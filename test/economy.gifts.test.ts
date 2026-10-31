// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGifts } from '../src/economy/gifts.ts'
import { parseGiftSettings } from '../src/economy/gameconfig.ts'
import { createInbox } from '../src/economy/inbox.ts'
import { createEconomyLedger } from '../src/economy/ledger.ts'
import { EMPTY_CATALOG } from '../src/economy/types.ts'
import { StoreError } from '../src/store/errors.ts'
import { createHttpPlayerStore } from '../src/store/http.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { TableApi } from '../src/store/tables.ts'

const NOW = 1_800_000_000_000
const code = (promise: Promise<unknown>, expected: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof StoreError && e.code === expected)

async function setup(settings?: string, wrap: (api: TableApi) => TableApi = api => api) {
  let time = NOW
  const now = () => time
  const api = createMemoryTableApi()
  const tables = wrap(api)
  const store = createHttpPlayerStore(tables, { now })
  const ledger = createEconomyLedger(tables, { catalog: () => EMPTY_CATALOG, now })
  const inbox = createInbox({ api: tables, ledger, catalog: () => EMPTY_CATALOG, now })
  const gifts = createGifts({ api: tables, ledger, inbox, store, gifts: async () => parseGiftSettings(settings), now })
  const player = async (external_id: string) =>
    (await store.getOrCreateByIdentity({ provider: 'wavedash', external_id })).player.player_id
  const sender = await player('alice')
  const recipient = await player('bob')
  const own = async (item = 'hat', quantity = 1, playerId = sender) => {
    await api.insert('etc_cards', { player_id: playerId, card_id: item, quantity, ledger_id: 0, first_at: NOW, updated_at: NOW })
  }
  const send = (op = 'op', item = 'hat', to = 'bob', message = '') => gifts.gift(sender, op, to, item, message)
  return { api, store, ledger, inbox, gifts, sender, recipient, own, send, advance: (ms: number) => { time += ms } }
}

test('a gift moves a copy through the inbox and claim without changing sales', async () => {
  const r = await setup()
  await r.own()
  await r.api.insert('etc_item_sales', { item_id: 'hat', sold: 1, cap: 1, updated_at: NOW })
  const sales = structuredClone(r.api.rows('etc_item_sales'))
  assert.deepEqual(await r.send('op', 'hat', 'bob', 'Enjoy!'), { to: 'bob', item: 'hat', applied: true })
  assert.equal(r.api.rows('etc_cards').find(row => row.player_id === r.sender)!.quantity, 0)
  assert.deepEqual((await r.ledger.state(r.recipient)).cards, {})
  const [entry] = await r.inbox.list(r.recipient)
  assert.deepEqual(entry, {
    id: entry.id, item: 'hat', sender: { kind: 'player', id: 'alice' }, message: 'Enjoy!',
    date: new Date(NOW).toISOString(), claimed: false,
  })
  const txId = `c:${r.sender}:op`
  const fact = r.api.rows('etc_ledger')[0]
  assert.equal(fact.tx_id, txId)
  assert.equal(fact.op, 'eco.gift')
  assert.equal(fact.params, JSON.stringify(['bob', 'hat', 'Enjoy!']))
  assert.deepEqual(JSON.parse(fact.result_json as string).fx, { coins: 0, packs: {}, cards: { hat: -1 } })
  assert.deepEqual(r.api.rows('etc_gifts').map(({ id, ...row }) => row), [{
    tx_id: txId, from_player: r.sender, to_player: r.recipient, item_id: 'hat', created_at: NOW,
  }])
  assert.equal(r.api.rows('etc_inbox')[0].source_tx, txId)
  assert.deepEqual(r.api.rows('etc_item_sales'), sales)
  await r.inbox.claim(r.recipient, 'claim', entry.id)
  assert.deepEqual((await r.ledger.state(r.recipient)).cards, { hat: 1 })
  assert.deepEqual(r.api.rows('etc_item_sales'), sales)
})

test('self gifts, unknown recipients and unowned items are refused without a gift', async () => {
  const r = await setup()
  await r.own()
  await code(r.send('self', 'hat', 'alice'), 'self_gift')
  await code(r.send('unknown', 'hat', 'missing'), 'not_found')
  await code(r.send('unowned', 'cape'), 'not_owned')
  assert.equal(r.api.rows('etc_players').length, 2)
  assert.equal(r.api.rows('etc_identities').length, 2)
  assert.equal(r.api.rows('etc_ledger').length, 0)
  assert.equal(r.api.rows('etc_gifts').length, 0)
  assert.equal(r.api.rows('etc_inbox').length, 0)
  assert.equal(r.api.rows('etc_cards')[0].quantity, 1)
})

test('the recipient can block and unblock the sender by Wavedash identity', async () => {
  const r = await setup()
  await r.own()
  await r.gifts.block(r.recipient, 'alice', true)
  await r.gifts.block(r.recipient, 'alice', true)
  await code(r.send(), 'blocked')
  assert.equal(r.api.rows('etc_cards')[0].quantity, 1)
  assert.equal(r.api.rows('etc_ledger').length, 0)
  assert.equal(r.api.rows('etc_blocks').length, 1)
  assert.equal(r.api.rows('etc_blocks')[0].block_key, `${r.recipient}|${r.sender}`)
  await r.gifts.block(r.recipient, 'alice', false)
  assert.equal(r.api.rows('etc_blocks').length, 1)
  assert.equal(r.api.rows('etc_blocks')[0].active, false)
  assert.equal((await r.send()).applied, true)
})

test('a block in the reverse direction does not prevent sending', async () => {
  const r = await setup()
  await r.own()
  await r.gifts.block(r.sender, 'bob', true)
  assert.equal((await r.send()).applied, true)
})

test('count + 1 is refused inside the window and accepted at its expiry', async () => {
  const r = await setup('{"count":2,"window_ms":1000}')
  await r.own('hat', 3)
  for (const op of ['one', 'two']) assert.equal((await r.send(op)).applied, true)
  r.advance(999)
  await code(r.send('three'), 'rate_limited')
  assert.equal(r.api.rows('etc_cards')[0].quantity, 1)
  r.advance(1)
  assert.equal((await r.send('three')).applied, true)
  assert.equal(r.api.rows('etc_gifts').length, 3)
})

test('no settings means no limit; message validation permits empty, URL and 280 characters', async () => {
  const r = await setup()
  await r.own('hat', 7)
  await code(r.send('long', 'hat', 'bob', 'x'.repeat(281)), 'bad_argument')
  for (const [i, message] of ['', 'https://example.com', 'x'.repeat(280), 'a', 'b', 'c', 'd'].entries()) {
    assert.equal((await r.send(String(i), 'hat', 'bob', message)).applied, true)
  }
  assert.equal(r.api.rows('etc_gifts').length, 7)
  assert.equal(r.api.rows('etc_inbox')[2].message, 'x'.repeat(280))
})

test('replay applies nothing and creates one inbox entry even after a block and the limit', async () => {
  const r = await setup('{"count":1,"window_ms":1000}')
  await r.own()
  assert.equal((await r.send()).applied, true)
  await r.gifts.block(r.recipient, 'alice', true)
  assert.equal((await r.send()).applied, false)
  assert.equal(r.api.rows('etc_cards')[0].quantity, 0)
  assert.equal(r.api.rows('etc_ledger').length, 1)
  assert.equal(r.api.rows('etc_gifts').length, 1)
  assert.equal(r.api.rows('etc_inbox').length, 1)
  await code(r.send('op', 'hat', 'bob', 'changed'), 'tx_conflict')
})

for (const failedTable of ['etc_gifts', 'etc_inbox']) {
  test(`replay repairs an interrupted ${failedTable} insertion with the original date`, async () => {
    let failed = false
    const r = await setup(undefined, api => ({
      ...api,
      async insert(table, row) {
        if (table === failedTable && !failed) {
          failed = true
          throw new Error('interrupted')
        }
        return api.insert(table, row)
      },
    }))
    await r.own()
    await assert.rejects(r.send(), /interrupted/)
    assert.equal(r.api.rows('etc_cards')[0].quantity, 0)
    r.advance(2000)
    assert.equal((await r.send()).applied, false)
    assert.equal((await r.send()).applied, false)
    assert.equal(r.api.rows('etc_ledger').length, 1)
    assert.equal(r.api.rows('etc_gifts').length, 1)
    assert.equal(r.api.rows('etc_inbox').length, 1)
    assert.equal(r.api.rows('etc_gifts')[0].created_at, NOW)
    assert.equal(r.api.rows('etc_inbox')[0].created_at, NOW)
    await r.inbox.claim(r.recipient, 'claim', String(r.api.rows('etc_inbox')[0].entry_id))
    assert.deepEqual((await r.ledger.state(r.recipient)).cards, { hat: 1 })
  })
}

test('concurrent gifts from one sender respect the limit through delivery', async () => {
  const r = await setup('{"count":1,"window_ms":1000}')
  await r.own('hat', 2)
  const results = await Promise.allSettled([r.send('one'), r.send('two')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')!
  assert.equal(rejected.reason.code, 'rate_limited')
  assert.equal(r.api.rows('etc_gifts').length, 1)
  assert.equal(r.api.rows('etc_inbox').length, 1)
  assert.equal(r.api.rows('etc_cards')[0].quantity, 1)
})

test('rate counting includes later pages and only the sender', async () => {
  const r = await setup('{"count":501,"window_ms":1000}')
  await r.own('hat', 2)
  for (let i = 0; i < 500; i++) {
    await r.api.insert('etc_gifts', {
      tx_id: `previous:${i}`, from_player: r.sender, to_player: r.recipient, item_id: 'cape', created_at: NOW,
    })
  }
  await r.api.insert('etc_gifts', {
    tx_id: 'other', from_player: r.recipient, to_player: r.sender, item_id: 'cape', created_at: NOW,
  })
  assert.equal((await r.send('last')).applied, true)
  await code(r.send('overflow'), 'rate_limited')
})

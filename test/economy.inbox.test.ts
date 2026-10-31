// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInbox } from '../src/economy/inbox.ts'
import { createEconomyLedger } from '../src/economy/ledger.ts'
import { EMPTY_CATALOG } from '../src/economy/types.ts'
import { StoreError } from '../src/store/errors.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { Row } from '../src/store/tables.ts'

const NOW = 1_800_000_000_000
const options = { catalog: () => EMPTY_CATALOG }

function setup() {
  const api = createMemoryTableApi()
  const ledger = createEconomyLedger(api, options)
  const inbox = createInbox({ api, ledger, catalog: () => EMPTY_CATALOG, now: () => NOW })
  return { api, ledger, inbox }
}

const entry = (over: Row = {}): Row => ({
  entry_id: 'e1', player_id: 'p', item_id: null, sender_kind: 'system', sender_id: null,
  message: '', created_at: NOW - 1000, claimed_at: null, source_tx: 'tx-e1', ...over,
})

const code = (p: Promise<unknown>, c: string) =>
  assert.rejects(p, (e: unknown) => e instanceof StoreError && e.code === c)

test('a system entry with an item is listed, claimed into etc_cards, and a second claim is refused', async () => {
  const { api, inbox } = setup()
  await api.insert('etc_inbox', entry({ entry_id: 'e1', item_id: 'hat', message: 'Welcome' }))

  assert.deepEqual(await inbox.list('p'), [{
    id: 'e1', item: 'hat', sender: { kind: 'system', id: null }, message: 'Welcome',
    date: new Date(NOW - 1000).toISOString(), claimed: false,
  }])
  assert.equal(await inbox.unread('p'), 1)

  assert.deepEqual(await inbox.claim('p', 'op-1', 'e1'), { id: 'e1', item: 'hat', applied: true })
  assert.deepEqual(api.rows('etc_cards').map(r => ({ player_id: r.player_id, card_id: r.card_id, quantity: r.quantity })),
    [{ player_id: 'p', card_id: 'hat', quantity: 1 }])

  const fact = api.rows('etc_ledger').find(r => r.tx_id === 'cl:e1')!
  assert.equal(fact.op, 'eco.claim')
  assert.equal(fact.params, '["e1"]')
  assert.deepEqual(JSON.parse(fact.result_json as string), {
    result: { id: 'e1', item: 'hat' }, fx: { coins: 0, packs: {}, cards: { hat: 1 } },
  })

  assert.equal((await inbox.list('p'))[0]!.claimed, true)
  assert.equal(await inbox.unread('p'), 0)
  await code(inbox.claim('p', 'op-2', 'e1'), 'already_claimed')
  assert.equal(api.rows('etc_cards')[0]!.quantity, 1)
})

test('a message-only entry is claimed without a card', async () => {
  const { api, inbox } = setup()
  await api.insert('etc_inbox', entry({ entry_id: 'e2', source_tx: 'tx-e2', message: 'Thanks for playing' }))

  assert.deepEqual(await inbox.claim('p', 'op-1', 'e2'), { id: 'e2', item: null, applied: true })
  assert.equal(api.rows('etc_cards').length, 0)
  const fact = api.rows('etc_ledger').find(r => r.tx_id === 'cl:e2')!
  assert.deepEqual(JSON.parse(fact.result_json as string).fx, { coins: 0, packs: {}, cards: {} })
  assert.notEqual(api.rows('etc_inbox')[0]!.claimed_at, null)
})

test('a claim whose ledger fact exists but was never marked answers applied:false once', async () => {
  const { api, inbox } = setup()
  await api.insert('etc_inbox', entry({ entry_id: 'e6', item_id: 'hat', source_tx: 'tx-e6' }))
  await api.insert('etc_ledger', {
    tx_id: 'cl:e6', player_id: 'p', op: 'eco.claim', game: '', coin_delta: 0, pack_delta: 0,
    params: '["e6"]', result_json: JSON.stringify({ result: { id: 'e6', item: 'hat' }, fx: { coins: 0, packs: {}, cards: { hat: 1 } } }),
    created_at: NOW,
  })

  assert.deepEqual(await inbox.claim('p', 'op-1', 'e6'), { id: 'e6', item: 'hat', applied: false })
  assert.equal(api.rows('etc_cards').length, 1)
  assert.equal(api.rows('etc_cards')[0]!.quantity, 1)
  assert.notEqual(api.rows('etc_inbox')[0]!.claimed_at, null)
  await code(inbox.claim('p', 'op-2', 'e6'), 'already_claimed')
})

test("another player's entry is refused not_found", async () => {
  const { api, inbox } = setup()
  await api.insert('etc_inbox', entry({ entry_id: 'e3', player_id: 'other', item_id: 'hat', source_tx: 'tx-e3' }))

  await code(inbox.claim('p', 'op-1', 'e3'), 'not_found')
  assert.equal(api.rows('etc_ledger').length, 0)
  assert.equal(api.rows('etc_inbox')[0]!.claimed_at, null)
  assert.equal(await inbox.unread('p'), 0)
})

test('claiming an item already owned is refused already_owned', async () => {
  const { api, inbox } = setup()
  await api.insert('etc_inbox', entry({ entry_id: 'e4', item_id: 'hat', source_tx: 'tx-e4' }))
  await api.insert('etc_cards', { player_id: 'p', card_id: 'hat', quantity: 1, ledger_id: 0, first_at: NOW, updated_at: NOW })

  await code(inbox.claim('p', 'op-1', 'e4'), 'already_owned')
  assert.equal(api.rows('etc_ledger').length, 0)
  assert.equal(api.rows('etc_inbox')[0]!.claimed_at, null)
  assert.equal(api.rows('etc_cards')[0]!.quantity, 1)
})

test('etc_item_sales is unchanged by a claim', async () => {
  const { api, inbox } = setup()
  await api.insert('etc_item_sales', { item_id: 'hat', sold: 1, cap: 10, updated_at: NOW })
  await api.insert('etc_inbox', entry({ entry_id: 'e5', item_id: 'hat', source_tx: 'tx-e5' }))

  await inbox.claim('p', 'op-1', 'e5')
  assert.equal(api.rows('etc_item_sales').length, 1)
  assert.equal(api.rows('etc_item_sales')[0]!.sold, 1)
  assert.equal(api.rows('etc_cards')[0]!.quantity, 1)
})

test('deliver is an insert-or-read keyed by source_tx', async () => {
  const { api, inbox } = setup()
  const delivery = {
    entry_id: 'g1', player_id: 'p', item_id: 'hat', sender_kind: 'player' as const,
    sender_id: 'friend', message: 'Enjoy', source_tx: 'gift:1',
  }
  const first = await inbox.deliver(delivery)
  const second = await inbox.deliver({ ...delivery, entry_id: 'g1-retry' })
  assert.equal(second.id, first.id)
  assert.equal(api.rows('etc_inbox').length, 1)
  assert.deepEqual((await inbox.list('p'))[0]!.sender, { kind: 'player', id: 'friend' })
})

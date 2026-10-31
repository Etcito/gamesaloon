// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCommissions } from '../src/economy/commissions.ts'
import { checkText } from '../src/economy/filter.ts'
import { parseFilterSettings, parseGameConfig } from '../src/economy/gameconfig.ts'
import type { FilterSettings } from '../src/economy/gameconfig.ts'
import { createEconomyLedger } from '../src/economy/ledger.ts'
import { StoreError } from '../src/store/errors.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'

const NOW = 1_800_000_000_000
const parsed = parseGameConfig(readFileSync(new URL('./fixtures/economy/other-game.economy.json', import.meta.url), 'utf8'))
const CATALOG = parsed.catalog
const FILTER = parseFilterSettings(parsed.settings['economy.filter'])!

function setup(filter: FilterSettings | null = FILTER) {
  const api = createMemoryTableApi()
  const ledger = createEconomyLedger(api, { catalog: () => CATALOG, now: () => NOW })
  const commissions = createCommissions({ api, ledger, catalog: () => CATALOG, filter: async () => filter, now: () => NOW })
  return { api, ledger, commissions }
}

async function grantStars(ledger: ReturnType<typeof createEconomyLedger>, stars: number): Promise<void> {
  await ledger.commit('p', 'grant:stars', 'eco.round', [], () => ({
    fx: { coins: 0, packs: {}, cards: {}, currencies: { stars } }, result: {},
  }))
}

const refused = (p: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof StoreError && e.code === code && (message === undefined || message.test(e.message)))

test('the filter refuses short text, long text, a URL and a banned word in any case', () => {
  assert.equal(checkText('123456789', { ...FILTER, min_length: 10 }), 'min_length')
  assert.equal(checkText('x', FILTER), 'min_length')
  assert.equal(checkText('x'.repeat(FILTER.max_length + 1), FILTER), 'max_length')
  assert.equal(checkText('see https://example.com', FILTER), 'no_url')
  assert.equal(checkText('visit WWW.example.com', FILTER), 'no_url')
  assert.equal(checkText('buy SPAM now', FILTER), 'banned_word: spam')
  assert.equal(checkText('this is a SLUR', FILTER), 'banned_word: slur')
})

test('length is counted in code points and a banned word inside another word passes', () => {
  assert.equal(checkText('😀😀😀', { ...FILTER, min_length: 3, max_length: 3 }), null)
  assert.equal(checkText('😀😀', { ...FILTER, min_length: 3 }), 'min_length')
  assert.equal(checkText('spammer', FILTER), null)
  assert.equal(checkText('spam_bot', FILTER), null)
  assert.equal(checkText('a sunny hat', FILTER), null)
})

test('a commission spends the rarity price and appears in mine() and queue() without player_id', async () => {
  const { api, ledger, commissions } = setup()
  await grantStars(ledger, 5)

  const made = await commissions.commission('p', 'op-1', 'hat', 'plain', '  A sunny hat  ')
  assert.deepEqual(made, {
    id: made.id, slot: 'hat', rarity: 'plain', description: 'A sunny hat', status: 'pending', created_at: NOW, applied: true,
  })
  assert.match(made.id, /^cm_[0-9a-f]{16}$/)
  assert.equal((await ledger.state('p')).balances?.stars, 4)

  const fact = api.rows('etc_ledger').find(r => r.op === 'eco.commission')!
  assert.equal(fact.tx_id, 'cm:p:op-1')
  assert.equal(fact.coin_delta, 0)
  assert.deepEqual(JSON.parse(fact.params as string), ['hat', 'plain', 'A sunny hat'])

  const mine = await commissions.mine('p')
  assert.deepEqual(mine, [{
    id: made.id, slot: 'hat', rarity: 'plain', description: 'A sunny hat', status: 'pending', created_at: NOW,
  }])
  assert.equal('player_id' in mine[0]!, false)
  const queue = await commissions.queue()
  assert.deepEqual(queue, mine)
  assert.equal('player_id' in queue[0]!, false)
})

test('a replay is applied:false and keeps a single commission row', async () => {
  const { api, ledger, commissions } = setup()
  await grantStars(ledger, 5)

  const first = await commissions.commission('p', 'op-1', 'hat', 'plain', 'A sunny hat')
  const replay = await commissions.commission('p', 'op-1', 'hat', 'plain', 'A sunny hat')
  assert.equal(replay.applied, false)
  assert.equal(replay.id, first.id)
  assert.equal(api.rows('etc_commissions').length, 1)
  assert.equal(api.rows('etc_ledger').filter(r => r.op === 'eco.commission').length, 1)
  assert.equal((await ledger.state('p')).balances?.stars, 4)
})

test('insufficient currency is refused without a commission or a ledger fact', async () => {
  const { api, ledger, commissions } = setup()
  await grantStars(ledger, 2)

  await refused(commissions.commission('p', 'op-1', 'cape', 'shiny', 'A wind cape'), 'insufficient_funds')
  assert.equal(api.rows('etc_commissions').length, 0)
  assert.equal(api.rows('etc_ledger').filter(r => r.op === 'eco.commission').length, 0)
  assert.equal((await ledger.state('p')).balances?.stars, 2)
})

test('a refused description is refused with the filter reason before anything is committed', async () => {
  const { api, ledger, commissions } = setup()
  await grantStars(ledger, 5)

  await refused(commissions.commission('p', 'op-1', 'hat', 'plain', 'visit https://example.com'), 'description_refused', /no_url/)
  await refused(commissions.commission('p', 'op-1', 'hat', 'plain', 'buy SPAM now'), 'description_refused', /banned_word: spam/)
  assert.equal(api.rows('etc_commissions').length, 0)
  assert.equal(api.rows('etc_ledger').filter(r => r.op === 'eco.commission').length, 0)
})

test('a commission set to shipped leaves the queue but stays in mine()', async () => {
  const { api, ledger, commissions } = setup()
  await grantStars(ledger, 5)
  const made = await commissions.commission('p', 'op-1', 'boots', 'plain', 'Moon boots')

  await api.update('etc_commissions', api.rows('etc_commissions')[0]!.id as number, { status: 'shipped' })
  assert.deepEqual(await commissions.queue(), [])
  assert.equal((await commissions.mine('p'))[0]!.status, 'shipped')
  assert.equal((await commissions.mine('p'))[0]!.id, made.id)

  await api.update('etc_commissions', api.rows('etc_commissions')[0]!.id as number, { status: 'mystery' })
  assert.deepEqual((await commissions.queue()).map(c => c.status), ['pending'])
})

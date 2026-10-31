// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEconomyLedger } from '../src/economy/ledger.ts'
import { EMPTY_CATALOG } from '../src/economy/types.ts'
import type { Fx } from '../src/economy/types.ts'
import { StoreError } from '../src/store/errors.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { Row, TableApi } from '../src/store/tables.ts'

const options = { catalog: () => EMPTY_CATALOG }
const fx = (currencies: Record<string, number> = {}): Fx => ({ coins: 0, packs: {}, cards: {}, currencies })
const fact = (txId: string, op: string, delta = fx({ stars: 2 })): Row => ({
  tx_id: txId, player_id: 'p', op, game: '', coin_delta: delta.coins, pack_delta: 0,
  params: '[]', result_json: JSON.stringify({ fx: delta, result: { granted: true } }), created_at: 1,
})

test('commit grants extra currencies once and replays the stored result', async () => {
  const api = createMemoryTableApi()
  const ledger = createEconomyLedger(api, options)
  const first = await ledger.commit('p', 'stars', 'eco.round', [], state => {
    assert.equal(Object.hasOwn(state, 'balances'), false)
    return { fx: fx({ stars: 2 }), result: { stars: 2 } }
  })
  assert.deepEqual(first, { applied: true, result: { stars: 2 } })
  const replay = await ledger.commit('p', 'stars', 'eco.round', [], () => { throw new Error('must not rebuild') })
  assert.deepEqual(replay, { applied: false, result: first.result })
  assert.deepEqual(await ledger.state('p'), { coins: 0, version: 1, packs: {}, cards: {}, balances: { stars: 2 } })
  assert.deepEqual(await ledger.grantedBy('stars'), fx({ stars: 2 }))
  assert.equal(api.rows('etc_balances').length, 1)
})

test('a player without currencies retains the original state shape', async () => {
  const ledger = createEconomyLedger(createMemoryTableApi(), options)
  assert.deepEqual(await ledger.state('p'), { coins: 0, version: 0, packs: {}, cards: {} })
  await ledger.commit('p', 'coins', 'eco.grant', [], () => ({
    fx: { coins: 3, packs: {}, cards: {} }, result: {},
  }), { editionKey: () => null })
  assert.deepEqual(await ledger.state('p'), { coins: 3, version: 1, packs: {}, cards: {} })
  assert.deepEqual(await ledger.grantedBy('coins'), { coins: 3, packs: {}, cards: {} })
})

test('an edition taken by another tx retries with fresh state and commits the next serial', async () => {
  const api = createMemoryTableApi()
  const rival = createEconomyLedger(api, options)
  let raced = false
  const wrapped: TableApi = {
    ...api,
    async insert(table, row) {
      if (table === 'etc_ledger' && row.tx_id === 'purchase' && !raced) {
        raced = true
        await rival.commit('p', 'rival', 'eco.shop', [], () => ({
          fx: { ...fx({ stars: 2 }), coins: 5, cards: { hat: 1 } }, result: { serial: 1 },
        }), { editionKey: () => 'hat:1' })
      }
      return api.insert(table, row)
    },
  }
  const ledger = createEconomyLedger(wrapped, options)
  let builds = 0
  let serial = 0
  const result = await ledger.commit('p', 'purchase', 'eco.shop', ['hat'], state => {
    builds++
    if (builds === 2) {
      assert.equal(state.coins, 5)
      assert.deepEqual(state.balances, { stars: 2 })
      assert.equal(state.version, 1)
    }
    serial = (state.cards.hat ?? 0) + 1
    return { fx: { ...fx(), cards: { hat: 1 } }, result: { serial } }
  }, { editionKey: () => `hat:${serial}` })
  assert.equal(builds, 2)
  assert.deepEqual(result, { applied: true, result: { serial: 2 } })
  assert.equal(api.rows('etc_ledger').find(r => r.tx_id === 'purchase')?.edition_key, 'hat:2')
  assert.deepEqual(await ledger.state('p'), { coins: 5, version: 2, packs: {}, cards: { hat: 2 }, balances: { stars: 2 } })
})

test('all new operation names catch up a directly inserted fact exactly once', async () => {
  for (const op of ['eco.shop', 'eco.round', 'eco.commission', 'eco.gift', 'eco.claim'] as const) {
    const api = createMemoryTableApi()
    const ledger = createEconomyLedger(api, options)
    await ledger.state('p')
    const inserted = await api.insert('etc_ledger', fact('crashed', op))
    assert.notEqual(inserted, 'conflict')
    assert.equal(api.rows('etc_balances').length, 0)
    const expected = { coins: 0, version: 1, packs: {}, cards: {}, balances: { stars: 2 } }
    assert.deepEqual(await ledger.state('p'), expected)
    assert.deepEqual(await ledger.state('p'), expected)
    assert.deepEqual(await ledger.commit('p', 'crashed', op, [], () => { throw new Error('must not rebuild') }), {
      applied: false, result: { granted: true },
    })
    assert.equal(api.rows('etc_balances')[0].ledger_id, inserted === 'conflict' ? 0 : inserted.row.id)
  }
})

test('a crash after the balance projection and before the wallet write does not credit twice', async () => {
  const api = createMemoryTableApi()
  let crash = true
  const wrapped: TableApi = {
    ...api,
    async update(table, id, patch) {
      if (table === 'etc_wallets' && crash) { crash = false; throw new Error('crash') }
      return api.update(table, id, patch)
    },
  }
  const ledger = createEconomyLedger(wrapped, options)
  await assert.rejects(ledger.commit('p', 'crashed', 'eco.claim', [], () => ({ fx: fx({ stars: 2 }), result: {} })), /crash/)
  assert.equal(api.rows('etc_balances')[0].quantity, 2)
  assert.equal(api.rows('etc_wallets')[0].last_ledger_id, 0)
  const recovered = createEconomyLedger(api, options)
  assert.deepEqual((await recovered.state('p')).balances, { stars: 2 })
  assert.deepEqual((await recovered.state('p')).balances, { stars: 2 })
  assert.equal((await recovered.state('p')).version, 1)
})

test('negative currency deltas spend balances; build refuses insufficient funds without committing', async () => {
  const api = createMemoryTableApi()
  const ledger = createEconomyLedger(api, options)
  await ledger.commit('p', 'grant', 'eco.round', [], () => ({ fx: fx({ stars: 2 }), result: {} }))
  const spend = (txId: string) => ledger.commit('p', txId, 'eco.commission', [], state => {
    if ((state.balances?.stars ?? 0) < 2) throw new StoreError('insufficient_funds', 'Insufficient stars')
    return { fx: fx({ stars: -2 }), result: { bought: true } }
  })
  assert.equal((await spend('spend')).applied, true)
  assert.deepEqual((await ledger.state('p')).balances, { stars: 0 })
  await assert.rejects(spend('refused'), { code: 'insufficient_funds' })
  assert.equal(api.rows('etc_ledger').length, 2)
})

test('negative card deltas remove copies and clamp quantity at zero', async () => {
  const api = createMemoryTableApi()
  const ledger = createEconomyLedger(api, options)
  await ledger.commit('p', 'grant', 'eco.claim', [], () => ({ fx: { ...fx(), cards: { hat: 2 } }, result: {} }))
  for (let i = 0; i < 3; i++) {
    await ledger.commit('p', `gift:${i}`, 'eco.gift', [], () => ({ fx: { ...fx(), cards: { hat: -1 } }, result: {} }))
    assert.equal(api.rows('etc_cards')[0].quantity, Math.max(0, 1 - i))
  }
  assert.deepEqual((await ledger.state('p')).cards, {})
})

test('a persistent edition collision stops after 64 attempts without projecting rejected deltas', async () => {
  const api = createMemoryTableApi()
  await api.insert('etc_ledger', { ...fact('taken', 'eco.shop'), player_id: 'other', edition_key: 'hat:1' })
  const ledger = createEconomyLedger(api, options)
  let builds = 0
  await assert.rejects(ledger.commit('p', 'purchase', 'eco.shop', [], () => {
    builds++
    return { fx: fx({ stars: 2 }), result: {} }
  }, { editionKey: () => 'hat:1' }), { code: 'tx_conflict' })
  assert.equal(builds, 64)
  assert.equal(api.rows('etc_ledger').length, 1)
  assert.deepEqual(await ledger.state('p'), { coins: 0, version: 0, packs: {}, cards: {} })
})

test('build can refuse sold out after an edition conflict without a new ledger row', async () => {
  const api = createMemoryTableApi()
  await api.insert('etc_ledger', { ...fact('taken', 'eco.shop'), player_id: 'other', edition_key: 'hat:1' })
  const ledger = createEconomyLedger(api, options)
  const refusal = new Error('sold_out')
  let builds = 0
  await assert.rejects(ledger.commit('p', 'purchase', 'eco.shop', [], () => {
    if (++builds === 2) throw refusal
    return { fx: fx({ stars: -2 }), result: {} }
  }, { editionKey: () => 'hat:1' }), e => e === refusal)
  assert.equal(builds, 2)
  assert.equal(api.rows('etc_ledger').length, 1)
  assert.equal(api.rows('etc_balances').length, 0)
})

test('insert conflicts re-query tx_id for replay or parameter mismatch before retrying build', async () => {
  for (const mismatch of [false, true]) {
    const api = createMemoryTableApi()
    const wrapped: TableApi = {
      ...api,
      async insert(table, row) {
        if (table === 'etc_ledger') {
          await api.insert(table, { ...row, params: mismatch ? '["different"]' : row.params })
        }
        return api.insert(table, row)
      },
    }
    const ledger = createEconomyLedger(wrapped, options)
    let builds = 0
    const result = ledger.commit('p', 'raced', 'eco.shop', [], () => {
      builds++
      return { fx: fx({ stars: 2 }), result: { stars: 2 } }
    })
    if (mismatch) await assert.rejects(result, { code: 'tx_conflict' })
    else assert.deepEqual(await result, { applied: false, result: { stars: 2 } })
    assert.equal(builds, 1)
    assert.equal(api.rows('etc_ledger').length, 1)
    assert.deepEqual((await ledger.state('p')).balances, { stars: 2 })
  }
})

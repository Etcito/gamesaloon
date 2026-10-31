// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalog } from '../src/economy/catalog.ts'
import { createEconomyLedger } from '../src/economy/ledger.ts'
import { createRoundRewards } from '../src/economy/rounds.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'

// A game whose vocabulary is not Royal Fiesta's: coins per finished round, a gem for the champion.
const OTHER_GAME = parseCatalog(JSON.stringify({
  cards: [{ id: 'card.1', rarity: 'basic' }],
  currencies: ['tickets', 'gems'],
  round_rewards: {
    finish: { coins: 5 },
    champion: { currencies: { gems: 1 } },
  },
}))

function setup() {
  const api = createMemoryTableApi()
  const store = createMemoryStore()
  const ledger = createEconomyLedger(api, { catalog: () => OTHER_GAME })
  const rounds = createRoundRewards({ api, ledger, store, catalog: () => OTHER_GAME, now: () => 1 })
  const playerOf = async (wavedashUserId: string) =>
    (await store.getOrCreateByIdentity({ provider: 'wavedash', external_id: wavedashUserId })).player.player_id
  return { api, ledger, rounds, playerOf }
}

test('a finish report grants the coins to the player of the Wavedash user id', async () => {
  const { api, ledger, rounds, playerOf } = setup()
  const r = await rounds.report('host', 'm1', 1, 'wd-a', 'finish')
  assert.deepEqual(r, { match_id: 'm1', round: 1, player: 'wd-a', kind: 'finish', granted: { coins: 5, currencies: {} }, applied: true })
  assert.deepEqual(await ledger.state(await playerOf('wd-a')), { coins: 5, version: 1, packs: {}, cards: {} })
  assert.deepEqual(api.rows('etc_round_hosts').map(h => [h.match_id, h.player_id]), [['m1', 'host']])
  assert.equal(api.rows('etc_ledger')[0]!.tx_id, 'rr:m1|1|wd-a|finish')
  assert.equal(api.rows('etc_ledger')[0]!.op, 'eco.round')
})

test('the same report again answers the original result and leaves the balance unchanged', async () => {
  const { ledger, rounds, playerOf } = setup()
  const first = await rounds.report('host', 'm1', 1, 'wd-a', 'finish')
  const again = await rounds.report('host', 'm1', 1, 'wd-a', 'finish')
  assert.deepEqual(again, { ...first, applied: false })
  assert.equal((await ledger.state(await playerOf('wd-a'))).coins, 5)
})

test('another round of the same match grants again', async () => {
  const { ledger, rounds, playerOf } = setup()
  await rounds.report('host', 'm1', 1, 'wd-a', 'finish')
  const second = await rounds.report('host', 'm1', 2, 'wd-a', 'finish')
  assert.equal(second.applied, true)
  assert.equal(second.round, 2)
  assert.equal((await ledger.state(await playerOf('wd-a'))).coins, 10)
})

test('a champion report grants the currency', async () => {
  const { ledger, rounds, playerOf } = setup()
  await rounds.report('host', 'm1', 3, 'wd-a', 'finish')
  const r = await rounds.report('host', 'm1', 3, 'wd-a', 'champion')
  assert.deepEqual(r.granted, { coins: 0, currencies: { gems: 1 } })
  assert.equal(r.applied, true)
  assert.deepEqual(await ledger.state(await playerOf('wd-a')), { coins: 5, version: 2, packs: {}, cards: {}, balances: { gems: 1 } })
})

test('an unknown kind is refused unknown_reward and claims no host', async () => {
  const { api, rounds } = setup()
  await assert.rejects(rounds.report('host', 'm1', 1, 'wd-a', 'win'), { code: 'unknown_reward' })
  await assert.rejects(rounds.report('host', 'm1', 1, 'wd-a', 'constructor'), { code: 'unknown_reward' })
  assert.equal(api.rows('etc_round_hosts').length, 0)
  assert.equal(api.rows('etc_ledger').length, 0)
})

test('a second reporter on the same match is refused forbidden', async () => {
  const { api, ledger, rounds, playerOf } = setup()
  await rounds.report('host', 'm1', 1, 'wd-a', 'finish')
  await assert.rejects(rounds.report('intruder', 'm1', 1, 'wd-b', 'finish'), { code: 'forbidden' })
  await assert.rejects(rounds.report('intruder', 'm1', 2, 'wd-a', 'finish'), { code: 'forbidden' })
  assert.equal(api.rows('etc_ledger').length, 1)
  assert.equal((await ledger.state(await playerOf('wd-a'))).coins, 5)
  assert.equal((await rounds.report('intruder', 'm2', 1, 'wd-b', 'finish')).applied, true)
})

test('arguments out of range are refused bad_argument', async () => {
  const { api, rounds } = setup()
  const refused = (p: Promise<unknown>) => assert.rejects(p, { code: 'bad_argument' })
  await refused(rounds.report('host', '', 1, 'wd-a', 'finish'))
  await refused(rounds.report('host', 'm'.repeat(129), 1, 'wd-a', 'finish'))
  for (const round of [-1, 1001, 1.5, Number.NaN]) await refused(rounds.report('host', 'm1', round, 'wd-a', 'finish'))
  await refused(rounds.report('host', 'm1', 1, 'wd-a', 'bad kind'))
  await refused(rounds.report('host', 'm1', 1, '', 'finish'))
  assert.equal(api.rows('etc_round_hosts').length, 0)
  assert.equal((await rounds.report('host', 'm'.repeat(128), 1000, 'wd-a', 'finish')).applied, true)
})

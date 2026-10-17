// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLegacyGame, ownerGames, parseOwnerGames, setOwnerGames } from '../src/store/legacy.ts'
import { createGameRouter } from '../src/store/games.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import { economyRoutes } from '../src/economy/routes.ts'
import type { GameBackend } from '../src/store/games.ts'
import type { EconomyService } from '../src/economy/service.ts'

const gameTable = async (code: string) => {
  const api = createMemoryTableApi()
  await api.insert('etc_game', { code, handshake_game: code, elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]' })
  return api
}
const maxRoomsOf = async (code: string): Promise<number | undefined> => {
  const router = await createGameRouter({ [code]: await gameTable(code) }, { multiCreator: true })
  try { return router.resolve(code)?.maxRooms?.() } finally { router.close() }
}

test('parsing OWNER_GAMES: trimmed, lowercased, empty entries and duplicates dropped, unset is empty', () => {
  assert.deepEqual(parseOwnerGames(undefined), [])
  assert.deepEqual(parseOwnerGames(''), [])
  assert.deepEqual(parseOwnerGames(' , ,'), [])
  assert.deepEqual(parseOwnerGames('kekkai,monsterracer'), ['kekkai', 'monsterracer'])
  assert.deepEqual(parseOwnerGames('  My-Game , OTHER,,my-game '), ['my-game', 'other'])
  setOwnerGames(' A , b ')
  assert.deepEqual(ownerGames(), ['a', 'b'])
  assert.equal(isLegacyGame('a'), true)
  assert.equal(isLegacyGame('A'), false)
})

test('default (no OWNER_GAMES): the former owner names are creator games with caps, like any other', async () => {
  setOwnerGames([])
  assert.equal(isLegacyGame('kekkai'), false)
  assert.equal(isLegacyGame('monsterracer'), false)
  for (const g of ['kekkai', 'monsterracer', 'my-game']) assert.equal(await maxRoomsOf(g), 10, g)
})

test('OWNER_GAMES=kekkai,monsterracer: those two keep the old behaviour (no caps), others stay capped', async () => {
  setOwnerGames('kekkai,monsterracer')
  assert.equal(isLegacyGame('kekkai'), true)
  assert.equal(isLegacyGame('monsterracer'), true)
  assert.equal(await maxRoomsOf('kekkai'), undefined)
  assert.equal(await maxRoomsOf('monsterracer'), undefined)
  assert.equal(await maxRoomsOf('my-game'), 10)
})

test('any configured name is an owner game, the legacy Stripe endpoint follows the configuration', async () => {
  const seen: string[] = []
  const backend = (game: string): GameBackend => ({ game, store: {} as GameBackend['store'], queues: () => ['quick'],
    economy: { hasStripe: () => true, stripeVerify: async () => { seen.push(game); return null } } as unknown as EconomyService })
  const route = () => economyRoutes({ backends: () => [backend('my-game'), backend('creator')] }).find(r => r.path === '/webhooks/stripe')!
  setOwnerGames('my-game')
  assert.equal(await maxRoomsOf('my-game'), undefined)
  await route().handle({ body: '{}', headers: { 'stripe-signature': 'x' } })
  assert.deepEqual(seen, ['my-game'])
  seen.length = 0
  setOwnerGames([])
  await route().handle({ body: '{}', headers: { 'stripe-signature': 'x' } })
  assert.deepEqual(seen, ['my-game', 'creator'])
})

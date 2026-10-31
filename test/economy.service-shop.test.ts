// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMemoryTableApi } from '../src/store/tables.ts'
import { importGameConfig } from '../src/economy/import.ts'
import { rig } from './economy.helpers.ts'
import type { Rig } from './economy.helpers.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/economy/${name}`, import.meta.url), 'utf8')

/** A rig whose tenant is seeded by importing a game economy file (the service game is 'g'). */
async function imported(name: string): Promise<Rig> {
  const api = createMemoryTableApi()
  await api.insert('etc_game', {
    code: 'g', name: 'G', repo_url: '', repo_branch: 'main', handshake_game: 'g',
    elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]',
  })
  await importGameConfig(api, fixture(name), { game: 'g' })
  return rig({ api })
}

/** A Wavedash player of the rig. The memory store keeps identities to itself, so the tenant's etc_identities row
 *  that the gift module resolves recipients through is mirrored here (the HTTP store writes it in production). */
async function wavedashPlayer(r: Rig, userId: string): Promise<string> {
  const id = await r.player(userId, 'wavedash')
  await r.api.insert('etc_identities', { ident_key: `wavedash\u001f${userId}`, player_id: id })
  return id
}

test('round reward, star purchase, commission, gift and claim through the service', async () => {
  const r = await imported('other-game.economy.json')
  const host = await r.player('host')
  const alice = await wavedashPlayer(r, 'wd-alice')
  const bob = await wavedashPlayer(r, 'wd-bob')
  const changed: string[] = []
  r.svc.onChange(id => changed.push(id))
  const take = (): string[] => changed.splice(0).sort()

  // Two champion rounds and a finish: 2 stars and 5 coins, each change notified to the rewarded player.
  assert.equal((await r.svc.roundReward(host, 'm1', 1, 'wd-alice', 'champion')).applied, true)
  assert.equal((await r.svc.roundReward(host, 'm1', 2, 'wd-alice', 'champion')).applied, true)
  assert.deepEqual((await r.svc.roundReward(host, 'm1', 2, 'wd-alice', 'finish')).granted, { coins: 5, currencies: {} })
  assert.deepEqual(take(), [alice, alice, alice])
  assert.equal((await r.svc.roundReward(host, 'm1', 1, 'wd-alice', 'champion')).applied, false)
  assert.deepEqual(take(), [])
  assert.deepEqual(await r.svc.state(alice), { coins: 5, version: 3, packs: [], cards: {}, balances: { stars: 2 } })

  // The capped hat bought in stars.
  assert.equal((await r.svc.shop()).items.find(i => i.id === 'hat.sunny')!.remaining, 2)
  const bought = await r.svc.shopBuy(alice, 'buy-1', 'hat.sunny', 'stars')
  assert.deepEqual(bought, { item: 'hat.sunny', currency: 'stars', price: 1, coins: 5, balances: { stars: 1 }, remaining: 1, applied: true })
  assert.deepEqual(take(), [alice])
  assert.equal((await r.svc.shop()).items.find(i => i.id === 'hat.sunny')!.remaining, 1)

  // A plain commission spends the last star and joins the queue without its player.
  const made = await r.svc.commission(alice, 'cm-1', 'boots', 'plain', '  Boots with little clouds  ')
  assert.equal(made.applied, true)
  assert.equal(made.description, 'Boots with little clouds')
  assert.deepEqual(take(), [alice])
  assert.deepEqual((await r.svc.commissions(alice)).map(c => c.id), [made.id])
  assert.deepEqual(await r.svc.commissionQueue(), [{
    id: made.id, slot: 'boots', rarity: 'plain', description: 'Boots with little clouds', status: 'pending', created_at: made.created_at,
  }])
  assert.deepEqual((await r.svc.state(alice)).balances, { stars: 0 })

  // The gift moves the hat to Bob's inbox and notifies both players; its replay notifies nobody.
  assert.deepEqual(await r.svc.gift(alice, 'gift-1', 'wd-bob', 'hat.sunny', 'For you'), { to: 'wd-bob', item: 'hat.sunny', applied: true })
  assert.deepEqual(take(), [alice, bob].sort())
  assert.equal((await r.svc.gift(alice, 'gift-1', 'wd-bob', 'hat.sunny', 'For you')).applied, false)
  assert.deepEqual(take(), [])
  assert.deepEqual((await r.svc.state(alice)).cards, {})

  const [entry, ...rest] = await r.svc.inbox(bob)
  assert.deepEqual(rest, [])
  assert.deepEqual({ item: entry!.item, sender: entry!.sender, message: entry!.message, claimed: entry!.claimed },
    { item: 'hat.sunny', sender: { kind: 'player', id: 'wd-alice' }, message: 'For you', claimed: false })

  // Bob claims it into his collection; the gift never counted as a second sale.
  assert.deepEqual(await r.svc.claim(bob, 'claim-1', entry!.id), { id: entry!.id, item: 'hat.sunny', applied: true })
  assert.deepEqual(take(), [bob])
  assert.deepEqual((await r.svc.state(bob)).cards, { 'hat.sunny': 1 })
  assert.equal((await r.svc.inbox(bob))[0]!.claimed, true)
  assert.equal((await r.svc.shop()).items.find(i => i.id === 'hat.sunny')!.sold, 1)
})

test('the state of a kekkai-like game has no balances key', async () => {
  const r = await imported('kekkai-like.economy.json')
  const p = await r.player('u1')
  await r.svc.reward(p, 'tuto:intro')
  const state = await r.svc.state(p)
  assert.equal(Object.hasOwn(state, 'balances'), false)
  assert.deepEqual(state, { coins: 25, version: 1, packs: [], cards: {} })
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { parseMatchMessage } from '../src/match/messages.ts'
import { singleStoreRouter } from '../src/store/games.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import { importGameConfig } from '../src/economy/import.ts'
import { defaultVerifiers, verifyIdentityHook } from '../src/identity.ts'
import { fakeWavedash, newSigner, NOW_MS, rig, userJwt } from './economy.helpers.ts'

type Frame = Record<string, unknown>

class FakeConn {
  sent: Frame[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
}
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)) }
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/economy/${name}`, import.meta.url), 'utf8')

/** A match service over a tenant seeded by importing a game economy file (the service game is 'g'). */
async function world(name: string) {
  const api = createMemoryTableApi()
  await api.insert('etc_game', {
    code: 'g', name: 'G', repo_url: '', repo_branch: 'main', handshake_game: 'g',
    elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]',
  })
  await importGameConfig(api, fixture(name), { game: 'g' })
  const signer = newSigner()
  const fw = fakeWavedash([signer])
  const r = await rig({ api, wavedash: fw.wd, now: () => NOW_MS })
  const deps = { now: () => NOW_MS, random: Math.random, log: () => {} }
  const hooks = { verifyIdentity: verifyIdentityHook(defaultVerifiers({ wavedash: fw.wd.identityVerifier() })) }
  const service = new MatchService(deps, singleStoreRouter(r.store, r.svc), hooks)
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  /** A connection; `send` answers the frames it received for that message. */
  const client = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    return {
      conn,
      async send(m: Frame): Promise<Frame[]> {
        const from = conn.sent.length
        hub.message(id, JSON.stringify(m))
        await flush()
        return conn.sent.slice(from)
      },
    }
  }
  /** A Wavedash player on a connection. The memory store keeps identities to itself, so the tenant's etc_identities
   *  row that gifts resolve recipients through is mirrored here (the HTTP store writes it in production). */
  const wavedash = async (userId: string) => {
    const c = client()
    const [authed] = await c.send({ t: 'auth', provider: 'wavedash', token: userJwt(signer, { sub: userId }) })
    assert.equal(authed!.t, 'authed')
    await api.insert('etc_identities', { ident_key: `wavedash\u001f${userId}`, player_id: authed!.player_id })
    return c
  }
  return { r, client, wavedash }
}

/** The frame of type `t` among the frames of one message (pushes such as eco_state may come with it). */
function pick(frames: Frame[], t: string): Frame {
  const found = frames.find(f => f.t === t)
  assert.ok(found, `no ${t} in ${JSON.stringify(frames)}`)
  return found
}

test('parse: each new eco_* message is accepted', () => {
  const ok: Array<[Frame, Frame]> = [
    [{ t: 'eco_shop' }, { t: 'eco_shop' }],
    [{ t: 'eco_shop', op: 's1' }, { t: 'eco_shop', op: 's1' }],
    [{ t: 'eco_shop_buy', op: 'b1', item: 'hat.sunny', currency: 'stars' }, { t: 'eco_shop_buy', op: 'b1', item: 'hat.sunny', currency: 'stars' }],
    [{ t: 'eco_round', match_id: 'm1', round: 0, player: 'wd-1', kind: 'finish' }, { t: 'eco_round', match_id: 'm1', round: 0, player: 'wd-1', kind: 'finish' }],
    [{ t: 'eco_round', op: 'r', match_id: 'm1', round: 1000, player: 'wd-1', kind: 'finish' }, { t: 'eco_round', op: 'r', match_id: 'm1', round: 1000, player: 'wd-1', kind: 'finish' }],
    [{ t: 'eco_commission', op: 'c1', slot: 'boots', rarity: 'plain', description: 'x'.repeat(1000) }, { t: 'eco_commission', op: 'c1', slot: 'boots', rarity: 'plain', description: 'x'.repeat(1000) }],
    [{ t: 'eco_commissions' }, { t: 'eco_commissions' }],
    [{ t: 'eco_queue', op: 'q' }, { t: 'eco_queue', op: 'q' }],
    [{ t: 'eco_inbox' }, { t: 'eco_inbox' }],
    [{ t: 'eco_claim', op: 'cl1', id: 'entry-1' }, { t: 'eco_claim', op: 'cl1', id: 'entry-1' }],
    [{ t: 'eco_gift', op: 'g1', to: 'wd-2', item: 'hat.sunny' }, { t: 'eco_gift', op: 'g1', to: 'wd-2', item: 'hat.sunny' }],
    [{ t: 'eco_gift', op: 'g1', to: 'wd-2', item: 'hat.sunny', message: '' }, { t: 'eco_gift', op: 'g1', to: 'wd-2', item: 'hat.sunny', message: '' }],
    [{ t: 'eco_gift', op: 'g1', to: 'wd-2', item: 'hat.sunny', message: 'm'.repeat(280) }, { t: 'eco_gift', op: 'g1', to: 'wd-2', item: 'hat.sunny', message: 'm'.repeat(280) }],
    [{ t: 'eco_block', player: 'wd-2', blocked: false }, { t: 'eco_block', player: 'wd-2', blocked: false }],
  ]
  for (const [input, expected] of ok) assert.deepEqual(parseMatchMessage(input), expected, JSON.stringify(input))
})

test('parse: a bad field is refused with bad_message naming it', () => {
  const refused: Array<[Frame, string]> = [
    [{ t: 'eco_shop', op: 'bad op' }, 'eco_shop.op'],
    [{ t: 'eco_shop_buy', item: 'hat.sunny', currency: 'stars' }, 'eco_shop_buy.op'],
    [{ t: 'eco_shop_buy', op: 'b', item: 'hat sunny', currency: 'stars' }, 'eco_shop_buy.item'],
    [{ t: 'eco_shop_buy', op: 'b', item: 'hat.sunny' }, 'eco_shop_buy.currency'],
    [{ t: 'eco_round', round: 1, player: 'wd-1', kind: 'finish' }, 'eco_round.match_id'],
    [{ t: 'eco_round', match_id: 'm1', round: 1001, player: 'wd-1', kind: 'finish' }, 'eco_round.round'],
    [{ t: 'eco_round', match_id: 'm1', round: -1, player: 'wd-1', kind: 'finish' }, 'eco_round.round'],
    [{ t: 'eco_round', match_id: 'm1', round: 1.5, player: 'wd-1', kind: 'finish' }, 'eco_round.round'],
    [{ t: 'eco_round', match_id: 'm1', round: 1, player: '', kind: 'finish' }, 'eco_round.player'],
    [{ t: 'eco_round', match_id: 'm1', round: 1, player: 'wd-1', kind: 'a/b' }, 'eco_round.kind'],
    [{ t: 'eco_commission', slot: 'boots', rarity: 'plain', description: 'd' }, 'eco_commission.op'],
    [{ t: 'eco_commission', op: 'c', slot: 7, rarity: 'plain', description: 'd' }, 'eco_commission.slot'],
    [{ t: 'eco_commission', op: 'c', slot: 'boots', rarity: '', description: 'd' }, 'eco_commission.rarity'],
    [{ t: 'eco_commission', op: 'c', slot: 'boots', rarity: 'plain', description: '' }, 'eco_commission.description'],
    [{ t: 'eco_commission', op: 'c', slot: 'boots', rarity: 'plain', description: 'x'.repeat(1001) }, 'eco_commission.description'],
    [{ t: 'eco_commissions', op: 'x'.repeat(65) }, 'eco_commissions.op'],
    [{ t: 'eco_queue', op: 3 }, 'eco_queue.op'],
    [{ t: 'eco_inbox', op: '' }, 'eco_inbox.op'],
    [{ t: 'eco_claim', id: 'e1' }, 'eco_claim.op'],
    [{ t: 'eco_claim', op: 'cl', id: 'x'.repeat(97) }, 'eco_claim.id'],
    [{ t: 'eco_gift', to: 'wd-2', item: 'hat.sunny' }, 'eco_gift.op'],
    [{ t: 'eco_gift', op: 'g', to: 'wd 2', item: 'hat.sunny' }, 'eco_gift.to'],
    [{ t: 'eco_gift', op: 'g', to: 'wd-2' }, 'eco_gift.item'],
    [{ t: 'eco_gift', op: 'g', to: 'wd-2', item: 'hat.sunny', message: 'm'.repeat(281) }, 'eco_gift.message'],
    [{ t: 'eco_gift', op: 'g', to: 'wd-2', item: 'hat.sunny', message: 5 }, 'eco_gift.message'],
    [{ t: 'eco_block', blocked: true }, 'eco_block.player'],
    [{ t: 'eco_block', player: 'wd-2', blocked: 'yes' }, 'eco_block.blocked'],
  ]
  for (const [input, field] of refused) {
    const r = parseMatchMessage(input) as { error?: string; message?: string }
    assert.equal(r.error, 'bad_message', JSON.stringify(input))
    assert.ok(r.message!.startsWith(field), `${JSON.stringify(input)} -> ${r.message}`)
  }
})

test('connection, other game: shop, round, buy, commission, gift, inbox and claim', async () => {
  const w = await world('other-game.economy.json')
  const host = w.client()
  assert.equal(pick(await host.send({ t: 'auth', provider: 'guest', token: 'guest-token-for-the-host-1' }), 'authed').t, 'authed')
  const alice = await w.wavedash('wd-alice')
  const bob = await w.wavedash('wd-bob')

  const shop = pick(await host.send({ t: 'eco_shop', op: 's1' }), 'eco_shop')
  assert.deepEqual([shop.op, shop.drop, shop.slots], ['s1', 'star-drop', ['hat', 'cape', 'boots']])
  const hat = (shop.items as Frame[]).find(i => i.id === 'hat.sunny')!
  assert.deepEqual([hat.sold, hat.remaining], [0, 2])

  // The host reports two champion rounds; the same report again answers applied:false. Alice's state is pushed.
  const round = { t: 'eco_round', op: 'r1', match_id: 'm1', round: 1, player: 'wd-alice', kind: 'champion' }
  const first = await host.send(round)
  const reported = pick(first, 'eco_round')
  assert.deepEqual({ ...reported, granted: undefined }, { t: 'eco_round', op: 'r1', match_id: 'm1', round: 1, player: 'wd-alice', kind: 'champion', granted: undefined, applied: true })
  assert.deepEqual((reported.granted as { currencies: unknown }).currencies, { stars: 1 })
  assert.equal(pick(await host.send(round), 'eco_round').applied, false)
  assert.equal(pick(await host.send({ ...round, op: 'r2', round: 2 }), 'eco_round').applied, true)
  assert.deepEqual((alice.conn.sent.filter(f => f.t === 'eco_state').at(-1)!).balances, { stars: 2 })
  assert.deepEqual(await alice.send({ t: 'eco_round', match_id: 'm1', round: 3, player: 'wd-alice', kind: 'champion' }), [{ t: 'error', reason: 'forbidden' }])

  // Alice buys the capped hat in stars; a currency the item has no price in is refused.
  const bought = pick(await alice.send({ t: 'eco_shop_buy', op: 'b1', item: 'hat.sunny', currency: 'stars' }), 'eco_shop_bought')
  assert.deepEqual(bought, { t: 'eco_shop_bought', op: 'b1', item: 'hat.sunny', currency: 'stars', price: 1, coins: 0, balances: { stars: 1 }, remaining: 1, applied: true })
  assert.deepEqual(pick(await alice.send({ t: 'eco_shop_buy', op: 'b2', item: 'boots.moon', currency: 'stars' }), 'error'), { t: 'error', reason: 'no_price', op: 'b2' })
  assert.deepEqual(pick(await alice.send({ t: 'eco_shop_buy', op: 'b3', item: 'hat.sunny', currency: 'stars' }), 'error'), { t: 'error', reason: 'already_owned', op: 'b3' })
  assert.deepEqual(pick(await alice.send({ t: 'eco_shop_buy', op: 'b4', item: 'ghost', currency: 'stars' }), 'error'), { t: 'error', reason: 'unknown_item', op: 'b4' })

  // The description filter refuses a banned word; a clean description is commissioned with the last star.
  assert.deepEqual(pick(await alice.send({ t: 'eco_commission', op: 'c1', slot: 'boots', rarity: 'plain', description: 'Boots full of spam' }), 'error'),
    { t: 'error', reason: 'description_refused', op: 'c1' })
  const made = pick(await alice.send({ t: 'eco_commission', op: 'c2', slot: 'boots', rarity: 'plain', description: 'Boots with little clouds' }), 'eco_commissioned')
  const commission = made.commission as Frame
  assert.deepEqual([made.op, made.applied, commission.slot, commission.rarity, commission.description, commission.status],
    ['c2', true, 'boots', 'plain', 'Boots with little clouds', 'pending'])
  assert.deepEqual(pick(await alice.send({ t: 'eco_commissions' }), 'eco_commissions'), { t: 'eco_commissions', items: [commission] })
  assert.deepEqual(pick(await bob.send({ t: 'eco_queue', op: 'q1' }), 'eco_queue'), { t: 'eco_queue', op: 'q1', items: [commission] })

  // The gift reaches Bob's inbox; Bob claims it into his collection.
  assert.deepEqual(pick(await alice.send({ t: 'eco_gift', op: 'g0', to: 'wd-nobody', item: 'hat.sunny' }), 'error'), { t: 'error', reason: 'not_found', op: 'g0' })
  assert.deepEqual(pick(await alice.send({ t: 'eco_gift', op: 'g1', to: 'wd-bob', item: 'hat.sunny', message: 'For you' }), 'eco_gifted'),
    { t: 'eco_gifted', op: 'g1', to: 'wd-bob', item: 'hat.sunny', applied: true })
  const inbox = pick(await bob.send({ t: 'eco_inbox', op: 'i1' }), 'eco_inbox')
  assert.deepEqual([inbox.op, inbox.unread], ['i1', 1])
  const [entry, ...rest] = inbox.entries as Frame[]
  assert.deepEqual(rest, [])
  assert.deepEqual([entry!.item, entry!.sender, entry!.message, entry!.claimed], ['hat.sunny', { kind: 'player', id: 'wd-alice' }, 'For you', false])
  const claimed = await bob.send({ t: 'eco_claim', op: 'cl1', id: entry!.id })
  assert.deepEqual(pick(claimed, 'eco_claimed'), { t: 'eco_claimed', op: 'cl1', id: entry!.id, item: 'hat.sunny', applied: true })
  assert.deepEqual(pick(claimed, 'eco_state').cards, { 'hat.sunny': 1 })
  assert.deepEqual(pick(await bob.send({ t: 'eco_claim', op: 'cl2', id: entry!.id }), 'error'), { t: 'error', reason: 'already_claimed', op: 'cl2' })
  assert.deepEqual(pick(await bob.send({ t: 'eco_claim', op: 'cl3', id: 'no-such-entry' }), 'error'), { t: 'error', reason: 'not_found', op: 'cl3' })
  assert.equal(pick(await bob.send({ t: 'eco_inbox' }), 'eco_inbox').unread, 0)

  // Bob blocks Alice's gifts.
  assert.deepEqual(await bob.send({ t: 'eco_block', op: 'k1', player: 'wd-alice', blocked: true }), [{ t: 'eco_blocked', op: 'k1', player: 'wd-alice', blocked: true }])
})

test('connection, kekkai-like game: eco_get keeps the old shape', async () => {
  const w = await world('kekkai-like.economy.json')
  const a = w.client()
  await a.send({ t: 'auth', provider: 'guest', token: 'guest-token-for-kekkai-1' })
  assert.deepEqual(await a.send({ t: 'eco_get', op: 'g1' }), [{ t: 'eco_state', op: 'g1', coins: 0, version: 0, packs: [], cards: {} }])
  assert.equal(pick(await a.send({ t: 'eco_reward', reward_id: 'tuto:intro' }), 'eco_reward').coins, 25)
  assert.deepEqual(await a.send({ t: 'eco_get' }), [{ t: 'eco_state', coins: 25, version: 1, packs: [], cards: {} }])
})

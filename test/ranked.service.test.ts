// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Ranked integrity of MatchService: forfeits, inactivity, weight, lone draw, rewardable, recordMatch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { guestIdentity } from '../src/hooks.ts'
import type { HandshakeHooks, MatchRecord } from '../src/hooks.ts'
import type { PlayerStore } from '../src/store/types.ts'

class FakeConn {
  sent: Record<string, unknown>[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
  types(): unknown[] { return this.sent.map((m) => m.t) }
  last(): Record<string, unknown> | undefined { return this.sent.at(-1) }
}

/** Wavedash tokens map to fixed subs; guest tokens go through guestIdentity. */
const WAVEDASH: Record<string, { sub: string; name: string }> = {
  'wd-token-a': { sub: 'wd-sub-a', name: 'Alice' },
  'wd-token-b': { sub: 'wd-sub-b', name: 'Bruno' },
  'wd-token-c': { sub: 'wd-sub-c', name: 'Chloe' },
  'wd-token-d': { sub: 'wd-sub-d', name: 'Dario' },
}
const verifyIdentity: NonNullable<HandshakeHooks['verifyIdentity']> = async (provider, token, name) => {
  if (provider === 'guest') return guestIdentity(token, name)
  const w = provider === 'wavedash' ? WAVEDASH[token] : undefined
  return w ? { provider: 'wavedash', external_id: w.sub, display_name: w.name } : null
}

function setup(store: PlayerStore = createMemoryStore(), hooks: HandshakeHooks = {},
  opts: { rankedRequireAccount?: boolean } = {}) {
  const clock = { t: 1_000_000 }
  const logs: string[] = []
  const deps = { now: () => clock.t, random: Math.random, log: (level: string, msg: string) => { logs.push(`${level} ${msg}`) } }
  const service = new MatchService(deps, store, { verifyIdentity, ...hooks }, opts)
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const add = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    const frame = (m: Record<string, unknown>) => hub.message(id, JSON.stringify(m))
    return { conn, id, frame }
  }
  const step = async (ms: number) => { clock.t += ms; hub.tick(clock.t); await flush() }
  return { hub, service, store, clock, add, logs, step }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

const wavedash = (who: 'a' | 'b' | 'c' | 'd') => ({ t: 'auth', provider: 'wavedash', token: `wd-token-${who}`, game: 'kekkai' })
const guest = (n: number) => ({ t: 'auth', provider: 'guest', token: `guest-token-${n}-abcdefgh`, game: 'kekkai' })

type S = ReturnType<typeof setup>
type Side = ReturnType<S['add']>

/** Seat A queues first (seat 0), seat B second (seat 1), both ranked. */
async function rankedPair(s: S, authB: Record<string, unknown> = wavedash('b'), authA = wavedash('a')) {
  const a = s.add(), b = s.add()
  a.frame(authA); b.frame(authB)
  await flush()
  a.frame({ t: 'match_queue', game: 'kekkai', queue: 'ranked' })
  await flush()
  b.frame({ t: 'match_queue', game: 'kekkai', queue: 'ranked' })
  await flush()
  const idA = a.conn.sent[0].player_id as string, idB = b.conn.sent[0].player_id as string
  assert.equal(a.conn.sent.find((m) => m.t === 'match')!.seat, 0)
  return { a, b, idA, idB }
}

const matchOf = (c: Side) => c.conn.sent.find((m) => m.t === 'match')!.match_id as string
const ends = (c: Side) => c.conn.sent.filter((m) => m.t === 'match_end')
const report = (c: Side, outcome: string) => c.frame({ t: 'result', match_id: matchOf(c), outcome })
type Rating = { before: number; after: number; games: number; placement: boolean; tier: string }
const ratingOf = (c: Side) => ends(c)[0].rating as Rating

function recording(order?: string[]) {
  const records: MatchRecord[] = []
  return {
    records,
    hooks: { onMatchEnd: (r: MatchRecord) => { order?.push(`onMatchEnd ${r.match_id}`); records.push(r) } } as HandshakeHooks,
  }
}

test('forfeit: bye before report forfeits the leaver (left), A drops and B rises', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await rankedPair(s)
  p.a.frame({ t: 'bye' })
  await flush()
  assert.deepEqual(records.map((r) => [r.status, r.reason, r.score_a]), [['forfeit', 'left', 0]])
  for (const c of [p.a, p.b]) {
    assert.equal(ends(c).length, 1)
    assert.equal(ends(c)[0].status, 'forfeit')
    assert.equal(ends(c)[0].reason, 'left')
  }
  assert.equal(ends(p.a)[0].outcome, 'loss')
  assert.equal(ends(p.b)[0].outcome, 'win')
  assert.equal(ratingOf(p.a).before, 2500)
  assert.equal(ratingOf(p.b).before, 2500)
  assert.ok(ratingOf(p.a).after < 2500)
  assert.ok(ratingOf(p.b).after > 2500)
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 0 })
})

test('forfeit: bye after own report keeps the report window, then agreement completes', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await rankedPair(s)
  report(p.a, 'win')
  await flush()
  p.a.frame({ t: 'bye' })
  await flush()
  assert.equal(ends(p.a).length, 0)
  assert.equal(ends(p.b).length, 0)
  assert.equal(records.length, 0)
  assert.equal(s.service.stats().matches, 1)
  report(p.b, 'loss')
  await flush()
  assert.deepEqual(records.map((r) => [r.status, r.reason, r.score_a]), [['complete', 'agreed', 1]])
  assert.equal(ends(p.a)[0].status, 'complete')
  assert.equal(ends(p.a)[0].reason, 'agreed')
  assert.equal(ends(p.a)[0].outcome, 'win')
  assert.equal(ends(p.b)[0].outcome, 'loss')
})

test('forfeit: a non-graceful close forfeits only after 90 000 ms (disconnect)', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await rankedPair(s)
  s.hub.disconnect(p.a.id)
  await s.step(89_999)
  assert.equal(records.length, 0)
  assert.equal(ends(p.b).length, 0)
  await s.step(1)
  assert.deepEqual(records.map((r) => [r.status, r.reason, r.score_a]), [['forfeit', 'disconnect', 0]])
  assert.equal(ends(p.b)[0].status, 'forfeit')
  assert.equal(ends(p.b)[0].reason, 'disconnect')
  assert.equal(ends(p.b)[0].outcome, 'win')
})

test('forfeit: inactivity voids at 600 000 ms after the last act, not at 599 999', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await rankedPair(s)
  await s.step(5_000)
  p.a.frame({ t: 'act', a: { k: 'move' }, n: 1 })
  await flush()
  await s.step(599_999)
  assert.equal(records.length, 0)
  assert.equal(ends(p.a).length, 0)
  assert.ok(!p.b.conn.types().includes('opp_left'))
  await s.step(1)
  assert.deepEqual(records.map((r) => [r.status, r.reason, r.score_a]), [['void', 'inactivity', null]])
  for (const c of [p.a, p.b]) {
    assert.equal(ends(c).length, 1)
    assert.equal(ends(c)[0].status, 'void')
    assert.equal(ends(c)[0].reason, 'inactivity')
    assert.equal(ends(c)[0].outcome, null)
    assert.ok(c.conn.types().includes('opp_left'))
  }
  for (const id of [p.idA, p.idB]) assert.equal((await s.store.getPlayer(id))!.active_ranked_match, null)
  assert.equal(s.hub.stats().sessions, 0)
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 0 })
})

test('forfeit: start reaps 2 stale ranked locks', async () => {
  const store = createMemoryStore()
  const ids: string[] = []
  for (const [n, lock] of [[1, 'stale-1'], [2, 'stale-2']] as const) {
    const { player } = await store.getOrCreateByIdentity({ provider: 'wavedash', external_id: `stale-sub-${n}` })
    assert.equal(await store.lockRanked(player.player_id, lock), true)
    ids.push(player.player_id)
  }
  const s = setup(store)
  assert.equal(await s.service.start(), 2)
  for (const id of ids) assert.equal((await store.getPlayer(id))!.active_ranked_match, null)
})

/** Plays one agreed A-win after `ms` of play and returns the match_end of each seat. */
async function agreedWinAfter(s: S, p: Awaited<ReturnType<typeof rankedPair>>, ms: number) {
  await s.step(ms)
  report(p.a, 'win'); report(p.b, 'loss')
  await flush()
  return [ends(p.a)[0], ends(p.b)[0]]
}

test('outcome: an agreed win at started_at + 179 999 counts at weight 0.5 (2540/2460)', async () => {
  const s = setup()
  const p = await rankedPair(s)
  const [ea, eb] = await agreedWinAfter(s, p, 179_999)
  assert.equal(ea.weight, 0.5)
  assert.equal(eb.weight, 0.5)
  assert.equal(ea.duration_ms, 179_999)
  assert.equal((ea.rating as Rating).after, 2540)
  assert.equal((eb.rating as Rating).after, 2460)
})

test('outcome: an agreed win at started_at + 180 000 counts at weight 1 (2580/2420)', async () => {
  const s = setup()
  const p = await rankedPair(s)
  const [ea, eb] = await agreedWinAfter(s, p, 180_000)
  assert.equal(ea.weight, 1)
  assert.equal(eb.weight, 1)
  assert.equal(ea.duration_ms, 180_000)
  assert.equal((ea.rating as Rating).after, 2580)
  assert.equal((eb.rating as Rating).after, 2420)
})

test('outcome: a lone draw report is a loss for the reporter only (lone_draw)', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await rankedPair(s)
  await s.step(180_000)
  report(p.a, 'draw')
  await flush()
  await s.step(59_999)
  assert.equal(records.length, 0)
  await s.step(1)
  assert.deepEqual(records.map((r) => [r.status, r.reason, r.score_a]), [['complete', 'lone_draw', 0]])
  assert.equal(ends(p.a)[0].status, 'complete')
  assert.equal(ends(p.a)[0].reason, 'lone_draw')
  assert.equal(ends(p.a)[0].outcome, 'loss')
  assert.equal(ratingOf(p.a).after, 2420)
  assert.equal(ratingOf(p.a).games, 1)
  const rb = await s.store.getRating(p.idB, 'kekkai')
  assert.equal(rb.rating, 2500)
  assert.equal(rb.games, 0)
})

test('outcome: rewardable only for an agreed full-length match between two wavedash players', async () => {
  const rewardable = async (scenario: 'full' | 'guest' | 'short' | 'left' | 'void') => {
    const { records, hooks } = recording()
    const s = setup(createMemoryStore(), hooks, { rankedRequireAccount: false })
    const p = await rankedPair(s, scenario === 'guest' ? guest(7) : wavedash('b'))
    await s.step(scenario === 'short' ? 179_999 : 180_000)
    if (scenario === 'left') p.a.frame({ t: 'bye' })
    else if (scenario === 'void') { report(p.a, 'win'); report(p.b, 'win') }
    else { report(p.a, 'win'); report(p.b, 'loss') }
    await flush()
    assert.equal(records.length, 1, scenario)
    assert.equal(ends(p.a)[0].rewardable, records[0].rewardable, scenario)
    assert.equal(ends(p.b)[0].rewardable, records[0].rewardable, scenario)
    return [records[0].status, records[0].reason, records[0].rewardable]
  }
  assert.deepEqual(await rewardable('full'), ['complete', 'agreed', true])
  assert.deepEqual(await rewardable('guest'), ['complete', 'agreed', false])
  assert.deepEqual(await rewardable('short'), ['complete', 'agreed', false])
  assert.deepEqual(await rewardable('left'), ['forfeit', 'left', false])
  assert.deepEqual(await rewardable('void'), ['void', 'disagreement', false])
})

test('outcome: recordMatch runs once per match_id, before onMatchEnd, and a repeat is not applied', async () => {
  const order: string[] = []
  const calls: MatchRecord[] = []
  const base = createMemoryStore()
  const store: PlayerStore = Object.assign(Object.create(base) as PlayerStore, {
    recordMatch: (r: MatchRecord) => { order.push(`recordMatch ${r.match_id}`); calls.push(r); return base.recordMatch(r) },
  })
  const { records, hooks } = recording(order)
  const s = setup(store, hooks)
  const p1 = await rankedPair(s)
  await agreedWinAfter(s, p1, 180_000)
  const p2 = await rankedPair(s, wavedash('d'), wavedash('c'))
  report(p2.a, 'win'); report(p2.b, 'win')
  await flush()
  await s.step(700_000)
  const ids = [matchOf(p1.a), matchOf(p2.a)]
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual(records.map((r) => r.match_id), ids)
  assert.deepEqual(calls.map((r) => r.match_id), ids)
  assert.deepEqual(order, ids.flatMap((id) => [`recordMatch ${id}`, `onMatchEnd ${id}`]))
  assert.deepEqual(await store.recordMatch(calls[0]), { applied: false })
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// End-to-end ranked tests over real sockets against two createHandshake instances (guest gate on and off):
// the guest gate, the ladder message and its cache, and display-name cleaning. Time only moves through the
// fake clock and handshake.tick; "nothing happened" is checked after a message round-trip, never a real delay.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHandshake } from '../src/handshake.ts'
import type { Handshake } from '../src/handshake.ts'
import { RELAY_PATH } from '../src/relay/protocol.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import type { PlayerStore } from '../src/store/types.ts'
import { tierOf } from '../src/store/elo.ts'
import { guestIdentity } from '../src/hooks.ts'
import type { HandshakeHooks } from '../src/hooks.ts'
import { sanitizeName } from '../src/names.ts'

type Msg = Record<string, any>

let WsClient: any = null
try {
  WsClient = (await import('ws')).WebSocket
} catch {
  WsClient = null
}
const skip = WsClient === null ? 'ws not installed' : false

const LADDER_GAME = 'e2e-ladder'
const clock = { t: 1_000_000 }
const base = createMemoryStore()
const reads = { leaderboard: 0, rankOf: 0 }
/** The memory store with `leaderboard` and `rankOf` calls counted (the ladder cache's store reads). */
const store: PlayerStore = new Proxy(base, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver)
    if (typeof v !== 'function') return v
    if (prop === 'leaderboard' || prop === 'rankOf') {
      return (...args: unknown[]) => { reads[prop]++; return (v as Function).apply(target, args) }
    }
    return (v as Function).bind(target)
  },
})
const totalReads = (): number => reads.leaderboard + reads.rankOf

let gated: Handshake | null = null
let open: Handshake | null = null
let gatedPort = 0
let openPort = 0
const sockets: any[] = []
/** Seeded ranked players, in seeding order: wavedash sub and player id. */
const seeded: { sub: string; player_id: string }[] = []

const hooks: HandshakeHooks = {
  async verifyIdentity(provider, token, name) {
    if (provider === 'wavedash') {
      if (!token.startsWith('wd-')) return null
      const sub = token.slice(3)
      return { provider: 'wavedash', external_id: sub, display_name: sanitizeName(name, 'Player-xxxx') }
    }
    if (provider === 'guest') return guestIdentity(token, name)
    return null
  },
}

let ready: Promise<void> = Promise.resolve()

before(() => (ready = (async () => {
  if (skip) return
  // 25 ranked players: player i wins 5 + i one-sided games against a placement dummy, so ratings are distinct.
  const { player: dummy } = await base.getOrCreateByIdentity({ provider: 'guest', external_id: 'ladder-dummy' })
  for (let i = 0; i < 25; i++) {
    const sub = `lad-${String(i).padStart(2, '0')}`
    const { player } = await base.getOrCreateByIdentity({ provider: 'wavedash', external_id: sub }, { display_name: `Ladder ${i}` })
    for (let g = 0; g < 5 + i; g++) {
      await base.applyRankedResult({ match_id: `seed-${sub}-${g}`, game: LADDER_GAME, a: player.player_id, b: dummy.player_id, score_a: 1, only: 'a' })
    }
    seeded.push({ sub, player_id: player.player_id })
  }
  const make = (rankedRequireAccount: boolean): Handshake => createHandshake({
    config: { port: 0, host: '127.0.0.1', logLevel: 'error', rankedRequireAccount },
    deps: { now: () => clock.t },
    autoTick: false,
    store,
    hooks,
  })
  gated = make(true)
  open = make(false)
  gatedPort = (await gated.listen()).port
  openPort = (await open.listen()).port
})()))

after(async () => {
  await ready
  for (const ws of sockets) { try { ws.close() } catch { /* closing */ } }
  for (const s of [gated, open]) if (s) await s.close()
  gated = null
  open = null
})

function tick(ms: number): void {
  clock.t += ms
  gated?.tick(clock.t)
  open?.tick(clock.t)
}

interface Client {
  msgs: Msg[]
  send(m: Msg): void
  wait(pred: (m: Msg) => boolean, from?: number): Promise<Msg>
  close(): void
}

async function connect(onPort: number): Promise<Client> {
  const ws = new WsClient(`ws://127.0.0.1:${onPort}${RELAY_PATH}`)
  sockets.push(ws)
  const msgs: Msg[] = []
  const waiters: { pred(m: Msg): boolean; from: number; resolve(m: Msg): void }[] = []
  const pump = (): void => {
    for (const w of waiters.slice()) {
      const found = msgs.find((m, i) => i >= w.from && w.pred(m))
      if (found) { waiters.splice(waiters.indexOf(w), 1); w.resolve(found) }
    }
  }
  ws.on('message', (data: Buffer) => {
    msgs.push(JSON.parse(data.toString()) as Msg)
    pump()
  })
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    msgs,
    send(m) { ws.send(JSON.stringify(m)) },
    wait(pred, from = 0) {
      return new Promise((resolve, reject) => {
        const w = { pred, from, resolve: (m: Msg) => { clearTimeout(timer); resolve(m) } }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error('timeout'))
        }, 1500)
        waiters.push(w)
        pump()
      })
    },
    close() { ws.close() },
  }
}

/** Sends `m` and returns the next reply matching `pred` (an error always matches). */
async function ask(c: Client, m: Msg, pred: (m: Msg) => boolean): Promise<Msg> {
  const from = c.msgs.length
  c.send(m)
  return c.wait((r) => r.t === 'error' || pred(r), from)
}

let tokenSeq = 0
async function guest(onPort: number, name?: string, game?: string): Promise<[Client, Msg]> {
  const c = await connect(onPort)
  const token = `e2e-ranked-token-${String(++tokenSeq).padStart(4, '0')}`
  const m: Msg = { t: 'auth', provider: 'guest', token }
  if (name !== undefined) m.name = name
  if (game !== undefined) m.game = game
  const authed = await ask(c, m, (r) => r.t === 'authed')
  assert.equal(authed.t, 'authed')
  return [c, authed]
}

async function wavedash(onPort: number, sub: string, name?: string, game?: string): Promise<[Client, Msg]> {
  const c = await connect(onPort)
  const m: Msg = { t: 'auth', provider: 'wavedash', token: `wd-${sub}` }
  if (name !== undefined) m.name = name
  if (game !== undefined) m.game = game
  const authed = await ask(c, m, (r) => r.t === 'authed')
  assert.equal(authed.t, 'authed')
  return [c, authed]
}

const queue = (c: Client, game: string, q: string): Promise<Msg> =>
  ask(c, { t: 'match_queue', game, queue: q }, (r) => r.t === 'match_queued')

/** Leaves the queue so a later tick never pairs this test's player. */
async function unqueue(c: Client): Promise<void> {
  assert.equal((await ask(c, { t: 'match_unqueue' }, (r) => r.t === 'match_unqueued')).t, 'match_unqueued')
}

const ladder = (c: Client, page: unknown): Promise<Msg> => ask(c, { t: 'ladder', page }, (r) => r.t === 'ladder')

// --- gate -------------------------------------------------------------------------------------------------------

test('gate: with the flag on a guest ranked queue is refused and nothing is queued', { skip }, async () => {
  const [c] = await guest(gatedPort)
  const err = await queue(c, 'e2e-gate', 'ranked')
  assert.deepEqual(err, { t: 'error', reason: 'ranked_requires_account' })
  const un = await ask(c, { t: 'match_unqueue' }, (r) => r.t === 'match_unqueued')
  assert.equal(un.t, 'error')
  assert.equal(un.reason, 'not_queued')
  c.close()
})

test('gate: with the flag off a guest is queued ranked', { skip }, async () => {
  const [c] = await guest(openPort)
  const q = await queue(c, 'e2e-gate', 'ranked')
  assert.equal(q.t, 'match_queued')
  assert.equal(q.queue, 'ranked')
  await unqueue(c)
  c.close()
})

test('gate: with the flag on a wavedash player is queued ranked', { skip }, async () => {
  const [c] = await wavedash(gatedPort, 'gate-wd', 'Gatekeeper')
  const q = await queue(c, 'e2e-gate', 'ranked')
  assert.equal(q.t, 'match_queued')
  assert.equal(q.queue, 'ranked')
  await unqueue(c)
  c.close()
})

test('gate: with the flag on a guest is queued quick', { skip }, async () => {
  const [c] = await guest(gatedPort)
  const q = await queue(c, 'e2e-gate', 'quick')
  assert.equal(q.t, 'match_queued')
  assert.equal(q.queue, 'quick')
  await unqueue(c)
  c.close()
})

// --- ladder -----------------------------------------------------------------------------------------------------

test('ladder: page 1 has page_size 10 and 10 entries', { skip }, async () => {
  const [c] = await guest(openPort, undefined, LADDER_GAME)
  const l = await ladder(c, 1)
  assert.equal(l.t, 'ladder')
  assert.equal(l.game, LADDER_GAME)
  assert.equal(l.page, 1)
  assert.equal(l.page_size, 10)
  assert.equal(l.total, 25)
  assert.equal(l.entries.length, 10)
  assert.deepEqual(l.entries.map((e: Msg) => e.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  c.close()
})

test('ladder: page 2 holds ranks 11..20 in leaderboard order', { skip }, async () => {
  const [c] = await guest(openPort, undefined, LADDER_GAME)
  const l = await ladder(c, 2)
  assert.equal(l.t, 'ladder')
  assert.equal(l.page, 2)
  assert.deepEqual(l.entries.map((e: Msg) => e.rank), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  const lb = (await base.leaderboard(LADDER_GAME, 1)).entries.slice(10, 20)
  assert.deepEqual(l.entries, lb.map(({ rank, player_id, display_name, rating, tier }) => ({ rank, player_id, display_name, rating, tier })))
  const ratings = new Set((await base.leaderboard(LADDER_GAME, 1)).entries.map((e) => e.rating))
  assert.equal(ratings.size, 25, 'seeded ratings are distinct')
  c.close()
})

test('ladder: a registered ranked player gets its own rank in me', { skip }, async () => {
  const who = seeded[7]
  const [c, authed] = await wavedash(openPort, who.sub, undefined, LADDER_GAME)
  assert.equal(authed.player_id, who.player_id)
  const l = await ladder(c, 1)
  assert.equal(l.t, 'ladder')
  const entry = (await base.leaderboard(LADDER_GAME, 1)).entries.find((e) => e.player_id === who.player_id)!
  const r = await base.getRating(who.player_id, LADDER_GAME)
  assert.deepEqual(l.me, { rank: entry.rank, rating: r.rating, tier: tierOf(r.rating), placement: false, games: 12 })
  assert.equal(l.me.rating, entry.rating)
  c.close()
})

test('ladder: a guest gets me null', { skip }, async () => {
  const [c] = await guest(openPort, undefined, LADDER_GAME)
  const l = await ladder(c, 1)
  assert.equal(l.t, 'ladder')
  assert.equal(l.me, null)
  c.close()
})

test('ladder: a page is cached for 45 000 ms and then read again once', { skip }, async () => {
  const [c] = await guest(openPort, undefined, LADDER_GAME)
  tick(45001) // drop whatever earlier tests cached
  let n = totalReads()
  assert.equal((await ladder(c, 1)).t, 'ladder')
  assert.equal(reads.leaderboard + reads.rankOf - n, 1, 'the first fetch is a miss')
  const first = clock.t

  tick(44999)
  n = totalReads()
  assert.equal((await ladder(c, 1)).t, 'ladder')
  assert.equal(totalReads() - n, 0, 'a hit at +44 999 ms reads nothing')

  tick(first + 45001 - clock.t)
  n = totalReads()
  const lb = reads.leaderboard
  assert.equal((await ladder(c, 1)).t, 'ladder')
  assert.equal(totalReads() - n, 1, 'a miss at +45 001 ms reads once')
  assert.equal(reads.leaderboard - lb, 1)
  c.close()
})

test('ladder: bad pages and a ladder before auth give bad_message', { skip }, async () => {
  const [c] = await guest(openPort, undefined, LADDER_GAME)
  for (const page of [0, 1001, 1.5, '2']) {
    const r = await ladder(c, page)
    assert.equal(r.t, 'error', `page ${JSON.stringify(page)}`)
    assert.equal(r.reason, 'bad_message', `page ${JSON.stringify(page)}`)
  }
  c.close()
  // Before auth the parser still decides first: a bad page is bad_message; a valid one needs auth (contract).
  const anon = await connect(openPort)
  for (const page of [0, '2']) {
    const r = await ladder(anon, page)
    assert.equal(r.t, 'error')
    assert.equal(r.reason, 'bad_message', `page ${JSON.stringify(page)} before auth`)
  }
  const r = await ladder(anon, 1)
  assert.equal(r.t, 'error')
  assert.equal(r.reason, 'auth_required')
  anon.close()
})

// --- names ------------------------------------------------------------------------------------------------------

test('names: a guest name is cleaned and a too short one falls back to Guest-XXXX', { skip }, async () => {
  const [a, aa] = await guest(openPort, ' Al\u200Bice  ')
  assert.equal(aa.display_name, 'Alice')
  const [b, ab] = await guest(openPort, 'Al')
  assert.match(ab.display_name, /^Guest-[0-9A-F]{4}$/)
  a.close()
  b.close()
})

test('names: a wavedash re-auth with a new clean name renames the player', { skip }, async () => {
  const [a, aa] = await wavedash(openPort, 'rename-1', 'Wavey')
  assert.equal(aa.display_name, 'Wavey')
  const [b, ab] = await wavedash(openPort, 'rename-1', 'Wavey2')
  assert.equal(ab.player_id, aa.player_id)
  assert.equal(ab.display_name, 'Wavey2')
  assert.equal((await base.getPlayer(aa.player_id))!.display_name, 'Wavey2')
  const [c, ac] = await wavedash(openPort, 'rename-1', '\u200B\u0007\u200B')
  assert.equal(ac.display_name, 'Wavey2')
  assert.equal((await base.getPlayer(aa.player_id))!.display_name, 'Wavey2')
  for (const x of [a, b, c]) x.close()
})

test('names: match.opponent carries name, rating, tier, placement and games', { skip }, async () => {
  const game = 'e2e-names'
  const [x, ax] = await wavedash(gatedPort, 'opp-x', 'Xavier')
  const [y, ay] = await wavedash(gatedPort, 'opp-y', 'Yolanda')
  for (const c of [x, y]) assert.equal((await queue(c, game, 'ranked')).t, 'match_queued')
  tick(1000)
  for (const [c, opp] of [[x, ay], [y, ax]] as const) {
    const m = await c.wait((v) => v.t === 'match')
    assert.deepEqual(m.opponent, {
      player_id: opp.player_id, display_name: opp.display_name, rating: 2500, tier: tierOf(2500), placement: true, games: 0,
    })
  }
  assert.equal(ax.display_name, 'Xavier')
  assert.equal(ay.display_name, 'Yolanda')
  x.close()
  y.close()
})

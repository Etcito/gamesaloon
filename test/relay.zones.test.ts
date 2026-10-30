// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { routeMask, ZoneGroup } from '../src/relay/groups.ts'
import { GameQueues, queueKey } from '../src/relay/gameQueues.ts'
import {
  MAX_INVALID, MAX_ROOMS, MAX_ZONE_PEERS, RATE_PER_SEC, RELAY_ERROR_CODES,
  RESUME_GRACE_MS, parseRelayMessage,
} from '../src/relay/protocol.ts'
import {
  DEFAULT_RELAY_MAX_BIN_BYTES, DEFAULT_RELAY_BIN_RATE_PER_SEC, loadConfig, parseGameLimits,
} from '../src/config.ts'
import { RelayHub } from '../src/relay/hub.ts'
import { relayEndpoint } from '../src/relay/endpoint.ts'
import { BIN_IN_HEADER, BIN_KIND } from '../src/relay/binary.ts'
import { createHandshake } from '../src/handshake.ts'

class FakeConn {
  sent: Record<string, unknown>[] = []
  binaries: Uint8Array[] = []
  closes = 0
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  sendBinary(frame: Uint8Array): void { this.binaries.push(frame) }
  close(): void { this.closes++ }
  types(): unknown[] { return this.sent.map((m) => m.t) }
}

function setup(opts: ConstructorParameters<typeof RelayHub>[2] = {}) {
  const clock = { t: 1_000_000 }
  let seed = 7
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const hub = new RelayHub({ now: () => clock.t, random, log: () => {} }, undefined, {
    games: parseGameLimits('royal-fiesta:64,other-game:4'), ...opts,
  })
  const add = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    return { conn, id }
  }
  const send = (c: { id: string }, msg: Record<string, unknown>) => hub.message(c.id, JSON.stringify(msg))
  return { hub, clock, add, send }
}

function createRoom(s: ReturnType<typeof setup>, players = 2, game: string | null = 'royal-fiesta') {
  const members = Array.from({ length: players }, () => s.add())
  s.send(members[0], { t: 'create', players, ...(game === null ? {} : { game, zones: true }) })
  const code = members[0].conn.sent[0].code as string
  for (const member of members.slice(1)) s.send(member, { t: 'join', code })
  return members
}

function binaryFrame(maskLo = 0, maskHi = 0, payload = Uint8Array.of(7, 9)): Uint8Array {
  const frame = new Uint8Array(BIN_IN_HEADER + payload.byteLength)
  frame[0] = BIN_KIND
  const view = new DataView(frame.buffer)
  view.setUint32(2, maskLo, true)
  view.setUint32(6, maskHi, true)
  frame.set(payload, BIN_IN_HEADER)
  return frame
}

test('zero mask broadcasts in seat order except to the sender', () => {
  const out = new Array<number>(64).fill(-1)
  const count = routeMask(0, 0, 1, 4, out)
  assert.equal(count, 3)
  assert.deepEqual(out.slice(0, count), [0, 2, 3])
  assert.equal(out[3], -1)
})

test('mask halves include boundary bits and ignore sender and out-of-range bits', () => {
  const out: number[] = []
  let count = routeMask(0x80000003, 0x80000003, 1, 64, out)
  assert.deepEqual(out.slice(0, count), [0, 31, 32, 33, 63])
  count = routeMask(0x80000003, 0x80000003, 32, 33, out)
  assert.deepEqual(out.slice(0, count), [0, 1, 31])
  count = routeMask(0, 0x80000000, 63, 64, out)
  assert.equal(count, 0)
})

test('64-seat broadcast and full masks route every other seat', () => {
  const out = new Array<number>(64).fill(0)
  const expected = Array.from({ length: 64 }, (_, seat) => seat).filter((seat) => seat !== 31)
  for (const mask of [0, 0xffffffff]) {
    const count = routeMask(mask, mask, 31, 64, out)
    assert.equal(count, 63)
    assert.deepEqual(out.slice(0, count), expected)
  }
})

test('ZoneGroup enforces the game cap and skips empty and dropped seats', () => {
  assert.throws(() => new ZoneGroup('small', 5, 4), RangeError)
  const group = new ZoneGroup('game', 64, 64)
  assert.equal(group.game, 'game')
  assert.equal(group.seats, 64)
  group.set(0, 'a')
  group.set(32, 'b')
  group.set(63, 'c')
  const out: string[] = []
  let count = group.route(0, 0, 0, out)
  assert.deepEqual(out.slice(0, count), ['b', 'c'])
  group.set(32, null)
  count = group.route(0, 1, 0x80000001, out)
  assert.deepEqual(out.slice(0, count), ['c'])
  group.set(63, null)
  assert.equal(group.route(0, 0, 0, out), 0)
})

test('queue keys separate games, legacy, player counts and cadence', () => {
  assert.equal(queueKey('game', 64, true), 'game|64|1')
  assert.equal(queueKey('', 2, false), '|2|0')
  const keys = ['', 'a', 'b'].flatMap((game) => [2, 4].flatMap((players) =>
    [false, true].map((cadence) => queueKey(game, players, cadence))))
  assert.equal(new Set(keys).size, 12)
  const queues = new GameQueues<{ conn: string; since: number }>()
  keys.forEach((key, since) => queues.list(key).push({ conn: key, since }))
  keys.forEach((key, since) => assert.deepEqual(queues.take(key, 2), [{ conn: key, since }]))
})

test('GameQueues takes FIFO, pops the tail, prunes and drops across lists', () => {
  const queues = new GameQueues<{ conn: string }>()
  const a = queues.list('a')
  assert.equal(queues.list('a'), a)
  a.push({ conn: 'first' }, { conn: 'dead' }, { conn: 'last' })
  queues.list('b').push({ conn: 'last' }, { conn: 'last' })
  assert.equal(queues.has('dead'), true)
  queues.prune('a', (conn) => conn !== 'dead')
  assert.equal(queues.has('dead'), false)
  assert.deepEqual(queues.take('a', 1), [{ conn: 'first' }])
  queues.drop('last')
  assert.equal(queues.has('last'), false)
  assert.notEqual(queues.list('a'), a)
  assert.deepEqual(queues.take('b', 2), [])
  const c = queues.list('c')
  c.push({ conn: 'one' }, { conn: 'two' })
  assert.deepEqual(queues.pop('c'), { conn: 'two' })
  assert.deepEqual(queues.take('c', 5), [{ conn: 'one' }])
  assert.notEqual(queues.list('c'), c)
  const d = queues.list('d')
  d.push({ conn: 'dead' })
  queues.prune('d', () => false)
  assert.notEqual(queues.list('d'), d)
  const e = queues.list('e')
  e.push({ conn: 'tail' })
  assert.deepEqual(queues.pop('e'), { conn: 'tail' })
  assert.notEqual(queues.list('e'), e)
  assert.equal(queues.pop('missing'), undefined)
  assert.deepEqual(queues.take('missing', 2), [])
  queues.prune('missing', () => false)
  queues.drop('missing')
})

test('zone create and queue accept up to 64 players with paired game and zones fields', () => {
  assert.equal(MAX_ZONE_PEERS, 64)
  assert.ok(RELAY_ERROR_CODES.includes('unknown game'))
  for (const t of ['create', 'queue']) {
    for (const game of ['g', 'g'.repeat(64)]) {
      for (const players of [undefined, 2, 64]) {
        const raw = JSON.stringify({ t, game, zones: true, players })
        assert.deepEqual(parseRelayMessage(raw), JSON.parse(raw))
      }
    }
    for (const fields of [
      { game: 'g' }, { zones: true }, { zones: false }, { game: 'g', zones: false },
      { game: '', zones: true }, { game: 1, zones: true }, { game: null, zones: true },
      { game: 'g'.repeat(65), zones: true }, { game: 'g', zones: 'true' },
      ...[1, 65, 2.5, '64', null].map((players) => ({ game: 'g', zones: true, players })),
      { players: 5 },
    ]) {
      assert.ok('error' in parseRelayMessage(JSON.stringify({ t, ...fields })), JSON.stringify(fields))
    }
    assert.deepEqual(parseRelayMessage(JSON.stringify({ t, players: 4 })), { t, players: 4 })
  }
})

test('resume have keeps its legacy scalar and array validation', () => {
  const frame = { t: 'resume', token: 'token', have: 100 }
  assert.deepEqual(parseRelayMessage(JSON.stringify(frame)), frame)
  assert.ok('error' in parseRelayMessage(JSON.stringify({ ...frame, have: [0, 0, 0, 0, 0] })))
})

test('zone config parses game caps and sets only explicitly supplied environment fields', () => {
  assert.deepEqual([...parseGameLimits(' , royal-fiesta:64, other-game:2, ,')], [
    ['royal-fiesta', 64], ['other-game', 2],
  ])
  assert.equal(parseGameLimits(`${'g'.repeat(64)}:64`).size, 1)
  assert.equal(parseGameLimits('').size, 0)
  for (const raw of [
    'game', ':2', 'g:1', 'g:65', 'g:2.5', 'g:-2', 'g:2:3', 'g:2,g:3',
    'g:2, g : 2', `${'g'.repeat(65)}:2`, 'g:NaN', 'g:',
  ]) assert.throws(() => parseGameLimits(raw), { message: '[config] RELAY_GAMES' })

  const defaults = loadConfig({})
  for (const field of ['relayGames', 'relayMaxBinBytes', 'relayBinRatePerSec']) {
    assert.equal(Object.hasOwn(defaults, field), false)
  }
  const cfg = loadConfig({
    RELAY_GAMES: 'royal-fiesta:64,other-game:4', RELAY_MAX_BIN_BYTES: '22000', RELAY_BIN_RATE_PER_SEC: '3000',
  })
  assert.deepEqual(cfg.relayGames, parseGameLimits('royal-fiesta:64,other-game:4'))
  assert.equal(cfg.relayMaxBinBytes, 22000)
  assert.equal(cfg.relayBinRatePerSec, 3000)
  assert.equal(loadConfig({ RELAY_GAMES: '' }).relayGames?.size, 0)
  assert.throws(() => loadConfig({ RELAY_GAMES: 'bad' }), { message: '[config] RELAY_GAMES' })
  for (const name of ['RELAY_MAX_BIN_BYTES', 'RELAY_BIN_RATE_PER_SEC']) {
    for (const value of ['0', '-1', '1.5', '', 'NaN', '9007199254740992']) {
      assert.throws(() => loadConfig({ [name]: value }), { message: `[config] ${name}` })
    }
  }
})

test('64-seat zone room matches every seat and routes masks across both halves', () => {
  const s = setup()
  const members = createRoom(s, 64)
  for (let seat = 0; seat < members.length; seat++) {
    const conn = members[seat].conn
    const matched = conn.sent.at(-1)!
    assert.equal(matched.t, 'matched')
    assert.equal(matched.youAre, seat)
    assert.equal(matched.players, 64)
    assert.equal((matched.opps as unknown[]).length, 64)
    assert.equal(typeof matched.token, 'string')
    assert.deepEqual(conn.types(), seat === 0 ? ['room', 'matched'] : seat === 63 ? ['matched'] : ['waiting', 'matched'])
  }
  const payload = Uint8Array.of(21, 0, 255)
  const frame = binaryFrame(1, 0x80000000, payload)
  s.hub.binary(members[3].id, frame)
  const expected = Uint8Array.of(0x5a, 3, ...payload)
  for (let seat = 0; seat < members.length; seat++) {
    assert.deepEqual(members[seat].conn.binaries, seat === 0 || seat === 63 ? [expected] : [])
  }
  assert.equal(members[0].conn.binaries[0], members[63].conn.binaries[0])
  assert.deepEqual(frame, binaryFrame(1, 0x80000000, payload))

  s.hub.binary(members[3].id, binaryFrame(0, 0, payload))
  const broadcast = members[1].conn.binaries[0]
  for (let seat = 0; seat < members.length; seat++) {
    const frames = members[seat].conn.binaries
    assert.equal(frames.length, seat === 3 ? 0 : seat === 0 || seat === 63 ? 2 : 1)
    if (seat !== 3) {
      assert.deepEqual(frames.at(-1), expected)
      assert.equal(frames.at(-1), broadcast)
    }
  }
})

test('binary requires a seated member of a started zone room and counts invalid frames', () => {
  const s = setup()
  const [legacy, peer] = createRoom(s, 2, null)
  const unseated = s.add(), waiting = s.add()
  s.send(waiting, { t: 'create', game: 'royal-fiesta', zones: true })
  const frame = binaryFrame()
  assert.doesNotThrow(() => s.hub.binary('unknown', frame))
  for (const sender of [legacy, unseated, waiting]) {
    for (let i = 0; i < MAX_INVALID - 1; i++) s.hub.binary(sender.id, frame)
    assert.equal(sender.conn.closes, 0)
    s.hub.binary(sender.id, frame)
    assert.equal(sender.conn.closes, 1)
    assert.equal(sender.conn.binaries.length, 0)
    assert.equal(peer.conn.binaries.length, 0)
  }
})

test('malformed binary frames are invalid and never relayed', () => {
  const wrongKind = binaryFrame()
  wrongKind[0] = 1
  const wrongReserved = binaryFrame()
  wrongReserved[1] = 1
  for (const frame of [new Uint8Array(9), wrongKind, wrongReserved]) {
    const s = setup()
    const [a, b] = createRoom(s)
    for (let i = 0; i < MAX_INVALID; i++) s.hub.binary(a.id, frame)
    assert.equal(a.conn.closes, 1)
    assert.deepEqual(b.conn.binaries, [])
    assert.equal(a.conn.types().includes('error'), false)
  }
})

test('binary size cap includes the input header and accepts exactly the cap', () => {
  for (const maxBinBytes of [BIN_IN_HEADER + 3, undefined]) {
    const s = setup({ maxBinBytes })
    const [a, b] = createRoom(s)
    const cap = maxBinBytes ?? DEFAULT_RELAY_MAX_BIN_BYTES
    s.hub.binary(a.id, binaryFrame(0, 0, new Uint8Array(cap - BIN_IN_HEADER)))
    assert.equal(b.conn.binaries.length, 1)
    assert.equal(b.conn.binaries[0].length, cap - BIN_IN_HEADER + 2)
    const oversized = binaryFrame(0, 0, new Uint8Array(cap - BIN_IN_HEADER + 1))
    for (let i = 0; i < MAX_INVALID - 1; i++) s.hub.binary(a.id, oversized)
    assert.equal(a.conn.closes, 0)
    assert.equal(b.conn.binaries.length, 1)
    s.hub.binary(a.id, oversized)
    assert.equal(a.conn.closes, 1)
    assert.equal(b.conn.binaries.length, 1)
  }
})

test('binary uses a fixed one-second window per client independently of JSON rate limits', () => {
  const s = setup({ binRatePerSec: 2 })
  const [a, b] = createRoom(s)
  const frame = binaryFrame()
  s.hub.binary(a.id, frame)
  s.clock.t += 999
  s.hub.binary(a.id, frame)
  s.hub.binary(b.id, frame)
  s.hub.binary(b.id, frame)
  s.send(a, { t: 'ping' })
  assert.equal(a.conn.sent.at(-1)!.t, 'pong')
  assert.equal(a.conn.closes, 0)
  s.clock.t++
  s.hub.binary(a.id, frame)
  s.hub.binary(a.id, frame)
  assert.equal(b.conn.binaries.length, 4)
  assert.equal(a.conn.closes, 0)
  s.hub.binary(a.id, frame)
  assert.equal(b.conn.binaries.length, 4)
  assert.deepEqual(a.conn.sent.at(-1), { t: 'error', reason: 'rate limited' })
  assert.equal(a.conn.closes, 1)
  assert.equal(b.conn.closes, 0)
})

test('binary defaults allow the configured default rate without consuming the JSON budget', () => {
  const s = setup()
  const [a, b] = createRoom(s)
  const frame = binaryFrame()
  for (let i = 0; i < DEFAULT_RELAY_BIN_RATE_PER_SEC; i++) s.hub.binary(a.id, frame)
  assert.equal(b.conn.binaries.length, DEFAULT_RELAY_BIN_RATE_PER_SEC)
  assert.equal(a.conn.closes, 0)
  for (let i = 0; i < RATE_PER_SEC - 1; i++) s.send(a, { t: 'ping' })
  assert.equal(a.conn.closes, 0)
  s.hub.binary(a.id, frame)
  assert.deepEqual(a.conn.sent.at(-1), { t: 'error', reason: 'rate limited' })
  assert.equal(a.conn.closes, 1)
  assert.equal(b.conn.binaries.length, DEFAULT_RELAY_BIN_RATE_PER_SEC)
})

test('zone create and queue refuse unknown games and seats above the game cap', () => {
  for (const t of ['create', 'queue']) {
    const s = setup()
    const a = s.add()
    s.send(a, { t, game: 'unknown', zones: true })
    assert.deepEqual(a.conn.sent.at(-1), { t: 'error', reason: 'unknown game' })
    s.send(a, { t, game: 'other-game', zones: true, players: 5 })
    assert.deepEqual(a.conn.sent.at(-1), { t: 'error', reason: 'room full' })
    assert.equal(s.hub.stats().sessions, 0)
    s.send(a, { t, game: 'other-game', zones: true, players: 4 })
    assert.equal(a.conn.sent.at(-1)!.t, t === 'create' ? 'room' : 'queued')

    const empty = setup({ games: undefined })
    const b = empty.add()
    empty.send(b, { t, game: 'royal-fiesta', zones: true })
    assert.deepEqual(b.conn.sent, [{ t: 'error', reason: 'unknown game' }])
  }
})

test('game queues and legacy queues form separate rooms with binary routing only inside the game', () => {
  const s = setup()
  const royal = [s.add(), s.add()], other = [s.add(), s.add()], legacy = [s.add(), s.add()]
  const q = { t: 'queue', players: 2, zones: true }
  s.send(royal[0], { ...q, game: 'royal-fiesta' })
  s.send(other[0], { ...q, game: 'other-game' })
  s.send(legacy[0], { t: 'queue', players: 2 })
  assert.equal(s.hub.stats().sessions, 0)
  s.send(other[1], { ...q, game: 'other-game' })
  s.send(royal[1], { ...q, game: 'royal-fiesta' })
  assert.equal(legacy[0].conn.types().at(-1), 'queued')
  s.send(legacy[1], { t: 'queue', players: 2 })
  assert.equal(s.hub.stats().sessions, 3)
  const codes = new Set<string>()
  for (const pair of [royal, other, legacy]) {
    codes.add(s.hub.seatOf(pair[0].id)!.session)
    assert.equal(s.hub.seatOf(pair[0].id)!.session, s.hub.seatOf(pair[1].id)!.session)
    pair.forEach((member, seat) => {
      assert.equal(member.conn.sent.at(-1)!.t, 'matched')
      assert.equal(member.conn.sent.at(-1)!.youAre, seat)
    })
  }
  assert.equal(codes.size, 3)
  s.hub.binary(royal[0].id, binaryFrame())
  s.hub.binary(other[1].id, binaryFrame())
  assert.deepEqual(royal[1].conn.binaries, [Uint8Array.of(BIN_KIND, 0, 7, 9)])
  assert.deepEqual(other[0].conn.binaries, [Uint8Array.of(BIN_KIND, 1, 7, 9)])
  for (const member of [royal[0], other[1], ...legacy]) assert.deepEqual(member.conn.binaries, [])
})

test('game queues retain FIFO estimates and remove unqueued or disconnected clients', () => {
  const s = setup()
  const a = s.add(), b = s.add(), c = s.add(), d = s.add(), e = s.add()
  const q = { t: 'queue', game: 'royal-fiesta', zones: true }
  s.send(a, q)
  assert.deepEqual(a.conn.sent[0], { t: 'queued', estimateMs: null })
  s.send(a, { ...q, game: 'other-game' })
  assert.equal(a.conn.sent.length, 1)
  s.clock.t += 400
  s.send(b, q)
  assert.equal(a.conn.sent.at(-1)!.youAre, 0)
  assert.equal(b.conn.sent.at(-1)!.youAre, 1)
  s.send(c, q)
  assert.deepEqual(c.conn.sent[0], { t: 'queued', estimateMs: 200 })
  s.send(c, { t: 'unqueue' })
  s.send(d, q)
  s.hub.disconnect(d.id)
  s.send(e, q)
  assert.equal(e.conn.sent.at(-1)!.t, 'queued')
  s.send(c, q)
  assert.equal(e.conn.sent.at(-1)!.youAre, 0)
  assert.equal(c.conn.sent.at(-1)!.youAre, 1)
  assert.equal(d.conn.types().includes('matched'), false)
})

test('server full pops only the new waiter and preserves the first queued client', () => {
  const s = setup()
  let room = ''
  for (let i = 0; i < MAX_ROOMS; i++) {
    const a = s.add(), b = s.add()
    s.send(a, { t: 'queue' })
    s.send(b, { t: 'queue' })
    room = s.hub.seatOf(a.id)!.session
  }
  const a = s.add(), b = s.add(), c = s.add()
  const q = { t: 'queue', game: 'royal-fiesta', zones: true }
  s.send(a, q)
  s.send(b, q)
  assert.deepEqual(b.conn.sent, [{ t: 'error', reason: 'server full' }])
  s.hub.endSession(room, 'done')
  s.send(c, q)
  assert.equal(a.conn.sent.at(-1)!.youAre, 0)
  assert.equal(c.conn.sent.at(-1)!.youAre, 1)
  assert.equal(b.conn.types().includes('matched'), false)
})

test('two-seat zones use seat notices on drop, resume and grace expiry before opp_left', () => {
  const s = setup()
  const [a, b] = createRoom(s)
  const token = b.conn.sent.at(-1)!.token
  s.hub.disconnect(b.id)
  assert.deepEqual(a.conn.sent.at(-1), { t: 'player_dropped', seat: 1, graceMs: RESUME_GRACE_MS })
  s.hub.binary(a.id, binaryFrame())
  assert.deepEqual(b.conn.binaries, [])
  s.clock.t += RESUME_GRACE_MS - 1
  s.hub.tick(s.clock.t)
  const b2 = s.add()
  s.send(b2, { t: 'resume', token, have: 0 })
  assert.deepEqual(a.conn.sent.at(-1), { t: 'player_back', seat: 1 })
  s.hub.binary(a.id, binaryFrame())
  assert.deepEqual(b2.conn.binaries, [Uint8Array.of(BIN_KIND, 0, 7, 9)])
  s.hub.binary(b2.id, binaryFrame())
  assert.deepEqual(a.conn.binaries, [Uint8Array.of(BIN_KIND, 1, 7, 9)])
  s.hub.disconnect(b2.id)
  s.clock.t += RESUME_GRACE_MS
  s.hub.tick(s.clock.t)
  assert.deepEqual(a.conn.sent.slice(-2), [{ t: 'player_left', seat: 1 }, { t: 'opp_left' }])
  assert.equal(a.conn.types().includes('opp_dropped'), false)
  assert.equal(a.conn.types().includes('opp_back'), false)
  assert.equal(s.hub.stats().sessions, 0)
  const b3 = s.add()
  s.send(b3, { t: 'resume', token })
  assert.deepEqual(b3.conn.sent, [{ t: 'error', reason: 'resume expired' }])
})

test('zone resume rebinds a live seat and binary history is absent from JSON replay', () => {
  const s = setup()
  const [a, b] = createRoom(s)
  const token = b.conn.sent.at(-1)!.token
  s.hub.binary(a.id, binaryFrame())
  s.send(a, { t: 'act', n: 1, a: { tick: 1 } })
  const b2 = s.add()
  s.send(b2, { t: 'resume', token, have: 0 })
  assert.equal(b.conn.closes, 1)
  assert.deepEqual(b2.conn.sent, [{ t: 'resumed', ack: 0 }, { t: 'act', n: 1, a: { tick: 1 }, from: 0 }])
  assert.deepEqual(b2.conn.binaries, [])
  s.hub.binary(a.id, binaryFrame())
  assert.equal(b2.conn.binaries.length, 1)
  assert.equal(b.conn.binaries.length, 1)
  s.hub.disconnect(b2.id)
  s.hub.binary(a.id, binaryFrame())
  s.send(a, { t: 'act', n: 2, a: { tick: 2 } })
  const b3 = s.add()
  s.send(b3, { t: 'resume', token, have: 1 })
  assert.deepEqual(b3.conn.sent, [{ t: 'resumed', ack: 0 }, { t: 'act', n: 2, a: { tick: 2 }, from: 0 }])
  assert.deepEqual(b3.conn.binaries, [])
  s.hub.binary(a.id, binaryFrame())
  assert.equal(b3.conn.binaries.length, 1)
  assert.equal(b2.conn.binaries.length, 1)
})

test('zone seats that leave gracefully stop receiving binary while remaining seats keep routing', () => {
  const s = setup()
  const [a, b, c] = createRoom(s, 3)
  s.send(b, { t: 'bye' })
  assert.deepEqual(a.conn.sent.at(-1), { t: 'player_left', seat: 1 })
  assert.equal(s.hub.stats().sessions, 1)
  s.hub.binary(a.id, binaryFrame())
  assert.deepEqual(b.conn.binaries, [])
  assert.deepEqual(c.conn.binaries, [Uint8Array.of(BIN_KIND, 0, 7, 9)])
  s.send(c, { t: 'bye' })
  assert.deepEqual(a.conn.sent.slice(-2), [{ t: 'player_left', seat: 2 }, { t: 'opp_left' }])
  assert.equal(s.hub.stats().sessions, 0)
})

test('relay endpoint forwards binary frames into the connected zone room', () => {
  const s = setup()
  const endpoint = relayEndpoint(s.hub)
  const a = new FakeConn(), b = new FakeConn()
  const sa = endpoint.open(a, { url: '/ws', headers: {} })!
  const sb = endpoint.open(b, { url: '/ws', headers: {} })!
  sa.message(JSON.stringify({ t: 'create', game: 'royal-fiesta', zones: true }))
  sb.message(JSON.stringify({ t: 'join', code: a.sent[0].code }))
  assert.ok(sa.binary)
  sa.binary(binaryFrame())
  assert.deepEqual(a.binaries, [])
  assert.deepEqual(b.binaries, [Uint8Array.of(BIN_KIND, 0, 7, 9)])
  sb.closed()
  sa.binary(binaryFrame())
  assert.equal(b.binaries.length, 1)
})

test('handshake passes configured zone games and binary caps through the shared endpoint', { timeout: 5000 }, async () => {
  const { WebSocket } = await import('ws')
  const hs = createHandshake({
    config: loadConfig({
      PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error',
      RELAY_GAMES: 'royal-fiesta:2', RELAY_MAX_BIN_BYTES: '12', RELAY_BIN_RATE_PER_SEC: '1',
    }),
    autoTick: false,
  })
  try {
    const { port } = await hs.listen()
    const a = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const b = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await Promise.all([once(a, 'open'), once(b, 'open')])
    const refused = once(a, 'message')
    a.send(JSON.stringify({ t: 'create', game: 'royal-fiesta', zones: true, players: 3 }))
    assert.deepEqual(JSON.parse(String((await refused)[0])), { t: 'error', reason: 'room full' })
    const created = once(a, 'message')
    a.send(JSON.stringify({ t: 'create', game: 'royal-fiesta', zones: true }))
    const room = JSON.parse(String((await created)[0]))
    assert.equal(room.t, 'room')
    const matched = Promise.all([once(a, 'message'), once(b, 'message')])
    b.send(JSON.stringify({ t: 'join', code: room.code }))
    for (const [data] of await matched) assert.equal(JSON.parse(String(data)).t, 'matched')

    const binaries: Buffer[] = []
    b.on('message', (data: Buffer, binary: boolean) => { if (binary) binaries.push(data) })
    const received = once(b, 'message')
    a.send(binaryFrame())
    const [data, isBinary] = await received
    assert.equal(isBinary, true)
    assert.deepEqual([...data], [BIN_KIND, 0, 7, 9])

    const pong = once(a, 'message')
    a.send(binaryFrame(0, 0, Uint8Array.of(1, 2, 3)))
    a.send(JSON.stringify({ t: 'ping' }))
    assert.deepEqual(JSON.parse(String((await pong)[0])), { t: 'pong' })
    const limited = once(a, 'message')
    const closed = once(a, 'close')
    a.send(binaryFrame())
    assert.deepEqual(JSON.parse(String((await limited)[0])), { t: 'error', reason: 'rate limited' })
    await closed
    assert.equal(binaries.length, 1)
    const peerClosed = once(b, 'close')
    b.close()
    await peerClosed
  } finally {
    await hs.close()
  }
})

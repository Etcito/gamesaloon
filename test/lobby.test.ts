// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { LobbyBook, loadLobbyRules } from '../src/lobby/lobby.ts'
import { lobbyClaims, parseLobbyMessage } from '../src/lobby/messages.ts'
import { LobbyService } from '../src/lobby/service.ts'
import { RelayHub } from '../src/relay/hub.ts'
import { BIN_IN_HEADER, BIN_KIND } from '../src/relay/binary.ts'

const F = { game: 'royal-fiesta', seats: 4, cadence: true }

test('book: the wait starts at the first player and a later arrival does not reset it', () => {
  const b = new LobbyBook({ waitMs: 60_000 })
  const l = b.open('a', { name: 'A' }, F, 1000)
  assert.equal(l.startsAt, 61_000)
  assert.equal(b.join('b', { name: 'B' }, l.id), l)
  assert.equal(l.startsAt, 61_000)
  assert.deepEqual(b.due(60_999), [])
  assert.deepEqual(b.due(61_000), [l])
})

test('book: a full lobby starts early, a started lobby is spectate-only', () => {
  const b = new LobbyBook({ waitMs: 60_000 })
  const l = b.open('a', null, { ...F, seats: 2 }, 0)
  assert.deepEqual(b.choices({ ...F, seats: 2 }, 10)[0].actions, ['join', 'spectate'])
  b.join('b', null, l.id)
  assert.deepEqual(b.due(1), [l])
  b.started(l.id, 'q1', 7)
  assert.equal(b.join('c', null, l.id), 'closed')
  assert.deepEqual(b.choices({ ...F, seats: 2 }, 10)[0].actions, ['spectate'])
  assert.equal(b.choices({ ...F, seats: 2 }, 10)[0].startsInMs, 0)
})

test('book: a joinable lobby is offered before an older one whose round is on', () => {
  const b = new LobbyBook()
  const old = b.open('a', null, F, 0)
  b.started(old.id, 'q1', 1)
  const fresh = b.open('b', null, F, 10)
  assert.deepEqual(b.choices(F, 20).map((s) => s.id), [fresh.id, old.id])
})

test('book: minPlayers holds the start; choices never mix formats', () => {
  const b = new LobbyBook({ waitMs: 1000, minPlayers: 2 })
  const l = b.open('a', null, F, 0)
  assert.deepEqual(b.due(5000), [])
  b.join('b', null, l.id)
  assert.deepEqual(b.due(5000), [l])
  assert.equal(b.choices({ ...F, seats: 2 }, 0).length, 0)
  assert.equal(b.choices({ ...F, game: 'kekkai' }, 0).length, 0)
  assert.equal(b.choices(F, 0).length, 1)
})

test('book: the last player leaving a waiting lobby closes it; a spectator leaving does not', () => {
  const b = new LobbyBook()
  const l = b.open('a', null, F, 0)
  b.spectate('s', l.id)
  assert.deepEqual(b.leave('s'), { lobby: l, closed: false })
  assert.equal(b.leave('a')?.closed, true)
  assert.equal(b.size(), 0)
  assert.equal(b.leave('a'), null)
})

test('rules from env: defaults, values, refusals', () => {
  assert.deepEqual(loadLobbyRules({}), { waitMs: 60_000, minPlayers: 1 })
  assert.deepEqual(loadLobbyRules({ LOBBY_WAIT_MS: '15000', LOBBY_MIN_PLAYERS: '2' }), { waitMs: 15_000, minPlayers: 2 })
  assert.throws(() => loadLobbyRules({ LOBBY_WAIT_MS: '5s' }), /LOBBY_WAIT_MS/)
  assert.throws(() => loadLobbyRules({ LOBBY_MIN_PLAYERS: '9' }), /LOBBY_MIN_PLAYERS/)
})

test('messages: parse and claims', () => {
  assert.deepEqual(parseLobbyMessage({ t: 'lobby_enter', game: 'g', seats: 4, payload: { n: 1 } }),
    { t: 'lobby_enter', game: 'g', seats: 4, cadence: false, payload: { n: 1 }, choice: false, spectate: false, zones: false })
  assert.deepEqual(parseLobbyMessage({ t: 'lobby_enter', game: 'g', seats: 4, choice: true, spectate: true }),
    { t: 'lobby_enter', game: 'g', seats: 4, cadence: false, payload: null, choice: true, spectate: true, zones: false })
  assert.equal(parseLobbyMessage({ t: 'lobby_enter', game: 'g', seats: 4, choice: 'yes' }), null)
  assert.equal(parseLobbyMessage({ t: 'lobby_enter', game: 'g', seats: 5 }), null)
  assert.equal(parseLobbyMessage({ t: 'lobby_enter', game: 'g', seats: 2, payload: { s: 'x'.repeat(600) } }), null)
  assert.equal(parseLobbyMessage({ t: 'lobby_pick', action: 'join' }), null)
  assert.deepEqual(parseLobbyMessage({ t: 'lobby_pick', action: 'new' }), { t: 'lobby_pick', action: 'new', id: null })
  assert.equal(parseLobbyMessage({ t: 'queue' }), null)
  assert.equal(lobbyClaims('{"t":"lobby_enter"}'), true)
  assert.equal(lobbyClaims('{"t":"lobby_state"}'), false)
  assert.equal(lobbyClaims('nope'), false)
})

// ---- service over a real RelayHub ----

class FakeConn {
  sent: Record<string, unknown>[] = []
  binaries: Uint8Array[] = []
  closes = 0
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  sendBinary(frame: Uint8Array): void { this.binaries.push(frame) }
  close(): void { this.closes++ }
  last(t: string): Record<string, unknown> | undefined { return this.sent.filter((m) => m.t === t).at(-1) }
  types(): unknown[] { return this.sent.map((m) => m.t) }
}

function setup(waitMs = 60_000, games?: ReadonlyMap<string, number>) {
  const clock = { t: 1_000_000 }
  let seed = 7
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const deps = { now: () => clock.t, random, log: () => {} }
  const lobby = new LobbyService(deps, { waitMs })
  const hub = new RelayHub(deps, undefined, games ? { games } : undefined)
  hub.use(lobby)
  lobby.attach(hub)
  const add = () => {
    const conn = new FakeConn()
    return { conn, id: hub.connect(conn, '/') }
  }
  const say = (c: { id: string }, m: Record<string, unknown>) => hub.message(c.id, JSON.stringify(m))
  // `enter` asks the legacy question (choice: true) so the lobby_choice / lobby_pick tests keep covering it;
  // `enterAuto` is what a normal client sends: no question, seated at once.
  const send = (c: { id: string }, name: string, seats: number, extra: Record<string, unknown>) =>
    say(c, { t: 'lobby_enter', game: 'royal-fiesta', seats, cadence: true, payload: { g: 'royal-fiesta', v: 1, name }, ...extra })
  const enter = (c: { id: string }, name: string, seats = 4) => send(c, name, seats, { choice: true })
  const enterAuto = (c: { id: string }, name: string, seats = 4) => send(c, name, seats, {})
  const enterSpectate = (c: { id: string }, name: string, seats = 4) => send(c, name, seats, { spectate: true })
  const enterZones = (c: { id: string }, name: string, seats = 4) => send(c, name, seats, { zones: true })
  return { hub, clock, add, say, enter, enterAuto, enterSpectate, enterZones }
}

function binaryFrame(): Uint8Array {
  const frame = new Uint8Array(BIN_IN_HEADER + 2)
  frame[0] = BIN_KIND
  frame.set([7, 9], BIN_IN_HEADER)
  return frame
}

test('zones: a zones lobby starts a zone room with whoever joined, a lone player too, and never mixes with legacy lobbies', () => {
  const s = setup(1000, new Map([['royal-fiesta', 64]]))
  const a = s.add(), b = s.add(), legacy = s.add()
  s.enterZones(a, 'A')
  s.enterZones(b, 'B')
  s.enterAuto(legacy, 'L')
  assert.equal((a.conn.last('lobby_state')!.players as unknown[]).length, 2)
  assert.equal((legacy.conn.last('lobby_state')!.players as unknown[]).length, 1)
  s.clock.t += 1000
  s.hub.tick(s.clock.t)
  assert.equal(a.conn.last('matched')!.players, 2)
  s.hub.binary(a.id, binaryFrame())
  assert.equal(b.conn.binaries.length, 1)
  // The legacy round refuses zone traffic; a lone zones player gets a zone room of one seat.
  s.hub.binary(legacy.id, binaryFrame())
  assert.equal(legacy.conn.binaries.length + a.conn.binaries.length, 0)
  const lone = s.add()
  s.enterZones(lone, 'Z')
  s.clock.t += 1000
  s.hub.tick(s.clock.t)
  assert.equal(lone.conn.last('matched')!.players, 1)
  for (let i = 0; i < 20; i++) s.hub.binary(lone.id, binaryFrame())
  assert.equal(lone.conn.closes, 0)
})

test('zones: a zones lobby of a game without a RELAY_GAMES cap is refused at entry', () => {
  const s = setup(1000)
  const a = s.add()
  s.enterZones(a, 'A')
  assert.equal(a.conn.last('lobby_error')!.reason, 'unknown game')
  assert.equal(a.conn.last('lobby_state'), undefined)
})

test('service: first arrival opens a lobby with the countdown, the round starts at the end with whoever is there', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.enter(a, 'A')
  const st = a.conn.last('lobby_state')!
  assert.equal(st.role, 'player')
  assert.equal(st.startsInMs, 60_000)
  assert.equal(st.waitMs, 60_000)
  s.clock.t += 20_000
  s.enter(b, 'B')
  const choice = b.conn.last('lobby_choice')!
  const offered = (choice.lobbies as Record<string, unknown>[])[0]
  assert.deepEqual(offered.actions, ['join', 'spectate'])
  assert.equal(offered.startsInMs, 40_000)
  s.say(b, { t: 'lobby_pick', action: 'join', id: offered.id })
  assert.equal(a.conn.last('lobby_state')!.startsInMs, 40_000)
  assert.equal((a.conn.last('lobby_state')!.players as unknown[]).length, 2)
  s.clock.t += 39_999
  s.hub.tick(s.clock.t)
  assert.equal(a.conn.last('matched'), undefined)
  s.clock.t += 1
  s.hub.tick(s.clock.t)
  const ma = a.conn.last('matched')!, mb = b.conn.last('matched')!
  assert.equal(ma.players, 2)
  assert.equal(ma.youAre, 0)
  assert.equal(mb.youAre, 1)
  assert.equal(ma.seed, mb.seed)
  assert.deepEqual((ma.opps as Record<string, unknown>[]).map((p) => p.name), ['A', 'B'])
})

test('service: lobby_enter seats the player at once, no question: in the waiting lobby with a free seat', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.enterAuto(a, 'A')
  s.clock.t += 20_000
  s.enterAuto(b, 'B')
  assert.equal(b.conn.last('lobby_choice'), undefined)
  const sb = b.conn.last('lobby_state')!
  assert.equal(sb.role, 'player')
  assert.equal(sb.id, a.conn.last('lobby_state')!.id)
  assert.equal(sb.startsInMs, 40_000)
  assert.equal((a.conn.last('lobby_state')!.players as unknown[]).length, 2)
  s.clock.t += 40_000
  s.hub.tick(s.clock.t)
  assert.equal(a.conn.last('matched')!.players, 2)
})

test('service: a full or playing lobby is not joined by default: the arrival lands in a new empty lobby', () => {
  const s = setup()
  const a = s.add(), b = s.add(), c = s.add(), d = s.add()
  s.enterAuto(a, 'A', 2)
  s.enterAuto(b, 'B', 2)
  assert.equal(a.conn.last('matched')!.players, 2)
  s.enterAuto(c, 'C', 2)
  assert.equal(c.conn.last('lobby_choice'), undefined)
  const sc = c.conn.last('lobby_state')!
  assert.equal(sc.role, 'player')
  assert.equal(sc.startsInMs, 60_000)
  assert.equal((sc.players as unknown[]).length, 1)
  // The new lobby is waiting with a free seat: the next arrival joins it, not the played one.
  s.enterAuto(d, 'D', 2)
  assert.equal(c.conn.last('matched')!.players, 2)
})

test('service: spectate: true is the explicit way to watch; with no lobby it opens one', () => {
  const s = setup(1000)
  const a = s.add(), w = s.add(), v = s.add(), lone = s.add()
  s.enterSpectate(lone, 'L')
  assert.equal(lone.conn.last('lobby_state')!.role, 'player')
  s.hub.disconnect(lone.id)
  s.enterAuto(a, 'A')
  s.enterSpectate(w, 'W')
  assert.equal(w.conn.last('lobby_state')!.role, 'spectator')
  assert.equal(w.conn.last('lobby_choice'), undefined)
  s.clock.t += 1000
  s.hub.tick(s.clock.t)
  assert.equal(w.conn.last('lobby_watch')!.players, 1)
  // Spectating a playing lobby works the same, no card.
  s.enterSpectate(v, 'V')
  assert.equal(v.conn.last('lobby_state')!.role, 'spectator')
  assert.equal(v.conn.last('lobby_watch')!.players, 1)
  assert.equal(s.hub.seatOf(w.id), null)
})

test('service: a lone player starts alone when the wait ends (the game fills with bots)', () => {
  const s = setup(1000)
  const a = s.add()
  s.enter(a, 'A')
  s.clock.t += 1000
  s.hub.tick(s.clock.t)
  assert.equal(a.conn.last('matched')!.players, 1)
})

test('service: a full lobby starts at once', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.enter(a, 'A', 2)
  s.enter(b, 'B', 2)
  const id = ((b.conn.last('lobby_choice')!.lobbies as Record<string, unknown>[])[0]).id
  s.say(b, { t: 'lobby_pick', action: 'join', id })
  assert.equal(a.conn.last('matched')!.players, 2)
})

test('service: new lobby opens an empty one with its own wait', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.enter(a, 'A')
  s.clock.t += 30_000
  s.enter(b, 'B')
  s.say(b, { t: 'lobby_pick', action: 'new' })
  const sb = b.conn.last('lobby_state')!
  assert.notEqual(sb.id, a.conn.last('lobby_state')!.id)
  assert.equal(sb.startsInMs, 60_000)
  assert.equal((sb.players as unknown[]).length, 1)
})

test('service: a spectator of a started round gets the header, the replay and live acts; it never becomes a seat', () => {
  const s = setup()
  const a = s.add(), b = s.add(), w = s.add()
  s.enter(a, 'A', 2)
  s.enter(b, 'B', 2)
  const id = ((b.conn.last('lobby_choice')!.lobbies as Record<string, unknown>[])[0]).id
  s.say(b, { t: 'lobby_pick', action: 'join', id })
  s.say(a, { t: 'act', a: { k: 'rb', m: [] }, n: 1 })
  s.enter(w, 'W', 2)
  const offered = (w.conn.last('lobby_choice')!.lobbies as Record<string, unknown>[])[0]
  assert.deepEqual(offered.actions, ['spectate'])
  assert.equal(offered.phase, 'playing')
  s.say(w, { t: 'lobby_pick', action: 'join', id })
  assert.equal(w.conn.last('lobby_error')!.reason, 'lobby_closed')
  s.say(w, { t: 'lobby_pick', action: 'spectate', id })
  assert.equal(w.conn.last('lobby_state')!.role, 'spectator')
  const head = w.conn.last('lobby_watch')!
  assert.equal(head.seed, a.conn.last('matched')!.seed)
  assert.equal(head.replay, true)
  assert.deepEqual(w.conn.last('lobby_act'), { t: 'lobby_act', id, a: { k: 'rb', m: [] }, n: 1, from: 0 })
  s.say(b, { t: 'act', a: { k: 'rb', m: [[1, 0, 'AA']] }, n: 1 })
  assert.deepEqual(w.conn.last('lobby_act'), { t: 'lobby_act', id, a: { k: 'rb', m: [[1, 0, 'AA']] }, n: 1, from: 1 })
  // Peers never see the spectator: no seat event, the act from a goes to b only.
  assert.equal(s.hub.seatOf(w.id), null)
  assert.ok(!a.conn.types().includes('player_back'))
  // The spectator's acts go nowhere (it holds no seat).
  const nb = b.conn.sent.length
  s.say(w, { t: 'act', a: { x: 1 }, n: 1 })
  assert.equal(b.conn.sent.length, nb)
  // Round over: the spectator is told.
  s.say(a, { t: 'bye' })
  assert.equal(w.conn.last('lobby_closed')!.reason, 'ended')
})

test('service: spectating a waiting lobby follows it into the round', () => {
  const s = setup(1000)
  const a = s.add(), w = s.add()
  s.enter(a, 'A')
  s.enter(w, 'W')
  const id = ((w.conn.last('lobby_choice')!.lobbies as Record<string, unknown>[])[0]).id
  s.say(w, { t: 'lobby_pick', action: 'spectate', id })
  assert.equal(w.conn.last('lobby_state')!.phase, 'waiting')
  s.clock.t += 1000
  s.hub.tick(s.clock.t)
  assert.equal(w.conn.last('lobby_state')!.phase, 'playing')
  assert.equal(w.conn.last('lobby_watch')!.players, 1)
  assert.equal(w.conn.last('matched'), undefined)
})

test('service: leaving or disconnecting updates the lobby; the last one out closes it for spectators', () => {
  const s = setup()
  const a = s.add(), b = s.add(), w = s.add()
  s.enter(a, 'A')
  s.enter(b, 'B')
  const id = ((b.conn.last('lobby_choice')!.lobbies as Record<string, unknown>[])[0]).id
  s.say(b, { t: 'lobby_pick', action: 'join', id })
  s.enter(w, 'W')
  s.say(w, { t: 'lobby_pick', action: 'spectate', id })
  s.say(b, { t: 'lobby_leave' })
  assert.equal(b.conn.last('lobby_left')!.t, 'lobby_left')
  assert.equal((a.conn.last('lobby_state')!.players as unknown[]).length, 1)
  s.hub.disconnect(a.id)
  assert.deepEqual(w.conn.last('lobby_closed'), { t: 'lobby_closed', id, reason: 'empty' })
})

test('service: errors for a pick without enter, an unknown lobby, and a seated client', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.say(a, { t: 'lobby_pick', action: 'new' })
  assert.equal(a.conn.last('lobby_error')!.reason, 'not_entered')
  s.enter(a, 'A', 2)
  s.enter(b, 'B', 2)
  s.say(b, { t: 'lobby_pick', action: 'spectate', id: 'L99' })
  assert.equal(b.conn.last('lobby_error')!.reason, 'unknown_lobby')
  const id = ((b.conn.last('lobby_choice')!.lobbies as Record<string, unknown>[])[0]).id
  s.say(b, { t: 'lobby_pick', action: 'join', id })
  s.enter(a, 'A', 2)
  assert.equal(a.conn.last('lobby_error')!.reason, 'in_session')
})

test('relay contract unchanged: the legacy queue still pairs alongside the lobby service', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.say(a, { t: 'queue', players: 2, payload: { n: 1 } })
  s.say(b, { t: 'queue', players: 2, payload: { n: 2 } })
  assert.equal(a.conn.last('matched')!.players, 2)
})

// ---- shared hub presence ----

function joinFirst(s: ReturnType<typeof setup>, c: { id: string; conn: FakeConn }, action: 'join' | 'spectate', name: string): string {
  s.enter(c, name)
  const id = ((c.conn.last('lobby_choice')!.lobbies as Record<string, unknown>[])[0]).id as string
  s.say(c, { t: 'lobby_pick', action, id })
  return id
}

test('presence: lobby_state carries this client key and the roster, spectators included and told apart', () => {
  const s = setup()
  const a = s.add(), b = s.add(), w = s.add()
  s.enter(a, 'A')
  joinFirst(s, b, 'join', 'B')
  joinFirst(s, w, 'spectate', 'W')
  const sa = a.conn.last('lobby_state')!
  assert.equal(sa.you, 0)
  assert.equal(b.conn.last('lobby_state')!.you, 1)
  assert.equal(w.conn.last('lobby_state')!.you, 2)
  // The players learn of the spectator (the roster), the existing fields are unchanged.
  assert.deepEqual((sa.players as Record<string, unknown>[]).map((p) => p.name), ['A', 'B'])
  assert.deepEqual((sa.members as Record<string, unknown>[]).map((m) => [m.k, m.role, (m.p as Record<string, unknown>).name]),
    [[0, 'player', 'A'], [1, 'player', 'B'], [2, 'spectator', 'W']])
  // Keys are never reused: B leaves, C arrives with key 3.
  s.say(b, { t: 'lobby_leave' })
  const c = s.add()
  joinFirst(s, c, 'join', 'C')
  assert.deepEqual((a.conn.last('lobby_state')!.members as Record<string, unknown>[]).map((m) => m.k), [0, 3, 2])
  // The spectator leaving updates the players' roster.
  s.say(w, { t: 'lobby_leave' })
  assert.deepEqual((a.conn.last('lobby_state')!.members as Record<string, unknown>[]).map((m) => m.k), [0, 3])
})

test('presence: a member state reaches the other members that send presence, never another lobby nor a silent client', () => {
  const s = setup()
  const a = s.add(), b = s.add(), w = s.add(), old = s.add(), x = s.add()
  s.enter(a, 'A')
  joinFirst(s, b, 'join', 'B')
  joinFirst(s, w, 'spectate', 'W')
  joinFirst(s, old, 'join', 'Old')
  // x opens its own lobby (new): presence never crosses lobbies.
  s.enter(x, 'X')
  s.say(x, { t: 'lobby_pick', action: 'new' })
  const st = { k: 'st', s: 1, p: [0, 100, 0], f: 0, m: 0, e: 0, q: 1, x: 0 }
  s.say(b, { t: 'lobby_presence', a: st })
  s.say(w, { t: 'lobby_presence', a: st })
  s.say(x, { t: 'lobby_presence', a: st })
  s.say(a, { t: 'lobby_presence', a: { ...st, s: 2 } })
  const lobby = a.conn.last('lobby_state')!.id
  assert.deepEqual(b.conn.last('lobby_presence'), { t: 'lobby_presence', id: lobby, from: 0, a: { ...st, s: 2 } })
  assert.equal(w.conn.last('lobby_presence')!.from, 0)
  // a had not sent presence yet when b and w did: it received nothing (and never anything from x).
  assert.equal(a.conn.last('lobby_presence'), undefined)
  s.say(w, { t: 'lobby_presence', a: { ...st, s: 3 } })
  assert.deepEqual([a, b].map((c) => c.conn.last('lobby_presence')!.from), [2, 2])
  assert.equal(old.conn.last('lobby_presence'), undefined)
  assert.equal(x.conn.sent.filter((m) => m.t === 'lobby_presence').length, 0)
})

test('presence: dropped outside a lobby and in a round without counting invalid; an oversized state is invalid', () => {
  const s = setup(1000)
  const a = s.add(), b = s.add(), w = s.add()
  for (let i = 0; i < 12; i++) s.say(a, { t: 'lobby_presence', a: { k: 'st', s: i } })
  assert.equal(a.conn.last('lobby_error'), undefined)
  s.enter(a, 'A')
  joinFirst(s, b, 'join', 'B')
  joinFirst(s, w, 'spectate', 'W')
  s.say(w, { t: 'lobby_presence', a: { k: 'st', s: 1 } })
  s.clock.t += 1000
  s.hub.tick(s.clock.t)
  assert.ok(a.conn.last('matched'))
  // Seated players neither send nor receive presence; spectators keep theirs.
  const nw = w.conn.sent.length
  s.say(a, { t: 'lobby_presence', a: { k: 'st', s: 5 } })
  assert.equal(w.conn.sent.length, nw)
  s.say(w, { t: 'lobby_presence', a: { k: 'st', s: 2 } })
  assert.equal(a.conn.last('lobby_presence'), undefined)
  assert.equal(parseLobbyMessage({ t: 'lobby_presence', a: { s: 'x'.repeat(300) } }), null)
  assert.equal(parseLobbyMessage({ t: 'lobby_presence', a: [1, 2] }), null)
  assert.equal(lobbyClaims('{"t":"lobby_presence","a":{}}'), true)
})

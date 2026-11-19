// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Origin->game binding (transport.ts + src/origin.ts gamesFor): a connection admitted ONLY through the
// registrar's dynamic list is bound to the game(s) that origin is registered for, and refuses auth,
// match_queue, lobby_enter and the rooms `hello` for any other game. A connection admitted statically, or with
// no `games` data from the registrar, is unbound (current behaviour, any game is accepted).
import test from 'node:test'
import assert from 'node:assert/strict'
import { RoomHub } from '../src/hub.ts'
import type { ClientConn } from '../src/hub.ts'
import { loadConfig } from '../src/config.ts'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { LobbyService } from '../src/lobby/service.ts'

type Msg = Record<string, unknown>

class FakeConn implements ClientConn {
  sent: Msg[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
  last(): Msg | undefined { return this.sent.at(-1) }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

// ---------------------------------------------------------------- RoomHub (kart-rooms `hello`)

test('RoomHub: hello for a game outside the origin binding is refused; the bound game and an unbound connection work', () => {
  const hub = new RoomHub(loadConfig({}), { now: () => 0, random: () => 0.5, seed: () => 1, log: () => {} })
  const bound = new FakeConn()
  const idBound = hub.connect(bound, ['kart'])
  hub.message(idBound, JSON.stringify({ t: 'hello', v: 1, game: 'other-game', name: 'Ann' }))
  assert.deepEqual(bound.last(), { t: 'error', code: 'game_not_allowed_for_origin', message: 'this origin is not registered for this game' })
  hub.message(idBound, JSON.stringify({ t: 'hello', v: 1, game: 'kart', name: 'Ann' }))
  assert.equal(bound.last()!.t, 'welcome')

  const unbound = new FakeConn()
  const idUnbound = hub.connect(unbound, null)
  hub.message(idUnbound, JSON.stringify({ t: 'hello', v: 1, game: 'other-game', name: 'Ann' }))
  assert.equal(unbound.last()!.t, 'welcome')
})

// ---------------------------------------------------------------- RelayHub.gameAllowed + MatchService (auth, match_queue)

function matchSetup() {
  const deps = { now: () => 1_000_000, random: Math.random, log: () => {} }
  const service = new MatchService(deps, createMemoryStore())
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const add = (boundGames: readonly string[] | null, ip: string | null = null) => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/', 'https://shared.example', boundGames, ip)
    return { conn, id, frame: (m: Msg) => hub.message(id, JSON.stringify(m)) }
  }
  return { hub, add }
}

test('RelayHub.gameAllowed/ipOf reflect what connect was given; an unbound/unknown connection allows any game', () => {
  const { hub, add } = matchSetup()
  const bound = add(['kart', 'kekkai'], '203.0.113.9')
  assert.equal(hub.gameAllowed(bound.id, 'kart'), true)
  assert.equal(hub.gameAllowed(bound.id, 'other-game'), false)
  assert.equal(hub.ipOf(bound.id), '203.0.113.9')
  const unbound = add(null)
  assert.equal(hub.gameAllowed(unbound.id, 'anything'), true)
  assert.equal(hub.ipOf(unbound.id), null)
  assert.equal(hub.gameAllowed('no-such-conn', 'anything'), true)
})

test('MatchService: auth for a game outside the binding is refused; the bound game and an unbound connection work', async () => {
  const { add } = matchSetup()
  const bound = add(['kekkai'])
  bound.frame({ t: 'auth', provider: 'guest', token: 'guest-token-bound-aaaaaaa', game: 'other-game' })
  await flush()
  assert.deepEqual(bound.conn.last(), { t: 'error', reason: 'game_not_allowed_for_origin' })
  bound.frame({ t: 'auth', provider: 'guest', token: 'guest-token-bound-aaaaaaa', game: 'kekkai' })
  await flush()
  assert.equal(bound.conn.last()!.t, 'authed')

  const unbound = add(null)
  unbound.frame({ t: 'auth', provider: 'guest', token: 'guest-token-unbound-aaaaaa', game: 'other-game' })
  await flush()
  assert.equal(unbound.conn.last()!.t, 'authed')
})

test('MatchService: match_queue for a game outside the binding is refused even after an unqualified auth', async () => {
  const { add } = matchSetup()
  const bound = add(['kekkai'])
  bound.frame({ t: 'auth', provider: 'guest', token: 'guest-token-bound-queue-1' }) // no game named at auth
  await flush()
  assert.equal(bound.conn.last()!.t, 'authed')
  bound.frame({ t: 'match_queue', game: 'other-game', queue: 'quick' })
  await flush()
  assert.deepEqual(bound.conn.last(), { t: 'error', reason: 'game_not_allowed_for_origin' })
  bound.frame({ t: 'match_queue', game: 'kekkai', queue: 'quick' })
  await flush()
  assert.equal(bound.conn.last()!.t, 'match_queued')
})

// ---------------------------------------------------------------- LobbyService (lobby_enter)

test('LobbyService: lobby_enter for a game outside the binding is refused; the bound game works', async () => {
  const deps = { now: () => 1_000_000, random: Math.random, log: () => {} }
  const lobby = new LobbyService(deps, { waitMs: 60_000 })
  const hub = new RelayHub(deps, undefined)
  hub.use(lobby)
  lobby.attach(hub)
  const conn = new FakeConn()
  const id = hub.connect(conn, '/', 'https://shared.example', ['royal-fiesta'])
  hub.message(id, JSON.stringify({ t: 'lobby_enter', game: 'other-game', seats: 2, cadence: false, payload: null }))
  assert.deepEqual(conn.last(), { t: 'lobby_error', reason: 'game_not_allowed_for_origin' })
  hub.message(id, JSON.stringify({ t: 'lobby_enter', game: 'royal-fiesta', seats: 2, cadence: false, payload: null }))
  assert.equal(conn.last()!.t, 'lobby_state')
})

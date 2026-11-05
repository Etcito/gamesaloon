// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// LobbyService: timed lobbies on the relay socket (a RelayExtension, see docs/lobby.md).
// lobby_enter -> the player is seated at once (lobby_state): in the oldest waiting lobby of its format with a
// free seat, else in a new empty lobby; `spectate: true` watches instead (explicit request only). The old
// question (lobby_choice, then lobby_pick join|spectate|new) is asked only for `choice: true`. When the wait ends (or the lobby is full) the seated players get the
// relay's usual `matched` (RelayHub.startGroup); spectators get lobby_watch then every act as lobby_act.
import type { RelayExtension, RelayHub, RelaySeatRef } from '../relay/hub.ts'
import { LobbyBook, roster } from './lobby.ts'
import type { Lobby, LobbyFormat, LobbyRules } from './lobby.ts'
import { parseLobbyMessage } from './messages.ts'
import type { LobbyErrorCode, LobbyServerMessage } from './messages.ts'

export interface LobbyDeps { now(): number; log(level: string, msg: string): void }

export class LobbyService implements RelayExtension {
  private deps: LobbyDeps
  private book: LobbyBook
  private waitMs: number
  private hub: RelayHub | null = null
  /** Arrivals that were offered a choice: what they asked to play. */
  private pending = new Map<string, { format: LobbyFormat; payload: unknown }>()
  /** Sockets that sent lobby_presence: only they receive the others' presence. */
  private presence = new Set<string>()

  constructor(deps: LobbyDeps, rules: Partial<LobbyRules> = {}) {
    this.deps = deps
    this.book = new LobbyBook(rules)
    this.waitMs = this.book.rules.waitMs
  }

  attach(hub: RelayHub): void { this.hub = hub }

  message(conn: string, raw: Record<string, unknown>): boolean {
    const msg = parseLobbyMessage(raw)
    if (!msg) return false
    const now = this.deps.now()
    if (msg.t === 'lobby_leave') {
      this.pending.delete(conn)
      this.leave(conn, now)
      this.send(conn, { t: 'lobby_left' })
      return true
    }
    if (msg.t === 'lobby_presence') return this.presenceFrom(conn, msg.a)
    if (this.hub?.seatOf(conn)) return this.error(conn, 'in_session')
    if (msg.t === 'lobby_enter') {
      if (msg.zones && !this.hub?.zoneGame(msg.game)) return this.error(conn, 'unknown game')
      const format: LobbyFormat = msg.zones ? { game: msg.game, seats: msg.seats, cadence: msg.cadence, zones: true } : { game: msg.game, seats: msg.seats, cadence: msg.cadence }
      // A local build (page on localhost) gets lobbies of its own with a short wait: two local browsers meet in
      // seconds, and public players never wait less or meet a developer's build.
      if (this.hub?.localDev(conn)) format.dev = true
      this.leave(conn, now)
      const lobbies = this.book.choices(format, now)
      if (!lobbies.length) return this.open(conn, format, msg.payload, now)
      if (!msg.choice) {
        if (msg.spectate) {
          // Spectating is an explicit request: the lobby that would have been joined, else the oldest one.
          const target = lobbies.find((l) => l.actions.includes('join')) ?? lobbies[0]
          this.book.spectate(conn, target.id, msg.payload)
          const lobby = this.book.get(target.id)!
          this.publish(lobby, now)
          if (lobby.phase === 'playing') this.watchFrom(conn, lobby)
          return true
        }
        // choices() lists joinable lobbies first, so the first one is the one to join, if any can be.
        const joinable = lobbies.find((l) => l.actions.includes('join'))
        if (!joinable) return this.open(conn, format, msg.payload, now)
        const r = this.book.join(conn, msg.payload, joinable.id)
        if (typeof r === 'string') return this.open(conn, format, msg.payload, now)
        this.publish(r, now)
        this.startDue(now)
        return true
      }
      this.pending.set(conn, { format, payload: msg.payload })
      this.send(conn, { t: 'lobby_choice', lobbies })
      return true
    }
    // lobby_pick
    const want = this.pending.get(conn)
    if (!want) return this.error(conn, 'not_entered')
    if (msg.action === 'new') {
      this.pending.delete(conn)
      return this.open(conn, want.format, want.payload, now)
    }
    const target = this.book.get(msg.id as string)
    if (!target || target.format.game !== want.format.game) return this.error(conn, 'unknown_lobby')
    if (msg.action === 'join') {
      const r = this.book.join(conn, want.payload, target.id)
      if (r === 'unknown') return this.error(conn, 'unknown_lobby')
      if (r === 'closed') return this.error(conn, 'lobby_closed')
      this.pending.delete(conn)
      this.publish(r, now)
      this.startDue(now)
      return true
    }
    this.book.spectate(conn, target.id, want.payload)
    this.pending.delete(conn)
    // Everyone not in the round learns of the new spectator (the roster: presence shows it in the hub).
    this.publish(target, now)
    if (target.phase === 'playing') this.watchFrom(conn, target)
    return true
  }

  connClosed(conn: string, _seat: RelaySeatRef | null): void {
    this.pending.delete(conn)
    this.presence.delete(conn)
    this.leave(conn, this.deps.now())
  }

  seatResumed(_seat: RelaySeatRef): void {}

  sessionEnded(session: string): void {
    const lobby = this.book.bySession(session)
    if (!lobby) return
    const watchers = [...lobby.spectators]
    this.book.close(lobby.id)
    for (const c of watchers) this.send(c, { t: 'lobby_closed', id: lobby.id, reason: 'ended' })
  }

  sessionAct(session: string, from: number, n: number, a: unknown): void {
    const lobby = this.book.bySession(session)
    if (!lobby || !lobby.spectators.size) return
    for (const c of lobby.spectators) this.send(c, { t: 'lobby_act', id: lobby.id, a, n, from })
  }

  tick(nowMs: number): void { this.startDue(nowMs) }

  private open(conn: string, format: LobbyFormat, payload: unknown, now: number): true {
    const lobby = this.book.open(conn, payload, format, now)
    this.deps.log('info', `[lobby] ${lobby.id} opened for ${format.game} (${format.seats} seats)`)
    this.publish(lobby, now)
    this.startDue(now)
    return true
  }

  private leave(conn: string, now: number): void {
    const r = this.book.leave(conn)
    if (!r) return
    if (r.closed) {
      for (const c of r.lobby.spectators) this.send(c, { t: 'lobby_closed', id: r.lobby.id, reason: 'empty' })
    } else this.publish(r.lobby, now)
  }

  private startDue(now: number): void {
    if (!this.hub) return
    for (const lobby of this.book.due(now)) {
      // A member that got seated elsewhere meanwhile cannot start here: drop it, keep the others.
      for (const m of [...lobby.members]) if (this.hub.seatOf(m.conn)) this.book.leave(m.conn)
      if (!this.book.get(lobby.id) || !lobby.members.length) continue
      try {
        const { session, seed } = this.hub.startGroup(lobby.members.map((m) => m.conn), lobby.members.map((m) => m.payload), { cadence: lobby.format.cadence, game: lobby.format.zones ? lobby.format.game : null })
        this.book.started(lobby.id, session, seed)
        this.deps.log('info', `[lobby] ${lobby.id} started ${session} with ${lobby.members.length}/${lobby.format.seats}`)
        for (const c of lobby.spectators) {
          this.stateTo(c, lobby, now)
          this.watchFrom(c, lobby)
        }
      } catch (e) {
        // Server full: tell the lobby and close it; its players may enter again.
        const reason = e instanceof Error && e.message === 'server full' ? 'server full' : 'lobby_closed'
        this.deps.log('error', `[lobby] ${lobby.id} could not start: ${reason}`)
        for (const c of this.book.close(lobby.id)) this.send(c, { t: 'lobby_error', reason })
      }
    }
  }

  /** The lobby's state to every player and spectator; once the round is on, to its spectators only (the players are in the round). */
  private publish(lobby: Lobby, now: number): void {
    if (lobby.phase === 'waiting') for (const m of lobby.members) this.stateTo(m.conn, lobby, now)
    for (const c of lobby.spectators) this.stateTo(c, lobby, now)
  }

  private stateTo(conn: string, lobby: Lobby, now: number): void {
    const seat = lobby.members.findIndex((m) => m.conn === conn)
    this.send(conn, {
      t: 'lobby_state', id: lobby.id, phase: lobby.phase,
      role: seat >= 0 ? 'player' : 'spectator', seat,
      players: lobby.members.map((m) => m.payload), seats: lobby.format.seats,
      startsInMs: lobby.phase === 'waiting' ? Math.max(0, lobby.startsAt - now) : 0,
      waitMs: this.book.waitOf(lobby.format),
      you: lobby.keys.get(conn) ?? -1, members: roster(lobby),
    })
  }

  /**
   * Shared hub presence: a member's avatar state goes to every other member of its lobby (players and
   * spectators) that is not in a round and that sends presence itself, so a client without presence
   * never receives a frame it does not know. Outside a lobby, or seated in a round, it is dropped
   * silently (a late frame after the start is not an error). The relay's per-socket rate limit bounds it.
   */
  private presenceFrom(conn: string, a: Record<string, unknown>): true {
    const lobby = this.book.of(conn)
    if (!lobby || this.hub?.seatOf(conn)) return true
    this.presence.add(conn)
    const from = lobby.keys.get(conn)
    if (from === undefined) return true
    const frame: LobbyServerMessage = { t: 'lobby_presence', id: lobby.id, from, a }
    for (const c of [...lobby.members.map((m) => m.conn), ...lobby.spectators]) {
      if (c === conn || !this.presence.has(c) || this.hub?.seatOf(c)) continue
      this.send(c, frame)
    }
    return true
  }

  /** Header then the act log so far: the spectator replays the round from its start (when the log allows). */
  private watchFrom(conn: string, lobby: Lobby): void {
    if (!this.hub || lobby.session === null || lobby.seed === null) return
    const w = this.hub.watch(lobby.session)
    this.send(conn, {
      t: 'lobby_watch', id: lobby.id, session: lobby.session, seed: lobby.seed,
      players: lobby.members.length, opps: lobby.members.map((m) => m.payload), replay: w !== null,
    })
    if (w) for (const e of w.acts) this.send(conn, { t: 'lobby_act', id: lobby.id, a: e.a, n: e.n, from: e.from })
  }

  private send(conn: string, msg: LobbyServerMessage): void {
    this.hub?.send(conn, msg as unknown as Record<string, unknown>)
  }

  private error(conn: string, reason: LobbyErrorCode): true {
    this.send(conn, { t: 'lobby_error', reason })
    return true
  }
}

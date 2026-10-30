// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Timed lobbies, pure state (no sockets, no clock of its own): the first player opens a lobby, the
// round starts when the wait ends (or when every seat is taken) with whoever is there. A player who
// arrives while lobbies of the same format exist chooses: join a waiting one, spectate one, or open
// a new empty lobby. Spectators are never seated, so they never become rollback peers.

export const DEFAULT_LOBBY_WAIT_MS = 60_000
export const DEFAULT_LOBBY_MIN_PLAYERS = 1
export const MAX_LOBBY_SEATS = 4

export type LobbyPhase = 'waiting' | 'playing'
export type LobbyAction = 'join' | 'spectate' | 'new'

export interface LobbyRules {
  /** How long a lobby waits for players after its first player arrives. A later arrival never resets it. */
  waitMs: number
  /** Seated players needed when the wait ends; below it the lobby keeps waiting (default 1: games fill with bots). */
  minPlayers: number
}

/** A lobby format: lobbies of one format are offered to each other's arrivals, never across formats. */
export interface LobbyFormat { game: string; seats: number; cadence: boolean }

export interface Lobby {
  id: string
  format: LobbyFormat
  phase: LobbyPhase
  openedAt: number
  /** When the round starts if not full before; fixed at the first arrival. */
  startsAt: number
  members: { conn: string; payload: unknown }[]
  spectators: Set<string>
  /** Relay session of the started round. */
  session: string | null
  seed: number | null
}

export interface LobbySummary {
  id: string
  phase: LobbyPhase
  players: number
  seats: number
  /** Milliseconds until the round starts (0 once playing). */
  startsInMs: number
  /** What the arrival may do with this lobby. */
  actions: LobbyAction[]
  names: unknown[]
}

/** LOBBY_WAIT_MS (default 60000, 1000..600000) and LOBBY_MIN_PLAYERS (default 1, 1..4); throws `[config] NAME`. */
export function loadLobbyRules(env: Record<string, string | undefined>): LobbyRules {
  const read = (name: string, def: number, lo: number, hi: number): number => {
    const v = env[name]?.trim()
    if (v === undefined || v === '') return def
    const n = Number(v)
    if (!/^\d+$/.test(v) || n < lo || n > hi) throw new Error(`[config] ${name}`)
    return n
  }
  return {
    waitMs: read('LOBBY_WAIT_MS', DEFAULT_LOBBY_WAIT_MS, 1000, 600_000),
    minPlayers: read('LOBBY_MIN_PLAYERS', DEFAULT_LOBBY_MIN_PLAYERS, 1, MAX_LOBBY_SEATS),
  }
}

export function formatKey(f: LobbyFormat): string {
  return `${f.game}|${f.seats}|${f.cadence ? 1 : 0}`
}

export function summarize(lobby: Lobby, now: number): LobbySummary {
  const canJoin = lobby.phase === 'waiting' && lobby.members.length < lobby.format.seats
  return {
    id: lobby.id,
    phase: lobby.phase,
    players: lobby.members.length,
    seats: lobby.format.seats,
    startsInMs: lobby.phase === 'waiting' ? Math.max(0, lobby.startsAt - now) : 0,
    actions: canJoin ? ['join', 'spectate'] : ['spectate'],
    names: lobby.members.map((m) => m.payload),
  }
}

/** Every open lobby of a format. Lobbies live from their first player until their round ends. */
export class LobbyBook {
  readonly rules: LobbyRules
  private lobbies = new Map<string, Lobby>()
  /** conn -> lobby id, for players and spectators alike (a conn is in at most one lobby). */
  private where = new Map<string, string>()
  private seq = 0

  constructor(rules: Partial<LobbyRules> = {}) {
    this.rules = {
      waitMs: rules.waitMs ?? DEFAULT_LOBBY_WAIT_MS,
      minPlayers: Math.max(1, rules.minPlayers ?? DEFAULT_LOBBY_MIN_PLAYERS),
    }
  }

  get(id: string): Lobby | undefined { return this.lobbies.get(id) }
  of(conn: string): Lobby | undefined {
    const id = this.where.get(conn)
    return id ? this.lobbies.get(id) : undefined
  }
  bySession(session: string): Lobby | undefined {
    for (const l of this.lobbies.values()) if (l.session === session) return l
    return undefined
  }

  /**
   * Lobbies an arrival of this format may choose from: joinable ones (waiting, a free seat) first, then
   * oldest first. Empty means: open one directly.
   */
  choices(format: LobbyFormat, now: number): LobbySummary[] {
    const key = formatKey(format)
    return [...this.lobbies.values()]
      .filter((l) => formatKey(l.format) === key)
      .map((l) => summarize(l, now))
      .sort((a, b) => Number(b.actions.includes('join')) - Number(a.actions.includes('join'))
        || this.lobbies.get(a.id)!.openedAt - this.lobbies.get(b.id)!.openedAt)
  }

  /** Opens an empty lobby seated with `conn`; its wait starts now. */
  open(conn: string, payload: unknown, format: LobbyFormat, now: number): Lobby {
    this.leave(conn)
    const lobby: Lobby = {
      id: `L${++this.seq}`, format, phase: 'waiting', openedAt: now,
      startsAt: now + this.rules.waitMs, members: [{ conn, payload }],
      spectators: new Set(), session: null, seed: null,
    }
    this.lobbies.set(lobby.id, lobby)
    this.where.set(conn, lobby.id)
    return lobby
  }

  /** Seats `conn` in a waiting lobby with a free seat. The wait is not reset. */
  join(conn: string, payload: unknown, id: string): Lobby | 'unknown' | 'closed' {
    const lobby = this.lobbies.get(id)
    if (!lobby) return 'unknown'
    if (lobby.phase !== 'waiting' || lobby.members.length >= lobby.format.seats) return 'closed'
    this.leave(conn)
    lobby.members.push({ conn, payload })
    this.where.set(conn, lobby.id)
    return lobby
  }

  /** Watches a lobby, waiting or playing. */
  spectate(conn: string, id: string): Lobby | 'unknown' {
    const lobby = this.lobbies.get(id)
    if (!lobby) return 'unknown'
    this.leave(conn)
    lobby.spectators.add(conn)
    this.where.set(conn, lobby.id)
    return lobby
  }

  /** Removes `conn` wherever it is. A waiting lobby left with no player closes (returned with closed=true). */
  leave(conn: string): { lobby: Lobby; closed: boolean } | null {
    const lobby = this.of(conn)
    if (!lobby) return null
    this.where.delete(conn)
    lobby.spectators.delete(conn)
    if (lobby.phase === 'waiting') {
      const i = lobby.members.findIndex((m) => m.conn === conn)
      if (i >= 0) lobby.members.splice(i, 1)
      if (!lobby.members.length) {
        this.close(lobby.id)
        return { lobby, closed: true }
      }
    }
    return { lobby, closed: false }
  }

  /** The waiting lobbies whose round must start now: wait elapsed with enough players, or every seat taken. */
  due(now: number): Lobby[] {
    const out: Lobby[] = []
    for (const l of this.lobbies.values()) {
      if (l.phase !== 'waiting') continue
      const full = l.members.length >= l.format.seats
      const timeUp = now >= l.startsAt && l.members.length >= this.rules.minPlayers
      if (full || timeUp) out.push(l)
    }
    return out
  }

  /** Marks the round started on its relay session. Players stay listed; new arrivals may only spectate. */
  started(id: string, session: string, seed: number): void {
    const lobby = this.lobbies.get(id)
    if (!lobby) return
    lobby.phase = 'playing'
    lobby.session = session
    lobby.seed = seed
  }

  /** Ends a lobby (its round ended, or it emptied). Returns everyone who was in it. */
  close(id: string): string[] {
    const lobby = this.lobbies.get(id)
    if (!lobby) return []
    this.lobbies.delete(id)
    const conns = [...lobby.members.map((m) => m.conn), ...lobby.spectators]
    for (const c of conns) if (this.where.get(c) === id) this.where.delete(c)
    return conns
  }

  size(): number { return this.lobbies.size }
}

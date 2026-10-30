// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Lobby messages on the relay socket (/ws). New types only: the relay and match protocols are unchanged.
import { MAX_PLAYERS, RELAY_CLIENT_TYPES, RELAY_SERVER_TYPES, RELAY_TYPE_FIELD } from '../relay/protocol.ts'
import { MATCH_CLIENT_TYPES, MATCH_SERVER_TYPES } from '../match/messages.ts'
import type { LobbyAction, LobbyPhase, LobbySummary } from './lobby.ts'

export const LOBBY_CLIENT_TYPES = ['lobby_enter', 'lobby_pick', 'lobby_leave'] as const
export const LOBBY_SERVER_TYPES = ['lobby_choice', 'lobby_state', 'lobby_watch', 'lobby_act', 'lobby_closed', 'lobby_left', 'lobby_error'] as const
export const LOBBY_ERROR_CODES = ['not_entered', 'unknown_lobby', 'lobby_closed', 'in_session', 'server full'] as const
export type LobbyErrorCode = typeof LOBBY_ERROR_CODES[number]

const taken: readonly string[] = [...RELAY_CLIENT_TYPES, ...RELAY_SERVER_TYPES, ...MATCH_CLIENT_TYPES, ...MATCH_SERVER_TYPES]
for (const type of [...LOBBY_CLIENT_TYPES, ...LOBBY_SERVER_TYPES]) {
  if (taken.includes(type)) throw new Error(`Lobby message type '${type}' collides with another protocol`)
}

/** Largest seat payload (JSON characters) kept for a lobby member: names and colours, not saves. */
export const MAX_LOBBY_PAYLOAD = 512

export type LobbyClientMessage =
  | { t: 'lobby_enter'; game: string; seats: number; cadence: boolean; payload: Record<string, unknown> | null }
  | { t: 'lobby_pick'; action: LobbyAction; id: string | null }
  | { t: 'lobby_leave' }

export type LobbyServerMessage =
  | { t: 'lobby_choice'; lobbies: LobbySummary[] }
  | { t: 'lobby_state'; id: string; phase: LobbyPhase; role: 'player' | 'spectator'; seat: number; players: unknown[]; seats: number; startsInMs: number; waitMs: number }
  | { t: 'lobby_watch'; id: string; session: string; seed: number; players: number; opps: unknown[]; replay: boolean }
  | { t: 'lobby_act'; id: string; a: unknown; n: number; from: number }
  | { t: 'lobby_closed'; id: string; reason: 'ended' | 'empty' }
  | { t: 'lobby_left' }
  | { t: 'lobby_error'; reason: LobbyErrorCode }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A lobby message, or null when `msg` is not one or is malformed (the hub then counts it invalid). */
export function parseLobbyMessage(msg: Record<string, unknown>): LobbyClientMessage | null {
  switch (msg.t) {
    case 'lobby_enter': {
      const { game, seats, cadence, payload } = msg
      if (typeof game !== 'string' || game.length < 1 || game.length > 64) return null
      if (!Number.isInteger(seats) || (seats as number) < 1 || (seats as number) > MAX_PLAYERS) return null
      if (cadence !== undefined && typeof cadence !== 'boolean') return null
      if (payload !== undefined && payload !== null && !isObject(payload)) return null
      if (payload && JSON.stringify(payload).length > MAX_LOBBY_PAYLOAD) return null
      return { t: 'lobby_enter', game, seats: seats as number, cadence: cadence === true, payload: (payload as Record<string, unknown>) ?? null }
    }
    case 'lobby_pick': {
      const { action, id } = msg
      if (action !== 'join' && action !== 'spectate' && action !== 'new') return null
      if (id !== undefined && id !== null && (typeof id !== 'string' || id.length > 32)) return null
      if (action !== 'new' && typeof id !== 'string') return null
      return { t: 'lobby_pick', action, id: typeof id === 'string' ? id : null }
    }
    case 'lobby_leave': return { t: 'lobby_leave' }
    default: return null
  }
}

/** True for a lobby frame, so a shared /ws path routes it to the relay endpoint. */
export function lobbyClaims(frame: string): boolean {
  try {
    const parsed: unknown = JSON.parse(frame)
    return isObject(parsed) && typeof parsed[RELAY_TYPE_FIELD] === 'string'
      && (LOBBY_CLIENT_TYPES as readonly string[]).includes(parsed[RELAY_TYPE_FIELD] as string)
  } catch {
    return false
  }
}

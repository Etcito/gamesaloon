// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Server configuration from environment variables.

export interface Config {
  port: number
  host: string
  stunUrls: string[]
  turnUrls: string[]
  turnSecret: string | null
  maxRooms: number
  maxClients: number
  allowedOrigins: string[]
  logLevel: 'error' | 'info' | 'debug'
  rankedRequireAccount: boolean
  relayGames?: ReadonlyMap<string, number>
  relayMaxBinBytes?: number
  relayBinRatePerSec?: number
}

/** Default cap on one binary relay frame; larger than a snapshot chunk plus headers. */
export const DEFAULT_RELAY_MAX_BIN_BYTES = 20000
/** Default binary frames per second allowed per zone member. */
export const DEFAULT_RELAY_BIN_RATE_PER_SEC = 2000

function list(v: string | undefined, def: string): string[] {
  return (v ?? def).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

function int(env: Record<string, string | undefined>, name: string, def: number): number {
  const v = env[name]
  if (v === undefined) return def
  const s = v.trim()
  if (!/^\d+$/.test(s)) throw new Error(`[config] ${name}`)
  const n = Number(s)
  if (!Number.isSafeInteger(n)) throw new Error(`[config] ${name}`)
  return n
}

function positiveInt(env: Record<string, string | undefined>, name: string): number {
  const n = int(env, name, 0)
  if (n === 0) throw new Error(`[config] ${name}`)
  return n
}

/** Parses `game:maxPeers` entries (comma list) into the zone room seat caps. */
export function parseGameLimits(raw: string): ReadonlyMap<string, number> {
  const limits = new Map<string, number>()
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const colon = trimmed.indexOf(':')
    const game = colon < 0 ? '' : trimmed.slice(0, colon).trim()
    const maxPeersText = colon < 0 ? '' : trimmed.slice(colon + 1).trim()
    if (game.length < 1 || game.length > 64 || game.includes(',') || game.includes(':')) {
      throw new Error('[config] RELAY_GAMES')
    }
    if (!/^\d+$/.test(maxPeersText)) throw new Error('[config] RELAY_GAMES')
    const maxPeers = Number(maxPeersText)
    if (!Number.isSafeInteger(maxPeers) || maxPeers < 2 || maxPeers > 64) throw new Error('[config] RELAY_GAMES')
    if (limits.has(game)) throw new Error('[config] RELAY_GAMES')
    limits.set(game, maxPeers)
  }
  return limits
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const logLevel = env.LOG_LEVEL ?? 'info'
  if (logLevel !== 'error' && logLevel !== 'info' && logLevel !== 'debug') throw new Error('[config] LOG_LEVEL')
  const turnSecret = env.TURN_SECRET
  const config: Config = {
    port: int(env, 'PORT', 8787),
    host: env.HOST ?? '127.0.0.1',
    stunUrls: list(env.STUN_URLS, 'stun:stun.l.google.com:19302'),
    turnUrls: list(env.TURN_URLS, ''),
    turnSecret: turnSecret === undefined || turnSecret === '' ? null : turnSecret,
    maxRooms: int(env, 'MAX_ROOMS', 500),
    maxClients: int(env, 'MAX_CLIENTS', 2000),
    allowedOrigins: list(env.ALLOWED_ORIGINS, ''),
    logLevel,
    rankedRequireAccount: env.RANKED_REQUIRE_ACCOUNT === '1' || env.RANKED_REQUIRE_ACCOUNT === 'true',
  }
  if (env.RELAY_GAMES !== undefined) config.relayGames = parseGameLimits(env.RELAY_GAMES)
  if (env.RELAY_MAX_BIN_BYTES !== undefined) config.relayMaxBinBytes = positiveInt(env, 'RELAY_MAX_BIN_BYTES')
  if (env.RELAY_BIN_RATE_PER_SEC !== undefined) config.relayBinRatePerSec = positiveInt(env, 'RELAY_BIN_RATE_PER_SEC')
  return config
}

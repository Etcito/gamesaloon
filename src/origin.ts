// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Origin allow-list for WebSocket upgrades. An entry is an exact origin (`https://game.example.com`) or a
// subdomain wildcard (`https://*.builds.wavedashcdn.com`: any non-empty host label chain under that suffix,
// same scheme, no port unless the entry has one). An empty list allows everything.
/** The matching core of `originAllowed`, without its "empty list means allow everything" shortcut: an empty
 *  `allowed` here matches nothing. Used where an empty list is a real "no origins", not a wildcard (see `gamesFor`). */
function matchOrigin(allowed: readonly string[], origin: string): boolean {
  if (allowed.includes(origin)) return true
  let url: URL
  try { url = new URL(origin) } catch { return false }
  if (url.origin !== origin) return false
  for (const entry of allowed) {
    const m = /^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i.exec(entry)
    if (!m) continue
    if (url.protocol !== `${m[1]!.toLowerCase()}:`) continue
    if ((url.port ? `:${url.port}` : '') !== (m[3] ?? '')) continue
    const suffix = `.${m[2]!.toLowerCase()}`
    if (url.hostname.length > suffix.length && url.hostname.endsWith(suffix)) return true
  }
  return false
}

export function originAllowed(allowed: readonly string[], origin: unknown): boolean {
  if (allowed.length === 0) return true
  if (typeof origin !== 'string') return false
  return matchOrigin(allowed, origin)
}

// Dynamic origins: the registrar (Etcito) publishes the web origins of every deployment of every game, so adding a
// publishing platform to a game needs no env edit and no restart here. They are merged with the static ALLOWED_ORIGINS
// (a static list that is EMPTY still means "allow everything": the dynamic list only ever adds).
const DYNAMIC_ENTRY = /^https:\/\/(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/
const MAX_DYNAMIC = 500
const MAX_BODY = 256 * 1024
const MAX_GAMES = 500
const GAME_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Keeps only well-formed https origins (`https://host` or `https://*.suffix`, suffix of at least two labels). */
export function parseDynamicOrigins(body: unknown): string[] {
  const raw = (body as { origins?: unknown } | null)?.origins
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const o = v.trim().toLowerCase()
    if (DYNAMIC_ENTRY.test(o) && !out.includes(o)) out.push(o)
    if (out.length >= MAX_DYNAMIC) break
  }
  return out
}

/**
 * Parses the registrar's `games` map (`{"<game code>": ["https://...", ...]}`): which games each published
 * origin serves. Null when the field is absent or malformed, meaning the registrar predates origin->game
 * binding; callers must then treat every dynamically-admitted origin as unbound, exactly as before this field
 * existed. A present but empty object is NOT the same as absent: it means every dynamic origin is bound to no
 * game (refused per game) until the registrar's data catches up.
 */
export function parseDynamicGames(body: unknown): Map<string, string[]> | null {
  const raw = (body as { games?: unknown } | null)?.games
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out = new Map<string, string[]>()
  for (const [game, originsRaw] of Object.entries(raw)) {
    if (out.size >= MAX_GAMES) break
    const g = game.trim().toLowerCase()
    if (!GAME_CODE.test(g) || !Array.isArray(originsRaw)) continue
    const origins: string[] = []
    for (const v of originsRaw) {
      if (typeof v !== 'string') continue
      const o = v.trim().toLowerCase()
      if (DYNAMIC_ENTRY.test(o) && !origins.includes(o)) origins.push(o)
      if (origins.length >= MAX_DYNAMIC) break
    }
    out.set(g, origins)
  }
  return out
}

export interface DynamicOrigins {
  /** True when `origin` is in the registrar's list. A miss refreshes a stale list first (at most every `missRefreshMs`). */
  allows(origin: unknown): Promise<boolean>
  refresh(): Promise<void>
  /** Starts the periodic refresh (every `ttlMs`); the timer never keeps the process alive. */
  start(): void
  stop(): void
  list(): readonly string[]
  /**
   * Game codes `origin` is registered for, from the last loaded list, or null when unbound: the registrar sent
   * no `games` data at all (legacy response shape), so the caller must not restrict this origin by game. Call
   * only after (or alongside) a successful `allows(origin)`; it does not itself trigger a refresh.
   */
  gamesFor(origin: unknown): readonly string[] | null
}

export interface DynamicOriginsOptions {
  url: string
  ttlMs?: number
  missRefreshMs?: number
  fetchFn?: typeof fetch
  now?: () => number
  log?: (level: string, msg: string) => void
}

export function createDynamicOrigins(opts: DynamicOriginsOptions): DynamicOrigins {
  const ttlMs = opts.ttlMs ?? 60_000
  const missRefreshMs = opts.missRefreshMs ?? 5_000
  const doFetch = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  let origins: string[] = []
  let games: Map<string, string[]> | null = null
  let loadedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  async function load(): Promise<void> {
    try {
      const res = await doFetch(opts.url, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (text.length > MAX_BODY) throw new Error('response too large')
      const parsed = JSON.parse(text)
      origins = parseDynamicOrigins(parsed)
      games = parseDynamicGames(parsed)
    } catch (e) {
      // Keep the last good list: a registrar outage must not lock players out.
      log('error', `[origins] refresh failed, keeping ${origins.length} cached: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      loadedAt = now()
    }
  }

  function refresh(): Promise<void> {
    inflight ??= load().finally(() => { inflight = null })
    return inflight
  }

  return {
    async allows(origin) {
      if (typeof origin !== 'string') return false
      // originAllowed([]) means "allow everything": an empty registrar list must allow NOTHING
      if (origins.length > 0 && originAllowed(origins, origin)) return true
      if (now() - loadedAt >= missRefreshMs) {
        await refresh()
        return origins.length > 0 && originAllowed(origins, origin)
      }
      return false
    },
    refresh,
    start() {
      if (timer) return
      void refresh()
      timer = setInterval(() => { void refresh() }, ttlMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    list: () => origins,
    gamesFor(origin) {
      if (games === null || typeof origin !== 'string') return null
      const matches: string[] = []
      for (const [game, originsForGame] of games) {
        // matchOrigin, not originAllowed: a game with no (or no well-formed) origins must match nothing, never
        // "everything" (originAllowed's empty-list meaning does not apply to a single game's origin list).
        if (matchOrigin(originsForGame, origin)) matches.push(game)
      }
      return matches
    },
  }
}

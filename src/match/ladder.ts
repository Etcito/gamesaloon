// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Ladder reads with a short TTL cache: at most one leaderboard read and one rankOf per request on a miss.
import type { LeaderboardPage, PlayerStore, RankInfo, TierName } from '../store/types.ts'

export const LADDER_PAGE_SIZE = 10
export const LADDER_TTL_MS = 45000
const STORE_PAGE_SIZE = 50
const MAX_KEYS = 1000

export interface LadderEntry { rank: number; player_id: string; display_name: string; rating: number; tier: TierName }
export interface LadderPage { game: string; page: number; page_size: typeof LADDER_PAGE_SIZE; total: number; entries: LadderEntry[] }
export interface Ladder {
  page(store: PlayerStore, game: string, page: number): Promise<LadderPage>
  me(store: PlayerStore, playerId: string, game: string): Promise<RankInfo>
  invalidate(playerId: string, game: string): void
}

interface Cached<T> { value: T; at: number }

export function createLadder({ now, ttlMs = LADDER_TTL_MS }: { now: () => number; ttlMs?: number }): Ladder {
  const pages = new Map<string, Cached<LeaderboardPage>>()
  const mine = new Map<string, Cached<RankInfo>>()

  function put<T>(map: Map<string, Cached<T>>, key: string, value: T, at: number): void {
    map.set(key, { value, at })
    if (map.size > MAX_KEYS) {
      for (const [k, c] of map) if (at - c.at > ttlMs) map.delete(k)
    }
  }

  return {
    async page(store, game, page) {
      const first = (page - 1) * LADDER_PAGE_SIZE
      const storePage = Math.floor(first / STORE_PAGE_SIZE) + 1
      const offset = first % STORE_PAGE_SIZE
      const key = JSON.stringify([game, storePage])
      const t = now()
      let hit = pages.get(key)
      if (!hit || t - hit.at > ttlMs) {
        const value = await store.leaderboard(game, storePage)
        put(pages, key, value, t)
        hit = { value, at: t }
      }
      const lb = hit.value
      return {
        game, page, page_size: LADDER_PAGE_SIZE, total: lb.total,
        entries: lb.entries.slice(offset, offset + LADDER_PAGE_SIZE).map(({ rank, player_id, display_name, rating, tier }) => ({ rank, player_id, display_name, rating, tier })),
      }
    },
    async me(store, playerId, game) {
      const key = JSON.stringify([playerId, game])
      const t = now()
      const hit = mine.get(key)
      if (hit && t - hit.at <= ttlMs) return hit.value
      const value = await store.rankOf(playerId, game)
      put(mine, key, value, t)
      return value
    },
    invalidate(playerId, game) {
      mine.delete(JSON.stringify([playerId, game]))
    },
  }
}

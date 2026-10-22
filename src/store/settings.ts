// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Raw etc_settings values of one game, cached briefly. A missing row and a failed read both answer null,
// so a caller that reads a switch or a secret fails closed.

import type { TableApi } from './tables.ts'

export interface SettingsReader {
  /** The `value` of the etc_settings row `key` as a string, or null (no row, non-string value, or read failure). */
  get(key: string): Promise<string | null>
}

export const SETTINGS_CACHE_MS = 30_000

export function createSettingsReader(api: TableApi, opts: { now?: () => number; ttlMs?: number } = {}): SettingsReader {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? SETTINGS_CACHE_MS
  const cache = new Map<string, { at: number; value: string | null }>()
  return {
    async get(key) {
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttl) return hit.value
      let value: string | null
      try {
        const row = (await api.query('etc_settings', { filters: [{ field: 'key', op: 'eq', value: key }], size: 1 }))[0]
        value = typeof row?.value === 'string' ? row.value : null
      } catch {
        // Not cached: the next call retries. Meanwhile the caller refuses.
        return null
      }
      cache.set(key, { at: now(), value })
      return value
    },
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Writes a game's economy file (src/economy/gameconfig.ts) into its tenant tables: etc_settings by key and
// etc_products by (provider, code). Idempotent: a value already equal is not written, so re-importing the same
// file performs no insert and no update. The whole file is validated before the first write; a refused file
// leaves every previous value in place. Settings and products absent from the file are left untouched
// (TableApi has no delete). Used by `npm run game:import` and by the Etcito MCP flow (package export ./import).

import type { Filter, Row, TableApi } from '../store/tables.ts'
import { parseGameConfig } from './gameconfig.ts'

export interface ImportCounts { inserted: number; updated: number; unchanged: number }
export interface ImportResult { settings: ImportCounts; products: ImportCounts }

type Outcome = keyof ImportCounts

const counts = (): ImportCounts => ({ inserted: 0, updated: 0, unchanged: 0 })
const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })
/** Values compare as text: a tenant may hand back 100 as "100", and a missing value equals "". */
const same = (stored: unknown, next: unknown): boolean => String(stored ?? '') === String(next ?? '')

/** Inserts `row` when no row matches `filters`, else updates only the fields of `row` whose value differs. */
async function upsert(api: TableApi, table: string, filters: Filter[], row: Row, onInsert: Row = {}): Promise<Outcome> {
  let existing = (await api.query(table, { filters, size: 1 }))[0]
  if (!existing) {
    if (await api.insert(table, { ...row, ...onInsert }) !== 'conflict') return 'inserted'
    // Written meanwhile by another writer: fall through to the comparison.
    existing = (await api.query(table, { filters, size: 1 }))[0]
    if (!existing) throw new Error(`${table}: insert conflicted but no row matches`)
  }
  const patch: Row = {}
  for (const [field, value] of Object.entries(row)) if (!same(existing[field], value)) patch[field] = value
  if (Object.keys(patch).length === 0) return 'unchanged'
  await api.update(table, existing.id as number, patch)
  return 'updated'
}

/** Imports the economy file `text` into the tables behind `api`, whose mission must be `opts.game`. */
export async function importGameConfig(api: TableApi, text: string, opts: { game: string }): Promise<ImportResult> {
  // 1. The service key must read the mission of this game (strict: an import writes, so a blank one is refused too).
  const game = (await api.query('etc_game', { size: 1 }))[0]
  if (!game) throw new Error(`--game ${opts.game}: the mission of this service key has no etc_game row, cannot check it is this game`)
  if (game.handshake_game !== opts.game) {
    throw new Error(`--game ${opts.game}: etc_game.handshake_game of this service key's mission is another game (wrong key or wrong --game)`)
  }
  // 2. Validate the whole file before any write.
  const config = parseGameConfig(text)
  const result: ImportResult = { settings: counts(), products: counts() }
  // 3. etc_settings by key.
  for (const [key, value] of Object.entries(config.settings)) {
    result.settings[await upsert(api, 'etc_settings', [eq('key', key)], { key, value })]++
  }
  // 4. etc_products by (provider, code).
  for (const product of config.products) {
    const filters = [eq('provider', product.provider), eq('code', product.code)]
    result.products[await upsert(api, 'etc_products', filters, product, { created_at: Date.now() })]++
  }
  return result
}

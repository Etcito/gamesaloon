// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The one per-game economy configuration file: { catalog, products, settings? }. It is the shape Kekkai's
// `npm run economy:catalog` exports. Validation is hand-written and mirrors schemas/game-economy.schema.json;
// a refusal names the faulty field and never echoes its value (QB7).

import type { Row } from '../store/tables.ts'
import type { Catalog } from './types.ts'
import { CATALOG_KEY, parseCatalog, parseProduct } from './catalog.ts'

export const FILTER_KEY = 'economy.filter'
export const GIFT_KEY = 'economy.gifts'

export interface FilterSettings {
  min_length: number
  max_length: number
  banned_words: string[]
  no_url: boolean
}

export interface GiftSettings {
  count: number
  window_ms: number
}

export interface GameConfig {
  catalogText: string
  catalog: Catalog
  products: Row[]
  settings: Record<string, string>
}

const ID_RE = /^[A-Za-z0-9:_.-]{1,64}$/
const MAX_COUNT = 1000
const MAX_BANNED_WORDS = 10_000
const FILTER_FIELDS = ['min_length', 'max_length', 'banned_words', 'no_url'] as const
const GIFT_FIELDS = ['count', 'window_ms'] as const

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function intAt(raw: Record<string, unknown>, key: string, path: string, min: number): number {
  const v = raw[key]
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new Error(`${path}.${key} must be an integer >= ${min}`)
  return v
}

function onlyFields(raw: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not a recognized field`)
  }
}

function parseFilterValue(raw: unknown, path: string): FilterSettings {
  if (!isObj(raw)) throw new Error(`${path} must be an object`)
  onlyFields(raw, path, FILTER_FIELDS)
  const minLength = intAt(raw, 'min_length', path, 0)
  const maxLength = intAt(raw, 'max_length', path, 0)
  const words = raw.banned_words
  if (!Array.isArray(words) || words.length > MAX_BANNED_WORDS || words.some(w => typeof w !== 'string' || w === '')) {
    throw new Error(`${path}.banned_words must be a list of non-empty strings`)
  }
  if (typeof raw.no_url !== 'boolean') throw new Error(`${path}.no_url must be a boolean`)
  return { min_length: minLength, max_length: maxLength, banned_words: [...words] as string[], no_url: raw.no_url }
}

function parseGiftValue(raw: unknown, path: string): GiftSettings {
  if (!isObj(raw)) throw new Error(`${path} must be an object`)
  onlyFields(raw, path, GIFT_FIELDS)
  return { count: intAt(raw, 'count', path, 1), window_ms: intAt(raw, 'window_ms', path, 1) }
}

function catalogTextOf(raw: unknown): string {
  if (typeof raw === 'string') {
    if (raw.trim() === '') throw new Error('catalog must not be empty')
    return raw
  }
  if (isObj(raw)) return JSON.stringify(raw)
  throw new Error('catalog must be the economy.catalog JSON object or its text')
}

function parseGrantPacks(raw: unknown, path: string): Record<string, number> {
  if (typeof raw !== 'string') throw new Error(`${path} must be JSON text {"<pack_type>": count}`)
  if (raw.trim() === '') return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error(`${path} is not valid JSON`) }
  if (!isObj(parsed)) throw new Error(`${path} must be a JSON object`)
  const out: Record<string, number> = {}
  for (const [type, count] of Object.entries(parsed)) {
    if (!ID_RE.test(type)) throw new Error(`${path} has an invalid pack type`)
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) {
      throw new Error(`${path}.${type} must be an integer in 0..${MAX_COUNT}`)
    }
    if (count > 0) out[type] = count
  }
  return out
}

function parseProducts(raw: unknown): Row[] {
  if (!Array.isArray(raw)) throw new Error('products must be a list')
  const out: Row[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const where = `products[${i}]`
    const row = raw[i]
    if (!isObj(row)) throw new Error(`${where} must be an object`)
    const provider = row.provider
    if (provider !== 'wavedash' && provider !== 'stripe' && provider !== 'coins') throw new Error(`${where}.provider must be wavedash, stripe or coins`)
    if (typeof row.code !== 'string' || row.code === '') throw new Error(`${where}.code must be a non-empty string`)
    if (typeof row.label !== 'string') throw new Error(`${where}.label must be a string`)
    if (row.description !== undefined && typeof row.description !== 'string') throw new Error(`${where}.description must be a string`)
    if (typeof row.price !== 'number' || !Number.isSafeInteger(row.price) || row.price < 0) throw new Error(`${where}.price must be a non-negative integer`)
    if (typeof row.currency !== 'string' || row.currency === '') throw new Error(`${where}.currency must be a non-empty string`)
    if (typeof row.grant_coins !== 'number' || !Number.isSafeInteger(row.grant_coins) || row.grant_coins < 0) throw new Error(`${where}.grant_coins must be a non-negative integer`)
    const packs = parseGrantPacks(row.grant_packs, `${where}.grant_packs`)
    if (row.active !== undefined && typeof row.active !== 'boolean') throw new Error(`${where}.active must be a boolean`)
    if (row.sort_order !== undefined && (typeof row.sort_order !== 'number' || !Number.isSafeInteger(row.sort_order))) {
      throw new Error(`${where}.sort_order must be an integer`)
    }
    const key = `${provider}\u0000${row.code}`
    if (seen.has(key)) throw new Error(`${where}.code is declared twice for the same provider`)
    seen.add(key)
    if (row.grant_coins === 0 && Object.keys(packs).length === 0) throw new Error(`${where} grants nothing`)
    if (!parseProduct(row)) throw new Error(`${where} is not a valid product`)
    out.push(row)
  }
  return out
}

function parseSettings(raw: unknown, catalogText: string): Record<string, string> {
  const settings: Record<string, string> = { [CATALOG_KEY]: catalogText }
  if (raw === undefined) return settings
  if (!isObj(raw)) throw new Error('settings must be an object')
  onlyFields(raw, 'settings', ['filter', 'gifts'])
  if (raw.filter !== undefined) settings[FILTER_KEY] = JSON.stringify(parseFilterValue(raw.filter, 'settings.filter'))
  if (raw.gifts !== undefined) settings[GIFT_KEY] = JSON.stringify(parseGiftValue(raw.gifts, 'settings.gifts'))
  return settings
}

/** Parses the whole game economy file; throws on the first invalid field, naming its path. */
export function parseGameConfig(text: string): GameConfig {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('game config is not valid JSON') }
  if (!isObj(raw)) throw new Error('game config must be a JSON object')
  onlyFields(raw, 'game config', ['catalog', 'products', 'settings'])
  if (!Object.hasOwn(raw, 'catalog')) throw new Error('catalog is required')
  if (!Object.hasOwn(raw, 'products')) throw new Error('products is required')
  const catalogText = catalogTextOf(raw.catalog)
  let catalog: Catalog
  try { catalog = parseCatalog(catalogText) } catch (e) { throw new Error(`catalog: ${(e as Error).message}`) }
  const products = parseProducts(raw.products)
  const settings = parseSettings(raw.settings, catalogText)
  return { catalogText, catalog, products, settings }
}

/** Reads the stored `economy.filter` value; null when the setting is absent. */
export function parseFilterSettings(text: string | null | undefined): FilterSettings | null {
  if (text === null || text === undefined) return null
  if (typeof text !== 'string') throw new Error(`${FILTER_KEY} must be JSON text`)
  if (text.trim() === '') return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(`${FILTER_KEY} is not valid JSON`) }
  return parseFilterValue(raw, FILTER_KEY)
}

/** Reads the stored `economy.gifts` value; null when the setting is absent. */
export function parseGiftSettings(text: string | null | undefined): GiftSettings | null {
  if (text === null || text === undefined) return null
  if (typeof text !== 'string') throw new Error(`${GIFT_KEY} must be JSON text`)
  if (text.trim() === '') return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(`${GIFT_KEY} is not valid JSON`) }
  return parseGiftValue(raw, GIFT_KEY)
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCatalog } from '../src/economy/catalog.ts'
import { parseFilterSettings, parseGameConfig, parseGiftSettings } from '../src/economy/gameconfig.ts'
import { CATALOG } from './economy.helpers.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/economy/${name}`, import.meta.url), 'utf8')
const KEKKAI = fixture('kekkai-like.economy.json')
const OTHER = fixture('other-game.economy.json')

type Raw = Record<string, any>
const clone = (text: string): Raw => JSON.parse(text) as Raw
const text = (base: string, mutate?: (c: Raw) => void): string => { const c = clone(base); mutate?.(c); return JSON.stringify(c) }
const refused = (base: string, mutate: (c: Raw) => void, pattern: RegExp) => assert.throws(() => parseGameConfig(text(base, mutate)), pattern)

interface Schema { properties: Record<string, { properties?: Record<string, unknown> }> }
const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/game-economy.schema.json', import.meta.url), 'utf8')) as Schema

test('both fixtures parse', () => {
  const kekkai = parseGameConfig(KEKKAI)
  assert.deepEqual(kekkai.catalog, parseCatalog(JSON.stringify(CATALOG)))
  assert.equal(kekkai.products.length, 5)

  const other = parseGameConfig(OTHER)
  assert.deepEqual(other.catalog.currencies, ['stars'])
  assert.deepEqual(other.catalog.shop?.slots, ['hat', 'cape', 'boots'])
  assert.deepEqual(other.catalog.shop?.rarities, {
    plain: { price: { coins: 10, stars: 1 } },
    shiny: { price: { coins: 30, stars: 3 } },
  })
  assert.deepEqual(other.catalog.shop?.items.map(i => i.id), ['hat.sunny', 'cape.wind', 'boots.moon'])
  assert.equal(other.catalog.shop?.items[0]?.edition_cap, 2)
  assert.deepEqual(other.catalog.shop?.commission, { currency: 'stars' })
  assert.deepEqual(other.catalog.round_rewards, {
    finish: { coins: 5, currencies: {} },
    champion: { coins: 0, currencies: { stars: 1 } },
  })
  assert.equal(other.products.length, 2)
})

test('the catalog may be given as its JSON text', () => {
  const raw = clone(KEKKAI)
  const parsed = parseGameConfig(text(KEKKAI, c => { c.catalog = JSON.stringify(c.catalog) }))
  assert.equal(parsed.catalogText, JSON.stringify(raw.catalog))
  assert.deepEqual(parsed.catalog, parseCatalog(JSON.stringify(CATALOG)))
})

test('the kekkai-like file yields only economy.catalog and products', () => {
  const raw = clone(KEKKAI)
  const parsed = parseGameConfig(KEKKAI)
  assert.deepEqual(Object.keys(parsed.settings), ['economy.catalog'])
  assert.equal(parsed.settings['economy.catalog'], JSON.stringify(raw.catalog))
  assert.deepEqual(parsed.products, raw.products)
  assert.equal(parsed.settings['economy.filter'], undefined)
  assert.equal(parsed.settings['economy.gifts'], undefined)
})

test('a bad product price is refused naming the field', () => {
  refused(KEKKAI, c => { c.products[2].price = -1 }, /products\[2\]\.price/)
  refused(KEKKAI, c => { c.products[2].price = 'free' }, /products\[2\]\.price/)
})

test('an unknown shop slot is refused naming the field', () => {
  refused(OTHER, c => { c.catalog.shop.items[0].slot = 'crown' }, /shop\.items\[hat\.sunny\]\.slot/)
})

test('a duplicate product code is refused per provider', () => {
  refused(KEKKAI, c => { c.products[1].code = c.products[0].code }, /products\[1\]\.code is declared twice/)
  const parsed = parseGameConfig(KEKKAI)
  const codes = parsed.products.map(p => `${p.provider}:${p.code}`)
  assert.ok(codes.includes('wavedash:coins-250'))
  assert.ok(codes.includes('stripe:coins-250'))
})

test('bad JSON is refused naming the catalog field', () => {
  assert.throws(() => parseGameConfig('{"catalog":'), /game config is not valid JSON/)
  assert.throws(() => parseGameConfig(text(KEKKAI, c => { c.catalog = '{"cards":' })), /catalog.*not valid JSON/)
})

test('a bad gift setting is refused naming the field', () => {
  refused(OTHER, c => { c.settings.gifts.window_ms = 0 }, /settings\.gifts\.window_ms/)
  refused(OTHER, c => { c.settings.filter.banned_words = ['ok', 7] }, /settings\.filter\.banned_words/)
})

test('every top-level and settings property the schema declares is accepted', () => {
  const base = clone(OTHER)
  const input: Raw = {}
  for (const key of Object.keys(SCHEMA.properties)) {
    assert.ok(key in base, `the fixture covers schema top-level property ${key}`)
    input[key] = base[key]
  }
  const settingsSchema = SCHEMA.properties.settings
  assert.ok(settingsSchema && settingsSchema.properties)
  const settingsProperties = settingsSchema.properties
  const settings: Raw = {}
  for (const key of Object.keys(settingsProperties)) {
    assert.ok(key in base.settings, `the fixture covers schema settings property ${key}`)
    settings[key] = base.settings[key]
  }
  input.settings = settings
  const parsed = parseGameConfig(JSON.stringify(input))
  assert.deepEqual(Object.keys(parsed.settings).sort(), ['economy.catalog', 'economy.filter', 'economy.gifts'])
})

test('the runtime settings parsers read stored values and return null when absent', () => {
  assert.equal(parseFilterSettings(undefined), null)
  assert.equal(parseFilterSettings(''), null)
  assert.equal(parseGiftSettings(undefined), null)
  assert.equal(parseGiftSettings(''), null)

  const parsed = parseGameConfig(OTHER)
  assert.deepEqual(parseFilterSettings(parsed.settings['economy.filter']), {
    min_length: 2, max_length: 40, banned_words: ['spam', 'slur'], no_url: true,
  })
  assert.deepEqual(parseGiftSettings(parsed.settings['economy.gifts']), { count: 3, window_ms: 86400000 })
  assert.throws(() => parseGiftSettings('{"count":0,"window_ms":10}'), /economy\.gifts\.count/)
  assert.throws(() => parseFilterSettings('{"min_length":0}'), /economy\.filter\.max_length/)
})

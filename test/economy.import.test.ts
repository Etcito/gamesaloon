// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { Row, TableApi } from '../src/store/tables.ts'
import { createCatalog } from '../src/economy/catalog.ts'
import { parseFilterSettings, parseGiftSettings } from '../src/economy/gameconfig.ts'
import { importGameConfig } from '../src/economy/import.ts'
import { runImportCli } from '../src/economy/importCli.ts'
import { rig } from './economy.helpers.ts'

const fixtureUrl = (name: string): URL => new URL(`./fixtures/economy/${name}`, import.meta.url)
const KEKKAI = readFileSync(fixtureUrl('kekkai-like.economy.json'), 'utf8')
const OTHER = readFileSync(fixtureUrl('other-game.economy.json'), 'utf8')

type Raw = Record<string, any>
const edit = (base: string, mutate: (c: Raw) => void): string => { const c = JSON.parse(base) as Raw; mutate(c); return JSON.stringify(c) }

type Memory = ReturnType<typeof createMemoryTableApi>

async function tenant(handshakeGame: string | null = 'g'): Promise<Memory> {
  const api = createMemoryTableApi()
  if (handshakeGame !== null) {
    await api.insert('etc_game', {
      code: 'g', name: 'G', repo_url: '', repo_branch: 'main', handshake_game: handshakeGame,
      elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]',
    })
  }
  return api
}

/** The same api, counting every write (and recording each update patch). */
function spied(api: Memory): { api: TableApi; inserts: Row[]; updates: { table: string; patch: Row }[] } {
  const inserts: Row[] = []
  const updates: { table: string; patch: Row }[] = []
  return {
    inserts, updates,
    api: {
      query: (t, q) => api.query(t, q),
      insert: (t, r) => { inserts.push(r); return api.insert(t, r) },
      update: (t, id, patch) => { updates.push({ table: t, patch }); return api.update(t, id, patch) },
    },
  }
}

const snapshot = (api: Memory) => structuredClone({ settings: api.rows('etc_settings'), products: api.rows('etc_products') })
const setting = (api: Memory, key: string): unknown => api.rows('etc_settings').find(r => r.key === key)?.value

test('the first import inserts the settings and the products', async () => {
  const api = await tenant()
  const r = await importGameConfig(api, KEKKAI, { game: 'g' })
  assert.deepEqual(r, { settings: { inserted: 1, updated: 0, unchanged: 0 }, products: { inserted: 5, updated: 0, unchanged: 0 } })
  const raw = JSON.parse(KEKKAI) as Raw
  assert.equal(setting(api, 'economy.catalog'), JSON.stringify(raw.catalog))
  const stored = api.rows('etc_products').map(({ id: _id, created_at: _at, ...row }) => row)
  assert.deepEqual(stored, raw.products)
})

test('a second import of the same file writes nothing', async () => {
  for (const file of [KEKKAI, OTHER]) {
    const api = await tenant()
    await importGameConfig(api, file, { game: 'g' })
    const before = snapshot(api)
    const spy = spied(api)
    const r = await importGameConfig(spy.api, file, { game: 'g' })
    assert.deepEqual([spy.inserts.length, spy.updates.length], [0, 0])
    assert.equal(r.settings.inserted + r.settings.updated + r.products.inserted + r.products.updated, 0)
    assert.equal(r.settings.unchanged, before.settings.length)
    assert.equal(r.products.unchanged, before.products.length)
    assert.deepEqual(snapshot(api), before)
  }
})

test('a changed price updates exactly that field of that row', async () => {
  const api = await tenant()
  await importGameConfig(api, KEKKAI, { game: 'g' })
  const before = snapshot(api)
  const spy = spied(api)
  const r = await importGameConfig(spy.api, edit(KEKKAI, c => { c.products[1].price = 420 }), { game: 'g' })
  assert.deepEqual(r, { settings: { inserted: 0, updated: 0, unchanged: 1 }, products: { inserted: 0, updated: 1, unchanged: 4 } })
  assert.deepEqual(spy.updates, [{ table: 'etc_products', patch: { price: 420 } }])
  assert.equal(spy.inserts.length, 0)
  const expected = structuredClone(before)
  expected.products[1]!.price = 420
  assert.deepEqual(snapshot(api), expected)
})

test('a changed banned word updates exactly the economy.filter row', async () => {
  const api = await tenant()
  await importGameConfig(api, OTHER, { game: 'g' })
  const before = snapshot(api)
  const spy = spied(api)
  const r = await importGameConfig(spy.api, edit(OTHER, c => { c.settings.filter.banned_words[1] = 'scam' }), { game: 'g' })
  assert.deepEqual(r, { settings: { inserted: 0, updated: 1, unchanged: 2 }, products: { inserted: 0, updated: 0, unchanged: 2 } })
  assert.equal(spy.updates.length, 1)
  assert.equal(spy.inserts.length, 0)
  assert.deepEqual(parseFilterSettings(setting(api, 'economy.filter') as string)?.banned_words, ['spam', 'scam'])
  const after = snapshot(api)
  assert.deepEqual(after.products, before.products)
  assert.deepEqual(after.settings.filter(s => s.key !== 'economy.filter'), before.settings.filter(s => s.key !== 'economy.filter'))
})

test('a bad file is refused naming the field and leaves the previous rows identical', async () => {
  const api = await tenant()
  await importGameConfig(api, OTHER, { game: 'g' })
  const before = snapshot(api)
  const spy = spied(api)
  // A valid catalog edit next to a bad product: nothing at all is written.
  const bad = edit(OTHER, c => { c.catalog.round_rewards.finish.coins = 9; c.products[1].price = -1 })
  await assert.rejects(importGameConfig(spy.api, bad, { game: 'g' }), /products\[1\]\.price/)
  await assert.rejects(importGameConfig(spy.api, edit(OTHER, c => { c.settings.gifts.window_ms = 0 }), { game: 'g' }), /settings\.gifts\.window_ms/)
  await assert.rejects(importGameConfig(spy.api, '{"catalog":', { game: 'g' }), /not valid JSON/)
  assert.deepEqual([spy.inserts.length, spy.updates.length], [0, 0])
  assert.deepEqual(snapshot(api), before)
})

test('a wrong --game is refused before anything is read from the file or written', async () => {
  for (const api of [await tenant('h'), await tenant(''), await tenant(null)]) {
    const spy = spied(api)
    await assert.rejects(importGameConfig(spy.api, KEKKAI, { game: 'g' }), /--game g/)
    await assert.rejects(importGameConfig(spy.api, 'not json', { game: 'g' }), /--game g/)
    assert.deepEqual([spy.inserts.length, spy.updates.length], [0, 0])
    assert.deepEqual(snapshot(api), { settings: [], products: [] })
  }
})

test('the kekkai-like file imports and the economy service buys pack-shop as before', async () => {
  const api = await tenant()
  await importGameConfig(api, KEKKAI, { game: 'g' })
  const buy = async (r: Awaited<ReturnType<typeof rig>>) => {
    const p = await r.player('a')
    for (const k of ['tuto:intro', 'enc:1', 'enc:2', 'enc:3', 'enc:4', 'enc:5']) await r.svc.reward(p, k)
    const bought = await r.svc.buy(p, 'op1', 'pack-shop', 1)
    const s = await r.svc.state(p)
    return [bought.applied, bought.result.coins, bought.result.packs, s.coins, s.packs]
  }
  const imported = await buy(await rig({ api }))
  assert.deepEqual(imported, [true, 25, { shop: 1 }, 25, [{ pack_type: 'shop', quantity: 1 }]])
  assert.deepEqual(imported, await buy(await rig()))   // the hand-seeded tenant of the other economy tests
})

test('the other-game file imports and its catalog loads with its own slots and rarities', async () => {
  const api = await tenant()
  const r = await importGameConfig(api, OTHER, { game: 'g' })
  assert.deepEqual(r, { settings: { inserted: 3, updated: 0, unchanged: 0 }, products: { inserted: 2, updated: 0, unchanged: 0 } })
  const catalog = createCatalog(api, { game: 'g' })
  assert.equal(await catalog.refresh(), 'ok')
  const shop = catalog.current().shop
  assert.deepEqual(catalog.current().currencies, ['stars'])
  assert.deepEqual(shop?.slots, ['hat', 'cape', 'boots'])
  assert.deepEqual(Object.keys(shop?.rarities ?? {}), ['plain', 'shiny'])
  assert.deepEqual(shop?.items.map(i => [i.id, i.slot, i.rarity]), [['hat.sunny', 'hat', 'plain'], ['cape.wind', 'cape', 'shiny'], ['boots.moon', 'boots', 'plain']])
  assert.deepEqual(shop?.commission, { currency: 'stars' })
  assert.deepEqual(parseGiftSettings(setting(api, 'economy.gifts') as string), { count: 3, window_ms: 86400000 })
})

/** A fetch serving the remote generic table API from a memory tenant, recording the bearer keys it saw. */
function tenantFetch(api: Memory, bearers: string[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    bearers.push(String((init?.headers as Record<string, string>).authorization))
    const m = /\/api\/tables\/([^/]+)(?:\/(query|\d+))?$/.exec(new URL(String(url)).pathname)
    if (!m) return new Response('not found', { status: 404 })
    const table = decodeURIComponent(m[1]!)
    const body = JSON.parse(String(init?.body)) as Row
    if (m[2] === 'query') return Response.json({ records: await api.query(table, body) })
    if (m[2]) { await api.update(table, Number(m[2]), body); return Response.json({}) }
    const res = await api.insert(table, body)
    return res === 'conflict' ? new Response('conflict', { status: 409 }) : Response.json(res.row)
  }) as typeof fetch
}

test('game:import CLI prints the counts, refuses with exit 1, and never prints the key', async () => {
  const api = await tenant()
  const bearers: string[] = []
  const lines: string[] = []
  const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s), fetch: tenantFetch(api, bearers) }
  const env = { ETCITO_URL: 'https://tenant.example', ETCITO_GAME_KEYS: '{"g":"gsk_secret_g","h":"gsk_secret_h"}' }
  const file = fileURLToPath(fixtureUrl('kekkai-like.economy.json'))

  assert.equal(await runImportCli([file, '--game', 'g'], env, io), 0)
  assert.deepEqual(lines, ['[game:import] g', 'settings: 1 inserted, 0 updated, 0 unchanged', 'products: 5 inserted, 0 updated, 0 unchanged'])
  assert.ok(bearers.length > 0 && bearers.every(b => b === 'Bearer gsk_secret_g'))
  lines.length = 0
  assert.equal(await runImportCli([file, '--game=g'], env, io), 0)
  assert.equal(lines[2], 'products: 0 inserted, 0 updated, 5 unchanged')

  for (const argv of [[file, '--game', 'h'], [file, '--game', 'nobody'], [file], ['missing.json', '--game', 'g'], [file, '--game', 'g', '--force']]) {
    lines.length = 0
    assert.equal(await runImportCli(argv, env, io), 1, argv.join(' '))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /^\[game:import\] /)
  }
  assert.equal(await runImportCli([file, '--game', 'g'], { ETCITO_URL: 'https://tenant.example' }, io), 1)
  assert.match(lines.at(-1)!, /ETCITO_GAME_KEYS/)
  assert.ok(lines.every(l => !l.includes('gsk_secret')))
  assert.equal(api.rows('etc_products').length, 5)
})

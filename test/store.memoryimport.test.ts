// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadStoreConfig } from '../src/store/config.ts'
import { openStores } from '../src/store/setup.ts'

const IMPORT_FILE = fileURLToPath(new URL('./fixtures/economy/other-game.economy.json', import.meta.url))
const JWKS_URL = 'http://127.0.0.1:8790/.well-known/jwks.json'

test('the memory store config reads the economy import and the JWKS URL', () => {
  const cfg = loadStoreConfig({
    PLAYER_STORE: ' memory ',
    ECONOMY_IMPORT_FILE: `  ${IMPORT_FILE}  `,
    WAVEDASH_JWKS_URL: `  ${JWKS_URL}  `,
  })
  assert.deepEqual(cfg, { mode: 'memory', importFile: IMPORT_FILE, jwksUrl: JWKS_URL })
  assert.deepEqual(loadStoreConfig({ PLAYER_STORE: 'memory', ECONOMY_IMPORT_FILE: ' ', WAVEDASH_JWKS_URL: '' }), { mode: 'memory' })
})

test('the http store refuses both memory-only variables, naming them', () => {
  const base = { PLAYER_STORE: 'http', ETCITO_URL: 'https://crm.example', ETCITO_GAME_KEYS: '{"game-a":"gsk_a"}' }
  assert.throws(() => loadStoreConfig({ ...base, ECONOMY_IMPORT_FILE: IMPORT_FILE }),
    /\[config\] ECONOMY_IMPORT_FILE: only allowed with PLAYER_STORE=memory/)
  assert.throws(() => loadStoreConfig({ ...base, WAVEDASH_JWKS_URL: JWKS_URL }),
    /\[config\] WAVEDASH_JWKS_URL: only allowed with PLAYER_STORE=memory/)
})

test('a JWKS value that is not an http(s) URL is refused', () => {
  for (const bad of ['not a url', 'file:///tmp/jwks.json', 'ws://127.0.0.1:8790/jwks.json']) {
    assert.throws(() => loadStoreConfig({ PLAYER_STORE: 'memory', WAVEDASH_JWKS_URL: bad }),
      /\[config\] WAVEDASH_JWKS_URL:/)
  }
})

test('a memory store imports the economy fixture and serves it to every auth game', async () => {
  const stores = await openStores({ mode: 'memory', importFile: IMPORT_FILE })
  try {
    // One shared memory backend: whatever `game` the auth message names, resolve() answers it.
    const backend = stores.resolve('royal-fiesta')
    assert.ok(backend)
    assert.equal(backend.game, null)
    assert.equal(backend, stores.resolve(undefined))
    assert.equal(stores.importedSettings, 3)

    // Same call as test/economy.service-shop.test.ts: economy.shop(); the start-up refresh is fire-and-forget.
    const economy = backend.economy!
    await economy.catalog.refresh()
    const shop = await economy.shop()
    assert.deepEqual(shop.items.map(i => i.id), ['hat.sunny', 'cape.wind', 'boots.moon'])
    assert.deepEqual(shop.items.map(i => i.name), ['Sunny Hat', 'Wind Cape', 'Moon Boots'])
    assert.equal(shop.items.find(i => i.id === 'hat.sunny')!.remaining, 2)
  } finally {
    stores.close()
  }
})

test('an unreadable import file is refused naming the variable', async () => {
  await assert.rejects(openStores({ mode: 'memory', importFile: '/nonexistent/economy.json' }),
    /\[config\] ECONOMY_IMPORT_FILE: unreadable/)
})

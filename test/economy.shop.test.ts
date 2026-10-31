// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalog } from '../src/economy/catalog.ts'
import { createEconomyLedger } from '../src/economy/ledger.ts'
import { createShop } from '../src/economy/shop.ts'
import type { Catalog } from '../src/economy/types.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'

// The other game's vocabulary (not Royal Fiesta's): currency stars, slots hat/cape, a cape capped at 2 copies.
const HAT = 'costume.straw-hat'
const CAPE = 'costume.wave-cape'
const CATALOG: Catalog = parseCatalog(JSON.stringify({
  cards: [{ id: 'card.1', rarity: 'basic' }],
  currencies: ['stars'],
  shop: {
    drop: 'summer-drop',
    slots: ['hat', 'cape'],
    rarities: { plain: { price: { coins: 20, stars: 2 } }, shiny: { price: { coins: 60, stars: 5 } } },
    items: [
      { id: HAT, name: 'Straw Hat', slot: 'hat', rarity: 'plain', asset: HAT, price: { coins: 20, stars: 2 } },
      { id: CAPE, name: 'Wave Cape', slot: 'cape', rarity: 'shiny', asset: CAPE, price: { stars: 5 }, edition_cap: 2 },
    ],
  },
}))

function setup(catalog: Catalog = CATALOG) {
  const api = createMemoryTableApi()
  const ledger = createEconomyLedger(api, { catalog: () => catalog, now: () => 1 })
  const shop = createShop({ api, ledger, catalog: () => catalog, now: () => 1 })
  const fund = (playerId: string, coins: number, stars: number) =>
    ledger.commit(playerId, `fund:${playerId}`, 'eco.round', [], () => ({
      fx: { coins, packs: {}, cards: {}, ...(stars ? { currencies: { stars } } : {}) }, result: {},
    }))
  const sales = (item: string) => api.rows('etc_item_sales').find(r => r.item_id === item)
  return { api, ledger, shop, fund, sales }
}

test('the view lists the drop with sold and remaining copies', async () => {
  const { shop, fund } = setup()
  const fresh = await shop.view()
  assert.deepEqual(fresh, {
    drop: 'summer-drop',
    slots: ['hat', 'cape'],
    rarities: { plain: { price: { coins: 20, stars: 2 } }, shiny: { price: { coins: 60, stars: 5 } } },
    items: [
      { id: HAT, name: 'Straw Hat', slot: 'hat', rarity: 'plain', asset: HAT, price: { coins: 20, stars: 2 }, edition_cap: null, sold: 0, remaining: null },
      { id: CAPE, name: 'Wave Cape', slot: 'cape', rarity: 'shiny', asset: CAPE, price: { stars: 5 }, edition_cap: 2, sold: 0, remaining: 2 },
    ],
  })
  await fund('p', 0, 5)
  await shop.buy('p', 'op1', CAPE, 'stars')
  const cape = (await shop.view()).items.find(i => i.id === CAPE)
  assert.equal(cape?.sold, 1)
  assert.equal(cape?.remaining, 1)
})

test('without a shop section the view and the purchase are unavailable', async () => {
  const { shop } = setup(parseCatalog(JSON.stringify({ cards: [] })))
  await assert.rejects(shop.view(), { code: 'economy_unavailable' })
  await assert.rejects(shop.buy('p', 'op1', HAT, 'coins'), { code: 'economy_unavailable' })
})

test('a buy in stars spends the balance and gives the item with its serial', async () => {
  const { api, ledger, shop, fund, sales } = setup()
  await fund('p', 7, 6)
  const bought = await shop.buy('p', 'op1', CAPE, 'stars')
  assert.deepEqual(bought, { item: CAPE, currency: 'stars', price: 5, coins: 7, balances: { stars: 1 }, remaining: 1, applied: true })
  assert.deepEqual(await ledger.state('p'), { coins: 7, version: 2, packs: {}, cards: { [CAPE]: 1 }, balances: { stars: 1 } })
  const row = api.rows('etc_ledger').find(r => r.tx_id === 'c:p:op1')
  assert.equal(row?.op, 'eco.shop')
  assert.equal(row?.edition_key, `${CAPE}#1`)
  assert.deepEqual({ sold: sales(CAPE)?.sold, cap: sales(CAPE)?.cap }, { sold: 1, cap: 2 })
})

test('a buy in coins spends coins and leaves no edition on an uncapped item', async () => {
  const { api, ledger, shop, fund, sales } = setup()
  await fund('p', 25, 3)
  const bought = await shop.buy('p', 'op1', HAT, 'coins')
  assert.deepEqual(bought, { item: HAT, currency: 'coins', price: 20, coins: 5, balances: { stars: 3 }, remaining: null, applied: true })
  assert.deepEqual(await ledger.state('p'), { coins: 5, version: 2, packs: {}, cards: { [HAT]: 1 }, balances: { stars: 3 } })
  assert.equal(api.rows('etc_ledger').find(r => r.tx_id === 'c:p:op1')?.edition_key, undefined)
  assert.equal(sales(HAT)?.sold, 1)
  const hat = (await shop.view()).items.find(i => i.id === HAT)
  assert.deepEqual({ sold: hat?.sold, remaining: hat?.remaining }, { sold: 1, remaining: null })
})

test('refusals: unknown item, no price, already owned, insufficient funds; none commits', async () => {
  const { api, ledger, shop, fund } = setup()
  await fund('p', 19, 5)
  await assert.rejects(shop.buy('p', 'op1', 'costume.crown', 'coins'), { code: 'unknown_item' })
  await assert.rejects(shop.buy('p', 'op2', CAPE, 'coins'), { code: 'no_price' })
  await assert.rejects(shop.buy('p', 'op3', HAT, 'gems'), { code: 'no_price' })
  await assert.rejects(shop.buy('p', 'op4', HAT, 'coins'), { code: 'insufficient_funds' })
  await assert.rejects(shop.buy('poor', 'op5', HAT, 'stars'), { code: 'insufficient_funds' })
  assert.equal(api.rows('etc_ledger').length, 1)
  assert.equal((await shop.buy('p', 'op6', HAT, 'stars')).applied, true)
  await assert.rejects(shop.buy('p', 'op7', HAT, 'stars'), { code: 'already_owned' })
  assert.deepEqual(await ledger.state('p'), { coins: 19, version: 2, packs: {}, cards: { [HAT]: 1 }, balances: { stars: 3 } })
  await assert.rejects(shop.buy('p', '', HAT, 'stars'), { code: 'bad_argument' })
})

test('10 concurrent buyers of a cap-2 item: exactly 2 commit, 8 are sold out', async () => {
  const { api, shop, fund, sales } = setup()
  const players = Array.from({ length: 10 }, (_, i) => `p${i}`)
  for (const p of players) await fund(p, 0, 5)
  const outcomes = await Promise.all(players.map(p => shop.buy(p, 'op', CAPE, 'stars').then(
    r => ({ ok: true as const, remaining: r.remaining }),
    (e: { code?: string }) => ({ ok: false as const, code: e.code }),
  )))
  const won = outcomes.filter(o => o.ok)
  const lost = outcomes.filter(o => !o.ok)
  assert.equal(won.length, 2)
  assert.deepEqual(won.map(o => o.remaining).sort(), [0, 1])
  assert.equal(lost.length, 8)
  assert.ok(lost.every(o => o.code === 'sold_out'), JSON.stringify(lost))
  const editions = api.rows('etc_ledger').filter(r => r.op === 'eco.shop').map(r => r.edition_key).sort()
  assert.deepEqual(editions, [`${CAPE}#1`, `${CAPE}#2`])
  assert.equal(api.rows('etc_cards').filter(r => r.card_id === CAPE && r.quantity === 1).length, 2)
  assert.equal(sales(CAPE)?.sold, 2)
  assert.equal(sales(CAPE)?.cap, 2)
  assert.equal((await shop.view()).items.find(i => i.id === CAPE)?.remaining, 0)
})

test('a replay of the same op answers the stored result, applied:false, and counts once', async () => {
  const { api, ledger, shop, fund, sales } = setup()
  await fund('p', 0, 10)
  const first = await shop.buy('p', 'op1', CAPE, 'stars')
  const again = await shop.buy('p', 'op1', CAPE, 'stars')
  assert.deepEqual(again, { ...first, applied: false })
  assert.equal(api.rows('etc_ledger').filter(r => r.op === 'eco.shop').length, 1)
  assert.equal(sales(CAPE)?.sold, 1)
  assert.equal((await shop.view()).items.find(i => i.id === CAPE)?.remaining, 1)
  assert.deepEqual((await ledger.state('p')).balances, { stars: 5 })
  await assert.rejects(shop.buy('p', 'op1', HAT, 'stars'), { code: 'tx_conflict' })

  await fund('q', 25, 0)
  const hat = await shop.buy('q', 'op1', HAT, 'coins')
  assert.equal((await shop.buy('q', 'op1', HAT, 'coins')).applied, false)
  assert.equal(hat.applied, true)
  assert.equal(sales(HAT)?.sold, 1)
})

test('a sales row lagging behind the ledger is repaired, and the cap still holds', async () => {
  const { api, shop, fund, sales } = setup()
  for (const p of ['a', 'b', 'c']) await fund(p, 0, 5)
  await shop.buy('a', 'op', CAPE, 'stars')
  await shop.buy('b', 'op', CAPE, 'stars')
  // A crash between the commit and the sales projection of the last copy.
  await api.update('etc_item_sales', sales(CAPE)!.id as number, { sold: 1 })
  assert.equal((await shop.view()).items.find(i => i.id === CAPE)?.remaining, 1)
  await assert.rejects(shop.buy('c', 'op', CAPE, 'stars'), { code: 'sold_out' })
  assert.equal(sales(CAPE)?.sold, 2)
  // The buyer's own replay repairs it too.
  await api.update('etc_item_sales', sales(CAPE)!.id as number, { sold: 0 })
  assert.equal((await shop.buy('b', 'op', CAPE, 'stars')).applied, false)
  assert.equal(sales(CAPE)?.sold, 2)
})

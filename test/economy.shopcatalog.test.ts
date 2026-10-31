// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalog } from '../src/economy/catalog.ts'
import { parseCurrencies, parseRoundRewards, parseShop } from '../src/economy/shopcatalog.ts'
import { shopPool } from '../src/economy/draw.ts'
import { CATALOG } from './economy.helpers.ts'

// A game whose vocabulary is not Royal Fiesta's: slots hat/cape, rarities plain/shiny.
const RAW = {
  cards: [{ id: 'card.1', rarity: 'basic' }],
  currencies: ['tickets', 'gems'],
  shop: {
    drop: 'summer-drop',
    slots: ['hat', 'cape'],
    rarities: {
      plain: { price: { coins: 20, tickets: 2 } },
      shiny: { price: { coins: 60, tickets: 5 } },
    },
    items: [
      { id: 'costume.straw-hat', name: 'Straw Hat', slot: 'hat', rarity: 'plain', asset: 'costume.straw-hat', price: { coins: 20, tickets: 2 }, edition_cap: 100 },
      { id: 'costume.wave-cape', name: 'Wave Cape', slot: 'cape', rarity: 'shiny', asset: 'costume.wave-cape', price: { coins: 60 } },
    ],
    commission: { currency: 'tickets' },
  },
  round_rewards: {
    win: { coins: 10, currencies: { tickets: 2 } },
    loss: { coins: 0, currencies: { tickets: 1 } },
  },
}

type RawCatalog = Record<string, any>
const clone = (): RawCatalog => structuredClone(RAW) as unknown as RawCatalog
const text = (mutate?: (c: RawCatalog) => void): string => { const c = clone(); mutate?.(c); return JSON.stringify(c) }
const refused = (mutate: (c: RawCatalog) => void, pattern: RegExp) => assert.throws(() => parseCatalog(text(mutate)), pattern)

test('a valid catalog parses currencies, shop and round rewards', () => {
  const c = parseCatalog(text())
  assert.deepEqual(c.currencies, ['tickets', 'gems'])
  assert.deepEqual(c.shop, {
    drop: 'summer-drop',
    slots: ['hat', 'cape'],
    rarities: { plain: { price: { coins: 20, tickets: 2 } }, shiny: { price: { coins: 60, tickets: 5 } } },
    items: [
      { id: 'costume.straw-hat', name: 'Straw Hat', slot: 'hat', rarity: 'plain', asset: 'costume.straw-hat', price: { coins: 20, tickets: 2 }, edition_cap: 100 },
      { id: 'costume.wave-cape', name: 'Wave Cape', slot: 'cape', rarity: 'shiny', asset: 'costume.wave-cape', price: { coins: 60 }, edition_cap: null },
    ],
    commission: { currency: 'tickets' },
  })
  assert.deepEqual(c.round_rewards, {
    win: { coins: 10, currencies: { tickets: 2 } },
    loss: { coins: 0, currencies: { tickets: 1 } },
  })
  assert.deepEqual(c.cards, [{ id: 'card.1', rarity: 'basic' }])
})

test('the section parsers stand alone and compose', () => {
  assert.deepEqual(parseCurrencies(['tickets']), ['tickets'])
  assert.deepEqual(parseShop(clone().shop, ['tickets', 'gems']), parseCatalog(text()).shop)
  assert.deepEqual(parseRoundRewards(clone().round_rewards, ['tickets', 'gems']), parseCatalog(text()).round_rewards)
})

test('a catalog without optional sections parses exactly as before', () => {
  const c = parseCatalog(JSON.stringify(CATALOG))
  assert.deepEqual(c, {
    cards: [
      { id: '1', rarity: 'basic' }, { id: '2', rarity: 'basic' }, { id: '3', rarity: 'basic' },
      { id: '10', rarity: 'rare' }, { id: '11', rarity: 'rare' },
      { id: '20', rarity: 'epic' }, { id: '30', rarity: 'legendary' },
      { id: '99', rarity: 'basic', token: true },
    ],
    packs: {
      shop: {
        kind: 'random', size: 5, tiers: ['common', 'rare', 'epic', 'legendary'],
        weights: { common: 70, rare: 22, epic: 6.5, legendary: 1.5 }, tier_of: { basic: 'common' },
        guarantee: { slot: 'last', min_tier: 'rare' }, duplicate_refund: 3, cards: [],
      },
      'story:a:1': { kind: 'fixed', size: 3, tiers: [], weights: {}, tier_of: {}, guarantee: null, duplicate_refund: 0, cards: ['20', '1', '10'] },
    },
    rewards: {
      'tuto:intro': { coins: 25, packs: {} }, 'enc:*': { coins: 20, packs: {} },
      'bonus:*': { coins: 500, packs: {} }, 'story:a': { coins: 0, packs: { 'story:a:1': 1 } },
    },
  })
  assert.equal('shop' in c, false)
  assert.equal('currencies' in c, false)
  assert.equal('round_rewards' in c, false)
})

test('shop items are not cards and never enter packs', () => {
  const c = parseCatalog(text())
  assert.deepEqual(c.cards, [{ id: 'card.1', rarity: 'basic' }])
  assert.deepEqual(shopPool(c.cards).map(x => x.id), ['card.1'])
  assert.equal(c.packs.shop, undefined)
})

test('currencies are distinct names and never coins', () => {
  refused(c => { c.currencies.push('coins') }, /currencies\[2\].*coins/)
  refused(c => { c.currencies.push('tickets') }, /currencies\[2\].*duplicate currency tickets/)
  refused(c => { c.currencies[0] = 'bad name' }, /currencies\[0\]/)
  assert.throws(() => parseCurrencies('tickets'), /currencies must be a list/)
})

test("an item slot and rarity must be declared by the shop", () => {
  refused(c => { c.shop.items[0].slot = 'crown' }, /shop\.items\[costume\.straw-hat\]\.slot/)
  refused(c => { c.shop.items[0].rarity = 'epic' }, /shop\.items\[costume\.straw-hat\]\.rarity/)
})

test('an item price must use coins or a declared currency', () => {
  refused(c => { c.shop.items[0].price.credits = 1 }, /shop\.items\[costume\.straw-hat\]\.price\.credits/)
})

test('item price in a rarity-priced currency must equal the rarity price', () => {
  refused(c => { c.shop.items[0].price.tickets = 3 }, /shop\.items\[costume\.straw-hat\]\.price\.tickets must equal shop\.rarities\.plain\.price\.tickets/)
  const c = clone()
  delete c.shop.items[0]!.price.tickets
  assert.equal(parseCatalog(JSON.stringify(c)).shop!.items[0]!.price.tickets, undefined)
})

test('shop item ids are distinct and never a card id', () => {
  refused(c => { c.shop.items[1].id = 'costume.straw-hat' }, /shop\.items\[costume\.straw-hat\]\.id is declared twice/)
  refused(c => { c.shop.items[1].id = 'card.1' }, /shop\.items\[card\.1\]\.id must not collide with a card id/)
})

test('edition_cap is a positive integer or absent', () => {
  for (const bad of [0, -5, 1.5, '10']) {
    refused(c => { c.shop.items[0].edition_cap = bad }, /shop\.items\[costume\.straw-hat\]\.edition_cap/)
  }
  const c = clone()
  c.shop.items[0].edition_cap = null
  assert.equal(parseCatalog(JSON.stringify(c)).shop!.items[0]!.edition_cap, null)
  delete c.shop.items[0].edition_cap
  assert.equal(parseCatalog(JSON.stringify(c)).shop!.items[0]!.edition_cap, null)
})

test('the commission currency is declared and priced by every rarity', () => {
  refused(c => { c.shop.commission.currency = 'rubies' }, /shop\.commission\.currency/)
  refused(c => { c.shop.commission.currency = 'gems' }, /shop\.commission\.currency: shop\.rarities\.plain\.price\.gems is missing/)
  const c = clone()
  c.shop.commission.currency = 'coins'
  assert.deepEqual(parseCatalog(JSON.stringify(c)).shop!.commission, { currency: 'coins' })
  const off = clone()
  delete off.shop.commission
  assert.equal(parseCatalog(JSON.stringify(off)).shop!.commission, null)
})

test('a round reward grants something with declared currencies only', () => {
  refused(c => { c.round_rewards.win = { coins: 0, currencies: {} } }, /round_rewards\.win grants nothing/)
  refused(c => { c.round_rewards.win.currencies.rubies = 1 }, /round_rewards\.win\.currencies\.rubies/)
  refused(c => { c.round_rewards.win.currencies.coins = 5 }, /round_rewards\.win\.currencies\.coins/)
  refused(c => { c.round_rewards.win.currencies.tickets = -1 }, /round_rewards\.win\.currencies\.tickets/)
  refused(c => { c.round_rewards.win.coins = -1 }, /round_rewards\.win\.coins/)
  const c = clone()
  c.round_rewards.loss = { coins: 5, currencies: {} }
  assert.deepEqual(parseCatalog(JSON.stringify(c)).round_rewards!.loss, { coins: 5, currencies: {} })
})

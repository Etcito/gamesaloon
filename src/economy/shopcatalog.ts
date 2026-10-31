// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Optional catalog sections: extra currencies, the cosmetic shop and the per-round rewards. Every name
// (slots, rarities, currencies, drops) is data the game declares; the parsers only check the rules.
// A refusal names the faulty path and, for an item, its id (QB7).

import type { RoundReward, ShopDef, ShopItem } from './types.ts'

const ID_RE = /^[A-Za-z0-9:_.-]{1,64}$/
const MAX_ITEMS = 10_000
const MAX_PRICE = 1_000_000

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, min: number, max = MAX_PRICE): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max

function parseCurrencies(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error('currencies must be a list of currency names')
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const name = raw[i]
    if (typeof name !== 'string' || !ID_RE.test(name)) throw new Error(`currencies[${i}] must be a currency name`)
    if (name === 'coins') throw new Error(`currencies[${i}]: coins is built in and must not be declared`)
    if (out.includes(name)) throw new Error(`currencies[${i}]: duplicate currency ${name}`)
    out.push(name)
  }
  return out
}

function parseNames(raw: unknown, path: string, what: string): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) throw new Error(`${path} must be a list of ${what} names`)
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const name = raw[i]
    if (typeof name !== 'string' || !ID_RE.test(name)) throw new Error(`${path}[${i}] must be a ${what} name`)
    if (out.includes(name)) throw new Error(`${path}[${i}]: duplicate ${what} ${name}`)
    out.push(name)
  }
  return out
}

function parsePrices(raw: unknown, path: string, allowed: ReadonlySet<string>): Record<string, number> {
  if (!isObj(raw)) throw new Error(`${path} must be an object {"<currency>": price}`)
  const out: Record<string, number> = {}
  for (const [currency, value] of Object.entries(raw)) {
    if (!allowed.has(currency)) throw new Error(`${path}.${currency}: unknown currency`)
    if (!isInt(value, 0)) throw new Error(`${path}.${currency} must be an integer in 0..${MAX_PRICE}`)
    out[currency] = value
  }
  return out
}

function parseShop(raw: unknown, currencies: readonly string[], cardIds: ReadonlySet<string> = new Set()): ShopDef {
  if (!isObj(raw)) throw new Error('shop must be an object')
  if (typeof raw.drop !== 'string' || !ID_RE.test(raw.drop)) throw new Error('shop.drop must be a drop id')
  const slots = parseNames(raw.slots, 'shop.slots', 'slot')
  if (!isObj(raw.rarities) || Object.keys(raw.rarities).length < 1 || Object.keys(raw.rarities).length > 64) {
    throw new Error('shop.rarities must be an object {"<rarity>": {"price": {...}}}')
  }
  const allowed = new Set<string>(['coins', ...currencies])
  const rarities: ShopDef['rarities'] = {}
  for (const [name, def] of Object.entries(raw.rarities)) {
    if (!ID_RE.test(name)) throw new Error(`shop.rarities: bad rarity name "${name}"`)
    if (!isObj(def)) throw new Error(`shop.rarities.${name} must be an object`)
    rarities[name] = { price: parsePrices(def.price ?? {}, `shop.rarities.${name}.price`, allowed) }
  }
  if (!Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) throw new Error('shop.items must be a list')
  const items: ShopItem[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.items.length; i++) {
    const o = raw.items[i]
    if (!isObj(o) || typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new Error(`shop.items[${i}].id must be an item id`)
    const id = o.id
    const where = `shop.items[${id}]`
    if (seen.has(id)) throw new Error(`${where}.id is declared twice`)
    if (cardIds.has(id)) throw new Error(`${where}.id must not collide with a card id`)
    seen.add(id)
    if (typeof o.name !== 'string' || o.name.trim() === '') throw new Error(`${where}.name must be a non-empty string`)
    if (typeof o.slot !== 'string' || !slots.includes(o.slot)) throw new Error(`${where}.slot must be one of shop.slots`)
    if (typeof o.rarity !== 'string' || !Object.hasOwn(rarities, o.rarity)) throw new Error(`${where}.rarity must be one of shop.rarities`)
    if (typeof o.asset !== 'string' || o.asset.trim() === '') throw new Error(`${where}.asset must be a non-empty string`)
    const price = parsePrices(o.price, `${where}.price`, allowed)
    if (Object.keys(price).length === 0) throw new Error(`${where}.price must price at least one currency`)
    const rarityPrice = rarities[o.rarity]!.price
    for (const [currency, value] of Object.entries(price)) {
      if (Object.hasOwn(rarityPrice, currency) && rarityPrice[currency] !== value) {
        throw new Error(`${where}.price.${currency} must equal shop.rarities.${o.rarity}.price.${currency}`)
      }
    }
    let editionCap: number | null = null
    if (o.edition_cap !== undefined && o.edition_cap !== null) {
      if (!isInt(o.edition_cap, 1)) throw new Error(`${where}.edition_cap must be a positive integer`)
      editionCap = o.edition_cap
    }
    items.push({ id, name: o.name, slot: o.slot, rarity: o.rarity, asset: o.asset, price, edition_cap: editionCap })
  }
  let commission: ShopDef['commission'] = null
  if (raw.commission !== undefined && raw.commission !== null) {
    if (!isObj(raw.commission) || typeof raw.commission.currency !== 'string' || !allowed.has(raw.commission.currency)) {
      throw new Error('shop.commission.currency must be coins or a declared currency')
    }
    const currency = raw.commission.currency
    for (const rarity of Object.keys(rarities)) {
      if (!Object.hasOwn(rarities[rarity]!.price, currency)) {
        throw new Error(`shop.commission.currency: shop.rarities.${rarity}.price.${currency} is missing`)
      }
    }
    commission = { currency }
  }
  return { drop: raw.drop, slots, rarities, items, commission }
}

function parseRoundRewards(raw: unknown, currencies: readonly string[]): Record<string, RoundReward> {
  if (!isObj(raw)) throw new Error('round_rewards must be an object {"<round kind>": {...}}')
  const declared = new Set(currencies)
  const out: Record<string, RoundReward> = {}
  for (const [kind, def] of Object.entries(raw)) {
    const path = `round_rewards.${kind}`
    if (!ID_RE.test(kind)) throw new Error(`round_rewards: bad round kind "${kind}"`)
    if (!isObj(def)) throw new Error(`${path} must be an object`)
    const coins = def.coins ?? 0
    if (!isInt(coins, 0, 1_000_000)) throw new Error(`${path}.coins must be a non-negative integer`)
    const rawCurrencies = def.currencies ?? {}
    if (!isObj(rawCurrencies)) throw new Error(`${path}.currencies must be an object {"<currency>": amount}`)
    const granted: Record<string, number> = {}
    for (const [currency, amount] of Object.entries(rawCurrencies)) {
      if (!declared.has(currency)) throw new Error(`${path}.currencies.${currency}: unknown currency`)
      if (!isInt(amount, 0, 1_000_000)) throw new Error(`${path}.currencies.${currency} must be a non-negative integer`)
      if (amount > 0) granted[currency] = amount
    }
    if (coins === 0 && Object.keys(granted).length === 0) throw new Error(`${path} grants nothing`)
    out[kind] = { coins, currencies: granted }
  }
  return out
}

export { parseCurrencies, parseShop, parseRoundRewards }

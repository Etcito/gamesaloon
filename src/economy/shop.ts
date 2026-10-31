// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The cosmetic shop of the catalog: what is on sale (with the copies left of capped items) and the purchase.
//
// A purchase is ONE ledger commit (op `eco.shop`): the price leaves the wallet or the currency balance and the item
// lands in etc_cards. A capped item also writes its edition `<item>#<serial>` in the ledger row's unique edition_key,
// so the hard cap is enforced by the same insert that commits the purchase: two buyers of one serial cannot both
// commit, the loser builds again with the next serial, and a serial above the cap is refused `sold_out`.
// etc_item_sales is a projection of those serials (never lowered); the ledger stays the source of truth.

import { StoreError } from '../store/errors.ts'
import type { StoreErrorCode } from '../store/errors.ts'
import type { Filter, Row, TableApi } from '../store/tables.ts'
import type { EconomyLedger } from './ledger.ts'
import type { Catalog, EconomyState, Fx, ShopDef, ShopItem } from './types.ts'

const PAGE = 500
/** Edition keys looked up per ledger query when counting the committed copies of an item. */
const PROBE = 50
const T = { sales: 'etc_item_sales', ledger: 'etc_ledger' }

export interface ShopItemView extends ShopItem { sold: number; remaining: number | null }
export interface ShopView { drop: string; slots: string[]; rarities: ShopDef['rarities']; items: ShopItemView[] }
export interface ShopBuyResult {
  item: string
  currency: string
  price: number
  coins: number
  balances: Record<string, number>
  remaining: number | null
}

export interface Shop {
  /** The catalogue with the copies sold and left of each item. `economy_unavailable` when the catalog has no shop. */
  view(): Promise<ShopView>
  /** Buys one copy of an item in one of its currencies. A replay of the op answers the stored result, applied:false. */
  buy(playerId: string, opId: string, itemId: string, currency: string): Promise<ShopBuyResult & { applied: boolean }>
}

/** Shop refusals. The store's code union predates them; the routes forward `code` as the refusal reason. */
type ShopRefusal = 'economy_unavailable' | 'unknown_item' | 'no_price' | 'already_owned' | 'insufficient_funds' | 'sold_out'
const refuse = (code: ShopRefusal, message: string): StoreError => new StoreError(code as StoreErrorCode, message)

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function arg(value: unknown, name: string, max = 64): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new StoreError('bad_argument', `Invalid ${name}`)
}

const editionKey = (itemId: string, serial: number): string => `${itemId}#${serial}`
const serialOf = (itemId: string, key: unknown): number =>
  typeof key === 'string' && key.startsWith(`${itemId}#`) ? num(key.slice(itemId.length + 1)) : 0

export function createShop(opts: {
  api: TableApi
  ledger: EconomyLedger
  catalog: () => Catalog
  now?: () => number
}): Shop {
  const { api, ledger } = opts
  const now = opts.now ?? Date.now
  const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })
  const one = async (table: string, filters: Filter[]): Promise<Row | undefined> => (await api.query(table, { filters, size: 1 }))[0]

  function shopOf(catalog: Catalog): ShopDef {
    if (!catalog.shop) throw refuse('economy_unavailable', 'The catalog has no shop')
    return catalog.shop
  }

  /** Raises etc_item_sales.sold to `sold` (never lowers it) and keeps the catalogue cap. The re-read after each write
   *  catches a concurrent writer of a lower count landing over ours. */
  async function recordSold(item: ShopItem, sold: number): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await one(T.sales, [eq('item_id', item.id)])
      if (!row) {
        const made = await api.insert(T.sales, { item_id: item.id, sold, cap: item.edition_cap, updated_at: now() })
        if (made !== 'conflict') return
        continue
      }
      if (num(row.sold) >= sold && (row.cap ?? null) === item.edition_cap) return
      await api.update(T.sales, row.id as number, { sold: Math.max(num(row.sold), sold), cap: item.edition_cap, updated_at: now() })
    }
  }

  /** One more copy of an uncapped item. Informational only (nothing is enforced on it): a crash or a race may miss one. */
  async function countSale(item: ShopItem): Promise<void> {
    const row = await one(T.sales, [eq('item_id', item.id)])
    if (row) return api.update(T.sales, row.id as number, { sold: num(row.sold) + 1, cap: item.edition_cap, updated_at: now() })
    if (await api.insert(T.sales, { item_id: item.id, sold: 1, cap: item.edition_cap, updated_at: now() }) === 'conflict') return countSale(item)
  }

  /** The highest committed serial of a capped item: the sales row, then the ledger editions above it (the row lags
   *  after a crash between commit and projection, or behind a concurrent buyer). A lagging row is repaired. */
  async function committedSerial(item: ShopItem, cap: number): Promise<number> {
    const recorded = num((await one(T.sales, [eq('item_id', item.id)]))?.sold)
    let top = recorded
    for (let from = recorded + 1; from <= cap; from += PROBE) {
      const keys: string[] = []
      for (let s = from; s < from + PROBE && s <= cap; s++) keys.push(editionKey(item.id, s))
      const rows = await api.query(T.ledger, { filters: [{ field: 'edition_key', op: 'in', values: keys }], size: keys.length })
      for (const r of rows) top = Math.max(top, serialOf(item.id, r.edition_key))
      if (rows.length < keys.length) break
    }
    if (top > recorded) await recordSold(item, top)
    return top
  }

  return {
    async view() {
      const shop = shopOf(opts.catalog())
      const sold = new Map<string, number>()
      for (let page = 1; ; page++) {
        const rows = await api.query(T.sales, { page, size: PAGE })
        for (const r of rows) sold.set(r.item_id as string, num(r.sold))
        if (rows.length < PAGE) break
      }
      return {
        drop: shop.drop, slots: [...shop.slots], rarities: shop.rarities,
        items: shop.items.map(i => {
          const n = sold.get(i.id) ?? 0
          return { ...i, price: { ...i.price }, sold: n, remaining: i.edition_cap === null ? null : Math.max(0, i.edition_cap - n) }
        }),
      }
    },

    async buy(playerId, opId, itemId, currency) {
      arg(opId, 'operation id'); arg(itemId, 'item id'); arg(currency, 'currency')
      const catalog = opts.catalog()
      let item: ShopItem | undefined
      let serial = 0   // the serial of the last build; a conflict on it means it is taken, so the next build goes above
      const txId = `c:${playerId}:${opId}`
      const build = async (state: EconomyState): Promise<{ fx: Fx; result: ShopBuyResult }> => {
        const found = shopOf(catalog).items.find(i => i.id === itemId)
        if (!found) throw refuse('unknown_item', 'Unknown item')
        item = found
        const price = found.price[currency]
        if (price === undefined) throw refuse('no_price', `The item has no price in ${currency}`)
        if ((state.cards[itemId] ?? 0) >= 1) throw refuse('already_owned', 'The item is already owned')
        const inCoins = currency === 'coins'
        const funds = inCoins ? state.coins : (state.balances?.[currency] ?? 0)
        if (funds < price) throw refuse('insufficient_funds', 'Insufficient funds')
        const cap = found.edition_cap
        if (cap !== null) {
          serial = Math.max(await committedSerial(found, cap), serial) + 1
          if (serial > cap) throw refuse('sold_out', 'Sold out')
        }
        const balances = { ...(state.balances ?? {}) }
        if (!inCoins) balances[currency] = funds - price
        return {
          fx: { coins: inCoins ? -price : 0, packs: {}, cards: { [itemId]: 1 }, ...(inCoins ? {} : { currencies: { [currency]: -price } }) },
          result: {
            item: itemId, currency, price, coins: inCoins ? state.coins - price : state.coins, balances,
            remaining: cap === null ? null : cap - serial,
          },
        }
      }
      const out = await ledger.commit(playerId, txId, 'eco.shop', [itemId, currency], build, {
        editionKey: () => (item && item.edition_cap !== null ? editionKey(item.id, serial) : null),
      })
      // Project the sale. A replay repairs a projection a crash may have skipped (raising to a serial never counts twice).
      const sold = catalog.shop?.items.find(i => i.id === itemId)
      if (sold && sold.edition_cap === null) {
        if (out.applied) await countSale(sold)
      } else if (sold) {
        const committed = out.applied ? serial : serialOf(itemId, (await one(T.ledger, [eq('tx_id', txId)]))?.edition_key)
        if (committed > 0) await recordSold(sold, committed)
      }
      return { ...out.result, applied: out.applied }
    },
  }
}

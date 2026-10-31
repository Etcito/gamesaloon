// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Custom commissions: the player pays the rarity price and describes a cosmetic; the queue of what is not shipped
// is the input of the next shop drop. The spend is ONE ledger commit (`eco.commission`) and the etc_commissions row
// is inserted after it, insert-or-read by tx_id, so a replay answers the same commission with `applied: false`.

import { randomBytes } from 'node:crypto'
import { StoreError } from '../store/errors.ts'
import type { StoreErrorCode } from '../store/errors.ts'
import type { Filter, Row, TableApi, TableQuery } from '../store/tables.ts'
import { checkText } from './filter.ts'
import type { FilterSettings } from './gameconfig.ts'
import type { EconomyLedger } from './ledger.ts'
import type { Catalog } from './types.ts'

const PAGE = 500
const T = { commissions: 'etc_commissions' }

export type CommissionStatus = 'pending' | 'in_production' | 'shipped'

export interface Commission {
  id: string
  slot: string
  rarity: string
  description: string
  status: CommissionStatus
  created_at: number
}

export interface CommissionResult extends Commission { applied: boolean }

export interface Commissions {
  /** Buys one custom commission; a replay of the same op answers the stored commission with `applied: false`. */
  commission(playerId: string, opId: string, slot: string, rarity: string, description: string): Promise<CommissionResult>
  /** The player's commissions, newest first. */
  mine(playerId: string): Promise<Commission[]>
  /** Every commission of the next drop (not shipped), oldest first, without its player id. */
  queue(): Promise<Commission[]>
}

export interface CommissionsDeps {
  api: TableApi
  ledger: EconomyLedger
  catalog: () => Catalog
  filter: () => Promise<FilterSettings | null>
  now?: () => number
}

// The store's code union predates the economy refusals; the routes forward `code` as the refusal reason.
type CommissionRefusal = 'economy_unavailable' | 'description_refused' | 'bad_argument' | 'insufficient_funds'
const refuse = (code: CommissionRefusal, message: string): StoreError => new StoreError(code as StoreErrorCode, message)

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function arg(value: unknown, name: string, max = 128): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new StoreError('bad_argument', `Invalid ${name}`)
}

const STATUSES: readonly CommissionStatus[] = ['pending', 'in_production', 'shipped']
const statusOf = (v: unknown): CommissionStatus => (typeof v === 'string' && (STATUSES as readonly string[]).includes(v) ? v as CommissionStatus : 'pending')

const newCommissionId = (): string => `cm_${randomBytes(8).toString('hex')}`

export function createCommissions(opts: CommissionsDeps): Commissions {
  const { api, ledger } = opts
  const now = opts.now ?? Date.now
  const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })
  const one = async (table: string, filters: Filter[]): Promise<Row | undefined> => (await api.query(table, { filters, size: 1 }))[0]

  async function all(filters: Filter[], sort?: TableQuery['sort']): Promise<Row[]> {
    const out: Row[] = []
    for (let page = 1; ; page++) {
      const rows = await api.query(T.commissions, { filters, sort, page, size: PAGE })
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  function view(row: Row): Commission {
    return {
      id: String(row.commission_id),
      slot: String(row.slot),
      rarity: String(row.rarity),
      description: typeof row.description === 'string' ? row.description : '',
      status: statusOf(row.status),
      created_at: num(row.created_at),
    }
  }

  /** Insert-or-read keyed by tx_id: a replay never creates a second commission. */
  async function record(row: Row): Promise<Row> {
    const made = await api.insert(T.commissions, row)
    if (made !== 'conflict') return made.row
    const found = await one(T.commissions, [eq('tx_id', row.tx_id)])
    if (!found) throw new Error('commission conflict without a tx row')
    return found
  }

  return {
    async commission(playerId, opId, slot, rarity, description) {
      arg(playerId, 'player id'); arg(opId, 'operation id', 64)
      if (typeof description !== 'string' || description.length > 10_000) throw refuse('bad_argument', 'Invalid description')
      const shop = opts.catalog().shop
      if (!shop || !shop.commission) throw refuse('economy_unavailable', 'The catalog has no commission shop')
      if (typeof slot !== 'string' || !shop.slots.includes(slot)) throw refuse('bad_argument', 'Invalid slot')
      if (typeof rarity !== 'string' || !Object.hasOwn(shop.rarities, rarity)) throw refuse('bad_argument', 'Invalid rarity')
      const settings = await opts.filter()
      if (settings !== null) {
        const reason = checkText(description, settings)
        if (reason !== null) throw refuse('description_refused', reason)
      }

      const trimmed = description.trim()
      const currency = shop.commission.currency
      const txId = `cm:${playerId}:${opId}`
      const { result, applied } = await ledger.commit(playerId, txId, 'eco.commission', [slot, rarity, trimmed], state => {
        const price = shop.rarities[rarity]!.price[currency]
        if (price === undefined) throw refuse('economy_unavailable', 'The commission price is not configured')
        const inCoins = currency === 'coins'
        const funds = inCoins ? state.coins : (state.balances?.[currency] ?? 0)
        if (funds < price) throw refuse('insufficient_funds', 'Insufficient funds')
        return {
          fx: {
            coins: inCoins ? -price : 0, packs: {}, cards: {},
            ...(inCoins ? {} : { currencies: { [currency]: -price } }),
          },
          result: {
            id: newCommissionId(), slot, rarity, description: trimmed,
            status: 'pending' as const, created_at: now(),
          },
        }
      })
      const row = await record({
        commission_id: result.id, tx_id: txId, player_id: playerId,
        slot: result.slot, rarity: result.rarity, description: result.description,
        status: result.status, created_at: result.created_at,
      })
      return { ...view(row), applied }
    },

    async mine(playerId) {
      arg(playerId, 'player id')
      const rows = await all([eq('player_id', playerId)], [
        { field: 'created_at', dir: 'desc' },
        { field: 'id', dir: 'desc' },
      ])
      return rows.map(view)
    },

    async queue() {
      const rows = await all([], [
        { field: 'created_at', dir: 'asc' },
        { field: 'id', dir: 'asc' },
      ])
      return rows.filter(r => statusOf(r.status) !== 'shipped').map(view)
    },
  }
}

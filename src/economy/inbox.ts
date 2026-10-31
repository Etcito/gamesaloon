// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Player inbox: entries the operator inserts in the backoffice, or a gift delivers. Claiming an entry
// is ONE ledger commit (`cl:<entry_id>`), so a replay never grants the same item twice.

import { StoreError } from '../store/errors.ts'
import type { StoreErrorCode } from '../store/errors.ts'
import type { Filter, Row, TableApi, TableQuery } from '../store/tables.ts'
import type { EconomyLedger } from './ledger.ts'
import type { Catalog } from './types.ts'

export type InboxSenderKind = 'owner' | 'system' | 'player'

/** One visible row of the player's inbox. */
export interface InboxEntry {
  id: string
  item: string | null
  sender: { kind: InboxSenderKind; id: string | null }
  message: string
  /** ISO date of `created_at`. */
  date: string
  claimed: boolean
}

/** A row delivered by a gift (or any other internal producer), keyed by `source_tx`. */
export interface InboxDelivery {
  entry_id: string
  player_id: string
  item_id?: string | null
  sender_kind: InboxSenderKind
  sender_id?: string | null
  message?: string
  created_at?: number
  source_tx: string
}

export interface ClaimResult { id: string; item: string | null; applied: boolean }

export interface Inbox {
  /** The player's entries, newest first. */
  list(playerId: string): Promise<InboxEntry[]>
  /** Internal insert-or-read by `source_tx`: delivering the same fact twice returns the first row. */
  deliver(row: InboxDelivery): Promise<Row>
  /** Claims one entry into the collection (or grants nothing for a message-only entry). */
  claim(playerId: string, opId: string, entryId: string): Promise<ClaimResult>
  /** Number of entries not claimed yet. */
  unread(playerId: string): Promise<number>
}

export interface InboxDeps {
  api: TableApi
  ledger: EconomyLedger
  catalog: () => Catalog
  now?: () => number
}

const T = { inbox: 'etc_inbox' }
const PAGE = 500

type InboxErrorCode = 'not_found' | 'already_claimed' | 'already_owned'

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function arg(value: unknown, name: string, max = 128): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new StoreError('bad_argument', `Invalid ${name}`)
}

// `already_owned` / `already_claimed` are the economy refusal codes; the store union catches up later.
const refuse = (code: InboxErrorCode, message: string): never => {
  throw new StoreError(code as StoreErrorCode, message)
}

export function createInbox(deps: InboxDeps): Inbox {
  const { api, ledger } = deps
  const now = deps.now ?? Date.now

  const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })

  async function all(table: string, filters: Filter[], sort?: TableQuery['sort']): Promise<Row[]> {
    const out: Row[] = []
    for (let page = 1; ; page++) {
      const rows = await api.query(table, { filters, sort, page, size: PAGE })
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  const one = async (table: string, filters: Filter[]) => (await api.query(table, { filters, size: 1 }))[0]

  function view(row: Row): InboxEntry {
    return {
      id: String(row.entry_id),
      item: row.item_id == null ? null : String(row.item_id),
      sender: {
        kind: row.sender_kind as InboxSenderKind,
        id: row.sender_id == null ? null : String(row.sender_id),
      },
      message: typeof row.message === 'string' ? row.message : '',
      date: new Date(num(row.created_at)).toISOString(),
      claimed: row.claimed_at != null,
    }
  }

  return {
    async list(playerId) {
      arg(playerId, 'player id')
      const rows = await all(T.inbox, [eq('player_id', playerId)], [
        { field: 'created_at', dir: 'desc' },
        { field: 'id', dir: 'desc' },
      ])
      return rows.map(view)
    },

    async deliver(delivery) {
      arg(delivery.entry_id, 'entry id', 96)
      arg(delivery.player_id, 'player id')
      arg(delivery.source_tx, 'source transaction id', 200)
      const made = await api.insert(T.inbox, {
        entry_id: delivery.entry_id,
        player_id: delivery.player_id,
        item_id: delivery.item_id ?? null,
        sender_kind: delivery.sender_kind,
        sender_id: delivery.sender_id ?? null,
        message: delivery.message ?? '',
        created_at: delivery.created_at ?? now(),
        claimed_at: null,
        source_tx: delivery.source_tx,
      })
      if (made !== 'conflict') return made.row
      const found = await one(T.inbox, [eq('source_tx', delivery.source_tx)])
      if (!found) throw new Error('inbox delivery conflict without a source row')
      return found
    },

    async claim(playerId, opId, entryId) {
      arg(playerId, 'player id')
      arg(opId, 'operation id', 64)
      arg(entryId, 'entry id', 96)

      const entry = await one(T.inbox, [eq('entry_id', entryId)])
      if (!entry || entry.player_id !== playerId) refuse('not_found', 'Inbox entry not found')
      if (entry.claimed_at != null) refuse('already_claimed', 'Inbox entry already claimed')

      const item = entry.item_id == null ? null : String(entry.item_id)
      const done = await ledger.commit(playerId, `cl:${entryId}`, 'eco.claim', [entryId], state => {
        if (item !== null && (state.cards[item] ?? 0) >= 1) refuse('already_owned', 'Item already owned')
        return {
          fx: { coins: 0, packs: {}, cards: item === null ? {} : { [item]: 1 } },
          result: { id: entryId, item },
        }
      })

      if (entry.claimed_at == null) await api.update(T.inbox, entry.id as number, { claimed_at: now() })
      return { id: done.result.id, item: done.result.item, applied: done.applied }
    },

    async unread(playerId) {
      arg(playerId, 'player id')
      const rows = await all(T.inbox, [eq('player_id', playerId), { field: 'claimed_at', op: 'is_null' }])
      return rows.length
    },
  }
}

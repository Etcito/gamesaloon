// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { randomUUID } from 'node:crypto'
import { StoreError } from '../store/errors.ts'
import type { StoreErrorCode } from '../store/errors.ts'
import type { Filter, TableApi } from '../store/tables.ts'
import type { PlayerStore } from '../store/types.ts'
import type { GiftSettings } from './gameconfig.ts'
import type { Inbox } from './inbox.ts'
import type { EconomyLedger } from './ledger.ts'
import { createKeyedLock } from './lock.ts'

export interface GiftResult { to: string; item: string; applied: boolean }

export interface Gifts {
  gift(senderId: string, opId: string, toWavedashUserId: string, itemId: string, message: string): Promise<GiftResult>
  block(playerId: string, otherWavedashUserId: string, blocked: boolean): Promise<void>
}

export interface GiftsDeps {
  api: TableApi
  ledger: EconomyLedger
  inbox: Inbox
  store: PlayerStore
  gifts: () => Promise<GiftSettings | null>
  now?: () => number
}

function arg(value: unknown, name: string, max = 128): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new StoreError('bad_argument', `Invalid ${name}`)
}

// As in inbox, economy-specific refusal codes precede their addition to the store union.
function refuse(code: 'not_found' | 'self_gift' | 'blocked' | 'rate_limited' | 'not_owned', message: string): never {
  throw new StoreError(code as StoreErrorCode, message)
}

export function createGifts(deps: GiftsDeps): Gifts {
  const { api, ledger, inbox, store } = deps
  const now = deps.now ?? Date.now
  const locked = createKeyedLock()
  const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })
  const one = async (table: string, filters: Filter[]) => (await api.query(table, { filters, size: 1 }))[0]

  async function recipient(externalId: string): Promise<string> {
    // Resolve without getOrCreateByIdentity: an unknown recipient must never create a player.
    const identity = await one('etc_identities', [eq('ident_key', `wavedash\u001f${externalId}`)])
    if (!identity || typeof identity.player_id !== 'string' || !await store.getPlayer(identity.player_id)) {
      refuse('not_found', 'Player not found')
    }
    return identity.player_id
  }

  async function checkLimit(senderId: string, at: number): Promise<void> {
    const settings = await deps.gifts()
    if (!settings) return
    let count = 0
    for (let page = 1; ; page++) {
      const rows = await api.query('etc_gifts', {
        filters: [eq('from_player', senderId), { field: 'created_at', op: 'gt', value: at - settings.window_ms },
          { field: 'created_at', op: 'lte', value: at }],
        page, size: 500,
      })
      count += rows.length
      if (count >= settings.count) refuse('rate_limited', 'Gift limit reached')
      if (rows.length < 500) return
    }
  }

  return {
    async gift(senderId, opId, to, item, message) {
      arg(senderId, 'player id')
      arg(opId, 'operation id', 64)
      arg(to, 'recipient id', 256)
      arg(item, 'item id')
      if (typeof message !== 'string' || message.length > 280) throw new StoreError('bad_argument', 'Invalid message')

      // Keep the gift row insertion inside the sender lock so the next call sees it in its limit.
      return locked([senderId], async () => {
        const txId = `c:${senderId}:${opId}`
        const done = await ledger.commit(senderId, txId, 'eco.gift', [to, item, message], async state => {
          const toPlayer = await recipient(to)
          if (toPlayer === senderId) refuse('self_gift', 'Cannot gift to yourself')
          const block = await one('etc_blocks', [eq('block_key', `${toPlayer}|${senderId}`)])
          if (block?.active === true || block?.active === 1) refuse('blocked', 'Gifts from this player are blocked')
          const createdAt = now()
          await checkLimit(senderId, createdAt)
          if ((state.cards[item] ?? 0) < 1) refuse('not_owned', 'Item not owned')
          const sender = await store.getPlayer(senderId)
          const senderUserId = sender?.identities.find(i => i.provider === 'wavedash')?.external_id
          if (!senderUserId) refuse('not_found', 'Sender identity not found')
          return {
            fx: { coins: 0, packs: {}, cards: { [item]: -1 } },
            result: { toPlayer, senderUserId, createdAt, entryId: randomUUID() },
          }
        })

        // These projections run on replays too, repairing a failure after the ledger commit.
        const saved = done.result
        const made = await api.insert('etc_gifts', {
          tx_id: txId, from_player: senderId, to_player: saved.toPlayer, item_id: item, created_at: saved.createdAt,
        })
        if (made === 'conflict' && !await one('etc_gifts', [eq('tx_id', txId)])) {
          throw new Error('gift conflict without a transaction row')
        }
        await inbox.deliver({
          entry_id: saved.entryId, player_id: saved.toPlayer, item_id: item, sender_kind: 'player',
          sender_id: saved.senderUserId, message, source_tx: txId, created_at: saved.createdAt,
        })
        return { to, item, applied: done.applied }
      })
    },

    async block(playerId, otherWavedashUserId, blocked) {
      arg(playerId, 'player id')
      arg(otherWavedashUserId, 'blocked user id', 256)
      if (typeof blocked !== 'boolean') throw new StoreError('bad_argument', 'Invalid blocked flag')
      const other = await recipient(otherWavedashUserId)
      const key = `${playerId}|${other}`
      const patch = { active: blocked, updated_at: now() }
      const made = await api.insert('etc_blocks', { block_key: key, player_id: playerId, blocked_id: other, ...patch })
      if (made === 'conflict') {
        const row = await one('etc_blocks', [eq('block_key', key)])
        if (!row) throw new Error('block conflict without a row')
        await api.update('etc_blocks', row.id as number, patch)
      }
    },
  }
}

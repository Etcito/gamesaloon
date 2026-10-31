// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryTableApi, ETCITO_TABLES } from '../src/store/tables.ts'
import type { Row } from '../src/store/tables.ts'

const ledger = (tx_id: string, edition_key: unknown): Row => ({ tx_id, player_id: 'p1', op: 'reward', edition_key })

test('etc_ledger: a non-null edition_key is unique, null never conflicts', async () => {
  const api = createMemoryTableApi()
  assert.notEqual(await api.insert('etc_ledger', ledger('tx-1', 'season1:ed1')), 'conflict')
  assert.equal(await api.insert('etc_ledger', ledger('tx-2', 'season1:ed1')), 'conflict')
  assert.notEqual(await api.insert('etc_ledger', ledger('tx-3', null)), 'conflict')
  assert.notEqual(await api.insert('etc_ledger', ledger('tx-4', null)), 'conflict')
  assert.equal(api.rows('etc_ledger').length, 3)
})

test('generic economy tables: declared, known to the memory API, unique sets enforced', async () => {
  const api = createMemoryTableApi()
  const rows: Record<string, Row> = {
    etc_balances: { player_id: 'p1', currency: 'gems', quantity: 3, ledger_id: 1, updated_at: 1 },
    etc_item_sales: { item_id: 'i1', sold: 1, cap: 10, updated_at: 1 },
    etc_commissions: { commission_id: 'c1', tx_id: 'tx-c1', player_id: 'p1', slot: 'weapon', rarity: 'rare', description: 'd', status: 'open', created_at: 1, updated_at: 1 },
    etc_inbox: { entry_id: 'e1', player_id: 'p1', item_id: 'i1', sender_kind: 'system', sender_id: '', message: 'm', created_at: 1, claimed_at: null, source_tx: 'tx-e1' },
    etc_gifts: { tx_id: 'tx-g1', from_player: 'p1', to_player: 'p2', item_id: 'i1', created_at: 1 },
    etc_blocks: { block_key: 'p1|p2', player_id: 'p1', blocked_id: 'p2', active: true, updated_at: 1 },
    etc_round_hosts: { match_id: 'm1', player_id: 'p1', created_at: 1 },
  }
  for (const [table, row] of Object.entries(rows)) {
    assert.ok(ETCITO_TABLES[table], `${table} declared`)
    assert.notEqual(await api.insert(table, row), 'conflict', `${table} insert`)
    assert.equal(api.rows(table).length, 1, `${table} row stored`)
  }
  assert.equal(await api.insert('etc_balances', { ...rows.etc_balances, ledger_id: 2 }), 'conflict')
  assert.equal(await api.insert('etc_item_sales', { ...rows.etc_item_sales, sold: 2 }), 'conflict')
  assert.equal(await api.insert('etc_commissions', { ...rows.etc_commissions, commission_id: 'c2' }), 'conflict')
  assert.equal(await api.insert('etc_inbox', { ...rows.etc_inbox, entry_id: 'e2' }), 'conflict')
  assert.equal(await api.insert('etc_gifts', { ...rows.etc_gifts, from_player: 'p9' }), 'conflict')
  assert.equal(await api.insert('etc_blocks', { ...rows.etc_blocks, active: false }), 'conflict')
  assert.equal(await api.insert('etc_round_hosts', { ...rows.etc_round_hosts, player_id: 'p9' }), 'conflict')
})

test('etc_ledger: edition_key is a declared column', () => {
  assert.ok(ETCITO_TABLES.etc_ledger!.columns.includes('edition_key'))
  assert.deepEqual(ETCITO_TABLES.etc_ledger!.unique, [['tx_id'], ['edition_key']])
})

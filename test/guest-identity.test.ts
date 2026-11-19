// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The `guest` provider's per-game on/off switch (guests.enabled) and its per-IP auth/match_queue rate limit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { TableApi } from '../src/store/tables.ts'
import { createSettingsReader } from '../src/store/settings.ts'
import { GuestsDisabledError, guestVerifier } from '../src/guest.ts'
import { defaultVerifiers, verifyIdentityHook } from '../src/identity.ts'

async function settingsApi(rows: Record<string, string>): Promise<TableApi> {
  const api = createMemoryTableApi()
  for (const [key, value] of Object.entries(rows)) await api.insert('etc_settings', { key, value })
  return api
}

async function verifierWith(rows: Record<string, string> | null) {
  if (rows === null) return guestVerifier({ settings: () => null })
  const reader = createSettingsReader(await settingsApi(rows))
  return guestVerifier({ settings: () => reader })
}

test('guest: a missing row, or any value but 0/false, allows guests', async () => {
  const cases: (Record<string, string> | null)[] = [null, {}, { 'guests.enabled': '1' }, { 'guests.enabled': 'true' }, { 'guests.enabled': 'yes' }]
  for (const rows of cases) {
    const v = await verifierWith(rows)
    assert.ok(await v.verify('guest-token-aaaaaaaaaaaaaaaa', 'Ann', 'kekkai'), JSON.stringify(rows))
  }
})

test('guest: 0 or false refuses with GuestsDisabledError; a different game is unaffected', async () => {
  for (const off of ['0', 'false']) {
    const v = await verifierWith({ 'guests.enabled': off })
    await assert.rejects(v.verify('guest-token-aaaaaaaaaaaaaaaa', 'Ann', 'kekkai'), { name: 'GuestsDisabledError' })
  }
  // No reader for an unknown/other game: guests stay allowed there, even though the switch is wired for one game.
  const settings = (game: string | undefined) => (game === 'kekkai' ? { get: async () => '0' } : null)
  const v = guestVerifier({ settings })
  await assert.rejects(v.verify('guest-token-aaaaaaaaaaaaaaaa', 'Ann', 'kekkai'), GuestsDisabledError)
  assert.ok(await v.verify('guest-token-aaaaaaaaaaaaaaaa', 'Ann', 'other-game'))
})

// ---------------------------------------------------------------- integration through MatchService

class FakeConn {
  sent: Record<string, unknown>[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
  last(): Record<string, unknown> | undefined { return this.sent.at(-1) }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

function setup(rows: Record<string, string>, rateOpts: { guestRatePerSec?: number; guestRateBurst?: number } = {}) {
  const verifyIdentity = verifyIdentityHook(defaultVerifiers({
    guest: guestVerifier({ settings: () => ({ get: async (k: string) => rows[k] ?? null }) }),
  }))
  const deps = { now: () => 1_000_000, random: Math.random, log: () => {} }
  const service = new MatchService(deps, createMemoryStore(), { verifyIdentity }, rateOpts)
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const add = (ip: string | null = null) => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/', 'https://game.example', null, ip)
    return { conn, frame: (m: Record<string, unknown>) => hub.message(id, JSON.stringify(m)) }
  }
  return { add }
}

test('guest: guests.enabled off refuses auth with guests_disabled; a bot-free account auth is unaffected by the switch', async () => {
  const s = setup({ 'guests.enabled': '0' })
  const guest = s.add()
  guest.frame({ t: 'auth', provider: 'guest', token: 'guest-token-1-abcdefgh', game: 'kekkai' })
  await flush()
  assert.deepEqual(guest.conn.last(), { t: 'error', reason: 'guests_disabled' })
})

test('guest: guests.enabled on (or missing) lets a guest authenticate normally', async () => {
  const s = setup({})
  const guest = s.add()
  guest.frame({ t: 'auth', provider: 'guest', token: 'guest-token-1-abcdefgh', game: 'kekkai' })
  await flush()
  assert.equal(guest.conn.last()?.t, 'authed')
})

test('guest: a per-IP flood of auth attempts is rate limited; a different IP is unaffected', async () => {
  const s = setup({}, { guestRatePerSec: 1, guestRateBurst: 2 })
  const a1 = s.add('203.0.113.9')
  a1.frame({ t: 'auth', provider: 'guest', token: 'guest-token-flood-aaaaaaa1', game: 'kekkai' })
  await flush()
  assert.equal(a1.conn.last()?.t, 'authed')
  const a2 = s.add('203.0.113.9')
  a2.frame({ t: 'auth', provider: 'guest', token: 'guest-token-flood-aaaaaaa2', game: 'kekkai' })
  await flush()
  assert.equal(a2.conn.last()?.t, 'authed') // burst of 2 still allows the second attempt
  const a3 = s.add('203.0.113.9')
  a3.frame({ t: 'auth', provider: 'guest', token: 'guest-token-flood-aaaaaaa3', game: 'kekkai' })
  await flush()
  assert.deepEqual(a3.conn.last(), { t: 'error', reason: 'rate_limited' })
  // A different IP is a different bucket.
  const b1 = s.add('198.51.100.4')
  b1.frame({ t: 'auth', provider: 'guest', token: 'guest-token-flood-bbbbbbb1', game: 'kekkai' })
  await flush()
  assert.equal(b1.conn.last()?.t, 'authed')
  // No known IP (e.g. a resident seat): never limited.
  const c1 = s.add(null)
  c1.frame({ t: 'auth', provider: 'guest', token: 'guest-token-flood-ccccccc1', game: 'kekkai' })
  await flush()
  assert.equal(c1.conn.last()?.t, 'authed')
})

test('guest: match_queue by a guest is rate limited per IP too; a bot/account is never limited', async () => {
  const s = setup({}, { guestRatePerSec: 0, guestRateBurst: 1 })
  const guest = s.add('203.0.113.9')
  guest.frame({ t: 'auth', provider: 'guest', token: 'guest-token-queue-aaaaaa', game: 'kekkai' })
  await flush()
  assert.equal(guest.conn.last()?.t, 'authed') // the auth call already spent the one-token burst
  guest.frame({ t: 'match_queue', game: 'kekkai', queue: 'quick' })
  await flush()
  assert.deepEqual(guest.conn.last(), { t: 'error', reason: 'rate_limited' })
})

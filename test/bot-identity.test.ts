// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The `bot` provider: tokens and the on/off switch come from the game's etc_settings; a bot may queue ranked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { TableApi } from '../src/store/tables.ts'
import { createSettingsReader } from '../src/store/settings.ts'
import { botVerifier, parseBotTokens } from '../src/bot.ts'
import { defaultVerifiers, verifyIdentityHook } from '../src/identity.ts'
import { parseMatchMessage } from '../src/match/messages.ts'

const SECRET = 'correct-horse-battery-staple'
const hex = (s: string) => createHash('sha256').update(s).digest('hex')

async function settingsApi(rows: Record<string, string>): Promise<TableApi> {
  const api = createMemoryTableApi()
  for (const [key, value] of Object.entries(rows)) await api.insert('etc_settings', { key, value })
  return api
}

async function verifierWith(rows: Record<string, string>, logs: string[] = []) {
  const reader = createSettingsReader(await settingsApi(rows))
  return botVerifier({ settings: () => reader, log: (l, m) => { logs.push(`${l} ${m}`) } })
}

const ON = { 'bots.enabled': '1', 'bots.tokens': JSON.stringify({ RookBot: hex(SECRET) }) }

test('bot: the right token yields a bot identity named by the bot, display name from the auth message', async () => {
  const v = await verifierWith(ON)
  assert.deepEqual(await v.verify(`RookBot:${SECRET}`, '  Rook  the  Bot ', 'kekkai'),
    { provider: 'bot', external_id: 'RookBot', display_name: 'Rook the Bot' })
  // An invalid display name falls back to the bot name.
  assert.equal((await v.verify(`RookBot:${SECRET}`, 'x', 'kekkai'))?.display_name, 'RookBot')
  assert.equal((await v.verify(`RookBot:${SECRET}`, undefined, 'kekkai'))?.display_name, 'RookBot')
})

test('bot: wrong secret, unknown bot name, empty or malformed token are refused', async () => {
  const v = await verifierWith(ON)
  for (const token of [`RookBot:wrong`, `KnightBot:${SECRET}`, '', 'RookBot:', `:${SECRET}`, SECRET, `rookbot:${SECRET}`]) {
    assert.equal(await v.verify(token, 'Rook', 'kekkai'), null, token)
  }
})

test('bot: refused when bots.enabled is off or absent, even with the right token', async () => {
  for (const enabled of ['0', 'false', '', 'yes', undefined]) {
    const rows: Record<string, string> = { 'bots.tokens': ON['bots.tokens'] }
    if (enabled !== undefined) rows['bots.enabled'] = enabled
    const v = await verifierWith(rows)
    assert.equal(await v.verify(`RookBot:${SECRET}`, 'Rook', 'kekkai'), null, String(enabled))
  }
  assert.ok(await (await verifierWith({ ...ON, 'bots.enabled': 'true' })).verify(`RookBot:${SECRET}`, 'Rook', 'kekkai'))
})

test('bot: missing or invalid bots.tokens refuses, and the log never shows a token or a hash', async () => {
  const logs: string[] = []
  for (const tokens of [undefined, 'not json', '[]', '"x"']) {
    const rows: Record<string, string> = { 'bots.enabled': '1' }
    if (tokens !== undefined) rows['bots.tokens'] = tokens
    const v = await verifierWith(rows, logs)
    assert.equal(await v.verify(`RookBot:${SECRET}`, 'Rook', 'kekkai'), null)
  }
  const v = await verifierWith(ON, logs)
  await v.verify('RookBot:wrong', 'Rook', 'kekkai')
  assert.ok(logs.length > 0)
  for (const line of logs) {
    assert.ok(!line.includes(SECRET) && !line.includes(hex(SECRET)) && !line.includes('wrong'), line)
  }
})

test('bot: parseBotTokens drops invalid names and hashes', () => {
  const good = hex(SECRET)
  const map = parseBotTokens(JSON.stringify({ RookBot: good.toUpperCase(), ab: good, 'bad name': good, Short: 'abc', Num: 12 }))!
  assert.deepEqual([...map.keys()], ['RookBot'])
  assert.equal(parseBotTokens(null), null)
})

test('bot: a failed etc_settings read refuses; values are cached briefly', async () => {
  let reads = 0
  let fail = false
  const base = await settingsApi(ON)
  const api: TableApi = { ...base, async query(t, q) { reads++; if (fail) throw new Error('down'); return base.query(t, q) } }
  const clock = { t: 0 }
  const reader = createSettingsReader(api, { now: () => clock.t, ttlMs: 1000 })
  const v = botVerifier({ settings: () => reader })
  assert.ok(await v.verify(`RookBot:${SECRET}`, 'Rook', 'kekkai'))
  const after = reads
  assert.ok(await v.verify(`RookBot:${SECRET}`, 'Rook', 'kekkai'))
  assert.equal(reads, after, 'served from the cache')
  clock.t = 2000
  fail = true
  assert.equal(await v.verify(`RookBot:${SECRET}`, 'Rook', 'kekkai'), null)
  // Unknown game: no settings reader, refused.
  assert.equal(await botVerifier({ settings: () => null }).verify(`RookBot:${SECRET}`, 'Rook', 'x'), null)
})

test('bot: default verifiers refuse bot (auth_unavailable path); the auth message accepts provider bot', async () => {
  await assert.rejects(defaultVerifiers().bot.verify(`RookBot:${SECRET}`, 'Rook', 'kekkai'), { name: 'ProviderNotConfiguredError' })
  assert.deepEqual(parseMatchMessage({ t: 'auth', provider: 'bot', token: `RookBot:${SECRET}` }), { t: 'auth', provider: 'bot', token: `RookBot:${SECRET}` })
})

// ---------------------------------------------------------------- ranked gate through MatchService

class FakeConn {
  sent: Record<string, unknown>[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
  last(): Record<string, unknown> | undefined { return this.sent.at(-1) }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

async function setup(rows: Record<string, string>) {
  const reader = createSettingsReader(await settingsApi(rows))
  const verifyIdentity = verifyIdentityHook(defaultVerifiers({ bot: botVerifier({ settings: () => reader }) }))
  const deps = { now: () => 1_000_000, random: Math.random, log: () => {} }
  const service = new MatchService(deps, createMemoryStore(), { verifyIdentity }, { rankedRequireAccount: true })
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const add = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    return { conn, frame: (m: Record<string, unknown>) => hub.message(id, JSON.stringify(m)) }
  }
  return { add }
}

test('bot: a bot queues ranked and gets a ladder row; a guest still gets ranked_requires_account', async () => {
  const s = await setup(ON)
  const bot = s.add()
  bot.frame({ t: 'auth', provider: 'bot', token: `RookBot:${SECRET}`, name: 'Rook', game: 'kekkai' })
  await flush()
  assert.deepEqual({ ...bot.conn.last(), player_id: 'x' }, { t: 'authed', player_id: 'x', display_name: 'Rook', provider: 'bot' })
  bot.frame({ t: 'match_queue', game: 'kekkai', queue: 'ranked' })
  await flush()
  assert.equal(bot.conn.last()?.t, 'match_queued')
  assert.equal(bot.conn.last()?.queue, 'ranked')
  bot.frame({ t: 'ladder', page: 1 })
  await flush()
  assert.equal(bot.conn.last()?.t, 'ladder')
  assert.notEqual(bot.conn.last()?.me, null)

  const guest = s.add()
  guest.frame({ t: 'auth', provider: 'guest', token: 'guest-token-1-abcdefgh', game: 'kekkai' })
  await flush()
  guest.frame({ t: 'match_queue', game: 'kekkai', queue: 'ranked' })
  await flush()
  assert.deepEqual(guest.conn.last(), { t: 'error', reason: 'ranked_requires_account' })
})

test('bot: with bots.enabled off the bot cannot authenticate at all', async () => {
  const s = await setup({ ...ON, 'bots.enabled': '0' })
  const bot = s.add()
  bot.frame({ t: 'auth', provider: 'bot', token: `RookBot:${SECRET}`, game: 'kekkai' })
  await flush()
  assert.deepEqual(bot.conn.last(), { t: 'error', reason: 'auth_failed' })
})

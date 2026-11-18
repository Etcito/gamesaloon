// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect as connectTcp } from 'node:net'
import { loadConfig } from '../src/config.ts'
import { createDynamicOrigins, parseDynamicOrigins } from '../src/origin.ts'
import { startTransport } from '../src/transport.ts'
import type { Endpoint } from '../src/transport.ts'

test('parseDynamicOrigins keeps only well-formed https origins', () => {
  assert.deepEqual(parseDynamicOrigins({ origins: [
    'https://a.example.com', 'HTTPS://B.example.com', 'https://*.cdn.example.com', 'https://a.example.com',
    'http://insecure.example.com', 'https://x.example.com/path', 'https://x.example.com:8443', 'https://*.com', 'https://*',
    'https://user@x.example.com', 42, null, '',
  ] }), ['https://a.example.com', 'https://b.example.com', 'https://*.cdn.example.com'])
  assert.deepEqual(parseDynamicOrigins(null), [])
  assert.deepEqual(parseDynamicOrigins({ origins: 'https://a.example.com' }), [])
})

function fakeFetch(state: { body: unknown; status: number; calls: number; fail?: boolean }): typeof fetch {
  return (async () => {
    state.calls++
    if (state.fail) throw new Error('network down')
    return new Response(JSON.stringify(state.body), { status: state.status })
  }) as unknown as typeof fetch
}

test('dynamic origins: hit, miss refresh, rate limit, stale list kept on failure', async () => {
  const state = { body: { origins: ['https://a.example.com'] }, status: 200, calls: 0, fail: false }
  let t = 1_000_000
  const d = createDynamicOrigins({ url: 'http://x/o', fetchFn: fakeFetch(state), now: () => t, missRefreshMs: 5000, log: () => {} })
  assert.equal(await d.allows('https://a.example.com'), true)           // first use loads the list
  assert.equal(state.calls, 1)
  assert.equal(await d.allows('https://b.example.com'), false)          // miss, list is fresh: no new fetch
  assert.equal(state.calls, 1)
  state.body = { origins: ['https://a.example.com', 'https://b.example.com'] }
  t += 6000
  assert.equal(await d.allows('https://b.example.com'), true)           // miss on a stale list: refreshed, now allowed
  assert.equal(state.calls, 2)
  assert.equal(await d.allows(undefined), false)
  assert.equal(await d.allows('https://evil.example.org'), false)
  assert.equal(state.calls, 2)                                          // a flood of unknown origins is rate limited
  t += 6000
  state.fail = true
  assert.equal(await d.allows('https://b.example.com'), true)           // registrar down: last good list kept
  assert.equal(await d.allows('https://c.example.com'), false)
  state.fail = false
  state.status = 500
  t += 6000
  assert.equal(await d.allows('https://a.example.com'), true)           // HTTP error: still kept
  assert.deepEqual([...d.list()], ['https://a.example.com', 'https://b.example.com'])
})

test('dynamic origins: wildcards from the registrar match like static ones', async () => {
  const state = { body: { origins: ['https://*.itch.zone'] }, status: 200, calls: 0 }
  const d = createDynamicOrigins({ url: 'http://x/o', fetchFn: fakeFetch(state), log: () => {} })
  assert.equal(await d.allows('https://html-classic.itch.zone'), true)
  assert.equal(await d.allows('https://itch.zone'), false)
})

test('config: originsUrl from ETCITO_URL or ALLOWED_ORIGINS_URL, absent otherwise', () => {
  assert.equal('originsUrl' in loadConfig({}), false)
  assert.equal(loadConfig({ ETCITO_URL: 'https://etcito.example/' }).originsUrl, 'https://etcito.example/api/etcito-publisher/handshake/origins')
  assert.equal(loadConfig({ ETCITO_URL: 'https://etcito.example', ALLOWED_ORIGINS_URL: 'https://o.example/list' }).originsUrl, 'https://o.example/list')
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS_URL: 'ftp://x' }), /ALLOWED_ORIGINS_URL/)
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS_URL: 'https://u:p@x.example/' }), /ALLOWED_ORIGINS_URL/)
})

function upgradeStatus(port: number, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port })
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timed out')))
    socket.on('error', reject)
    socket.on('data', (chunk: string) => { response += chunk; if (/^HTTP\/1\.1 \d{3}/.test(response)) { socket.destroy(); resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)![1])) } })
    socket.on('end', () => reject(new Error(`no status: ${response}`)))
    socket.on('connect', () => socket.write([
      'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', `Origin: ${origin}`, '', '',
    ].join('\r\n')))
  })
}

let wsInstalled = true
try { await import('ws') } catch { wsInstalled = false }

test('transport: static list, then the registrar list; a freshly registered origin works at once', { skip: !wsInstalled, timeout: 8000 }, async () => {
  const opened: string[] = []
  const endpoint: Endpoint = {
    path: '/ws', maxPayload: 65536, heartbeatMs: null,
    open(_conn, info) { opened.push(String(info.headers.origin)); return { message() {}, closed() {} } },
    tick() {},
  }
  const state = { body: { origins: [] as string[] }, status: 200, calls: 0 }
  const dynamicOrigins = createDynamicOrigins({ url: 'http://x/o', fetchFn: fakeFetch(state), missRefreshMs: 0, log: () => {} })
  const cfg = { ...loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error' }), allowedOrigins: ['https://static.example'] }
  const transport = await startTransport({ cfg, endpoints: [endpoint], health: () => ({}), log: () => {}, autoTick: false, dynamicOrigins })
  try {
    assert.equal(await upgradeStatus(transport.port, 'https://static.example'), 101)
    assert.equal(await upgradeStatus(transport.port, 'https://new.vercel.example'), 403)
    state.body = { origins: ['https://new.vercel.example'] }                 // the creator just added a platform
    assert.equal(await upgradeStatus(transport.port, 'https://new.vercel.example'), 101)
    assert.equal(await upgradeStatus(transport.port, 'https://still-bad.example'), 403)
  } finally {
    await transport.close()
  }
})

test('transport: an EMPTY static list still allows everything (the registrar only adds)', { skip: !wsInstalled, timeout: 8000 }, async () => {
  const endpoint: Endpoint = { path: '/ws', maxPayload: 65536, heartbeatMs: null, open() { return { message() {}, closed() {} } }, tick() {} }
  const state = { body: { origins: ['https://only.example'] }, status: 200, calls: 0 }
  const dynamicOrigins = createDynamicOrigins({ url: 'http://x/o', fetchFn: fakeFetch(state), log: () => {} })
  const cfg = { ...loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error' }), allowedOrigins: [] as string[] }
  const transport = await startTransport({ cfg, endpoints: [endpoint], health: () => ({}), log: () => {}, autoTick: false, dynamicOrigins })
  try {
    assert.equal(await upgradeStatus(transport.port, 'https://anything.example'), 101)
  } finally {
    await transport.close()
  }
})

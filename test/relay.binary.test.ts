// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'
import type { ClientConn } from '../src/hub.ts'
import { startTransport } from '../src/transport.ts'
import type { Endpoint, EndpointSession, UpgradeInfo } from '../src/transport.ts'
import { BIN_IN_HEADER, BIN_KIND, BIN_OUT_HEADER, decodeBinIn, encodeBinOut } from '../src/relay/binary.ts'

let WsClient: any = null
try {
  WsClient = (await import('ws')).WebSocket
} catch {
  WsClient = null
}
const skip = WsClient === null ? 'ws not installed' : false
const testOptions = { skip, timeout: 5000 }

function config() {
  return loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error' })
}

function binIn(maskLo: number, maskHi: number, payload: number[] = [], padding = 0): Uint8Array {
  const backing = new Uint8Array(padding + BIN_IN_HEADER + payload.length + padding)
  const frame = backing.subarray(padding, padding + BIN_IN_HEADER + payload.length)
  frame[0] = BIN_KIND
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  view.setUint32(2, maskLo, true)
  view.setUint32(6, maskHi, true)
  frame.set(payload, BIN_IN_HEADER)
  return frame
}

function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      const value = read()
      if (value !== undefined) {
        resolve(value)
        return
      }
      if (Date.now() - started > 2000) {
        reject(new Error(`timed out waiting for ${what}`))
        return
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}

interface Recorded {
  conn: ClientConn
  info: UpgradeInfo
  binary: Uint8Array[]
  messages: string[]
}

function fakeEndpoint(path: string, opts: { binary?: boolean; claims?: (frame: string) => boolean } = {}) {
  const opened: Recorded[] = []
  const endpoint: Endpoint = {
    path, maxPayload: 65536, heartbeatMs: null, claims: opts.claims,
    open(conn, info) {
      const record: Recorded = { conn, info, binary: [], messages: [] }
      opened.push(record)
      const session: EndpointSession = {
        message(frame) { record.messages.push(frame) },
        closed() {},
      }
      if (opts.binary !== false) {
        session.binary = (frame) => { record.binary.push(frame) }
      }
      return session
    },
    tick() {},
  }
  return { endpoint, opened }
}

async function connect(port: number, path: string) {
  const ws = new WsClient(`ws://127.0.0.1:${port}${path}`)
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

test('decodeBinIn round-trips mask halves and payload from an offset frame', () => {
  const frame = binIn(0x89abcdef, 0x01234567, [1, 2, 3, 255], 3)
  const decoded = decodeBinIn(frame)
  assert.ok(decoded)
  assert.equal(decoded.maskLo, 0x89abcdef)
  assert.equal(decoded.maskHi, 0x01234567)
  assert.ok(decoded.payload instanceof Uint8Array)
  assert.deepEqual(Array.from(decoded.payload), [1, 2, 3, 255])
  assert.equal(decoded.payload.buffer, frame.buffer)
  assert.equal(decoded.payload.byteOffset, frame.byteOffset + BIN_IN_HEADER)
})

test('decodeBinIn rejects short frames, a wrong kind and a non-zero byte 1', () => {
  assert.equal(decodeBinIn(new Uint8Array(0)), null)
  const short = new Uint8Array(BIN_IN_HEADER - 1)
  short[0] = BIN_KIND
  assert.equal(decodeBinIn(short), null)
  const wrongKind = binIn(0, 0, [1])
  wrongKind[0] = BIN_KIND + 1
  assert.equal(decodeBinIn(wrongKind), null)
  const wrongSecond = binIn(0, 0, [1])
  wrongSecond[1] = 1
  assert.equal(decodeBinIn(wrongSecond), null)
})

test('decodeBinIn returns one reused result object', () => {
  const first = decodeBinIn(binIn(1, 2, [3]))
  const second = decodeBinIn(binIn(4, 5, [6]))
  assert.ok(first)
  assert.equal(first, second)
  assert.equal(first.maskLo, 4)
  assert.equal(first.maskHi, 5)
  assert.deepEqual(Array.from(first.payload), [6])
})

test('encodeBinOut writes kind, sender and payload into one new array', () => {
  const payload = new Uint8Array([7, 8, 9])
  const out = encodeBinOut(5, payload)
  assert.equal(out.length, BIN_OUT_HEADER + payload.length)
  assert.deepEqual(Array.from(out), [BIN_KIND, 5, 7, 8, 9])
  assert.notEqual(out.buffer, payload.buffer)
})

test('client binary frames reach session.binary as a Uint8Array', testOptions, async () => {
  const fake = fakeEndpoint('/ws')
  const transport = await startTransport({ cfg: config(), endpoints: [fake.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    const ws = await connect(transport.port, '/ws')
    const bytes = [0x5a, 0, 1, 2, 3, 255]
    ws.send(Buffer.from(bytes))
    const frame = await waitFor(() => fake.opened[0]?.binary[0], 'binary frame')
    assert.ok(frame instanceof Uint8Array)
    assert.deepEqual(Array.from(frame), bytes)
    assert.deepEqual(fake.opened[0].messages, [])
    ws.close()
  } finally {
    await transport.close()
  }
})

test('sendBinary reaches the client as a binary message', testOptions, async () => {
  const fake = fakeEndpoint('/ws')
  const transport = await startTransport({ cfg: config(), endpoints: [fake.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    const ws = await connect(transport.port, '/ws')
    const received = new Promise<{ data: Buffer; binary: boolean }>((resolve) => {
      ws.once('message', (data: Buffer, isBinary: boolean) => resolve({ data, binary: isBinary }))
    })
    fake.opened[0].conn.sendBinary!(new Uint8Array([9, 8, 7]))
    const message = await received
    assert.equal(message.binary, true)
    assert.deepEqual(Array.from(message.data), [9, 8, 7])
    ws.close()
  } finally {
    await transport.close()
  }
})

test('a session without binary receives the frame as a string through message', testOptions, async () => {
  const fake = fakeEndpoint('/ws', { binary: false })
  const transport = await startTransport({ cfg: config(), endpoints: [fake.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    const ws = await connect(transport.port, '/ws')
    ws.send(Buffer.from('legacy-bin'))
    const frame = await waitFor(() => fake.opened[0]?.messages[0], 'message frame')
    assert.equal(frame, 'legacy-bin')
    assert.deepEqual(fake.opened[0].binary, [])
    ws.close()
  } finally {
    await transport.close()
  }
})

test('a binary first frame on a pending shared socket is ignored', testOptions, async () => {
  const rooms = fakeEndpoint('/ws')
  const relay = fakeEndpoint('/ws', { claims: (frame) => frame.includes('"relay"') })
  const transport = await startTransport({ cfg: config(), endpoints: [rooms.endpoint, relay.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    const ws = await connect(transport.port, '/ws')
    ws.send(Buffer.from([1, 2, 3]))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(rooms.opened.length, 0)
    assert.equal(relay.opened.length, 0)
    const hello = '{"t":"hello"}'
    ws.send(hello)
    const frame = await waitFor(() => rooms.opened[0]?.messages[0], 'rooms message')
    assert.equal(frame, hello)
    ws.close()
  } finally {
    await transport.close()
  }
})

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Etcito
// Smoke client: node examples/hello-client.mjs [ws://127.0.0.1:8787/ws] [origin]
// If the server sets ALLOWED_ORIGINS, pass an allowed origin as 2nd argument (or GAMESALOON_ORIGIN):
// a Node client sends no Origin header and is refused with HTTP 403 otherwise.
// Connects, says hello (the protocol has no accounts; hello is the whole handshake),
// creates a room and prints its join code.
import WebSocket from 'ws'

const url = process.argv[2] ?? process.env.GAMESALOON_URL ?? 'ws://127.0.0.1:8787/ws'
const build = { characterId: 'a', bodyId: 'a', wheelId: 'a', gliderId: 'a' }
const origin = process.argv[3] ?? process.env.GAMESALOON_ORIGIN
const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined)
const timer = setTimeout(() => { console.error('FAIL: timeout'); process.exit(1) }, 8000)
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1) }

ws.on('error', (e) => fail(e.message))
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, game: 'hello-client', name: 'Guest' })))
ws.on('message', (data) => {
  const m = JSON.parse(String(data))
  if (m.t === 'welcome') {
    console.log('welcome, session', m.client)
    ws.send(JSON.stringify({ t: 'create', rid: 'r1', players: [{ name: 'Guest', build }] }))
  } else if (m.t === 'room') {
    console.log('OK: created room', m.code, '(you are peer', m.you + ')')
    clearTimeout(timer)
    ws.close()
  } else if (m.t === 'error') {
    fail(m.code + ': ' + m.message)
  }
})

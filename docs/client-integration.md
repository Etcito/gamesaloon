# Client integration

How a web game talks to the server. Everything goes through one WebSocket URL, `wss://<host>/ws` (or `ws://127.0.0.1:8787/ws` locally). No SDK is required: the protocol is JSON text frames, one object per frame, with a type field `t` ([protocol.md](protocol.md)).

## Choose what your game uses

| You want | Use | First frame |
|---|---|---|
| Friends join a lobby with a short code and then play peer to peer over WebRTC (the server only relays signaling) | the **rooms** protocol | `hello` |
| Two to four players exchange small actions through the server (turn-based, lockstep, card games), pair by code or by queue | the **relay** protocol ([RELAY.md](RELAY.md)) | `create`, `join` or `queue` |
| Accounts, ratings, ranked and quick matches, plus economy, saves, achievements | **matchmaking** and the per-player services | `auth` |

A connection speaks exactly one of these families, decided by its first frame. Matchmaking connections are relay connections: after `match` the two players are in a relay session and use `act` to talk. Open a second WebSocket if your game needs both a lobby and an account (for example, rooms for friends and a separate connection for saves).

Rooms use the KartRacer shapes for players (`name` plus a `build` of four ids) and room settings (`cup`/`track`, `cc`, `items`); see [protocol.md](protocol.md) for the exact validation. The relay and matchmaking carry arbitrary JSON from your game.

## A small client

This class works in browsers and in Node 22 or newer (both have the same `WebSocket` global). It sends requests with a request id (`rid`) that the server echoes on the direct reply, and dispatches every other message to listeners by type. The full file, including the usage below, was run against a local server.

```js
export class SaloonClient {
  constructor(url) {
    this.url = url
    this.nextRid = 1
    this.pending = new Map() // rid -> { resolve, reject }
    this.listeners = new Map() // message type -> [fn]
  }

  connect(firstFrame) {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = (e) => this.#onMessage(JSON.parse(e.data))
    this.ws.onclose = (e) => this.#emit('close', { code: e.code, reason: e.reason })
    return new Promise((resolve, reject) => {
      this.ws.onerror = () => reject(new Error('WebSocket error'))
      this.ws.onopen = () => resolve(firstFrame ? this.request(firstFrame) : undefined)
    })
  }

  on(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg))
  }

  // Rooms protocol: the server echoes `rid` on the direct reply or error.
  request(msg) {
    const rid = this.nextRid++
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject })
      this.send({ ...msg, rid })
    })
  }

  #onMessage(msg) {
    const p = msg.rid !== undefined ? this.pending.get(msg.rid) : undefined
    if (p) {
      this.pending.delete(msg.rid)
      if (msg.t === 'error') p.reject(new Error(msg.code ?? msg.reason))
      else p.resolve(msg)
    }
    this.#emit(msg.t, msg)
  }

  #emit(type, msg) {
    for (const fn of this.listeners.get(type) ?? []) fn(msg)
  }
}
```

Usage with the rooms protocol:

```js
const player = { name: 'Alice', build: { characterId: 'fox', bodyId: 'std', wheelId: 'std', gliderId: 'std' } }

const client = new SaloonClient('wss://rooms.example.com/ws')
client.on('room', (room) => console.log('room update:', room.code, 'members:', room.members.length))
client.on('started', (s) => console.log('race starts, seed', s.seed))
client.on('signal', (s) => console.log('signal from peer', s.from, s.data.kind))

const welcome = await client.connect({ t: 'hello', v: 1, game: 'my-game-1.0', name: 'Alice' })
const room = await client.request({ t: 'create', players: [player] })   // show room.code to friends
// a friend: await other.request({ t: 'join', code, players: [player] })
await client.request({ t: 'start' })                                    // owner only
```

Output against a local server:

```
ice servers: [{"urls":["stun:stun.l.google.com:19302"]}]
room update: QSND4 members: 1
share this code: QSND4
race starts, seed 379777879
```

Notes for the rooms protocol:

- Relay requests do not take a `rid`; the helper above is for rooms replies. For the relay and matchmaking, wait for the reply by message type (see the second sample of [quickstart.md](quickstart.md)).
- The `game` string in `hello` also partitions rooms: use a version or build id if different versions must not meet.
- After `welcome`, pass `welcome.iceServers` to `new RTCPeerConnection({ iceServers })`. Then exchange `signal` messages with the other members: `{ t: 'signal', to: <peer id>, data }` where `data` is `{kind: 'offer' | 'answer', sdp}`, `{kind: 'ice', candidate, sdpMid, sdpMLineIndex}` or `{kind: 'ice-end'}`. Peer ids come from `room.members[].peer`, and `room.you` is yours. Once the data channels are open, race traffic never touches the server.
- `room` is re-sent to everybody whenever the lobby changes (a join, a leave, new settings). A leaving member produces `peerLeft` followed by `room`.
- Only the owner (`room.owner`) can `start`, change `settings`, or `end`. `started.seed` is the same random 32-bit number for everyone: use it to seed your deterministic simulation.

## Matchmaking from a client

```js
ws.send(JSON.stringify({ t: 'auth', provider: 'guest', token: myStableRandomToken, name: 'Alice' }))
// -> { t: 'authed', player_id, display_name, provider }
ws.send(JSON.stringify({ t: 'match_queue', game: 'my-game', queue: 'ranked' }))
// -> { t: 'match_queued', ... } then { t: 'match', match_id, seat, opponent } and { t: 'matched', seed, youAre, token, ... }
// play with { t: 'act', a: {...} } messages; the opponent receives { t: 'act', a, n, from }
ws.send(JSON.stringify({ t: 'result', match_id, outcome: 'win' }))
// -> { t: 'result_ack' }, then { t: 'match_end', status, outcome, rating? }
```

- A guest token is 16 to 128 characters of `A-Za-z0-9_-`. Generate 32 random characters once, store them (for example in `localStorage`), and reuse them: the token *is* the account. Anyone with the token can play as that player.
- Save the `token` from `matched`: if the connection drops, reconnect, send `{ t: 'resume', token, have: <last n you applied> }` within 90 seconds and the server replays missed actions. Past that you forfeit.
- Both players must report the result, and the reports must agree (see [matchmaking-and-elo.md](matchmaking-and-elo.md)). Compute the result in your lockstep simulation on both sides.

## Practical advice

- **Keep-alive**: the server pings (WebSocket ping frames) every 20 s on the rooms side and 30 s on the relay; browsers answer automatically. You do not need an application-level heartbeat. `ping` messages exist for latency measurement.
- **Reconnects**: a rooms connection that drops has left its room; there is no resume for rooms. Matchmaking sessions can resume as above.
- **Rate limits**: rooms accept about 40 messages per second per connection (burst 80) and close abusive connections; the relay allows 20 per second and 400 per minute. Do not send per-frame traffic through the server.
- **Mixed content**: a page served over `https` must use `wss://`.
- **Origins**: if the operator set `ALLOWED_ORIGINS`, your page's origin must be in it, otherwise the upgrade fails with 403 (the browser reports only a generic error).
- **Close codes you may see**: 4000 (no first frame in 10 s), 4001 (unsupported `v`), 4008 (rate abuse), 4009 or 1009 (frame too large), 1013 (server full), 1000 `idle` (lobby idle for 30 minutes), 1001 (server shutting down).
- **Errors**: rooms errors are `{t:'error', code, message}`; relay and matchmaking errors are `{t:'error', reason}`. Handle both.

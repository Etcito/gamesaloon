# Quickstart (5 minutes)

You will start the server, check it is alive, create and join a room with two scripted clients, and run a quick match.

> This quickstart covers the lobby core (memory store, zero setup): rooms, relay, matchmaking, Elo. The economy, cloud saves and achievements need a table store and have no data in memory mode; either connect your own database ([stores.md](stores.md)) or use Etcito (hosted). See the README for the three options.

## 1. Run the server

Requirements: Node 22.18 or newer (TypeScript runs through Node's type stripping, there is no build step) and `npm`.

```sh
npm install --omit=dev
npm start        # node --experimental-strip-types src/main.ts
```

The server prints `player store: memory` and `rooms listening on 127.0.0.1:8787`. It listens on `127.0.0.1:8787` by default; set `PORT` and `HOST` to change that (all variables are in [configuration.md](configuration.md)). With the default `PLAYER_STORE=memory`, players, ratings and everything else persisted by the server are lost when the process stops (see [stores.md](stores.md)).

Check it:

```sh
curl http://127.0.0.1:8787/health
# {"ok":true,"rooms":0,"clients":0,"version":"0.1.0"}
```

Other npm scripts that exist: `npm test` (the `node:test` suite over `test/**/*.test.ts`), `npm run typecheck` and `npm run build` (compiles `src/` to `dist/`; both need the dev dependencies, so run a plain `npm install` for them).

### With Docker

The repository root also carries a Docker setup; see [../docker-compose.yml](../docker-compose.yml) and the environment template [../.env.example](../.env.example). The variables in that template are the ones documented in [configuration.md](configuration.md).

## 2. Connect a client and create a room

WebSocket clients connect to `ws://127.0.0.1:8787/ws`. Every message is one JSON object with a type field `t`. A rooms client must send `hello` first.

The script below uses the `WebSocket` global of Node 22 (browsers have the same API). It connects two clients, creates a room with the first, joins it by code with the second, and starts it.

```js
// Two clients: one creates a room, the other joins it by code.
const URL = process.env.WS_URL ?? 'ws://127.0.0.1:8787/ws'

function connect(name) {
  const ws = new WebSocket(URL)
  const inbox = []
  const waiting = []
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    const w = waiting.findIndex((x) => x.t === msg.t)
    if (w >= 0) waiting.splice(w, 1)[0].resolve(msg)
    else inbox.push(msg)
  }
  const send = (obj) => ws.send(JSON.stringify(obj))
  const next = (t) =>
    new Promise((resolve) => {
      const i = inbox.findIndex((m) => m.t === t)
      if (i >= 0) resolve(inbox.splice(i, 1)[0])
      else waiting.push({ t, resolve })
    })
  const ready = new Promise((resolve) => (ws.onopen = resolve))
  return { ws, send, next, ready, name }
}

const player = (name) => ({
  name,
  build: { characterId: 'fox', bodyId: 'std', wheelId: 'std', gliderId: 'std' },
})

const alice = connect('Alice')
const bob = connect('Bob')
await Promise.all([alice.ready, bob.ready])

alice.send({ t: 'hello', v: 1, game: 'demo', name: 'Alice' })
bob.send({ t: 'hello', v: 1, game: 'demo', name: 'Bob' })
await alice.next('welcome')
await bob.next('welcome')

alice.send({ t: 'create', players: [player('Alice')] })
const room = await alice.next('room')
console.log('room code:', room.code)

bob.send({ t: 'join', code: room.code, players: [player('Bob')] })
const joined = await bob.next('room')
console.log('Bob is peer', joined.you, 'in a room of', joined.members.length)

alice.send({ t: 'start' })
const started = await bob.next('started')
console.log('started with seed', started.seed)

alice.ws.close()
bob.ws.close()
```

Save it as `room.mjs` and run `node room.mjs`. Output (the code and seed differ on every run):

```
room code: UZRVV
Bob is peer 1 in a room of 2
started with seed 245244992
```

What happened: the room code is 5 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; the creator is peer 0 and the room owner; only the owner can `start`; `started` carries a random 32-bit seed that every member receives. From here, members exchange WebRTC `signal` messages through the server and play peer to peer. The server never relays race data in the rooms protocol. Details: [protocol.md](protocol.md).

Note that the `build` fields (`characterId`, `bodyId`, `wheelId`, `gliderId`) and the room `settings` (`cup` or `track`, `cc`, `items`) are the KartRacer shapes the rooms protocol currently validates. A different game can still use rooms by sending placeholder values that match the validation (ids of 1 to 24 characters from `a-z`, `0-9`, `-`), or use the relay and match protocols, which are game-agnostic.

## 3. Run a quick match

Matchmaking messages ride on the same `/ws` path. The first frame of a connection decides what the connection is: a `hello` makes it a rooms connection; an `auth` (or any other relay or match message) makes it a relay and matchmaking connection. A connection cannot be both.

```js
// Two guests enter the quick queue, get paired and report a result.
const URL = process.env.WS_URL ?? 'ws://127.0.0.1:8787/ws'

function connect() {
  const ws = new WebSocket(URL)
  const inbox = []
  const waiting = []
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    const w = waiting.findIndex((x) => x.t === msg.t)
    if (w >= 0) waiting.splice(w, 1)[0].resolve(msg)
    else inbox.push(msg)
  }
  const send = (obj) => ws.send(JSON.stringify(obj))
  const next = (t) =>
    new Promise((resolve) => {
      const i = inbox.findIndex((m) => m.t === t)
      if (i >= 0) resolve(inbox.splice(i, 1)[0])
      else waiting.push({ t, resolve })
    })
  const ready = new Promise((resolve) => (ws.onopen = resolve))
  return { ws, send, next, ready }
}

const a = connect()
const b = connect()
await Promise.all([a.ready, b.ready])

// The first frame of a connection decides what it is: an auth frame makes it a match/relay connection.
a.send({ t: 'auth', provider: 'guest', token: 'guest-token-0000000000a1', name: 'Alice' })
b.send({ t: 'auth', provider: 'guest', token: 'guest-token-0000000000b2', name: 'Bob' })
console.log('authed:', (await a.next('authed')).display_name, (await b.next('authed')).display_name)

a.send({ t: 'match_queue', game: 'demo', queue: 'quick' })
b.send({ t: 'match_queue', game: 'demo', queue: 'quick' })
const ma = await a.next('match')
const mb = await b.next('match')
console.log('match', ma.match_id, 'seats', ma.seat, mb.seat, 'opponent of A:', ma.opponent.display_name)

const matched = await a.next('matched')
console.log('relay seed', matched.seed, 'youAre', matched.youAre)

a.send({ t: 'result', match_id: ma.match_id, outcome: 'win' })
b.send({ t: 'result', match_id: mb.match_id, outcome: 'loss' })
const end = await a.next('match_end')
console.log('match_end:', end.status, end.outcome)

a.ws.close()
b.ws.close()
```

Output:

```
authed: Alice Bob
match c60d22bf-ec40-4275-ad48-48dbe81530a5 seats 0 1 opponent of A: Bob
relay seed 3820894389 youAre 0
match_end: complete win
```

Guest tokens are 16 to 128 characters of `A-Za-z0-9_-`; the player is created on first use and recognised by a hash of the token, so keep the token private and stable per player. Replace `quick` with `ranked` for a rated match (the rating is per player and per `game`). Once paired, the two clients share a relay session on the same connection: `act` messages are relayed between them (see [RELAY.md](RELAY.md)) and each side reports the result. Everything about queues and results is in [matchmaking-and-elo.md](matchmaking-and-elo.md).

## Next steps

- Connect a real web game: [client-integration.md](client-integration.md).
- Run it for real: [deploying.md](deploying.md).
- Use it as a library inside your own server process: the embedding section of [configuration.md](configuration.md).
- Add a coin and card-pack economy or cloud saves: [economy.md](economy.md), [online-data.md](online-data.md).

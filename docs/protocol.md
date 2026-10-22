# Wire protocol

JSON text frames over WebSocket at path `/ws`. Every frame is one JSON object with a type field `t`. The path serves two protocol families, and the **first frame of a connection** chooses which one the connection speaks for its whole life:

| First frame `t` | The connection is | Section |
|---|---|---|
| `hello` (or anything the relay does not claim) | a **rooms** connection | [Rooms](#rooms-protocol) |
| `create`, `join`, `act`, `bye`, `queue`, `unqueue`, `resume`, `ping` (relay), or `auth`, `match_queue`, `match_unqueue`, `result`, `ladder`, `eco_*`, `save_*`, `ach_*`, `stats_get`, `stat_report`, `ugc_*` (extensions) | a **relay + matchmaking** connection | [Relay](#relay-connection) and [Matchmaking](#matchmaking-messages) |

(Source: `relayClaims` in `src/relay/protocol.ts`, `matchClaims` in `src/match/messages.ts`, and the claim logic in `src/transport.ts`.) A connection that sent no first frame within 10 seconds is closed with code 4000 `hello_timeout`.

Consequences worth knowing:

- A rooms client sends `hello` first. After that, `auth` is answered with a rooms `bad_message` error ("unknown type 'auth'").
- A relay or matchmaking client never sends `hello`; a `hello` sent after its first frame is ignored without a reply.
- A first frame that is not valid JSON goes to the rooms side, which answers `bad_message` ("not JSON").
- A first frame `ping` or `create` is a relay frame, not a rooms frame. For rooms, `hello` always comes first.

`GET /health` answers `200 {"ok":true,"rooms":n,"clients":n,"version":"<package version>"}` (`rooms` and `clients` count the rooms side). `POST /webhooks/wavedash`, `/webhooks/wavedash/playtest`, `/webhooks/stripe` and `/webhooks/stripe/<game>` exist when the server is started with `npm start` (see [economy.md](economy.md)). Any other HTTP request gets 404. An upgrade on another path, or from an origin not in `ALLOWED_ORIGINS`, gets `403 Forbidden`.

The rooms protocol is also described in the repository's [../PROTOCOL.md](../PROTOCOL.md) (the typed copy is `src/protocol.ts`). This page is checked against the code and adds what that file leaves out.

---

## Rooms protocol

Protocol version: `PROTOCOL_VERSION = 1`. Frames are text, at most 65536 bytes on a rooms connection. Unknown fields are ignored. An optional `rid` (string or finite number) on a client message is echoed on the direct reply or error.

### Shared shapes

- `LocalPlayer = { name, build: { characterId, bodyId, wheelId, gliderId } }`. `name` is 1 to 16 characters after trimming; each build id is 1 to 24 characters of `[a-z0-9-]`. These are the KartRacer shapes.
- `RoomSettings = { kind: 'cup' | 'track', cupId, trackId, cc: 50 | 100 | 150 | 200, items: boolean }`. Ids are 1 to 32 characters of `[a-z0-9-]`. Default when `create` has no settings: `{ kind: 'cup', cupId: 'sprout', trackId: 'meadow-loop', cc: 150, items: true }`.
- `Member = { peer: 0..7, name, players: LocalPlayer[] (1..4) }`.
- `IceServer = { urls: string[], username?, credential? }`.

Limits: at most 8 machines (connections) and 8 humans (local players summed over all members) per room; at most 4 local players per connection.

### Client to server

| `t` | Fields | Reply |
|---|---|---|
| `hello` | `v: 1`, `game` (1..64 chars, the client's build id), `name` (1..16) | `welcome` |
| `create` | `players` (1..4), optional `settings`, optional `private: boolean` | `room` (creator is owner, peer 0) |
| `list` | none | `rooms` |
| `join` | `code`, `players` | `room` to the joiner, `room` broadcast to the others |
| `leave` | none | `left`, then `peerLeft` + `room` to the others |
| `players` | `players` | `room` broadcast (lobby only) |
| `settings` | `settings` | `room` broadcast (owner only, lobby only) |
| `start` | none | `started` broadcast (owner only, lobby only) |
| `end` | none | `room` broadcast, status back to `lobby` (owner only, racing only) |
| `signal` | `to: 0..7`, `data` | `signal` `{ from, data }` to the member with peer id `to` |
| `ping` | `id: number` | `pong` `{ id }` |

`signal.data` is one of `{ kind: 'offer' | 'answer', sdp }`, `{ kind: 'ice', candidate, sdpMid: string | null, sdpMLineIndex: number | null }`, `{ kind: 'ice-end' }`, at most 16384 bytes serialized.

### Server to client

- `welcome` `{ v: 1, client, iceServers, maxHumans: 8, maxLocal: 4 }`. `client` is an opaque session id.
- `room` `{ code, you, owner, status: 'lobby' | 'racing', members, settings, humans, private?: true }`. `you` is the receiver's own peer id; `members` are sorted by peer.
- `started` `{ code, seed, settings, members }`. `seed` is a random u32 drawn on the server.
- `rooms` `{ rooms: [{ code, owner, humans, settings }] }`: public lobby rooms, not full, with the same `game` as the caller, fullest first, at most 50. Private rooms are never listed.
- `left`, `peerLeft` `{ peer }` (always followed by a `room` message), `signal`, `pong`.
- `error` `{ code, message }` (plus `rid` when the request had one).

### Example session

Two clients, A (Alice) and B (Bob). Output from a local server (long member lists shortened):

```
A -> {"t":"hello","v":1,"game":"kart","name":"Alice","rid":1}
A <- {"t":"welcome","rid":1,"v":1,"client":"c1-9691e932","iceServers":[{"urls":["stun:stun.l.google.com:19302"]}],"maxHumans":8,"maxLocal":4}
A -> {"t":"create","rid":2,"players":[{"name":"Alice","build":{"characterId":"fox","bodyId":"std","wheelId":"std","gliderId":"std"}}]}
A <- {"t":"room","rid":2,"code":"6TPRE","you":0,"owner":0,"status":"lobby","members":[{"peer":0,"name":"Alice","players":[...]}],"settings":{"kind":"cup","cupId":"sprout","trackId":"meadow-loop","cc":150,"items":true},"humans":1}
B -> {"t":"join","code":"6tpre","players":[{"name":"Bob","build":{...}}]}
B <- {"t":"room","code":"6TPRE","you":1,"owner":0,"status":"lobby","members":[{"peer":0,...},{"peer":1,...}],"settings":{...},"humans":2}
A <- {"t":"room","code":"6TPRE","you":0,"owner":0,...}
A -> {"t":"list"}
A <- {"t":"rooms","rooms":[{"code":"6TPRE","owner":"Alice","humans":2,"settings":{...}}]}
A -> {"t":"signal","to":1,"data":{"kind":"offer","sdp":"v=0..."}}
B <- {"t":"signal","from":0,"data":{"kind":"offer","sdp":"v=0..."}}
A -> {"t":"start"}
A <- {"t":"started","code":"6TPRE","seed":4290224220,"settings":{...},"members":[...]}
B <- {"t":"started","code":"6TPRE","seed":4290224220,"settings":{...},"members":[...]}
A -> {"t":"join","code":"ZZZZZ","players":[...]}
A <- {"t":"error","code":"already_in_room","message":"already in a room"}
A -> {"t":"ping","id":7}
A <- {"t":"pong","id":7}
```

Join codes are case-insensitive and surrounding spaces are trimmed.

### Rules

- **Peer ids**: the lowest free id in 0..7. When the owner leaves, ownership passes to the lowest remaining peer id. An empty room is deleted.
- **Racing**: after `start` the room is `racing`; `join`, `players` and `settings` are refused with `room_started`. The owner's `end` returns it to `lobby`.
- **Game matching**: `join` fails with `game_mismatch` when the joiner's `hello.game` differs from the creator's. `list` shows only rooms of the caller's `game`.
- **ICE servers**: `iceServers` holds one entry with the STUN urls (default `stun:stun.l.google.com:19302`) and, when `TURN_SECRET` and `TURN_URLS` are both set, a second entry with the TURN urls plus coturn REST credentials: `username = "<unix expiry>:<client>"` where expiry is now + 86400 seconds, and `credential = base64(HMAC-SHA1(TURN_SECRET, username))` (`src/turn.ts`).
- **Rate limit**: a token bucket of 40 messages per second with a burst of 80 per connection. Excess messages are dropped with `rate_limited`. A connection that stays over the limit for 5 seconds is closed with code 4008.
- **Timeouts**: `hello` within 10 s (else close 4000 `hello_timeout`). The server sends a WebSocket ping every 20 s and terminates a connection that did not answer by the next one (about 40 s). A lobby with no activity for 30 minutes is closed (members get close code 1000 `idle`). Racing rooms are not subject to the idle timeout.
- **Capacity**: when `MAX_CLIENTS` is reached a new connection receives `error` `server_full` and is closed with 1013. When `MAX_ROOMS` is reached, `create` fails with `server_full`. In multi-creator mode a creator game also has its own room cap (message "no room available for this game", same code); see [multi-game.md](multi-game.md).
- **Unknown game**: only when the server runs in multi-creator mode, `hello` (and `create`) with a game the server does not serve fails with `bad_message` ("unknown game"). Otherwise any `game` string is accepted.

### Error codes

Rooms errors look like `{"t":"error","code":"...","message":"..."}`.

| code | meaning |
|---|---|
| `bad_message` | not JSON, missing or invalid fields, unknown `t`, a second `hello`, or `end` while not racing |
| `bad_version` | `hello.v` is not 1; the connection is then closed with 4001 |
| `hello_required` | any message before `hello` |
| `game_mismatch` | `join` with a `game` different from the room creator's |
| `room_not_found` | unknown or malformed code |
| `room_full` | more than 8 machines, or more than 8 humans in total |
| `room_started` | `join`, `players` or `settings` while racing; `start` when already racing |
| `not_in_room` | the message needs a room |
| `already_in_room` | `create` or `join` while in a room |
| `not_owner` | owner-only message (`settings`, `start`, `end`) |
| `bad_players` | invalid players list |
| `bad_settings` | invalid settings |
| `peer_not_found` | `signal` to an unknown peer or to yourself |
| `rate_limited` | over the rate limit; the message is dropped |
| `server_full` | `MAX_ROOMS` or `MAX_CLIENTS` reached |
| `too_large` | a frame over 65536 bytes (the connection is then closed with 4009) |
| `internal` | unexpected server failure |

### Close codes used by the rooms side

4000 `hello_timeout`, 4001 `bad_version`, 4008 `rate_limited`, 4009 `too_large`, 1013 `server_full`, 1000 `idle`, 1001 `server shutdown` (graceful `close()`).

---

## Relay connection

A connection whose first frame is a relay message is a GameNet relay connection: private rooms by 4-digit code (`create` / `join`), a legacy FIFO `queue`, sequenced `act` relay with acknowledgements, reconnection with `resume`, and `bye`. The whole relay reference is [RELAY.md](RELAY.md). The relay's shapes differ from rooms:

- Errors are `{"t":"error","reason":"<text>"}`, with reasons such as `server full`, `room not found`, `room full`, `bad queue payload`, `resume expired`, `rate limited` (spaces, not underscores). Matchmaking reuses this shape with underscore reasons (below).
- Relay messages (`create`, `join`, `act`, ...) over 4096 bytes are invalid; the tenth invalid frame closes the socket. Extension messages (`auth`, `match_*`, `eco_*`, `save_*`, `ach_*`, `ugc_*`, ...) may be up to 524288 bytes (512 KiB, `MAX_EXT_BYTES` in `src/relay/protocol.ts`); a larger frame closes the socket with code 1009.
- Relay limits that are constants in the code (`src/relay/protocol.ts`): at most 200 relay sessions, 500 relay sockets, 4 players per session, 20 messages per second and 400 per minute per socket (90 and 4000 for seated cadence clients), heartbeat every 30 s, reconnection grace 60 s.
- These relay limits are separate from `MAX_ROOMS` and `MAX_CLIENTS`, which apply to the rooms side.

---

## Matchmaking messages

These ride on a relay connection. The pairing rules, ratings and timings are in [matchmaking-and-elo.md](matchmaking-and-elo.md). Errors are `{"t":"error","reason":"<code>"}`.

### Client to server

| `t` | Fields | Needs auth | Reply |
|---|---|---|---|
| `auth` | `provider: 'wavedash' \| 'itch' \| 'guest' \| 'bot'` (bot token: `<bot name>:<secret>`), `token`, optional `name`, optional `game` (1..64 chars) | no | `authed` |
| `match_queue` | `game` (1..64 chars), `queue: 'quick' \| 'ranked'` | yes | `match_queued`, later `match` |
| `match_unqueue` | none | no | `match_unqueued` |
| `result` | `match_id` (1..128 chars), `outcome: 'win' \| 'loss' \| 'draw'` | yes | `result_ack` |
| `ladder` | `page` (integer 1..1000) | yes | `ladder` |

`token` is 16 to 128 characters of `[A-Za-z0-9_-]` for `guest`, and 1 to 4096 characters for `wavedash` and `itch`. `name` is used only when the player is first created, and only if it is 3 to 16 characters after trimming. `game` selects which game's player list the connection joins when the server serves several games (see [multi-game.md](multi-game.md)); with a single store or a single game it may be omitted. After `auth`, `match_queue.game` must be the game the connection authenticated into.

Do not confuse `match_queue` / `match_unqueue` with the relay's legacy `queue` / `unqueue`: the legacy ones pair anonymous clients without accounts or ratings.

### Server to client

- `authed` `{ player_id, display_name, provider }`
- `match_queued` `{ game, queue, rating, games, placement }`
- `match_unqueued` `{}`
- `match` `{ match_id, game, queue, seat: 0 | 1, opponent: { player_id, display_name, rating, tier, placement, games } }`. `rating`, `tier`, `placement` and `games` describe the opponent's ranked state. Sent just before the relay's `matched` frame, on the same connection.
- `result_ack` `{ match_id }`
- `match_end` `{ match_id, status: 'complete' | 'void' | 'forfeit', reason: 'agreed' | 'disagreement' | 'no_report' | 'disconnect' | 'both_disconnected' | 'left' | 'lone_draw' | 'inactivity', outcome: 'win' | 'loss' | 'draw' | null, rating?: { before, after, games, placement, tier }, weight: 1 | 0.5, duration_ms, rewardable: boolean }`. `outcome` is from the receiver's point of view and is `null` when void. `rating` appears only for a ranked match that applied a result; `rating.tier` is the tier after the change. `weight` is `0.5` for a match shorter than 180000 ms. `duration_ms` is `ended_at - started_at`. `rewardable` is `true` only for a complete, agreed ranked match of at least 180000 ms between two non-resident accounts (see [matchmaking-and-elo.md](matchmaking-and-elo.md#rewardable)).
- `ladder` `{ game, page, page_size: 10, total, entries: [{ rank, player_id, display_name, rating, tier }], me: { rank: number | null, rating, tier, placement, games } | null }`. Ordered by rating, then player id; `rank` is 1-based and `null` while in placement. `me` is the receiver's own row, or `null` for a `guest` (a `bot` gets its row; a guest reads the ladder without a pinned row).

### Error reasons

| reason | meaning |
|---|---|
| `auth_required` | `match_queue` or `ladder` before `auth` |
| `already_authed` | a second `auth` on the same connection |
| `auth_failed` | identity verification refused, or the `verifyIdentity` hook threw |
| `auth_unavailable` | the provider has no verifier: `wavedash` or `itch` without a `verifyIdentity` hook, or `itch` under `npm start` (no itch verifier ships) |
| `already_queued` | already queued or being paired |
| `not_queued` | `match_unqueue` while not queued |
| `in_match` | already seated in a match or relay session |
| `ranked_busy` | the player already holds a ranked match lock |
| `resident_cannot_queue` | the authenticated player is a resident |
| `bad_queue` | `queue` is neither `quick` nor `ranked`, or the game does not offer that queue |
| `unknown_match` | `result` for a match this player is not in |
| `already_reported` | this player already reported for this match |
| `store_unavailable` | a `PlayerStore` call failed |
| `ranked_requires_account` | `match_queue` with `queue: 'ranked'` from a `guest` while the server sets `RANKED_REQUIRE_ACCOUNT`; the player is not queued |
| `bad_message` | invalid fields; also an unknown `game` in `auth`, a missing `game` while several games are served, and a `match_queue.game` different from the authenticated game (relay code reused) |
| `internal` | unexpected failure (relay code reused) |

The economy and online-data messages add more reasons (`economy_unavailable`, `insufficient_funds`, `no_packs`, `online_unavailable`, `version_conflict`, `quota_exceeded`, ...); they are listed in [economy.md](economy.md) and [online-data.md](online-data.md). Errors for those messages echo the request's `op` when it had one.

### Example session

Two guests playing a ranked match (output from a local server):

```
C -> {"t":"match_queue","game":"kart","queue":"quick"}
C <- {"t":"error","reason":"auth_required"}
C -> {"t":"auth","provider":"guest","token":"guest-token-aaaaaaaaaaaa","name":"Carol"}
C <- {"t":"authed","player_id":"942772a4-bed6-48eb-85b1-8b46a839a9ca","display_name":"Carol","provider":"guest"}
D -> {"t":"auth","provider":"guest","token":"guest-token-bbbbbbbbbbbb"}
D <- {"t":"authed","player_id":"00ce1acc-90fa-4944-9248-ccbb2148c373","display_name":"Guest-8A69","provider":"guest"}
C -> {"t":"match_queue","game":"kart","queue":"ranked"}
C <- {"t":"match_queued","game":"kart","queue":"ranked","rating":2500,"games":0,"placement":true}
D -> {"t":"match_queue","game":"kart","queue":"ranked"}
D <- {"t":"match_queued","game":"kart","queue":"ranked","rating":2500,"games":0,"placement":true}
D <- {"t":"match","match_id":"4058fa24-...","game":"kart","queue":"ranked","seat":1,"opponent":{"player_id":"942772a4-...","display_name":"Carol","rating":2500,"tier":"Platinum","placement":true,"games":0}}
D <- {"t":"matched","seed":2491007138,"hostStarts":true,"youAre":1,"token":"6761b103-...","players":2,"opps":[null,null],"opp":null}
C <- {"t":"match","match_id":"4058fa24-...","game":"kart","queue":"ranked","seat":0,"opponent":{"player_id":"00ce1acc-...","display_name":"Guest-8A69","rating":2500,"tier":"Platinum","placement":true,"games":0}}
C <- {"t":"matched","seed":2491007138,"hostStarts":true,"youAre":0,"token":"9114feff-...","players":2,"opps":[null,null],"opp":null}
C -> {"t":"act","a":{"x":1}}
C <- {"t":"ack","n":1}
D <- {"t":"act","a":{"x":1},"n":1,"from":0}
C -> {"t":"result","match_id":"4058fa24-...","outcome":"win"}
C <- {"t":"result_ack","match_id":"4058fa24-..."}
D -> {"t":"result","match_id":"4058fa24-...","outcome":"loss"}
D <- {"t":"result_ack","match_id":"4058fa24-..."}
D <- {"t":"match_end","match_id":"4058fa24-...","status":"complete","reason":"agreed","outcome":"loss","rating":{"before":2500,"after":2420,"games":1,"placement":true,"tier":"Platinum"},"weight":1,"duration_ms":240000,"rewardable":false}
C <- {"t":"match_end","match_id":"4058fa24-...","status":"complete","reason":"agreed","outcome":"win","rating":{"before":2500,"after":2580,"games":1,"placement":true,"tier":"Platinum"},"weight":1,"duration_ms":240000,"rewardable":false}
D -> {"t":"result","match_id":"nope","outcome":"loss"}
D <- {"t":"error","reason":"unknown_match"}
D -> {"t":"match_unqueue"}
D <- {"t":"error","reason":"not_queued"}
```

The `token` in `matched` is the relay's reconnection token for that seat (see `resume` in [RELAY.md](RELAY.md)); it is also what keeps the match alive across a reconnect, because the match service restores the seat's identity when the seat resumes.

### Example ladder exchange

An account player (`W`) and a guest (`G`) ask for page 1:

```
W -> {"t":"ladder","page":1}
W <- {"t":"ladder","game":"kart","page":1,"page_size":10,"total":42,"entries":[{"rank":1,"player_id":"7f0e6d3a-...","display_name":"Mira","rating":2860,"tier":"Diamond"},{"rank":2,"player_id":"a1c9f20b-...","display_name":"Tobias","rating":2710,"tier":"Platinum"}],"me":{"rank":7,"rating":2512,"tier":"Platinum","placement":false,"games":12}}
G -> {"t":"ladder","page":1}
G <- {"t":"ladder","game":"kart","page":1,"page_size":10,"total":42,"entries":[{"rank":1,"player_id":"7f0e6d3a-...","display_name":"Mira","rating":2860,"tier":"Diamond"},{"rank":2,"player_id":"a1c9f20b-...","display_name":"Tobias","rating":2710,"tier":"Platinum"}],"me":null}
```

`entries` holds at most 10 rows (the rest of the page is shortened above). A player in placement has `rank: null` in `me`; a guest gets the page but never a pinned `me` row.

# GameNet relay protocol reference

Source: the implementation in `src/relay/` (`protocol.ts`, `hub.ts`, `endpoint.ts`, `groups.ts`, `gameQueues.ts`, `binary.ts`) and `src/config.ts`; scenario tests in `test/relay.test.ts`, `test/relay.hub.test.ts`, and `test/relay.zones.test.ts`. Fields below are JSON fields; all message types use `t`.

## 1. Endpoint

- The source comments identify the WebSocket route as `/ws`; `new WebSocketServer({ server })` does not configure a path filter. There are no relay query parameters or query handling; the server attaches to HTTP upgrades without examining their URL.
- The server does not set a `maxPayload` option. Text relay messages are limited to 4 KiB (`MAX_MSG_BYTES`). Invalid text messages count as invalid and are ignored; the tenth invalid message closes the socket. Binary frames are handled for started zone-room members as described in section 4; elsewhere they count as invalid.
- Protocol field: `t`.
- WebSocket heartbeat: every 30,000 ms the server sends a control ping; a pong marks the socket alive. A socket still marked dead on the next interval is terminated.

## 2. Client and server messages

Client messages (validation and handling: ):

- `create` `{ t, players?, cadence?, payload? }` for legacy rooms, or `{ t, players?, cadence?, payload?, game, zones:true }` for a zone room. Legacy `players` is 2–4 (default 2); zone `players` is 2–64 (default 2) and cannot exceed that game's configured seat cap. `cadence` is boolean; payload is stored as the creator's seat payload. Reply: `{ t:'room', code }`, or an error (`server full`, `unknown game`, or `room full` for a game seat-cap excess).
- `join` `{ t, code, payload? }`. Reply on a missing code: `error` reason `room not found`; no free seat or already-started room: `error` reason `room full`; an incomplete room: `{ t:'waiting', seat, players }`; when full, all seats receive `matched` (fields below).
- `queue` `{ t, players?, cadence?, payload? }` for legacy queues, or `{ t, players?, cadence?, payload?, game, zones:true }` for a game queue. It has the same player-count constraints as `create`; payload may be absent/null or a shallow-enough object. A waiting caller receives `{ t:'queued', estimateMs }` (estimate is null until there are completed pairings). When that queue reaches `players`, all seats receive `matched`. Invalid payload gives error reason `bad queue payload`; room capacity gives `server full`; an unconfigured game gives `unknown game` and a player count above its cap gives `room full`.
- `unqueue` `{ t }`. Reply: `{ t:'unqueued' }`.
- `act` `{ t, a, n? }`. `a` must be a bounded JSON object/array; optional `n` is an integer from 0 through 1,000,000. The sender receives `{ t:'ack', n }`; other seats receive `{ t:'act', a, n, from }`. An omitted sequence number is assigned as that seat's previous receive number plus one.
- `resume` `{ t, token, have? }`. `token` is a nonempty string up to 64 characters; `have` is an integer sequence or an array of up to four sequence integers. Reply is `resumed` and any replayed `act` messages; see sections 6–7. Invalid/expired token replies `{ t:'error', reason:'resume expired' }`.
- `ping` `{ t }`. Reply: `{ t:'pong' }`.
- `bye` `{ t }`. No direct reply; departure notifications follow the rules in section 3.

Server messages:

- `room` `{ t, code }`: private room created; code is four decimal digits.
- `waiting` `{ t, seat, players }`: seat taken, room still incomplete.
- `queued` `{ t, estimateMs }`: caller entered the public queue.
- `unqueued` `{ t }`: caller removed from every queue.
- `matched` `{ t, seed, hostStarts, youAre, token, players, opps, opp? }`: one per seated client. `youAre` is its seat index; `token` is its unique resume token; `opps` is the payload array by seat. For two players, `opp` is the other seat's payload.
- `act` `{ t, a, n, from }`: action relayed to every other seat; `from` is sender's seat.
- `ack` `{ t, n }`: action sequence acknowledged to sender, including a duplicate sequence.
- `resumed` `{ t, ack }`: `ack` is the reconnecting seat's last accepted action sequence.
- `opp_dropped` `{ t, graceMs }` and `opp_back` `{ t }`: two-player disconnect and return notifications.
- `opp_left` `{ t }`: no opponent remains, or the other two-player seat leaves/expires.
- `player_dropped` `{ t, seat, graceMs }`, `player_back` `{ t, seat }`, and `player_left` `{ t, seat }`: corresponding multiplayer seat notifications.
- `pong` `{ t }`: response to application `ping`.
- `error` `{ t, reason }`: errors described in section 8.

## 3. Pairing by code

- `create` allocates a private room and returns its code to seat 0. `join` takes the next free seat; a joining client gets `waiting` until every seat is occupied. The last join starts the room. Private rooms support 2–4 seats.
- On start, every seat gets the same randomly generated 32-bit `seed` and `hostStarts`, its own `youAre`, and a unique UUID `token`. Payloads are retained by seat.
- Legacy private rooms support 2–4 seats; zone private rooms can have up to 64 seats, subject to the game's configured cap. `bye` ends that seat immediately, without a grace period. In a two-seat legacy room the other receives `opp_left`, and the room is destroyed. With 3–4 legacy seats, others receive `player_left`; the room ends when at most one remains, and that remaining player receives `opp_left`. Zone rooms use the seat notices described in section 4.

## 4. Legacy quick queue

- `queue` pairs first-in, first-out within a `(players, cadence)` queue; `players` defaults to 2. The seat order is arrival order. Different player counts and cadence settings use separate queues.
- Before a match, a queued caller receives `queued` with `estimateMs`: rounded mean wait across up to the latest 10 formed matches, or null when none exist.
- Pairing creates a `q`-prefixed internal room and sends the same `matched` fields described in section 2. Repeated queue requests while already waiting have no reply; `unqueue` removes the socket from all queues and replies `unqueued`.

### Zone rooms

- A zone room requires both `game` (a string of 1–64 characters) and `zones:true` on `create` or `queue`. `RELAY_GAMES` is a comma-separated list of `game:maxPeers` entries (for example, `royal-fiesta:64`). Each configured game's seat cap is 2–64; a room may contain 2–64 players, but never more than its game's cap. An unconfigured game returns `error` reason `unknown game`; requesting more seats than the game cap returns `room full`.
- Legacy queues remain unchanged and pair FIFO by `(players, cadence)`. Game queues are keyed by `(game, players, cadence)`. Queues for different games, player counts, or cadence values never mix, and game queues never mix with legacy queues.
- Zone rooms use `player_dropped`, `player_back`, and `player_left` with the affected seat number, including in two-player rooms; they do not use `opp_dropped` or `opp_back`. When at most one live seat remains, the last player receives `opp_left` and the room is destroyed.
- Binary frames are accepted only from a live member of a started zone room. The client-to-server frame is `0x5A`, reserved byte `0`, an unsigned 64-bit little-endian destination mask, then the payload. A set bit selects that seat index; an all-zero mask sends to every other room member. The server-to-client frame is `0x5A`, the sender's seat byte, then the payload. The sender does not receive its own frame, and disconnected or otherwise down seats are skipped.
- `RELAY_MAX_BIN_BYTES` caps the entire incoming frame, including its 10-byte header; its default is 20,000 bytes. `RELAY_BIN_RATE_PER_SEC` defaults to 2,000 frames per client in a fixed one-second window. An oversize or malformed/unauthorized binary frame is dropped and counted as invalid; the tenth invalid frame closes the socket. Exceeding the binary rate sends `error` reason `rate limited` and closes the socket. Binary rate accounting is separate from JSON message rates.
- Binary frames are not recorded in the room's resume log. Resume replays logged JSON `act` messages; a returning zone client gets the game's own snapshot through its zone protocol.

## 5. Action relay

- `act.a` must be an object or array. Nested values are bounded to depth 6, object key count 24, and array length 512; raw message size is capped at 4 KiB.
- Sequence numbers are tracked independently per seat. An omitted `n` increments that seat's number; a repeated or lower number is not relayed but is acknowledged again. Accepted actions are acknowledged to their sender and broadcast unchanged as `act` with `n` and `from` to all other occupied seats.
- The ordered replay log stores `{ side, n, a }` for accepted actions only. It retains at most 4,000 entries normally or 20,000 in cadence rooms, dropping the oldest entry beyond the bound.

## 6. Reconnection token

- At room start, the relay creates one `randomUUID` token per seat and sends it in that seat's `matched` message.
- A `resume` token replaces the socket occupying its seat; the previous socket, if different, is terminated. The relay sends `resumed` with that seat's accepted sequence in `ack`, replays eligible actions, then notifies other seats with `opp_back` or `player_back`.
- A sudden disconnect starts a `RESUME_GRACE_MS` timer, default 60,000 ms (override `RESUME_GRACE_MS`); `opp_dropped`/`player_dropped` reports the same `graceMs`. Expiry marks the seat gone. A voluntary `bye` has no grace.

## 7. Replay log

- Each accepted action records its seat (`side`), sequence (`n`) and action (`a`), in order. The log is capped at 4,000 entries, or 20,000 for cadence rooms; oldest entries are shifted out on overflow.
- `resume.have` says what the returning client has applied: a scalar applies to every other seat, while an array gives per-seat values. The relay first sends `resumed`; it then replays logged actions from other seats whose `n` is greater than that seat's `have`, as `{ t:'act', a, n, from:side }`. The returning seat's own actions are never replayed to it.

## 8. Error shape and codes

- Shape: `{ t:'error', reason: string }`.
- `server full`: socket ceiling, room ceiling, or inability to allocate a room code.
- `room not found`: join code does not identify a room.
- `room full`: no free seat or room already started.
- `bad queue payload`: queue payload fails validation.
- `resume expired`: token has no live room or its seat is already gone.
- `unknown game`: `create` or `queue` requested a zone room for a game not configured in `RELAY_GAMES`.
- `rate limited`: message rate exceeds its applicable limit; the relay then closes the socket. Defaults are 20 messages/second and 400/minute; seated cadence clients get 90/second and 4,000/minute.
- Unknown `t`, malformed JSON, invalid shape, binary frames that are not valid for a started zone-room member, and oversize frames receive no error message: they count as invalid, are silently ignored, and the tenth invalid message closes the socket.

## 9. Close behavior and codes

- Invalid-message threshold and rate limit call `ws.close` without an explicit code or reason; socket-capacity rejection also calls `ws.close` after its error. No custom WebSocket close code is specified.
- Replacing an old connection on resume and missing heartbeat use `ws.terminate`; these do not send an explicit close code.

## 10. Timers and limits expressed as time

- Resume grace: 60,000 ms by default (`RESUME_GRACE_MS` override), started on ungraceful disconnect.
- WebSocket heartbeat interval: 30,000 ms.
- Rate windows: 1,000 ms and 60,000 ms; default thresholds 20/sec and 400/minute, cadence-seat thresholds 90/sec and 4,000/minute.
- Legacy room limits remain `MAX_PLAYERS` = 4, with the same JSON rate limits above. Zone room binary rates use a separate 1,000 ms window and default to 2,000 frames/second; the default incoming binary frame cap is 20,000 bytes.
- No other timer is created for the relay protocol.

## 11. Shared `/ws` path

- The path is `/ws` per the source comments, so it shares the rooms path. A discriminator can claim a first frame when its parsed JSON object has `t` equal to one of the relay message names: `create`, `join`, `act`, `bye`, `queue`, `unqueue`, `resume`, or `ping`. No valid rooms hello `{t:'hello', v, game, name}` satisfies this rule, because its `t` value is `hello`, which is absent from that set.

## 12. Test scenario names

The legacy scenario suite (`test/relay.test.ts`) covers **51 scenarios**, in this order:

1. matchmaking: both peers receive the same seed
2. the queue payload is forwarded unchanged to the peer
3. action relayed host -> guest
4. action relayed guest -> host
5. non-object act is not relayed (peer stays silent)
6. act nested too deep is not relayed
7. oversized message (>4 KiB) ignored
8. resume token provided at matchmaking
9. abrupt disconnect -> opp_dropped (match on hold)
10. abrupt disconnect -> NO immediate opp_left
11. resume accepted (resumed + ack of my received actions)
12. missed actions replayed to the returning player
13. the peer is told of the return (opp_back)
14. action re-sent after resume -> de-duplicated
15. duel relayed normally after resume
16. list of 30 integers relayed (deck)
17. array of 900 elements refused
18. accepted action -> ack with its sequence number
19. duplicate -> re-acked (the client outbox still drains)
20. ping -> pong
21. resume -> the old socket is KILLED (no zombie)
22. action coming from a zombie socket -> never relayed
23. the duel continues after resume
24. unknown token -> "resume expired"
25. bye -> immediate opp_left (no grace period)
26. resume window expired -> opp_left
27. 10 malformed acts -> socket closed
28. flood > 20 msg/s -> "rate limited" error
29. flood > 20 msg/s -> socket closed
30. unqueue -> unqueued
31. 3-seat queue: two players are not enough to start
32. 3-seat match: seats 0/1/2 are distinct
33. 3-seat match: one single shared seed
34. 3-seat match: `players` is announced
35. 3-seat match: `opps` carries the payload of all three seats
36. 3-seat match: resume tokens are all different
37. queues are separated by format (a 1v1 is not pulled into a 4-seat queue)
38. action broadcast to BOTH other seats
39. action stamped with the sender seat (`from`)
40. independent sequence numbers per seat (n=1 from seats 1 AND 2 both pass)
41. disconnect with 3 seats -> `player_dropped` with the affected seat
42. 3-seat resume accepted
43. selective replay: only the action of the seat NOT covered by `have` comes back
44. selective replay: the already covered action is NOT replayed
45. 3-seat resume: the others are told (`player_back`)
46. one of three players leaves -> `player_left` with its seat
47. one of three players leaves -> the match is NOT over
48. the match continues between the survivors
49. last player standing -> `opp_left` (match over)
50. paced room: 45 consecutive actions pass without a disconnect
51. paced room: the ceiling still exists (200 messages at once -> disconnected)

The zone scenario suite (`test/relay.zones.test.ts`) covers **24 scenarios**, in this order:

52. zero mask broadcasts in seat order except to the sender
53. mask halves include boundary bits and ignore sender and out-of-range bits
54. 64-seat broadcast and full masks route every other seat
55. `ZoneGroup` enforces the game cap and skips empty and dropped seats
56. queue keys separate games, legacy, player counts and cadence
57. `GameQueues` takes FIFO, pops the tail, prunes and drops across lists
58. zone create and queue accept up to 64 players with paired game and zones fields
59. resume `have` keeps its legacy scalar and array validation
60. zone config parses game caps and sets only explicitly supplied environment fields
61. 64-seat zone room matches every seat and routes masks across both halves
62. binary requires a seated member of a started zone room and counts invalid frames
63. malformed binary frames are invalid and never relayed
64. binary size cap includes the input header and accepts exactly the cap
65. binary uses a fixed one-second window per client independently of JSON rate limits
66. binary defaults allow the configured default rate without consuming the JSON budget
67. zone create and queue refuse unknown games and seats above the game cap
68. game queues and legacy queues form separate rooms with binary routing only inside the game
69. game queues retain FIFO estimates and remove unqueued or disconnected clients
70. server full pops only the new waiter and preserves the first queued client
71. two-seat zones use seat notices on drop, resume and grace expiry before `opp_left`
72. zone resume rebinds a live seat and binary history is absent from JSON replay
73. zone seats that leave gracefully stop receiving binary while remaining seats keep routing
74. relay endpoint forwards binary frames into the connected zone room
75. handshake passes configured zone games and binary caps through the shared endpoint

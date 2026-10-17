# GameNet relay protocol reference

Source: the implementation in `src/relay/` (`protocol.ts`, `hub.ts`, `endpoint.ts`); scenario tests in `test/relay.test.ts` and `test/relay.hub.test.ts`. Fields below are JSON fields; all message types use `t`.

## 1. Endpoint

- The source comments identify the WebSocket route as `/ws`; `new WebSocketServer({ server })` does not configure a path filter. There are no relay query parameters or query handling; the server attaches to HTTP upgrades without examining their URL.
- The server does not set a `maxPayload` option. Application input is limited to 4 KiB (`MAX_MSG_BYTES`). Binary or larger messages count as invalid and are ignored; the tenth invalid message closes the socket.
- Protocol field: `t`.
- WebSocket heartbeat: every 30,000 ms the server sends a control ping; a pong marks the socket alive. A socket still marked dead on the next interval is terminated.

## 2. Client and server messages

Client messages (validation and handling: ):

- `create` `{ t, players?, cadence?, payload? }`. `players` is 2–4 (default 2); `cadence` is boolean; payload is stored as the creator's seat payload. Reply: `{ t:'room', code }`, or `{ t:'error', reason:'server full' }`.
- `join` `{ t, code, payload? }`. Reply on a missing code: `error` reason `room not found`; no free seat or already-started room: `error` reason `room full`; an incomplete room: `{ t:'waiting', seat, players }`; when full, all seats receive `matched` (fields below).
- `queue` `{ t, players?, cadence?, payload? }`. Same player-count and cadence constraints as `create`; payload may be absent/null or a shallow-enough object. A waiting caller receives `{ t:'queued', estimateMs }` (estimate is null until there are completed pairings). When the format queue reaches `players`, all seats receive `matched`. Invalid payload gives error reason `bad queue payload`; room capacity gives `server full`.
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
- `bye` ends that seat immediately, without a grace period. In a two-seat room the other receives `opp_left`, and the room is destroyed. With 3–4 seats, others receive `player_left`; the room ends when at most one remains, and that remaining player receives `opp_left`.

## 4. Legacy quick queue

- `queue` pairs first-in, first-out within a `(players, cadence)` queue; `players` defaults to 2. The seat order is arrival order. Different player counts and cadence settings use separate queues.
- Before a match, a queued caller receives `queued` with `estimateMs`: rounded mean wait across up to the latest 10 formed matches, or null when none exist.
- Pairing creates a `q`-prefixed internal room and sends the same `matched` fields described in section 2. Repeated queue requests while already waiting have no reply; `unqueue` removes the socket from all queues and replies `unqueued`.

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
- `rate limited`: message rate exceeds its applicable limit; the relay then closes the socket. Defaults are 20 messages/second and 400/minute; seated cadence clients get 90/second and 4,000/minute.
- Unknown `t`, malformed JSON, invalid shape, binary frames, and oversize frames receive no error message: they count as invalid, are silently ignored, and the tenth invalid message closes the socket.

## 9. Close behavior and codes

- Invalid-message threshold and rate limit call `ws.close` without an explicit code or reason; socket-capacity rejection also calls `ws.close` after its error. No custom WebSocket close code is specified.
- Replacing an old connection on resume and missing heartbeat use `ws.terminate`; these do not send an explicit close code.

## 10. Timers and limits expressed as time

- Resume grace: 60,000 ms by default (`RESUME_GRACE_MS` override), started on ungraceful disconnect.
- WebSocket heartbeat interval: 30,000 ms.
- Rate windows: 1,000 ms and 60,000 ms; default thresholds 20/sec and 400/minute, cadence-seat thresholds 90/sec and 4,000/minute.
- No other timer is created for the relay protocol.

## 11. Shared `/ws` path

- The path is `/ws` per the source comments, so it shares the rooms path. A discriminator can claim a first frame when its parsed JSON object has `t` equal to one of the relay message names: `create`, `join`, `act`, `bye`, `queue`, `unqueue`, `resume`, or `ping`. No valid rooms hello `{t:'hello', v, game, name}` satisfies this rule, because its `t` value is `hello`, which is absent from that set.

## 12. Test scenario names

The scenario suite (`test/relay.test.ts`) covers **51 scenarios**, in this order:

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

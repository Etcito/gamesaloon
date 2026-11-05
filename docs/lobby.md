# Timed lobbies

Source: `src/lobby/` (`lobby.ts` pure state, `messages.ts`, `service.ts` the relay extension), wired in
`src/handshake.ts`; tests in `test/lobby.test.ts`. The lobby is an extension on the relay socket (`/ws`):
it adds message types and never changes the relay protocol (`docs/RELAY.md`) or the match protocol.
The legacy `queue` (exact party size, FIFO) keeps working as before.

## Rule

- The first player of a format (`game`, `seats`, `cadence`) opens a lobby. Its wait starts then:
  `LOBBY_WAIT_MS` (default 60000). A later arrival never resets it.
- When the wait ends, the round starts with whoever is seated, if at least `LOBBY_MIN_PLAYERS`
  (default 1: games fill the empty places with bots). A lobby that fills every seat starts at once.
- A player who enters is never asked anything: they are seated in the oldest waiting lobby of the
  format with a free seat; if every lobby is playing or full, or there is none, they open a new empty
  lobby (they wait for others; bots fill after the wait). A lobby whose round started is never joined.
- Spectating is an explicit request only: `lobby_enter` with `spectate: true` watches the lobby the
  player would have joined (else the oldest one, waiting or playing); with no lobby it opens one.
- The old question (join / spectate / new, `lobby_choice` then `lobby_pick`) is kept for clients that
  ask for it with `lobby_enter { choice: true }`; the default is the automatic join above.
- A lobby ends when its round's relay session ends, or when its last player leaves before the start.
- Spectators are never seated: they are not rollback peers, their `act`s go nowhere, peers get no seat
  event about them. They receive a copy of the round's act stream.

## Messages

Client to server:

| type | fields | effect |
| --- | --- | --- |
| `lobby_enter` | `game` (1-64 chars), `seats` (1-4, the lobby's max seats), `cadence?` (bool), `payload?` (object, <= 512 JSON chars: the seat payload, e.g. `{g, v, name, c}`), `spectate?` (bool, default false: watch instead of playing), `choice?` (bool, default false: legacy, answer with `lobby_choice` when lobbies exist), `zones?` (bool, default false: the round starts as a relay zone room of `game`, binary zone traffic between its seats; the game needs a `RELAY_GAMES` cap, else `lobby_error unknown game`; zones and legacy lobbies never mix) | Joins the waiting lobby with a free seat, else opens a new one; replies `lobby_state`. With `spectate`: spectator `lobby_state` (+ `lobby_watch` on a playing lobby). With `choice` and lobbies of that format existing: replies `lobby_choice` instead. |
| `lobby_pick` | `action`: `join` \| `spectate` \| `new`; `id` (required for join/spectate) | Answers the last `lobby_choice` (only sent for `choice: true`). |
| `lobby_leave` | | Leaves the lobby (player or spectator) and forgets a pending choice. Reply `lobby_left`. |
| `lobby_presence` | `a` (object, <= 16 keys, <= 256 JSON chars: the sender's hub avatar state, opaque to the server) | Shared hub presence, see below. Never answered; dropped silently outside a lobby or from a seated socket. |

Server to client:

| type | fields |
| --- | --- |
| `lobby_choice` | only for `lobby_enter { choice: true }`: `lobbies: [{ id, phase: 'waiting'\|'playing', players, seats, startsInMs, actions: ('join'\|'spectate')[], names: payload[] }]`, oldest first |
| `lobby_state` | `id, phase, role: 'player'\|'spectator', seat` (index among players, -1 for a spectator), `players: payload[], seats, startsInMs, waitMs`, and (added for presence, ignored by older clients) `you` (this client's presence key) and `members: [{ k, role, p }]` (the roster: players in seat order, then spectators in arrival order; `p` is the payload each sent with `lobby_enter`). Sent to players and spectators on every join or leave of a player or spectator while waiting, to spectators when a spectator comes or goes in a playing lobby, and to spectators when the round starts. Clients count `startsInMs` down locally. |
| `lobby_presence` | `id, from` (the sender's presence key), `a` (its state, verbatim) |
| `lobby_watch` | to spectators when the round starts (or when they start watching a playing lobby): `id, session, seed, players, opps: payload[], replay` (false when the relay log was truncated: no replay from the start is possible) |
| `lobby_act` | `id, a, n, from`: every act of the round, the replay first (when `replay`), then live |
| `lobby_closed` | `id, reason: 'ended'\|'empty'` to spectators |
| `lobby_left` | reply to `lobby_leave` |
| `lobby_error` | `reason`: `not_entered`, `unknown_lobby`, `lobby_closed` (join on a started or full lobby), `in_session` (the socket is seated in a relay session), `server full`, `unknown game` (`zones: true` for a game without a `RELAY_GAMES` cap) |

When the round starts, the **players** get the relay's usual `matched` frame (`seed, hostStarts, youAre,
token, players, opps`), exactly as from `queue`: `players` is the number of seated players (1-4), which
may be less than the lobby's `seats`. Everything after (acts, resume, `player_left`, `bye`) is the
unchanged relay protocol.

A server without this extension counts `lobby_enter` as one invalid frame and replies nothing: a client
can fall back to `queue` after a short silence.

## What a client must handle

- Variable player count: build the round from `matched.players`, not from the requested `seats`.
- A one-player round (`players: 1`): no remote peer; the game fills the rest with bots.
- No choice screen: `lobby_enter` lands the player in a lobby. A client that still receives a
  `lobby_choice` (a server older than this rule never sends one to a client that does not ask) answers
  at once with its default (join a waiting lobby, else new); Royal Fiesta does.
- Spectating: `lobby_state` gives the waiting room and countdown; `lobby_watch` + `lobby_act` carry
  the round's seed and every act from seat `from` (for a rollback game: the peers' packets). Replaying
  the round from them needs an observer mode in the game's rollback session (a session that receives
  every peer's packets and sends nothing); until a game has one, it shows the lobby status only.

## Shared hub presence

Every member of a lobby (players and spectators) can be drawn in one shared hub scene, whatever the
lobby's size: presence is owned by the lobby, not by a relay room, so it uses no relay session and is
not capped by the relay's 4 seats.

- Each player and spectator gets a presence key (`you` in its `lobby_state`): an integer unique in the
  lobby, given in arrival order, never reused. `members` maps keys to roles and payloads (names, colours).
- A client sends its avatar state as `lobby_presence { a }` at its own cadence (Royal Fiesta: 5 Hz, the
  same as its old hub room). The server relays it as `lobby_presence { id, from, a }` to every other
  member of the same lobby that is not seated in a round and that has sent presence itself: a client
  that never sends presence never receives it, so older clients see no new frame.
- Seated sockets (the round is on) neither send nor receive presence; spectators of a playing lobby
  keep seeing each other. A key that leaves `members` is gone: the client removes that avatar.
- The relay's per-socket rate limit (20/s, 400/min) bounds each sender; `a` is at most 256 JSON chars.
- Names are whatever the client put in its payload; the server adds nothing (no account id, no address).

## Relay seams used

`RelayHub.use(ext)` (several extensions), `RelayHub.startGroup(conns, payloads, { cadence })` (a 1-4 seat
session with `matched` frames, returns `{ session, seed }`), `RelayHub.watch(session)` (the act log for a
replay, or null), and the optional `RelayExtension.sessionAct` hook (every accepted act).

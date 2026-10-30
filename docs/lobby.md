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
- A player who arrives while lobbies of the same format exist gets a choice: **join** a waiting lobby
  with a free seat, **spectate** a lobby (waiting or playing), or open a **new** empty lobby.
  A lobby whose round started is spectate-only.
- A lobby ends when its round's relay session ends, or when its last player leaves before the start.
- Spectators are never seated: they are not rollback peers, their `act`s go nowhere, peers get no seat
  event about them. They receive a copy of the round's act stream.

## Messages

Client to server:

| type | fields | effect |
| --- | --- | --- |
| `lobby_enter` | `game` (1-64 chars), `seats` (1-4, the lobby's max seats), `cadence?` (bool), `payload?` (object, <= 512 JSON chars: the seat payload, e.g. `{g, v, name, c}`) | No lobby of that format: opens one, replies `lobby_state`. Otherwise replies `lobby_choice`. |
| `lobby_pick` | `action`: `join` \| `spectate` \| `new`; `id` (required for join/spectate) | Answers the last `lobby_choice`. |
| `lobby_leave` | | Leaves the lobby (player or spectator) and forgets a pending choice. Reply `lobby_left`. |

Server to client:

| type | fields |
| --- | --- |
| `lobby_choice` | `lobbies: [{ id, phase: 'waiting'\|'playing', players, seats, startsInMs, actions: ('join'\|'spectate')[], names: payload[] }]`, oldest first |
| `lobby_state` | `id, phase, role: 'player'\|'spectator', seat` (index among players, -1 for a spectator), `players: payload[], seats, startsInMs, waitMs`. Sent to players and spectators on every join or leave while waiting, and to spectators when the round starts. Clients count `startsInMs` down locally. |
| `lobby_watch` | to spectators when the round starts (or when they start watching a playing lobby): `id, session, seed, players, opps: payload[], replay` (false when the relay log was truncated: no replay from the start is possible) |
| `lobby_act` | `id, a, n, from`: every act of the round, the replay first (when `replay`), then live |
| `lobby_closed` | `id, reason: 'ended'\|'empty'` to spectators |
| `lobby_left` | reply to `lobby_leave` |
| `lobby_error` | `reason`: `not_entered`, `unknown_lobby`, `lobby_closed` (join on a started or full lobby), `in_session` (the socket is seated in a relay session), `server full` |

When the round starts, the **players** get the relay's usual `matched` frame (`seed, hostStarts, youAre,
token, players, opps`), exactly as from `queue`: `players` is the number of seated players (1-4), which
may be less than the lobby's `seats`. Everything after (acts, resume, `player_left`, `bye`) is the
unchanged relay protocol.

A server without this extension counts `lobby_enter` as one invalid frame and replies nothing: a client
can fall back to `queue` after a short silence.

## What a client must handle

- Variable player count: build the round from `matched.players`, not from the requested `seats`.
- A one-player round (`players: 1`): no remote peer; the game fills the rest with bots.
- The choice: a screen with join / spectate / new. A client may pick a default by itself after a few
  seconds (Royal Fiesta: join a waiting lobby, else a new lobby).
- Spectating: `lobby_state` gives the waiting room and countdown; `lobby_watch` + `lobby_act` carry
  the round's seed and every act from seat `from` (for a rollback game: the peers' packets). Replaying
  the round from them needs an observer mode in the game's rollback session (a session that receives
  every peer's packets and sends nothing); until a game has one, it shows the lobby status only.

## Relay seams used

`RelayHub.use(ext)` (several extensions), `RelayHub.startGroup(conns, payloads, { cadence })` (a 1-4 seat
session with `matched` frames, returns `{ session, seed }`), `RelayHub.watch(session)` (the act log for a
replay, or null), and the optional `RelayExtension.sessionAct` hook (every accepted act).

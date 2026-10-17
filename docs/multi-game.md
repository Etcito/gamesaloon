# Several games on one server

A "game" is just a string: the `game` field of `hello` (rooms), of `auth` and of `match_queue` (matchmaking), 1 to 64 characters. This page describes what the server does with it, from a single shared namespace up to the opt-in multi-creator mode. Everything here is as implemented in `src/store/games.ts`, `src/store/setup.ts`, `src/store/gamesettings.ts`, `src/store/config.ts` and `src/handshake.ts`.

## Three modes

| Mode | How it is selected | What a "game" is |
|---|---|---|
| **Shared** | `PLAYER_STORE=memory` (default), or an embedder passing one `PlayerStore` | only a label. Any game name is accepted; all games share one player list; both queues are offered; no per-game limits |
| **Per-game stores** | `PLAYER_STORE=http` with `ETCITO_GAME_KEYS` | a configured game with its own player list, ratings, economy, saves and settings |
| **Multi-creator** | `PLAYER_STORE=http` with `ETCITO_GAME_KEYS_FILE` | per-game stores, plus a game registry that is hot-reloaded, caps on creator games, and a strict `hello` |

Multi-creator mode is entirely opt-in: without `ETCITO_GAME_KEYS_FILE` none of its rules apply.

## What `game` does in every mode

- **Rooms**: a room belongs to the `game` of its creator. `join` fails with `game_mismatch` if the joiner's `hello.game` differs, and `list` shows only rooms of the caller's game. Use the game's build or version string here if you want players on different versions kept apart.
- **Ratings**: ratings are stored per player and per `game` string, in every mode.
- **Matchmaking**: players only pair with players waiting in the same `(game, queue)`.

## Per-game stores

With `PLAYER_STORE=http`, `ETCITO_GAME_KEYS` is a JSON object `{"<game>": "gsk_..."}`: one service key per game. Each key gives access to that game's own data on the remote table service ([stores.md](stores.md)), so:

- Each game has its own players, ratings, wallets, collections, saves and content. The same Wavedash user in two games is two unrelated players with two unrelated economies.
- `auth` takes an optional `game`. With exactly one configured game it may be omitted; with several it is required, otherwise `bad_message`. An unknown (or disabled) game is also `bad_message`. A later `match_queue.game` must equal the game the connection authenticated into (else `bad_message`).
- A game's `etc_game` row (one row per game on the table service) holds its parameters: `handshake_game` (must equal the game name if non-empty), `elo_start` (default 2500), `elo_k_floor` (32), `placement_games` (5) and `queues` (JSON array of `"quick"` and/or `"ranked"`, default both; a queue not listed answers `bad_queue`). The server reads them at start-up and every 60 seconds; an unreadable row or an invalid value keeps the previous (or default) parameters and logs an error. Valid ranges: `elo_start` 0..100000, `elo_k_floor` 1..160, `placement_games` 0..100.
- A key that reads a row whose `handshake_game` names another game is a wrong-key mistake: in this mode the server refuses to start (`[config] game "<game>": ...`).
- Rooms are not restricted: any `hello.game` string may open rooms, as in shared mode.

## Multi-creator mode

Meant for a host that serves games from several independent creators. Turn it on with `ETCITO_GAME_KEYS_FILE=/path/to/game-keys.json` (it replaces `ETCITO_GAME_KEYS`).

### The registry file

The file holds the same JSON object as `ETCITO_GAME_KEYS`, nothing else:

```json
{
  "game-one": "gsk_...",
  "game-two": "gsk_..."
}
```

Rules (`loadStoreConfig`): every value is a string starting with `gsk_`, two games never share a key, at least one game, names 1 to 64 characters. For the webhook route `/webhooks/stripe/<game>` to be reachable a name must match `[a-z0-9_-]{1,64}`.

- Read at start-up (an unreadable or invalid file stops the server) and then **every 30 seconds**. An unreadable or invalid update keeps the previous registry and logs one error line without the content.
- Only changes are applied: a new name is opened, a changed key rebuilds that game, a removed name closes that game. A game whose key did not change keeps its live state (locks, caches, listeners), so adding a game never disturbs the others.
- Replace the file atomically (write a temporary file in the same directory, then rename it).
- This repository has no API to edit the registry; you (or your own tooling) write the file.

### Creator games and owner games

Owner games are **configuration**: set `OWNER_GAMES` to a comma-separated list of game names (trimmed, lowercased; for example `OWNER_GAMES=my-game,other-game`). The default is **empty**: a fresh install has no owner games, so every game is a creator game and gets the caps below. A game named in `OWNER_GAMES` is exempt from the creator caps and keeps the established limits (the table below), uses the service user's HOME in the publisher, and is the only kind of game the legacy Stripe endpoint verifies. Restart the server after changing it. Outside multi-creator mode the setting has no effect on rooms and matchmaking. Embedders can call `setOwnerGames([...])` (exported from the package) instead of using the environment.

In this mode every game is either an *owner game* (listed in `OWNER_GAMES`) or a *creator game* (every other name).

| | Owner game | Creator game |
|---|---|---|
| `etc_game.handshake_game` | if non-empty, must equal the name; a mismatch disables the game | must equal the name; empty or different disables the game |
| Rooms | only the server-wide `MAX_ROOMS` | `min(etc_settings limits.max_rooms, ETCITO_CREATOR_MAX_ROOMS)`; the setting may lower the ceiling, never raise it. Default ceiling 10 |
| Saves and content limits | `etc_settings` values | `etc_settings` values, each capped (below) |
| Economy catalog size | unbounded | at most 1 MiB |

A creator game is also disabled (and its players get `bad_message` on `auth`) while its `etc_game` row is missing.

### Caps on creator games

The platform ceilings come from `creatorCaps` in `src/store/games.ts`. Each limit of [online-data.md](online-data.md) is the minimum of the creator's `etc_settings` value (or the default) and this ceiling. With `T` = `ETCITO_CREATOR_STORAGE_MAX_BYTES` (default 50 MiB = 52428800):

| Limit | Ceiling |
|---|---|
| `saves.max_bytes` | 196608 |
| `saves.quota_bytes` | `floor(T / 5)` |
| `saves.max_keys` | 32 |
| `saves.writes_per_minute` | 60 |
| `ugc.max_bytes` | 196608 |
| `ugc.quota_bytes` | `T - floor(T / 5)` |
| `ugc.max_items` | 100 |
| `ugc.writes_per_minute` | 30 |

Rooms: `ETCITO_CREATOR_MAX_ROOMS` (default 10). The check happens at `create`; when a game is at its cap the error is `server_full` with the message "no room available for this game".

### Strict `hello`

In multi-creator mode, `hello` and `create` with a game that is not configured, or that is disabled, are refused with `bad_message` ("unknown game"). In the other modes any game name may open rooms.

### Payments

- `POST /webhooks/stripe/<game>` is verified with that game's own service key and requires the Checkout metadata `game` to equal `<game>`. The legacy `POST /webhooks/stripe` accepts only owner games when owner games are configured.
- A Wavedash receipt is routed to the game whose enabled `wavedash` row in `etc_publishers` lists the receipt's audience. If several games claim one audience, an owner game wins; otherwise the receipt is refused (`ambiguous_game`, HTTP 400). Details: [economy.md](economy.md).

## What is not implemented

- No registry admin API, no creator onboarding flow and no billing in this repository: those belong to the hosted service built on GameSaloon (Etcito).
- Clients are not authenticated per game: any client can name any configured game in `auth`; the game's players are identified by their provider identities (guest token, Wavedash user).
- No horizontal scaling: locks and rate counters are in process, so run one instance per set of tables.

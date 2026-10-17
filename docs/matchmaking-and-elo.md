# Matchmaking and ELO

How the queues, pairing, results and ratings work, as implemented in `src/match/` and `src/store/elo.ts`. The wire messages are in [protocol.md](protocol.md#matchmaking-messages).

## Overview

1. A client connects to `/ws` and sends `auth`. The server resolves the identity, finds or creates the player in the game's store and replies `authed`.
2. The client sends `match_queue` with a `game` and a `queue` (`quick` or `ranked`). The server replies `match_queued` (with the player's current rating) and tries to pair.
3. When two players are paired, both receive `match` (with a seat, 0 or 1, and the opponent), immediately followed by the relay's `matched` frame. From then on the two connections share a relay session: `act` messages are relayed between them (see [RELAY.md](RELAY.md)). What the `act` payload means is up to your game.
4. Each client reports the result with `result`. The server replies `result_ack`; when it can decide, both receive `match_end`.

The pairing loop runs when a player enters the queue and on a one-second tick.

## Authentication

- `guest`: the token is 16 to 128 characters of `[A-Za-z0-9_-]`. The player's external id is the SHA-256 of the token, so the same token always means the same player. The display name is the supplied `name` if it is 3 to 16 characters after trimming, else `Guest-` plus four uppercase hex characters of the hash (`guestIdentity` in `src/hooks.ts`).
- `wavedash`: under `npm start`, the token is the Wavedash user JWT; it is verified against Wavedash's JWKS (issuer `https://auth.wavedash.com`, audience `gameplay.wavedash.com`, RS256) and the Wavedash user id becomes the external id (`src/economy/wavedash.ts`). This needs outbound HTTPS to Wavedash.
- `itch`: no verifier ships. `npm start` answers `auth_unavailable`. An embedder can supply one (below).
- Embedding: a `hooks.verifyIdentity(provider, token, name, game)` function decides every provider; returning `null` or throwing answers `auth_failed`. Throwing `ProviderNotConfiguredError` (exported from `src/identity.ts`) answers `auth_unavailable`. `verifyIdentityHook(defaultVerifiers({ ... }))` builds such a hook from one verifier per provider. A verified identity whose `provider` differs from the requested one is refused. Without any `verifyIdentity` hook, only `guest` works.

One player can have several identities in the data model, but the server creates a player per identity: it never links two identities by itself.

## Queues

| Queue | Rated | Pairing |
|---|---|---|
| `quick` | no | first in, first out among players waiting for the same `game` |
| `ranked` | yes | closest rating first, inside a window that widens with waiting time |

A game can restrict which queues it offers; asking for another one is answered `bad_queue` (see [multi-game.md](multi-game.md); the default is both).

A connection can wait in one queue at a time (`already_queued`), cannot queue while seated in a match or relay session (`in_match`), and a `resident` player cannot queue (`resident_cannot_queue`). `match_unqueue` leaves the queue. Closing the connection also removes the waiter.

### Ranked pairing

- The window is `100 + 100 * floor(waitMs / 5000)` rating points (`rankedWindow` in `src/match/matchmaker.ts`): 100 at first, 200 after 5 s, 300 after 10 s, and so on, without a maximum.
- Two waiters are compatible when their rating gap is at most the larger of their two windows.
- Among compatible candidates the smallest gap wins; on equal gaps the one that has waited longest. A player is never paired with themselves (two connections of one player).
- Pairing happens per `(game, queue)`.

### Ranked lock

A player can be in one ranked match at a time. When a ranked pair forms, the server takes a lock for both players in the store (`lockRanked`). If either lock is refused, the busy player gets `ranked_busy` and the other goes back to the queue. The lock is released when the result is applied or the match ends void. A player who still holds a lock when asking for a ranked queue gets `ranked_busy` immediately.

### Resident opponents

If an embedder supplies `hooks.pickResident(game, queue, rating)`, a waiter that has waited 8 seconds (quick) or 15 seconds (ranked) is offered a resident: the hook returns a `ResidentSeat` or `null` (retried at the next tick). The resident is a player of kind `resident` in the store; the server connects it through the seat's `socket` and `sink` as if it were a normal client, and the match is played and rated like any other. A resident is never paired with a resident and never queues itself. `npm start` sets no `pickResident`: no resident exists by default.

## Results

Both players send `result` with their own outcome: `win`, `loss` or `draw`.

- The outcomes must be consistent: win with loss, or draw with draw. The match is then `complete`. Anything else (win with win, loss with loss, win with draw, ...) is a disagreement: status `void`, reason `disagreement`, no rating change.
- A second report that does not arrive within 60 seconds of the first makes the match `void` (`no_report`).
- A player who reports twice gets `already_reported`; a player who is not in the match, or a wrong id, gets `unknown_match`.
- After a decision each connection receives `match_end` with its own `outcome` (`null` when void) and, for a ranked match that applied a result, `rating: { before, after, games, placement }`.
- The server calls `hooks.onMatchEnd(record)` for every ended match. The `MatchRecord` (see `src/hooks.ts`) has the match id, game, queue, the two player ids, which seats were residents, status, reason (`agreed`, `disagreement`, `no_report`, `disconnect`, `both_disconnected`), the two reports, the score, the rating changes and timestamps.

A `complete` match does not end the relay session by itself: the clients decide when to close. The server ends the session (the other side receives `opp_left`) for a forfeit, a missing report and a both-absent void.

### Disconnects and forfeits

When a seated player's connection drops, the player has 90 seconds (`FORFEIT_MS`) to come back with the relay's `resume` token (the `token` field of `matched`). If a seat is still absent after 90 seconds, that player forfeits: status `forfeit`, the absent player scores a loss, the other a win, and a ranked match is rated normally. If both seats are absent, the match is `void` (`both_disconnected`). The relay keeps the seat for the same duration for matches created by the match service.

### Store failures

If a store call fails, the affected request is answered `store_unavailable`. If applying a ranked result fails, the match stays pending and the server retries on later ticks; both players receive `store_unavailable` each time it fails.

## Rating

Implemented in `src/store/elo.ts` and applied by the store's `applyRankedResult`.

- Start rating: 2500 (per player and per game). Only ranked matches change it.
- Expected score: `E = 1 / (1 + 10^((r_opp - r) / 400))`.
- New rating: `max(0, round(r + K * (S - E)))`, with `S` = 1 for a win, 0.5 for a draw, 0 for a loss.
- Elastic K, using the player's number of rated games before this match (`games`): `K = 160` while `games < 5` (placement), then `K = max(32, 160 - 16 * games)`. So K is 80 at 5 games, 64 at 6, 48 at 7 and 32 from the 8th game on.
- Placement: the first 5 ranked games. `placement` is `true` in `match_queued` and `match_end` until the player has played them.
- Worked example (from the tests): two new players, one wins: 2580 and 2420.
- The ELO start value, the K floor and the number of placement games are parameters of a game (defaults 2500, 32 and 5). With the table-API store they are read from the game's `etc_game` row and refreshed every 60 seconds (columns `elo_start`, `elo_k_floor`, `placement_games`); with the memory store they are the defaults.
- A ranked result is applied once per match id (`applied: false` on a replay). Both players are updated with their own prior game count.

### Tiers and display

`TIERS` in `src/store/elo.ts`:

| Tier | From |
|---|---|
| Bronze | 0 |
| Gold | 1600 |
| Platinum | 2200 |
| Diamond | 2800 |
| Master | 3400 |

`displayRating(rating, placement)` returns `null` while in placement, `"< 500"` below 500, otherwise the number as text. The server does not send tiers in match messages; they appear in leaderboard entries of the store (`tierOf`). Clients can compute a tier from the rating with the table above.

### Leaderboard

`PlayerStore.leaderboard(game, page)` returns 50 entries per page ordered by rating then player id, excluding players still in placement, with rank and tier. There is no WebSocket message for it: a host reads it through the store (see [stores.md](stores.md)).

## Achievements fed by matches

When a ranked or quick match ends with a decided score, the server emits a `match_end` event to the achievements service of the game (see [online-data.md](online-data.md)). Void matches emit nothing.

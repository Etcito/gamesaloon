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

### Ranked guest gate

By default a `guest` may queue `ranked`: the server option `rankedRequireAccount` is off when `RANKED_REQUIRE_ACCOUNT` is unset. `RANKED_REQUIRE_ACCOUNT=1` (or `true`) turns it on; `deploy/rooms.env.example` sets `1` for production. With the gate on, a `match_queue` for `queue: 'ranked'` from a `guest` is answered `ranked_requires_account` and the player is not queued. `quick` is unaffected. Reading the ladder stays open to guests (their `me` is `null`).

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

When the match service starts, it reaps the locks left by a previous process: `MatchService.start()` calls `store.reapRankedLocks(active)` on every store the router serves, with `active` = the live match ids (empty at boot). The count is logged as `[match] reaped N stale ranked locks`; a store failure is logged and does not stop the others, so the boot never fails on it.

### Resident opponents

If an embedder supplies `hooks.pickResident(game, queue, rating)`, a waiter that has waited 8 seconds (quick) or 15 seconds (ranked) is offered a resident: the hook returns a `ResidentSeat` or `null` (retried at the next tick). The resident is a player of kind `resident` in the store; the server connects it through the seat's `socket` and `sink` as if it were a normal client, and the match is played and rated like any other. A resident is never paired with a resident and never queues itself. `npm start` sets no `pickResident`: no resident exists by default.

## Results

Both players send `result` with their own outcome: `win`, `loss` or `draw`.

- The outcomes must be consistent: win with loss, or draw with draw. The match is then `complete` (`agreed`). Anything else (win with win, loss with loss, win with draw, ...) is a disagreement: status `void`, reason `disagreement`, no rating change.
- A second report that does not arrive within 60 seconds (`RESULT_WAIT_MS`) of the first ends the match: a lone `draw` report is a `complete` match with reason `lone_draw` (below), any other lone report makes it `void` (`no_report`).
- A player who reports twice gets `already_reported`; a player who is not in the match, or a wrong id, gets `unknown_match`.
- After a decision each connection receives `match_end` with its own `outcome` (`null` when void), the `reason`, `weight` (`1`, or `0.5` when the match lasted less than 180000 ms), `duration_ms`, `rewardable`, and, for a ranked match that applied a result, `rating: { before, after, games, placement, tier }` where `tier` is `tierOf(after)`.
- The server calls `hooks.onMatchEnd(record)` for every ended match (see [Match records](#match-records)).

A `complete` match does not end the relay session by itself: the clients decide when to close. The server ends the session (the other side receives `opp_left`) for a forfeit, a missing report, a both-absent void, an inactivity void, a lone draw and a graceful leave.

### Graceful leave

A seated client that leaves with the relay's `bye` forfeits when the match is not decided yet and that player has not reported: status `forfeit`, reason `left`, and the leaver loses with the same seat-to-score mapping as a disconnect forfeit (seat 0 → `score_a` 0, seat 1 → `score_a` 1). The decision is taken synchronously, so the session end that follows does nothing. A leaver who already reported is left alone: the normal 60-second report window still applies to the other seat. The session ends and the remaining player receives `opp_left`.

### Inactivity and lone draw

The bye forfeit above, the inactivity void and the lone-draw loss are ranked-only rules. A `quick` (casual) match behaves as before: a `bye` does not forfeit, a lone `draw` report ends `void` (`no_report`), and there is no inactivity void.

The tick decides two more endings for a match that is not already decided:

- **Inactivity**: if neither seat has acted or reported for 600000 ms (10 minutes), the match is `void` with reason `inactivity`, no rating change and both locks released. The condition is `now - lastActivityAt >= 600000` together with no report inside that span (`firstReportAt` is null, or `now - firstReportAt >= 600000`). The check is inclusive: it fires at exactly 600000 ms, not at 599999.
- **Lone draw**: when the 60-second report window lapses with exactly one report and that report is `draw`, the match is `complete` with reason `lone_draw`. The reporter takes the loss and is the only side rated (`only` = the reporter's side); the opponent's rating and game count are unchanged. The reporter still sees `outcome: 'loss'`, the opponent sees `outcome: 'win'`. Other lone reports stay `void no_report`.

### Match records

Every ended match is written to the store table `etc_matches` as one row keyed by `match_id` (`game`, `queue`, `status`, `reason`, `ended_at` and the full `record` JSON). `recordMatch` is idempotent: a replay of the same `match_id` returns `{ applied: false }` and writes nothing. The write happens after the `match_end` frames and before `hooks.onMatchEnd`; a store failure is logged (`[match] recordMatch failed for <match_id>`) and never blocks the end, the ladder invalidation or the hook. The `MatchRecord` (see `src/hooks.ts`) has the match id, game, queue, the two player ids, which seats were residents, status, reason (`agreed`, `disagreement`, `no_report`, `disconnect`, `both_disconnected`, `left`, `lone_draw`, `inactivity`), the two reports, `score_a`, the rating changes, `started_at`, `ended_at`, `duration_ms`, `weight` and `rewardable`.

### Disconnects and forfeits

When a seated player's connection drops, the player has 90 seconds (`FORFEIT_MS`) to come back with the relay's `resume` token (the `token` field of `matched`). If a seat is still absent after 90 seconds, that player forfeits: status `forfeit`, the absent player scores a loss, the other a win, and a ranked match is rated normally. If both seats are absent, the match is `void` (`both_disconnected`). The relay keeps the seat for the same duration for matches created by the match service.

### Store failures

If a store call fails, the affected request is answered `store_unavailable`. If applying a ranked result fails, the match stays pending and the server retries on later ticks; both players receive `store_unavailable` each time it fails.

## Rating

Implemented in `src/store/elo.ts` and applied by the store's `applyRankedResult`.

- Start rating: 2500 (per player and per game). Only ranked matches change it.
- Expected score: `E = 1 / (1 + 10^((r_opp - r) / 400))`.
- New rating: `max(0, round(r + weight * K * (S - E)))`, with `S` = 1 for a win, 0.5 for a draw, 0 for a loss. `weight` is 1, or 0.5 when the match lasted less than `RANKED_MIN_MS` = 180000 ms (`SHORT_WEIGHT`); `nextRating` takes it as an optional argument.
- Elastic K, using the player's number of rated games before this match (`games`): `K = 160` while `games < 5` (placement), then `K = max(32, 160 - 16 * games)`. So K is 80 at 5 games, 64 at 6, 48 at 7 and 32 from the 8th game on.
- Placement: the first 5 ranked games. `placement` is `true` in `match_queued` and `match_end` until the player has played them.
- Worked example (from the tests): two new players, a match of at least 180000 ms, one wins: 2580 and 2420. The same match ended before 180000 ms counts at half weight: 2540 and 2460.
- The ELO start value, the K floor and the number of placement games are parameters of a game (defaults 2500, 32 and 5). With the table-API store they are read from the game's `etc_game` row and refreshed every 60 seconds (columns `elo_start`, `elo_k_floor`, `placement_games`); with the memory store they are the defaults.
- A ranked result is applied once per match id (`applied: false` on a replay). Both players are updated with their own prior game count.

### Rewardable

`match_end.rewardable` is `true` only when every condition holds (decision e):

- the queue is `ranked`;
- the status is `complete` and the reason is `agreed`;
- `duration_ms >= 180000` (`RANKED_MIN_MS`);
- neither seat is a resident;
- both players are accounts, i.e. neither `auth.provider` is `guest`.

The server only sets the flag: it never credits coins. The game client pays its own 20-coin ranked reward (`ranked:<match_id>` in its wallet) when the flag is true. A guest match, a resident match, a short match, a void or a forfeit is `rewardable: false`.

### Tiers and display

`TIERS` in `src/store/elo.ts`:

| Tier | From |
|---|---|
| Bronze | 0 |
| Gold | 1600 |
| Platinum | 2200 |
| Diamond | 2800 |
| Master | 3400 |

`displayRating(rating, placement)` returns `null` while in placement, `"< 500"` below 500, otherwise the number as text. The server sends the tier with the ranked state: `match.opponent.tier`, `match_end.rating.tier` (`tierOf(after)`) and the `tier` of every ladder entry and of `me` (`tierOf`). Clients can still compute it from the rating with the table above.

### Ladder

The `ladder` message is the read-only leaderboard over the matchmaking socket (see [protocol.md](protocol.md#matchmaking-messages)). It needs `auth`; a page is an integer 1..1000, each reply carries at most `LADDER_PAGE_SIZE` = 10 entries ordered by rating then player id, and `me` is the caller's `{ rank, rating, tier, placement, games }` (`rank` null in placement) or `null` for a guest. A store failure answers `store_unavailable`.

The store's `leaderboard(game, page)` still returns 50 entries per page (`LEADERBOARD_PAGE_SIZE`). The ladder maps a 10-row page onto it: store page = `floor((page - 1) * 10 / 50) + 1`, offset = `((page - 1) * 10) % 50`; it slices 10 rows out of that store page. Pages and `me` entries are cached for `LADDER_TTL_MS` = 45000 ms, with at most one `leaderboard` read and one `rankOf` per request on a miss; `invalidate(playerId, game)` drops only that player's `me` entry and runs for both players at every match end.

## Achievements fed by matches

When a ranked or quick match ends with a decided score, the server emits a `match_end` event to the achievements service of the game (see [online-data.md](online-data.md)). Void matches emit nothing.

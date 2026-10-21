# GameSaloon online contract (r9)

The shared rules of the GameSaloon server (internally called Handshake), the optional AI residents and every game client.
One authority for the wire rules: this file. A change = a new revision number + one changelog line at the bottom. Written in English.
The code is the final reference; where this file and the code differ, the code wins and this file is a bug.

## 1. Components
- **GameSaloon / Handshake** (this repository): a Node module. `createHandshake(options)` returns the HTTP + WebSocket server: rooms and signaling (the KartRacer protocol), the GameNet relay protocol (moved here from the original standalone relay, unchanged on the wire), matchmaking queues, and the per-player services (economy, saves, achievements, player content). Persistence goes through a `PlayerStore` interface and a table API. The standalone `npm start` runs it with in-memory tables by default.
- **A table backend** (optional): the remote service reached with `PLAYER_STORE=http`. Etcito, the hosted service built on GameSaloon, provides one; it is not part of this repository. A self-hoster can implement the `TableApi` interface directly (see stores.md).
- **Residents** (optional, not in this repository): persistent AI players supplied through `hooks.pickResident`.
- **Game clients**: the same build on itch.io, Wavedash and the standalone web page. The platform only changes the login identity and how real money is spent.

## 2. Accounts
- `player_id`: a UUID issued by the server. `display_name`: 3..16 chars.
- `identities[]`: `{provider: "wavedash" | "itch" | "guest", external_id}`. One player can link several identities. The provider never changes gameplay, rating, collection or matchmaking.
- An AI resident is a player like any other (`kind: "resident"` is stored, never shown to players, visible to the operator only).

## 3. Rating (elastic ELO) and tiers
- Each player has a rating `r` per game (only the `ranked` queue changes it). Start: `r = 2500` (a per-game parameter, see multi-game.md).
- Expected score `E = 1 / (1 + 10^((r_opp - r) / 400))`. After a match: `r = max(0, r + K * (S - E))`, `S` = 1 win, 0.5 draw, 0 loss.
- Elastic K: `K = 160` while `ranked_games_played < 5` (placement: no tier and no number shown), then `K = max(32, 160 - 16 * ranked_games_played)`. The floor 32 and the 5 placement games are per-game parameters.
- Tiers (constants `TIERS` in `src/store/elo.ts`; the distribution forms a bell curve centred on 2500 = Platinum):
  | Tier | Rating |
  |---|---|
  | Bronze | 0 – 1599 |
  | Gold | 1600 – 2199 |
  | Platinum | 2200 – 2799 |
  | Diamond | 2800 – 3399 |
  | Master | 3400+ |
- Displayed rating: the number is shown only from 500 up; below 500 the client shows "< 500". The stored rating is never capped except at 0.
- Residents use the same formula; their matches count for both sides.

## 4. Matches
- Queues per game: `quick` (unrated) and `ranked`.
- One ranked match at a time per player (residents too): `active_ranked_match` is set atomically when a ranked match is created and cleared at its result. A client that disconnects for more than 90 s loses the match.
- Ranked pairing: rating window ±100, widened by 100 every 5 s.
- When no human is found after 15 s (ranked) or 8 s (quick), the queue takes the free resident with the nearest rating. A resident is never paired with a resident.
- Results are reported by both clients (deterministic lockstep: they agree); a disagreement is recorded and the match is void (no rating change).

## 5. Economy (server-authoritative)
- The server alone changes coins, packs and cards. Amounts, prices, the card pool and the pack rules are game data (section 8), not constants of the server.
- Coins come from rewards, refunds of duplicates and purchases; packs are bought with coins or granted by rewards and purchases; `eco_open` is a server action: the server draws the cards (the client never decides drops) and records them.
- Real money buys what the game's products say (coins and/or packs). Wavedash: the Wavedash purchase API; items are credited only after the server verifies the receipt. itch.io and the web: Stripe Checkout, same server crediting rule. Both are specified in section 8.

## 6. Protocol
- JSON over WebSocket, the existing framing. New message types are additive: existing clients keep working.
- The exact list of new messages (auth, queue, match result, economy) is section 7, written by the Handshake project's milestone that introduces them.

## 7. Messages

Messages use the GameNet relay WebSocket at `/ws`, the same path as rooms. On the shared path, the first JSON text frame is routed by its `t`: relay types and the match types below go to the relay, while a rooms `hello` goes to rooms. Frames are JSON text objects with the type field `t`; errors use `{ t:'error', reason }`. A queue match pairs both players straight into a relay session on that same connection. The unchanged relay messages (`create`, `join`, `act`, `bye`, `queue`, `unqueue`, `resume`, `ping`) and their replies are documented in [docs/RELAY.md](RELAY.md). These additions are additive only: old KartRacer and GameNet clients keep working. The economy (coins, packs, collection, purchases) has its own messages, section 8.

### Client to server
- `auth` { provider: `wavedash` | `itch` | `guest`, token: string (guest: 16..128 chars of [A-Za-z0-9_-]; wavedash/itch: 1..4096 chars), name?: string (3..16 chars after trim; used only when the player is created), game?: string (1..64 chars; the game whose player list is used) }. No auth required. Replies `authed` or error `already_authed`, `auth_failed`, `auth_unavailable`, `bad_message` (also: unknown `game`, or no `game` while several games are served), `store_unavailable` (or relay `internal`).
- `match_queue` { game: string (1..64 chars), queue: `quick` | `ranked` }. Needs auth, and `game` must be the game the connection authenticated into (otherwise `bad_message`). Replies `match_queued`, then `match` when paired; errors `auth_required`, `already_queued`, `in_match`, `ranked_busy`, `resident_cannot_queue`, `bad_queue`, `bad_message`, `store_unavailable` (or relay `internal`). These `match_queue` / `match_unqueue` messages are distinct from the relay's legacy `queue` / `unqueue`.
- `match_unqueue` {}. No auth required. Replies `match_unqueued`; error `not_queued` when the caller is not queued.
- `result` { match_id: string (1..128 chars), outcome: `win` | `loss` | `draw` }. Needs auth. Replies `result_ack` { match_id } when the caller reports for a match; errors `unknown_match`, `already_reported`, `bad_message` (or relay `internal`).
- `ladder` { page: integer (1..1000) }. Needs auth. Replies `ladder` { game, page, page_size: 10, total, entries, me } (10 entries per page; `me` is null for a guest); errors `auth_required`, `bad_message`, `store_unavailable` (or relay `internal`).
- `eco_get` { op? }. Replies `eco_state`; see section 8.
- `eco_products` { op? }. Replies `eco_products`; see section 8.
- `eco_reward` { reward_id }. Replies `eco_reward`; see section 8.
- `eco_buy` { op, product, qty? }. Replies `eco_bought`; see section 8.
- `eco_open` { op, pack_type }. Replies `eco_opened`; see section 8.
- `eco_wavedash` { op?, receipt_jwt, user_jwt? }. Replies `eco_purchase`; see section 8.
- `eco_stripe` { op?, product, return_url }. Replies `eco_checkout`; see section 8.
- `save_list` { op? }. Replies `save_list`; see section 9.
- `save_get` { key }. Replies `save_data`; see section 9.
- `save_put` { op?, key, base_version, data }. Replies `save_ok` or `save_conflict`; see section 9.
- `save_delete` { op?, key, base_version }. Replies `save_deleted` or `save_conflict`; see section 9.
- `ach_list` { op? }. Replies `ach_list`; see section 9.
- `stats_get` { op? }. Replies `stats`; see section 9.
- `stat_report` { op, stat, value }. Replies `stat_value`; see section 9.
- `ach_ack` { op?, codes }. Replies `ach_acked`; see section 9.
- `ugc_create` { op?, type?, title, description?, visibility?, content_type?, content, wavedash_ref? }. Replies `ugc_saved`; see section 9.
- `ugc_update` { id, base_version?, ... }. Replies `ugc_saved`; see section 9.
- `ugc_list` { owner?, type?, visibility?, cursor?, limit? }. Replies `ugc_list`; see section 9.
- `ugc_get` { id }. Replies `ugc_item`; see section 9.
- `ugc_delete` { id }. Replies `ugc_deleted`; see section 9.

### Server to client
- `authed` { player_id, display_name, provider }.
- `match_queued` { game, queue, rating: number, games: number, placement: boolean }.
- `match_unqueued` {}.
- `match` { match_id, game, queue, seat: 0 | 1, opponent: { player_id, display_name, rating: number, tier, placement: boolean, games: number } }. Sent immediately before the relay's `matched`, on the same session and with the same reconnection token.
- `result_ack` { match_id }.
- `match_end` { match_id, status: `complete` | `void` | `forfeit`, reason: `agreed` | `disagreement` | `no_report` | `disconnect` | `both_disconnected` | `left` | `lone_draw` | `inactivity`, outcome: `win` | `loss` | `draw` | null, rating?: { before, after, games, placement, tier }, weight: 1 | 0.5, duration_ms: number, rewardable: boolean }. `rating` appears only on a ranked match that applied a result, with `tier` = `tierOf(after)`; `outcome` is null when void; `weight` is 0.5 below 180000 ms; `rewardable` is the decision-e flag ([matchmaking-and-elo.md](matchmaking-and-elo.md#rewardable)).
- `ladder` { game, page, page_size: 10, total, entries: [{ rank, player_id, display_name, rating, tier }], me: { rank: number | null, rating, tier, placement, games } | null }. `me` is null for a guest.
- `eco_state` { op?, coins, version, packs, cards }; see section 8.
- `eco_products` { op?, products }; see section 8.
- `eco_reward` { op?, reward_id, granted, coins, applied }; see section 8.
- `eco_bought` { op?, product, qty, coins, packs, applied }; see section 8.
- `eco_opened` { op?, pack_type, cards, refund, coins, remaining, applied }; see section 8.
- `eco_purchase` { op?, provider, external_id, product, status, coins, granted, applied }; see section 8.
- `eco_checkout` { op?, url, session_id }; see section 8.
- `save_list` { op?, saves, quota }; see section 9.
- `save_data` { op?, key, exists, version, etag, size, updated_at, data }; see section 9.
- `save_ok` { op?, key, version, etag, size, updated_at, applied }; see section 9.
- `save_conflict` { op?, key, exists, version, etag, size, updated_at, data }; see section 9.
- `save_deleted` { op?, key, deleted, applied }; see section 9.
- `ach_list` { op?, achievements, pending_sync }; see section 9.
- `stats` { op?, stats }; see section 9.
- `stat_value` { op?, stat, value, applied }; see section 9.
- `ach_acked` { op?, codes }; see section 9.
- `ach_unlocked` { achievements }; see section 9.
- `ugc_saved` { op?, item, applied }; see section 9.
- `ugc_list` { op?, items, next_cursor }; see section 9.
- `ugc_item` { op?, item }; see section 9.
- `ugc_deleted` { op?, id, deleted }; see section 9.

### Error codes
| code | meaning |
|---|---|
| `auth_required` | Match queue requires authentication. |
| `already_authed` | This connection is already authenticated. |
| `auth_failed` | Identity verification failed. |
| `auth_unavailable` | No verifier is available for this provider. |
| `already_queued` | This connection is already queued or pairing. |
| `not_queued` | This connection is not queued. |
| `in_match` | This connection is already in a match. |
| `ranked_busy` | The player already has a ranked match lock, or a lock could not be taken. |
| `resident_cannot_queue` | A resident player cannot join a queue. |
| `bad_queue` | Queue must be `quick` or `ranked`, and be offered by the game (`etc_game.queues`). |
| `unknown_match` | This authenticated player is not in the named match. |
| `already_reported` | This player already reported an outcome for the match. |
| `store_unavailable` | A PlayerStore operation failed. |
| `ranked_requires_account` | A guest asked for the ranked queue while the server requires an account (`RANKED_REQUIRE_ACCOUNT`). |
| `economy_unavailable` | The game has no economy service. |
| `insufficient_funds` | The coin balance does not cover the purchase. |
| `no_packs` | No closed pack of that type is left. |
| `tx_conflict` | The same `op` was used with other parameters. |
| `unknown_product` | No such product. |
| `unknown_reward` | No such reward. |
| `unknown_pack` | No such pack type. |
| `purchase_refunded` | The purchase was refunded. |
| `purchases_blocked` | Real-money purchases are blocked after a refund. |
| `bad_receipt` | The Wavedash receipt failed verification. |
| `receipt_mismatch` | The receipt belongs to another player or user JWT. |
| `not_production` | The receipt is a playtest receipt on a production game. |
| `bad_return_url` | The Stripe return url is invalid. |
| `payment_unavailable` | The Stripe bridge is unavailable. |
| `online_unavailable` | The game has no online-data service. |
| `version_conflict` | The save or UGC `base_version` differs from the server's. |
| `too_large` | The save or UGC content exceeds its limit. |
| `quota_exceeded` | The player's save or UGC quota is full. |
| `forbidden` | A non-owner tried to change a visible item. |
| `rate_limited` | Too many writes in the window. |
| `not_found` | The requested item does not exist for this player. |
| `unknown_stat` | No such stat. |
| `stat_not_writable` | The stat is not client-writable. |

`bad_message` (invalid fields) and `internal` are the relay's existing codes, reused as docs/RELAY.md names them.

### Rules
- Auth: guest authentication is built in when there is no `verifyIdentity` hook; wavedash and itch answer `auth_unavailable` without the hook. With the hook, it decides every provider; a null result or thrown error answers `auth_failed`. Built-in guest identity hashes the token for its external id and uses a valid trimmed name, or `Guest-` plus four uppercase hash characters.
- Games: a server that serves several games keeps one player list per game; the same provider id in two games is two unrelated players. A server serving one game (or a single shared store) accepts `auth` without `game`.
- Quick queue pairs FIFO.
- Ranked window is `100 + 100 * floor(wait/5000)`; pairing uses the maximum window of the two waiters. The smallest rating gap wins, then the earliest arrival; the same player is never paired with themselves.
- Residents are offered after 8000 ms (quick) or 15000 ms (ranked) through `hooks.pickResident`; a resident never queues and is never paired with a resident.
- Ranked lock: one ranked match at a time; a player with an active lock gets `ranked_busy`.
- Results: both seats report; agreement means `complete`, disagreement means `void`; if the second report does not arrive within 60000 ms after the first, the match is void (`no_report`).
- Forfeit: a seat not resumed with its token within 90000 ms loses; both seats absent means void. The relay session then ends.
- Every match end calls `hooks.onMatchEnd`.

## 8. Economy (r4)

One economy per game (never shared between games). Everything below needs `auth`; an unauthenticated
connection gets `auth_required`. The server is the only authority: the client never sends an amount, a price or a card. (r6 refund rules are in the changelog and in economy.md.)

### State (tables of the game)
`etc_wallets` (coins, version), `etc_packs` (closed packs per player and `pack_type`), `etc_cards` (collection: quantity per player and card),
`etc_products` (catalogue of products), `etc_purchases` (one row per purchase: `provider` `wavedash` | `stripe` | `coins`,
`external_id` unique per provider, `status` `pending` | `granted` | `refunded`), `etc_ledger` (journal and idempotency guard, unique `tx_id`).
The card pool, the pack rules (size, tiers, weights, guaranteed last slot, duplicate refund) and the rewards are DATA: the JSON text of
`etc_settings` key `economy.catalog` (`{cards:[{id,rarity,token?}], packs:{<pack_type>:{kind:"random"|"fixed",...}}, rewards:{<id or prefix*>:{coins?,packs?}}}`).
Prices and what a purchase contains are the rows of `etc_products` (`price` in minor units, or coins for provider `coins`; `grant_coins`, `grant_packs` `{"<pack_type>": n}`).

### Idempotency
Every mutation is committed by ONE ledger row with a unique `tx_id`. Client operations carry an `op` (1..64 chars of `A-Za-z0-9_:.-`) chosen by the
client; the server namespaces it by player. The same `op` with the same parameters answers the original result with `applied: false`
and changes nothing; the same `op` with other parameters is `tx_conflict`. A reward is granted once per player and `reward_id`.
Purchases are keyed by the provider's id (`purchaseId`, Checkout session id). A replay, a duplicated webhook or a concurrent delivery grants once.

### Client to server
- `eco_get` { op? }. Replies `eco_state`.
- `eco_products` { op? }. Replies `eco_products` { products: [{provider, code, label, description, price, currency, grant_coins, grant_packs}] } (active products of every provider; the client keeps the ones of its platform).
- `eco_reward` { reward_id }. Grants the reward defined in the catalog (amount decided by the server). Replies `eco_reward` { reward_id, granted: {coins, packs}, coins, applied }. Error `unknown_reward`.
- `eco_buy` { op, product, qty? (1..100) }. Buys a `coins` product with coins. Replies `eco_bought` { product, qty, coins, packs, applied }. Errors `unknown_product`, `insufficient_funds`, `tx_conflict`.
- `eco_open` { op, pack_type }. The SERVER draws the cards (or reveals a fixed pack), records them in the collection and refunds the duplicates as the pack definition says. Replies `eco_opened` { pack_type, cards: [{id, rarity, is_new, duplicate}], refund, coins, remaining, applied }. Errors `unknown_pack`, `no_packs`, `tx_conflict`.
- `eco_wavedash` { op?, receipt_jwt, user_jwt? }. The Wavedash `PURCHASE_COMPLETED` receipt (and `getUserJwt()`). The server verifies the receipt (RS256 against the Wavedash JWKS, cached; `typ` `wavedash-purchase+jwt`; `iss`; `aud` one of the game's Wavedash ids = the enabled `wavedash` rows of `etc_publishers`; `env` `PRODUCTION` unless `etc_settings` `economy.allow_playtest` is `1`; `ptype` `CONSUMABLE`), that its `sub` is an identity of the authenticated player (and equals the user JWT `sub`, same `gcid`), then credits the product whose `code` is the receipt's `contentIdentifier`. Replies `eco_purchase` { provider, external_id, product, status:"granted", coins, granted, applied }. Only after this reply may the client call `Wavedash.fulfillPurchase(purchaseId)`. Errors `bad_receipt`, `not_production`, `receipt_mismatch`, `unknown_product`, `purchase_refunded`, `economy_unavailable`.
- `eco_stripe` { op?, product, return_url }. Opens a Stripe Checkout for an active `stripe` product. Replies `eco_checkout` { url, session_id }: the client opens `url` in the browser. Coins arrive only when Stripe confirms the payment (webhook); the player's open connections receive an `eco_state` push, or the client asks `eco_get` when the player comes back. Errors `unknown_product`, `bad_return_url`, `payment_unavailable`, `economy_unavailable`.

### Server to client
- `eco_state` { op?, coins, version, packs: [{pack_type, quantity}], cards: {<card id>: quantity} }. Also pushed when a webhook purchase or refund changes the player's economy.
- Errors: `{ t:'error', reason, op? }` (the `op` of the request is echoed when it had one). New reasons: `economy_unavailable`, `insufficient_funds`, `no_packs`, `tx_conflict`, `unknown_product`, `unknown_reward`, `unknown_pack`, `purchase_refunded`, `bad_receipt`, `receipt_mismatch`, `not_production`, `bad_return_url`, `payment_unavailable`.

### Webhooks (HTTP, no session; nothing is trusted before it is verified)
- `POST /webhooks/wavedash` body `{receiptJwt}`: the receipt is verified as above (the game is found from the receipt audience), the buyer is the player of the identity `wavedash` / `sub` (created if new), the product is credited, then the server calls `POST https://api.wavedash.com/api/purchases/{purchaseId}/fulfill`. `purchase.refunded` takes back the coins and the still-closed packs of that purchase (opened cards are kept), and a refund seen before its purchase blocks the purchase. 2xx only when handled; a product missing from `etc_products` answers 409 and a failed fulfill 502, so Wavedash retries.
- `POST /webhooks/stripe` (owner legacy endpoint) and `POST /webhooks/stripe/:game` (game endpoint): the raw body and `Stripe-Signature` are verified by the table service's Stripe bridge using the selected game’s service key, which selects that game’s webhook secret. The game endpoint requires the Checkout metadata `game` to equal `:game`; full refunds search only that game’s purchases. The legacy endpoint accepts only owner games when they are configured. `checkout.session.completed` / `checkout.session.async_payment_succeeded` with `payment_status: paid` credit the product once (the session amount and currency must match the amount recorded at Checkout creation); `charge.refunded` (full) reverses it. Unknown or unconfirmed payments grant nothing.

### Rules
- A refund never takes the coin balance below zero (section 8.1, r6); cards from rewards or earlier purchases are never removed.
- A profile (wallet, packs, collection) belongs to one game: the same Wavedash id in two games has two unrelated economies.

## 9. Cloud saves, stats, achievements, player content (r5)

Everything below needs `auth` (else `auth_required`) and belongs to one game, like the economy. **Handshake is the source of
truth; Wavedash is a convenience copy** (section 9.5). Frames may now be up to 512 KiB for these messages (relay messages stay at 4 KiB;
a frame over the cap closes the socket with 1009, so keep `saves.max_bytes` / `ugc.max_bytes` well below it: the defaults are 192 KiB).
Errors are `{ t:'error', reason, op? }`; new reasons: `online_unavailable`, `version_conflict`, `too_large`, `quota_exceeded`, `forbidden`,
`rate_limited`, `not_found`, `unknown_stat`, `stat_not_writable` (invalid fields stay `bad_message`, a reused `op` with other parameters `tx_conflict`).

### 9.1 Limits (data, per game)
`etc_settings` rows, all optional integers: `saves.max_bytes` (192 KiB per key), `saves.quota_bytes` (2 MiB per player), `saves.max_keys` (32),
`saves.writes_per_minute` (60), `ugc.max_bytes` (192 KiB per item), `ugc.quota_bytes` (4 MiB per player), `ugc.max_items` (100),
`ugc.writes_per_minute` (30; 0 = no limit). Cached 30 s. Sizes are UTF-8 bytes.

### 9.2 Cloud saves (`etc_saves`)
A save is a text (`data`: the client stringifies its JSON, or base64 for binary) under a `key` (`[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`, e.g. `decks`,
`profile`), with an integer `version` (1 at creation, +1 per write) and an `etag` (first 16 hex of SHA-256 of `data`).
- `save_list` {}. Replies `save_list` { saves: [{key, version, etag, size, updated_at}], quota: {used, max_bytes, keys, max_keys, max_key_bytes} }.
- `save_get` { key }. Replies `save_data` { key, exists, version, etag, size, updated_at, data } (`exists:false`, version 0 when there is none).
- `save_put` { op?, key, base_version, data }. `base_version` is the version the client based its edit on (0 = "I believe there is none").
  Compare-and-set: when the server version is `base_version`, the save is stored and the reply is `save_ok` { key, version, etag, size, updated_at, applied:true }.
  A replay of the very same write (same base, same content, e.g. after a lost reply) answers `save_ok` with `applied:false`. Any other case answers
  **`save_conflict`** { key, exists, version, etag, size, updated_at, data } = the SERVER copy; nothing is written. Errors `too_large`, `quota_exceeded`, `rate_limited`.
- `save_delete` { op?, key, base_version }. Replies `save_deleted` { key, deleted, applied } or `save_conflict`. A deleted key reads as `exists:false`; the version keeps growing on a recreate.

### 9.3 Stats and achievements (`etc_stats`, `etc_achievements`, `etc_player_stats`, `etc_player_achievements`)
The server alone unlocks. Definitions are rows you maintain in the tables: `etc_stats` (`code`, aggregation `sum|max|min|last`, `value_type int|float`,
`client_writable`, `max_delta`) and `etc_achievements` (`code` = the Wavedash identifier, titles/descriptions fr+en, `secret`, `image`, rule). Rules:
`stat` (`rule_stat` reaches `rule_threshold`: `>=`, `<=` for a `min` stat), `event` (`rule_event` + optional `rule_filter`, first matching event), `manual` (granted by the operator through the tables only).
The server maintains **built-in stats** for every game: `matches_played`, `matches_won`, `matches_lost`, `matches_drawn`, `ranked_matches_played`, `ranked_matches_won`,
`win_streak_current`, `win_streak_best`, `rating_peak`, `packs_opened`, `cards_unique`, `purchases`, `rewards_claimed` (never client-writable).
**Server events** (the client does not send them; they happen when it plays): `match_end` { outcome win|loss|draw, queue, status, rating_before?, rating_after?, placement? }
(once per player and match, void matches excluded), `pack_opened` { pack_type, new_cards, duplicates, unique_cards }, `purchase` { provider, product }, `reward` { reward_id }.
`rule_filter` is a comma list of conditions over those fields: `outcome=win,queue=ranked,rating_after>=2800` (`= != >= <= > <`).
- `ach_list` {}. Replies `ach_list` { achievements: [{code, title:{fr,en}, description:{fr,en}, secret, image, unlocked, unlocked_at, synced, progress:{stat,value,threshold}|null}], pending_sync: [code] }.
  A locked secret achievement shows title `???`, no description, no progress. Achievements added later whose stat is already reached unlock at this call.
- `stats_get` {}. Replies `stats` { stats: {<stat code>: value} } (the values to copy to Wavedash with `setStat` + `storeStats`).
- `stat_report` { op, stat, value }. Only for a stat with `client_writable`: `sum` adds `value` (>= 0), `max`/`min` keep the best, `last` replaces; `int` stats take integers; `max_delta` bounds `|value|`.
  Replies `stat_value` { stat, value, applied }; `applied:false` for a replay of `op`. Errors `unknown_stat`, `stat_not_writable`, `tx_conflict`.
- `ach_ack` { op?, codes: [code] }. The client confirms it copied these unlocks to Wavedash. Replies `ach_acked` { codes } (the ones that were pending).
- Pushed by the server, to the connection concerned, right after the request or the match end that caused it: **`ach_unlocked`** { achievements: [same objects as ach_list, unlocked:true] }.

### 9.4 Player content (`etc_ugc`)
Items (levels, mods, maps, screenshots) with a bounded text `content` (`content_type` `json` is validated, `text`, or `base64` is validated). `type`: `SCREENSHOT|VIDEO|COMMUNITY|GAME_MANAGED|OTHER` (Wavedash's),
`visibility`: `PUBLIC|PRIVATE`, `title` 1..80, `description` <= 500, optional `wavedash_ref` (the Wavedash UGC id when the client also created one). Item ids are `u_<hex>`. The owner alone updates or deletes;
a PRIVATE item does not exist for anyone else (`not_found`); an administrator can mask an item (`hidden`), which removes it for everyone but its owner.
- `ugc_create` { op?, type?, title, description?, visibility?, content_type?, content, wavedash_ref? }. Defaults `COMMUNITY`, `PRIVATE`, `json`. With `op`, a replay returns the same item. Replies `ugc_saved` { item, applied }.
- `ugc_update` { id, base_version?, <any field of create> }. Replies `ugc_saved`; `version_conflict` (with `item` = the server meta) when `base_version` differs; `forbidden` for a non-owner of a visible item.
- `ugc_list` { owner? (`me` or a player id), type?, visibility?, cursor?, limit? (1..50, default 20) }. Newest first, without content. Replies `ugc_list` { items: [meta], next_cursor: string|null } (pass it back as `cursor`).
  Without `owner`: everybody's PUBLIC items. `owner:'me'`: all of yours, hidden ones flagged.
- `ugc_get` { id }. Replies `ugc_item` { item: meta + content }.
- `ugc_delete` { id }. Replies `ugc_deleted` { id, deleted }.
`meta` = { id, owner, type, title, description, visibility, content_type, size, hash, version, wavedash_ref, hidden, created_at, updated_at }.

### 9.5 Wavedash copy (client side, never authoritative)
Wavedash has no server API for saves, achievements, stats or UGC: only the game client can write them. So, on Wavedash only:
- **Saves**: after a `save_ok`, write the same `{version, etag, data}` to Wavedash Remote Storage (`uploadRemoteFile`, file `nmc/<key>.json`; 30 uploads/min, 300/h per player: coalesce). At start, ask Handshake first;
  if Handshake is unreachable, read the Wavedash copy and play on it. When Handshake comes back, `save_put` with `base_version` = the last server version you knew: a `save_conflict` means Handshake moved on and **Handshake wins**
  (replace the local copy, or let the player choose when he played offline). A Wavedash copy with a version higher than the server's is only ever pushed through a normal `save_put`.
- **Achievements / stats**: on `ach_unlocked`, and for each code of `pending_sync` at start, call `setAchievement(code)` and `storeStats()` (and `setStat(code, value)` for the values of `stats_get`), then send `ach_ack`.
  The Wavedash identifiers are the `code`s of `etc_achievements` / `etc_stats`.
- **UGC**: Handshake stores the content; the client may also `createUGCItem` on Wavedash and keep its id in `wavedash_ref` (`ugc_update`). Leaderboard scores that point to an item use that id.
On itch.io and the web, only Handshake is used.

## 10. Multi-creator runtime (r7)

- Everything below applies only in **multi-creator mode**: `PLAYER_STORE=http` with `ETCITO_GAME_KEYS_FILE` set. Without it (`ETCITO_GAME_KEYS` only) the server behaves exactly as in r6: a mismatched key aborts the start-up, any game name may open rooms, no per-game caps. The owner games are the names listed in `src/store/legacy.ts`; every other game in the file is a creator game. See multi-game.md.
- `ETCITO_GAME_KEYS_FILE` names an owner-managed JSON object `{ "game": "gsk_..." }` (it replaces `ETCITO_GAME_KEYS`). Handshake reads it at start-up (unreadable = start-up error) and every 30 seconds. Replace it atomically (write a temporary file, then rename). An unreadable or invalid update leaves the previous registry active. Only changed games are rebuilt: an added game is opened, a game whose key changed is rebuilt, a removed game is closed; an unchanged game keeps its live state. An `etc_game.handshake_game` mismatch disables that game alone until corrected; a creator game also needs `handshake_game` equal to its name. A `hello` naming an unknown or disabled game is refused (`bad_message`).
- `etc_settings` key `limits.max_rooms` may lower a creator game's active-room limit, never raise it above the platform ceiling (`ETCITO_CREATOR_MAX_ROOMS`, default 10). Owner games keep only the server-wide limit. Creator save and UGC settings are capped by server maxima; their combined quota ceiling defaults to 50 MiB (`ETCITO_CREATOR_STORAGE_MAX_BYTES`). A creator `economy.catalog` is capped at 1 MiB.
- Wavedash: when several games claim the receipt audience, an owner game wins; otherwise the receipt is refused (`ambiguous_game`).
- The publisher (`src/publisher`, a separate process used by the hosted service to publish builds) is not part of the game protocol and is not specified here.

## Changelog
- r1 (2026-10-12): first version.
- r2 (2026-10-14): section 7 Messages written by the Handshake project.
- r3 (2026-10-14): `auth` gains an optional `game` (one player list per game); `bad_message` for an unknown or mismatched game; `bad_queue` also for a queue the game does not offer. Additive.
- r4 (2026-10-15): economy messages (`eco_*`), server-side pack opening from data, Wavedash consumable receipts and Stripe Checkout, payment webhooks. Additive.
- r5 (2026-10-15): cloud saves with compare-and-set (`save_*`), server-evaluated stats and achievements (`ach_*`, `stats_get`, `stat_report`, `ach_unlocked`), player content (`ugc_*`), extension frames up to 512 KiB, tables `etc_saves` / `etc_stats` / `etc_player_stats` / `etc_achievements` / `etc_player_achievements` / `etc_ugc`. Additive.
- r6 (2026-10-15): refund policy. A refunded purchase (Stripe `charge.refunded` in full, Wavedash `purchase.refunded`) takes back what it gave: its coins, its closed packs, and what was already spent is recovered from the player's later pack purchases (closed packs first, then the cards drawn from the newest openings). The balance never goes below zero; cards from rewards or earlier purchases stay. The player may not buy with real money for `economy.refund_ban_days` days (etc_settings, default 30, 0 = no ban; table `etc_purchase_bans`): `eco_stripe` answers `purchases_blocked`, `eco_products` lists only coin products and adds `blocked_until` (epoch ms). A purchase already paid during the ban is still granted. Additive.
- r7 (2026-10-15): game-scoped Stripe webhook, Wavedash audience disambiguation (owner first, else refused), opt-in file-backed game registry with per-game reload, creator room and data limits. Additive: nothing changes without `ETCITO_GAME_KEYS_FILE`.
- r8 (2026-10-16): documentation pass only, no wire change. Product names and internal paths removed; section 1 describes the open-source components; sections 3 and 5 aligned with the code (tiers are constants, the K formula, no fixed prices); the refund rule now says the balance never goes below zero (as r6 and the code already did).
- r9 (2026-10-21): ranked play: `ladder` in both directions (`page_size` 10, guest `me` null, 45 s cache), error `ranked_requires_account`, `match.opponent` rating/tier/placement/games, `match_end` reason/weight/duration_ms/rewardable/rating.tier, graceful-leave forfeit (`left`), lone draw, 10-minute inactivity void, 180 s half weight, `etc_matches` match records (idempotent, written before `onMatchEnd`) and `rewardable` (no server coin credit). Additive.

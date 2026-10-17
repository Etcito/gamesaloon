# Stores

Everything the server persists goes through two interfaces:

- **`PlayerStore`** (`src/store/types.ts`): players, identities, ratings, ranked locks (and a self-contained wallet/pack/leaderboard API). The match service uses it for matchmaking and ratings.
- **`TableApi`** (`src/store/tables.ts`): a tiny table interface (insert, query, update) used by the economy, cloud saves, achievements, player content and per-game settings, and by the table-API implementation of `PlayerStore`.

Implementations in this repository:

| Implementation | PlayerStore | TableApi | Persistence |
|---|---|---|---|
| in-memory | `createMemoryStore()` (`src/store/memory.ts`) | `createMemoryTableApi()` | none, lost on exit |
| table API over HTTP | `createHttpPlayerStore(api)` (`src/store/http.ts`) | `createCrmTableApi({ baseUrl, apiKey })` | whatever the remote table service uses |

`npm start` picks one with `PLAYER_STORE` (`memory`, the default, or `http`; see [configuration.md](configuration.md)). Embedders pass any `PlayerStore` or a `GameRouter` as the `store` option of `createHandshake`.

## The PlayerStore contract

Every method returns a Promise and must never throw synchronously. Errors are `StoreError` (`src/store/errors.ts`) with a `code`:

`not_found`, `bad_argument`, `insufficient_funds`, `tx_conflict`, `no_packs`, `unknown_product`, `unknown_reward`, `unknown_pack`, `purchase_refunded`, `purchases_blocked`, `version_conflict`, `too_large`, `quota_exceeded`, `forbidden`, `rate_limited`, `unknown_stat`, `stat_not_writable` (the last ten are used by the economy and online services; a `PlayerStore` itself raises the first five).

| Method | Behaviour |
|---|---|
| `getOrCreateByIdentity(identity, init?)` | `identity` is `{provider: 'wavedash' \| 'itch' \| 'guest', external_id}` (external id 1..256 characters). Returns `{ player, created }`. The same identity always gives the same player; `init` (display name 3..16 characters, `kind`) is used only at creation. Concurrent calls for one identity yield one player. |
| `getPlayer(playerId)` | the `Player` or `null`. A `Player` is `{player_id, display_name, kind: 'human' \| 'resident', identities, active_ranked_match, created_at}`. |
| `getRating(playerId, game)` | `{game, rating, games, placement}`; a new player is `2500`, 0 games, in placement. Unknown player: `not_found`. |
| `applyRankedResult({match_id, game, a, b, score_a})` | applies the ELO change to both players and clears their ranked lock if it names this match. **Idempotent by `match_id`**: a repeat returns the first result with `applied: false`. `a` and `b` must differ and exist. |
| `lockRanked(playerId, matchId)` | atomically takes the player's single ranked lock. `true` if taken (or already held for the same match id), `false` if held for another match. Concurrent calls have exactly one winner. |
| `unlockRanked(playerId, matchId)` | releases the lock only if it names this match; returns whether it did. |
| `balance`, `credit`, `debit` | a coin wallet; `credit`/`debit` take a `txId` and are idempotent by it (a repeat returns `applied: false`; the same `txId` with other parameters is `tx_conflict`; a debit above the balance is `insufficient_funds`). |
| `unopenedPacks`, `addPacks`, `openPack`, `collection` | packs and a collection per player and game; `openPack` calls the supplied roller once and is idempotent by `txId`. |
| `leaderboard(game, page)` | 50 entries per page (`page` starts at 1), ordered by rating then player id, with `rank` and `tier`, excluding players still in placement. |

Returned objects must be copies: callers can mutate them without affecting the store.

**What the server actually calls**: `getOrCreateByIdentity`, `getPlayer`, `getRating`, `applyRankedResult`, `lockRanked` and `unlockRanked` (matchmaking, `src/match/service.ts`), and `getPlayer`/`getOrCreateByIdentity` from the economy service. The wallet, pack, collection and leaderboard methods are not called by any message handler: the economy messages run on the ledger in the table API ([economy.md](economy.md)). They remain part of the interface and of the contract suite.

## Memory store

`createMemoryStore({ now?, uuid? })`. Players, ratings (per player and game), locks, wallet, packs and collections live in `Map`s. A player without a usable name gets `Player-` plus the first four characters of the id. It uses the default ELO parameters and ignores the per-game settings.

## Table-API store

`createHttpPlayerStore(api, { now?, uuid?, elo? })` implements `PlayerStore` on a `TableApi`. Design (from the comments in `src/store/http.ts`): every fact is an append-only row guarded by a unique key (transaction id, match id, event key, lock key) and current state (balance, packs, rating) is derived from the rows, so there is no read-modify-write on shared state. An in-process mutex per key serialises the check-then-insert steps: **run a single server instance per set of tables.** The `elo` option supplies the game's ELO parameters (start, K floor, placement games) at each use.

### TableApi

```ts
interface TableApi {
  insert(table: string, row: Row): Promise<{ row: Row } | 'conflict'>   // 'conflict' = a unique constraint rejected it
  query(table: string, q: { filters?, sort?, page?, size? }): Promise<Row[]>
  update(table: string, id: number, patch: Row): Promise<void>
}
```

Rows carry an integer `id` assigned on insert. Filters are `{field, op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'is_null' | 'not_null', value | values}`; `sort` is a list of `{field, dir}`; `page` starts at 1 and `size` defaults to 50. There is no delete: the services use tombstones. Unique sets are part of the contract (a unique violation must be reported as `'conflict'`; unique sets containing a `null` column never conflict, which is how a closed ranked lock frees a player).

The tables, their columns and their unique sets are listed in `ETCITO_TABLES` in `src/store/tables.ts`: `etc_players`, `etc_identities`, `etc_locks`, `etc_ranked_results`, `etc_rating_events`, `etc_ledger`, `etc_game`, `etc_publishers`, `etc_settings`, `etc_wallets`, `etc_cards`, `etc_packs`, `etc_products`, `etc_purchases`, `etc_saves`, `etc_stats`, `etc_player_stats`, `etc_achievements`, `etc_player_achievements`, `etc_ugc`, `etc_purchase_bans`, `etc_deploy_runs`. `createMemoryTableApi()` is the executable reference of the semantics (and is what the tests use as a fake tenant).

### HTTP table service

`createCrmTableApi({ baseUrl, apiKey, fetch? })` talks to a remote service with a bearer key (`gsk_...`, one per game):

- `POST {baseUrl}/api/tables/{table}` with the row as JSON: insert; status 409 means `'conflict'`; the response is the stored row (with `id`).
- `POST {baseUrl}/api/tables/{table}/query` with `{filters, sort, page, size}`: the response is an array, or an object whose `records`, `rows`, `items` or `data` is the array.
- `PATCH {baseUrl}/api/tables/{table}/{id}` with the patch.

The service that implements this API for hosted games is Etcito, the hosted service built on GameSaloon; it is not part of this repository. To self-host with persistence, implement `TableApi` directly on your own database (the simplest route: one SQL table per entry of `ETCITO_TABLES`, with the unique sets as unique indexes) instead of emulating that HTTP service.

Under `npm start`, `PLAYER_STORE=http` additionally needs `ETCITO_URL` and `ETCITO_GAME_KEYS` (see [configuration.md](configuration.md)), and reads each game's `etc_game` row at start-up ([multi-game.md](multi-game.md)).

## GameRouter

The match service and the rooms hub work with a `GameRouter` (`src/store/games.ts`):

```ts
interface GameRouter {
  resolve(game: string | undefined): GameBackend | null
  readonly strictGames?: boolean
}
interface GameBackend { game: string | null; store: PlayerStore; queues(): readonly QueueName[]; maxRooms?(): number | undefined; economy?: EconomyService; online?: OnlineServices }
```

- `singleStoreRouter(store, economy?, online?)`: one store for every game name; any game name is accepted, both queues are offered, no per-game room cap. Passing a bare `PlayerStore` as the `store` option of `createHandshake` is equivalent to a single-store router without economy or online services (the economy and online messages then answer `economy_unavailable` / `online_unavailable`).
- `createGameRouter(apis, opts)`: one `TableApi` per game, each with its own settings, store, economy and online services.
- `openStores(storeCfg, opts)` (`src/store/setup.ts`): what `npm start` uses to build the above from environment variables.

Note: `createOnline` (`src/online/index.ts`), which builds the saves, achievements and content services for a table API, is not re-exported from the package entry (`src/index.ts`); import it from the source file when embedding. `createEconomyService`, `createMemoryTableApi`, `createGameRouter` and `singleStoreRouter` are exported.

## Writing your own PlayerStore

1. Implement the whole `PlayerStore` interface. Start from `src/store/memory.ts`, which is short, or implement `TableApi` and reuse `createHttpPlayerStore`.
2. Make `lockRanked`, `applyRankedResult` and the transaction-id methods atomic in your database (unique constraints, transactions); the server relies on them for correctness when two matches end at the same time.
3. Return plain, detached objects; throw `StoreError` with the codes above.
4. Run the contract suite.

### The contract suite

`playerStoreContract(label, makeStore)` registers about 44 `node:test` tests (every method returns a Promise, identity stability, the ELO examples, idempotency, concurrency, detached copies, the wallet, packs, collection and leaderboard rules). `makeStore` must return a **fresh, empty** store each call (it may be async).

From inside this repository:

```ts
// my-store.test.ts
import { playerStoreContract } from './src/store/contract.ts'
import { createMemoryStore } from './src/index.ts'

playerStoreContract('my store', () => createMemoryStore())
```

```sh
node --experimental-strip-types --test my-store.test.ts
```

From your own project, after `npm run build` the suite is available from the `gamesaloon/contract` subpath (the entry `./contract` in `package.json` `exports`, mapped to `dist/store/contract.js`); it is exported from there and never from the main entry:

```ts
import { playerStoreContract } from 'gamesaloon/contract'
```

The repository runs it against both stores: `test/store.memory.test.ts` and `test/store.http.test.ts` (the table-API store over `createMemoryTableApi()`).

# Configuration

Two ways to run the server: the standalone entry point (`npm start`, which reads environment variables) and embedding (`createHandshake(options)` in your own process, which takes options and reads no environment variables). Template env files are in [../.env.example](../.env.example) and, for systemd, `deploy/rooms.env.example`.

## Environment variables read by `npm start`

Source: `src/config.ts`, `src/store/config.ts`, `src/store/games.ts`, `src/main.ts`.

### Server

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP and WebSocket port (plain; TLS is done by a reverse proxy). `0` picks a free port. Must be digits only |
| `HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` inside a container |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs sent to rooms clients in `welcome.iceServers` |
| `TURN_URLS` | empty | Comma-separated TURN URLs; used only when `TURN_SECRET` is also set |
| `TURN_SECRET` | unset | Shared secret of a coturn server (`static-auth-secret`); enables time-limited TURN credentials (24 h) |
| `MAX_ROOMS` | `500` | Maximum number of rooms; further `create` fails with `server_full` |
| `MAX_CLIENTS` | `2000` | Maximum number of rooms-side connections; further connections get `server_full` and are closed (1013) |
| `ALLOWED_ORIGINS` | empty (any origin) | Comma-separated allowed `Origin` values for the `/ws` upgrade. See below |
| `ALLOWED_ORIGINS_URL` | `$ETCITO_URL/api/etcito-publisher/handshake/origins` when `ETCITO_URL` is set, else none | Registrar endpoint (JSON `{"origins": [...], "games": {...}}`) whose origins are added to `ALLOWED_ORIGINS`. See below |
| `LOG_LEVEL` | `info` | `error`, `info` or `debug` |
| `OWNER_GAMES` | empty | Comma-separated game names (trimmed, lowercased) treated as *owner games*: exempt from the creator caps of multi-creator mode, see [multi-game.md](multi-game.md). Empty = every game is a creator game |
| `GUEST_RATE_PER_MIN` | `30` | Guest `auth` / `match_queue` cap per client IP: token-bucket refill rate (actions per minute). Must be digits only |
| `GUEST_RATE_BURST` | `10` | Guest `auth` / `match_queue` cap per client IP: token-bucket burst size. Must be digits only |

An invalid value (a non-numeric `PORT`, an unknown `LOG_LEVEL`) stops the process at start-up with `[config] <NAME>`.

`MAX_ROOMS` and `MAX_CLIENTS` apply to the rooms side only. The relay has fixed limits (200 sessions, 500 sockets; `src/relay/protocol.ts`).

**`ALLOWED_ORIGINS`.** An entry is an exact origin (`https://game.example.com`, no path, no trailing slash) or a subdomain wildcard `https://*.cdn.example.com` (any non-empty host label chain under that suffix, same scheme, no port unless the entry has one; `src/origin.ts`). When the list is not empty, a connection with no `Origin` header (a command-line client, a native app) is refused with HTTP 403. Leave it empty if non-browser clients must connect. Browsers always send `Origin`, so for a browser game the allow-list is effective; for anything else it is not a security boundary. A connection admitted this way is **unbound**: see "Origin->game binding" below.

**Registrar origins.** When `ALLOWED_ORIGINS_URL` (or `ETCITO_URL`) is set, an upgrade whose origin is not in `ALLOWED_ORIGINS` is checked against the list the registrar serves (same entry forms, https only, loaded at startup and every 60 s; an unknown origin on a stale list refreshes it once, at most every 5 s, so a deployment registered seconds ago works at once). The registrar list only adds to the static one: an empty `ALLOWED_ORIGINS` still allows every origin. If the registrar is unreachable the last good list is kept.

**Origin->game binding.** The registrar's response may also carry `"games": {"<game code>": ["https://...", ...]}`: which published origins belong to which game. A connection admitted ONLY through this dynamic list is then bound to the game(s) its origin is registered for; the connection's `hello`, `auth`, `match_queue` and `lobby_enter` are refused with `game_not_allowed_for_origin` for any other game. A shared origin registered for several games is bound to that whole set. A connection admitted through the static `ALLOWED_ORIGINS` list, or admitted dynamically while the registrar sends no `games` field at all, is **unbound** (any game is accepted, the behaviour before this existed); a `games` field that is present but has no entry for that origin binds it to an empty set (every game refused) until the registrar's data catches up — this is a fail-closed default, so a registrar deploy that turns on game binding before it has backfilled every origin's games will start refusing those origins' connections. See `src/origin.ts` (`parseDynamicGames`, `gamesFor`) and `src/transport.ts`.

### Player store

| Variable | Default | Meaning |
|---|---|---|
| `PLAYER_STORE` | `memory` | `memory` (nothing persisted) or `http` (a remote table service, see [stores.md](stores.md)) |
| `ETCITO_URL` | none | Required with `http`. Base URL of the table service (`http` or `https`, no credentials inside the URL) |
| `ETCITO_GAME_KEYS` | none | Required with `http` (unless the file variable is set). JSON object `{"<game>": "gsk_..."}`: one service key per game; a game name is 1..64 characters; two games never share a key |
| `ETCITO_GAME_KEYS_FILE` | unset | Path of a file with the same JSON; turns on multi-creator mode and is re-read every 30 s. Replaces `ETCITO_GAME_KEYS` (see [multi-game.md](multi-game.md)) |
| `ETCITO_CREATOR_MAX_ROOMS` | `10` | Multi-creator mode: room ceiling of a creator game (positive integer) |
| `ETCITO_CREATOR_STORAGE_MAX_BYTES` | `52428800` | Multi-creator mode: saves plus content quota ceiling of a creator game (positive integer) |
| `ECONOMY_IMPORT_FILE` | unset | Memory only: path of an economy file (`{catalog, products, settings?}`, see [economy.md](economy.md)) imported into the in-memory tenant at start-up. Refused with `PLAYER_STORE=http` |
| `WAVEDASH_JWKS_URL` | unset | Memory only: http(s) URL of the Wavedash JWKS that verifies user JWTs, so local tests can sign a Wavedash player in. Refused with `PLAYER_STORE=http` |

The `ETCITO_` prefix is historical: these variables configure the remote table service client. Configuration errors name the variable and never print a key. When `PLAYER_STORE=http` the start-up banner lists the configured game names.

### Publisher (separate process)

`npm run publisher` starts a different program, `src/publisher/main.ts`, used by the hosted service to publish game builds to storefronts. It is not needed to run a game server and is not documented further here. Its variables are described at the top of that file.

### What `npm start` wires

`src/main.ts` calls `createHandshake` with: the configuration above; the stores from `PLAYER_STORE`; a `verifyIdentity` hook where `guest` is verified unless the game's `guests.enabled` switch is off (see Guest provider), `wavedash` is verified against Wavedash's keys and `itch` is refused (`auth_unavailable`), `bot` is checked against the game's `etc_settings` (see Bot provider); an `onMatchEnd` hook that logs one line; no `pickResident` (no AI opponents); and the payment webhook routes (`/webhooks/wavedash`, `/webhooks/wavedash/playtest`, `/webhooks/stripe`, `/webhooks/stripe/<game>`). It closes gracefully on `SIGTERM` and `SIGINT`.

### Bot provider

The `bot` identity provider (`src/bot.ts`) has no environment variable: it is driven per game by two `etc_settings` rows, written from the EtcitoGameServer administration interface and read through a 30 s cache (`src/store/settings.ts`):

| Key | Value | Meaning |
|---|---|---|
| `bots.enabled` | `1` or `true` | Kill switch. Any other value, a missing row or a failed read refuses every bot of the game |
| `bots.tokens` | JSON `{"<bot name>": "<sha256 hex>"}` | One entry per bot: the SHA-256 (hex) of its secret. A bot name is 3..16 chars of `A-Za-z0-9_-`; invalid entries are ignored; a missing row or invalid JSON refuses every bot |

A bot authenticates with token `<bot name>:<secret>`; the secret's hash is compared in constant time. Example value of `bots.tokens`: `{"RookBot": "<output of: printf %s 'the-secret' | sha256sum>"}`. The server never logs a token or a hash. `npm start` wires this verifier for every game; per-bot daily caps are not implemented yet.

### Guest provider

The `guest` identity provider (`src/guest.ts`) is on by default; it is switched off per game by one `etc_settings` row, written from the EtcitoGameServer administration interface and read through the same 30 s cache as the bot provider:

| Key | Value | Meaning |
|---|---|---|
| `guests.enabled` | `0` or `false` | Turns guests OFF for the game: `auth` with `provider: 'guest'` is refused `guests_disabled`. Any other value, a missing row or a failed read **allows** guests (unlike `bots.enabled`, this fails OPEN: it is a product switch, not a secret roster) |

`npm start` wires this for every game. Guest `auth` and `match_queue` are also capped per client IP (`GUEST_RATE_PER_MIN`, `GUEST_RATE_BURST` above): over the cap, both answer `rate_limited`. Bots and accounts (wavedash, itch) are never subject to this cap. The real client IP behind the reverse proxy is resolved the same way the IP limiter uses it (see "Trusted client IP" below).

### Trusted client IP

`src/transport.ts`'s `clientIp` trusts `X-Forwarded-For` only when the TCP peer is loopback (`127.0.0.1`/`::1`), matching the deployment in [deploying.md](deploying.md) where `HOST` is bound to loopback behind nginx; a direct, non-loopback peer (no proxy, or a misconfigured one) gets its own socket address instead, never a header a client could forge itself. When trusted, the real client is the **last** entry of `X-Forwarded-For`: nginx's `$proxy_add_x_forwarded_for` *appends* the peer it saw to whatever the client already sent, so with one proxy hop everything before that append is client-supplied and not trustworthy — reading the first entry (a common mistake) would let a client claim any IP it likes.

### Verified identity for real-money purchases

`eco_wavedash` (a Wavedash receipt) and `eco_stripe` (starting a Stripe checkout) require a non-guest, verified identity (an account or a bot); a guest is refused `verified_identity_required` before either is attempted. This keeps a real purchase from ever being tied to a disposable guest id that cannot be recovered, refunded or charged back against. The in-game virtual economy (coins and packs earned or spent in play: `eco_buy`, `eco_open`, `eco_reward`, `eco_shop_buy`, `eco_round`, `eco_commission`, `eco_claim`, `eco_gift`, and every read-only `eco_*`/social message) stays open to guests, as it always has (see [economy.md](economy.md)). Ranked play's own account requirement is unchanged: `RANKED_REQUIRE_ACCOUNT` above, error `ranked_requires_account`.

## Embedding

The package entry (`src/index.ts`, `dist/index.js` after `npm run build`) exports `createHandshake`, the stores, the hooks types and more. Verified example (it runs as is from the repository root; replace the import path with `gamesaloon` when using the built package):

```js
import { createHandshake, createMemoryStore, guestIdentity } from './src/index.ts'

const handshake = createHandshake({
  config: { port: 8787, host: '127.0.0.1' },
  store: createMemoryStore(),
  hooks: {
    verifyIdentity: async (provider, token, name) =>
      provider === 'guest' ? guestIdentity(token, name) : null,
    onMatchEnd: (record) => console.log(`match ${record.match_id}: ${record.status}`),
  },
})

const { port } = await handshake.listen()
console.log('listening on', port)
process.once('SIGTERM', () => {
  handshake.close().then(() => process.exit(0))
})
```

### Options (`HandshakeOptions`, `src/handshake.ts`)

| Option | Meaning |
|---|---|
| `config` | `Partial<Config>`: `port`, `host`, `stunUrls`, `turnUrls`, `turnSecret`, `maxRooms`, `maxClients`, `allowedOrigins`, `logLevel`. Merged over the defaults of the table above. **The environment is not read** in this mode; call `loadConfig(process.env)` yourself if you want it |
| `store` | a `PlayerStore` (one store for every game) or a `GameRouter` (one store per game, see [stores.md](stores.md)). Default: a fresh in-memory store |
| `hooks` | `verifyIdentity`, `pickResident`, `onMatchEnd` (below) |
| `http` | extra plain HTTP routes (an array of `HttpRoute`, e.g. `economyRoutes(...)`) |
| `deps` | injectable clock, random and logger (`now`, `random`, `seed`, `log`), mostly for tests |
| `autoTick` | default `true`: run the one-second maintenance tick yourself with `tick(nowMs)` when `false` |

`createHandshake` returns `{ hub, port, listen(), tick(nowMs), close() }`. `listen()` resolves with the actual port (use `port: 0` for an ephemeral one) and throws if called twice; `close()` closes all sockets and the HTTP server.

### Hooks (`src/hooks.ts`)

- `verifyIdentity(provider, token, name?, game?) => Promise<VerifiedIdentity | null>`: turns a provider token into `{ provider, external_id, display_name }` or refuses (`null`, or a throw). When this hook is **absent**, only `guest` is accepted (the built-in `guestIdentity`); `wavedash` and `itch` answer `auth_unavailable`. When present, it decides every provider, including `guest`. `game` is the `game` of the `auth` message. `src/identity.ts` offers `defaultVerifiers()` and `verifyIdentityHook()` to compose one verifier per provider.
- `pickResident(game, queue, rating) => Promise<ResidentSeat | null>`: supply an AI opponent for a player who waited too long. See [matchmaking-and-elo.md](matchmaking-and-elo.md#resident-opponents).
- `onMatchEnd(record) => void | Promise<void>`: called with the `MatchRecord` of every ended match. Errors are logged and swallowed.

### Using the built package

`npm run build` compiles `src/` to `dist/` (JavaScript plus `.d.ts`). The package entry is `dist/index.js`; the contract test suite is at the `/contract` subpath. `package.json` currently has `"private": true` and the name `gamesaloon`, so it is not published to a registry; depend on it from a checkout or a tarball.

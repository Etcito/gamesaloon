# Economy: coins, packs, collection, purchases

> **Needs a table store.** With the default memory store (`PLAYER_STORE=memory`) the economy has no data: no catalog, no products, nothing persisted. To use it, connect your own database through the `TableApi` contract ([stores.md](stores.md); no generic SQL adapter is shipped yet, and the shipped `http` store targets a CRM-style table API), or use Etcito, the hosted service built on GameSaloon.

A server-authoritative economy per game: a coin balance, closed card packs, a card collection, rewards, a coin shop, and paid purchases (Wavedash consumables, Stripe Checkout). The client never sends an amount, a price or a card; it names a product, a reward or a pack type, and the server decides. Code: `src/economy/`. Wire rules: [CONTRACT.md](CONTRACT.md) section 8.

Contents: [Where the data lives](#where-the-data-lives) · [Messages](#messages) · [The catalog](#the-catalog-economycatalog) · [Products](#products) · [Idempotency](#idempotency) · [Wavedash](#wavedash) · [Stripe](#stripe) · [Refunds](#refunds-and-the-purchase-ban) · [Webhooks](#webhooks) · [Settings](#settings-keys) · [Running it yourself](#running-it-yourself)

## Where the data lives

The economy is built on the same **table API** as the rest of the per-game data (`TableApi` in `src/store/tables.ts`, see [stores.md](stores.md)). One `EconomyService` exists per game and keeps no balance of its own. Tables used: `etc_wallets`, `etc_packs`, `etc_cards`, `etc_ledger` (the journal), `etc_products`, `etc_purchases`, `etc_purchase_bans`, `etc_publishers` (Wavedash game ids) and `etc_settings` (catalog and switches).

- With `PLAYER_STORE=http` the tables are on a remote table service (see [stores.md](stores.md)).
- With `PLAYER_STORE=memory` (the default of `npm start`) the tables are an in-process fake that starts **empty**: `eco_state` works (coins 0) and a Wavedash purchase cannot be matched, but there is no catalog and no product, and `npm start` offers no way to seed them. To use the economy without a remote table service, embed the server and seed the tables yourself; see [Running it yourself](#running-it-yourself).

Note: `PlayerStore` also declares `credit`, `debit`, `addPacks`, `openPack`, `collection` and `balance`. The server does not call them: the economy messages use the ledger above. They exist in the store contract (and are implemented by the memory store) as an independent, simpler wallet API for hosts that use the store directly.

## Messages

All economy messages need `auth` first (otherwise `auth_required`) and act on the game the connection authenticated into. A game without an economy answers `economy_unavailable`. `eco_buy` and `eco_open` require an `op` (1 to 64 characters of `A-Za-z0-9_:.-`, chosen by the client); on the other messages it is optional. See [Idempotency](#idempotency). Replies echo `op`. Errors are `{"t":"error","reason":"<code>","op":"<op>"}`.

| Client sends | Server replies |
|---|---|
| `eco_get` | `eco_state` `{ coins, version, packs: [{pack_type, quantity}], cards: {<card id>: quantity} }` |
| `eco_products` | `eco_products` `{ products: [...], blocked_until? }` |
| `eco_reward` `{ reward_id }` | `eco_reward` `{ reward_id, granted: {coins, packs}, coins, applied }` |
| `eco_buy` `{ op, product, qty? }` (`qty` 1..100, default 1) | `eco_bought` `{ product, qty, coins, packs, applied }` |
| `eco_open` `{ op, pack_type }` | `eco_opened` `{ pack_type, cards: [{id, rarity, is_new, duplicate}], refund, coins, remaining, applied }` |
| `eco_wavedash` `{ op?, receipt_jwt, user_jwt? }` | `eco_purchase` `{ provider, external_id, product, status, coins, granted, applied }` |
| `eco_stripe` `{ op?, product, return_url }` | `eco_checkout` `{ url, session_id }` |

`eco_state` is also **pushed** to every connection of a player (of the same game) when the economy changes outside a request, i.e. when a webhook purchase or refund is applied.

A real exchange (shortened ids), against a server with the catalog and product of [Running it yourself](#running-it-yourself):

```
auth -> {"t":"authed","player_id":"3634675d-...","display_name":"Alice","provider":"guest"}
eco_products -> {"t":"eco_products","products":[{"provider":"coins","code":"starter-pack","label":"Starter pack","description":"","price":40,"currency":"coins","grant_coins":0,"grant_packs":{"starter":1}}]}
eco_reward -> {"t":"eco_reward","reward_id":"tutorial:done","granted":{"coins":100,"packs":{}},"coins":100,"applied":true}
eco_reward -> {"t":"eco_reward","reward_id":"tutorial:done","granted":{"coins":100,"packs":{}},"coins":100,"applied":false}
eco_buy -> {"t":"eco_bought","op":"buy-1","product":"starter-pack","qty":1,"coins":60,"packs":{"starter":1},"applied":true}
eco_open -> {"t":"eco_opened","op":"open-1","pack_type":"starter","cards":[{"id":"c1","rarity":"common","is_new":true,"duplicate":false},{"id":"c2","rarity":"common","is_new":true,"duplicate":false},{"id":"c2","rarity":"common","is_new":false,"duplicate":true}],"refund":5,"coins":65,"remaining":0,"applied":true}
eco_get -> {"t":"eco_state","coins":65,"version":3,"packs":[],"cards":{"c1":1,"c2":2}}
eco_open -> {"t":"error","reason":"no_packs","op":"open-2"}
```

### Behaviour

- **Rewards** are granted once per player and reward id, whatever `op` is sent: claiming again returns the same result with `applied: false`. The amounts come from the catalog (`rewards`). A reward id matches exactly, else the longest `prefix*` entry.
- **`eco_buy`** buys a product of provider `coins` with coins: it costs `price * qty` coins and grants `grant_packs * qty` (and `grant_coins * qty`). Not enough coins: `insufficient_funds`.
- **`eco_open`** spends one closed pack of that type. A `random` pack is drawn by the server (crypto-grade random numbers) from the catalog's shop pool; a `fixed` pack reveals its listed cards in order. Every duplicate (a card the player already owned, or repeated inside the pack) refunds the pack definition's `duplicate_refund` coins. Cards are added to the collection. No closed pack of that type: `no_packs`; unknown pack type: `unknown_pack`.
- **`eco_products`** lists the active products of every provider; the client keeps those of its own platform. A player under a purchase ban sees only `coins` products, and the reply carries `blocked_until` (epoch milliseconds).
- A `random` pack never contains token cards (`token: true`) nor cards whose `source` is `base` or `story` (`shopPool` in `src/economy/draw.ts`).

### Error reasons

| reason | when |
|---|---|
| `auth_required` | not authenticated |
| `economy_unavailable` | the game has no economy, or Wavedash / Stripe is not configured for it |
| `bad_message` | invalid fields |
| `unknown_product`, `unknown_reward`, `unknown_pack` | the product, reward or pack type does not exist (or the product is inactive) |
| `insufficient_funds` | `eco_buy` costs more than the balance |
| `no_packs` | `eco_open` without a closed pack of that type |
| `tx_conflict` | the same `op` was used with other parameters |
| `purchase_refunded` | the purchase named by a receipt was refunded |
| `purchases_blocked` | `eco_stripe` while under a purchase ban |
| `bad_receipt`, `receipt_mismatch`, `not_production` | `eco_wavedash` receipt problems (below) |
| `bad_return_url` | `eco_stripe.return_url` is not an `http(s)` URL |
| `payment_unavailable` | the Stripe bridge could not be reached or refused |
| `store_unavailable` | a table call failed |

## The catalog (`economy.catalog`)

The card pool, pack rules and rewards are data: the JSON text stored in the `etc_settings` row whose `key` is `economy.catalog`. The service reads it at start-up and refreshes it every 60 seconds. An invalid edit is logged and the previous catalog stays active. Validation is in `parseCatalog` (`src/economy/catalog.ts`).

```json
{
  "cards": [
    { "id": "c1", "rarity": "common" },
    { "id": "c3", "rarity": "rare" },
    { "id": "t1", "rarity": "common", "token": true },
    { "id": "s1", "rarity": "rare", "source": "story" }
  ],
  "packs": {
    "starter": {
      "kind": "random", "size": 3,
      "tiers": ["common", "rare"], "weights": { "common": 80, "rare": 20 },
      "tier_of": { "basic": "common" },
      "guarantee": { "slot": "last", "min_tier": "rare" },
      "duplicate_refund": 5
    },
    "story:a:1": { "kind": "fixed", "cards": ["s1", "c1"] }
  },
  "rewards": {
    "tutorial:done": { "coins": 100 },
    "enc:*": { "coins": 20 },
    "story:a": { "packs": { "story:a:1": 1 } }
  }
}
```

- Ids match `[A-Za-z0-9:_.-]{1,64}` (reward ids up to 96, and may end with one `*`). At most 20000 cards.
- `random` packs: `size` 1..64; `tiers` lowest first; one `weights` entry per tier (at least one positive); `tier_of` maps a card's `rarity` to a tier (a rarity not listed is its own tier name); optional `guarantee` `{slot: "last", min_tier}` makes the last slot come from `min_tier` upwards when nothing above the lowest tier was drawn; `duplicate_refund` coins per duplicate.
- `fixed` packs list 1..64 existing card ids.
- Rewards grant `coins` and/or `packs` (pack types must exist); a reward that grants nothing is rejected.
- In multi-creator mode a creator game's catalog is capped at 1 MiB (see [multi-game.md](multi-game.md)).

## Products

Rows of `etc_products`: `provider` (`coins`, `wavedash` or `stripe`), `code` (unique per provider), `label`, `description`, `price` (cents for money, coins for provider `coins`), `currency`, `grant_coins`, `grant_packs` (a JSON text such as `{"starter":1}`), `active`, `sort_order`. A product that grants nothing, or has invalid numbers, is ignored. The server reads products when needed (nothing to restart). For provider `wavedash` the `code` is the Wavedash consumable identifier; for `stripe` it names the product Checkout sells.

## Idempotency

Every mutation is committed by one row of the ledger with a unique `tx_id`. A client `op` is namespaced by player. Replaying the same `op` with the same parameters returns the original result with `applied: false` and changes nothing; the same `op` with other parameters fails with `tx_conflict`. Wavedash purchases are keyed by the purchase id, Stripe ones by the Checkout session id, so a duplicated webhook grants once. The wallet, pack and card rows are a projection of the ledger; every operation first applies the player's not-yet-projected ledger rows, which repairs a crash between the two. An in-process lock serialises operations of one server instance: run **one instance** per set of tables.

## Wavedash

Under `npm start` Wavedash support is built in (`src/economy/wavedash.ts`); it needs outbound HTTPS to `auth.wavedash.com` and `api.wavedash.com`.

- **Client path**: after a purchase, the game sends `eco_wavedash` with the receipt JWT (and optionally the user JWT). The server checks: RS256 signature against Wavedash's JWKS; header type `wavedash-purchase+jwt`; issuer; audience equal to one of the game's Wavedash game ids (the enabled rows of `etc_publishers` with `platform = 'wavedash'`, field `external_id`); `env` equal to `PRODUCTION` (or `PLAYTEST` when `economy.allow_playtest` is `1` or `true`); purchase type `CONSUMABLE`. The receipt's `sub` must be an identity of the authenticated player, and if a user JWT is given it must have the same `sub` (and `gcid`). The product credited is the active `wavedash` product whose `code` equals the receipt's `contentIdentifier`. The reply is `eco_purchase`; only after it should the client call Wavedash's fulfill.
- **Webhook path**: Wavedash can also call `POST /webhooks/wavedash`; the server finds the game from the receipt's audience, credits the player (created if new) and then calls Wavedash's fulfill API itself.
- Errors map as: bad signature or claims to `bad_receipt`; wrong environment to `not_production`; buyer mismatch to `receipt_mismatch`; unreachable fulfill call to `store_unavailable`.

## Stripe

`eco_stripe` opens a Stripe Checkout for an active `stripe` product and returns its `url`; the coins arrive when Stripe confirms the payment through the webhook, and the player's open connections receive an `eco_state` push. The server builds `success_url` and `cancel_url` from `return_url` (adding `checkout=success&session_id=...` or `checkout=cancel`).

**This server holds no Stripe key.** Checkout creation and webhook signature verification are delegated to an HTTP "bridge" on the table service (`<base URL>/api/etcito-publisher/stripe/checkout` and `/verify`, called with the game's service key; `src/economy/stripe.ts`). The bridge is part of the hosted service (Etcito) and is not in this repository. A self-hosted server without that bridge cannot sell through Stripe: `createStripeBridge` is only wired when `PLAYER_STORE=http`, and `eco_stripe` otherwise answers `economy_unavailable`. If you embed the server you can pass your own `StripeBridge` (an object with `checkout` and `verify`) to `createEconomyService`.

## Refunds and the purchase ban

A Wavedash `purchase.refunded` receipt or a full Stripe `charge.refunded` reverses the purchase (`ledger.reverse` in `src/economy/ledger.ts`):

1. the purchase's coins are taken back, as far as they are still in the balance;
2. its closed packs are taken back;
3. whatever was already spent is recovered from the player's later pack purchases (closed packs first, then the cards drawn from the newest openings of that pack type).

The balance never goes below zero and cards from rewards or earlier purchases stay. A refund that arrives before its purchase blocks the purchase (`purchase_refunded`). After a refund the player may not buy with real money for `economy.refund_ban_days` days (default 30, 0 disables the ban; table `etc_purchase_bans`): `eco_stripe` answers `purchases_blocked` and `eco_products` lists coin products only. A purchase already paid during a ban is still granted.

## Webhooks

Public HTTP routes, served by the same process as the WebSocket (the proxy must forward them; see [deploying.md](deploying.md)). Nothing in a request is trusted before it is verified. A non-2xx answer makes the sender retry.

| Route | Body | Notes |
|---|---|---|
| `POST /webhooks/wavedash` and `/webhooks/wavedash/playtest` | `{"receiptJwt": "..."}` | up to 16 KiB. 200 when handled (also for an already refunded purchase); 400 `bad_request`, `unknown_game`, `ambiguous_game` or a receipt error code; 409 `unknown_product`; 502 `fulfill_failed`; 503 otherwise |
| `POST /webhooks/stripe` | Stripe event (raw) with `Stripe-Signature` | up to 256 KiB. The "legacy" endpoint: verified with the keys of the owner games only (the names in `OWNER_GAMES`, see [multi-game.md](multi-game.md)) when those are configured; with the default empty `OWNER_GAMES` it ignores every event |
| `POST /webhooks/stripe/<game>` | same | verified with that game's own key; the Checkout metadata `game` must equal `<game>`. `<game>` matches `[a-z0-9_-]{1,64}` |

Handled Stripe events: `checkout.session.completed` and `checkout.session.async_payment_succeeded` with `payment_status` `paid` (the session amount and currency must equal what was recorded at Checkout creation), and `charge.refunded` (full refunds only). Everything else is answered 200 and ignored. The webhook route is available when the server is started with `npm start`; an embedder passes `economyRoutes({ backends, log })` as the `http` option of `createHandshake`.

## Settings keys

Rows of `etc_settings` (`key`, `value`):

| Key | Meaning |
|---|---|
| `economy.catalog` | the JSON catalog above |
| `economy.allow_playtest` | `1` or `true`: accept Wavedash `PLAYTEST` receipts. Leave unset in production |
| `economy.refund_ban_days` | days of purchase ban after a refund (default 30, 0 = none) |

`economy.allow_playtest` (and the list of Wavedash game ids) is cached for 30 seconds; `economy.refund_ban_days` is read when a refund is applied.

## Running it yourself

Without a remote table service, embed the server and give it a table API you seed yourself. This example (run against a local server) uses the in-memory table API, so nothing survives a restart; swap `createMemoryTableApi()` for your own `TableApi` implementation to persist (see [stores.md](stores.md)).

```js
import {
  createHandshake, createMemoryStore, createMemoryTableApi, createEconomyService, singleStoreRouter,
} from './src/index.ts'
import { createOnline } from './src/online/index.ts' // not re-exported by the package entry

const api = createMemoryTableApi()
await api.insert('etc_settings', {
  key: 'economy.catalog',
  value: JSON.stringify({
    cards: [{ id: 'c1', rarity: 'common' }, { id: 'c2', rarity: 'common' }, { id: 'c3', rarity: 'rare' }],
    packs: {
      starter: {
        kind: 'random', size: 3, tiers: ['common', 'rare'], weights: { common: 80, rare: 20 },
        guarantee: null, duplicate_refund: 5,
      },
    },
    rewards: { 'tutorial:done': { coins: 100 } },
  }),
})
await api.insert('etc_products', {
  provider: 'coins', code: 'starter-pack', label: 'Starter pack', price: 40, currency: 'coins',
  grant_coins: 0, grant_packs: '{"starter":1}', active: true, sort_order: 0,
})

const store = createMemoryStore()
const economy = createEconomyService({ game: 'demo', api, store })
await economy.catalog.refresh()
const router = singleStoreRouter(store, economy, createOnline(api))

const hs = createHandshake({ config: { port: 8787 }, store: router })
await hs.listen()
```

Inside this repository the imports point at `./src/...`; from the built package they come from the package entry (`createOnline` is currently not exported from it; see the note in [stores.md](stores.md)). `economy.start()` (called for you by `openStores`) additionally refreshes the catalog every 60 seconds; in this example the catalog is read once.

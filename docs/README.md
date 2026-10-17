# GameSaloon documentation

GameSaloon is the handshake and lobby layer for web games, as a Node/TypeScript WebSocket server. The core (rooms, relay, matchmaking, Elo, identity) works with zero setup on the in-memory store. For more (economy, cloud saves, achievements, payments, creator tooling) you either connect your own database through the `PlayerStore` / `TableApi` contract ([stores.md](stores.md); a generic SQL adapter is not shipped yet, and the shipped `http` store targets a CRM-style table API) or use Etcito, the hosted service built on GameSaloon. One endpoint, `/ws`, carries:

- **Rooms**: short room codes, a lobby, and WebRTC signaling relayed between room members. Race data never goes through the server. (The player and settings shapes are currently those of the KartRacer game; see [protocol.md](protocol.md).)
- **GameNet relay**: a small, game-agnostic action relay for 2 to 4 seats (private rooms by code, a FIFO queue, reconnection tokens). See [RELAY.md](RELAY.md).
- **Matchmaking**: guest (and Wavedash) authentication, `quick` and `ranked` queues, an ELO rating per player and game, result reporting, and a hook for resident (AI) opponents. See [matchmaking-and-elo.md](matchmaking-and-elo.md).
- **Per-player services** on the same connection: a coin and card-pack economy ([economy.md](economy.md)) and cloud saves, stats, achievements and player content ([online-data.md](online-data.md)).

Persistence goes through the `PlayerStore` interface and a table API ([stores.md](stores.md)). The standalone server (`npm start`) keeps everything in memory unless it is pointed at a remote table backend.

Etcito, the hosted service built on GameSaloon.

## Reading order

| Document | Read it to |
|---|---|
| [quickstart.md](quickstart.md) | run the server, create a room and run a quick match in five minutes |
| [client-integration.md](client-integration.md) | connect a web game, with a short JavaScript example |
| [protocol.md](protocol.md) | see every rooms and matchmaking message, error code, limit and timeout |
| [RELAY.md](RELAY.md) | GameNet relay reference (derived from the original relay it was moved from) |
| [matchmaking-and-elo.md](matchmaking-and-elo.md) | queues, pairing windows, results, forfeits, the rating formula, tiers |
| [economy.md](economy.md) | coins, packs, collection, rewards, purchases and webhooks |
| [online-data.md](online-data.md) | cloud saves, stats, achievements, player content |
| [configuration.md](configuration.md) | every environment variable, and the embedding options |
| [stores.md](stores.md) | the `PlayerStore` contract, the memory and table-API stores, writing your own |
| [multi-game.md](multi-game.md) | several games on one server, the game registry and creator caps |
| [deploying.md](deploying.md) | systemd and a TLS reverse proxy (nginx or Caddy) |
| [licensing-faq.md](licensing-faq.md) | AGPL-3.0, the commercial licence, what they mean for you |
| [CONTRACT.md](CONTRACT.md) | the design contract the server follows (message lists, rules) |

## Conventions

- Every statement was checked against the code; paths such as `src/match/service.ts` point to the source of truth.
- "Rooms protocol" is the `hello`-first lobby protocol. "Relay" is the GameNet relay. "Match messages" are `auth`, `match_queue`, `match_unqueue`, `result` and the `eco_*`, `save_*`, `ach_*`, `stats_*`, `stat_*`, `ugc_*` families: they ride on a relay connection.
- The npm package in `package.json` is called `gamesaloon` (and is `private`, so not published to a registry), and some internal names (`etc_*` tables, `ETCITO_*` variables) predate the GameSaloon name. Those names are used verbatim in these documents because they are what the code expects.
- Code samples were run against a local server built from this repository.

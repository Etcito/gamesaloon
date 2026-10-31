---
name: memory-mode-economy-identities
description: Use when running or testing gamesaloon in memory mode with the economy (shop, gifts, inbox, commissions, eco_* messages), or when an eco_* request answers not_found / 404.
---

# Memory mode: the economy needs identities in etc_identities and an imported game

The economy service (gifts, shop, inbox, commissions) looks up players in the `etc_identities` table. The HTTP store writes that table. Memory mode does not write it unless created identities are mirrored there. If they are not, the gift `recipient()` lookup in `src/economy/gifts.ts` fails, and the client gets `{ code: 'not_found', status: 404 }` back on the eco_* WebSocket message. Retrying gives the same result.

Rules:
- Every identity created in memory mode must also be written to `etc_identities`, the table the economy reads. Keep a regression test that creates two players in memory mode and sends a gift between them.
- Memory mode must import the game economy (the idempotent `game:import` path). Without it, catalogue lookups return not_found. Catalogue ids must match the ones the client sends.
- When an eco_* request returns not_found, log the exact message and its payload first. Then find which lookup refused it (identity, catalogue item, game). Do not loosen the client test.
- Unit tests passing is not proof. Run a real client loopback over the WebSocket against the memory-mode server, end to end, and check that every step of the flow passes, not only the gift step.

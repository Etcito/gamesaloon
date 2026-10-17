# Online data: cloud saves, stats, achievements, player content

> **Needs a table store.** With the default memory store these services have no persisted data; see [stores.md](stores.md) for connecting your own database, or use Etcito (hosted).

Four per-player services, available on the authenticated relay connection, one set per game. The server is the source of truth. Code: `src/saves/`, `src/achievements/`, `src/ugc/`, `src/online/`. Wire rules: [CONTRACT.md](CONTRACT.md) section 9.

Like the economy, they read and write through the table API (see [stores.md](stores.md)): tables `etc_saves`, `etc_stats`, `etc_player_stats`, `etc_achievements`, `etc_player_achievements`, `etc_ugc`, with limits in `etc_settings`. Under `npm start` with the default `PLAYER_STORE=memory` these tables are an in-process fake: everything works but is lost on restart, and the definitions tables (`etc_stats`, `etc_achievements`) start empty. A game without these services answers `online_unavailable`.

All messages need `auth` (else `auth_required`). Replies echo the request's `op` when it had one. Errors are `{"t":"error","reason":"<code>","op":"<op>"}`. Frames for these messages can be up to 512 KiB; keep per-item limits well below that (the defaults are 192 KiB).

## Limits

Optional integer rows of `etc_settings`, cached for 30 seconds (sizes are UTF-8 bytes; `0` for a writes-per-minute key means no limit). A missing or invalid value uses the default.

| Key | Default | Meaning |
|---|---|---|
| `saves.max_bytes` | 196608 | size of one save |
| `saves.quota_bytes` | 2097152 | all saves of a player |
| `saves.max_keys` | 32 | number of saves per player |
| `saves.writes_per_minute` | 60 | write rate per player |
| `ugc.max_bytes` | 196608 | size of one item |
| `ugc.quota_bytes` | 4194304 | all items of a player |
| `ugc.max_items` | 100 | items per player |
| `ugc.writes_per_minute` | 30 | write rate per player |

In multi-creator mode creator games are additionally capped by platform ceilings ([multi-game.md](multi-game.md)).

## Cloud saves

A save is a text (`data`: a stringified JSON, or base64) under a `key` matching `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`, with an integer `version` (1 at creation, +1 per write) and an `etag` (the first 16 hex characters of the SHA-256 of `data`).

| Client sends | Server replies |
|---|---|
| `save_list` | `save_list` `{ saves: [{key, version, etag, size, updated_at}], quota: {used, max_bytes, keys, max_keys, max_key_bytes} }` |
| `save_get` `{ key }` | `save_data` `{ key, exists, version, etag, size, updated_at, data }` (`exists: false`, version 0 when absent) |
| `save_put` `{ op?, key, base_version, data }` | `save_ok` `{ key, version, etag, size, updated_at, applied }` or `save_conflict` |
| `save_delete` `{ op?, key, base_version }` | `save_deleted` `{ key, deleted, applied }` or `save_conflict` |

`save_put` is compare-and-set. `base_version` is the version the client based its edit on (0 means "I believe there is none"). If the server version equals it, the save is stored. A replay of the very same write (same base version and same content, e.g. after a lost reply) answers `save_ok` with `applied: false`. Any other case answers `save_conflict` with the **server copy**, and nothing is written. Real output:

```
save_put -> {"t":"save_ok","key":"profile","version":1,"etag":"c8d699b727ef627e","size":11,"updated_at":1792159348875,"applied":true}
save_put -> {"t":"save_conflict","key":"profile","exists":true,"version":1,"etag":"c8d699b727ef627e","size":11,"updated_at":1792159348875,"data":"{\"level\":3}"}
```

(The second call sent `base_version: 0` again with other content.) Errors: `too_large`, `quota_exceeded` (too many keys or bytes), `rate_limited`. The table API has no delete, so a deleted save stays as an empty row whose version keeps growing; it reads as `exists: false` and a recreate never reuses a version number.

## Stats and achievements

The server alone unlocks achievements. The client can only report values of stats flagged `client_writable`, and its play triggers server events.

Definitions are rows you maintain in the tables: `etc_stats` (`code`, `aggregation` of `sum`, `max`, `min` or `last`, `value_type` of `int` or `float`, `client_writable`, `max_delta`, `active`) and `etc_achievements` (`code`, `title_fr`/`title_en`, `description_fr`/`description_en`, `secret`, `image`, the rule, `active`, `sort_order`). Codes match `[a-z0-9_]{1,64}`. Rule types:

- `stat`: unlocked when the player's value of `rule_stat` reaches `rule_threshold` (`>=`; `<=` for a `min` stat).
- `event`: unlocked by the first server event named `rule_event` whose payload satisfies `rule_filter`, a comma list of conditions such as `outcome=win,queue=ranked,rating_after>=2800` (operators `=`, `!=`, `>=`, `<=`, `>`, `<`; numbers compare as numbers).
- `manual`: never unlocked by the server.

**Built-in stats** are maintained for every game (never client-writable): `matches_played`, `matches_won`, `matches_lost`, `matches_drawn`, `ranked_matches_played`, `ranked_matches_won`, `win_streak_current`, `win_streak_best`, `rating_peak`, `packs_opened`, `cards_unique`, `purchases`, `rewards_claimed`.

**Server events** (the client does not send them): `match_end` `{ outcome, queue, status, rating_before?, rating_after?, placement? }` (once per player and match; void matches excluded), `pack_opened` `{ pack_type, new_cards, duplicates, unique_cards }`, `purchase` `{ provider, product }`, `reward` `{ reward_id }`. Residents never receive events.

| Client sends | Server replies |
|---|---|
| `ach_list` | `ach_list` `{ achievements: [{code, title: {fr,en}, description: {fr,en}, secret, image, unlocked, unlocked_at, synced, progress}], pending_sync: [code] }` |
| `stats_get` | `stats` `{ stats: {<code>: value} }` |
| `stat_report` `{ op, stat, value }` | `stat_value` `{ stat, value, applied }` |
| `ach_ack` `{ op?, codes: [code] }` | `ach_acked` `{ codes }` (the ones that were pending) |

The server also pushes `ach_unlocked` `{ achievements: [...] }` to the connection concerned, right after the request or match end that caused the unlock.

- A locked secret achievement shows the title `???`, no description and no progress. Achievements added later whose stat is already reached unlock at the next `ach_list`.
- `stat_report` requires an `op` (replay-safe) and works only for a `client_writable`, non-built-in stat: `sum` adds `value` (must be >= 0), `max`/`min` keep the best, `last` replaces; `int` stats take integers; `max_delta` bounds `|value|`. Errors: `unknown_stat`, `stat_not_writable`, `bad_message`, `tx_conflict` (same `op`, other parameters).
- `synced` and `pending_sync` exist for platforms where the game client must copy unlocks to the platform (Wavedash): the client copies, then sends `ach_ack`. Where that does not apply, ignore them.

## Player content (UGC)

Items such as levels, mods, maps or screenshots with a bounded text `content`.

| Client sends | Server replies |
|---|---|
| `ugc_create` `{ op?, type?, title, description?, visibility?, content_type?, content, wavedash_ref? }` | `ugc_saved` `{ item, applied }` |
| `ugc_update` `{ id, base_version?, ...fields }` | `ugc_saved` |
| `ugc_list` `{ owner?, type?, visibility?, cursor?, limit? }` | `ugc_list` `{ items, next_cursor }` |
| `ugc_get` `{ id }` | `ugc_item` `{ item }` (metadata plus `content`) |
| `ugc_delete` `{ id }` | `ugc_deleted` `{ id, deleted }` |

- `type`: `SCREENSHOT`, `VIDEO`, `COMMUNITY`, `GAME_MANAGED`, `OTHER` (default `COMMUNITY`). `visibility`: `PUBLIC` or `PRIVATE` (default `PRIVATE`). `content_type`: `json` (validated), `text` or `base64` (validated); default `json`. `title` 1..80 characters, `description` up to 500, optional `wavedash_ref` (`[A-Za-z0-9_:.-]{1,128}`). Item ids look like `u_<hex>`.
- Metadata: `{ id, owner, type, title, description, visibility, content_type, size, hash, version, wavedash_ref, hidden, created_at, updated_at }`.
- With an `op`, a `ugc_create` replay returns the same item with `applied: false`.
- Only the owner updates or deletes an item (`forbidden` for a non-owner of a visible item). A private item of someone else does not exist for you (`not_found`). `hidden` is an administrator mask: a hidden item is invisible to everyone but its owner.
- `ugc_list` returns newest first, without content, 1..50 per page (default 20). Without `owner` it lists everybody's public items; `owner: "me"` (or your own id) lists all of yours. Pass `next_cursor` back as `cursor`.
- `ugc_update` with `base_version` different from the item's version fails with `version_conflict` (the error carries the server metadata as `item`).
- Deleting empties the row and marks it deleted; it no longer counts toward quotas.

## Error reasons

`online_unavailable`, `version_conflict`, `too_large`, `quota_exceeded`, `forbidden`, `rate_limited`, `not_found`, `unknown_stat`, `stat_not_writable`, plus `bad_message` (invalid fields), `tx_conflict`, `auth_required` and `store_unavailable`.

## Single instance

Compare-and-set, quotas and rate limits are serialised by in-process locks and counters. Run one server instance per set of tables.

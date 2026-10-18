// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Publisher entry point. Env: PUBLISHER_KEY (required), PUBLISHER_PORT (9997), PUBLISHER_HOST (127.0.0.1),
// PUBLISHER_DATA (/var/lib/etcito-publisher), PUBLISHER_HOME (= PUBLISHER_DATA/home, the CLI's credential home,
// used by owner-game runs and the status probes; creator runs get a private per-run HOME),
// ETCITO_URL + ETCITO_API_KEY (optional: tenant API + gsk_ key, to mirror OWNER-game runs into etc_deploy_runs),
// WAVEDASH_BIN (wavedash), PUBLISHER_GAMES (OPTIONAL JSON path: {"my-game":{"name":"My Game","game_id":"..."}}; absent = fine,
// the backoffice sends game + game_id with every run; a run without game_id uses the entry of this file), PUBLISHER_MAX_QUEUE (8),
// OWNER_GAMES (comma-separated game names treated as owner games; default empty),
// PUBLISHER_WAVEDASH_CREATE_ARGS (optional JSON argv array after the binary, with {slug}/{name}, that creates a Wavedash
// project; unset = project creation answers 501; a bad value stops the start).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCrmTableApi } from '../store/tables.ts'
import { createPublisher, type GameConfig } from './runner.ts'
import { parseCreateArgsEnv } from './project.ts'
import { createHandshakeUpdater } from './handshake.ts'
import { createPublisherServer } from './server.ts'

const env = process.env
const dataDir = env.PUBLISHER_DATA ?? '/var/lib/etcito-publisher'
const key = env.PUBLISHER_KEY ?? ''
const gamesPath = env.PUBLISHER_GAMES ?? join(dataDir, 'games.json')
let games: Record<string, GameConfig> | undefined
try { games = JSON.parse(readFileSync(gamesPath, 'utf8')) as Record<string, GameConfig> } catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
}

const publisher = createPublisher({
  dataDir, home: env.PUBLISHER_HOME ?? join(dataDir, 'home'), wavedashBin: env.WAVEDASH_BIN ?? 'wavedash', butlerBin: env.BUTLER_BIN ?? 'butler', games,
  maxArtifactBytes: Number(env.PUBLISHER_MAX_BYTES ?? 150 * 1024 * 1024), keepArtifacts: 2, runTimeoutMs: 15 * 60_000,
  // Mirror owner runs into the tenant (etc_deploy_runs) when configured; otherwise the publisher works alone.
  recorder: env.ETCITO_URL && env.ETCITO_API_KEY ? createCrmTableApi({ baseUrl: env.ETCITO_URL, apiKey: env.ETCITO_API_KEY }) : undefined,
  maxQueuedRuns: Number(env.PUBLISHER_MAX_QUEUE ?? 8),
  wavedashCreateArgs: parseCreateArgsEnv(env.PUBLISHER_WAVEDASH_CREATE_ARGS),
})
const server = createPublisherServer(publisher, {
  key,
  handshake: createHandshakeUpdater({
    dir: join(dataDir, 'handshake'), healthUrl: env.HANDSHAKE_HEALTH_URL ?? 'http://127.0.0.1:9998/health',
    deployedFile: env.HANDSHAKE_DEPLOYED_FILE ?? '/opt/kart-rooms/.deployed-ref',
  }),
})
const host = env.PUBLISHER_HOST ?? '127.0.0.1'
const port = Number(env.PUBLISHER_PORT ?? 9997)
server.listen(port, host, () => console.log(`publisher listening on ${host}:${port}`))
const stop = (): void => { server.close(); void publisher.idle().then(() => process.exit(0)) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

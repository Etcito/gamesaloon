// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// `npm run game:import -- <file> --game <handshake_game>`: imports a game's economy file into its tenant tables
// (src/economy/import.ts). Env: ETCITO_URL and the game's service key from ETCITO_GAME_KEYS_FILE / ETCITO_GAME_KEYS,
// parsed by src/store/config.ts. Prints the counts; a refusal prints its reason and exits 1. Never prints the key.

import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadStoreConfig } from '../store/config.ts'
import { createCrmTableApi } from '../store/tables.ts'
import { importGameConfig } from './import.ts'
import type { ImportCounts } from './import.ts'

const USAGE = 'usage: npm run game:import -- <file> --game <handshake_game>'

export function parseImportArgs(argv: string[]): { file: string; game: string } {
  let file: string | undefined
  let game: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--game') game = argv[++i]
    else if (arg.startsWith('--game=')) game = arg.slice('--game='.length)
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}; ${USAGE}`)
    else if (file === undefined) file = arg
    else throw new Error(`one file only; ${USAGE}`)
  }
  if (!file || !game) throw new Error(USAGE)
  return { file, game }
}

const line = (what: string, c: ImportCounts): string => `${what}: ${c.inserted} inserted, ${c.updated} updated, ${c.unchanged} unchanged`

export async function runImportCli(argv: string[], env: Record<string, string | undefined>, io: {
  out?: (s: string) => void
  err?: (s: string) => void
  fetch?: typeof fetch
} = {}): Promise<number> {
  const out = io.out ?? console.log
  const err = io.err ?? console.error
  let apiKey = ''
  try {
    const { file, game } = parseImportArgs(argv)
    const cfg = loadStoreConfig({ ...env, PLAYER_STORE: 'http' })
    if (cfg.mode !== 'http') throw new Error('[config] PLAYER_STORE: must be "http"')
    apiKey = cfg.games[game] ?? ''
    if (apiKey === '') throw new Error(`--game ${game}: ETCITO_GAME_KEYS has no key for this game`)
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { throw new Error(`${file}: unreadable`) }
    const r = await importGameConfig(createCrmTableApi({ baseUrl: cfg.baseUrl, apiKey, fetch: io.fetch }), text, { game })
    out(`[game:import] ${game}`)
    out(line('settings', r.settings))
    out(line('products', r.products))
    return 0
  } catch (e) {
    // A tenant error carries its response body: strip the key in case it is echoed there.
    const message = (e as Error).message
    err(`[game:import] ${apiKey === '' ? message : message.split(apiKey).join('gsk_***')}`)
    return 1
  }
}

function invokedDirectly(): boolean {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
}

if (invokedDirectly()) process.exitCode = await runImportCli(process.argv.slice(2), process.env)

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The `bot` identity provider: a registered program that may play ranked. Everything is per-game DATA in etc_settings,
// written from the administration interface:
//   bots.enabled  '1' or 'true' turns the provider on; anything else, or no row, refuses every bot.
//   bots.tokens   JSON {"<bot name>": "<sha256 hex of the secret>"}; no row or invalid JSON refuses every bot.
// The auth token is `<bot name>:<secret>`. The secret's SHA-256 is compared in constant time with the stored hash.
// Neither the token nor a hash is ever logged.

import { createHash, timingSafeEqual } from 'node:crypto'
import { sanitizeName } from './names.ts'
import type { IdentityVerifier } from './identity.ts'
import type { SettingsReader } from './store/settings.ts'

export const BOT_SETTING_ENABLED = 'bots.enabled'
export const BOT_SETTING_TOKENS = 'bots.tokens'

/** A bot name is its stable external_id and its fallback display name, so it follows the display-name rules. */
export const BOT_NAME = /^[A-Za-z0-9_-]{3,16}$/
const HASH = /^[0-9a-f]{64}$/

/** Parses the bots.tokens value; entries with an invalid name or hash are dropped. Null when the value is not a JSON object. */
export function parseBotTokens(raw: string | null): Map<string, Buffer> | null {
  if (raw === null) return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out = new Map<string, Buffer>()
  for (const [name, hash] of Object.entries(v)) {
    if (!BOT_NAME.test(name) || typeof hash !== 'string') continue
    const h = hash.trim().toLowerCase()
    if (HASH.test(h)) out.set(name, Buffer.from(h, 'hex'))
  }
  return out
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
const DUMMY = Buffer.alloc(32)

/**
 * `settings(game)` gives the etc_settings reader of the game of the auth message (null when the game is unknown).
 * Returns null (refused) when bots are off for that game, the tokens are missing, or the token does not match.
 */
export function botVerifier(opts: {
  settings: (game: string | undefined) => SettingsReader | null | undefined
  log?: (level: string, msg: string) => void
}): IdentityVerifier {
  const log = opts.log ?? (() => {})
  return {
    async verify(token, name, game) {
      const settings = opts.settings(game)
      if (!settings) return null
      const enabled = await settings.get(BOT_SETTING_ENABLED)
      if (enabled !== '1' && enabled !== 'true') return null
      const tokens = parseBotTokens(await settings.get(BOT_SETTING_TOKENS))
      if (tokens === null) {
        log('error', `[bot] ${game ?? '-'}: etc_settings ${BOT_SETTING_TOKENS} is missing or not a JSON object; bots refused`)
        return null
      }
      const sep = token.indexOf(':')
      const botName = sep > 0 ? token.slice(0, sep) : ''
      const secret = sep > 0 ? token.slice(sep + 1) : ''
      const expected = tokens.get(botName)
      // Always hash and compare, so an unknown name or an empty secret costs the same as a wrong secret.
      const same = timingSafeEqual(sha256(secret), expected ?? DUMMY)
      if (!same || expected === undefined || secret === '') return null
      return { provider: 'bot', external_id: botName, display_name: sanitizeName(name, botName) }
    },
  }
}

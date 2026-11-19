// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The `guests.enabled` per-game switch: same etc_settings pattern as bots.enabled (src/bot.ts), read through the
// same 30 s cache (src/store/settings.ts). Unlike bots.enabled, a missing row (or a failed read) means guests stay
// ALLOWED: this is a product on/off switch for a creator, not a secret roster that must fail closed.

import { guestIdentity } from './hooks.ts'
import type { IdentityVerifier } from './identity.ts'
import type { VerifiedIdentity } from './hooks.ts'
import type { SettingsReader } from './store/settings.ts'

export const GUEST_SETTING_ENABLED = 'guests.enabled'

/** Thrown when `guests.enabled` is '0'/'false' for the game of the auth message; the player is refused (`guests_disabled`). */
export class GuestsDisabledError extends Error {
  constructor() {
    super('guests disabled for this game')
    this.name = 'GuestsDisabledError'
  }
}

/**
 * `settings(game)` gives the etc_settings reader of the game of the auth message. No reader (the game is
 * unknown, or the caller embeds without wiring settings) means guests stay allowed, same as a missing row.
 */
export function guestVerifier(opts: {
  settings: (game: string | undefined) => SettingsReader | null | undefined
}): IdentityVerifier {
  return {
    async verify(token, name, game): Promise<VerifiedIdentity | null> {
      const settings = opts.settings(game)
      if (settings) {
        const enabled = await settings.get(GUEST_SETTING_ENABLED)
        if (enabled === '0' || enabled === 'false') throw new GuestsDisabledError()
      }
      return guestIdentity(token, name)
    },
  }
}

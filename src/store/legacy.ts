// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
/**
 * Owner games are configuration: the OWNER_GAMES environment variable, a comma-separated list of game names
 * (trimmed, lowercased). Default EMPTY: every game is a creator game and gets the creator caps. An owner game keeps
 * its established limits (no creator caps), a shared publisher HOME and the legacy Stripe webhook.
 */
export function parseOwnerGames(value: string | undefined): string[] {
  const out: string[] = []
  for (const part of (value ?? '').split(',')) {
    const name = part.trim().toLowerCase()
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

let owners = new Set<string>(parseOwnerGames(process.env.OWNER_GAMES))

/** Replace the owner game set (embedding and tests). Names are normalised like the environment variable. */
export function setOwnerGames(names: readonly string[] | string): void {
  owners = new Set(parseOwnerGames(typeof names === 'string' ? names : names.join(',')))
}

export const ownerGames = (): string[] => [...owners]

export const isLegacyGame = (game: string): boolean => owners.has(game)

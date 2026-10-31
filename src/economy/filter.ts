// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The automatic description filter of the commission queue: the parsed `economy.filter` setting applied to
// player text. A refusal names the rule (and the banned word) and is safe to show as the client reason.

import type { FilterSettings } from './gameconfig.ts'

const WORD = '\\p{L}\\p{N}\\p{M}_'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bannedPattern(word: string): RegExp {
  return new RegExp(`(?<![${WORD}])${escapeRegExp(word)}(?![${WORD}])`, 'iu')
}

/** Null when `text` passes, else the reason that refused it. Length is counted in code points of the trimmed text. */
export function checkText(text: string, filter: FilterSettings): string | null {
  const trimmed = text.trim()
  const length = [...trimmed].length
  if (length < filter.min_length) return 'min_length'
  if (length > filter.max_length) return 'max_length'
  const lower = trimmed.toLowerCase()
  if (filter.no_url && (lower.includes('://') || lower.includes('www.'))) return 'no_url'
  for (const word of filter.banned_words) {
    if (bannedPattern(word).test(trimmed)) return `banned_word: ${word}`
  }
  return null
}

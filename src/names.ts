// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// The one display-name cleaner (guest names, Wavedash names, store identities).

// C0/C1 controls, zero-width and bidi marks/overrides/isolates, BOM.
const STRIP = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/** NFKC, strip controls and invisible marks, collapse whitespace, trim; keep 3..16 code points, else `fallback`. */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const s = raw.normalize('NFKC').replace(STRIP, '').replace(/\s+/g, ' ').trim()
  const n = [...s].length
  return n >= 3 && n <= 16 ? s : fallback
}

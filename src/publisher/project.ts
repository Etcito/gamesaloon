// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Pure helpers for creating a Wavedash project.

export const WAVEDASH_GAME_ID_RE = /^[A-Za-z0-9]{8,64}$/

export interface CreateProjectRequest { game: string; name?: string }
export interface CreateProjectResult { ok: boolean; game_id: string | null; detail: string }

/** Parses the optional argv template from PUBLISHER_WAVEDASH_CREATE_ARGS. */
export function parseCreateArgsEnv(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error('PUBLISHER_WAVEDASH_CREATE_ARGS must be a JSON array') }
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value.some(v => typeof v !== 'string' || v.length === 0 || v.includes('\0'))) {
    throw new Error('PUBLISHER_WAVEDASH_CREATE_ARGS must be an array of 1..16 non-empty strings without NUL')
  }
  return value
}

/** Substitutes placeholders within argv elements without changing their boundaries. */
export function createProjectArgv(template: readonly string[], slug: string, name: string): string[] {
  return template.map(arg => arg.replaceAll('{slug}', slug).replaceAll('{name}', name))
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a Wavedash game id from JSON output or a labelled CLI line. */
export function parseProjectId(output: string): string | null {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '')
  const candidates = [clean.trim(), ...clean.split(/\r?\n/).filter(line => line.trimStart().startsWith('{'))]
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (!isObj(parsed)) continue
      for (const key of ['id', 'game_id', 'gameId']) {
        const id = parsed[key]
        if (typeof id === 'string' && WAVEDASH_GAME_ID_RE.test(id)) return id
      }
    } catch { /* Ignore non-JSON CLI output. */ }
  }
  const labelled = /\b(?:game[ _-]?id|id)(?:\s*[:=]\s*|\s+)([A-Za-z0-9-]+)/i.exec(clean)
  return labelled && WAVEDASH_GAME_ID_RE.test(labelled[1]!) ? labelled[1]! : null
}

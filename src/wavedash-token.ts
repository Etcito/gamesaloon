// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// A standalone RS256 JWT verifier for Wavedash player tokens. Not wired into identity.ts or any
// auth path: this file exists so a future wavedash IdentityVerifier can be built on it, but until
// that happens it is dead code, reachable only from its own tests.

import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto'

const DEFAULT_JWKS_URL = 'https://auth.wavedash.com/.well-known/jwks.json'
const ISSUER = 'https://auth.wavedash.com'
const AUDIENCE = 'gameplay.wavedash.com'
const SCOPE = 'gameplay'
const JWKS_TTL_MS = 10 * 60 * 1000
const CLOCK_SKEW_S = 60

export interface WavedashClaims {
  sub: string
  gbid?: string
  gcid?: string
}

export interface VerifyOptions {
  /** Overrides the JWKS endpoint; defaults to the production Wavedash one. */
  jwksUrl?: string
  /** Replaces the fetch used to retrieve the JWKS (for tests, or a custom transport). */
  fetchJwks?: (url: string) => Promise<unknown>
  /** Current time in epoch seconds; defaults to Date.now() / 1000. */
  now?: () => number
}

interface Jwk {
  kid?: string
  kty?: string
  [key: string]: unknown
}

interface JwksCacheEntry {
  jwks: Jwk[]
  fetchedAtMs: number
  url: string
}

// Cache keyed by the fetch function's identity (default or injected), and checked against the
// URL too, so distinct fake fetchers in different tests never share a cache entry.
const jwksCacheByFetcher = new WeakMap<(url: string) => Promise<unknown>, JwksCacheEntry>()

async function getJwks(url: string, fetchJwks: (url: string) => Promise<unknown>, nowMs: number): Promise<Jwk[]> {
  const cached = jwksCacheByFetcher.get(fetchJwks)
  if (cached && cached.url === url && nowMs - cached.fetchedAtMs < JWKS_TTL_MS) return cached.jwks
  const jwks = await loadJwks(url, fetchJwks)
  jwksCacheByFetcher.set(fetchJwks, { jwks, fetchedAtMs: nowMs, url })
  return jwks
}

async function loadJwks(url: string, fetchJwks: (url: string) => Promise<unknown>): Promise<Jwk[]> {
  const body = await fetchJwks(url)
  const keys = (body as { keys?: unknown } | null)?.keys
  if (!Array.isArray(keys)) return []
  return keys.filter((k): k is Jwk => typeof k === 'object' && k !== null)
}

async function defaultFetchJwks(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`)
  return res.json()
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url')
}

function parseJson(buf: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function audienceMatches(aud: unknown): boolean {
  if (typeof aud === 'string') return aud === AUDIENCE
  if (Array.isArray(aud)) return aud.includes(AUDIENCE)
  return false
}

/**
 * Verifies a Wavedash RS256 player JWT: signature against the JWKS, issuer, audience, scope,
 * expiry and clock-skew bounds. Returns the claims on success, null on any failure. Never throws
 * on malformed input and never logs the token.
 */
export async function verifyWavedashToken(token: string, options: VerifyOptions = {}): Promise<WavedashClaims | null> {
  try {
    const jwksUrl = options.jwksUrl ?? DEFAULT_JWKS_URL
    const fetchJwks = options.fetchJwks ?? defaultFetchJwks
    const now = options.now ?? (() => Date.now() / 1000)

    if (typeof token !== 'string' || token.length === 0) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerPart, payloadPart, signaturePart] = parts
    if (!headerPart || !payloadPart || !signaturePart) return null

    const header = parseJson(base64urlDecode(headerPart))
    const payload = parseJson(base64urlDecode(payloadPart))
    if (!header || !payload) return null

    if (header['alg'] !== 'RS256') return null
    const kid = header['kid']
    if (!isNonEmptyString(kid)) return null

    const nowS = now()
    const jwks = await getJwks(jwksUrl, fetchJwks, nowS * 1000)
    const jwk = jwks.find((k) => k.kid === kid)
    if (!jwk) return null

    let publicKey
    try {
      publicKey = createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' })
    } catch {
      return null
    }

    const signature = base64urlDecode(signaturePart)
    const signedData = `${headerPart}.${payloadPart}`
    let signatureValid = false
    try {
      signatureValid = createVerify('RSA-SHA256').update(signedData).verify(publicKey, signature)
    } catch {
      return null
    }
    if (!signatureValid) return null

    if (payload['iss'] !== ISSUER) return null
    if (!audienceMatches(payload['aud'])) return null
    if (payload['scope'] !== SCOPE) return null

    const exp = payload['exp']
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
    if (!(nowS < exp)) return null

    for (const field of ['nbf', 'iat'] as const) {
      const value = payload[field]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      if (value > nowS + CLOCK_SKEW_S) return null
    }

    const sub = payload['sub']
    if (!isNonEmptyString(sub)) return null

    const claims: WavedashClaims = { sub }
    const gbid = payload['gbid']
    if (isNonEmptyString(gbid)) claims.gbid = gbid
    const gcid = payload['gcid']
    if (isNonEmptyString(gcid)) claims.gcid = gcid

    return claims
  } catch {
    return null
  }
}

/**
 * True when no gcid is configured (allow all builds), or when the token's gcid matches the
 * configured one. Lets a caller separate a playtest build from production later.
 */
export function isAllowedBuild(claims: WavedashClaims, allowed: { gcid?: string }): boolean {
  if (!allowed.gcid) return true
  return claims.gcid === allowed.gcid
}

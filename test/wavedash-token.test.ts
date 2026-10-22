// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// verifyWavedashToken is a standalone RS256 JWT verifier, not yet wired into identity.ts or any
// auth path. These tests exercise it directly with a throwaway RSA key pair.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto'
import { verifyWavedashToken, isAllowedBuild } from '../src/wavedash-token.ts'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const JWK = { ...(publicKey.export({ format: 'jwk' }) as unknown as Record<string, unknown>), kid: 'key-1', alg: 'RS256', use: 'sig' }

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject = privateKey): string {
  const h = base64url(JSON.stringify(header))
  const p = base64url(JSON.stringify(payload))
  const signer = createSign('RSA-SHA256')
  signer.update(`${h}.${p}`)
  const sig = base64url(signer.sign(key))
  return `${h}.${p}.${sig}`
}

const NOW = 1_700_000_000

function validPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://auth.wavedash.com',
    aud: 'gameplay.wavedash.com',
    scope: 'gameplay',
    sub: 'player-42',
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 3600,
    ...extra,
  }
}

function fakeJwks(keys: unknown[] = [JWK], counter?: { count: number }) {
  return async (_url: string) => {
    if (counter) counter.count++
    return { keys }
  }
}

function opts(extra: Record<string, unknown> = {}) {
  return { jwksUrl: 'https://test.invalid/jwks.json', fetchJwks: fakeJwks(), now: () => NOW, ...extra }
}

test('wavedash-token: a valid token yields the sub (and gbid/gcid when present)', async () => {
  const token = sign({ alg: 'RS256', kid: 'key-1' }, validPayload({ gbid: 'build-1', gcid: 'prod' }))
  const claims = await verifyWavedashToken(token, opts())
  assert.deepEqual(claims, { sub: 'player-42', gbid: 'build-1', gcid: 'prod' })
})

test('wavedash-token: a token signed by a different key is refused', async () => {
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const token = sign({ alg: 'RS256', kid: 'key-1' }, validPayload(), otherKey)
  assert.equal(await verifyWavedashToken(token, opts()), null)
})

test('wavedash-token: wrong issuer, audience or scope are refused', async () => {
  const counter = { count: 0 }
  const o = { jwksUrl: 'https://test.invalid/jwks.json', fetchJwks: fakeJwks([JWK], counter), now: () => NOW }
  for (const bad of [
    validPayload({ iss: 'https://evil.example' }),
    validPayload({ aud: 'other.app' }),
    validPayload({ scope: 'admin' }),
  ]) {
    const token = sign({ alg: 'RS256', kid: 'key-1' }, bad)
    assert.equal(await verifyWavedashToken(token, o), null)
  }
  // aud as an array containing the right value is accepted.
  const token = sign({ alg: 'RS256', kid: 'key-1' }, validPayload({ aud: ['other.app', 'gameplay.wavedash.com'] }))
  assert.ok(await verifyWavedashToken(token, o))
})

test('wavedash-token: an expired token, or nbf/iat too far in the future, is refused', async () => {
  const o = opts()
  const expired = sign({ alg: 'RS256', kid: 'key-1' }, validPayload({ exp: NOW - 1 }))
  assert.equal(await verifyWavedashToken(expired, o), null)

  const futureNbf = sign({ alg: 'RS256', kid: 'key-1' }, validPayload({ nbf: NOW + 1000 }))
  assert.equal(await verifyWavedashToken(futureNbf, o), null)

  const futureIat = sign({ alg: 'RS256', kid: 'key-1' }, validPayload({ iat: NOW + 1000 }))
  assert.equal(await verifyWavedashToken(futureIat, o), null)

  // Within the 60s skew allowance.
  const withinSkew = sign({ alg: 'RS256', kid: 'key-1' }, validPayload({ nbf: NOW + 30, iat: NOW + 30 }))
  assert.ok(await verifyWavedashToken(withinSkew, o))
})

test('wavedash-token: alg "none" or HS256 is refused even with a valid-looking payload', async () => {
  const o = opts()
  const none = sign({ alg: 'none', kid: 'key-1' }, validPayload())
  assert.equal(await verifyWavedashToken(none, o), null)
  const hs256 = sign({ alg: 'HS256', kid: 'key-1' }, validPayload())
  assert.equal(await verifyWavedashToken(hs256, o), null)
})

test('wavedash-token: an unknown kid is refused', async () => {
  const token = sign({ alg: 'RS256', kid: 'no-such-key' }, validPayload())
  assert.equal(await verifyWavedashToken(token, opts()), null)
})

test('wavedash-token: malformed tokens are refused without throwing', async () => {
  const o = opts()
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', `${base64url('{}')}.${base64url('{}')}.sig`, 'a.b.c']) {
    assert.equal(await verifyWavedashToken(bad, o), null, bad)
  }
  // @ts-expect-error intentionally wrong type to prove it never throws
  assert.equal(await verifyWavedashToken(null, o), null)
})

test('wavedash-token: the JWKS is fetched once and cached across calls', async () => {
  const counter = { count: 0 }
  const o = { jwksUrl: 'https://test.invalid/jwks.json', fetchJwks: fakeJwks([JWK], counter), now: () => NOW }
  const token = sign({ alg: 'RS256', kid: 'key-1' }, validPayload())
  await verifyWavedashToken(token, o)
  await verifyWavedashToken(token, o)
  await verifyWavedashToken(token, o)
  assert.equal(counter.count, 1)

  // Past the 10-minute TTL, it fetches again.
  const o2 = { ...o, now: () => NOW + 601 }
  await verifyWavedashToken(token, o2)
  assert.equal(counter.count, 2)
})

test('wavedash-token: isAllowedBuild passes when unconfigured, matches, or refuses a mismatch', () => {
  assert.equal(isAllowedBuild({ sub: 'p' }, {}), true)
  assert.equal(isAllowedBuild({ sub: 'p', gcid: 'playtest' }, { gcid: 'playtest' }), true)
  assert.equal(isAllowedBuild({ sub: 'p', gcid: 'playtest' }, { gcid: 'prod' }), false)
  assert.equal(isAllowedBuild({ sub: 'p' }, { gcid: 'prod' }), false)
})

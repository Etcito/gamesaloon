// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeName } from '../src/names.ts'
import { createWavedash } from '../src/economy/wavedash.ts'
import { createJwks } from '../src/economy/jwt.ts'
import { newSigner, NOW_MS, userJwt } from './economy.helpers.ts'

const FB = 'Guest-abcd'
const GOTHIC = '\u{10330}'   // astral, NFKC-stable: 1 code point, 2 UTF-16 units

test('names: sanitizeName table', () => {
  const rows: Array<[unknown, string]> = [
    [undefined, FB], [42, FB], [null, FB],
    ['\uFF2B\uFF45\uFF56\uFF49\uFF4E', 'Kevin'],   // fullwidth -> ASCII by NFKC
    ['Ke\u0007vin', 'Kevin'], ['Ke\u0085vin', 'Kevin'],
    ['Ke\u200Bvin', 'Kevin'], ['Ke\u200Evin', 'Kevin'], ['Ke\u202Evin', 'Kevin'], ['Ke\u2067vin', 'Kevin'], ['\uFEFFKevin', 'Kevin'],
    ['  Big   Bad  Wolf  ', 'Big Bad Wolf'],
    ['ab', FB], ['abc', 'abc'], ['abcdefghijklmnop', 'abcdefghijklmnop'], ['abcdefghijklmnopq', FB],
    [GOTHIC.repeat(16), GOTHIC.repeat(16)], [GOTHIC.repeat(2), FB], [GOTHIC.repeat(17), FB],
    ['\u200B\u200E\uFEFF   ', FB],
  ]
  for (const [raw, want] of rows) assert.equal(sanitizeName(raw, FB), want, JSON.stringify(raw))
})

test('names: wavedash verifier name', async () => {
  const s = newSigner()
  const f = (async () => Response.json({ keys: [s.jwk] })) as unknown as typeof fetch
  const jwks = createJwks('https://auth.wavedash.com/.well-known/jwks.json', { fetch: f, now: () => NOW_MS })
  const v = createWavedash({ jwks, now: () => NOW_MS }).identityVerifier()
  const token = userJwt(s, { sub: 'wd-user-1' })
  assert.deepEqual(await v.verify(token, '  Ke\u200Bvin   San ', 'kekkai'), { provider: 'wavedash', external_id: 'wd-user-1', display_name: 'Kevin San' })
  assert.equal((await v.verify(token, 'K\u200B', 'kekkai'))?.display_name, 'Player-wd-u')
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createProjectArgv, parseCreateArgsEnv, parseProjectId } from '../src/publisher/project.ts'

describe('Wavedash project helpers', () => {
  test('substitutes argv elements without changing their boundaries or template', () => {
    const template = ['create', '--slug={slug}', '{name}:{slug}:{name}']
    const before = [...template]
    assert.deepEqual(createProjectArgv(template, 'my-game', 'A Game; Deluxe'), ['create', '--slug=my-game', 'A Game; Deluxe:my-game:A Game; Deluxe'])
    assert.deepEqual(template, before)
  })

  test('validates PUBLISHER_WAVEDASH_CREATE_ARGS', () => {
    assert.equal(parseCreateArgsEnv(undefined), undefined)
    assert.equal(parseCreateArgsEnv(''), undefined)
    assert.deepEqual(parseCreateArgsEnv(' ["create", "{slug}"] '), ['create', '{slug}'])
    for (const raw of ['not json', '{}', '[]', JSON.stringify(Array(17).fill('x')), '[""]', '[1]', '["bad\\u0000value"]']) {
      assert.throws(() => parseCreateArgsEnv(raw), /PUBLISHER_WAVEDASH_CREATE_ARGS/)
    }
  })

  test('parses ids from JSON, labelled output and ANSI-coloured output', () => {
    assert.equal(parseProjectId('{"id":"AbC12345xyz"}'), 'AbC12345xyz')
    assert.equal(parseProjectId('starting up\n{"id":"AbC12345xyz"}\ndone'), 'AbC12345xyz')
    assert.equal(parseProjectId('{"gameId":"AbC12345xyz"}'), 'AbC12345xyz')
    assert.equal(parseProjectId('{"game_id":"AbC12345xyz"}'), 'AbC12345xyz')
    assert.equal(parseProjectId('Game ID: AbC12345xyz'), 'AbC12345xyz')
    assert.equal(parseProjectId('id=AbC12345xyz'), 'AbC12345xyz')
    assert.equal(parseProjectId('\u001b[32mGame ID: AbC12345xyz\u001b[0m'), 'AbC12345xyz')
  })

  test('rejects invalid and absent ids', () => {
    assert.equal(parseProjectId('id: AbC1234'), null)
    assert.equal(parseProjectId('id: AbC12345-xyz'), null)
    assert.equal(parseProjectId(''), null)
  })
})

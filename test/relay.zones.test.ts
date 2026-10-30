// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import test from 'node:test'
import assert from 'node:assert/strict'
import { routeMask, ZoneGroup } from '../src/relay/groups.ts'
import { GameQueues, queueKey } from '../src/relay/gameQueues.ts'
import { MAX_ZONE_PEERS, RELAY_ERROR_CODES, parseRelayMessage } from '../src/relay/protocol.ts'

test('zero mask broadcasts in seat order except to the sender', () => {
  const out = new Array<number>(64).fill(-1)
  const count = routeMask(0, 0, 1, 4, out)
  assert.equal(count, 3)
  assert.deepEqual(out.slice(0, count), [0, 2, 3])
  assert.equal(out[3], -1)
})

test('mask halves include boundary bits and ignore sender and out-of-range bits', () => {
  const out: number[] = []
  let count = routeMask(0x80000003, 0x80000003, 1, 64, out)
  assert.deepEqual(out.slice(0, count), [0, 31, 32, 33, 63])
  count = routeMask(0x80000003, 0x80000003, 32, 33, out)
  assert.deepEqual(out.slice(0, count), [0, 1, 31])
  count = routeMask(0, 0x80000000, 63, 64, out)
  assert.equal(count, 0)
})

test('64-seat broadcast and full masks route every other seat', () => {
  const out = new Array<number>(64).fill(0)
  const expected = Array.from({ length: 64 }, (_, seat) => seat).filter((seat) => seat !== 31)
  for (const mask of [0, 0xffffffff]) {
    const count = routeMask(mask, mask, 31, 64, out)
    assert.equal(count, 63)
    assert.deepEqual(out.slice(0, count), expected)
  }
})

test('ZoneGroup enforces the game cap and skips empty and dropped seats', () => {
  assert.throws(() => new ZoneGroup('small', 5, 4), RangeError)
  const group = new ZoneGroup('game', 64, 64)
  assert.equal(group.game, 'game')
  assert.equal(group.seats, 64)
  group.set(0, 'a')
  group.set(32, 'b')
  group.set(63, 'c')
  const out: string[] = []
  let count = group.route(0, 0, 0, out)
  assert.deepEqual(out.slice(0, count), ['b', 'c'])
  group.set(32, null)
  count = group.route(0, 1, 0x80000001, out)
  assert.deepEqual(out.slice(0, count), ['c'])
  group.set(63, null)
  assert.equal(group.route(0, 0, 0, out), 0)
})

test('queue keys separate games, legacy, player counts and cadence', () => {
  assert.equal(queueKey('game', 64, true), 'game|64|1')
  assert.equal(queueKey('', 2, false), '|2|0')
  const keys = ['', 'a', 'b'].flatMap((game) => [2, 4].flatMap((players) =>
    [false, true].map((cadence) => queueKey(game, players, cadence))))
  assert.equal(new Set(keys).size, 12)
  const queues = new GameQueues<{ conn: string; since: number }>()
  keys.forEach((key, since) => queues.list(key).push({ conn: key, since }))
  keys.forEach((key, since) => assert.deepEqual(queues.take(key, 2), [{ conn: key, since }]))
})

test('GameQueues takes FIFO, pops the tail, prunes and drops across lists', () => {
  const queues = new GameQueues<{ conn: string }>()
  const a = queues.list('a')
  assert.equal(queues.list('a'), a)
  a.push({ conn: 'first' }, { conn: 'dead' }, { conn: 'last' })
  queues.list('b').push({ conn: 'last' }, { conn: 'last' })
  assert.equal(queues.has('dead'), true)
  queues.prune('a', (conn) => conn !== 'dead')
  assert.equal(queues.has('dead'), false)
  assert.deepEqual(queues.take('a', 1), [{ conn: 'first' }])
  queues.drop('last')
  assert.equal(queues.has('last'), false)
  assert.notEqual(queues.list('a'), a)
  assert.deepEqual(queues.take('b', 2), [])
  const c = queues.list('c')
  c.push({ conn: 'one' }, { conn: 'two' })
  assert.deepEqual(queues.pop('c'), { conn: 'two' })
  assert.deepEqual(queues.take('c', 5), [{ conn: 'one' }])
  assert.notEqual(queues.list('c'), c)
  const d = queues.list('d')
  d.push({ conn: 'dead' })
  queues.prune('d', () => false)
  assert.notEqual(queues.list('d'), d)
  const e = queues.list('e')
  e.push({ conn: 'tail' })
  assert.deepEqual(queues.pop('e'), { conn: 'tail' })
  assert.notEqual(queues.list('e'), e)
  assert.equal(queues.pop('missing'), undefined)
  assert.deepEqual(queues.take('missing', 2), [])
  queues.prune('missing', () => false)
  queues.drop('missing')
})

test('zone create and queue accept up to 64 players with paired game and zones fields', () => {
  assert.equal(MAX_ZONE_PEERS, 64)
  assert.ok(RELAY_ERROR_CODES.includes('unknown game'))
  for (const t of ['create', 'queue']) {
    for (const game of ['g', 'g'.repeat(64)]) {
      for (const players of [undefined, 2, 64]) {
        const raw = JSON.stringify({ t, game, zones: true, players })
        assert.deepEqual(parseRelayMessage(raw), JSON.parse(raw))
      }
    }
    for (const fields of [
      { game: 'g' }, { zones: true }, { zones: false }, { game: 'g', zones: false },
      { game: '', zones: true }, { game: 1, zones: true }, { game: null, zones: true },
      { game: 'g'.repeat(65), zones: true }, { game: 'g', zones: 'true' },
      ...[1, 65, 2.5, '64', null].map((players) => ({ game: 'g', zones: true, players })),
      { players: 5 },
    ]) {
      assert.ok('error' in parseRelayMessage(JSON.stringify({ t, ...fields })), JSON.stringify(fields))
    }
    assert.deepEqual(parseRelayMessage(JSON.stringify({ t, players: 4 })), { t, players: 4 })
  }
})

test('resume have keeps its legacy scalar and array validation', () => {
  const frame = { t: 'resume', token: 'token', have: 100 }
  assert.deepEqual(parseRelayMessage(JSON.stringify(frame)), frame)
  assert.ok('error' in parseRelayMessage(JSON.stringify({ ...frame, have: [0, 0, 0, 0, 0] })))
})

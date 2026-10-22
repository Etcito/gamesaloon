// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir,mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createPublisher } from '../src/publisher/runner.ts'
import { createPublisherServer } from '../src/publisher/server.ts'
import { parseCreatedId, parseExisting, portalJson, validateCatalog } from '../src/publisher/catalog.ts'
import { setOwnerGames } from '../src/store/legacy.ts'
import { writeFakeCli } from './fake-cli.ts'
setOwnerGames('kekkai,monsterracer') // these tests exercise the owner-game behaviour

const KEY = 'k'.repeat(32)
let root: string, base: string, server: ReturnType<typeof createPublisherServer>, calls: string

// Fake CLI: logs "token|args" per call. `achievement list --json` knows one achievement; `stat create` prints an id.
// __CALLS__ is replaced by the JSON-quoted log path.
const FAKE = [
  "log(__CALLS__, `${env.WAVEDASH_TOKEN || 'none'}|${args.join(' ')}`)",
  "const cmd = `${args[0]} ${args[1]}`",
  `if (cmd === 'achievement list') { console.log('[{"id":"ach_77","identifier":"already_there"}]'); return 0 }`,
  "if (cmd === 'stat create') {",
  "  if (args[3] === 'dup_stat') { console.log('error: stat already exists'); return 1 }",
  "  if (args[3] === 'bad_stat') { console.log('boom'); return 2 }",
  "  console.log(`Created stat (id: st_${args[3]})`); return 0",
  "}",
  "if (cmd === 'achievement create' || cmd === 'achievement update') { console.log('ok'); return 0 }",
  'return 9',
].join('\n')

const CATALOG = {
  stats: [{ identifier: 'wins', display_name: 'Wins' }, { identifier: 'dup_stat', display_name: 'Dup' }],
  achievements: [
    { identifier: 'first_win', display_name: 'First win', description: 'Win a match', secret: false, stat_requirement: null },
    { identifier: 'ten_wins', display_name: 'Ten wins', description: 'Win 10 matches', secret: true, stat_requirement: { stat: 'wins', threshold: 10 } },
    { identifier: 'already_there', display_name: 'Existing', description: 'Already on Wavedash', secret: false, stat_requirement: null },
    { identifier: 'dup_trigger', display_name: 'Dup trigger', description: 'd', secret: false, stat_requirement: { stat: 'dup_stat', threshold: 1 } },
  ],
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/wavedash/catalog`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: (await res.json()) as any }
}
async function waitRun(id: string) {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/runs/${id}`, { headers: { authorization: `Bearer ${KEY}` } })
    const run = (await res.json()) as any
    if (run.status === 'ok' || run.status === 'failed') return run
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('run did not finish')
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'pub-cat-'))
  calls = join(root, 'calls.log')
  const bin = await writeFakeCli(root, 'wavedash', FAKE.replaceAll('__CALLS__', JSON.stringify(calls)))
  await mkdir(join(root, 'home'), { recursive: true })
  const publisher = createPublisher({ dataDir: root, home: join(root, 'home'), wavedashBin: bin, maxArtifactBytes: 200_000, keepArtifacts: 2, runTimeoutMs: 10_000 })
  server = createPublisherServer(publisher, { key: KEY })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => { server.close(); await rm(root, { recursive: true, force: true }) })

describe('catalog helpers', () => {
  test('validateCatalog refuses what Wavedash would refuse', () => {
    assert.throws(() => validateCatalog({ stats: [{ identifier: 'a b', display_name: 'x' }], achievements: [] }), /identifier/)
    assert.throws(() => validateCatalog({ stats: [], achievements: [{ identifier: 'a', display_name: 'A', description: '', stat_requirement: { stat: 'nope', threshold: 1 } }] }), /not in the catalogue/)
    assert.throws(() => validateCatalog({ stats: [], achievements: [{ identifier: 'a', display_name: '', description: '' }] }), /display_name/)
    assert.throws(() => validateCatalog({ stats: [{ identifier: 'a', display_name: 'A' }, { identifier: 'a', display_name: 'B' }], achievements: [] }), /duplicate/)
    assert.throws(() => validateCatalog('x'), /object/)
  })
  test('portalJson has exactly the documented shape', () => {
    assert.deepEqual(portalJson(validateCatalog(CATALOG)).achievements[1], {
      identifier: 'ten_wins', display_name: 'Ten wins', description: 'Win 10 matches', secret: true, stat_requirement: { stat: 'wins', threshold: 10 },
    })
    assert.deepEqual(portalJson(validateCatalog(CATALOG)).achievements[0], {
      identifier: 'first_win', display_name: 'First win', description: 'Win a match', secret: false, stat_requirement: null,
    })
    assert.deepEqual(portalJson(validateCatalog(CATALOG)).stats[0], { identifier: 'wins', display_name: 'Wins' })
  })
  test('output parsers are tolerant', () => {
    assert.deepEqual(parseExisting('noise\n[{"id": 5, "identifier": "a"}, {"id": "x"}]\n'), [{ id: '5', identifier: 'a' }])
    assert.deepEqual(parseExisting('not json'), [])
    assert.equal(parseCreatedId('Created stat (id: st_wins)'), 'st_wins')
    assert.equal(parseCreatedId('{"id":"abc123"}'), 'abc123')
    assert.equal(parseCreatedId('done'), null)
  })
})

describe('POST /wavedash/catalog', () => {
  test('needs the service key', async () => {
    const res = await fetch(`${base}/wavedash/catalog`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 401)
  })

  test('dry run is the default: returns the plan and the portal JSON, runs nothing, needs no token', async () => {
    await writeFile(calls, '')
    const r = await post({ game: 'kekkai', game_id: 'gid12345', catalog: CATALOG })
    assert.equal(r.status, 200)
    assert.equal(r.json.dry_run, true)
    assert.deepEqual(r.json.counts, { achievements: 4, stats: 2 })
    assert.equal(r.json.portal_json.achievements.length, 4)
    assert.deepEqual(r.json.commands[0], ['wavedash', 'achievement', 'list', '--json'])
    assert.ok(r.json.commands.some((c: string[]) => c.includes('--triggered-by-stat-id') && c.includes('--threshold')))
    assert.equal(await readFile(calls, 'utf8'), '') // the CLI was never started
    // an explicit dry_run:true with a token is still a dry run
    const t = await post({ game: 'kekkai', game_id: 'gid12345', catalog: CATALOG, dry_run: true }, { 'x-wavedash-token': 'secret-token-123' })
    assert.equal(t.json.dry_run, true)
    assert.equal(await readFile(calls, 'utf8'), '')
  })

  test('validation errors are 400, a missing game_id is refused', async () => {
    assert.equal((await post({ game: 'kekkai', game_id: 'gid12345', catalog: { stats: [], achievements: [{ identifier: '!', display_name: 'x', description: '' }] } })).status, 400)
    assert.equal((await post({ game: 'Bad Slug', game_id: 'gid12345', catalog: CATALOG })).status, 400)
    assert.equal((await post({ game: 'kekkai', catalog: CATALOG })).status, 400)
  })

  test('a real run needs dry_run:false AND the token; it creates stats, creates or updates achievements and links stat triggers', async () => {
    const noToken = await post({ game: 'kekkai', game_id: 'gid12345', catalog: CATALOG, dry_run: false })
    assert.equal(noToken.status, 409)
    await writeFile(calls, '')
    const started = await post({ game: 'kekkai', game_id: 'gid12345', catalog: CATALOG, dry_run: false }, { 'x-wavedash-token': 'secret-token-123' })
    assert.equal(started.status, 202)
    assert.equal(started.json.action, 'catalog')
    const run = await waitRun(started.json.id)
    assert.equal(run.status, 'ok', run.log)
    const log = (await readFile(calls, 'utf8')).trim().split('\n').map(l => l.replace(/ -c \S+$/, ''))
    assert.deepEqual(log, [
      'secret-token-123|achievement list --json',
      'secret-token-123|stat create --identifier wins --name Wins',
      'secret-token-123|stat create --identifier dup_stat --name Dup',
      'secret-token-123|achievement create --identifier first_win --title First win --description Win a match',
      'secret-token-123|achievement create --identifier ten_wins --title Ten wins --description Win 10 matches --secret --triggered-by-stat-id st_wins --threshold 10',
      'secret-token-123|achievement update --id ach_77 --title Existing --description Already on Wavedash --secret false',
      'secret-token-123|achievement create --identifier dup_trigger --title Dup trigger --description d',
    ])
    assert.match(run.log, /stat dup_stat already exists/)
    assert.match(run.log, /achievement dup_trigger: id of stat dup_stat unknown/)
    assert.ok(!run.log.includes('secret-token-123'))
  })

  test('a failing command fails the run', async () => {
    const bad = { stats: [{ identifier: 'bad_stat', display_name: 'Bad' }], achievements: [] }
    const started = await post({ game: 'kekkai', game_id: 'gid12345', catalog: bad, dry_run: false }, { 'x-wavedash-token': 'secret-token-123' })
    const run = await waitRun(started.json.id)
    assert.equal(run.status, 'failed')
  })
})

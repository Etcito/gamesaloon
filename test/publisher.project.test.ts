// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProjectArgv, parseCreateArgsEnv, parseProjectId } from '../src/publisher/project.ts'
import { createPublisher } from '../src/publisher/runner.ts'
import { createPublisherServer } from '../src/publisher/server.ts'
import { isLegacyGame, setOwnerGames } from '../src/store/legacy.ts'

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

// Fake-CLI cases: a fake `wavedash` behind the real HTTP server.
const KEY = 'k'.repeat(32)
const TOKEN = 'wvd_tok_secret_987654'
const TEMPLATE = ['projects', 'create', '--slug', '{slug}', '--name', '{name}']
setOwnerGames('kekkai') // kekkai is an owner game: its runs keep cfg.home, the status probe must not

// Logs "$WAVEDASH_TOKEN|$HOME|$*" per call. The __FAIL__ marker file makes the create command leak the token and fail.
const FAKE = `#!/bin/sh
echo "$WAVEDASH_TOKEN|$HOME|$*" >> "__LOG__"
case "$1 $2" in
  "auth status") if [ -n "$WAVEDASH_TOKEN" ]; then echo "Authenticated"; exit 0; else echo "Not authenticated"; exit 1; fi ;;
  "projects create") if [ -f "__FAIL__" ]; then echo "boom: $WAVEDASH_TOKEN"; exit 1; fi; echo '{"id":"AbCd1234Ef"}'; exit 0 ;;
esac
exit 9
`

describe('Wavedash project routes (fake CLI)', () => {
  let root: string, log: string, failMarker: string, home: string
  const servers: Server[] = []
  let base: string, baseNoTemplate: string
  let publisher: ReturnType<typeof createPublisher>

  async function listen(p: ReturnType<typeof createPublisher>): Promise<string> {
    const server = createPublisherServer(p, { key: KEY })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  async function call(url: string, init: RequestInit & { auth?: boolean; token?: string | null } = {}) {
    const headers = new Headers(init.headers)
    if (init.auth !== false) headers.set('authorization', `Bearer ${KEY}`)
    if (init.token !== null) headers.set('x-wavedash-token', init.token ?? TOKEN)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetch(url, { ...init, headers })
    const text = await res.text()
    return { status: res.status, text, json: JSON.parse(text) as any }
  }
  const create = (body: object, init: { auth?: boolean; token?: string | null } = {}, at = base) =>
    call(`${at}/wavedash/projects`, { method: 'POST', body: JSON.stringify(body), ...init })
  const logLines = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const lastLine = async () => (await logLines()).at(-1) ?? ''

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'pub-proj-'))
    log = join(root, 'calls.log')
    failMarker = join(root, 'fail')
    home = join(root, 'home')
    const bin = join(root, 'wavedash')
    await writeFile(bin, FAKE.replaceAll('__LOG__', log).replaceAll('__FAIL__', failMarker))
    await chmod(bin, 0o755)
    await mkdir(home, { recursive: true })
    const cfg = { dataDir: root, home, wavedashBin: bin, maxArtifactBytes: 200_000, keepArtifacts: 2, runTimeoutMs: 10_000 }
    publisher = createPublisher({ ...cfg, wavedashCreateArgs: TEMPLATE })
    base = await listen(publisher)
    baseNoTemplate = await listen(createPublisher(cfg))
  })
  after(async () => {
    for (const s of servers) s.close()
    await rm(root, { recursive: true, force: true })
  })

  test('the argv template is substituted per element and reaches the child', async () => {
    const r = await create({ game: 'my-game', name: 'My Fancy Game' })
    assert.equal(r.status, 201)
    const [, , args] = (await lastLine()).split('|')
    assert.equal(args, 'projects create --slug my-game --name My Fancy Game')
  })

  test('201 with the parsed game id', async () => {
    const r = await create({ game: 'my-game' })
    assert.equal(r.status, 201)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.game_id, 'AbCd1234Ef')
    assert.match(await lastLine(), /--name my-game$/) // the name defaults to the slug
  })

  test('the token reaches the child env but no response, listRuns or getRun output', async () => {
    const r = await create({ game: 'tok-game', name: 'Tok' })
    assert.equal(r.status, 201)
    assert.ok((await lastLine()).startsWith(`${TOKEN}|`))
    assert.ok(!r.text.includes(TOKEN))
    const runs = await publisher.listRuns()
    assert.ok(!JSON.stringify(runs).includes(TOKEN))
    for (const run of runs) assert.ok(!JSON.stringify(await publisher.getRun(run.id)).includes(TOKEN))
    const listed = await call(`${base}/runs`)
    assert.ok(!listed.text.includes(TOKEN))
  })

  test('a creator game runs in a private HOME under dataDir/work/<uuid>/home, removed afterwards', async () => {
    assert.equal(isLegacyGame('creator-game'), false)
    const r = await create({ game: 'creator-game' })
    assert.equal(r.status, 201)
    const [, childHome] = (await lastLine()).split('|')
    const m = childHome!.match(/^(.*)\/work\/([0-9a-f-]{36})\/home$/)
    assert.ok(m, `unexpected HOME ${childHome}`)
    assert.equal(m[1], root)
    assert.notEqual(childHome, home)
    await assert.rejects(stat(join(root, 'work', m[2]!)), { code: 'ENOENT' })
  })

  test('no PUBLISHER_WAVEDASH_CREATE_ARGS → 501 naming the env', async () => {
    const before = (await logLines()).length
    const r = await create({ game: 'my-game' }, {}, baseNoTemplate)
    assert.equal(r.status, 501)
    assert.match(r.json.error, /PUBLISHER_WAVEDASH_CREATE_ARGS/)
    assert.equal((await logLines()).length, before)
  })

  test('no X-Wavedash-Token → 409 without running the CLI', async () => {
    const before = (await logLines()).length
    const r = await create({ game: 'my-game' }, { token: null })
    assert.equal(r.status, 409)
    assert.match(r.json.error, /Wavedash API key missing/)
    assert.equal((await logLines()).length, before)
  })

  test('a failing CLI → 502 with a scrubbed detail', async () => {
    await writeFile(failMarker, '')
    try {
      const r = await create({ game: 'my-game' })
      assert.equal(r.status, 502)
      assert.match(r.json.error, /\[REDACTED\]/)
      assert.ok(!r.text.includes(TOKEN))
      assert.match(await lastLine(), /projects create/)
    } finally {
      await rm(failMarker, { force: true })
    }
  })

  test('GET /wavedash/status for an owner game runs in a private HOME, not cfg.home', async () => {
    assert.equal(isLegacyGame('kekkai'), true)
    const r = await call(`${base}/wavedash/status?game=kekkai`)
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.ok(!r.text.includes(TOKEN))
    const [tok, childHome, args] = (await lastLine()).split('|')
    assert.equal(tok, TOKEN)
    assert.equal(args, 'auth status')
    assert.notEqual(childHome, home)
    assert.match(childHome!, /\/work\/[0-9a-f-]{36}\/home$/)
  })

  test('a missing bearer → 401 on both routes', async () => {
    assert.equal((await create({ game: 'my-game' }, { auth: false })).status, 401)
    assert.equal((await call(`${base}/wavedash/status?game=kekkai`, { auth: false })).status, 401)
  })
})

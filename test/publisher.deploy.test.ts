// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, renderPublisherDeploy, runPublisherDeploy } from '../deploy/publisher/publisher-deploy.ts'

const options = { host: 'deploy@example.test', service: 'publisher.service', appDir: '/opt/publisher',
  envFile: '/etc/gamesaloon-publisher.env', backupRoot: '/var/backups/publisher',
  healthUrl: 'http://127.0.0.1:9997/health', stamp: '20261019T120000Z' }
type Recorded = [string, string[]]

function spy(failAt = 0): { calls: Recorded[]; exec: (cmd: string, args: string[]) => Promise<number> } {
  const calls: Recorded[] = []
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, args])
    return Promise.resolve(calls.length === failAt ? 1 : 0)
  }
  return { calls, exec }
}

test('publisher deploy: labels follow contract, with optional env step', () => {
  assert.deepEqual(renderPublisherDeploy({ ...options, createArgs: ['create', '{slug}'] }).steps.map((s) => s.label),
    ['backup', 'stage', 'install', 'env', 'restart', 'health'])
  assert.deepEqual(renderPublisherDeploy(options).steps.map((s) => s.label),
    ['backup', 'stage', 'install', 'restart', 'health'])
})

test('publisher deploy: backup precedes every write step', () => {
  const labels = renderPublisherDeploy({ ...options, createArgs: [] }).steps.map((s) => s.label)
  const backup = labels.indexOf('backup')
  for (const label of ['stage', 'install', 'env', 'restart']) assert.ok(backup < labels.indexOf(label))
})

test('publisher deploy: only one systemctl call restarts the given service', () => {
  const steps = renderPublisherDeploy(options).steps
  const calls = steps.flatMap((s) => s.args.flatMap((arg) => {
    const executable = arg.replace(/echo 'restore: [\s\S]*?'(?=;|\s*\}|$)/g, '')
    return [...executable.matchAll(/systemctl\s+\w+[^;&|]*/g)].map((m) => [s.label, m[0]])
  }))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['restart', `systemctl restart ${options.service}`])
  assert.ok(steps.at(-1)!.args.join(' ').includes(`systemctl restart ${options.service}`))
})

test('publisher deploy: health is last and includes restore command and backup path', () => {
  const plan = renderPublisherDeploy(options)
  const health = plan.steps.at(-1)!
  assert.equal(health.label, 'health')
  assert.ok(health.args.join(' ').includes('restore:'))
  assert.ok(health.args.join(' ').includes(`${options.backupRoot}/${options.stamp}`))
})

test('publisher deploy: env step assigns only the create args variable', () => {
  const env = renderPublisherDeploy({ ...options, createArgs: ['--game', '{slug}'] }).steps.find((s) => s.label === 'env')!
  const assignments = [...env.args.join(' ').matchAll(/\b([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1])
  assert.deepEqual([...new Set(assignments)], ['PUBLISHER_WAVEDASH_CREATE_ARGS'])
})

test('publisher deploy: process secrets never appear in the rendered plan', () => {
  const before = { publisher: process.env.PUBLISHER_KEY, api: process.env.ETCITO_API_KEY }
  process.env.PUBLISHER_KEY = 'FAKE_PUBLISHER_SECRET'
  process.env.ETCITO_API_KEY = 'gsk_FAKE_API_SECRET'
  try {
    const plan = renderPublisherDeploy(options)
    const json = JSON.stringify(plan)
    assert.ok(!json.includes(process.env.PUBLISHER_KEY!))
    assert.ok(!json.includes(process.env.ETCITO_API_KEY!))
  } finally {
    if (before.publisher === undefined) delete process.env.PUBLISHER_KEY
    else process.env.PUBLISHER_KEY = before.publisher
    if (before.api === undefined) delete process.env.ETCITO_API_KEY
    else process.env.ETCITO_API_KEY = before.api
  }
})

test('runPublisherDeploy: rejects at install and never calls later steps', async () => {
  const plan = renderPublisherDeploy({ ...options, createArgs: ['create'] })
  const { calls, exec } = spy(3)
  await assert.rejects(runPublisherDeploy(plan, exec), /publisher deploy step "install" failed/)
  assert.deepEqual(calls, plan.steps.slice(0, 3).map((s) => [s.cmd, s.args]))
})

test('main: dry run writes plan.json without executing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'publisher-deploy-'))
  try {
    const { calls, exec } = spy()
    assert.equal(await main(['--dry-run', '--out', dir, '--host', options.host, '--service', options.service,
      '--app-dir', options.appDir], exec), 0)
    assert.equal(calls.length, 0)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')).steps.map((s: {label: string}) => s.label),
      ['backup', 'stage', 'install', 'restart', 'health'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('main: missing required service or app dir returns exit 2', async () => {
  const { calls, exec } = spy()
  const base = ['--dry-run', '--out', '/tmp/unused', '--host', options.host]
  assert.equal(await main([...base, '--app-dir', options.appDir], exec), 2)
  assert.equal(await main([...base, '--service', options.service], exec), 2)
  assert.equal(calls.length, 0)
})

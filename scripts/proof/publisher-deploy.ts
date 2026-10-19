// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// M7 proof: the publisher deploy plan is safe to apply.
// Five checks: plan-renders, backup-before-write, single-restart, health-last, no-secret-in-plan.
// Nothing here touches the network or a real exec (never pass --apply).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PublisherDeployPlan } from '../../deploy/publisher/publisher-deploy.ts'
import { runChecks, spawnCheck, type Check, type CheckResult } from './lib.ts'

const tmpDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const SERVICE = 'etcito-publisher-proof'
const WRITE_LABELS = ['stage', 'install', 'env', 'restart']

function dryRunArgs(out: string): string[] {
  return [
    '--experimental-strip-types', 'deploy/publisher/publisher-deploy.ts',
    '--dry-run', '--out', out,
    '--host', 'proof@127.0.0.1', '--service', SERVICE, '--app-dir', '/opt/proof',
    '--create-args', '["create","{slug}"]',
  ]
}

function readPlan(dir: string): PublisherDeployPlan {
  const path = join(dir, 'plan.json')
  if (!existsSync(path)) throw new Error(`no plan.json in ${dir} (run plan-renders)`)
  return JSON.parse(readFileSync(path, 'utf8')) as PublisherDeployPlan
}

// The health step echoes the restore command on failure; that text is printed, not executed.
function executable(arg: string): string {
  return arg.replace(/echo 'restore: [\s\S]*?'(?=;|\s*\}|$)/g, '')
}

const planDir = tempDir('publisher-deploy-proof-')
let rendered: Promise<CheckResult> | null = null
const renderCheck: Check = spawnCheck('plan-renders', process.execPath, dryRunArgs(planDir), {
  timeoutMs: 30000,
  expect: ({ code }) => {
    let steps = -1
    try { steps = readPlan(planDir).steps.length } catch { steps = -1 }
    return { value: `exit ${code}, steps ${steps}`, threshold: 'exit 0, steps 6', ok: code === 0 && steps === 6 }
  },
})
// Checks that read the plan render it first when run alone (--only).
function ensurePlan(): Promise<CheckResult> {
  rendered ??= renderCheck.run()
  return rendered
}

const planRenders: Check = { label: 'plan-renders', run: ensurePlan }

const backupBeforeWrite: Check = {
  label: 'backup-before-write',
  async run(): Promise<CheckResult> {
    await ensurePlan()
    const labels = readPlan(planDir).steps.map((step) => step.label)
    const backup = labels.indexOf('backup')
    const writes = WRITE_LABELS.map((label) => labels.indexOf(label)).filter((i) => i >= 0)
    const ok = backup >= 0 && writes.length === WRITE_LABELS.length && writes.every((i) => backup < i)
    return { value: `backup ${backup}, writes [${writes.join(',')}]`, threshold: 'backup < every write', ok }
  },
}

const singleRestart: Check = {
  label: 'single-restart',
  async run(): Promise<CheckResult> {
    await ensurePlan()
    const steps = readPlan(planDir).steps
    const restarting = steps.filter((step) => step.args.some((arg) => /systemctl restart/.test(executable(arg))))
    const units = restarting.flatMap((step) => step.args.flatMap((arg) =>
      [...executable(arg).matchAll(/systemctl restart\s+([^\s;&|]+)/g)].map((m) => m[1])))
    const ok = restarting.length === 1 && units.length === 1 && units[0] === SERVICE
    return { value: `restarts ${restarting.length}, units [${units.join(',')}]`, threshold: `restarts 1, units [${SERVICE}]`, ok }
  },
}

const healthLast: Check = {
  label: 'health-last',
  async run(): Promise<CheckResult> {
    await ensurePlan()
    const last = readPlan(planDir).steps.at(-1)?.label ?? '(none)'
    return { value: `last ${last}`, threshold: 'last health', ok: last === 'health' }
  },
}

const FAKE_SECRETS: Record<string, string> = {
  PUBLISHER_KEY: 'FAKE_PUBLISHER_KEY_PROOF_1234',
  ETCITO_API_KEY: 'gsk_FAKEPROOF0123456789abcdef',
  WAVEDASH_API_TOKEN: 'FAKE_WAVEDASH_TOKEN_PROOF_5678',
}
const secretDir = tempDir('publisher-deploy-secret-')
const noSecret: Check = spawnCheck('no-secret-in-plan', process.execPath, dryRunArgs(secretDir), {
  env: FAKE_SECRETS,
  timeoutMs: 30000,
  expect: ({ code }) => {
    const path = join(secretDir, 'plan.json')
    if (code !== 0 || !existsSync(path)) {
      return { value: `exit ${code}, no plan.json`, threshold: 'leaks 0', ok: false }
    }
    const text = readFileSync(path, 'utf8')
    const leaks = Object.values(FAKE_SECRETS).filter((secret) => text.includes(secret)).length
    return { value: `leaks ${leaks}`, threshold: 'leaks 0', ok: leaks === 0 }
  },
})

const checks: Check[] = [planRenders, backupBeforeWrite, singleRestart, healthLast, noSecret]
await runChecks(checks, process.argv.slice(2))

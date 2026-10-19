// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Deploy rendering and execution for the Etcito publisher sidecar (not the rooms server).
// renderPublisherDeploy builds the plan (staged paths plus the ordered ssh/rsync steps:
// backup, stage, install, env, restart, health); runPublisherDeploy walks the steps with
// an injected exec. main is the CLI: --dry-run renders into --out and executes nothing,
// --apply runs the plan. The plan holds paths only, never an env value or a secret.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseCreateArgsEnv } from '../../src/publisher/project.ts'

const DEPLOY_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(DEPLOY_DIR, '..', '..')

const REMOTE_STAGING_DIR = '/tmp/etcito-publisher-deploy/'
const CREATE_ARGS_KEY = 'PUBLISHER_WAVEDASH_CREATE_ARGS'
const BACKUP_TAR = 'app.tgz'

// Defaults from crm docs/etcito-agent/01-measure.md "## Publisher on the VM".
export const DEFAULT_ENV_FILE = '/etc/gamesaloon-publisher.env'
export const DEFAULT_HEALTH_URL = 'http://127.0.0.1:9997/health'
export const DEFAULT_BACKUP_ROOT = '/var/backups/etcito-publisher'

export type DeployExec = (cmd: string, args: string[]) => Promise<number>

export interface PublisherDeployOptions {
  host: string
  appDir: string
  service: string
  envFile: string
  backupRoot: string
  healthUrl: string
  createArgs?: string[]
  stamp?: string
}

export interface PublisherDeployStep {
  label: string
  cmd: string
  args: string[]
}

export interface PublisherDeployPlan {
  files: { source: string; target: string }[]
  steps: PublisherDeployStep[]
}

/** Quotes a value for a POSIX shell: wraps it in single quotes, escaping inner ones. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** UTC timestamp as YYYYMMDDTHHMMSSZ. */
export function utcStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function renderPublisherDeploy(o: PublisherDeployOptions): PublisherDeployPlan {
  const stamp = o.stamp ?? utcStamp()
  const backupDir = `${o.backupRoot}/${stamp}`
  const envBackup = `${backupDir}/${basename(o.envFile)}`
  const restore = [
    `sudo tar -xzf ${backupDir}/${BACKUP_TAR} -C ${o.appDir}`,
    `sudo cp -a ${envBackup} ${o.envFile}`,
    `sudo systemctl restart ${o.service}`,
  ].join(' && ')

  const files = [
    { source: join(REPO_ROOT, 'src', 'publisher'), target: `${o.appDir}/src/publisher` },
    { source: join(REPO_ROOT, 'src', 'store'), target: `${o.appDir}/src/store` },
    { source: join(REPO_ROOT, 'package.json'), target: `${o.appDir}/package.json` },
  ]

  const steps: PublisherDeployStep[] = [
    {
      label: 'backup',
      cmd: 'ssh',
      args: [o.host, [
        `sudo mkdir -p ${backupDir}`,
        `sudo tar -czf ${backupDir}/${BACKUP_TAR} -C ${o.appDir} src package.json`,
        `sudo cp -a ${o.envFile} ${backupDir}/`,
      ].join(' && ')],
    },
    {
      label: 'stage',
      cmd: 'rsync',
      args: ['-az', '--delete', ...files.map((file) => file.source), `${o.host}:${REMOTE_STAGING_DIR}`],
    },
    {
      label: 'install',
      cmd: 'ssh',
      args: [o.host, [
        `sudo mkdir -p ${o.appDir}/src`,
        `sudo cp -a ${REMOTE_STAGING_DIR}publisher ${REMOTE_STAGING_DIR}store ${o.appDir}/src/`,
        `sudo cp -a ${REMOTE_STAGING_DIR}package.json ${o.appDir}/`,
      ].join(' && ')],
    },
  ]

  if (o.createArgs !== undefined) {
    const line = `${CREATE_ARGS_KEY}=${JSON.stringify(o.createArgs)}`
    steps.push({
      label: 'env',
      cmd: 'ssh',
      args: [o.host, [
        `sudo sed -i '/^${CREATE_ARGS_KEY}=/d' ${o.envFile}`,
        `printf '%s\\n' ${shellQuote(line)} | sudo tee -a ${o.envFile} >/dev/null`,
      ].join(' && ')],
    })
  }

  steps.push(
    {
      label: 'restart',
      cmd: 'ssh',
      args: [o.host, `sudo systemctl restart ${o.service}`],
    },
    {
      label: 'health',
      cmd: 'ssh',
      args: [o.host, `curl -fsS ${o.healthUrl} | grep -qF '"ok":true' || { echo ${shellQuote(`restore: ${restore}`)}; exit 1; }`],
    },
  )

  return { files, steps }
}

export async function runPublisherDeploy(plan: PublisherDeployPlan, exec: DeployExec): Promise<void> {
  for (const step of plan.steps) {
    const code = await exec(step.cmd, step.args)
    if (code !== 0) {
      throw new Error(`publisher deploy step "${step.label}" failed: ${step.cmd} exited with code ${code}`)
    }
  }
}

function planText(plan: PublisherDeployPlan): string {
  return plan.steps.map((step) => `${step.label}: ${step.cmd} ${step.args.join(' ')}`).join('\n')
}

const USAGE = `usage: publisher-deploy.ts --host <user@host> --service <unit> --app-dir <dir> [options] --dry-run --out <dir>
       publisher-deploy.ts --host <user@host> --service <unit> --app-dir <dir> [options] --apply
options: --env-file <path> (${DEFAULT_ENV_FILE}) --backup-root <dir> (${DEFAULT_BACKUP_ROOT})
         --health-url <url> (${DEFAULT_HEALTH_URL}) --stamp <YYYYMMDDTHHMMSSZ> --create-args <json>`

interface CliArgs {
  options: PublisherDeployOptions
  dryRun: boolean
  out: string | null
}

function parseArgs(argv: string[]): CliArgs | null {
  const values = new Map<string, string>()
  const valued = ['--host', '--service', '--app-dir', '--env-file', '--backup-root', '--health-url', '--stamp', '--create-args', '--out']
  let dryRun = false
  let apply = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (valued.includes(arg) && i + 1 < argv.length && !values.has(arg)) values.set(arg, argv[++i]!)
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--apply') apply = true
    else return null
  }

  const host = values.get('--host')
  const service = values.get('--service')
  const appDir = values.get('--app-dir')
  const out = values.get('--out')
  if (!host || !service || !appDir) return null
  if (dryRun === apply) return null
  if (dryRun && out === undefined) return null
  if (apply && out !== undefined) return null

  let createArgs: string[] | undefined
  const rawCreateArgs = values.get('--create-args')
  if (rawCreateArgs !== undefined) {
    try { createArgs = parseCreateArgsEnv(rawCreateArgs) } catch { return null }
    if (createArgs === undefined) return null
  }

  return {
    options: {
      host,
      service,
      appDir,
      envFile: values.get('--env-file') ?? DEFAULT_ENV_FILE,
      backupRoot: values.get('--backup-root') ?? DEFAULT_BACKUP_ROOT,
      healthUrl: values.get('--health-url') ?? DEFAULT_HEALTH_URL,
      createArgs,
      stamp: values.get('--stamp'),
    },
    dryRun,
    out: out ?? null,
  }
}

export async function main(argv: string[], exec: DeployExec): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }

  try {
    const plan = renderPublisherDeploy(parsed.options)

    if (parsed.dryRun) {
      const outDir = parsed.out as string
      mkdirSync(outDir, { recursive: true })
      const jsonPath = join(outDir, 'plan.json')
      const textPath = join(outDir, 'plan.txt')
      writeFileSync(jsonPath, JSON.stringify(plan, null, 2))
      writeFileSync(textPath, planText(plan))
      console.log(jsonPath)
      console.log(textPath)
      return 0
    }

    await runPublisherDeploy(plan, exec)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const exec: DeployExec = (cmd, args) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
  main(process.argv.slice(2), exec).then((code) => process.exit(code))
}

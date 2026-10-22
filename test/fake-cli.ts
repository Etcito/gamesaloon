// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Fake CLIs for the publisher tests, written as Node scripts so they run the same on Linux, macOS and Windows
// (a "#!/bin/sh" fake cannot be spawned on Windows). The runner starts a .mjs bin with the current Node.
// The body is the inside of an async function: `args`, `env`, `log(file, line)`, `sleep(ms)` and the node:fs
// helpers below are in scope, `return <code>` sets the exit code (0 when nothing is returned).
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeFakeCli(dir: string, name: string, body: string): Promise<string> {
  const bin = join(dir, `${name}.mjs`)
  await writeFile(bin, `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2), env = process.env
const log = (file, line) => appendFileSync(file, line + '\\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
process.exitCode = (await (async () => {
${body}
})()) ?? 0
`)
  return bin
}

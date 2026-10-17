#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// CLI entry: `npx gamesaloon` starts the server (configure with env vars, see .env.example).
// Defaults: PORT=8787, HOST=127.0.0.1.
await import('../dist/main.js')

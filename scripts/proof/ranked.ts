// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { runChecks, testFileCheck } from './lib.ts'

const files = ['test/ranked.e2e.test.ts', 'test/ranked.service.test.ts', 'test/names.test.ts']

runChecks([
  testFileCheck('gate', files, { minPassed: 4, namePattern: '^gate:' }),
  testFileCheck('forfeit', files, { minPassed: 5, namePattern: '^forfeit:' }),
  testFileCheck('outcome', files, { minPassed: 5, namePattern: '^outcome:' }),
  testFileCheck('ladder', files, { minPassed: 6, namePattern: '^ladder:' }),
  testFileCheck('names', files, { minPassed: 5, namePattern: '^names:' }),
], process.argv.slice(2))

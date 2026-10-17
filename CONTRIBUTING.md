# Contributing to GameSaloon

Thank you for helping. Short version: open an issue for anything non-trivial,
keep pull requests small, run the tests, sign the CLA.

## Licences

The server is AGPL-3.0-or-later; protocol docs and client/example code are MIT.
See [LICENSING.md](LICENSING.md) for which directory is which. Your
contribution is accepted under the [CLA](CLA.md): you keep your copyright and
license it to Etcito, which lets Etcito also offer a commercial licence.

## Contributor Licence Agreement

On your first pull request a bot asks you to sign the CLA by posting one
comment. It is asked once per contributor. No signature, no merge.

## Set up

Requires Node.js >= 22.18.

    npm ci
    npm run typecheck
    npm test
    npm start          # standalone server

## Pull requests

- One topic per pull request, with a clear description of the why.
- Add or update tests for behaviour changes (`test/`, run with `node:test`).
- `npm run typecheck` and `npm test` must pass.
- Every new source file starts with the SPDX header:

      // SPDX-License-Identifier: AGPL-3.0-or-later
      // Copyright (c) 2026 Etcito

  (MIT files use `MIT` instead.)
- Keep the wire protocol (`PROTOCOL.md`) and its typed copy (`src/protocol.ts`)
  in step; a protocol change needs an issue first.
- A DCO sign-off is not required; the CLA replaces it.

## Conduct and security

Be kind, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

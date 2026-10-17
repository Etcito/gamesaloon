# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. Report privately through GitHub's
"Report a vulnerability" (Security tab, private advisories) on this repository,
or write to **contact@etcito.com**.

Include what you found, how to reproduce it, and the version or commit. We aim
to acknowledge within 5 working days and to share a plan within 15. We credit
reporters who want it once a fix is released.

## Scope

The server in this repository: WebSocket protocol handling, rooms, relay,
matchmaking, rate limiting, origin checks, and the deploy files. Denial of
service through unbounded resource use is in scope.

Out of scope: vulnerabilities in your own game or in a third-party
`PlayerStore` implementation, and findings that need a misconfigured deployment.

## Supported versions

Only the latest release and the `main` branch receive fixes while the project
is pre-1.0.

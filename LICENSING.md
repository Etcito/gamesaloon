# Licensing at a glance

GameSaloon is dual-licensed by Etcito.

| What | Where | Licence |
| --- | --- | --- |
| The server (`src/`, `scripts/`, `deploy/`, `test/`) | this repository | **AGPL-3.0-or-later**, see [LICENSE](LICENSE) |
| The wire-protocol documentation (`PROTOCOL.md`, `docs/RELAY.md`) and any client SDK or example client code added under `clients/` or `examples/` | this repository | **MIT**, see [LICENSE-MIT](LICENSE-MIT) |
| The server under non-AGPL terms | by agreement | **Commercial licence**, see [COMMERCIAL.md](COMMERCIAL.md) |

## Your game is not covered by the AGPL

A game that connects to a GameSaloon server over WebSocket is **not** a
derivative work of the server. It talks to the server through a public
protocol, the same way a web browser talks to any web server. You can build a
closed-source, commercial game on GameSaloon and you owe us nothing: no source
code, no licence fee, no attribution for your game.

The AGPL applies if you modify the **server** itself (or embed it in your own
program) and let other people use that modified server over a network. Then
you must offer those users the source of your modified server. If you cannot or
do not want to, ask for a commercial licence.

This is a plain-words summary, not legal advice; the licence texts are what
binds.

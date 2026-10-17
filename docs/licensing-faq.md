# Licensing FAQ

GameSaloon is owned by Etcito and is released under the **GNU Affero General Public License, version 3 or (at your option) any later version (AGPL-3.0-or-later)**; the protocol documentation and example client code are under the MIT licence (see [LICENSING.md](../LICENSING.md)). A **commercial licence** is available from Etcito for those who prefer not to be bound by the AGPL ([COMMERCIAL.md](../COMMERCIAL.md)). The authoritative texts are `LICENSE`, `LICENSE-MIT`, `LICENSING.md` and your commercial agreement, if you have one.

**This page is a plain-English guide, not legal advice.** Licence questions about your own product are best answered by a lawyer who has read the licence.

## The short version

- You can use, study, modify and run GameSaloon for free, including commercially, as long as you follow the AGPL.
- If you modify it and let other people use your modified version over a network (for example, you host a changed server for your players), the AGPL requires you to offer those users the source code of your modified version, under the AGPL.
- A game that only *talks to* a GameSaloon server over WebSocket is a separate program and is not covered by the AGPL because of that.
- If you cannot or do not want to publish your changes, or you want to build the server into a closed-source product, take the commercial licence instead.

## Questions

### Do I have to pay to run it?

No. The AGPL licence is free of charge, for personal, hobby and commercial use. The commercial licence is a separate agreement with Etcito.

### I run GameSaloon unmodified for my game. What do I owe?

Nothing beyond keeping the licence and copyright notices intact. The network clause of the AGPL (section 13) is triggered by *modifying* the program and then letting users interact with it remotely. Running the unmodified program does not require you to publish anything. It is good practice to link to the project's source from your game's credits page, and if you also *distribute* copies (for example a Docker image of the unmodified program) the normal rules of the licence for distribution apply, which means passing on the licence and providing the source.

### I changed the server and host it for my players. What must I do?

Offer every user who interacts with your modified server remotely a way to get the corresponding source code of your modified version, under the AGPL. Typically that is a link to a public repository containing your version, kept in sync with what you run. "Corresponding source" includes your changes and what is needed to build and run it, but not unrelated programs that merely talk to it. You must keep the licence and copyright notices and mark your modifications.

### What counts as a modification?

Changing the code of GameSaloon itself: editing files under `src/`, adding a new store or hook implementation into the repository's code, patching a protocol. Configuring it with environment variables, or deploying the unmodified files, is not a modification.

### I use GameSaloon as a library in my own Node server (`createHandshake`). Is my code covered?

Be careful here. Importing the library and running it in the same process creates a single combined program, and the AGPL treats a work based on the program as covered by the AGPL. If you host such a combined program for players, the safe reading is that the corresponding source of the whole combined server (your code included) must be offered to those users. The simple ways to avoid the question are: run GameSaloon as a separate process (`npm start` or the container) and talk to it over the network, or take the commercial licence. If this matters to your product, ask a lawyer.

Providing your own `PlayerStore`, identity verifier or hooks to an embedded server is the same situation: those pieces run inside the combined program.

### My game client is a web page that connects to a GameSaloon server. Is the game open source now?

No. A game that communicates with the server through the documented WebSocket protocol is a separate work that happens to use a network service. The AGPL does not extend to programs that only exchange messages with an AGPL program at arm's length, and it does not make your client, your assets or your game logic open source. This is the reason the protocol is documented ([protocol.md](protocol.md)): you can write a client without copying any GameSaloon code. If you copy GameSaloon source code into your game (for example, the repository's protocol validators), that copied code stays under the AGPL.

### What about the example code in the documentation?

Treat the samples in these documents as part of the repository and subject to the repository's licence notices. If you need different terms for a snippet, ask Etcito or use the commercial licence.

### Can I run a competing hosted service on GameSaloon?

The AGPL allows it, provided you comply with it: you must offer your users the source of your modified version. The licence does not give you any right to Etcito's names, logos or to the hosted service built on GameSaloon (Etcito), which is a separate, private product.

### What does the commercial licence give me?

The right to use GameSaloon without the AGPL's source-sharing obligations: modify it privately, embed it in a closed-source server, and host it without offering the source of your changes. Terms, price and support are agreed in writing with Etcito: see [COMMERCIAL.md](../COMMERCIAL.md) and write to contact@etcito.com.

### Can I contribute?

Contributions are welcome. Because Etcito offers GameSaloon under both the AGPL and a commercial licence, it must be able to license every contribution under both. Contributors are therefore asked to agree to the [CLA](../CLA.md) (by posting the comment the CLA bot asks for on your pull request), which grants Etcito the necessary rights, including the right to sublicense your contribution under any terms, while you keep the copyright in it. See [CONTRIBUTING.md](../CONTRIBUTING.md). Read the CLA text before you agree; if your employer owns your work, make sure you have permission to contribute.

### Does the AGPL apply to the data of my players?

No. The licence covers the software, not the data it stores or the messages players send. Your obligations about player data (privacy law, consent, retention) are separate and are your responsibility as the operator.

### Where do I look in the repository?

The licence text and any notices are in the root of the repository. When in doubt, the files in the repository, not this page, are authoritative.

# loom for VS Code

Navigation, diagnostics and commands for [loom](https://github.com/ikmartin/loom) quilts, through the [loom language server](https://github.com/ikmartin/loom-lsp).

It activates only inside a quilt: a folder with a `config.toml` holding a `[quilt]` table. An ordinary LaTeX workspace is untouched, and no language client is started there.

## What you get

- **Diagnostics** as `loom lint` reports them, republished as you type rather than as you save.
- **Go to definition** on `\ref`, `\eqref`, `\cref`, `\uses`, `\cite`, `\input` and `\nest`; **find references**; **hover** with the state and the first lines of the statement; a **document symbol** outline with proofs under their statements; **completion** of ids, aliases, citekeys, taxa and `% !LOOM` directive keys.
- **Go to Symbol in Workspace** (Cmd/Ctrl+T) finds a node by its title, an alias, a tag or its id.
- **Show Call Hierarchy** on a node shows what it uses (outgoing) and what uses it (incoming).
- **Inlay hints** show what each `\ref`, `\uses` and `\input` points to.
- **Code actions**: add a `\uses` entry the proof references but does not list; accept the key under the cursor, atomize the file, or insert a node skeleton, each confirming first when it writes; open the node in arras.
- **Commands** under `Loom:` in the palette: status, lint, new node, accept, serve, open in arras, bundle, restart the server.
- A **status bar item** naming the node under the cursor, which opens it in arras.

**Open in arras launches your browser** rather than embedding a webview. arras is a web application; a browser tab is what it wants to be, and it is the same page you would get from `loom serve`.

**Each window owns its servers**: one `loom serve` per quilt, on a free port the extension picks. Serve starts it, and Open in arras starts it if it is not running and says so. It runs in a terminal named `loom serve` that is not brought to the front, so the editor keeps focus, and it stops when the window closes.

## Settings

| setting | default | meaning |
|---|---|---|
| `loom.loomPath` | `loom` | the loom executable |
| `loom.serverPath` | `loom-lsp` | the language server executable |
| `loom.autostart` | `true` | start the language server in a quilt |

`LOOM_BIN` and `LOOM_LSP` in the environment override the first two. The extension host does not inherit a shell's `PATH`, so this is how to name executables that live in a virtual environment without writing to your settings.

## Developing

```
npm install
npm run compile
npm run lint
LOOM_LSP=../loom-lsp/.venv/bin/loom-lsp LOOM_BIN=../loom/.venv/bin/loom npm test
npm run package        # a .vsix to install by hand
```

`npm test` runs two passes in a real VS Code. Inside a copy of loom's synthetic quilt, 27 tests cover the command builders and the serve helpers, the commands, starting and reusing a server for Open in arras (against a stub, and against a real `loom serve` when `LOOM_BIN` is set), and, when `LOOM_LSP` is set, the client reaching *running* with workspace symbols, call hierarchy and inlay hints answering. In a plain LaTeX folder, 3 tests check that no client starts. Copy the quilt into `fixtures/synthetic` first (`cp -R ../loom/tests/quilts/synthetic fixtures/synthetic`).

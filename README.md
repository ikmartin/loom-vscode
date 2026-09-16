# loom for VS Code

Navigation, diagnostics and commands for [loom](https://github.com/ikmartin/loom) quilts, through the [loom language server](https://github.com/ikmartin/loom-lsp).

It activates only inside a quilt: a folder with a `config.toml` holding a `[quilt]` table. An ordinary LaTeX workspace is untouched, and no language client is started there.

## What you get

- **Diagnostics** as `loom lint` reports them, republished as you type rather than as you save.
- **Go to definition** on `\ref`, `\eqref`, `\cref`, `\uses`, `\cite`, `\input` and `\nest`; **find references**; **hover** with the state and the first lines of the statement; a **document symbol** outline with proofs under their statements; **completion** of ids, aliases, citekeys, taxa and `% !LOOM` directive keys.
- **Code actions**, including adding a `\uses` entry the proof references but does not list.
- **Commands** under `Loom:` in the palette: status, lint, new node, accept, serve, open in arras, bundle, restart the server.
- A **status bar item** naming the node under the cursor, which opens it in arras.

**Open in arras launches your browser** rather than embedding a webview. arras is a web application; a browser tab is what it wants to be, and it is the same page you would get from `loom serve`.

## Settings

| setting | default | meaning |
|---|---|---|
| `loom.loomPath` | `loom` | the loom executable |
| `loom.serverPath` | `loom-lsp` | the language server executable |
| `loom.servePort` | `8000` | the port `loom serve` listens on, and the one "open in arras" uses |
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

`npm test` runs two integration passes in a real VS Code: one inside a copy of loom's synthetic quilt, where the client must reach *running*, and one in a plain LaTeX folder, where no client may start. Copy the quilt into `fixtures/synthetic` first (`cp -R ../loom/tests/quilts/synthetic fixtures/synthetic`).

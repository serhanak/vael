# vael

> A lightweight, privacy-first, cross-platform editor for **Markdown, plain text, and code**.

vael is an open-source desktop editor that sits between a calm Markdown writing
app (like Typora) and a fast code editor (like a modern, cross-platform
Notepad++). It is built to stay light and fast while handling the things other
editors get wrong: **very large files**, **correct & visible encoding/BOM/EOL**,
and **offline-by-default with zero telemetry**.

**Status:** 🚧 Early development (Milestone M0 — scaffold & spikes). Not yet usable.

## Why

- **Lightweight & fast** — native shell (Tauri v2 / Rust + system WebView), not Electron.
- **Privacy & offline** — local files only, no network calls, no telemetry.
- **Big files** — designed to open multi-GB logs without choking (streaming + virtualized viewer).
- **Honest encoding** — UTF-8 (no BOM) by default; encoding/BOM/EOL always visible, never silently rewritten.
- **Simple but capable** — clean default UI; Markdown source / live preview / WYSIWYG, plus real code editing.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri v2 (Rust + OS WebView) |
| Frontend | TypeScript + Vite + Lit |
| Code editor | CodeMirror 6 |
| Markdown WYSIWYG | Milkdown / Crepe *(later)* |
| Live preview | markdown-it + KaTeX + Mermaid *(later)* |
| License | MIT |

See [`PLAN.md`](./PLAN.md) for the full architecture and roadmap, and
[`docs/design/`](./docs/design/) for per-subsystem design notes.

## Development

Prerequisites:

- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/) 9+
- [Rust](https://rustup.rs/) (stable) + the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

```bash
pnpm install
pnpm tauri icon app-icon.png   # generate app icons (one-time, after install)
pnpm tauri dev                 # run the desktop app
```

Frontend-only (no Rust required), runs in a browser without file I/O:

```bash
pnpm dev
```

## License

[MIT](./LICENSE)

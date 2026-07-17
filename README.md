# vael

> A lightweight, privacy-first, cross-platform editor for **Markdown, plain text, and code**.

vael is an open-source desktop editor that sits between a calm Markdown writing
app (like Typora) and a fast code editor (like a modern, cross-platform
Notepad++). It is built to stay light and fast while handling the things other
editors get wrong: **very large files**, **correct & visible encoding/BOM/EOL**,
and **offline-by-default with zero telemetry**.

**Status:** 🚀 Preview release [`v0.1.0-preview.1`](https://github.com/serhanak/vael/releases).
Milestone **M1 (core editing) is complete** and several M2/M3 features have shipped
(live preview, HTML export, command palette, file-watch). Usable day-to-day for
Markdown/text/code; a few advanced features (WYSIWYG, PDF/DOCX export) are still
in progress — see [Roadmap](#roadmap). No prebuilt installers yet — build from
source (below).

## Why

- **Lightweight & fast** — native shell (Tauri v2 / Rust + system WebView), not Electron.
- **Privacy & offline** — local files only, no telemetry. (One caveat: a Markdown
  `![](https://…)` image stays a remote reference in the live preview and HTML
  export — that single case reaches the network; everything else is local.)
- **Big files** — opens multi-GB logs without choking: a 3-tier strategy scales
  from full editing to a streaming, virtualized read-only viewer.
- **Honest encoding** — UTF-8 (no BOM) by default; encoding/BOM/EOL always visible
  in the status bar, never silently rewritten. Converting to a legacy encoding
  that would lose characters warns you first.
- **Simple but capable** — clean default UI; Markdown source and live split preview,
  plus real code editing (CodeMirror 6).

## Features

What works today:

- **Encoding/BOM/EOL aware** open & save with detection, a visible status bar,
  reopen-with-encoding, convert-to-encoding, and a lossy-save warning dialog.
- **Live Markdown preview** (source / split) through a single canonical
  `markdown-it` renderer — KaTeX math (native MathML), Prism syntax highlighting,
  task lists, footnotes, tables — with proportional scroll-sync.
- **Large-file tiers** — full editing ≤ 50 MB, a degraded-but-editable tier
  ≤ 1 GB, and a read-only streaming viewer above that for multi-GB files (sub-100
  MB RAM, virtualized scroll).
- **In-file search** — CodeMirror find/replace in the editable tiers and a
  ripgrep-backed (ReDoS-proof), encoding-aware find bar in the streaming viewer.
- **File-watch + conflict banner** — external changes reload a clean buffer
  silently, or offer Reload / Save as… / Keep mine when you have unsaved edits;
  your own saves never raise a false "changed on disk" banner.
- **Standalone HTML export** — one self-contained file from the same renderer as
  the preview (styling inlined; flips to a light theme when printed).
- **Command palette** (`Ctrl/Cmd+Shift+P`) plus direct shortcuts
  (`Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S`).

## Roadmap

Planned / in progress: WYSIWYG editing (Milkdown/Crepe), PDF export, DOCX via
Pandoc, Mermaid diagrams, and streaming edit for the multi-GB tier. See
[`PLAN.md`](./PLAN.md) §9.2 for the live status.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri v2 (Rust + OS WebView) |
| Frontend | TypeScript + Vite + Lit |
| Code editor | CodeMirror 6 |
| Live preview | markdown-it + KaTeX (MathML) + Prism |
| Markdown WYSIWYG | Milkdown / Crepe *(planned)* |
| Diagrams | Mermaid *(planned)* |
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

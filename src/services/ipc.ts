import { invoke, Channel } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open as openDialog, save as saveDialog, ask } from '@tauri-apps/plugin-dialog'

/** Re-exported so the rest of the app never imports `@tauri-apps/*` directly. */
export type { UnlistenFn }

/**
 * IPC / platform service layer — the ONLY module allowed to touch
 * `@tauri-apps/*` (PLAN.md §3.2). Open/save go through Rust commands that own
 * all encoding/BOM/EOL policy; the dialog plugin only picks paths.
 */

export type Eol = 'LF' | 'CRLF' | 'Mixed'
export type Confidence = 'High' | 'Medium' | 'Low'

/**
 * Size-based handling tier (mirrors Rust `Tier`):
 * - `full`         ≤ 50 MB  — every CM6 feature on
 * - `degraded`     ≤ 1 GB   — CM6 with heavy extensions off (still editable)
 * - `streamViewer` > 1 GB   — read-only windowed viewer, never fully loaded
 */
export type Tier = 'full' | 'degraded' | 'streamViewer'

export interface OpenResult {
  path: string
  /** Full text for `full`/`degraded`; empty for `streamViewer`. */
  content: string
  /** Detected encoding label, e.g. "UTF-8", "UTF-8-BOM", "Windows-1254". */
  encoding: string
  hasBom: boolean
  eol: Eol
  confidence: Confidence
  /** false for UTF-32 and for `streamViewer` (read-only until converted). */
  canSave: boolean
  tier: Tier
  byteLen: number
  /** Known for eager tiers; null for `streamViewer` until indexed. */
  lineCount: number | null
}

export interface FileMeta {
  path: string
  encoding: string
  hasBom: boolean
  eol: Eol
}

/** Pick a file via dialog and open it (Rust detects encoding/BOM/EOL). */
export async function openFile(): Promise<OpenResult | null> {
  const selected = await openDialog({ multiple: false, directory: false })
  if (selected === null || Array.isArray(selected)) return null
  return invoke<OpenResult>('open_file', { path: selected })
}

/** Re-decode the same bytes on disk with a chosen encoding (fix a wrong guess). */
export function reopenWithEncoding(path: string, encoding: string): Promise<OpenResult> {
  return invoke<OpenResult>('reopen_with_encoding', { path, encoding })
}

/**
 * Save `text`. When `path` is null (untitled), prompt for one. The encoding
 * label and BOM flag are sent separately (the structural guard against the
 * Notepad++ name↔byte inversion bug).
 */
export async function saveFile(
  path: string | null,
  text: string,
  encoding: string,
  addBom: boolean,
  eol: Eol,
): Promise<FileMeta | null> {
  let target = path
  if (!target) {
    target = await saveDialog({})
    if (!target) return null
  }
  return invoke<FileMeta>('save_file', {
    path: target,
    text,
    encoding: encodingBase(encoding),
    addBom,
    eol,
  })
}

/** "UTF-8-BOM" -> "UTF-8"; the BOM travels in the separate `addBom` flag. */
export function encodingBase(label: string): string {
  return label === 'UTF-8-BOM' ? 'UTF-8' : label
}

// ---------------------------------------------------------------------------
// Large-file streaming (>1 GB read-only tier)
// ---------------------------------------------------------------------------

/** A window of decoded lines streamed from the backend (matches Rust LinesChunk). */
export interface LinesChunk {
  startLine: number
  lines: string[]
  eof: boolean
}

/** Background line-index build progress (matches Rust StreamProgress). */
export interface StreamProgress {
  /** The file this progress is for; ignore events for any other path. */
  path: string
  lines: number
  done: boolean
}

/**
 * Open a >1 GB file for streaming: the backend memory-maps it and builds a
 * sparse line index in the background, reporting line counts via
 * `onStreamProgress`. No content is returned here — pull it with `readLines`.
 */
export function startStream(path: string, encoding: string): Promise<void> {
  return invoke('start_stream', { path, encoding: encodingBase(encoding) })
}

/**
 * Stream `lineCount` lines starting at `startLine` (0-based). Chunks arrive via
 * `onChunk` as they decode; the returned promise resolves when the window is
 * fully sent.
 */
export function readLines(
  path: string,
  startLine: number,
  lineCount: number,
  onChunk: (chunk: LinesChunk) => void,
): Promise<void> {
  const channel = new Channel<LinesChunk>()
  channel.onmessage = onChunk
  return invoke('read_lines', { path, startLine, lineCount, onChunk: channel })
}

/** Subscribe to background index-build progress for the active stream. */
export function onStreamProgress(cb: (p: StreamProgress) => void): Promise<UnlistenFn> {
  return listen<StreamProgress>('stream-progress', (e) => cb(e.payload))
}

/**
 * Close the active streaming session (frees the backend memory-map and aborts
 * its background scan). Call when navigating away from a streamed file.
 */
export function closeStream(): Promise<void> {
  return invoke('close_stream')
}

// ---------------------------------------------------------------------------
// In-file search (ripgrep engine — linear time, streams over multi-GB files)
// ---------------------------------------------------------------------------

/** A single search match (matches Rust `Hit`). */
export interface Hit {
  /** 0-based line number (the viewer seeks by line). */
  line: number
  preview: string
}

/** Result of a completed search (matches Rust `SearchSummary`). */
export interface SearchSummary {
  total: number
  /** True if the hit cap was reached and matches were dropped. */
  truncated: boolean
}

/**
 * Search `path` for `pattern`. Matches stream in via `onHit` (batched) as they
 * are found; the returned promise resolves with the totals when done. The
 * engine is finite-automaton based, so even pathological regexes are linear
 * time (no catastrophic backtracking).
 */
export function searchFile(
  path: string,
  pattern: string,
  isRegex: boolean,
  caseInsensitive: boolean,
  encoding: string,
  onHit: (hits: Hit[]) => void,
): Promise<SearchSummary> {
  const channel = new Channel<Hit[]>()
  channel.onmessage = onHit
  return invoke<SearchSummary>('search_file', {
    path,
    pattern,
    isRegex,
    caseInsensitive,
    encoding,
    onHit: channel,
  })
}

/**
 * Ask before discarding unsaved edits (opening/reopening over a dirty buffer).
 * Returns true if the user chose to continue.
 */
export function confirmDiscard(): Promise<boolean> {
  return ask('You have unsaved changes that will be lost. Continue?', {
    title: 'Unsaved changes',
    kind: 'warning',
  })
}

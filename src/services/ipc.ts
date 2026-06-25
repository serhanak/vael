import { invoke } from '@tauri-apps/api/core'
import { open as openDialog, save as saveDialog, ask } from '@tauri-apps/plugin-dialog'

/**
 * IPC / platform service layer — the ONLY module allowed to touch
 * `@tauri-apps/*` (PLAN.md §3.2). Open/save go through Rust commands that own
 * all encoding/BOM/EOL policy; the dialog plugin only picks paths.
 */

export type Eol = 'LF' | 'CRLF' | 'Mixed'
export type Confidence = 'High' | 'Medium' | 'Low'

export interface OpenResult {
  path: string
  content: string
  /** Detected encoding label, e.g. "UTF-8", "UTF-8-BOM", "Windows-1254". */
  encoding: string
  hasBom: boolean
  eol: Eol
  confidence: Confidence
  /** false for UTF-32 (detect + read-only until converted). */
  canSave: boolean
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

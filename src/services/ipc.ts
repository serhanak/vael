import { open, save } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

/**
 * IPC / platform service layer — the ONLY module allowed to touch
 * `@tauri-apps/*` (PLAN.md §3.2). UI and editor code go through here so the
 * editor stays portable (a mock service can back a future web/mobile build).
 *
 * M0 uses the dialog + fs plugins directly. Encoding-aware open/save, large
 * files, and streaming will move to dedicated Rust commands in M1+.
 */

export interface OpenResult {
  path: string
  content: string
}

/** Show an open dialog and read the chosen file as UTF-8 text. */
export async function openFile(): Promise<OpenResult | null> {
  const selected = await open({ multiple: false, directory: false })
  if (selected === null || Array.isArray(selected)) return null
  const content = await readTextFile(selected)
  return { path: selected, content }
}

/**
 * Write `text` to `path`. If `path` is null (untitled), prompt with a save
 * dialog first. Returns the path written, or null if the user cancelled.
 */
export async function saveFile(
  path: string | null,
  text: string,
): Promise<string | null> {
  let target = path
  if (!target) {
    target = await save({})
    if (!target) return null
  }
  await writeTextFile(target, text)
  return target
}

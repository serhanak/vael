import { buildStandaloneHtml } from '../editor/preview/export'
import { pickSavePath, writeTextFile } from './ipc'

/**
 * Export orchestration (PLAN.md #8). Turns editor content into a document on
 * disk. The HTML itself is built by the pure `buildStandaloneHtml` (same
 * canonical renderer as the live preview); this layer only owns the IPC — pick a
 * destination and write it — keeping the shell free of `@tauri-apps/*` (§3.2).
 */

/** Strip a directory path down to its base file name (handles `/` and `\`). */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/**
 * Export `markdown` as a standalone HTML file. Suggests a name derived from the
 * source file (or "untitled"). Returns the written path, or null if the user
 * cancelled the save dialog.
 */
export async function exportHtml(markdown: string, sourcePath: string | null): Promise<string | null> {
  const stem = (sourcePath ? baseName(sourcePath) : 'untitled').replace(/\.[^.]+$/, '')
  const suggested = `${stem}.html`
  const out = await pickSavePath({
    defaultPath: suggested,
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  })
  if (!out) return null
  await writeTextFile(out, buildStandaloneHtml(markdown, stem))
  return out
}

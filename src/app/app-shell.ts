import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './status-bar'
import './command-palette'
import '../editor/source-view'
import '../editor/preview-pane'
import '../editor/stream-viewer'
import type { SourceView } from '../editor/source-view'
import type { Command } from './commands'
import {
  openFile,
  openPath,
  saveFile,
  pickSavePath,
  reopenWithEncoding,
  confirmDiscard,
  startStream,
  onStreamProgress,
  closeStream,
  watchFile,
  unwatchFile,
  onFileChanged,
  type Eol,
  type Confidence,
  type OpenResult,
  type Tier,
  type FileChange,
  type UnlistenFn,
} from '../services/ipc'
import { exportHtml } from '../services/export'

type Mode = 'source' | 'split'

/** Human-readable byte size for the large-file banner/badge. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Top-level application shell (M1): toolbar + CodeMirror source view + an
 * optional live Markdown preview + an always-visible encoding/EOL status bar.
 *
 * Hard rule (PLAN.md §3.2): the shell and editor never import `@tauri-apps/*`
 * directly — only `services/*` touches the IPC boundary.
 */
@customElement('vael-app')
export class VaelApp extends LitElement {
  @state() private path: string | null = null
  @state() private dirty = false
  @state() private busy = false
  @state() private error = ''
  @state() private mode: Mode = 'source'
  @state() private previewMd = ''

  // Document encoding/EOL state (base label; BOM carried separately).
  @state() private encoding = 'UTF-8'
  @state() private hasBom = false
  @state() private eol: Eol = 'LF'
  @state() private confidence: Confidence = 'High'
  @state() private canSave = true

  @state() private line = 1
  @state() private col = 1

  // Lossy-save confirmation dialog (a character can't be represented in the
  // chosen legacy encoding). `lossyResolve` is the pending choice callback.
  @state() private lossyOpen = false
  private lossyResolve?: (choice: 'utf8' | 'anyway' | 'cancel') => void

  // External file-change (conflict) banner: the open file was modified/removed
  // on disk by another program.
  @state() private conflict: 'modified' | 'removed' | null = null
  private watchUnlisten?: UnlistenFn
  /** mtime (ms) the file had right after our own last save. A `file-changed`
   *  event carrying this exact mtime is that save's echo and is ignored; a real
   *  external write bumps the mtime and is handled. 0 = no self-write to ignore. */
  private lastSavedMtime = 0

  // Command palette (PLAN.md #10): a keyboard-driven menu of the toolbar actions.
  @state() private paletteOpen = false

  // Large-file handling tier (PLAN.md §6.b).
  @state() private tier: Tier = 'full'
  @state() private byteLen = 0
  @state() private lineCount: number | null = null

  private previewTimer?: number
  private streamUnlisten?: UnlistenFn

  // Split-mode scroll sync between the editor and the preview. `syncLeader` is
  // the pane the user is actively scrolling; the other pane's echoed scroll
  // events are ignored until a short idle window clears the lock.
  private syncLeader: 'editor' | 'preview' | null = null
  private syncTimer?: number
  private linkedEditorScroller?: HTMLElement
  private linkedPreviewEl?: HTMLElement

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font: 13px/1.5 system-ui, sans-serif;
      color: #e6e6e6;
      background: #1e1e22;
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: #26262b;
      border-bottom: 1px solid #333;
      flex: 0 0 auto;
    }
    button {
      font: inherit;
      color: #e6e6e6;
      background: #34343b;
      border: 1px solid #444;
      border-radius: 5px;
      padding: 3px 10px;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      background: #3e3e47;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .modes {
      display: inline-flex;
      gap: 2px;
      margin-left: 4px;
    }
    .modes button.active {
      background: #4a4a8a;
      border-color: #5a5aa0;
    }
    .path {
      margin-left: 6px;
      color: #b9b9c2;
    }
    .tier {
      margin-left: 6px;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .tier.degraded {
      background: #4a3a1a;
      color: #ffcf8a;
    }
    .tier.streamViewer {
      background: #1a3a4a;
      color: #8ad6ff;
    }
    .spacer {
      flex: 1;
    }
    .error {
      color: #ff8a8a;
      max-width: 40%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .workspace {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
    }
    .workspace source-view {
      flex: 1 1 100%;
      min-width: 0;
    }
    .workspace.split source-view {
      flex: 1 1 50%;
      border-right: 1px solid #333;
    }
    .workspace preview-pane {
      flex: 1 1 50%;
      min-width: 0;
    }
    .workspace stream-viewer {
      flex: 1 1 100%;
      min-width: 0;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.5);
    }
    .modal {
      max-width: 440px;
      margin: 0 16px;
      padding: 16px 20px 18px;
      background: #26262b;
      border: 1px solid #4a4a55;
      border-radius: 8px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
    }
    .modal h3 {
      margin: 0 0 8px;
      font-size: 14px;
      color: #f0f0f5;
    }
    .modal p {
      margin: 0 0 16px;
      font-size: 13px;
      line-height: 1.5;
      color: #c4c4ce;
    }
    .modal .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .modal .actions button.primary {
      background: #4a4a8a;
      border-color: #5a5aa0;
      color: #fff;
    }
    .modal .actions button.danger {
      background: #6a2a2a;
      border-color: #8a3a3a;
      color: #ffcaca;
    }
    .banner {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
      padding: 6px 12px;
      background: #4a3a1a;
      color: #ffcf8a;
      border-bottom: 1px solid #5a4a2a;
      font-size: 13px;
    }
    .banner button {
      padding: 2px 10px;
    }
  `

  private get editor(): SourceView | null {
    return this.renderRoot.querySelector('source-view')
  }

  /** The preview pane's scroll container (its :host has overflow:auto). */
  private get previewEl(): HTMLElement | null {
    return this.renderRoot.querySelector('preview-pane')
  }

  private get tierLabel(): string {
    return this.tier === 'degraded' ? 'large file' : 'huge file'
  }

  private get tierTitle(): string {
    return this.tier === 'degraded'
      ? `${formatBytes(this.byteLen)} — syntax highlighting and word-wrap are off for speed.`
      : `${formatBytes(this.byteLen)} — opened in read-only streaming viewer.`
  }


  private async applyOpen(r: OpenResult) {
    this.path = r.path
    // Normalize "UTF-8-BOM" into base encoding + BOM flag.
    this.encoding = r.encoding === 'UTF-8-BOM' ? 'UTF-8' : r.encoding
    this.hasBom = r.hasBom
    this.eol = r.eol
    this.confidence = r.confidence
    this.canSave = r.canSave
    this.tier = r.tier
    this.byteLen = r.byteLen
    this.lineCount = r.lineCount
    this.conflict = null // a fresh open/reload clears any external-change banner
    this.lastSavedMtime = 0 // no pending self-write echo for a newly-opened file
    // Preview engines (markdown-it) and Crepe are unbounded; only the small
    // `full` tier may show split preview. Force back to source for big files.
    if (r.tier !== 'full' && this.mode !== 'source') this.mode = 'source'
    // Let Lit mount the view that matches this tier before we drive it.
    await this.updateComplete
    if (r.tier === 'streamViewer') {
      // The whole file is never loaded; the read-only viewer pulls windows and
      // the line count fills in from the background index build. Read-only, so
      // it isn't file-watched.
      void unwatchFile()
      this.dirty = false
      await this.startStreamFor(r.path, this.encoding)
      return
    }
    // Entering a non-stream tier: drop any prior stream subscription and free
    // the backend memory-map / abort its scan (else a multi-GB mapping lingers
    // and its stale progress could clobber this file's line count).
    this.teardownStream()
    // Order matters: CM6's heavy parser/highlight must NEVER run on a large
    // document. Going TO degraded, turn the heavy features OFF *before* loading
    // the big text. Going TO full, replace the (possibly large) old text with
    // the new small text *first*, then turn features on — otherwise enabling
    // highlight on a still-loaded big buffer (e.g. switching from a 75 MB log
    // back to a small file) parses the whole thing and hangs for seconds.
    const degraded = r.tier === 'degraded'
    if (degraded) this.editor?.setDegraded(true)
    this.editor?.setText(r.content)
    if (!degraded) this.editor?.setDegraded(false)
    this.dirty = false // setText fires doc-changed synchronously; clear after
    if (this.mode === 'split') this.previewMd = r.content
    void watchFile(r.path) // watch for external changes (editable tiers only)
  }

  /** Unsubscribe from stream progress and close the backend session, if any. */
  private teardownStream() {
    if (!this.streamUnlisten) return
    this.streamUnlisten()
    this.streamUnlisten = undefined
    void closeStream()
  }

  /**
   * Start the >1 GB streaming session and subscribe to its background
   * index-build progress (which fills in the total line count). The
   * subscription is set up before `startStream` so no early progress is missed.
   */
  private async startStreamFor(path: string, encoding: string) {
    this.streamUnlisten?.()
    this.streamUnlisten = await onStreamProgress((p) => {
      // Ignore progress from a previous file's still-running scan.
      if (p.path !== this.path) return
      this.lineCount = p.lines
    })
    await startStream(path, encoding)
  }

  private fail(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e)
  }

  connectedCallback() {
    super.connectedCallback()
    // App-wide keyboard shortcuts. On `window` (capture phase) so they work
    // regardless of focus (CodeMirror, inputs) and can pre-empt WebView defaults
    // like Ctrl+S "save page" / Ctrl+O "open".
    window.addEventListener('keydown', this.onGlobalKey, true)
  }

  async firstUpdated() {
    // Subscribe once to external file-change events (backend file watcher).
    this.watchUnlisten = await onFileChanged((c) => this.onExternalChange(c))
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this.onGlobalKey, true)
    this.teardownStream()
    this.teardownScrollSync()
    this.watchUnlisten?.()
    void unwatchFile()
  }

  /** App-wide accelerators. The command palette (Ctrl/Cmd+Shift+P) is the
   *  discoverable surface; the direct ones mirror the shortcuts the palette
   *  advertises. */
  private onGlobalKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (e.shiftKey && k === 'p') {
      e.preventDefault()
      this.paletteOpen = !this.paletteOpen
    } else if (e.shiftKey && k === 's') {
      e.preventDefault()
      if (!this.readOnly && !this.busy) void this.onSaveAs()
    } else if (!e.shiftKey && k === 's') {
      e.preventDefault()
      void this.onSave() // self-guards readOnly / !canSave
    } else if (!e.shiftKey && k === 'o') {
      e.preventDefault()
      void this.onOpen()
    }
  }

  /** The palette's command list, rebuilt from current state so each command's
   *  `enabled` reflects the moment it is shown (PLAN.md #10). */
  private get paletteCommands(): Command[] {
    const full = this.tier === 'full'
    const ro = this.readOnly
    return [
      { id: 'open', title: 'Open File…', hint: 'Ctrl+O', enabled: !this.busy, run: () => void this.onOpen() },
      {
        id: 'save',
        title: 'Save',
        hint: 'Ctrl+S',
        enabled: !this.busy && this.canSave && !ro,
        run: () => void this.onSave(),
      },
      {
        id: 'saveAs',
        title: 'Save As…',
        hint: 'Ctrl+Shift+S',
        enabled: !this.busy && !ro,
        run: () => void this.onSaveAs(),
      },
      {
        id: 'export',
        title: 'Export HTML…',
        enabled: !this.busy && full,
        run: () => void this.onExportHtml(),
      },
      {
        id: 'reload',
        title: 'Reload from Disk',
        enabled: !this.busy && !!this.path && !ro,
        run: () => void this.reloadFromDisk(),
      },
      { id: 'source', title: 'View: Source', enabled: this.mode !== 'source', run: () => this.setMode('source') },
      {
        id: 'split',
        title: 'View: Split Preview',
        hint: full ? '' : 'normal-size files',
        enabled: full && this.mode !== 'split',
        run: () => this.setMode('split'),
      },
    ]
  }

  /** Backend reports the open file changed on disk. Ignore our own save's echo;
   *  auto-reload a clean buffer; raise the conflict banner if there are edits. */
  private onExternalChange(c: FileChange) {
    if (c.path !== this.path) return // stale event from a previously-open file
    if (this.readOnly) return // the stream tier isn't watched; guard anyway
    // Ignore the echo of our OWN save by mtime identity, not a blanket time
    // window: a real external write in the moments after a save bumps the mtime
    // and is still handled, instead of being silently swallowed.
    if (c.mtimeMs !== 0 && c.mtimeMs === this.lastSavedMtime) return
    if (c.kind === 'removed') {
      this.conflict = 'removed'
      return
    }
    if (this.dirty) this.conflict = 'modified' // real conflict — let the user choose
    else void this.reloadFromDisk() // no local edits → silently pick up the new content
  }

  /** Re-read the open file from disk (fresh detection) and replace the buffer. */
  private async reloadFromDisk() {
    if (!this.path) return
    this.busy = true
    this.error = ''
    try {
      const r = await openPath(this.path)
      await this.applyOpen(r) // resets dirty, re-watches, clears the banner
    } catch (e) {
      this.fail(e)
    } finally {
      this.busy = false
    }
  }

  updated(changed: Map<string, unknown>) {
    // Link/unlink editor↔preview scroll sync as we enter/leave split mode. (Tier
    // changes can force `mode` back to source, so react to both.)
    if (changed.has('mode') || changed.has('tier')) {
      if (this.mode === 'split' && this.tier === 'full') {
        // Defer until the freshly-rendered preview-pane and the CM scroller exist.
        this.updateComplete.then(() => this.setupScrollSync())
      } else {
        this.teardownScrollSync()
      }
    }
  }

  private setupScrollSync() {
    const ed = this.editor?.scroller ?? null
    const pv = this.previewEl
    if (!ed || !pv) return
    if (this.linkedEditorScroller === ed && this.linkedPreviewEl === pv) return // already linked
    this.teardownScrollSync()
    this.linkedEditorScroller = ed
    this.linkedPreviewEl = pv
    ed.addEventListener('scroll', this.onEditorScroll, { passive: true })
    pv.addEventListener('scroll', this.onPreviewScroll, { passive: true })
  }

  private teardownScrollSync() {
    this.linkedEditorScroller?.removeEventListener('scroll', this.onEditorScroll)
    this.linkedPreviewEl?.removeEventListener('scroll', this.onPreviewScroll)
    this.linkedEditorScroller = undefined
    this.linkedPreviewEl = undefined
    clearTimeout(this.syncTimer)
    this.syncLeader = null
  }

  private onEditorScroll = () => {
    if (this.syncLeader === 'preview') return // preview is driving; ignore the echo
    this.syncLeader = 'editor'
    if (this.linkedEditorScroller && this.linkedPreviewEl) {
      this.copyScrollFraction(this.linkedEditorScroller, this.linkedPreviewEl)
    }
    this.armSyncRelease()
  }

  private onPreviewScroll = () => {
    if (this.syncLeader === 'editor') return
    this.syncLeader = 'preview'
    if (this.linkedEditorScroller && this.linkedPreviewEl) {
      this.copyScrollFraction(this.linkedPreviewEl, this.linkedEditorScroller)
    }
    this.armSyncRelease()
  }

  /** Release the leader lock after a short idle so the other pane can take over. */
  private armSyncRelease() {
    clearTimeout(this.syncTimer)
    this.syncTimer = window.setTimeout(() => (this.syncLeader = null), 120)
  }

  /** Match `to`'s scroll position to `from`'s, by fraction of scrollable height. */
  private copyScrollFraction(from: HTMLElement, to: HTMLElement) {
    const fromMax = from.scrollHeight - from.clientHeight
    const toMax = to.scrollHeight - to.clientHeight
    if (fromMax <= 0 || toMax <= 0) return
    to.scrollTop = (from.scrollTop / fromMax) * toMax
  }

  private onDocChanged() {
    this.dirty = true
    // Keep the total-line readout live (CM6 reports it in O(1)).
    if (this.tier !== 'streamViewer') this.lineCount = this.editor?.getLineCount() ?? null
    this.schedulePreview()
  }

  private schedulePreview() {
    if (this.mode !== 'split') return
    clearTimeout(this.previewTimer)
    this.previewTimer = window.setTimeout(() => {
      this.previewMd = this.editor?.getText() ?? ''
    }, 150)
  }

  private setMode(mode: Mode) {
    this.mode = mode
    if (mode === 'split') this.previewMd = this.editor?.getText() ?? ''
  }

  private async onOpen() {
    if (this.dirty && !(await confirmDiscard())) return
    this.busy = true
    this.error = ''
    try {
      const r = await openFile()
      if (r) await this.applyOpen(r)
    } catch (e) {
      this.fail(e)
    } finally {
      this.busy = false
    }
  }

  /** The >1 GB stream tier is a read-only viewer: it has no editor in the DOM
   *  and must never be saved (an empty save would truncate the file). */
  private get readOnly(): boolean {
    return this.tier === 'streamViewer'
  }

  private async onSave() {
    // Guard against saving the streaming viewer: there is no <source-view> in
    // the DOM, so getText() would be '' and overwrite the multi-GB file empty.
    if (this.readOnly || !this.canSave) return
    await this.trySave(false)
  }

  /**
   * Save, resolving a lossy-encoding refusal via the dialog. The backend returns
   * `lossy` (not an error) when the target legacy encoding can't represent some
   * character; we then ask the user and recurse once per choice: convert to
   * UTF-8 (lossless) or save anyway (write with replacement).
   */
  private async trySave(allowLossy: boolean, target: string | null = this.path) {
    this.busy = true
    this.error = ''
    try {
      const text = this.editor?.getText() ?? ''
      const outcome = await saveFile(target, text, this.encoding, this.hasBom, this.eol, allowLossy)
      if (!outcome) return // Save-As dialog cancelled
      if (outcome.kind === 'lossy') {
        this.busy = false
        const choice = await this.askLossy()
        if (choice === 'cancel') return
        if (choice === 'utf8') {
          this.encoding = 'UTF-8' // lossless target
          this.hasBom = false
          await this.trySave(false, target)
        } else {
          await this.trySave(true, target) // save anyway, in the lossy encoding
        }
        return
      }
      // Commit path/conflict/watch ONLY on a confirmed write. onSaveAs relies on
      // this: a failed or cancelled Save-As must leave this.path, the banner, and
      // the active watch on the ORIGINAL file untouched.
      this.path = outcome.meta.path
      this.dirty = false
      this.conflict = null // we just wrote it — no external conflict
      // Recognize this write's own watcher echo by its mtime (not a time window),
      // and (re)watch the possibly-new path (Save As).
      this.lastSavedMtime = outcome.meta.mtimeMs
      void watchFile(outcome.meta.path)
    } catch (e) {
      this.fail(e)
    } finally {
      this.busy = false
    }
  }

  /** Save the current buffer to a new path (Save As), then watch it. The picked
   *  path is committed by trySave only on success, so a cancelled/failed save
   *  leaves the original file watched and its conflict banner intact. */
  private async onSaveAs() {
    const p = await pickSavePath()
    if (!p) return
    await this.trySave(false, p)
  }

  /** Export the current document as a standalone HTML file (same canonical
   *  render as the preview). Only for the `full` tier — markdown-it, like the
   *  preview, is unbounded and must not run on a large/huge buffer. */
  private async onExportHtml() {
    if (this.tier !== 'full') return
    this.busy = true
    this.error = ''
    try {
      await exportHtml(this.editor?.getText() ?? '', this.path)
    } catch (e) {
      this.fail(e)
    } finally {
      this.busy = false
    }
  }

  /** Show the lossy-save dialog; resolves with the user's choice. */
  private askLossy(): Promise<'utf8' | 'anyway' | 'cancel'> {
    return new Promise((resolve) => {
      this.lossyResolve = resolve
      this.lossyOpen = true
    })
  }

  private resolveLossy(choice: 'utf8' | 'anyway' | 'cancel') {
    this.lossyOpen = false
    const resolve = this.lossyResolve
    this.lossyResolve = undefined
    resolve?.(choice)
  }

  private async onReopen(e: Event) {
    const encoding = (e as CustomEvent<string>).detail
    if (!this.path) return
    if (this.dirty && !(await confirmDiscard())) return
    this.busy = true
    this.error = ''
    try {
      const r = await reopenWithEncoding(this.path, encoding)
      await this.applyOpen(r) // reopen is a re-decode, not an edit → not dirty
    } catch (err) {
      this.fail(err)
    } finally {
      this.busy = false
    }
  }

  private onConvert(e: Event) {
    // Convert means "edit the bytes on next save" — meaningless for the
    // read-only stream tier, and re-enabling canSave there is the empty-save
    // data-loss path. To change how a huge file is *decoded*, use Reopen.
    if (this.readOnly) return
    const label = (e as CustomEvent<string>).detail
    const base = label === 'UTF-8-BOM' ? 'UTF-8' : label
    this.encoding = base
    // UTF-8 BOM is opt-in; UTF-16 must always carry a BOM (a BOM-less UTF-16
    // file is undetectable on reopen → silent data loss); legacy has none.
    this.hasBom = label === 'UTF-8-BOM' || base.startsWith('UTF-16')
    this.canSave = !base.startsWith('UTF-32')
    this.dirty = true
  }

  private onToggleBom(e: Event) {
    if (this.readOnly) return
    this.hasBom = (e as CustomEvent<boolean>).detail
    this.dirty = true
  }

  private onSetEol(e: Event) {
    if (this.readOnly) return
    this.eol = (e as CustomEvent<Eol>).detail
    this.dirty = true
  }

  render() {
    const name = this.path ?? 'untitled'
    return html`
      <header>
        <button @click=${this.onOpen} ?disabled=${this.busy}>Open…</button>
        <button
          @click=${this.onSave}
          ?disabled=${this.busy || !this.canSave}
          title=${this.canSave ? 'Save' : 'Read-only encoding — convert to UTF-8 first'}
        >
          Save
        </button>
        <button
          @click=${this.onExportHtml}
          ?disabled=${this.busy || this.tier !== 'full'}
          title=${this.tier === 'full'
            ? 'Export a standalone HTML file (same as the preview)'
            : 'Export is available for normal-size files'}
        >
          Export HTML…
        </button>
        <span class="modes">
          <button class=${this.mode === 'source' ? 'active' : ''} @click=${() => this.setMode('source')}>
            Source
          </button>
          <button
            class=${this.mode === 'split' ? 'active' : ''}
            ?disabled=${this.tier !== 'full'}
            title=${this.tier === 'full' ? 'Split preview' : 'Preview disabled for large files'}
            @click=${() => this.setMode('split')}
          >
            Split
          </button>
        </span>
        <span class="path">${name}${this.dirty ? ' •' : ''}</span>
        ${this.tier !== 'full'
          ? html`<span class="tier ${this.tier}" title=${this.tierTitle}>${this.tierLabel}</span>`
          : ''}
        <span class="spacer"></span>
        ${this.error ? html`<span class="error" title=${this.error}>⚠ ${this.error}</span>` : ''}
      </header>

      ${this.conflict ? this.renderConflictBanner() : ''}

      <div class="workspace ${this.mode}">
        ${this.tier === 'streamViewer'
          ? html`<stream-viewer
              .path=${this.path ?? ''}
              .encoding=${this.encoding}
              .totalLines=${this.lineCount ?? 1}
            ></stream-viewer>`
          : html`
              <source-view
                @doc-changed=${this.onDocChanged}
                @cursor-changed=${(e: Event) => {
                  const d = (e as CustomEvent<{ line: number; col: number }>).detail
                  this.line = d.line
                  this.col = d.col
                }}
              ></source-view>
              ${this.mode === 'split'
                ? html`<preview-pane .markdown=${this.previewMd}></preview-pane>`
                : ''}
            `}
      </div>

      <status-bar
        .encoding=${this.encoding}
        .hasBom=${this.hasBom}
        .eol=${this.eol}
        .confidence=${this.confidence}
        .canSave=${this.canSave}
        .readOnly=${this.readOnly}
        .line=${this.line}
        .col=${this.col}
        .lines=${this.lineCount}
        @reopen=${this.onReopen}
        @convert=${this.onConvert}
        @toggle-bom=${this.onToggleBom}
        @set-eol=${this.onSetEol}
      ></status-bar>

      ${this.lossyOpen ? this.renderLossyDialog() : ''}

      <command-palette
        .open=${this.paletteOpen}
        .commands=${this.paletteCommands}
        @close=${() => (this.paletteOpen = false)}
      ></command-palette>
    `
  }

  private renderConflictBanner() {
    if (this.conflict === 'removed') {
      return html`
        <div class="banner">
          <span>⚠ This file was deleted on disk.</span>
          <span class="spacer"></span>
          <button @click=${() => this.trySave(false)}>Save to restore</button>
          <button @click=${() => (this.conflict = null)}>Dismiss</button>
        </div>
      `
    }
    return html`
      <div class="banner">
        <span>⚠ This file changed on disk.</span>
        <span class="spacer"></span>
        <button @click=${() => this.reloadFromDisk()}>Reload</button>
        <button @click=${() => this.onSaveAs()}>Save as…</button>
        <button @click=${() => (this.conflict = null)}>Keep mine</button>
      </div>
    `
  }

  private renderLossyDialog() {
    return html`
      <div class="scrim" @click=${() => this.resolveLossy('cancel')}>
        <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
          <h3>Some characters can't be saved as ${this.encoding}</h3>
          <p>
            This document has characters that <strong>${this.encoding}</strong> can't
            represent. Saving in this encoding replaces them (data loss). Save as UTF-8
            to keep everything.
          </p>
          <div class="actions">
            <button class="primary" @click=${() => this.resolveLossy('utf8')}>
              Save as UTF-8
            </button>
            <button class="danger" @click=${() => this.resolveLossy('anyway')}>
              Save anyway
            </button>
            <button @click=${() => this.resolveLossy('cancel')}>Cancel</button>
          </div>
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vael-app': VaelApp
  }
}

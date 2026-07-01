import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './status-bar'
import '../editor/source-view'
import '../editor/preview-pane'
import '../editor/stream-viewer'
import type { SourceView } from '../editor/source-view'
import {
  openFile,
  saveFile,
  reopenWithEncoding,
  confirmDiscard,
  startStream,
  onStreamProgress,
  closeStream,
  type Eol,
  type Confidence,
  type OpenResult,
  type Tier,
  type UnlistenFn,
} from '../services/ipc'

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
    // Preview engines (markdown-it) and Crepe are unbounded; only the small
    // `full` tier may show split preview. Force back to source for big files.
    if (r.tier !== 'full' && this.mode !== 'source') this.mode = 'source'
    // Let Lit mount the view that matches this tier before we drive it.
    await this.updateComplete
    if (r.tier === 'streamViewer') {
      // The whole file is never loaded; the read-only viewer pulls windows and
      // the line count fills in from the background index build.
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

  disconnectedCallback() {
    super.disconnectedCallback()
    this.teardownStream()
    this.teardownScrollSync()
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
    this.busy = true
    this.error = ''
    try {
      const text = this.editor?.getText() ?? ''
      const meta = await saveFile(this.path, text, this.encoding, this.hasBom, this.eol)
      if (meta) {
        this.path = meta.path
        this.dirty = false
      }
    } catch (e) {
      this.fail(e)
    } finally {
      this.busy = false
    }
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
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vael-app': VaelApp
  }
}

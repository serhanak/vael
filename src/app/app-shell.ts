import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './status-bar'
import '../editor/source-view'
import '../editor/preview-pane'
import type { SourceView } from '../editor/source-view'
import {
  openFile,
  saveFile,
  reopenWithEncoding,
  confirmDiscard,
  type Eol,
  type Confidence,
  type OpenResult,
} from '../services/ipc'

type Mode = 'source' | 'split'

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

  private previewTimer?: number

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
  `

  private get editor(): SourceView | null {
    return this.renderRoot.querySelector('source-view')
  }

  private applyOpen(r: OpenResult) {
    this.path = r.path
    // Normalize "UTF-8-BOM" into base encoding + BOM flag.
    this.encoding = r.encoding === 'UTF-8-BOM' ? 'UTF-8' : r.encoding
    this.hasBom = r.hasBom
    this.eol = r.eol
    this.confidence = r.confidence
    this.canSave = r.canSave
    this.editor?.setText(r.content)
    this.dirty = false // setText fires doc-changed synchronously; clear after
    if (this.mode === 'split') this.previewMd = r.content
  }

  private fail(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e)
  }

  private onDocChanged() {
    this.dirty = true
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
      if (r) this.applyOpen(r)
    } catch (e) {
      this.fail(e)
    } finally {
      this.busy = false
    }
  }

  private async onSave() {
    if (!this.canSave) return
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
      this.applyOpen(r) // reopen is a re-decode, not an edit → not dirty
    } catch (err) {
      this.fail(err)
    } finally {
      this.busy = false
    }
  }

  private onConvert(e: Event) {
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
    this.hasBom = (e as CustomEvent<boolean>).detail
    this.dirty = true
  }

  private onSetEol(e: Event) {
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
          <button class=${this.mode === 'split' ? 'active' : ''} @click=${() => this.setMode('split')}>
            Split
          </button>
        </span>
        <span class="path">${name}${this.dirty ? ' •' : ''}</span>
        <span class="spacer"></span>
        ${this.error ? html`<span class="error" title=${this.error}>⚠ ${this.error}</span>` : ''}
      </header>

      <div class="workspace ${this.mode}">
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
      </div>

      <status-bar
        .encoding=${this.encoding}
        .hasBom=${this.hasBom}
        .eol=${this.eol}
        .confidence=${this.confidence}
        .canSave=${this.canSave}
        .line=${this.line}
        .col=${this.col}
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

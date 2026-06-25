import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import '../editor/source-view'
import type { SourceView } from '../editor/source-view'
import { openFile, saveFile } from '../services/ipc'

/**
 * Top-level application shell (M0): a minimal toolbar + a single CodeMirror
 * source view, wired to open/save via the IPC service layer.
 *
 * Hard rule (see PLAN.md §3.2): the shell and editor never import
 * `@tauri-apps/*` directly — only `services/*` touches the IPC boundary.
 */
@customElement('vael-app')
export class VaelApp extends LitElement {
  @state() private path: string | null = null
  @state() private dirty = false
  @state() private busy = false

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font: 13px/1.5 system-ui, sans-serif;
      color: #e6e6e6;
      background: #1e1e22;
    }
    header,
    footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: #26262b;
      border-bottom: 1px solid #333;
      flex: 0 0 auto;
    }
    footer {
      border-top: 1px solid #333;
      border-bottom: none;
      color: #9a9aa2;
      font-size: 12px;
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
    .path {
      margin-left: 6px;
      color: #b9b9c2;
    }
    .spacer {
      flex: 1;
    }
    source-view {
      flex: 1 1 auto;
      min-height: 0;
    }
  `

  private get editor(): SourceView | null {
    return this.renderRoot.querySelector('source-view')
  }

  private async onOpen() {
    this.busy = true
    try {
      const res = await openFile()
      if (!res) return
      this.path = res.path
      this.editor?.setText(res.content)
      this.dirty = false
    } finally {
      this.busy = false
    }
  }

  private async onSave() {
    this.busy = true
    try {
      const text = this.editor?.getText() ?? ''
      const saved = await saveFile(this.path, text)
      if (saved) {
        this.path = saved
        this.dirty = false
      }
    } finally {
      this.busy = false
    }
  }

  render() {
    const name = this.path ?? 'untitled'
    return html`
      <header>
        <button @click=${this.onOpen} ?disabled=${this.busy}>Open…</button>
        <button @click=${this.onSave} ?disabled=${this.busy}>Save</button>
        <span class="path">${name}${this.dirty ? ' •' : ''}</span>
        <span class="spacer"></span>
      </header>
      <source-view @doc-changed=${() => (this.dirty = true)}></source-view>
      <footer>vael — M0 scaffold</footer>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vael-app': VaelApp
  }
}

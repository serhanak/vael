import { LitElement, html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import type { Eol, Confidence } from '../services/ipc'

/** Encodings offered in the reopen/convert menus. */
const ENCODINGS = [
  'UTF-8',
  'UTF-8-BOM',
  'UTF-16 LE',
  'UTF-16 BE',
  'Windows-1254',
  'Windows-1252',
  'ISO-8859-9',
  'Windows-1251',
  'Shift_JIS',
  'GBK',
  'Big5',
]

/**
 * Always-visible status bar (PLAN.md §6.c / docs/design §10). Encoding, BOM,
 * EOL and detection confidence are never hidden in a deep menu — the inverse
 * of Notepad++. Emits: `reopen`, `convert`, `toggle-bom`, `set-eol`.
 */
@customElement('status-bar')
export class StatusBar extends LitElement {
  @property() encoding = 'UTF-8'
  @property({ type: Boolean }) hasBom = false
  @property() eol: Eol = 'LF'
  @property() confidence: Confidence = 'High'
  @property({ type: Boolean }) canSave = true
  @property({ type: Number }) line = 1
  @property({ type: Number }) col = 1

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      font: 12px/1.6 system-ui, sans-serif;
      color: #b9b9c2;
      background: #26262b;
      border-top: 1px solid #333;
      user-select: none;
    }
    .pos {
      color: #9a9aa2;
    }
    .spacer {
      flex: 1;
    }
    details.menu {
      position: relative;
    }
    summary.chip {
      list-style: none;
      cursor: pointer;
      padding: 1px 8px;
      border-radius: 4px;
      color: #d6d6de;
    }
    summary.chip::-webkit-details-marker {
      display: none;
    }
    summary.chip:hover {
      background: #34343b;
    }
    summary.chip.warn {
      color: #e6b34d;
    }
    .panel {
      position: absolute;
      bottom: calc(100% + 4px);
      right: 0;
      min-width: 180px;
      max-height: 320px;
      overflow-y: auto;
      padding: 6px;
      background: #2c2c33;
      border: 1px solid #444;
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
      z-index: 10;
    }
    .grp {
      margin: 6px 4px 2px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #82828c;
    }
    .panel button {
      display: block;
      width: 100%;
      text-align: left;
      font: inherit;
      color: #e6e6e6;
      background: transparent;
      border: none;
      border-radius: 4px;
      padding: 3px 8px;
      cursor: pointer;
    }
    .panel button:hover {
      background: #3a3a43;
    }
    .note {
      margin: 2px 4px 6px;
      color: #e6b34d;
      font-size: 11px;
    }
    label.bom {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 6px 4px 2px;
      cursor: pointer;
    }
  `

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }

  private get displayEncoding(): string {
    if (this.encoding === 'UTF-8') return this.hasBom ? 'UTF-8-BOM' : 'UTF-8'
    return this.encoding
  }

  private get bomToggleable(): boolean {
    // Only UTF-8 has an optional BOM. UTF-16 must always carry one (a BOM-less
    // UTF-16 file is undetectable on reopen), so it is not user-toggleable.
    return this.encoding === 'UTF-8'
  }

  render() {
    const lowConf = this.confidence !== 'High'
    return html`
      <span class="pos">Ln ${this.line}, Col ${this.col}</span>
      <span class="spacer"></span>

      <details class="menu">
        <summary class="chip ${lowConf ? 'warn' : ''}" title=${lowConf ? 'Low-confidence detection — verify the encoding' : 'Encoding'}>
          ${this.displayEncoding}${lowConf ? ' ⚠' : ''}
        </summary>
        <div class="panel">
          ${!this.canSave
            ? html`<p class="note">Read-only encoding — convert to UTF-8 to edit &amp; save.</p>`
            : ''}
          <p class="grp">Reopen with…</p>
          ${ENCODINGS.map(
            (e) => html`<button @click=${() => this.emit('reopen', e)}>${e}</button>`,
          )}
          <p class="grp">Convert to…</p>
          ${ENCODINGS.map(
            (e) => html`<button @click=${() => this.emit('convert', e)}>${e}</button>`,
          )}
          ${this.bomToggleable
            ? html`<label class="bom">
                <input
                  type="checkbox"
                  .checked=${this.hasBom}
                  @change=${(ev: Event) =>
                    this.emit('toggle-bom', (ev.target as HTMLInputElement).checked)}
                />
                Byte-order mark (BOM)
              </label>`
            : ''}
        </div>
      </details>

      <details class="menu">
        <summary class="chip ${this.eol === 'Mixed' ? 'warn' : ''}" title="Line endings">
          ${this.eol}
        </summary>
        <div class="panel">
          <p class="grp">Line endings</p>
          <button @click=${() => this.emit('set-eol', 'LF')}>LF — Unix (\\n)</button>
          <button @click=${() => this.emit('set-eol', 'CRLF')}>CRLF — Windows (\\r\\n)</button>
        </div>
      </details>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'status-bar': StatusBar
  }
}

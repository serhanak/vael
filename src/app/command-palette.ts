import { LitElement, html, css } from 'lit'
import { customElement, property, state, query } from 'lit/decorators.js'
import { rankCommands, type Command, type RankedCommand } from './commands'

/**
 * Command palette overlay (PLAN.md #10): a keyboard-driven, fuzzy-filtered menu
 * of the app's actions. The host (app-shell) owns the command list and toggles
 * `open`; this component owns only the query, selection, and keyboard nav. It
 * never mutates app state directly — it calls the chosen `Command.run` and asks
 * the host to close via a `close` event.
 *
 * Ranking/filtering lives in the pure `commands.ts` (unit-tested); this is just
 * the view + interaction.
 */
@customElement('command-palette')
export class CommandPalette extends LitElement {
  @property({ type: Boolean }) open = false
  @property({ attribute: false }) commands: Command[] = []

  @state() private queryText = ''
  /** Index into the CURRENTLY VISIBLE (ranked) list, not into `commands`. */
  @state() private active = 0

  @query('input') private input?: HTMLInputElement

  static styles = css`
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding-top: 12vh;
      background: rgba(0, 0, 0, 0.45);
    }
    .palette {
      width: min(560px, 92vw);
      max-height: 60vh;
      display: flex;
      flex-direction: column;
      background: #26262b;
      border: 1px solid #4a4a55;
      border-radius: 10px;
      box-shadow: 0 16px 56px rgba(0, 0, 0, 0.55);
      overflow: hidden;
    }
    input {
      font: 14px/1.5 system-ui, sans-serif;
      color: #f0f0f5;
      background: #1e1e22;
      border: none;
      border-bottom: 1px solid #3a3a43;
      padding: 12px 14px;
      outline: none;
    }
    input::placeholder {
      color: #7a7a85;
    }
    ul {
      margin: 0;
      padding: 4px;
      list-style: none;
      overflow-y: auto;
    }
    li {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 10px;
      border-radius: 6px;
      color: #dcdce4;
      cursor: pointer;
    }
    li.active {
      background: #4a4a8a;
      color: #fff;
    }
    li.disabled {
      color: #6a6a75;
      cursor: default;
    }
    li .title {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    li .title mark {
      background: none;
      color: #ffd479;
      font-weight: 600;
    }
    li.active .title mark {
      color: #ffe9b0;
    }
    li .hint {
      font-size: 11px;
      color: #9a9aa5;
      flex: 0 0 auto;
    }
    li.active .hint {
      color: #cfcfe6;
    }
    .empty {
      padding: 14px;
      color: #8a8a95;
      font: 13px system-ui, sans-serif;
    }
  `

  private get ranked(): RankedCommand[] {
    return rankCommands(this.commands, this.queryText)
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open) {
      // Fresh each time it opens: clear the query, select the first runnable
      // row, focus input.
      this.queryText = ''
      this.active = this.firstEnabledIndex()
      this.input?.focus()
    }
  }

  private onInput(e: Event) {
    this.queryText = (e.target as HTMLInputElement).value
    this.active = this.firstEnabledIndex() // best runnable match after a query change
  }

  /** Index of the first selectable (enabled) visible row, or 0 if none. */
  private firstEnabledIndex(): number {
    const i = this.ranked.findIndex((r) => r.command.enabled)
    return i < 0 ? 0 : i
  }

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }))
  }

  private runActive() {
    const rows = this.ranked
    const row = rows[this.active]
    if (!row || !row.command.enabled) return
    this.close()
    row.command.run()
  }

  private onKeydown(e: KeyboardEvent) {
    const rows = this.ranked
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.active = this.nextEnabled(this.active, 1, rows)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      this.active = this.nextEnabled(this.active, -1, rows)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.runActive()
    }
  }

  /** Move from `from` by `dir`, skipping disabled rows, clamped to the list. */
  private nextEnabled(from: number, dir: 1 | -1, rows: RankedCommand[]): number {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
      if (rows[i].command.enabled) return i
    }
    return from
  }

  render() {
    if (!this.open) return html``
    const rows = this.ranked
    return html`
      <div class="scrim" @click=${this.close}>
        <div class="palette" @click=${(e: Event) => e.stopPropagation()}>
          <input
            type="text"
            placeholder="Type a command…"
            .value=${this.queryText}
            @input=${this.onInput}
            @keydown=${this.onKeydown}
          />
          ${rows.length === 0
            ? html`<div class="empty">No matching commands</div>`
            : html`
                <ul>
                  ${rows.map(
                    (r, i) => html`
                      <li
                        class=${[i === this.active ? 'active' : '', r.command.enabled ? '' : 'disabled']
                          .filter(Boolean)
                          .join(' ')}
                        @click=${() => {
                          if (!r.command.enabled) return
                          this.active = i
                          this.runActive()
                        }}
                        @mousemove=${() => {
                          if (r.command.enabled) this.active = i
                        }}
                      >
                        <span class="title">${this.highlight(r)}</span>
                        ${r.command.hint ? html`<span class="hint">${r.command.hint}</span>` : ''}
                      </li>
                    `,
                  )}
                </ul>
              `}
        </div>
      </div>
    `
  }

  /** Render the title with matched character ranges wrapped in <mark>. */
  private highlight(r: RankedCommand) {
    const title = r.command.title
    if (r.ranges.length === 0) return title
    const out: unknown[] = []
    let cursor = 0
    for (const [start, end] of r.ranges) {
      if (start > cursor) out.push(title.slice(cursor, start))
      out.push(html`<mark>${title.slice(start, end)}</mark>`)
      cursor = end
    }
    if (cursor < title.length) out.push(title.slice(cursor))
    return out
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'command-palette': CommandPalette
  }
}

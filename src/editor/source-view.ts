import { LitElement, html, css } from 'lit'
import { customElement } from 'lit/decorators.js'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { baseExtensions, setDegraded } from './cm-setup'

/**
 * CodeMirror 6 source-editing view, hosted inside a Lit element.
 *
 * The markdown/text is the single source of truth (SSOT); later modes (split
 * preview, Crepe WYSIWYG, stream viewer) read/write the same text.
 *
 * Events: `doc-changed`, `cursor-changed` (detail: {line, col}).
 */
@customElement('source-view')
export class SourceView extends LitElement {
  private view?: EditorView
  private degraded = false

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: hidden;
    }
    .cm-host {
      height: 100%;
    }
    .cm-host .cm-editor {
      height: 100%;
    }
  `

  firstUpdated() {
    const parent = this.renderRoot.querySelector('.cm-host') as HTMLElement
    this.view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: baseExtensions(
          {
            onChange: () => this.dispatchEvent(new CustomEvent('doc-changed')),
            onCursor: (line, col) =>
              this.dispatchEvent(new CustomEvent('cursor-changed', { detail: { line, col } })),
          },
          this.degraded,
        ),
      }),
      parent,
    })
  }

  /** Replace the whole document (e.g. after opening a file). */
  setText(text: string) {
    const view = this.view
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
    })
  }

  /**
   * Switch the editor between full and degraded (large-file) feature sets.
   * Idempotent; the document and history survive the switch.
   */
  setDegraded(degraded: boolean) {
    if (degraded === this.degraded) return
    this.degraded = degraded
    if (this.view) setDegraded(this.view, degraded)
  }

  /** Current document text. */
  getText(): string {
    return this.view?.state.doc.toString() ?? ''
  }

  /** Total number of lines in the document (CM6 tracks this in O(1)). */
  getLineCount(): number {
    return this.view?.state.doc.lines ?? 1
  }

  render() {
    return html`<div class="cm-host"></div>`
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.view?.destroy()
    this.view = undefined
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'source-view': SourceView
  }
}

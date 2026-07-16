import { LitElement, html, css, unsafeCSS } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { renderMarkdown } from './preview/renderer'
import { PROSE_CSS } from './preview/prose-styles'

/**
 * Live Markdown preview pane. Renders sanitized HTML from the canonical
 * engine. The host (app-shell) feeds it debounced markdown text.
 */
@customElement('preview-pane')
export class PreviewPane extends LitElement {
  @property() markdown = ''

  // Pane chrome (scroll container + backdrop) is pane-specific; the rendered
  // content styling is shared VERBATIM with the HTML export so the two can't
  // drift. See `preview/prose-styles.ts`.
  static styles = [
    css`
      :host {
        display: block;
        height: 100%;
        overflow: auto;
        background: #1b1b1f;
      }
    `,
    unsafeCSS(PROSE_CSS),
  ]

  render() {
    return html`<div class="prose">${unsafeHTML(renderMarkdown(this.markdown))}</div>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'preview-pane': PreviewPane
  }
}

import { LitElement, html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { renderMarkdown } from './preview/renderer'

/**
 * Live Markdown preview pane. Renders sanitized HTML from the canonical
 * engine. The host (app-shell) feeds it debounced markdown text.
 */
@customElement('preview-pane')
export class PreviewPane extends LitElement {
  @property() markdown = ''

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      background: #1b1b1f;
    }
    .prose {
      max-width: 820px;
      margin: 0 auto;
      padding: 16px 28px 64px;
      color: #dcdce4;
      font: 14px/1.7 system-ui, sans-serif;
      word-wrap: break-word;
    }
    .prose :first-child {
      margin-top: 0;
    }
    .prose h1,
    .prose h2,
    .prose h3,
    .prose h4 {
      line-height: 1.25;
      margin: 1.4em 0 0.5em;
      color: #f0f0f5;
    }
    .prose h1 {
      font-size: 1.7em;
      border-bottom: 1px solid #333;
      padding-bottom: 0.3em;
    }
    .prose h2 {
      font-size: 1.4em;
      border-bottom: 1px solid #2c2c30;
      padding-bottom: 0.25em;
    }
    .prose a {
      color: #79b0ff;
    }
    .prose code {
      font: 12.5px/1.5 ui-monospace, 'Cascadia Code', Consolas, monospace;
      background: #2a2a30;
      padding: 0.15em 0.4em;
      border-radius: 4px;
    }
    .prose pre {
      background: #15151a;
      border: 1px solid #2c2c30;
      border-radius: 6px;
      padding: 12px 14px;
      overflow: auto;
    }
    .prose pre code {
      background: none;
      padding: 0;
    }
    .prose blockquote {
      margin: 1em 0;
      padding: 0.2em 1em;
      border-left: 3px solid #4a4a55;
      color: #a8a8b3;
    }
    .prose table {
      border-collapse: collapse;
      margin: 1em 0;
    }
    .prose th,
    .prose td {
      border: 1px solid #3a3a43;
      padding: 5px 10px;
    }
    .prose th {
      background: #26262b;
    }
    .prose img {
      max-width: 100%;
    }
    .prose hr {
      border: none;
      border-top: 1px solid #333;
      margin: 1.6em 0;
    }
  `

  render() {
    return html`<div class="prose">${unsafeHTML(renderMarkdown(this.markdown))}</div>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'preview-pane': PreviewPane
  }
}

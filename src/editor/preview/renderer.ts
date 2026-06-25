import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

/**
 * The single canonical Markdown engine (PLAN.md §6.d).
 *
 * The live preview renders from here, and export will render from the SAME
 * function — so "what you see is what you get" by construction (no drift
 * between a JS preview engine and a separate export engine).
 *
 * Pipeline: markdown-it (CommonMark + GFM tables/strikethrough) → DOMPurify.
 * KaTeX, Mermaid and Prism highlighting are layered on in a later increment.
 */
const md: MarkdownIt = new MarkdownIt({
  html: false, // raw HTML is escaped (defense-in-depth; output is sanitized too)
  linkify: true,
  typographer: false, // keep output deterministic for golden snapshots
  breaks: false,
})

export function renderMarkdown(src: string): string {
  const rendered = md.render(src)
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
  })
}

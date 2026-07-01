import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import footnote from 'markdown-it-footnote'
import texmath from 'markdown-it-texmath'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { highlightCode } from './prism'

/**
 * The single canonical Markdown engine (PLAN.md §6.d).
 *
 * The live preview renders from here, and export will render from the SAME
 * function — so "what you see is what you get" by construction (no drift
 * between a JS preview engine and a separate export engine).
 *
 * Pipeline: markdown-it (CommonMark + GFM tables/strikethrough) + GFM task
 * lists + footnotes + Prism syntax highlighting (static token markup) + KaTeX
 * math → DOMPurify. Mermaid is layered on in a later increment.
 *
 * Math uses KaTeX's MathML output (`$…$` inline, `$$…$$` display): it renders
 * natively in the WebView (Chromium MathML), needs no bundled fonts/CSS, and is
 * kept by DOMPurify's mathMl profile — fully offline and robust. (KaTeX's
 * pixel-polished HTML rendering would need font bundling; a later refinement.)
 */
const md: MarkdownIt = new MarkdownIt({
  html: false, // raw HTML is escaped (defense-in-depth; output is sanitized too)
  linkify: true,
  typographer: false, // keep output deterministic for golden snapshots
  breaks: false,
  highlight: highlightCode, // Prism tokens for fenced code (empty → md's default)
})
  // Read-only checkboxes (`- [ ]` / `- [x]`); not user-toggleable in preview.
  .use(taskLists, { label: true })
  .use(footnote)
  .use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { output: 'mathml', throwOnError: false },
  })

export function renderMarkdown(src: string): string {
  const rendered = md.render(src)
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    // <semantics>/<annotation> are NOT in DOMPurify's mathMl profile; without
    // them it unwraps the elements and KaTeX's TeX-source annotation leaks as
    // visible text next to the formula. They're inert MathML metadata (renderers
    // hide annotations), so keep them (+ the `encoding` attr).
    ADD_TAGS: ['semantics', 'annotation'],
    // Task-list checkboxes are disabled inputs; keep them and their state.
    ADD_ATTR: ['type', 'checked', 'disabled', 'encoding'],
  })
}

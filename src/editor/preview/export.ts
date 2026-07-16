import { renderMarkdown } from './renderer'
import { PROSE_CSS } from './prose-styles'

/**
 * Build a fully standalone, offline HTML document from Markdown (PLAN.md #8).
 *
 * The body is the SAME sanitized HTML the live preview shows — both go through
 * the single canonical `renderMarkdown` engine — so the export is "what you see
 * is what you get" by construction, with no separate export renderer to drift.
 *
 * The result is self-contained: styling is inlined in one `<style>` block and
 * math is native MathML (KaTeX's MathML output), so there are no external
 * stylesheets, scripts, fonts, or asset requests. The file opens identically
 * offline and is safe to move anywhere.
 *
 * Pure (no IPC / DOM-mutation side effects beyond DOMPurify's parse), so it is
 * unit-testable and callable from either the app or a test.
 */
export function buildStandaloneHtml(markdown: string, title: string): string {
  const body = renderMarkdown(markdown)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="vael">
<title>${escapeHtml(title)}</title>
<style>
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #1b1b1f; }
${PROSE_CSS}</style>
</head>
<body>
<article class="prose">
${body}
</article>
</body>
</html>
`
}

/** Escape text destined for an HTML text/attribute context (the <title>), so a
 *  document name containing `<`, `&`, `"` can't break out of it. The rendered
 *  body is already DOMPurify-sanitized; this guards only the title we inject. */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
}

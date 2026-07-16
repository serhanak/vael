import { renderMarkdown } from './renderer'
import { PROSE_CSS, PRINT_CSS } from './prose-styles'

/**
 * Build a standalone HTML document from Markdown (PLAN.md #8).
 *
 * The body is the SAME sanitized HTML the live preview shows — both go through
 * the single canonical `renderMarkdown` engine — so the export is "what you see
 * is what you get" by construction, with no separate export renderer to drift.
 *
 * Self-contained STYLING: the stylesheet is inlined in one `<style>` block and
 * math is native MathML (KaTeX's MathML output), so the document needs no
 * external stylesheet, script, or font — the builder never emits `<link>`,
 * `<script>`, or `@import`, and it renders correctly with no network.
 *
 * CAVEAT — images are NOT inlined. A Markdown image with a remote URL
 * (`![x](https://host/a.png)`) stays a remote `<img src>`: markdown-it generates
 * that element itself (so `html: false` doesn't stop it) and DOMPurify keeps it.
 * Such a document therefore does NOT render offline, and opening it fetches that
 * URL — disclosing the viewer's IP and User-Agent to the host. That is inherent
 * to the author's own markup, but it means "portable offline file" only holds
 * for documents without remote images. Embedding referenced assets as `data:`
 * URIs is a separate pass (PLAN.md §5 `inline-assets.ts`), not done here.
 *
 * A printed/PDF rendering flips to an ink-friendly light theme (see PRINT_CSS);
 * on screen the export matches the dark preview exactly.
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
${PROSE_CSS}${PRINT_CSS}</style>
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

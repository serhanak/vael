/**
 * Content styling for rendered Markdown, shared VERBATIM by the live preview
 * pane (`preview-pane.ts`, Shadow DOM) and the standalone HTML export
 * (`export.ts`). Keeping it in one place is the structural guarantee that what
 * the preview shows and what an exported/printed document contains never drift
 * (PLAN.md §6.d — single canonical render path, "preview = export").
 *
 * Plain string (not a Lit `css` result) so the export can inline it into a
 * `<style>` block and the pane can wrap it with `unsafeCSS`. Scope every rule to
 * `.prose` so it stays inert until applied to the rendered article container.
 */
export const PROSE_CSS = `
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
/* Prism token palette (dark). Scoped to .prose so it stays inside the pane. */
.prose .token.comment,
.prose .token.prolog,
.prose .token.doctype,
.prose .token.cdata {
  color: #6a6a75;
  font-style: italic;
}
.prose .token.punctuation {
  color: #9a9aa5;
}
.prose .token.property,
.prose .token.tag,
.prose .token.boolean,
.prose .token.number,
.prose .token.constant,
.prose .token.symbol,
.prose .token.deleted {
  color: #f0937d;
}
.prose .token.selector,
.prose .token.attr-name,
.prose .token.string,
.prose .token.char,
.prose .token.builtin,
.prose .token.inserted {
  color: #b5e08e;
}
.prose .token.operator,
.prose .token.entity,
.prose .token.url {
  color: #9ad1e0;
}
.prose .token.atrule,
.prose .token.attr-value,
.prose .token.keyword {
  color: #a5b4fc;
}
.prose .token.function,
.prose .token.class-name {
  color: #ffd479;
}
.prose .token.regex,
.prose .token.important,
.prose .token.variable {
  color: #f5c07a;
}
.prose .token.important,
.prose .token.bold {
  font-weight: 600;
}
.prose .token.italic {
  font-style: italic;
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
.prose ul.contains-task-list {
  list-style: none;
  padding-left: 1.1em;
}
.prose .task-list-item {
  list-style: none;
}
.prose .task-list-item input {
  margin: 0 0.5em 0 -1.1em;
  vertical-align: middle;
}
.prose .footnotes {
  margin-top: 2.4em;
  padding-top: 0.6em;
  border-top: 1px solid #333;
  font-size: 0.9em;
  color: #a8a8b3;
}
/* Display math: texmath wraps $$…$$ in a classless <section> (footnotes are a
   <section class="footnotes">, excluded here). Center it and let a wide
   equation scroll rather than overflow the pane. */
.prose section:not(.footnotes) {
  text-align: center;
  margin: 1em 0;
  overflow-x: auto;
}
.prose .katex {
  font-size: 1.05em;
}
.prose .footnote-ref a,
.prose .footnote-backref {
  color: #79b0ff;
  text-decoration: none;
}
`

import { describe, it, expect } from 'vitest'
import { buildStandaloneHtml } from './export'

// The HTML export shares the single canonical renderer with the live preview, so
// these lock what makes an exported file trustworthy: (1) it carries the SAME
// rendered body the preview shows, and (2) its STYLING is self-contained — no
// external stylesheet, script, font, or @import. Note (2) is deliberately about
// styling, not assets: images the author referenced by URL stay remote (see the
// remote-image test below, which pins that known limit).
describe('buildStandaloneHtml', () => {
  it('produces a complete HTML document with the prose article', () => {
    const doc = buildStandaloneHtml('# Hi', 'notes')
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<meta charset="utf-8">')
    expect(doc).toContain('<article class="prose">')
    expect(doc).toContain('</html>')
  })

  it('embeds the same rendered body the preview would show', () => {
    const doc = buildStandaloneHtml('# Title\n\nsome **bold**', 'x')
    expect(doc).toContain('<h1>Title</h1>')
    expect(doc).toContain('<strong>bold</strong>')
  })

  it('inlines styling and emits no external stylesheet/script/import', () => {
    const doc = buildStandaloneHtml('# Hi\n\n```js\nconst x = 1\n```', 'x')
    // The shared prose CSS is inlined in a <style> block...
    expect(doc).toContain('<style>')
    expect(doc).toContain('.prose')
    // ...and the builder never emits a <link>, <script>, or @import — the
    // document's styling is entirely self-contained (structural, not content-
    // dependent: true for any input).
    expect(doc).not.toContain('<link')
    expect(doc).not.toContain('<script')
    expect(doc).not.toMatch(/@import/)
  })

  it('renders math as native inline MathML (no bundled fonts/CSS)', () => {
    const doc = buildStandaloneHtml('$$a^2 + b^2$$', 'x')
    expect(doc).toContain('<math')
  })

  it('escapes the document title so a crafted name cannot break out', () => {
    const doc = buildStandaloneHtml('x', 'a</title><script>evil()</script>')
    // The injected markup is neutralized into entities, not a live element.
    expect(doc).toContain('&lt;/title&gt;&lt;script&gt;')
    expect(doc).not.toContain('<title>a</title><script>')
    // Exactly one real <title> element remains.
    expect(doc.match(/<title>/g)?.length).toBe(1)
  })

  it('keeps a Markdown link in the body without making it a page asset', () => {
    // A user-authored https link is legitimate content (an <a href>), distinct
    // from an external asset reference — it must survive.
    const doc = buildStandaloneHtml('[site](https://example.com)', 'x')
    expect(doc).toMatch(/<a [^>]*href="https:\/\/example\.com"/)
  })

  it('leaves a remote image as an external reference (pins a known limitation)', () => {
    // markdown-it GENERATES this <img> (so `html: false` doesn't stop it) and
    // DOMPurify keeps it. Consequence: a document with remote images does NOT
    // render offline, and opening the export fetches the URL — disclosing the
    // viewer's IP/User-Agent to that host. Asset inlining as data: URIs is a
    // separate pass (PLAN.md inline-assets.ts). Asserted so that implementing
    // inlining has to update this test deliberately rather than by accident.
    const doc = buildStandaloneHtml('![logo](https://example.com/a.png)', 'x')
    expect(doc).toMatch(/<img [^>]*src="https:\/\/example\.com\/a\.png"/)
  })

  it('ships print rules that flip the dark theme to ink-friendly light', () => {
    // Browsers drop backgrounds when printing, so without these the near-white
    // body text would land on white paper — an essentially blank printout.
    const doc = buildStandaloneHtml('# Hi', 'x')
    expect(doc).toContain('@media print')
    expect(doc).toMatch(/@media print\s*\{[\s\S]*background:\s*#fff/)
    expect(doc).toMatch(/@media print\s*\{[\s\S]*color:\s*#111/)
  })
})

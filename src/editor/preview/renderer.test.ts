import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './renderer'

// The renderer is the single canonical Markdown engine (preview today, export
// later), so these lock both its output shape and — more importantly — its
// sanitization. A regression here is a potential XSS, not just a visual diff.
describe('renderMarkdown — formatting', () => {
  it('renders headings and inline emphasis', () => {
    const html = renderMarkdown('# Title\n\nsome **bold** and *italic*')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })

  it('renders GFM tables', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
  })

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```\ncode line\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('<code>')
    expect(html).toContain('code line')
  })

  it('linkifies bare URLs', () => {
    const html = renderMarkdown('see https://example.com now')
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com"/)
  })

  it('renders blockquotes and lists', () => {
    const html = renderMarkdown('> quoted\n\n- one\n- two')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<li>one</li>')
  })

  it('renders GFM task lists as checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done')
    const boxes = html.match(/<input[^>]*type="checkbox"/g) ?? []
    expect(boxes.length).toBe(2)
    expect(html).toMatch(/<input[^>]*checked/) // the [x] item is checked
    expect(html).toMatch(/<input[^>]*disabled/) // read-only in preview
  })

  it('renders footnotes with a reference and a definition', () => {
    const html = renderMarkdown('Here is a note.[^1]\n\n[^1]: the note text')
    expect(html).toMatch(/footnote-ref/) // inline reference marker
    expect(html).toContain('the note text') // definition body
    expect(html).toMatch(/<a[^>]*href="#fnref1"/) // back-reference link
  })
})

describe('renderMarkdown — syntax highlighting (Prism)', () => {
  it('emits Prism token markup for a known language', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```')
    expect(html).toContain('language-js') // Prism's own 'js' alias → grammar found
    expect(html).toMatch(/<span class="token /) // tokenized, not plain text
    expect(html).toContain('const')
  })

  it('resolves an alias (py → python)', () => {
    const html = renderMarkdown('```py\nprint("hi")\n```')
    expect(html).toContain('language-python')
    expect(html).toMatch(/<span class="token /)
  })

  it('keeps token span classes through sanitization', () => {
    // The whole point of the canonical engine is that sanitization can't silently
    // strip the highlight markup (class must survive DOMPurify).
    const html = renderMarkdown('```rust\nfn main() {}\n```')
    expect(html).toMatch(/class="token /)
  })

  it('falls back to plain, escaped code for an unknown language', () => {
    const html = renderMarkdown('```notalang\nplain <stuff>\n```')
    expect(html).not.toMatch(/token/) // no Prism tokens
    expect(html).toMatch(/<code/)
    expect(html).toContain('&lt;stuff&gt;') // still HTML-escaped, never raw
  })
})

describe('renderMarkdown — sanitization (security)', () => {
  it('does not emit an executable <script> element', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> world')
    expect(html).not.toMatch(/<script/i)
  })

  it('escapes raw inline HTML instead of passing it through', () => {
    // html:false means raw HTML is escaped, so a <b> tag must not survive.
    const html = renderMarkdown('this is <b>raw</b> html')
    expect(html).not.toContain('<b>raw</b>')
    expect(html).toContain('&lt;b&gt;')
  })

  it('strips an onerror handler injected via raw HTML', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    // No real <img> element should be produced (raw HTML is neutralized).
    expect(html).not.toMatch(/<img[^>]+onerror/i)
  })

  it('neutralizes javascript: links', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toMatch(/href="javascript:/i)
  })

  it('keeps safe http(s) links intact', () => {
    const html = renderMarkdown('[ok](https://example.com/path)')
    expect(html).toMatch(/href="https:\/\/example\.com\/path"/)
  })
})

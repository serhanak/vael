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

import Prism from 'prismjs'
// `prismjs` core already bundles markup (html/xml/svg), css, clike and
// javascript. Add a curated set of common languages IN DEPENDENCY ORDER
// (tsx needs jsx + typescript; cpp needs c). Everything is imported statically
// so highlighting stays fully offline and deterministic — no CDN autoloader.
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-diff'

/** Fence languages people type that Prism doesn't already alias, mapped to a
 *  known grammar key. Unmapped labels (incl. "text"/"txt") fall through to the
 *  plain, escaped-code path. */
const ALIASES: Record<string, string> = {
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  jsonc: 'json',
}

/**
 * markdown-it `highlight` callback. Returns a complete `<pre><code>` block with
 * Prism token markup when the fence language is known; returns '' otherwise so
 * markdown-it applies its own safe default (HTML-escape + wrap). Because the
 * same canonical renderer feeds both preview and export, highlighting is
 * identical in both (PLAN.md §6.d).
 */
export function highlightCode(code: string, lang: string): string {
  const key = ALIASES[lang] ?? lang
  const grammar = key ? Prism.languages[key] : undefined
  if (!grammar) return '' // unknown/empty language → markdown-it escapes + wraps
  const tokens = Prism.highlight(code, grammar, key)
  // `key` is a resolved Prism grammar name here (a safe identifier), and
  // `tokens` is Prism-escaped; the whole thing is DOMPurify-sanitized downstream.
  return `<pre class="language-${key}"><code class="language-${key}">${tokens}</code></pre>`
}

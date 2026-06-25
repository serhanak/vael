import { defineConfig } from 'vitest/config'

// Frontend unit tests run in jsdom because the Markdown renderer's sanitizer
// (DOMPurify) needs a spec-complete `window`/DOM. (happy-dom mis-parses block
// wrappers like <pre>/<blockquote>/<table> when DOMPurify re-parses them.)
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})

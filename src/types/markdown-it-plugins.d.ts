// Minimal ambient declarations for markdown-it plugins that ship without
// (complete) TypeScript types. They are markdown-it `PluginWithOptions`.
declare module 'markdown-it-task-lists' {
  import type { PluginWithOptions } from 'markdown-it'
  const taskLists: PluginWithOptions<{ enabled?: boolean; label?: boolean; labelAfter?: boolean }>
  export default taskLists
}

declare module 'markdown-it-footnote' {
  import type { PluginSimple } from 'markdown-it'
  const footnote: PluginSimple
  export default footnote
}

declare module 'markdown-it-texmath' {
  import type { PluginWithOptions } from 'markdown-it'
  interface TexmathOptions {
    /** The math engine (the KaTeX module). */
    engine: unknown
    /** Delimiter set, e.g. 'dollars' (`$…$` / `$$…$$`). */
    delimiters?: string | string[]
    /** Passed through to katex.renderToString. */
    katexOptions?: Record<string, unknown>
  }
  const texmath: PluginWithOptions<TexmathOptions>
  export default texmath
}

import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language'

/**
 * Base CodeMirror 6 extension set for the M0 source view.
 *
 * Deliberately hand-composed (no `basic-setup`) so we can later swap pieces
 * in/out via Compartments for the large-file "degraded" tier (PLAN.md §6.b).
 *
 * @param onChange called whenever the document content changes.
 */
export function baseExtensions(onChange: () => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    rectangularSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    // Markdown base with lazy-loaded fenced-code language support.
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.theme(
      {
        '&': { fontSize: '13px', backgroundColor: '#1e1e22', color: '#e6e6e6' },
        '.cm-gutters': {
          backgroundColor: '#1e1e22',
          color: '#6b6b75',
          border: 'none',
        },
        '.cm-activeLine': { backgroundColor: '#26262b' },
        '.cm-activeLineGutter': { backgroundColor: '#26262b' },
      },
      { dark: true },
    ),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange()
    }),
  ]
}

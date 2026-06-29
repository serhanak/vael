import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from '@codemirror/view'
import { Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language'

export interface EditorCallbacks {
  /** Fired when the document content changes. */
  onChange: () => void
  /** Fired with the 1-based caret position when it moves or the doc changes. */
  onCursor: (line: number, col: number) => void
}

/**
 * Heavy extensions and line-wrapping live in compartments so the large-file
 * "degraded" tier can switch them off at runtime without rebuilding the editor
 * (docs/design/02-large-file.md §3.1). These are the costs that dominate on
 * big buffers: Lezer highlighting/parse, and O(line-length) wrap layout on the
 * pathological single-giant-line file.
 */
const featuresCompartment = new Compartment()
const wrapCompartment = new Compartment()

/** Syntax highlight + language + per-cursor/per-input passes — off when degraded. */
function heavyFeatures(): Extension[] {
  return [
    highlightActiveLine(),
    highlightActiveLineGutter(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    // Markdown base with lazy-loaded fenced-code language support.
    markdown({ base: markdownLanguage, codeLanguages: languages }),
  ]
}

/**
 * Base CodeMirror 6 extension set for the M0/M1 source view.
 *
 * Deliberately hand-composed (no `basic-setup`) so heavy pieces can be swapped
 * out via Compartments for the large-file "degraded" tier (PLAN.md §6.b).
 * `lineNumbers`, `drawSelection`, `history` and the keymap stay on in every
 * tier — they are cheap and viewport-bounded.
 */
export function baseExtensions(cb: EditorCallbacks, degraded = false): Extension[] {
  return [
    lineNumbers(),
    drawSelection(),
    rectangularSelection(),
    history(),
    // In-file find/replace (Ctrl+F). On in every editable tier — it operates on
    // the already-loaded CM6 document, so it's correct for Full and Degraded; the
    // >1 GB StreamViewer (never fully loaded) has its own Rust-backed find bar.
    // Cheap and viewport-bounded, so it stays on even when degraded.
    search({ top: true }),
    highlightSelectionMatches(),
    featuresCompartment.of(degraded ? [] : heavyFeatures()),
    // Wrap is OFF when degraded so a newline-less multi-MB line can't trigger
    // O(line-length) layout; the user gets horizontal scroll instead.
    wrapCompartment.of(degraded ? [] : EditorView.lineWrapping),
    // searchKeymap before defaultKeymap so Ctrl+F/G bind to the panel.
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
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
        // Search/replace panel — match the app chrome (default CM styling is light).
        '.cm-panels': { backgroundColor: '#26262b', color: '#e6e6e6' },
        '.cm-panels.cm-panels-top': { borderBottom: '1px solid #333' },
        '.cm-panel.cm-search': { padding: '6px 8px' },
        '.cm-panel.cm-search label': { fontSize: '12px' },
        '.cm-panel.cm-search input[type=text]': {
          backgroundColor: '#1f1f24',
          color: '#e6e6e6',
          border: '1px solid #444',
          borderRadius: '4px',
          padding: '2px 6px',
        },
        '.cm-panel.cm-search button': {
          backgroundColor: '#34343b',
          color: '#d6d6de',
          border: '1px solid #444',
          borderRadius: '4px',
          padding: '2px 8px',
          cursor: 'pointer',
        },
        '.cm-panel.cm-search button:hover': { backgroundColor: '#3e3e47' },
        '.cm-panel.cm-search button[name=close]': {
          border: 'none',
          background: 'transparent',
          color: '#9a9aa2',
        },
        '.cm-searchMatch': { backgroundColor: 'rgba(255, 214, 110, 0.25)' },
        '.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 214, 110, 0.5)' },
        '.cm-selectionMatch': { backgroundColor: 'rgba(120, 170, 255, 0.18)' },
      },
      { dark: true },
    ),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) cb.onChange()
      if (u.docChanged || u.selectionSet) {
        const head = u.state.selection.main.head
        const line = u.state.doc.lineAt(head)
        cb.onCursor(line.number, head - line.from + 1)
      }
    }),
  ]
}

/**
 * Reconfigure the heavy-feature and wrap compartments for the current tier,
 * keeping the document and history intact (PLAN.md §6.b runtime switch).
 */
export function setDegraded(view: EditorView, degraded: boolean): void {
  view.dispatch({
    effects: [
      featuresCompartment.reconfigure(degraded ? [] : heavyFeatures()),
      wrapCompartment.reconfigure(degraded ? [] : EditorView.lineWrapping),
    ],
  })
}

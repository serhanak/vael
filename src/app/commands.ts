/**
 * Command model + fuzzy matcher for the command palette (PLAN.md #10).
 *
 * The matcher is pure and lives here (not in the Lit component) so the ranking —
 * the part with real logic and edge cases — is unit-testable without a DOM.
 */

/** One invokable action shown in the palette. */
export interface Command {
  /** Stable id (for keys / tests), not shown to the user. */
  id: string
  /** Label shown in the list, e.g. "Save As…". */
  title: string
  /** Optional right-aligned hint, e.g. a shortcut or context ("Split only"). */
  hint?: string
  /** Whether the action can run now; disabled commands are shown greyed and
   *  are not selectable (kept visible so the palette is a discoverable menu). */
  enabled: boolean
  /** Perform the action. */
  run: () => void
}

/** A command plus the match metadata used to render and order it. */
export interface RankedCommand {
  command: Command
  score: number
  /** [start, end) index ranges in `command.title` that matched the query, for
   *  highlight. Empty when the query is empty. */
  ranges: Array<[number, number]>
}

/**
 * Score how well `query` fuzzy-matches `text` (subsequence match, case-
 * insensitive). Returns null when `text` doesn't contain the query characters in
 * order. Higher is better. Scoring rewards, per matched character:
 *   +consecutive run     — adjacent matches (a contiguous substring) rank high
 *   +word-boundary start — a match at the start of a word (after a space, or the
 *                          first char) beats a match mid-word
 * so "sa" ranks "Save" over "Reopen as…" and "exp" ranks "Export HTML" highly.
 *
 * An empty query matches everything with score 0 and no ranges (caller keeps the
 * original order).
 */
export function fuzzyScore(
  query: string,
  text: string,
): { score: number; ranges: Array<[number, number]> } | null {
  if (query.length === 0) return { score: 0, ranges: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  let qi = 0
  let score = 0
  let runLength = 0
  const ranges: Array<[number, number]> = []

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      runLength = 0
      continue
    }
    // Base point for a matched character.
    let point = 1
    // Consecutive matches compound (favours contiguous substrings).
    point += runLength * 3
    // Word-boundary bonus: first char, or preceded by a separator.
    const prev = ti > 0 ? text[ti - 1] : ' '
    if (ti === 0 || prev === ' ' || prev === '-' || prev === '_' || prev === '/') {
      point += 3
    }
    score += point
    runLength++

    // Extend the previous contiguous range or open a new one.
    const last = ranges[ranges.length - 1]
    if (last && last[1] === ti) last[1] = ti + 1
    else ranges.push([ti, ti + 1])

    qi++
  }

  if (qi < q.length) return null // ran out of text before matching all of query
  // Prefer shorter titles when scores tie (a shorter label is a tighter match).
  score -= text.length * 0.01
  return { score, ranges }
}

/**
 * Filter and rank `commands` against `query`. With an empty query every command
 * is returned in the given order (enabled first is the caller's concern — we
 * keep input order so the "default menu" is stable). With a query, only matching
 * commands are returned, best score first; ties keep input order (stable sort).
 */
export function rankCommands(commands: Command[], query: string): RankedCommand[] {
  if (query.trim().length === 0) {
    return commands.map((command) => ({ command, score: 0, ranges: [] }))
  }
  const matched: Array<RankedCommand & { i: number }> = []
  commands.forEach((command, i) => {
    const m = fuzzyScore(query.trim(), command.title)
    if (m) matched.push({ command, score: m.score, ranges: m.ranges, i })
  })
  matched.sort((a, b) => b.score - a.score || a.i - b.i)
  return matched.map(({ command, score, ranges }) => ({ command, score, ranges }))
}

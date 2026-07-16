import { describe, it, expect } from 'vitest'
import { fuzzyScore, rankCommands, type Command } from './commands'

describe('fuzzyScore', () => {
  it('matches a subsequence case-insensitively', () => {
    expect(fuzzyScore('sv', 'Save')).not.toBeNull()
    expect(fuzzyScore('EXP', 'Export HTML')).not.toBeNull()
  })

  it('returns null when characters are not present in order', () => {
    expect(fuzzyScore('xyz', 'Save')).toBeNull()
    expect(fuzzyScore('eva', 'Save')).toBeNull() // 'a' before 'v' — wrong order
  })

  it('treats an empty query as a match with no ranges', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ score: 0, ranges: [] })
  })

  it('scores a contiguous prefix higher than a scattered match', () => {
    const contig = fuzzyScore('sav', 'Save')!.score
    const scattered = fuzzyScore('sav', 'Show all values')!.score
    expect(contig).toBeGreaterThan(scattered)
  })

  it('reports contiguous matched ranges for highlighting', () => {
    // "exp" is a contiguous prefix of "Export HTML" → one range [0,3).
    expect(fuzzyScore('exp', 'Export HTML')!.ranges).toEqual([[0, 3]])
  })

  it('rewards a word-boundary match over a mid-word one', () => {
    // 'h' at the start of the word "HTML" should beat 'h' inside "Switch".
    const boundary = fuzzyScore('h', 'Export HTML')!.score
    const midword = fuzzyScore('h', 'Switch')!.score
    expect(boundary).toBeGreaterThan(midword)
  })
})

describe('rankCommands', () => {
  const cmd = (id: string, title: string): Command => ({ id, title, enabled: true, run: () => {} })
  const commands = [
    cmd('open', 'Open File'),
    cmd('save', 'Save'),
    cmd('saveAs', 'Save As…'),
    cmd('export', 'Export HTML'),
    cmd('split', 'View: Split'),
  ]

  it('returns every command in input order for an empty query', () => {
    const out = rankCommands(commands, '')
    expect(out.map((r) => r.command.id)).toEqual(['open', 'save', 'saveAs', 'export', 'split'])
  })

  it('drops non-matching commands', () => {
    const out = rankCommands(commands, 'save')
    expect(out.map((r) => r.command.id)).toEqual(['save', 'saveAs'])
  })

  it('orders the tighter match first', () => {
    // "Save" is a full contiguous match; "Save As…" matches too but is longer.
    const out = rankCommands(commands, 'save')
    expect(out[0].command.id).toBe('save')
  })

  it('is stable for equal scores (keeps input order)', () => {
    // A query hitting both "Save" and "Save As…" at their shared prefix; the
    // shorter one wins on the length tiebreak, but two same-length titles keep
    // input order — assert via a crafted pair.
    const pair = [cmd('a', 'Reload'), cmd('b', 'Reopen')]
    const out = rankCommands(pair, 're')
    expect(out.map((r) => r.command.id)).toEqual(['a', 'b'])
  })

  it('matches across word boundaries (space-separated query chars)', () => {
    const out = rankCommands(commands, 'vs')
    expect(out.map((r) => r.command.id)).toContain('split') // "View: Split"
  })
})

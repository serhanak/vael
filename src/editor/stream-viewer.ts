import { LitElement, html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { readLines, searchFile, type Hit, type SearchSummary } from '../services/ipc'

/**
 * Read-only virtualized viewer for the >1 GB tier (docs/design/02-large-file.md
 * §3.2). It is deliberately NOT CodeMirror: CM6's `Text` rope must materialize
 * the whole document, which a multi-GB file can't fit in the WebView. Here only
 * the visible window (plus overscan) is ever in the DOM, and lines are pulled
 * from the backend on demand and cached. Constant fixed line height makes the
 * virtual scrollbar an O(1) computation.
 */
@customElement('stream-viewer')
export class StreamViewer extends LitElement {
  @property() path = ''
  @property() encoding = 'UTF-8'
  /** Total visual lines; grows as the background index reports progress. */
  @property({ type: Number }) totalLines = 1

  @state() private firstVisible = 0
  @state() private visibleCount = 0

  // Find bar (ripgrep-backed search over the whole file).
  @state() private findOpen = false
  @state() private query = ''
  @state() private useRegex = false
  @state() private caseInsensitive = true
  @state() private hits: Hit[] = []
  @state() private current = -1
  @state() private searching = false
  @state() private searchError = ''
  @state() private summary: SearchSummary | null = null
  /** Line currently centered by a search jump, highlighted in the gutter+row. */
  @state() private activeLine = -1
  /** Highest hit line — search greps the whole file independently of the
   *  background index, so a hit can be past the indexed `totalLines`; the
   *  virtual extent must cover it or the scroll clamps and the row won't render. */
  @state() private maxHitLine = 0
  /** The query `hits` belong to — guards navigating stale results mid-edit. */
  private resultsQuery = ''
  /** Monotonic token so a slow search can't overwrite a newer one's results. */
  private searchSeq = 0
  private searchTimer?: number

  /** Virtual document height in lines: the indexed total, but at least far
   *  enough to reach the deepest search hit so jumps aren't clamped. */
  private get virtualLines(): number {
    return Math.max(this.totalLines, this.maxHitLine + 1)
  }

  /** Float line at the top of the viewport (drives row placement). Decoupled
   *  from raw scrollTop because the scrollbar is scaled for huge files. */
  private topLine = 0
  private viewportH = 0

  /** line index → decoded text. Bounded; oldest *insertions* are evicted
   *  (insertion-order, not access-order), except lines in the visible window. */
  private cache = new Map<number, string>()
  private cacheOrder: number[] = []
  private static readonly CACHE_CAP = 8000
  private readonly lineHeight = 18
  private readonly overscan = 60
  /** Browser/WebView2 (Chromium) caps element height at ~33.5M px; above this
   *  the sizer is clamped and absolute row positions break. Stay well under and
   *  scale the line↔pixel mapping past it. */
  private static readonly MAX_SIZER_PX = 30_000_000
  /** The range a fetch is currently in flight for (de-dupes scroll spam). */
  private pendingFrom = -1
  private pendingTo = -1
  /** Bumped whenever the file/encoding changes; in-flight fetches from a prior
   *  epoch are discarded so old-encoding lines never land in the fresh cache. */
  private epoch = 0
  private scrollEl?: HTMLElement
  /** The translated row layer; its transform is updated synchronously on scroll
   *  (not via the async render) so it can't lag the native scroll and flicker. */
  private rowsEl?: HTMLElement
  private rafPending = false
  /** Re-measures geometry when the viewport is resized (window/pane/layout);
   *  without it a maximize leaves blank rows / a stale jump mapping until the
   *  next scroll, since geometry is otherwise only derived inside recompute(). */
  private resizeObs?: ResizeObserver
  /** Deferred, epoch-guarded retry after a transient line-fetch failure. */
  private retryTimer?: number

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-width: 0;
    }
    .scroll {
      position: relative;
      height: 100%;
      overflow: auto;
      /* Don't let the browser re-adjust scrollTop when the windowed rows change
         under the viewport — that fights our own layout and causes flicker. */
      overflow-anchor: none;
      background: #1b1b1f;
      font: 12px/18px ui-monospace, 'Cascadia Code', Consolas, monospace;
      color: #d2d2da;
    }
    .sizer {
      width: 1px;
    }
    .rows {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      will-change: transform;
    }
    .row {
      position: absolute;
      left: 0;
      right: 0;
      height: 18px;
      display: flex;
      white-space: pre;
    }
    .ln {
      flex: 0 0 auto;
      text-align: right;
      padding: 0 12px 0 10px;
      color: #5c5c66;
      background: #1b1b1f;
      position: sticky;
      left: 0;
      user-select: none;
    }
    .tx {
      flex: 1 1 auto;
    }
    .tx.loading {
      color: #44444c;
    }
    .row.active .tx {
      background: #3a3a18;
    }
    .row.active .ln {
      background: #3a3a18;
      color: #d8d8a0;
    }
    .findbar {
      position: absolute;
      top: 8px;
      right: 18px;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      background: #2c2c33;
      border: 1px solid #444;
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
      font: 12px/1.4 system-ui, sans-serif;
      color: #d6d6de;
    }
    .findbar input[type='text'] {
      width: 200px;
      font: inherit;
      color: #e6e6e6;
      background: #1f1f24;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 3px 6px;
    }
    .findbar button {
      font: inherit;
      color: #d6d6de;
      background: #34343b;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 2px 7px;
      cursor: pointer;
    }
    .findbar button:hover:not(:disabled) {
      background: #3e3e47;
    }
    .findbar button.toggle.on {
      background: #4a4a8a;
      border-color: #5a5aa0;
      color: #fff;
    }
    .findbar button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .findbar .count {
      min-width: 78px;
      text-align: center;
      color: #9a9aa2;
      font-variant-numeric: tabular-nums;
    }
    .findbar .count.err {
      color: #ff8a8a;
    }
  `

  connectedCallback() {
    super.connectedCallback()
    // Window-scoped so Ctrl+F works without first clicking into the viewer;
    // only one stream-viewer is mounted at a time (the >1 GB tier).
    window.addEventListener('keydown', this.onKeydown)
  }

  firstUpdated() {
    this.scrollEl = this.renderRoot.querySelector('.scroll') as HTMLElement
    this.rowsEl = this.renderRoot.querySelector('.rows') as HTMLElement
    this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true })
    // Geometry (viewport height, visible-row count, scaled scroll↔line mapping)
    // is derived from clientHeight; recompute whenever the viewport resizes, or a
    // window-maximize / pane-drag leaves blank rows and a stale jump mapping
    // until the next scroll event happens to re-run recompute().
    this.resizeObs = new ResizeObserver(() => this.recompute())
    this.resizeObs.observe(this.scrollEl)
    this.recompute()
  }

  private onKeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      this.openFind()
    } else if (e.key === 'Escape' && this.findOpen) {
      this.closeFind()
    }
  }

  private openFind() {
    this.findOpen = true
    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector('.findbar input') as HTMLInputElement | null
      input?.focus()
      input?.select()
    })
  }

  private closeFind() {
    this.findOpen = false
    this.activeLine = -1
  }

  /** Re-run the search shortly after the query/options settle. */
  private scheduleSearch() {
    clearTimeout(this.searchTimer)
    this.searchTimer = window.setTimeout(() => this.runSearch(), 180)
  }

  private clearResults() {
    this.hits = []
    this.current = -1
    this.activeLine = -1
    this.summary = null
    this.resultsQuery = ''
    // NB: maxHitLine is deliberately NOT reset here. It sizes the virtual extent
    // (virtualLines) so a jump to a hit past the still-indexing `totalLines` isn't
    // clamped. Zeroing it at the start of every re-search would collapse the sizer
    // and yank a deep-scrolled viewport backward mid-grep. It is reset only on a
    // genuine new document (updated(), below) and overwritten when fresh results
    // arrive (runSearch).
  }

  private async runSearch() {
    const q = this.query
    const seq = ++this.searchSeq
    this.clearResults() // drop stale results so they can't be navigated mid-search
    this.searchError = ''
    if (!q) {
      this.searching = false
      return
    }
    this.searching = true
    const collected: Hit[] = []
    try {
      const summary = await searchFile(this.path, q, this.useRegex, this.caseInsensitive, (batch) => {
        if (seq === this.searchSeq) collected.push(...batch)
      })
      if (seq !== this.searchSeq) return // a newer search superseded us
      this.hits = collected
      this.maxHitLine = collected.reduce((m, h) => Math.max(m, h.line), 0)
      this.summary = summary
      this.resultsQuery = q
      this.current = collected.length ? 0 : -1
      if (this.current >= 0) await this.jumpTo(0)
    } catch (e) {
      if (seq !== this.searchSeq) return
      this.clearResults()
      this.searchError = e instanceof Error ? e.message : String(e)
    } finally {
      if (seq === this.searchSeq) this.searching = false
    }
  }

  private async jumpTo(i: number) {
    if (i < 0 || i >= this.hits.length) return
    this.current = i
    const line = this.hits[i].line
    this.activeLine = line
    // The hit may be past the still-indexing `totalLines`. `virtualLines`
    // already covers it, but the scroll container's sizer only reflects that
    // after Lit commits the render — wait, or the browser clamps scrollTop to
    // the shorter height and we land in the wrong place.
    await this.updateComplete
    const el = this.scrollEl
    if (el) {
      // Center the line: put (line - half a viewport) at the top, via the
      // scaled mapping so it works for huge files past the pixel cap too.
      const targetTop = line - Math.floor(this.visibleCount / 2)
      el.scrollTop = this.scrollTopForLine(targetTop)
      this.recompute()
    }
  }

  private step(delta: number) {
    if (!this.hits.length) return
    const next = (this.current + delta + this.hits.length) % this.hits.length
    void this.jumpTo(next)
  }

  private onFindKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      // Only step through results that belong to the current query; otherwise
      // run the search now (don't navigate the previous query's stale hits).
      const fresh = this.resultsQuery === this.query && this.hits.length > 0
      if (fresh) {
        this.step(e.shiftKey ? -1 : 1)
      } else if (!this.searching) {
        clearTimeout(this.searchTimer)
        void this.runSearch()
      }
    }
  }

  updated(changed: Map<string, unknown>) {
    // A new file, or a re-decode with a different encoding: drop the cache and
    // jump back to the top (cached lines were decoded with the old encoding).
    if (changed.has('path') || changed.has('encoding')) {
      this.epoch++ // invalidate any in-flight fetch from the previous file/encoding
      clearTimeout(this.retryTimer)
      this.cache.clear()
      this.cacheOrder = []
      this.pendingFrom = this.pendingTo = -1
      // Search results belong to the previous file/encoding — drop them. This is a
      // real new document, so the virtual extent must reset too (clearResults
      // leaves maxHitLine alone for the mid-re-search case).
      this.searchSeq++
      this.clearResults()
      this.maxHitLine = 0
      this.searchError = ''
      if (this.scrollEl) this.scrollEl.scrollTop = 0
      this.firstVisible = 0
      this.recompute()
    } else if (changed.has('totalLines')) {
      // The background index reported more lines, so the virtual height (and,
      // for huge files, the scaled scrollTop↔line mapping) changed. Re-anchor on
      // the same top line so the view doesn't drift as indexing progresses.
      if (this.scrollEl && this.topLine > 0) {
        this.scrollEl.scrollTop = this.scrollTopForLine(this.topLine)
      }
      this.recompute()
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.scrollEl?.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('keydown', this.onKeydown)
    this.resizeObs?.disconnect()
    clearTimeout(this.searchTimer)
    clearTimeout(this.retryTimer)
  }

  private onScroll = () => {
    const el = this.scrollEl
    if (!el) return
    // Pin the row layer to the viewport SYNCHRONOUSLY every scroll event so it
    // tracks the native scroll exactly (an async-render transform lags a frame
    // and flickers). The heavier line-mapping work is throttled to one a frame.
    this.pinRows(el.scrollTop)
    if (!this.rafPending) {
      this.rafPending = true
      requestAnimationFrame(() => {
        this.rafPending = false
        this.recompute()
      })
    }
  }

  /** Keep `.rows` glued to the viewport top (it otherwise scrolls away with the
   *  content, since it's absolutely positioned inside the scroller) AND carry the
   *  sub-line scroll offset. Rows are laid out at integer line positions relative
   *  to `firstVisible`, so they only re-render when the line window shifts; the
   *  fractional remainder of the current scroll position is applied here, in the
   *  synchronous transform, so within-line scrolling stays pixel-smooth without a
   *  re-render (and can't lag a frame behind the native scroll and flicker). */
  private pinRows(scrollTop: number) {
    if (!this.rowsEl) return
    const maxScroll = Math.max(0, this.sizerHeight - this.viewportH)
    const topLine = maxScroll > 0 ? (scrollTop / maxScroll) * this.maxTopLine : 0
    const frac = topLine - Math.floor(topLine)
    this.rowsEl.style.transform = `translateY(${scrollTop - frac * this.lineHeight}px)`
  }

  /** Sizer (scrollbar) height: the true content height, clamped to the
   *  browser's max so it isn't silently truncated for huge files. */
  private get sizerHeight(): number {
    return Math.min(this.virtualLines * this.lineHeight, StreamViewer.MAX_SIZER_PX)
  }

  /** Topmost first-visible line when scrolled to the very bottom. */
  private get maxTopLine(): number {
    return Math.max(0, this.virtualLines - this.visibleCount)
  }

  private recompute() {
    const el = this.scrollEl
    if (!el) return
    this.viewportH = el.clientHeight
    this.visibleCount = Math.max(1, Math.ceil(this.viewportH / this.lineHeight))
    const scrollTop = el.scrollTop
    const maxScroll = Math.max(0, this.sizerHeight - this.viewportH)
    // Map the (possibly scaled) scrollbar position to a fractional line. When
    // the content fits under MAX_SIZER_PX this is exactly scrollTop/lineHeight.
    this.topLine = maxScroll > 0 ? (scrollTop / maxScroll) * this.maxTopLine : 0
    this.firstVisible = Math.floor(this.topLine)
    // Pin AFTER geometry is fresh: the sub-line fraction in pinRows depends on
    // maxTopLine (→ visibleCount). Also re-pins on programmatic scrolls (jump,
    // resize, indexing re-anchor).
    this.pinRows(scrollTop)
    this.ensureLoaded(this.firstVisible - this.overscan, this.visibleCount + 2 * this.overscan)
  }

  /** Inverse of `recompute`'s mapping: scrollTop that puts `topLine` at the top. */
  private scrollTopForLine(topLine: number): number {
    const el = this.scrollEl
    if (!el) return 0
    const maxScroll = Math.max(0, this.sizerHeight - el.clientHeight)
    const clamped = Math.max(0, Math.min(this.maxTopLine, topLine))
    return this.maxTopLine > 0 ? (clamped / this.maxTopLine) * maxScroll : 0
  }

  /** Fetch any not-yet-cached lines in the desired window, coalesced into one
   *  contiguous request (the gap between the first and last missing line). */
  private async ensureLoaded(start: number, count: number) {
    const from = Math.max(0, start)
    // Allow fetching past the indexed total up to a search hit; read_lines
    // forward-scans the mmap so it can resolve lines the index hasn't reached.
    const to = Math.min(this.virtualLines, from + count)
    let missFrom = -1
    for (let i = from; i < to; i++) {
      if (!this.cache.has(i)) {
        missFrom = i
        break
      }
    }
    if (missFrom === -1) return // window fully cached
    let missTo = missFrom + 1
    for (let i = to - 1; i >= missFrom; i--) {
      if (!this.cache.has(i)) {
        missTo = i + 1
        break
      }
    }
    if (missFrom === this.pendingFrom && missTo === this.pendingTo) return // already loading
    this.pendingFrom = missFrom
    this.pendingTo = missTo
    const epoch = this.epoch // snapshot: discard results if the file/encoding changes
    try {
      await readLines(this.path, missFrom, missTo - missFrom, (chunk) => {
        if (epoch !== this.epoch) return // stale fetch from a previous file/encoding
        chunk.lines.forEach((ln, k) => this.put(chunk.startLine + k, ln))
        this.requestUpdate()
      })
    } catch {
      // A transient read error (vs. a real session/path swap, which bumps epoch)
      // would otherwise leave this window stuck showing '⋯' until the user
      // scrolls. Schedule an epoch-guarded retry so an idle user recovers on its
      // own; recompute() re-arms it until the window loads or the document
      // changes. clearTimeout-stacked so only the latest retry is pending.
      clearTimeout(this.retryTimer)
      const ep = epoch
      this.retryTimer = window.setTimeout(() => {
        if (ep === this.epoch) this.recompute()
      }, 600)
    } finally {
      if (this.pendingFrom === missFrom) {
        this.pendingFrom = this.pendingTo = -1
      }
    }
    if (epoch === this.epoch) this.requestUpdate()
  }

  private put(line: number, text: string) {
    if (!this.cache.has(line)) this.cacheOrder.push(line)
    this.cache.set(line, text)
    if (this.cacheOrder.length <= StreamViewer.CACHE_CAP) return
    // Evict oldest insertions, but never a line in the current visible window
    // (that would flash a '⋯' placeholder over what the user is looking at).
    const from = Math.max(0, this.firstVisible - this.overscan)
    const to = this.firstVisible + this.visibleCount + this.overscan
    let scanned = 0
    while (this.cacheOrder.length > StreamViewer.CACHE_CAP && scanned < this.cacheOrder.length) {
      const old = this.cacheOrder.shift()
      if (old === undefined) break
      if (old >= from && old < to) {
        this.cacheOrder.push(old) // keep visible line; reconsider later
        scanned++
        continue
      }
      this.cache.delete(old)
      scanned = 0
    }
  }

  private renderFindBar() {
    const count = this.searchError
      ? html`<span class="count err" title=${this.searchError}>error</span>`
      : this.searching
        ? html`<span class="count">…</span>`
        : this.hits.length
          ? html`<span class="count"
              >${(this.current + 1).toLocaleString()} / ${this.hits.length.toLocaleString()}${this
                .summary?.truncated
                ? '+'
                : ''}</span
            >`
          : this.query
            ? html`<span class="count">No results</span>`
            : html`<span class="count"></span>`
    return html`
      <div class="findbar" @keydown=${(e: KeyboardEvent) => this.onFindKeydown(e)}>
        <input
          type="text"
          placeholder="Find in file…"
          .value=${this.query}
          @input=${(e: Event) => {
            this.query = (e.target as HTMLInputElement).value
            this.scheduleSearch()
          }}
        />
        <button
          class="toggle ${this.caseInsensitive ? '' : 'on'}"
          title="Match case"
          @click=${() => {
            this.caseInsensitive = !this.caseInsensitive
            this.runSearch()
          }}
        >
          Aa
        </button>
        <button
          class="toggle ${this.useRegex ? 'on' : ''}"
          title="Regular expression"
          @click=${() => {
            this.useRegex = !this.useRegex
            this.runSearch()
          }}
        >
          .*
        </button>
        ${count}
        ${(() => {
          const stale = !this.hits.length || this.resultsQuery !== this.query
          return html`
            <button title="Previous (Shift+Enter)" ?disabled=${stale} @click=${() => this.step(-1)}>
              ↑
            </button>
            <button title="Next (Enter)" ?disabled=${stale} @click=${() => this.step(1)}>
              ↓
            </button>
          `
        })()}
        <button title="Close (Esc)" @click=${() => this.closeFind()}>✕</button>
      </div>
    `
  }

  render() {
    // Use the virtual extent (which covers search hits past the indexed total).
    const extent = this.virtualLines
    const from = Math.max(0, this.firstVisible - this.overscan)
    const to = Math.min(extent, this.firstVisible + this.visibleCount + this.overscan)
    const gutter = `${Math.max(4, String(extent).length)}ch`
    const rows = []
    for (let i = from; i < to; i++) {
      const text = this.cache.get(i)
      // Rows are positioned at INTEGER offsets relative to firstVisible (the
      // .rows layer is translated to follow the scroll AND carry the sub-line
      // fraction), so positions stay small even at 100M+ lines, and the rows
      // re-render only when the line window shifts — not on every sub-line scroll.
      const top = (i - this.firstVisible) * this.lineHeight
      rows.push(html`
        <div class="row ${i === this.activeLine ? 'active' : ''}" style="top:${top}px">
          <span class="ln" style="min-width:${gutter}">${(i + 1).toLocaleString()}</span>
          <span class="tx ${text === undefined ? 'loading' : ''}">${text ?? '⋯'}</span>
        </div>
      `)
    }
    return html`
      ${this.findOpen ? this.renderFindBar() : ''}
      <div class="scroll">
        <div class="sizer" style="height:${this.sizerHeight}px"></div>
        <div class="rows">${rows}</div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stream-viewer': StreamViewer
  }
}

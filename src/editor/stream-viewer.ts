import { LitElement, html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { readLines } from '../services/ipc'

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

  /** line index → decoded text. Bounded; oldest *insertions* are evicted
   *  (insertion-order, not access-order), except lines in the visible window. */
  private cache = new Map<number, string>()
  private cacheOrder: number[] = []
  private static readonly CACHE_CAP = 8000
  private readonly lineHeight = 18
  private readonly overscan = 60
  /** The range a fetch is currently in flight for (de-dupes scroll spam). */
  private pendingFrom = -1
  private pendingTo = -1
  /** Bumped whenever the file/encoding changes; in-flight fetches from a prior
   *  epoch are discarded so old-encoding lines never land in the fresh cache. */
  private epoch = 0
  private scrollEl?: HTMLElement

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
  `

  firstUpdated() {
    this.scrollEl = this.renderRoot.querySelector('.scroll') as HTMLElement
    this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true })
    this.recompute()
  }

  updated(changed: Map<string, unknown>) {
    // A new file, or a re-decode with a different encoding: drop the cache and
    // jump back to the top (cached lines were decoded with the old encoding).
    if (changed.has('path') || changed.has('encoding')) {
      this.epoch++ // invalidate any in-flight fetch from the previous file/encoding
      this.cache.clear()
      this.cacheOrder = []
      this.pendingFrom = this.pendingTo = -1
      if (this.scrollEl) this.scrollEl.scrollTop = 0
      this.firstVisible = 0
      this.recompute()
    } else if (changed.has('totalLines')) {
      // The background index just reported more lines; fill any rows in the
      // current viewport that were beyond the previous (provisional) total.
      this.recompute()
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.scrollEl?.removeEventListener('scroll', this.onScroll)
  }

  private onScroll = () => this.recompute()

  private recompute() {
    const el = this.scrollEl
    if (!el) return
    this.firstVisible = Math.floor(el.scrollTop / this.lineHeight)
    this.visibleCount = Math.max(1, Math.ceil(el.clientHeight / this.lineHeight))
    this.ensureLoaded(this.firstVisible - this.overscan, this.visibleCount + 2 * this.overscan)
  }

  /** Fetch any not-yet-cached lines in the desired window, coalesced into one
   *  contiguous request (the gap between the first and last missing line). */
  private async ensureLoaded(start: number, count: number) {
    const from = Math.max(0, start)
    const to = Math.min(this.totalLines, from + count)
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
      // session swapped or path mismatch; a later scroll will retry
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

  render() {
    const from = Math.max(0, this.firstVisible - this.overscan)
    const to = Math.min(this.totalLines, this.firstVisible + this.visibleCount + this.overscan)
    const gutter = `${Math.max(4, String(this.totalLines).length)}ch`
    const rows = []
    for (let i = from; i < to; i++) {
      const text = this.cache.get(i)
      rows.push(html`
        <div class="row" style="top:${i * this.lineHeight}px">
          <span class="ln" style="min-width:${gutter}">${(i + 1).toLocaleString()}</span>
          <span class="tx ${text === undefined ? 'loading' : ''}">${text ?? '⋯'}</span>
        </div>
      `)
    }
    return html`
      <div class="scroll">
        <div class="sizer" style="height:${this.totalLines * this.lineHeight}px"></div>
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

# vael — Operator (manual GUI) test plan

Human-driven verification of everything that can't be checked headlessly: how
things actually **render and feel** in the real WebView2. Run this in a fresh
session against `pnpm tauri dev`. Automated tests (40 Rust + 43 vitest) already
cover logic/sanitization; this plan covers the visual/interaction layer.

For each case: do the **Steps**, compare to **Expected**, mark **Result**
(✅ pass / ❌ fail / ➖ n/a) and jot anything odd. A ❌ becomes the next session's
work item.

Legend: 🆕 = never verified in the GUI before (the accumulated backlog — verify
these first). 🔁 = regression re-check of something smoke-tested earlier.

---

## 0. Build & launch

This machine (Windows 10 Pro N): prepend Node + cargo to PATH first.

```powershell
$env:Path = 'C:\Program Files\nodejs;' + (Join-Path $env:USERPROFILE '.cargo\bin') + ';' + $env:Path
pnpm tauri dev
```

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 0.1 | Run the commands above | Window opens, empty "untitled" editor, dark theme, no console errors | |
| 0.2 | Resize the window | Layout reflows; no double scrollbar; header/status bar stay put | |

---

## 1. Open / Save / encoding (M1 core) 🔁

Fixtures in `docs/qa/fixtures/`.

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 1.1 | Open `sample.md` | Loads; status bar shows **UTF-8**, **LF** (or CRLF), no BOM; path in header | |
| 1.2 | Type a character | Header shows the dirty dot `•`; line/col update as you move | |
| 1.3 | Save (Ctrl+S) | Dirty dot clears; no error; file on disk updated | |
| 1.4 | Open `lossy-test.md`, status bar → set encoding **Windows-1254**, Save | **Lossy dialog** appears (3 options): Save as UTF-8 / Save anyway / Cancel 🆕 | |
| 1.5 | In that dialog, pick **Save as UTF-8** | Saves losslessly; encoding shows UTF-8; no data lost | |
| 1.6 | Repeat 1.4 but pick **Save anyway** | Saves in Windows-1254; unrepresentable chars replaced (data loss, as warned) | |
| 1.7 | Reopen a file, use status-bar **Reopen with encoding** on a legacy file | Re-decodes; not marked dirty | |

---

## 2. Split preview — KaTeX math, Prism, task lists, footnotes 🆕

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 2.1 | With `sample.md` open, click **Split** | Editor left, live preview right | |
| 2.2 | Look at the inline math ($E=mc^2$, √) | Renders as real math (MathML), NOT raw `$E=mc^2$` text; **no leftover TeX source** next to it 🆕 | |
| 2.3 | Look at the display math (integral, matrix) | Centered on its own line; a wide equation scrolls, doesn't overflow the pane | |
| 2.4 | Look at the code blocks | JS/Python/Rust/SQL are **syntax-highlighted** (colored tokens), monospace | |
| 2.5 | Task list | Two checkboxes, one checked, both disabled (not clickable) | |
| 2.6 | Footnotes | Superscript refs; footnote section at the bottom with back-links | |
| 2.7 | Table, blockquote, hr, links | All styled as expected; links look clickable | |
| 2.8 | Edit the source | Preview updates within ~150 ms | |

> Known non-bug: if MathML looks unstyled/plain in this WebView, note it — the
> fallback is KaTeX-HTML with bundled fonts. That decision is what 2.2 informs.

---

## 3. Scroll-sync (split mode) 🆕

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 3.1 | In Split, scroll the **editor** | Preview follows proportionally | |
| 3.2 | Scroll the **preview** | Editor follows proportionally | |
| 3.3 | Alternate quickly between panes | No jitter/fighting; whichever you touch leads (leader-lock), the other follows | |
| 3.4 | Overall feel | Smooth, not laggy or jumpy 🆕 (subjective — note if it feels off) | |

---

## 4. Large-file tiers 🔁

Generate test files (PowerShell), then open each.

```powershell
# ~75 MB → degraded tier
$f = Join-Path $env:TEMP 'vael-degraded.txt'
$sw = [IO.StreamWriter]::new($f); 1..900000 | % { $sw.WriteLine("line $_ the quick brown fox jumps over the lazy dog") }; $sw.Close()

# ~1.3 GB → streamViewer tier (takes a bit; needs disk space)
$f = Join-Path $env:TEMP 'vael-huge.txt'
$sw = [IO.StreamWriter]::new($f); 1..16000000 | % { $sw.WriteLine("line $_ the quick brown fox jumps over the lazy dog") }; $sw.Close()
```

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 4.1 | Open the ~75 MB file | Opens as **large file** (degraded badge); editable; Split disabled; scrolling responsive | |
| 4.2 | Ctrl+F in it | CM6 find panel; matches highlight; find+replace work | |
| 4.3 | Open the ~1.3 GB file | Opens as **huge file** (streamViewer badge); read-only; line count fills in as it indexes | |
| 4.4 | Scroll the huge file fast | Smooth virtualized scroll, **no flicker**, no stuck `⋯` rows 🆕 (the smooth sub-line-scroll fix) | |
| 4.5 | Use the stream-viewer **find bar** (Ctrl+F), jump to a late match | Jumps and highlights correctly, even past the still-indexing region | |
| 4.6 | Switch from the huge file back to a small file | No hang; loads normally | |

---

## 5. File-watch + conflict banner 🆕

Uses `docs/qa/fixtures/watch-target.md`. Keep a second editor (Notepad/VS Code)
or a shell open to make external edits.

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 5.1 | Open `watch-target.md` in vael (do NOT edit it there) | — | |
| 5.2 | From another editor, change the file and save | vael **silently reloads** the new content (clean buffer → no banner) 🆕 | |
| 5.3 | Now type an edit in vael (leave it dirty), then change the file externally again | **Conflict banner** appears: Reload / Save as… / Keep mine 🆕 | |
| 5.4 | Click **Keep mine** | Banner dismisses; your buffer stays | |
| 5.5 | Trigger the banner again, click **Reload** | Buffer replaced with disk content; dirty cleared | |
| 5.6 | Trigger the banner again, click **Save as…**, then cancel the dialog | Original file stays watched; banner stays; nothing breaks 🆕 (the Save-As lifecycle fix) | |
| 5.7 | Delete the file externally | Banner: "This file was deleted on disk" with **Save to restore** | |
| 5.8 | **Self-save false-positive check:** open a file, edit, Save (Ctrl+S) a few times | **No** "changed on disk" banner from your own saves 🆕 (the mtime-identity fix) | |

---

## 6. HTML export 🆕

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 6.1 | Open `sample.md` (full tier), click **Export HTML…** | Save dialog defaults to `sample.html` with an HTML filter | |
| 6.2 | Save it, then open the `.html` in a browser | Looks the **same as the preview** (dark theme, math/code/tables all rendered) 🆕 | |
| 6.3 | In the browser, open **Print / Print-preview** (Ctrl+P) | Flips to a **light** theme (dark bg → white, text → dark); NOT a blank/near-white page 🆕 | |
| 6.4 | Open the exported `.html` with **no network** (airplane mode / offline) | Everything renders except the remote image (expected — documented limit); no broken layout | |
| 6.5 | Try Export while a **large/huge** file is open | The **Export HTML…** button is disabled (full tier only) | |

---

## 7. Command palette + shortcuts 🆕

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 7.1 | Press **Ctrl+Shift+P** | Palette overlay opens, input focused, all commands listed | |
| 7.2 | Type `exp` | Filters to "Export HTML…"; matched letters highlighted | |
| 7.3 | Arrow ↑/↓ | Selection moves, skipping greyed-out (disabled) rows | |
| 7.4 | Enter on a command | Runs it, palette closes | |
| 7.5 | Reopen, press **Esc** | Closes, nothing runs | |
| 7.6 | Open a huge file, open palette | "Export HTML…" and "View: Split Preview" shown **greyed** (disabled) | |
| 7.7 | **Ctrl+O** / **Ctrl+S** / **Ctrl+Shift+S** | Open / Save / Save As fire directly (WebView defaults suppressed) | |

---

## Results summary

Fill after the pass:

| Area | Pass | Fail | Notes |
|------|:----:|:----:|-------|
| 0 Build/launch | | | |
| 1 Open/save/encoding | | | |
| 2 Preview (math/code) | | | |
| 3 Scroll-sync | | | |
| 4 Large-file tiers | | | |
| 5 File-watch | | | |
| 6 HTML export | | | |
| 7 Command palette | | | |

**Any ❌ → file as the next work item.** Highest-signal 🆕 items: 2.2 (MathML
render), 4.4 (smooth huge-file scroll), 5.8 (no self-save false banner), 6.3
(print theme), 7.x (palette).

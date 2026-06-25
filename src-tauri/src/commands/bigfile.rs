//! Streaming read-only access for the >1 GB tier (docs/design/02-large-file.md
//! §2–4). The whole file is memory-mapped (zero-copy, OS-paged) and a sparse
//! line index is built on a background thread; the frontend pulls windows of
//! decoded lines on demand via `read_lines`, so a multi-GB log opens in
//! sub-100 MB RAM. The mapped file is never fully materialized in the WebView.

use std::fs::File;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use memmap2::Mmap;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::encoding::{encoding_for_label, is_streamable_label};
use crate::line_index::SparseLineIndex;

/// Anchor every 1000th line (see SparseLineIndex memory rationale).
const STRIDE: u64 = 1000;
/// Lines per streamed chunk — the first chunk should paint well under a frame.
const BATCH: usize = 500;
/// Emit a progress event at most this often (in lines scanned) to avoid
/// flooding the IPC channel on a fast scan.
const PROGRESS_EVERY: u64 = 200_000;

/// One active streaming document. Single-document for now (opening another big
/// file replaces it). The `Arc`s keep the mapping/index alive for any in-flight
/// `read_lines` even if the session is swapped out underneath.
pub struct StreamSession {
    path: String,
    encoding: String,
    mmap: Arc<Mmap>,
    index: Arc<RwLock<SparseLineIndex>>,
}

/// Shared streaming state. `generation` is bumped every time a session starts
/// or closes; the background scan checks it so a superseded scan self-aborts
/// (frees its mmap, stops wasting CPU) instead of running to completion and
/// emitting stale progress for a file the user already navigated away from.
#[derive(Default)]
pub struct StreamState {
    session: Mutex<Option<StreamSession>>,
    generation: Arc<AtomicU64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamProgress {
    /// The file this progress belongs to — the frontend ignores events whose
    /// path isn't the currently-open one (stale scan of a previous file).
    pub path: String,
    /// Lines counted so far (or the exact total when `done`).
    pub lines: u64,
    pub done: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinesChunk {
    /// Absolute line number of `lines[0]`.
    pub start_line: u64,
    pub lines: Vec<String>,
    /// True when this chunk reaches end-of-file (no more lines after it).
    pub eof: bool,
}

/// Begin streaming `path`: map it, store the session, and kick off a background
/// sparse-index build that reports progress via `stream-progress` events.
/// Returns immediately — content is pulled later through `read_lines`.
#[tauri::command]
pub fn start_stream(
    path: String,
    encoding: String,
    app: AppHandle,
    state: State<'_, StreamState>,
) -> Result<(), String> {
    // Defense in depth: the open path already rejects these, but never decode a
    // multi-byte-newline encoding by splitting on a lone 0x0A.
    if !is_streamable_label(&encoding) {
        return Err(format!("{encoding} is not supported by the streaming viewer."));
    }

    let file = File::open(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    // SAFETY: a read-only shared mapping. If the file is changed/truncated by
    // another process the mapping can fault; a file watcher (later increment)
    // will invalidate the session on external modification. Acceptable for the
    // read-only viewer until then.
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| format!("Could not map {path}: {e}"))?;
    let mmap = Arc::new(mmap);
    let index = Arc::new(RwLock::new(SparseLineIndex::new(STRIDE)));

    // Bump the generation: any scan from a previous session will see the change
    // and bail. This scan owns `my_gen`.
    let generation = Arc::clone(&state.generation);
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;

    *state.session.lock().unwrap() = Some(StreamSession {
        path: path.clone(),
        encoding,
        mmap: Arc::clone(&mmap),
        index: Arc::clone(&index),
    });

    // Background scan: SIMD newline count → sparse anchors + progress events.
    // We touch the shared index only at stride boundaries (every 1000 lines) to
    // keep lock traffic low; the progress event carries the precise count.
    std::thread::spawn(move || {
        let data: &[u8] = &mmap;
        let mut count: u64 = 0;
        // Emit the first event early (after one stride) so the viewer becomes
        // scrollable within milliseconds; then fall back to the coarse cadence.
        let mut next_progress = STRIDE;
        for pos in memchr::memchr_iter(b'\n', data) {
            count += 1; // line `count` begins at pos + 1
            if count % STRIDE == 0 {
                // Stop promptly if a newer session superseded us.
                if generation.load(Ordering::SeqCst) != my_gen {
                    return;
                }
                index.write().unwrap().observe_line_start(count, (pos + 1) as u64);
            }
            if count >= next_progress {
                let _ = app.emit(
                    "stream-progress",
                    StreamProgress { path: path.clone(), lines: count, done: false },
                );
                next_progress = count + PROGRESS_EVERY;
            }
        }
        if generation.load(Ordering::SeqCst) != my_gen {
            return;
        }
        let total = count + 1; // include the final (possibly empty) line
        index.write().unwrap().finish(total);
        let _ = app.emit(
            "stream-progress",
            StreamProgress { path, lines: total, done: true },
        );
    });

    Ok(())
}

/// Close the active streaming session: bump the generation (any running scan
/// self-aborts and drops its mmap) and drop the stored session. Called when the
/// user opens a non-streaming file so a multi-GB mapping isn't kept resident.
#[tauri::command]
pub fn close_stream(state: State<'_, StreamState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.session.lock().unwrap() = None;
}

/// Decode one line's bytes (newline already excluded). Strips a trailing CR so
/// CRLF files render cleanly.
fn decode_line(bytes: &[u8], enc: &'static encoding_rs::Encoding) -> String {
    let bytes = match bytes.last() {
        Some(b'\r') => &bytes[..bytes.len() - 1],
        _ => bytes,
    };
    enc.decode_without_bom_handling(bytes).0.into_owned()
}

/// Decode a window of up to `count` lines starting at `start_line` from `data`.
/// Returns the decoded lines (CR-stripped, with a leading BOM removed from the
/// file's first line) and whether the window reached end-of-file.
///
/// Pure (no Tauri/IPC) so the windowing/decoding can be unit-tested. Note: line
/// splitting is on the `\n` byte, which is correct for UTF-8 and single-byte
/// legacy charsets — i.e. essentially every multi-GB log. UTF-16/UTF-32 (whose
/// newline isn't a lone 0x0A) aren't faithfully streamed yet.
fn decode_window(
    data: &[u8],
    index: &SparseLineIndex,
    enc: &'static encoding_rs::Encoding,
    start_line: u64,
    count: u64,
) -> (Vec<String>, bool) {
    let total = index.total_lines();
    let mut off = index.offset_of_line(data, start_line) as usize;
    let mut out = Vec::new();
    let mut reached_eof = false;
    while (out.len() as u64) < count {
        let cur = start_line + out.len() as u64;
        if off >= data.len() {
            // A file ending in '\n' (or an empty file) has a final empty line at
            // index total-1 with no bytes to decode. Emit it once so the row the
            // scrollbar advertises isn't stuck on the loading glyph forever.
            if cur < total && cur == total - 1 && (data.is_empty() || data.last() == Some(&b'\n')) {
                out.push(String::new());
            }
            reached_eof = true;
            break;
        }
        let rest = &data[off..];
        let mut line = match memchr::memchr(b'\n', rest) {
            Some(p) => {
                let s = decode_line(&rest[..p], enc);
                off += p + 1;
                s
            }
            None => {
                let s = decode_line(rest, enc);
                off = data.len();
                reached_eof = true;
                s
            }
        };
        if cur == 0 {
            line = line.trim_start_matches('\u{FEFF}').to_string();
        }
        out.push(line);
    }
    (out, reached_eof)
}

/// Stream a window of `line_count` lines starting at `start_line` (0-based) to
/// the frontend in `BATCH`-sized chunks over `on_chunk`. The viewer only asks
/// for lines it already knows exist (≤ the latest reported progress), so the
/// sparse index always has an anchor within `STRIDE` of `start_line`.
#[tauri::command]
pub fn read_lines(
    path: String,
    start_line: u64,
    line_count: u64,
    state: State<'_, StreamState>,
    on_chunk: Channel<LinesChunk>,
) -> Result<(), String> {
    // Snapshot the session, then release the state lock for the whole scan.
    let (mmap, enc_label, index) = {
        let guard = state.session.lock().unwrap();
        let s = guard.as_ref().ok_or("no active stream session")?;
        if s.path != path {
            return Err("stream session path mismatch".into());
        }
        (Arc::clone(&s.mmap), s.encoding.clone(), Arc::clone(&s.index))
    };

    // Reject (rather than silently UTF-8-fallback) any encoding we can't split
    // on a lone 0x0A; the open path blocks these, this is defense in depth.
    let enc = match encoding_for_label(&enc_label) {
        Some(e) if is_streamable_label(&enc_label) => e,
        _ => return Err(format!("{enc_label} is not supported by the streaming viewer.")),
    };
    let data: &[u8] = &mmap;

    let (lines, eof) = {
        let idx = index.read().unwrap();
        decode_window(data, &idx, enc, start_line, line_count)
    };

    // Send in BATCH-sized chunks so the first lines paint before a wide window
    // finishes serializing. `eof` rides only on the final chunk.
    let total = lines.len();
    let mut sent = 0usize;
    while sent < total {
        let end = (sent + BATCH).min(total);
        let is_last = end == total;
        on_chunk
            .send(LinesChunk {
                start_line: start_line + sent as u64,
                lines: lines[sent..end].to_vec(),
                eof: is_last && eof,
            })
            .map_err(|e| e.to_string())?;
        sent = end;
    }
    // If EOF landed on an empty window (asked past the end), still tell the
    // frontend the file ended here.
    if total == 0 && eof {
        on_chunk
            .send(LinesChunk {
                start_line,
                lines: vec![],
                eof: true,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::line_index::SparseLineIndex;
    use encoding_rs::{UTF_8, WINDOWS_1252};

    fn index_of(data: &[u8], stride: u64) -> SparseLineIndex {
        let mut idx = SparseLineIndex::new(stride);
        let mut line = 0u64;
        for pos in memchr::memchr_iter(b'\n', data) {
            line += 1;
            idx.observe_line_start(line, (pos + 1) as u64);
        }
        idx.finish(line + 1);
        idx
    }

    #[test]
    fn window_basic_utf8() {
        let data = b"alpha\nbravo\ncharlie\ndelta\n";
        let idx = index_of(data, 2);
        let (lines, eof) = decode_window(data, &idx, UTF_8, 1, 2);
        assert_eq!(lines, vec!["bravo", "charlie"]);
        assert!(!eof);
    }

    #[test]
    fn window_past_eof_sets_flag() {
        let data = b"one\ntwo\nthree"; // last line unterminated → no phantom line
        let idx = index_of(data, 4);
        let (lines, eof) = decode_window(data, &idx, UTF_8, 0, 100);
        assert_eq!(lines, vec!["one", "two", "three"]);
        assert!(eof);
    }

    #[test]
    fn window_emits_trailing_empty_line() {
        let data = b"a\nb\n"; // ends in newline → 3 visual lines: "a","b",""
        let idx = index_of(data, 4);
        assert_eq!(idx.total_lines(), 3);
        let (lines, eof) = decode_window(data, &idx, UTF_8, 0, 100);
        assert_eq!(lines, vec!["a", "b", ""]);
        assert!(eof);
        // Requesting only the trailing line yields one empty string, not nothing
        // (otherwise that row is stuck on the loading glyph forever).
        let (last, _) = decode_window(data, &idx, UTF_8, 2, 1);
        assert_eq!(last, vec![""]);
    }

    #[test]
    fn window_strips_crlf() {
        let data = b"a\r\nb\r\nc\r\n";
        let idx = index_of(data, 4);
        let (lines, _) = decode_window(data, &idx, UTF_8, 0, 3);
        assert_eq!(lines, vec!["a", "b", "c"]);
    }

    #[test]
    fn window_strips_leading_bom_on_first_line_only() {
        let data = b"\xEF\xBB\xBFfirst\nsecond";
        let idx = index_of(data, 4);
        let (lines, _) = decode_window(data, &idx, UTF_8, 0, 2);
        assert_eq!(lines, vec!["first", "second"]); // BOM gone from line 0
    }

    #[test]
    fn window_decodes_legacy_charset() {
        // "café" + newline + "naïve" encoded as Windows-1252.
        let (bytes, _, _) = WINDOWS_1252.encode("café\nnaïve\n");
        let idx = index_of(&bytes, 4);
        let (lines, _) = decode_window(&bytes, &idx, WINDOWS_1252, 0, 2);
        assert_eq!(lines, vec!["café", "naïve"]);
    }

    #[test]
    fn window_seeks_to_middle_with_sparse_index() {
        let mut s = String::new();
        for i in 0..100 {
            s.push_str(&format!("row{i}\n"));
        }
        let data = s.as_bytes();
        let idx = index_of(data, 8); // sparse: anchor every 8th line
        let (lines, _) = decode_window(data, &idx, UTF_8, 37, 3);
        assert_eq!(lines, vec!["row37", "row38", "row39"]);
    }

    /// Full path on a real on-disk file: write 200 k lines, memory-map it, build
    /// the production-stride sparse index, then random-access windows — exactly
    /// what `start_stream` + `read_lines` do, minus the IPC layer.
    #[test]
    fn end_to_end_mmap_random_access() {
        use std::io::Write;

        let n: u64 = 200_000;
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        {
            let mut w = std::io::BufWriter::new(tmp.as_file_mut());
            for i in 0..n {
                writeln!(w, "line-{i:08}").unwrap();
            }
            w.flush().unwrap();
        }

        let file = std::fs::File::open(tmp.path()).unwrap();
        let mmap = unsafe { memmap2::Mmap::map(&file) }.unwrap();
        let data: &[u8] = &mmap;

        let idx = index_of(data, STRIDE); // ~200 anchors at the real stride
        assert_eq!(idx.total_lines(), n + 1); // trailing newline → empty final line

        // Point reads at, around, and far from anchor boundaries.
        for &start in &[0u64, 1, 999, 1000, 1001, 123_456, 199_999] {
            let (lines, _) = decode_window(data, &idx, UTF_8, start, 1);
            assert_eq!(lines, vec![format!("line-{start:08}")], "line {start}");
        }

        // A window straddling a stride boundary returns a contiguous run.
        let (lines, eof) = decode_window(data, &idx, UTF_8, 998, 4);
        assert_eq!(
            lines,
            vec!["line-00000998", "line-00000999", "line-00001000", "line-00001001"]
        );
        assert!(!eof);

        // Reading the tail past the last real line reports EOF.
        let (lines, eof) = decode_window(data, &idx, UTF_8, n - 1, 10);
        assert!(eof);
        assert_eq!(lines.first().map(String::as_str), Some("line-00199999"));
    }
}

//! Sparse line index for the >1 GB stream viewer (docs/design/02-large-file.md §2.2).
//!
//! Storing every line's byte offset would cost ~8 bytes/line (800 MB for a
//! 100 M-line file) and blow the sub-100 MB budget. Instead we keep the offset
//! of every `stride`-th line ("anchor"); seeking to line N is an anchor lookup
//! plus a bounded forward scan of at most `stride` newlines. Memory: a 100 M
//! line / stride-1000 file → 100 K anchors × 8 B ≈ 800 KB.
//!
//! The index is built incrementally by a background scan so the viewer can
//! render the already-scanned head while the tail is still being counted. The
//! invariant the reader relies on: anchors exist for every line ≤ `total_lines`.
//! Kept Tauri-free so it can be unit-tested without a WebView.

/// Line numbers here are 0-based byte-offset anchors. Line 0 starts at offset 0.
pub struct SparseLineIndex {
    /// `anchors[i]` = byte offset at which line `i * stride` begins.
    anchors: Vec<u64>,
    stride: u64,
    /// Renderable line count: during the scan this advances in `stride` steps;
    /// after `finish` it is the exact total (newlines + 1).
    total_lines: u64,
}

impl SparseLineIndex {
    pub fn new(stride: u64) -> Self {
        assert!(stride > 0, "stride must be positive");
        Self {
            anchors: vec![0], // line 0 always begins at offset 0
            stride,
            total_lines: 0,
        }
    }

    pub fn total_lines(&self) -> u64 {
        self.total_lines
    }

    /// Record that a new line begins at `start_offset` (the byte just past a
    /// newline). Called once per newline, in increasing offset order. The line
    /// numbers are implied by call order: the k-th call marks the start of line
    /// k. Only stride-aligned line starts are stored as anchors.
    pub fn observe_line_start(&mut self, line_number: u64, start_offset: u64) {
        if line_number % self.stride == 0 {
            // anchors are appended in order; index == line_number / stride.
            debug_assert_eq!(self.anchors.len() as u64, line_number / self.stride);
            self.anchors.push(start_offset);
        }
        // Publish renderable progress: lines 0..line_number-1 are fully
        // delimited (each ends at a seen newline), so `line_number` of them
        // are renderable right now.
        self.total_lines = line_number;
    }

    /// Set the final visual line count once the scan completes (newlines + 1 —
    /// a trailing newline yields a final empty line).
    pub fn finish(&mut self, total: u64) {
        self.total_lines = total;
    }

    /// Byte offset at which `line` begins: nearest preceding anchor, then a
    /// forward newline scan over `data` for the remainder (≤ `stride` lines).
    /// Clamps into the scanned region if `line` is past what's indexed.
    pub fn offset_of_line(&self, data: &[u8], line: u64) -> u64 {
        let max_idx = self.anchors.len().saturating_sub(1);
        let anchor_idx = ((line / self.stride) as usize).min(max_idx);
        let mut off = self.anchors[anchor_idx] as usize;
        let mut cur = anchor_idx as u64 * self.stride;
        while cur < line && off < data.len() {
            match memchr::memchr(b'\n', &data[off..]) {
                Some(p) => {
                    off += p + 1;
                    cur += 1;
                }
                None => {
                    off = data.len();
                    break;
                }
            }
        }
        off as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a fully-scanned index from `data`, mirroring the background scan.
    fn index_of(data: &[u8], stride: u64) -> SparseLineIndex {
        let mut idx = SparseLineIndex::new(stride);
        let mut line: u64 = 0;
        for pos in memchr::memchr_iter(b'\n', data) {
            line += 1; // line `line` starts right after this newline
            idx.observe_line_start(line, (pos + 1) as u64);
        }
        idx.finish(line + 1); // +1 for the final (possibly empty) line
        idx
    }

    #[test]
    fn offsets_with_stride_one() {
        // "a\nbb\nccc\n" → line starts at 0, 2, 5, 9(EOF, empty final line)
        let data = b"a\nbb\nccc\n";
        let idx = index_of(data, 1);
        assert_eq!(idx.total_lines(), 4); // a, bb, ccc, ""
        assert_eq!(idx.offset_of_line(data, 0), 0);
        assert_eq!(idx.offset_of_line(data, 1), 2);
        assert_eq!(idx.offset_of_line(data, 2), 5);
        assert_eq!(idx.offset_of_line(data, 3), 9);
    }

    #[test]
    fn no_trailing_newline() {
        let data = b"x\ny\nz"; // 3 lines, last unterminated
        let idx = index_of(data, 1);
        assert_eq!(idx.total_lines(), 3);
        assert_eq!(idx.offset_of_line(data, 2), 4);
    }

    #[test]
    fn sparse_anchors_seek_correctly() {
        // 50 numbered lines, stride 8 → anchors at lines 0,8,16,24,32,40,48.
        let mut s = String::new();
        for i in 0..50 {
            s.push_str(&format!("line{i}\n"));
        }
        let data = s.as_bytes();
        let idx = index_of(data, 8);
        assert_eq!(idx.total_lines(), 51); // trailing newline → empty 51st line
        // Spot-check several lines resolve to the right byte offset.
        for line in [0u64, 1, 7, 8, 9, 23, 24, 49] {
            let off = idx.offset_of_line(data, line) as usize;
            let expected = format!("line{line}\n");
            assert!(
                data[off..].starts_with(expected.as_bytes()),
                "line {line}: got offset {off} → {:?}",
                String::from_utf8_lossy(&data[off..off + 8.min(data.len() - off)])
            );
        }
    }

    #[test]
    fn empty_input() {
        let data = b"";
        let idx = index_of(data, 4);
        assert_eq!(idx.total_lines(), 1); // one empty line
        assert_eq!(idx.offset_of_line(data, 0), 0);
    }

    #[test]
    fn clamps_past_end() {
        let data = b"a\nb\n";
        let idx = index_of(data, 2);
        // Asking past the end clamps to EOF rather than panicking.
        assert_eq!(idx.offset_of_line(data, 999), data.len() as u64);
    }
}

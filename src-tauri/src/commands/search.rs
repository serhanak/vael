//! In-file search (docs/design/02-large-file.md §2.5). Backed by the ripgrep
//! engine: `grep-regex` compiles to a finite automaton (Thompson NFA + lazy
//! DFA) with NO backtracking, so even a pathological pattern over a multi-GB
//! file runs in linear time and bounded memory — the structural fix for the
//! catastrophic-backtracking hangs that take down Notepad++/Scintilla.
//!
//! `grep-searcher` reads line-oriented and streams matches, so we never hold the
//! whole file in memory; hits flow to the frontend in batches over a Channel.

use grep_regex::RegexMatcherBuilder;
use grep_matcher::LineTerminator;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use serde::Serialize;
use tauri::ipc::Channel;

/// Default ceiling on returned hits so a pattern matching every line of a
/// 100 M-line file can't flood the UI / exhaust memory. Surfaced as `truncated`.
const MAX_HITS: u64 = 50_000;
/// Hits per streamed batch.
const BATCH: usize = 1000;

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// 0-based line number (matches the stream viewer / read_lines indexing).
    /// The viewer seeks by line, not byte offset — and grep's absolute byte
    /// offset is into the (possibly transcoded) decoded stream, not the file,
    /// so it would be wrong to seek by anyway. Hence: line only.
    pub line: u64,
    /// The matched line, trimmed of its line terminator (for a result preview).
    pub preview: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub total: u64,
    /// True if the hit cap was reached and matches were dropped.
    pub truncated: bool,
}

fn io_err<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

/// Build a line matcher. A non-regex query is escaped to a literal so the user's
/// `.`/`*`/`(` are matched verbatim. `crlf(true)` so `$`/`^` anchor correctly on
/// Windows CRLF files (the `\r` doesn't block an end-anchored match).
fn build_matcher(
    pattern: &str,
    is_regex: bool,
    case_insensitive: bool,
) -> Result<grep_regex::RegexMatcher, String> {
    let pat = if is_regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive)
        .crlf(true)
        .build(&pat)
        .map_err(|e| format!("Invalid search pattern: {e}"))
}

/// A line-numbered searcher whose terminator strips an optional `\r` (so CRLF
/// and LF files both work, and `$` matches before `\r\n`).
fn build_searcher() -> Searcher {
    SearcherBuilder::new()
        .line_number(true)
        .line_terminator(LineTerminator::crlf())
        .build()
}

fn make_hit(m: &SinkMatch<'_>) -> Hit {
    // grep line numbers are 1-based; the viewer is 0-based.
    let line = m.line_number().map(|n| n.saturating_sub(1)).unwrap_or(0);
    let preview = String::from_utf8_lossy(m.bytes())
        .trim_end_matches(|c| c == '\n' || c == '\r')
        .to_string();
    Hit { line, preview }
}

/// Pure, in-memory search over a byte slice. Returns up to `max_hits` matches
/// and whether the result was truncated. Tauri-free so it can be unit-tested;
/// also the intended core for in-memory search of the small/Full tier.
#[allow(dead_code)]
pub fn search_bytes(
    data: &[u8],
    pattern: &str,
    is_regex: bool,
    case_insensitive: bool,
    max_hits: u64,
) -> Result<(Vec<Hit>, bool), String> {
    let matcher = build_matcher(pattern, is_regex, case_insensitive)?;

    struct CollectSink {
        hits: Vec<Hit>,
        max: u64,
        truncated: bool,
    }
    impl Sink for CollectSink {
        type Error = std::io::Error;
        fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, std::io::Error> {
            // Collect exactly `max`; the (max+1)-th match proves there were more,
            // so we stop and flag truncation. A file with exactly `max` hits is
            // never falsely marked truncated (no (max+1)-th call happens).
            if self.hits.len() as u64 >= self.max {
                self.truncated = true;
                return Ok(false);
            }
            self.hits.push(make_hit(m));
            Ok(true)
        }
    }

    let mut sink = CollectSink {
        hits: Vec::new(),
        max: max_hits,
        truncated: false,
    };
    build_searcher()
        .search_slice(&matcher, data, &mut sink)
        .map_err(|e| e.to_string())?;
    Ok((sink.hits, sink.truncated))
}

/// Search a file on disk, streaming hits to the frontend in batches. Uses
/// grep-searcher's line-oriented streaming reader (memory-bounded), so it works
/// on multi-GB files without loading them. The pattern is linear-time.
#[tauri::command]
pub fn search_file(
    path: String,
    pattern: String,
    is_regex: bool,
    case_insensitive: bool,
    on_hit: Channel<Vec<Hit>>,
) -> Result<SearchSummary, String> {
    let matcher = build_matcher(&pattern, is_regex, case_insensitive)?;

    struct ChannelSink {
        batch: Vec<Hit>,
        on_hit: Channel<Vec<Hit>>,
        total: u64,
        max: u64,
        truncated: bool,
    }
    impl ChannelSink {
        fn flush(&mut self) -> Result<(), std::io::Error> {
            if self.batch.is_empty() {
                return Ok(());
            }
            self.on_hit
                .send(std::mem::take(&mut self.batch))
                .map_err(io_err)
        }
    }
    impl Sink for ChannelSink {
        type Error = std::io::Error;
        fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, std::io::Error> {
            // Same overflow detection as CollectSink: stop on the (max+1)-th hit.
            if self.total >= self.max {
                self.truncated = true;
                return Ok(false);
            }
            self.batch.push(make_hit(m));
            self.total += 1;
            if self.batch.len() >= BATCH {
                self.flush()?;
            }
            Ok(true)
        }
    }

    let mut sink = ChannelSink {
        batch: Vec::with_capacity(BATCH),
        on_hit,
        total: 0,
        max: MAX_HITS,
        truncated: false,
    };
    build_searcher()
        .search_path(&matcher, &path, &mut sink)
        .map_err(|e| format!("Search failed: {e}"))?;
    sink.flush().map_err(|e| e.to_string())?;

    Ok(SearchSummary {
        total: sink.total,
        truncated: sink.truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HAYSTACK: &[u8] = b"alpha one\nBeta two\ngamma three\nalpha four\nDELTA five\n";

    #[test]
    fn literal_match_reports_zero_based_lines() {
        let (hits, trunc) = search_bytes(HAYSTACK, "alpha", false, false, 100).unwrap();
        assert!(!trunc);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, 0);
        assert_eq!(hits[0].preview, "alpha one");
        assert_eq!(hits[1].line, 3);
        assert_eq!(hits[1].preview, "alpha four");
    }

    #[test]
    fn literal_query_is_not_a_regex() {
        // The '.' must match a literal dot, not any char.
        let data = b"a.b\naxb\n";
        let (hits, _) = search_bytes(data, "a.b", false, false, 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].preview, "a.b");
    }

    #[test]
    fn regex_mode_matches_pattern() {
        let (hits, _) = search_bytes(HAYSTACK, r"^\w+\s+t", true, false, 100).unwrap();
        // "Beta two" and "gamma three" start with word + space + 't'.
        assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn case_insensitive_matches_mixed_case() {
        let (ci, _) = search_bytes(HAYSTACK, "delta", false, true, 100).unwrap();
        assert_eq!(ci.len(), 1);
        assert_eq!(ci[0].line, 4);
        let (cs, _) = search_bytes(HAYSTACK, "delta", false, false, 100).unwrap();
        assert!(cs.is_empty());
    }

    #[test]
    fn hit_cap_truncates() {
        let (hits, trunc) = search_bytes(HAYSTACK, "a", false, false, 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(trunc);
    }

    #[test]
    fn invalid_regex_is_an_error() {
        assert!(search_bytes(HAYSTACK, "(unclosed", true, false, 100).is_err());
    }

    #[test]
    fn end_anchor_matches_on_crlf_lines() {
        // Windows CRLF: `foo$` must match despite the trailing \r before \n.
        let data = b"foo\r\nbar\r\nfoo\r\n";
        let (hits, _) = search_bytes(data, "foo$", true, false, 100).unwrap();
        assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![0, 2]);
        assert_eq!(hits[0].preview, "foo"); // preview has no trailing \r
    }

    #[test]
    fn pathological_pattern_is_linear_not_catastrophic() {
        // The classic ReDoS trigger. A backtracking engine hangs on this; the
        // ripgrep engine returns promptly (no match), proving linear-time.
        let data = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!\n";
        let (hits, _) = search_bytes(data, r"(a+)+$", true, false, 100).unwrap();
        assert!(hits.is_empty()); // '!' before EOL → no match, and crucially: fast
    }
}

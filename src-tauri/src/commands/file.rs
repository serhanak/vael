//! File I/O commands (M1). Encoding/BOM/EOL-aware open & atomic save.
//! The frontend never reads/writes files itself — it picks a path via the
//! dialog plugin and calls these commands, so all byte-level policy lives here.

use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::encoding::{analyze, encode_for_save, is_streamable_label, Eol, SaveError};

/// Size-based handling tier (PLAN.md §6.b, docs/design/02-large-file.md §1).
/// The thresholds are deliberate: `Full` keeps every CM6 feature; `Degraded`
/// still edits in CM6 but disables the heavy extensions (highlight, wrap,
/// bracket-match) that dominate cost on big buffers; `StreamViewer` never loads
/// the whole file into the WebView at all (read-only, windowed).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Full,
    Degraded,
    StreamViewer,
}

const MIB: u64 = 1024 * 1024;
/// ≤ 50 MiB → full features. Highlight styling roughly triples buffer cost in
/// the WebView, so this is the last size where eager highlight stays cheap.
const FULL_MAX: u64 = 50 * MIB;
/// ≤ 1 GiB → degraded but still editable. Above this a UTF-8→UTF-16 blow-up in
/// the WebView would approach the V8/JSC string ceiling, so we never full-load.
const DEGRADED_MAX: u64 = 1024 * MIB;

fn tier_for(len: u64) -> Tier {
    if len <= FULL_MAX {
        Tier::Full
    } else if len <= DEGRADED_MAX {
        Tier::Degraded
    } else {
        Tier::StreamViewer
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub path: String,
    /// Full decoded text for `Full`/`Degraded`; empty for `StreamViewer`
    /// (which pulls windows of lines on demand via `read_lines`).
    pub content: String,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: String,
    pub confidence: String,
    pub can_save: bool,
    pub tier: Tier,
    pub byte_len: u64,
    /// Known for eagerly-loaded tiers; `None` for `StreamViewer` until the
    /// background sparse-index build reports it.
    pub line_count: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: String,
    /// On-disk last-modified time (ms since epoch, 0 if unavailable). The
    /// frontend records this after a save so the watcher echo of our own write
    /// — which carries this same mtime — can be told apart from a genuine
    /// external change (which bumps mtime). See `watch.rs`.
    pub mtime_ms: u64,
}

/// Last-modified time of `path` as milliseconds since the Unix epoch, or 0 if it
/// can't be read. Used to distinguish our own save from an external write.
pub(crate) fn mtime_millis(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read up to `max` bytes from the start of a file (encoding sniffing only
/// needs the head). `Take` bounds the read so a multi-GB file costs one 64 KB
/// page, not a full load.
fn read_head(path: &str, max: u64) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    std::fs::File::open(path)?
        .take(max)
        .read_to_end(&mut buf)?;
    Ok(buf)
}

fn count_lines(text: &str) -> u64 {
    // Total visual lines = newline count + 1 (a trailing newline yields a final
    // empty line, matching what the editor shows).
    text.bytes().filter(|&b| b == b'\n').count() as u64 + 1
}

fn open_inner(path: String, forced: Option<&str>) -> Result<OpenResult, String> {
    let len = std::fs::metadata(&path)
        .map_err(|e| format!("Could not stat {path}: {e}"))?
        .len();
    let tier = tier_for(len);

    if tier == Tier::StreamViewer {
        // Never materialize a >1 GiB file: sniff encoding/EOL from the head and
        // hand the frontend a windowed read-only viewer instead.
        let head = read_head(&path, 64 * 1024).map_err(|e| format!("Could not read {path}: {e}"))?;
        let a = analyze(&head, forced);
        if !is_streamable_label(&a.encoding) {
            return Err(format!(
                "{} files over 1 GB aren't supported by the streaming viewer yet \
                 (its newline isn't a single byte). Reopen with a UTF-8 or single-byte encoding.",
                a.encoding
            ));
        }
        return Ok(OpenResult {
            path,
            content: String::new(),
            encoding: a.encoding,
            has_bom: a.has_bom,
            eol: a.eol,
            confidence: a.confidence,
            can_save: false, // the stream viewer is read-only
            tier,
            byte_len: len,
            line_count: None, // filled in by the background index build
        });
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let a = analyze(&bytes, forced);
    let line_count = Some(count_lines(&a.content));
    Ok(OpenResult {
        path,
        content: a.content,
        encoding: a.encoding,
        has_bom: a.has_bom,
        eol: a.eol,
        confidence: a.confidence,
        can_save: a.can_save,
        tier,
        byte_len: len,
        line_count,
    })
}

/// Open a file, detecting its encoding/BOM/EOL.
#[tauri::command]
pub fn open_file(path: String) -> Result<OpenResult, String> {
    open_inner(path, None)
}

/// Re-decode the SAME bytes on disk with a user-chosen encoding (fixing a wrong
/// guess). Does not write; the document is not marked dirty by this.
#[tauri::command]
pub fn reopen_with_encoding(path: String, encoding: String) -> Result<OpenResult, String> {
    open_inner(path, Some(&encoding))
}

/// Result of a save attempt. Either the file was written, or it would lose data
/// in the target legacy encoding (`Lossy`) and the frontend must confirm via the
/// lossy dialog before retrying with `allow_lossy = true`. Serialized tagged:
/// `{ "kind": "saved", "meta": {…} }` or `{ "kind": "lossy" }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SaveOutcome {
    Saved { meta: FileMeta },
    Lossy,
}

/// Encode `text` per (encoding + add_bom + eol) and write it atomically. A
/// legacy target that can't represent some character returns `Lossy` (not an
/// error) unless `allow_lossy` — the user chose "save anyway".
#[tauri::command]
pub fn save_file(
    path: String,
    text: String,
    encoding: String,
    add_bom: bool,
    eol: String,
    allow_lossy: bool,
) -> Result<SaveOutcome, String> {
    let bytes = match encode_for_save(&text, &encoding, add_bom, Eol::from_label(&eol), allow_lossy) {
        Ok(b) => b,
        // Not a hard error: the caller shows the lossy dialog and may retry with
        // allow_lossy=true, or convert to UTF-8.
        Err(SaveError::Lossy(_)) => return Ok(SaveOutcome::Lossy),
        Err(e) => return Err(e.to_string()),
    };
    atomic_write(&path, &bytes).map_err(|e| format!("Could not save {path}: {e}"))?;
    // Stat AFTER the write so the frontend can suppress the watcher echo of this
    // exact save by mtime identity (a later external write bumps mtime and is
    // therefore not suppressed).
    let mtime_ms = mtime_millis(Path::new(&path));
    Ok(SaveOutcome::Saved {
        meta: FileMeta {
            path,
            encoding,
            has_bom: add_bom,
            eol,
            mtime_ms,
        },
    })
}

/// Write UTF-8 `text` to `path` atomically. Unlike `save_file`, this applies no
/// encoding/BOM/EOL policy — the caller already produced the exact bytes (an
/// exported standalone HTML document). Used by HTML export (PLAN.md #8, §3.4
/// `write_text_file`).
#[tauri::command]
pub fn write_text_file(path: String, text: String) -> Result<String, String> {
    atomic_write(&path, text.as_bytes()).map_err(|e| format!("Could not write {path}: {e}"))?;
    Ok(path)
}

/// Write via same-directory temp file + fsync + atomic rename, so a crash
/// leaves either the old or the new complete file — never a half-written one.
fn atomic_write(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let target = std::path::Path::new(path);
    // Follow symlinks to the real target (don't replace the link with a file).
    // For a not-yet-existing file (Save As / new), keep the requested path.
    let real = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let dir = real
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no parent directory"))?;

    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?; // fsync data before rename

    // Preserve original Unix permissions when overwriting an existing file.
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(&real) {
        use std::os::unix::fs::PermissionsExt;
        let _ = tmp
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(meta.permissions().mode()));
    }

    // Atomically replace the target: rename(2) on POSIX, MoveFileExW(REPLACE_EXISTING)
    // on Windows (what tempfile's persist uses).
    // TODO(windows): MoveFileExW does NOT preserve the destination's per-file ACLs
    // or alternate data streams (ReplaceFileW would). Acceptable for now; revisit
    // before shipping if keeping tightened ACLs on overwrite matters.
    tmp.persist(&real).map_err(|e| e.error)?;

    // fsync the directory so the rename itself is durable (POSIX).
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_boundaries() {
        assert_eq!(tier_for(0), Tier::Full);
        assert_eq!(tier_for(FULL_MAX), Tier::Full);
        assert_eq!(tier_for(FULL_MAX + 1), Tier::Degraded);
        assert_eq!(tier_for(DEGRADED_MAX), Tier::Degraded);
        assert_eq!(tier_for(DEGRADED_MAX + 1), Tier::StreamViewer);
        assert_eq!(tier_for(8 * 1024 * MIB), Tier::StreamViewer);
    }

    #[test]
    fn line_counting() {
        assert_eq!(count_lines(""), 1);
        assert_eq!(count_lines("a"), 1);
        assert_eq!(count_lines("a\nb"), 2);
        assert_eq!(count_lines("a\nb\n"), 3); // trailing newline → final empty line
    }

    #[test]
    fn mtime_millis_reads_existing_and_zero_for_missing() {
        // A real file reports a nonzero mtime; the frontend compares this exact
        // value to a watcher event's mtime to recognize its own save's echo.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        assert!(mtime_millis(tmp.path()) > 0);
        // An unreadable/absent path degrades to 0 (never matches a real save mtime).
        assert_eq!(mtime_millis(Path::new("/vael/no/such/file-xyzzy")), 0);
    }
}

//! File I/O commands (M1). Encoding/BOM/EOL-aware open & atomic save.
//! The frontend never reads/writes files itself — it picks a path via the
//! dialog plugin and calls these commands, so all byte-level policy lives here.

use serde::Serialize;

use crate::encoding::{analyze, encode_for_save, Eol};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: String,
    pub confidence: String,
    pub can_save: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: String,
}

fn open_inner(path: String, forced: Option<&str>) -> Result<OpenResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let a = analyze(&bytes, forced);
    Ok(OpenResult {
        path,
        content: a.content,
        encoding: a.encoding,
        has_bom: a.has_bom,
        eol: a.eol,
        confidence: a.confidence,
        can_save: a.can_save,
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

/// Encode `text` per (encoding + add_bom + eol) and write it atomically.
#[tauri::command]
pub fn save_file(
    path: String,
    text: String,
    encoding: String,
    add_bom: bool,
    eol: String,
) -> Result<FileMeta, String> {
    let bytes = encode_for_save(&text, &encoding, add_bom, Eol::from_label(&eol)).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes).map_err(|e| format!("Could not save {path}: {e}"))?;
    Ok(FileMeta {
        path,
        encoding,
        has_bom: add_bom,
        eol,
    })
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

//! External file-change watching for the open document (PLAN.md #9).
//!
//! Uses the notify + debouncer-full stack: cross-platform, and the debouncer
//! coalesces the burst of raw FS events a single save produces into one settled
//! batch. We watch the file's PARENT directory (NonRecursive), not the file node
//! itself, so an atomic temp-file + rename replace — how vael and many editors
//! save — is still seen as a change to the target rather than losing the watch
//! when the original inode is replaced.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::file::mtime_millis;

/// Debounce window: coalesce the multiple FS events one save emits.
const DEBOUNCE_MS: u64 = 400;

/// One active file watch (single open document). Dropping the debouncer stops
/// its background thread and releases the OS watch.
#[derive(Default)]
pub struct WatchState {
    inner: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// "modified" (still on disk) or "removed" (deleted).
    pub kind: String,
    /// On-disk mtime (ms since epoch, 0 if removed/unreadable). The frontend
    /// suppresses this event when it equals the mtime it recorded from its own
    /// last save — that is our own atomic-write echo, not an external change.
    pub mtime_ms: u64,
}

/// True if any event path is the target file. We watch only the file's own
/// directory, so the file name uniquely identifies it there — and, crucially,
/// the temp file an atomic save writes has a different name, so it's ignored.
/// Pure → unit-testable.
fn event_matches_target(paths: &[PathBuf], target_name: &OsStr) -> bool {
    paths.iter().any(|p| p.file_name() == Some(target_name))
}

/// Start watching `path` for external changes, replacing any previous watch.
/// Emits a debounced `file-changed` event when the file is modified or removed.
#[tauri::command]
pub fn watch_file(path: String, app: AppHandle, state: State<'_, WatchState>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .map(Path::to_path_buf)
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| "file has no parent directory to watch".to_string())?;
    // Match against the file's REAL on-disk name (from canonicalize), not the
    // caller-supplied casing: a Save-As that types a different-case name over an
    // existing file on a case-insensitive FS (Windows/macOS) would otherwise set
    // a target_name that never matches the on-disk-cased event paths, silently
    // killing the watch. Fall back to the raw name if the file doesn't exist yet.
    // (Only the match NAME is canonicalized; the watched `dir` stays the raw path
    // so notify never has to watch an extended-length `\\?\` directory.)
    let target_name: OsString = std::fs::canonicalize(&target)
        .ok()
        .and_then(|c| c.file_name().map(OsStr::to_os_string))
        .or_else(|| target.file_name().map(OsStr::to_os_string))
        .ok_or_else(|| "file has no name".to_string())?;

    let emit_path = path.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(_) => return, // watcher hiccup; a later event will resync
            };
            let touched = events
                .iter()
                .any(|ev| event_matches_target(&ev.paths, &target_name));
            if !touched {
                return;
            }
            // Stat now (post-debounce) rather than trust raw event kinds: an
            // atomic rename-replace looks like remove+create, but if the file is
            // present it was modified; only a true deletion leaves it absent.
            let present = target.exists();
            let kind = if present { "modified" } else { "removed" };
            // mtime lets the frontend tell our own save's echo from a real edit.
            let mtime_ms = if present { mtime_millis(&target) } else { 0 };
            let _ = app.emit(
                "file-changed",
                FileChange { path: emit_path.clone(), kind: kind.into(), mtime_ms },
            );
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    // Replace (and thereby drop/stop) any previous watch.
    *state.inner.lock().unwrap() = Some(debouncer);
    Ok(())
}

/// Stop watching (e.g. opening the read-only stream tier, or app teardown).
#[tauri::command]
pub fn unwatch_file(state: State<'_, WatchState>) {
    *state.inner.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_target_file_in_its_dir() {
        let paths = vec![
            PathBuf::from("/proj/other.txt"),
            PathBuf::from("/proj/notes.md"),
        ];
        assert!(event_matches_target(&paths, OsStr::new("notes.md")));
        assert!(!event_matches_target(&paths, OsStr::new("missing.md")));
        // The temp file an atomic save writes must NOT be mistaken for the target
        // (else every save would self-trigger a false "changed on disk").
        let tmp = vec![PathBuf::from("/proj/.tmp-abcd1234")];
        assert!(!event_matches_target(&tmp, OsStr::new("notes.md")));
    }
}

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
    let target_name: OsString = target
        .file_name()
        .ok_or_else(|| "file has no name".to_string())?
        .to_os_string();

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
            let kind = if target.exists() { "modified" } else { "removed" };
            let _ = app.emit(
                "file-changed",
                FileChange { path: emit_path.clone(), kind: kind.into() },
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

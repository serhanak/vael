use serde::Serialize;

/// Basic build info, exposed over IPC. Primarily a smoke-test that the
/// Rust <-> frontend boundary works; real commands (encoding-aware open,
/// big-file streaming, search) land in M1+.
#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "vael".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

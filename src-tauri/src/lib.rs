mod commands;
mod encoding;
mod line_index;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::bigfile::StreamState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::file::open_file,
            commands::file::reopen_with_encoding,
            commands::file::save_file,
            commands::bigfile::start_stream,
            commands::bigfile::read_lines,
            commands::bigfile::close_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running vael");
}

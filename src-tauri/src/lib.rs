mod commands;
mod encoding;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::file::open_file,
            commands::file::reopen_with_encoding,
            commands::file::save_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running vael");
}

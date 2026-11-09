// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod watch;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(watch::Watch::default());
            watch::start(app.handle());
            Ok(())
        })
        .on_window_event(watch::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::list_history,
            commands::get_project,
            commands::jobs,
            commands::stats,
            commands::cache_size,
            commands::thumbnail,
            commands::open_path,
            commands::run_render,
            commands::providers,
            commands::list_voices,
            commands::set_secret,
            commands::remove_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the ScreenPilot dashboard");
}

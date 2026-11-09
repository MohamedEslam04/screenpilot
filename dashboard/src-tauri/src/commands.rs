//! The Tauri commands of `../../API.md`. Each one only calls `screenpilot-dashboard-core`; the work
//! (file reads, directory walks, ffmpeg, spawns) runs on the blocking pool, never on the main thread.

use screenpilot_dashboard_core as sp;
use serde_json::{json, Value};
use std::path::Path;

/// Run blocking `work` off the async runtime's threads and flatten the join error into a string.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn paths() -> sp::Paths {
    sp::Paths::from_env()
}

fn cli() -> sp::cli::Cli {
    sp::cli::Cli::from_env(&paths())
}

#[tauri::command]
pub async fn list_history(
    before: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Value>, String> {
    blocking(move || {
        Ok(sp::history::list_history(
            &paths().history_file(),
            before.as_deref(),
            limit.unwrap_or(50),
        ))
    })
    .await
}

#[tauri::command]
pub async fn get_project(path: String) -> Result<sp::project::Project, String> {
    blocking(move || sp::project::get_project(Path::new(&path))).await
}

#[tauri::command]
pub async fn jobs() -> Result<Vec<sp::jobs::JobInfo>, String> {
    blocking(|| Ok(sp::jobs::jobs(&paths().jobs_dir()))).await
}

#[tauri::command]
pub async fn stats() -> Result<sp::stats::Stats, String> {
    blocking(|| {
        let p = paths();
        Ok(sp::stats::stats(&p.history_file(), &p.speed_file()))
    })
    .await
}

#[tauri::command]
pub async fn cache_size() -> Result<u64, String> {
    blocking(|| Ok(sp::cache::cache_size(&paths().extract_cache))).await
}

#[tauri::command]
pub async fn thumbnail(video: String) -> Result<Option<String>, String> {
    blocking(move || {
        Ok(
            sp::thumbnail::thumbnail(Path::new(&video), &paths().cache, "ffmpeg")
                .map(|p| p.to_string_lossy().into_owned()),
        )
    })
    .await
}

#[tauri::command]
pub async fn open_path(path: String, reveal: Option<bool>) -> Result<(), String> {
    blocking(move || sp::open::open_path(Path::new(&path), reveal.unwrap_or(false))).await
}

#[tauri::command]
pub async fn run_render(storyboard: String, quality: String) -> Result<Value, String> {
    blocking(move || {
        sp::cli::run_render(&cli(), &storyboard, &quality)?;
        Ok(json!({ "started": true }))
    })
    .await
}

#[tauri::command]
pub async fn providers() -> Result<Vec<sp::providers::ProviderInfo>, String> {
    blocking(|| Ok(sp::cli::providers(&cli()))).await
}

#[tauri::command]
pub async fn list_voices(provider: String) -> Result<Vec<sp::cli::Voice>, String> {
    blocking(move || sp::cli::list_voices(&cli(), &provider)).await
}

/// The key goes to the CLI's stdin and nowhere else: not logged, not returned, not in an error.
#[tauri::command]
pub async fn set_secret(provider: String, key: String) -> Result<(), String> {
    blocking(move || sp::cli::set_secret(&cli(), &provider, &key)).await
}

#[tauri::command]
pub async fn remove_secret(provider: String) -> Result<bool, String> {
    blocking(move || sp::cli::remove_secret(&cli(), &provider)).await
}

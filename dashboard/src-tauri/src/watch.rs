//! Tells the UI when the set of running renders changes, without polling: a file watcher on
//! `<cache>/jobs/` that only exists while the window is visible. Events are debounced (a job
//! rewrites its file on every step) and answered with the whole current job list.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use screenpilot_dashboard_core as sp;
use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

const DEBOUNCE: Duration = Duration::from_millis(250);

/// Managed state: the running watcher, if any. Dropping it stops it (and its thread).
#[derive(Default)]
pub struct Watch(Mutex<Option<RecommendedWatcher>>);

/// Start watching (no-op when already watching) and send the current job list once.
pub fn start(app: &AppHandle) {
    let state = app.state::<Watch>();
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return;
    }
    let dir = sp::Paths::from_env().jobs_dir();
    // The CLI creates the folder with its first job; the watcher needs it to exist.
    let _ = std::fs::create_dir_all(&dir);

    let (tx, rx) = mpsc::channel::<()>();
    let Ok(mut watcher) =
        notify::recommended_watcher(move |_event: notify::Result<notify::Event>| {
            let _ = tx.send(());
        })
    else {
        return;
    };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }

    let handle = app.clone();
    // The thread ends when the watcher is dropped: that drops the only sender and `recv` fails.
    std::thread::spawn(move || {
        emit(&handle, &dir);
        while rx.recv().is_ok() {
            let deadline = Instant::now() + DEBOUNCE;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(()) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            emit(&handle, &dir);
        }
    });
    *slot = Some(watcher);
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<Watch>();
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    *slot = None;
}

fn emit(app: &AppHandle, dir: &Path) {
    let _ = app.emit("jobs-changed", sp::jobs::jobs(dir));
}

/// Watch while the window is shown (not minimized or hidden), also when it is only unfocused:
/// someone may follow a render from a second monitor. Coming back always sends a fresh list.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
        return;
    }
    let shown = window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
    if shown {
        start(window.app_handle());
    } else {
        stop(window.app_handle());
    }
}

// A release build on Windows is a window program: no console window next to it.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use screenpilot_dashboard::app;
use screenpilot_dashboard_core::{cli::Cli, Paths};
use std::time::Duration;

fn main() {
    // Hidden flag for RAM measurements: close the window after N seconds.
    let mut args = std::env::args().skip(1);
    let mut exit_after = None;
    while let Some(a) = args.next() {
        if a == "--exit-after" {
            exit_after = args
                .next()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|s| s.is_finite() && *s > 0.0)
                .map(Duration::from_secs_f64);
        }
    }
    let paths = Paths::from_env();
    let cli = Cli::from_env(&paths);
    if let Err(e) = app::run(paths, cli, exit_after) {
        eprintln!("screenpilot-dashboard: {e}");
        std::process::exit(1);
    }
}

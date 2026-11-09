//! Write a fixture config + cache for a real window run:
//! `cargo run --example seed -- <dir> [events]`, then start the dashboard with
//! `XDG_CONFIG_HOME=<dir>/config XDG_CACHE_HOME=<dir>/cache SCREENPILOT_BIN=<dir>/bin/screenpilot`.
use screenpilot_dashboard::fixture;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("usage: seed <dir> [events]"));
    let n: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let f = fixture::write(&dir, n, now, r#"{"elevenlabs":"env","gemini":null}"#)
        .expect("write fixture");
    println!("{} events in {}", n, f.paths.history_file().display());
}

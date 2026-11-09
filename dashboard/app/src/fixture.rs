//! Deterministic fake data for the headless screenshots and the RAM measurement: a history of any
//! length (Arabic titles, failures, every kind), a few real session folders, running jobs, render
//! speeds and a stand-in `screenpilot` program that answers `secret status`. Nothing here is used
//! by the shipping window.

use crate::model::iso_from_secs;
use screenpilot_dashboard_core::{cli::Cli, Paths};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub struct Fixture {
    pub root: PathBuf,
    pub paths: Paths,
    /// A stand-in CLI: `secret status` prints `<root>/bin/status.json`.
    pub cli: Cli,
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const TITLES: [&str; 13] = [
    "demo-signup",
    "onboarding-flow",
    "billing-export",
    "release-notes",
    "checkout-tour",
    "api-keys",
    "dark-mode",
    "team-invite",
    "عرض المنتج",
    "شرح لوحة التحكم",
    "تسجيل الدخول",
    "جولة في التطبيق",
    "تصدير التقارير",
];

const ERRORS: [&str; 4] = [
    "ffmpeg exited with code 1",
    "voice provider edge timed out after 30 s",
    "فشل التصيير: لم يتم العثور على ملف المصدر",
    "source video not found: rec.mp4",
];

fn sessions(root: &Path) -> PathBuf {
    root.join("sessions")
}

/// `n` history lines, oldest first (the order the CLI appends them). The newest ones are the
/// hand-made ones that `write` backs with real folders.
pub fn history_lines(n: usize, now: i64, root: &Path) -> Vec<String> {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut t = now - 40;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let title = if i == 0 {
            "عرض المنتج"
        } else if i == 1 {
            "demo-signup"
        } else {
            TITLES[rng.below(TITLES.len() as u64) as usize]
        };
        let dir = sessions(root).join(format!("{title}-{i}"));
        let kind = match i {
            0 | 1 => "render",
            2 => "take",
            3 => "sequence",
            4 => "record",
            _ => [
                "render", "render", "render", "take", "take", "record", "sequence",
            ][rng.below(7) as usize],
        };
        let failed = i == 0 || (i > 4 && rng.below(8) == 0);
        let dur = 12 + rng.below(160);
        let mut ev = json!({
            "v": 1, "at": iso_from_secs(t), "kind": kind,
            "status": if failed { "failed" } else { "ok" },
        });
        let o = ev.as_object_mut().unwrap();
        let path_of = |name: &str| dir.join(name).to_string_lossy().into_owned();
        match kind {
            "render" => {
                o.insert("path".into(), path_of("storyboard.json").into());
                o.insert(
                    "quality".into(),
                    ["draft", "draft", "looks", "delivery"][rng.below(4) as usize].into(),
                );
                if !failed {
                    o.insert("output".into(), path_of("demo.mp4").into());
                    o.insert("durationSec".into(), dur.into());
                    o.insert("wallSeconds".into(), (dur * 2 + rng.below(40)).into());
                }
            }
            "sequence" => {
                o.insert("path".into(), path_of("sequence.json").into());
                o.insert("quality".into(), "draft".into());
                if !failed {
                    o.insert("durationSec".into(), (dur * 2).into());
                    o.insert("wallSeconds".into(), (dur * 4).into());
                }
            }
            _ => {
                o.insert("path".into(), dir.to_string_lossy().into_owned().into());
                if kind == "take" {
                    o.insert("storyboard".into(), path_of("storyboard.json").into());
                }
                if !failed {
                    o.insert("output".into(), path_of("rec.mp4").into());
                    o.insert("durationSec".into(), dur.into());
                }
                if i > 4 && rng.below(10) == 0 {
                    o.insert("imported".into(), true.into());
                }
            }
        }
        if failed {
            let e = if i == 0 {
                ERRORS[2]
            } else {
                ERRORS[rng.below(4) as usize]
            };
            o.insert("error".into(), e.into());
        }
        out.push(ev.to_string());
        t -= 30 + rng.below(4000) as i64;
    }
    // Written oldest first: reverse so the newest (i = 0) comes last.
    out.reverse();
    out
}

fn storyboard() -> Value {
    json!({
        "version": 1, "source": "rec.mp4",
        "output": {"width": 1920, "height": 1080, "fps": 30},
        "voice": {"provider": "local", "name": "voicetut:Sarah"},
        "narration": [
            {"at": 0.8, "text": "مرحبا بكم في عرض المنتج الجديد."},
            {"at": 6.5, "text": "First, open the dashboard and pick a recording."},
            {"at": 14.0, "text": "ثم اضغط على زر التصيير لبدء العمل."},
            {"at": 21.3, "text": "Your video is ready in a minute."},
        ],
        "captions": [{"at": 1, "text": "Open"}, {"at": 7, "text": "Pick"}],
        "zooms": [{"at": 2, "dur": 3, "x": 0.5, "y": 0.5, "scale": 1.8}],
        "highlights": [{"at": 5, "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}],
        "segments": [{"from": 0, "to": 30}]
    })
}

fn sequence_json() -> Value {
    json!({"version": 1, "parts": [
        {"storyboard": "demo.json", "to": 42},
        {"storyboard": "feature.json", "transition": {"type": "crossfade", "dur": 0.5}},
        {"storyboard": "demo.json", "from": 42}
    ]})
}

/// Write a complete config and cache under `root` for `n` events. `key_status` is the JSON the
/// stand-in CLI prints for `secret status`, e.g. `{"elevenlabs":"env","gemini":null}`.
pub fn write(root: &Path, n: usize, now: i64, key_status: &str) -> std::io::Result<Fixture> {
    let paths = Paths {
        config: root.join("config").join("screenpilot"),
        cache: root.join("cache").join("screenpilot"),
        app_home: root.join("app"),
        extract_cache: root.join("cache").join("screenpilot").join("extract"),
    };
    fs::create_dir_all(&paths.config)?;
    fs::create_dir_all(paths.jobs_dir())?;
    fs::create_dir_all(&paths.extract_cache)?;

    let lines = history_lines(n, now, root);
    let mut text = lines.join("\n");
    text.push('\n');
    fs::write(paths.history_file(), text)?;

    // Real folders for the newest events, so the detail panel has something to read.
    for line in lines.iter().rev().take(5) {
        let line: Value = serde_json::from_str(line).expect("fixture line");
        let path = PathBuf::from(line["path"].as_str().unwrap_or(""));
        let dir = if path.extension().is_some() {
            path.parent().map(Path::to_path_buf).unwrap_or(path)
        } else {
            path
        };
        fs::create_dir_all(&dir)?;
        if line["kind"] == "sequence" {
            fs::write(dir.join("sequence.json"), sequence_json().to_string())?;
        } else {
            fs::write(dir.join("storyboard.json"), storyboard().to_string())?;
        }
        fs::write(dir.join("meta.json"), r#"{"app":"Files","screens":1}"#)?;
        fs::write(dir.join("events.jsonl"), "{}\n")?;
    }

    fs::write(
        paths.speed_file(),
        json!({"entries": [
            {"quality": "draft", "workers": 4, "outSeconds": 30, "wallSeconds": 9},
            {"quality": "draft", "workers": 4, "outSeconds": 60, "wallSeconds": 21},
            {"quality": "looks", "workers": 4, "outSeconds": 45, "wallSeconds": 70},
            {"quality": "delivery", "workers": 4, "outSeconds": 40, "wallSeconds": 130}
        ]})
        .to_string(),
    )?;
    // A cache of a few MB (sparse: no real disk use).
    let big = fs::File::create(paths.extract_cache.join("frames.bin"))?;
    big.set_len(37 * 1024 * 1024)?;

    let bin = root.join("bin");
    fs::create_dir_all(&bin)?;
    fs::write(bin.join("status.json"), key_status)?;
    let script = bin.join("screenpilot");
    fs::write(
        &script,
        "#!/bin/sh\ncase \"$1 $2\" in\n  \"secret status\") cat \"$(dirname \"$0\")/status.json\";;\n  \"secret set\") cat >/dev/null;;\n  \"secret remove\") echo '{\"removed\":true}';;\n  *) echo '[]';;\nesac\n",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))?;
    }
    Ok(Fixture {
        root: root.to_path_buf(),
        cli: Cli {
            program: script.into_os_string(),
            prefix: Vec::new(),
        },
        paths,
    })
}

/// Two job files owned by this process, so they count as running: one mid-render, one just
/// started.
pub fn write_jobs(paths: &Paths, now: i64) -> std::io::Result<()> {
    let dir = paths.jobs_dir();
    fs::create_dir_all(&dir)?;
    let pid = std::process::id();
    let a = json!({
        "id": "job-a", "pid": pid, "kind": "render", "quality": "delivery",
        "path": "/home/me/sessions/عرض المنتج/storyboard.json",
        "startedAt": iso_from_secs(now - 134), "updatedAt": iso_from_secs(now - 2),
        "step": {"label": "Rendering chunk", "index": 3, "total": 12}
    });
    let b = json!({
        "id": "job-b", "pid": pid, "kind": "sequence", "quality": "draft",
        "path": "/home/me/sessions/product-tour/sequence.json",
        "startedAt": iso_from_secs(now - 9), "updatedAt": iso_from_secs(now - 9)
    });
    fs::write(dir.join("job-a.json"), a.to_string())?;
    fs::write(dir.join("job-b.json"), b.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_deterministic_valid_and_ordered() {
        let root = Path::new("/r");
        let a = history_lines(300, 1_800_000_000, root);
        assert_eq!(a, history_lines(300, 1_800_000_000, root));
        assert_eq!(a.len(), 300);
        let ats: Vec<String> = a
            .iter()
            .map(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                for k in ["at", "path", "kind"] {
                    assert!(v[k].is_string(), "{l}");
                }
                v["at"].as_str().unwrap().to_string()
            })
            .collect();
        assert!(ats.windows(2).all(|w| w[0] < w[1]), "oldest first");
        let last: Value = serde_json::from_str(a.last().unwrap()).unwrap();
        assert_eq!(last["status"], "failed");
        assert!(a.iter().any(|l| l.contains("عرض")));
    }
}

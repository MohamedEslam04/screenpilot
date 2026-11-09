//! Running renders. The CLI writes one small file per job to `<cache>/jobs/<id>.json` and removes
//! it when the job ends (`src/history/jobs.ts`). A crash leaves the file behind, so a job whose
//! process is gone is dropped, and on Linux its file is deleted.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Without a way to ask the OS (not Linux), a job counts as running while it was updated this recently.
const FRESH_SECS: i64 = 5 * 60;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Step {
    pub label: String,
    pub index: u64,
    pub total: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct JobInfo {
    pub id: String,
    pub pid: u32,
    pub kind: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<Step>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Alive,
    /// The process is gone: ignore the job and delete its file.
    Dead,
    /// Probably not running, but we cannot be sure: ignore it, keep the file.
    Stale,
}

/// The jobs running now, oldest first.
pub fn jobs(dir: &Path) -> Vec<JobInfo> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    list_jobs(dir, &|job| verdict(job, now))
}

pub fn list_jobs(dir: &Path, verdict: &dyn Fn(&JobInfo) -> Verdict) -> Vec<JobInfo> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        // Being written, or not ours: skip.
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(job) = serde_json::from_str::<JobInfo>(&text) else {
            continue;
        };
        match verdict(&job) {
            Verdict::Alive => out.push(job),
            Verdict::Dead => {
                let _ = fs::remove_file(&path);
            }
            Verdict::Stale => {}
        }
    }
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    out
}

fn verdict(job: &JobInfo, now: i64) -> Verdict {
    if cfg!(target_os = "linux") && Path::new("/proc/self").exists() {
        return if Path::new("/proc").join(job.pid.to_string()).exists() {
            Verdict::Alive
        } else {
            Verdict::Dead
        };
    }
    match parse_iso_secs(&job.updated_at) {
        Some(t) if now - t <= FRESH_SECS => Verdict::Alive,
        _ => Verdict::Stale,
    }
}

/// Seconds since the epoch of `YYYY-MM-DDTHH:MM:SS[.fff]Z` (what `Date#toISOString` writes).
pub fn parse_iso_secs(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hh, mm, ss) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn job_json(id: &str, pid: u32, started: &str) -> String {
        format!(
            r#"{{"id":"{id}","pid":{pid},"kind":"render","path":"/p/sb.json","quality":"draft","startedAt":"{started}","updatedAt":"{started}","step":{{"label":"chunk","index":2,"total":5}}}}"#
        )
    }

    #[test]
    fn parses_iso_time() {
        assert_eq!(parse_iso_secs("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_secs("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(
            parse_iso_secs("2026-11-09T12:30:15.123Z"),
            Some(1_794_227_415)
        );
        assert_eq!(parse_iso_secs("garbage"), None);
        assert_eq!(parse_iso_secs("2026-13-09T12:30:15Z"), None);
    }

    #[test]
    fn reads_sorts_and_filters_by_verdict() {
        let d = TempDir::new();
        std::fs::write(
            d.join("b.json"),
            job_json("b", 20, "2026-01-01T00:00:02.000Z"),
        )
        .unwrap();
        std::fs::write(
            d.join("a.json"),
            job_json("a", 10, "2026-01-01T00:00:01.000Z"),
        )
        .unwrap();
        std::fs::write(
            d.join("dead.json"),
            job_json("dead", 666, "2026-01-01T00:00:00.000Z"),
        )
        .unwrap();
        std::fs::write(
            d.join("stale.json"),
            job_json("stale", 777, "2026-01-01T00:00:03.000Z"),
        )
        .unwrap();
        std::fs::write(d.join("half.json"), r#"{"id":"half","pi"#).unwrap();
        std::fs::write(d.join("note.txt"), "x").unwrap();
        std::fs::write(d.join("a.json.tmp"), "x").unwrap();
        let v = |j: &JobInfo| match j.pid {
            666 => Verdict::Dead,
            777 => Verdict::Stale,
            _ => Verdict::Alive,
        };
        let jobs = list_jobs(d.path(), &v);
        assert_eq!(
            jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(
            jobs[0].step,
            Some(Step {
                label: "chunk".into(),
                index: 2,
                total: 5
            })
        );
        assert_eq!(jobs[0].quality.as_deref(), Some("draft"));
        assert!(!d.join("dead.json").exists(), "dead job file is deleted");
        assert!(d.join("stale.json").exists(), "stale job file is kept");
        assert!(
            d.join("half.json").exists(),
            "files we cannot read are left alone"
        );
    }

    #[test]
    fn missing_dir_is_empty() {
        let d = TempDir::new();
        assert!(jobs(&d.join("nope")).is_empty());
    }

    #[test]
    fn serializes_with_the_api_field_names() {
        let j: JobInfo = serde_json::from_str(r#"{"id":"x","pid":1,"kind":"sequence","path":"/s.json","startedAt":"a","updatedAt":"b"}"#).unwrap();
        let v = serde_json::to_value(&j).unwrap();
        assert_eq!(v["startedAt"], "a");
        assert_eq!(v["updatedAt"], "b");
        assert!(v.get("quality").is_none() && v.get("step").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_uses_proc_to_tell_live_from_dead() {
        let d = TempDir::new();
        std::fs::write(
            d.join("me.json"),
            job_json("me", std::process::id(), "2026-01-01T00:00:01.000Z"),
        )
        .unwrap();
        std::fs::write(
            d.join("gone.json"),
            job_json("gone", 4_194_000, "2026-01-01T00:00:02.000Z"),
        )
        .unwrap();
        let jobs = jobs(d.path());
        assert_eq!(
            jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
            vec!["me"]
        );
        assert!(!d.join("gone.json").exists());
    }
}

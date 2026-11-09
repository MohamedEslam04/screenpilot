//! Numbers for the dashboard header: how many things were done, how fast renders are.

use crate::history::count_lines;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
pub struct SpeedStat {
    pub quality: String,
    pub runs: usize,
    /// Video seconds made per second of waiting (median of the stored runs).
    pub realtime: f64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Stats {
    pub history_count: usize,
    pub speed: Vec<SpeedStat>,
}

pub fn stats(history_file: &Path, speed_file: &Path) -> Stats {
    Stats {
        history_count: count_lines(history_file),
        speed: speed(speed_file),
    }
}

const ORDER: [&str; 3] = ["draft", "looks", "delivery"];

/// Per quality, from `render-speed.json` (`{"entries": [{quality, workers, outSeconds, wallSeconds}]}`).
/// A missing or corrupt file, or an unusable entry, is ignored.
pub fn speed(file: &Path) -> Vec<SpeedStat> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let Ok(data) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(entries) = data.get("entries").and_then(Value::as_array) else {
        return Vec::new();
    };

    let usable = |v: Option<&Value>| {
        v.and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n > 0.0)
    };
    let mut by_quality: Vec<(String, Vec<f64>)> = Vec::new();
    for e in entries {
        let (Some(q), Some(out), Some(wall)) = (
            e.get("quality").and_then(Value::as_str),
            usable(e.get("outSeconds")),
            usable(e.get("wallSeconds")),
        ) else {
            continue;
        };
        match by_quality.iter_mut().find(|(name, _)| name == q) {
            Some((_, v)) => v.push(out / wall),
            None => by_quality.push((q.to_string(), vec![out / wall])),
        }
    }
    let mut stats: Vec<SpeedStat> = by_quality
        .into_iter()
        .map(|(quality, mut v)| {
            v.sort_by(|a, b| a.total_cmp(b));
            let mid = v.len() / 2;
            let realtime = if v.len() % 2 == 1 {
                v[mid]
            } else {
                (v[mid - 1] + v[mid]) / 2.0
            };
            SpeedStat {
                quality,
                runs: v.len(),
                realtime,
            }
        })
        .collect();
    let rank = |q: &str| ORDER.iter().position(|o| *o == q).unwrap_or(ORDER.len());
    stats.sort_by(|a, b| {
        rank(&a.quality)
            .cmp(&rank(&b.quality))
            .then_with(|| a.quality.cmp(&b.quality))
    });
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn median_per_quality_in_a_fixed_order() {
        let d = TempDir::new();
        let f = d.join("render-speed.json");
        std::fs::write(
            &f,
            r#"{"entries":[
              {"quality":"delivery","workers":4,"outSeconds":10,"wallSeconds":20},
              {"quality":"draft","workers":4,"outSeconds":60,"wallSeconds":20},
              {"quality":"draft","workers":4,"outSeconds":10,"wallSeconds":10},
              {"quality":"draft","workers":4,"outSeconds":30,"wallSeconds":10},
              {"quality":"draft","workers":4,"outSeconds":0,"wallSeconds":10},
              {"quality":"draft","workers":4,"outSeconds":"x","wallSeconds":10},
              {"quality":"custom","workers":4,"outSeconds":8,"wallSeconds":2},
              {"quality":"custom","workers":4,"outSeconds":2,"wallSeconds":2}
            ]}"#,
        )
        .unwrap();
        let s = speed(&f);
        assert_eq!(
            s,
            vec![
                SpeedStat {
                    quality: "draft".into(),
                    runs: 3,
                    realtime: 3.0
                }, // 1, 3, 3 -> 3
                SpeedStat {
                    quality: "delivery".into(),
                    runs: 1,
                    realtime: 0.5
                },
                SpeedStat {
                    quality: "custom".into(),
                    runs: 2,
                    realtime: 2.5
                }, // 1, 4 -> 2.5
            ]
        );
    }

    #[test]
    fn missing_or_corrupt_file_is_empty() {
        let d = TempDir::new();
        assert!(speed(&d.join("nope.json")).is_empty());
        std::fs::write(d.join("bad.json"), "{").unwrap();
        assert!(speed(&d.join("bad.json")).is_empty());
        std::fs::write(d.join("odd.json"), r#"{"entries":5}"#).unwrap();
        assert!(speed(&d.join("odd.json")).is_empty());
    }

    #[test]
    fn stats_combines_history_count_and_speed() {
        let d = TempDir::new();
        std::fs::write(d.join("h.jsonl"), "{}\n{}\n").unwrap();
        let s = stats(&d.join("h.jsonl"), &d.join("nope.json"));
        assert_eq!(
            s,
            Stats {
                history_count: 2,
                speed: vec![]
            }
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["history_count"], 2);
    }
}

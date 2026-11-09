//! `history.jsonl`: one JSON object per line, appended by the CLI. Read newest first, backwards
//! in blocks, so the cost depends on the page and never on the length of the file.

use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const BLOCK: usize = 64 * 1024;
/// A line longer than this is not an event; it is dropped instead of held in memory.
const MAX_LINE: usize = 1024 * 1024;

fn valid(e: &Value) -> bool {
    ["at", "path", "kind"]
        .iter()
        .all(|k| e.get(k).is_some_and(Value::is_string))
}

/// The newest events first. `before` (an ISO time, compared as a string) continues after the
/// last event of the previous page. Torn or invalid lines are skipped; a missing file is empty.
pub fn list_history(file: &Path, before: Option<&str>, limit: usize) -> Vec<Value> {
    let mut out = Vec::new();
    if limit == 0 {
        return out;
    }
    let Ok(mut f) = File::open(file) else {
        return out;
    };
    let Ok(mut pos) = f.metadata().map(|m| m.len()) else {
        return out;
    };
    // The start of a line whose beginning is in an earlier block.
    let mut tail: Vec<u8> = Vec::new();
    // An oversized line was dropped: ignore its front part when it shows up.
    let mut skipping = false;

    while pos > 0 && out.len() < limit {
        let size = pos.min(BLOCK as u64);
        pos -= size;
        let mut data = vec![0u8; size as usize];
        if f.seek(SeekFrom::Start(pos))
            .and_then(|_| f.read_exact(&mut data))
            .is_err()
        {
            break;
        }
        data.extend_from_slice(&tail);

        // Lines in this buffer as (start, end), last one first; `end` is where the head begins.
        let mut lines: Vec<(usize, usize)> = Vec::new();
        let mut end = data.len();
        for i in (0..data.len()).rev() {
            if data[i] == b'\n' {
                lines.push((i + 1, end));
                end = i;
            }
        }
        // data[..end] is the start of a line that continues in an earlier block.
        if skipping {
            if lines.is_empty() {
                // Still inside the dropped line.
                continue;
            }
            lines.remove(0);
            skipping = false;
        }
        tail = data[..end].to_vec();
        if tail.len() > MAX_LINE {
            tail.clear();
            skipping = true;
        }
        if pos == 0 && !skipping {
            lines.push((0, end));
        }

        for (start, stop) in lines {
            if out.len() >= limit {
                break;
            }
            if let Ok(e) = serde_json::from_slice::<Value>(&data[start..stop]) {
                if valid(&e) && before.is_none_or(|b| e["at"].as_str().is_some_and(|at| at < b)) {
                    out.push(e);
                }
            }
        }
    }
    out
}

/// How many non-blank lines the file has, counted in chunks (constant memory).
pub fn count_lines(file: &Path) -> usize {
    let Ok(mut f) = File::open(file) else {
        return 0;
    };
    let mut buf = vec![0u8; BLOCK];
    let mut count = 0;
    let mut has_content = false;
    loop {
        let n = match f.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' {
                if has_content {
                    count += 1;
                }
                has_content = false;
            } else if !b.is_ascii_whitespace() {
                has_content = true;
            }
        }
    }
    count + usize::from(has_content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn event(i: usize, pad: usize) -> String {
        // `at` grows with i so string order is time order.
        format!(
            r#"{{"v":1,"at":"2026-01-01T00:00:00.{i:06}Z","kind":"render","status":"ok","path":"/p/{i}","error":"{}"}}"#,
            "x".repeat(pad)
        )
    }

    fn ids(events: &[Value]) -> Vec<usize> {
        events
            .iter()
            .map(|e| {
                e["path"]
                    .as_str()
                    .unwrap()
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap()
            })
            .collect()
    }

    fn write(dir: &TempDir, lines: &[String]) -> std::path::PathBuf {
        let f = dir.join("history.jsonl");
        std::fs::write(&f, lines.join("\n") + "\n").unwrap();
        f
    }

    #[test]
    fn missing_file_is_empty() {
        let d = TempDir::new();
        assert!(list_history(&d.join("nope.jsonl"), None, 10).is_empty());
        assert_eq!(count_lines(&d.join("nope.jsonl")), 0);
    }

    #[test]
    fn newest_first_with_limit() {
        let d = TempDir::new();
        let f = write(&d, &(0..10).map(|i| event(i, 0)).collect::<Vec<_>>());
        assert_eq!(ids(&list_history(&f, None, 3)), vec![9, 8, 7]);
        assert_eq!(ids(&list_history(&f, None, 0)), Vec::<usize>::new());
        assert_eq!(
            ids(&list_history(&f, None, 100)),
            (0..10).rev().collect::<Vec<_>>()
        );
    }

    #[test]
    fn file_without_trailing_newline_and_with_crlf() {
        let d = TempDir::new();
        let f = d.join("h.jsonl");
        std::fs::write(&f, format!("{}\r\n{}", event(0, 0), event(1, 0))).unwrap();
        assert_eq!(ids(&list_history(&f, None, 10)), vec![1, 0]);
    }

    #[test]
    fn before_pages_without_overlap() {
        let d = TempDir::new();
        let f = write(&d, &(0..10).map(|i| event(i, 0)).collect::<Vec<_>>());
        let page1 = list_history(&f, None, 4);
        assert_eq!(ids(&page1), vec![9, 8, 7, 6]);
        let last = page1.last().unwrap()["at"].as_str().unwrap().to_string();
        let page2 = list_history(&f, Some(&last), 4);
        assert_eq!(ids(&page2), vec![5, 4, 3, 2]);
        let last = page2.last().unwrap()["at"].as_str().unwrap().to_string();
        assert_eq!(ids(&list_history(&f, Some(&last), 4)), vec![1, 0]);
    }

    #[test]
    fn big_file_across_many_blocks_with_lines_on_block_boundaries() {
        let d = TempDir::new();
        // About 450 KB: seven blocks, and lines of 150 bytes cross the 64 KiB boundaries.
        let lines: Vec<String> = (0..3000).map(|i| event(i, 20)).collect();
        let f = write(&d, &lines);
        assert!(std::fs::metadata(&f).unwrap().len() > 5 * BLOCK as u64);
        let all = list_history(&f, None, 10_000);
        assert_eq!(ids(&all), (0..3000).rev().collect::<Vec<_>>());
        // A small page from the end of a big file must not need the rest.
        assert_eq!(
            ids(&list_history(&f, None, 5)),
            vec![2999, 2998, 2997, 2996, 2995]
        );
        assert_eq!(count_lines(&f), 3000);
    }

    #[test]
    fn a_line_longer_than_a_block_still_parses() {
        let d = TempDir::new();
        let f = write(&d, &[event(0, 0), event(1, 3 * BLOCK), event(2, 0)]);
        assert_eq!(ids(&list_history(&f, None, 10)), vec![2, 1, 0]);
    }

    #[test]
    fn torn_and_invalid_lines_are_skipped() {
        let d = TempDir::new();
        let mut lines: Vec<String> = (0..6).map(|i| event(i, 0)).collect();
        lines.insert(
            3,
            r#"{"v":1,"at":"2026-01-01T00:00:00Z","kind":"ren"#.to_string(),
        ); // torn
        lines.insert(1, "not json".to_string());
        lines.insert(2, r#"{"at":"2026","kind":"render"}"#.to_string()); // no path
        lines.insert(2, String::new());
        lines.push(r#"{"v":1,"at":"2026-01-01T00:59"#.to_string()); // torn last line, no newline needed
        let f = d.join("h.jsonl");
        std::fs::write(&f, lines.join("\n")).unwrap();
        assert_eq!(ids(&list_history(&f, None, 10)), vec![5, 4, 3, 2, 1, 0]);
    }

    #[test]
    fn oversized_garbage_line_is_dropped_not_loaded() {
        let d = TempDir::new();
        let huge = "y".repeat(MAX_LINE + 3 * BLOCK);
        let f = write(
            &d,
            &[event(0, 0), event(1, 0), huge, event(2, 0), event(3, 0)],
        );
        assert_eq!(ids(&list_history(&f, None, 10)), vec![3, 2, 1, 0]);
    }

    #[test]
    fn counts_non_blank_lines() {
        let d = TempDir::new();
        let f = d.join("h.jsonl");
        std::fs::write(&f, "a\n\n  \nb\nc").unwrap();
        assert_eq!(count_lines(&f), 3);
    }
}

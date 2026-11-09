//! What the UI shows for one history entry: its storyboard, the recording's `meta.json` and
//! the files in the folder.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::Path;

/// A JSON file bigger than this is not a storyboard we want to ship over IPC.
const MAX_JSON: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Project {
    pub storyboard: Option<Value>,
    pub meta: Option<Value>,
    pub files: Vec<FileEntry>,
}

/// A folder reads its `storyboard.json` and `meta.json` and lists its files (top level, files only,
/// sorted by name). A file is read as the storyboard (or sequence); it has no meta and no listing.
/// Invalid or missing JSON gives `None` for that part, never an error.
pub fn get_project(path: &Path) -> Result<Project, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    if meta.is_dir() {
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                // `metadata` follows symlinks: a link to a video lists as the video.
                if let Ok(m) = fs::metadata(entry.path()) {
                    if m.is_file() {
                        files.push(FileEntry {
                            name: entry.file_name().to_string_lossy().into_owned(),
                            size: m.len(),
                        });
                    }
                }
            }
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Project {
            storyboard: read_json(&path.join("storyboard.json")),
            meta: read_json(&path.join("meta.json")),
            files,
        })
    } else {
        Ok(Project {
            storyboard: read_json(path),
            meta: None,
            files: Vec::new(),
        })
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_JSON {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_JSON).read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn folder_reads_storyboard_meta_and_lists_files() {
        let d = TempDir::new();
        std::fs::write(
            d.join("storyboard.json"),
            r#"{"version":1,"source":"a.mp4"}"#,
        )
        .unwrap();
        std::fs::write(d.join("meta.json"), r#"{"screens":[]}"#).unwrap();
        std::fs::write(d.join("a.mp4"), vec![0u8; 1234]).unwrap();
        std::fs::create_dir(d.join("sub")).unwrap();
        std::fs::write(d.join("sub").join("deep.txt"), "x").unwrap();
        let p = get_project(d.path()).unwrap();
        assert_eq!(p.storyboard.unwrap()["source"], "a.mp4");
        assert_eq!(p.meta.unwrap()["screens"], serde_json::json!([]));
        let names: Vec<_> = p.files.iter().map(|f| (f.name.as_str(), f.size)).collect();
        assert_eq!(
            names,
            vec![("a.mp4", 1234), ("meta.json", 14), ("storyboard.json", 30)]
        );
    }

    #[test]
    fn invalid_or_missing_json_is_none_not_an_error() {
        let d = TempDir::new();
        std::fs::write(d.join("storyboard.json"), "{ not json").unwrap();
        let p = get_project(d.path()).unwrap();
        assert!(p.storyboard.is_none() && p.meta.is_none());
        assert_eq!(p.files.len(), 1);
    }

    #[test]
    fn file_is_read_as_the_storyboard() {
        let d = TempDir::new();
        std::fs::write(d.join("sequence.json"), r#"{"version":1,"parts":[]}"#).unwrap();
        std::fs::write(d.join("meta.json"), "{}").unwrap();
        let p = get_project(&d.join("sequence.json")).unwrap();
        assert_eq!(p.storyboard.unwrap()["parts"], serde_json::json!([]));
        assert!(p.meta.is_none() && p.files.is_empty());
        let bad = d.join("bad.json");
        std::fs::write(&bad, "nope").unwrap();
        assert!(get_project(&bad).unwrap().storyboard.is_none());
    }

    #[test]
    fn missing_path_is_an_error() {
        let d = TempDir::new();
        assert!(get_project(&d.join("nope")).is_err());
    }

    #[test]
    fn serializes_to_the_api_shape() {
        let v = serde_json::to_value(Project {
            storyboard: None,
            meta: None,
            files: vec![FileEntry {
                name: "a".into(),
                size: 3,
            }],
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"storyboard": null, "meta": null, "files": [{"name": "a", "size": 3}]})
        );
    }
}

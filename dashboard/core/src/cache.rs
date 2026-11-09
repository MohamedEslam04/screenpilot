use std::fs;
use std::path::{Path, PathBuf};

/// Total bytes of the files under `dir`. Iterative (no recursion limit), ignores anything it cannot
/// read, never follows symlinks (a link counts as nothing).
pub fn cache_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn sums_nested_files() {
        let d = TempDir::new();
        std::fs::write(d.join("a"), vec![0u8; 100]).unwrap();
        std::fs::create_dir_all(d.join("x/y/z")).unwrap();
        std::fs::write(d.join("x/b"), vec![0u8; 20]).unwrap();
        std::fs::write(d.join("x/y/z/c"), vec![0u8; 3]).unwrap();
        assert_eq!(cache_size(d.path()), 123);
    }

    #[test]
    fn missing_dir_is_zero() {
        let d = TempDir::new();
        assert_eq!(cache_size(&d.join("nope")), 0);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        let d = TempDir::new();
        let outside = TempDir::new();
        std::fs::write(outside.join("big"), vec![0u8; 1000]).unwrap();
        std::fs::write(d.join("small"), vec![0u8; 5]).unwrap();
        std::os::unix::fs::symlink(outside.path(), d.join("dirlink")).unwrap();
        std::os::unix::fs::symlink(outside.join("big"), d.join("filelink")).unwrap();
        // A loop must not hang either.
        std::os::unix::fs::symlink(d.path(), d.join("loop")).unwrap();
        assert_eq!(cache_size(d.path()), 5);
    }

    #[test]
    fn very_deep_tree_does_not_overflow_the_stack() {
        let d = TempDir::new();
        let mut p = d.path().to_path_buf();
        for _ in 0..60 {
            p = p.join("d");
        }
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("f"), "1234").unwrap();
        assert_eq!(cache_size(d.path()), 4);
    }
}

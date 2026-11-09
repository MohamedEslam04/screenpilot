//! A small JPG of a video's first moments, made once with ffmpeg and cached in `<cache>/thumbs/`.

use crate::proc::run_capture;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

const FFMPEG_TIMEOUT: Duration = Duration::from_secs(30);

/// FNV-1a, 64 bit.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Where the thumbnail of `video` goes: the hash covers the path, the modification time and the size,
/// so a re-rendered video gets a new thumbnail. None when the video cannot be read.
pub fn thumb_path(video: &Path, cache_dir: &Path) -> Option<PathBuf> {
    let meta = fs::metadata(video).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut key = video.to_string_lossy().into_owned().into_bytes();
    key.extend_from_slice(
        format!(
            "|{}.{:09}|{}",
            mtime.as_secs(),
            mtime.subsec_nanos(),
            meta.len()
        )
        .as_bytes(),
    );
    Some(
        cache_dir
            .join("thumbs")
            .join(format!("{:016x}.jpg", fnv1a64(&key))),
    )
}

/// `ffmpeg` arguments for one frame, `seek` seconds in, scaled to 320 px wide.
pub fn ffmpeg_args(video: &Path, out: &Path, seek: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-y", "-v", "error", "-ss", seek, "-i"]
        .iter()
        .map(OsString::from)
        .collect();
    args.push(video.into());
    args.extend(
        ["-frames:v", "1", "-vf", "scale=320:-1", "-q:v", "5"]
            .iter()
            .map(OsString::from),
    );
    args.push(out.into());
    args
}

/// The cached thumbnail, made first if needed. None when the video is missing or ffmpeg fails
/// (not installed, not a video). `ffmpeg` is the program to run.
pub fn thumbnail(video: &Path, cache_dir: &Path, ffmpeg: &str) -> Option<PathBuf> {
    let out = thumb_path(video, cache_dir)?;
    if out.is_file() {
        return Some(out);
    }
    fs::create_dir_all(out.parent()?).ok()?;
    let tmp = out.with_extension("tmp.jpg");
    // A video shorter than a second has no frame at 1 s: try the first frame instead.
    for seek in ["1", "0"] {
        let _ = fs::remove_file(&tmp);
        let result = run_capture(
            Command::new(ffmpeg).args(ffmpeg_args(video, &tmp, seek)),
            None,
            FFMPEG_TIMEOUT,
        );
        if result.is_ok_and(|r| r.status.success()) && fs::metadata(&tmp).is_ok_and(|m| m.len() > 0)
        {
            fs::rename(&tmp, &out).ok()?;
            return Some(out);
        }
    }
    let _ = fs::remove_file(&tmp);
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn fnv1a64_known_values() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn path_changes_with_the_file() {
        let d = TempDir::new();
        let cache = d.join("cache");
        let v = d.join("v.mp4");
        assert!(thumb_path(&v, &cache).is_none(), "missing video");
        std::fs::write(&v, "aaaa").unwrap();
        let p1 = thumb_path(&v, &cache).unwrap();
        assert_eq!(p1.parent().unwrap(), cache.join("thumbs"));
        assert_eq!(p1.extension().unwrap(), "jpg");
        assert_eq!(p1.file_stem().unwrap().len(), 16);
        assert_eq!(thumb_path(&v, &cache).unwrap(), p1, "stable");
        std::fs::write(&v, "aaaaaaaa").unwrap();
        assert_ne!(
            thumb_path(&v, &cache).unwrap(),
            p1,
            "a new size gives a new thumbnail"
        );
        assert!(
            thumb_path(d.path(), &cache).is_none(),
            "a folder is not a video"
        );
    }

    #[test]
    fn args_are_one_per_element() {
        let args = ffmpeg_args(Path::new("/a b/c;d.mp4"), Path::new("/o.jpg"), "1");
        let strs: Vec<_> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(
            strs,
            [
                "-y",
                "-v",
                "error",
                "-ss",
                "1",
                "-i",
                "/a b/c;d.mp4",
                "-frames:v",
                "1",
                "-vf",
                "scale=320:-1",
                "-q:v",
                "5",
                "/o.jpg"
            ]
        );
    }

    #[cfg(unix)]
    mod with_fake_ffmpeg {
        use super::*;
        use crate::testutil::script;

        #[test]
        fn makes_the_thumbnail_once_and_reuses_it() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let ffmpeg = d.join("ffmpeg");
            // Writes a file at its last argument and counts how often it ran.
            script(
                &ffmpeg,
                r#"out="${@: -1}"; echo jpg > "$out"; echo run >> "$(dirname "$0")/runs.txt""#,
            );
            let v = d.join("v.mp4");
            std::fs::write(&v, "video").unwrap();
            let cache = d.join("cache");
            let t = thumbnail(&v, &cache, ffmpeg.to_str().unwrap()).unwrap();
            assert!(t.is_file());
            assert_eq!(std::fs::read_to_string(&t).unwrap(), "jpg\n");
            assert!(t.starts_with(cache.join("thumbs")));
            assert_eq!(thumbnail(&v, &cache, ffmpeg.to_str().unwrap()).unwrap(), t);
            assert_eq!(
                std::fs::read_to_string(d.join("runs.txt"))
                    .unwrap()
                    .lines()
                    .count(),
                1,
                "second call is a cache hit"
            );
            assert!(!t.with_extension("tmp.jpg").exists());
        }

        #[test]
        fn retries_at_the_first_frame_for_a_short_video() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let ffmpeg = d.join("ffmpeg");
            // Succeeds without output when asked for second 1 (what ffmpeg does past the end).
            script(
                &ffmpeg,
                r#"[ "$4" = "1" ] && exit 0; out="${@: -1}"; echo jpg > "$out""#,
            );
            let v = d.join("short.mp4");
            std::fs::write(&v, "video").unwrap();
            assert!(thumbnail(&v, &d.join("cache"), ffmpeg.to_str().unwrap()).is_some());
        }

        #[test]
        fn ffmpeg_failure_or_absence_is_none() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let v = d.join("v.mp4");
            std::fs::write(&v, "video").unwrap();
            let failing = d.join("ffmpeg");
            script(&failing, "echo broken >&2; exit 1");
            assert!(thumbnail(&v, &d.join("cache"), failing.to_str().unwrap()).is_none());
            assert!(
                thumbnail(&v, &d.join("cache"), d.join("no-ffmpeg").to_str().unwrap()).is_none()
            );
            assert!(thumbnail(
                &d.join("missing.mp4"),
                &d.join("cache"),
                failing.to_str().unwrap()
            )
            .is_none());
        }
    }
}

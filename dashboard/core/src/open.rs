//! Open a file or folder with the OS: the default app, or the folder that holds it.

use crate::paths::Os;
use crate::proc::spawn_detached;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The program and arguments that open `path` on `os`. `reveal` shows the file in its folder
/// (a folder is simply opened).
pub fn open_command(os: Os, path: &Path, reveal: bool) -> (&'static str, Vec<OsString>) {
    let target: PathBuf = if reveal && !path.is_dir() {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    };
    match os {
        Os::Mac if reveal && !path.is_dir() => ("open", vec!["-R".into(), path.into()]),
        Os::Mac => ("open", vec![target.into_os_string()]),
        Os::Windows if reveal && !path.is_dir() => {
            let mut arg = OsString::from("/select,");
            arg.push(path);
            ("explorer", vec![arg])
        }
        Os::Windows => ("explorer", vec![target.into_os_string()]),
        Os::Other => ("xdg-open", vec![target.into_os_string()]),
    }
}

const OPENABLE: &[&str] = &[
    "mp4", "webm", "mov", "mkv", "gif", "png", "jpg", "jpeg", "webp", "srt", "vtt", "json",
    "jsonl", "txt", "md", "log", "wav", "mp3", "m4a", "ogg",
];

fn is_openable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| OPENABLE.contains(&e.to_ascii_lowercase().as_str()))
}

/// Open `path` (it must exist). Returns as soon as the opener has started: `xdg-open` and
/// `explorer` report odd exit codes, so the result is not waited for.
pub fn open_path(path: &Path, reveal: bool) -> Result<(), String> {
    open_path_with(Os::current(), None, path, reveal)
}

/// As `open_path` with the OS and the program chosen by the caller (tests).
pub fn open_path_with(
    os: Os,
    program: Option<&str>,
    path: &Path,
    reveal: bool,
) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("not found: {}", path.display()));
    }
    // The opener runs whatever the OS associates with the file (an .exe on Windows, a script on
    // Linux), so only media and text are opened; showing anything in its folder is always fine.
    if !reveal && !path.is_dir() && !is_openable(path) {
        return Err(format!(
            "will not open {}: only videos, images, subtitles and text files are opened (use reveal to show it in its folder)",
            path.display()
        ));
    }
    // Absolute, so a name that starts with "-" is never read as an option.
    let abs = std::path::absolute(path).map_err(|e| format!("bad path: {e}"))?;
    let (default_program, args) = open_command(os, &abs, reveal);
    let program = program.unwrap_or(default_program);
    spawn_detached(Command::new(program).args(args))
        .map_err(|e| format!("cannot start {program}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn strs(args: &[OsString]) -> Vec<&str> {
        args.iter().map(|a| a.to_str().unwrap()).collect()
    }

    #[test]
    fn builds_the_opener_per_os() {
        let file = Path::new("/v/demo video.mp4");
        let (p, a) = open_command(Os::Other, file, false);
        assert_eq!((p, strs(&a)), ("xdg-open", vec!["/v/demo video.mp4"]));
        let (p, a) = open_command(Os::Other, file, true);
        assert_eq!((p, strs(&a)), ("xdg-open", vec!["/v"]));
        let (p, a) = open_command(Os::Mac, file, false);
        assert_eq!((p, strs(&a)), ("open", vec!["/v/demo video.mp4"]));
        let (p, a) = open_command(Os::Mac, file, true);
        assert_eq!((p, strs(&a)), ("open", vec!["-R", "/v/demo video.mp4"]));
        let (p, a) = open_command(Os::Windows, Path::new("C:/v/demo.mp4"), false);
        assert_eq!((p, strs(&a)), ("explorer", vec!["C:/v/demo.mp4"]));
        let (p, a) = open_command(Os::Windows, Path::new("C:/v/demo.mp4"), true);
        assert_eq!((p, strs(&a)), ("explorer", vec!["/select,C:/v/demo.mp4"]));
    }

    #[test]
    fn revealing_a_folder_opens_it() {
        let d = TempDir::new();
        let (p, a) = open_command(Os::Other, d.path(), true);
        assert_eq!((p, a), ("xdg-open", vec![d.path().as_os_str().to_owned()]));
        let (_, a) = open_command(Os::Mac, d.path(), true);
        assert_eq!(a, vec![d.path().as_os_str().to_owned()]);
    }

    #[test]
    fn missing_path_is_an_error() {
        let d = TempDir::new();
        assert!(
            open_path_with(Os::Other, Some("true"), &d.join("nope"), false)
                .unwrap_err()
                .contains("not found")
        );
    }

    #[test]
    fn refuses_to_open_a_program_or_script() {
        let d = TempDir::new();
        for name in [
            "evil.exe",
            "x.desktop",
            "run.sh",
            "noext",
            "a.bat",
            "b.app.cmd",
        ] {
            let f = d.join(name);
            std::fs::write(&f, "").unwrap();
            let err = open_path_with(Os::Other, Some("true"), &f, false).unwrap_err();
            assert!(err.contains("will not open"), "{name}: {err}");
            // Showing it in its folder is harmless.
            assert!(
                open_path_with(Os::Other, Some("true"), &f, true).is_ok(),
                "{name}"
            );
        }
        for name in ["a.mp4", "B.MP4", "c.srt", "d.json", "e.png"] {
            let f = d.join(name);
            std::fs::write(&f, "").unwrap();
            assert!(
                open_path_with(Os::Other, Some("true"), &f, false).is_ok(),
                "{name}"
            );
        }
        assert!(open_path_with(Os::Other, Some("true"), d.path(), false).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_given_program_with_the_path() {
        use crate::testutil::script;
        let _serial = crate::testutil::serial();
        let d = TempDir::new();
        let opener = d.join("opener");
        script(
            &opener,
            r#"printf '%s\n' "$@" > "$(dirname "$0")/args.txt""#,
        );
        let file = d.join("a b.mp4");
        std::fs::write(&file, "").unwrap();
        open_path_with(Os::Other, opener.to_str(), &file, true).unwrap();
        for _ in 0..200 {
            if d.join("args.txt").exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(
            std::fs::read_to_string(d.join("args.txt")).unwrap(),
            format!("{}\n", d.path().display())
        );
        assert!(
            open_path_with(Os::Other, Some("/no/such/opener"), &file, false)
                .unwrap_err()
                .contains("cannot start")
        );
    }
}

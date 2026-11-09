//! Where screenpilot keeps things. Mirrors `src/brand.ts` (`configDir`, `cacheHome`) and
//! `src/setup/index.ts` (`appHome`) rule for rule, so both sides always look at the same folders.

use std::path::{Path, PathBuf};

const APP: &str = "screenpilot";
const APP_TITLE: &str = "ScreenPilot";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Other,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Other
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    /// `history.jsonl`, `secrets.json` live here.
    pub config: PathBuf,
    /// `jobs/`, `render-speed.json`, `thumbs/` live here.
    pub cache: PathBuf,
    /// Where `setup` installs the app (`dist/cli.js`).
    pub app_home: PathBuf,
    /// The HyperFrames extract cache, the part of the cache that is big.
    pub extract_cache: PathBuf,
}

impl Paths {
    pub fn from_env() -> Paths {
        let env = |k: &str| std::env::var_os(k).and_then(|v| v.into_string().ok());
        Paths::resolve(Os::current(), &home_dir(Os::current(), &env), &env)
    }

    /// `env` returns a variable's value; an empty value counts as unset (as in JS).
    pub fn resolve(os: Os, home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Paths {
        let get = |k: &str| env(k).filter(|v| !v.is_empty());

        let config_base = match (get("XDG_CONFIG_HOME"), os, get("APPDATA")) {
            (Some(x), _, _) => PathBuf::from(x),
            (None, Os::Windows, Some(a)) => PathBuf::from(a),
            _ => home.join(".config"),
        };

        let cache = match (os, get("LOCALAPPDATA")) {
            (Os::Windows, Some(l)) => PathBuf::from(l).join(APP).join("cache"),
            (Os::Mac, _) => home.join("Library").join("Caches").join(APP),
            _ => get("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".cache"))
                .join(APP),
        };

        let app_home = match os {
            Os::Windows => get("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Local"))
                .join(APP_TITLE),
            Os::Mac => home
                .join("Library")
                .join("Application Support")
                .join(APP_TITLE),
            Os::Other => get("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join(APP),
        };

        let extract_cache = get("HYPERFRAMES_EXTRACT_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| cache.join("extract"));

        Paths {
            config: config_base.join(APP),
            cache,
            app_home,
            extract_cache,
        }
    }

    pub fn history_file(&self) -> PathBuf {
        self.config.join("history.jsonl")
    }
    pub fn jobs_dir(&self) -> PathBuf {
        self.cache.join("jobs")
    }
    pub fn speed_file(&self) -> PathBuf {
        self.cache.join("render-speed.json")
    }
}

fn home_dir(os: Os, env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    let (first, second) = if os == Os::Windows {
        ("USERPROFILE", "HOME")
    } else {
        ("HOME", "USERPROFILE")
    };
    [first, second]
        .iter()
        .find_map(|k| env(k).filter(|v| !v.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn paths(os: Os, vars: &[(&str, &str)]) -> Paths {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Paths::resolve(os, Path::new("/home/u"), &|k| map.get(k).cloned())
    }

    #[test]
    fn linux_defaults() {
        let p = paths(Os::Other, &[]);
        assert_eq!(p.config, Path::new("/home/u/.config/screenpilot"));
        assert_eq!(p.cache, Path::new("/home/u/.cache/screenpilot"));
        assert_eq!(p.app_home, Path::new("/home/u/.local/share/screenpilot"));
        assert_eq!(
            p.extract_cache,
            Path::new("/home/u/.cache/screenpilot/extract")
        );
        assert_eq!(
            p.history_file(),
            Path::new("/home/u/.config/screenpilot/history.jsonl")
        );
        assert_eq!(p.jobs_dir(), Path::new("/home/u/.cache/screenpilot/jobs"));
        assert_eq!(
            p.speed_file(),
            Path::new("/home/u/.cache/screenpilot/render-speed.json")
        );
    }

    #[test]
    fn linux_xdg_overrides_and_empty_means_unset() {
        let p = paths(
            Os::Other,
            &[
                ("XDG_CONFIG_HOME", "/x/c"),
                ("XDG_CACHE_HOME", "/x/k"),
                ("XDG_DATA_HOME", "/x/d"),
            ],
        );
        assert_eq!(p.config, Path::new("/x/c/screenpilot"));
        assert_eq!(p.cache, Path::new("/x/k/screenpilot"));
        assert_eq!(p.app_home, Path::new("/x/d/screenpilot"));
        let q = paths(
            Os::Other,
            &[("XDG_CONFIG_HOME", ""), ("XDG_CACHE_HOME", "")],
        );
        assert_eq!(q.config, Path::new("/home/u/.config/screenpilot"));
        assert_eq!(q.cache, Path::new("/home/u/.cache/screenpilot"));
    }

    #[test]
    fn mac_paths() {
        let p = paths(Os::Mac, &[("XDG_CACHE_HOME", "/ignored")]);
        assert_eq!(p.config, Path::new("/home/u/.config/screenpilot"));
        assert_eq!(p.cache, Path::new("/home/u/Library/Caches/screenpilot"));
        assert_eq!(
            p.app_home,
            Path::new("/home/u/Library/Application Support/ScreenPilot")
        );
    }

    #[test]
    fn windows_paths() {
        let p = paths(
            Os::Windows,
            &[("APPDATA", "C:/Roaming"), ("LOCALAPPDATA", "C:/Local")],
        );
        assert_eq!(p.config, Path::new("C:/Roaming/screenpilot"));
        assert_eq!(p.cache, Path::new("C:/Local/screenpilot/cache"));
        assert_eq!(p.app_home, Path::new("C:/Local/ScreenPilot"));
        // XDG_CONFIG_HOME wins over APPDATA, as in brand.ts.
        let q = paths(
            Os::Windows,
            &[("XDG_CONFIG_HOME", "D:/cfg"), ("APPDATA", "C:/Roaming")],
        );
        assert_eq!(q.config, Path::new("D:/cfg/screenpilot"));
        // No LOCALAPPDATA: the cache falls back to ~/.cache, the app home to ~/AppData/Local.
        assert_eq!(q.cache, Path::new("/home/u/.cache/screenpilot"));
        assert_eq!(q.app_home, Path::new("/home/u/AppData/Local/ScreenPilot"));
    }

    #[test]
    fn extract_cache_override() {
        let p = paths(
            Os::Other,
            &[("HYPERFRAMES_EXTRACT_CACHE_DIR", "/big/extract")],
        );
        assert_eq!(p.extract_cache, Path::new("/big/extract"));
    }

    #[test]
    fn home_prefers_the_platform_variable() {
        let env = |k: &str| match k {
            "HOME" => Some("/h".to_string()),
            "USERPROFILE" => Some("C:/Users/u".to_string()),
            _ => None,
        };
        assert_eq!(home_dir(Os::Other, &env), Path::new("/h"));
        assert_eq!(home_dir(Os::Windows, &env), Path::new("C:/Users/u"));
        assert_eq!(home_dir(Os::Other, &|_| None), Path::new("."));
    }
}

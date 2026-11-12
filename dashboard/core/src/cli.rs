//! Calls to the screenpilot CLI. Arguments are built and validated here as separate `OsString`s
//! (no shell, so a path with spaces, quotes or `;` stays one argument). A key only ever goes to
//! the child's stdin: never an argument, never the environment, never a log line or an error.

use crate::paths::Paths;
use crate::proc::{run_capture, short_stderr, spawn_detached};
use crate::providers::{
    merge_providers, ProviderInfo, ENDPOINT_PROVIDERS, SECRET_PROVIDERS, VOICE_PROVIDERS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub const QUALITIES: [&str; 3] = ["draft", "looks", "delivery"];

/// Voice lists can come from the network (Edge, ElevenLabs).
const VOICES_TIMEOUT: Duration = Duration::from_secs(60);
const SECRET_TIMEOUT: Duration = Duration::from_secs(30);
const ENDPOINT_TIMEOUT: Duration = Duration::from_secs(30);

/// How to start the CLI: a program and the arguments that come before the subcommand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cli {
    pub program: OsString,
    pub prefix: Vec<OsString>,
}

impl Cli {
    /// `$SCREENPILOT_BIN`, else `<app home>/dist/cli.js` run with the node that ships in the package
    /// (`<app home>/bin/node`, `node.exe` on Windows; an app started from a menu has no shell PATH),
    /// else `node` on PATH, else `screenpilot` on PATH.
    pub fn resolve(paths: &Paths, env: &dyn Fn(&str) -> Option<String>) -> Cli {
        if let Some(bin) = env("SCREENPILOT_BIN").filter(|b| !b.is_empty()) {
            return Cli {
                program: bin.into(),
                prefix: Vec::new(),
            };
        }
        let cli_js = paths.app_home.join("dist").join("cli.js");
        if cli_js.is_file() {
            let bundled =
                paths
                    .app_home
                    .join("bin")
                    .join(if cfg!(windows) { "node.exe" } else { "node" });
            let program: OsString = if bundled.is_file() {
                bundled.into_os_string()
            } else {
                "node".into()
            };
            return Cli {
                program,
                prefix: vec![cli_js.into_os_string()],
            };
        }
        Cli {
            program: "screenpilot".into(),
            prefix: Vec::new(),
        }
    }

    pub fn from_env(paths: &Paths) -> Cli {
        Cli::resolve(paths, &|k| {
            std::env::var_os(k).and_then(|v| v.into_string().ok())
        })
    }

    fn command(&self, args: &[OsString]) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.prefix).args(args);
        cmd
    }
}

fn os(parts: &[&str]) -> Vec<OsString> {
    parts.iter().map(OsString::from).collect()
}

pub fn check_quality(quality: &str) -> Result<(), String> {
    if QUALITIES.contains(&quality) {
        Ok(())
    } else {
        Err(format!(
            "unknown quality \"{quality}\" (want draft, looks or delivery)"
        ))
    }
}

pub fn check_voice_provider(provider: &str) -> Result<(), String> {
    if VOICE_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("unknown voice provider \"{provider}\""))
    }
}

pub fn check_secret_provider(provider: &str) -> Result<(), String> {
    if SECRET_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!(
            "provider \"{provider}\" has no key (want elevenlabs or gemini)"
        ))
    }
}

pub fn check_endpoint_provider(provider: &str) -> Result<(), String> {
    if ENDPOINT_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!(
            "provider \"{provider}\" has no base URL (want elevenlabs or gemini)"
        ))
    }
}

/// The text of the Base URL field (an address or a region name), trimmed. The CLI does the real
/// check of the address; this only rejects what must never reach it as an argument.
pub fn check_endpoint_value(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("the address is empty".to_string());
    }
    if value.chars().any(char::is_control) {
        return Err("the address must be a single line".to_string());
    }
    if value.starts_with('-') {
        return Err("the address must not start with \"-\"".to_string());
    }
    Ok(value.to_string())
}

/// `render <storyboard> -q <quality>`. The storyboard must be an existing `.json` file; it is made
/// absolute so the CLI finds it from any working folder.
pub fn render_args(storyboard: &str, quality: &str) -> Result<Vec<OsString>, String> {
    check_quality(quality)?;
    let path = Path::new(storyboard);
    if !storyboard.to_ascii_lowercase().ends_with(".json") {
        return Err("the storyboard must be a .json file".to_string());
    }
    if storyboard.starts_with('-') {
        return Err("the storyboard path must not start with \"-\"".to_string());
    }
    if !path.is_file() {
        return Err(format!("storyboard not found: {storyboard}"));
    }
    let abs = std::path::absolute(path).map_err(|e| format!("bad storyboard path: {e}"))?;
    let mut args = os(&["render"]);
    args.push(abs.into_os_string());
    args.extend(os(&["-q", quality]));
    Ok(args)
}

/// `secret set|status|remove [<provider>]`.
pub fn secret_args(action: &str, provider: Option<&str>) -> Result<Vec<OsString>, String> {
    if !["set", "status", "remove"].contains(&action) {
        return Err(format!("unknown secret action \"{action}\""));
    }
    let mut args = os(&["secret", action]);
    if action != "status" {
        let p = provider.ok_or("a provider is required")?;
        check_secret_provider(p)?;
        args.push(p.into());
    }
    Ok(args)
}

/// `endpoint set <provider> <url-or-region>`, `endpoint status` or `endpoint clear <provider>`.
pub fn endpoint_args(
    action: &str,
    provider: Option<&str>,
    value: Option<&str>,
) -> Result<Vec<OsString>, String> {
    if !["set", "status", "clear"].contains(&action) {
        return Err(format!("unknown endpoint action \"{action}\""));
    }
    let mut args = os(&["endpoint", action]);
    if action != "status" {
        let p = provider.ok_or("a provider is required")?;
        check_endpoint_provider(p)?;
        args.push(p.into());
    }
    if action == "set" {
        args.push(check_endpoint_value(value.ok_or("an address is required")?)?.into());
    }
    Ok(args)
}

/// `voices --provider <id>`.
pub fn voices_args(provider: &str) -> Result<Vec<OsString>, String> {
    check_voice_provider(provider)?;
    Ok(os(&["voices", "--provider", provider]))
}

/// Start a render that keeps going when the dashboard closes. Progress shows up in the jobs folder.
pub fn run_render(cli: &Cli, storyboard: &str, quality: &str) -> Result<(), String> {
    let args = render_args(storyboard, quality)?;
    let mut cmd = cli.command(&args);
    if let Some(dir) = std::path::absolute(storyboard)
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        cmd.current_dir(dir);
    }
    spawn_detached(&mut cmd)
        .map_err(|e| format!("cannot start {}: {e}", cli.program.to_string_lossy()))
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct Voice {
    pub name: String,
    pub locale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
}

pub fn list_voices(cli: &Cli, provider: &str) -> Result<Vec<Voice>, String> {
    let args = voices_args(provider)?;
    let out = run_capture(&mut cli.command(&args), None, VOICES_TIMEOUT)?;
    if !out.status.success() {
        return Err(format!(
            "screenpilot voices failed: {}",
            short_stderr(&out.stderr, None, 300)
        ));
    }
    let json = parse_json(&out.stdout).ok_or("screenpilot voices printed no JSON")?;
    let list = json
        .as_array()
        .ok_or("screenpilot voices did not print a list")?;
    Ok(list
        .iter()
        .filter_map(|v| serde_json::from_value::<Voice>(v.clone()).ok())
        .collect())
}

/// Store a key. It is written to the CLI's stdin and nowhere else.
pub fn set_secret(cli: &Cli, provider: &str, key: &str) -> Result<(), String> {
    let args = secret_args("set", Some(provider))?;
    let key = key.trim();
    if key.is_empty() {
        return Err("the key is empty".to_string());
    }
    if key.chars().any(char::is_control) {
        return Err("the key must be a single line".to_string());
    }
    let input = format!("{key}\n");
    let out = run_capture(
        &mut cli.command(&args),
        Some(input.as_bytes()),
        SECRET_TIMEOUT,
    )?;
    if out.status.success() {
        return Ok(());
    }
    let code = out
        .status
        .code()
        .map_or("signal".to_string(), |c| c.to_string());
    Err(format!(
        "screenpilot secret set failed (exit {code}): {}",
        short_stderr(&out.stderr, Some(key), 300)
    ))
}

/// Delete a stored key; true when there was one.
pub fn remove_secret(cli: &Cli, provider: &str) -> Result<bool, String> {
    let args = secret_args("remove", Some(provider))?;
    let out = run_capture(&mut cli.command(&args), None, SECRET_TIMEOUT)?;
    if !out.status.success() {
        return Err(format!(
            "screenpilot secret remove failed: {}",
            short_stderr(&out.stderr, None, 300)
        ));
    }
    let json = parse_json(&out.stdout).ok_or("screenpilot secret remove printed no JSON")?;
    Ok(json
        .get("removed")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

/// Save the base URL of a provider (an address or a region name). The CLI checks it; the new
/// address comes back normalized. The dashboard never contacts the address itself.
pub fn set_endpoint(cli: &Cli, provider: &str, value: &str) -> Result<String, String> {
    let args = endpoint_args("set", Some(provider), Some(value))?;
    let out = run_capture(&mut cli.command(&args), None, ENDPOINT_TIMEOUT)?;
    if !out.status.success() {
        return Err(format!(
            "screenpilot endpoint set failed: {}",
            short_stderr(&out.stderr, None, 300)
        ));
    }
    Ok(parse_json(&out.stdout)
        .and_then(|j| j.get("baseUrl").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| value.trim().to_string()))
}

/// Go back to the default address; true when there was a saved one.
pub fn clear_endpoint(cli: &Cli, provider: &str) -> Result<bool, String> {
    let args = endpoint_args("clear", Some(provider), None)?;
    let out = run_capture(&mut cli.command(&args), None, ENDPOINT_TIMEOUT)?;
    if !out.status.success() {
        return Err(format!(
            "screenpilot endpoint clear failed: {}",
            short_stderr(&out.stderr, None, 300)
        ));
    }
    let json = parse_json(&out.stdout).ok_or("screenpilot endpoint clear printed no JSON")?;
    Ok(json
        .get("cleared")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

/// The JSON a read-only CLI command prints, or None when it cannot run or fails.
fn read_status(cli: &Cli, args: Result<Vec<OsString>, String>, timeout: Duration) -> Option<Value> {
    run_capture(&mut cli.command(&args.ok()?), None, timeout)
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| parse_json(&out.stdout))
}

/// The providers with where their keys come from and their base URLs. A CLI that cannot run just
/// shows no keys; one without `endpoint` (older) shows no base URLs.
pub fn providers(cli: &Cli) -> Vec<ProviderInfo> {
    let status = read_status(cli, secret_args("status", None), SECRET_TIMEOUT);
    let endpoints = read_status(cli, endpoint_args("status", None, None), ENDPOINT_TIMEOUT);
    merge_providers(status.as_ref(), endpoints.as_ref())
}

/// The CLI prints one JSON document; tolerate a line of log text before it.
fn parse_json(stdout: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(stdout);
    serde_json::from_str(text.trim()).ok().or_else(|| {
        let start = text.find(['[', '{'])?;
        serde_json::from_str(text[start..].trim()).ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn env_of(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| {
            vars.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    fn paths_in(dir: &Path) -> Paths {
        Paths {
            config: dir.join("config"),
            cache: dir.join("cache"),
            app_home: dir.join("home"),
            extract_cache: dir.join("cache/extract"),
        }
    }

    #[test]
    fn resolves_bin_then_app_home_then_path() {
        let d = TempDir::new();
        let p = paths_in(d.path());
        let bin = Cli::resolve(&p, &env_of(&[("SCREENPILOT_BIN", "/opt/sp")]));
        assert_eq!(
            bin,
            Cli {
                program: "/opt/sp".into(),
                prefix: vec![]
            }
        );
        // An empty variable is unset.
        assert_eq!(
            Cli::resolve(&p, &env_of(&[("SCREENPILOT_BIN", "")])).program,
            OsString::from("screenpilot")
        );

        std::fs::create_dir_all(p.app_home.join("dist")).unwrap();
        std::fs::write(p.app_home.join("dist/cli.js"), "").unwrap();
        let node = Cli::resolve(&p, &env_of(&[]));
        assert_eq!(node.program, OsString::from("node"));
        assert_eq!(
            node.prefix,
            vec![p.app_home.join("dist/cli.js").into_os_string()]
        );
        // SCREENPILOT_BIN still wins.
        assert_eq!(
            Cli::resolve(&p, &env_of(&[("SCREENPILOT_BIN", "/opt/sp")])).program,
            OsString::from("/opt/sp")
        );
    }

    #[test]
    fn prefers_the_node_that_ships_in_the_package() {
        let d = TempDir::new();
        let p = paths_in(d.path());
        std::fs::create_dir_all(p.app_home.join("dist")).unwrap();
        std::fs::write(p.app_home.join("dist/cli.js"), "").unwrap();
        std::fs::create_dir_all(p.app_home.join("bin")).unwrap();
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::write(p.app_home.join("bin").join(name), "").unwrap();
        let cli = Cli::resolve(&p, &env_of(&[]));
        assert_eq!(
            cli.program,
            p.app_home.join("bin").join(name).into_os_string()
        );
        assert_eq!(
            cli.prefix,
            vec![p.app_home.join("dist/cli.js").into_os_string()]
        );
    }

    #[test]
    fn render_args_keep_a_hostile_path_as_one_argument() {
        let d = TempDir::new();
        let name = r#"my "demo"; rm -rf $HOME `x` $(y).json"#;
        let file = d.join(name);
        std::fs::write(&file, "{}").unwrap();
        let args = render_args(file.to_str().unwrap(), "draft").unwrap();
        assert_eq!(
            args,
            vec![
                OsString::from("render"),
                file.clone().into_os_string(),
                OsString::from("-q"),
                OsString::from("draft")
            ]
        );
    }

    #[test]
    fn render_args_validate_quality_and_path() {
        let d = TempDir::new();
        let sb = d.join("storyboard.json");
        std::fs::write(&sb, "{}").unwrap();
        let sb = sb.to_str().unwrap();
        for q in QUALITIES {
            assert!(render_args(sb, q).is_ok());
        }
        assert!(render_args(sb, "ultra").is_err());
        assert!(render_args(sb, "draft; rm -rf /").is_err());
        assert!(render_args(sb, "").is_err());
        assert!(
            render_args(d.join("missing.json").to_str().unwrap(), "draft").is_err(),
            "must exist"
        );
        let txt = d.join("a.txt");
        std::fs::write(&txt, "").unwrap();
        assert!(
            render_args(txt.to_str().unwrap(), "draft").is_err(),
            "must be .json"
        );
        std::fs::create_dir(d.join("dir.json")).unwrap();
        assert!(
            render_args(d.join("dir.json").to_str().unwrap(), "draft").is_err(),
            "must be a file"
        );
        assert!(
            render_args("-x.json", "draft").is_err(),
            "must not look like an option"
        );
    }

    #[test]
    fn secret_and_voices_args_validate_the_provider() {
        let s = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            secret_args("set", Some("gemini")).unwrap(),
            s(&["secret", "set", "gemini"])
        );
        assert_eq!(
            secret_args("remove", Some("elevenlabs")).unwrap(),
            s(&["secret", "remove", "elevenlabs"])
        );
        assert_eq!(
            secret_args("status", None).unwrap(),
            s(&["secret", "status"])
        );
        assert!(secret_args("set", Some("edge")).is_err());
        assert!(secret_args("set", Some("gemini; id")).is_err());
        assert!(secret_args("set", None).is_err());
        assert!(secret_args("dump", Some("gemini")).is_err());

        for p in VOICE_PROVIDERS {
            assert_eq!(voices_args(p).unwrap(), s(&["voices", "--provider", p]));
        }
        assert!(voices_args("openai").is_err());
        assert!(voices_args("--help").is_err());
    }

    #[test]
    fn endpoint_args_validate_the_provider_and_the_address() {
        let s = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            endpoint_args("set", Some("elevenlabs"), Some(" eu ")).unwrap(),
            s(&["endpoint", "set", "elevenlabs", "eu"])
        );
        assert_eq!(
            endpoint_args(
                "set",
                Some("gemini"),
                Some("https://gw.example.com/a b; rm -rf $HOME")
            )
            .unwrap(),
            s(&[
                "endpoint",
                "set",
                "gemini",
                "https://gw.example.com/a b; rm -rf $HOME"
            ]),
            "the address stays one argument"
        );
        assert_eq!(
            endpoint_args("clear", Some("gemini"), None).unwrap(),
            s(&["endpoint", "clear", "gemini"])
        );
        assert_eq!(
            endpoint_args("status", None, None).unwrap(),
            s(&["endpoint", "status"])
        );
        // clear and status never carry an address.
        assert_eq!(
            endpoint_args("clear", Some("gemini"), Some("x")).unwrap(),
            s(&["endpoint", "clear", "gemini"])
        );

        assert!(endpoint_args("set", Some("edge"), Some("eu")).is_err());
        assert!(endpoint_args("set", Some("gemini; id"), Some("eu")).is_err());
        assert!(endpoint_args("set", None, Some("eu")).is_err());
        assert!(endpoint_args("set", Some("gemini"), None).is_err());
        assert!(endpoint_args("clear", None, None).is_err());
        assert!(endpoint_args("dump", Some("gemini"), None).is_err());
    }

    #[test]
    fn an_empty_or_odd_address_is_rejected() {
        for bad in [
            "",
            "   ",
            "\t\n",
            "a\nb",
            "https://x\u{0}y",
            "--help",
            " -x",
        ] {
            assert!(check_endpoint_value(bad).is_err(), "{bad:?}");
            assert!(
                endpoint_args("set", Some("gemini"), Some(bad)).is_err(),
                "{bad:?}"
            );
        }
        assert_eq!(check_endpoint_value("  us  ").unwrap(), "us");
        assert_eq!(
            check_endpoint_value("http://localhost:8080/v1").unwrap(),
            "http://localhost:8080/v1"
        );
    }

    #[test]
    fn parses_json_with_log_noise() {
        assert_eq!(parse_json(b"[1,2]\n").unwrap(), serde_json::json!([1, 2]));
        assert_eq!(
            parse_json(b"warming up...\n{\"a\":1}\n").unwrap(),
            serde_json::json!({"a": 1})
        );
        assert!(parse_json(b"nothing").is_none());
    }

    #[cfg(unix)]
    mod with_fake_cli {
        use super::*;
        use crate::testutil::script;

        fn fake(d: &TempDir, body: &str) -> Cli {
            let path = d.join("fake-screenpilot.sh");
            script(&path, body);
            Cli {
                program: path.into_os_string(),
                prefix: vec![],
            }
        }

        #[test]
        fn set_secret_sends_the_key_on_stdin_only() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(
                &d,
                r#"printf '%s\n' "$@" > "$(dirname "$0")/args.txt"; env > "$(dirname "$0")/env.txt"; cat > "$(dirname "$0")/stdin.txt""#,
            );
            let key = "sk-test-SECRET-0123456789";
            set_secret(&cli, "elevenlabs", &format!("  {key}  ")).unwrap();
            assert_eq!(
                std::fs::read_to_string(d.join("stdin.txt")).unwrap(),
                format!("{key}\n")
            );
            let args = std::fs::read_to_string(d.join("args.txt")).unwrap();
            assert_eq!(args, "secret\nset\nelevenlabs\n");
            assert!(!args.contains(key));
            assert!(
                !std::fs::read_to_string(d.join("env.txt"))
                    .unwrap()
                    .contains(key),
                "the key is not in the environment"
            );
        }

        #[test]
        fn set_secret_failure_reports_stderr_without_the_key() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            // A CLI that (wrongly) echoes its input in the error: the key must still not come back.
            let cli = fake(
                &d,
                r#"k=$(cat); echo "rejected key $k: bad format" >&2; exit 3"#,
            );
            let key = "sk-leaky-1234567890";
            let err = set_secret(&cli, "gemini", key).unwrap_err();
            assert!(err.contains("exit 3"), "{err}");
            assert!(err.contains("rejected key ***"), "{err}");
            assert!(!err.contains(key), "{err}");
        }

        #[test]
        fn set_secret_rejects_bad_input_before_running_anything() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(&d, "touch \"$(dirname \"$0\")/ran\"");
            assert!(set_secret(&cli, "edge", "k").is_err());
            assert!(set_secret(&cli, "gemini", "   ").is_err());
            let err = set_secret(&cli, "gemini", "line1\nline2-secret").unwrap_err();
            assert!(!err.contains("secret"), "{err}");
            assert!(!d.join("ran").exists());
        }

        #[test]
        fn remove_secret_and_providers_read_the_cli_json() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(
                &d,
                r#"case "$2" in
  remove) echo '{"provider":"gemini","removed":true}';;
  status) echo '{"elevenlabs":"file","gemini":null}';;
esac"#,
            );
            assert!(remove_secret(&cli, "gemini").unwrap());
            let list = providers(&cli);
            assert_eq!(list[3].key.as_deref(), Some("file"));
            assert_eq!(list[4].key, None);
        }

        #[test]
        fn endpoint_set_clear_and_status_read_the_cli_json() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(
                &d,
                r#"printf '%s\n' "$@" >> "$(dirname "$0")/args.txt"
case "$2" in
  set) echo '{"provider":"elevenlabs","baseUrl":"https://api.eu.residency.elevenlabs.io","file":"/x"}';;
  clear) echo '{"provider":"gemini","cleared":true}';;
  status) echo '{"elevenlabs":{"baseUrl":"https://api.elevenlabs.io","source":"env"},"gemini":{"error":"Bad gemini base URL from providers.gemini.baseUrl in v.json: x"}}';;
  *) echo '{"removed":false}';;
esac"#,
            );
            assert_eq!(
                set_endpoint(&cli, "elevenlabs", " eu ").unwrap(),
                "https://api.eu.residency.elevenlabs.io"
            );
            assert!(clear_endpoint(&cli, "gemini").unwrap());
            let list = providers(&cli);
            let eleven = list[3].endpoint.as_ref().unwrap();
            assert_eq!(
                (eleven.base_url.as_str(), eleven.source.as_str()),
                ("https://api.elevenlabs.io", "env")
            );
            assert!(list[4].endpoint.as_ref().unwrap().error.is_some());
            assert_eq!(
                std::fs::read_to_string(d.join("args.txt")).unwrap(),
                "endpoint\nset\nelevenlabs\neu\nendpoint\nclear\ngemini\nsecret\nstatus\nendpoint\nstatus\n"
            );
        }

        #[test]
        fn endpoint_errors_come_from_stderr_and_bad_input_runs_nothing() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(
                &d,
                "echo 'Bad gemini base URL: not a web address' >&2; exit 1",
            );
            let err = set_endpoint(&cli, "gemini", "nope").unwrap_err();
            assert!(err.contains("not a web address"), "{err}");
            assert!(clear_endpoint(&cli, "gemini").is_err());

            let d = TempDir::new();
            let cli = fake(&d, "touch \"$(dirname \"$0\")/ran\"");
            assert!(set_endpoint(&cli, "gemini", "  ").is_err());
            assert!(set_endpoint(&cli, "edge", "eu").is_err());
            assert!(clear_endpoint(&cli, "edge").is_err());
            assert!(!d.join("ran").exists());
        }

        #[test]
        fn an_older_cli_without_endpoint_shows_no_base_url() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(
                &d,
                r#"case "$1" in
  secret) echo '{"elevenlabs":"file","gemini":null}';;
  *) echo "error: unknown command 'endpoint'" >&2; exit 1;;
esac"#,
            );
            let list = providers(&cli);
            assert_eq!(list[3].key.as_deref(), Some("file"));
            assert!(list.iter().all(|p| p.endpoint.is_none()));
        }

        #[test]
        fn providers_survive_a_broken_cli() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(&d, "exit 1");
            let list = providers(&cli);
            assert_eq!(list.len(), 5);
            assert!(list.iter().all(|p| p.key.is_none()));
            let missing = Cli {
                program: d.join("no-such-cli").into_os_string(),
                prefix: vec![],
            };
            assert_eq!(providers(&missing).len(), 5);
        }

        #[test]
        fn list_voices_parses_and_passes_the_provider() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(
                &d,
                r#"echo "$@" > "$(dirname "$0")/args.txt"
echo '[{"name":"en-US-AndrewNeural","locale":"en-US","gender":"Male","langs":["en"]},{"name":"x","locale":"ar"},{"bad":1}]'"#,
            );
            let voices = list_voices(&cli, "edge").unwrap();
            assert_eq!(
                voices,
                vec![
                    Voice {
                        name: "en-US-AndrewNeural".into(),
                        locale: "en-US".into(),
                        gender: Some("Male".into())
                    },
                    Voice {
                        name: "x".into(),
                        locale: "ar".into(),
                        gender: None
                    }
                ]
            );
            assert_eq!(
                std::fs::read_to_string(d.join("args.txt")).unwrap().trim(),
                "voices --provider edge"
            );
            assert!(list_voices(&cli, "nope").is_err());
        }

        #[test]
        fn list_voices_failure_is_an_error_string() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let cli = fake(&d, "echo 'no network' >&2; exit 2");
            let err = list_voices(&cli, "elevenlabs").unwrap_err();
            assert!(err.contains("no network"), "{err}");
        }

        #[test]
        fn run_render_starts_the_cli_detached() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let sb = d.join("storyboard.json");
            std::fs::write(&sb, "{}").unwrap();
            let cli = fake(
                &d,
                r#"printf '%s\n' "$@" > "$(dirname "$0")/args.txt"; pwd > "$(dirname "$0")/cwd.txt""#,
            );
            run_render(&cli, sb.to_str().unwrap(), "looks").unwrap();
            let args = d.join("args.txt");
            for _ in 0..200 {
                if args.exists() && d.join("cwd.txt").exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            std::thread::sleep(Duration::from_millis(50));
            assert_eq!(
                std::fs::read_to_string(args).unwrap(),
                format!("render\n{}\n-q\nlooks\n", sb.display())
            );
            assert!(run_render(&cli, sb.to_str().unwrap(), "best").is_err());
        }

        #[test]
        fn a_missing_cli_is_a_clear_error() {
            let _serial = crate::testutil::serial();
            let d = TempDir::new();
            let missing = Cli {
                program: d.join("no-such-cli").into_os_string(),
                prefix: vec![],
            };
            let sb = d.join("storyboard.json");
            std::fs::write(&sb, "{}").unwrap();
            assert!(run_render(&missing, sb.to_str().unwrap(), "draft")
                .unwrap_err()
                .contains("cannot start"));
            assert!(set_secret(&missing, "gemini", "k")
                .unwrap_err()
                .contains("cannot start"));
        }
    }
}

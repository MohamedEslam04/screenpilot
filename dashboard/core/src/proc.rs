//! Spawning helpers. Every program is started with `Command` and explicit arguments, never a shell.

use std::io::{self, Read, Write};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const MAX_STDOUT: u64 = 16 * 1024 * 1024;
const MAX_STDERR: u64 = 64 * 1024;

pub struct Captured {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// No console window flashing up on Windows; a no-op elsewhere.
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Start a program that outlives us: no stdio, its own process group, reaped by a thread so it
/// never lingers as a zombie while the dashboard runs.
pub fn spawn_detached(cmd: &mut Command) -> io::Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Run to the end with `stdin` written to it (then closed), collecting stdout and stderr (capped).
/// Kills the child after `timeout`.
pub fn run_capture(
    cmd: &mut Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Captured, String> {
    quiet(cmd);
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", cmd.get_program().to_string_lossy()))?;

    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // The child may exit without reading (a bad argument): that is reported by its exit code.
        let _ = pipe.write_all(data);
    }
    let drain = |r: Option<Box<dyn Read + Send>>, cap: u64| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = (&mut r).take(cap).read_to_end(&mut buf);
                let _ = io::copy(&mut r, &mut io::sink()); // keep the child from blocking on a full pipe
            }
            buf
        })
    };
    let out = drain(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        MAX_STDOUT,
    );
    let err = drain(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        MAX_STDERR,
    );

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                // The reader threads are left to finish on their own: a grandchild may hold the pipes.
                return Err(format!(
                    "{} did not finish in {} s",
                    cmd.get_program().to_string_lossy(),
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(e) => {
                return Err(format!(
                    "cannot wait for {}: {e}",
                    cmd.get_program().to_string_lossy()
                ))
            }
        }
    };
    Ok(Captured {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// The first `max` characters of what a program wrote to stderr, one line, with `secret` removed.
pub fn short_stderr(stderr: &[u8], secret: Option<&str>, max: usize) -> String {
    let mut text = String::from_utf8_lossy(stderr).trim().to_string();
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        text = text.replace(s, "***");
    }
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(max).collect()
}

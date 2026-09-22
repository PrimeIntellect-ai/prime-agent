//! Child-process helpers for the package manager: an inherit-stdio runner for
//! user-facing installs (`npm install`, `git clone`) and a capturing runner
//! with a timeout for network probes (`npm view`, `git ls-remote`). Error
//! strings are part of the CLI parity surface.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Poll interval for the capture timeout loop.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Run a command with inherited stdio, failing on a non-zero exit.
pub fn run_command(
    program: &str,
    args: &[&str],
    cwd: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let status = command
        .status()
        .map_err(|error| anyhow::anyhow!("{}", spawn_error(program, &error)))?;
    if status.success() {
        return Ok(());
    }
    let exit_status = match status.code() {
        Some(code) => format!("code {code}"),
        None => format!("signal {}", signal_name(status)),
    };
    anyhow::bail!("{program} {} failed with {exit_status}", args.join(" "));
}

/// Run a command capturing stdout/stderr, trimmed like the TS capture helper.
pub fn run_command_capture(
    program: &str,
    args: &[&str],
    cwd: Option<&std::path::Path>,
    timeout: Option<Duration>,
    env: &[(&str, &str)],
) -> anyhow::Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|error| anyhow::anyhow!("{}", spawn_error(program, &error)))?;

    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                if status.success() {
                    return Ok(stdout.trim().to_string());
                }
                let exit_status = match status.code() {
                    Some(code) => format!("code {code}"),
                    None => format!("signal {}", signal_name(status)),
                };
                let detail = if stderr.trim().is_empty() {
                    stdout
                } else {
                    stderr
                };
                anyhow::bail!(
                    "{program} {} failed with {exit_status}: {}",
                    args.join(" "),
                    detail.trim_end()
                );
            }
            Ok(None) => {
                if let Some(deadline) = deadline {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        anyhow::bail!(
                            "{program} {} timed out after {}ms",
                            args.join(" "),
                            timeout.map_or(0, |t| t.as_millis())
                        );
                    }
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) => anyhow::bail!("{program} {} failed: {error}", args.join(" ")),
        }
    }
}

/// Node-style spawn failure text (`spawn npm ENOENT`).
fn spawn_error(program: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return format!("spawn {program} ENOENT");
    }
    format!("spawn {program} failed: {error}")
}

fn signal_name(status: std::process::ExitStatus) -> String {
    crate::platform::process::termination_signal(&status)
        .map(|signal| signal.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_trims_stdout_and_reports_failures() {
        let out = run_command_capture("echo", &["-n", " hi "], None, None, &[]).unwrap();
        assert_eq!(out, "hi");
        let error = run_command_capture("sh", &["-c", "echo boom >&2; exit 3"], None, None, &[])
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "sh -c echo boom >&2; exit 3 failed with code 3: boom"
        );
    }

    #[test]
    fn capture_times_out() {
        let error =
            run_command_capture("sleep", &["5"], None, Some(Duration::from_millis(200)), &[])
                .unwrap_err();
        assert_eq!(error.to_string(), "sleep 5 timed out after 200ms");
    }
}

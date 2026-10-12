//! `prime-agent tailscale`: the Tailscale detection core.
//!
//! [`probe_tailscale`] is the detection seam the tailnet agent mesh builds on
//! (peer discovery, remote sessions labeled with their tailscale connection,
//! cross-machine messaging/spawn). This module ships the detection itself:
//! the `tailscale` command group and the `doctor` fact. The mesh layers ship
//! separately.
//!
//! Every `tailscale` CLI spawn is bounded by a timeout (15 s for probes, a
//! 60 s interactive serve/funnel call), so a hung `tailscaled` cannot wedge
//! the command, and the whole `status --json` payload is read: a large
//! tailnet's payload carries every peer and must not truncate. The public
//! commands resolve the CLI to an absolute trusted path before spawning
//! (`probe::resolve_tailscale_binary`): a `PATH` entry an attacker can plant in -
//! a relative entry, which resolves to the current directory, or an entry
//! naming the current directory itself - can never supply the binary that
//! runs with the CLI's credentials and environment, and the chosen candidate
//! must be executable by this process (`access(2)` `X_OK`, not just any
//! execute bit): a first entry usable only by an unrelated group yields to a
//! later entry instead of stranding the CLI behind a permission-denied spawn.
//!
//! Submodules by responsibility: `probe` (detection and trusted-path
//! resolution), `args` (argv parsing), `status` (the status command),
//! `serve` (the serve command and post-serve verification), and `format`
//! (ANSI styling). The shared types and the subprocess primitive stay here.

use std::ffi::OsStr;
use std::time::Duration;

use serde_json::Value;

pub(crate) mod format;

mod args;
mod probe;
mod serve;
mod status;

pub(crate) use args::{parse_tailscale_args, TailscaleArgs};
pub(crate) use probe::{doctor_facts, probe_tailscale};
pub(crate) use serve::run_serve;
pub(crate) use status::run_status;

/// The CLI this module wraps (the TS `cliPath` value).
pub(crate) const TAILSCALE_BINARY: &str = "tailscale";

/// Bound on every probe call (TS `timeout: 15000`).
const TAILSCALE_TIMEOUT: Duration = Duration::from_secs(15);

/// This node's tailnet state (TS `TailscaleProbe`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TailscaleProbe {
    /// `Some("tailscale")` when the CLI was found and ran, `None` when absent.
    pub(crate) cli_path: Option<String>,
    /// True when this node is up on a tailnet right now.
    pub(crate) on_tailnet: bool,
    /// The tailnet's `MagicDNS` suffix (e.g. `tailnet-name.ts.net.`), or `None`.
    pub(crate) magic_dns_suffix: Option<String>,
    /// This node's tailnet hostname (without the suffix), or `None`.
    pub(crate) hostname: Option<String>,
    /// True when the backend is Running but the node is not online right now.
    pub(crate) offline_but_up: bool,
    /// The raw error line when the CLI exists but reports a failure.
    pub(crate) error: Option<String>,
}

/// One `tailscale` invocation's result (TS `runTailscale`'s return).
#[derive(Debug)]
struct TailscaleRun {
    /// The exit code, or -1 when the CLI could not be spawned or timed out.
    code: i32,
    stdout: String,
    stderr: String,
    /// The spawn failure kind; [`std::io::ErrorKind::NotFound`] is the
    /// binary-absent case.
    spawn_error: Option<std::io::ErrorKind>,
}

/// Run the tailscale CLI once, returning stdout/stderr or an error descriptor.
async fn run_tailscale(program: &OsStr, args: &[&str]) -> TailscaleRun {
    let output = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(TAILSCALE_TIMEOUT, output).await {
        Ok(Ok(output)) => TailscaleRun {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            spawn_error: None,
        },
        Ok(Err(error)) => TailscaleRun {
            code: -1,
            stdout: String::new(),
            stderr: error.to_string(),
            spawn_error: Some(error.kind()),
        },
        Err(_) => TailscaleRun {
            code: -1,
            stdout: String::new(),
            stderr: format!(
                "tailscale {args:?} timed out after {}s",
                TAILSCALE_TIMEOUT.as_secs()
            ),
            spawn_error: None,
        },
    }
}

/// Parse `tailscale serve status --json`. A tailnet with nothing served answers
/// a bare `null` (valid JSON and the common empty-config encoding), so
/// normalize a null payload to an empty serve config before any property
/// access; otherwise the status command and post-serve verification read a
/// valid empty config as unparseable output.
fn parse_serve_status(stdout: &str) -> Result<Value, serde_json::Error> {
    let parsed: Value = serde_json::from_str(stdout)?;
    Ok(match parsed {
        Value::Null => serde_json::json!({}),
        other => other,
    })
}

/// Trim the trailing dots a tailnet DNS name carries (`host.tailnet.ts.net.`).
fn trim_trailing_dots(value: &str) -> &str {
    value.trim_end_matches('.')
}

/// Drive the async detection core from the synchronous public-command path
/// (the CLI's usual current-thread-runtime bridge, mirroring `provider_login`).
fn block_on<F: std::future::Future>(future: F) -> Option<F::Output> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
        .map(|runtime| runtime.block_on(future))
}

/// `prime-agent tailscale` status (exit code): the sync bridge. The CLI
/// resolves to an absolute trusted path first (`probe::trusted_tailscale_path`);
/// a resolution failure presents as an absent CLI, never as an untrusted
/// spawn.
pub(crate) fn run_tailscale_status(json: bool) -> i32 {
    let program = probe::trusted_tailscale_path();
    block_on(run_status(program.as_os_str(), json)).unwrap_or(1)
}

/// `prime-agent tailscale serve` (exit code): the sync bridge, through the
/// same trusted resolution.
pub(crate) fn run_tailscale_serve(port: f64, funnel: bool) -> i32 {
    let program = probe::trusted_tailscale_path();
    block_on(run_serve(program.as_os_str(), port, funnel)).unwrap_or(1)
}

/// The `doctor` fact lines: the sync bridge, through the same trusted
/// resolution.
pub(crate) fn tailscale_doctor_facts() -> Vec<String> {
    let program = probe::trusted_tailscale_path();
    block_on(doctor_facts(program.as_os_str())).unwrap_or_default()
}

#[cfg(all(test, unix))]
#[path = "tests.rs"]
mod tests;

//! Detection: probe the `tailscale` CLI for this node's tailnet state,
//! produce the `doctor` fact lines, and resolve the CLI to the absolute
//! trusted path every public spawn goes through.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use pa_core::platform::{is_executable, is_executable_by_process};
use serde_json::Value;

use super::{run_tailscale, trim_trailing_dots, TailscaleProbe, TAILSCALE_BINARY};

/// Detect the CLI at `program` and, when present, this node's tailnet
/// state. The detection seam the mesh builds on: the public commands pass
/// [`trusted_tailscale_path`]'s resolution, tests and the mesh pass their
/// own path.
pub(crate) async fn probe_tailscale(program: &OsStr) -> TailscaleProbe {
    let version = run_tailscale(program, &["version"]).await;
    if let Some(kind) = version.spawn_error {
        // A binary-absent spawn is genuinely absent; any other failure (a
        // permission problem, a hung CLI) is an installed-but-unusable CLI
        // and must say so instead of "not found".
        if kind == std::io::ErrorKind::NotFound {
            return TailscaleProbe::default();
        }
        return TailscaleProbe {
            cli_path: Some(TAILSCALE_BINARY.to_string()),
            error: Some(format!("tailscale CLI could not be run ({kind:?})")),
            ..TailscaleProbe::default()
        };
    }
    let cli_path = Some(TAILSCALE_BINARY.to_string());
    let status = run_tailscale(program, &["status", "--json"]).await;
    if status.code != 0 {
        let first_line = status.stderr.split('\n').next().unwrap_or_default().trim();
        let error = if first_line.is_empty() {
            "tailscale status failed with no diagnostic".to_string()
        } else {
            first_line.to_string()
        };
        return TailscaleProbe {
            cli_path,
            error: Some(error),
            ..TailscaleProbe::default()
        };
    }
    match serde_json::from_str::<Value>(&status.stdout) {
        Ok(parsed) => {
            // BackendState distinguishes a stopped/logged-out daemon from a node
            // that is up but temporarily unreachable; only Running serves.
            let backend = parsed
                .get("BackendState")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let self_field = parsed.get("Self");
            let online = self_field
                .and_then(|value| value.get("Online"))
                .and_then(Value::as_bool);
            // An empty or dot-only `DNSName` carries no name, so it yields to
            // `HostName` instead of winning the choice and then trimming to
            // no hostname (which serve would advertise as `.<suffix>`).
            let dns_name =
                node_name(self_field, "DNSName").or_else(|| node_name(self_field, "HostName"));
            // Top-level MagicDNSSuffix is deprecated upstream; prefer
            // CurrentTailnet's. An empty or dot-only suffix carries no
            // domain, so it reads as absent and yields to the next candidate
            // instead of blocking it (serve would otherwise trim it to no
            // suffix and advertise a trailing-dot host like `milk.`).
            let suffix = magic_dns_suffix(parsed.get("CurrentTailnet"))
                .or_else(|| magic_dns_suffix(Some(&parsed)))
                .map(str::to_string);
            let hostname = dns_name
                .map(|name| {
                    let mut host = trim_trailing_dots(name).to_string();
                    if let Some(suffix) = &suffix {
                        let suffix = trim_trailing_dots(suffix);
                        if let Some(stripped) = host.strip_suffix(&format!(".{suffix}")) {
                            host = stripped.to_string();
                        }
                    }
                    host
                })
                // The hostname is either a real machine label or nothing: a
                // name that trims or strips to empty must never surface as an
                // empty host (serve would advertise it as `.<suffix>`).
                .filter(|host| !host.is_empty());
            TailscaleProbe {
                cli_path,
                on_tailnet: online == Some(true) || backend == "Running",
                magic_dns_suffix: suffix,
                hostname,
                offline_but_up: backend == "Running" && online == Some(false),
                error: None,
            }
        }
        Err(error) => TailscaleProbe {
            cli_path,
            error: Some(format!("unparseable status output: {error}")),
            ..TailscaleProbe::default()
        },
    }
}

/// The raw `Self.<field>` name when it carries a real hostname: empty and
/// dot-only strings trim to no hostname, so they read as absent and the next
/// candidate (e.g. `HostName`) takes over.
fn node_name<'a>(self_field: Option<&'a Value>, field: &str) -> Option<&'a str> {
    self_field
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
        .filter(|name| !trim_trailing_dots(name).is_empty())
}

/// The raw `MagicDNSSuffix` field of `object` when it carries a real domain:
/// empty and dot-only strings trim to no suffix, so they read as absent and
/// the next candidate (the deprecated top-level suffix) takes over.
fn magic_dns_suffix(object: Option<&Value>) -> Option<&str> {
    object
        .and_then(|value| value.get("MagicDNSSuffix"))
        .and_then(Value::as_str)
        .filter(|suffix| !trim_trailing_dots(suffix).is_empty())
}

/// One-line doctor facts for `prime-agent doctor` (TS `tailscaleDoctorFacts`).
pub(crate) async fn doctor_facts(program: &OsStr) -> Vec<String> {
    let probe = probe_tailscale(program).await;
    if let Some(error) = &probe.error {
        return vec![format!("tailscale: CLI present but erroring ({error})")];
    }
    if probe.cli_path.is_none() {
        return vec![
            "tailscale: CLI not found (optional; install from https://tailscale.com/download)"
                .to_string(),
        ];
    }
    if !probe.on_tailnet {
        return vec!["tailscale: installed but not up on a tailnet (tailscale up)".to_string()];
    }
    let offline = if probe.offline_but_up {
        " (currently offline)"
    } else {
        ""
    };
    vec![format!(
        "tailscale: on tailnet (node {}, MagicDNS {}{offline})",
        probe.hostname.as_deref().unwrap_or("unknown"),
        probe.magic_dns_suffix.as_deref().unwrap_or("unknown")
    )]
}

/// A spawn target that cannot exist: the stand-in the public commands pass
/// when no trusted `PATH` entry holds the CLI, so the probe reports the CLI
/// as absent instead of executing anything untrusted.
const NO_TRUSTED_TAILSCALE: &str = "/nonexistent/tailscale-cli-not-found-on-a-trusted-path";

/// The `tailscale` program name a `PATH` entry is probed with: Windows
/// installs `tailscale.exe` (what a bare `tailscale` spawn used to resolve
/// through `PATHEXT`); everywhere else the binary is `tailscale`.
fn tailscale_program_name() -> &'static str {
    if cfg!(windows) {
        "tailscale.exe"
    } else {
        TAILSCALE_BINARY
    }
}

/// The `tailscale` CLI the public commands spawn: [`resolve_tailscale_binary`]
/// over the ambient `PATH`, or [`NO_TRUSTED_TAILSCALE`] when no trusted entry
/// holds it.
pub(super) fn trusted_tailscale_path() -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::new());
    resolve_tailscale_binary(&path, &cwd, tailscale_program_name())
        .unwrap_or_else(|| PathBuf::from(NO_TRUSTED_TAILSCALE))
}

/// Resolve the `tailscale` CLI over `path_env` to the absolute path the
/// public commands spawn. Which-style first match over `program` (the
/// platform's binary name, see [`tailscale_program_name`]), but fail
/// closed:
///
/// - only absolute `PATH` entries are considered; a relative entry (including
///   the empty entry) resolves to the current directory, whose contents are
///   not this command's to trust;
/// - an entry that *is* the current directory is skipped the same way, so a
///   `./tailscale` planted in the working directory can never supply the
///   binary that runs with the CLI's credentials and environment;
/// - a candidate must be executable by this process (`access(2)` `X_OK`), not
///   just carry an execute bit: a first entry executable only by an unrelated
///   group yields to a later usable entry instead of failing to spawn with
///   permission denied.
pub(crate) fn resolve_tailscale_binary(
    path_env: &OsStr,
    cwd: &Path,
    program: &str,
) -> Option<PathBuf> {
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    std::env::split_paths(path_env)
        .filter(|entry| entry.is_absolute())
        .filter(|entry| std::fs::canonicalize(entry).map_or(true, |real| real != cwd))
        .map(|entry| entry.join(program))
        .find(|candidate| {
            // The platform execute-bit probe, narrowed to regular files:
            // `pa_core`'s unix arm accepts any mode with an execute bit, and
            // a `PATH` entry holding a directory named like the program must
            // not resolve. The any-bit probe alone would also accept a file
            // this process cannot execute (its only execute bit belongs to an
            // unrelated group): the spawn would die with permission denied
            // and strand a usable CLI in a later entry, so the access check
            // decides for this process and the search falls through.
            candidate.is_file() && is_executable(candidate) && is_executable_by_process(candidate)
        })
}

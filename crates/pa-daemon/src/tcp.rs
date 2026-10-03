//! The daemon's tailnet TCP listener (port of TS #2517 `daemon-tcp.ts`).
//!
//! The listener serves the same JSONL protocol and command dispatch as the
//! unix socket; the differences are all trust-shaped: every TCP command line
//! must carry the per-machine token, an untrusted peer's `daemon_hello` is
//! the protocol banner only, and a remote peer's connections are bounded
//! (per-line length, concurrent count, admission deadlines). The token and
//! every authenticated command cross this socket in plaintext, so the
//! listener binds this machine's Tailscale address by default and refuses
//! to start (fail closed) when no tailnet address exists and no bind host
//! was configured.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use pa_core::platform::{is_executable, is_executable_by_process};
use serde_json::Value;

/// Environment variable checked for the daemon TCP port (after the CLI
/// flag, before settings).
const DAEMON_TCP_PORT_ENV: &str = "PRIME_AGENT_DAEMON_PORT";
/// Environment variable checked for the daemon TCP bind host (after the
/// CLI flag, before settings).
const DAEMON_TCP_BIND_HOST_ENV: &str = "PRIME_AGENT_DAEMON_BIND_HOST";

/// Upper bound for one TCP command line; an oversized line closes the
/// connection instead of buffering without limit (TS #2517's
/// `DAEMON_TCP_MAX_LINE_CHARS`, the review round that bounded
/// unterminated remote lines).
pub const DAEMON_TCP_MAX_LINE_CHARS: usize = 1024 * 1024;
/// Refuses TCP connections once this many concurrent sockets are admitted
/// (TS #2517's `DAEMON_TCP_MAX_CONNECTIONS`, the review round that capped
/// unauthenticated idle sockets).
pub const DAEMON_TCP_MAX_CONNECTIONS: usize = 256;
/// Closes a TCP socket that sends no authenticated line within this
/// window, re-armed at `daemon_hello` (TS #2517's
/// `DAEMON_TCP_AUTH_TIMEOUT_MS`).
pub const DAEMON_TCP_AUTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Idle window for an authenticated TCP socket; any traffic resets it (TS
/// #2517's `DAEMON_TCP_IDLE_TIMEOUT_MS`).
pub const DAEMON_TCP_IDLE_TIMEOUT: Duration = Duration::from_mins(10);
/// Absolute admission budget for a TCP socket accepted before
/// `daemon_hello` can be written: the listener binds before the boot
/// passes complete, and mesh clients wait for hello before sending their
/// first token. The short auth deadline re-arms from the moment hello is
/// written (TS #2517's `DAEMON_TCP_PRE_READY_TIMEOUT_MS`, the review
/// round that stopped the auth window from closing pre-ready clients).
pub const DAEMON_TCP_PRE_READY_TIMEOUT: Duration = Duration::from_secs(120);
/// Bound on the bind-address probe's `tailscale status --json` spawn (TS
/// #2517's `DAEMON_TCP_TAILSCALE_TIMEOUT_MS`, SIGKILL past the window): the
/// probe runs during startup after the unix socket is bound but before the
/// accept loops serve, so a wedged `tailscaled` must die at the window
/// instead of parking the daemon with a bound-but-never-accepting socket.
const DAEMON_TCP_TAILSCALE_TIMEOUT: Duration = Duration::from_secs(15);

/// One TCP command line's auth verdict (TS `DaemonTcpAuthVerdict`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonTcpAuthVerdict {
    pub ok: bool,
    /// Correlatable response id when the line was JSON.
    pub id: String,
    /// Best-effort command name for the failure response.
    pub command: Option<String>,
    pub reason: &'static str,
}

/// The loaded (or first-created) per-machine token record.
#[derive(Debug, Clone)]
pub struct DaemonTcpTokenRecord {
    pub token: String,
    pub token_path: PathBuf,
    /// True when this load call created the token (first time).
    pub created: bool,
}

/// The token file's name inside the agent dir (TS: `daemon-tcp-token`,
/// no `.json` suffix - the docs review round pinned the real name).
pub const DAEMON_TCP_TOKEN_FILE_NAME: &str = "daemon-tcp-token";
const DAEMON_TCP_TOKEN_FILE: &str = DAEMON_TCP_TOKEN_FILE_NAME;

/// The token file path inside the agent dir (TS `daemonTcpTokenPath`).
fn daemon_tcp_token_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join(DAEMON_TCP_TOKEN_FILE)
}

/// Parse the port from an environment map. A present-but-invalid value is
/// a named error, never silently ignored (TS `daemonTcpPortFromEnv`).
fn daemon_tcp_port_from_env(env: &HashMap<String, String>) -> Result<Option<u16>> {
    let Some(raw) = env.get(DAEMON_TCP_PORT_ENV).filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let invalid = || {
        anyhow!(
            "Invalid {DAEMON_TCP_PORT_ENV}: \"{raw}\" (expected an integer between 1 and 65535)"
        )
    };
    let port: u16 = raw.parse().map_err(|_| invalid())?;
    if (1..=u16::MAX).contains(&port) {
        return Ok(Some(port));
    }
    Err(invalid())
}

/// Resolve the daemon TCP port. Precedence: explicit CLI flag > env var >
/// settings `daemonPort` (TS `resolveDaemonTcpPort`). Returns `Ok(None)`
/// when no source provides a port (the listener stays off; zero behavior
/// change when unset).
///
/// # Errors
///
/// Returns an error when the env variable is present but invalid; a
/// settings port outside 1..=65535 reads as unset (TS parity).
pub fn resolve_daemon_tcp_port(
    explicit: Option<u16>,
    settings_port: Option<u16>,
    env: &HashMap<String, String>,
) -> Result<Option<u16>> {
    if let Some(port) = explicit.filter(|port| (1..=u16::MAX).contains(port)) {
        return Ok(Some(port));
    }
    Ok(daemon_tcp_port_from_env(env)?
        .or(settings_port)
        .filter(|port| (1..=u16::MAX).contains(port)))
}

/// True for a bind host that listens on every interface. The IPv6 side
/// accepts every spelling of the unspecified address - `::`, `::0`, the
/// fully expanded `0:0:0:0:0:0:0:0`, and group-compressed mixes like
/// `0:0::` all bind the wildcard interface, so a classifier that only
/// knows `::` would skip the plaintext-token exposure warning for the
/// others (TS #2517's review round: all IPv6 spellings must classify).
#[must_use]
pub fn is_wildcard_bind_host(host: &str) -> bool {
    if host == "0.0.0.0" {
        return true;
    }
    match host.parse::<std::net::Ipv6Addr>() {
        // Every group is zero or compressed away; any non-zero group is a
        // real address (`::1`, `fd7a:115c:a1e0::1`, `fe80::` stay negative).
        Ok(address) => address.segments().iter().all(|segment| *segment == 0),
        Err(_) => false,
    }
}

/// Validate one configured bind host, naming the source that supplied it
/// (TS `daemonTcpBindHostFromSource`): an IP literal binds exactly one
/// interface; a hostname would resolve through DNS at listen time and
/// could dodge the tailnet-only default.
fn daemon_tcp_bind_host_from_source(raw: &str, source: &str) -> Result<IpAddr> {
    raw.trim().parse::<IpAddr>().map_err(|_| {
        anyhow!(
            "Invalid {source}: \"{raw}\" (expected an IP address, e.g. the tailnet address of this machine)"
        )
    })
}

/// Resolve the host the daemon TCP listener binds. Precedence mirrors the
/// port: explicit CLI flag > env var > settings `daemonTcpBindHost` > the
/// machine's Tailscale address (TS `resolveDaemonTcpListenerHost`). The
/// token and every authenticated command travel in plaintext, so the
/// listener only widens past the tailnet when a source above asks for it
/// explicitly; a wildcard default is never returned.
///
/// # Errors
///
/// Returns an error when no source provides a host and the probe cannot
/// find a tailnet address (fail closed), or when a configured source is
/// not an IP literal.
///
/// Test-only: the lib resolves through
/// [`resolve_daemon_tcp_listener_host_production`]; this seam exists for
/// the probe-injected precedence tests (the shared core is
/// [`configured_daemon_tcp_listener_host`]).
#[cfg(test)]
pub fn resolve_daemon_tcp_listener_host(
    explicit: Option<&str>,
    settings_host: Option<&str>,
    env: &HashMap<String, String>,
    probe: &dyn Fn() -> Option<IpAddr>,
) -> Result<IpAddr> {
    if let Some(host) = configured_daemon_tcp_listener_host(explicit, settings_host, env)? {
        return Ok(host);
    }
    probe().ok_or_else(daemon_tcp_bind_host_missing)
}

/// The configured bind host when a source provides one (the precedence
/// chain the pure resolver and the production probe share): explicit CLI
/// flag > env var > settings `daemonTcpBindHost`, first non-empty source
/// wins (including its parse error).
fn configured_daemon_tcp_listener_host(
    explicit: Option<&str>,
    settings_host: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<Option<IpAddr>> {
    let candidates = [
        (explicit, "--daemon-bind"),
        (
            env.get(DAEMON_TCP_BIND_HOST_ENV).map(String::as_str),
            DAEMON_TCP_BIND_HOST_ENV,
        ),
        (settings_host, "settings daemonTcpBindHost"),
    ];
    for (value, source) in candidates {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            return daemon_tcp_bind_host_from_source(value, source).map(Some);
        }
    }
    Ok(None)
}

/// The fail-closed refusal when no source provides a host and the probe
/// cannot find a tailnet address (a wildcard default is never returned).
fn daemon_tcp_bind_host_missing() -> anyhow::Error {
    anyhow!(
        "Refusing to start the daemon TCP listener: this machine has no Tailscale address to bind and no bind host was configured. The per-machine token travels in plaintext over TCP, so the listener binds the tailnet only. Set {DAEMON_TCP_BIND_HOST_ENV}, the --daemon-bind flag, or settings daemonTcpBindHost to the local address to listen on (only when that network is trusted), or unset the daemon port to disable the listener."
    )
}

/// The tailscale CLI this module spawns: which-style first match over the
/// ambient `PATH`, but fail closed. Mirrors the detection core's
/// trusted-path resolution (the #3181 tailscale probe, the CLI's
/// `resolve_tailscale_binary`) exactly.
fn trusted_tailscale_path() -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let cwd = std::env::current_dir().ok()?;
    trusted_tailscale_path_over(&path_env, &cwd)
}

/// The trusted-path resolver core: which-style first match over `path_env`
/// for the `tailscale` program, fail closed (the CLI detection core's
/// contract, kept the same on both sides of the daemon/CLI split - the
/// probe's output picks the listener's bind address, so a weaker lookup
/// here would let a planted binary name the interface the plaintext
/// token rides):
///
/// - only absolute `PATH` entries are considered (a relative entry, or an
///   entry that is the current directory, resolves to
///   attacker-controllable contents);
/// - an entry that *is* the current directory is skipped canonically
///   (`canonicalize` on both sides), so a `./tailscale` planted in the
///   working directory - reached through an absolute entry that is a
///   symlink to it - can never supply the binary either;
/// - a candidate must be executable by this process, not just present:
///   a first entry whose `tailscale` is a non-executable file yields to a
///   later usable CLI instead of stranding it (the spawn would die with
///   permission denied and fail-close the listener).
fn trusted_tailscale_path_over(path_env: &OsStr, cwd: &Path) -> Option<PathBuf> {
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let program = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    std::env::split_paths(path_env)
        .filter(|entry| entry.is_absolute())
        .filter(|entry| std::fs::canonicalize(entry).map_or(true, |real| real != cwd))
        .map(|entry| entry.join(program))
        .find(|candidate| {
            candidate.is_file() && is_executable(candidate) && is_executable_by_process(candidate)
        })
}

/// Resolve this machine's own Tailscale address for the default listener
/// bind (TS `detectTailscaleBindAddress`; module-private by design - the
/// review round that unexported the TS helper keeps it an internal seam).
/// Returns `None` when the CLI is missing, the node is not up on a
/// tailnet, or the status carries no usable address, so the caller can
/// refuse to bind instead of widening to a wildcard interface. The state
/// read mirrors the detection core's probe: `tailscale status --json`,
/// `Self.Online`/`BackendState` (a Running-but-offline daemon keeps its
/// assigned address), IPv4 preferred.
async fn detect_tailscale_bind_address() -> Option<IpAddr> {
    let program = trusted_tailscale_path()?;
    detect_tailscale_bind_address_with(&program, DAEMON_TCP_TAILSCALE_TIMEOUT).await
}

/// One bounded `tailscale status --json` probe (TS `detectTailscaleBindAddress`'s
/// `timeout: DAEMON_TCP_TAILSCALE_TIMEOUT_MS`, `killSignal: SIGKILL`): the
/// spawn dies at `timeout` instead of parking startup with it - the probe
/// runs after the unix socket is bound, and a wedged `tailscaled` must not
/// leave clients connected to a daemon that never accepts.
async fn detect_tailscale_bind_address_with(program: &Path, timeout: Duration) -> Option<IpAddr> {
    let probe = tokio::process::Command::new(program)
        .args(["status", "--json"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(timeout, probe).await else {
        return None;
    };
    if !output.status.success() {
        return None;
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).ok()?;
    let self_field = parsed.get("Self")?;
    let online = self_field.get("Online").and_then(Value::as_bool);
    let backend = parsed.get("BackendState").and_then(Value::as_str);
    // BackendState covers a daemon that is Running but currently offline
    // (its address stays assigned); anything else has no address to bind.
    if online != Some(true) && backend != Some("Running") {
        return None;
    }
    let addresses = self_field
        .get("TailscaleIPs")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|address| address.as_str())
        .filter_map(|address| address.parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    // Tailscale assigns both a CGNAT IPv4 and an IPv6 address; IPv4 is the
    // one every peer on the tailnet can reach without extra configuration.
    addresses
        .iter()
        .find(|address| address.is_ipv4())
        .or_else(|| addresses.first())
        .copied()
}

/// Resolve the listener bind host with the production probe (module-private
/// detection: the precedence core is shared with
/// [`resolve_daemon_tcp_listener_host`], whose tests inject their own
/// probe). The probe is the bounded `tailscale status --json` spawn: it
/// awaits instead of blocking, and a wedged `tailscaled` dies at
/// [`DAEMON_TCP_TAILSCALE_TIMEOUT`] instead of parking startup.
///
/// # Errors
///
/// See [`resolve_daemon_tcp_listener_host`].
pub async fn resolve_daemon_tcp_listener_host_production(
    explicit: Option<&str>,
    settings_host: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<IpAddr> {
    if let Some(host) = configured_daemon_tcp_listener_host(explicit, settings_host, env)? {
        return Ok(host);
    }
    detect_tailscale_bind_address()
        .await
        .ok_or_else(daemon_tcp_bind_host_missing)
}

/// Timing-safe token comparison that does not leak content through early
/// exit (TS `daemonTcpTokensMatch`): the length check leaks only the
/// length (which the wire format reveals anyway), and every byte
/// comparison completes regardless of mismatches.
fn daemon_tcp_tokens_match(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    let mut mismatch: u8 = 0;
    for (a, b) in actual.bytes().zip(expected.bytes()) {
        mismatch |= a ^ b;
    }
    mismatch == 0
}

/// Why a token read failed (the load distinguishes the cases): an empty
/// file may be a concurrent creator's in-flight open (the exclusive
/// create's window between the open and the write), while invalid content
/// is corruption the load must refuse.
#[derive(Debug)]
enum TokenReadError {
    /// The file exists but reads empty: a concurrent creator may still be
    /// mid-write.
    Empty,
    /// The file carries content that is not the token record.
    Corrupt(String),
    /// The read itself failed.
    Io(std::io::Error),
}

/// Render the token-read failure with the TS refusal wording.
fn token_read_error(agent_dir: &Path, error: TokenReadError) -> anyhow::Error {
    let token_path = daemon_tcp_token_path(agent_dir);
    match error {
        TokenReadError::Empty => anyhow!("daemon TCP token file {} is empty", token_path.display()),
        TokenReadError::Corrupt(message) => anyhow!("{message}"),
        TokenReadError::Io(error) => {
            anyhow!("daemon TCP token file {}: {error}", token_path.display())
        }
    }
}

/// Read the existing token without creating one. Returns `Ok(None)` when
/// unset; a corrupt file (invalid JSON, missing token) is a named error
/// the caller refuses to overwrite, and an empty file is its own case -
/// under a concurrent start it is the winner's in-flight open (TS
/// `readDaemonTcpToken` throws on it because `writeFileSync`'s
/// create-and-write is one call; Rust's open-then-write widens that
/// window, so the load treats empty as a fall-through to the create
/// path, which converges on the winner or refuses after its budget).
///
/// # Errors
///
/// Returns an error when the token file exists but cannot be read, is
/// empty, is not valid JSON, or carries no token string.
fn read_daemon_tcp_token(agent_dir: &Path) -> Result<Option<String>, TokenReadError> {
    let token_path = daemon_tcp_token_path(agent_dir);
    if !token_path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&token_path)
        .map_err(TokenReadError::Io)?
        .trim()
        .to_string();
    if raw.is_empty() {
        return Err(TokenReadError::Empty);
    }
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| {
        TokenReadError::Corrupt(format!(
            "daemon TCP token file {} is not valid JSON",
            token_path.display()
        ))
    })?;
    let token = parsed
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty());
    match token {
        Some(token) => Ok(Some(token.to_string())),
        None => Err(TokenReadError::Corrupt(format!(
            "daemon TCP token file {} is missing its token",
            token_path.display()
        ))),
    }
}

/// Load or create the per-machine token used to authenticate TCP lines.
/// The token is stored as JSON in `<agent_dir>/daemon-tcp-token` with
/// owner-only permissions (0600). The create is exclusive: a concurrent
/// daemon must not overwrite a token its peer may already be
/// authenticating with; the race loser reads and reuses the winner's
/// token instead of writing a new one (TS #2517's review fix: exclusive
/// create + `EEXIST` loser reuse).
///
/// # Errors
///
/// Returns an error when the existing token file is corrupt (refused,
/// not regenerated) or cannot be written.
pub fn load_or_create_daemon_tcp_token(agent_dir: &Path) -> Result<DaemonTcpTokenRecord> {
    let token_path = daemon_tcp_token_path(agent_dir);
    // Refuse to overwrite a corrupt token file (the TS contract: the
    // daemon fails loudly instead of silently rotating the credential).
    match read_daemon_tcp_token(agent_dir) {
        Ok(Some(token)) => {
            // The owner-only restriction is idempotent: a file created
            // with wider permissions (or restored by a backup that
            // widened them) is re-restricted here, so the credential
            // never stays readable by a later start that merely reuses
            // it (the Bugbot round).
            let _ = pa_core::platform::perms::restrict_file(&token_path);
            return Ok(DaemonTcpTokenRecord {
                token,
                token_path,
                created: false,
            });
        }
        // An absent file, or an empty one, falls through to the create
        // path: under a concurrent start an empty file is the winner's
        // in-flight open (the exclusive create converges on the winner's
        // token, or refuses after the loser budget - never regenerates
        // over it); a lone empty file refuses on that same budget.
        Ok(None) | Err(TokenReadError::Empty) => {}
        Err(other) => return Err(token_read_error(agent_dir, other)),
    }
    std::fs::create_dir_all(agent_dir)?;
    let token = generate_token();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // The credential is owner-only FROM CREATION (TS's `{ mode: 0o600 }`):
    // an open with the default umask would leave the secret world-readable
    // for the window between the open and the post-write restriction.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&token_path) {
        Ok(mut file) => {
            let payload = format!("{}\n", serde_json::json!({ "token": token }));
            file.write_all(payload.as_bytes())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // The exclusive create lost the race: converge on the winner's
            // token so concurrent daemons authenticate with one credential.
            // The winner writes its content right after its exclusive open,
            // so a read that races ahead of the write retries briefly; a
            // loser that still cannot read rethrows instead of clobbering
            // (TS contract: never regenerate over a peer's credential).
            for _ in 0..80 {
                match read_daemon_tcp_token(agent_dir) {
                    Ok(Some(existing)) => {
                        return Ok(DaemonTcpTokenRecord {
                            token: existing,
                            token_path,
                            created: false,
                        })
                    }
                    // The winner's open landed but its write is still in
                    // flight: the file reads empty (or not yet exists);
                    // retry briefly.
                    Ok(None) | Err(TokenReadError::Empty) => {
                        std::thread::sleep(std::time::Duration::from_millis(25));
                    }
                    // Real corruption in the winner's file: never
                    // clobber it (the TS refusal contract).
                    Err(other) => return Err(token_read_error(agent_dir, other)),
                }
            }
            return Err(anyhow!(
                "daemon TCP token file {} was created concurrently and cannot be read",
                token_path.display()
            ));
        }
        Err(error) => {
            return Err(anyhow!(
                "daemon TCP token file {}: {error}",
                token_path.display()
            ))
        }
    }
    if let Err(error) = pa_core::platform::perms::restrict_file(&token_path) {
        return Err(anyhow!(
            "daemon TCP token file {}: permissions could not be restricted ({error})",
            token_path.display()
        ));
    }
    Ok(DaemonTcpTokenRecord {
        token,
        token_path,
        created: true,
    })
}

/// Generate a fresh 256-bit token (TS `randomBytes(32).toString("base64url")`):
/// two random v4 UUIDs concatenated = 64 hex chars over 256 random bits.
fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Check that a TCP command line carries the expected per-machine token
/// (TS `checkDaemonTcpLineAuth`). Only the daemon envelope
/// (`{"type":"command","command":{...},"auth":{"token"}}`) is
/// dispatchable: the supervisor requires the envelope protocol for every
/// client, unix included, so a raw `{"id","type","auth":{...}}` record
/// authenticates here and is then refused by the dispatcher with the
/// protocol-version error.
///
/// A JSON primitive such as `null` is rejected here (not dereferenced):
/// the TS review round pinned that a primitive must answer `invalid_json`
/// instead of throwing and taking the connection handler down with it.
#[must_use]
pub fn check_daemon_tcp_line_auth(line: &str, expected_token: &str) -> DaemonTcpAuthVerdict {
    let invalid = || DaemonTcpAuthVerdict {
        ok: false,
        id: "unknown".to_string(),
        command: None,
        reason: "invalid_json",
    };
    let parsed: Value = match serde_json::from_str(line) {
        Ok(parsed) => parsed,
        Err(_) => return invalid(),
    };
    // A JSON primitive (null, number, string, bool) or an array has no
    // fields to read; reject it as invalid JSON like the TS fix.
    let Some(object) = parsed.as_object() else {
        return invalid();
    };
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    // An envelope carries `type: "command"` and names the real command in
    // `command.type`, so the inner name wins; `type` stays the fallback
    // for a line that never reaches the dispatcher (TS #2517's review
    // fix: the refusal names the real command, not "command").
    let command = object
        .get("command")
        .and_then(|command| command.get("type"))
        .and_then(Value::as_str)
        .or_else(|| object.get("type").and_then(Value::as_str))
        .map(str::to_string);
    let token = object.get("auth").and_then(|auth| auth.get("token"));
    let authenticated = match token {
        Some(Value::String(token)) if !token.is_empty() => {
            daemon_tcp_tokens_match(token, expected_token)
        }
        _ => false,
    };
    if authenticated {
        return DaemonTcpAuthVerdict {
            ok: true,
            id,
            command,
            reason: "",
        };
    }
    let reason = match token {
        None | Some(Value::Null) => "missing_token",
        Some(Value::String(text)) if text.is_empty() => "missing_token",
        _ => "wrong_token",
    };
    DaemonTcpAuthVerdict {
        ok: false,
        id,
        command,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    // ------------------------------------------------------------------
    // Token store
    // ------------------------------------------------------------------

    /// First load creates the token (created flag); a second load reuses
    /// it; the file is JSON with the token string and owner-only
    /// permissions (TS `loadOrCreateDaemonTcpToken`).
    #[test]
    fn token_load_creates_then_reuses() {
        let dir = tempfile::TempDir::new().unwrap();
        let first = load_or_create_daemon_tcp_token(dir.path()).unwrap();
        assert!(first.created);
        assert_eq!(first.token.len(), 64, "256-bit token, hex");
        assert!(first.token_path.ends_with("daemon-tcp-token"));
        let second = load_or_create_daemon_tcp_token(dir.path()).unwrap();
        assert!(!second.created);
        assert_eq!(
            first.token, second.token,
            "the token is stable across daemons"
        );
    }

    /// The token file is 0600: only the owner may read the credential.
    #[cfg(unix)]
    #[test]
    fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().unwrap();
        let record = load_or_create_daemon_tcp_token(dir.path()).unwrap();
        let mode = std::fs::metadata(&record.token_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the token file must be 0600");
    }

    /// Corrupt token files are refused, not regenerated (TS: the daemon
    /// fails loudly instead of silently rotating the credential): empty,
    /// invalid JSON, and a missing token each reject the load.
    #[test]
    fn corrupt_token_files_are_refused_not_regenerated() {
        for (name, content) in [
            ("empty", ""),
            ("not-json", "not json"),
            ("missing-token", "{\"other\": true}"),
        ] {
            let dir = tempfile::TempDir::new().unwrap();
            std::fs::create_dir_all(dir.path()).unwrap();
            let path = dir.path().join("daemon-tcp-token");
            std::fs::write(&path, content).unwrap();
            let error = load_or_create_daemon_tcp_token(dir.path())
                .unwrap_err()
                .to_string();
            assert!(!error.is_empty(), "{name} must refuse");
            assert!(
                load_or_create_daemon_tcp_token(dir.path()).is_err(),
                "{name} must not regenerate"
            );
            // The corrupt file survives: the daemon never clobbers it.
            assert_eq!(
                std::fs::read_to_string(&path).unwrap().trim(),
                content.trim(),
                "{name} file must survive the refusal"
            );
        }
    }

    /// Concurrent creators converge on one token (TS's review fix: the
    /// exclusive create's race loser reuses the winner's token instead
    /// of clobbering the file the daemon may already be authenticating
    /// with).
    #[test]
    fn concurrent_creates_converge_on_one_token() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().to_path_buf();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let agent_dir = agent_dir.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                load_or_create_daemon_tcp_token(&agent_dir).unwrap()
            }));
        }
        let tokens: Vec<String> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().token)
            .collect();
        let distinct: std::collections::HashSet<&String> = tokens.iter().collect();
        assert_eq!(distinct.len(), 1, "all racers must converge on one token");
        // And the file carries the same winner's token.
        assert_eq!(
            read_daemon_tcp_token(&agent_dir).unwrap().as_deref(),
            Some(tokens[0].as_str())
        );
    }

    // ------------------------------------------------------------------
    // Port resolution
    // ------------------------------------------------------------------

    /// Precedence: CLI flag > env var > settings (TS
    /// `resolveDaemonTcpPort`); unset everywhere disables the listener.
    #[test]
    fn port_resolution_flag_over_env_over_settings() {
        let settings = Some(4100u16);
        assert_eq!(
            resolve_daemon_tcp_port(
                Some(4200),
                settings,
                &env(&[("PRIME_AGENT_DAEMON_PORT", "4300")])
            )
            .unwrap(),
            Some(4200),
            "the flag wins"
        );
        assert_eq!(
            resolve_daemon_tcp_port(None, settings, &env(&[("PRIME_AGENT_DAEMON_PORT", "4300")]))
                .unwrap(),
            Some(4300),
            "the env var beats the setting"
        );
        assert_eq!(
            resolve_daemon_tcp_port(None, settings, &HashMap::new()).unwrap(),
            Some(4100),
            "the setting is the last source"
        );
        assert_eq!(
            resolve_daemon_tcp_port(None, None, &HashMap::new()).unwrap(),
            None,
            "unset everywhere disables the listener"
        );
    }

    /// A present-but-invalid env port is a named error, never silently
    /// ignored (TS `daemonTcpPortFromEnv`); a settings port outside
    /// 1..=65535 reads as unset.
    #[test]
    fn invalid_port_sources() {
        for bad in ["0", "65536", "-1", "not-a-port"] {
            let error =
                resolve_daemon_tcp_port(None, None, &env(&[("PRIME_AGENT_DAEMON_PORT", bad)]))
                    .unwrap_err()
                    .to_string();
            assert!(
                error.contains("Invalid PRIME_AGENT_DAEMON_PORT"),
                "{bad}: {error}"
            );
        }
        assert_eq!(
            resolve_daemon_tcp_port(None, Some(0), &HashMap::new()).unwrap(),
            None,
            "an out-of-range settings port reads as unset"
        );
    }

    // ------------------------------------------------------------------
    // Bind host resolution
    // ------------------------------------------------------------------

    fn host_resolution(
        explicit: Option<&str>,
        settings: Option<&str>,
        env_map: &HashMap<String, String>,
        probe: Option<&str>,
    ) -> Result<IpAddr> {
        let probe_addr = probe.and_then(|ip| ip.parse::<IpAddr>().ok());
        resolve_daemon_tcp_listener_host(explicit, settings, env_map, &move || probe_addr)
    }

    /// Precedence: flag > env > settings > the tailscale probe (TS
    /// `resolveDaemonTcpListenerHost`).
    #[test]
    fn bind_host_resolution_precedence() {
        let probe = "100.64.1.2";
        assert_eq!(
            host_resolution(
                Some("10.0.0.5"),
                Some("10.0.0.9"),
                &env(&[("PRIME_AGENT_DAEMON_BIND_HOST", "10.0.0.8")]),
                Some(probe)
            )
            .unwrap(),
            "10.0.0.5".parse::<IpAddr>().unwrap(),
            "the flag wins"
        );
        assert_eq!(
            host_resolution(
                None,
                Some("10.0.0.9"),
                &env(&[("PRIME_AGENT_DAEMON_BIND_HOST", "10.0.0.8")]),
                Some(probe)
            )
            .unwrap(),
            "10.0.0.8".parse::<IpAddr>().unwrap(),
            "the env var beats the setting"
        );
        assert_eq!(
            host_resolution(None, Some("10.0.0.9"), &HashMap::new(), Some(probe)).unwrap(),
            "10.0.0.9".parse::<IpAddr>().unwrap(),
            "the setting beats the probe"
        );
        assert_eq!(
            host_resolution(None, None, &HashMap::new(), Some(probe)).unwrap(),
            "100.64.1.2".parse::<IpAddr>().unwrap(),
            "the probe is the default"
        );
    }

    /// Fail closed (TS #2517's review fix): with the port set, no
    /// configured host, and no tailscale address, the listener refuses
    /// to start - NEVER a wildcard default - and the error names every
    /// escape hatch.
    #[test]
    fn bind_host_fails_closed_without_a_tailnet_address() {
        let error = host_resolution(None, None, &HashMap::new(), None)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("Refusing to start the daemon TCP listener"),
            "{error}"
        );
        assert!(error.contains("PRIME_AGENT_DAEMON_BIND_HOST"), "{error}");
        assert!(error.contains("--daemon-bind"), "{error}");
        assert!(error.contains("daemonTcpBindHost"), "{error}");
    }

    /// An explicit bind host must be an IP literal (TS
    /// `daemonTcpBindHostFromSource`): a hostname would resolve through
    /// DNS at listen time and could dodge the tailnet-only default.
    #[test]
    fn explicit_bind_host_must_be_an_ip_literal() {
        for (source, value) in [
            ("--daemon-bind", "example.com"),
            ("PRIME_AGENT_DAEMON_BIND_HOST", "not an ip"),
            ("settings daemonTcpBindHost", "::gg::"),
        ] {
            let error = host_resolution(
                if source == "--daemon-bind" {
                    Some(value)
                } else {
                    None
                },
                if source == "settings daemonTcpBindHost" {
                    Some(value)
                } else {
                    None
                },
                &env(&[(
                    "PRIME_AGENT_DAEMON_BIND_HOST",
                    if source == "PRIME_AGENT_DAEMON_BIND_HOST" {
                        value
                    } else {
                        ""
                    },
                )]),
                None,
            )
            .unwrap_err()
            .to_string();
            assert!(
                error.contains(&format!("Invalid {source}")),
                "{source}: {error}"
            );
        }
    }

    /// Every spelling of the wildcard interface classifies (TS #2517's
    /// review fix: `0:0:0:0:0:0:0:0` binds every interface, so it must
    /// carry the plaintext-token warning too); real addresses stay
    /// negative.
    #[test]
    fn wildcard_bind_host_spellings() {
        for wildcard in [
            "0.0.0.0",
            "::",
            "::0",
            "0:0:0:0:0:0:0:0",
            "0:0::",
            "::0.0.0.0",
        ] {
            assert!(
                is_wildcard_bind_host(wildcard),
                "{wildcard} is the wildcard"
            );
        }
        for real in [
            "::1",
            "fd7a:115c:a1e0::1",
            "fe80::",
            "100.64.1.2",
            "127.0.0.1",
            "not-an-ip",
        ] {
            assert!(!is_wildcard_bind_host(real), "{real} is a real address");
        }
    }

    // ------------------------------------------------------------------
    // Per-line auth
    // ------------------------------------------------------------------

    fn envelope(id: &str, command: &str, token: &str) -> String {
        format!(
            "{{\"type\":\"command\",\"id\":\"{id}\",\"command\":{{\"type\":\"{command}\"}},\"auth\":{{\"token\":\"{token}\"}}}}"
        )
    }

    /// A valid envelope authenticates and names the real command (TS's
    /// review fix: the refusal and the verdict report the inner command
    /// name, not the envelope's `"command"`).
    #[test]
    fn line_auth_accepts_envelope_and_names_the_command() {
        let verdict = check_daemon_tcp_line_auth(&envelope("e1", "list_sessions", "t"), "t");
        assert!(verdict.ok);
        assert_eq!(verdict.id, "e1");
        assert_eq!(verdict.command.as_deref(), Some("list_sessions"));

        // A wrong token is refused with the envelope's INNER command name
        // - the failure response must name the refused command.
        let refused = check_daemon_tcp_line_auth(&envelope("e2", "list", "wrong"), "t");
        assert!(!refused.ok);
        assert_eq!(refused.id, "e2");
        assert_eq!(
            refused.command.as_deref(),
            Some("list"),
            "the real command, not \"command\""
        );
        assert_eq!(refused.reason, "wrong_token");
    }

    /// Missing, empty, and absent tokens carry their distinct reasons (TS
    /// `checkDaemonTcpLineAuth`).
    #[test]
    fn line_auth_refusal_reasons() {
        let missing = check_daemon_tcp_line_auth(
            "{\"type\":\"command\",\"id\":\"m\",\"command\":{\"type\":\"list\"}}",
            "t",
        );
        assert!(!missing.ok);
        assert_eq!(missing.reason, "missing_token");
        assert_eq!(missing.id, "m");

        let empty = check_daemon_tcp_line_auth(
            "{\"type\":\"command\",\"id\":\"m\",\"command\":{\"type\":\"list\"},\"auth\":{\"token\":\"\"}}",
            "t",
        );
        assert!(!empty.ok);
        assert_eq!(empty.reason, "missing_token");
    }

    /// Invalid JSON and JSON primitives are refused without a panic (TS
    /// #2517's review fix: `null` is valid JSON but must answer
    /// `invalid_json` instead of dereferencing null and taking the
    /// connection handler down with it).
    #[test]
    fn line_auth_rejects_invalid_json_and_primitives() {
        for line in ["", "not json", "{", "null", "42", "\"text\"", "true", "[]"] {
            let verdict = check_daemon_tcp_line_auth(line, "t");
            assert!(!verdict.ok, "{line:?} must refuse");
            assert_eq!(verdict.reason, "invalid_json", "{line:?}");
            assert_eq!(verdict.id, "unknown", "{line:?}");
        }
    }

    /// A raw record authenticates but is not dispatchable (TS #2517's
    /// contract: only the envelope reaches the dispatcher; a raw record
    /// gets the protocol-version refusal there - same as the unix path).
    #[test]
    fn line_auth_accepts_raw_records_for_the_dispatcher_to_refuse() {
        let verdict = check_daemon_tcp_line_auth(
            "{\"id\":\"r1\",\"type\":\"list\",\"auth\":{\"token\":\"t\"}}",
            "t",
        );
        assert!(verdict.ok, "the token is valid");
        assert_eq!(
            verdict.command.as_deref(),
            Some("list"),
            "the fallback name"
        );
    }

    /// The token comparison is timing-safe in shape: a wrong token of
    /// the same length is still refused (spot-check via the verdict).
    #[test]
    fn line_auth_refuses_same_length_wrong_token() {
        let verdict = check_daemon_tcp_line_auth(&envelope("s", "list", "aaaaaaaa"), "bbbbbbbb");
        assert!(!verdict.ok);
        assert_eq!(verdict.reason, "wrong_token");
    }
    /// A token file with wider permissions is re-restricted on reuse (the
    /// Bugbot round: a later start that merely reuses the existing file
    /// must never leave the mesh credential readable), and a fresh create
    /// is owner-only from the open (the TS `{ mode: 0o600 }` shape, not a
    /// post-write chmod).
    #[cfg(unix)]
    #[test]
    fn token_file_permissions_are_owner_only_from_creation_and_on_reuse() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().unwrap();
        let record = load_or_create_daemon_tcp_token(dir.path()).unwrap();
        let mode = std::fs::metadata(&record.token_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the fresh token is 0600");
        // Widen the file (a backup restore or a manual chmod): the next
        // load re-restricts it instead of silently reusing the readable
        // credential.
        let mut perms = std::fs::metadata(&record.token_path).unwrap().permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&record.token_path, perms).unwrap();
        let reloaded = load_or_create_daemon_tcp_token(dir.path()).unwrap();
        let mode = std::fs::metadata(&reloaded.token_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the reuse re-restricts the token file");
    }

    // ------------------------------------------------------------------
    // The bind-address probe's trusted resolution and its bounded spawn
    // (the Bugbot round: the probe picks the interface the plaintext
    // token rides, and it runs after the unix socket is bound).
    // ------------------------------------------------------------------

    /// The probe's spawn budget is the TS window (TS #2517
    /// `DAEMON_TCP_TAILSCALE_TIMEOUT_MS = 15_000`): the constants test
    /// stands in for a virtual-time wait the same way the idle-window
    /// pin does.
    #[test]
    fn tailscale_probe_budget_is_the_ts_window() {
        assert_eq!(
            DAEMON_TCP_TAILSCALE_TIMEOUT,
            Duration::from_secs(15),
            "TS #2517's DAEMON_TCP_TAILSCALE_TIMEOUT_MS"
        );
    }

    /// A wedged `tailscale` CLI (the spawn never answers) dies at the
    /// window instead of parking startup with it: the probe runs after
    /// the unix socket is bound, so an unbounded spawn would leave
    /// clients connected to a daemon that never accepts (Bugbot's
    /// startup-hang finding, TS's `timeout`/`SIGKILL` contract).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hung_tailscale_probe_dies_at_the_window() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = dir.path().join("tailscale");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        make_executable(&script);
        let started = std::time::Instant::now();
        let address = detect_tailscale_bind_address_with(&script, Duration::from_millis(300)).await;
        assert!(
            address.is_none(),
            "a wedged CLI yields no bind address: {address:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the wedged spawn died at the window, took {}s",
            started.elapsed().as_secs_f32()
        );
    }

    /// A first `PATH` entry whose `tailscale` is not executable yields to
    /// a later usable CLI instead of stranding it: the old first-file
    /// match fail-closed the listener with permission-denied spawns even
    /// while the real CLI sat in a later entry (Bugbot's stranding arm).
    #[cfg(unix)]
    #[test]
    fn a_non_executable_first_match_yields_to_a_later_cli() {
        let base = tempfile::TempDir::new().unwrap();
        let stranded = base.path().join("stranded");
        let real = base.path().join("real");
        std::fs::create_dir_all(&stranded).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        let decoy = stranded.join("tailscale");
        std::fs::write(&decoy, "#!/bin/sh\nexit 0\n").unwrap();
        let usable = real.join("tailscale");
        std::fs::write(&usable, "#!/bin/sh\nexit 0\n").unwrap();
        make_executable(&usable);
        let path_env = format!("{}:{}", stranded.display(), real.display());
        let resolved = trusted_tailscale_path_over(OsStr::new(&path_env), base.path());
        assert_eq!(
            resolved,
            Some(usable),
            "the later executable CLI wins over the non-executable first match"
        );
    }

    /// The cwd skip is canonical: a `PATH` entry that is an absolute
    /// symlink to the current directory is skipped the same way the
    /// entry-equals-cwd case is, so a `./tailscale` planted in the
    /// working directory can never supply the binary that names the
    /// listener's bind address (Bugbot's weaker-lookup finding).
    #[cfg(unix)]
    #[test]
    fn a_symlink_entry_pointing_at_the_cwd_is_skipped() {
        let base = tempfile::TempDir::new().unwrap();
        let planted = base.path().join("tailscale");
        std::fs::write(&planted, "#!/bin/sh\nexit 0\n").unwrap();
        make_executable(&planted);
        let link = base.path().join("link-to-cwd");
        std::os::unix::fs::symlink(std::fs::canonicalize(base.path()).unwrap(), &link).unwrap();
        let path_env = link.display().to_string();
        let resolved = trusted_tailscale_path_over(OsStr::new(&path_env), base.path());
        assert_eq!(
            resolved, None,
            "a symlinked cwd entry never supplies the CLI"
        );
    }

    /// Relative and cwd `PATH` entries never supply the CLI (the
    /// fail-closed pins the resolver shares with the CLI detection core).
    #[cfg(unix)]
    #[test]
    fn relative_and_cwd_entries_never_supply_the_cli() {
        let base = tempfile::TempDir::new().unwrap();
        let planted = base.path().join("tailscale");
        std::fs::write(&planted, "#!/bin/sh\nexit 0\n").unwrap();
        make_executable(&planted);
        let relative = OsStr::new(".");
        assert_eq!(
            trusted_tailscale_path_over(relative, base.path()),
            None,
            "a relative entry resolves to the cwd and is skipped"
        );
        let cwd_entry = OsStr::new(base.path().as_os_str());
        assert_eq!(
            trusted_tailscale_path_over(cwd_entry, base.path()),
            None,
            "the cwd entry is skipped"
        );
    }

    /// Make a test script executable by this process (the resolver's
    /// execute gate requires it).
    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }
}

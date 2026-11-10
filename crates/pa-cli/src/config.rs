//! Product-wide constants and environment handling.

use std::path::PathBuf;

pub const APP_NAME: &str = "prime-agent";

pub const CONFIG_DIR_NAME: &str = ".prime/agent";

pub const ENV_AGENT_DIR: &str = "PRIME_AGENT_CODING_AGENT_DIR";

pub const ENV_SESSION_DIR: &str = "PRIME_AGENT_SESSION_DIR";

/// `PRIME_AGENT_DAEMON_SOCKET`: overrides the daemon socket path when no explicit
/// `--daemon-socket` flag is given. The launcher pins it so the Rust daemon runs
/// beside — never replacing — the TS daemon (a Rust CLI that found the TS daemon
/// on the default socket would treat the schema-id mismatch as staleness).
pub const ENV_DAEMON_SOCKET: &str = "PRIME_AGENT_DAEMON_SOCKET";

/// The daemon socket path: an explicit `--daemon-socket` flag wins, then
/// [`ENV_DAEMON_SOCKET`], then the per-user default.
pub fn resolve_daemon_socket_path(daemon_socket: Option<&str>) -> PathBuf {
    daemon_socket
        .map(expand_tilde_path)
        .or_else(|| {
            std::env::var_os(ENV_DAEMON_SOCKET)
                .filter(|value| !value.is_empty())
                .as_deref()
                .map(expand_tilde_path_os)
        })
        .unwrap_or_else(pa_daemon::socket::default_daemon_socket_path)
}

/// [`expand_tilde_path`] over a raw environment value: anything but a
/// tilde-prefixed value passes through as the original bytes — a lossy read
/// here would rewrite a non-UTF-8 socket path.
pub fn expand_tilde_path_os(value: &std::ffi::OsStr) -> PathBuf {
    if value.to_str().is_some_and(|path| path.starts_with('~')) {
        return expand_tilde_path(&value.to_string_lossy());
    }
    PathBuf::from(value)
}

pub const ENV_LEGACY_SESSION_DIR: &str = "PRIME_AGENT_CODING_AGENT_SESSION_DIR";

/// The version compiled into this build, used when no packaged manifest
/// overrides it.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// `PRIME_AGENT_A2A_TOKEN`: the A2A server mode's bearer token,
/// preferred over the `a2a.token` setting (never a CLI flag, so the
/// secret stays off the command line).
pub const ENV_A2A_TOKEN: &str = "PRIME_AGENT_A2A_TOKEN";

/// The A2A server mode's public base URL (settings `a2a.publicBaseUrl`):
/// the agent card's interface URL and the accepted `Host` authority
/// when a TLS-terminating front serves the mode (the bound endpoint is
/// otherwise the honest URL — the server is local-only without it).
pub fn a2a_public_base_url(cwd: &std::path::Path) -> Option<String> {
    pa_core::settings::SettingsManager::create(cwd, get_agent_dir()).get_a2a_public_base_url()
}

/// The A2A server mode's live-context bound (settings `a2a.maxContexts`;
/// the default 64): the server keeps at most this many conversation
/// contexts, evicting the least recently used idle one (its worker
/// stops) when the table is full.
pub fn a2a_max_contexts(cwd: &std::path::Path) -> Option<usize> {
    pa_core::settings::SettingsManager::create(cwd, get_agent_dir()).get_a2a_max_contexts()
}

/// Resolve the A2A server mode's bind options — flag > settings >
/// default for the host and port, environment > settings for the
/// bearer token (the token is deliberately not a flag — a flag lands
/// in every process listing and the shell history), with the loud
/// warning the spec's enterprise section asks for on every
/// non-loopback bind — and scrub the token's
/// environment variable: the A2A process spawns its supervisor from
/// this environment and forwards it into every context's worker
/// (`launch_env`), so the secret must leave the process env before
/// either runs — the resolved token is already in hand. Call while
/// the process is still single-threaded (the A2A mode's entry, before
/// the tokio runtime builds).
///
/// With no token configured anywhere (neither the environment nor the
/// `a2a.token` setting), the mode MINTS one per run: a fresh random
/// token handed to the serving mode in memory, written by the server
/// — after its listener binds — to an owner-only file in the agent
/// dir, named per bound port (a second server on another port never
/// overwrites the first's token), whose path it prints — every task
/// route requires a token (the
/// daemon's control socket is owner-only, and the TCP listener must
/// not be the weaker surface: any local account could otherwise drive
/// the agent's bash and python tools as the operator), while the
/// well-known Agent Card stays public.
/// # Errors
///
/// Returns the startup error string when the configured `a2a.port`
/// sits outside the TCP port range (the server refuses to start
/// rather than bind a port the settings do not name).
pub fn a2a_bind_options_scrubbed(
    host_flag: Option<&str>,
    port_flag: Option<u16>,
    cwd: &std::path::Path,
) -> Result<(String, u16, String, Option<std::path::PathBuf>), String> {
    let settings = pa_core::settings::SettingsManager::create(cwd, get_agent_dir());
    let host = host_flag
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .or_else(|| settings.get_a2a_host())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    // A configured port outside the TCP range is a startup error, not
    // a silent default-port bind: the settings document would name a
    // port the server never listens on (the flag path cannot carry one
    // — `--a2a-port` parses as u16).
    let port = match port_flag {
        Some(port) => port,
        None => match settings.get_a2a_port() {
            Some(port) => u16::try_from(port).map_err(|_| {
                format!(
                    "the a2a.port setting is {port}, outside the TCP port range \
                     0-65535; fix the setting before starting the A2A server"
                )
            })?,
            None => crate::config::A2A_DEFAULT_PORT,
        },
    };
    let token = std::env::var(ENV_A2A_TOKEN)
        .ok()
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().to_string())
        .or_else(|| settings.get_a2a_token());
    if !host_is_loopback(&host) {
        // The real posture, never the false one: a bearer token gates
        // every task route (minted when none is configured), so a
        // non-loopback bind is authenticated but not encrypted — name
        // the TLS front and the token the remote peers must present
        // (a per-run minted token is written to a local owner-only
        // file they cannot read; configure one they know).
        eprintln!(
            "Warning: the A2A server is binding {host} on a non-loopback interface. \
A bearer token gates every task route; set the {ENV_A2A_TOKEN} environment \
variable or the a2a.token setting so remote peers can present it, and front \
the bind with TLS — the token authenticates, it does not encrypt."
        );
    }
    // The mint stays in memory here: the token FILE is written only
    // after the listener binds, named per bound port (a second start
    // against the same agent dir — another port, a port-0 run — must
    // never overwrite the token file of the server that is still
    // running, which would leave every client reading the documented
    // path with a 401 and nothing explaining it). The fresh
    // experience never serves unauthenticated: the value reaches the
    // caller in memory, and the file's agent dir is the server that
    // actually binds (see the a2a module's write site).
    let (token, minted) = match token {
        Some(token) => (token, None),
        None => (
            format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            Some(get_agent_dir()),
        ),
    };
    std::env::remove_var(ENV_A2A_TOKEN);
    Ok((host, port, token, minted))
}

pub const A2A_DEFAULT_PORT: u16 = 7800;

/// Whether a bind host is loopback (`127.0.0.0/8`, `::1`, or
/// `localhost` — case-insensitively, the name a resolver reads the
/// same way).
fn host_is_loopback(host: &str) -> bool {
    let host = host.trim_matches(|c| c == '[' || c == ']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback())
        || host
            .parse::<std::net::Ipv6Addr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The A2A card's agent name (settings `a2a.name`, default "Prime Agent").
pub fn a2a_agent_name(cwd: &std::path::Path) -> String {
    pa_core::settings::SettingsManager::create(cwd, get_agent_dir())
        .get_a2a_name()
        .unwrap_or_else(|| "Prime Agent".to_string())
}

/// The A2A card's agent description (settings `a2a.description`, the
/// one-line default otherwise).
pub fn a2a_agent_description(cwd: &std::path::Path) -> String {
    pa_core::settings::SettingsManager::create(cwd, get_agent_dir()).get_a2a_description()
    .unwrap_or_else(|| {
        "A general-purpose coding and research agent driven over the Agent2Agent (A2A) protocol."
            .to_string()
    })
}

/// The product version: the packaged `package.json` manifest next to the
/// executable wins, falling back to the compiled-in version.
pub fn version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| match packaged_manifest_version() {
        Some(version) => version,
        None => crate::config::VERSION.to_string(),
    })
}

/// The packaged package-dir (`PI_PACKAGE_DIR` wins, else the directory of
/// the executable, launcher symlinks resolved through pa-core's
/// `exe_dir_of`).
fn package_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("PI_PACKAGE_DIR") {
        if !env_dir.is_empty() {
            return expand_tilde_path(&env_dir);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| pa_core::packages::exe_dir_of(&exe))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn packaged_manifest_version() -> Option<String> {
    let manifest = std::fs::read_to_string(package_dir().join("package.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    let version = parsed.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

pub const ENV_OFFLINE: &str = "PI_OFFLINE";

pub const ENV_STARTUP_BENCHMARK: &str = "PI_STARTUP_BENCHMARK";

/// Expand a leading `~`, `~/`, or (Windows) `~\` segment against the
/// home directory.
pub fn expand_tilde_path(path: &str) -> PathBuf {
    let Some(home) = pa_types::platform::home_dir() else {
        return PathBuf::from(path);
    };
    if path == "~" {
        return home;
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    #[cfg(windows)]
    if let Some(rest) = path.strip_prefix("~\\") {
        return home.join(rest);
    }
    PathBuf::from(path)
}

pub fn get_agent_dir() -> PathBuf {
    match std::env::var(ENV_AGENT_DIR) {
        Ok(dir) if !dir.is_empty() => expand_tilde_path(&dir),
        _ => pa_types::platform::home_dir()
            .expect("HOME or PRIME_AGENT_CODING_AGENT_DIR is required for agent settings")
            .join(CONFIG_DIR_NAME),
    }
}

/// The CLI checks this before any command can read agent settings. Keep the
/// error at the command boundary so a missing home is reported without a
/// panic or a fallback into the repository.
pub fn require_agent_dir() -> Result<(), String> {
    if std::env::var(ENV_AGENT_DIR).is_ok_and(|dir| !dir.is_empty())
        || pa_types::platform::home_dir().is_some()
    {
        Ok(())
    } else {
        Err(format!(
            "HOME or {ENV_AGENT_DIR} is required for agent settings"
        ))
    }
}

pub fn get_session_dir_env_override() -> Option<PathBuf> {
    std::env::var(ENV_SESSION_DIR)
        .ok()
        .or_else(|| std::env::var(ENV_LEGACY_SESSION_DIR).ok())
        .filter(|value| !value.is_empty())
        .map(|value| expand_tilde_path(&value))
}

/// Truthy environment flag check: only `1`, `true`, and `yes`
/// (case-insensitive) count.
pub fn is_truthy_env_flag(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(value) => {
            let lower = value.to_ascii_lowercase();
            value == "1" || lower == "true" || lower == "yes"
        }
    }
}

/// The env-mutating tests serialize on one lock (the `client_traces`
/// convention): both HOME mutators in this crate's test binary take it.
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The flag/env/default order is the co-existence contract (the launcher pins the env).
    #[test]
    fn daemon_socket_resolution_prefers_flag_then_env_then_default() {
        let default = pa_daemon::socket::default_daemon_socket_path();
        std::env::set_var(ENV_DAEMON_SOCKET, "/tmp/rust-launcher.sock");
        assert_eq!(
            resolve_daemon_socket_path(None),
            PathBuf::from("/tmp/rust-launcher.sock")
        );
        assert_eq!(
            resolve_daemon_socket_path(Some("/tmp/flag.sock")),
            PathBuf::from("/tmp/flag.sock")
        );
        std::env::remove_var(ENV_DAEMON_SOCKET);
        assert_eq!(resolve_daemon_socket_path(None), default);
    }

    /// The A2A token's env var scrubs at the bind-options resolution:
    /// the resolved options carry the token while the variable leaves
    /// the process env, so the supervisor spawn and every context's
    /// `launch_env` collect cannot forward the secret.
    #[test]
    fn resolving_the_bind_options_scrubs_the_token_env() {
        let _env = env_lock();
        std::env::set_var(ENV_A2A_TOKEN, "probe-secret-a2a");
        let (host, port, token, minted) = a2a_bind_options_scrubbed(
            Some("127.0.0.1"),
            Some(7800),
            std::path::Path::new("/nonexistent-a2a-cwd"),
        )
        .expect("the bind options resolve");
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 7800);
        assert_eq!(token, "probe-secret-a2a");
        assert_eq!(minted, None, "a configured token is never minted");
        assert!(
            std::env::var(ENV_A2A_TOKEN).is_err(),
            "the scrub removed the token's environment variable"
        );
    }

    /// An out-of-range `a2a.port` is a startup error, never a silent
    /// default-port bind: the settings document would otherwise name a
    /// port the server never listens on.
    #[test]
    fn an_out_of_range_a2a_port_errors_instead_of_the_default() {
        let _env = env_lock();
        let agent_dir = tempfile::tempdir().expect("temp agent dir");
        std::env::set_var(ENV_AGENT_DIR, agent_dir.path());
        std::fs::write(
            agent_dir.path().join("settings.json"),
            r#"{"a2a":{"port":70000}}"#,
        )
        .expect("settings write");
        let refused =
            a2a_bind_options_scrubbed(None, None, std::path::Path::new("/nonexistent-a2a-cwd"));
        // The same document with an in-range port resolves the
        // configured value (the error path never widened into a
        // default-for-everything).
        std::fs::write(
            agent_dir.path().join("settings.json"),
            r#"{"a2a":{"port":443}}"#,
        )
        .expect("settings write");
        let resolved =
            a2a_bind_options_scrubbed(None, None, std::path::Path::new("/nonexistent-a2a-cwd"));
        // The env window closes before any assertion can panic.
        std::env::remove_var(ENV_AGENT_DIR);
        let error = refused.expect_err("the out-of-range port must error");
        assert!(
            error.contains("a2a.port") && error.contains("70000"),
            "the error names the setting and its value: {error}"
        );
        let (_, port, _, _) = resolved.expect("the in-range port resolves");
        assert_eq!(port, 443);
    }

    #[test]
    fn expands_tilde() {
        let _env = env_lock();
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(expand_tilde_path("~"), PathBuf::from("/home/tester"));
        assert_eq!(
            expand_tilde_path("~/sessions"),
            PathBuf::from("/home/tester/sessions")
        );
        assert_eq!(expand_tilde_path("/abs/path"), PathBuf::from("/abs/path"));
        assert_eq!(expand_tilde_path("~foo"), PathBuf::from("~foo"));
    }

    /// The TS `expandTildePath` win32 arm (the pa-types twin carries it too).
    #[test]
    #[cfg(windows)]
    fn expands_the_win32_backslash_tilde() {
        let _env = env_lock();
        std::env::remove_var("HOME");
        std::env::set_var("USERPROFILE", r"C:\Users\tester");
        assert_eq!(
            expand_tilde_path(r"~\sessions"),
            PathBuf::from(r"C:\Users\tester\sessions")
        );
        assert_eq!(
            expand_tilde_path(r"~\deep\dir"),
            PathBuf::from(r"C:\Users\tester\deep\dir")
        );
        std::env::remove_var("USERPROFILE");
    }
}

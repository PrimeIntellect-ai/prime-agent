//! Product-wide constants and environment handling, ported from
//! `packages/coding-agent/src/config.ts`.

use std::path::{Path, PathBuf};

/// The user-facing application name (`piConfig.name` in package.json).
pub const APP_NAME: &str = "prime-agent";

/// The agent state directory name (`piConfig.configDir` in package.json).
pub const CONFIG_DIR_NAME: &str = ".prime/agent";

/// `PRIME_AGENT_CODING_AGENT_DIR`: overrides the agent state directory.
pub const ENV_AGENT_DIR: &str = "PRIME_AGENT_CODING_AGENT_DIR";

/// `PRIME_AGENT_SESSION_DIR`: overrides the session directory.
pub const ENV_SESSION_DIR: &str = "PRIME_AGENT_SESSION_DIR";

/// `PRIME_AGENT_CODING_AGENT_SESSION_DIR`: legacy session-dir override.
pub const ENV_LEGACY_SESSION_DIR: &str = "PRIME_AGENT_CODING_AGENT_SESSION_DIR";

/// The version compiled into this build, used when no packaged manifest
/// overrides it (dev checkouts, cargo target dirs).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The product version: the packaged `package.json` manifest next to the
/// executable wins (TS `VERSION` reads `getPackageJsonPath()` at runtime, so
/// a repackaged release reports the pinned manifest version), falling back
/// to the compiled-in version.
pub fn version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| match packaged_manifest_version() {
        Some(version) => version,
        None => crate::config::VERSION.to_string(),
    })
}

/// The packaged package-dir (`PI_PACKAGE_DIR` wins, else the directory of
/// the executable — the TS `getPackageDir` bun-binary layout).
fn package_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("PI_PACKAGE_DIR") {
        if !env_dir.is_empty() {
            return expand_tilde_path(&env_dir);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn packaged_manifest_version() -> Option<String> {
    let manifest = std::fs::read_to_string(package_dir().join("package.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    let version = parsed.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// `PRIME_AGENT_OFFLINE`: truthy values enable offline mode.
pub const ENV_OFFLINE: &str = "PI_OFFLINE";

/// `PRIME_AGENT_STARTUP_BENCHMARK`: truthy values enable startup benchmarking.
pub const ENV_STARTUP_BENCHMARK: &str = "PI_STARTUP_BENCHMARK";

/// Expand a leading `~`, `~/`, or (Windows) `~\` segment against the home
/// directory (TS `expandTildePath`, including the win32 backslash arm).
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

/// The agent state directory, honoring `PRIME_AGENT_CODING_AGENT_DIR`.
pub fn get_agent_dir() -> PathBuf {
    match std::env::var(ENV_AGENT_DIR) {
        Ok(dir) if !dir.is_empty() => expand_tilde_path(&dir),
        _ => pa_types::platform::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(CONFIG_DIR_NAME),
    }
}

/// The session directory override from the environment, if any.
pub fn get_session_dir_env_override() -> Option<PathBuf> {
    std::env::var(ENV_SESSION_DIR)
        .ok()
        .or_else(|| std::env::var(ENV_LEGACY_SESSION_DIR).ok())
        .filter(|value| !value.is_empty())
        .map(|value| expand_tilde_path(&value))
}

/// Truthy environment flag check, matching `isTruthyEnvFlag` in main.ts:
/// only `1`, `true`, and `yes` (case-insensitive) count.
pub fn is_truthy_env_flag(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(value) => {
            let lower = value.to_ascii_lowercase();
            value == "1" || lower == "true" || lower == "yes"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_tilde() {
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(expand_tilde_path("~"), PathBuf::from("/home/tester"));
        assert_eq!(
            expand_tilde_path("~/sessions"),
            PathBuf::from("/home/tester/sessions")
        );
        assert_eq!(expand_tilde_path("/abs/path"), PathBuf::from("/abs/path"));
        assert_eq!(expand_tilde_path("~foo"), PathBuf::from("~foo"));
    }
}

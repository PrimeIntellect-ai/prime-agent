//! Home-directory resolution shared by every crate that expands `~`.
//!
//! The TS product resolves the home directory with Node's `os.homedir()`
//! (or `process.env.HOME || homedir()` in the package manager, which keeps
//! the same first step): `HOME` when set, then on Windows `USERPROFILE`,
//! else `HOMEDRIVE` + `HOMEPATH`. When nothing resolves, `os.homedir()`
//! throws - this port returns `None` and each caller owns its fallback
//! (an explicit error in the daemon, a documented degraded value elsewhere),
//! so the decision stays visible at the point of use instead of a shared
//! silent default.

use std::path::PathBuf;

/// The user's home directory, Node `os.homedir()` semantics.
///
/// `HOME` first (an explicit `HOME` always wins, matching the TS
/// `process.env.HOME || homedir()` order), then on Windows the
/// `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH` chain. `None` means no
/// environment source resolved a home; POSIX has no fallback here (the
/// per-call-site fallback replaces the TS `os.homedir()` throw).
pub fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()) {
        return Some(PathBuf::from(home));
    }
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|p| !p.is_empty()) {
            return Some(PathBuf::from(profile));
        }
        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            let mut home = PathBuf::from(drive);
            home.push(path);
            return Some(home);
        }
    }
    None
}

/// `PRIME_AGENT_CODING_AGENT_DIR`: the agent state directory override (a
/// wire-internal identifier kept byte-compatible with the TS product).
pub const ENV_AGENT_DIR: &str = "PRIME_AGENT_CODING_AGENT_DIR";

/// The agent state directory name (TS `CONFIG_DIR_NAME`, `.prime/agent`).
pub const CONFIG_DIR_NAME: &str = ".prime/agent";

/// The agent state directory (TS `getAgentDir`): the env override with a
/// leading `~`/`~/` expanded against [`home_dir`], else `<home>/.prime/agent`.
/// `None` when no override is set and the home directory does not resolve
/// (each caller owns its fallback).
pub fn agent_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(ENV_AGENT_DIR).filter(|dir| !dir.is_empty()) {
        return Some(expand_tilde(&dir.to_string_lossy()));
    }
    home_dir().map(|home| home.join(CONFIG_DIR_NAME))
}

/// Expand a leading `~`/`~/` against [`home_dir`]; other values pass
/// through (TS `expandTildePath`: `~foo` is not an expansion).
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().map_or_else(|| PathBuf::from(path), |home| home.join(rest));
    }
    if path == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Environment mutations are process-global: every test takes this lock
    /// and restores the previous values on exit.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Run `body` with the named variables set to the given values (`None`
    /// removes them), restoring the previous state afterwards.
    fn with_env(names: &[(&str, Option<&str>)], body: impl FnOnce()) {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous: Vec<(&str, Option<std::ffi::OsString>)> = names
            .iter()
            .map(|(name, _)| (*name, std::env::var_os(name)))
            .collect();
        for (name, value) in names {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        body();
        for (name, value) in previous {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn agent_dir_env_override_expands_tilde() {
        with_env(
            &[
                ("HOME", Some("/home/tester")),
                ("PRIME_AGENT_CODING_AGENT_DIR", Some("~/state")),
            ],
            || {
                assert_eq!(agent_dir(), Some(PathBuf::from("/home/tester/state")));
            },
        );
    }

    #[test]
    #[cfg(unix)]
    fn agent_dir_env_override_passthrough() {
        with_env(
            &[
                ("HOME", None),
                ("PRIME_AGENT_CODING_AGENT_DIR", Some("/opt/state")),
            ],
            || {
                assert_eq!(agent_dir(), Some(PathBuf::from("/opt/state")));
            },
        );
    }

    #[test]
    #[cfg(unix)]
    fn agent_dir_default_under_home() {
        with_env(
            &[
                ("HOME", Some("/home/tester")),
                ("PRIME_AGENT_CODING_AGENT_DIR", None),
            ],
            || {
                assert_eq!(
                    agent_dir(),
                    Some(PathBuf::from("/home/tester/.prime/agent"))
                );
            },
        );
    }

    #[test]
    #[cfg(unix)]
    fn agent_dir_without_home_is_none() {
        with_env(
            &[("HOME", None), ("PRIME_AGENT_CODING_AGENT_DIR", None)],
            || {
                assert_eq!(agent_dir(), None);
            },
        );
    }

    #[test]
    #[cfg(unix)]
    fn home_dir_follows_home() {
        with_env(&[("HOME", Some("/home/tester"))], || {
            assert_eq!(home_dir(), Some(PathBuf::from("/home/tester")));
        });
    }

    #[test]
    #[cfg(unix)]
    fn home_dir_unset_is_none() {
        with_env(&[("HOME", None)], || {
            assert_eq!(home_dir(), None);
        });
    }

    #[test]
    #[cfg(unix)]
    fn home_dir_empty_is_none() {
        with_env(&[("HOME", Some(""))], || {
            assert_eq!(home_dir(), None);
        });
    }

    #[test]
    #[cfg(windows)]
    fn home_dir_prefers_home_over_userprofile() {
        with_env(
            &[
                ("HOME", Some("/home/tester")),
                ("USERPROFILE", Some(r"C:\Users\tester")),
            ],
            || {
                assert_eq!(home_dir(), Some(PathBuf::from("/home/tester")));
            },
        );
    }

    #[test]
    #[cfg(windows)]
    fn home_dir_falls_back_to_userprofile() {
        with_env(
            &[("HOME", None), ("USERPROFILE", Some(r"C:\Users\tester"))],
            || {
                assert_eq!(home_dir(), Some(PathBuf::from(r"C:\Users\tester")));
            },
        );
    }

    #[test]
    #[cfg(windows)]
    fn home_dir_falls_back_to_homedrive_homepath() {
        with_env(
            &[
                ("HOME", None),
                ("USERPROFILE", None),
                ("HOMEDRIVE", Some("C:")),
                ("HOMEPATH", Some(r"\Users\tester")),
            ],
            || {
                assert_eq!(home_dir(), Some(PathBuf::from(r"C:\Users\tester")));
            },
        );
    }

    #[test]
    #[cfg(windows)]
    fn home_dir_unset_is_none() {
        with_env(
            &[
                ("HOME", None),
                ("USERPROFILE", None),
                ("HOMEDRIVE", None),
                ("HOMEPATH", None),
            ],
            || {
                assert_eq!(home_dir(), None);
            },
        );
    }
}

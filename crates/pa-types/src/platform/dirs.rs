//! Home-directory resolution shared by every crate that expands `~`: Node `os.homedir()`
//! semantics -
//! `HOME` when set, then on Windows `USERPROFILE`, else `HOMEDRIVE` + `HOMEPATH`. Where
//! `os.homedir()` throws, this port returns `None` and each caller owns its fallback.

use std::path::PathBuf;

/// The user's home directory, Node `os.homedir()` semantics: `HOME` first (always wins, matching
/// the
/// TS order), then on Windows the `USERPROFILE`/`HOMEDRIVE`+`HOMEPATH` chain; `None` when nothing
/// resolves (the per-call-site fallback replaces the TS throw).
#[must_use]
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

/// `PRIME_AGENT_CODING_AGENT_DIR`: the agent state directory override
/// (byte-compatible with the TS product).
pub const ENV_AGENT_DIR: &str = "PRIME_AGENT_CODING_AGENT_DIR";

/// The agent state directory name (TS `CONFIG_DIR_NAME`, `.prime/agent`).
pub const CONFIG_DIR_NAME: &str = ".prime/agent";

/// The agent state directory: the env override with a leading `~`/`~/` expanded, else
/// `<home>/.prime/agent`; `None` when the home directory does not resolve (each caller owns its
/// fallback).
#[must_use]
pub fn agent_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(ENV_AGENT_DIR).filter(|dir| !dir.is_empty()) {
        return Some(expand_tilde(&dir.to_string_lossy()));
    }
    home_dir().map(|home| home.join(CONFIG_DIR_NAME))
}

/// Expand a leading `~`/`~/` - and on Windows `~\` - against [`home_dir`]; other values pass
/// through (`~foo` is not an expansion).
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().map_or_else(|| PathBuf::from(path), |home| home.join(rest));
    }
    #[cfg(windows)]
    if let Some(rest) = path.strip_prefix("~\\") {
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

    /// Environment mutations are process-global: tests take this lock and
    /// restore previous values on exit.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Run `body` with the named variables set (`None` removes them),
    /// restoring the previous state afterwards.
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
    fn home_and_agent_dirs_follow_the_environment() {
        type Case<'a> = (
            &'a [(&'a str, Option<&'a str>)],
            Option<&'a str>,
            Option<&'a str>,
        );
        let cases: [Case; 5] = [
            (
                &[
                    ("HOME", Some("/home/tester")),
                    (ENV_AGENT_DIR, Some("~/state")),
                ],
                Some("/home/tester"),
                Some("/home/tester/state"),
            ),
            (
                &[("HOME", None), (ENV_AGENT_DIR, Some("/opt/state"))],
                None,
                Some("/opt/state"),
            ),
            (
                &[("HOME", Some("/home/tester")), (ENV_AGENT_DIR, None)],
                Some("/home/tester"),
                Some("/home/tester/.prime/agent"),
            ),
            (&[("HOME", None), (ENV_AGENT_DIR, None)], None, None),
            (&[("HOME", Some("")), (ENV_AGENT_DIR, None)], None, None),
        ];
        for (env, home, agent) in cases {
            with_env(env, || {
                assert_eq!(home_dir(), home.map(PathBuf::from), "{env:?}");
                assert_eq!(agent_dir(), agent.map(PathBuf::from), "{env:?}");
            });
        }
    }

    #[test]
    #[cfg(windows)]
    fn agent_dir_env_override_expands_the_win32_backslash_tilde() {
        // The TS `expandTildePath` win32 arm: a `~\`-prefixed override expands exactly like the
        // `~/`
        // form (a CLI-only expansion would split the state dir between processes).
        with_env(
            &[
                ("HOME", None),
                ("USERPROFILE", Some(r"C:\Users\tester")),
                ("PRIME_AGENT_CODING_AGENT_DIR", Some(r"~\state")),
            ],
            || {
                assert_eq!(agent_dir(), Some(PathBuf::from(r"C:\Users\tester\state")));
            },
        );
    }

    #[test]
    #[cfg(windows)]
    fn home_dir_falls_back_to_userprofile() {
        type Case<'a> = (&'a [(&'a str, Option<&'a str>)], Option<&'a str>);
        let cases: [Case; 4] = [
            (
                &[
                    ("HOME", Some("/home/tester")),
                    ("USERPROFILE", Some(r"C:\Users\tester")),
                ],
                Some("/home/tester"),
            ),
            (
                &[("HOME", None), ("USERPROFILE", Some(r"C:\Users\tester"))],
                Some(r"C:\Users\tester"),
            ),
            (
                &[
                    ("HOME", None),
                    ("USERPROFILE", None),
                    ("HOMEDRIVE", Some("C:")),
                    ("HOMEPATH", Some(r"\Users\tester")),
                ],
                Some(r"C:\Users\tester"),
            ),
            (
                &[
                    ("HOME", None),
                    ("USERPROFILE", None),
                    ("HOMEDRIVE", None),
                    ("HOMEPATH", None),
                ],
                None,
            ),
        ];
        for (env, home) in cases {
            with_env(env, || {
                assert_eq!(home_dir(), home.map(PathBuf::from), "{env:?}");
            });
        }
    }
}

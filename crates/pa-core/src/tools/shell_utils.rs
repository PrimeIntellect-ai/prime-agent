//! Shell configuration and process helpers.
//!
//! Port of `packages/coding-agent/src/utils/shell.ts` plus the
//! `waitForChildProcess` semantics of `utils/child-process.ts` that the bash
//! tool relies on. Platform-specific resolution and kill semantics live in
//! [`crate::platform`]; this module keeps the cross-platform shell environment
//! and output sanitation.

pub use crate::platform::shell::get_shell_config;

/// The agent config directory (`~/.prime/agent` unless overridden).
pub fn get_agent_dir() -> String {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if dir.starts_with('~') {
            if let Some(rest) = dir.strip_prefix("~/") {
                return format!("{}/{}", home_dir(), rest);
            }
        }
        return dir;
    }
    format!("{}/.prime/agent", home_dir())
}

fn home_dir() -> String {
    pa_types::platform::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Directory containing the agent's bundled binaries, prepended to PATH.
pub fn get_bin_dir() -> String {
    format!("{}/bin", get_agent_dir())
}

/// Environment for agent-spawned shells.
///
/// Prepends the agent bin dir to PATH and forces non-interactive settings so
/// prompts, pagers, and editors fail fast instead of hanging on dead stdin.
pub fn get_shell_env() -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars()
        .filter(|(_, v)| !v.contains('\0'))
        .collect();
    let bin_dir = get_bin_dir();
    let path_key = env
        .keys()
        .find(|k| k.eq_ignore_ascii_case("path"))
        .cloned()
        .unwrap_or_else(|| "PATH".to_string());
    let current_path = env.get(&path_key).cloned().unwrap_or_default();
    // Node `path.delimiter` (`:` on Unix, `;` on Windows): the std
    // split/join helpers carry the same per-platform delimiter, and empty
    // entries drop exactly like the TS `.filter(Boolean)`.
    let has_bin_dir = std::env::split_paths(&current_path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .any(|dir| dir == std::path::Path::new(&bin_dir));
    if !has_bin_dir {
        let updated = if current_path.is_empty() {
            bin_dir
        } else {
            let mut entries = vec![std::path::PathBuf::from(&bin_dir)];
            entries.extend(
                std::env::split_paths(&current_path).filter(|dir| !dir.as_os_str().is_empty()),
            );
            std::env::join_paths(entries)
                .expect("bin dir path has no NUL byte")
                .to_string_lossy()
                .into_owned()
        };
        env.insert(path_key, updated);
    }
    env.insert("GIT_EDITOR".into(), "true".into());
    env.insert("GIT_SEQUENCE_EDITOR".into(), "true".into());
    env.insert("GIT_TERMINAL_PROMPTS".into(), "0".into());
    env.insert("GIT_ASKPASS".into(), "true".into());
    env.insert("SSH_ASKPASS_REQUIRE".into(), "never".into());
    env.insert("EDITOR".into(), "true".into());
    env.insert("VISUAL".into(), "true".into());
    env.insert("PAGER".into(), "cat".into());
    env.insert("GIT_PAGER".into(), "cat".into());
    env.insert("DEBIAN_FRONTEND".into(), "noninteractive".into());
    env
}

/// Sanitize binary output for display/storage.
///
/// Removes control characters (except tab, newline, carriage return) and
/// Unicode format characters; lone surrogates cannot occur in Rust strings.
pub fn sanitize_binary_output(s: &str) -> String {
    s.chars()
        .filter(|&ch| {
            let code = ch as u32;
            // Allow tab, newline, carriage return.
            if code == 0x09 || code == 0x0a || code == 0x0d {
                return true;
            }
            // Control characters.
            if code <= 0x1f {
                return false;
            }
            // Unicode format characters that crash string-width.
            if (0xfff9..=0xfffb).contains(&code) {
                return false;
            }
            true
        })
        .collect()
}

/// Kill a process and all its children (process group first, then the bare
/// pid). Returns true when a signal was delivered.
pub fn kill_process_tree(pid: i32) -> bool {
    crate::platform::process::kill_process_group_or_pid(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_config_prefers_bin_bash() {
        let cfg = get_shell_config(None).unwrap();
        assert_eq!(cfg.shell, "/bin/bash");
        assert_eq!(cfg.args, vec!["-c".to_string()]);
    }

    #[test]
    fn shell_env_disables_prompts() {
        let env = get_shell_env();
        assert_eq!(env.get("GIT_TERMINAL_PROMPTS").unwrap(), "0");
        assert_eq!(env.get("PAGER").unwrap(), "cat");
        assert!(env.get("PATH").unwrap().contains("/bin"));
    }

    #[test]
    fn sanitize_removes_control_chars() {
        assert_eq!(sanitize_binary_output("a\u{0}b\u{7}c"), "abc");
        assert_eq!(sanitize_binary_output("a\tb\nc\rd"), "a\tb\nc\rd");
        assert_eq!(sanitize_binary_output("x\u{FFF9}y"), "xy");
    }
}

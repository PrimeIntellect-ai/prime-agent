//! Shell selection for the bash tool and the kernel's `bash()`. Unix:
//! explicit path, `/bin/bash`, `which bash`, `sh`. Windows: Git Bash from
//! the canonical install dirs, then `where bash.exe` (System32 candidates
//! demoted to last — the WSL launcher), never PATH for the kernel shell.

use std::path::Path;

/// Shell program plus the fixed argument list used to run a command string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    pub shell: String,
    pub args: Vec<String>,
}

/// One predicate for every explicit `shellPath` consumer (the user-bash
/// [`get_shell_config`] and the kernel [`resolve_kernel_bash_shell`]):
/// the same setting fails the same way everywhere, naming the setting.
///
/// # Errors
///
/// Error when the path does not exist or (on unix) is not an executable
/// regular file.
fn check_custom_shell_path(path: &str) -> anyhow::Result<()> {
    if !Path::new(path).exists() {
        anyhow::bail!("Custom shell path not found: {path} (shellPath setting)");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = std::fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0);
        if !executable {
            anyhow::bail!("Custom shell path is not executable: {path} (shellPath setting)");
        }
    }
    Ok(())
}

/// Resolve the shell to run commands with, honoring an explicit custom path.
///
/// # Errors
///
/// Error when the explicit custom shell path fails [`check_custom_shell_path`];
/// the built-ins never fail.
#[cfg(unix)]
pub fn get_shell_config(custom_shell_path: Option<&str>) -> anyhow::Result<ShellConfig> {
    if let Some(path) = custom_shell_path {
        check_custom_shell_path(path)?;
        return Ok(ShellConfig {
            shell: path.to_string(),
            args: vec!["-c".to_string()],
        });
    }

    if Path::new("/bin/bash").exists() {
        return Ok(ShellConfig {
            shell: "/bin/bash".to_string(),
            args: vec!["-c".to_string()],
        });
    }

    if let Some(bash) = find_bash_on_path() {
        return Ok(ShellConfig {
            shell: bash,
            args: vec!["-c".to_string()],
        });
    }

    Ok(ShellConfig {
        shell: "sh".to_string(),
        args: vec!["-c".to_string()],
    })
}

/// Windows: the TS order: an explicit path, Git Bash in the canonical
/// install dirs (`ProgramFiles`), then `where bash.exe` with System32
/// matches demoted to last (that bash.exe is the WSL launcher).
///
/// # Errors
///
/// Error when the explicit path fails [`check_custom_shell_path`]; the
/// fallbacks otherwise resolve or name the classes searched.
#[cfg(windows)]
pub fn get_shell_config(custom_shell_path: Option<&str>) -> anyhow::Result<ShellConfig> {
    if let Some(path) = custom_shell_path {
        check_custom_shell_path(path)?;
        return Ok(bash_config(path));
    }

    let paths = windows_git_bash_search_paths();
    for path in &paths {
        if Path::new(path).exists() {
            return Ok(bash_config(path));
        }
    }

    if let Some(bash) = find_bash_on_path() {
        return Ok(bash_config(&bash));
    }

    Err(anyhow::anyhow!(
        "No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, WSL, etc.)\n  3. Set shellPath in settings.json\n\nSearched Git Bash in:\n{}",
        paths
            .iter()
            .map(|path| format!("  {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

#[cfg(not(any(unix, windows)))]
pub fn get_shell_config(_custom_shell_path: Option<&str>) -> anyhow::Result<ShellConfig> {
    anyhow::bail!("shell selection is not implemented on this platform")
}

#[cfg(unix)]
fn find_bash_on_path() -> Option<String> {
    let out = std::process::Command::new("which")
        .arg("bash")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.trim().lines().next()?;
    (!first.is_empty()).then(|| first.to_string())
}

/// Windows: `where bash.exe`, every match verified to exist (`where` can
/// report non-existent paths), System32 candidates demoted to last.
#[cfg(windows)]
fn find_bash_on_path() -> Option<String> {
    let mut command = std::process::Command::new("where");
    command.arg("bash.exe");
    crate::platform::process::set_no_window(&mut command);
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let matches: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    order_windows_bash_candidates(&matches, std::env::var("SystemRoot").ok().as_deref())
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
}

/// The TS candidate ordering (`orderWindowsBashCandidates`): System32 matches
/// (the WSL launcher) move to the end; everything else keeps `where`'s
/// order.
#[cfg(windows)]
fn order_windows_bash_candidates(matches: &[String], system_root: Option<&str>) -> Vec<String> {
    let Some(system_root) = system_root else {
        return matches.to_vec();
    };
    // `where` prints absolute normal paths; the comparison is the same
    // case-insensitive `<SystemRoot>\` prefix the TS helper applies.
    let prefix = format!("{system_root}\\").to_lowercase();
    let is_under_system_root = |candidate: &String| candidate.to_lowercase().starts_with(&prefix);
    let (other, system): (Vec<String>, Vec<String>) = matches
        .iter()
        .cloned()
        .partition(|m| !is_under_system_root(m));
    [other, system].concat()
}

#[cfg(windows)]
fn bash_config(shell: &str) -> ShellConfig {
    ShellConfig {
        shell: shell.to_string(),
        args: vec!["-c".to_string()],
    }
}

/// The Git Bash install dirs searched on Windows, from the `ProgramFiles`
/// environment (TS `getShellConfig` win32 order). The kernel-shell
/// resolution does NOT use these - see [`resolve_kernel_bash_shell`].
#[cfg(windows)]
fn windows_git_bash_search_paths() -> Vec<String> {
    let mut paths = Vec::new();
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        paths.push(format!("{program_files}\\Git\\bin\\bash.exe"));
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        paths.push(format!("{program_files_x86}\\Git\\bin\\bash.exe"));
    }
    paths
}

/// Absolute default shell for the kernel's `bash()` when no `shellPath` is
/// configured: POSIX uses `/bin/bash` else `/bin/sh`. `None` when no shell
/// resolves (kernel startup must not fail; `bash()` raises its teaching error).
#[cfg(unix)]
#[must_use]
pub fn default_kernel_bash_shell() -> Option<String> {
    if Path::new("/bin/bash").exists() {
        Some("/bin/bash".to_string())
    } else {
        Some("/bin/sh".to_string())
    }
}

/// Windows default: the canonical Git Bash install paths only, never PATH
/// (TS `resolveKernelBashShell` win32): a repo-controlled PATH must not
/// pick the kernel shell, and hardcoded candidates avoid ambient attacker-
/// influenceable `ProgramFiles` input. `None`: `bash()` raises its teaching error.
#[cfg(windows)]
#[must_use]
pub fn default_kernel_bash_shell() -> Option<String> {
    const WINDOWS_GIT_BASH_PATHS: [&str; 2] = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    WINDOWS_GIT_BASH_PATHS
        .into_iter()
        .find(|path| Path::new(path).exists())
        .map(str::to_string)
}

#[cfg(not(any(unix, windows)))]
#[must_use]
pub fn default_kernel_bash_shell() -> Option<String> {
    None
}

/// Resolve the absolute shell for the kernel's `bash()` from an explicit
/// `shellPath`, validated here so a bad setting fails session creation
/// once instead of every kernel `bash()` call: a trimmed non-empty
/// explicit path must be absolute and pass [`check_custom_shell_path`];
/// anything else falls back to [`default_kernel_bash_shell`].
///
/// # Errors
///
/// Error naming the path and the `shellPath` setting when the explicit
/// path is relative, missing, or (on unix) not executable. The default
/// never fails.
pub fn resolve_kernel_bash_shell(custom: Option<&str>) -> anyhow::Result<Option<String>> {
    if let Some(path) = custom.map(str::trim).filter(|s| !s.is_empty()) {
        if !Path::new(path).is_absolute() {
            anyhow::bail!("Custom shell path must be absolute: {path} (shellPath setting)");
        }
        check_custom_shell_path(path)?;
        return Ok(Some(path.to_string()));
    }
    Ok(default_kernel_bash_shell())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn system32_candidates_are_demoted_last() {
        let candidates = [
            r"C:\Windows\System32\bash.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            r"c:\windows\system32\bash.exe",
            r"C:\cygwin64\bin\bash.exe",
        ]
        .map(str::to_string);
        let ordered = order_windows_bash_candidates(&candidates, Some(r"C:\Windows"));
        assert_eq!(
            ordered,
            [
                r"C:\Program Files\Git\bin\bash.exe",
                r"C:\cygwin64\bin\bash.exe",
                r"C:\Windows\System32\bash.exe",
                r"c:\windows\system32\bash.exe",
            ]
        );
    }

    #[test]
    fn without_system_root_the_order_stands() {
        let candidates =
            [r"C:\Windows\System32\bash.exe", r"C:\Git\bin\bash.exe"].map(str::to_string);
        assert_eq!(order_windows_bash_candidates(&candidates, None), candidates);
    }

    /// An explicit path is validated (it must exist) and wins over the
    /// hardcoded Git Bash candidates; without one the resolution is the
    /// platform default.
    #[test]
    fn kernel_shell_prefers_explicit_then_hardcoded_git_bash() {
        let dir = tempfile::tempdir().unwrap();
        let explicit = dir.path().join("bash.exe");
        std::fs::write(&explicit, b"").unwrap();
        let explicit = explicit.to_string_lossy().to_string();
        assert_eq!(
            resolve_kernel_bash_shell(Some(format!("  {explicit}  ").as_str())).unwrap(),
            Some(explicit)
        );
        assert_eq!(
            resolve_kernel_bash_shell(None).unwrap(),
            default_kernel_bash_shell()
        );
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A rejected explicit shell: the error names the path and the
    /// `shellPath` setting, whatever the validation failure was.
    #[test]
    fn explicit_shell_paths_are_validated() {
        for path in ["relative/bash", "/no/such/shell"] {
            let message = resolve_kernel_bash_shell(Some(path))
                .unwrap_err()
                .to_string();
            assert!(message.contains("shellPath"), "{path}: {message}");
            assert!(message.contains(path), "{path}: {message}");
        }
        let dir = tempfile::tempdir().unwrap();
        let not_executable = dir.path().join("shell");
        std::fs::write(&not_executable, b"").unwrap();
        let path = not_executable.to_string_lossy().to_string();
        let message = resolve_kernel_bash_shell(Some(path.as_str()))
            .unwrap_err()
            .to_string();
        assert!(message.contains("shellPath"), "not executable: {message}");
        assert!(message.contains(&path), "not executable: {message}");
    }

    #[test]
    fn padded_executable_shell_resolves_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("bash");
        std::fs::write(&shell, b"").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let padded = format!("  {}  ", shell.to_string_lossy());
        assert_eq!(
            resolve_kernel_bash_shell(Some(padded.as_str())).unwrap(),
            Some(shell.to_string_lossy().to_string())
        );
    }
}

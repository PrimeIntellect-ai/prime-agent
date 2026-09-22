//! Shell selection for the bash tool and the kernel's `bash()`.
//!
//! Unix: explicit path, `/bin/bash`, `which bash`, `sh`. Windows: the TS
//! resolution order - Git Bash from the canonical install dirs, then
//! `where bash.exe` with System32 candidates demoted to last (that bash.exe
//! is the WSL launcher), never PATH for the kernel shell (a repo-controlled
//! PATH must not pick the kernel shell).

#[cfg(any(unix, windows))]
use std::path::Path;

/// Shell program plus the fixed argument list used to run a command string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    pub shell: String,
    pub args: Vec<String>,
}

/// Resolve the shell to run commands with, honoring an explicit custom path.
#[cfg(unix)]
pub fn get_shell_config(custom_shell_path: Option<&str>) -> anyhow::Result<ShellConfig> {
    if let Some(path) = custom_shell_path {
        if Path::new(path).exists() {
            return Ok(ShellConfig {
                shell: path.to_string(),
                args: vec!["-c".to_string()],
            });
        }
        return Err(anyhow::anyhow!("Custom shell path not found: {path}"));
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

/// Windows: the TS resolution order (TS `getShellConfig` win32): an explicit
/// path, then Git Bash in the canonical install dirs (from the ProgramFiles
/// environment), then `where bash.exe` with System32 matches demoted to last
/// (`System32\bash.exe` is the WSL launcher - it runs Linux-side).
#[cfg(windows)]
pub fn get_shell_config(custom_shell_path: Option<&str>) -> anyhow::Result<ShellConfig> {
    if let Some(path) = custom_shell_path {
        if Path::new(path).exists() {
            return Ok(bash_config(path));
        }
        return Err(anyhow::anyhow!("Custom shell path not found: {path}"));
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

/// The Git Bash install dirs searched on Windows, from the ProgramFiles
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

/// Absolute default shell for the kernel's `bash()`: explicit path wins;
/// POSIX uses `/bin/bash` else `/bin/sh`. `None` when no shell resolves
/// (kernel startup must not fail; `bash()` raises its teaching error).
#[cfg(unix)]
pub fn resolve_kernel_bash_shell(custom_shell_path: Option<&str>) -> Option<String> {
    if let Some(explicit) = custom_shell_path.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(explicit.to_string());
    }
    if Path::new("/bin/bash").exists() {
        Some("/bin/bash".to_string())
    } else {
        Some("/bin/sh".to_string())
    }
}

/// Windows: canonical Git Bash install paths only, never PATH - a
/// repo-controlled PATH/`where` must not pick the kernel shell (TS
/// `resolveKernelBashShell` win32). The candidates are hardcoded literals
/// by design: the ProgramFiles variables are ambient attacker-influenceable
/// input, the same trust-laundering class as PATH. `None` means no shell:
/// kernel startup must not fail, `bash()` raises its teaching error.
#[cfg(windows)]
pub fn resolve_kernel_bash_shell(custom_shell_path: Option<&str>) -> Option<String> {
    if let Some(explicit) = custom_shell_path.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(explicit.to_string());
    }
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
pub fn resolve_kernel_bash_shell(custom_shell_path: Option<&str>) -> Option<String> {
    custom_shell_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// The TS ordering: System32 (WSL launcher) candidates move last.
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

    /// Without SystemRoot the order is preserved unchanged.
    #[test]
    fn without_system_root_the_order_stands() {
        let candidates =
            [r"C:\Windows\System32\bash.exe", r"C:\Git\bin\bash.exe"].map(str::to_string);
        assert_eq!(order_windows_bash_candidates(&candidates, None), candidates);
    }

    /// The kernel shell candidates are the hardcoded Git Bash paths, not
    /// PATH-derived (a repo-controlled PATH must not pick the kernel
    /// shell); an explicit path always wins.
    #[test]
    fn kernel_shell_prefers_explicit_then_hardcoded_git_bash() {
        assert_eq!(
            resolve_kernel_bash_shell(Some("  C:/my/bash.exe  ")),
            Some("C:/my/bash.exe".to_string())
        );
        // Hardcoded candidates are environment-independent: absent on a
        // clean CI runner, the resolution is None (bash() raises its
        // teaching error, kernel startup still succeeds).
        let clean = !Path::new(r"C:\Program Files\Git\bin\bash.exe").exists()
            && !Path::new(r"C:\Program Files (x86)\Git\bin\bash.exe").exists();
        if clean {
            assert_eq!(resolve_kernel_bash_shell(None), None);
        }
    }
}

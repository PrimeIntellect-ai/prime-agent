//! The git-context concern (moved with its concern): the quiet git
//! probes and the header's git-context capture (TS captureGitContext).

use super::*;

/// One quiet git probe: `--no-optional-locks`, stdio ignore/pipe/ignore,
/// `None` on any failure or empty output (TS `runGit` in utils/git.ts).
fn run_git_probe(cwd: &Path, args: &[&str]) -> Option<String> {
    std::process::Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|stdout| stdout.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Capture git context for the header (best effort; None outside a repo).
///
/// Contract (TS `captureGitContext`): every field is independently optional;
/// the context exists when at least one probe succeeds. `branch` is
/// `--show-current`, so a detached HEAD yields no branch. The remote URL is
/// normalized through the git-source parser when it parses, else kept
/// verbatim.
pub fn capture_git_context(cwd: &Path) -> Option<GitContext> {
    let commit = run_git_probe(cwd, &["rev-parse", "HEAD"]);
    let branch = run_git_probe(cwd, &["branch", "--show-current"]);
    let remote = run_git_probe(cwd, &["remote", "get-url", "origin"]);
    if commit.is_none() && branch.is_none() && remote.is_none() {
        return None;
    }
    Some(GitContext {
        repo_url: remote.map(|url| {
            crate::packages::parse_git_url(&url)
                .map(|source| source.repo)
                .unwrap_or(url)
        }),
        commit,
        branch,
    })
}

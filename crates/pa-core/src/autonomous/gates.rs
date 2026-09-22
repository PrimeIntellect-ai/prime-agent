//! Autonomous quality gates: shell-command gates evaluated after each turn,
//! with workspace snapshots that suppress re-running a failing gate over an
//! unchanged workspace (the retry valve).

use std::path::{Path, PathBuf};
use std::pin::Pin;

use sha2::{Digest, Sha256};

use super::{
    now_millis, AgentAutonomousGateFailure, AutonomousDecision, AutonomousDecisionReason,
    AutonomousGateResult, AutonomousLimitReason, AutonomousRuntimeState, GitWorktreeSnapshot,
};

/// Output cap for gate results surfaced in continuation text.
const MAX_GATE_OUTPUT_CHARS: usize = 6000;
/// Output cap for gate child processes (both streams combined per stream).
const MAX_CHILD_PROCESS_OUTPUT_CHARS: usize = 1024 * 1024;
/// Timeout for the git commands that capture a worktree snapshot.
const SNAPSHOT_TIMEOUT_MS: u64 = 10_000;

/// Future returned by [`GateCommandRunner`] methods.
pub type GateRunFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = anyhow::Result<ChildProcessResult>> + Send + 'a>>;
/// Future returned by [`GateCommandRunner::capture_snapshot`].
pub type SnapshotFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = Option<GitWorktreeSnapshot>> + Send + 'a>>;

/// Runs gate commands and captures workspace evidence for them. The product
/// implementation shells out in the session cwd; tests and eval harnesses
/// implement scripted, deterministic runners.
///
/// Contract: `run_gate` always resolves (a spawn failure is an `Err`, which
/// the gate loop counts as a failed attempt), and `capture_snapshot` returns
/// `None` when the workspace state is unavailable, which means "always
/// re-run the gate" (snapshots never compare equal).
pub trait GateCommandRunner: Send + Sync {
    /// Run one gate command with the configured per-gate timeout.
    fn run_gate(&self, command: &str, timeout_ms: u64) -> GateRunFuture<'_>;

    /// Capture the workspace snapshot compared against the previous failed
    /// run to decide whether a failing gate is re-run.
    fn capture_snapshot(&self) -> SnapshotFuture<'_> {
        Box::pin(async { None })
    }
}

/// The product runner: `bash -c <command>` in the session cwd.
#[derive(Debug, Clone)]
pub struct ShellGateRunner {
    cwd: PathBuf,
}

impl ShellGateRunner {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}

impl GateCommandRunner for ShellGateRunner {
    fn run_gate(&self, command: &str, timeout_ms: u64) -> GateRunFuture<'_> {
        let command = command.to_string();
        let cwd = self.cwd.clone();
        Box::pin(async move { run_gate_command(&command, &cwd, timeout_ms).await })
    }

    fn capture_snapshot(&self) -> SnapshotFuture<'_> {
        let cwd = self.cwd.clone();
        Box::pin(async move { capture_git_worktree_snapshot(&cwd).await })
    }
}

/// Result of one gate child process.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChildProcessResult {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
    pub timed_out: bool,
    pub output_truncated: bool,
}

/// Decide whether an assistant turn should be followed by a continuation:
/// gates first (a pass stops the run), then the budget limits.
pub async fn should_autonomously_continue(
    state: &mut AutonomousRuntimeState,
    stop_reason: Option<pa_types::ai::StopReason>,
    gates: &dyn GateCommandRunner,
) -> AutonomousDecision {
    use pa_types::ai::StopReason;
    if !state.enabled
        || stop_reason == Some(StopReason::Error)
        || stop_reason == Some(StopReason::Aborted)
    {
        return AutonomousDecision {
            should_continue: false,
            reason: AutonomousDecisionReason::NotNeeded,
        };
    }
    let gate_result = refresh_autonomous_quality_gates(state, gates).await;
    let limit_reason = autonomous_limit_reason_now(state);
    match gate_result {
        Some(AutonomousGateResult::Passed) => AutonomousDecision {
            should_continue: false,
            reason: AutonomousDecisionReason::NotNeeded,
        },
        Some(AutonomousGateResult::RetryExhausted) => AutonomousDecision {
            should_continue: false,
            reason: AutonomousDecisionReason::LimitReached,
        },
        None if limit_reason.is_some() => AutonomousDecision {
            should_continue: false,
            reason: AutonomousDecisionReason::LimitReached,
        },
        Some(AutonomousGateResult::Failed) => {
            if limit_reason.is_some() {
                AutonomousDecision {
                    should_continue: false,
                    reason: AutonomousDecisionReason::LimitReached,
                }
            } else {
                AutonomousDecision {
                    should_continue: true,
                    reason: AutonomousDecisionReason::GateFailed,
                }
            }
        }
        None => AutonomousDecision {
            should_continue: true,
            reason: AutonomousDecisionReason::MissingTerminalEvidence,
        },
    }
}

fn autonomous_limit_reason_now(state: &AutonomousRuntimeState) -> Option<AutonomousLimitReason> {
    super::autonomous_limit_reason(state, now_millis())
}

/// Run the configured gates when enabled; `None` when no gates apply.
async fn refresh_autonomous_quality_gates(
    state: &mut AutonomousRuntimeState,
    gates: &dyn GateCommandRunner,
) -> Option<AutonomousGateResult> {
    if !state.enabled || state.gates.commands.is_empty() {
        return None;
    }
    Some(run_autonomous_quality_gates(state, gates).await)
}

/// Evaluate every configured gate in order; the first failure wins.
async fn run_autonomous_quality_gates(
    state: &mut AutonomousRuntimeState,
    gates: &dyn GateCommandRunner,
) -> AutonomousGateResult {
    let commands = state.gates.commands.clone();
    let max_retries = state.gates.max_retries;
    let gate_timeout_ms = state.gates.timeout_ms;
    for command in &commands {
        // A failed gate is not re-run over an unchanged workspace: the
        // snapshot taken after the failure must differ first.
        let current_snapshot = gates.capture_snapshot().await;
        let same_failure = state
            .last_gate_failure
            .as_ref()
            .is_some_and(|failure| &failure.command == command)
            && state.last_gate_failure_snapshot.is_some()
            && snapshots_equal(
                current_snapshot.as_ref(),
                state.last_gate_failure_snapshot.as_ref(),
            );
        if same_failure {
            let attempt = state.gate_attempts.get(command).copied().unwrap_or(
                state
                    .last_gate_failure
                    .as_ref()
                    .map(|failure| failure.attempt)
                    .unwrap_or(0),
            ) + 1;
            state.gate_attempts.insert(command.clone(), attempt);
            let mut failure = state.last_gate_failure.clone().unwrap();
            failure.attempt = attempt;
            failure.exit_text =
                "not rerun: workspace unchanged since previous failed gate".to_string();
            failure.output = "The autonomous gate was not rerun because the workspace has not changed since this failure. Edit source files, tests, or a blocker artifact before attempting to finish again.".to_string();
            state.last_gate_failure = Some(failure);
            return gate_attempt_result(attempt, max_retries);
        }
        let result = gates.run_gate(command, gate_timeout_ms).await;
        let Ok(result) = result else {
            // A spawn/IO failure counts as a failed attempt.
            let attempt = state.gate_attempts.get(command).copied().unwrap_or(0) + 1;
            state.gate_attempts.insert(command.clone(), attempt);
            state.last_gate_failure = Some(AgentAutonomousGateFailure {
                command: command.clone(),
                attempt,
                exit_text: "failed to run".to_string(),
                output: String::new(),
            });
            state.last_gate_failure_snapshot = None;
            return gate_attempt_result(attempt, max_retries);
        };
        if result.status == Some(0) && result.error.is_none() && !result.timed_out {
            state.gate_attempts.insert(command.clone(), 0);
            if state
                .last_gate_failure
                .as_ref()
                .is_some_and(|failure| &failure.command == command)
            {
                state.last_gate_failure = None;
                state.last_gate_failure_snapshot = None;
            }
            continue;
        }
        let attempt = state.gate_attempts.get(command).copied().unwrap_or(0) + 1;
        state.gate_attempts.insert(command.clone(), attempt);
        let output = [result.stdout.clone(), result.stderr.clone()]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        state.last_gate_failure = Some(AgentAutonomousGateFailure {
            command: command.clone(),
            attempt,
            exit_text: format_process_exit(&result),
            output: truncate_gate_output(&output, result.output_truncated),
        });
        state.last_gate_failure_snapshot = gates.capture_snapshot().await;
        return gate_attempt_result(attempt, max_retries);
    }
    state.last_gate_failure = None;
    state.last_gate_failure_snapshot = None;
    AutonomousGateResult::Passed
}

/// Failed attempts within the retry window continue; past it, exhausted.
fn gate_attempt_result(attempt: u64, max_retries: u64) -> AutonomousGateResult {
    if attempt > max_retries {
        AutonomousGateResult::RetryExhausted
    } else {
        AutonomousGateResult::Failed
    }
}

fn snapshots_equal(a: Option<&GitWorktreeSnapshot>, b: Option<&GitWorktreeSnapshot>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a.status == b.status && a.diff == b.diff && a.untracked_hash == b.untracked_hash)
}

fn format_process_exit(result: &ChildProcessResult) -> String {
    if result.timed_out {
        return "timed out".to_string();
    }
    if let Some(error) = &result.error {
        return error.clone();
    }
    match result.status {
        Some(code) => format!("exited with code {code}"),
        None => "killed by signal".to_string(),
    }
}

fn truncate_gate_output(output: &str, was_truncated: bool) -> String {
    if output.chars().count() <= MAX_GATE_OUTPUT_CHARS && !was_truncated {
        return output.to_string();
    }
    let prefix: String = output.chars().take(MAX_GATE_OUTPUT_CHARS).collect();
    format!("{prefix}\n... [truncated]")
}

/// Pathspec entries excluded from gate snapshots: harness workspaces churn
/// in these paths between attempts, and none of them is gate-relevant work.
const SNAPSHOT_EXCLUDES: [&str; 6] = [
    "verification",
    "target",
    ".vf-prime-agent",
    "Cargo.lock",
    "submission.tar.gz",
    "runner_args.log",
];

/// Snapshot the git worktree state: porcelain status, the HEAD diff, and a
/// content hash of untracked files. `None` when any capture step fails (the
/// gate loop then treats the workspace as always-changed).
pub async fn capture_git_worktree_snapshot(cwd: &Path) -> Option<GitWorktreeSnapshot> {
    if !cwd.is_dir() {
        return None;
    }
    let mut pathspec: Vec<String> = vec!["--".to_string(), ".".to_string()];
    for exclude in SNAPSHOT_EXCLUDES {
        pathspec.push(format!(":(exclude){exclude}"));
    }
    let status = run_git(
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "-uall",
            "--no-renames",
        ],
        &pathspec,
        cwd,
    )
    .await?;
    let diff = run_git(
        &[
            "--no-optional-locks",
            "diff",
            "--no-ext-diff",
            "--binary",
            "HEAD",
        ],
        &pathspec,
        cwd,
    )
    .await?;
    let untracked_hash = hash_untracked_files(cwd, &status);
    Some(GitWorktreeSnapshot {
        status,
        diff,
        untracked_hash,
    })
}

/// One git invocation: `None` on any non-zero exit, timeout, or truncation.
async fn run_git(prefix: &[&str], pathspec: &[String], cwd: &Path) -> Option<String> {
    let mut args: Vec<String> = prefix.iter().map(|arg| arg.to_string()).collect();
    args.extend(pathspec.iter().cloned());
    let result = run_child_process("git", &args, cwd, SNAPSHOT_TIMEOUT_MS)
        .await
        .ok()?;
    if result.status != Some(0)
        || result.error.is_some()
        || result.timed_out
        || result.output_truncated
    {
        return None;
    }
    Some(result.stdout)
}

/// Aggregate content hash over the untracked files named in a porcelain
/// status stream: path, then file/symlink/other digest, NUL-separated.
fn hash_untracked_files(cwd: &Path, status: &str) -> String {
    let mut aggregate = Sha256::new();
    for path in untracked_paths_from_status(status) {
        aggregate.update(path.as_bytes());
        aggregate.update([0]);
        aggregate.update(hash_untracked_path(&cwd.join(path)).as_bytes());
        aggregate.update([0]);
    }
    format!("{:x}", aggregate.finalize())
}

fn untracked_paths_from_status(status: &str) -> Vec<String> {
    let mut paths: Vec<String> = status
        .split('\0')
        .filter(|entry| entry.starts_with("?? "))
        .map(|entry| entry[3..].to_string())
        .collect();
    paths.sort();
    paths
}

/// Digest of one untracked path: symlink target, file content, or metadata
/// for everything else; capture failures hash their message (a partial
/// digest is still a stable comparison basis between attempts).
fn hash_untracked_path(path: &Path) -> String {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return "missing".to_string();
    };
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(path)
            .map(|target| target.to_string_lossy().to_string())
            .unwrap_or_else(|error| error.to_string());
        return format!("symlink:{target}");
    }
    if !metadata.is_file() {
        return format!(
            "other:{}:{}",
            metadata.len(),
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        );
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            format!("file:{:x}", hasher.finalize())
        }
        Err(error) => format!("error:{error}"),
    }
}

/// Run a child process with a timeout, draining both output pipes
/// concurrently (a chatty command cannot wedge the wait on a full pipe).
async fn run_child_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout_ms: u64,
) -> anyhow::Result<ChildProcessResult> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = read_pipe_capped(child.stdout.take());
    let stderr = read_pipe_capped(child.stderr.take());
    let timeout = tokio::time::Duration::from_millis(timeout_ms.max(1));
    let wait = async {
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(status)
    };
    tokio::select! {
        status = wait => {
            let status = status.map_err(|error| anyhow::anyhow!("{error}"))?;
            let (stdout, stdout_truncated) = stdout.await;
            let (stderr, stderr_truncated) = stderr.await;
            Ok(ChildProcessResult {
                status: status.code(),
                stdout,
                stderr,
                error: None,
                timed_out: false,
                output_truncated: stdout_truncated || stderr_truncated,
            })
        }
        _ = tokio::time::sleep(timeout) => {
            let _ = child.kill().await;
            let (stdout, stdout_truncated) = stdout.await;
            let (stderr, stderr_truncated) = stderr.await;
            Ok(ChildProcessResult {
                status: None,
                stdout,
                stderr,
                error: None,
                timed_out: true,
                output_truncated: stdout_truncated || stderr_truncated,
            })
        }
    }
}

/// Run a shell gate command with the configured timeout and output caps.
pub async fn run_gate_command(
    command: &str,
    cwd: &Path,
    timeout_ms: u64,
) -> anyhow::Result<ChildProcessResult> {
    let args = ["-c".to_string(), command.to_string()];
    run_child_process("bash", &args, cwd, timeout_ms).await
}

/// Read one output pipe to EOF, keeping at most `cap` characters; the
/// remainder is drained so a full pipe never blocks the child.
async fn read_pipe_capped<R: tokio::io::AsyncRead + Unpin>(mut pipe: Option<R>) -> (String, bool) {
    use tokio::io::AsyncReadExt;
    let cap = MAX_CHILD_PROCESS_OUTPUT_CHARS;
    let mut kept = String::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    if let Some(pipe) = pipe.as_mut() {
        loop {
            match pipe.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let chunk = String::from_utf8_lossy(&buffer[..read]);
                    if kept.len() < cap {
                        let remaining = cap - kept.len();
                        if chunk.len() <= remaining {
                            kept.push_str(&chunk);
                        } else {
                            kept.push_str(&chunk[..remaining]);
                            truncated = true;
                        }
                    } else {
                        truncated = true;
                    }
                }
            }
        }
    }
    (kept, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autonomous::{
        create_autonomous_runtime_state, AgentAutonomousConfig, AgentAutonomousGateConfig,
        AutonomousDecisionReason,
    };
    use pa_types::ai::StopReason;

    fn config(enabled: bool) -> AgentAutonomousConfig {
        AgentAutonomousConfig {
            enabled: Some(enabled),
            ..Default::default()
        }
    }

    /// A scripted runner: fixed results per command, optional snapshots
    /// (an absent snapshot never suppresses a re-run).
    struct ScriptedRunner {
        results: Vec<ChildProcessResult>,
        snapshots: Vec<Option<GitWorktreeSnapshot>>,
    }

    impl GateCommandRunner for ScriptedRunner {
        fn run_gate(&self, _command: &str, _timeout_ms: u64) -> GateRunFuture<'_> {
            let result = self.results.first().cloned().unwrap_or_default();
            Box::pin(async move { Ok(result) })
        }

        fn capture_snapshot(&self) -> SnapshotFuture<'_> {
            let snapshot = self.snapshots.first().cloned().flatten();
            Box::pin(async { snapshot })
        }
    }

    fn ok_gates() -> ScriptedRunner {
        ScriptedRunner {
            results: vec![ChildProcessResult {
                status: Some(0),
                ..Default::default()
            }],
            snapshots: vec![None],
        }
    }

    fn failing_gates() -> ScriptedRunner {
        ScriptedRunner {
            results: vec![ChildProcessResult {
                status: Some(1),
                stdout: "boom\n".to_string(),
                stderr: String::new(),
                ..Default::default()
            }],
            snapshots: vec![Some(GitWorktreeSnapshot::default())],
        }
    }

    #[tokio::test]
    async fn decisions_without_gates() {
        let mut state = create_autonomous_runtime_state(Some(&config(true)), None);
        let decision =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &ok_gates()).await;
        assert!(decision.should_continue);
        assert_eq!(
            decision.reason,
            AutonomousDecisionReason::MissingTerminalEvidence
        );
        // Error and aborted turns never continue.
        let stopped =
            should_autonomously_continue(&mut state, Some(StopReason::Error), &ok_gates()).await;
        assert!(!stopped.should_continue);
        let aborted =
            should_autonomously_continue(&mut state, Some(StopReason::Aborted), &ok_gates()).await;
        assert!(!aborted.should_continue);
        // Disabled state never continues.
        state.enabled = false;
        let disabled =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &ok_gates()).await;
        assert!(!disabled.should_continue);
    }

    #[tokio::test]
    async fn gate_results_drive_decisions() {
        let mut state = create_autonomous_runtime_state(
            Some(&AgentAutonomousConfig {
                enabled: Some(true),
                gates: Some(AgentAutonomousGateConfig {
                    commands: Some(vec!["make check".to_string()]),
                    max_retries: Some(1),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            None,
        );
        // Failing gate -> continue with gate_failed.
        let failed =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &failing_gates())
                .await;
        assert!(failed.should_continue);
        assert_eq!(failed.reason, AutonomousDecisionReason::GateFailed);
        let failure = state.last_gate_failure.clone().unwrap();
        assert_eq!(failure.command, "make check");
        assert_eq!(failure.attempt, 1);
        assert_eq!(failure.exit_text, "exited with code 1");
        assert_eq!(failure.output, "boom");
        // Passing gate -> stop with not_needed.
        let passed =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &ok_gates()).await;
        assert!(!passed.should_continue);
        assert_eq!(passed.reason, AutonomousDecisionReason::NotNeeded);
        // The pass reset the retry counter, so this failure starts a fresh
        // retry window.
        let failed_again =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &failing_gates())
                .await;
        assert!(failed_again.should_continue);
        assert_eq!(failed_again.reason, AutonomousDecisionReason::GateFailed);
        // Without a pass in between, the next failure exhausts the window.
        let exhausted =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &failing_gates())
                .await;
        assert!(!exhausted.should_continue);
        assert_eq!(exhausted.reason, AutonomousDecisionReason::LimitReached);
    }

    #[tokio::test]
    async fn unchanged_workspace_is_not_rerun() {
        let mut state = create_autonomous_runtime_state(
            Some(&AgentAutonomousConfig {
                enabled: Some(true),
                gates: Some(AgentAutonomousGateConfig {
                    commands: Some(vec!["make check".to_string()]),
                    max_retries: Some(2),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            None,
        );
        // Same snapshot on every consult: the first failure records it, the
        // next consult must not re-run the gate.
        let runner = failing_gates();
        let failed =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &runner).await;
        assert!(failed.should_continue);
        assert_eq!(state.last_gate_failure.as_ref().unwrap().attempt, 1);
        let mut runner = failing_gates();
        runner.snapshots = vec![state.last_gate_failure_snapshot.clone()];
        let held = should_autonomously_continue(&mut state, Some(StopReason::Stop), &runner).await;
        assert!(held.should_continue);
        let failure = state.last_gate_failure.as_ref().unwrap();
        assert_eq!(failure.attempt, 2);
        assert_eq!(
            failure.exit_text,
            "not rerun: workspace unchanged since previous failed gate"
        );
        assert!(failure
            .output
            .starts_with("The autonomous gate was not rerun"));
        // Past the retry window the held failure exhausts the run.
        let exhausted =
            should_autonomously_continue(&mut state, Some(StopReason::Stop), &runner).await;
        assert!(!exhausted.should_continue);
        assert_eq!(exhausted.reason, AutonomousDecisionReason::LimitReached);
    }

    #[tokio::test]
    async fn shell_runner_runs_gates_and_snapshots() {
        let dir = tempfile::TempDir::new().unwrap();
        let runner = ShellGateRunner::new(dir.path());
        let passing = runner.run_gate("exit 0", 5_000).await.unwrap();
        assert_eq!(passing.status, Some(0));
        let failing = runner
            .run_gate("echo boom >&2; exit 3", 5_000)
            .await
            .unwrap();
        assert_eq!(failing.status, Some(3));
        assert_eq!(failing.stderr.trim(), "boom");
        assert_eq!(format_process_exit(&failing), "exited with code 3");
        // Timeout: a sleeping gate is killed and reported as timed out.
        let timed_out = runner.run_gate("sleep 5", 50).await.unwrap();
        assert!(timed_out.timed_out);
        assert_eq!(format_process_exit(&timed_out), "timed out");
        // Outside a git worktree no snapshot is captured.
        assert!(runner.capture_snapshot().await.is_none());
    }

    #[tokio::test]
    async fn shell_runner_snapshot_tracks_workspace_changes() {
        let dir = tempfile::TempDir::new().unwrap();
        let run = |args: &[&str]| {
            let mut command = std::process::Command::new("git");
            command.args(args).current_dir(dir.path());
            command
                .output()
                .map(|output| {
                    (
                        output.status.success(),
                        String::from_utf8_lossy(&output.stderr).to_string(),
                    )
                })
                .unwrap()
        };
        assert!(run(&["init", "-q"]).0);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.path().join("tracked.txt"), "one\n").unwrap();
        assert!(run(&["add", "."]).0);
        assert!(run(&["commit", "-q", "-m", "init"]).0);
        let runner = ShellGateRunner::new(dir.path());
        let empty = runner.capture_snapshot().await.unwrap();
        // An untracked file changes the snapshot (content-hashed).
        std::fs::write(dir.path().join("untracked.txt"), "hello\n").unwrap();
        let with_file = runner.capture_snapshot().await.unwrap();
        assert!(with_file.status.contains("?? untracked.txt"));
        assert_ne!(with_file.untracked_hash, empty.untracked_hash);
        // Same content again: an identical snapshot (the comparison basis).
        let same = runner.capture_snapshot().await.unwrap();
        assert_eq!(same, with_file);
        // A tracked modification changes the diff instead.
        std::fs::write(dir.path().join("tracked.txt"), "two\n").unwrap();
        let modified = runner.capture_snapshot().await.unwrap();
        assert!(modified.diff.contains("+two"));
        assert_ne!(modified, with_file);
        assert_eq!(
            untracked_paths_from_status(&modified.status),
            vec!["untracked.txt".to_string()]
        );
        let digest = hash_untracked_path(&dir.path().join("untracked.txt"));
        assert!(digest.starts_with("file:"));
    }
}

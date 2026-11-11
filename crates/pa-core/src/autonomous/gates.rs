//! Autonomous quality gates: shell-command gates evaluated after each turn, with workspace
//! snapshots that suppress re-running a failing gate over an unchanged workspace.
//!
//! The snapshot's git probes run inside the session worktree, so their fixed argument sets
//! carry command-line overrides that close the ways the project's own git configuration can
//! start a program during capture: the fsmonitor hook, index-write hooks, promisor lazy
//! fetches, diff text conversion or external diff programs, and submodule reads. One
//! residual stays open and is documented on the argument sets below: `.gitattributes`
//! clean and process filters still run on modified tracked files, and no flag disables them.

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
const MAX_CHILD_PROCESS_OUTPUT_BYTES: usize = 1024 * 1024;
/// Timeout for the git commands that capture a worktree snapshot.
const SNAPSHOT_TIMEOUT_MS: u64 = 10_000;

pub type GateRunFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = anyhow::Result<ChildProcessResult>> + Send + 'a>>;
pub type SnapshotFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = Option<GitWorktreeSnapshot>> + Send + 'a>>;

/// Runs gate commands and captures workspace evidence for them; tests and eval
/// harnesses implement scripted, deterministic runners.
///
/// Contract: `run_gate` always resolves (a spawn failure is an `Err`), and
/// `capture_snapshot` returning `None` means "always re-run the gate".
pub trait GateCommandRunner: Send + Sync {
    /// Run one gate command with the configured per-gate timeout.
    fn run_gate(&self, command: &str, timeout_ms: u64) -> GateRunFuture<'_>;

    /// Capture the workspace snapshot compared against the previous failed
    /// run to decide whether a failing gate is re-run.
    fn capture_snapshot(&self) -> SnapshotFuture<'_> {
        Box::pin(async { None })
    }
}

/// The product runner: the platform-selected shell in the session cwd.
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
                    .map_or(0, |failure| failure.attempt),
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

/// Overrides every snapshot probe starts with. The `-c` keys are command-line configuration:
/// they outrank repository, worktree and included config, and reach git's own child
/// processes (submodule probes included) through `GIT_CONFIG_PARAMETERS`.
///
/// - `core.fsmonitor=false` - the fsmonitor hook would otherwise run on the index refresh;
/// - `diff.autoRefreshIndex=false` and `--no-optional-locks` - the probes never write the
///   index, so no index-write hook runs, whether `core.hooksPath` or a config-based
///   `hook.<name>` names it, and the user's index stays untouched.
///
/// `.gitattributes` clean/process filters still run on modified tracked files, in the
/// repository and inside its submodules; no flag disables them.
const SNAPSHOT_GIT_OVERRIDES: [&str; 5] = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.autoRefreshIndex=false",
    "--no-optional-locks",
];

const SNAPSHOT_STATUS_ARGS: [&str; 5] = ["status", "--porcelain=v1", "-z", "-uall", "--no-renames"];

/// Neither a text conversion driver nor an external diff program may start;
/// `--submodule=short` reports submodule changes as commit ids, so no submodule
/// diff (or its textconv) runs while edits and gitlink bumps stay visible.
const SNAPSHOT_DIFF_ARGS: [&str; 6] = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=short",
    "--binary",
    "HEAD",
];

/// Snapshot the git worktree state: porcelain status, the HEAD diff, and a content
/// hash of untracked files. `None` when any capture step fails.
pub async fn capture_git_worktree_snapshot(cwd: &Path) -> Option<GitWorktreeSnapshot> {
    if !cwd.is_dir() {
        return None;
    }
    let mut pathspec: Vec<String> = vec!["--".to_string(), ".".to_string()];
    for exclude in SNAPSHOT_EXCLUDES {
        pathspec.push(format!(":(exclude){exclude}"));
    }
    let status = run_git(&SNAPSHOT_STATUS_ARGS, &pathspec, cwd).await?;
    let diff = run_git(&SNAPSHOT_DIFF_ARGS, &pathspec, cwd).await?;
    let untracked_hash = hash_untracked_files(cwd, &status);
    Some(GitWorktreeSnapshot {
        status,
        diff,
        untracked_hash,
    })
}

/// One git invocation: `None` on any non-zero exit, timeout, or truncation.
async fn run_git(command: &[&str], pathspec: &[String], cwd: &Path) -> Option<String> {
    let mut args: Vec<String> = SNAPSHOT_GIT_OVERRIDES
        .iter()
        .chain(command)
        .map(std::string::ToString::to_string)
        .collect();
    args.extend(pathspec.iter().cloned());
    // A promisor lazy fetch would run a repository-chosen transport (uploadpack,
    // ssh or ext command, remote helper). GIT_ALLOW_PROTOCOL is an allowlist that
    // overrides every `protocol.*` key, so `none` permits no transport on any git;
    // GIT_NO_LAZY_FETCH (git >= 2.44) skips the fetch attempt.
    let result = run_child_process(
        "git",
        &args,
        cwd,
        SNAPSHOT_TIMEOUT_MS,
        &[("GIT_ALLOW_PROTOCOL", "none"), ("GIT_NO_LAZY_FETCH", "1")],
    )
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

/// Digest of one untracked path: symlink target, file content, or metadata for everything else;
/// capture failures hash their message.
fn hash_untracked_path(path: &Path) -> String {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return "missing".to_string();
    };
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(path).map_or_else(
            |error| error.to_string(),
            |target| target.to_string_lossy().to_string(),
        );
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
                .map_or(0, |duration| duration.as_millis())
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
/// concurrently (a chatty command cannot wedge the wait on a full pipe);
/// `envs` are extra environment entries for the child.
async fn run_child_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout_ms: u64,
    envs: &[(&str, &str)],
) -> anyhow::Result<ChildProcessResult> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .envs(envs.iter().copied())
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
        () = tokio::time::sleep(timeout) => {
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
    let shell = crate::platform::get_shell_config(None)?;
    let mut args = shell.args;
    args.push(command.to_string());
    run_child_process(&shell.shell, &args, cwd, timeout_ms, &[]).await
}

/// Read one output pipe to EOF, keeping at most `cap` bytes of text; the
/// remainder is drained so a full pipe never blocks the child. The bytes are
/// decoded once at the end, so a character split across two reads survives.
async fn read_pipe_capped<R: tokio::io::AsyncRead + Unpin>(mut pipe: Option<R>) -> (String, bool) {
    use tokio::io::AsyncReadExt;
    let cap = MAX_CHILD_PROCESS_OUTPUT_BYTES;
    let mut kept: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    if let Some(pipe) = pipe.as_mut() {
        loop {
            match pipe.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = cap.saturating_sub(kept.len());
                    if read > room {
                        truncated = true;
                    }
                    kept.extend_from_slice(&buffer[..read.min(room)]);
                }
            }
        }
    }
    if truncated {
        // The cap may have cut the last character short; drop its partial bytes.
        if let Some(last) = kept.utf8_chunks().last() {
            let partial = last.invalid().len();
            kept.truncate(kept.len() - partial);
        }
    }
    (String::from_utf8_lossy(&kept).into_owned(), truncated)
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
        let stopped =
            should_autonomously_continue(&mut state, Some(StopReason::Error), &ok_gates()).await;
        assert!(!stopped.should_continue);
        let aborted =
            should_autonomously_continue(&mut state, Some(StopReason::Aborted), &ok_gates()).await;
        assert!(!aborted.should_continue);
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
        std::fs::write(dir.path().join("untracked.txt"), "hello\n").unwrap();
        let with_file = runner.capture_snapshot().await.unwrap();
        assert!(with_file.status.contains("?? untracked.txt"));
        assert_ne!(with_file.untracked_hash, empty.untracked_hash);
        let same = runner.capture_snapshot().await.unwrap();
        assert_eq!(same, with_file);
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

    /// The probes run inside a repository whose own configuration names
    /// programs - an fsmonitor hook, a textconv driver, an index-write
    /// hook, a submodule's textconv driver and fsmonitor hook, and lazy-fetch
    /// transports (an uploadpack and a remote helper). A plain `git diff HEAD`
    /// starts them all on a stale copy of the repository; a capture must
    /// start none of them.
    #[cfg(unix)]
    #[tokio::test]
    async fn snapshot_capture_never_starts_repo_configured_commands() {
        use std::os::unix::fs::PermissionsExt;
        const PROGRAMS: [&str; 5] = [
            "fsmonitor",
            "textconv",
            "hook",
            "subtextconv",
            "subfsmonitor",
        ];
        fn at(path: &Path) -> &str {
            path.to_str().unwrap()
        }
        let root = tempfile::TempDir::new().unwrap();
        let marker = |name: &str| root.path().join(name);
        let script = |path: &Path, target: &str, body: &str| {
            let text = format!("#!/bin/sh\ntouch {}\n{body}\n", marker(target).display());
            std::fs::write(path, text).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let git = |dir: &Path, args: &[&str]| {
            let mut command = std::process::Command::new("git");
            command
                .args(args)
                .current_dir(dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e");
            command.output().unwrap()
        };
        let ok = |dir: &Path, args: &[&str]| git(dir, args).status.success();
        let fresh = |name: &str| {
            let dir = root.path().join(name);
            assert!(ok(root.path(), &["init", "-q", "-b", "main", at(&dir)]));
            dir
        };
        let copy = |from: &Path, name: &str| {
            let to = root.path().join(name);
            let mut cp = std::process::Command::new("cp");
            let status = cp.args(["-R"]).args([from, &to]).status().unwrap();
            assert!(status.success());
            to
        };
        let clear = |names: &[&str]| {
            for name in names {
                let _ = std::fs::remove_file(marker(name));
            }
        };

        // A main repository whose own configuration names four programs and
        // carries a submodule that adds a fifth and sixth path.
        let sub = fresh("sub");
        let sub_tc = sub.join("tc.sh");
        std::fs::write(sub.join("a.txt"), "x\n").unwrap();
        std::fs::write(sub.join(".gitattributes"), "*.txt diff=evil\n").unwrap();
        script(&sub_tc, "subtextconv", "cat \"$1\"");
        assert!(ok(&sub, &["add", "."]));
        assert!(ok(&sub, &["commit", "-qm", "init"]));
        let main = fresh("main");
        let in_main = |args: &[&str]| assert!(ok(&main, args));
        std::fs::write(main.join("top.txt"), "t\n").unwrap();
        assert!(ok(&main, &["add", "."]));
        assert!(ok(&main, &["commit", "-qm", "init"]));
        let mut add = vec!["-c", "protocol.file.allow=always", "submodule", "add"];
        add.extend(["-q", at(&sub), "sub"]);
        assert!(ok(&main, &add));
        assert!(ok(&main, &["commit", "-qm", "sub"]));
        let sub_config = main.join(".git/modules/sub/config");
        let sub_fsm = main.join("subfsm.sh");
        script(&sub_fsm, "subfsmonitor", "exit 0");
        in_main(&[
            "config",
            "-f",
            at(&sub_config),
            "diff.evil.textconv",
            at(&sub_tc),
        ]);
        in_main(&[
            "config",
            "-f",
            at(&sub_config),
            "core.fsmonitor",
            at(&sub_fsm),
        ]);
        let fsm = main.join("fsm.sh");
        let main_tc = main.join("tc.sh");
        let hooks = main.join("hooks");
        script(&fsm, "fsmonitor", "exit 0");
        script(&main_tc, "textconv", "cat \"$1\"");
        std::fs::create_dir(&hooks).unwrap();
        script(&hooks.join("post-index-change"), "hook", ":");
        in_main(&["config", "diff.submodule", "diff"]);
        in_main(&["config", "diff.evil.textconv", at(&main_tc)]);
        in_main(&["config", "core.fsmonitor", at(&fsm)]);
        in_main(&["config", "core.hooksPath", at(&hooks)]);
        std::fs::write(main.join(".gitattributes"), "*.txt diff=evil\n").unwrap();
        std::fs::write(main.join("top.txt"), "two\n").unwrap();
        std::fs::write(main.join("sub/a.txt"), "z\n").unwrap();

        // A plain diff on a stale copy starts every program; the capture on
        // a fresh stale copy must start none of them.
        let old = ["diff", "HEAD"];
        clear(&PROGRAMS);
        let control = copy(&main, "control");
        // The control only has to run the programs; its exit status is incidental.
        let _ = ok(&control, &old);
        for name in PROGRAMS {
            assert!(marker(name).exists(), "control ran no {name}");
        }
        clear(&PROGRAMS);
        let guarded = copy(&main, "guarded");
        let _ = ShellGateRunner::new(&guarded).capture_snapshot().await;
        for name in PROGRAMS {
            assert!(!marker(name).exists(), "the capture ran {name}");
        }

        // With a promisor remote, a missing blob and the repository re-allowing the file
        // protocol, the diff probe would fetch through a repository-chosen uploadpack.
        let uploadpack = main.join("uploadpack.sh");
        script(&uploadpack, "fetch", "exit 0");
        in_main(&["config", "core.repositoryformatversion", "1"]);
        in_main(&["config", "extensions.partialClone", "origin"]);
        in_main(&["config", "protocol.file.allow", "always"]);
        let server = fresh("server");
        std::fs::write(server.join("top.txt"), "t\n").unwrap();
        assert!(ok(&server, &["add", "."]));
        assert!(ok(&server, &["commit", "-qm", "init"]));
        in_main(&["config", "remote.origin.url", at(&server)]);
        in_main(&["config", "remote.origin.promisor", "true"]);
        in_main(&["config", "remote.origin.uploadpack", at(&uploadpack)]);
        let head = git(&main, &["rev-parse", "HEAD:top.txt"]);
        let oid = String::from_utf8_lossy(&head.stdout).trim().to_string();
        let loose = main.join(".git/objects").join(&oid[..2]).join(&oid[2..]);
        std::fs::remove_file(loose).unwrap();
        clear(&["fetch"]);
        let control = copy(&main, "fetch-control");
        let _ = ok(&control, &old);
        assert!(marker("fetch").exists(), "control: no lazy fetch");
        clear(&["fetch"]);
        let guarded = copy(&main, "fetch-guarded");
        let _ = ShellGateRunner::new(&guarded).capture_snapshot().await;
        assert!(!marker("fetch").exists(), "the capture fetched");

        // The same fetch through a remote helper the repository allows; the
        // helper resolves to a repository alias, so nothing is put on PATH.
        let helper = main.join("helper.sh");
        script(&helper, "helper", "exit 1");
        in_main(&["config", "remote.origin.url", "foo::x"]);
        in_main(&["config", "protocol.foo.allow", "always"]);
        in_main(&[
            "config",
            "alias.remote-foo",
            &format!("!{}", helper.display()),
        ]);
        let control = copy(&main, "helper-control");
        let _ = ok(&control, &old);
        assert!(marker("helper").exists(), "control: no remote helper");
        clear(&["helper"]);
        let guarded = copy(&main, "helper-guarded");
        let _ = ShellGateRunner::new(&guarded).capture_snapshot().await;
        assert!(
            !marker("helper").exists(),
            "the capture ran the remote helper"
        );
    }

    /// Edits inside a submodule count as workspace changes.
    #[tokio::test]
    async fn snapshot_tracks_edits_inside_a_submodule() {
        let root = tempfile::TempDir::new().unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@e"])
                .args(["-c", "protocol.file.allow=always"])
                .args(args)
                .current_dir(dir)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        let sub = root.path().join("sub");
        let main = root.path().join("main");
        for dir in [&sub, &main] {
            std::fs::create_dir(dir).unwrap();
            git(dir, &["init", "-q"]);
            std::fs::write(dir.join("a.txt"), "x\n").unwrap();
            git(dir, &["add", "."]);
            git(dir, &["commit", "-qm", "init"]);
        }
        git(
            &main,
            &["submodule", "add", "-q", sub.to_str().unwrap(), "sub"],
        );
        git(&main, &["commit", "-qm", "sub"]);
        let runner = ShellGateRunner::new(&main);
        let clean = runner.capture_snapshot().await.unwrap();
        std::fs::write(main.join("sub/a.txt"), "y\n").unwrap();
        assert_ne!(runner.capture_snapshot().await.unwrap(), clean);
    }

    #[tokio::test]
    async fn a_character_split_across_pipe_reads_is_kept_whole() {
        let output = format!("{}\u{e9} done", "a".repeat(8191));
        let captured =
            read_pipe_capped(Some(std::io::Cursor::new(output.clone().into_bytes()))).await;
        assert_eq!(captured, (output, false));
    }

    #[tokio::test]
    async fn the_cap_never_cuts_inside_a_character() {
        let mut output = "a".repeat(MAX_CHILD_PROCESS_OUTPUT_BYTES - 1);
        output.push_str("\u{e9}\u{e9}");
        let captured = read_pipe_capped(Some(std::io::Cursor::new(output.into_bytes()))).await;
        assert_eq!(
            captured,
            ("a".repeat(MAX_CHILD_PROCESS_OUTPUT_BYTES - 1), true)
        );
    }
}

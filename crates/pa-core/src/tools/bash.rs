//! The `bash` tool: shell command execution with output truncation and a destructive-git dirty-tree
//! guard (execution, guard, truncation, and formatting match the TS tool).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use crate::tools::bash_guard::{
    find_destructive_git_discard_commands, format_dirty_tree_refusal, is_truthy_env_value,
    resolve_discard_probe_target, DiscardProbeResolution, BASH_DESTRUCTIVE_GIT_BYPASS_ENV,
};
use crate::tools::output_accumulator::{OutputAccumulator, OutputAccumulatorOptions};
use crate::tools::shell_utils::get_shell_env;
use crate::tools::tool_definition::{
    AbortSignal, OnUpdate, ToolContentBlock, ToolDefinition, ToolExecutionResult, ToolUpdate,
};
use crate::tools::truncate::{
    format_size, TruncatedBy, TruncationResult, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES,
};

/// The default porcelain status command the guard probes with.
const GIT_STATUS_PORCELAIN_COMMAND: &str = "git status --porcelain --untracked-files=all";

/// Throttle for streamed output updates (TS: `BASH_UPDATE_THROTTLE_MS`).
const BASH_UPDATE_THROTTLE_MS: Duration = Duration::from_millis(100);

pub use crate::tools::bash_local::LocalBashOperations;

pub(crate) type ExecFuture<'a> =
    Pin<Box<dyn Future<Output = anyhow::Result<Option<i32>>> + Send + 'a>>;

/// Execution options for [`BashOperations::exec`].
pub struct ExecOptions<'a> {
    /// Receives streamed stdout/stderr chunks.
    pub on_data: &'a (dyn Fn(&[u8]) + Send + Sync),
    /// Reports the spawned child's pid right after spawn (the
    /// auto-background job id and notice identity). Optional: backends
    /// without process ids leave it unset.
    pub on_spawn: Option<&'a (dyn Fn(u32) + Send + Sync)>,
    /// Cancellation handle; kills the process tree when fired.
    pub signal: Option<AbortSignal>,
    /// Timeout in seconds.
    pub timeout: Option<f64>,
    /// Environment for the child; defaults to the agent shell env.
    pub env: Option<HashMap<String, String>>,
}

/// Pluggable operations for the bash tool. Implementations stream merged stdout/stderr through
/// `on_data`, kill the process tree on cancellation, resolve with the child exit code (`None` when
/// killed by a signal), and reject with `"aborted"` / `"timeout:<seconds>"`. Object-safe on purpose
/// (`&dyn` injection).
pub trait BashOperations: Send + Sync {
    /// Execute a command and stream output through `on_data`; resolves with the exit code (`None`
    /// when killed by a signal), or an error: `"aborted"` or `"timeout:<seconds>"`.
    fn exec<'a>(
        &'a self,
        command: &'a str,
        cwd: &'a str,
        options: ExecOptions<'a>,
    ) -> ExecFuture<'a>;
}

/// Context for the spawn hook: command, cwd, env.
pub struct BashSpawnContext {
    pub command: String,
    pub cwd: String,
    pub env: HashMap<String, String>,
}

pub type BashSpawnHook = Arc<dyn Fn(BashSpawnContext) -> BashSpawnContext + Send + Sync>;

fn resolve_spawn_context(
    command: &str,
    cwd: &str,
    spawn_hook: Option<&BashSpawnHook>,
) -> BashSpawnContext {
    let base = BashSpawnContext {
        command: command.to_string(),
        cwd: cwd.to_string(),
        env: get_shell_env(),
    };
    match spawn_hook {
        Some(hook) => hook(base),
        None => base,
    }
}

/// Options for the bash tool.
#[derive(Default)]
pub struct BashToolOptions {
    /// Custom operations for command execution. Default: local shell.
    pub operations: Option<Arc<dyn BashOperations>>,
    /// Command prefix prepended to every command.
    pub command_prefix: Option<String>,
    /// Optional explicit shell path from settings.
    pub shell_path: Option<String>,
    /// Hook to adjust command, cwd, or env before execution.
    pub spawn_hook: Option<BashSpawnHook>,
    /// The agent loop's arm registry: the ONE config source for promotion.
    /// The loop arms every bash call (window and notice lane; a zero arm
    /// is the disable), and the dispatch takes its window from the arm.
    /// A call with no arm — a direct dispatch outside the loop — never
    /// promotes (see [`pa_agent::auto_background`]).
    pub auto_background_registry:
        Option<std::sync::Arc<pa_agent::auto_background::AutoBackgroundRegistry>>,
}

/// Probe for at-risk files via `git status --porcelain`. Returns `Ok(None)`
/// when dirtiness cannot be determined, so the guard fails open.
async fn probe_uncommitted_changes(
    ops: &dyn BashOperations,
    probe_command: &str,
    cwd: &str,
    env: &HashMap<String, String>,
    signal: Option<AbortSignal>,
    timeout: Option<f64>,
) -> anyhow::Result<Option<Vec<String>>> {
    let output = std::sync::Mutex::new(String::new());
    let result = ops
        .exec(
            probe_command,
            cwd,
            ExecOptions {
                on_data: &|data: &[u8]| {
                    output
                        .lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(data));
                },
                on_spawn: None,
                signal,
                timeout,
                env: Some(env.clone()),
            },
        )
        .await;
    match result {
        Ok(Some(0)) => {}
        Err(err) if err.to_string() == "aborted" => return Err(err),
        Ok(_) | Err(_) => return Ok(None),
    }
    Ok(Some(
        output
            .into_inner()
            .expect("probe output unlocked")
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.trim_end_matches('\r').to_string())
            .collect(),
    ))
}

/// Serialize a truncation result with the TS wire shape.
pub fn truncation_to_json(truncation: &TruncationResult) -> serde_json::Value {
    json!({
        "content": truncation.content,
        "truncated": truncation.truncated,
        "truncatedBy": match truncation.truncated_by {
            Some(TruncatedBy::Lines) => json!("lines"),
            Some(TruncatedBy::Bytes) => json!("bytes"),
            None => serde_json::Value::Null,
        },
        "totalLines": truncation.total_lines,
        "totalBytes": truncation.total_bytes,
        "outputLines": truncation.output_lines,
        "outputBytes": truncation.output_bytes,
        "lastLinePartial": truncation.last_line_partial,
        "firstLineExceedsLimit": truncation.first_line_exceeds_limit,
        "maxLines": truncation.max_lines,
        "maxBytes": truncation.max_bytes,
    })
}

struct FormattedOutput {
    text: String,
    details: Option<serde_json::Value>,
}

fn format_output(
    snapshot: &crate::tools::output_accumulator::OutputSnapshot,
    last_line_bytes: usize,
    empty_text: &str,
) -> FormattedOutput {
    let truncation = &snapshot.truncation;
    let mut text = if snapshot.content.is_empty() {
        empty_text.to_string()
    } else {
        snapshot.content.clone()
    };
    let mut details = None;
    if truncation.truncated {
        let mut d = json!({ "truncation": truncation_to_json(truncation) });
        if let Some(path) = &snapshot.full_output_path {
            d["fullOutputPath"] = json!(path);
        }
        details = Some(d);
        let start_line = truncation.total_lines - truncation.output_lines + 1;
        let end_line = truncation.total_lines;
        // A degraded spill has no path; never advertise a missing file.
        let location = snapshot
            .full_output_path
            .as_deref()
            .map(|p| format!(". Full output: {p}"))
            .unwrap_or_default();
        if truncation.last_line_partial {
            let line_size = if last_line_bytes > 0 {
                format!(" (line is {})", format_size(last_line_bytes))
            } else {
                String::new()
            };
            let _ = write!(
                text,
                "\n\n[Showing last {} of line {start_line}{line_size}{location}]",
                format_size(truncation.output_bytes)
            );
        } else if truncation.truncated_by == Some(TruncatedBy::Lines) {
            let _ = write!(
                text,
                "\n\n[Showing lines {start_line}-{end_line} of {}{location}]",
                truncation.total_lines
            );
        } else {
            let _ = write!(
                text,
                "\n\n[Showing lines {start_line}-{end_line} of {} ({} limit){location}]",
                truncation.total_lines,
                format_size(DEFAULT_MAX_BYTES)
            );
        }
    }
    FormattedOutput { text, details }
}

fn append_status(text: &str, status: &str) -> String {
    if text.is_empty() {
        status.to_string()
    } else {
        format!("{text}\n\n{status}")
    }
}

/// The promoted text's partial-output tail: the last [`OUTPUT_TAIL_CHARS`]
/// characters of the streamed output, so a command that printed an error and
/// then hung stays visible without reading the spill file.
const OUTPUT_TAIL_CHARS: usize = 512;

/// The text-embedded tail of the partial output (`""` when there is none).
fn output_tail_note(content: &str, cap: usize) -> String {
    if content.trim().is_empty() {
        return String::new();
    }
    let tail = content.char_indices().rev().nth(cap.saturating_sub(1));
    let start = match tail {
        Some((index, _)) => index,
        None => 0,
    };
    format!("\n\nOutput so far:\n{}", &content[start..])
}

/// Execute one bash tool call. Errors carry the model-facing text.
// The TS-era parameter list is the tool's contract; `tool_call_id` is a
// Rust-native addition (the promotion arm is keyed per call).
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(
    level = "debug",
    name = "tool_bash_execute",
    skip(cwd, options, on_update)
    fields(command),
)]
pub async fn execute_bash(
    tool_call_id: &str,
    cwd: &str,
    options: &BashToolOptions,
    command: &str,
    timeout: Option<f64>,
    allow_destructive_git: Option<bool>,
    signal: Option<AbortSignal>,
    on_update: Option<OnUpdate>,
) -> anyhow::Result<ToolExecutionResult> {
    let ops: Arc<dyn BashOperations> = match &options.operations {
        Some(ops) => Arc::clone(ops),
        None => Arc::new(LocalBashOperations {
            shell_path: options.shell_path.clone(),
        }),
    };
    let command_prefix = options.command_prefix.as_deref();
    let spawn_hook = options.spawn_hook.as_ref();

    let resolved_command = match command_prefix {
        Some(prefix) => format!("{prefix}\n{command}"),
        None => command.to_string(),
    };
    let spawn_context = resolve_spawn_context(&resolved_command, cwd, spawn_hook);

    // Refuse destructive git discard commands while the tree is dirty.
    let discard_indices = find_destructive_git_discard_commands(&resolved_command);
    if !discard_indices.is_empty()
        && allow_destructive_git != Some(true)
        && !is_truthy_env_value(spawn_context.env.get(BASH_DESTRUCTIVE_GIT_BYPASS_ENV))
    {
        let mut probes: Vec<(BashSpawnContext, bool)> = Vec::new();
        let mut seen_probes: HashSet<String> = HashSet::new();
        let user_command_start = command_prefix.map_or(0, |p| p.len() + 1);
        for index in discard_indices {
            let target = resolve_discard_probe_target(&resolved_command, index, user_command_start);
            match target {
                DiscardProbeResolution::Unresolvable => {
                    anyhow::bail!("{RELOCATION_REFUSAL}");
                }
                DiscardProbeResolution::NotRelocated => {
                    let raw_probe = match command_prefix {
                        Some(prefix) => format!("{prefix}\n{GIT_STATUS_PORCELAIN_COMMAND}"),
                        None => GIT_STATUS_PORCELAIN_COMMAND.to_string(),
                    };
                    let context = resolve_spawn_context(&raw_probe, cwd, spawn_hook);
                    let key = format!("{}\u{0}{}", context.command, context.cwd);
                    if seen_probes.insert(key) {
                        probes.push((context, false));
                    }
                }
                DiscardProbeResolution::Target(target) => {
                    let relocation_prefix = target.relocation_prefix.as_deref().unwrap_or("");
                    let raw_probe = match command_prefix {
                        Some(prefix) => {
                            format!("{prefix}\n{relocation_prefix}{}", target.git_status_command)
                        }
                        None => format!("{relocation_prefix}{}", target.git_status_command),
                    };
                    let context = resolve_spawn_context(&raw_probe, cwd, spawn_hook);
                    let key = format!("{}\u{0}{}", context.command, context.cwd);
                    if seen_probes.insert(key) {
                        probes.push((
                            context,
                            target.git_status_command.contains("--ignored=matching"),
                        ));
                    }
                }
            }
        }
        for (context, includes_ignored) in probes {
            let dirty_paths = probe_uncommitted_changes(
                ops.as_ref(),
                &context.command,
                &context.cwd,
                &context.env,
                signal.clone(),
                timeout,
            )
            .await?;
            if let Some(paths) = dirty_paths.filter(|paths| !paths.is_empty()) {
                anyhow::bail!("{}", format_dirty_tree_refusal(&paths, includes_ignored));
            }
        }
    }

    let acc = Arc::new(Mutex::new(OutputAccumulator::new(
        &OutputAccumulatorOptions {
            temp_file_prefix: "pi-bash".to_string(),
            ..OutputAccumulatorOptions::default()
        },
    )));
    let notify = Arc::new(tokio::sync::Notify::new());
    let dirty = Arc::new(AtomicBool::new(false));

    if let Some(on_update) = &on_update {
        on_update(ToolUpdate {
            content: Vec::new(),
            details: None,
        });
    }

    // The promotion window has ONE source: the agent loop's per-call arm
    // in the shared registry (the loop arms every bash call, zero
    // included, so its disable reaches the dispatch as a zero arm). A call
    // with no arm — a direct dispatch outside the loop — never promotes.
    let (mut window, notice) = match options
        .auto_background_registry
        .as_ref()
        .and_then(|registry| registry.take(tool_call_id))
    {
        Some(arm) => (arm.window, arm.notice),
        None => (Duration::ZERO, None),
    };
    // A promotion without a notice lane strands the command: the synthetic
    // result promises a completion notification that can never arrive, and
    // nothing re-reads the job afterwards. Promotion requires the lane.
    if notice.is_none() {
        window = Duration::ZERO;
    }

    // The command runs in its own task so a promotion can hand it off: on
    // promotion this call returns while the task keeps driving the process,
    // streaming output into the accumulator's disk spill, and the
    // completion notice goes out through the same lane a backgrounded
    // `bash()` job uses. The command KEEPS RUNNING; nothing is killed.
    let on_data = {
        let notify = notify.clone();
        let dirty = dirty.clone();
        let acc = acc.clone();
        Arc::new(move |data: &[u8]| {
            acc.lock().unwrap().append(data);
            dirty.store(true, Ordering::SeqCst);
            notify.notify_one();
        }) as Arc<dyn Fn(&[u8]) + Send + Sync>
    };
    let pid_slot = Arc::new(Mutex::new(None::<u32>));
    // The promotion/completion handoff: RUNNING -> PROMOTED (the caller's
    // window edge) or RUNNING -> DONE (the exec task's completion). The
    // compare-exchange decides exactly one winner when both race the same
    // edge, so neither the completion notice nor the ExecDone handoff is
    // lost.
    let handoff = Arc::new(AtomicU8::new(HANDOFF_RUNNING));
    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel::<ExecDone>();
    // The caller's wake channel for the promotion (the task watches the
    // same `Notify` the output stream uses).
    let notify_caller = Arc::clone(&notify);

    {
        let ops = Arc::clone(&ops);
        let task_command = spawn_context.command.clone();
        // The notice carries the raw command (kernel parity: the prefix is
        // machinery, not the user's command).
        let notice_command = command.to_string();
        let task_cwd = spawn_context.cwd.clone();
        let task_env = spawn_context.env.clone();
        // The promoted job outlives the run: a user abort later in the
        // same run must not kill a job the model was told keeps running
        // (kernel parity — backgrounded `bash()` handles survive run
        // aborts). The gate forwards the run's abort to the job's signal
        // only while the call is still inline (RUNNING); once the
        // promotion edge claims the job, the run's signal is decoupled.
        let task_signal = AbortSignal::new();
        {
            let gate_run_signal = signal.clone();
            let gate_handoff = Arc::clone(&handoff);
            let gate_job_signal = task_signal.clone();
            // The gate claims the handoff ONLY from RUNNING, exactly like
            // the promotion and the completion edges: an abort at the
            // promotion boundary cannot both kill the job and leave the
            // synthetic "keeps running" result. Once the handoff settles
            // (promotion, completion, or abort) the gate exits, so it
            // never outlives the call it guarded.
            tokio::spawn(async move {
                let Some(run_signal) = gate_run_signal else {
                    return;
                };
                loop {
                    tokio::select! {
                        // Immediate: an abort that lands while the call is
                        // still inline must reach the claim race without
                        // waiting out a poll interval.
                        () = run_signal.cancelled() => break,
                        () = tokio::time::sleep(Duration::from_millis(50)) => {
                            if gate_handoff.load(Ordering::SeqCst) != HANDOFF_RUNNING {
                                // The handoff settled (promotion,
                                // completion, or a competing abort): the
                                // gate is closed — exit now, so it never
                                // outlives the call it guarded.
                                return;
                            }
                        }
                    }
                }
                // Claim the abort edge ONLY from RUNNING, exactly like the
                // promotion and the completion edges: an abort at the
                // promotion boundary cannot both kill the job and leave the
                // synthetic "keeps running" result standing.
                if gate_handoff
                    .compare_exchange(
                        HANDOFF_RUNNING,
                        HANDOFF_ABORTED,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    gate_job_signal.cancel();
                }
            });
        }
        let task_on_update = on_update.clone();
        let on_data = Arc::clone(&on_data);
        let pid_slot = Arc::clone(&pid_slot);
        let handoff = Arc::clone(&handoff);
        let acc = Arc::clone(&acc);
        tokio::spawn(async move {
            let on_spawn = {
                let pid_slot = Arc::clone(&pid_slot);
                move |pid: u32| {
                    *pid_slot.lock().unwrap() = Some(pid);
                    // Kernel `bash()` lane parity: the orphan record is
                    // journaled at spawn, with the process identity captured
                    // while the child is live (a fast exit and PID reuse
                    // cannot strand an unidentifiable record). The
                    // completion releases it on both handoff branches.
                    crate::kernel::orphan_journal::record_orphan_process_state(pid as i32, true);
                }
            };
            let exec_fut = ops.exec(
                &task_command,
                &task_cwd,
                ExecOptions {
                    on_data: on_data.as_ref(),
                    on_spawn: Some(&on_spawn),
                    signal: Some(task_signal),
                    timeout,
                    env: Some(task_env),
                },
            );
            tokio::pin!(exec_fut);

            let mut task_on_update = task_on_update;
            let mut update_lane_settled = false;
            let mut last_update_at: Option<std::time::Instant> = None;
            let exec_result: anyhow::Result<Option<i32>> = loop {
                let deadline = if dirty.load(Ordering::SeqCst) {
                    last_update_at.map(|last| {
                        let elapsed = last.elapsed();
                        if elapsed >= BASH_UPDATE_THROTTLE_MS {
                            std::time::Instant::now()
                        } else {
                            last + BASH_UPDATE_THROTTLE_MS
                        }
                    })
                } else {
                    None
                };
                tokio::select! {
                    () = notify.notified() => {}
                    () = async {
                        match deadline {
                            Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
                            None => std::future::pending::<()>().await,
                        }
                    }, if deadline.is_some() => {}
                    result = &mut exec_fut => {
                        break result;
                    }
                }
                // The caller promoted: release the streamed-update lane
                // NOW, not at process exit — the agent loop's update
                // emitter drains only once every callback sender drops,
                // so holding the callback here would wedge the tool call
                // (and the turn) until the process finished.
                if !update_lane_settled && handoff.load(Ordering::SeqCst) != HANDOFF_RUNNING {
                    // Promoted or abort-gated: no caller is streaming, so
                    // release the update lane NOW.
                    update_lane_settled = true;
                    task_on_update = None;
                }
                if dirty.swap(false, Ordering::SeqCst) {
                    last_update_at = Some(std::time::Instant::now());
                    if let Some(on_update) = &task_on_update {
                        let snapshot = acc.lock().unwrap().snapshot();
                        on_update(ToolUpdate {
                            content: vec![ToolContentBlock::text(snapshot.content.clone())],
                            details: Some(json!({
                                "truncation": if snapshot.truncation.truncated {
                                    truncation_to_json(&snapshot.truncation)
                                } else {
                                    serde_json::Value::Null
                                },
                                "fullOutputPath": snapshot.full_output_path,
                            })),
                        });
                    }
                }
            };

            {
                let mut acc = acc.lock().unwrap();
                acc.finish();
            }
            let (snapshot, last_line_bytes) = {
                let mut acc = acc.lock().unwrap();
                acc.close_temp_file_sync();
                let snapshot = acc.snapshot();
                (snapshot, acc.get_last_line_bytes())
            };
            let pid = *pid_slot.lock().unwrap();
            // The spawn-time orphan record is released at completion,
            // whichever way the handoff settled (best-effort, kernel-lane
            // parity; the write is ordered after the spawn's active write).
            if let Some(pid) = pid {
                crate::kernel::orphan_journal::record_orphan_process_state(pid as i32, false);
            }
            let claimed_done = handoff
                .compare_exchange(
                    HANDOFF_RUNNING,
                    HANDOFF_DONE,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok();
            if let Some(notice) = (!claimed_done
                && handoff.load(Ordering::SeqCst) == HANDOFF_PROMOTED)
                .then(|| notice.clone())
                .flatten()
            {
                // The caller claimed the promotion edge first: the
                // completion rides the notice lane. A terminal exec
                // failure keeps the partial output and appends the same
                // status line the inline catch path renders (aborted /
                // timeout:N), so the diagnostic survives the promotion;
                // the row itself stays kernel-parity (no exit code).
                let mut output = snapshot.content.clone();
                let mut status = None;
                let failure = exec_result.as_ref().err().map(ToString::to_string);
                if failure.as_deref() == Some("aborted") {
                    status = Some("Command aborted".to_string());
                    output = append_status(&output, "Command aborted");
                } else if let Some(secs) = failure
                    .as_deref()
                    .and_then(|failure| failure.strip_prefix("timeout:"))
                {
                    let line = format!("Command timed out after {secs} seconds");
                    status = Some(line.clone());
                    output = append_status(&output, &line);
                }
                notice(pa_agent::auto_background::AutoBackgroundCompletion {
                    pid,
                    exit_code: exec_result.as_ref().ok().copied().flatten(),
                    command: notice_command,
                    output,
                    full_output_path: snapshot.full_output_path.clone(),
                    status,
                });
                // The caller may still be inside its promotion-edge grace
                // wait (the claim raced its window): deliver the ExecDone
                // too — a caller that already returned drops it silently.
                let _ = done_tx.send(ExecDone {
                    result: exec_result,
                    snapshot,
                    last_line_bytes,
                });
            } else {
                // DONE claimed inline, or the abort gate claimed ABORTED:
                // the caller is still inline (an aborted run drops its
                // frame in practice); hand it the real result. No notice —
                // the inline caller reports the outcome itself.
                let _ = done_tx.send(ExecDone {
                    result: exec_result,
                    snapshot,
                    last_line_bytes,
                });
            }
        });
    }

    enum ExecEvent {
        Done(ExecDone),
        Promoted,
    }
    let exec_event = if window.is_zero() {
        match done_rx.await {
            Ok(done) => ExecEvent::Done(done),
            Err(_) => anyhow::bail!("bash execution task failed"),
        }
    } else {
        let raced = tokio::select! {
            done = &mut done_rx => match done {
                Ok(done) => ExecEvent::Done(done),
                Err(_) => anyhow::bail!("bash execution task failed"),
            },
            () = tokio::time::sleep(window) => ExecEvent::Promoted,
        };
        match raced {
            // A job without a pid has no wake lane: the daemon's mapper
            // cannot name it in a `[bash-done]` row, so the synthetic text
            // would promise a completion notification that can never
            // arrive. It must not detach — it runs inline to completion
            // (the same contract as a promotion without a notice lane).
            ExecEvent::Promoted if pid_slot.lock().unwrap().is_none() => match done_rx.await {
                Ok(done) => ExecEvent::Done(done),
                Err(_) => anyhow::bail!("bash execution task failed"),
            },
            // The window edge claims the promotion only from RUNNING: the
            // exec task may have completed at the same instant (claimed
            // DONE), or the abort gate may have claimed ABORTED.
            ExecEvent::Promoted => {
                // No claim-time journaling: the orphan record was written at
                // spawn with the identity captured while the child was live
                // (kernel-lane parity; see on_spawn), and the completion
                // releases it whichever way the edge settles.
                if handoff
                    .compare_exchange(
                        HANDOFF_RUNNING,
                        HANDOFF_PROMOTED,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    ExecEvent::Promoted
                } else {
                    // The claim lost the edge (completion or abort gate):
                    // the job never detached; a DONE-claimed task's channel send is microseconds
                    // away (only a task panic can drop it); an ABORTED
                    // task delivers its result at the killed process's
                    // exit. Wait instead of failing the call.
                    match done_rx.try_recv() {
                        Ok(done) => ExecEvent::Done(done),
                        Err(_) => {
                            if let Ok(Ok(done)) =
                                tokio::time::timeout(PROMOTION_EDGE_RECV, &mut done_rx).await
                            {
                                ExecEvent::Done(done)
                            } else {
                                if handoff.load(Ordering::SeqCst) == HANDOFF_ABORTED {
                                    anyhow::bail!("aborted");
                                }
                                anyhow::bail!(
                                    "bash completion raced the promotion edge and was lost"
                                )
                            }
                        }
                    }
                }
            }
            event @ ExecEvent::Done(_) => event,
        }
    };

    match exec_event {
        ExecEvent::Promoted => {
            // Wake the exec task so it observes the promotion and releases
            // the streamed-update lane (see the task body).
            notify_caller.notify_one();
            let pid = *pid_slot.lock().unwrap();
            let snapshot = {
                let mut acc = acc.lock().unwrap();
                // The synthetic result promises the output streams to disk:
                // force the spill open so `fullOutputPath` exists even for
                // a low-output command (the only later re-read path).
                acc.force_spill();
                acc.snapshot()
            };
            // The orphan record for this pid was written at spawn
            // (see on_spawn), so a worker crash or restart reaps its
            // process group instead of leaking it behind a wake that can
            // never arrive.
            // The pid-less guard ran before the claim: only a reported
            // pid can name the job in the `[bash-done]` wake row, so the
            // promoted job is its pid — there is no fallback job id.
            let job = match pid {
                Some(pid) => pid.to_string(),
                None => unreachable!("the pid-less guard refused the promotion"),
            };
            let window_text = if window.as_millis() % 1000 == 0 {
                format!("{}s", window.as_secs())
            } else {
                format!("{}ms", window.as_millis())
            };
            let mut details = json!({
                "autoBackgrounded": true,
                // The running marker: the promoted result renders as a
                // live job, not a finished successful command (#3523's
                // `BashSnapshot.running` parity for the TUI/ACP surfaces).
                "running": true,
                "pid": pid,
                "command": command,
                "output": snapshot.content,
            });
            if let Some(path) = &snapshot.full_output_path {
                details["fullOutputPath"] = json!(path);
            }
            // The spill path goes in the TEXT, not just `details` (details
            // are for logs and UI rendering; they never reach the model):
            // without it the model cannot find the streamed output after
            // the wake.
            let spill_note = match &snapshot.full_output_path {
                Some(path) => format!("Output streams to disk: {path}."),
                None => "Output streams to disk.".to_string(),
            };
            // The last stretch of the partial output also goes in the text:
            // a command that printed an error and then hung stays visible
            // without the model going to read the spill.
            let output_note = output_tail_note(&snapshot.content, OUTPUT_TAIL_CHARS);
            Ok(ToolExecutionResult {
                content: vec![ToolContentBlock::text(format!(
                    "Command exceeded {window_text}. Auto-backgrounded as job {job}. \
{spill_note} The completion notification wakes the turn. Continue other work or end the turn.\
{output_note}"
                ))],
                details: Some(details),
                is_error: false,
            })
        }
        ExecEvent::Done(ExecDone {
            result: exec_result,
            snapshot,
            last_line_bytes,
        }) => match exec_result {
            Err(err) => {
                // TS catch path: timeouts and aborts keep the partial output and
                // append a status line; other errors surface raw.
                let message = err.to_string();
                if message == "aborted" {
                    let formatted = format_output(&snapshot, last_line_bytes, "");
                    anyhow::bail!(append_status(&formatted.text, "Command aborted"));
                }
                if let Some(secs) = message.strip_prefix("timeout:") {
                    let formatted = format_output(&snapshot, last_line_bytes, "");
                    anyhow::bail!(append_status(
                        &formatted.text,
                        &format!("Command timed out after {secs} seconds")
                    ));
                }
                Err(err)
            }
            Ok(exit_code) => {
                let formatted = format_output(&snapshot, last_line_bytes, "(no output)");
                let text = formatted.text;
                if exit_code.is_some_and(|code| code != 0) {
                    anyhow::bail!(append_status(
                        &text,
                        &format!("Command exited with code {}", exit_code.unwrap())
                    ));
                }
                Ok(ToolExecutionResult {
                    content: vec![ToolContentBlock::text(text)],
                    details: formatted.details,
                    is_error: false,
                })
            }
        },
    }
}

/// The detached exec task's handoff: the process result plus the finished
/// accumulator snapshot.
struct ExecDone {
    result: anyhow::Result<Option<i32>>,
    snapshot: crate::tools::output_accumulator::OutputSnapshot,
    last_line_bytes: usize,
}

/// The promotion/completion handoff states (see [`execute_bash`]): RUNNING
/// moves to exactly one of PROMOTED (the caller's window edge), DONE (the
/// exec task's completion), or ABORTED (the abort gate forwarding a run
/// abort while the call is still inline) — the compare-exchanges decide
/// the edge races atomically.
const HANDOFF_RUNNING: u8 = 0;
const HANDOFF_PROMOTED: u8 = 1;
const HANDOFF_DONE: u8 = 2;
const HANDOFF_ABORTED: u8 = 3;

/// Grace for the promotion-edge recv: a DONE-claimed task's channel send is
/// microseconds away; the bound only guards a panicked task.
const PROMOTION_EDGE_RECV: Duration = Duration::from_millis(500);

pub fn bash_tool_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "required": ["command"],
        "properties": {
            "command": {
                "type": "string",
                "description": "Bash command to execute"
            },
            "timeout": {
                "type": "number",
                "description": "Timeout in seconds (optional, no default timeout)"
            },
            "allowDestructiveGit": {
                "type": "boolean",
                "description": "Skip the dirty-tree guard for destructive git discard commands. Only set when discarding uncommitted work is intentional."
            }
        }
    })
}

pub fn bash_tool_description() -> String {
    format!(
        "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last {DEFAULT_MAX_LINES} lines or {}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Destructive git discard commands (git checkout -- ., git checkout ., git clean -f..., git reset --hard, git restore .) are refused while uncommitted changes exist; retry with allowDestructiveGit: true only when the discard is intentional.",
        DEFAULT_MAX_BYTES / 1024
    )
}

/// The `bash` tool definition: exact name, schema, and description.
#[must_use]
pub fn create_bash_tool_definition(cwd: &str) -> ToolDefinition {
    create_bash_tool_definition_with_options(cwd, &BashToolOptions::default())
}

#[must_use]
pub fn create_bash_tool_definition_with_options(
    cwd: &str,
    options: &BashToolOptions,
) -> ToolDefinition {
    let cwd = cwd.to_string();
    let operations = options.operations.clone();
    let command_prefix = options.command_prefix.clone();
    let shell_path = options.shell_path.clone();
    let spawn_hook = options.spawn_hook.clone();
    let auto_background_registry = options.auto_background_registry.clone();
    let execute: crate::tools::tool_definition::ExecuteFn = {
        Arc::new(move |tool_call_id, params, signal, on_update| {
            let cwd = cwd.clone();
            let tool_call_id = tool_call_id.to_string();
            let options = BashToolOptions {
                operations: operations.clone(),
                command_prefix: command_prefix.clone(),
                shell_path: shell_path.clone(),
                spawn_hook: spawn_hook.clone(),
                auto_background_registry: auto_background_registry.clone(),
            };
            Box::pin(async move {
                let command = params
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("bash tool requires a command string"))?
                    .to_string();
                let timeout = params.get("timeout").and_then(serde_json::Value::as_f64);
                let allow_destructive_git = params
                    .get("allowDestructiveGit")
                    .and_then(serde_json::Value::as_bool);
                execute_bash(
                    &tool_call_id,
                    &cwd,
                    &options,
                    &command,
                    timeout,
                    allow_destructive_git,
                    signal,
                    on_update,
                )
                .await
            })
        })
    };
    ToolDefinition {
        name: "bash".to_string(),
        label: "bash".to_string(),
        description: bash_tool_description(),
        prompt_snippet: "Execute bash commands (ls, grep, find, etc.)".to_string(),
        parameters: bash_tool_schema(),
        execution_mode: None,
        prepare_arguments: None,
        execute,
    }
}

/// Refusal text for discard commands whose target repository cannot be
/// resolved safely (TS: `formatRelocationRefusal`).
const RELOCATION_REFUSAL: &str = "Refusing to run this destructive git command: it changes directory (or repository) first, and the uncommitted changes of the repository it targets cannot be checked safely.\n\nRun the discard as its own command from the target directory, or retry with allowDestructiveGit: true, or set PI_BASH_ALLOW_DESTRUCTIVE_GIT=1.";

#[cfg(test)]
mod auto_background_tests {
    //! The promotion contract: an inline bash call still running past the
    //! window is handed off to the background machinery (the command keeps
    //! running, output keeps streaming, the completion notice fires), the
    //! tool result returns immediately with the synthetic text, and a call
    //! under the window (or with promotion disabled) runs inline unchanged.

    use std::sync::{Arc, MutexGuard};
    use std::time::{Duration, Instant};

    use super::{
        execute_bash, output_tail_note, BashOperations, BashToolOptions, ExecFuture, ExecOptions,
        OUTPUT_TAIL_CHARS,
    };
    use crate::kernel::orphan_journal::ORPHAN_PROCESS_JOURNAL_ENV;
    use pa_agent::auto_background::AutoBackgroundCompletion;

    #[tokio::test]
    async fn a_call_past_the_window_promotes_and_notifies() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        registry.arm(
            "test-promote",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_secs(2),
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let options = BashToolOptions {
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };

        let started = Instant::now();
        let result = execute_bash(
            "test-promote",
            ".",
            &options,
            "sleep 5; echo promoted-lander",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("promotion returns Ok");
        // (a) The tool result returns by the window, not the command.
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "promotion must return at the window, took {:?}",
            started.elapsed()
        );
        let text = result.content[0].as_text().expect("text block");
        assert!(
            text.starts_with("Command exceeded 2s. Auto-backgrounded as job "),
            "unexpected synthetic text: {text}"
        );
        // The spill path must be IN the text: details never reach the model.
        let details = result.details.clone().expect("promotion details");
        let spill_path = details["fullOutputPath"].as_str().expect("spill path");
        assert!(
            text.contains(&format!("Output streams to disk: {spill_path}.")),
            "the synthetic text must carry the spill path: {text}"
        );
        assert!(text.contains(
            "The completion notification wakes the turn. Continue other work or end the turn."
        ));
        assert!(!result.is_error);
        let details = result.details.clone().expect("promotion details");
        assert_eq!(details["autoBackgrounded"], serde_json::json!(true));
        // The running marker: the promoted result renders as a live job,
        // not a finished successful command (#3523's BashSnapshot parity).
        assert_eq!(details["running"], serde_json::json!(true));
        let pid = details["pid"].as_u64().expect("pid reported");

        // (a) The process outlives the call; its output lands via the
        // notice and the byte-cursor reads it back.
        let completion = tokio::time::timeout(Duration::from_secs(8), rx.recv())
            .await
            .expect("completion notice wakes within the bound")
            .expect("notice channel alive");
        assert_eq!(completion.pid, Some(u32::try_from(pid).expect("pid fits")));
        assert_eq!(completion.exit_code, Some(0));
        assert_eq!(completion.command, "sleep 5; echo promoted-lander");
        assert!(
            completion.output.contains("promoted-lander"),
            "byte-cursor read: {}",
            completion.output
        );
    }

    #[tokio::test]
    async fn a_call_under_the_window_runs_inline() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        registry.arm(
            "test-inline",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_secs(10),
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let options = BashToolOptions {
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };

        let result = execute_bash(
            "test-inline",
            ".",
            &options,
            "echo quick-lander",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("inline call succeeds");
        // (b) No promotion: the normal output returns, no notice fires.
        let text = result.content[0].as_text().expect("text block");
        assert_eq!(text, "quick-lander\n");
        assert!(result.details.is_none());
        assert!(rx.try_recv().is_err(), "no notice for an inline call");
    }

    #[tokio::test]
    async fn a_zero_window_disables_promotion() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        registry.arm(
            "test-disabled",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::ZERO,
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let options = BashToolOptions {
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };

        let started = Instant::now();
        let result = execute_bash(
            "test-disabled",
            ".",
            &options,
            "sleep 2; echo slow-lander",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("disabled promotion runs inline");
        // (c) T=0 keeps the old contract: the call blocks to completion.
        assert!(
            started.elapsed() >= Duration::from_secs(2),
            "T=0 must not promote, returned after {:?}",
            started.elapsed()
        );
        assert_eq!(
            result.content[0].as_text().expect("text block"),
            "slow-lander\n"
        );
        assert!(rx.try_recv().is_err(), "no notice when promotion is off");
    }

    /// A `BashOperations` whose exec resolves only when the test releases it
    /// (edge-race control: the release fires at the promotion window).
    struct HeldOps {
        release: Arc<tokio::sync::Notify>,
    }

    impl BashOperations for HeldOps {
        fn exec<'a>(
            &'a self,
            _command: &'a str,
            _cwd: &'a str,
            options: ExecOptions<'a>,
        ) -> ExecFuture<'a> {
            let release = Arc::clone(&self.release);
            Box::pin(async move {
                if let Some(on_spawn) = options.on_spawn {
                    on_spawn(4321);
                }
                release.notified().await;
                (options.on_data)(b"edge-lander\n");
                Ok(Some(0))
            })
        }
    }

    #[tokio::test]
    async fn a_zero_window_arm_disables_promotion() {
        // The loop's zero arm is the disable: the dispatch must honor it
        // even though the notice lane is wired (a live lane alone must not
        // resurrect a window the loop resolved to zero).
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        let notice: pa_agent::auto_background::AutoBackgroundNoticeFn =
            Arc::new(move |completion| {
                tx.send(completion).ok();
            });
        registry.arm(
            "call-0",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::ZERO,
                notice: Some(Arc::clone(&notice)),
            },
        );
        let ops = Arc::new(HeldOps {
            release: Arc::new(tokio::sync::Notify::new()),
        });
        let release = Arc::clone(&ops.release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            release.notify_one();
        });
        let options = BashToolOptions {
            operations: Some(ops),
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash("call-0", ".", &options, "sleep 1", None, None, None, None)
            .await
            .expect("zero arm runs inline");
        let text = result.content[0].as_text().expect("text block");
        assert!(
            !text.starts_with("Command exceeded"),
            "the zero arm must disable promotion, got: {text}"
        );
        assert!(result.details.is_none(), "no promotion details");
        assert!(rx.try_recv().is_err(), "no notice for a disabled call");
    }

    #[tokio::test]
    async fn promotion_requires_a_notice_lane() {
        // Without a completion lane the synthetic result would promise a
        // wake that can never arrive: promotion must not fire.
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        registry.arm(
            "call-1",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_millis(200),
                notice: None,
            },
        );
        let ops = Arc::new(HeldOps {
            release: Arc::new(tokio::sync::Notify::new()),
        });
        let release = Arc::clone(&ops.release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            release.notify_one();
        });
        let options = BashToolOptions {
            operations: Some(ops),
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash("call-1", ".", &options, "sleep 1", None, None, None, None)
            .await
            .expect("laneless call runs inline");
        let text = result.content[0].as_text().expect("text block");
        assert!(
            !text.starts_with("Command exceeded"),
            "promotion without a notice lane strands the command: {text}"
        );
        assert!(result.details.is_none(), "no promotion details");
    }

    #[tokio::test]
    async fn promotion_releases_the_streamed_update_lane() {
        // The agent loop's update emitter drains only once every callback
        // sender drops: the exec task must release the on_update callback
        // at promotion, not at process exit (or the tool call wedges).
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        let notice: pa_agent::auto_background::AutoBackgroundNoticeFn =
            Arc::new(move |completion| {
                tx.send(completion).ok();
            });
        registry.arm(
            "call-2",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_millis(200),
                notice: Some(Arc::clone(&notice)),
            },
        );
        let callback: super::OnUpdate = Arc::new(|_| {});
        let ops = Arc::new(HeldOps {
            release: Arc::new(tokio::sync::Notify::new()),
        });
        let release = Arc::clone(&ops.release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            release.notify_one();
        });
        let options = BashToolOptions {
            operations: Some(ops),
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash(
            "call-2",
            ".",
            &options,
            "sleep 8",
            None,
            None,
            None,
            Some(Arc::clone(&callback)),
        )
        .await
        .expect("promotion returns Ok");
        assert!(
            result.content[0]
                .as_text()
                .expect("text block")
                .starts_with("Command exceeded"),
            "the call must promote"
        );
        // The exec task's callback clone must drop once the task observes
        // the promotion — long before the held command's release at 2s
        // (a teardown deferred to process exit fails this deadline).
        let deadline = Instant::now() + Duration::from_secs(1);
        while Arc::strong_count(&callback) > 1 {
            assert!(
                Instant::now() < deadline,
                "the promoted exec task never released the update lane"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let completion = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("the held command completes after teardown")
            .expect("notice lane open");
        assert_eq!(completion.pid, Some(4321));
    }

    #[tokio::test]
    async fn the_promotion_edge_never_strands_a_completion() {
        // The window edge and the completion can race: exactly one of
        // {synthetic result, then notice} or {normal result, no notice}
        // must hold — never a synthetic result with no completion and
        // never a lost ExecDone.
        let window = Duration::from_millis(300);
        // The release alternates: just before the window (the Done path
        // must win) and just after it (the promotion must win and the
        // notice must land) — plus the true edge in between.
        for rep in 0..10 {
            let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
            let notice: pa_agent::auto_background::AutoBackgroundNoticeFn =
                Arc::new(move |completion| {
                    tx.send(completion).ok();
                });
            registry.arm(
                "call-3",
                pa_agent::auto_background::AutoBackgroundArm {
                    window,
                    notice: Some(Arc::clone(&notice)),
                },
            );
            let ops = Arc::new(HeldOps {
                release: Arc::new(tokio::sync::Notify::new()),
            });
            let release = Arc::clone(&ops.release);
            // Fire the release around the window edge itself.
            let release_delay = Duration::from_millis(match rep % 2 {
                0 => 295,
                _ => 305,
            });
            tokio::spawn(async move {
                tokio::time::sleep(release_delay).await;
                release.notify_one();
            });
            let options = BashToolOptions {
                operations: Some(ops),
                auto_background_registry: Some(Arc::new(registry)),
                ..BashToolOptions::default()
            };
            let result = execute_bash(
                "call-3",
                ".",
                &options,
                "held command",
                None,
                None,
                None,
                None,
            )
            .await
            .expect("edge call resolves");
            let text = result.content[0].as_text().expect("text block");
            if text.starts_with("Command exceeded") {
                let completion = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                    .await
                    .expect("a promoted call's completion must arrive")
                    .expect("notice lane open");
                assert_eq!(completion.exit_code, Some(0));
            } else {
                assert_eq!(text, "edge-lander\n", "normal result carries the output");
                assert!(
                    rx.try_recv().is_err(),
                    "an inline completion fires no notice"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_promoted_command_that_fails_keeps_the_diagnostic() {
        // A promoted job's terminal exec failure (aborted / timeout:N)
        // must not lose its diagnostic: the inline catch path renders the
        // same status line, and the completion carries it (the row stays
        // parity — no exit code reports as -1).
        struct FailingOps;
        impl BashOperations for FailingOps {
            fn exec<'a>(
                &'a self,
                _command: &'a str,
                _cwd: &'a str,
                options: ExecOptions<'a>,
            ) -> ExecFuture<'a> {
                Box::pin(async move {
                    if let Some(on_spawn) = options.on_spawn {
                        on_spawn(4321);
                    }
                    (options.on_data)(b"partial-lander\n");
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    Err(anyhow::anyhow!("timeout:1"))
                })
            }
        }
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        let notice: pa_agent::auto_background::AutoBackgroundNoticeFn =
            Arc::new(move |completion| {
                tx.send(completion).ok();
            });
        registry.arm(
            "call-4",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_millis(100),
                notice: Some(Arc::clone(&notice)),
            },
        );
        let options = BashToolOptions {
            operations: Some(Arc::new(FailingOps)),
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash(
            "call-4",
            ".",
            &options,
            "slow failure",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("promotion returns Ok");
        assert!(
            result.content[0]
                .as_text()
                .expect("text block")
                .starts_with("Command exceeded"),
            "the call must promote"
        );
        let completion = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("the failed job's completion arrives")
            .expect("notice lane open");
        // No exit code: the row renders -1, kernel-parity for a job that
        // died without reporting one.
        assert_eq!(completion.exit_code, None);
        // The diagnostic survives: partial output plus the same status
        // line the inline catch path renders.
        assert_eq!(completion.pid, Some(4321));
        assert!(
            completion.output.contains("partial-lander"),
            "byte-cursor read: {}",
            completion.output
        );
        assert!(
            completion
                .output
                .ends_with("Command timed out after 1 seconds"),
            "the completion must carry the failure diagnostic: {}",
            completion.output
        );
    }

    /// A backend that never reports a pid: `on_spawn` is never called, so
    /// the promotion edge sees `pid: None` — exactly the case where the
    /// daemon mapper would drop the completion (no `[bash-done]` row).
    struct PidlessOps {
        release: Arc<tokio::sync::Notify>,
    }

    impl BashOperations for PidlessOps {
        fn exec<'a>(
            &'a self,
            _command: &'a str,
            _cwd: &'a str,
            options: ExecOptions<'a>,
        ) -> ExecFuture<'a> {
            let release = Arc::clone(&self.release);
            Box::pin(async move {
                // Deliberately NO on_spawn call: the pid is never reported.
                release.notified().await;
                (options.on_data)(b"pidless-lander\n");
                Ok(Some(0))
            })
        }
    }

    #[tokio::test]
    async fn a_pidless_job_never_detaches() {
        // A job without a pid has no wake lane (the mapper returns None),
        // so the synthetic text would promise a completion notification
        // that can never arrive. It must run inline to completion instead.
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        registry.arm(
            "call-pidless",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_millis(200),
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let ops = Arc::new(PidlessOps {
            release: Arc::new(tokio::sync::Notify::new()),
        });
        let release = Arc::clone(&ops.release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            release.notify_one();
        });
        let options = BashToolOptions {
            operations: Some(ops),
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash(
            "call-pidless",
            ".",
            &options,
            "held",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("pidless call resolves");
        // Inline completion: the real output, no synthetic text, no notice.
        assert_eq!(
            result.content[0].as_text().expect("text block"),
            "pidless-lander\n"
        );
        assert!(result.details.is_none(), "no promotion details");
        assert!(rx.try_recv().is_err(), "no notice for an inline call");
    }

    #[tokio::test]
    async fn a_promoted_text_carries_the_partial_output_tail() {
        // A command that printed an error and then hung stays visible: the
        // synthetic text embeds the tail of the streamed output (details
        // never reach the model).
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        registry.arm(
            "call-tail",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_secs(2),
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let options = BashToolOptions {
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash(
            "call-tail",
            ".",
            &options,
            "echo tail-lander; sleep 5",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("promotion returns Ok");
        let text = result.content[0].as_text().expect("text block");
        assert!(
            text.contains("Output so far:") && text.contains("tail-lander"),
            "the synthetic text must carry the partial output tail: {text}"
        );
        // The kernel-lane parity: the notice still holds the full output.
        let completion = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("completion lands")
            .expect("notice lane open");
        assert_eq!(completion.exit_code, Some(0));
    }

    #[tokio::test]
    async fn a_promoted_job_survives_a_later_run_abort() {
        // The promoted job is decoupled from the run's abort signal: a
        // user abort after the promotion must not kill the background job
        // the model was told keeps running (the notice would say "Command
        // aborted" and the work would be lost).
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        registry.arm(
            "call-abort-gate",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_millis(200),
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let run_signal = super::AbortSignal::new();
        let options = BashToolOptions {
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash(
            "call-abort-gate",
            ".",
            &options,
            "sleep 3; echo gate-lander",
            None,
            None,
            Some(run_signal.clone()),
            None,
        )
        .await
        .expect("promotion returns Ok");
        assert!(
            result.content[0]
                .as_text()
                .expect("text block")
                .starts_with("Command exceeded"),
            "the call must promote"
        );
        // The run aborts AFTER the promotion: the job must survive it (the
        // local backend honors the signal; the gate must have decoupled it).
        run_signal.cancel();
        let completion = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("the promoted job completes")
            .expect("notice lane open");
        assert_eq!(
            completion.exit_code,
            Some(0),
            "the promoted job was killed by the run abort: {completion:?}"
        );
        assert!(
            !completion.output.contains("Command aborted"),
            "the completion must not report an abort: {}",
            completion.output
        );
        assert!(completion.output.contains("gate-lander"));
    }

    #[tokio::test]
    async fn a_call_without_an_arm_never_promotes() {
        // The arm registry is the ONE config source: a direct dispatch
        // with no arm (outside the agent loop) never promotes, no matter
        // how long the command runs.
        let ops = Arc::new(HeldOps {
            release: Arc::new(tokio::sync::Notify::new()),
        });
        let release = Arc::clone(&ops.release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            release.notify_one();
        });
        let options = BashToolOptions {
            operations: Some(ops),
            ..BashToolOptions::default()
        };
        let result = execute_bash(
            "call-armless",
            ".",
            &options,
            "held",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("armless call resolves");
        assert_eq!(
            result.content[0].as_text().expect("text block"),
            "edge-lander\n",
            "no arm means no promotion, ever"
        );
        assert!(result.details.is_none());
    }

    #[tokio::test]
    async fn an_inline_abort_kills_the_command_and_returns_the_status() {
        // An abort while the call is still inline claims the edge atomically
        // (RUNNING -> ABORTED) and kills the command: the caller gets the
        // inline aborted result and NO notice fires — the abort-gated
        // completion never rides the notice lane.
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        registry.arm(
            "call-inline-abort",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_secs(10),
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let run_signal = super::AbortSignal::new();
        let cancel_signal = run_signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel_signal.cancel();
        });
        let options = BashToolOptions {
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let result = execute_bash(
            "call-inline-abort",
            ".",
            &options,
            "sleep 3; echo never-lander",
            None,
            None,
            Some(run_signal),
            None,
        )
        .await;
        let text = match result {
            Err(error) => error.to_string(),
            Ok(result) => result.content[0].as_text().expect("text block").to_string(),
        };
        assert!(
            !text.starts_with("Command exceeded"),
            "an inline abort must not promote: {text}"
        );
        assert!(
            text.contains("Command aborted"),
            "the inline catch path reports the abort: {text}"
        );
        assert!(
            rx.try_recv().is_err(),
            "an abort-gated inline completion fires no notice"
        );
    }
    #[test]
    fn output_tail_note_caps_and_trims() {
        assert_eq!(output_tail_note("", 8), "");
        assert_eq!(output_tail_note("  \n ", 8), "");
        assert_eq!(output_tail_note("abc", 8), "\n\nOutput so far:\nabc");
        let long = "x".repeat(1_024);
        let note = output_tail_note(&long, OUTPUT_TAIL_CHARS);
        assert!(note.ends_with(&"x".repeat(OUTPUT_TAIL_CHARS)));
        assert!(!note.starts_with('x'), "the note is labeled, not raw tail");
        // The cap keeps multi-byte characters whole.
        let unicode = "é".repeat(600);
        let note = output_tail_note(&unicode, 512);
        assert!(note.chars().rev().take(512).all(|c| c == 'é'));
    }

    /// The orphan-journal path is process env, so a test that arms it must
    /// clear it on every exit path: `Drop` runs on unwind too, so a
    /// panicking (or timed-out) test still restores the environment
    /// instead of stranding a stale path whose `TempDir` is already gone.
    /// The lock serializes every taker of the env var.
    struct JournalEnv {
        // Held for the guard's lifetime; the lock's value is never read.
        #[allow(dead_code)]
        lock: MutexGuard<'static, ()>,
        saved: Option<std::ffi::OsString>,
    }

    impl JournalEnv {
        fn arm(journal: &std::path::Path) -> Self {
            let lock = journal_env_lock();
            let saved = std::env::var_os(ORPHAN_PROCESS_JOURNAL_ENV);
            std::env::set_var(ORPHAN_PROCESS_JOURNAL_ENV, journal.display().to_string());
            JournalEnv { lock, saved }
        }
    }

    impl Drop for JournalEnv {
        fn drop(&mut self) {
            match &self.saved {
                Some(value) => std::env::set_var(ORPHAN_PROCESS_JOURNAL_ENV, value),
                None => std::env::remove_var(ORPHAN_PROCESS_JOURNAL_ENV),
            }
        }
    }

    static JOURNAL_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn journal_env_lock() -> MutexGuard<'static, ()> {
        JOURNAL_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[tokio::test]
    async fn a_promoted_job_journals_orphan_state() {
        // The promoted job is journaled in the same orphan-process journal
        // the kernel `bash()` lane uses, so a worker crash or restart
        // reaps its process group instead of leaking it.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let journal = dir.path().join("t.orphans.jsonl");
        let _journal_env = JournalEnv::arm(&journal);
        let registry = pa_agent::auto_background::AutoBackgroundRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AutoBackgroundCompletion>();
        registry.arm(
            "call-journal",
            pa_agent::auto_background::AutoBackgroundArm {
                window: Duration::from_millis(200),
                notice: Some(Arc::new(move |completion| {
                    tx.send(completion).ok();
                })),
            },
        );
        let options = BashToolOptions {
            auto_background_registry: Some(Arc::new(registry)),
            ..BashToolOptions::default()
        };
        let journal_rows = || std::fs::read_to_string(&journal).unwrap_or_default();
        // `ORPHAN_PROCESS_JOURNAL_ENV` is process-global, so a concurrent
        // bash test's spawn can land its active row in this journal before
        // this test's own row. Seed exactly such a foreign row through the
        // real journaling path: the selection below must identify this
        // job's own row, never the first active one. A pid past the OS pid
        // range can never be this job's.
        crate::kernel::orphan_journal::record_orphan_process_state(999_999, true);
        let call = tokio::spawn(async move {
            execute_bash(
                "call-journal",
                ".",
                &options,
                "sleep 2; echo journaled-lander",
                None,
                None,
                None,
                None,
            )
            .await
        });
        // The active row is journaled in `on_spawn`, synchronously with the
        // child's spawn — before the promotion edge, while the call is still
        // inline. Snapshot the journal mid-window to pin that ordering: a
        // registration moved back to the promotion edge leaves this job's
        // row out of the snapshot. The row is identified by the promoted
        // job's own pid once the result reports it — never by row order.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mid_window_rows = journal_rows();
        let result = call
            .await
            .expect("the promoted call joins")
            .expect("promotion returns Ok");
        let details = result.details.clone().expect("promotion details");
        let pid = details["pid"].as_u64().expect("pid reported") as usize;
        assert!(
            mid_window_rows.lines().any(|line| {
                let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
                    return false;
                };
                row["active"].as_bool() == Some(true) && row["pid"].as_u64() == Some(pid as u64)
            }),
            "the orphan row is journaled at spawn, before the promotion edge"
        );
        // The spawn-time row is already on disk when the promotion returns.
        assert!(
            journal_rows().contains(&format!("\"pid\":{pid},\"ownerPid\":")),
            "the promoted job must be journaled active at promotion"
        );
        // Completion releases the record: the exec task writes the
        // inactive row before it sends the notice, so no polling — the
        // release must already be the last row for this pid when the
        // notice arrives.
        let completion = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("completion lands")
            .expect("notice lane open");
        assert_eq!(completion.exit_code, Some(0));
        let rows = journal_rows();
        let last_row = rows
            .lines()
            .rev()
            .find(|line| line.contains(&format!("\"pid\":{pid},")));
        assert!(
            last_row.is_some_and(|line| line.contains("\"active\":false")),
            "the completed job must release its journal record before the notice"
        );
    }

    #[test]
    fn a_panicking_test_still_clears_the_journal_env() {
        // The unwind contract of `JournalEnv`: a panic between arm and the
        // tail must still clear the journal path, or later tests inherit
        // a path whose TempDir is already gone.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let journal = dir.path().join("t.orphans.pin.jsonl");
        let armed = journal.display().to_string();
        let panicked = std::panic::catch_unwind(|| {
            let _guard = JournalEnv::arm(&journal);
            assert_eq!(
                std::env::var_os(ORPHAN_PROCESS_JOURNAL_ENV),
                Some(armed.clone().into())
            );
            panic!("boom");
        });
        assert!(panicked.is_err());
        assert_ne!(
            std::env::var_os(ORPHAN_PROCESS_JOURNAL_ENV),
            Some(armed.into()),
            "the panicking test leaked its journal path into the process env"
        );
    }

    #[test]
    fn an_armed_journal_env_holds_the_env_lock() {
        // The dead-code allow on `lock` documents a contract: the field is
        // never read, it only holds the env-var mutex from arm until Drop.
        // A cleanup that deletes the field (and arm's acquisition) turns
        // this pin red: the try_lock below then succeeds, because nothing
        // in the binary takes the lock anymore. Held as it is, the same-
        // thread try_lock fails with no scheduling involved, no sleeps.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let journal = dir.path().join("t.orphans.hold.jsonl");
        let _guard = JournalEnv::arm(&journal);
        assert!(
            JOURNAL_ENV_LOCK.try_lock().is_err(),
            "the env-var lock was free while a JournalEnv was armed"
        );
    }
}

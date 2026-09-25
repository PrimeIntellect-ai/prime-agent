//! The `bash` tool: shell command execution with output truncation and a
//! destructive-git dirty-tree guard.
//!
//! Port of `packages/coding-agent/src/core/tools/bash.ts` (TUI renderers
//! excluded; execution, guard, truncation, and formatting are identical).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Cancellation handle; kills the process tree when fired.
    pub signal: Option<AbortSignal>,
    /// Timeout in seconds.
    pub timeout: Option<f64>,
    /// Environment for the child; defaults to the agent shell env.
    pub env: Option<HashMap<String, String>>,
}

/// Pluggable operations for the bash tool (TS: `BashOperations`).
///
/// Implementations stream merged stdout/stderr through `on_data`, honor the
/// cancellation token by killing the whole process tree, resolve with the
/// child exit code (`None` when killed by a signal), and reject with
/// `"aborted"` / `"timeout:<seconds>"` on abort/timeout.
///
/// Object-safe on purpose: the tool takes `&dyn` operations so remote
/// execution backends can be injected without generics — hence the
/// `Pin<Box<dyn Future>>` return instead of RPITIT.
pub trait BashOperations: Send + Sync {
    /// Execute a command and stream output; resolves with the exit code
    /// (`None` when killed by a signal), or an error:
    /// `"aborted"` or `"timeout:<seconds>"`.
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
            text.push_str(&format!(
                "\n\n[Showing last {} of line {start_line}{line_size}{location}]",
                format_size(truncation.output_bytes)
            ));
        } else if truncation.truncated_by == Some(TruncatedBy::Lines) {
            text.push_str(&format!(
                "\n\n[Showing lines {start_line}-{end_line} of {}{location}]",
                truncation.total_lines
            ));
        } else {
            text.push_str(&format!(
                "\n\n[Showing lines {start_line}-{end_line} of {} ({} limit){location}]",
                truncation.total_lines,
                format_size(DEFAULT_MAX_BYTES)
            ));
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

/// Execute one bash tool call. Errors carry the model-facing text.
#[tracing::instrument(
    level = "debug",
    name = "tool_bash_execute",
    skip(cwd, options, on_update)
    fields(command),
)]
pub async fn execute_bash(
    cwd: &str,
    options: &BashToolOptions,
    command: &str,
    timeout: Option<f64>,
    allow_destructive_git: Option<bool>,
    signal: Option<AbortSignal>,
    on_update: Option<OnUpdate>,
) -> anyhow::Result<ToolExecutionResult> {
    let default_ops;
    let ops: &dyn BashOperations = if let Some(ops) = &options.operations {
        ops.as_ref()
    } else {
        default_ops = LocalBashOperations {
            shell_path: options.shell_path.clone(),
        };
        &default_ops
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
                ops,
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

    // Stream output through the accumulator with throttled updates.
    let acc = Arc::new(Mutex::new(OutputAccumulator::new(
        OutputAccumulatorOptions {
            temp_file_prefix: "pi-bash".to_string(),
            ..OutputAccumulatorOptions::default()
        },
    )));
    let notify = Arc::new(tokio::sync::Notify::new());
    let dirty = Arc::new(AtomicBool::new(false));
    let mut last_update_at: Option<std::time::Instant> = None;

    if let Some(on_update) = &on_update {
        on_update(ToolUpdate {
            content: Vec::new(),
            details: None,
        });
    }

    let on_data = {
        let notify = notify.clone();
        let dirty = dirty.clone();
        let acc = acc.clone();
        move |data: &[u8]| {
            acc.lock().unwrap().append(data);
            dirty.store(true, Ordering::SeqCst);
            notify.notify_one();
        }
    };

    let exec_fut = ops.exec(
        &spawn_context.command,
        &spawn_context.cwd,
        ExecOptions {
            on_data: &on_data,
            signal: signal.clone(),
            timeout,
            env: Some(spawn_context.env.clone()),
        },
    );
    tokio::pin!(exec_fut);

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
            _ = notify.notified() => {}
            _ = async {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
                    None => std::future::pending::<()>().await,
                }
            }, if deadline.is_some() => {}
            result = &mut exec_fut => {
                break result;
            }
        }
        if dirty.swap(false, Ordering::SeqCst) {
            last_update_at = Some(std::time::Instant::now());
            if let Some(on_update) = &on_update {
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

    // Finish the accumulator, settle the spill, then snapshot.
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

    match exec_result {
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
    }
}

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
pub fn create_bash_tool_definition(cwd: &str) -> ToolDefinition {
    create_bash_tool_definition_with_options(cwd, BashToolOptions::default())
}

pub fn create_bash_tool_definition_with_options(
    cwd: &str,
    options: BashToolOptions,
) -> ToolDefinition {
    let cwd = cwd.to_string();
    let operations = options.operations.clone();
    let command_prefix = options.command_prefix.clone();
    let shell_path = options.shell_path.clone();
    let spawn_hook = options.spawn_hook.clone();
    let execute: crate::tools::tool_definition::ExecuteFn = {
        Arc::new(move |_tool_call_id, params, signal, on_update| {
            let cwd = cwd.clone();
            let options = BashToolOptions {
                operations: operations.clone(),
                command_prefix: command_prefix.clone(),
                shell_path: shell_path.clone(),
                spawn_hook: spawn_hook.clone(),
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

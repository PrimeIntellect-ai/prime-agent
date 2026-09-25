//! The detached kernel bash completion notice: the port of the TS
//! async-bash-completion wake (agent-session.ts `_createKernelHostHandlers`'
//! `bash.completed`/`bash.consumed` arms + rlm-runtime.ts's validated host
//! handlers + messages.ts `createAsyncBashCompletionMessage`).
//!
//! The kernel runtime (`prime-agent-runtime`'s `bash.py`) starts a notice
//! task for every background `bash()` whose creating cell ends before the
//! command settles: when the process finishes (still detached, its result
//! unconsumed), the kernel sends a `bash.completed` host request. The TS
//! session answers it by injecting the `[bash-done pid:N exit:M]` custom
//! row with `queueIfBusy` + `resumeIfIdle` — a busy session queues the
//! notice as a steering row, an idle session wakes into a new turn that
//! runs on the row. A later kernel read that reaches the model first
//! sends `bash.consumed`, and the undelivered notice withdraws.
//!
//! The Rust mapping: the handlers live at the daemon worker seam
//! (`AgentSessionEngine::extra_host_handlers` — every product session is
//! a daemon worker, and only the worker owns the queue the notice
//! admits into); the admission goes through the worker's steering lane
//! with the recovery-journal busy-evidence checkpoint, so a crash
//! between the notice and its delivery revives the worker with the row
//! replaying (queue-snapshot restore) — the wake path survives worker
//! re-adoption and revival alike.

use serde_json::Value;

use pa_core::kernel::shared::{host_handler, HostRequestHandlers};

use crate::agent_engine::AgentSessionEngine;
use crate::engine::{BashCompletionNotice, BashConsumedNotice};

impl AgentSessionEngine {
    /// Wire the worker's bash-completion queue seams. The worker calls
    /// this once at construction, before the first prompt's session
    /// build reads them in [`AgentSessionEngine::extra_host_handlers`].
    ///
    /// # Panics
    ///
    /// Panics when a sink mutex is poisoned (a holder panicked while
    /// holding the completion or consumed-sink lock).
    pub fn set_bash_notice_sinks(
        &self,
        completion: crate::engine::BashCompletionSink,
        consumed: crate::engine::BashConsumedSink,
    ) {
        *self
            .bash_completion_sink
            .lock()
            .expect("bash completion sink lock") = Some(completion);
        *self
            .bash_consumed_sink
            .lock()
            .expect("bash consumed sink lock") = Some(consumed);
    }

    /// The `bash.completed`/`bash.consumed` kernel host handlers (TS
    /// `createAsyncBashCompletionHostHandler` /
    /// `createAsyncBashConsumedHostHandler`): validated details, the
    /// notice admitted (or withdrawn) through the worker's queue
    /// seams. Registered only when both seams are wired — the daemon
    /// worker wires them at construction; anything without a worker
    /// queue leaves the requests honestly unavailable.
    pub(crate) fn register_bash_notice_host_handlers(&self, handlers: &mut HostRequestHandlers) {
        let Some(completion) = self
            .bash_completion_sink
            .lock()
            .expect("bash completion sink lock")
            .clone()
        else {
            return;
        };
        let Some(consumed) = self
            .bash_consumed_sink
            .lock()
            .expect("bash consumed sink lock")
            .clone()
        else {
            return;
        };
        handlers.register(
            "bash.completed",
            host_handler(move |payload| {
                let completion = completion.clone();
                Box::pin(async move {
                    let notice = validate_completion(&payload.data)?;
                    // The closed-session gate lives in the sink: the
                    // worker's kill/shutdown set the marker and parked the
                    // runner, and the sink (which holds the engine) refuses
                    // the injection exactly like TS `_disposed` /
                    // `session_closed` refuse it.
                    completion(notice);
                    Ok(serde_json::json!({}))
                })
            }),
        );
        handlers.register(
            "bash.consumed",
            host_handler(move |payload| {
                let consumed = consumed.clone();
                Box::pin(async move {
                    let notice = validate_consumed(&payload.data)?;
                    consumed(notice);
                    Ok(serde_json::json!({}))
                })
            }),
        );
    }
}

/// TS `createAsyncBashCompletionHostHandler` validation: a positive
/// integer pid, a non-empty string command, an integer exit code.
fn validate_completion(data: &Value) -> anyhow::Result<BashCompletionNotice> {
    let consumed = validate_consumed(data)?;
    let exit_code = data
        .get("exitCode")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("bash.completed exitCode must be an integer"))?;
    Ok(BashCompletionNotice {
        pid: consumed.pid,
        command: consumed.command,
        exit_code,
    })
}

/// TS `createAsyncBashConsumedHostHandler` validation: a positive
/// integer pid and a non-empty string command (pids are reused across
/// handles, so the command disambiguates).
fn validate_consumed(data: &Value) -> anyhow::Result<BashConsumedNotice> {
    let pid = data
        .get("pid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .ok_or_else(|| anyhow::anyhow!("bash.completed pid must be a positive integer"))?
        as u32;
    let command = data
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.is_empty())
        .ok_or_else(|| anyhow::anyhow!("bash.completed command must be a non-empty string"))?
        .to_string();
    Ok(BashConsumedNotice { pid, command })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_validation_matches_the_ts_contract() {
        assert!(validate_completion(&serde_json::json!({
            "pid": 4321,
            "command": "sleep 1",
            "exitCode": 0,
        }))
        .is_ok());
        assert!(validate_completion(&serde_json::json!({
            "pid": 0,
            "command": "sleep 1",
            "exitCode": 0,
        }))
        .is_err());
        assert!(validate_completion(&serde_json::json!({
            "pid": 4321,
            "command": "",
            "exitCode": 0,
        }))
        .is_err());
        assert!(validate_completion(&serde_json::json!({
            "pid": 4321,
            "command": "sleep 1",
            "exitCode": "0",
        }))
        .is_err());
    }
}

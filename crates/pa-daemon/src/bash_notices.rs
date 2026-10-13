//! The detached kernel bash completion notice (the TS async-bash-completion
//! wake: `bash.completed`/`bash.consumed`): on completion the session injects
//! the `[bash-done pid:N exit:M]` custom row with `queueIfBusy` +
//! `resumeIfIdle`; a later kernel read that reaches the model first sends
//! `bash.consumed`, and the undelivered notice withdraws.

use serde_json::Value;

use pa_core::kernel::shared::{host_handler, HostRequestHandlers};

use crate::agent_engine::AgentSessionEngine;
use crate::engine::{BashCompletionNotice, BashConsumedNotice};

impl AgentSessionEngine {
    /// Wire the worker's bash-completion queue seams (called once at
    /// construction, before the first session build reads them).
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
    /// `createAsyncBashCompletionHostHandler`/`createAsyncBashConsumedHostHandler`).
    /// Registered only when both seams are wired — no worker queue leaves the requests
    /// honestly unavailable.
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
                    // The closed-session gate lives in the sink: the worker's kill/shutdown
                    // set the marker, and the sink refuses the injection like TS `_disposed`.
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

/// TS `createAsyncBashConsumedHostHandler` validation: a positive integer pid and a
/// non-empty command (pids are reused across handles, so the command disambiguates).
fn validate_consumed(data: &Value) -> anyhow::Result<BashConsumedNotice> {
    let pid = data
        .get("pid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid > 0 && u32::try_from(*pid).is_ok())
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

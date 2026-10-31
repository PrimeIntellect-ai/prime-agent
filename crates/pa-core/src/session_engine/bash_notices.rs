//! The kernel notice seam (the TS async-bash-completion wake): the
//! `bash.completed`/`bash.consumed` notices plus the `factory.progress`
//! run-milestone notice that rides the same steering delivery. Here live
//! the shared notice types, the TS payload validation, and the
//! host-handler registration, plus the in-process sinks a daemonless
//! embedding uses — the notice row steers onto the session's own agent
//! and the embedding's wake fires.

use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;

use crate::kernel::shared::{host_handler, HostRequestHandlers, BASH_COMPLETED_REQUEST_TYPE};
use pa_agent::types::AgentMessage;
use pa_types::session::CustomMessage;

use super::messages::{
    self, ASYNC_BASH_COMPLETION_CUSTOM_TYPE, ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
    FACTORY_PROGRESS_PREVIEW_LABEL,
};
use super::{session_message_to_loop, SessionAgentMessage};

/// One kernel notice the host admits as a steering row (TS
/// `_promptInjectedMessage` with `streamingBehavior: "steer"`,
/// `queueIfBusy`, and `resumeIfIdle`): a detached bash completion
/// (`bash.completed`) or a factory run milestone (`factory.progress`).
#[derive(Debug, Clone)]
pub struct KernelNotice {
    /// The durable custom row the woken or steered turn carries.
    pub row: CustomMessage,
    /// The queue strip's label for the row's preview.
    pub preview_label: &'static str,
}

impl KernelNotice {
    /// The `[bash-done]` notice for one finished detached command.
    #[must_use]
    pub fn bash_completion(pid: u32, command: &str, exit_code: i64) -> Self {
        Self {
            row: messages::create_async_bash_completion_message(
                pid,
                command,
                exit_code,
                crate::autonomous::now_millis(),
            ),
            preview_label: ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
        }
    }

    /// The `[turn-held]` pacing notice for one delivery that outlived the
    /// worker's turn-held window: it rides the same steering lane as a
    /// bash completion, so the queued row cuts the held turn at its next
    /// boundary and delivers as the next turn's injected prompt.
    #[must_use]
    pub fn turn_held(elapsed_ms: u64) -> Self {
        Self {
            row: messages::create_turn_held_message(elapsed_ms, crate::autonomous::now_millis()),
            preview_label: messages::TURN_HELD_PREVIEW_LABEL,
        }
    }
}

/// The queue-admission seam for one kernel notice (the daemon worker's
/// steering lane + runner wake + recovery busy-evidence; the in-process
/// sinks below steer onto the session's own agent).
pub type KernelNoticeSink = Arc<dyn Fn(KernelNotice) + Send + Sync>;

/// The kernel read a finished command's result before its notice
/// delivered (the `bash.consumed` host request): the queued notice is stale.
#[derive(Debug, Clone)]
pub struct BashConsumedNotice {
    pub pid: u32,
    pub command: String,
}

/// The queue-withdrawal seam for one consumed notice.
pub type BashConsumedSink = Arc<dyn Fn(BashConsumedNotice) + Send + Sync>;

/// The daemonless embedding's wake (TS `resumeIfIdle`): fires after a
/// notice admits its row, so the embedding resumes the idle run.
pub type BashNoticeWake = Arc<dyn Fn() + Send + Sync>;

/// The `bash.completed`/`bash.consumed`/`factory.progress` kernel host
/// handlers (TS `createAsyncBashCompletionHostHandler`,
/// `createAsyncBashConsumedHostHandler`, `createFactoryProgressHostHandler`).
pub fn register_kernel_notice_host_handlers(
    notice: KernelNoticeSink,
    consumed: BashConsumedSink,
    handlers: &mut HostRequestHandlers,
) {
    let completion = Arc::clone(&notice);
    handlers.register(
        BASH_COMPLETED_REQUEST_TYPE,
        host_handler(move |payload| {
            let completion = completion.clone();
            Box::pin(async move {
                let notice = validate_completion(&payload.data)?;
                // Any closed-session gate is the sink's (the daemon
                // worker refuses injections after kill/shutdown like TS
                // `_disposed`; the in-process sinks bind a weak agent).
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
    handlers.register(
        "factory.progress",
        host_handler(move |payload| {
            let notice = notice.clone();
            Box::pin(async move {
                notice(validate_factory_progress(&payload.data)?);
                Ok(serde_json::json!({}))
            })
        }),
    );
}

/// TS `createAsyncBashCompletionHostHandler` validation: a positive
/// integer pid, a non-empty string command, an integer exit code.
fn validate_completion(data: &Value) -> anyhow::Result<KernelNotice> {
    let consumed = validate_consumed(data)?;
    let exit_code = data
        .get("exitCode")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("bash.completed exitCode must be an integer"))?;
    Ok(KernelNotice::bash_completion(
        consumed.pid,
        &consumed.command,
        exit_code,
    ))
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

/// The kernel factory executor's milestone payload (`FactoryExecutor._milestone`
/// in `rlm/factory.py`): non-empty `run_id`, `kind`, and `detail` strings, and
/// an optional non-empty `node` string.
fn validate_factory_progress(data: &Value) -> anyhow::Result<KernelNotice> {
    let text = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| anyhow::anyhow!("factory.progress {key} must be a non-empty string"))
    };
    let node = data
        .get("node")
        .is_some()
        .then(|| text("node"))
        .transpose()?;
    Ok(KernelNotice {
        row: messages::create_factory_progress_message(
            text("run_id")?,
            text("kind")?,
            node,
            text("detail")?,
            crate::autonomous::now_millis(),
        ),
        preview_label: FACTORY_PROGRESS_PREVIEW_LABEL,
    })
}

/// The session's agent through which the in-process sinks steer and
/// withdraw: late-bound because the handlers register before the agent
/// exists, and weak so the handler -> agent -> kernel -> handler graph
/// stays acyclic (a dropped session's handlers bind nothing).
pub type BashNoticeAgentSlot = Arc<Mutex<Option<Weak<pa_agent::agent::Agent>>>>;

/// The in-process sinks over one session's own agent (the daemonless
/// embeddings): a notice steers its row (`[bash-done]` or
/// `[factory-progress]`) onto the agent's steering queue and fires the
/// embedding's wake (TS `queueIfBusy: true` + `resumeIfIdle: true` — the
/// row rides the steering lane and the embedding resumes the idle run); a
/// consumed notice withdraws the queued completion row.
pub fn register_in_process_kernel_notice_handlers(
    wake: &BashNoticeWake,
    agent_slot: &BashNoticeAgentSlot,
    handlers: &mut HostRequestHandlers,
) {
    let notice_wake = Arc::clone(wake);
    let notice_slot = Arc::clone(agent_slot);
    let notice: KernelNoticeSink = Arc::new(move |notice| {
        let Some(agent) = bound_agent(&notice_slot) else {
            return;
        };
        let Some(row) = session_message_to_loop(&SessionAgentMessage::Custom(notice.row)) else {
            return;
        };
        agent.steer(row);
        notice_wake();
    });
    let consumed_slot = Arc::clone(agent_slot);
    let consumed: BashConsumedSink = Arc::new(move |notice| {
        let Some(agent) = bound_agent(&consumed_slot) else {
            return;
        };
        // One read withdraws one notice (TS 5865-5869; the daemon's
        // front-most rule): pid reuse can queue an identical key twice
        // and the read belongs to the older handle.
        let withdrawn = std::cell::Cell::new(false);
        agent.remove_queued_messages(|row| {
            !withdrawn.get() && is_queued_completion_row(row, &notice) && {
                withdrawn.set(true);
                true
            }
        });
    });
    register_kernel_notice_host_handlers(notice, consumed, handlers);
}

/// The bound agent behind the late slot, when the session still lives.
fn bound_agent(slot: &BashNoticeAgentSlot) -> Option<Arc<pa_agent::agent::Agent>> {
    slot.lock()
        .expect("bash notice agent slot lock")
        .as_ref()
        .and_then(Weak::upgrade)
}

/// Whether one queued loop row is the completion notice for this
/// pid+command (the row's details carry both — pids alone are reused).
fn is_queued_completion_row(row: &AgentMessage, notice: &BashConsumedNotice) -> bool {
    let AgentMessage::Custom(custom) = row else {
        return false;
    };
    custom.payload.get("customType").and_then(Value::as_str)
        == Some(ASYNC_BASH_COMPLETION_CUSTOM_TYPE)
        && custom
            .payload
            .pointer("/details/pid")
            .and_then(Value::as_u64)
            == Some(u64::from(notice.pid))
        && custom
            .payload
            .pointer("/details/command")
            .and_then(Value::as_str)
            == Some(notice.command.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::{HostHandlerFn, HostRequestPayload};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn completed_payload(pid: u64, command: &str, exit_code: i64) -> Value {
        serde_json::json!({
            "type": "bash.completed",
            "pid": pid,
            "command": command,
            "exitCode": exit_code,
        })
    }

    async fn dispatch(handler: &HostHandlerFn, data: Value) -> anyhow::Result<Value> {
        handler(HostRequestPayload { data }).await
    }

    fn wired_agent() -> (
        Arc<pa_agent::agent::Agent>,
        BashNoticeAgentSlot,
        Arc<AtomicUsize>,
        HostRequestHandlers,
    ) {
        let agent = Arc::new(pa_agent::agent::Agent::new(
            pa_agent::agent::AgentOptions::default(),
        ));
        let slot: BashNoticeAgentSlot = Arc::new(Mutex::new(Some(Arc::downgrade(&agent))));
        let wakes = Arc::new(AtomicUsize::new(0));
        let wake = {
            let wakes = Arc::clone(&wakes);
            Arc::new(move || {
                wakes.fetch_add(1, Ordering::SeqCst);
            }) as BashNoticeWake
        };
        let mut handlers = HostRequestHandlers::default();
        register_in_process_kernel_notice_handlers(&wake, &slot, &mut handlers);
        (agent, slot, wakes, handlers)
    }

    #[tokio::test]
    async fn completed_queues_the_bash_done_row_and_fires_the_wake() {
        let (agent, _slot, wakes, handlers) = wired_agent();
        let handler = handlers
            .get("bash.completed")
            .expect("the completion handler registered")
            .clone();
        let reply = dispatch(&handler, completed_payload(4321, "sleep 1", 7))
            .await
            .expect("the notice is accepted");
        assert_eq!(reply, serde_json::json!({}));
        assert_eq!(
            wakes.load(Ordering::SeqCst),
            1,
            "the admission fired the wake"
        );
        let queued = agent.remove_queued_messages(|_| true);
        assert_eq!(queued.len(), 1, "one row queued on the agent");
        let AgentMessage::Custom(custom) = &queued[0] else {
            panic!("the queued row is the custom notice: {queued:?}");
        };
        assert_eq!(
            custom.payload.get("customType").and_then(Value::as_str),
            Some(ASYNC_BASH_COMPLETION_CUSTOM_TYPE)
        );
        assert_eq!(
            custom
                .payload
                .pointer("/details/pid")
                .and_then(Value::as_u64),
            Some(4321)
        );
        assert_eq!(
            custom
                .payload
                .pointer("/details/exitCode")
                .and_then(Value::as_i64),
            Some(7)
        );
        assert_eq!(
            custom
                .payload
                .pointer("/details/command")
                .and_then(Value::as_str),
            Some("sleep 1")
        );
        assert!(
            custom
                .payload
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("[bash-done pid:4321 exit:7]")),
            "the row carries the notice header: {}",
            custom.payload
        );
    }

    #[tokio::test]
    async fn consumed_withdraws_the_front_most_queued_row() {
        let (agent, _slot, _wakes, handlers) = wired_agent();
        let completed = handlers
            .get("bash.completed")
            .expect("the completion handler registered")
            .clone();
        // Pid reuse queues an identical key twice (the read belongs to
        // the older handle).
        dispatch(&completed, completed_payload(4321, "sleep 1", 0))
            .await
            .expect("the first notice is accepted");
        dispatch(&completed, completed_payload(4321, "sleep 1", 0))
            .await
            .expect("the second notice is accepted");
        assert!(agent.has_queued_messages());

        let consumed = handlers
            .get("bash.consumed")
            .expect("the consumed handler registered")
            .clone();
        dispatch(
            &consumed,
            serde_json::json!({ "type": "bash.consumed", "pid": 4321, "command": "sleep 1" }),
        )
        .await
        .expect("the withdrawal is accepted");
        let remaining = agent.remove_queued_messages(|_| true);
        assert_eq!(
            remaining.len(),
            1,
            "one read withdrew the front-most row; the second identical row stayed"
        );
    }

    #[tokio::test]
    async fn factory_progress_queues_the_milestone_row_and_fires_the_wake() {
        let (agent, _slot, wakes, handlers) = wired_agent();
        let handler = handlers
            .get("factory.progress")
            .expect("the factory progress handler registered")
            .clone();
        let missing_run = serde_json::json!({ "kind": "paused", "detail": "state a failed" });
        assert!(
            dispatch(&handler, missing_run).await.is_err(),
            "a milestone without a run id is refused"
        );
        let milestone = serde_json::json!({
            "run_id": "run-7",
            "kind": "budget_exceeded",
            "detail": "run budget_ms 2000 exceeded",
        });
        dispatch(&handler, milestone)
            .await
            .expect("the milestone is accepted");
        assert_eq!(
            wakes.load(Ordering::SeqCst),
            1,
            "the admission fired the wake"
        );
        let queued = agent.remove_queued_messages(|_| true);
        let [AgentMessage::Custom(custom)] = queued.as_slice() else {
            panic!("one custom notice row queued: {queued:?}");
        };
        assert_eq!(
            (
                custom.payload.get("customType"),
                custom.payload.get("content"),
                custom.payload.get("details"),
            ),
            (
                Some(&serde_json::json!("factory_progress_notice")),
                Some(&serde_json::json!(
                    "[factory-progress run:run-7] budget-exceeded: run budget_ms 2000 exceeded"
                )),
                Some(&serde_json::json!({
                    "runId": "run-7",
                    "kind": "budget_exceeded",
                    "detail": "run budget_ms 2000 exceeded",
                })),
            )
        );
    }

    #[test]
    fn completion_validation_matches_the_ts_contract() {
        assert!(validate_completion(&completed_payload(4321, "sleep 1", 0)).is_ok());
        assert!(validate_completion(&completed_payload(0, "sleep 1", 0)).is_err());
        assert!(validate_completion(&completed_payload(4321, "", 0)).is_err());
        assert!(validate_completion(&serde_json::json!({
            "type": "bash.completed",
            "pid": 4321,
            "command": "sleep 1",
            "exitCode": "0",
        }))
        .is_err());
    }
}

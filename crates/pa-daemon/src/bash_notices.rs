//! The daemon worker's kernel-notice seams (bash completions and factory
//! progress): the notice types, the validation, and the handler
//! registration live in pa-core (`session_engine::bash_notices`); the
//! worker keeps its queue-lane sinks here.

use pa_core::kernel::shared::HostRequestHandlers;

use crate::agent_engine::AgentSessionEngine;

impl AgentSessionEngine {
    /// Wire the worker's kernel-notice queue seams (called once at
    /// construction, before the first session build reads them).
    ///
    /// # Panics
    ///
    /// Panics when a sink mutex is poisoned (a holder panicked while
    /// holding the notice or consumed-sink lock).
    pub fn set_kernel_notice_sinks(
        &self,
        notice: crate::engine::KernelNoticeSink,
        consumed: crate::engine::BashConsumedSink,
    ) {
        *self
            .kernel_notice_sink
            .lock()
            .expect("kernel notice sink lock") = Some(notice);
        *self
            .bash_consumed_sink
            .lock()
            .expect("bash consumed sink lock") = Some(consumed);
    }

    /// Fire the session's cell wake: a user message or inbox arrival ends a
    /// running cell's wait early (the cell keeps running and auto-backgrounds;
    /// its completion lands in the inbox). Requests with no live cell wait are
    /// inert — a subscription only fires on requests after it armed.
    pub(crate) fn fire_cell_wake(&self) {
        self.cell_wake.request();
    }

    /// Route one auto-backgrounded cell's completion into the worker's kernel
    /// notice seam (the same lane `bash.completed` rides: inbox when enabled,
    /// else a steering row).
    pub(crate) fn admit_background_cell_outcome(
        &self,
        outcome: &pa_core::kernel::shared::BackgroundCellOutcome,
    ) {
        let Some(sink) = self
            .kernel_notice_sink
            .lock()
            .expect("kernel notice sink lock")
            .clone()
        else {
            return;
        };
        let result = &outcome.result;
        let status = match result.status {
            pa_core::kernel::shared::ExecuteStatus::Ok => "ok",
            pa_core::kernel::shared::ExecuteStatus::Error => "error",
            pa_core::kernel::shared::ExecuteStatus::Aborted => "aborted",
        };
        let reason = match outcome.reason {
            pa_core::kernel::shared::DetachReason::Interrupted => "interrupted".to_string(),
            pa_core::kernel::shared::DetachReason::WaitBudget(ms) => format!("wait-budget:{ms}"),
        };
        let mut output = result.stdout.clone();
        if !result.stderr.is_empty() {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(&result.stderr);
        }
        if let Some(value) = &result.result {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(value);
        }
        sink(
            pa_core::session_engine::bash_notices::KernelNotice::background_cell_completion(
                &outcome.cell_id,
                status,
                result.duration_ms,
                &reason,
                &output,
            ),
        );
    }

    /// The `bash.completed`/`bash.consumed`/`factory.progress` kernel host
    /// handlers. Registered only when both seams are wired — no worker queue
    /// leaves the requests honestly unavailable.
    pub(crate) fn register_kernel_notice_host_handlers(&self, handlers: &mut HostRequestHandlers) {
        let Some(notice) = self
            .kernel_notice_sink
            .lock()
            .expect("kernel notice sink lock")
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
        pa_core::session_engine::bash_notices::register_kernel_notice_host_handlers(
            notice, consumed, handlers,
        );
    }
}

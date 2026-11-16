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

    /// Wire the MCP notification row seam (informational server notifications
    /// land as durable rows; significant kinds wake through the notice sink).
    ///
    /// # Panics
    ///
    /// Panics when the sink mutex is poisoned.
    pub fn set_mcp_notification_row_sink(
        &self,
        row: pa_core::session_engine::mcp_notices::McpNotificationRowSink,
    ) {
        *self
            .mcp_notification_row_sink
            .lock()
            .expect("mcp notification row sink lock") = Some(row);
    }

    /// Wire the MCP sampling runner (policy + bounded completion), called by the
    /// worker before the session builds.
    ///
    /// # Panics
    ///
    /// Panics when the runner mutex is poisoned.
    pub fn set_mcp_sampling_runner(
        &self,
        runner: crate::agent_engine::mcp_sampling::SamplingRunner,
    ) {
        *self
            .mcp_sampling_runner
            .lock()
            .expect("mcp sampling runner lock") = Some(runner);
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
        let mcp_notice = notice.clone();
        pa_core::session_engine::bash_notices::register_kernel_notice_host_handlers(
            notice, consumed, handlers,
        );
        let Some(row) = self
            .mcp_notification_row_sink
            .lock()
            .expect("mcp notification row sink lock")
            .clone()
        else {
            return;
        };
        pa_core::session_engine::mcp_notices::register_mcp_notification_host_handler(
            mcp_notice,
            row,
            Some(self.mcp_usage_sink()),
            handlers,
        );
    }
}

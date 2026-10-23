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

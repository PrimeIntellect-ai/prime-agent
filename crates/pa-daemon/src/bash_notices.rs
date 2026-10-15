//! The daemon worker's bash-notice seams: the notice types, the TS
//! validation, and the handler registration live in pa-core
//! (`session_engine::bash_notices`); the worker keeps its queue-lane
//! sinks here.

use pa_core::kernel::shared::HostRequestHandlers;

use crate::agent_engine::AgentSessionEngine;

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
        pa_core::session_engine::bash_notices::register_bash_notice_host_handlers(
            completion, consumed, handlers,
        );
    }
}

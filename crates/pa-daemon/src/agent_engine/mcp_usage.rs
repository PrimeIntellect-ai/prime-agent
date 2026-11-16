//! The daemon's MCP usage counter seam.
//!
//! The notification, sampling, elicitation and kernel-usage handlers report one
//! fixed [`McpUsageKind`] per occurrence; this module maps that into the built
//! session's telemetry counters — the same `Arc<SessionCounters>` the session's
//! telemetry handle finalizes on `agent session ended`. Server names, URIs,
//! prompts and answers never reach it: the vocabulary is the whole payload.
//!
//! The handlers register before the session (and therefore before the kernel
//! and its counters) exists, so they hold [`McpUsageSink`] — a closure that
//! resolves the counters per occurrence and reports nothing until the build.

use std::sync::Arc;

use pa_core::session_engine::telemetry::{McpUsageKind, McpUsageSink, SessionCounters};

use super::AgentSessionEngine;

impl AgentSessionEngine {
    /// The built session's counters; `None` before the first build (no kernel
    /// exists then, so no MCP traffic can arrive).
    pub(crate) fn mcp_usage_counters(&self) -> Option<Arc<SessionCounters>> {
        self.mcp_counters.get().cloned()
    }

    /// Report one MCP capability occurrence into the session counters.
    pub(crate) fn note_mcp_usage(&self, kind: McpUsageKind) {
        if let Some(counters) = self.mcp_usage_counters() {
            counters.note_mcp_usage(kind);
        }
    }

    /// The sink form the pa-core handlers take (they register before the build).
    pub(crate) fn mcp_usage_sink(&self) -> McpUsageSink {
        let slot = Arc::clone(&self.mcp_counters);
        Arc::new(move |kind| {
            if let Some(counters) = slot.get() {
                counters.note_mcp_usage(kind);
            }
        })
    }
}

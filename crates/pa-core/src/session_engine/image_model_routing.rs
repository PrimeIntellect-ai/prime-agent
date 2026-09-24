//! The image-model routing host seam (TS agent-session's settingsManager +
//! modelRegistry reads + the per-run model override of `agent.ts`).
//!
//! Turn dispatch consults this seam when the delivered batch attaches image
//! blocks: the host supplies the routing decision (settings `imageModel` +
//! the live registry) and the serving-target swap for its stream adapter.
//! `None` on the session keeps today's behavior (image turns serve on the
//! session model): verification harnesses, and the daemon worker, whose
//! turn dispatch owns routing itself (the worker's queued lanes re-dispatch
//! every batch through its engine, so it arms, re-applies per attempt, and
//! restores the route itself).

use std::sync::Arc;

use pa_agent::types::{Model, ThinkingLevel};

use crate::models::ResolvedImageModel;

/// The host seam for image-model routing.
#[derive(Clone)]
pub struct ImageModelRouter {
    /// The routing decision for one dispatched batch (TS
    /// `resolveImageModelOverride` over the host's settings + registry):
    /// `Ok(None)` when the batch does not route, `Err` the actionable
    /// refusal that fails the turn.
    pub decide: Arc<
        dyn Fn(bool, &Model, ThinkingLevel) -> Result<Option<ResolvedImageModel>, String>
            + Send
            + Sync,
    >,
    /// Swap the host's serving target to the routed image model, or
    /// restore the session target (`None`). Called with the fresh decision
    /// of every admitted batch, so a stale route never outlives the next
    /// dispatch.
    pub swap_target: Arc<dyn Fn(Option<&ResolvedImageModel>) + Send + Sync>,
}

impl std::fmt::Debug for ImageModelRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageModelRouter").finish_non_exhaustive()
    }
}

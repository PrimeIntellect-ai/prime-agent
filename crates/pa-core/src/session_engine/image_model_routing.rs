//! The image-model routing host seam: turn dispatch consults this seam when the delivered
//! batch attaches image blocks. `None` on the session keeps image turns on the session model
//! (verification harnesses, and the daemon worker whose turn dispatch owns routing itself).

use std::sync::Arc;

use crate::models::ResolvedImageModel;

/// The routing decision for one dispatched batch: `Ok(None)` when the batch does not
/// route, `Err` the actionable refusal that fails the turn. The host owns the session-model
/// and per-request-field reads (the agent-state model descriptor is lossy - no input modalities).
pub type ImageRouteDecisionFn = Arc<
    dyn Fn(bool, pa_types::ai::ModelThinkingLevel) -> Result<Option<ResolvedImageModel>, String>
        + Send
        + Sync,
>;

/// Swap the host's serving target to the routed image model, or restore the session target;
/// called with the fresh decision of every admitted batch, so a stale route never outlives
/// the next dispatch.
pub type ImageRouteTargetSwapFn = Arc<dyn Fn(Option<&ResolvedImageModel>) + Send + Sync>;

/// The host seam for image-model routing.
#[derive(Clone)]
pub struct ImageModelRouter {
    pub decide: ImageRouteDecisionFn,
    pub swap_target: ImageRouteTargetSwapFn,
}

impl std::fmt::Debug for ImageModelRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageModelRouter").finish_non_exhaustive()
    }
}

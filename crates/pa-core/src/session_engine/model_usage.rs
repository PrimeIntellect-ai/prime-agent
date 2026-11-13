//! The `model_usage` row: one billed model call made outside the agent loop
//! (refinement planning and review, side questions). Compactions and branch
//! summaries bill on their own rows; these calls have no row of their own.

use pa_types::ai::{AssistantMessage, Usage};
use serde::{Deserialize, Serialize};

/// The `custom` entry type that records one [`ModelUsage`] in its `data`.
pub const MODEL_USAGE_CUSTOM_TYPE: &str = "model_usage";

/// One billed model call: what made it, the model that served it, and its usage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub source: String,
    pub provider: String,
    pub model_id: String,
    pub usage: Usage,
}

impl ModelUsage {
    /// `None` when the call billed no tokens (a request that failed before
    /// the provider counted anything).
    #[must_use]
    pub fn new(source: &str, provider: &str, model_id: &str, usage: Usage) -> Option<Self> {
        (usage.total_tokens > 0).then(|| Self {
            source: source.to_string(),
            provider: provider.to_string(),
            model_id: model_id.to_string(),
            usage,
        })
    }

    /// The call behind one reply.
    #[must_use]
    pub fn of_reply(source: &str, reply: &AssistantMessage) -> Option<Self> {
        Self::new(source, &reply.provider, &reply.model, reply.usage)
    }
}

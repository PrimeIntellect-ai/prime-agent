//! Public streaming facade.
//! Ported from `packages/ai/src/stream.ts`.

use std::sync::Arc;

use crate::event_stream::AssistantMessageEventStream;
use crate::registry::{ensure_builtins, get_api_provider};
use crate::types::{AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions};
use crate::utils_inner::ProviderError;

fn resolve_provider(api: &str) -> Result<Arc<dyn crate::registry::Provider>, ProviderError> {
    ensure_builtins();
    get_api_provider(api)
        .ok_or_else(|| ProviderError::Message(format!("No API provider registered for api: {api}")))
}

/// Start streaming a completion for `model` using provider-native options.
pub fn stream(
    model: &Model,
    context: &Context,
    options: Option<StreamOptions>,
) -> Result<AssistantMessageEventStream, ProviderError> {
    let provider = resolve_provider(&model.api)?;
    Ok(provider.stream(model, context, options.as_ref()))
}

/// Await the final assistant message of a provider-native stream.
pub async fn complete(
    model: &Model,
    context: &Context,
    options: Option<StreamOptions>,
) -> Result<AssistantMessage, ProviderError> {
    let stream = stream(model, context, options)?;
    Ok(stream.result().await)
}

/// Start a streaming completion with unified reasoning options (`streamSimple`).
pub fn stream_simple(
    model: &Model,
    context: &Context,
    options: Option<SimpleStreamOptions>,
) -> Result<AssistantMessageEventStream, ProviderError> {
    let provider = resolve_provider(&model.api)?;
    Ok(provider.stream_simple(model, context, options.as_ref()))
}

/// Await the final assistant message of a simple stream (`completeSimple`).
pub async fn complete_simple(
    model: &Model,
    context: &Context,
    options: Option<SimpleStreamOptions>,
) -> Result<AssistantMessage, ProviderError> {
    let stream = stream_simple(model, context, options)?;
    Ok(stream.result().await)
}

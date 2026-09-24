//! Routing for image-attaching turns on session models without image input
//! (TS `image-model-routing.ts` + the two `auth-guidance.ts` messages).
//!
//! The decision is pure: the embedding supplies the session model, its
//! per-request fields, the configured `settings.imageModel` reference, the
//! available catalog, and the auth probe; the resolver either returns the
//! image-capable model that serves the turn (with the session thinking
//! level and service tier clamped to what it supports) or an actionable
//! error naming the setting. The turn-dispatch owner (the daemon engine)
//! invokes it once per dispatched batch and applies the result as the
//! per-run model override.

use pa_types::ai::{clamp_thinking_level, supports_fast_mode, ServiceTier};

use super::resolver::find_exact_model_reference_match;
use pa_types::ai::{Model, ModelInput, ModelThinkingLevel};

/// The model serving a routed image turn, with the session's per-request
/// fields clamped to what it supports (TS `AgentModelOverride`'s fields).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedImageModel {
    pub model: Model,
    /// Session thinking level clamped to the routed model's vocabulary.
    pub thinking_level: ModelThinkingLevel,
    /// Session service tier clamped for the routed model (a `priority`
    /// request on a model without fast mode serves `default`).
    pub service_tier: Option<ServiceTier>,
}

/// Whether the model takes image input (TS `model.input.includes("image")`).
fn takes_image_input(model: &Model) -> bool {
    model.input.contains(&ModelInput::Image)
}

/// TS `formatImageModelRequiredMessage`: the session model cannot serve the
/// attached images and no image model is configured. Name the model, the
/// setting, and the alternatives so the user can act immediately.
pub fn format_image_model_required_message(session_model_id: &str) -> String {
    format!(
        "This turn attaches images, but the selected model ({session_model_id}) does not accept image input.\n\nPick one:\n- Switch the session model to an image-capable one with /model, or\n- Set imageModel in settings.json to an image-capable model (\"provider/model-id\" or a bare id), e.g. \"anthropic/claude-sonnet-4-5\"\n\nThen resend the message. Without it the request would silently drop the images."
    )
}

/// TS `formatImageModelUnusableMessage`: the configured `imageModel` could
/// not be resolved to an available, image-capable, authenticated model.
pub fn format_image_model_unusable_message(reference: &str) -> String {
    format!(
        "imageModel \"{reference}\" could not be resolved to an available, image-capable, authenticated model.\n\nFix the imageModel setting (settings.json) or authenticate the provider, then resend the message."
    )
}

/// Session state the routing decision needs when a turn batch commits (TS
/// `ImageModelRoutingInputs`).
pub struct ImageModelRoutingInputs<'a> {
    /// Model selected for the session; the routed turns carry images it
    /// cannot see.
    pub session_model: &'a Model,
    /// Session thinking level; clamped to what the routed model supports.
    pub thinking_level: ModelThinkingLevel,
    /// Session service tier; clamped to what the routed model supports.
    pub service_tier: Option<ServiceTier>,
    /// `settings.imageModel` reference ("provider/model-id" or a bare id).
    pub image_model_reference: Option<&'a str>,
    /// Registry models the reference may resolve to (available: the
    /// reference must resolve AND be authenticated).
    pub available_models: &'a [Model],
    /// Whether the registry has working credentials for a model.
    pub has_configured_auth: &'a dyn Fn(&Model) -> bool,
    /// `settings.images.blockImages`: no image reaches any provider, so no
    /// turn routes.
    pub block_images: bool,
}

/// Resolve the model that serves turns attaching images: the configured
/// image model when the session model has no image input, `None` when the
/// session model serves them natively (or images are blocked globally).
/// Returns the actionable refusal when the turn cannot be served honestly:
/// a text-only session model would otherwise downgrade the images to an
/// "(image omitted)" placeholder (TS `resolveImageModelOverride`).
pub fn resolve_image_model_override(
    inputs: &ImageModelRoutingInputs<'_>,
) -> Result<Option<ResolvedImageModel>, String> {
    let session_model = inputs.session_model;
    if takes_image_input(session_model) || inputs.block_images {
        return Ok(None);
    }
    let Some(reference) = inputs.image_model_reference else {
        return Err(format_image_model_required_message(&format!(
            "{}/{}",
            session_model.provider, session_model.id
        )));
    };
    let image_model = find_exact_model_reference_match(reference, inputs.available_models)
        .ok_or_else(|| format_image_model_unusable_message(reference))?;
    let usable =
        takes_image_input(image_model) && (inputs.has_configured_auth)(image_model);
    if !usable {
        return Err(format_image_model_unusable_message(reference));
    }
    Ok(Some(ResolvedImageModel {
        model: image_model.clone(),
        thinking_level: clamp_thinking_level(image_model, inputs.thinking_level),
        service_tier: match inputs.service_tier {
            Some(ServiceTier::Priority) if !supports_fast_mode(image_model) => {
                Some(ServiceTier::Default)
            }
            other => other,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, image: bool) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: pa_types::ai::Api::AnthropicMessages,
            provider: "anthropic".to_string(),
            base_url: "https://x".to_string(),
            reasoning: true,
            thinking_level_map: None,
            input: if image {
                vec![ModelInput::Text, ModelInput::Image]
            } else {
                vec![ModelInput::Text]
            },
            cost: pa_types::ai::ModelCost {
                input: 1.0.into(),
                output: 2.0.into(),
                cache_read: 0.0.into(),
                cache_write: 0.0.into(),
            },
            context_window: 200_000,
            max_tokens: 8192,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    fn inputs<'a>(
        session_model: &'a Model,
        reference: Option<&'a str>,
        available: &'a [Model],
        block_images: bool,
    ) -> ImageModelRoutingInputs<'a> {
        ImageModelRoutingInputs {
            session_model,
            thinking_level: ModelThinkingLevel::High,
            service_tier: Some(ServiceTier::Priority),
            image_model_reference: reference,
            available_models: available,
            has_configured_auth: &|_| true,
            block_images,
        }
    }

    fn resolved_ok(inputs: &ImageModelRoutingInputs<'_>) -> Option<String> {
        match resolve_image_model_override(inputs) {
            Ok(Some(resolved)) => Some(resolved.model.id),
            Ok(None) => None,
            Err(message) => Some(format!("ERR:{message}")),
        }
    }

    // The TS table (test/image-model-override.test.ts): routes image turns
    // to imageModel; a vision session model serves image turns natively;
    // blocked images stay on the session model; refusals name the setting.
    #[test]
    fn routes_image_turns_to_image_model() {
        let session = model("claude-opus-4-7-text-only", false);
        let image_model = model("claude-haiku-4-5", true);
        let available = vec![session.clone(), image_model.clone()];
        let inputs = inputs(&session, Some("claude-haiku-4-5"), &available, false);
        let resolved = resolve_image_model_override(&inputs).unwrap().unwrap();
        assert_eq!(resolved.model.id, "claude-haiku-4-5");
        // Thinking level and tier clamp to what the routed model supports.
        assert_eq!(resolved.thinking_level, ModelThinkingLevel::High);
        assert_eq!(resolved.service_tier, Some(ServiceTier::Default));
    }

    #[test]
    fn vision_session_model_serves_image_turns() {
        let session = model("claude-opus-4-7", true);
        let available = vec![session.clone()];
        let inputs = inputs(&session, Some("claude-opus-4-7"), &available, false);
        assert_eq!(resolve_image_model_override(&inputs).unwrap(), None);
    }

    #[test]
    fn blocked_images_stay_on_the_session_model() {
        let session = model("claude-opus-4-7-text-only", false);
        let available = vec![session.clone()];
        let inputs = inputs(&session, Some("claude-haiku-4-5"), &available, true);
        assert_eq!(resolve_image_model_override(&inputs).unwrap(), None);
    }

    #[test]
    fn refuses_without_image_model() {
        let session = model("claude-opus-4-7-text-only", false);
        let available = vec![session.clone()];
        let inputs = inputs(&session, None, &available, false);
        let error = resolve_image_model_override(&inputs).unwrap_err();
        assert!(
            error.contains("does not accept image input"),
            "{error}"
        );
        assert!(error.contains("Set imageModel in settings.json"), "{error}");
    }

    #[test]
    fn refuses_unusable_reference() {
        let session = model("claude-opus-4-7-text-only", false);
        let available = vec![session.clone()];
        let inputs = inputs(&session, Some("openai/gpt-5.4"), &available, false);
        let error = resolve_image_model_override(&inputs).unwrap_err();
        assert!(error.contains("could not be resolved"), "{error}");
    }

    #[test]
    fn refuses_text_only_image_model() {
        let session = model("claude-opus-4-7-text-only", false);
        let backup = model("deepseek-v4-pro", false);
        let available = vec![session.clone(), backup];
        let inputs = inputs(&session, Some("deepseek/deepseek-v4-pro"), &available, false);
        let error = resolve_image_model_override(&inputs).unwrap_err();
        assert!(error.contains("could not be resolved"), "{error}");
    }

    #[test]
    fn refuses_unauthenticated_image_model() {
        let session = model("claude-opus-4-7-text-only", false);
        let image_model = model("claude-haiku-4-5", true);
        let available = vec![session.clone(), image_model.clone()];
        let mut inputs = inputs(&session, Some("claude-haiku-4-5"), &available, false);
        inputs.has_configured_auth = &|model| model.id != "claude-haiku-4-5";
        let error = resolve_image_model_override(&inputs).unwrap_err();
        assert!(error.contains("could not be resolved"), "{error}");
    }

    #[test]
    fn priority_tier_kept_on_fast_mode_models() {
        let session = model("claude-opus-4-7-text-only", false);
        let mut image_model = model("gpt-5.4", true);
        image_model.provider = "openai".to_string();
        image_model.api = pa_types::ai::Api::OpenAiResponses;
        let available = vec![session.clone(), image_model.clone()];
        let inputs = inputs(&session, Some("openai/gpt-5.4"), &available, false);
        let resolved = resolve_image_model_override(&inputs).unwrap().unwrap();
        assert_eq!(resolved.service_tier, Some(ServiceTier::Priority));
    }
}

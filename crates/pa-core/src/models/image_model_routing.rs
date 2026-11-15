//! Routing for image-attaching turns on session models without image input.
//! The decision is pure: the embedding supplies the session model, its
//! per-request fields, `settings.imageModel`, the catalog, and the auth
//! probe; the resolver returns the image-capable model or an actionable error.

use pa_types::ai::{clamp_thinking_level, supports_fast_mode, ServiceTier};

use super::resolver::find_exact_model_reference_match;
use pa_types::ai::{Model, ModelInput, ModelThinkingLevel};

/// The model serving a routed image turn, with the session's per-request
/// fields clamped to what it supports (TS `AgentModelOverride`'s fields).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedImageModel {
    pub model: Model,
    pub thinking_level: ModelThinkingLevel,
    /// Session service tier clamped for the routed model (a `priority`
    /// request on a model without fast mode serves `default`).
    pub service_tier: Option<ServiceTier>,
}

/// Whether the model takes image input (TS `model.input.includes("image")`).
fn takes_image_input(model: &Model) -> bool {
    model.input.contains(&ModelInput::Image)
}

/// Whether the session model can carry image input, and — when it cannot — whether the
/// catalog actually declares it (a text-only entry) or knows nothing about it. The
/// difference is user-facing: an id absent from every catalog must be named as such
/// instead of being blamed on the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionImageSupport {
    /// The model, or its catalog entry, declares image input.
    Native,
    /// The catalog lists the model and declares no image input.
    DeclaredTextOnly,
    /// No catalog entry exists for the id: nothing declares it either way.
    NotInCatalog,
}

/// Classify the session model's image support against the catalog. A matching catalog
/// entry (same provider and id) decides — the entry is the truth about the model, and a
/// locally synthesized session model need not carry the same `input` list. Without one,
/// the session model's own declaration is all there is.
#[must_use]
pub fn session_image_support(session_model: &Model, available: &[Model]) -> SessionImageSupport {
    match available
        .iter()
        .find(|model| model.provider == session_model.provider && model.id == session_model.id)
    {
        Some(catalog) if takes_image_input(catalog) => SessionImageSupport::Native,
        Some(_) => SessionImageSupport::DeclaredTextOnly,
        None if takes_image_input(session_model) => SessionImageSupport::Native,
        None => SessionImageSupport::NotInCatalog,
    }
}

/// The session model id is absent from every catalog, so nothing declares that it can
/// see images: say "unknown" out loud instead of blaming the model for a capability the
/// catalog never recorded.
fn format_image_model_unknown_message(session_model_id: &str) -> String {
    format!(
        "This turn attaches images, but the selected model ({session_model_id}) is not in the model catalog, so it is treated as text-only.

Pick one:
- Switch to a model the catalog lists with image input (/model), or
- Set imageModel in settings.json to an image-capable model (\"provider/model-id\" or a bare id), e.g. \"anthropic/claude-sonnet-4-5\"

Then resend the message. Without it the request would silently drop the images."
    )
}

/// TS `formatImageModelRequiredMessage`: the session model cannot serve the
/// attached images and no image model is configured.
fn format_image_model_required_message(session_model_id: &str) -> String {
    format!(
        "This turn attaches images, but the selected model ({session_model_id}) does not accept image input.\n\nPick one:\n- Switch the session model to an image-capable one with /model, or\n- Set imageModel in settings.json to an image-capable model (\"provider/model-id\" or a bare id), e.g. \"anthropic/claude-sonnet-4-5\"\n\nThen resend the message. Without it the request would silently drop the images."
    )
}

/// TS `formatImageModelUnusableMessage`: the configured `imageModel` could
/// not be resolved to an available, image-capable, authenticated model.
fn format_image_model_unusable_message(reference: &str) -> String {
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
    pub thinking_level: ModelThinkingLevel,
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
///
/// # Errors
///
/// The actionable refusal when the turn cannot be served honestly.
pub fn resolve_image_model_override(
    inputs: &ImageModelRoutingInputs<'_>,
) -> Result<Option<ResolvedImageModel>, String> {
    let session_model = inputs.session_model;
    if takes_image_input(session_model) || inputs.block_images {
        return Ok(None);
    }
    let Some(reference) = inputs.image_model_reference else {
        let selector = format!("{}/{}", session_model.provider, session_model.id);
        return Err(
            match session_image_support(session_model, inputs.available_models) {
                SessionImageSupport::NotInCatalog => format_image_model_unknown_message(&selector),
                // `Native` cannot reach here (the early return above); it shares the
                // text-only copy rather than inventing a third message.
                SessionImageSupport::Native | SessionImageSupport::DeclaredTextOnly => {
                    format_image_model_required_message(&selector)
                }
            },
        );
    };
    let image_model = find_exact_model_reference_match(reference, inputs.available_models)
        .ok_or_else(|| format_image_model_unusable_message(reference))?;
    let usable = takes_image_input(image_model) && (inputs.has_configured_auth)(image_model);
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
            api: "anthropic-messages".to_string(),
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
            max_tokens_explicit: false,
            featured: None,
            serving: None,
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

    // The TS table (test/image-model-override.test.ts): routes image turns
    // to imageModel; a vision session model serves image turns natively;
    // blocked images stay on the session model; refusals name the setting.
    #[test]
    fn routes_image_turns_to_image_model() {
        let session = model("claude-opus-4-7-text-only", false);
        let image_model = model("claude-haiku-4-5", true);
        let available = vec![session.clone(), image_model];
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
        assert!(error.contains("does not accept image input"), "{error}");
        assert!(error.contains("Set imageModel in settings.json"), "{error}");
    }

    /// The classifier is what lets the refusal distinguish "the catalog says this model
    /// is text-only" from "no catalog knows this id": the second one must be said out
    /// loud instead of blaming the model.
    #[test]
    fn session_image_support_reads_the_catalog_entry() {
        let vision = model("claude-opus-4-7", true);
        let text_only = model("claude-opus-4-7-text-only", false);
        let available = vec![vision.clone(), text_only.clone()];
        assert_eq!(
            session_image_support(&vision, &available),
            SessionImageSupport::Native
        );
        assert_eq!(
            session_image_support(&text_only, &available),
            SessionImageSupport::DeclaredTextOnly
        );
        // An id no catalog lists ("deepseek-flash" was the real one) is unknown, not
        // text-only-by-declaration.
        let mut uncatalogued = model("deepseek-flash", false);
        uncatalogued.provider = "deepseek".to_string();
        assert_eq!(
            session_image_support(&uncatalogued, &available),
            SessionImageSupport::NotInCatalog
        );
        // A locally configured model that declares image input outside the catalog still
        // counts as native: its own declaration is the only truth available.
        let mut local_vision = model("local-vision", true);
        local_vision.provider = "local".to_string();
        assert_eq!(
            session_image_support(&local_vision, &available),
            SessionImageSupport::Native
        );
    }

    #[test]
    fn an_uncatalogued_session_model_gets_the_unknown_refusal() {
        let catalogued = model("claude-opus-4-7-text-only", false);
        let available = vec![catalogued.clone()];
        let mut uncatalogued = model("deepseek-flash", false);
        uncatalogued.provider = "deepseek".to_string();
        let routing = inputs(&uncatalogued, None, &available, false);
        let error = resolve_image_model_override(&routing).unwrap_err();
        assert!(error.contains("not in the model catalog"), "{error}");
        assert!(error.contains("deepseek/deepseek-flash"), "{error}");
        assert!(
            !error.contains("does not accept image input"),
            "an uncatalogued model is not blamed for a capability the catalog never              recorded: {error}"
        );
        // The catalogued text-only model keeps the original copy.
        let routing = inputs(&catalogued, None, &available, false);
        let error = resolve_image_model_override(&routing).unwrap_err();
        assert!(error.contains("does not accept image input"), "{error}");
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
        let inputs = inputs(
            &session,
            Some("deepseek/deepseek-v4-pro"),
            &available,
            false,
        );
        let error = resolve_image_model_override(&inputs).unwrap_err();
        assert!(error.contains("could not be resolved"), "{error}");
    }

    #[test]
    fn refuses_unauthenticated_image_model() {
        let session = model("claude-opus-4-7-text-only", false);
        let image_model = model("claude-haiku-4-5", true);
        let available = vec![session.clone(), image_model];
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
        image_model.api = "openai-responses".to_string();
        let available = vec![session.clone(), image_model];
        let inputs = inputs(&session, Some("openai/gpt-5.4"), &available, false);
        let resolved = resolve_image_model_override(&inputs).unwrap().unwrap();
        assert_eq!(resolved.service_tier, Some(ServiceTier::Priority));
    }
}

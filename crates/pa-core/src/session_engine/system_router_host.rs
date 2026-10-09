//! The `system_router.run` kernel host-request handler (#2484).
//!
//! The session model (System 2) declares the environment (a stdio adapter
//! command plus its init payload), the finite action space (its own or the
//! adapter's defaults), and the System 1 action model; the handler resolves
//! the action model and its request auth, then runs one bounded router
//! segment and returns the complete trace for System 2 to review and steer.
//!
//! Port of `handleSystemRouterHostRequest` in `core/agent-session.ts`. It
//! composes the existing seams exactly like the TS handler: the action-model
//! selector resolves like `_resolveRlmSubagentModel` (the #2453
//! per-call-model-override precedent), the request auth preflight resolves
//! through the registry, and the decision calls ride `complete_simple` under
//! the shared provider-retry policy. The step loop itself lives in
//! [`crate::system_router`].
//!
//! Divergence from the TS reference: the TS handler passes the session
//! dispose `AbortController` into the segment so a host shutdown cancels the
//! adapter subprocess and the decision calls. The kernel host-request bridge
//! in this port has no per-request abort signal, so v1 runs the segment
//! without one; the segment's own wall-clock budget bounds every run.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use pa_agent::types::Model;
use pa_types::ai::Model as AiModel;
use serde_json::Value;

use crate::auth::AuthStorage;
use crate::kernel::shared::{host_handler, HostRequestHandlers};
use crate::models::registry::ModelRegistry;
use crate::models::resolver::find_exact_model_reference_match;
use crate::session_engine::provider_retry::ProviderRetryPolicy;
use crate::system_router::{
    parse_system_router_run_spec, run_router_segment, RouterSegmentOptions,
};

/// The session facts the `system_router.run` handler resolves against.
#[derive(Clone)]
pub struct SystemRouterHostConfig {
    pub agent_dir: PathBuf,
    pub cwd: PathBuf,
    /// The session model: the last fallback for the action-model selector.
    /// It crosses back to the ai side field by field
    /// ([`crate::session_engine::provider_adapter::agent_model_to_ai_model`]);
    /// the two `Model`s do not share a wire shape, unlike the message
    /// handoffs.
    pub session_model: Model,
    pub session_id: String,
    /// The configured subagent default model (the action model's first
    /// fallback, before the session model).
    pub subagent_default_model: Option<String>,
    /// The daemon `allowedModels` pin, enforced on the resolved action model.
    pub allowed_models: Option<Vec<String>>,
    pub policy: ProviderRetryPolicy,
}

/// Register the `system_router.run` host handler.
pub fn register_system_router_handlers(
    handlers: &mut HostRequestHandlers,
    config: SystemRouterHostConfig,
) {
    let config = Arc::new(config);
    handlers.register(
        "system_router.run",
        host_handler(move |payload| {
            let config = Arc::clone(&config);
            Box::pin(async move { handle_system_router_run(&config, &payload.data).await })
        }),
    );
}

/// Handle one `system_router.run` request: parse the spec, resolve the action
/// model and auth, and run one bounded segment.
///
/// # Errors
///
/// Returns an error when the spec is malformed, the action-model selector
/// cannot be resolved (or sits outside the allowlist), the model is not
/// authenticated, or the segment fails to start.
pub async fn handle_system_router_run(
    config: &SystemRouterHostConfig,
    payload: &Value,
) -> anyhow::Result<Value> {
    let spec = parse_system_router_run_spec(payload)?;
    let (model, api_key, headers) = resolve_action_model(config, spec.model.as_deref())?;
    let result = run_router_segment(
        &spec,
        RouterSegmentOptions {
            model,
            api_key,
            headers,
            session_id: Some(config.session_id.clone()),
            policy: config.policy.clone(),
            env: None,
            decide: None,
            default_cwd: Some(config.cwd.to_string_lossy().into_owned()),
            // No per-request abort signal exists on the kernel host bridge;
            // the segment's wall-clock budget bounds the run.
            signal: None,
        },
    )
    .await?;
    serde_json::to_value(&result).map_err(anyhow::Error::new)
}

/// The resolved action model: the model, its API key, and its merged request
/// headers.
type ResolvedActionModel = (AiModel, Option<String>, Option<BTreeMap<String, String>>);

/// Resolve the System 1 action model and its request auth: the spec's
/// selector, else the configured subagent default, else the session model.
/// The session model resolves through the catalog like any other selector
/// (the pa-agent model on this side is lossy: it carries no input
/// modalities), with the agent-model field mapping as the fallback for a
/// session model the catalog does not carry, named in the full form or in
/// the TS short form.
fn resolve_action_model(
    config: &SystemRouterHostConfig,
    reference: Option<&str>,
) -> anyhow::Result<ResolvedActionModel> {
    let mut registry = ModelRegistry::create(
        AuthStorage::create(&config.agent_dir),
        config.agent_dir.join("models.json"),
    );
    registry.load_private_authorization_from_cache();
    let session_selector = session_selector(config);
    let reference = reference
        .map(str::trim)
        .filter(|reference| !reference.is_empty())
        .map(str::to_string)
        .or_else(|| config.subagent_default_model.clone())
        .unwrap_or_else(|| session_selector.clone());
    let model = resolve_reference(&registry, config, &reference, &session_selector)?;
    if let Some(allowlist) = &config.allowed_models {
        let selector = format!("{}/{}", model.provider, model.id).to_lowercase();
        if !crate::models::model_allowed(&selector, allowlist) {
            anyhow::bail!(
                "Requested system-router model \"{selector}\" is blocked by the model allowlist"
            );
        }
    }
    let resolved = registry.get_api_key_and_headers(&model, model.headers.as_ref());
    if !resolved.ok {
        anyhow::bail!(
            "Model \"{}/{}\" is not authenticated: {}",
            model.provider,
            model.id,
            resolved.error.as_deref().unwrap_or("no credential found")
        );
    }
    Ok((model, resolved.api_key, resolved.headers))
}

/// The session model's `provider/model-id` selector.
fn session_selector(config: &SystemRouterHostConfig) -> String {
    format!(
        "{}/{}",
        config.session_model.provider, config.session_model.id
    )
}

/// Resolve one model reference against the credential-backed catalog. The
/// session model itself falls back to the agent-model field mapping when
/// the catalog does not carry it (a scripted or in-memory model), named in
/// the full `provider/id` form or in the TS short form.
fn resolve_reference(
    registry: &ModelRegistry,
    config: &SystemRouterHostConfig,
    reference: &str,
    session_selector: &str,
) -> anyhow::Result<AiModel> {
    // The exact catalog match over the searchable set (TS
    // `_authenticatedRlmModels`).
    let searchable: Vec<AiModel> = registry
        .get_rlm_searchable_models()
        .into_iter()
        .cloned()
        .collect();
    if let Some(model) = find_exact_model_reference_match(reference, &searchable) {
        return Ok(model.clone());
    }
    if reference.eq_ignore_ascii_case(session_selector) {
        // The catalog miss for the session's own model means the same
        // thing as for any other reference: unauthenticated, absent, or
        // expired. A stale or expired provider must fail here instead of
        // starting a segment whose first decision call fails its model
        // request (the TS parent-model branch); every other miss crosses
        // back to the ai side field by field, which covers a session
        // model the catalog does not carry (a scripted or in-memory
        // model). The full form resolves before any catalog short-form
        // match below (TS runs the parent equality first).
        return session_model_fallback(registry, config, reference);
    }
    // The TS short-form tail (`_resolveRlmSubagentModel`:
    // `candidates.find(exact) ?? findUniqueRlmShortFormModelMatch(reference,
    // candidates, parentModel)`): a unique catalog match resolves first,
    // several still leave the reference unresolved, and the session model
    // backs the lookup only when the catalog has no match at all ("The
    // parent model can be missing from the authenticated catalog (offline
    // discovery or expired credentials) while staying selectable, so it
    // backs the short-form lookup when the catalog has no match. Several
    // catalog matches still leave the reference unresolved."). The daemon
    // child-model resolution (resolve_child_model_unchecked) pins the
    // same suffix rule.
    let short_form_matches: Vec<&AiModel> = searchable
        .iter()
        .filter(|model| is_short_form_selector(reference, &model.provider, &model.id))
        .collect();
    if short_form_matches.len() == 1 {
        return Ok(short_form_matches[0].clone());
    }
    if short_form_matches.is_empty()
        && is_short_form_selector(
            reference,
            &config.session_model.provider,
            &config.session_model.id,
        )
    {
        // The same session-model fallback as the full form above, gate
        // included: a short-form name for a stale session provider fails
        // just as loudly.
        return session_model_fallback(registry, config, reference);
    }
    Err(unavailable_error(reference))
}

/// The TS short form (`findRlmShortFormModelMatches`): a reference names a
/// model when the full selector ends with `"/<reference>"`, so a bare id
/// like "glm-5.3" also matches "prime-inference/z-ai/glm-5.3".
fn is_short_form_selector(reference: &str, provider: &str, id: &str) -> bool {
    let normalized = reference.trim().to_lowercase();
    !normalized.is_empty()
        && format!("{provider}/{id}")
            .to_lowercase()
            .ends_with(&format!("/{normalized}"))
}

/// The session model's fallback crossing, under the stale/expired gate: a
/// stale or expired provider fails the reference loudly instead of
/// starting a segment whose first decision call fails its model request
/// (the TS parent-model branch); any other provider crosses the agent
/// descriptor back to the ai side field by field.
fn session_model_fallback(
    registry: &ModelRegistry,
    config: &SystemRouterHostConfig,
    reference: &str,
) -> anyhow::Result<AiModel> {
    let status = registry.get_provider_auth_status(&config.session_model.provider);
    if status.source != Some(crate::auth::types::AuthSource::Stale)
        && status.label.as_deref() != Some("expired")
    {
        Ok(crate::session_engine::provider_adapter::agent_model_to_ai_model(&config.session_model))
    } else {
        Err(unavailable_error(reference))
    }
}

/// The unavailable-model refusal (the TS `formatRlmModelUnavailableError`
/// base and hint, without the close-match list).
fn unavailable_error(reference: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "Requested system-router model \"{reference}\" is unavailable, unauthenticated, or expired; selectors use the form \"provider/model-id\" (e.g. \"prime-inference/internal/glm-5.3-fast\")"
    )
}

// The unit battery lives in the child module (system_router_host::tests).
#[cfg(test)]
mod tests;

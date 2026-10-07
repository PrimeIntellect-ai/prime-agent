//! Child model resolution over the model registry: the TS
//! `_resolveRlmSubagentModel` half the daemon shares, over the in-process
//! registry the host owns (no daemon allowlist: the resident guest owns
//! its model surface), plus the spawn-time thinking-support check.

use pa_types::ai::Model;
use pa_types::ai::{get_supported_thinking_levels, thinking_level_from_str};

use crate::kernel::rlm_runtime::{find_rlm_model_matches, RlmModelInfo};
use crate::models::registry::ModelRegistry;

/// Close matches listed in model-resolution errors (TS suggestion limit).
const MODEL_ERROR_SUGGESTION_LIMIT: usize = 3;

/// A resolved child model: the selector the roster reports and the model
/// the child engine runs.
#[derive(Debug, Clone)]
pub struct ResolvedChildModel {
    pub selector: String,
    pub model: pa_agent::types::Model,
}

/// The searchable catalog as `rlm.find_models` sees it.
fn catalog(registry: &ModelRegistry) -> Vec<&Model> {
    registry.get_rlm_searchable_models()
}

/// The `provider/id` info list model-resolution errors suggest from.
fn catalog_infos(registry: &ModelRegistry) -> Vec<RlmModelInfo> {
    catalog(registry)
        .into_iter()
        .map(|model| RlmModelInfo {
            provider: model.provider.clone(),
            id: model.id.clone(),
            name: if model.name.is_empty() {
                model.id.clone()
            } else {
                model.name.clone()
            },
        })
        .collect()
}

/// Resolve the child model reference (TS `_resolveRlmSubagentModel`):
/// `None` inherits the parent's live model, a reference resolves exactly
/// like the TS — parent equality first, then an exact catalog selector,
/// then a unique short-form match, then a parent short form — else the
/// TS unavailable-model error with close matches.
///
/// # Errors
///
/// Returns an error when no parent model is bound and no reference was
/// supplied, when the reference matches no catalog model, or when the
/// resolved model fails the wire-shape conversion.
pub fn resolve_child_model(
    registry: &ModelRegistry,
    reference: Option<&str>,
    parent_model: Option<&pa_agent::types::Model>,
    target: &str,
) -> anyhow::Result<ResolvedChildModel> {
    let Some(reference) = reference
        .map(str::trim)
        .filter(|reference| !reference.is_empty())
    else {
        return parent_model
            .cloned()
            .map(|model| ResolvedChildModel {
                selector: format!("{}/{}", model.provider, model.id),
                model,
            })
            .ok_or_else(|| anyhow::anyhow!("No model selected. Use /model to pick one."));
    };
    let normalized = reference.to_lowercase();
    if let Some(parent) = parent_model {
        if format!("{}/{}", parent.provider, parent.id).to_lowercase() == normalized {
            return Ok(ResolvedChildModel {
                selector: format!("{}/{}", parent.provider, parent.id),
                model: parent.clone(),
            });
        }
    }
    let catalog = catalog(registry);
    let selector_of = |model: &Model| format!("{}/{}", model.provider, model.id);
    if let Some(exact) = catalog
        .iter()
        .copied()
        .find(|model| selector_of(model).to_lowercase() == normalized)
    {
        return agent_model_of(exact, target);
    }
    // Short form: the full selector ends with "/<reference>".
    let short_matches: Vec<&Model> = catalog
        .iter()
        .copied()
        .filter(|model| {
            selector_of(model)
                .to_lowercase()
                .ends_with(&format!("/{normalized}"))
        })
        .collect();
    match short_matches.len() {
        1 => agent_model_of(short_matches[0], target),
        0 => parent_model
            .filter(|parent| {
                format!("{}/{}", parent.provider, parent.id)
                    .to_lowercase()
                    .ends_with(&format!("/{normalized}"))
            })
            .map(|parent| ResolvedChildModel {
                selector: format!("{}/{}", parent.provider, parent.id),
                model: parent.clone(),
            })
            .ok_or_else(|| model_unavailable_error(reference, target, &catalog_infos(registry))),
        _ => Err(model_unavailable_error(
            reference,
            target,
            &catalog_infos(registry),
        )),
    }
}

/// The catalog model in the agent loop's shape.
fn agent_model_of(model: &Model, target: &str) -> anyhow::Result<ResolvedChildModel> {
    let selector = format!("{}/{}", model.provider, model.id);
    let agent_model = super::super::provider_adapter::json_round_trip(model).ok_or_else(|| {
        anyhow::anyhow!("Requested {target} model \"{selector}\" failed the wire-shape conversion")
    })?;
    Ok(ResolvedChildModel {
        selector,
        model: agent_model,
    })
}

/// Rejection message for an unresolved model reference (TS
/// `formatRlmModelUnavailableError`): the unavailability, the selector
/// form, and close matches so the caller can retry with a full selector.
fn model_unavailable_error(
    reference: &str,
    target: &str,
    catalog: &[RlmModelInfo],
) -> anyhow::Error {
    let base = format!(
        "Requested {target} model \"{reference}\" is unavailable, unauthenticated, or expired"
    );
    let hint =
        "selectors use the form \"provider/model-id\" (e.g. \"prime-inference/z-ai/glm-5.3\")";
    let close_matches = find_rlm_model_matches(reference, catalog, MODEL_ERROR_SUGGESTION_LIMIT);
    if close_matches.is_empty() {
        anyhow::anyhow!("{base}; {hint}")
    } else {
        let selectors = close_matches
            .iter()
            .map(|match_| format!("\"{}\"", match_.selector))
            .collect::<Vec<_>>()
            .join(", ");
        anyhow::anyhow!("{base}; {hint}; close matches: {selectors}")
    }
}

/// A requested thinking level must be supported by the resolved model
/// (the TS spawn-time check). A model outside the local catalog cannot be
/// checked and passes.
///
/// # Errors
///
/// Returns an error when the resolved model's supported levels do not
/// include the requested level (the message lists the supported levels).
pub fn assert_thinking_supported(
    registry: &ModelRegistry,
    level: Option<&str>,
    selector: &str,
) -> anyhow::Result<()> {
    let Some(level) = level else {
        return Ok(());
    };
    let Some((provider, id)) = selector.split_once('/') else {
        return Ok(());
    };
    let Some(model) = registry
        .get_rlm_searchable_models()
        .into_iter()
        .find(|model| model.provider == provider && model.id == id)
    else {
        return Ok(());
    };
    let supported = get_supported_thinking_levels(model);
    let Some(requested) = thinking_level_from_str(level) else {
        return Ok(());
    };
    if supported.contains(&requested) {
        return Ok(());
    }
    let levels = supported
        .iter()
        .map(|level| level.wire_name())
        .collect::<Vec<_>>()
        .join(", ");
    anyhow::bail!(
        "Requested thinking level \"{level}\" is not supported by model \"{selector}\"; supported levels: {levels}"
    );
}

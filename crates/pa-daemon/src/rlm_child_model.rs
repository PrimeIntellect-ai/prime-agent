//! RLM child model resolution and roster text helpers: the pa-daemon side of
//! the TS `_resolveRlmSubagentModel` (reference resolution against the
//! credential-backed catalog, with the TS unavailable-model error) and the
//! spawn-time thinking-support check, plus the roster text caps.

use std::path::Path;

use anyhow::{anyhow, bail, Result};
use pa_ai::models::{get_supported_thinking_levels, thinking_level_from_str};
use pa_core::auth::AuthStorage;
use pa_core::kernel::rlm_runtime::{find_rlm_model_matches, RlmModelInfo};
use pa_core::models::ModelRegistry;

/// Close matches listed in model-resolution errors (TS suggestion limit).
const MODEL_ERROR_SUGGESTION_LIMIT: usize = 3;
/// Cap on the answer preview handed to the parent model (TS `compactRlmText`).
pub const ANSWER_PREVIEW_MAX_CHARS: usize = 160;
/// Cap on the one-line task label shown in kernel rosters.
pub const LABEL_MAX_CHARS: usize = 200;
const ELLIPSIS: &str = "...";

/// The model catalog the RLM surface resolves against: the same
/// credential-backed list `rlm.find_models` searches.
pub fn catalog_models(agent_dir: &Path) -> Vec<RlmModelInfo> {
    let auth = AuthStorage::create(agent_dir);
    let registry = ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry
        .get_rlm_searchable_models()
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

/// Resolve the child model reference. `None` inherits the parent model; a
/// reference resolves exactly like the TS `_resolveRlmSubagentModel`:
/// parent equality first, then an exact catalog selector, then a unique
/// short-form match, else the TS unavailable-model error.
pub fn resolve_child_model(
    agent_dir: &Path,
    reference: Option<&str>,
    parent_model: Option<&str>,
    target: &str,
) -> Result<String> {
    let Some(reference) = reference else {
        return parent_model
            .map(str::to_string)
            .ok_or_else(|| anyhow!("No model selected. Use /model to pick one."));
    };
    let reference = reference.trim();
    let normalized = reference.to_lowercase();
    if let Some(parent) = parent_model {
        if parent.to_lowercase() == normalized {
            return Ok(parent.to_string());
        }
    }
    let candidates = catalog_models(agent_dir);
    let selector_of = |model: &RlmModelInfo| format!("{}/{}", model.provider, model.id);
    if let Some(exact) = candidates
        .iter()
        .find(|model| selector_of(model).to_lowercase() == normalized)
    {
        return Ok(selector_of(exact));
    }
    // Short form: the full selector ends with "/<reference>".
    let short_matches: Vec<&RlmModelInfo> = candidates
        .iter()
        .filter(|model| {
            selector_of(model)
                .to_lowercase()
                .ends_with(&format!("/{normalized}"))
        })
        .collect();
    match short_matches.len() {
        1 => return Ok(selector_of(short_matches[0])),
        0 => {
            if let Some(parent) = parent_model {
                if parent.to_lowercase().ends_with(&format!("/{normalized}")) {
                    return Ok(parent.to_string());
                }
            }
        }
        _ => {}
    }
    Err(model_unavailable_error(reference, target, &candidates))
}

/// A requested thinking level must be supported by the resolved model (the
/// TS spawn-time check). A model outside the local catalog (a scripted
/// verification model) cannot be checked and passes.
pub fn assert_thinking_supported(
    agent_dir: &Path,
    level: Option<&str>,
    selector: &str,
) -> Result<()> {
    let Some(level) = level else {
        return Ok(());
    };
    let Some((provider, id)) = selector.split_once('/') else {
        return Ok(());
    };
    let auth = AuthStorage::create(agent_dir);
    let registry = ModelRegistry::create(auth, agent_dir.join("models.json"));
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
    bail!(
        "Requested thinking level \"{level}\" is not supported by model \"{selector}\"; supported levels: {levels}"
    );
}

/// Rejection message for an unresolved model reference (TS
/// `formatRlmModelUnavailableError`): the unavailability, the selector form,
/// and close matches so the caller can retry with a full selector.
fn model_unavailable_error(
    reference: &str,
    target: &str,
    candidates: &[RlmModelInfo],
) -> anyhow::Error {
    let base = format!(
        "Requested {target} model \"{reference}\" is unavailable, unauthenticated, or expired"
    );
    let hint =
        "selectors use the form \"provider/model-id\" (e.g. \"prime-inference/z-ai/glm-5.3\")";
    let close_matches = find_rlm_model_matches(reference, candidates, MODEL_ERROR_SUGGESTION_LIMIT);
    if close_matches.is_empty() {
        anyhow!("{base}; {hint}")
    } else {
        let selectors = close_matches
            .iter()
            .map(|match_| format!("\"{}\"", match_.selector))
            .collect::<Vec<_>>()
            .join(", ");
        anyhow!("{base}; {hint}; close matches: {selectors}")
    }
}

/// Collapse whitespace and cap at the roster limit (TS `compactRlmText`).
pub fn compact_rlm_text(text: &str) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    cap_text(&compact, ANSWER_PREVIEW_MAX_CHARS)
}

/// One-line task label: collapsed prompt, capped for roster rows.
pub fn rlm_child_label(prompt: &str) -> String {
    let collapsed: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let collapsed = if collapsed.is_empty() {
        "child agent".to_string()
    } else {
        collapsed
    };
    cap_text(&collapsed, LABEL_MAX_CHARS)
}

/// Whitespace-collapsed text capped at `max` chars with an ellipsis.
fn cap_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max - ELLIPSIS.len()).collect();
    format!("{}{}", kept.trim_end(), ELLIPSIS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A models.json custom provider, like the pa-core registry tests.
    fn write_catalog(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("models.json"),
            json!({
                "providers": {
                    "test-provider": {
                        "baseUrl": "http://localhost:9",
                        "apiKey": "test-key",
                        "api": "openai-completions",
                        "models": [
                            { "id": "glm-5.3", "name": "GLM 5.3", "contextWindow": 1000, "maxTokens": 100 },
                            { "id": "glm-5.3-turbo", "name": "GLM Turbo", "contextWindow": 1000, "maxTokens": 100 }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn resolves_parent_exact_and_short_form_references() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        // No reference inherits the parent model.
        let resolved =
            resolve_child_model(dir.path(), None, Some("test-provider/glm-5.3"), "subagent")
                .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3");
        // Parent equality short-circuits even a catalog refresh miss.
        let resolved = resolve_child_model(
            dir.path(),
            Some("Test-Provider/GLM-5.3"),
            Some("test-provider/glm-5.3"),
            "subagent",
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3");
        // Exact catalog selector.
        let resolved = resolve_child_model(
            dir.path(),
            Some("test-provider/glm-5.3-turbo"),
            Some("test-provider/glm-5.3"),
            "subagent",
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3-turbo");
        // Unique short form.
        let resolved = resolve_child_model(
            dir.path(),
            Some("glm-5.3-turbo"),
            Some("test-provider/glm-5.3"),
            "subagent",
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3-turbo");
        // No reference and no parent model: the TS no-model error.
        let error = resolve_child_model(dir.path(), None, None, "subagent").unwrap_err();
        assert_eq!(
            error.to_string(),
            "No model selected. Use /model to pick one."
        );
    }

    #[test]
    fn unmatched_references_carry_the_ts_error_with_close_matches() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        // TS parity (4649 regression suite): a prefix reference lists close
        // matches, a reference matching nothing at all does not. The
        // reference prefixes the test catalog's provider, so it can never
        // resolve against real default-catalog models.
        let error = resolve_child_model(
            dir.path(),
            Some("test-provi"),
            Some("test-provider/glm-5.3"),
            "subagent",
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(
            message.starts_with(
                "Requested subagent model \"test-provi\" is unavailable, unauthenticated, or expired; selectors use the form \"provider/model-id\""
            ),
            "{message}"
        );
        // Close matches list full selectors, nearest first.
        assert!(
            message.contains("close matches: \"test-provider/glm-5.3\""),
            "{message}"
        );
        // A reference matching nothing at all omits the close-match list.
        let error = resolve_child_model(
            dir.path(),
            Some("zzz"),
            Some("test-provider/glm-5.3"),
            "subagent",
        )
        .unwrap_err();
        assert!(!error.to_string().contains("close matches:"), "{error}");
    }

    #[test]
    fn thinking_support_follows_the_resolved_model() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        // The custom catalog model is non-reasoning: only "off" is supported.
        assert_thinking_supported(dir.path(), Some("off"), "test-provider/glm-5.3").unwrap();
        let error = assert_thinking_supported(dir.path(), Some("high"), "test-provider/glm-5.3")
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Requested thinking level \"high\" is not supported by model \"test-provider/glm-5.3\"; supported levels: off"
        );
        // A model outside the catalog (scripted verification models) passes.
        assert_thinking_supported(dir.path(), Some("high"), "scripted/faux-1").unwrap();
    }

    #[test]
    fn roster_text_is_collapsed_and_capped() {
        let label = rlm_child_label("  ship   the\nlane  ");
        assert_eq!(label, "ship the lane");
        let long = "word ".repeat(100);
        let label = rlm_child_label(&long);
        assert!(label.chars().count() <= LABEL_MAX_CHARS);
        assert!(label.ends_with("..."));
        let preview = compact_rlm_text("  a\nshort   answer ");
        assert_eq!(preview, "a short answer");
        let long_answer = "x".repeat(ANSWER_PREVIEW_MAX_CHARS + 50);
        let preview = compact_rlm_text(&long_answer);
        assert_eq!(preview.chars().count(), ANSWER_PREVIEW_MAX_CHARS);
        assert!(preview.ends_with("..."));
    }
}

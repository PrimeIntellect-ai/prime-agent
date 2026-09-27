//! The daemon-level model allowlist (settings `allowedModels`): the model
//! patterns a daemon may resolve to. A daemon policy, not a session
//! preference — `SettingsManager::get_allowed_models` reads the global
//! scope, and the daemon's model-resolution seams (the `set_model`
//! command, RLM child-model resolution, and the worker's startup model
//! chain) enforce it: a model outside the allowlist fails loudly with
//! [`ModelAllowlistRefusal`] instead of resolving, and the daemon never
//! falls back to a different model on a refusal.
//!
//! Rust-only guardrail (no TS equivalent): unset means unrestricted, which
//! is byte-for-byte the TS behavior. Motivation: a silent fallback to an
//! unintended route (an unavailable pinned model falling back to a
//! metered featured default) must surface as an error, never as a running
//! session on the wrong model.

/// A model the daemon refused to resolve: the resolved selector is outside
/// the configured allowlist. Typed so enforcement seams can downcast the
/// refusal (adoption telemetry) out of the resolution errors that stay
/// TS-parity (unknown / unauthenticated / expired models).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelAllowlistRefusal {
    /// The refused model, full selector form `provider/model-id`.
    pub selector: String,
}

impl std::fmt::Display for ModelAllowlistRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Model \"{}\" is blocked by the daemon model allowlist (settings \"allowedModels\"); \
             the daemon never falls back to a different model. Allow it in the settings \
             or pick an allowed model.",
            self.selector
        )
    }
}

impl std::error::Error for ModelAllowlistRefusal {}

/// Whether a resolved model selector is allowed by the `allowedModels`
/// patterns. Patterns use the `--models` CLI scope grammar, matched
/// case-insensitively against the full selector `provider/model-id` and
/// against the bare model id (whose `prime-inference` ids may carry
/// slashes, e.g. `internal/glm-5.3-fast`): a pattern with wildcards
/// (`*`, `?`, `[`) globs, a plain pattern must match exactly. An empty
/// pattern list allows nothing.
pub fn model_allowed(selector: &str, allowlist: &[String]) -> bool {
    allowlist
        .iter()
        .any(|pattern| pattern_matches_selector(pattern, selector))
}

/// One pattern against one selector: case-insensitive exact or glob match
/// on the full selector or the bare id.
fn pattern_matches_selector(pattern: &str, selector: &str) -> bool {
    let pattern = pattern.trim().to_lowercase();
    if pattern.is_empty() {
        return false;
    }
    let selector = selector.to_lowercase();
    let bare_id = selector
        .split_once('/')
        .map_or(selector.as_str(), |(_, id)| id);
    if !pattern.contains(['*', '?', '[']) {
        return pattern == selector || pattern == bare_id;
    }
    let matcher = match globset::Glob::new(&pattern) {
        Ok(glob) => glob.compile_matcher(),
        Err(_) => return false,
    };
    matcher.is_match(&selector) || matcher.is_match(bare_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELECTOR: &str = "prime-inference/internal/glm-5.3-fast";

    #[test]
    fn exact_and_bare_id_patterns_match_case_insensitively() {
        // Full selector, exact.
        assert!(model_allowed(
            SELECTOR,
            &["prime-inference/internal/glm-5.3-fast".to_string()]
        ));
        // Case folds both sides.
        assert!(model_allowed(
            SELECTOR,
            &["Prime-Inference/Internal/GLM-5.3-Fast".to_string()]
        ));
        // The bare id (prime-inference ids carry slashes) matches without
        // the provider.
        assert!(model_allowed(
            SELECTOR,
            &["internal/glm-5.3-fast".to_string()]
        ));
        assert!(!model_allowed(SELECTOR, &["glm-5.3-fast".to_string()]));
        // A different model does not.
        assert!(!model_allowed(
            SELECTOR,
            &["prime-inference/internal/glm-5.3-turbo".to_string()]
        ));
    }

    #[test]
    fn glob_patterns_match_the_full_selector_or_bare_id() {
        let allow = |pattern: &str| vec![pattern.to_string()];
        assert!(model_allowed(SELECTOR, &allow("prime-inference/*")));
        assert!(model_allowed(
            SELECTOR,
            &allow("prime-inference/internal/*")
        ));
        assert!(model_allowed(SELECTOR, &allow("internal/*")));
        assert!(model_allowed(SELECTOR, &allow("PRIME-INFERENCE/*")));
        // The provider wildcard does not swallow other providers.
        assert!(!model_allowed("zai/glm-5.3", &allow("prime-inference/*")));
        // A question mark is a wildcard, not a plain character.
        assert!(model_allowed("zai/glm-5.3", &allow("zai/glm-5.?")));
        // An empty pattern list allows nothing (the settings getter never
        // produces one, but the matching must stay total).
        assert!(!model_allowed(SELECTOR, &[]));
        // Blank patterns never match.
        assert!(!model_allowed(SELECTOR, &["  ".to_string()]));
        // An invalid glob never matches.
        assert!(!model_allowed(SELECTOR, &allow("[")));
    }

    #[test]
    fn the_refusal_error_carries_the_selector() {
        let refusal = ModelAllowlistRefusal {
            selector: "zai/glm-5.3".to_string(),
        };
        assert_eq!(refusal.selector, "zai/glm-5.3");
        let message = refusal.to_string();
        assert!(
            message.contains("Model \"zai/glm-5.3\" is blocked by the daemon model allowlist"),
            "{message}"
        );
        assert!(message.contains("never falls back"), "{message}");
    }
}

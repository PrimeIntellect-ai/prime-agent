//! Model resolution, scoping, and CLI selection. Port of model-resolver.ts.

use pa_agent::types::ThinkingLevel;
use pa_types::ai::Model;

use super::prime_inference::is_private_prime_inference_model;

pub const PRIME_INFERENCE_DEFAULT_MODEL_ID: &str = "z-ai/glm-5.3";

/// Default model ids per provider (TS `defaultModelPerProvider`).
pub fn default_model_per_provider(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "amazon-bedrock" => "us.anthropic.claude-opus-4-6-v1",
        "anthropic" => "claude-opus-4-7",
        "openai" => "gpt-5.4",
        "azure-openai-responses" => "gpt-5.4",
        "openai-codex" => "gpt-5.5",
        "prime-inference" => PRIME_INFERENCE_DEFAULT_MODEL_ID,
        "deepseek" => "deepseek-v4-pro",
        "google" => "gemini-3.1-pro-preview",
        "google-vertex" => "gemini-3.1-pro-preview",
        "github-copilot" => "gpt-5.4",
        "openrouter" => "moonshotai/kimi-k2.6",
        "vercel-ai-gateway" => "zai/glm-5.1",
        "xai" => "grok-4.20-0309-reasoning",
        "groq" => "openai/gpt-oss-120b",
        "cerebras" => "gpt-oss-120b",
        "zai" => "glm-5.3",
        "mistral" => "devstral-medium-latest",
        "minimax" => "MiniMax-M2.7",
        "minimax-cn" => "MiniMax-M2.7",
        "moonshotai" => "kimi-k2.6",
        "moonshotai-cn" => "kimi-k2.6",
        "huggingface" => "moonshotai/Kimi-K2.6",
        "fireworks" => "accounts/fireworks/models/kimi-k2p6",
        "opencode" => "kimi-k2.6",
        "opencode-go" => "kimi-k2.6",
        "kimi-coding" => "kimi-for-coding",
        "cloudflare-workers-ai" => "@cf/moonshotai/kimi-k2.6",
        "cloudflare-ai-gateway" => "claude-sonnet-4.5",
        "xiaomi" => "mimo-v2.5-pro",
        "xiaomi-token-plan-cn" => "mimo-v2.5-pro",
        "xiaomi-token-plan-ams" => "mimo-v2.5-pro",
        "xiaomi-token-plan-sgp" => "mimo-v2.5-pro",
        _ => return None,
    })
}

/// A resolved model plus an explicit thinking level from the pattern.
#[derive(Debug, Clone)]
pub struct ScopedModel {
    pub model: Model,
    pub thinking_level: Option<ThinkingLevel>,
}

/// True when a model id looks like an alias (no date suffix).
fn is_alias(id: &str) -> bool {
    if id.ends_with("-latest") {
        return true;
    }
    id.len() < 9
        || !id[id.len() - 9..].starts_with('-')
        || id[id.len() - 8..].parse::<u32>().is_err()
}

/// Exact reference match: canonical provider/id, provider/id split, or an
/// unambiguous bare id.
pub fn find_exact_model_reference_match<'a>(
    model_reference: &str,
    available_models: &'a [Model],
) -> Option<&'a Model> {
    let trimmed = model_reference.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.to_lowercase();
    let canonical: Vec<&Model> = available_models
        .iter()
        .filter(|model| format!("{}/{}", model.provider, model.id).to_lowercase() == normalized)
        .collect();
    if canonical.len() == 1 {
        return Some(canonical[0]);
    }
    if canonical.len() > 1 {
        return None;
    }
    if let Some(slash) = trimmed.find('/') {
        let provider = trimmed[..slash].trim();
        let model_id = trimmed[slash + 1..].trim();
        if !provider.is_empty() && !model_id.is_empty() {
            let provider_matches: Vec<&Model> = available_models
                .iter()
                .filter(|model| {
                    model.provider.to_lowercase() == provider.to_lowercase()
                        && model.id.to_lowercase() == model_id.to_lowercase()
                })
                .collect();
            if provider_matches.len() == 1 {
                return Some(provider_matches[0]);
            }
            if provider_matches.len() > 1 {
                return None;
            }
        }
    }
    let id_matches: Vec<&Model> = available_models
        .iter()
        .filter(|model| model.id.to_lowercase() == normalized)
        .collect();
    if id_matches.len() == 1 {
        Some(id_matches[0])
    } else {
        None
    }
}

fn fuzzy_match_model<'a>(pattern: &str, available_models: &'a [Model]) -> Option<&'a Model> {
    let normalized = pattern.to_lowercase();
    let matches: Vec<&Model> = available_models
        .iter()
        .filter(|model| {
            model.id.to_lowercase().contains(&normalized)
                || model.name.to_lowercase().contains(&normalized)
        })
        .collect();
    if matches.is_empty() {
        return None;
    }
    let (aliases, dated): (Vec<&Model>, Vec<&Model>) =
        matches.into_iter().partition(|model| is_alias(&model.id));
    let pool = if !aliases.is_empty() { aliases } else { dated };
    pool.into_iter().max_by(|a, b| a.id.cmp(&b.id))
}

/// Rebuild an unknown id on a provider template (custom/unlisted models).
pub fn build_fallback_model(
    provider: &str,
    model_id: &str,
    available_models: &[Model],
) -> Option<Model> {
    let provider_models: Vec<&Model> = available_models
        .iter()
        .filter(|model| model.provider == provider)
        .collect();
    if provider_models.is_empty() {
        return None;
    }
    // Private ids must inherit a private-route template.
    let template = if is_private_prime_inference_model(&Model {
        id: model_id.to_string(),
        provider: provider.to_string(),
        ..wire_skeleton()
    }) {
        provider_models.iter().copied().find(|model| {
            is_private_prime_inference_model(&Model {
                id: model.id.clone(),
                provider: model.provider.clone(),
                ..wire_skeleton()
            })
        })?
    } else {
        let default_id = default_model_per_provider(provider)?;
        provider_models
            .iter()
            .copied()
            .find(|model| model.id == default_id)
            .unwrap_or(provider_models[0])
    };
    let mut model = template.clone();
    model.id = model_id.to_string();
    model.name = model_id.to_string();
    Some(model)
}

fn wire_skeleton() -> Model {
    serde_json::from_value(serde_json::json!({
        "id": "", "name": "", "api": "openai-completions", "provider": "",
        "baseUrl": "", "reasoning": false, "input": [], "cost": {
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0
        },
        "contextWindow": 0, "maxTokens": 0
    }))
    .expect("skeleton model serializes")
}

/// Preferred default: prime-inference glm-5.3 first, then per-provider defaults.
pub fn find_preferred_default_model(available_models: &[Model]) -> Option<&Model> {
    if let Some(model) = available_models.iter().find(|model| {
        model.provider == "prime-inference" && model.id == PRIME_INFERENCE_DEFAULT_MODEL_ID
    }) {
        return Some(model);
    }
    available_models
        .iter()
        .find(|model| default_model_per_provider(&model.provider).is_some_and(|id| model.id == id))
}

fn is_valid_thinking_level(value: &str) -> bool {
    matches!(
        value,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn parse_thinking_level(value: &str) -> Option<ThinkingLevel> {
    match value {
        "off" => Some(ThinkingLevel::Off),
        "minimal" => Some(ThinkingLevel::Minimal),
        "low" => Some(ThinkingLevel::Low),
        "medium" => Some(ThinkingLevel::Medium),
        "high" => Some(ThinkingLevel::High),
        "xhigh" => Some(ThinkingLevel::Xhigh),
        "max" => Some(ThinkingLevel::Max),
        _ => None,
    }
}

struct ParsedModelResult<'a> {
    model: Option<&'a Model>,
    thinking_level: Option<ThinkingLevel>,
    warning: Option<String>,
}

/// `model:level` parsing; colon-suffixed ids (OpenRouter `:exacto`) fall
/// through when the suffix is not a valid level.
fn parse_model_pattern<'a>(
    pattern: &str,
    available_models: &'a [Model],
    strict: bool,
) -> ParsedModelResult<'a> {
    if let Some(exact) = fuzzy_exact(pattern, available_models) {
        return ParsedModelResult {
            model: Some(exact),
            thinking_level: None,
            warning: None,
        };
    }
    let Some(last_colon) = pattern.rfind(':') else {
        return ParsedModelResult {
            model: None,
            thinking_level: None,
            warning: None,
        };
    };
    let prefix = &pattern[..last_colon];
    let suffix = &pattern[last_colon + 1..];
    if is_valid_thinking_level(suffix) {
        let result = parse_model_pattern(prefix, available_models, strict);
        if result.model.is_some() {
            return ParsedModelResult {
                model: result.model,
                thinking_level: Some(parse_thinking_level(suffix).expect("validated")),
                warning: result.warning,
            };
        }
        return result;
    }
    if strict {
        return ParsedModelResult {
            model: None,
            thinking_level: None,
            warning: None,
        };
    }
    let result = parse_model_pattern(prefix, available_models, strict);
    if result.model.is_some() {
        return ParsedModelResult {
            model: result.model,
            thinking_level: None,
            warning: Some(format!(
                "Invalid thinking level \"{suffix}\" in pattern \"{pattern}\". Using default instead."
            )),
        };
    }
    result
}

/// Exact match first, then fuzzy (`tryMatchModel`).
fn fuzzy_exact<'a>(pattern: &str, available_models: &'a [Model]) -> Option<&'a Model> {
    find_exact_model_reference_match(pattern, available_models)
        .or_else(|| fuzzy_match_model(pattern, available_models))
}

/// Glob match (`?*[]` patterns, case-insensitive) against provider/id and id.
fn glob_matches(pattern: &str, model: &Model) -> bool {
    let full_id = format!("{}/{}", model.provider, model.id);
    let matcher = globset::Glob::new(pattern)
        .ok()
        .and_then(|glob| glob.compile_matcher().into());
    match matcher {
        Some(matcher) => matcher.is_match(&full_id) || matcher.is_match(&model.id),
        None => false,
    }
}

/// Resolve model patterns to scoped models: exact/fuzzy for plain patterns,
/// glob expansion for wildcard patterns; `pattern:level` applies a level.
pub fn resolve_model_scope_from_models(
    patterns: &[String],
    available_models: &[Model],
) -> Vec<ScopedModel> {
    let mut scoped: Vec<ScopedModel> = Vec::new();
    for pattern in patterns {
        if pattern.contains('*') || pattern.contains('?') || pattern.contains('[') {
            let (glob_pattern, thinking_level) = match pattern.rfind(':') {
                Some(idx) if is_valid_thinking_level(&pattern[idx + 1..]) => {
                    (&pattern[..idx], parse_thinking_level(&pattern[idx + 1..]))
                }
                _ => (pattern.as_str(), None),
            };
            let matching: Vec<&Model> = available_models
                .iter()
                .filter(|model| {
                    let case_fold = glob_pattern.to_lowercase();
                    glob_matches(&case_fold, model) || glob_matches(glob_pattern, model)
                })
                .collect();
            if matching.is_empty() {
                eprintln!("Warning: No models match pattern \"{pattern}\"");
                continue;
            }
            for model in matching {
                if !scoped.iter().any(|sm| models_equal(&sm.model, model)) {
                    scoped.push(ScopedModel {
                        model: model.clone(),
                        thinking_level,
                    });
                }
            }
            continue;
        }
        let parsed = parse_model_pattern(pattern, available_models, false);
        if let Some(warning) = &parsed.warning {
            eprintln!("Warning: {warning}");
        }
        let Some(model) = parsed.model else {
            eprintln!("Warning: No models match pattern \"{pattern}\"");
            continue;
        };
        if !scoped.iter().any(|sm| models_equal(&sm.model, model)) {
            scoped.push(ScopedModel {
                model: model.clone(),
                thinking_level: parsed.thinking_level,
            });
        }
    }
    scoped
}

fn models_equal(a: &Model, b: &Model) -> bool {
    a.provider == b.provider && a.id == b.id
}

/// Result of CLI model resolution.
#[derive(Debug, Default)]
pub struct ResolveCliModelResult {
    pub model: Option<Model>,
    pub thinking_level: Option<ThinkingLevel>,
    pub warning: Option<String>,
    pub error: Option<String>,
}

/// Resolve one model from `--provider`/`--model` flags against the full
/// catalog (not just auth-configured models).
pub fn resolve_cli_model(
    cli_provider: Option<&str>,
    cli_model: &str,
    all_models: &[Model],
) -> ResolveCliModelResult {
    let mut result = ResolveCliModelResult::default();
    if all_models.is_empty() {
        result.error = Some(
            "No models available. Check your installation or add models to models.json."
                .to_string(),
        );
        return result;
    }
    let mut provider = None;
    if let Some(cli_provider) = cli_provider {
        let canonical = all_models
            .iter()
            .find(|model| model.provider.to_lowercase() == cli_provider.to_lowercase())
            .map(|model| model.provider.clone());
        match canonical {
            Some(p) => provider = Some(p),
            None => {
                result.error = Some(format!(
                    "Unknown provider \"{cli_provider}\". Use \"prime-agent model list\" to see available providers/models."
                ));
                return result;
            }
        }
    }

    let mut pattern = cli_model.to_string();
    let mut inferred_provider = false;
    if provider.is_none() {
        if let Some(slash) = cli_model.find('/') {
            let maybe_provider = &cli_model[..slash];
            let canonical = all_models
                .iter()
                .find(|model| model.provider.to_lowercase() == maybe_provider.to_lowercase())
                .map(|model| model.provider.clone());
            if let Some(p) = canonical {
                provider = Some(p);
                pattern = cli_model[slash + 1..].to_string();
                inferred_provider = true;
            }
        }
    }

    // Exact matches without provider inference (ids that contain slashes).
    if provider.is_none() {
        let lower = cli_model.to_lowercase();
        let exact = all_models
            .iter()
            .find(|model| {
                model.id.to_lowercase() == lower
                    || format!("{}/{}", model.provider, model.id).to_lowercase() == lower
            })
            .cloned();
        if let Some(model) = exact {
            result.model = Some(model);
            return result;
        }
    }

    if let Some(provider) = &provider {
        if cli_provider.is_some() {
            let prefix = format!("{provider}/");
            if pattern.to_lowercase().starts_with(&prefix.to_lowercase()) {
                pattern = pattern[prefix.len()..].to_string();
            }
        }
    }

    let candidates: Vec<&Model> = match &provider {
        Some(provider) => all_models
            .iter()
            .filter(|model| model.provider == *provider)
            .collect(),
        None => all_models.iter().collect(),
    };
    // Scope to the candidate slice for pattern parsing.
    let candidate_refs: Vec<Model> = candidates.into_iter().cloned().collect();
    let parsed = parse_model_pattern(&pattern, &candidate_refs, true);
    if let Some(model) = parsed.model {
        return ResolveCliModelResult {
            model: Some(model.clone()),
            thinking_level: parsed.thinking_level,
            warning: parsed.warning,
            error: None,
        };
    }

    if inferred_provider {
        let lower = cli_model.to_lowercase();
        let exact = all_models
            .iter()
            .find(|model| {
                model.id.to_lowercase() == lower
                    || format!("{}/{}", model.provider, model.id).to_lowercase() == lower
            })
            .cloned();
        if let Some(model) = exact {
            result.model = Some(model);
            return result;
        }
        let fallback = parse_model_pattern(cli_model, all_models, true);
        if fallback.model.is_some() {
            return ResolveCliModelResult {
                model: fallback.model.cloned(),
                thinking_level: fallback.thinking_level,
                warning: fallback.warning,
                error: None,
            };
        }
    }

    if let Some(provider) = &provider {
        if let Some(fallback_model) = build_fallback_model(provider, &pattern, all_models) {
            let fallback_warning = match parsed.warning {
                Some(warning) => format!(
                    "{warning} Model \"{pattern}\" not found for provider \"{provider}\". Using custom model id."
                ),
                None => format!(
                    "Model \"{pattern}\" not found for provider \"{provider}\". Using custom model id."
                ),
            };
            return ResolveCliModelResult {
                model: Some(fallback_model),
                thinking_level: None,
                warning: Some(fallback_warning),
                error: None,
            };
        }
    }

    let display = match &provider {
        Some(provider) => format!("{provider}/{pattern}"),
        None => cli_model.to_string(),
    };
    result.error = Some(format!(
        "Model \"{display}\" not found. Use \"prime-agent model list\" to see available models."
    ));
    result
}

/// Provider-failover candidates for `current`: the other providers serving
/// the same model id, in catalog order starting after `current`'s provider,
/// one per provider.
///
/// The list is what the provider-failover loop walks when the current
/// provider exhausts its retries; the caller passes the auth-configured
/// catalog (`ModelRegistry::get_available`) so unconfigured providers never
/// surprise the user with a switch. Rotation keeps the chain stable for
/// every starting provider: with catalog order A, B, C the candidates for
/// B are C then A.
pub fn failover_candidates(current: &Model, available: &[Model]) -> Vec<Model> {
    // Same model id, other providers: first catalog entry wins per provider.
    let mut candidates: Vec<&Model> = Vec::new();
    for model in available
        .iter()
        .filter(|model| model.id == current.id && model.provider != current.provider)
    {
        if !candidates
            .iter()
            .any(|candidate| candidate.provider == model.provider)
        {
            candidates.push(model);
        }
    }
    // Rotate so the provider after `current` (by catalog position) leads:
    // with catalog order A, B, C the candidates for B are C then A.
    let current_position = available
        .iter()
        .position(|model| model.provider == current.provider);
    if let Some(position) = current_position {
        candidates.sort_by_key(|candidate| {
            let candidate_position = available
                .iter()
                .position(|model| model.provider == candidate.provider)
                .unwrap_or(usize::MAX);
            if candidate_position > position {
                candidate_position
            } else {
                candidate_position + available.len()
            }
        });
    }
    candidates.into_iter().cloned().collect()
}

/// Inputs to the startup-model lookup (TS `findInitialModel`, composed with
/// the `--models`-scope handling from `prepareSessionOptions`).
#[derive(Clone, Copy)]
pub struct InitialModelOptions<'a> {
    /// Explicit `--provider` flag.
    pub cli_provider: Option<&'a str>,
    /// Explicit `--model` flag (a `provider/model` reference is inferred).
    pub cli_model: Option<&'a str>,
    /// Models resolved from `--models` patterns (against the available
    /// catalog, TS `resolveModelScope`).
    pub scoped_models: &'a [ScopedModel],
    /// A continued/resumed session skips the scoped-model step (TS
    /// `isContinuing`).
    pub is_continuing: bool,
    /// Saved default provider (settings `defaultProvider`).
    pub default_provider: Option<&'a str>,
    /// Saved default model id (settings `defaultModel`).
    pub default_model_id: Option<&'a str>,
    /// The full catalog (custom + built-in, auth not filtered).
    pub all_models: &'a [Model],
    /// The auth-configured catalog (TS `refreshAvailableModels`).
    pub available_models: &'a [Model],
}

/// The startup model, in the TS priority order:
/// 1. CLI flags (`--provider` + `--model`, resolved against the full catalog;
///    an unresolved flagged model resolves to `None`, the caller's error)
/// 2. The `--models` scope: the saved default when it is in scope, else the
///    first scoped model (skipped for a continued session)
/// 3. The saved settings default, rebuilt from the provider template when the
///    saved id is missing from the catalog
/// 4. The featured default (prime-inference glm-5.3, then per-provider ids)
/// 5. The first available model.
pub fn find_initial_model(options: &InitialModelOptions<'_>) -> Option<Model> {
    if let (Some(provider), Some(pattern)) = (options.cli_provider, options.cli_model) {
        let resolved = resolve_cli_model(Some(provider), pattern, options.all_models);
        // A flagged model that cannot resolve fails the whole lookup; the
        // caller surfaces the error (TS exits the process at this point).
        return resolved.model;
    }
    if !options.scoped_models.is_empty() && !options.is_continuing {
        let saved_in_scope = options
            .default_provider
            .zip(options.default_model_id)
            .and_then(|(provider, id)| {
                options
                    .scoped_models
                    .iter()
                    .find(|scoped| scoped.model.provider == provider && scoped.model.id == id)
            });
        return saved_in_scope
            .or_else(|| options.scoped_models.first())
            .map(|scoped| scoped.model.clone());
    }
    if let (Some(provider), Some(id)) = (options.default_provider, options.default_model_id) {
        if let Some(found) = options
            .available_models
            .iter()
            .find(|model| model.provider == provider && model.id == id)
        {
            return Some(found.clone());
        }
        // A saved id missing from this build's snapshot survives on the
        // provider template — except private Prime Inference ids, whose
        // template route is authorized per team.
        if !is_private_prime_inference_reference(provider, id) {
            if let Some(rebuilt) = build_fallback_model(provider, id, options.available_models) {
                return Some(rebuilt);
            }
        }
    }
    find_preferred_default_model(options.available_models)
        .cloned()
        .or_else(|| options.available_models.first().cloned())
}

/// The private-model predicate without a full `Model` value (TS
/// `isPrivatePrimeInferenceModel({ provider, id })`).
fn is_private_prime_inference_reference(provider: &str, model_id: &str) -> bool {
    provider == "prime-inference"
        && super::prime_inference::is_private_prime_inference_model_id(model_id)
}

#[cfg(test)]
mod tests {
    use super::super::prime_inference::private_prime_inference_models;
    use super::*;

    fn model(provider: &str, id: &str, name: &str) -> Model {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "api": "openai-completions", "provider": provider,
            "baseUrl": "", "reasoning": false, "input": [], "cost": {
                "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0
            },
            "contextWindow": 100000, "maxTokens": 8192
        }))
        .unwrap()
    }

    fn catalog() -> Vec<Model> {
        vec![
            model("anthropic", "claude-sonnet-4-5", "Sonnet"),
            model("anthropic", "claude-sonnet-4-5-20250929", "Sonnet dated"),
            model("prime-inference", "z-ai/glm-5.3", "GLM"),
            model("openrouter", "openai/gpt-4o", "GPT-4o"),
        ]
    }

    #[test]
    fn failover_candidates_order_by_catalog_after_current() {
        let mut catalog = catalog();
        catalog.push(model("zai", "z-ai/glm-5.3", "GLM via zai"));
        catalog.push(model("openrouter", "z-ai/glm-5.3", "GLM via openrouter"));
        // The prime-inference entry (provider at catalog position 2)
        // fails over to the providers after it in catalog order
        // (openrouter's provider first appears at position 3, zai at 4).
        let current = model("prime-inference", "z-ai/glm-5.3", "GLM");
        let candidates = failover_candidates(&current, &catalog);
        assert_eq!(
            candidates
                .iter()
                .map(|model| model.provider.as_str())
                .collect::<Vec<_>>(),
            vec!["openrouter", "zai"]
        );
        // A later provider wraps to the front of the catalog.
        let current = model("openrouter", "z-ai/glm-5.3", "GLM");
        let candidates = failover_candidates(&current, &catalog);
        assert_eq!(
            candidates
                .iter()
                .map(|model| model.provider.as_str())
                .collect::<Vec<_>>(),
            vec!["zai", "prime-inference"]
        );
        // No other provider serves the model: no candidates, no failover.
        let current = model("anthropic", "claude-sonnet-4-5", "Sonnet");
        assert!(failover_candidates(&current, &catalog).is_empty());
        // The current provider itself is never a candidate, even when the
        // catalog carries a second entry for it.
        let current = model("zai", "z-ai/glm-5.3", "GLM");
        let candidates = failover_candidates(&current, &catalog);
        assert!(candidates.iter().all(|model| model.provider != "zai"));
    }

    #[test]
    fn exact_and_fuzzy_matching() {
        let catalog = catalog();
        let exact = find_exact_model_reference_match("anthropic/claude-sonnet-4-5", &catalog);
        assert_eq!(exact.map(|m| m.id.as_str()), Some("claude-sonnet-4-5"));
        // Bare id matches uniquely.
        assert_eq!(
            fuzzy_exact("claude-sonnet", &catalog).map(|m| m.id.as_str()),
            Some("claude-sonnet-4-5")
        );
        // Aliases beat dated versions in fuzzy matching.
        let fuzzy = fuzzy_match_model("claude-sonnet", &catalog);
        assert_eq!(fuzzy.map(|m| m.id.as_str()), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn scoped_patterns_and_thinking_levels() {
        let catalog = catalog();
        let patterns = vec!["claude-sonnet".to_string(), "z-ai/glm-5.3:high".to_string()];
        let scoped = resolve_model_scope_from_models(&patterns, &catalog);
        assert_eq!(scoped.len(), 2);
        assert_eq!(scoped[0].model.id, "claude-sonnet-4-5");
        assert!(scoped[0].thinking_level.is_none());
        assert_eq!(scoped[1].thinking_level, Some(ThinkingLevel::High));
    }

    #[test]
    fn cli_provider_model_resolution() {
        let catalog = catalog();
        let resolved = resolve_cli_model(Some("anthropic"), "claude-sonnet-4-5", &catalog);
        assert!(resolved.error.is_none());
        assert_eq!(
            resolved.model.as_ref().map(|m| m.id.as_str()),
            Some("claude-sonnet-4-5")
        );

        let inferred = resolve_cli_model(None, "anthropic/claude-sonnet-4-5", &catalog);
        assert!(inferred.error.is_none());
        assert_eq!(
            inferred.model.as_ref().map(|m| m.provider.as_str()),
            Some("anthropic")
        );

        let unknown = resolve_cli_model(Some("nope"), "x", &catalog);
        assert!(unknown.error.unwrap().contains("Unknown provider"));

        let missing = resolve_cli_model(Some("anthropic"), "missing-model", &catalog);
        // Falls back to the provider template with a warning.
        assert_eq!(
            missing.model.as_ref().map(|m| m.id.as_str()),
            Some("missing-model")
        );
        assert!(missing.warning.unwrap().contains("Using custom model id"));
    }

    #[test]
    fn openrouter_slash_ids_resolve_without_provider_inference() {
        let catalog = catalog();
        let resolved = resolve_cli_model(None, "openai/gpt-4o", &catalog);
        assert!(resolved.error.is_none());
        assert_eq!(
            resolved.model.as_ref().map(|m| m.provider.as_str()),
            Some("openrouter")
        );
    }

    #[test]
    fn fallback_model_prefers_private_template_for_private_ids() {
        let mut catalog = catalog();
        catalog.extend(private_prime_inference_models());
        let fallback = build_fallback_model("prime-inference", "internal/glm-5.9-turbo", &catalog);
        let fallback = fallback.expect("private template exists");
        assert_eq!(fallback.id, "internal/glm-5.9-turbo");
        // Inherited the private template's compat (max_tokens field).
        assert!(fallback.compat.is_some());
    }

    #[test]
    fn initial_model_prefers_cli_flags() {
        let catalog = catalog();
        let options = InitialModelOptions {
            cli_provider: Some("anthropic"),
            cli_model: Some("claude-sonnet-4-5"),
            scoped_models: &[],
            is_continuing: false,
            default_provider: Some("openrouter"),
            default_model_id: Some("openai/gpt-4o"),
            all_models: &catalog,
            available_models: &catalog,
        };
        let model = find_initial_model(&options).expect("flagged model resolves");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.id, "claude-sonnet-4-5");
    }

    #[test]
    fn initial_model_saved_default_wins_over_featured_default() {
        let catalog = catalog();
        let options = InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &[],
            is_continuing: false,
            default_provider: Some("anthropic"),
            default_model_id: Some("claude-sonnet-4-5"),
            all_models: &catalog,
            available_models: &catalog,
        };
        let model = find_initial_model(&options).expect("saved default resolves");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.id, "claude-sonnet-4-5");
    }

    #[test]
    fn initial_model_rebuilds_missing_saved_id_on_template() {
        let catalog = catalog();
        let options = InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &[],
            is_continuing: false,
            default_provider: Some("anthropic"),
            default_model_id: Some("claude-future-model"),
            all_models: &catalog,
            available_models: &catalog,
        };
        let model = find_initial_model(&options).expect("template rebuild resolves");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.id, "claude-future-model");
    }

    #[test]
    fn initial_model_falls_back_to_featured_then_first_available() {
        let catalog = catalog();
        // The featured default (prime-inference glm-5.3) wins when present.
        let options = InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &[],
            is_continuing: false,
            default_provider: None,
            default_model_id: None,
            all_models: &catalog,
            available_models: &catalog,
        };
        let model = find_initial_model(&options).expect("featured default resolves");
        assert_eq!(model.provider, "prime-inference");
        assert_eq!(model.id, "z-ai/glm-5.3");
        // Without it, the first available model takes over.
        let available: Vec<Model> = catalog
            .iter()
            .filter(|model| model.provider == "anthropic")
            .cloned()
            .collect();
        let fallback = InitialModelOptions {
            available_models: &available,
            ..options
        };
        let model = find_initial_model(&fallback).expect("first available resolves");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.id, "claude-sonnet-4-5");
        // An empty available catalog resolves to nothing.
        let empty = InitialModelOptions {
            available_models: &[],
            ..options
        };
        assert_eq!(find_initial_model(&empty), None);
    }

    #[test]
    fn initial_model_scope_prefers_saved_default_in_scope() {
        let catalog = catalog();
        let scoped = resolve_model_scope_from_models(
            &["claude-sonnet".to_string(), "glm".to_string()],
            &catalog,
        );
        let options = InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &scoped,
            is_continuing: false,
            default_provider: Some("prime-inference"),
            default_model_id: Some("z-ai/glm-5.3"),
            all_models: &catalog,
            available_models: &catalog,
        };
        let model = find_initial_model(&options).expect("scoped model resolves");
        assert_eq!(model.provider, "prime-inference");
        // The saved default is in scope and wins over scoped order.
        assert_eq!(model.id, "z-ai/glm-5.3");
        // A continued session skips the scope entirely.
        let continued = InitialModelOptions {
            is_continuing: true,
            ..options
        };
        let model = find_initial_model(&continued).expect("saved default resolves");
        assert_eq!(model.provider, "prime-inference");
        assert_eq!(model.id, "z-ai/glm-5.3");
    }
}

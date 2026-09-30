//! Pure normalization/search helpers of the RLM surface — the host side of
//! `rlm.spawn` / `rlm.find_models` kwargs validation.
//!
//! Ported from `core/rlm-runtime.ts`. The handler adapters that bind these to
//! the agent session (`createRlmRunHostHandler` and friends) live with the
//! session wiring; this module holds the behavior they share.

use serde_json::Value;

/// Thinking levels the RLM surface accepts, matching the TS `THINKING_LEVELS`
/// (`core/thinking-levels.ts`); the values live in `pa-types`.
pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH: usize = 64;
pub const DEFAULT_RLM_MODEL_SEARCH_LIMIT: usize = 8;
pub const MAX_RLM_MODEL_SEARCH_LIMIT: usize = 20;
const RLM_MODEL_ERROR_SUGGESTION_LIMIT: usize = 3;

/// One catalog model the search/match helpers work over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RlmModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
}

impl RlmModelInfo {
    #[must_use]
    pub fn selector(&self) -> String {
        format!("{}/{}", self.provider, self.id)
    }
}

/// One search match returned to the kernel.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RlmModelMatch {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub selector: String,
}

fn error(operation: &str, message: &str) -> anyhow::Error {
    anyhow::anyhow!("{operation} {message}")
}

/// Validate the requested subagent session name. `None` when absent.
///
/// # Errors
///
/// Returns an error, prefixed with `operation`, when the name is empty after
/// trimming or longer than the subagent name length limit.
pub fn normalize_requested_rlm_subagent_session_name(
    value: Option<&str>,
    operation: &str,
) -> anyhow::Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let name = value.trim();
    if name.is_empty() {
        return Err(error(operation, "name must not be empty"));
    }
    if name.chars().count() > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH {
        return Err(error(
            operation,
            &format!("name must be at most {RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters"),
        ));
    }
    Ok(Some(name.to_string()))
}

/// Validate the requested thinking level. `None` when absent.
///
/// # Errors
///
/// Returns an error, prefixed with `operation`, when the level is not one of
/// the supported thinking levels.
pub fn normalize_requested_rlm_subagent_thinking_level(
    value: Option<&str>,
    operation: &str,
) -> anyhow::Result<Option<&'static str>> {
    let Some(value) = value else { return Ok(None) };
    let level = value.trim().to_lowercase();
    let Some(matched) = THINKING_LEVELS
        .iter()
        .find(|candidate| **candidate == level)
    else {
        return Err(error(
            operation,
            &format!("thinking must be one of: {}", THINKING_LEVELS.join(", ")),
        ));
    };
    Ok(Some(matched))
}

/// Spawn placement targets `rlm.spawn` accepts for its `target` kwarg
/// (the admission gate that refuses cloud until its backend exists lives
/// in `session_engine::rlm_host`).
pub const RLM_SPAWN_TARGETS: [&str; 2] = ["local", "cloud"];

/// Typed spawn placement: where an admitted `rlm.spawn` child session runs.
///
/// Design note — the `target` placement contract (the cloud admission and
/// messaging parity the future cloud backend must uphold):
///
/// * Omission is local and byte-identical. The kernel forwards `target`
///   only when the caller passed one, so an omitted target reaches this
///   module as `None` and resolves to [`RlmSpawnTarget::Local`]: the same
///   wire payload, the same request, the same local spawn as before the
///   contract existed. The prompt layers do not advertise `target` until
///   the cloud backend ships, keeping the cache-stable prompt prefix
///   byte-identical across this contract slice.
/// * Cloud fails explicitly, never falls back. Admission (the
///   `rlm.run` handler in `session_engine::rlm_host`) refuses
///   [`RlmSpawnTarget::Cloud`] before any `RlmSubagentHost` is consulted,
///   so no host implementation can silently run a cloud child locally.
///   The error names the missing backend and the local alternative.
/// * Cloud admission parity. The backend must admit into the exact
///   `RLMSpawnHandle` wire shape (`rlm_child_id`/`name`/`session_dir`/
///   `model` — `session_dir` stays the child's agent-visible session
///   directory, through whatever interpretation the backend documents),
///   enforce sibling name uniqueness with the same reservation
///   semantics, count the child against the recursion depth limit, and
///   surface it through `rlm.list_subagents`/`rlm.collect`/
///   `rlm.delete_subagent` with the shared status vocabulary — a cloud
///   child is a full family member, indistinguishable at those surfaces.
/// * Cloud messaging parity. A cloud child must support bidirectional
///   `agent_message` — parent-to-child (`receiver_role: "child"`) and
///   child-to-parent (`receiver_role: "parent"`) — with the shared
///   `delivered`/`queued` receipt vocabulary. Offline parent delivery is
///   part of the contract: a cloud child's replies and progress notes
///   sent while the parent is disconnected queue durably and deliver
///   when the parent is reachable again, exactly like a local
///   non-resident family member; nothing is silently dropped.
/// * Telemetry. Nothing user-visible succeeds in this slice (the kwarg
///   is not prompt-advertised and the refusal never reaches the daemon
///   worker that owns telemetry clients), so no adoption event lands
///   here; the backend PR ships the event with the surface it makes
///   visible.
///
/// TS-parity note: the TS surface rejects `target` as an unsupported
/// `rlm.spawn` kwarg. Accepting and typing it is a deliberate Rust-side
/// divergence owned by this contract; omitted-target behavior stays
/// TS-identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RlmSpawnTarget {
    /// The daemon's local worker tree (the only placement today).
    #[default]
    Local,
    /// The cloud child backend (contract only — no backend exists yet, so
    /// admission refuses it explicitly instead of running locally).
    Cloud,
}

/// Validate the requested spawn placement. `None` when absent (local).
///
/// # Errors
///
/// Returns an error, prefixed with `operation`, when the target is not one
/// of the supported placement targets.
pub fn normalize_requested_rlm_spawn_target(
    value: Option<&str>,
    operation: &str,
) -> anyhow::Result<Option<RlmSpawnTarget>> {
    let Some(value) = value else { return Ok(None) };
    let target = value.trim().to_lowercase();
    let matched = match target.as_str() {
        "local" => RlmSpawnTarget::Local,
        "cloud" => RlmSpawnTarget::Cloud,
        _ => {
            return Err(error(
                operation,
                &format!("target must be one of: {}", RLM_SPAWN_TARGETS.join(", ")),
            ));
        }
    };
    Ok(Some(matched))
}

/// Validate the requested model override. `None` when absent.
///
/// # Errors
///
/// Returns an error, prefixed with `operation`, when the model override is
/// empty after trimming.
pub fn normalize_requested_rlm_subagent_model(
    value: Option<&str>,
    operation: &str,
) -> anyhow::Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let model = value.trim();
    if model.is_empty() {
        return Err(error(operation, "model must not be empty"));
    }
    Ok(Some(model.to_string()))
}

/// A readable, collision-resistant default name usable as an
/// agent-message selector, matching the TS product.
pub fn create_default_rlm_subagent_session_name(prompt: &str, child_id: &str) -> String {
    let prompt_slug = slugify(prompt);
    let id_suffix: String = child_id
        .strip_prefix("sub-")
        .unwrap_or(child_id)
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let id_suffix = if id_suffix.len() >= 8 {
        id_suffix[id_suffix.len() - 8..].to_string()
    } else if id_suffix.is_empty() {
        "child".to_string()
    } else {
        id_suffix
    };
    let fixed_length = "subagent--".len() + id_suffix.len();
    let budget = RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH
        .saturating_sub(fixed_length)
        .max(1);
    let mut prompt_part: String = if prompt_slug.is_empty() {
        "worker".to_string()
    } else {
        prompt_slug.chars().take(budget).collect()
    };
    while prompt_part.ends_with('-') {
        prompt_part.pop();
    }
    if prompt_part.is_empty() {
        prompt_part = "worker".to_string();
    }
    format!("subagent-{prompt_part}-{id_suffix}")
}

/// NFKD-equivalent slug for the practical character space: Latin letters
/// decompose to their base ASCII letter (dropping diacritics), everything
/// else collapses into the separator.
fn slugify(prompt: &str) -> String {
    let mut slug = String::with_capacity(prompt.len());
    let mut last_dash = false;
    for ch in prompt.chars() {
        // ASCII passes through (alphanumerics kept, rest collapse to `-`);
        // accented Latin decomposes to its base letter (NFKD strip of marks);
        // everything else is non-[a-z0-9] for the slug, so it collapses too.
        let mapped = if ch.is_ascii() {
            Some(ch)
        } else {
            latin_base(ch)
        };
        for ch in mapped.into_iter().chain(std::iter::empty::<char>()) {
            if ch.is_ascii_alphanumeric() {
                slug.push(ch.to_ascii_lowercase());
                last_dash = false;
            } else if !last_dash {
                slug.push('-');
                last_dash = true;
            }
        }
    }
    let trimmed = slug.trim_matches('-');
    let mut out = String::with_capacity(trimmed.len());
    out.push_str(trimmed);
    out
}

fn latin_base(ch: char) -> Option<char> {
    // to_lowercase() handles non-ASCII uppercase accents; to_ascii_lowercase
    // leaves them untouched.
    let lowercase = ch.to_lowercase().next().unwrap_or(ch);
    let base = match lowercase {
        '\u{00E0}'..='\u{00E5}' | '\u{0101}' | '\u{0103}' | '\u{0105}' | '\u{00E6}' => 'a', // NFKD splits ligatures; single letter suffices
        '\u{00E7}' | '\u{0107}' | '\u{0109}' | '\u{010B}' | '\u{010D}' => 'c',
        '\u{00E8}'..='\u{00EB}'
        | '\u{0113}'
        | '\u{0115}'
        | '\u{0117}'
        | '\u{0119}'
        | '\u{011B}' => 'e',
        '\u{00EC}'..='\u{00EF}'
        | '\u{0129}'
        | '\u{012B}'
        | '\u{012D}'
        | '\u{012F}'
        | '\u{0131}' => 'i',
        '\u{00F1}' | '\u{0144}' | '\u{0146}' | '\u{0148}' => 'n',
        '\u{00F2}'..='\u{00F6}' | '\u{00F8}' | '\u{014D}' | '\u{014F}' | '\u{0151}' => 'o',
        '\u{015B}' | '\u{015D}' | '\u{015F}' | '\u{0161}' => 's',
        '\u{00F9}'..='\u{00FC}'
        | '\u{0169}'
        | '\u{016B}'
        | '\u{016D}'
        | '\u{016F}'
        | '\u{0171}'
        | '\u{0173}' => 'u',
        '\u{00FD}' | '\u{00FF}' | '\u{0177}' => 'y',
        '\u{017A}' | '\u{017C}' | '\u{017E}' => 'z',
        '\u{00F0}' => 'd',
        '\u{013E}' => 'l',
        '\u{0155}' | '\u{0157}' | '\u{0159}' => 'r',
        '\u{0165}' | '\u{0167}' => 't',
        _ => return None,
    };
    Some(base)
}

fn normalize_model_search_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

/// Rank and cap model matches the same way `findRlmModelMatches` does:
/// exact match, then prefix, then substring, then alphabetical order.
///
/// # Panics
///
/// Candidates are sorted by score with a `partial_cmp().unwrap()`; every
/// score is finite by construction, so the unwrap cannot fail.
#[must_use]
pub fn find_rlm_model_matches(
    query: &str,
    models: &[RlmModelInfo],
    limit: usize,
) -> Vec<RlmModelMatch> {
    let normalized_query = normalize_model_search_text(query.trim());
    let mut candidates: Vec<(RlmModelMatch, f64)> = Vec::new();
    for model in models {
        let selector = model.selector();
        let name = if model.name.is_empty() {
            model.id.clone()
        } else {
            model.name.clone()
        };
        let fields = [selector.clone(), model.id.clone(), name.clone()];
        let normalized_fields: Vec<String> = fields
            .iter()
            .map(|f| normalize_model_search_text(f))
            .collect();
        let mut score = if normalized_query.is_empty() {
            0.0
        } else {
            f64::INFINITY
        };
        if !normalized_query.is_empty() {
            if let Some(exact) = normalized_fields
                .iter()
                .position(|f| f == &normalized_query)
            {
                score = exact as f64;
            } else if let Some(prefix) = normalized_fields
                .iter()
                .position(|f| f.starts_with(&normalized_query))
            {
                score = 3.0 + prefix as f64;
            } else if let Some(partial) = normalized_fields
                .iter()
                .position(|f| f.contains(&normalized_query))
            {
                score = 6.0 + partial as f64;
            }
        }
        if score.is_finite() {
            candidates.push((
                RlmModelMatch {
                    provider: model.provider.clone(),
                    id: model.id.clone(),
                    name,
                    selector,
                },
                score,
            ));
        }
    }
    candidates.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap()
            .then_with(|| a.0.selector.cmp(&b.0.selector))
    });
    candidates.into_iter().take(limit).map(|(m, _)| m).collect()
}

/// Models whose full selector ends with the reference, so a bare id like
/// "z-ai/glm-5.3" also matches "prime-inference/z-ai/glm-5.3".
fn find_rlm_short_form_model_matches<'a>(
    reference: &str,
    models: &'a [RlmModelInfo],
) -> Vec<&'a RlmModelInfo> {
    let normalized = reference.trim().to_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }
    models
        .iter()
        .filter(|model| {
            format!("{}/{}", model.provider, model.id)
                .to_lowercase()
                .ends_with(&format!("/{normalized}"))
        })
        .collect()
}

/// The single model a short-form reference resolves to: its unique match, or
/// the fallback when nothing matches. `None` when several match or nothing
/// resolves, so an ambiguous reference is never auto-resolved.
#[must_use]
pub fn find_unique_rlm_short_form_model_match<'a>(
    reference: &str,
    models: &'a [RlmModelInfo],
    fallback: Option<&'a RlmModelInfo>,
) -> Option<&'a RlmModelInfo> {
    let matches = find_rlm_short_form_model_matches(reference, models);
    if matches.len() == 1 {
        return Some(matches[0]);
    }
    if matches.is_empty() {
        if let Some(fallback) = fallback {
            if find_rlm_short_form_model_matches(reference, std::slice::from_ref(fallback)).len()
                == 1
            {
                return Some(fallback);
            }
        }
    }
    None
}

/// Rejection message for an unresolved model reference, with the expected
/// selector form and close matches.
#[must_use]
pub fn format_rlm_model_unavailable_error(
    reference: &str,
    target: &str,
    models: &[RlmModelInfo],
) -> String {
    let base = format!(
        "Requested {target} model \"{reference}\" is unavailable, unauthenticated, or expired"
    );
    let hint =
        "selectors use the form \"provider/model-id\" (e.g. \"prime-inference/z-ai/glm-5.3\")";
    let normalized_reference = normalize_model_search_text(reference);
    let close_matches: Vec<String> = if normalized_reference.is_empty() {
        Vec::new()
    } else {
        find_rlm_model_matches(reference, models, RLM_MODEL_ERROR_SUGGESTION_LIMIT)
            .into_iter()
            .map(|m| m.selector)
            .collect()
    };
    if close_matches.is_empty() {
        return format!("{base}; {hint}");
    }
    let quoted: Vec<String> = close_matches.iter().map(|s| format!("\"{s}\"")).collect();
    format!("{base}; {hint}; close matches: {}", quoted.join(", "))
}

/// Parse the `kwargs` object of a kernel host request. Missing -> empty.
pub fn kwargs_from_payload(payload: &Value) -> serde_json::Map<String, Value> {
    payload
        .get("kwargs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_spawn_target() {
        assert_eq!(
            normalize_requested_rlm_spawn_target(None, "rlm.spawn").unwrap(),
            None
        );
        assert_eq!(
            normalize_requested_rlm_spawn_target(Some("local"), "rlm.spawn").unwrap(),
            Some(RlmSpawnTarget::Local)
        );
        // Case and surrounding whitespace normalize like thinking levels.
        assert_eq!(
            normalize_requested_rlm_spawn_target(Some(" Cloud "), "rlm.spawn").unwrap(),
            Some(RlmSpawnTarget::Cloud)
        );
        assert!(
            normalize_requested_rlm_spawn_target(Some("edge"), "rlm.spawn").is_err(),
            "an unknown target is rejected instead of defaulting to local"
        );
        assert_eq!(
            normalize_requested_rlm_spawn_target(Some("edge"), "rlm.spawn")
                .unwrap_err()
                .to_string(),
            "rlm.spawn target must be one of: local, cloud"
        );
    }

    #[test]
    fn normalizes_session_name() {
        assert_eq!(
            normalize_requested_rlm_subagent_session_name(Some("  worker "), "rlm.spawn").unwrap(),
            Some("worker".to_string())
        );
        assert_eq!(
            normalize_requested_rlm_subagent_session_name(None, "rlm.spawn").unwrap(),
            None
        );
        assert!(normalize_requested_rlm_subagent_session_name(Some("   "), "rlm.spawn").is_err());
        let long = "x".repeat(65);
        assert!(normalize_requested_rlm_subagent_session_name(Some(&long), "rlm.spawn").is_err());
    }

    #[test]
    fn normalizes_thinking_and_model() {
        assert_eq!(
            normalize_requested_rlm_subagent_thinking_level(Some("Medium"), "rlm.spawn").unwrap(),
            Some("medium")
        );
        assert!(
            normalize_requested_rlm_subagent_thinking_level(Some("nope"), "rlm.spawn").is_err()
        );
        assert!(normalize_requested_rlm_subagent_model(Some("  "), "rlm.spawn").is_err());
        assert_eq!(
            normalize_requested_rlm_subagent_model(Some(" z-ai/glm-5.3 "), "rlm.spawn").unwrap(),
            Some("z-ai/glm-5.3".to_string())
        );
    }

    #[test]
    fn default_session_name_shape() {
        let name =
            create_default_rlm_subagent_session_name("Fix the API!!  Now", "sub-1234567890abcdef");
        assert!(name.starts_with("subagent-fix-the-api-now-"));
        assert!(name.ends_with("cdef"));
        assert!(name.chars().count() <= 64);
    }

    #[test]
    fn model_matches_ranked_and_capped() {
        let models = vec![
            RlmModelInfo {
                provider: "a".into(),
                id: "glm-5.3".into(),
                name: "GLM 5.3".into(),
            },
            RlmModelInfo {
                provider: "pi".into(),
                id: "glm-5.3-turbo".into(),
                name: "GLM".into(),
            },
        ];
        let matches = find_rlm_model_matches("glm-5.3", &models, 8);
        assert_eq!(matches.len(), 2);
        assert_eq!(
            matches[0].selector, "a/glm-5.3",
            "exact selector match ranks first"
        );
        let matches = find_rlm_model_matches("", &models, 1);
        assert_eq!(matches.len(), 1, "empty query lists up to the limit");
    }

    #[test]
    fn short_form_resolution_and_error_text() {
        let models = vec![
            RlmModelInfo {
                provider: "prime-inference".into(),
                id: "z-ai/glm-5.3".into(),
                name: "GLM".into(),
            },
            RlmModelInfo {
                provider: "a".into(),
                id: "glm-5.3".into(),
                name: "GLM".into(),
            },
        ];
        assert!(find_unique_rlm_short_form_model_match("glm-5.3", &models, None).is_none());
        let one = vec![models[0].clone()];
        let resolved = find_unique_rlm_short_form_model_match("glm-5.3", &one, None)
            .map(super::RlmModelInfo::selector);
        assert_eq!(resolved.as_deref(), Some("prime-inference/z-ai/glm-5.3"));
        let message = format_rlm_model_unavailable_error("glm-5.3", "spawn", &models);
        assert!(message.contains("close matches"));
    }
}

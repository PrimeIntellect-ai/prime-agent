//! Thinking-level semantics over the shared [`Model`] type: which levels a
//! model supports, how a requested level clamps, and the level's wire
//! vocabulary. These helpers are pure functions over `pa-types` data, so they
//! live with the type they interpret — every crate that holds a `Model`
//! (client pickers, daemon registries, providers) needs them without a
//! dependency on `pa-ai`.

use crate::ai::{Model, ModelThinkingLevel};

/// The full thinking-level ladder, weakest to strongest
/// (`EXTENDED_THINKING_LEVELS` in the TS reference).
pub const EXTENDED_THINKING_LEVELS: [ModelThinkingLevel; 7] = [
    ModelThinkingLevel::Off,
    ModelThinkingLevel::Minimal,
    ModelThinkingLevel::Low,
    ModelThinkingLevel::Medium,
    ModelThinkingLevel::High,
    ModelThinkingLevel::Xhigh,
    ModelThinkingLevel::Max,
];

pub const SUPPORTED_THINKING_LEVELS: [ModelThinkingLevel; 7] = EXTENDED_THINKING_LEVELS;

/// Ordinal position of a level within [`EXTENDED_THINKING_LEVELS`].
///
/// # Panics
///
/// Panics if `level` is not one of the variants listed in
/// [`EXTENDED_THINKING_LEVELS`].
pub fn thinking_level_index(level: ModelThinkingLevel) -> usize {
    EXTENDED_THINKING_LEVELS
        .iter()
        .position(|candidate| *candidate == level)
        .expect("thinking level is always in EXTENDED_THINKING_LEVELS")
}

/// Whether the model has a thinking surface at all (the TS session's
/// `supportsThinking`): the coarse `reasoning` flag, or a thinking-level
/// map that maps at least one level to a wire value. A route that
/// declares addressable thinking levels is thinking-capable even when the
/// flag is false (the live catalog ships `gpt-5.3-chat-latest` as
/// `reasoning: false` with an addressable `xhigh`); an all-null map is the
/// "keep reasoning output, send no unverified controls" encoding, not a
/// capability claim of its own.
pub fn supports_thinking(model: &Model) -> bool {
    model.reasoning
        || model
            .thinking_level_map
            .as_ref()
            .is_some_and(|map| map.values().any(Option::is_some))
}

/// Thinking levels the model supports: "off" only for a model without a
/// thinking surface; otherwise every level that is not explicitly mapped to
/// null. `xhigh`/`max` additionally require an explicit mapping.
pub fn get_supported_thinking_levels(model: &Model) -> Vec<ModelThinkingLevel> {
    if !supports_thinking(model) {
        return vec![ModelThinkingLevel::Off];
    }
    EXTENDED_THINKING_LEVELS
        .iter()
        .copied()
        .filter(|level| {
            let mapped = model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get(level));
            match mapped {
                None => !matches!(level, ModelThinkingLevel::Xhigh | ModelThinkingLevel::Max),
                Some(None) => false,
                Some(Some(_)) => true,
            }
        })
        .collect()
}

/// Clamp a requested thinking level to what the model supports, preferring the
/// nearest higher level then the nearest lower one.
pub fn clamp_thinking_level(model: &Model, level: ModelThinkingLevel) -> ModelThinkingLevel {
    let available = get_supported_thinking_levels(model);
    if available.contains(&level) {
        return level;
    }
    let requested_index = thinking_level_index(level);
    for candidate in EXTENDED_THINKING_LEVELS.iter().skip(requested_index) {
        if available.contains(candidate) {
            return *candidate;
        }
    }
    for candidate in EXTENDED_THINKING_LEVELS[..requested_index].iter().rev() {
        if available.contains(candidate) {
            return *candidate;
        }
    }
    available
        .first()
        .copied()
        .unwrap_or(ModelThinkingLevel::Off)
}

/// Identity compare (`modelsAreEqual`): provider plus id.
pub fn models_are_equal(a: Option<&Model>, b: Option<&Model>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.id == b.id && a.provider == b.provider,
        _ => false,
    }
}

/// Parse a thinking level from its wire name ("off", "minimal", ...).
pub fn thinking_level_from_str(name: &str) -> Option<ModelThinkingLevel> {
    EXTENDED_THINKING_LEVELS
        .iter()
        .find(|level| level.wire_name() == name)
        .copied()
}

/// Build a thinking level map from pairs (helper for tests and catalogs).
pub fn thinking_level_map(
    pairs: &[(ModelThinkingLevel, Option<&str>)],
) -> std::collections::BTreeMap<ModelThinkingLevel, Option<String>> {
    pairs
        .iter()
        .map(|(key, value)| (*key, value.map(ToString::to_string)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{ModelCost, ModelInput, ThinkingLevelMap};
    use crate::JsNumber;

    fn model(reasoning: bool, map: Option<ThinkingLevelMap>) -> Model {
        Model {
            id: "m".into(),
            name: "m".into(),
            api: "openai-completions".into(),
            provider: "test".into(),
            base_url: "http://localhost".into(),
            reasoning,
            thinking_level_map: map,
            input: vec![ModelInput::Text],
            cost: ModelCost {
                input: JsNumber::from(0.0),
                output: JsNumber::from(0.0),
                cache_read: JsNumber::from(0.0),
                cache_write: JsNumber::from(0.0),
            },
            context_window: 128_000,
            max_tokens: 8_192,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn clamps_thinking_levels() {
        // off: null means disabled; xhigh/max require explicit mapping.
        let map = thinking_level_map(&[
            (ModelThinkingLevel::Off, Some("none")),
            (ModelThinkingLevel::Low, Some("low")),
            (ModelThinkingLevel::Medium, None),
            (ModelThinkingLevel::High, Some("high")),
        ]);
        let m = model(true, Some(map));
        assert_eq!(
            clamp_thinking_level(&m, ModelThinkingLevel::Off),
            ModelThinkingLevel::Off
        );
        // TS ground truth (verified against packages/ai/src/models.ts): minimal is
        // always supported on reasoning models; medium maps to null (unsupported)
        // so it clamps up to high; xhigh requires an explicit mapping and clamps down
        // to high via the nearest-higher-then-lower rule.
        assert_eq!(
            clamp_thinking_level(&m, ModelThinkingLevel::Minimal),
            ModelThinkingLevel::Minimal
        );
        assert_eq!(
            clamp_thinking_level(&m, ModelThinkingLevel::Medium),
            ModelThinkingLevel::High
        );
        assert_eq!(
            clamp_thinking_level(&m, ModelThinkingLevel::Xhigh),
            ModelThinkingLevel::High
        );
    }

    #[test]
    fn non_reasoning_models_only_support_off() {
        let m = model(false, None);
        assert_eq!(
            get_supported_thinking_levels(&m),
            vec![ModelThinkingLevel::Off]
        );
        assert_eq!(
            clamp_thinking_level(&m, ModelThinkingLevel::High),
            ModelThinkingLevel::Off
        );
    }

    #[test]
    fn an_addressable_map_enables_thinking_without_the_reasoning_flag() {
        // The live catalog's `gpt-5.3-chat-latest` shape: `reasoning: false`
        // with `off` nulled and `xhigh` addressable — the map is the
        // stronger capability signal, so the levels answer from it.
        let map = thinking_level_map(&[
            (ModelThinkingLevel::Off, None),
            (ModelThinkingLevel::Xhigh, Some("xhigh")),
        ]);
        let m = model(false, Some(map));
        assert_eq!(
            get_supported_thinking_levels(&m),
            vec![
                ModelThinkingLevel::Minimal,
                ModelThinkingLevel::Low,
                ModelThinkingLevel::Medium,
                ModelThinkingLevel::High,
                ModelThinkingLevel::Xhigh,
            ]
        );
        assert_eq!(
            clamp_thinking_level(&m, ModelThinkingLevel::Max),
            ModelThinkingLevel::Xhigh
        );
    }

    #[test]
    fn an_all_null_map_keeps_the_non_thinking_collapse() {
        // The xAI subscription's unverified-control encoding: an all-null
        // map claims no addressable level, so a non-reasoning model stays
        // "off"-only (and a reasoning model's map filter is unchanged —
        // it never claimed an addressable level either).
        let all_null = thinking_level_map(&[
            (ModelThinkingLevel::Off, None),
            (ModelThinkingLevel::Minimal, None),
            (ModelThinkingLevel::Low, None),
            (ModelThinkingLevel::Medium, None),
            (ModelThinkingLevel::High, None),
            (ModelThinkingLevel::Xhigh, None),
            (ModelThinkingLevel::Max, None),
        ]);
        assert_eq!(
            get_supported_thinking_levels(&model(false, Some(all_null.clone()))),
            vec![ModelThinkingLevel::Off]
        );
        assert!(!supports_thinking(&model(false, Some(all_null))));
        assert!(get_supported_thinking_levels(&model(true, Some(all_null))).is_empty());
    }

    #[test]
    fn supports_thinking_reads_the_flag_and_the_map() {
        assert!(supports_thinking(&model(true, None)));
        assert!(!supports_thinking(&model(false, None)));
        // A map that only disables (`off` → "none") still addresses a
        // thinking level: the surface exists.
        let toggle = thinking_level_map(&[(ModelThinkingLevel::Off, Some("none"))]);
        assert!(supports_thinking(&model(false, Some(toggle))));
    }

    #[test]
    fn supported_levels_exclude_null_and_implicit_xhigh_max() {
        let map = thinking_level_map(&[
            (ModelThinkingLevel::Off, None),
            (ModelThinkingLevel::Low, Some("low")),
            (ModelThinkingLevel::High, Some("high")),
        ]);
        let m = model(true, Some(map));
        // Off is explicitly null (disabled); xhigh/max need an explicit
        // mapping; everything else on the ladder stays supported.
        assert_eq!(
            get_supported_thinking_levels(&m),
            vec![
                ModelThinkingLevel::Minimal,
                ModelThinkingLevel::Low,
                ModelThinkingLevel::Medium,
                ModelThinkingLevel::High,
            ]
        );
    }

    #[test]
    fn wire_names_match_ts_keys() {
        assert_eq!(ModelThinkingLevel::Off.wire_name(), "off");
        assert_eq!(ModelThinkingLevel::Max.wire_name(), "max");
        assert_eq!(
            thinking_level_from_str("xhigh"),
            Some(ModelThinkingLevel::Xhigh)
        );
        assert_eq!(thinking_level_from_str("nope"), None);
    }

    #[test]
    fn wire_names_round_trip_the_whole_ladder() {
        for level in EXTENDED_THINKING_LEVELS {
            assert_eq!(thinking_level_from_str(level.wire_name()), Some(level));
        }
    }

    #[test]
    fn equality_is_provider_and_id() {
        let a = model(false, None);
        let mut b = a.clone();
        assert!(models_are_equal(Some(&a), Some(&b)));
        b.provider = "other".into();
        assert!(!models_are_equal(Some(&a), Some(&b)));
        assert!(!models_are_equal(Some(&a), None));
        assert!(!models_are_equal(None, None));
    }
}

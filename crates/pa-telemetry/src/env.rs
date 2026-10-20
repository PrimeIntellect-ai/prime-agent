//! Environment-variable parsing for the opt-out switch (TS
//! `parseBooleanOverride`); the precedence lives with the switch in pa-core
//! (`session_engine::telemetry::telemetry_switch`).

/// Parse a truthy/falsy string per the TS product: `1/true/yes/on` and
/// `0/false/no/off` (case-insensitive, trimmed); anything else is not an
/// override.
#[must_use]
pub fn parse_bool_override(value: Option<&str>) -> Option<bool> {
    let normalized = value?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Explicit harness markers, never inferred from provider, model, CI, or mode.
pub(crate) fn synthetic_workload(env: impl Fn(&str) -> Option<String>) -> bool {
    matches!(
        env("PRIME_AGENT_TELEMETRY_ORIGIN")
            .as_deref()
            .map(str::trim),
        Some("test" | "eval")
    ) || env("PRIME_AGENT_FAUX_SCRIPT").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_harness_markers_suppress_analytics() {
        for (pairs, expected) in [
            (vec![], false),
            (vec![("PRIME_AGENT_TELEMETRY_ORIGIN", "internal")], false),
            (vec![("PRIME_AGENT_TELEMETRY_ORIGIN", "automated")], false),
            (
                vec![("CI", "true"), ("PRIME_AGENT_MODEL_PROVIDER", "custom")],
                false,
            ),
            (
                vec![
                    ("PRIME_AGENT_TELEMETRY_ORIGIN", " test "),
                    ("PRIME_AGENT_TELEMETRY", "1"),
                ],
                true,
            ),
            (vec![("PRIME_AGENT_TELEMETRY_ORIGIN", "eval")], true),
            (vec![("PRIME_AGENT_FAUX_SCRIPT", "/tmp/script.json")], true),
        ] {
            assert_eq!(
                synthetic_workload(|key| pairs
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| (*value).to_string())),
                expected
            );
        }
    }

    #[test]
    fn bool_override_parsing() {
        assert_eq!(parse_bool_override(Some("1")), Some(true));
        assert_eq!(parse_bool_override(Some(" True ")), Some(true));
        assert_eq!(parse_bool_override(Some("ON")), Some(true));
        assert_eq!(parse_bool_override(Some("off")), Some(false));
        assert_eq!(parse_bool_override(Some("0")), Some(false));
        assert_eq!(parse_bool_override(Some("")), None);
        assert_eq!(parse_bool_override(Some("maybe")), None);
        assert_eq!(parse_bool_override(None), None);
    }
}

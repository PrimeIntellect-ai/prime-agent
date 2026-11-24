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

#[cfg(test)]
mod tests {
    use super::*;

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

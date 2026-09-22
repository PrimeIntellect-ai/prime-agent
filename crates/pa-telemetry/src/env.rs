//! Environment-variable override resolution for the opt-in posture.
//!
//! Parity with the TS product's `isTelemetryEnabled` env handling:
//! - `PI_OFFLINE` truthy disables (falsy is ignored).
//! - `DO_NOT_TRACK` truthy disables (falsy is ignored).
//! - `PRIME_AGENT_TELEMETRY` truthy/falsy overrides in both directions.
//!
//! [`env_telemetry_override`] returns the env verdict; settings (owned by
//! pa-core) apply when the verdict is absent.

/// Parse a truthy/falsy string per the TS product: `1/true/yes/on` and
/// `0/false/no/off` (case-insensitive, trimmed); anything else is not an
/// override.
pub fn parse_bool_override(value: Option<&str>) -> Option<bool> {
    let normalized = value?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Env verdict for telemetry. `Some(false)` disables, `Some(true)` enables,
/// `None` defers to settings.
pub fn env_telemetry_override() -> Option<bool> {
    override_verdict(
        parse_bool_override(std::env::var("PI_OFFLINE").ok().as_deref()),
        parse_bool_override(std::env::var("DO_NOT_TRACK").ok().as_deref()),
        parse_bool_override(std::env::var("PRIME_AGENT_TELEMETRY").ok().as_deref()),
    )
}

/// Truth table: offline and do-not-track only disable; the explicit variable
/// applies only when neither of those disables first.
fn override_verdict(
    offline: Option<bool>,
    dnt: Option<bool>,
    explicit: Option<bool>,
) -> Option<bool> {
    if offline == Some(true) || dnt == Some(true) {
        return Some(false);
    }
    explicit
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

    #[test]
    fn verdict_disables_only() {
        assert_eq!(override_verdict(Some(true), None, Some(true)), Some(false));
        assert_eq!(override_verdict(None, Some(true), Some(true)), Some(false));
        // Falsy PI_OFFLINE / DO_NOT_TRACK do not enable.
        assert_eq!(override_verdict(Some(false), Some(false), None), None);
    }

    #[test]
    fn explicit_variable_applies() {
        assert_eq!(override_verdict(None, None, Some(true)), Some(true));
        assert_eq!(override_verdict(None, None, Some(false)), Some(false));
        assert_eq!(override_verdict(None, None, None), None);
    }
}

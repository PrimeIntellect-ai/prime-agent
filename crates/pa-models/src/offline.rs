//! Offline mode (`PI_OFFLINE`): no network at all, serve cache/bundled/compiled.
//!
//! Ported from `isCatalogOffline` in `model-catalog-cache.ts`: the value
//! matches `^(1|true|yes)$` case-insensitively; unset or anything else
//! keeps the network enabled.

/// Whether the catalog subsystem must avoid every network request.
pub fn is_catalog_offline() -> bool {
    offline_flag().is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
}

fn offline_flag() -> Option<String> {
    std::env::var("PI_OFFLINE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: process-global env mutation in tests is unsafe in Rust 2024 and
    // racy across the test binary; the parsing rule is covered through the
    // private helper instead.
    #[test]
    fn parses_offline_values() {
        let yes = |raw: &str| {
            std::env::remove_var("PI_OFFLINE");
            // SAFETY: single-threaded test runtime before tokio starts.
            std::env::set_var("PI_OFFLINE", raw);
            is_catalog_offline()
        };
        assert!(yes("1"));
        assert!(yes("true"));
        assert!(yes("YES"));
        assert!(yes(" Yes "));
        assert!(!yes("0"));
        assert!(!yes("no"));
        assert!(!yes("maybe"));
        std::env::remove_var("PI_OFFLINE");
        assert!(!is_catalog_offline());
    }
}

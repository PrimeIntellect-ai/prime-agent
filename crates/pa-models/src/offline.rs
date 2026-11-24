//! Offline mode (`PI_OFFLINE`): no network at all, serve cache/bundled/compiled.

/// Whether the catalog subsystem must avoid every network request.
#[must_use]
pub fn is_catalog_offline() -> bool {
    offline_flag().is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
}

fn offline_flag() -> Option<String> {
    std::env::var("PI_OFFLINE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
}

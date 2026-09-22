//! Header helpers. Ported from `packages/ai/src/utils/headers.ts`.

/// Convert a header map into a plain record with lowercase keys.
#[allow(dead_code)] // SDK header conversion for upcoming providers
pub fn headers_to_record(
    headers: &std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, String> {
    headers
        .iter()
        .map(|(key, value)| (key.to_ascii_lowercase(), value.clone()))
        .collect()
}

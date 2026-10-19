//! The Prime Inference `/models` fetch: the private-authorization flow's
//! HTTP layer. The payload's parse and model build live in the catalog crate
//! (`pa_models::prime_inference`), shared with the public routes.

use std::collections::HashMap;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Fetch the live `/models` payload (timeout-capped, 2 MiB cap). `base_url`
/// is the Prime Inference API base (production: [`super::prime_inference
/// ::PRIME_INFERENCE_BASE_URL`]; tests pass a local server through the
/// shared catalog's seam).
///
/// # Errors
///
/// Human-readable error: the request failed, or the body is not JSON.
pub(crate) async fn fetch_prime_inference_model_catalog(
    base_url: &str,
    headers: Option<&HashMap<String, String>>,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let client = pa_ai::utils::tls::http_client_builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .get(format!("{base_url}/models"))
        .header("accept", "application/json");
    if let Some(headers) = headers {
        for (name, value) in headers {
            request = request.header(name, value);
        }
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Prime Inference model catalog request failed with status {status}"
        ));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Response is too large".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

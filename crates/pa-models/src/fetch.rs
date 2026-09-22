//! The unauthenticated catalog fetch layer.
//!
//! Ported from `readJsonResponse` + `CatalogCache.refresh` request handling in
//! `model-catalog-cache.ts`:
//! - unauthenticated GET, headers `accept: application/json`,
//!   `cache-control: no-cache`, `If-None-Match: <etag>` when cached;
//! - 5 s hard timeout;
//! - 8 MiB response cap enforced through content-length AND a streaming
//!   byte count;
//! - redirects refused: a moved catalog must be a client change
//!   (`redirect: "error"` in the TS reference);
//! - `304 Not Modified` keeps the snapshot (caller reuses the cached
//!   payload and updates `fetchedAt`).

use std::time::Duration;

use thiserror::Error;

/// The provider model catalog aggregate (models side of the catalog repo).
pub const MODEL_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/models/catalog.v1.json";

/// The MCP service catalog aggregate (plugins side of the catalog repo).
pub const MCP_SERVICE_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/plugins/catalog.v2.json";

/// Hard per-request timeout for catalog fetches.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Hard response size cap for catalog fetches (8 MiB).
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Failure of a catalog HTTP request (`CatalogRequestError` in the TS).
#[derive(Debug, Error)]
pub enum FetchError {
    /// Non-success status (the response was not read).
    #[error("Catalog request failed with status {status}")]
    Status { status: u16 },
    /// Redirect refused, timeout, connection failure, or oversize body.
    #[error("{message}")]
    Transport { message: String },
}

impl FetchError {
    /// HTTP status for the 401/403 scope-clearing rule; None for transport
    /// failures and redirects.
    pub fn status(&self) -> Option<u16> {
        match self {
            FetchError::Status { status } => Some(*status),
            FetchError::Transport { .. } => None,
        }
    }
}

/// The outcome of one catalog fetch.
#[derive(Debug)]
pub enum FetchOutcome {
    /// HTTP 200 with the full body and the response `ETag` (when present).
    Fresh { body: Vec<u8>, etag: Option<String> },
    /// HTTP 304: the snapshot is still current; reuse the cached payload.
    NotModified,
}

/// The shared catalog HTTP client. One instance serves both catalog URLs;
/// each request is bounded by the timeout and the byte cap.
#[derive(Debug)]
pub struct CatalogFetcher {
    client: reqwest::Client,
    timeout: Duration,
    max_bytes: usize,
}

impl Default for CatalogFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl CatalogFetcher {
    /// The production client: 5 s timeout, no redirects, 8 MiB cap.
    pub fn new() -> Self {
        Self::with_limits(FETCH_TIMEOUT, MAX_RESPONSE_BYTES)
    }

    /// A client with explicit bounds (tests; the Prime Inference 2 MiB cap).
    pub fn with_limits(timeout: Duration, max_bytes: usize) -> Self {
        let client = reqwest::Client::builder()
            // A moved catalog must be a client change, never a silent hop.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("catalog reqwest client");
        Self {
            client,
            timeout,
            max_bytes,
        }
    }

    /// GET `url` with catalog headers and the optional cached `ETag`.
    pub async fn fetch(&self, url: &str, etag: Option<&str>) -> Result<FetchOutcome, FetchError> {
        self.fetch_with(url, etag, &[]).await
    }

    /// [`CatalogFetcher::fetch`] plus extra request headers (credentials for
    /// the credentialed Prime Inference fetch).
    pub async fn fetch_with(
        &self,
        url: &str,
        etag: Option<&str>,
        extra_headers: &[(String, String)],
    ) -> Result<FetchOutcome, FetchError> {
        let mut request = self
            .client
            .get(url)
            .timeout(self.timeout)
            .header("accept", "application/json")
            .header("cache-control", "no-cache");
        for (name, value) in extra_headers {
            request = request.header(name.as_str(), value.as_str());
        }
        if let Some(etag) = etag {
            request = request.header("if-none-match", etag);
        }
        let response = request
            .send()
            .await
            .map_err(|error| FetchError::Transport {
                message: format!("Catalog request failed: {error}"),
            })?;
        let status = response.status().as_u16();
        if status == 304 {
            return Ok(FetchOutcome::NotModified);
        }
        if (300..400).contains(&status) {
            // Redirects are refused: a moved catalog must be a client
            // change (`redirect: "error"` in the TS reference).
            return Err(FetchError::Transport {
                message: "Catalog request refused a redirect".into(),
            });
        }
        if !(200..300).contains(&status) {
            return Err(FetchError::Status { status });
        }
        if let Some(length) = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
        {
            if length > self.max_bytes {
                return Err(FetchError::Transport {
                    message: "Catalog is too large".into(),
                });
            }
        }
        let mut body = Vec::new();
        let mut response = response;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| FetchError::Transport {
                message: format!("Catalog request failed: {error}"),
            })?
        {
            body.extend_from_slice(&chunk);
            if body.len() > self.max_bytes {
                return Err(FetchError::Transport {
                    message: "Catalog is too large".into(),
                });
            }
        }
        Ok(FetchOutcome::Fresh {
            body,
            etag: response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_bounds_match_the_contract() {
        let fetcher = CatalogFetcher::new();
        assert_eq!(fetcher.timeout, FETCH_TIMEOUT);
        assert_eq!(fetcher.max_bytes, MAX_RESPONSE_BYTES);
    }

    #[test]
    fn catalog_urls_are_the_frozen_contract() {
        assert_eq!(
            MODEL_CATALOG_URL,
            "https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/models/catalog.v1.json"
        );
        assert_eq!(
            MCP_SERVICE_CATALOG_URL,
            "https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/plugins/catalog.v2.json"
        );
    }
}

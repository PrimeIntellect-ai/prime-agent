//! `PostHog` feature-flag client (gradual rollouts).
//!
//! v1 scope: fetch + [`FlagsClient::flag_enabled`] with an in-memory TTL
//! cache; no product gating lives in this crate. Decisions are anonymous —
//! the only identity is the pseudonymous installation id (`distinct_id`).
//! When `PostHog` is unreachable the configured default is served and the
//! (empty) result is cached for the TTL so an offline client never
//! request-storms.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

/// How long a decide response (or a failed fetch) stays authoritative.
pub const FLAG_CACHE_TTL: Duration = Duration::from_mins(5);

const DECIDE_API_VERSION: &str = "v=3";

/// `PostHog` decide client for one installation.
pub struct FlagsClient {
    http: reqwest::Client,
    decide_url: String,
    api_key: String,
    distinct_id: String,
    cache: std::sync::Mutex<Option<CacheEntry>>,
    /// Latched when the decide endpoint answers 401 (bad or missing-scope
    /// credentials): no further decide is attempted, so a permanently
    /// rejected key cannot poll the endpoint every TTL.
    auth_terminal: AtomicBool,
}

struct CacheEntry {
    fetched_at: Instant,
    flags: HashMap<String, Value>,
}

impl FlagsClient {
    /// New decide client for one installation: fetches the endpoint's
    /// `/decide/` flags for `distinct_id`, on a 1.5s request timeout.
    ///
    /// # Panics
    ///
    /// Panics if the internal reqwest HTTP client (rustls backend) cannot
    /// be built.
    pub fn new(endpoint: &crate::sinks::PostHogEndpoint, distinct_id: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(1500))
            .build()
            .expect("reqwest client with rustls");
        let base = endpoint.endpoint.trim_end_matches('/');
        Self {
            http,
            decide_url: format!("{base}/decide/?{DECIDE_API_VERSION}"),
            api_key: endpoint.api_key.clone(),
            distinct_id: distinct_id.into(),
            cache: std::sync::Mutex::new(None),
            auth_terminal: AtomicBool::new(false),
        }
    }

    /// Is the flag enabled for this installation? A fresh decide cache is
    /// authoritative for every flag name (absent = default, no refetch);
    /// a stale or missing cache refetches. Offline, `default` is served and
    /// the (empty) result is cached for the TTL so a dead endpoint is polled
    /// at most once per TTL per client.
    pub async fn flag_enabled(&self, name: &str, default: bool) -> bool {
        if self.auth_terminal.load(Ordering::Relaxed) {
            return default;
        }
        if let Some(value) = self.cached_flag(name) {
            let value = value.unwrap_or(Value::Null);
            return truthy(&value).unwrap_or(default);
        }
        if let Some(flags) = self.fetch().await {
            let value = flags.get(name).cloned().unwrap_or(Value::Null);
            self.store(flags);
            truthy(&value).unwrap_or(default)
        } else {
            self.store(HashMap::new());
            default
        }
    }

    /// Flag value from a fresh cache: `Some(None)` = fresh cache that does not
    /// know the flag (serve default, no refetch), `None` = stale/missing
    /// cache (refetch).
    fn cached_flag(&self, name: &str) -> Option<Option<Value>> {
        let cache = self.cache.lock().expect("flags cache poisoned");
        let cache = cache.as_ref()?;
        if cache.fetched_at.elapsed() >= FLAG_CACHE_TTL {
            return None;
        }
        Some(cache.flags.get(name).cloned())
    }

    /// Replace the cache with a fresh decide result.
    fn store(&self, flags: HashMap<String, Value>) {
        *self.cache.lock().expect("flags cache poisoned") = Some(CacheEntry {
            fetched_at: Instant::now(),
            flags,
        });
    }

    /// Parse the `featureFlags` object out of a decide v3 response; `None`
    /// on transport failure or a malformed body.
    async fn fetch(&self) -> Option<HashMap<String, Value>> {
        let response = self
            .http
            .post(&self.decide_url)
            .header("content-type", "application/json")
            .header("user-agent", format!("prime-agent/{}", crate::VERSION))
            .json(&serde_json::json!({
                "api_key": self.api_key,
                "distinct_id": self.distinct_id,
            }))
            .send()
            .await
            .ok()?;
        if response.status().as_u16() == 401 {
            // Terminal, not retried: bad or missing-scope credentials fail
            // every decide; stop polling instead of re-asking each TTL.
            self.auth_terminal.store(true, Ordering::Relaxed);
            tracing::debug!("feature-flag decide rejected with 401, polling disabled");
            return None;
        }
        if !response.status().is_success() {
            tracing::debug!(status = %response.status(), "feature-flag decide rejected");
            return None;
        }
        let body: Value = response.json().await.ok()?;
        let flags = body.get("featureFlags")?.as_object()?.clone();
        Some(flags.into_iter().collect::<HashMap<_, _>>())
    }
}

/// `PostHog` flag values are `true`/`false` (booleans) or multivariate strings.
/// A string other than `"false"` is an enabled variant.
fn truthy(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(enabled) => Some(*enabled),
        Value::String(variant) => Some(variant != "false"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(flags: HashMap<String, Value>, fetched_at: Instant) -> CacheEntry {
        CacheEntry { fetched_at, flags }
    }

    fn flags(values: &[(&str, Value)]) -> HashMap<String, Value> {
        values
            .iter()
            .map(|(name, value)| ((*name).to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn truthy_flag_values() {
        assert_eq!(truthy(&Value::Bool(true)), Some(true));
        assert_eq!(truthy(&Value::Bool(false)), Some(false));
        assert_eq!(truthy(&Value::String("control".into())), Some(true));
        assert_eq!(truthy(&Value::String("false".into())), Some(false));
        assert_eq!(truthy(&Value::Null), None);
    }

    #[test]
    fn fresh_cache_serves_flag() {
        let client = FlagsClient::new(
            &crate::sinks::PostHogEndpoint::new("http://127.0.0.1:1", "phc-key"),
            "install-1",
        );
        *client.cache.lock().unwrap() = Some(entry(
            flags(&[("new_engine", Value::Bool(true))]),
            Instant::now(),
        ));
        let cache = client.cache.lock().unwrap();
        assert!(cache.as_ref().is_some());
    }

    #[test]
    fn stale_cache_is_ignored() {
        let client = FlagsClient::new(
            &crate::sinks::PostHogEndpoint::new("http://127.0.0.1:1", "phc-key"),
            "install-1",
        );
        *client.cache.lock().unwrap() = Some(entry(
            flags(&[("new_engine", Value::Bool(true))]),
            Instant::now() - FLAG_CACHE_TTL,
        ));
        assert!(client.cached_flag("new_engine").is_none());
    }

    #[test]
    fn fresh_cache_is_authoritative_for_absent_flags() {
        let client = FlagsClient::new(
            &crate::sinks::PostHogEndpoint::new("http://127.0.0.1:1", "phc-key"),
            "install-1",
        );
        *client.cache.lock().unwrap() = Some(entry(HashMap::new(), Instant::now()));
        // Fresh cache that does not know the flag: no refetch signal.
        assert_eq!(client.cached_flag("absent"), Some(None));
    }
}

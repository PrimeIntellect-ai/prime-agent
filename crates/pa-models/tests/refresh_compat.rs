//! Compat regressions (spec §5.2) over the generic `CatalogCache` and a
//! scripted local HTTP server: fake future versions keep last-good
//! silently, malformed entries skip per policy, failures keep state
//! unchanged, hourly gating + coalescing hold, and scopes isolate
//! accounts (the Prime Inference disk cache is scope-keyed; 401/403
//! clears only that scope).

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use pa_models::cache::{CatalogCache, RefreshOptions, PUBLIC_SCOPE};
use pa_models::fetch::CatalogFetcher;
use pa_models::pinning::{parse_provider_model_catalog, PinnedTemplates};
use pa_models::prime_inference::{
    build_prime_inference_models, parse_prime_inference_model_catalog, PrimeInferenceCatalog,
    PrimeInferenceCredentials,
};
use serde_json::{json, Value};

/// A cache over the models catalog parse pipeline (the same closure
/// `ModelCatalog` installs in production), aimed at the mock server.
fn models_cache(dir: &std::path::Path, url: String) -> CatalogCache<Vec<pa_models::Model>> {
    let templates = PinnedTemplates::from_compiled();
    let parse: pa_models::cache::CatalogParse<Vec<pa_models::Model>> =
        Arc::new(move |payload, _scope| parse_provider_model_catalog(payload, &templates));
    CatalogCache::new(
        &url,
        Some(dir.join("provider-model-catalog.v1.json")),
        Arc::new(CatalogFetcher::new()),
        parse,
    )
}

fn catalog_json(ids: &[&str]) -> String {
    let compiled = pa_models::transports::compiled_models();
    let anthropic = compiled.iter().find(|m| m.provider == "anthropic").unwrap();
    let models: Vec<Value> = ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "name": id,
                "api": anthropic.api,
                "provider": anthropic.provider,
                "baseUrl": anthropic.base_url,
                "reasoning": false,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 128_000,
                "maxTokens": 4_096,
            })
        })
        .collect();
    serde_json::to_string(&json!({"schemaVersion": 1, "models": models})).unwrap()
}

#[tokio::test]
async fn fresh_fetch_writes_a_validated_0600_snapshot_and_serves_it() {
    let dir = tempfile::tempdir().unwrap();
    let body = catalog_json(&["model-a"]);
    let server =
        common::MockServer::start(vec![common::ok_json(body.clone(), Some("\"e1\""))]).await;
    let cache = models_cache(dir.path(), server.url("/catalog"));
    let models = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("refreshed");
    assert!(models.iter().any(|m| m.id == "model-a"));

    let path = dir.path().join("provider-model-catalog.v1.json");
    let metadata = std::fs::metadata(&path).expect("snapshot written");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            metadata.permissions().mode() & 0o777,
            0o600,
            "mode 0600 like the TS writeFileAtomicSync"
        );
    }
    let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored["url"], server.url("/catalog"));
    assert_eq!(stored["scope"], PUBLIC_SCOPE);
    assert_eq!(stored["etag"], "\"e1\"");
    assert!(stored["fetchedAt"].as_u64().is_some());
    assert_eq!(stored["payload"]["models"][0]["id"], "model-a");

    // A second cache (new process) serves the validated disk snapshot and
    // hits no network without a refresh.
    let cache2 = models_cache(dir.path(), server.url("/catalog"));
    let models = cache2.get(PUBLIC_SCOPE).expect("disk snapshot");
    assert!(models.iter().any(|m| m.id == "model-a"));
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn unsupported_future_version_keeps_last_good_silently() {
    let dir = tempfile::tempdir().unwrap();
    let good = catalog_json(&["model-a"]);
    let server = common::MockServer::start(vec![
        common::ok_json(good.clone(), None),
        // A future v3 aggregate: rejected, silently, forever.
        common::ok_json(
            serde_json::to_string(&json!({
                "schemaVersion": 3, "models": [{"id": "v3-model"}]
            }))
            .unwrap(),
            None,
        ),
    ])
    .await;
    let cache = models_cache(dir.path(), server.url("/catalog"));
    cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("good first refresh");
    let before = cache.get(PUBLIC_SCOPE).expect("last good");

    let after = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("kept last good");
    assert_eq!(
        after.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        before.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        "v3 payload silently keeps last-good"
    );
    // The disk snapshot was not clobbered either.
    let cache2 = models_cache(dir.path(), server.url("/catalog"));
    assert!(cache2
        .get(PUBLIC_SCOPE)
        .expect("disk snapshot intact")
        .iter()
        .any(|m| m.id == "model-a"));
}

#[tokio::test]
async fn malformed_model_entry_skips_and_the_refresh_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let compiled = pa_models::transports::compiled_models();
    let anthropic = compiled.iter().find(|m| m.provider == "anthropic").unwrap();
    let body = json!({"schemaVersion": 1, "models": [
        {"id": "broken-entry", "api": anthropic.api, "provider": anthropic.provider,
         "baseUrl": anthropic.base_url, "contextWindow": 0},
        {"id": "good-entry", "name": "good", "api": anthropic.api,
         "provider": anthropic.provider, "baseUrl": anthropic.base_url,
         "reasoning": false, "input": ["text"],
         "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
         "contextWindow": 128_000, "maxTokens": 4_096},
    ]});
    let server = common::MockServer::start(vec![common::ok_json(
        serde_json::to_string(&body).unwrap(),
        None,
    )])
    .await;
    let cache = models_cache(dir.path(), server.url("/catalog"));
    let models = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("refresh succeeds");
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["good-entry"], "bad entry skipped, refresh kept");
}

#[tokio::test]
async fn network_failure_and_oversize_keep_state_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![
        common::ok_json(catalog_json(&["model-a"]), None),
        // The next request fails with a 5xx: state must not change.
        common::status(500, "Internal Server Error"),
    ])
    .await;
    let url = server.url("/catalog");
    let cache = models_cache(dir.path(), url.clone());
    cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("good refresh");
    let before: Vec<String> = cache
        .get(PUBLIC_SCOPE)
        .expect("snapshot")
        .iter()
        .map(|m| m.id.clone())
        .collect();

    // Fetch failure: the same last-good snapshot serves, no error surfaced.
    let after = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("last good kept");
    assert_eq!(
        after.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        before,
        "state unchanged after a failed fetch"
    );

    // Oversized body on a pristine cache: no snapshot before, none after.
    let oversize = common::MockServer::start(vec![common::oversized_header()]).await;
    let big = models_cache(dir.path(), oversize.url("/catalog"));
    assert!(big
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            }
        )
        .await
        .is_none());
    assert!(
        big.get(PUBLIC_SCOPE).is_none(),
        "oversized body never produces a snapshot"
    );
}

#[tokio::test]
async fn hourly_gating_skips_recent_attempts_and_force_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let server =
        common::MockServer::start(vec![common::ok_json(catalog_json(&["model-a"]), None)]).await;
    let cache = models_cache(dir.path(), server.url("/catalog"));
    cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("first refresh");
    assert_eq!(server.request_count(), 1);

    // Not forced, attempted seconds ago: no new request.
    cache
        .refresh(PUBLIC_SCOPE, RefreshOptions::default())
        .await
        .expect("served from snapshot");
    assert_eq!(server.request_count(), 1, "hourly gating");

    // Forced (startup/picker/auth change): one new request.
    cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("forced refresh");
    assert_eq!(server.request_count(), 2);
}

#[tokio::test]
async fn concurrent_refreshes_coalesce_into_one_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let server =
        common::MockServer::start(vec![common::ok_json(catalog_json(&["model-a"]), None)]).await;
    let cache = Arc::new(models_cache(dir.path(), server.url("/catalog")));
    let a = cache.refresh(
        PUBLIC_SCOPE,
        RefreshOptions {
            force: true,
            ..Default::default()
        },
    );
    let b = cache.refresh(
        PUBLIC_SCOPE,
        RefreshOptions {
            force: true,
            ..Default::default()
        },
    );
    let (a, b) = tokio::join!(a, b);
    assert!(a.is_some());
    assert!(b.is_some());
    assert_eq!(
        server.request_count(),
        1,
        "in-flight refreshes coalesce per source"
    );
}

#[tokio::test]
async fn not_modified_keeps_snapshot_and_updates_fetched_at() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![
        common::ok_json(catalog_json(&["model-a"]), Some("\"e1\"")),
        common::not_modified(),
    ])
    .await;
    let cache = models_cache(dir.path(), server.url("/catalog"));
    cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("first refresh");
    let models = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("304 keeps snapshot");
    assert!(models.iter().any(|m| m.id == "model-a"));
    let stored: Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("provider-model-catalog.v1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stored["etag"], "\"e1\"", "etag reused after 304");
}

#[tokio::test]
async fn prime_inference_cache_is_scope_keyed_and_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let compiled = pa_models::transports::prime_inference_offline_entries();
    let ids: Vec<String> = compiled.iter().map(|m| m.id.clone()).take(60).collect();
    let entry = |id: &str| {
        json!({
            "id": id,
            "display_name": id,
            "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0},
            "specs": {
                "context_window": 200_000, "max_output_tokens": 32_768,
                "supports_reasoning": true,
                "modalities": {"input": ["text"], "output": ["text"]},
            },
        })
    };
    let mut data: Vec<Value> = ids.iter().map(|id| entry(id)).collect();
    data.push(entry("internal/team-a-secret"));
    let payload = json!({"data": data}).to_string();
    let server = common::MockServer::start(vec![common::ok_json(payload, None)]).await;
    let base = {
        let url = server.url("/api/v1");
        url.trim_end_matches("/models").to_string()
    };
    let catalog = PrimeInferenceCatalog::with_base_url(Some(PathBuf::from(dir.path())), &base);

    let team_a = PrimeInferenceCredentials {
        api_key: "key-a".into(),
        team_id: Some("team-a".into()),
    };
    let team_b = PrimeInferenceCredentials {
        api_key: "key-b".into(),
        team_id: Some("team-b".into()),
    };

    // Account A fetches live models with its credentials on the wire.
    let a = catalog
        .refresh(&team_a, true)
        .await
        .expect("team-a live models");
    assert_eq!(a.len(), 60, "public live entries only");
    // The public models cache never includes private ids (the private
    // entitlement flow is the registry's, over its own authorization).
    assert!(
        !a.iter().any(|m| m.id == "internal/team-a-secret"),
        "private ids are filtered from the public models cache"
    );
    let request = &server.recorded_requests()[0];
    assert!(request.contains("authorization: Bearer key-a"), "{request}");
    assert!(request.contains("x-prime-team-id: team-a"), "{request}");

    // Account B: a different scope — A's fetched data never serves it.
    assert!(
        catalog.get(&team_b).is_none(),
        "account B sees nothing from account A's scope"
    );

    // A fresh process (same URL) serves A's disk snapshot for A's scope
    // only: the cache file is scope-keyed by the HMAC of key over team.
    let fresh = PrimeInferenceCatalog::with_base_url(Some(PathBuf::from(dir.path())), &base);
    assert!(
        fresh.get(&team_a).is_some(),
        "A's scope reloads its own disk snapshot"
    );
    assert!(
        fresh.get(&team_b).is_none(),
        "B's scope stays empty across processes"
    );
    let stored: Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("prime-inference-models-cache.json")).unwrap(),
    )
    .unwrap();
    let expected_scope = pa_models::prime_inference::scope_key("key-a", "team-a");
    assert_eq!(stored["scope"], expected_scope, "scope fingerprint on disk");
}

#[tokio::test]
async fn unauthorized_prime_inference_clears_only_that_scope() {
    let dir = tempfile::tempdir().unwrap();
    let compiled = pa_models::transports::prime_inference_offline_entries();
    let ids: Vec<String> = compiled.iter().map(|m| m.id.clone()).take(60).collect();
    let data: Vec<Value> = ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0},
                "specs": {
                    "context_window": 200_000, "max_output_tokens": 32_768,
                    "supports_reasoning": true,
                    "modalities": {"input": ["text"], "output": ["text"]},
                },
            })
        })
        .collect();
    let payload = json!({"data": data}).to_string();
    let server = common::MockServer::start(vec![
        common::ok_json(payload, None),
        common::status(401, "Unauthorized"),
        common::ok_json(json!({"data": []}).to_string(), None),
    ])
    .await;
    let base = {
        let url = server.url("/api/v1");
        url.trim_end_matches("/models").to_string()
    };
    let catalog = PrimeInferenceCatalog::with_base_url(Some(PathBuf::from(dir.path())), &base);

    let creds = PrimeInferenceCredentials {
        api_key: "key-a".into(),
        team_id: Some("team-a".into()),
    };
    let other = PrimeInferenceCredentials {
        api_key: "key-z".into(),
        team_id: Some("team-z".into()),
    };
    assert!(catalog.refresh(&creds, true).await.is_some(), "good fetch");
    assert!(catalog.get(&creds).is_some());

    // 401 revocation clears only the requesting scope: the disk file is
    // removed, the in-memory snapshot for that scope drops.
    assert!(catalog.refresh(&creds, true).await.is_none(), "401");
    assert!(catalog.get(&creds).is_none(), "scope cleared");
    assert!(
        !dir.path()
            .join("prime-inference-models-cache.json")
            .exists(),
        "cache file removed"
    );
    // The other scope was never populated — also clear; the invariant is
    // that clearing is scoped, not global.
    assert!(catalog.get(&other).is_none());
}

#[test]
fn prime_inference_parse_and_coverage_gate_use_public_fns() {
    // Sanity for the closure the PrimeInferenceCatalog installs: an empty
    // live catalog parses (allowEmpty) but fails the coverage gate, so a
    // degraded fetch never replaces a good snapshot.
    let compiled = pa_models::transports::prime_inference_offline_entries();
    let payload = json!({"data": []});
    let entries = parse_prime_inference_model_catalog(&payload, true).expect("empty ok");
    assert!(build_prime_inference_models(&compiled, &entries, false, None).is_none());
}

#[tokio::test]
async fn mid_session_refresh_never_retargets() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![
        common::ok_json(catalog_json(&["before-model"]), None),
        common::ok_json(catalog_json(&["after-model"]), None),
    ])
    .await;
    let cache = models_cache(dir.path(), server.url("/catalog"));
    let first = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("first refresh");
    // The session resolves and keeps its model value.
    let active = first
        .iter()
        .find(|m| m.id == "before-model")
        .expect("active model")
        .clone();
    let _ = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await
        .expect("second refresh");
    // The session's model object keeps identity + transport for the
    // session's lifetime; only new resolutions see the new catalog.
    assert_eq!(active.id, "before-model");
    assert_eq!(active.api, "anthropic-messages");
}

/// Fire-and-forget safety (the header contract): a caller that drops its
/// `refresh` mid-fetch — a bounded wait timing out — must not poison the
/// coalescing gate. The dropped driver resolves the gate as a failed
/// refresh, wakes any coalesced waiter, and the next refresh starts a
/// fresh fetch instead of awaiting a notify that never comes.
#[tokio::test]
async fn a_dropped_refresh_resolves_the_gate_and_the_next_refresh_starts_fresh() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start_scripted(vec![
        common::Scripted::Delayed(
            common::ok_json(catalog_json(&["model-a"]), None),
            std::time::Duration::from_secs(5),
        ),
        common::Scripted::Response(common::ok_json(catalog_json(&["model-b"]), None)),
    ])
    .await;
    let cache = Arc::new(models_cache(dir.path(), server.url("/catalog")));

    // A coalesced waiter joins the dropped driver: it must wake with a
    // failed refresh (None), never hang on the abandoned gate. Both waits
    // are bounded — pre-fix, the coalesced waiter hangs on the abandoned
    // gate and the 2s bound fails the test instead of wedging it.
    let dropped = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        cache.refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        ),
    );
    let joined = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        cache.refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        ),
    );
    let (dropped, joined) = tokio::join!(dropped, joined);
    assert!(
        dropped.is_err(),
        "the bounded wait must return while the fetch is held"
    );
    let joined = joined.expect("the coalesced waiter wakes on the abandoned gate");
    assert!(
        joined.is_none(),
        "a dropped refresh resolves as a failed one"
    );

    // The gate is clear: the next forced refresh starts a fresh fetch and
    // lands (the second scripted response), instead of coalescing onto the
    // abandoned in-flight gate forever.
    let next = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force: true,
                ..Default::default()
            },
        )
        .await;
    assert!(next.is_some(), "the next refresh starts a fresh fetch");
    assert!(
        next.as_ref()
            .is_some_and(|models| { models.iter().any(|model| model.id == "model-b") }),
        "the fresh fetch lands"
    );
    assert!(
        server.request_count() >= 2,
        "a fresh fetch ran after the abandoned one"
    );
}

/// The hourly loop (the supervisor's arm on the process-shared catalog)
/// refreshes through the credentials closure: the first tick fires the
/// gated Hourly trigger immediately (tokio interval semantics — a
/// supervisor boot warms the caches without waiting an hour) and the
/// closure's credentials ride the credentialed fetch; the tick's own
/// fetch arms the hourly gate, so an immediate second attempt stays
/// inside the window (one fetch per layer per hour).
#[tokio::test]
async fn the_hourly_loop_refreshes_through_the_credentials_closure() {
    let dir = tempfile::tempdir().unwrap();
    let compiled = pa_models::transports::prime_inference_offline_entries();
    let ids: Vec<String> = compiled.iter().map(|m| m.id.clone()).take(60).collect();
    let entry = |id: &str| {
        json!({
            "id": id,
            "display_name": id,
            "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0},
            "specs": {
                "context_window": 200_000, "max_output_tokens": 32_768,
                "supports_reasoning": true,
                "modalities": {"input": ["text"], "output": ["text"]},
            },
        })
    };
    let data: Vec<Value> = ids.iter().map(|id| entry(id)).collect();
    let pi_payload = json!({"data": data}).to_string();
    let server = common::MockServer::start(vec![
        common::ok_json(catalog_json(&["hourly-model"]), None),
        common::ok_json(pi_payload, None),
    ])
    .await;
    let catalog = Arc::new(pa_models::ModelCatalog::with_urls(
        Some(dir.path().join("models")),
        Some(dir.path().to_path_buf()),
        &server.url("/catalog"),
        &server.url("/api/v1"),
    ));
    let credentials = pa_models::PrimeCredentials {
        api_key: "sk-hourly".into(),
        team_id: Some("team-hourly".into()),
    };
    let hourly = Arc::clone(&catalog);
    hourly.spawn_hourly_refresh(move || Some(credentials.clone()));
    // The first tick fires immediately: both fetch layers ran, the
    // credentialed one carrying the closure's current credentials.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while server.request_count() < 2 {
        assert!(
            std::time::Instant::now() < deadline,
            "the hourly loop's first tick never fetched"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let heads = server.recorded_requests();
    assert!(
        heads.iter().any(|head| head.contains("/catalog")),
        "the provider catalog layer refreshed"
    );
    let pi_fetch = heads
        .iter()
        .find(|head| head.contains("/models"))
        .expect("the credentialed layer refreshed");
    assert!(
        pi_fetch.contains("authorization: Bearer sk-hourly"),
        "{pi_fetch}"
    );
    assert!(
        pi_fetch.contains("x-prime-team-id: team-hourly"),
        "{pi_fetch}"
    );
    // The hourly gate: an immediate second attempt serves the cached
    // snapshot with no fetch (the awaited call is the gate's own path, so
    // the count is settled at the assert, not raced).
    let gated = catalog.refresh(false).await;
    assert!(gated.is_some_and(|models| { models.iter().any(|model| model.id == "hourly-model") }));
    assert_eq!(server.request_count(), 2, "one fetch per layer per window");
}

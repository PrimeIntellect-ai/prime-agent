//! Codex discovery through the public catalog facade and loopback HTTP.

mod common;

use std::path::Path;

use pa_models::{CodexCredentials, Model, ModelCatalog};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn credentials(account: &str) -> CodexCredentials {
    CodexCredentials {
        access_token: format!("token-{account}"),
        account_id: account.into(),
    }
}

fn catalog(dir: &Path, url: &str) -> ModelCatalog {
    ModelCatalog::with_bundled_dir(Some(dir.into()), Some(dir.into())).with_codex_url(url)
}

fn payload(id: &str) -> Value {
    json!({"models": [{
        "slug": id, "display_name": "New release",
        "visibility": "list", "context_window": 400_000,
        "supported_reasoning_levels": [{"effort": "high"}],
        "input_modalities": ["text", "image"]
    }]})
}

fn write_expired_snapshot(dir: &Path, url: &str, account: &str, payload: &Value) {
    let mut hash = Sha256::new();
    hash.update(b"prime-agent:codex-models:v1\0");
    hash.update(account.as_bytes());
    let snapshot = json!({
        "url": url,
        "scope": hex::encode(hash.finalize()),
        "fetchedAt": 1,
        "payload": payload
    });
    std::fs::write(
        dir.join("openai-codex-models-cache.json"),
        snapshot.to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn authenticated_fetch_discovers_a_new_model_without_changing_other_providers() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![common::ok_json(
        payload("gpt-new-release").to_string(),
        None,
    )])
    .await;
    let catalog = catalog(dir.path(), &server.url("/models?client_version=0.162.1"));
    let before = catalog.resolve(None);
    let models = catalog
        .refresh_codex(&credentials("account-a"))
        .await
        .expect("live discovery");
    let expected: Model = serde_json::from_value(json!({
        "id": "gpt-new-release", "name": "New release",
        "api": "openai-codex-responses", "provider": "openai-codex",
        "baseUrl": "https://chatgpt.com/backend-api",
        "reasoning": true,
        "thinkingLevelMap": {
            "off": null, "minimal": null, "low": null, "medium": null,
            "high": "high", "xhigh": null, "max": null
        },
        "input": ["text", "image"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 400_000, "maxTokens": 128_000
    }))
    .unwrap();
    assert_eq!(models, vec![expected.clone()]);
    let mut expected_catalog: Vec<_> = before
        .into_iter()
        .filter(|model| model.provider != "openai-codex")
        .collect();
    expected_catalog.push(expected);
    assert_eq!(
        catalog.resolve_with_codex(None, Some("account-a")),
        expected_catalog
    );
    let requests = server.recorded_requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    for header in [
        "GET /models?client_version=0.162.1 HTTP/1.1",
        "authorization: Bearer token-account-a",
        "chatgpt-account-id: account-a",
        "originator: pi",
    ] {
        assert!(request.contains(header), "missing {header}: {request}");
    }
}

#[tokio::test]
async fn fresh_disk_cache_reuses_models_until_expiry_then_fetches_a_new_release() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![
        common::ok_json(payload("gpt-first-release").to_string(), None),
        common::ok_json(payload("gpt-next-release").to_string(), None),
    ])
    .await;
    let url = server.url("/models");
    let first = catalog(dir.path(), &url);
    let original = first
        .refresh_codex(&credentials("account-a"))
        .await
        .expect("first fetch");
    let reloaded = catalog(dir.path(), &url);
    assert_eq!(
        reloaded.refresh_codex(&credentials("account-a")).await,
        Some(original.clone())
    );
    assert_eq!(
        first.refresh_codex(&credentials("account-a")).await,
        Some(original)
    );
    assert_eq!(
        server.request_count(),
        1,
        "fresh memory and disk avoid HTTP"
    );

    write_expired_snapshot(dir.path(), &url, "account-a", &payload("gpt-first-release"));
    let expired = catalog(dir.path(), &url);
    let stale = expired.resolve_with_codex(None, Some("account-a"));
    assert!(stale.iter().any(|model| model.id == "gpt-first-release"));
    let updated = expired
        .refresh_codex(&credentials("account-a"))
        .await
        .expect("expired cache refresh");
    assert_eq!(
        updated
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-next-release"]
    );
    assert_eq!(server.request_count(), 2);
    let snapshot: Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("openai-codex-models-cache.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["payload"], payload("gpt-next-release"));
    assert!(snapshot["fetchedAt"].as_u64().unwrap() > 1);
}

#[tokio::test]
async fn invalid_payload_and_http_failure_keep_last_good_or_compiled_fallback() {
    for response in [
        common::ok_json("{broken", None),
        common::ok_json(json!({"models": []}).to_string(), None),
        common::ok_json(json!({"unexpected": []}).to_string(), None),
        common::status(503, "Unavailable"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let server = common::MockServer::start(vec![response.clone(), response]).await;
        let url = server.url("/models");
        let empty = catalog(dir.path(), &url);
        let compiled = empty.resolve(None);
        assert!(empty
            .refresh_codex(&credentials("account-a"))
            .await
            .is_none());
        assert_eq!(empty.resolve_with_codex(None, Some("account-a")), compiled);

        write_expired_snapshot(dir.path(), &url, "account-a", &payload("gpt-last-good"));
        let cached = catalog(dir.path(), &url);
        let before = cached.resolve_with_codex(None, Some("account-a"));
        let disk_before = std::fs::read(dir.path().join("openai-codex-models-cache.json")).unwrap();
        assert!(cached
            .refresh_codex(&credentials("account-a"))
            .await
            .is_some());
        assert_eq!(cached.resolve_with_codex(None, Some("account-a")), before);
        assert_eq!(
            std::fs::read(dir.path().join("openai-codex-models-cache.json")).unwrap(),
            disk_before
        );
        assert_eq!(server.request_count(), 2);
    }
}

#[tokio::test]
async fn disconnected_server_preserves_the_last_good_catalog() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/models", listener.local_addr().unwrap());
    drop(listener);
    let dir = tempfile::tempdir().unwrap();
    write_expired_snapshot(dir.path(), &url, "account-a", &payload("gpt-last-good"));
    let catalog = catalog(dir.path(), &url);
    let before = catalog.resolve_with_codex(None, Some("account-a"));
    assert!(catalog
        .refresh_codex(&credentials("account-a"))
        .await
        .is_some());
    assert_eq!(catalog.resolve_with_codex(None, Some("account-a")), before);
}

#[tokio::test]
async fn account_switch_and_logout_never_expose_another_accounts_models() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![
        common::ok_json(payload("gpt-account-a").to_string(), None),
        common::ok_json(payload("gpt-account-b").to_string(), None),
    ])
    .await;
    let url = server.url("/models");
    let active = catalog(dir.path(), &url);
    let fallback = active.resolve(None);
    active
        .refresh_codex(&credentials("account-a"))
        .await
        .unwrap();
    let account_a = active.resolve_with_codex(None, Some("account-a"));
    assert_ne!(account_a, fallback);
    assert_eq!(active.resolve_with_codex(None, None), fallback);
    assert_eq!(active.resolve_with_codex(None, Some("account-b")), fallback);
    let reloaded = catalog(dir.path(), &url);
    assert_eq!(
        reloaded.resolve_with_codex(None, Some("account-b")),
        fallback
    );
    assert_eq!(
        reloaded.resolve_with_codex(None, Some("account-a")),
        account_a
    );

    active
        .refresh_codex(&credentials("account-b"))
        .await
        .unwrap();
    let account_b = active.resolve_with_codex(None, Some("account-b"));
    assert!(account_b.iter().any(|model| model.id == "gpt-account-b"));
    assert!(!account_b.iter().any(|model| model.id == "gpt-account-a"));
    assert_eq!(active.resolve_with_codex(None, Some("account-a")), fallback);
    assert_eq!(
        server.request_count(),
        2,
        "a new account bypasses the previous account's TTL"
    );
    let snapshot =
        std::fs::read_to_string(dir.path().join("openai-codex-models-cache.json")).unwrap();
    assert!(
        !snapshot.contains("token-account"),
        "credentials must not be persisted"
    );
}

#[test]
fn offline_refresh_serves_disk_and_compiled_models_without_http() {
    // Run the environment-dependent path in its own process, so parallel
    // online tests cannot observe PI_OFFLINE and ambient state stays intact.
    const CHILD: &str = "PA_CODEX_OFFLINE_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "offline_refresh_serves_disk_and_compiled_models_without_http",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("PI_OFFLINE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let server = common::MockServer::start(vec![common::ok_json(
            payload("gpt-online-only").to_string(),
            None,
        )])
        .await;
        let url = server.url("/models");
        let empty = catalog(dir.path(), &url);
        let fallback = empty.resolve(None);
        assert!(empty
            .refresh_codex(&credentials("account-a"))
            .await
            .is_none());
        assert_eq!(empty.resolve_with_codex(None, Some("account-a")), fallback);
        write_expired_snapshot(
            dir.path(),
            &url,
            "account-a",
            &payload("gpt-offline-cached"),
        );
        let cached = catalog(dir.path(), &url);
        let before = cached.resolve_with_codex(None, Some("account-a"));
        assert!(before.iter().any(|model| model.id == "gpt-offline-cached"));
        assert!(cached
            .refresh_codex(&credentials("account-a"))
            .await
            .is_some());
        assert_eq!(cached.resolve_with_codex(None, Some("account-a")), before);
        assert_eq!(server.request_count(), 0);
    });
}

#[tokio::test]
async fn max_context_window_is_used_when_context_window_is_absent() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = payload("gpt-larger-context");
    body["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("context_window");
    body["models"][0]["max_context_window"] = json!(1_000_000);
    let server = common::MockServer::start(vec![common::ok_json(body.to_string(), None)]).await;
    let catalog = catalog(dir.path(), &server.url("/models"));
    let models = catalog
        .refresh_codex(&credentials("account-a"))
        .await
        .unwrap();
    assert_eq!(models[0].context_window, 1_000_000);
}

#[tokio::test]
async fn missing_reasoning_metadata_preserves_known_model_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let body = json!({"models": [{
        "slug": "gpt-5.1", "display_name": "GPT-5.1", "visibility": "list"
    }]});
    let server = common::MockServer::start(vec![common::ok_json(body.to_string(), None)]).await;
    let catalog = catalog(dir.path(), &server.url("/models"));
    let expected: Vec<_> = catalog
        .resolve(None)
        .into_iter()
        .filter(|model| model.provider == "openai-codex" && model.id == "gpt-5.1")
        .collect();
    assert_eq!(expected.len(), 1);
    assert_eq!(
        catalog.refresh_codex(&credentials("account-a")).await,
        Some(expected)
    );
}

#[tokio::test]
async fn revoked_codex_credentials_discard_the_account_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![common::status(401, "Unauthorized")]).await;
    let url = server.url("/models");
    write_expired_snapshot(dir.path(), &url, "account-a", &payload("gpt-revoked"));
    let catalog = catalog(dir.path(), &url);
    assert!(catalog
        .resolve_with_codex(None, Some("account-a"))
        .iter()
        .any(|model| model.id == "gpt-revoked"));
    assert!(catalog
        .refresh_codex(&credentials("account-a"))
        .await
        .is_none());
    assert_eq!(
        catalog.resolve_with_codex(None, Some("account-a")),
        catalog.resolve(None)
    );
    assert!(!dir.path().join("openai-codex-models-cache.json").exists());
}

#[tokio::test]
async fn remote_entries_cannot_change_transport_or_list_hidden_models() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = payload("gpt-visible");
    body["models"][0]["baseUrl"] = json!("https://untrusted.invalid");
    body["models"][0]["headers"] = json!({"Authorization": "untrusted"});
    let hidden = json!({"slug": "gpt-hidden", "display_name": "Hidden", "visibility": "hide"});
    body["models"]
        .as_array_mut()
        .unwrap()
        .extend([hidden, json!({"slug": "gpt-malformed"})]);
    let server = common::MockServer::start(vec![common::ok_json(body.to_string(), None)]).await;
    let catalog = catalog(dir.path(), &server.url("/models"));
    let models = catalog
        .refresh_codex(&credentials("account-a"))
        .await
        .unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| (
                model.id.as_str(),
                model.provider.as_str(),
                model.api.as_str(),
                model.base_url.as_str(),
                model.headers.as_ref()
            ))
            .collect::<Vec<_>>(),
        vec![(
            "gpt-visible",
            "openai-codex",
            "openai-codex-responses",
            "https://chatgpt.com/backend-api",
            None
        )]
    );
}

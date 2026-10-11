//! Codex catalog integration through the auth-aware model registry.

mod common;

use std::sync::Arc;

use pa_core::auth::{AuthCredential, AuthStorage, AuthStorageData, OAuthIntegration};
use pa_core::models::{install_catalog, ModelRegistry};
use pa_models::ModelCatalog;
use serde_json::json;

struct RefreshCodex;

impl OAuthIntegration for RefreshCodex {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            AuthCredential::ApiKey { .. } | AuthCredential::McpStaticToken { .. } => None,
        }
    }

    fn refresh(&self, _provider: &str, _credentials: &AuthStorageData) -> Option<AuthCredential> {
        serde_json::from_value(json!({
            "type": "oauth", "access": "fresh-access", "refresh": "refresh-token",
            "expires": 9_000_000_000_000_i64, "accountId": "injected-account"
        }))
        .ok()
    }
}

#[tokio::test]
async fn registry_preserves_injected_auth_and_custom_overrides_for_new_codex_models() {
    let dir = tempfile::tempdir().unwrap();
    let public = common::MockServer::start(vec![common::status(503, "Unavailable")]).await;
    let codex = common::MockServer::start(vec![common::ok_json(
        &json!({"models": [{
            "slug": "gpt-codex-live-probe", "display_name": "Live probe",
            "visibility": "list", "context_window": 400_000,
            "supported_reasoning_levels": [{"effort": "high"}],
            "input_modalities": ["text", "image"]
        }]})
        .to_string(),
        None,
    )])
    .await;
    let catalog = ModelCatalog::with_urls(
        Some(dir.path().join("models")),
        Some(dir.path().into()),
        &public.url("/catalog"),
        &public.url("/api/v1"),
    )
    .with_codex_url(&codex.url("/models"));
    let models_path = dir.path().join("models.json");
    install_catalog(&models_path, Arc::new(catalog));
    std::fs::write(&models_path, json!({"providers": {"openai-codex": {
        "modelOverrides": {"gpt-codex-live-probe": {"name": "My live model", "contextWindow": 123_456}}
    }}}).to_string()).unwrap();
    let data = AuthStorageData(
        json!({"openai-codex": {
            "type": "oauth", "access": "expired-access", "refresh": "refresh-token",
            "expires": 1, "accountId": "injected-account"
        }})
        .as_object()
        .unwrap()
        .clone(),
    );
    let auth = AuthStorage::in_memory_without_env(&data, Arc::new(RefreshCodex));
    let mut registry = ModelRegistry::create(auth, models_path);
    assert!(!registry
        .get_all()
        .iter()
        .any(|model| model.id == "gpt-codex-live-probe"));

    registry.refresh_available_models().await;

    let live = registry
        .get_rlm_searchable_models()
        .into_iter()
        .find(|model| model.id == "gpt-codex-live-probe")
        .expect("injected OAuth refresh discovers the new Codex model");
    assert_eq!(
        (live.name.as_str(), live.context_window),
        ("My live model", 123_456)
    );
    let requests = codex.recorded_requests();
    assert_eq!(requests.len(), 1);
    let head = requests[0].to_ascii_lowercase();
    assert!(
        head.contains("authorization: bearer fresh-access"),
        "{head}"
    );
    assert!(
        head.contains("chatgpt-account-id: injected-account"),
        "{head}"
    );
}

#[tokio::test]
async fn startup_returns_while_codex_discovery_never_replies() {
    use pa_core::models::startup_refresh;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    let dir = tempfile::tempdir().unwrap();
    let public = common::MockServer::start(vec![common::status(503, "Unavailable")]).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/models", listener.local_addr().unwrap());
    let catalog = ModelCatalog::with_urls(
        Some(dir.path().join("models")),
        Some(dir.path().into()),
        &public.url("/catalog"),
        &public.url("/api/v1"),
    )
    .with_codex_url(&url);
    install_catalog(&dir.path().join("models.json"), Arc::new(catalog));
    std::fs::write(
        dir.path().join("auth.json"),
        json!({"openai-codex": {
            "type": "oauth", "access": "test-access", "refresh": "test-refresh",
            "expires": 9_000_000_000_000_i64, "accountId": "test-account"
        }})
        .to_string(),
    )
    .unwrap();

    let agent_dir = dir.path().to_path_buf();
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::task::spawn_blocking(move || startup_refresh(&agent_dir)),
    )
    .await
    .expect("startup does not wait for Codex discovery")
    .unwrap();
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(1), listener.accept())
        .await
        .expect("startup starts Codex discovery")
        .unwrap();
    let mut request = vec![0; 8192];
    let read = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut request))
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&request[..read]).contains("GET /models"));
    // The endpoint holds the connection without answering while the registry serves fallback.
    let registry = ModelRegistry::create(
        AuthStorage::create(dir.path()),
        dir.path().join("models.json"),
    );
    assert!(registry
        .get_available()
        .iter()
        .any(|model| model.provider == "openai-codex"));
}

#[test]
fn offline_registry_does_not_refresh_expired_oauth() {
    if std::env::var_os("CODEX_OFFLINE_TEST_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "offline_registry_does_not_refresh_expired_oauth",
                "--nocapture",
            ])
            .env("CODEX_OFFLINE_TEST_CHILD", "1")
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
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let data = AuthStorageData(
            json!({"openai-codex": {
                "type": "oauth", "access": "expired-access", "refresh": "refresh-token",
                "expires": 1, "accountId": "injected-account"
            }})
            .as_object()
            .unwrap()
            .clone(),
        );
        let auth = AuthStorage::in_memory_without_env(&data, Arc::new(RefreshCodex));
        let mut registry = ModelRegistry::in_memory(auth);
        registry.refresh_available_models().await;
        assert_eq!(
            registry.auth.get_all().0,
            data.0,
            "offline leaves expired OAuth unchanged"
        );
        assert!(registry
            .get_all()
            .iter()
            .any(|model| model.provider == "openai-codex"));
    });
}

#[tokio::test]
async fn registry_does_not_send_runtime_api_key_with_stored_codex_account() {
    let dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![common::status(503, "Unavailable")]).await;
    let catalog = ModelCatalog::with_urls(
        Some(dir.path().join("models")),
        Some(dir.path().into()),
        &server.url("/catalog"),
        &server.url("/api/v1"),
    )
    .with_codex_url(&server.url("/codex-models"));
    let models_path = dir.path().join("models.json");
    install_catalog(&models_path, Arc::new(catalog));
    let data = AuthStorageData(
        json!({"openai-codex": {
            "type": "oauth", "access": "stored-access", "refresh": "refresh-token",
            "expires": 9_000_000_000_000_i64, "accountId": "stored-account"
        }})
        .as_object()
        .unwrap()
        .clone(),
    );
    let mut auth = AuthStorage::in_memory_without_env(&data, Arc::new(RefreshCodex));
    auth.set_runtime_api_key("openai-codex", "runtime-api-key".into());
    let mut registry = ModelRegistry::create(auth, models_path);
    registry.refresh_available_models().await;
    let requests = server.recorded_requests();
    assert!(
        requests
            .iter()
            .all(|request| !request.contains("/codex-models")),
        "{requests:#?}"
    );
}

#[tokio::test]
async fn runtime_api_key_does_not_select_stored_oauth_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let server =
        common::MockServer::start(vec![common::ok_json(&json!({"models": [{
        "slug": "gpt-codex-account-probe", "display_name": "Account probe", "visibility": "list"
    }]}).to_string(), None)])
        .await;
    let catalog = Arc::new(
        ModelCatalog::with_urls(
            Some(dir.path().join("models")),
            Some(dir.path().into()),
            &server.url("/catalog"),
            &server.url("/api/v1"),
        )
        .with_codex_url(&server.url("/codex-models")),
    );
    catalog
        .refresh_codex(&pa_models::CodexCredentials {
            access_token: "stored-access".into(),
            account_id: "stored-account".into(),
        })
        .await
        .expect("seed live account snapshot");
    let models_path = dir.path().join("models.json");
    install_catalog(&models_path, catalog);
    let data = AuthStorageData(
        json!({"openai-codex": {
            "type": "oauth", "access": "stored-access", "refresh": "refresh-token",
            "expires": 9_000_000_000_000_i64, "accountId": "stored-account"
        }})
        .as_object()
        .unwrap()
        .clone(),
    );
    let auth = AuthStorage::in_memory_without_env(&data, Arc::new(RefreshCodex));
    let mut registry = ModelRegistry::create(auth, models_path);
    assert!(registry
        .get_all()
        .iter()
        .any(|model| model.id == "gpt-codex-account-probe"));
    registry
        .auth
        .set_runtime_api_key("openai-codex", "runtime-api-key".into());
    registry.refresh();
    assert!(
        !registry
            .get_all()
            .iter()
            .any(|model| model.id == "gpt-codex-account-probe"),
        "runtime credential must not select stored OAuth account snapshot"
    );
}

use super::select_model;
use crate::mode::RuntimeConfig;
use pa_core::auth::{AuthStorage, AuthStorageData, NoOAuth};
use pa_core::models::ModelRegistry;
use pa_core::session::SessionContext;
use pa_types::ai::{UserContent, UserMessage};
use pa_types::session::AgentMessage;
use serde_json::json;
use std::sync::Arc;

fn fixture(settings: &serde_json::Value) -> (tempfile::TempDir, RuntimeConfig, ModelRegistry) {
    let dir = tempfile::tempdir().unwrap();
    let config = RuntimeConfig {
        cwd: dir.path().join("project"),
        agent_dir: dir.path().join("agent"),
        ..Default::default()
    };
    std::fs::create_dir_all(&config.cwd).unwrap();
    std::fs::create_dir_all(&config.agent_dir).unwrap();
    std::fs::write(config.agent_dir.join("settings.json"), settings.to_string()).unwrap();
    let path = config.agent_dir.join("models.json");
    std::fs::write(&path, json!({"providers": {
        "my-gateway": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": "synthetic-only",
            "api": "openai-completions", "compat": {"thinkingFormat":"zai", "zaiToolStream":true}, "models": [{"id": "my-group/my-model"}, {"id": "other"}]},
        "other-gateway": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": "synthetic-only",
            "api": "openai-completions", "models": [{"id": "other"}]}
    }}).to_string()).unwrap();
    let auth = AuthStorage::in_memory_without_env(&AuthStorageData::default(), Arc::new(NoOAuth));
    let registry = ModelRegistry::create(auth, path);
    (dir, config, registry)
}

#[tokio::test]
async fn print_model_uses_saved_gateway_and_full_model_metadata() {
    for id in ["my-group/my-model", "my-gateway/my-group/my-model"] {
        let (_dir, config, mut registry) = fixture(&json!({
            "defaultProvider":"my-gateway", "defaultModel":id
        }));
        let expected = registry
            .get_all()
            .iter()
            .find(|m| m.provider == "my-gateway" && m.id == "my-group/my-model")
            .unwrap()
            .clone();
        assert_eq!(
            select_model(&mut registry, &config, None).await.unwrap(),
            expected
        );
    }
}

#[tokio::test]
async fn print_model_explicit_and_partial_flags_override_defaults() {
    for (provider, model, expected) in [
        (
            Some("other-gateway"),
            Some("other"),
            ("other-gateway", "other"),
        ),
        (
            None,
            Some("other-gateway/other"),
            ("other-gateway", "other"),
        ),
        (
            Some("my-gateway"),
            None,
            ("my-gateway", "my-group/my-model"),
        ),
        (Some("other-gateway"), None, ("other-gateway", "other")),
    ] {
        let (_dir, mut config, mut registry) =
            fixture(&json!({"defaultProvider":"my-gateway", "defaultModel":"my-group/my-model"}));
        config.provider = provider.map(str::to_string);
        config.model = model.map(str::to_string);
        let selected = select_model(&mut registry, &config, None).await.unwrap();
        assert_eq!((selected.provider.as_str(), selected.id.as_str()), expected);
    }
}

#[tokio::test]
async fn print_model_invalid_saved_or_explicit_selection_fails_locally() {
    for settings in [
        json!({"defaultProvider":"missing", "defaultModel":"missing"}),
        json!({"defaultProvider":"my-gateway", "defaultModel":"missing"}),
    ] {
        let (_dir, config, mut registry) = fixture(&settings);
        assert!(select_model(&mut registry, &config, None).await.is_err());
    }
    let (_dir, mut config, mut registry) = fixture(&json!({}));
    config.provider = Some("missing".into());
    assert!(select_model(&mut registry, &config, None).await.is_err());
}

#[tokio::test]
async fn print_model_without_configured_auth_does_not_select_a_bundled_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let auth = AuthStorage::in_memory_without_env(&AuthStorageData::default(), Arc::new(NoOAuth));
    let mut registry = ModelRegistry::create(auth, dir.path().join("models.json"));
    let config = RuntimeConfig {
        cwd: dir.path().into(),
        agent_dir: dir.path().into(),
        ..Default::default()
    };
    assert!(select_model(&mut registry, &config, None).await.is_err());
}

#[tokio::test]
async fn print_model_only_flag_preserves_catalog_resolution_without_saved_provider() {
    let (_dir, mut config, mut registry) =
        fixture(&json!({"defaultProvider":"my-gateway", "defaultModel":"my-group/my-model"}));
    config.model = Some("other".into());
    let available = registry
        .get_available()
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    let expected = pa_core::models::resolve_cli_model(None, "other", &available)
        .model
        .unwrap();
    assert_eq!(
        select_model(&mut registry, &config, None).await.unwrap(),
        expected
    );
}

#[tokio::test]
async fn print_model_saved_private_id_cannot_reuse_another_private_route() {
    let (_dir, config, _) = fixture(&json!({
        "defaultProvider":"prime-inference", "defaultModel":"internal/not-authorized"
    }));
    let models_path = config.agent_dir.join("models.json");
    std::fs::write(&models_path, json!({"providers": {"prime-inference": {
        "baseUrl":"http://127.0.0.1:9/v1", "api":"openai-completions", "apiKey":"synthetic-only",
        "models":[{"id":"internal/authorized-fixture"}]
    }}}).to_string()).unwrap();
    let auth = AuthStorage::in_memory_without_env(&AuthStorageData::default(), Arc::new(NoOAuth));
    let mut registry = ModelRegistry::create(auth, models_path);
    assert!(registry
        .get_available()
        .iter()
        .any(|m| m.id == "internal/authorized-fixture"));
    assert!(select_model(&mut registry, &config, None).await.is_err());
}

#[tokio::test]
async fn print_model_unauthenticated_default_does_not_switch_to_another_gateway() {
    let (_dir, config, mut registry) = fixture(&json!({}));
    let unauthenticated_model = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "anthropic")
        .unwrap()
        .clone();
    std::fs::write(
        config.agent_dir.join("settings.json"),
        json!({
            "defaultProvider": unauthenticated_model.provider,
            "defaultModel": unauthenticated_model.id,
        })
        .to_string(),
    )
    .unwrap();
    assert!(registry
        .get_available()
        .iter()
        .any(|m| m.provider == "other-gateway"));
    assert!(select_model(&mut registry, &config, None).await.is_err());
}

/// One open session's active context: a message plus, when given, the
/// session's saved model.
fn session_context(model: Option<(&str, &str)>) -> SessionContext {
    SessionContext {
        messages: vec![AgentMessage::User(UserMessage {
            content: UserContent::Text("resume me".into()),
            timestamp: 0,
            rest: pa_types::JsonMap::new(),
        })],
        thinking_level: "off".into(),
        service_tier: None,
        model: model.map(|(provider, id)| (provider.to_string(), id.to_string())),
    }
}

#[tokio::test]
async fn print_model_resumes_the_session_model_over_a_stale_saved_default() {
    let (_dir, config, mut registry) = fixture(&json!({
        "defaultProvider": "my-gateway", "defaultModel": "missing"
    }));
    let context = session_context(Some(("my-gateway", "my-group/my-model")));
    let expected = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "my-gateway" && model.id == "my-group/my-model")
        .cloned()
        .unwrap();
    assert_eq!(
        select_model(&mut registry, &config, Some(&context))
            .await
            .unwrap(),
        expected
    );
}

#[tokio::test]
async fn print_model_explicit_flag_wins_over_the_session_model() {
    let (_dir, mut config, mut registry) = fixture(&json!({
        "defaultProvider": "my-gateway", "defaultModel": "my-group/my-model"
    }));
    config.model = Some("other-gateway/other".into());
    let context = session_context(Some(("my-gateway", "other")));
    let selected = select_model(&mut registry, &config, Some(&context))
        .await
        .unwrap();
    assert_eq!(
        (selected.provider.as_str(), selected.id.as_str()),
        ("other-gateway", "other")
    );
}

#[tokio::test]
async fn print_model_provider_only_settings_default_does_not_scope() {
    let (_dir, config, mut registry) = fixture(&json!({"defaultProvider": "other-gateway"}));
    let selected = select_model(&mut registry, &config, None).await.unwrap();
    assert_eq!(
        (selected.provider.as_str(), selected.id.as_str()),
        ("my-gateway", "my-group/my-model")
    );
}

use std::sync::Arc;

use serde_json::{json, Value};

use super::{InMemorySettingsStorage, SettingsManager, SettingsScope, SettingsStorage};

fn fixture(content: &str) -> (Arc<InMemorySettingsStorage>, SettingsManager) {
    let storage = Arc::new(InMemorySettingsStorage::default());
    storage
        .with_lock(SettingsScope::Global, &mut |_| Some(content.to_string()))
        .unwrap();
    let manager = SettingsManager::from_storage(storage.clone());
    (storage, manager)
}

fn document(storage: &dyn SettingsStorage) -> Value {
    serde_json::from_str(&storage.read(SettingsScope::Global).unwrap().unwrap()).unwrap()
}

#[test]
fn model_switch_preserves_a_document_that_failed_to_load() {
    for content in ["{\"theme\":\"light\",}", "\u{feff}{\"theme\":\"light\"}"] {
        let (storage, mut manager) = fixture(content);
        manager
            .set_default_model_and_provider("openai", "model")
            .unwrap();
        assert_eq!(
            storage.read(SettingsScope::Global).unwrap().as_deref(),
            Some(content)
        );
        assert!(manager
            .errors()
            .iter()
            .any(|error| error.message.contains("not saved")));
        assert_eq!(manager.get_default_model(), Some("model"));
    }
}

#[test]
fn chat_detail_save_changes_only_the_requested_setting() {
    let (storage, mut manager) = fixture(r#"{"theme":"light","pluginSetting":{"keep":true}}"#);
    manager.set_chat_detail("details").unwrap();
    assert_eq!(
        document(storage.as_ref()),
        json!({
            "theme":"light", "pluginSetting":{"keep":true}, "chatDetail":"details"
        })
    );
}

#[test]
fn stale_managers_preserve_other_writers_and_explicit_same_value_choices() {
    let (storage, mut first) =
        fixture(r#"{"theme":"light","telemetry":{"enabled":false,"futureSetting":"keep"}}"#);
    let mut second = SettingsManager::from_storage(storage.clone());
    second.set_theme("dark".into()).unwrap();
    second.set_telemetry_notice_shown(true).unwrap();
    first.set_theme("light".into()).unwrap();
    first.set_telemetry_enabled(true).unwrap();
    second.set_quiet_startup(true).unwrap();
    assert_eq!(
        document(storage.as_ref()),
        json!({
            "theme":"light", "quietStartup":true,
            "telemetry":{"enabled":true,"noticeShown":true,"futureSetting":"keep"}
        })
    );
}

#[test]
fn saves_preserve_a_document_corrupted_after_load() {
    let (storage, mut manager) = fixture(r#"{"theme":"light"}"#);
    for content in ["{bad", "[]", "null"] {
        storage
            .with_lock(SettingsScope::Global, &mut |_| Some(content.into()))
            .unwrap();
        assert!(manager.set_theme("dark".into()).is_err());
        assert_eq!(
            storage.read(SettingsScope::Global).unwrap().as_deref(),
            Some(content)
        );
    }
    storage
        .with_lock(SettingsScope::Global, &mut |_| {
            Some(r#"{"external":"keep"}"#.into())
        })
        .unwrap();
    manager.set_quiet_startup(true).unwrap();
    assert_eq!(
        document(storage.as_ref()),
        json!({
            "external":"keep", "theme":"dark", "quietStartup":true
        })
    );
}

#[test]
fn resource_save_preserves_a_document_corrupted_after_load() {
    let (storage, mut manager) = fixture("{}");
    storage
        .with_lock(SettingsScope::Global, &mut |_| Some("{bad".into()))
        .unwrap();
    manager.set_global_resource_array("skills", vec!["new".into()]);
    assert_eq!(
        storage.read(SettingsScope::Global).unwrap().as_deref(),
        Some("{bad")
    );
    assert!(manager
        .errors()
        .iter()
        .any(|error| error.message.contains("not saved")));
}

#[test]
fn clearing_a_setting_removes_only_that_key() {
    let (storage, mut manager) = fixture(r#"{"enabledModels":["old"],"theme":"light"}"#);
    manager.set_enabled_models(None).unwrap();
    assert_eq!(document(storage.as_ref()), json!({"theme":"light"}));
}

#[test]
fn resource_save_survives_an_unrelated_later_save() {
    let (storage, mut manager) = fixture("{}");
    manager.set_packages(vec![json!("first")]);
    let mut other = SettingsManager::from_storage(storage.clone());
    other.set_packages(vec![json!("second")]);
    manager.set_theme("dark".into()).unwrap();
    assert_eq!(
        document(storage.as_ref()),
        json!({"packages":["second"],"theme":"dark"})
    );
}

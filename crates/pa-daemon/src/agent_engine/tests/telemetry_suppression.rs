use super::*;

#[test]
fn faux_runs_cannot_install_telemetry_even_with_an_explicit_opt_in() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    write_compaction_settings(dir.path(), 16_384);
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        faux_script: Some(serde_json::json!({"responses": [{"text": "test reply"}]}).to_string()),
        telemetry_disabled: Some(false),
        ..bare_engine(dir.path()).config
    })
    .unwrap();
    assert_eq!(engine.config.telemetry_disabled, Some(true));
    let mut events = Vec::new();
    admit(&engine, "hello".to_string(), &mut events);
    assert!(events
        .iter()
        .any(|event| matches!(event, EngineEvent::AssistantMessage(_))));
    let session = engine.runtime.block_on(engine.session.lock());
    assert!(session
        .as_ref()
        .expect("real core engine was built")
        .telemetry
        .is_none());
    engine
        .model_refusal_telemetry
        .note_refused("spawn", "zai/glm-5.3", dir.path());
    assert!(!dir.path().join("agent/telemetry.json").exists());
    assert!(!dir.path().join("agent/telemetry.jsonl").exists());
}

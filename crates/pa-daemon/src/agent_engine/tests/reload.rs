//! `/reload`'s session half: the MCP manager's live inputs re-read from
//! the store. Request auth needs no rebind pins — the live session's
//! stream re-resolves it from the credential store on every provider
//! call (the `live_auth` battery owns those).
use super::*;

/// A reload over a malformed auth store reports the failure: the store
/// cannot be parsed, so the MCP manager keeps its previous credentials
/// and the reload answers with the storage error instead of a success
/// the session did not apply.
#[test]
fn reload_reports_the_auth_store_failure() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(agent_dir.join("auth.json"), "not json").unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .expect("engine");
    let error = engine
        .reload_live_inputs()
        .expect_err("the malformed store fails the reload");
    assert!(!error.is_empty(), "the reload surfaces the storage error");
    // A repaired store reloads cleanly again.
    std::fs::write(dir.path().join("agent").join("auth.json"), "{}").unwrap();
    engine
        .reload_live_inputs()
        .expect("the repaired store reloads");
}

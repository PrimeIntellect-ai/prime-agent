//! The create-command contract at the daemon wire: provider/model flags
//! riding the config, the duplicate-name refusal, and the continue-recent
//! refusal.

use super::*;

/// Explicit `--provider`/`--model` flags are authoritative for the worker's
/// model resolution — no process-wide fallback may answer instead.
#[test]
fn create_config_model_flags_reach_the_worker_engine() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon-flags.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // A models.json custom provider whose name has no env-key mapping: the
    // only way the worker can resolve it is the wire config.
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command(
        "c1",
        &serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "provider": "battery",
                "model": "mock-1",
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    client.send_command(
        "s1",
        &serde_json::json!({ "type": "get_session_stats", "activeSessionId": session_id }),
    );
    let stats = client.read_response("s1");
    assert_eq!(stats["success"], true, "get_session_stats failed: {stats}");
    assert_eq!(
        stats["data"]["contextUsage"]["contextWindow"], 128_000,
        "context usage reflects the wire-flagged model: {stats}"
    );
}

#[test]
fn create_path_duplicate_name_fails_with_current_ts_string() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [ { "text": "ok" } ] }).to_string(),
    )
    .expect("write script");

    client.send_command(
        "c1",
        &serde_json::json!({
            "type": "create",
            "name": "dup",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "first create failed: {created}");

    // The TS string (`formatAgentSessionNameUnavailable`): the CLI's
    // auto-rename retry keys off the `Agent name "..." is unavailable` prefix.
    client.send_command(
        "c2",
        &serde_json::json!({
            "type": "create",
            "name": "dup",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let rejected = client.read_response("c2");
    assert_eq!(
        rejected["success"], false,
        "duplicate create succeeded: {rejected}"
    );
    assert_eq!(rejected["command"], "create");
    assert_eq!(
        rejected["error"],
        "Agent name \"dup\" is unavailable: an agent of that name already exists at depth 0 under this parent"
    );

    // An empty name keeps its own error (worker-side parity string).
    client.send_command(
        "c3",
        &serde_json::json!({
            "type": "create",
            "name": "  ",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let empty = client.read_response("c3");
    assert_eq!(
        empty["success"], false,
        "empty-name create succeeded: {empty}"
    );
    assert_eq!(empty["error"], "Session name cannot be empty");
}

/// A sanctioned divergence: the TS worker resolves `continueRecent` to the
/// newest saved session for the cwd (any session on a shared dir, including
/// one whose context and scheduled jobs resurrect); the daemon refuses the
/// blind-resume form, and a create without the field still succeeds.
#[test]
fn create_with_continue_recent_is_refused() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // A saved session exists, so the refusal is the contract, not the
    // empty-dir error it replaces.
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    let cwd = dir.path().display().to_string();
    let saved = session_dir.join("saved00000000000000000000000001.jsonl");
    std::fs::write(
        &saved,
        format!(
            concat!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"saved00000000000000000000000001\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"{cwd}\"}}\n"
            ),
            cwd = cwd,
        ),
    )
    .expect("write saved session");

    client.send_command(
        "c1",
        &serde_json::json!({
            "type": "create",
            "continueRecent": true,
            "config": {
                "cwd": cwd,
                "sessionDir": session_dir.display().to_string(),
            },
        }),
    );
    let refused = client.read_response("c1");
    assert_eq!(
        refused["success"], false,
        "the blind continue-recent create succeeded: {refused}"
    );
    assert_eq!(refused["command"], "create");
    assert_eq!(
        refused["error"],
        "continueRecent is not supported: pass sessionPath to reopen a session, or open one through the agents view"
    );

    client.send_command(
        "c2",
        &serde_json::json!({
            "type": "create",
            "config": {
                "cwd": cwd,
                "sessionDir": session_dir.display().to_string(),
            },
        }),
    );
    let created = client.read_response("c2");
    assert_eq!(created["success"], true, "plain create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    assert_ne!(
        session_id, "saved00000000000000000000000001",
        "the plain create opened a fresh session, not the saved one"
    );
}

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

/// A cold reopen must discover project resources in the saved directory, even
/// when the caller (Agents View inline Reply) sends no cwd. An explicit fallback
/// or override must still win.
#[test]
fn cold_reopen_uses_saved_cwd_unless_explicitly_overridden() {
    let dir = tempfile::tempdir_in("/tmp").expect("temp dir");
    let project = dir.path().join("project ! saved");
    let override_dir = dir.path().join("override");
    let agent_dir = dir.path().join("agent");
    for path in [&project, &override_dir, &agent_dir] {
        std::fs::create_dir_all(path).expect("directory");
    }
    for path in [&project, &override_dir] {
        std::fs::write(path.join("AGENTS.md"), "CWD_REGRESSION_PROJECT_CONTEXT").unwrap();
        let skill = path.join(".agents/skills/cwd-regression");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: cwd-regression\ndescription: Cwd regression skill.\n---\nProject skill.\n",
        )
        .unwrap();
    }
    let socket = dir.path().join("daemon.sock");
    let alias = dir.path().join("project-alias");
    std::os::unix::fs::symlink(&project, &alias).unwrap();
    let _daemon = spawn_daemon_in(&socket, &agent_dir, dir.path());
    let (mut client, _) = Client::connect(&socket);
    for (index, (explicit, relative, recorded)) in [
        (true, false, &project),
        (false, false, &project),
        (false, true, &project),
        (false, false, &alias),
        (true, true, &project),
    ]
    .into_iter()
    .enumerate()
    {
        let file_dir = if explicit && relative {
            &override_dir
        } else {
            dir.path()
        };
        let saved = file_dir.join(format!("saved-{index}.jsonl"));
        std::fs::write(
            &saved,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session", "version": 3,
                    "id": format!("cwd-regression-{index}"),
                    "timestamp": "2026-10-12T00:00:00.000Z", "cwd": recorded,
                })
            ),
        )
        .expect("saved session");
        let mut config = serde_json::json!({});
        if explicit {
            config["cwd"] = serde_json::json!(override_dir);
        }
        client.send_command("resume", &serde_json::json!({
            "type": "create", "sessionPath": if relative { saved.file_name().unwrap().to_str().unwrap() } else { saved.to_str().unwrap() }, "config": config,
        }));
        let response = client.read_response("resume");
        assert_eq!(response["success"], true, "{response}");
        let expected = if explicit { &override_dir } else { recorded };
        assert_eq!(
            response["data"]["cwd"],
            serde_json::json!(expected),
            "{response}"
        );
        assert_eq!(
            response["data"]["sessionId"],
            format!("cwd-regression-{index}")
        );
        let active = &response["data"]["id"];
        client.send_command(
            "context",
            &serde_json::json!({
                "type": "get_system_prompt", "activeSessionId": active,
            }),
        );
        let context = client.read_response("context");
        assert_eq!(context["success"], true, "{context}");
        let prompt = context["data"]["systemPrompt"].as_str().unwrap();
        assert!(
            prompt.contains("CWD_REGRESSION_PROJECT_CONTEXT"),
            "{context}"
        );
        assert!(prompt.contains("cwd-regression"), "{context}");
        client.send_command(
            "pwd",
            &serde_json::json!({
                "type": "execute_bash_and_wait", "activeSessionId": active,
                "command": "pwd -P",
            }),
        );
        let pwd = client.read_response("pwd");
        assert_eq!(pwd["success"], true, "{pwd}");
        assert_eq!(
            pwd["data"]["output"].as_str().unwrap().trim(),
            expected.canonicalize().unwrap().to_str().unwrap()
        );
    }
    client.send_command("shutdown", &serde_json::json!({"type": "shutdown"}));
    assert_eq!(client.read_response("shutdown")["success"], true);
}

#[test]
fn missing_saved_cwd_requires_an_explicit_fallback() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let saved = dir.path().join("missing.jsonl");
    std::fs::write(
        &saved,
        format!(
            "{}\n",
            serde_json::json!({
                "type": "session", "version": 3, "id": "missing-cwd",
                "timestamp": "2026-10-12T00:00:00.000Z", "cwd": dir.path().join("gone"),
            })
        ),
    )
    .unwrap();
    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon_in(&socket, &agent_dir, dir.path());
    let (mut client, _) = Client::connect(&socket);
    client.send_command(
        "missing",
        &serde_json::json!({"type": "create", "sessionPath": saved}),
    );
    let missing = client.read_response("missing");
    assert_eq!(missing["success"], false, "{missing}");
    assert!(missing["error"]
        .as_str()
        .unwrap()
        .contains("Saved session directory is unavailable"));
    client.send_command(
        "fallback",
        &serde_json::json!({
            "type": "create", "sessionPath": saved, "config": {"cwd": dir.path()},
        }),
    );
    let fallback = client.read_response("fallback");
    assert_eq!(fallback["success"], true, "{fallback}");
    assert_eq!(fallback["data"]["cwd"], serde_json::json!(dir.path()));
    client.send_command("fresh", &serde_json::json!({"type": "create"}));
    let fresh = client.read_response("fresh");
    assert_eq!(fresh["success"], true, "{fresh}");
    assert_eq!(
        fresh["data"]["cwd"],
        serde_json::json!(dir.path().canonicalize().unwrap())
    );
    client.send_command("shutdown", &serde_json::json!({"type": "shutdown"}));
    assert_eq!(client.read_response("shutdown")["success"], true);
}

/// Uses a real Python kernel; only provider responses are scripted.
#[test]
#[ignore = "requires PRIME_AGENT_KERNEL_PYTHON with the kernel runtime installed"]
fn cold_reopen_python_kernel_uses_saved_cwd_and_explicit_override() {
    assert!(std::env::var_os("PRIME_AGENT_KERNEL_PYTHON").is_some());
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let project = dir.path().join("saved-project");
    let override_dir = dir.path().join("override");
    let agent_dir = dir.path().join("agent");
    for path in [&project, &override_dir, &agent_dir] {
        std::fs::create_dir_all(path).unwrap();
    }
    let script = dir.path().join("kernel.json");
    std::fs::write(&script, serde_json::json!({
        "engine": "faux", "responses": [
            {"content": [{"type": "toolCall", "name": "python_repl", "id": "kernel-cwd",
                "arguments": {"code": "import os, pathlib\npathlib.Path('kernel-cwd.txt').write_text(os.getcwd())\nprint(os.getcwd())"}}]},
            {"text": "done"}
        ]
    }).to_string()).unwrap();
    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon_in(&socket, &agent_dir, dir.path());
    let (mut client, _) = Client::connect(&socket);
    for (index, explicit) in [false, true].into_iter().enumerate() {
        let saved = dir.path().join(format!("kernel-{index}.jsonl"));
        std::fs::write(
            &saved,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session", "version": 3, "id": format!("kernel-cwd-{index}"),
                    "timestamp": "2026-10-12T00:00:00.000Z", "cwd": project,
                })
            ),
        )
        .unwrap();
        let mut config = serde_json::json!({"script": script});
        if explicit {
            config["cwd"] = serde_json::json!(override_dir);
        }
        client.send_command(
            "open",
            &serde_json::json!({
                "type": "create", "sessionPath": saved, "config": config,
            }),
        );
        let opened = client.read_response("open");
        assert_eq!(opened["success"], true, "{opened}");
        client.send_command(
            "python",
            &serde_json::json!({
                "type": "prompt_and_wait", "activeSessionId": opened["data"]["id"],
                "message": "Record the Python kernel working directory.",
            }),
        );
        let response = client.read_response("python");
        assert_eq!(response["success"], true, "{response}");
        let expected = if explicit { &override_dir } else { &project };
        let observed = std::fs::read_to_string(expected.join("kernel-cwd.txt"))
            .expect("the real Python tool wrote its relative-path cwd probe");
        assert_eq!(observed, expected.canonicalize().unwrap().to_str().unwrap());
    }
    client.send_command("shutdown", &serde_json::json!({"type": "shutdown"}));
    assert_eq!(client.read_response("shutdown")["success"], true);
}

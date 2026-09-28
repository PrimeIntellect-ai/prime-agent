// The Tier-C/D ruling (fleet-uniform, 2026-09-28): stack-resident futures
// by design on hot paths (boxing 130 fns is allocation-churn with zero
// correctness gain); the fn-length threshold is a style gate, not
// correctness (the harness fns are intentionally linear); 64-bit targets -
// the narrowing sits at OS/protocol boundaries where the values are
// bounded (pid syscalls, epoch/elapsed milliseconds, calendar math,
// guarded parses), and checked conversions would add panic paths where
// silent wrap was deliberate (the one genuinely-suspect family, args.rs's
// parse_positive_u32 lacking its u32::MAX bound, is flagged in the lane
// dossier for the conductor).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! ACP picker e2e (the TS #2455 port): `session/new` advertises the
//! standard `model` and `thought_level` select options, and
//! `session/set_config_option` applies selections — the effort picker
//! follows the selected model's supported levels, invalid values are
//! `-32602` invalid params, and real selections publish the
//! `config_option_update` notification.
//!
//! Both transports are covered: the in-process mode (the faux provider
//! with a models.json fixture model, so a switch is observable end to
//! end) and the daemon-attached mode (the worker's own wire commands).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_mins(1);

struct AcpChild {
    child: Child,
    stdin: std::process::ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
    /// Held so the child's cwd outlives the process.
    home: tempfile::TempDir,
}

impl AcpChild {
    /// Spawn the ACP binary with a models.json fixture in place before the
    /// process starts (discovery reads it through the registry).
    fn spawn_with_models(
        args: &[&str],
        script: &serde_json::Value,
        models_json: Option<serde_json::Value>,
        extra_env: &[(String, String)],
    ) -> AcpChild {
        let home = tempfile::TempDir::new().unwrap();
        let agent_dir = home.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        if let Some(models) = models_json {
            std::fs::write(agent_dir.join("models.json"), models.to_string()).unwrap();
        }
        let bin = env!("CARGO_BIN_EXE_prime-agent");
        let mut command = Command::new(bin);
        command
            .args(args)
            .env("HOME", home.path())
            // The CLI's agent dir (`PRIME_AGENT_CODING_AGENT_DIR`) is where
            // the registry reads models.json from; the runtime env name
            // rides along for the kernel-side paths.
            .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
            .env("PRIME_AGENT_AGENT_DIR", &agent_dir)
            .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string());
        for (key, value) in extra_env {
            command.env(key, value);
        }
        let mut child = command
            .current_dir(home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("binary present");
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        AcpChild {
            child,
            stdin,
            lines,
            next_id: 0,
            home,
        }
    }

    fn send(&mut self, frame: &Value) {
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: &Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        id
    }

    fn wait_response(&mut self, id: u64, timeout: Duration) -> (Value, Vec<Value>) {
        let deadline = Instant::now() + timeout;
        let mut notifications = Vec::new();
        loop {
            let timeout_left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !timeout_left.is_zero(),
                "timed out waiting for response {id}"
            );
            match self.lines.recv_timeout(timeout_left) {
                Ok(line) => {
                    let frame: Value = serde_json::from_str(&line).expect("valid JSON line");
                    if frame.get("id").and_then(Value::as_u64) == Some(id)
                        && (frame.get("result").is_some() || frame.get("error").is_some())
                    {
                        return (frame, notifications);
                    }
                    notifications.push(frame);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for response {id}")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("ACP server closed stdout")
                }
            }
        }
    }
}

impl Drop for AcpChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {},
        "clientInfo": { "name": "acp-e2e", "title": "ACP E2E", "version": "0.0.1" },
    })
}

/// The `config_option_update` notifications seen among a frame batch.
fn config_updates(notifications: &[Value]) -> Vec<Value> {
    notifications
        .iter()
        .filter(|frame| frame["params"]["update"]["sessionUpdate"] == "config_option_update")
        .cloned()
        .collect()
}

fn select_params(session_id: &str, config_id: &str, value: &Value) -> Value {
    json!({ "sessionId": session_id, "configId": config_id, "value": value })
}

fn shutdown_sandboxed_daemon(socket: &std::path::Path) {
    use std::io::Write as _;
    let Ok(mut stream) = pa_types::platform::transport::connect_blocking(socket) else {
        return;
    };
    let frame = format!(
            "{{\"type\":\"command\",\"id\":\"shutdown-test\",\"protocol\":{{\"name\":\"prime-agent.daemon\",\"version\":{}}},\"command\":{{\"type\":\"shutdown\"}}}}\n",
            pa_types::daemon::DAEMON_PROTOCOL_VERSION
        );
    let _ = stream.write_all(frame.as_bytes());
    let _ = stream.flush();
    std::thread::sleep(Duration::from_millis(300));
}

/// The models.json fixture: a second faux-provider model the pickers can
/// discover and switch to (the faux provider is registered under the
/// stable `faux` api, so requests against it stream through the scripted
/// provider).
fn faux_models_fixture() -> serde_json::Value {
    json!({
        "providers": {
            "faux": {
                "api": "faux",
                "baseUrl": "http://localhost:0",
                "apiKey": "sk-faux",
                "models": [
                    {
                        "id": "faux-1",
                        "name": "Faux Model",
                        "api": "faux",
                        "baseUrl": "http://localhost:0",
                        "reasoning": true,
                        "contextWindow": 128_000,
                        "maxTokens": 4_096,
                    },
                    {
                        "id": "plain-model",
                        "name": "Plain Model",
                        "api": "faux",
                        "baseUrl": "http://localhost:0",
                        "contextWindow": 128_000,
                        "maxTokens": 4_096,
                    },
                    {
                        // #2858's `gpt-5.3-chat-latest` shape: the coarse
                        // `reasoning` flag is false, but the map addresses
                        // `xhigh` — the map is the capability signal.
                        "id": "map-model",
                        "name": "Map Model",
                        "api": "faux",
                        "baseUrl": "http://localhost:0",
                        "reasoning": false,
                        "thinkingLevelMap": { "off": null, "xhigh": "xhigh" },
                        "contextWindow": 128_000,
                        "maxTokens": 4_096,
                    }
                ],
            },
            // A provider whose models discovery admits (the `authHeader`
            // config counts as configured request auth) but whose
            // credential cannot resolve at request time (a set-but-empty
            // env var is a missing credential): a switch to it must refuse
            // before anything moves, not install an unauthenticated
            // target.
            "locked": {
                "api": "faux",
                "baseUrl": "http://localhost:0",
                "authHeader": true,
                "apiKey": "PROBE_LOCKED_KEY",
                "models": [
                    {
                        "id": "locked-model",
                        "name": "Locked Model",
                        "api": "faux",
                        "baseUrl": "http://localhost:0",
                        "contextWindow": 128_000,
                        "maxTokens": 4_096,
                    }
                ],
            }
        }
    })
}

/// The in-process transport: the pickers are advertised at `session/new`,
/// applied through `session/set_config_option` (a real model switch —
/// the engine and the provider target follow), invalid values are invalid
/// params, and changes publish `config_option_update`.
#[test]
fn acp_in_process_config_option_advertises_and_applies() {
    let script = json!({
        "reasoning": true,
        "responses": ["one answer", "the switched model still streams"],
    });
    let mut client = AcpChild::spawn_with_models(
        &["--mode", "acp", "--no-session"],
        &script,
        Some(faux_models_fixture()),
        // The locked provider's credential reference resolves to nothing:
        // a set-but-empty env var is a missing credential.
        &[("PROBE_LOCKED_KEY".to_string(), String::new())],
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let result = &new_response["result"];
    let session_id = result["sessionId"].as_str().unwrap().to_string();

    // Both pickers advertised: the model select (current model always
    // selectable, the discovered fixture model listed) and the effort
    // select on the reasoning model's supported levels.
    let options = &result["configOptions"];
    assert_eq!(
        options.as_array().map(Vec::len),
        Some(2),
        "two options: {options}"
    );
    let model_option = &options[0];
    assert_eq!(model_option["id"], "model");
    assert_eq!(model_option["type"], "select");
    assert_eq!(model_option["category"], "model");
    assert_eq!(model_option["currentValue"], r#"["faux","faux-1"]"#);
    let values: Vec<Value> = model_option["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["value"].clone())
        .collect();
    assert!(
        values.contains(&json!(r#"["faux","plain-model"]"#)),
        "{values:?}"
    );
    let effort = &options[1];
    assert_eq!(effort["id"], "thought_level");
    assert_eq!(effort["category"], "thought_level");
    assert_eq!(effort["currentValue"], "medium");
    let levels: Vec<String> = effort["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["value"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(levels, vec!["off", "minimal", "low", "medium", "high"]);

    // A valid effort selection applies and publishes the change.
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "thought_level", &json!("high")),
    );
    let (response, notifications) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][1]["currentValue"], "high",
        "the effort picker follows the selection: {response}"
    );
    let updates = config_updates(&notifications);
    assert!(
        updates
            .iter()
            .any(|update| update["params"]["update"]["configOptions"][1]["currentValue"] == "high"),
        "the change publishes config_option_update: {notifications:?}"
    );

    // Invalid selections are invalid params with the TS reasons.
    for (config_id, value, reason) in [
        ("model", json!("missing"), "Unavailable model: missing"),
        (
            "thought_level",
            json!("sideways"),
            "Unsupported reasoning effort: sideways",
        ),
        (
            "unknown",
            json!("high"),
            "Invalid configuration option: unknown",
        ),
    ] {
        let select = client.request(
            "session/set_config_option",
            &select_params(&session_id, config_id, &value),
        );
        let (response, _) = client.wait_response(select, TIMEOUT);
        assert_eq!(response["error"]["code"], -32602, "{config_id}: {response}");
        assert_eq!(response["error"]["data"]["reason"], reason);
    }
    // An unknown session is invalid params, never an internal error.
    let select = client.request(
        "session/set_config_option",
        &select_params("missing-session", "thought_level", &json!("high")),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(
        response["error"]["data"]["reason"],
        "Unknown ACP session: missing-session"
    );

    // A real model switch: the plain model drops the effort picker (its
    // supported levels are `off` only) and the effort selection now
    // refuses.
    let plain = r#"["faux","plain-model"]"#;
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(plain)),
    );
    let (response, notifications) = client.wait_response(select, TIMEOUT);
    let options = &response["result"]["configOptions"];
    assert_eq!(options.as_array().map(Vec::len), Some(1), "{options}");
    assert_eq!(options[0]["currentValue"], plain, "{response}");
    let updates = config_updates(&notifications);
    assert!(
        updates
            .iter()
            .any(|update| update["params"]["update"]["configOptions"][0]["currentValue"] == plain),
        "the switch publishes config_option_update: {notifications:?}"
    );
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "thought_level", &json!("high")),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(
        response["error"]["data"]["reason"],
        "Unsupported reasoning effort: high"
    );

    // The switched session still turns: the provider target followed the
    // switch, so the next prompt streams on the selected model.
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hello" }] }),
    );
    let (prompt_response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");

    // Switching back restores the effort picker at the persisted default
    // (the level saved while the reasoning model was active).
    let reasoner = r#"["faux","faux-1"]"#;
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(reasoner)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    let options = &response["result"]["configOptions"];
    assert_eq!(options.as_array().map(Vec::len), Some(2), "{options}");
    assert_eq!(options[0]["currentValue"], reasoner);
    assert_eq!(options[1]["currentValue"], "high", "{options}");

    // The current model re-selected: refresh only, no discovery needed.
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(reasoner)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"],
        reasoner
    );

    // #2858's map-driven capability: the map model (`reasoning: false`
    // with an addressable `xhigh`) serves its effort picker and accepts
    // the mapped level — the coarse flag must not veto what the map
    // addresses.
    let map = r#"["faux","map-model"]"#;
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(map)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    let options = &response["result"]["configOptions"];
    assert_eq!(options.as_array().map(Vec::len), Some(2), "{options}");
    assert_eq!(options[0]["currentValue"], map);
    assert_eq!(
        options[1]["currentValue"], "high",
        "the level clamped: {options}"
    );
    let levels: Vec<String> = options[1]["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["value"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(levels, vec!["minimal", "low", "medium", "high", "xhigh"]);
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "thought_level", &json!("xhigh")),
    );
    let (response, notifications) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][1]["currentValue"], "xhigh",
        "the mapped level applies: {response}"
    );
    let updates = config_updates(&notifications);
    assert!(
        updates.iter().any(
            |update| update["params"]["update"]["configOptions"][1]["currentValue"] == "xhigh"
        ),
        "the mapped level publishes config_option_update: {notifications:?}"
    );

    // An uncredentialed model discovery admits (the locked provider's
    // auth cannot resolve): the switch refuses BEFORE anything moves —
    // the next turn keeps running on the model it still reports.
    let locked = r#"["locked","locked-model"]"#;
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(locked)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(response["error"]["code"], -32603, "{response}");
    assert!(
        response["error"]["data"]["details"]
            .as_str()
            .unwrap_or_default()
            .contains("No API key found"),
        "the refusal names the missing credentials: {response}"
    );
    // Nothing moved: the map model is still the live selection (the
    // no-op re-selection refreshes and reports it).
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(map)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"], map,
        "the uncredentialed switch mutated nothing: {response}"
    );

    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
}

/// The in-process transport's failed settings persist: the switch's live
/// state is applied COHERENTLY (TS `setModel` rejects after the model
/// assignment and the durable row, with the switched session applied),
/// never split — `current_model()` and the agent agree on the switched
/// model even when the settings write fails, so the effort gate answers
/// for the model the turns run on. The settings write fails because the
/// global settings file is a directory (the lock step cannot read it).
#[test]
fn acp_in_process_failed_settings_persist_keeps_the_session_coherent() {
    let script = json!({
        "reasoning": true,
        "responses": ["one answer", "still streaming on the switched model"],
    });
    let mut client = AcpChild::spawn_with_models(
        &["--mode", "acp", "--no-session"],
        &script,
        Some(faux_models_fixture()),
        &[],
    );
    // The global settings file as a directory: every settings write
    // fails at its read step, deterministically.
    std::fs::create_dir_all(client.home.path().join("agent").join("settings.json")).unwrap();
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let result = &new_response["result"];
    let session_id = result["sessionId"].as_str().unwrap().to_string();
    assert_eq!(
        result["configOptions"].as_array().map(Vec::len),
        Some(2),
        "the admission is unaffected: {result}"
    );

    // The switch fails at the settings persist (the live switch and the
    // durable row already ran): the RPC reports the failure...
    let plain = r#"["faux","plain-model"]"#;
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(plain)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(response["error"]["code"], -32603, "{response}");
    assert!(
        response["error"]["data"]["details"]
            .as_str()
            .unwrap_or_default()
            .contains("model switch failed"),
        "the refusal names the switch: {response}"
    );

    // ...but the session is NOT split: the effort gate answers for the
    // model the turns run on (the switched plain model), so `high` is
    // unsupported — a stale pre-switch slot would have accepted it.
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "thought_level", &json!("high")),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(response["error"]["code"], -32602, "{response}");
    assert_eq!(
        response["error"]["data"]["reason"],
        "Unsupported reasoning effort: high"
    );

    // The live session runs the switched model (TS's reject-with-state-
    // applied): the no-op re-selection refreshes and reports it...
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(plain)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"], plain,
        "the switched model is live and reported: {response}"
    );
    assert_eq!(
        response["result"]["configOptions"].as_array().map(Vec::len),
        Some(1),
        "the plain model serves no effort picker: {response}"
    );

    // ...and the next turn still streams on it.
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hello" }] }),
    );
    let (prompt_response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");

    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
}

/// The daemon-attached transport: the pickers ride the worker's own wire
/// commands — advertised at `session/new`, the effort selection applied
/// through `set_thinking_level`, invalid values refused, and the turn
/// after a switch still settles.
#[test]
fn acp_daemon_attached_config_option_pickers() {
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let script_path = home.path().join("worker-script.json");
    std::fs::write(
        &script_path,
        json!({
            "engine": "faux",
            "reasoning": true,
            "responses": ["The Thames flows through London."],
        })
        .to_string(),
    )
    .unwrap();
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let mut child = Command::new(bin)
        .args([
            "--mode",
            "acp",
            "--no-session",
            "--daemon-socket",
            socket.to_str().unwrap(),
        ])
        .env("HOME", home.path())
        .env("PRIME_AGENT_CODING_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_ACP_DAEMON_SCRIPT", &script_path)
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let mut client = {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        AcpChild {
            child,
            stdin,
            lines: rx,
            next_id: 0,
            home,
        }
    };
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let result = &new_response["result"];
    assert!(
        result["sessionId"].is_string(),
        "daemon-attached admission succeeds: {new_response}"
    );
    let session_id = result["sessionId"].as_str().unwrap().to_string();

    // Both pickers advertised off the worker's connection state.
    let options = &result["configOptions"];
    assert_eq!(options.as_array().map(Vec::len), Some(2), "{options}");
    assert_eq!(options[0]["id"], "model");
    assert_eq!(options[0]["currentValue"], r#"["faux","faux-1"]"#);
    assert_eq!(options[1]["id"], "thought_level");
    assert_eq!(options[1]["currentValue"], "medium");

    // An effort selection applies through the worker's switch and
    // publishes the change.
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "thought_level", &json!("high")),
    );
    let (response, notifications) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][1]["currentValue"], "high",
        "{response}"
    );
    let updates = config_updates(&notifications);
    assert!(
        updates
            .iter()
            .any(|update| update["params"]["update"]["configOptions"][1]["currentValue"] == "high"),
        "the change publishes config_option_update: {notifications:?}"
    );

    // Unsupported levels and models are refused with the TS reasons; the
    // current model re-selects cleanly.
    for (config_id, value, reason) in [
        (
            "thought_level",
            json!("sideways"),
            "Unsupported reasoning effort: sideways",
        ),
        ("model", json!("missing"), "Unavailable model: missing"),
        (
            "unknown",
            json!("high"),
            "Invalid configuration option: unknown",
        ),
    ] {
        let select = client.request(
            "session/set_config_option",
            &select_params(&session_id, config_id, &value),
        );
        let (response, _) = client.wait_response(select, TIMEOUT);
        assert_eq!(response["error"]["code"], -32602, "{config_id}: {response}");
        assert_eq!(response["error"]["data"]["reason"], reason);
    }
    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(r#"["faux","faux-1"]"#)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"],
        r#"["faux","faux-1"]"#
    );

    // The switched level survives a turn: the prompt still settles.
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "Name a river." }] }),
    );
    let (prompt_response, _) = client.wait_response(prompt, Duration::from_mins(2));
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");

    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
    drop(client);
    shutdown_sandboxed_daemon(&socket);
}

// large_futures: stack futures on hot paths by design. too_many_lines:
// style gate only. Casts: 64-bit targets; narrowing sits at bounded
// OS/protocol boundaries.
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
//! `session/set_config_option` applies selections — the effort select
//! offers the session model's supported levels, invalid values are
//! `-32602` invalid params, and real selections publish the
//! `config_option_update` notification. Model switches are observable:
//! the faux worker resolves a switched selection through the registry
//! (a models.json faux-api model streams through the same scripted
//! provider), so the pickers follow the switch.
//!
//! The daemon-attached transport covers the surface: the pickers ride
//! the worker's own wire commands, with a models.json fixture in the
//! agent dir for discovery.

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
    /// Held (never read) so the child's cwd outlives the process.
    _home: tempfile::TempDir,
}

impl AcpChild {
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
/// discover and switch to (under the stable `faux` api).
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
                        // #2858's `gpt-5.3-chat-latest` shape: the coarse `reasoning` flag is
                        // false, but the map addresses `xhigh`.
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
            }
        }
    })
}

/// The daemon-attached transport: the pickers ride the worker's own wire
/// commands — advertised at `session/new`, the effort selection applied
/// through `set_thinking_level`, invalid values refused, and a real
/// model switch observable (the plain model drops the effort picker, the
/// map model accepts `xhigh`, and the turn after a switch settles).
#[test]
fn acp_daemon_attached_config_option_pickers() {
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let agent_dir = home.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The worker inherits the CLI's agent dir, so the fixture models ride
    // the same discovery.
    std::fs::write(
        agent_dir.join("models.json"),
        faux_models_fixture().to_string(),
    )
    .unwrap();
    let script_path = home.path().join("worker-script.json");
    std::fs::write(
        &script_path,
        json!({
            "engine": "faux",
            "reasoning": true,
            "responses": ["The Thames flows through London.", "The switched model still streams."],
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
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("PRIME_AGENT_FAUX_SCRIPT", &script_path)
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
            _home: home,
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

    // Both pickers advertised off the worker's connection state: the
    // model select (current model always selectable, the discovered
    // fixture model listed) and the effort select on the reasoning
    // model's supported levels.
    let options = &result["configOptions"];
    assert_eq!(options.as_array().map(Vec::len), Some(2), "{options}");
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

    // Unsupported levels and models are refused with the TS reasons.
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

    // The provider target followed the switch: the next prompt streams on the selected model.
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hello" }] }),
    );
    let (prompt_response, _) = client.wait_response(prompt, Duration::from_mins(2));
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");

    // Switching back restores the effort picker at the persisted default.
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

    let select = client.request(
        "session/set_config_option",
        &select_params(&session_id, "model", &json!(reasoner)),
    );
    let (response, _) = client.wait_response(select, TIMEOUT);
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"],
        reasoner
    );

    // #2858's map-driven capability: the map model (`reasoning: false` with an
    // addressable `xhigh`) serves its effort picker.
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

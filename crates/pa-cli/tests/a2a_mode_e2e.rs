//! End-to-end `--mode a2a`: the real binary serves the A2A JSON-RPC
//! binding over a sandboxed supervisor hosting scripted faux workers.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct A2a {
    child: Child,
    _home: tempfile::TempDir,
    socket: std::path::PathBuf,
    addr: String,
    token: String,
    token_file: Option<std::path::PathBuf>,
}

impl A2a {
    /// Start the mode on port 0 with a scripted worker (and scripted RLM
    /// children); readiness is the listening line.
    fn start(script: &Value, child_script: Option<&Value>, env: &[(&str, &str)]) -> Self {
        Self::start_full(script, child_script, env, &[])
    }

    fn start_with_args(script: &Value, args: &[&str]) -> Self {
        Self::start_full(script, None, &[], args)
    }

    fn start_full(
        script: &Value,
        child_script: Option<&Value>,
        env: &[(&str, &str)],
        args: &[&str],
    ) -> Self {
        let home = tempfile::TempDir::new().unwrap();
        let agent_dir = home.path().join(".prime/agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let socket = home.path().join("daemon.sock");
        std::fs::write(home.path().join("script.json"), script.to_string()).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
        command
            .args(["--mode", "a2a", "--a2a-port", "0", "--daemon-socket"])
            .arg(&socket)
            .args(args)
            .env("HOME", home.path())
            .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
            .env_remove("PRIME_AGENT_SESSION_DIR")
            .env_remove("PRIME_AGENT_A2A_TOKEN")
            .env("PRIME_AGENT_FAUX_SCRIPT", home.path().join("script.json"))
            .envs(env.iter().copied())
            .current_dir(home.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(child_script) = child_script {
            let path = home.path().join("child-script.json");
            std::fs::write(&path, child_script.to_string()).unwrap();
            command.env("PRIME_AGENT_FAUX_CHILD_SCRIPT", path);
        }
        let kernel_python = std::env::var_os("PA_E2E_KERNEL_PYTHON").unwrap_or_else(|| {
            format!(
                "{}/.prime/agent/kernel-venv/bin/python",
                std::env::var("HOME").unwrap_or_default()
            )
            .into()
        });
        if std::path::Path::new(&kernel_python).exists() {
            command.env("PRIME_AGENT_KERNEL_PYTHON", kernel_python);
        }
        let mut child = command.spawn().expect("the binary starts");
        let mut stderr = BufReader::new(child.stderr.take().unwrap());
        let (mut addr, mut token_file, mut lines) = (None, None, Vec::new());
        while addr.is_none() {
            let mut line = String::new();
            assert!(
                stderr.read_line(&mut line).unwrap_or(0) > 0,
                "the mode exited: {lines:?}"
            );
            if let Some(rest) = line.strip_prefix("a2a: listening on http://") {
                addr = Some(rest.trim().to_string());
            }
            if let Some(rest) = line.strip_prefix("a2a: minted a bearer token for this run in ") {
                token_file = rest.split(" (send").next().map(std::path::PathBuf::from);
            }
            lines.push(line);
        }
        std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
        let token = env
            .iter()
            .find(|(name, _)| *name == "PRIME_AGENT_A2A_TOKEN")
            .map_or_else(
                || std::fs::read_to_string(token_file.as_ref().expect("a minted token")).unwrap(),
                |(_, token)| (*token).to_string(),
            )
            .trim()
            .to_string();
        A2a {
            child,
            _home: home,
            socket,
            addr: addr.unwrap(),
            token,
            token_file,
        }
    }

    /// One HTTP/1.0 exchange (the server closes after the reply, so an SSE
    /// body reads to its end): status, lowercase headers, body.
    fn http(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> (u16, Vec<(String, String)>, String) {
        let mut stream = TcpStream::connect(&self.addr).unwrap();
        let mut lines = vec![
            format!("{method} {path} HTTP/1.0"),
            format!("Content-Length: {}", body.len()),
        ];
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("host"))
        {
            lines.push(format!("Host: {}", self.addr));
        }
        lines.extend(
            headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}")),
        );
        let head = lines.join("\r\n") + "\r\n";
        stream
            .write_all(format!("{head}\r\n{body}").as_bytes())
            .unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
        let mut lines = head.lines();
        let status = lines
            .next()
            .and_then(|line| line.split(' ').nth(1))
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        (status, headers, body.to_string())
    }

    fn post(&self, method: &str, params: &Value) -> (u16, String) {
        let auth = format!("Bearer {}", self.token);
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let (status, _, body) = self.http(
            "POST",
            "/",
            &[
                ("Authorization", &auth),
                ("A2A-Version", "1.0"),
                ("Content-Type", "application/json"),
            ],
            &body.to_string(),
        );
        (status, body)
    }

    fn rpc(&self, method: &str, params: &Value) -> Value {
        let (status, body) = self.post(method, params);
        assert_eq!(status, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }

    /// A streaming method: every SSE frame's JSON-RPC result.
    fn sse(&self, method: &str, params: &Value) -> Vec<Value> {
        let (_, body) = self.post(method, params);
        body.split("\n\n")
            .filter_map(|frame| frame.strip_prefix("data: "))
            .map(|frame| serde_json::from_str::<Value>(frame).unwrap()["result"].clone())
            .collect()
    }

    fn send(&self, text: &str, context: Option<&str>, configuration: &Value) -> Value {
        self.rpc("SendMessage", &send_params(text, context, configuration))
    }

    /// Follow the task's `SubscribeToTask` stream until a frame satisfies
    /// `until` (the observable readiness); a task that already finished
    /// answers an error instead of a stream. Returns the task's snapshot.
    fn wait_task(&self, id: &str, until: impl Fn(&Value) -> bool) -> Value {
        let mut stream = TcpStream::connect(&self.addr).unwrap();
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "SubscribeToTask", "params": { "id": id } })
            .to_string();
        write!(
            stream,
            "POST / HTTP/1.0\r\nHost: {}\r\nAuthorization: Bearer {}\r\nA2A-Version: 1.0\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            self.addr,
            self.token,
            body.len()
        )
        .unwrap();
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if let Some(frame) = line.strip_prefix("data: ") {
                if until(&serde_json::from_str::<Value>(frame).unwrap()["result"]) {
                    break;
                }
            }
        }
        self.rpc("GetTask", &json!({ "id": id }))["result"].clone()
    }

    fn daemon(&self, command: &Value) -> Value {
        let mut stream = pa_types::platform::transport::connect_blocking(&self.socket).unwrap();
        let frame = json!({
            "type": "command",
            "id": "probe",
            "protocol": { "name": "prime-agent.daemon", "version": pa_types::daemon::DAEMON_PROTOCOL_VERSION },
            "command": command,
        });
        writeln!(stream, "{frame}").unwrap();
        BufReader::new(stream)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
            .find(|value| value["type"] == "response")
            .expect("the daemon answers")
    }

    /// The daemon sessions the A2A contexts host (not their child agents).
    fn sessions(&self) -> Vec<Value> {
        self.daemon(&json!({ "type": "list", "all": true }))["data"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["runtimeKind"] != "subagent")
            .cloned()
            .collect()
    }
}

impl Drop for A2a {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.daemon(&json!({ "type": "shutdown" }));
    }
}

fn send_params(text: &str, context: Option<&str>, configuration: &Value) -> Value {
    let mut message =
        json!({ "messageId": "m-1", "role": "ROLE_USER", "parts": [{ "text": text }] });
    if let Some(context) = context {
        message["contextId"] = json!(context);
    }
    json!({ "message": message, "configuration": configuration })
}

/// The task state a stream frame reports, if any.
fn frame_state(frame: &Value) -> &str {
    frame["task"]["status"]["state"]
        .as_str()
        .or_else(|| frame["statusUpdate"]["status"]["state"].as_str())
        .unwrap_or_default()
}

fn state(task: &Value) -> &str {
    task["status"]["state"].as_str().unwrap_or_default()
}

fn artifact_text(task: &Value) -> &str {
    task["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default()
}

#[test]
fn send_stream_get_and_list() {
    let server = A2a::start(
        &json!({ "engine": "faux", "tokensPerSecond": 40, "responses": [
            "first reply",
            "the second reply streams in several chunks over a little while",
        ] }),
        None,
        &[],
    );
    let (status, headers, card) = server.http("GET", "/.well-known/agent-card.json", &[], "");
    assert_eq!(status, 200, "the card is public");
    let card: Value = serde_json::from_str(&card).unwrap();
    assert_eq!(
        card["supportedInterfaces"][0]["url"],
        format!("http://{}/", server.addr)
    );
    assert_eq!(card["capabilities"]["streaming"], true);
    let etag = &headers.iter().find(|(name, _)| name == "etag").unwrap().1;
    assert_eq!(
        server
            .http(
                "GET",
                "/.well-known/agent-card.json",
                &[("If-None-Match", etag)],
                ""
            )
            .0,
        304
    );

    let blocking = server.send("hello", None, &json!({}))["result"]["task"].clone();
    assert_eq!(state(&blocking), "TASK_STATE_COMPLETED", "{blocking}");
    assert_eq!(artifact_text(&blocking), "first reply");
    assert_eq!(blocking["history"][1]["parts"][0]["text"], "first reply");
    let context = blocking["contextId"].as_str().unwrap();

    // The second task continues the same conversation, streamed.
    let frames = server.sse(
        "SendStreamingMessage",
        &send_params("again", Some(context), &json!({})),
    );
    assert_eq!(
        state(&frames[0]["task"]),
        "TASK_STATE_SUBMITTED",
        "{frames:?}"
    );
    assert_eq!(
        frames[1]["statusUpdate"]["status"]["state"],
        "TASK_STATE_WORKING"
    );
    let chunks: Vec<&Value> = frames
        .iter()
        .filter_map(|frame| frame.get("artifactUpdate"))
        .collect();
    assert!(chunks.len() > 2, "the reply streams in chunks: {frames:?}");
    assert_eq!(chunks[0]["append"], false);
    let last = chunks.last().unwrap();
    assert_eq!(
        (last["append"].clone(), last["lastChunk"].clone()),
        (json!(false), json!(true))
    );
    assert_eq!(
        last["artifact"]["parts"][0]["text"],
        "the second reply streams in several chunks over a little while"
    );
    let terminal = frames.last().unwrap();
    assert_eq!(
        terminal["statusUpdate"]["status"]["state"],
        "TASK_STATE_COMPLETED"
    );
    let streamed_id = terminal["statusUpdate"]["taskId"].as_str().unwrap();

    let got =
        server.rpc("GetTask", &json!({ "id": streamed_id, "historyLength": 1 }))["result"].clone();
    assert!(artifact_text(&got).starts_with("the second reply"));
    assert_eq!(got["history"].as_array().unwrap().len(), 1);
    let listed =
        server.rpc("ListTasks", &json!({ "contextId": context, "pageSize": 1 }))["result"].clone();
    assert_eq!(listed["totalSize"], 2);
    assert_eq!(listed["tasks"][0]["id"], streamed_id, "newest first");
    assert!(listed["tasks"][0].get("artifacts").is_none());
    let rest = server.rpc(
        "ListTasks",
        &json!({ "contextId": context, "pageToken": listed["nextPageToken"] }),
    );
    assert_eq!(rest["result"]["tasks"][0]["id"], blocking["id"]);
    assert_eq!(
        server.rpc("GetTask", &json!({ "id": "nope" }))["error"]["code"],
        -32001
    );
    assert_message_rules(&server, context, streamed_id);
}

/// `includeArtifacts`, the spec 3.4.3 `taskId` rules, and the client role.
fn assert_message_rules(server: &A2a, context: &str, streamed_id: &str) {
    let with_artifacts = server.rpc(
        "ListTasks",
        &json!({ "contextId": context, "includeArtifacts": true }),
    );
    assert!(with_artifacts["result"]["tasks"][0]["artifacts"].is_array());
    let on_task = |task_context: Option<&str>| {
        let mut message = json!({ "messageId": "m", "role": "ROLE_USER", "taskId": streamed_id, "parts": [{ "text": "x" }] });
        if let Some(task_context) = task_context {
            message["contextId"] = json!(task_context);
        }
        server.rpc("SendMessage", &json!({ "message": message }))
    };
    let continued = on_task(None);
    assert_eq!(
        continued["error"]["code"], -32004,
        "a finished task takes no messages"
    );
    assert_eq!(
        continued["error"]["data"][0]["metadata"]["contextId"], context,
        "the context is the task's"
    );
    assert_eq!(on_task(Some("another-context"))["error"]["code"], -32602);
    let as_agent = server.rpc(
        "SendMessage",
        &json!({ "message": { "messageId": "m", "role": "ROLE_AGENT", "parts": [{ "text": "x" }] } }),
    );
    assert_eq!(as_agent["error"]["code"], -32602);
}

#[test]
fn the_gates_refuse_bad_credentials_origins_hosts_and_versions() {
    let server = A2a::start(
        &json!({ "engine": "faux", "responses": ["ok"] }),
        None,
        &[("PRIME_AGENT_A2A_TOKEN", "secret-token")],
    );
    let body =
        json!({ "jsonrpc": "2.0", "id": 1, "method": "ListTasks", "params": {} }).to_string();
    let json_headers = [("A2A-Version", "1.0"), ("Content-Type", "application/json")];
    let (status, headers, _) = server.http("POST", "/", &json_headers, &body);
    assert_eq!(status, 401);
    assert!(headers
        .iter()
        .any(|(name, value)| name == "www-authenticate" && value == "Bearer"));
    let with = |auth: &str, extra: &[(&str, &str)]| {
        let mut headers = vec![("Authorization", auth)];
        headers.extend_from_slice(&json_headers);
        headers.extend_from_slice(extra);
        server.http("POST", "/", &headers, &body)
    };
    assert_eq!(with("Bearer wrong", &[]).0, 401);
    assert_eq!(with("bearer secret-token", &[]).0, 200);
    assert_eq!(
        with("Bearer secret-token", &[("Origin", "https://evil.example")]).0,
        403
    );
    assert_eq!(
        with("Bearer secret-token", &[("Host", "evil.example:7800")]).0,
        403
    );
    assert_eq!(
        server
            .http(
                "GET",
                "/.well-known/agent-card.json",
                &[("Origin", "https://evil.example")],
                ""
            )
            .0,
        403
    );
    let (_, _, no_version) = server.http(
        "POST",
        "/",
        &[
            ("Authorization", "Bearer secret-token"),
            ("Content-Type", "application/json"),
        ],
        &body,
    );
    assert!(no_version.contains("-32009"), "{no_version}");
    let (_, _, query_version) = server.http(
        "POST",
        "/?A2A-Version=1.0",
        &[
            ("Authorization", "Bearer secret-token"),
            ("Content-Type", "application/json"),
        ],
        &body,
    );
    assert!(query_version.contains("\"result\""), "{query_version}");
    let (_, _, form) = server.http(
        "POST",
        "/",
        &[
            ("Authorization", "Bearer secret-token"),
            ("A2A-Version", "1.0"),
            ("Content-Type", "text/plain"),
        ],
        &body,
    );
    assert!(form.contains("-32005"), "{form}");
}

#[test]
fn a_minted_token_is_owner_only_and_leaves_with_the_server() {
    let server = A2a::start(&json!({ "engine": "faux", "responses": ["ok"] }), None, &[]);
    let path = server
        .token_file
        .clone()
        .expect("no configured token mints one");
    assert!(server.rpc("ListTasks", &json!({})).get("result").is_some());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let mut server = server;
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(i32::try_from(server.child.id()).unwrap()),
            nix::sys::signal::Signal::SIGTERM,
        )
        .unwrap();
        assert!(server.child.wait().unwrap().success());
        assert!(!path.exists(), "the token file leaves at exit");
    }
    #[cfg(not(unix))]
    assert!(path.exists());
}

#[test]
fn subscribe_reconnects_to_a_running_task() {
    let server = A2a::start(
        &json!({ "engine": "faux", "tokensPerSecond": 8, "responses": ["a reply slow enough to subscribe to while it streams"] }),
        None,
        &[],
    );
    let task =
        server.send("go", None, &json!({ "returnImmediately": true }))["result"]["task"].clone();
    let id = task["id"].as_str().unwrap();
    server.wait_task(id, |frame| frame_state(frame) == "TASK_STATE_WORKING");
    let frames = server.sse("SubscribeToTask", &json!({ "id": id }));
    assert_eq!(frames[0]["task"]["id"], id);
    assert_eq!(state(&frames[0]["task"]), "TASK_STATE_WORKING");
    assert_eq!(
        frames.last().unwrap()["statusUpdate"]["status"]["state"],
        "TASK_STATE_COMPLETED"
    );
    let done = server.rpc("SubscribeToTask", &json!({ "id": id }));
    assert_eq!(
        done["error"]["code"], -32004,
        "a terminal task has no stream"
    );
}

#[test]
fn contexts_run_in_parallel_and_tasks_in_one_context_in_order() {
    let server = A2a::start(
        &json!({ "engine": "faux", "tokensPerSecond": 10, "responses": ["the slow reply of one context", "next"] }),
        None,
        &[],
    );
    let config = json!({ "returnImmediately": true });
    let first = server.send("one", Some("ctx-a"), &config)["result"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let queued = server.send("two", Some("ctx-a"), &config)["result"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let other = server.send("three", Some("ctx-b"), &config)["result"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.wait_task(&first, |frame| frame_state(frame) == "TASK_STATE_WORKING");
    server.wait_task(&other, |frame| frame_state(frame) == "TASK_STATE_WORKING");
    assert_eq!(
        state(&server.rpc("GetTask", &json!({ "id": queued }))["result"]),
        "TASK_STATE_SUBMITTED"
    );
    let a = server.wait_task(&first, |frame| frame_state(frame) == "TASK_STATE_COMPLETED");
    let b = server.wait_task(&other, |frame| frame_state(frame) == "TASK_STATE_COMPLETED");
    assert_eq!(
        artifact_text(&a),
        artifact_text(&b),
        "each context has its own session"
    );
    let second = server.wait_task(&queued, |frame| {
        frame_state(frame) == "TASK_STATE_COMPLETED"
    });
    assert_eq!(artifact_text(&second), "next");
    assert_eq!(server.sessions().len(), 2, "one daemon session per context");
}

#[test]
fn cancel_stops_the_turn_and_the_child_agents() {
    // The parent spawns a child agent that holds its turn, so the task
    // waits for the child; a cancel must stop it.
    let spawn =
        "handle = await rlm.spawn(\"run the child task\", name=\"kid\")\nprint(\"SPAWNED\")";
    let server = A2a::start(
        &json!({ "engine": "faux", "responses": [
            { "content": [
                { "type": "text", "text": "Delegating." },
                { "type": "toolCall", "name": "ipython", "arguments": { "code": spawn } },
            ] },
            "waiting for the child",
            { "text": "a turn that holds", "delayMs": 120_000 },
        ], "repeatLastResponse": true }),
        Some(
            &json!({ "engine": "faux", "responses": [{ "text": "child done", "delayMs": 120_000 }] }),
        ),
        &[],
    );
    let task = server.send("delegate", None, &json!({ "returnImmediately": true }))["result"]
        ["task"]
        .clone();
    let id = task["id"].as_str().unwrap();
    // The parent's answer streams after its spawn call returned: the child
    // exists and the task now waits for it.
    let streamed = std::cell::RefCell::new(String::new());
    server.wait_task(id, |frame| {
        let mut streamed = streamed.borrow_mut();
        streamed.push_str(
            frame["artifactUpdate"]["artifact"]["parts"][0]["text"]
                .as_str()
                .unwrap_or_default(),
        );
        streamed.contains("waiting for the child")
    });
    let session = server.sessions()[0]["activeSessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let children = |server: &A2a| {
        server.daemon(&json!({ "type": "get_rlm_children", "activeSessionId": session }))["data"]
            ["children"]
            .clone()
    };
    assert_eq!(
        children(&server).as_array().map(Vec::len),
        Some(1),
        "the child agent exists"
    );
    assert_eq!(
        state(&server.rpc("GetTask", &json!({ "id": id }))["result"]),
        "TASK_STATE_WORKING"
    );
    let canceled = server.rpc("CancelTask", &json!({ "id": id }))["result"].clone();
    assert_eq!(state(&canceled), "TASK_STATE_CANCELED", "{canceled}");
    let stopped = children(&server);
    assert!(
        stopped
            .as_array()
            .unwrap()
            .iter()
            .all(|child| child["status"] != "running" && child["status"] != "queued"),
        "the cancel stopped the child agents: {stopped}"
    );
    assert_eq!(
        server.rpc("CancelTask", &json!({ "id": id }))["error"]["code"],
        -32002
    );

    // A turn canceled mid-flight stops too, and the context serves on.
    let context = canceled["contextId"].as_str().unwrap();
    let held = server.send(
        "again",
        Some(context),
        &json!({ "returnImmediately": true }),
    )["result"]["task"]
        .clone();
    let held_id = held["id"].as_str().unwrap();
    server.wait_task(held_id, |frame| frame_state(frame) == "TASK_STATE_WORKING");
    let started = Instant::now();
    // Two cancels at once (spec 3.3.1): both answer the canceled task.
    let canceled = std::thread::scope(|scope| {
        let other = scope.spawn(|| server.rpc("CancelTask", &json!({ "id": held_id })));
        let canceled = server.rpc("CancelTask", &json!({ "id": held_id }));
        let other = other.join().unwrap();
        assert_eq!(state(&other["result"]), "TASK_STATE_CANCELED", "{other}");
        canceled["result"].clone()
    });
    assert_eq!(state(&canceled), "TASK_STATE_CANCELED", "{canceled}");
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "the stop did not wait out the held turn"
    );
    let row = server
        .sessions()
        .into_iter()
        .find(|row| row["activeSessionId"] == session.as_str());
    assert_ne!(
        row.map(|row| row["isStreaming"].clone()),
        Some(json!(true)),
        "the turn stopped"
    );
}

#[test]
fn another_clients_turn_stays_out_of_the_reply() {
    let server = A2a::start(
        &json!({ "engine": "faux", "responses": [
            "ready",
            { "text": "FOREIGN reply", "delayMs": 2000 },
            "the task's own reply",
        ] }),
        None,
        &[],
    );
    let warm = server.send("warm up", None, &json!({}))["result"]["task"].clone();
    let context = warm["contextId"].as_str().unwrap();
    let session = server.sessions()[0]["activeSessionId"]
        .as_str()
        .unwrap()
        .to_string();
    // Another daemon client's turn is running when the task arrives: the
    // task's prompt waits behind it instead of joining it.
    let queued = server
        .daemon(&json!({ "type": "prompt", "activeSessionId": session, "message": "foreign" }));
    assert_eq!(queued["success"], true, "{queued}");
    let task = server.send("go", Some(context), &json!({}))["result"]["task"].clone();
    assert_eq!(state(&task), "TASK_STATE_COMPLETED", "{task}");
    assert_eq!(artifact_text(&task), "the task's own reply", "{task}");
}

#[test]
fn a_failed_goal_continuation_fails_the_task() {
    let server = A2a::start(
        &json!({ "engine": "faux", "responses": [
            "working on it",
            { "text": "", "stopReason": "error", "errorMessage": "the provider failed" },
        ] }),
        None,
        &[],
    );
    let task = server.send("/goal finish the work", None, &json!({}))["result"]["task"].clone();
    assert_eq!(state(&task), "TASK_STATE_FAILED", "{task}");
}

#[test]
fn cancel_retires_the_goal_loop() {
    let server = A2a::start(
        &json!({ "engine": "faux", "tokensPerSecond": 20, "responses": [
            "the goal's first step streams slowly enough to cancel it in the middle of the run",
            "a plain answer",
        ] }),
        None,
        &[],
    );
    let task = server.send(
        "/goal do many steps",
        None,
        &json!({ "returnImmediately": true }),
    )["result"]["task"]
        .clone();
    let id = task["id"].as_str().unwrap();
    server.wait_task(id, |frame| frame.get("artifactUpdate").is_some());
    let canceled = server.rpc("CancelTask", &json!({ "id": id }))["result"].clone();
    assert_eq!(state(&canceled), "TASK_STATE_CANCELED", "{canceled}");
    // A goal that resumed would mint another turn after this one and fail it
    // (the script has no answer left).
    let next =
        server.send("hello", canceled["contextId"].as_str(), &json!({}))["result"]["task"].clone();
    assert_eq!(state(&next), "TASK_STATE_COMPLETED", "{next}");
    assert_eq!(artifact_text(&next), "a plain answer");
}

#[test]
fn the_context_cap_refuses_new_conversations_and_the_public_url_serves() {
    let server = A2a::start_with_args(
        &json!({ "engine": "faux", "responses": ["one", "two"] }),
        &[
            "--a2a-max-contexts",
            "1",
            "--a2a-public-url",
            "https://agent.example.com/a2a",
        ],
    );
    let first = server.send("hi", Some("ctx-1"), &json!({}))["result"]["task"].clone();
    assert_eq!(state(&first), "TASK_STATE_COMPLETED", "{first}");
    let refused = server.send("hi", Some("ctx-2"), &json!({}));
    assert_eq!(
        refused["error"]["data"][0]["reason"], "CONTEXT_LIMIT_REACHED",
        "{refused}"
    );
    let again = server.send("again", Some("ctx-1"), &json!({}))["result"]["task"].clone();
    assert_eq!(state(&again), "TASK_STATE_COMPLETED", "{again}");
    // Behind the TLS front: its Host passes the loopback gate and the card
    // advertises its URL.
    let (status, _, card) = server.http(
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "agent.example.com")],
        "",
    );
    assert_eq!(status, 200);
    let card: Value = serde_json::from_str(&card).unwrap();
    assert_eq!(
        card["supportedInterfaces"][0]["url"],
        "https://agent.example.com/a2a"
    );
}

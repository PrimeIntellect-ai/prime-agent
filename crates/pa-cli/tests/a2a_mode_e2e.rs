// large_futures: stack futures on hot paths by design. too_many_lines:
// style gate only. Casts: 64-bit targets; narrowing sits at bounded
// OS/protocol boundaries.
#![allow(clippy::large_futures, clippy::too_many_lines)]

//! End-to-end A2A-mode verification: the real binary serves the A2A
//! JSON-RPC binding over HTTP on the daemon-attached transport (a
//! sandboxed supervisor hosting a scripted faux worker), and the served
//! wire answers the spec's own shapes — the card at the well-known
//! URI, the blocking send, the SSE stream's ordered frames, the task
//! registry, the cancel paths, the version gate, and the bearer gate.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

/// One parsed HTTP reply head: the status, the lowercased headers, and
/// the body bytes after the header terminator.
type ReplyHead<'a> = (u16, Vec<(String, String)>, &'a [u8]);

/// The response of one HTTP request.
#[derive(Debug)]
struct HttpReply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// The raw bytes past the headers (an SSE stream reads until close).
    raw: Vec<u8>,
}

/// The A2A child: the binary serving `--mode a2a` on its own sandboxed
/// supervisor, with the socket and the bound address on the struct (the
/// drop kills the child and shuts the sandbox down).
struct A2aChild {
    child: Child,
    socket: std::path::PathBuf,
    url: String,
    /// The minted bearer token of a run configured with none (read
    /// from the agent dir's owner-only token file): the harness
    /// presents it on every request by default, so the unauthenticated
    /// probes are the tests that explicitly ask for no auth.
    token: Option<String>,
    /// The stderr lines captured while waiting for the listener.
    stderr_lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    /// The sandboxed home's drop guard (its files die with the child).
    home: tempfile::TempDir,
}

impl A2aChild {
    /// Spawn the A2A mode with a scripted faux worker and port 0 (the
    /// bound port rides the startup line).
    fn spawn(args: &[&str], script: &Value) -> Self {
        Self::spawn_with_env(&[], args, script)
    }

    /// [`Self::spawn_with_env`] with a global settings document
    /// pre-written under the home (the `a2a` settings and the worker's
    /// `idleEvictionMinutes` read at launch). The agent dir rides the
    /// environment override too, so the spawned tree reads THIS home's
    /// settings and sessions, never the invoking session's.
    fn spawn_with_settings(settings: &Value, env: &[(&str, &str)], script: &Value) -> Self {
        let home = tempfile::TempDir::new().unwrap();
        let agent_dir = home.path().join(".prime/agent");
        std::fs::create_dir_all(&agent_dir).expect("the agent dir creates");
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::to_string(settings).expect("serializes"),
        )
        .expect("the settings write");
        let socket = home.path().join("daemon.sock");
        let mut child = a2a_command(home.path(), &socket, env, script)
            .args(["--a2a-port", "0"])
            .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
            .spawn()
            .expect("binary present");
        let stderr = child.stderr.take().expect("stderr piped");
        let (url, lines) = Self::wait_for_listener(stderr);
        let token = a2a_run_token(&lines);
        Self {
            child,
            socket,
            url,
            stderr_lines: std::sync::Arc::new(std::sync::Mutex::new(lines)),
            token,
            home,
        }
    }

    /// [`Self::spawn`] with extra environment pairs (the bearer-token
    /// probe sets `PRIME_AGENT_A2A_TOKEN`).
    fn spawn_with_env(env: &[(&str, &str)], args: &[&str], script: &Value) -> Self {
        Self::spawn_in_home(tempfile::TempDir::new().unwrap(), env, args, script)
    }

    /// [`Self::spawn`] whose `rlm.spawn` children are scripted: the
    /// child script file rides `PRIME_AGENT_FAUX_CHILD_SCRIPT` (the
    /// a2a mode's create reads it into the harness `childScript`
    /// member), so the spawned child workers run their own faux
    /// responses — the terminal-notice flow of the RLM children.
    fn spawn_with_child_script(args: &[&str], script: &Value, child_script: &Value) -> Self {
        let home = tempfile::TempDir::new().unwrap();
        let child_script_path = home.path().join("child-script.json");
        std::fs::write(&child_script_path, child_script.to_string())
            .expect("the child script writes");
        let child_script_arg = child_script_path.to_string_lossy().to_string();
        Self::spawn_in_home(
            home,
            &[("PRIME_AGENT_FAUX_CHILD_SCRIPT", child_script_arg.as_str())],
            args,
            script,
        )
    }

    /// The shared spawn: bind the sandbox, start the mode, and wait for
    /// its listening line (the observable-readiness contract, never a
    /// sleep).
    fn spawn_in_home(
        home: tempfile::TempDir,
        env: &[(&str, &str)],
        args: &[&str],
        script: &Value,
    ) -> Self {
        std::fs::create_dir_all(home.path().join(".prime/agent")).expect("the agent dir creates");
        let socket = home.path().join("daemon.sock");
        let mut child = a2a_command(home.path(), &socket, env, script)
            .args(["--a2a-port", "0"])
            .args(args)
            .spawn()
            .expect("binary present");
        let stderr = child.stderr.take().expect("stderr piped");
        // The readiness line: the mode prints its bound address on
        // startup (the observable-readiness contract, never a sleep).
        // The lines read while waiting stay for the warning assertions.
        let (url, lines) = Self::wait_for_listener(stderr);
        let token = a2a_run_token(&lines);
        Self {
            child,
            socket,
            url,
            stderr_lines: std::sync::Arc::new(std::sync::Mutex::new(lines)),
            token,
            home,
        }
    }

    /// Read the child's stderr until the listening line; the lines read
    /// along the way return with the bound address. Everything the
    /// server still logs after startup drains on a background thread:
    /// the server keeps writing to its stderr for the run's life, and an
    /// unread pipe would fill and wedge the server's writes.
    fn wait_for_listener(stderr: std::process::ChildStderr) -> (String, Vec<String>) {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        let mut lines = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            line.clear();
            if reader.read_line(&mut line).is_err() {
                // The child's stderr closed early; the deadline check
                // below reports the failure.
            }
            if let Some(rest) = line.strip_prefix("a2a: listening on ") {
                std::thread::spawn(move || {
                    let _ = std::io::copy(&mut reader, &mut std::io::sink());
                });
                return (rest.trim().to_string(), lines);
            }
            lines.push(line.trim().to_string());
            assert!(
                std::time::Instant::now() < deadline,
                "the a2a mode never printed its listening line: {lines:?}"
            );
        }
    }

    /// The stderr lines captured during startup.
    fn stderr_dump(&self) -> String {
        self.stderr_lines.lock().unwrap().join("\n")
    }

    /// The run's minted token file: the path the startup line prints
    /// (the file is named for the bound address — the port plus the
    /// IP — so concurrent servers sharing one port on different
    /// addresses keep one file each, and the file leaves at the
    /// mode's own exits).
    fn minted_token_path(&self) -> std::path::PathBuf {
        minted_token_path(&self.stderr_lines.lock().unwrap())
            .expect("the minted run prints its token file's path")
    }

    /// One full HTTP request against the child, with the binding's
    /// version header by default. A minted bearer token rides every
    /// request unless the caller names its own `Authorization` (a run
    /// configured with no token serves unauthenticated only where a
    /// probe asks for it — the mint keeps the task routes closed).
    fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
        version: Option<&str>,
    ) -> HttpReply {
        let owned = self.headers_with_default_auth(headers);
        let borrowed: Vec<(&str, &str)> = owned
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        request(&self.url, method, path, &borrowed, body, version)
    }

    /// [`Self::request`] in the SSE form (HTTP/1.0: the server closes
    /// the connection at the stream's end, so the client reads to
    /// EOF).
    fn request_sse(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
        version: Option<&str>,
    ) -> HttpReply {
        let owned = self.headers_with_default_auth(headers);
        let borrowed: Vec<(&str, &str)> = owned
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        request_sse(&self.url, method, path, &borrowed, body, version)
    }

    /// The request headers with the minted bearer token appended (a
    /// minted run presents its token by default; a caller's own
    /// `Authorization` wins).
    fn headers_with_default_auth(&self, headers: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut owned: Vec<(String, String)> = headers
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect();
        if let Some(token) = &self.token {
            if !owned
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            {
                owned.push(("Authorization".to_string(), format!("Bearer {token}")));
            }
        }
        owned
    }

    /// Read one HTTP/1.1 reply: status, headers, and the body (the
    /// content length, or everything the server writes — the SSE case
    /// reads until the connection closes).
    fn read_reply(stream: &mut TcpStream) -> HttpReply {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            if std::time::Instant::now() > deadline {
                break;
            }
            let read = stream.read(&mut chunk);
            match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    let split = Self::header_split(&buffer);
                    if let Some((status, headers, rest)) = split {
                        // A content-length reply is done when the body
                        // reaches it; a stream reply (no length) reads
                        // until the server closes the connection.
                        let length = Self::content_length(&headers);
                        if length.is_some_and(|length| rest.len() >= length) {
                            let body = rest[..length.unwrap_or_default()].to_vec();
                            return HttpReply {
                                status,
                                headers,
                                body,
                                raw: buffer,
                            };
                        }
                    }
                }
            }
        }
        let (status, headers, rest) =
            Self::header_split(&buffer).unwrap_or((0, Vec::new(), &[][..]));
        HttpReply {
            status,
            headers,
            body: rest.to_vec(),
            raw: buffer,
        }
    }

    /// Split the raw bytes at the header terminator.
    fn header_split(buffer: &[u8]) -> Option<ReplyHead<'_>> {
        let split = buffer.windows(4).position(|window| window == b"\r\n\r\n")?;
        let header_text = String::from_utf8_lossy(&buffer[..split]).to_string();
        let mut header_lines = header_text.split("\r\n");
        let status = header_lines
            .next()?
            .split_whitespace()
            .nth(1)?
            .parse::<u16>()
            .ok()?;
        let headers = header_lines
            .map(|line| {
                let (name, value) = line.split_once(':').expect("a header pair");
                (name.trim().to_ascii_lowercase(), value.trim().to_string())
            })
            .collect();
        Some((status, headers, &buffer[split + 4..]))
    }

    fn content_length(headers: &[(String, String)]) -> Option<usize> {
        headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse().ok())
    }

    fn body_json(reply: &HttpReply) -> Value {
        serde_json::from_slice(&reply.body).expect("a JSON body")
    }

    /// The SSE `data:` lines of one reply's raw bytes (the header
    /// block stripped first, then the frame split).
    fn sse_lines(reply: &HttpReply) -> Vec<Value> {
        let raw = String::from_utf8_lossy(&reply.raw);
        let body = raw
            .split_once("\r\n\r\n")
            .map_or(raw.as_ref(), |(_, body)| body);
        body.split("\n\n")
            .filter_map(|frame| frame.trim().strip_prefix("data: "))
            .map(|line| serde_json::from_str(line).expect("an SSE JSON frame"))
            .collect()
    }

    /// One `SendMessage` request body.
    fn send_message_body(
        parts_text: &str,
        context_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Value {
        let mut message = json!({
            "messageId": uuid::Uuid::new_v4().to_string(),
            "role": "ROLE_USER",
            "parts": [{ "text": parts_text }],
        });
        if let Some(context_id) = context_id {
            message["contextId"] = json!(context_id);
        }
        if let Some(task_id) = task_id {
            message["taskId"] = json!(task_id);
        }
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "SendMessage",
            "params": { "message": message },
        })
    }

    /// One blocking send: returns the full JSON-RPC response.
    fn send_message(&self, text: &str, context_id: Option<&str>) -> Value {
        let reply = self.request(
            "POST",
            "/",
            &[],
            Some(&Self::send_message_body(text, context_id, None)),
            Some("1.0"),
        );
        assert_eq!(reply.status, 200, "the send answered HTTP 200");
        Self::body_json(&reply)
    }
}

/// One full HTTP request against a served address: a fresh connection
/// per request, the binding's default version header by `version`.
fn request(
    url: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&Value>,
    version: Option<&str>,
) -> HttpReply {
    request_with_version(url, method, path, headers, body, version, "HTTP/1.1")
}

/// The HTTP/1.0 form for SSE: no chunked encoding, the server closes
/// the connection when the stream ends, so the client reads to EOF.
#[allow(clippy::too_many_arguments)]
fn request_sse(
    url: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&Value>,
    version: Option<&str>,
) -> HttpReply {
    request_with_version(url, method, path, headers, body, version, "HTTP/1.0")
}

fn request_with_version(
    url: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&Value>,
    version: Option<&str>,
    http_version: &str,
) -> HttpReply {
    let address = url.trim_start_matches("http://").to_string();
    let mut stream = TcpStream::connect(&address).expect("the listener answers");
    let mut lines: Vec<String> = vec![format!("{method} {path} {http_version}")];
    lines.push(format!("Host: {address}"));
    if let Some(version) = version {
        lines.push(format!("A2A-Version: {version}"));
    }
    for (name, value) in headers {
        lines.push(format!("{name}: {value}"));
    }
    let body = body
        .map(|body| serde_json::to_string(body).unwrap_or_default())
        .unwrap_or_default();
    // The binding's declared content type (spec 9.1), unless a probe
    // overrides it through `headers`.
    if !body.is_empty()
        && !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    {
        lines.push("Content-Type: application/json".to_string());
    }
    lines.push(format!("Content-Length: {}", body.len()));
    let request = format!("{}\r\n\r\n{body}", lines.join("\r\n"));
    stream
        .write_all(request.as_bytes())
        .expect("the request writes");
    stream.flush().expect("the flush lands");
    A2aChild::read_reply(&mut stream)
}

/// One raw HTTP request with full header control (the browser-surface
/// probes: a foreign `Host`, an `Origin`, a form's content type). The
/// body passes through verbatim; `read` decides whether the reply is
/// read (a probe that drops the connection mid-turn passes `false`).
fn raw_request(
    url: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    read: bool,
) -> Option<HttpReply> {
    let address = url.trim_start_matches("http://").to_string();
    let mut stream = TcpStream::connect(&address).expect("the listener answers");
    let mut lines: Vec<String> = vec![format!("{method} {path} HTTP/1.1")];
    // The loopback `Host` gate reads the header: a probe may override
    // it (the DNS-rebinding shape carries a foreign name).
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
    {
        lines.push(format!("Host: {address}"));
    }
    for (name, value) in headers {
        lines.push(format!("{name}: {value}"));
    }
    lines.push(format!("Content-Length: {}", body.len()));
    let request = format!("{}\r\n\r\n", lines.join("\r\n"));
    stream
        .write_all(request.as_bytes())
        .expect("the raw request writes");
    stream.write_all(body).expect("the raw body writes");
    stream.flush().expect("the flush lands");
    if !read {
        // The client hangs up: the socket drops with the request sent.
        drop(stream);
        return None;
    }
    Some(A2aChild::read_reply(&mut stream))
}

/// The A2A-mode child command for a fresh home: the scripted faux
/// worker and the sandboxed supervisor socket, with extra environment
/// pairs (the shared spawn path of the listener tests and the
/// exit-path probes).
fn a2a_command(
    home: &std::path::Path,
    socket: &std::path::Path,
    env: &[(&str, &str)],
    script: &Value,
) -> Command {
    std::fs::write(home.join("worker-script.json"), script.to_string()).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "a2a", "--daemon-socket"])
        .arg(socket)
        .env("HOME", home)
        .env("PRIME_AGENT_FAUX_SCRIPT", home.join("worker-script.json"))
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        // The sandboxed home owns every child's settings and session
        // state: the invoking session's agent/session dirs never leak
        // into the spawned tree (the minted-token file and the settings
        // read stay inside the sandbox too).
        .env("PRIME_AGENT_CODING_AGENT_DIR", home.join(".prime/agent"))
        .env_remove("PRIME_AGENT_SESSION_DIR")
        // The caller's pairs ride LAST, so an explicit pair wins over
        // the defaults (the two-server token test points a second
        // server at the first's agent dir).
        .envs(
            env.iter()
                .map(|(name, value)| (name.to_string(), value.to_string())),
        )
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The worker kernels run the scripted tool calls (the scrub pin's
    // `ipython` probe): the same explicit interpreter the other e2e
    // harnesses pass — the offline container gate has no kernel venv
    // inside the sandboxed home — resolved the same way
    // (`PA_E2E_KERNEL_PYTHON`, else the invoking home's kernel venv),
    // and only set when it exists (a bare host inherits instead).
    let kernel_python = std::env::var_os("PA_E2E_KERNEL_PYTHON").unwrap_or_else(|| {
        std::ffi::OsString::from(std::env::var("HOME").map_or_else(
            |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
            |invoking| format!("{invoking}/.prime/agent/kernel-venv/bin/python"),
        ))
    });
    if std::path::Path::new(&kernel_python).exists() {
        command.env("PRIME_AGENT_KERNEL_PYTHON", kernel_python);
    }
    command
}

/// The minted token file's path as its startup line prints it (the
/// line precedes the listening line, so the harness's captured startup
/// lines carry it).
fn minted_token_path(lines: &[String]) -> Option<std::path::PathBuf> {
    lines
        .iter()
        .find(|line| line.contains("minted one for this run"))?
        .split("wrote it to ")
        .nth(1)?
        .split(" (present it")
        .next()
        .map(|path| path.trim().into())
}

/// The run's MINTED bearer token (`a2a-token-<port>-<address>` in
/// the agent dir under the sandboxed home, its path printed at
/// startup),
/// read once the listener answered: a run configured with no token
/// mints one, and the harness presents the MINTED
/// token on every request by default — a run configured with
/// `PRIME_AGENT_A2A_TOKEN` carries no minted token, so its probes
/// choose their own auth exactly (the bearer-gate test asserts the
/// challenge on its unauthenticated probes).
fn a2a_run_token(lines: &[String]) -> Option<String> {
    minted_token_path(lines)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

impl Drop for A2aChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let lines = self.stderr_dump();
        if !lines.is_empty() {
            eprintln!("A2A child stderr: {lines}");
        }
        shutdown_sandboxed_daemon(&self.socket);
    }
}

/// The faux worker script of the plain suites: two queued replies for
/// the two-turn suites (the faux engine answers one prompt per queued
/// response; an empty queue fails the turn).
fn plain_script() -> Value {
    json!({ "engine": "faux", "responses": ["A2A-OK", "A2A-OK-2"] })
}

/// Recursively collect a home's `.jsonl` session files, skipping the
/// selected file (the --fork side-effect probe: a refused selection must
/// leave no copy behind).
fn collect_jsonl(
    dir: &std::path::Path,
    skip: &std::path::Path,
    found: &mut Vec<std::path::PathBuf>,
) {
    for entry in std::fs::read_dir(dir).expect("the home is readable") {
        let path = entry.expect("a readable entry").path();
        if path == skip {
            continue;
        }
        if path.is_dir() {
            collect_jsonl(&path, skip, found);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            found.push(path);
        }
    }
}

/// One daemon `list` probe against the sandboxed supervisor socket (the
/// live residents' summaries): the idle detach after a context's settle
/// is observable through the context session's `attachedClients`.
fn daemon_list(socket: &std::path::Path) -> Value {
    let Ok(mut stream) = pa_types::platform::transport::connect_blocking(socket) else {
        panic!("the supervisor socket answers");
    };
    let frame = format!(
        "{{\"type\":\"command\",\"id\":\"list-test\",\"protocol\":{{\"name\":\"prime-agent.daemon\",\"version\":{}}},\"command\":{{\"type\":\"list\"}}}}\n",
        pa_types::daemon::DAEMON_PROTOCOL_VERSION
    );
    stream
        .write_all(frame.as_bytes())
        .expect("the command writes");
    stream.flush().expect("the flush lands");
    for line in BufReader::new(stream).lines() {
        let line = line.expect("a readable line");
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["type"] == "response" && value["id"] == "list-test" {
            assert!(value["success"].as_bool().unwrap_or(false), "{value}");
            return value;
        }
    }
    panic!("the daemon never answered the list probe");
}

/// Stop the sandboxed supervisor a test spawned.
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

/// The card served at the well-known URI declares exactly the served
/// surface (spec 8.3/4.4): the JSON-RPC interface preferred, streaming
/// on, push and extended card off, one skill, and the caching headers.
#[test]
fn a2a_card_served_at_the_well_known_uri() {
    let child = A2aChild::spawn(&[], &plain_script());
    let reply = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    assert_eq!(reply.status, 200);
    let card = A2aChild::body_json(&reply);
    assert_eq!(card["name"], "Prime Agent");
    assert_eq!(card["supportedInterfaces"][0]["protocolBinding"], "JSONRPC");
    assert_eq!(card["supportedInterfaces"][0]["protocolVersion"], "1.0");
    assert_eq!(card["capabilities"]["streaming"], true);
    assert_eq!(card["capabilities"]["pushNotifications"], false);
    assert_eq!(card["capabilities"]["extendedAgentCard"], false);
    assert!(!card["skills"].as_array().unwrap().is_empty());
    assert!(card["defaultInputModes"][0].is_string());

    let etag = reply
        .headers
        .iter()
        .find(|(name, _)| name == "etag")
        .expect("the card carries an ETag");
    let revalidated = child.request(
        "GET",
        "/.well-known/agent-card.json",
        &[("If-None-Match", etag.1.as_str())],
        None,
        None,
    );
    assert_eq!(revalidated.status, 304);
}

/// The blocking send (spec 3.2.2): the task returns completed with the
/// turn's reply as its artifact, and a follow-up on the same context
/// continues the conversation (a second task on the same contextId).
#[test]
fn a2a_send_message_blocking_completes_the_task() {
    let child = A2aChild::spawn(&[], &plain_script());
    let reply = child.send_message("Say A2A-OK", None);
    assert!(
        reply.get("error").is_none()
            && reply["result"]["task"]["status"]["state"] == "TASK_STATE_COMPLETED",
        "the send completed: {reply}"
    );
    let task = &reply["result"]["task"];
    assert_eq!(task["artifacts"][0]["parts"][0]["text"], "A2A-OK");
    assert_eq!(task["history"][0]["parts"][0]["text"], "Say A2A-OK");
    assert_eq!(task["history"].as_array().unwrap().len(), 2);
    let context_id = task["contextId"]
        .as_str()
        .expect("a context id")
        .to_string();

    // The follow-up names the context: a second task on the same
    // conversation (spec 3.4.1's context continuity).
    let second = child.send_message("Again", Some(&context_id));
    let second_task = &second["result"]["task"];
    assert_eq!(second_task["contextId"], context_id.as_str());
    assert_eq!(second_task["status"]["state"], "TASK_STATE_COMPLETED");

    // An unknown context id is rejected (the spec's MUST).
    let unknown = child.request(
        "POST",
        "/",
        &[],
        Some(&A2aChild::send_message_body(
            "hi",
            Some("not-a-context"),
            None,
        )),
        Some("1.0"),
    );
    let unknown = A2aChild::body_json(&unknown);
    assert_eq!(unknown["error"]["code"], -32602);
    // The generic parameter error's detail is the spec's `Any` form
    // (spec 9.5): an array of objects each carrying `@type` — the
    // BadRequest violation names the field, never a bare map.
    assert_eq!(
        unknown["error"]["data"][0]["@type"], "type.googleapis.com/google.rpc.BadRequest",
        "{unknown}"
    );
    assert_eq!(
        unknown["error"]["data"][0]["fieldViolations"][0]["field"], "contextId",
        "{unknown}"
    );

    // A terminal task's id is rejected for continuation (spec 3.1.1),
    // and a known task with a mismatching context id is rejected too
    // (spec 3.4.3).
    let settled_id = second["result"]["task"]["id"].as_str().unwrap().to_string();
    let terminal = child.request(
        "POST",
        "/",
        &[],
        Some(&A2aChild::send_message_body("hi", None, Some(&settled_id))),
        Some("1.0"),
    );
    let terminal = A2aChild::body_json(&terminal);
    assert_eq!(terminal["error"]["code"], -32004);

    let mismatched = child.request(
        "POST",
        "/",
        &[],
        Some(&A2aChild::send_message_body(
            "hi",
            Some("not-a-context"),
            Some(&settled_id),
        )),
        Some("1.0"),
    );
    let mismatched = A2aChild::body_json(&mismatched);
    assert_eq!(mismatched["error"]["code"], -32004);
}

/// The version gate (spec 3.6.2): only 1.0 is served; the empty header
/// reads as 0.3 and answers the spec's -32009.
#[test]
fn a2a_version_gate_rejects_missing_and_unsupported() {
    let child = A2aChild::spawn(&[], &plain_script());
    let body = A2aChild::send_message_body("hi", None, None);

    let missing = child.request("POST", "/", &[], Some(&body), None);
    let missing = A2aChild::body_json(&missing);
    assert_eq!(missing["error"]["code"], -32009);
    assert_eq!(
        missing["error"]["data"][0]["reason"],
        "VERSION_NOT_SUPPORTED"
    );

    let old = child.request("POST", "/", &[], Some(&body), Some("0.3"));
    let old = A2aChild::body_json(&old);
    assert_eq!(old["error"]["code"], -32009);

    // The patch suffix is ignored (Major.Minor negotiation).
    let patch = child.request("POST", "/", &[], Some(&body), Some("1.0.1"));
    assert_eq!(patch.status, 200);
}

/// The streaming send (spec 3.1.2): the stream opens with the Task
/// object, carries the artifact chunks, and closes on the terminal
/// status update.
#[test]
fn a2a_streaming_send_emits_the_ordered_sse_frames() {
    let child = A2aChild::spawn(&[], &plain_script());
    let body = json!({
        "jsonrpc": "2.0",
        "id": 9,
        "method": "SendStreamingMessage",
        "params": {
            "message": {
                "messageId": "m-1",
                "role": "ROLE_USER",
                "parts": [{ "text": "stream me" }],
            }
        }
    });
    let reply = child.request_sse("POST", "/", &[], Some(&body), Some("1.0"));
    assert_eq!(reply.status, 200, "the streaming send answered SSE");
    let frames = A2aChild::sse_lines(&reply);
    assert!(!frames.is_empty(), "the stream produced frames");
    assert_eq!(frames[0]["id"], 9);
    // The first frame wraps the task snapshot in the stream payload's
    // oneof member (`StreamResponse`'s `task`, spec 3.1.2/9.4.2): a
    // conforming client reads `result.task.id` — a bare Task shape
    // makes strict ProtoJSON reject the frame and the official client
    // lose the task id.
    assert!(
        frames[0]["result"].get("task").is_some(),
        "the first frame carries the task inside the stream response oneof: {frames:?}"
    );
    assert_eq!(
        frames[0]["result"]["task"]["contextId"], frames[0]["result"]["task"]["contextId"],
        "the wrapped snapshot parses"
    );
    assert!(
        frames[0]["result"].get("status").is_none()
            && frames[0]["result"].get("artifactUpdate").is_none(),
        "the first frame carries exactly one oneof member: {frames:?}"
    );
    let mut saw_artifact = false;
    let mut saw_terminal = false;
    for frame in &frames {
        if let Some(update) = frame["result"].get("artifactUpdate") {
            saw_artifact = true;
            assert_eq!(
                update["artifact"]["parts"][0]["text"], "A2A-OK",
                "the artifact chunk carried the whole reply"
            );
        }
        if let Some(update) = frame["result"].get("statusUpdate") {
            if update["status"]["state"] == "TASK_STATE_COMPLETED" {
                saw_terminal = true;
            }
        }
    }
    assert!(
        saw_artifact,
        "the stream carried the reply chunks: {frames:?}"
    );
    assert!(saw_terminal, "the terminal status closed the stream");
    // The terminal frame is the last data frame (spec: the stream closes
    // at the terminal state).
    let last = frames.last().expect("the last frame");
    assert!(last["result"].get("statusUpdate").is_some());
}

/// `GetTask` (spec 3.1.3): the settled task's snapshot, the unknown id
/// the spec's -32001 with the `ErrorInfo` detail.
#[test]
fn a2a_get_task_unknown_answers_task_not_found() {
    let child = A2aChild::spawn(&[], &plain_script());
    let sent = child.send_message("hello", None);
    let task_id = sent["result"]["task"]["id"].as_str().unwrap().to_string();

    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(get["result"]["status"]["state"], "TASK_STATE_COMPLETED");

    let unknown = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "GetTask",
            "params": { "id": "not-a-task" },
        })),
        Some("1.0"),
    );
    let unknown = A2aChild::body_json(&unknown);
    assert_eq!(unknown["error"]["code"], -32001);
    assert_eq!(unknown["error"]["data"][0]["reason"], "TASK_NOT_FOUND");
}

/// `ListTasks` (spec 3.1.4): the tasks newest first, the always-present
/// next token, and the filters.
#[test]
fn a2a_list_tasks_answers_the_registry() {
    let child = A2aChild::spawn(&[], &plain_script());
    let first = child.send_message("one", None);
    let second = child.send_message("two", None);
    let first_id = first["result"]["task"]["id"].clone();
    let second_id = second["result"]["task"]["id"].clone();

    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "ListTasks",
            "params": { "pageSize": 1 },
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list)["result"].clone();
    assert_eq!(list["totalSize"], 2);
    assert_eq!(list["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(list["tasks"][0]["id"], second_id, "newest first");

    let next = list["nextPageToken"].as_str().unwrap().to_string();
    let page2 = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "ListTasks",
            "params": { "pageSize": 1, "pageToken": next },
        })),
        Some("1.0"),
    );
    let page2 = A2aChild::body_json(&page2)["result"].clone();
    assert_eq!(page2["tasks"][0]["id"], first_id);
    assert_eq!(page2["nextPageToken"], "", "the last page's token is empty");

    // A pageToken this server did not mint answers the binding's
    // invalid-params (-32602), never a silent restart at page one.
    let garbage = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "ListTasks",
            "params": { "pageSize": 1, "pageToken": "not-a-minted-token" },
        })),
        Some("1.0"),
    );
    let garbage = A2aChild::body_json(&garbage);
    assert_eq!(
        garbage["error"]["code"], -32602.0,
        "an unminted page token answers invalid-params: {garbage}"
    );
}

/// `CancelTask` (spec 3.1.5): the slow-turn cancel answers the canceled
/// state, and the cancel of a settled task answers the spec's -32002.
#[test]
fn a2a_cancel_task_answers_the_canceled_state() {
    // The slow faux: the turn takes long enough to cancel mid-flight.
    let script = json!({
        "engine": "faux",
        "tokensPerSecond": 2,
        "responses": ["a slow reply to cancel mid-flight"],
    });
    let child = A2aChild::spawn(&[], &script);

    // The blocking send runs in its own connection (the turn runs
    // while the test drives the cancel on another one). The run's
    // minted token rides it: the auth gate fires before the task is
    // admitted, and a tokenless send would admit nothing for the poll
    // below to find (its tight loop would then spin out the machine's
    // ephemeral ports for the full deadline).
    let auth = format!(
        "Bearer {}",
        child.token.as_deref().expect("the run carries its token")
    );
    let url = child.url.clone();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let body = A2aChild::send_message_body("slow", None, None);
    std::thread::spawn(move || {
        let reply = request(
            &url,
            "POST",
            "/",
            &[("Authorization", auth.as_str())],
            Some(&body),
            Some("1.0"),
        );
        let _ = tx.send(String::from_utf8_lossy(&reply.raw).to_string());
    });

    // The observable readiness: the task reaches WORKING (GetTask
    // until it does — the 50 ms poll step, never a tight connect
    // loop).
    let mut task_id = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        let reply = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 11,
                "method": "ListTasks",
                "params": { "status": "TASK_STATE_WORKING" },
            })),
            Some("1.0"),
        );
        let list = A2aChild::body_json(&reply);
        if let Some(task) = list["result"]["tasks"]
            .as_array()
            .and_then(|tasks| tasks.first())
        {
            task_id = task["id"].as_str().map(str::to_string);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let task_id = task_id.expect("the slow task reached WORKING");

    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the cancel of a live task answers a task: {cancel}"
    );
    // The aborted turn settles through the worker's abort settle (the
    // `canceled` snapshot, never a stranded WORKING one).
    let state = cancel["result"]["status"]["state"].as_str().unwrap_or("");
    assert_eq!(state, "TASK_STATE_CANCELED", "the cancel settles: {cancel}");
    // The aborted send's connection settles too (the request returns).
    let _settled = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the cancelled turn settles its blocking send");

    // A settled task is not cancelable (spec 3.1.5).
    let settled = child.send_message("quick", None);
    let settled_id = settled["result"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let refused = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "CancelTask",
            "params": { "id": settled_id },
        })),
        Some("1.0"),
    );
    let refused = A2aChild::body_json(&refused);
    assert_eq!(refused["error"]["code"], -32002);
    assert_eq!(refused["error"]["data"][0]["reason"], "TASK_NOT_CANCELABLE");
}

/// The bearer gate: a configured token (the environment variable,
/// never a flag) leaves the well-known Agent Card public — spec 14.3
/// makes it the discovery surface, and an unknown client must be able
/// to read the `bearer` security scheme it needs to present (13.3's
/// MUST-authenticate applies to the task routes) — while every task
/// route refuses unauthenticated requests with a 401 that carries the
/// `WWW-Authenticate` challenge, accepts the credentials whatever the
/// scheme's casing (RFC 9110 §11.1), and serves the right token.
#[test]
fn a2a_bearer_token_gates_the_task_routes_only() {
    let child = A2aChild::spawn_with_env(
        &[("PRIME_AGENT_A2A_TOKEN", "test-token")],
        &[],
        &plain_script(),
    );
    // The card is the public discovery surface: it serves without the
    // token and declares the scheme the task routes enforce.
    let card_reply = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    assert_eq!(card_reply.status, 200, "the card serves unauthenticated");
    let card = A2aChild::body_json(&card_reply);
    assert!(
        card["securitySchemes"]["bearer"].is_object(),
        "the token-configured card declares its scheme: {card}"
    );

    // The task routes stay authenticated: a send without the token
    // answers the challenge.
    let refused = child.request(
        "POST",
        "/",
        &[],
        Some(&A2aChild::send_message_body("gate", None, None)),
        Some("1.0"),
    );
    assert_eq!(refused.status, 401);
    assert!(
        refused
            .headers
            .iter()
            .any(|(name, value)| name == "www-authenticate" && value.contains("Bearer")),
        "the 401 carries the challenge: {refused:?}"
    );

    let wrong = child.request(
        "POST",
        "/",
        &[("Authorization", "Bearer wrong")],
        Some(&A2aChild::send_message_body("gate", None, None)),
        Some("1.0"),
    );
    assert_eq!(wrong.status, 401);
    assert!(
        wrong
            .headers
            .iter()
            .any(|(name, _)| name == "www-authenticate"),
        "every 401 carries the challenge: {wrong:?}"
    );

    // The scheme's casing does not matter; the token compares exactly.
    let lower = child.request(
        "POST",
        "/",
        &[("Authorization", "bearer test-token")],
        Some(&A2aChild::send_message_body("gate", None, None)),
        Some("1.0"),
    );
    assert_eq!(lower.status, 200, "the case-insensitive scheme serves");
}

/// A non-loopback bind prints the loud warning with the REAL posture
/// (the spec's enterprise-section stance this mode holds): the token
/// gates every task route — a minted per-run token is unusable for
/// remote peers — and the bind still needs a TLS front (the token
/// authenticates, it does not encrypt). The false
/// "unauthenticated agent" sentence is gone: the minted run never
/// serves a task route open.
#[test]
fn a2a_non_loopback_bind_warns_about_tls_and_the_token() {
    let child = A2aChild::spawn(&["--a2a-host", "0.0.0.0"], &plain_script());
    let stderr = child.stderr_dump();
    assert!(
        stderr.contains("Warning: the A2A server is binding 0.0.0.0 on a non-loopback interface"),
        "the non-loopback warning printed: {stderr}"
    );
    assert!(
        stderr.contains("front the bind with TLS"),
        "the warning names the TLS front: {stderr}"
    );
    assert!(
        stderr.contains("A bearer token gates every task route"),
        "the warning states the token-gated posture: {stderr}"
    );
    assert!(
        !stderr.contains("without a bearer token"),
        "the false unauthenticated-agent sentence is gone: {stderr}"
    );
    // The minted token still gates the task routes (the warning does
    // not stop the bind; the posture is authenticated, not open).
    let refused = request(
        &child.url,
        "POST",
        "/",
        &[],
        Some(&A2aChild::send_message_body("gate", None, None)),
        Some("1.0"),
    );
    assert_eq!(refused.status, 401, "the unauthenticated send is refused");
    // And the server still serves the card (public discovery).
    let reply = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    assert_eq!(reply.status, 200);
}

/// The capability-gated methods answer the spec's -32003/-32004 (the
/// card declares them off).
#[test]
fn a2a_capability_gated_methods_answer_their_errors() {
    let child = A2aChild::spawn(&[], &plain_script());
    let push = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "CreateTaskPushNotificationConfig",
            "params": { "taskId": "t", "url": "https://example.com/hook" },
        })),
        Some("1.0"),
    );
    let push = A2aChild::body_json(&push);
    assert_eq!(push["error"]["code"], -32003);

    let extended = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "GetExtendedAgentCard",
        })),
        Some("1.0"),
    );
    let extended = A2aChild::body_json(&extended);
    assert_eq!(extended["error"]["code"], -32004);

    let unknown_method = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "NotAMethod",
        })),
        Some("1.0"),
    );
    let unknown_method = A2aChild::body_json(&unknown_method);
    assert_eq!(unknown_method["error"]["code"], -32601);
}

/// A `ListTasks` row poller: one task in the state, or `None` within the
/// bound (the observable-readiness pattern, never a blind sleep).
/// Wait until the registry holds any task (the blocking send's
/// admission receipt: the server read the request and admitted the
/// flow), returning its id.
fn wait_for_any_task(child: &A2aChild) -> Option<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        let reply = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 45,
                "method": "ListTasks",
                "params": {},
            })),
            Some("1.0"),
        );
        let list = A2aChild::body_json(&reply);
        if let Some(task) = list["result"]["tasks"]
            .as_array()
            .and_then(|tasks| tasks.first())
        {
            return task["id"].as_str().map(str::to_string);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn wait_for_task_in_state(child: &A2aChild, state: &str) -> Option<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while std::time::Instant::now() < deadline {
        let reply = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 41,
                "method": "ListTasks",
                "params": { "status": state },
            })),
            Some("1.0"),
        );
        let list = A2aChild::body_json(&reply);
        if let Some(task) = list["result"]["tasks"]
            .as_array()
            .and_then(|tasks| tasks.first())
        {
            return task["id"].as_str().map(str::to_string);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/// One daemon-protocol command over the sandboxed supervisor socket: the
/// first response value (the A2A mode's own transport, used by the
/// untracked-turn probe).
fn daemon_command(socket: &std::path::Path, command: &Value) -> Value {
    use std::io::Write as _;
    let mut stream = pa_types::platform::transport::connect_blocking(socket)
        .expect("the sandboxed supervisor socket answers");
    let frame = format!(
        "{{\"type\":\"command\",\"id\":\"probe\",\"protocol\":{{\"name\":\"prime-agent.daemon\",\"version\":{}}},\"command\":{}}}\n",
        pa_types::daemon::DAEMON_PROTOCOL_VERSION,
        serde_json::to_string(command).unwrap()
    );
    stream
        .write_all(frame.as_bytes())
        .expect("the daemon command writes");
    stream.flush().expect("the flush lands");
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if value.get("type").and_then(Value::as_str) == Some("response") {
                return value;
            }
        }
        line.clear();
    }
    panic!("the daemon command never answered");
}

/// The one live session of a fresh sandbox (the A2A context's).
fn daemon_live_session(socket: &std::path::Path) -> String {
    let reply = daemon_command(socket, &json!({ "type": "list", "all": true }));
    assert!(reply["success"].as_bool().unwrap_or(false), "{reply}");
    reply["data"]["sessions"]
        .as_array()
        .and_then(|sessions| sessions.first())
        .and_then(|session| session.get("activeSessionId"))
        .and_then(Value::as_str)
        .expect("one live session")
        .to_string()
}

/// One session's live roster row (its live fields — the worker pid,
/// the attached-client count — are the e2e's daemon-side observables).
fn daemon_row(socket: &std::path::Path, session: &str) -> Value {
    let reply = daemon_command(socket, &json!({ "type": "list", "all": true }));
    assert!(reply["success"].as_bool().unwrap_or(false), "{reply}");
    reply["data"]["sessions"]
        .as_array()
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|row| row["activeSessionId"].as_str() == Some(session))
                .cloned()
        })
        .expect("the session's live row")
}

/// One `SendMessage`/`SendStreamingMessage` request body with a
/// configuration object and the message's context/task wiring.
fn send_body(
    text: &str,
    context_id: Option<&str>,
    task_id: Option<&str>,
    configuration: Value,
) -> Value {
    let mut body = A2aChild::send_message_body(text, context_id, task_id);
    body["params"]["configuration"] = configuration;
    // A fixed messageId keeps the history assertions exact.
    body["params"]["message"]["messageId"] = json!("m-1");
    body
}

/// The JSON-RPC binding's HTTP surface (spec 9): a protocol POST must
/// carry `Content-Type: application/json` (a form's `text/plain` answers
/// -32005 with no task admitted), and `A2A-Version` rides the header
/// only — the query string no longer substitutes for it (spec 9.2).
#[test]
fn a2a_protocol_posts_need_the_json_content_type_and_version_header() {
    let child = A2aChild::spawn(&[], &plain_script());
    // The minted token rides every probe: the auth gate fires before
    // the content-type and version gates, and the probes assert the
    // PROTOCOL errors, not the 401.
    let token = child
        .token
        .as_deref()
        .expect("the run carries its token")
        .to_string();
    let token = format!("Bearer {token}");
    let auth = ("Authorization", token.as_str());
    let body = serde_json::to_vec(&A2aChild::send_message_body("hi", None, None)).unwrap();

    let form = raw_request(
        &child.url,
        "POST",
        "/",
        &[
            ("Content-Type", "text/plain;charset=UTF-8"),
            ("A2A-Version", "1.0"),
            auth,
        ],
        &body,
        true,
    )
    .expect("the probe answered");
    let form = serde_json::from_slice::<Value>(&form.body).expect("a JSON error");
    assert_eq!(form["error"]["code"], -32005, "{form}");
    // The refusal advertises the BINDING's media type (the JSON-RPC
    // body format), not the card's input mode.
    assert_eq!(
        form["error"]["data"][0]["metadata"]["supported"], "application/json",
        "{form}"
    );

    // The media type compares case-insensitively (RFC 9110 §8.3.1):
    // "Application/JSON" is served like the lowercase form (a read-only
    // ListTasks keeps the no-task-admitted invariant below intact).
    let list_body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": 57,
        "method": "ListTasks",
        "params": {},
    }))
    .unwrap();
    let case_form = raw_request(
        &child.url,
        "POST",
        "/",
        &[
            ("Content-Type", "Application/JSON"),
            ("A2A-Version", "1.0"),
            auth,
        ],
        &list_body,
        true,
    )
    .expect("the probe answered");
    let case_form = serde_json::from_slice::<Value>(&case_form.body).expect("a JSON body");
    assert!(
        case_form.get("error").is_none() && case_form["result"].get("totalSize").is_some(),
        "the case-variant media type is served: {case_form}"
    );

    let bare = raw_request(
        &child.url,
        "POST",
        "/",
        &[("A2A-Version", "1.0"), auth],
        &body,
        true,
    )
    .expect("the probe answered");
    let bare = serde_json::from_slice::<Value>(&bare.body).expect("a JSON error");
    assert_eq!(bare["error"]["code"], -32005, "{bare}");

    let query = raw_request(
        &child.url,
        "POST",
        "/?A2A-Version=1.0",
        &[("Content-Type", "application/json"), auth],
        &body,
        true,
    )
    .expect("the probe answered");
    let query = serde_json::from_slice::<Value>(&query.body).expect("a JSON error");
    assert_eq!(query["error"]["code"], -32009, "{query}");

    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "ListTasks",
            "params": {},
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(list["result"]["totalSize"], 0, "no task was admitted");
}

/// The loopback bind's browser-surface refusals: a foreign `Host` (DNS
/// rebinding) and a browser `Origin` answer 403 with no task admitted.
#[test]
fn a2a_loopback_bind_refuses_foreign_hosts_and_origins() {
    let child = A2aChild::spawn(&[], &plain_script());
    // The minted token rides both probes: the auth gate fires before
    // the Host and Origin gates, and the probes assert the BINDING's
    // refusals, not the 401.
    let auth = format!(
        "Bearer {}",
        child.token.as_deref().expect("the run carries its token")
    );
    let body = serde_json::to_vec(&A2aChild::send_message_body("hi", None, None)).unwrap();

    let rebound = raw_request(
        &child.url,
        "POST",
        "/",
        &[
            ("Host", "rebound.attacker.example"),
            ("Content-Type", "application/json"),
            ("A2A-Version", "1.0"),
            ("Authorization", auth.as_str()),
        ],
        &body,
        true,
    )
    .expect("the probe answered");
    assert_eq!(rebound.status, 403, "the rebound Host is refused");

    let origin = raw_request(
        &child.url,
        "POST",
        "/",
        &[
            ("Content-Type", "application/json"),
            ("A2A-Version", "1.0"),
            ("Origin", "https://attacker.example"),
            ("Authorization", auth.as_str()),
        ],
        &body,
        true,
    )
    .expect("the probe answered");
    assert_eq!(origin.status, 403, "the browser Origin is refused");

    // Host names are case-insensitive (RFC 9110 §7.2): the cased
    // loopback name serves the same bind.
    let cased = raw_request(
        &child.url,
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "LocalHost")],
        &[],
        true,
    )
    .expect("the probe answered");
    assert_eq!(cased.status, 200, "the cased loopback Host serves");

    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 43,
            "method": "ListTasks",
            "params": {},
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(list["result"]["totalSize"], 0, "no task was admitted");
}

/// A client disconnect mid-turn cannot strand the flow (the settle runs
/// detached from the connection): the task settles with its own reply,
/// and the next task on the context keeps its own artifact.
#[test]
fn a2a_a_disconnect_does_not_strand_the_send_flow() {
    let script = json!({ "engine": "faux", "responses": [
        { "text": "SLOW-REPLY", "delayMs": 1500 },
        "SECOND-REPLY",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let auth = format!(
        "Bearer {}",
        child.token.as_deref().expect("the run carries its token")
    );
    let body = serde_json::to_vec(&A2aChild::send_message_body("slow", None, None)).unwrap();
    // The blocking send's connection stays open until the server has
    // admitted the task (the receipt guarantee: dropping before the
    // server reads the body is a truncated request on the Linux
    // loopback, where the connection reset races the buffered read —
    // no task is ever admitted, and the test would pin nothing), then
    // drops mid-turn — the first reply is still 1500ms out, so the
    // settle must run detached from the connection.
    let address = child.url.trim_start_matches("http://").to_string();
    let mut held = TcpStream::connect(&address).expect("the listener answers");
    let request = format!(
        "POST / HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\n\
         A2A-Version: 1.0\r\nAuthorization: {auth}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    held.write_all(request.as_bytes())
        .expect("the raw request writes");
    held.write_all(&body).expect("the raw body writes");
    held.flush().expect("the flush lands");
    let admitted_id = wait_for_any_task(&child).expect("the server admitted the send");
    drop(held);

    let task_id = wait_for_task_in_state(&child, "TASK_STATE_COMPLETED")
        .expect("the disconnected send still settled");
    assert_eq!(task_id, admitted_id, "the settled task is the admitted one");
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 44,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    let task = &get["result"];
    assert_eq!(task["artifacts"][0]["parts"][0]["text"], "SLOW-REPLY");
    let context_id = task["contextId"].as_str().expect("the context").to_string();

    let second = child.send_message("again", Some(&context_id));
    assert_eq!(
        second["result"]["task"]["artifacts"][0]["parts"][0]["text"],
        "SECOND-REPLY"
    );
}

/// A session turn no A2A task owns (a daemon prompt into the resident
/// session) never lands its text in the next task's artifact.
#[test]
fn a2a_untracked_session_turns_never_reach_task_artifacts() {
    let script = json!({ "engine": "faux", "responses": [
        "FIRST-REPLY",
        { "text": "UNTRACKED-TURN-TEXT", "delayMs": 1200 },
        "SECOND-REPLY",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let first = child.send_message("one", None);
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();

    // A daemon prompt on the same session: a turn no A2A task owns.
    let session = daemon_live_session(&child.socket);
    let prompt = daemon_command(
        &child.socket,
        &json!({ "type": "prompt", "activeSessionId": session, "message": "untracked input" }),
    );
    assert!(prompt["success"].as_bool().unwrap_or(false), "{prompt}");
    // The observable readiness: the untracked turn is streaming.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let state = daemon_command(
            &child.socket,
            &json!({ "type": "get_state", "activeSessionId": session }),
        );
        if state["data"]["isStreaming"].as_bool() == Some(true) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the untracked turn never started: {state}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    // The second A2A task queues behind the untracked turn and completes
    // with its own reply alone.
    let second = child.send_message("two", Some(&context_id));
    assert_eq!(
        second["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the queued task completed: {second}"
    );
    let artifact = second["result"]["task"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(
        artifact, "SECOND-REPLY",
        "the untracked turn's text never joined the task's artifact: {artifact}"
    );
}

/// The `returnImmediately` handoff (spec 3.2.2): a task is
/// acknowledged only after its prompt reached the daemon, so a cancel
/// sent right behind the acknowledgement finds a registered admission
/// and settles CANCELED — never -32002 with the prompt left running.
#[test]
fn a2a_a_return_immediately_task_is_cancelable_at_once() {
    let script = json!({ "engine": "faux", "responses": [
        { "text": "held reply", "delayMs": 20000 },
    ]});
    let child = A2aChild::spawn(&[], &script);
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "first",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();

    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 45,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the acknowledged task is cancelable: {cancel}"
    );

    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let get = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 46,
                "method": "GetTask",
                "params": { "id": task_id },
            })),
            Some("1.0"),
        );
        let get = A2aChild::body_json(&get);
        let state = get["result"]["status"]["state"].as_str().unwrap_or("");
        assert!(
            state != "TASK_STATE_FAILED",
            "the cancel settles canceled, not failed: {get}"
        );
        if state == "TASK_STATE_CANCELED" {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the cancelled task never settled: {get}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A queued task's cancel (spec 3.1.5) settles CANCELED: the queued
/// admission withdraws with the explicit deleted-queue settle, never the
/// broken-channel "Prompt did not complete" that reads as FAILED.
#[test]
fn a2a_a_queued_task_cancel_settles_canceled() {
    // A stream-paced reply keeps the first task WORKING (the ack
    // snapshot arrives SUBMITTED, before the first frame), so the
    // second task deterministically queues behind its turn.
    let script = json!({ "engine": "faux", "tokensPerSecond": 2, "responses": [
        "held reply",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "held",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let context_id = held["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();
    wait_for_task_in_state(&child, "TASK_STATE_WORKING")
        .expect("the paced reply keeps the held task WORKING");

    // Two tasks queue behind the held turn: the write turnstile means
    // neither ever writes its prompt, so one queued task's cancel can
    // never touch the other — no daemon-side batch co-delivers them.
    let queued = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "queued behind",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let queued = A2aChild::body_json(&queued);
    let queued_id = queued["result"]["task"]["id"]
        .as_str()
        .expect("the queued task")
        .to_string();
    let sibling = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "sibling behind",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let sibling = A2aChild::body_json(&sibling);
    let sibling_id = sibling["result"]["task"]["id"]
        .as_str()
        .expect("the sibling task")
        .to_string();

    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 47,
            "method": "CancelTask",
            "params": { "id": sibling_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the queued sibling is cancelable: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the queued cancel settles canceled: {cancel}"
    );
    // The canceled sibling never touched its queued neighbor: the other
    // queued task is still live and cancelable on its own.
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 63,
            "method": "GetTask",
            "params": { "id": queued_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(
        get["result"]["status"]["state"], "TASK_STATE_SUBMITTED",
        "the sibling's cancel left the other queued task untouched: {get}"
    );

    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 64,
            "method": "CancelTask",
            "params": { "id": queued_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the remaining queued task is cancelable: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the second queued cancel settles canceled too: {cancel}"
    );
}

/// `ListTasks` (spec 3.1.4): `statusTimestampAfter` is the inclusive
/// filter (a future timestamp returns nothing) and list rows omit
/// artifacts unless `includeArtifacts` asks for them.
#[test]
fn a2a_list_tasks_applies_the_v1_filters() {
    let child = A2aChild::spawn(&[], &plain_script());
    let first = child.send_message("one", None);
    let first_task_id = first["result"]["task"]["id"]
        .as_str()
        .expect("the first task's id")
        .to_string();
    let _second = child.send_message("two", None);

    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 48,
            "method": "ListTasks",
            "params": { "statusTimestampAfter": "2999-01-01T00:00:00Z" },
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(list["result"]["totalSize"], 0, "the future floor filters");

    // The timestamp is parsed as an instant, never a literal clock: the
    // first task's own status timestamp in a `+00:00` offset form
    // filters inclusively at the same instant, and the same clock with
    // a `-01:00` offset is one hour LATER in UTC terms, so nothing
    // matches. Invalid syntax is a parameter error, never a silent
    // no-filter.
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 58,
            "method": "GetTask",
            "params": { "id": first_task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    let stamp = get["result"]["status"]["timestamp"]
        .as_str()
        .expect("the status timestamp")
        .to_string();
    let same_instant = stamp.replace('Z', "+00:00");
    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 59,
            "method": "ListTasks",
            "params": { "statusTimestampAfter": same_instant },
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(
        list["result"]["totalSize"], 2,
        "the offset form of the same instant filters inclusively: {list}"
    );
    let later_instant = stamp.replace('Z', "-01:00");
    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 60,
            "method": "ListTasks",
            "params": { "statusTimestampAfter": later_instant },
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(
        list["result"]["totalSize"], 0,
        "the offset shifted the instant one hour later, so nothing matches: {list}"
    );
    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 61,
            "method": "ListTasks",
            "params": { "statusTimestampAfter": "1970-01-01T00:00:00GARBAGE" },
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(
        list["error"]["code"], -32602,
        "invalid timestamp syntax is a parameter error: {list}"
    );

    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 49,
            "method": "ListTasks",
            "params": {},
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert!(
        list["result"]["tasks"]
            .as_array()
            .expect("rows")
            .iter()
            .all(|task| task.get("artifacts").is_none() || task["artifacts"].is_null()),
        "list rows omit artifacts by default: {list}"
    );

    let with_artifacts = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 50,
            "method": "ListTasks",
            "params": { "includeArtifacts": true },
        })),
        Some("1.0"),
    );
    let with_artifacts = A2aChild::body_json(&with_artifacts);
    assert!(
        with_artifacts["result"]["tasks"]
            .as_array()
            .expect("rows")
            .iter()
            .all(|task| !task["artifacts"].as_array().unwrap().is_empty()),
        "includeArtifacts carries the artifacts: {with_artifacts}"
    );
}

/// An inline `taskPushNotificationConfig` (spec 3.2.2) answers the
/// spec's -32003 before any context or prompt side effect.
#[test]
fn a2a_an_inline_push_config_is_refused() {
    let child = A2aChild::spawn(&[], &plain_script());
    let push = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "hi",
            None,
            None,
            json!({ "taskPushNotificationConfig": { "url": "https://example.com/hook" } }),
        )),
        Some("1.0"),
    );
    let push = A2aChild::body_json(&push);
    assert_eq!(push["error"]["code"], -32003, "{push}");

    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 51,
            "method": "ListTasks",
            "params": {},
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(list["result"]["totalSize"], 0, "no task was admitted");
}

/// An inline `taskPushNotificationConfig` on a `taskId` continuation
/// answers the same -32003 (spec 3.2.2) BEFORE the refusal: the
/// task's history stays unchanged.
#[test]
fn a2a_a_continuation_with_an_inline_push_config_is_refused() {
    let script = json!({ "engine": "faux", "responses": [
        { "text": "held reply", "delayMs": 20000 },
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "held",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let task_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    let context_id = held["result"]["task"]["contextId"]
        .as_str()
        .unwrap()
        .to_string();

    let continuation = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "continue",
            Some(&context_id),
            Some(&task_id),
            json!({ "taskPushNotificationConfig": { "url": "https://example.com/hook" } }),
        )),
        Some("1.0"),
    );
    let continuation = A2aChild::body_json(&continuation);
    assert_eq!(continuation["error"]["code"], -32003, "{continuation}");

    // No continuation reached the session: the task's history is still
    // the one user message it was admitted with.
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 53,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(
        get["result"]["history"].as_array().map(Vec::len),
        Some(1),
        "the refused continuation joined no history: {get}"
    );
}

/// The v1 `taskId` continuation contract (spec 3.4.3): every KNOWN
/// task answers the -32004 "cannot continue" refusal — WORKING and
/// SUBMITTED alike, the same answer a terminal task gets (pinned in
/// `a2a_send_message_blocking_completes_the_task`) — and the
/// continuation never reaches the session. An unknown id stays the
/// spec's -32001. The turn-based session model has no mid-turn
/// injection: a client continues the conversation by sending a new
/// message on the context.
#[test]
fn a2a_a_task_id_continuation_answers_the_refusal_in_every_live_state() {
    // One paced reply holds the first task WORKING mid-turn; the
    // second send, admitted behind it on the same context, stays
    // SUBMITTED while the head streams.
    let script = json!({
        "engine": "faux",
        "tokensPerSecond": 2,
        "responses": [
            "a paced reply that streams slowly enough for the mid-turn continuation probe",
            "the queued task's own reply",
        ],
    });
    let child = A2aChild::spawn(&[], &script);
    let get_task = |id: &str, request_id: i32| {
        let reply = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "GetTask",
                "params": { "id": id },
            })),
            Some("1.0"),
        );
        A2aChild::body_json(&reply)
    };
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "held",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let context_id = held["result"]["task"]["contextId"]
        .as_str()
        .unwrap()
        .to_string();
    let working_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    let queued = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "queued",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let queued = A2aChild::body_json(&queued);
    let submitted_id = queued["result"]["task"]["id"].as_str().unwrap().to_string();

    // The head is WORKING (its prompt dispatched; the turn may not
    // have streamed yet); the queued task behind it is SUBMITTED (its
    // turn never started).
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let working = get_task(&working_id, 51);
        assert_eq!(working["result"]["id"], working_id.as_str(), "{working}");
        if working["result"]["status"]["state"] == "TASK_STATE_WORKING" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the paced reply never reached WORKING: {working}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let submitted = get_task(&submitted_id, 52);
    assert_eq!(
        submitted["result"]["status"]["state"], "TASK_STATE_SUBMITTED",
        "the queued task stays SUBMITTED behind the streaming head: {submitted}"
    );

    for task_id in [&working_id, &submitted_id] {
        let continuation = child.request(
            "POST",
            "/",
            &[],
            Some(&send_body(
                "continuation",
                Some(&context_id),
                Some(task_id),
                json!({}),
            )),
            Some("1.0"),
        );
        let continuation = A2aChild::body_json(&continuation);
        assert_eq!(continuation["error"]["code"], -32004, "{continuation}");
        assert_eq!(
            continuation["error"]["data"][0]["metadata"]["reason"],
            "this server does not continue tasks by taskId; send a new message on the context instead",
            "the refusal's ErrorInfo carries the contract's guidance: {continuation}"
        );
    }

    // The refusal reached no session: each task's history is still the
    // one user message it was admitted with, and both settle with
    // their own replies (the continuation ran no turn).
    for (id, expected) in [
        (
            &working_id,
            "a paced reply that streams slowly enough for the mid-turn continuation probe",
        ),
        (&submitted_id, "the queued task's own reply"),
    ] {
        let settled = loop {
            let task = get_task(id, 53);
            if task["result"]["status"]["state"] == "TASK_STATE_COMPLETED" {
                break task;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "task {id} never completed: {task}"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(
            settled["result"]["history"].as_array().map(Vec::len),
            Some(2),
            "each task's history is its admitted row and its own answer: {settled}"
        );
        assert_eq!(
            settled["result"]["artifacts"][0]["parts"][0]["text"], expected,
            "{settled}"
        );
    }
}
/// A session-command turn (no assistant row) settles COMPLETED with NO
/// artifact: the window claim is the reply authority, and the
/// session's previous answer never fabricates one for a task whose own
/// turn produced nothing.
#[test]
fn a2a_a_command_turn_settles_with_no_artifact() {
    let script = json!({ "engine": "faux", "responses": ["FIRST-REPLY"] });
    let child = A2aChild::spawn(&[], &script);
    let first = child.send_message("one", None);
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();
    assert_eq!(
        first["result"]["task"]["artifacts"][0]["parts"][0]["text"], "FIRST-REPLY",
        "the first task answered: {first}"
    );

    // A session command runs its turn without a model reply: no
    // assistant row, no artifact — never the previous task's answer.
    let second = child.send_message("/goal status", Some(&context_id));
    assert_eq!(
        second["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the command turn completes: {second}"
    );
    assert!(
        second["result"]["task"]["artifacts"]
            .as_array()
            .is_none_or(Vec::is_empty),
        "the command turn fabricated no artifact: {second}"
    );
    assert_eq!(
        second["result"]["task"]["history"].as_array().map(Vec::len),
        Some(1),
        "the history carries the user message and no agent reply: {second}"
    );
}

/// The Agent Card advertises the bound endpoint (spec 8.3): a port-0
/// bind publishes its ephemeral port, and an IPv6 bind publishes the
/// bracketed address — both URLs serve.
#[test]
fn a2a_the_card_advertises_the_bound_endpoint() {
    let child = A2aChild::spawn(&[], &plain_script());
    let reply = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    let card = A2aChild::body_json(&reply);
    let advertised = card["supportedInterfaces"][0]["url"].as_str().unwrap();
    assert_eq!(
        advertised,
        &format!("{}/", child.url),
        "the card URL is the bound endpoint"
    );
    // The advertised URL serves.
    let address = advertised
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let stream = TcpStream::connect(&address).expect("the advertised endpoint answers");
    drop(stream);

    // The IPv6 bind publishes the bracketed address.
    let child = A2aChild::spawn(&["--a2a-host", "::1"], &plain_script());
    let reply = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    let card = A2aChild::body_json(&reply);
    let advertised = card["supportedInterfaces"][0]["url"].as_str().unwrap();
    assert_eq!(
        advertised,
        &format!("{}/", child.url),
        "the IPv6 card URL is bracketed: {advertised}"
    );
}

/// A wildcard bind advertises the address each client actually reached
/// (spec 8.3.1: the interface URL MUST accurately name the transport
/// URL): the card answers with the request's `Host` authority, never
/// the literal `0.0.0.0` bind.
#[test]
fn a2a_a_wildcard_bind_advertises_the_requests_host() {
    let child = A2aChild::spawn(&["--a2a-host", "0.0.0.0"], &plain_script());
    let reply = raw_request(
        &child.url,
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "a2a.test:9431")],
        &[],
        true,
    )
    .expect("the probe answered");
    let card = A2aChild::body_json(&reply);
    assert_eq!(
        card["supportedInterfaces"][0]["url"], "http://a2a.test:9431/",
        "the wildcard card carries the request's Host authority: {card}"
    );
    // The card without a Host override stays the reachable bound
    // endpoint (the harness's own Host), and both URLs serve.
    let reply = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    let card = A2aChild::body_json(&reply);
    let advertised = card["supportedInterfaces"][0]["url"].as_str().unwrap();
    assert_eq!(
        advertised,
        &format!("{}/", child.url),
        "the default-Host card is the bound endpoint: {advertised}"
    );
    let address = advertised
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let stream = TcpStream::connect(&address).expect("the advertised endpoint answers");
    drop(stream);
}

/// An idle context detaches its session (the daemon's idle passivation
/// can reclaim the worker — an attached session never passivates) and
/// the next send re-attaches it: after a task settles, the daemon's
/// live list shows the context's session with no attached client, and
/// a follow-up send on the same context still completes with its own
/// reply.
#[test]
fn a2a_an_idle_context_detaches_and_reattaches() {
    let child = A2aChild::spawn(&[], &plain_script());
    let first = child.send_message("one", None);
    assert_eq!(
        first["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{first}"
    );
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();

    // The settled context's session has no attached client (the idle
    // detach landed — poll until the daemon's list observes it).
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let detached = loop {
        let list = daemon_list(&child.socket);
        let row = list["data"]["sessions"]
            .as_array()
            .expect("the live list")
            .iter()
            .find(|row| {
                row["sessionName"]
                    .as_str()
                    .is_some_and(|name| name.starts_with("a2a-"))
            })
            .cloned()
            .unwrap_or_else(|| panic!("the A2A context session is missing: {list}"));
        if row["attachedClients"] == 0 {
            break row;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the context never detached: {row}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(detached["attachedClients"], 0, "{detached:?}");

    // The next send on the same context still completes (the
    // re-attach), with its own reply.
    let second = child.send_message("two", Some(&context_id));
    assert_eq!(
        second["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{second}"
    );
    assert_eq!(
        second["result"]["task"]["artifacts"][0]["parts"][0]["text"], "A2A-OK-2",
        "the re-attached context answers its own reply: {second}"
    );
}

/// A passivated context re-hosts on its next send (finding the durable
/// identity): with `idleEvictionMinutes: 1` the daemon reclaims the
/// detached context's worker (the row leaves the live list), and the
/// next send on the context re-opens the conversation's file through
/// the mode's own create template — the conversation continues with
/// its own scripted engine reply, never the dead `Unknown active
/// session` failure and never a cwd-only revival that lost the engine
/// (the revived worker is a fresh process, so the faux script serves
/// its first response again: both sends answer REHOST-REPLY).
#[test]
fn a2a_a_passivated_context_rehosts_on_the_next_send() {
    let child = A2aChild::spawn_with_settings(
        &json!({ "idleEvictionMinutes": 1 }),
        &[],
        &json!({ "engine": "faux", "responses": ["REHOST-REPLY"] }),
    );
    let first = child.send_message("one", None);
    assert_eq!(
        first["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{first}"
    );
    assert_eq!(
        first["result"]["task"]["artifacts"][0]["parts"][0]["text"], "REHOST-REPLY",
        "{first}"
    );
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();

    // The observable passivation: the context's row leaves the live
    // list (the idle detach landed at the settle; the eviction timer
    // fires a minute later).
    let deadline = std::time::Instant::now() + Duration::from_secs(150);
    loop {
        let list = daemon_list(&child.socket);
        let live = list["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let gone = !live.iter().any(|row| {
            row["sessionName"]
                .as_str()
                .is_some_and(|name| name.starts_with("a2a-"))
        });
        if gone {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the context session never passivated: {list}"
        );
        std::thread::sleep(Duration::from_millis(500));
    }

    // The next send on the same context re-hosts the session over its
    // file and answers with its own scripted reply (the fresh revived
    // worker restarts the script; a cwd-only revival would fail on the
    // real provider chain instead).
    let second = child.send_message("two", Some(&context_id));
    assert_eq!(
        second["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the passivated context re-hosted: {second}"
    );
    assert_eq!(
        second["result"]["task"]["artifacts"][0]["parts"][0]["text"], "REHOST-REPLY",
        "the re-hosted context answers with its scripted engine: {second}"
    );
}

/// JSON-RPC 2.0 pins the request id to string, number, or null: object,
/// array, and boolean ids answer -32600 with no side effect.
#[test]
fn a2a_malformed_request_ids_answer_invalid_request() {
    let child = A2aChild::spawn(&[], &plain_script());
    for id in [json!({ "object": true }), json!([1, 2]), json!(true)] {
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": "m-1",
                    "role": "ROLE_USER",
                    "parts": [{ "text": "hi" }],
                }
            },
        });
        let reply = child.request("POST", "/", &[], Some(&request), Some("1.0"));
        let reply = A2aChild::body_json(&reply);
        assert_eq!(reply["error"]["code"], -32600, "id {id}: {reply}");
    }
    let list = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 53,
            "method": "ListTasks",
            "params": {},
        })),
        Some("1.0"),
    );
    let list = A2aChild::body_json(&list);
    assert_eq!(list["result"]["totalSize"], 0, "no task was admitted");
}

/// A `--mode a2a` run refuses a selected saved session (`--resume`,
/// `--fork`, `--continue`): every A2A context hosts its own session,
/// and reusing the selected file would alias them.
#[test]
fn a2a_mode_rejects_a_selected_session() {
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let selected = home.path().join("selected.jsonl");
    std::fs::write(&selected, "{}\n").unwrap();
    let child = a2a_command(home.path(), &socket, &[], &plain_script())
        .arg("--a2a-port")
        .arg("0")
        .arg("--resume")
        .arg(&selected)
        .spawn()
        .expect("binary present");
    let output = child
        .wait_with_output()
        .expect("the mode exits instead of listening");
    assert!(
        !output.status.success(),
        "the selected-session run must fail: {output:?}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("cannot reuse") && stderr.contains("--resume"),
        "the rejection names the flags: {stderr}"
    );

    // The refusal precedes every side effect: a --fork selection — whose
    // helper materializes a session copy — writes NO new session file
    // before the mode exits.
    let child = a2a_command(home.path(), &socket, &[], &plain_script())
        .arg("--a2a-port")
        .arg("0")
        .arg("--fork")
        .arg(&selected)
        .spawn()
        .expect("binary present");
    let output = child
        .wait_with_output()
        .expect("the mode exits instead of listening");
    assert!(
        !output.status.success(),
        "the --fork selection run must fail: {output:?}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("cannot reuse") && stderr.contains("--fork"),
        "the rejection names the flags: {stderr}"
    );
    let mut copied: Vec<std::path::PathBuf> = Vec::new();
    collect_jsonl(home.path(), &selected, &mut copied);
    assert!(
        copied.is_empty(),
        "the refused --fork wrote no session copy: {copied:?}"
    );
    shutdown_sandboxed_daemon(&socket);
}

/// One accept error does not end the server: under fd exhaustion the
/// process stays up, and once the sockets free it serves again.
#[test]
fn a2a_accept_errors_do_not_end_the_server() {
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let child = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "ulimit -n 64 && exec '{}' --mode a2a --daemon-socket '{}' --a2a-port 0",
            env!("CARGO_BIN_EXE_prime-agent"),
            socket.display()
        ))
        .env("HOME", home.path())
        .env(
            "PRIME_AGENT_FAUX_SCRIPT",
            home.path().join("worker-script.json"),
        )
        // The sandboxed home owns the child's settings and session
        // state: the invoking session's agent/session dirs never leak
        // into the spawned tree (the helper's own pins, mirrored here —
        // this spawn bypasses it for the ulimit-wrapped exec).
        .env(
            "PRIME_AGENT_CODING_AGENT_DIR",
            home.path().join(".prime/agent"),
        )
        .env_remove("PRIME_AGENT_SESSION_DIR")
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
    let mut child = child;
    let stderr = child.stderr.take().expect("stderr piped");
    // The accept-error log lines keep coming after startup; the reader
    // must keep draining them (a closed pipe would turn the SUT's own
    // logging into its exit). The accept-error line is also the test's
    // observable readiness: fd exhaustion is proven by the server's own
    // log, never by a fixed sleep.
    let (url_tx, url_rx) = std::sync::mpsc::channel::<String>();
    let (error_tx, error_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if let Some(rest) = trimmed.strip_prefix("a2a: listening on http://") {
                        let _ = url_tx.send(rest.trim().to_string());
                    } else if let Some(rest) = trimmed.strip_prefix("a2a: accept error: ") {
                        let _ = error_tx.send(rest.trim().to_string());
                    }
                }
            }
        }
    });
    let url = url_rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the a2a mode printed its listening line");
    let address = url.trim_start_matches("http://").to_string();

    // Exhaust the server's descriptors with idle, unwritten connections.
    let mut idle = Vec::new();
    for _ in 0..80 {
        if let Ok(stream) = TcpStream::connect(&address) {
            idle.push(stream);
        }
    }
    assert!(
        !idle.is_empty(),
        "the probe opened {}/80 connections",
        idle.len()
    );
    // The fd limit forces accept errors: the server's own accept-error
    // line is the observable proof the exhaustion landed (and that the
    // server was alive to log it) — never a fixed sleep.
    let error = error_rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the server logged its accept error");
    assert!(
        child.try_wait().expect("the child is waitable").is_none(),
        "the server survived fd exhaustion: {error}"
    );
    drop(idle);
    // The freed descriptors let the surface serve again.
    let reply = request(&url, "GET", "/.well-known/agent-card.json", &[], None, None);
    assert_eq!(reply.status, 200, "the card answers after the exhaustion");
    let _ = child.kill();
    let _ = child.wait();
    shutdown_sandboxed_daemon(&socket);
}

/// The supervisor socket closing ends the mode (a shutdown, restart, or
/// update): the process exits non-zero instead of serving a zombie card.
#[test]
fn a2a_daemon_close_ends_the_mode() {
    let mut child = A2aChild::spawn(&[], &plain_script());
    let card = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    assert_eq!(card.status, 200);

    shutdown_sandboxed_daemon(&child.socket);
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut status = None;
    while std::time::Instant::now() < deadline {
        if let Some(waited) = child.child.try_wait().expect("the child is waitable") {
            status = Some(waited);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let status = status.expect("the mode exited after the daemon closed");
    assert!(
        !status.success(),
        "the zombie card ends with a non-zero exit: {status:?}"
    );
}

/// The artifact rule for a multi-round turn: the task's own run is
/// the reply unit — every model step's text joins with the blank-line
/// separator, never ONE claimed window (the middle step) and never
/// the final step alone.
#[test]
fn a2a_a_tool_calling_turn_artifact_is_the_whole_run() {
    let script = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Let me check." },
            { "type": "toolCall", "name": "bash", "arguments": { "command": "true" } },
        ] },
        "The answer is 42.",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let reply = child.send_message("compute", None);
    let artifact = reply["result"]["task"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(
        artifact, "Let me check.\n\nThe answer is 42.",
        "the artifact is the whole run — both rounds' text, blank-line joined: {artifact:?}"
    );
}

/// The whole-run artifact rule at three rounds: a turn whose middle
/// step narrates and whose last step answers carries ALL of it — the
/// single-window claim would return the middle step's narration and
/// lose the answer entirely.
#[test]
fn a2a_a_three_round_tool_turn_artifact_carries_every_round() {
    let script = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Let me check A." },
            { "type": "toolCall", "name": "bash", "arguments": { "command": "true" } },
        ] },
        { "content": [
            { "type": "text", "text": "Now B." },
            { "type": "toolCall", "name": "bash", "arguments": { "command": "true" } },
        ] },
        "The answer is 42.",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let reply = child.send_message("compute", None);
    let artifact = reply["result"]["task"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(
        artifact, "Let me check A.\n\nNow B.\n\nThe answer is 42.",
        "the artifact is the whole run — every round's text: {artifact:?}"
    );
}

/// The task's history message ids are stable across reads and carry the
/// client's own `messageId` (spec 4.1.4: the creator sets it).
#[test]
fn a2a_history_message_ids_are_stable() {
    let child = A2aChild::spawn(&[], &plain_script());
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body("hello", None, None, json!({}))),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        send["result"]["task"]["history"][0]["messageId"], "m-1",
        "the client's messageId rides the history: {send}"
    );
    let agent_id = send["result"]["task"]["history"][1]["messageId"].clone();

    // The second read returns the same ids.
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 54,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(get["result"]["history"][0]["messageId"], "m-1");
    assert_eq!(
        get["result"]["history"][1]["messageId"], agent_id,
        "the agent message id is stable across reads: {get}"
    );
}

/// A wildcard bind without a token refuses the browser surface on the
/// exposed interface too: any `Origin` header answers 403 on every bind
/// (a rebound page posts same-origin; no legitimate non-browser client
/// sends `Origin`), while the plain request still serves.
#[test]
fn a2a_a_wildcard_bind_refuses_origins() {
    let child = A2aChild::spawn(&["--a2a-host", "0.0.0.0"], &plain_script());
    let auth = format!(
        "Bearer {}",
        child.token.as_deref().expect("the run carries its token")
    );
    let refused = raw_request(
        &child.url,
        "POST",
        "/",
        &[
            ("Origin", "http://rebind.attacker.example"),
            ("Authorization", auth.as_str()),
        ],
        &serde_json::to_vec(&A2aChild::send_message_body("probe", None, None)).expect("serializes"),
        true,
    )
    .expect("the probe reads a reply");
    assert_eq!(
        refused.status, 403,
        "the wildcard bind refuses a browser Origin: {refused:?}"
    );
}

/// The configured public base URL (`a2a.publicBaseUrl`) is the card's
/// interface URL (spec 8.3.1: the interface URL MUST accurately name the
/// transport URL a front serves) and the one foreign `Host` a loopback
/// bind accepts — a front that forwards the client's own `Host` reaches
/// the task routes; every other name stays refused.
#[test]
fn a2a_a_public_base_url_serves_the_card_and_the_host_gate() {
    let child = A2aChild::spawn_with_settings(
        &json!({ "a2a": { "publicBaseUrl": "https://agent.example.com/" } }),
        &[],
        &plain_script(),
    );
    let card = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    assert_eq!(card.status, 200);
    let card = A2aChild::body_json(&card);
    assert_eq!(
        card["supportedInterfaces"][0]["url"], "https://agent.example.com/",
        "the configured public URL is the interface URL: {card}"
    );
    let through_front = raw_request(
        &child.url,
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "agent.example.com")],
        &[],
        true,
    )
    .expect("the front's request reads a reply");
    assert_eq!(
        through_front.status, 200,
        "the configured authority passes the loopback Host gate: {through_front:?}"
    );
    let still_refused = raw_request(
        &child.url,
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "rebind.attacker.example")],
        &[],
        true,
    )
    .expect("the probe reads a reply");
    assert_eq!(
        still_refused.status, 403,
        "every other foreign Host stays refused: {still_refused:?}"
    );
    // The authority compares case-insensitively (RFC 9110 §7.2) and
    // modulo the URL scheme's default port: a front's forwarded `Host`
    // in either default-port form serves, any other port stays
    // refused.
    let cased_front = raw_request(
        &child.url,
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "Agent.Example.Com")],
        &[],
        true,
    )
    .expect("the probe reads a reply");
    assert_eq!(
        cased_front.status, 200,
        "the cased configured authority passes the gate: {cased_front:?}"
    );
    let default_port_front = raw_request(
        &child.url,
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "agent.example.com:443")],
        &[],
        true,
    )
    .expect("the probe reads a reply");
    assert_eq!(
        default_port_front.status, 200,
        "the scheme's default port names the same authority: {default_port_front:?}"
    );
    let foreign_port = raw_request(
        &child.url,
        "GET",
        "/.well-known/agent-card.json",
        &[("Host", "agent.example.com:8443")],
        &[],
        true,
    )
    .expect("the probe reads a reply");
    assert_eq!(
        foreign_port.status, 403,
        "an authority-named host on a foreign port stays refused: {foreign_port:?}"
    );
}

/// The live-context bound (`a2a.maxContexts`): a full table evicts the
/// least recently used IDLE context — its worker stops — and the new
/// conversation serves; the evicted context's tasks stay queryable, and
/// its conversation ends honestly (an unknown context id answers
/// -32602, the documented bound).
#[test]
fn a2a_a_full_context_table_evicts_the_idle_lru_context() {
    let child = A2aChild::spawn_with_settings(
        &json!({ "a2a": { "maxContexts": 2 } }),
        &[],
        &json!({ "engine": "faux", "responses": ["R-1", "R-2", "R-3"] }),
    );
    let first = child.send_message("one", None);
    assert_eq!(
        first["result"]["task"]["status"]["state"],
        "TASK_STATE_COMPLETED"
    );
    let first_context = first["result"]["task"]["contextId"]
        .as_str()
        .unwrap()
        .to_string();
    let first_id = first["result"]["task"]["id"].as_str().unwrap().to_string();
    // The first conversation's worker process: the eviction's stop
    // must end IT (the reclamation is a stop, not a bookkeeping
    // forget) — the pid is the observable the settle below polls.
    let first_session = daemon_live_session(&child.socket);
    let first_row = daemon_row(&child.socket, &first_session);
    let first_worker_pid = first_row["workerPid"]
        .as_u64()
        .expect("the live worker carries its pid");
    // The first conversation persists its turn's rows (the fresh
    // agent dir's FIRST session once lost every append: its lease was
    // minted before the sessions dir existed, so the raw-path lease
    // failed every later append's ownership check).
    let first_session_file = child.home.path().join(format!(
        ".prime/agent/sessions/{}.jsonl",
        first_row["sessionId"]
            .as_str()
            .expect("the row's durable session id")
    ));
    let persisted = std::fs::read_to_string(&first_session_file)
        .unwrap_or_else(|error| panic!("the first conversation's session file reads: {error}"));
    assert!(
        persisted.contains("\"type\":\"message\""),
        "the first conversation's turn persisted its rows: {persisted}"
    );
    let second = child.send_message("two", None);
    assert_eq!(
        second["result"]["task"]["status"]["state"],
        "TASK_STATE_COMPLETED"
    );

    // The third conversation evicts the idle LRU context (the first).
    let third = child.send_message("three", None);
    assert_eq!(
        third["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the new conversation serves past the bound: {third}"
    );

    // The evicted context's worker process stopped: `ps` reporting the
    // pid gone is the observable readiness the reclamation's stop
    // tail owns (a leaked worker would hold the pid alive past the
    // deadline).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let reported = Command::new("ps")
            .args(["-p", &first_worker_pid.to_string()])
            .output()
            .expect("ps runs");
        if !reported.status.success() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the evicted context's worker process {first_worker_pid} stopped with the binding"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    // The evicted context's task stays queryable (the registry is the
    // authority), but its conversation ended: a send naming its context
    // id answers the honest parameter error.
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 70,
            "method": "GetTask",
            "params": { "id": first_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(
        get["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the evicted context's task stays queryable: {get}"
    );
    let refused = child.send_message("late", Some(&first_context));
    assert_eq!(refused["error"]["code"], -32602, "{refused}");
    assert!(
        refused["error"]["data"][0]["fieldViolations"][0]["description"]
            .as_str()
            .is_some_and(|message| message.contains("unknown contextId")),
        "the eviction ends the conversation honestly: {refused}"
    );
}

/// A send after a FOREIGN abort with a parked foreign row must still
/// run: the abort leaves `queued_input_suspended` set with the
/// queue-visible row parked behind it (the runner never drains a
/// suspended lane), and the flow's pre-write idle wait would hold on
/// that parked row forever — wedging every later task on the context
/// SUBMITTED. The flow resumes the parked queue ahead of its wait
/// (the same ACP resume its own prompt would run), so the foreign row
/// drains as an ordinary turn and the task's own turn follows it.
#[test]
fn a2a_a_send_after_an_abort_with_a_parked_foreign_row_still_runs() {
    let script = json!({
        "engine": "faux",
        "tokensPerSecond": 4,
        "responses": [
            "a paced reply that streams slowly enough for an abort to land mid-turn",
            "SECOND-REPLY",
            "THIRD-REPLY",
        ],
    });
    let child =
        A2aChild::spawn_with_settings(&json!({ "retry": { "enabled": false } }), &[], &script);
    let first = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "start the task",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let first = A2aChild::body_json(&first);
    let task_id = first["result"]["task"]["id"].as_str().unwrap().to_string();
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for_task_in_state(&child, "TASK_STATE_WORKING")
        .expect("the held reply keeps the task WORKING");
    let session = daemon_live_session(&child.socket);
    // The turn's response must have STARTED streaming (the engine
    // consumed the first scripted reply — the pop the queue accounting
    // below asserts): the continuation that follows joins a
    // mid-response turn, and the abort lands mid-stream, never racing
    // the pop.
    let popped = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 60,
                    "method": "GetTask",
                    "params": { "id": task_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            if get["result"]["artifacts"][0]["parts"][0]["text"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
            {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    assert!(
        popped,
        "the turn's response started streaming before the continuation"
    );
    // An unattached daemon client queues a question and then aborts the
    // shared session's turn: the abort parks its queue-visible row
    // behind the suspension it sets.
    let queued = daemon_command(
        &child.socket,
        &json!({
            "type": "follow_up",
            "activeSessionId": session,
            "message": "an unattached client's queued question",
        }),
    );
    assert!(
        queued["success"].as_bool().unwrap_or(false),
        "the foreign follow_up queues: {queued}"
    );
    let abort = daemon_command(
        &child.socket,
        &json!({ "type": "abort", "activeSessionId": session }),
    );
    assert!(
        abort["success"].as_bool().unwrap_or(false),
        "the foreign abort lands: {abort}"
    );
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 61,
                    "method": "GetTask",
                    "params": { "id": task_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            if get["result"]["status"]["state"] == "TASK_STATE_CANCELED" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the aborted task never settled CANCELED: {get}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    // The parked foreign row survives the abort (its own client's
    // work, never the task's to sweep) and suspends the session.
    let queue_after = daemon_command(
        &child.socket,
        &json!({ "type": "get_queue", "activeSessionId": session }),
    );
    assert!(
        queue_after["data"]["followUp"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()),
        "the foreign row stays parked behind the abort: {queue_after}"
    );
    // The next task on the same context must still run to its own
    // terminal state, within the bound (the parked row drains first,
    // then the task's own turn answers). A return-immediately send
    // keeps the pin bounded: the wedge this pin guards would leave
    // this task SUBMITTED at the bound, never hang the blocking
    // send's idle wait.
    let next = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "the next task",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let next = A2aChild::body_json(&next);
    let next_id = next["result"]["task"]["id"].as_str().unwrap().to_string();
    let next_final = {
        let deadline = std::time::Instant::now() + Duration::from_secs(45);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 62,
                    "method": "GetTask",
                    "params": { "id": next_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            let state = get["result"]["status"]["state"]
                .as_str()
                .unwrap_or_default();
            if state == "TASK_STATE_COMPLETED"
                || state == "TASK_STATE_FAILED"
                || state == "TASK_STATE_CANCELED"
            {
                break get;
            }
            if std::time::Instant::now() > deadline {
                break get;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert_eq!(
        next_final["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the next task settles within the bound (the pre-write wait never wedged on the parked row): {next_final}"
    );
    assert_eq!(
        next_final["result"]["artifacts"][0]["parts"][0]["text"], "THIRD-REPLY",
        "the next task's own reply follows the drained foreign row: {next_final}"
    );
}

/// A goal-driven autonomous continuation reaches the task: the blocking
/// send answers only after the goal's continuation turns finished, and
/// the artifact carries the whole run's output — not the first turn's
/// reply alone.
#[test]
fn a2a_an_autonomous_continuation_reaches_the_task() {
    // Three progress replies, then three empty turns: the goal driver's
    // no-progress streak caps the goal (the faux engine never completes
    // one), the driver stops, and the task settles COMPLETED with the
    // whole run's output — the empty turns are real output-less turns,
    // never a hidden provider failure.
    let script = json!({
        "engine": "faux",
        "responses": ["GOAL-1", "GOAL-2", "GOAL-3", "", "", ""],
    });
    let child = A2aChild::spawn(&[], &script);
    let reply = child.send_message("/goal write three short lines", None);
    assert_eq!(
        reply["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the goal task completes: {reply}"
    );
    let artifact = reply["result"]["task"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    let order = ["GOAL-1", "GOAL-2", "GOAL-3"];
    let mut from = 0;
    for line in order {
        let found = artifact[from..].find(line).map(|at| from + at);
        assert!(
            found.is_some(),
            "the artifact carries the autonomous run's whole output ({artifact:?})"
        );
        from = found.expect("checked") + line.len();
    }
}

/// With no token configured anywhere (neither the environment nor the
/// `a2a.token` setting), the mode MINTS one per run: the token lands in
/// an owner-only file in the agent dir,
/// the startup lines print its path, and every task route requires it —
/// an unauthenticated send answers 401 while the well-known card stays
/// public.
#[test]
fn a2a_a_run_without_a_configured_token_mints_one() {
    let child = A2aChild::spawn(&[], &plain_script());
    let token = child.token.as_deref().expect("the run minted a token");
    // The startup lines name the minted token file's path.
    let stderr = child.stderr_dump();
    assert!(
        stderr.contains("minted one for this run"),
        "the minted token's startup line printed: {stderr}"
    );
    assert!(
        stderr.contains("a2a-token"),
        "the printed line carries the token file's path: {stderr}"
    );
    let token_path = child.minted_token_path();
    let file = std::fs::read_to_string(&token_path).expect("the minted token file exists");
    assert_eq!(file.trim(), token, "the file carries the served token");
    // The owner-only mode check is Unix-only (`std::os::unix`), gated
    // per item: the Windows cross-check compiles the rest of the test.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&token_path)
            .expect("the token file's metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the minted token file is owner-only");
    }
    // The well-known card stays public discovery, minted run or not.
    let card = child.request("GET", "/.well-known/agent-card.json", &[], None, None);
    assert_eq!(card.status, 200, "the card serves unauthenticated");
    // An unauthenticated send answers the 401 challenge — the minted
    // run never serves a task route open (the raw probe carries no
    // Authorization).
    let refused = request(
        &child.url,
        "POST",
        "/",
        &[],
        Some(&A2aChild::send_message_body("gate", None, None)),
        Some("1.0"),
    );
    assert_eq!(refused.status, 401, "the unauthenticated send is refused");
    assert!(
        refused
            .headers
            .iter()
            .any(|(name, value)| name == "www-authenticate" && value.contains("Bearer")),
        "the 401 carries the challenge: {refused:?}"
    );
    // The minted token authorizes the same route.
    let served = child.send_message("gate", None);
    assert_eq!(
        served["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the minted token serves the task route: {served}"
    );
}

/// Two minted servers in one agent dir never overwrite each other's
/// token: each run's file is named for the address it bound, so the
/// first server's printed path keeps serving after the second starts
/// (a shared file left every client of the first server reading the
/// second's token — a 401 with nothing explaining it).
#[test]
fn a2a_second_server_never_overwrites_the_firsts_token() {
    let first = A2aChild::spawn(&[], &plain_script());
    let first_token_path = first.minted_token_path();
    let first_agent_dir = first.home.path().join(".prime/agent");
    // The second server binds its own port against the SAME agent dir
    // (another project's run, a port-0 default): its minted file is
    // its own, never the first's.
    let second = A2aChild::spawn_with_env(
        &[(
            "PRIME_AGENT_CODING_AGENT_DIR",
            first_agent_dir.to_str().expect("the agent dir is utf-8"),
        )],
        &[],
        &plain_script(),
    );
    assert_ne!(
        first_token_path,
        second.minted_token_path(),
        "each server's token file names its own bind"
    );
    // A client that reads the FIRST server's printed path after the
    // second server started still holds a token the first server
    // accepts — the second server's mint never overwrote it.
    let file_token = std::fs::read_to_string(&first_token_path)
        .expect("the first server's token file exists")
        .trim()
        .to_string();
    let auth = format!("Bearer {file_token}");
    let served = first.request(
        "POST",
        "/",
        &[("Authorization", auth.as_str())],
        Some(&A2aChild::send_message_body("still serving", None, None)),
        Some("1.0"),
    );
    assert_eq!(
        served.status, 200,
        "the first server's printed token path keeps serving after the second server started"
    );
    let body = A2aChild::body_json(&served);
    assert_eq!(
        body["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the first server serves its own file's token: {body}"
    );
    // Both servers keep serving their own minted tokens (the second
    // server's file lives in the SHARED agent dir it was pointed at,
    // so its token reads from there).
    let first_reply = first.send_message("first", None);
    assert_eq!(
        first_reply["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the first server still serves: {first_reply}"
    );
    let second_token = std::fs::read_to_string(second.minted_token_path())
        .expect("the second server's own token file exists")
        .trim()
        .to_string();
    let second_auth = format!("Bearer {second_token}");
    let second_reply = second.request(
        "POST",
        "/",
        &[("Authorization", second_auth.as_str())],
        Some(&A2aChild::send_message_body("second", None, None)),
        Some("1.0"),
    );
    assert_eq!(
        second_reply.status, 200,
        "the second server serves its own token"
    );
    let second_reply = A2aChild::body_json(&second_reply);
    assert_eq!(
        second_reply["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the second server's own token keeps serving it: {second_reply}"
    );
}

/// Two minted servers that share one agent dir AND one port — different
/// addresses (`127.0.0.1` and `::1` both bind) — never overwrite each
/// other's token either: the file names the bound address, so each
/// listener's printed path holds ITS token (a port-only name let the
/// second start truncate the first's file — the first listener's
/// documented path then served a 401 to every client that read it).
#[test]
fn a2a_two_addresses_on_one_port_keep_each_minted_token_readable() {
    let first = A2aChild::spawn(&[], &plain_script());
    let first_port = first
        .url
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .trim_end_matches('/');
    let first_agent_dir = first.home.path().join(".prime/agent");
    // The second server binds the SAME port on the IPv6 loopback
    // against the SAME agent dir.
    let second = A2aChild::spawn_with_env(
        &[(
            "PRIME_AGENT_CODING_AGENT_DIR",
            first_agent_dir.to_str().expect("the agent dir is utf-8"),
        )],
        &["--a2a-host", "::1", "--a2a-port", first_port],
        &plain_script(),
    );
    assert_eq!(
        second
            .url
            .rsplit(':')
            .next()
            .unwrap_or_default()
            .trim_end_matches('/'),
        first_port,
        "the second server bound the same port on another address"
    );
    // Each listener's printed path is its OWN file: both files exist,
    // side by side, and each listener accepts only its own token.
    let (first_path, second_path) = (first.minted_token_path(), second.minted_token_path());
    assert_ne!(
        first_path, second_path,
        "two listeners on one port and one agent dir write two files"
    );
    assert!(
        first_path.to_string_lossy().contains("a2a-token"),
        "the first server's printed path is a minted token file: {first_path:?}"
    );
    for (child, path) in [(&first, &first_path), (&second, &second_path)] {
        let file_token = std::fs::read_to_string(path)
            .expect("the minted token file exists")
            .trim()
            .to_string();
        let auth = format!("Bearer {file_token}");
        let served = child.request(
            "POST",
            "/",
            &[("Authorization", auth.as_str())],
            Some(&A2aChild::send_message_body("still serving", None, None)),
            Some("1.0"),
        );
        assert_eq!(
            served.status, 200,
            "the listener at {path:?} keeps serving its own file's token"
        );
        let body = A2aChild::body_json(&served);
        assert_eq!(
            body["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
            "the listener's own token serves the task route: {body}"
        );
    }
}

/// Sequential runs on one ADDRESS leave ONE minted token file: the
/// bind is exclusive, so the address-keyed name replaces only a dead
/// run's token — the agent dir's minted set stays bounded by the
/// distinct binds, never one owner-only secret file per run forever
/// (the per-run-id name made every token-less run leave a new file
/// behind, and SIGTERM exits without teardown).
#[test]
fn sequential_runs_on_one_address_replace_the_minted_token_file() {
    let first = A2aChild::spawn(&[], &plain_script());
    let port = first
        .url
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let first_path = first.minted_token_path();
    assert_eq!(
        first_path.file_name().and_then(|name| name.to_str()),
        Some(format!("a2a-token-{port}-127-0-0-1").as_str()),
        "the minted file names the bound address, not a per-run id: {first_path:?}"
    );
    let agent_dir = first.home.path().join(".prime/agent");
    // The first run dies (the bind frees); a second run on the SAME
    // address writes the SAME file.
    drop(first);
    let second = A2aChild::spawn_with_env(
        &[(
            "PRIME_AGENT_CODING_AGENT_DIR",
            agent_dir.to_str().expect("the agent dir is utf-8"),
        )],
        &["--a2a-port", &port],
        &plain_script(),
    );
    assert_eq!(
        second.minted_token_path(),
        first_path,
        "the second run's minted file is the first's (one address, one file)"
    );
    let files: Vec<String> = std::fs::read_dir(&agent_dir)
        .expect("the agent dir lists")
        .filter_map(|entry| {
            let name = entry.expect("the entry").file_name();
            let name = name.to_string_lossy().to_string();
            name.starts_with("a2a-token-").then_some(name)
        })
        .collect();
    assert_eq!(
        files.len(),
        1,
        "two sequential runs on one address leave one minted token file: {files:?}"
    );
    // The replacement token serves the second run.
    let served = second.send_message("still serving", None);
    assert_eq!(
        served["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the replacement token serves: {served}"
    );
}

/// Two token-less port-0 runs against one shared agent dir leave at
/// most one minted token file: each run's file leaves at the mode's
/// own graceful exits — SIGTERM among them (the watch the mode
/// installs at its entry, so the listener's readiness line already
/// proves it armed) — so the ephemeral ports a port-0 run binds never
/// strand one owner-only secret file per run behind. Before the
/// removal, every token-less port-0 run minted a new
/// address-keyed file and none was ever removed: the agent dir grew
/// one secret file per run, unbounded.
#[test]
fn token_less_port_zero_runs_remove_their_minted_token_file_at_exit() {
    let shared = tempfile::TempDir::new().unwrap();
    let agent_dir = shared.path().join(".prime/agent");
    std::fs::create_dir_all(&agent_dir).expect("the agent dir creates");
    for _ in 0..2 {
        let mut child = A2aChild::spawn_with_env(
            &[(
                "PRIME_AGENT_CODING_AGENT_DIR",
                agent_dir.to_str().expect("the agent dir is utf-8"),
            )],
            &[],
            &plain_script(),
        );
        // The run minted its file into the shared agent dir, and the
        // file exists while the run serves (the removal the exit
        // drives is what the pin observes).
        let token_path = child.minted_token_path();
        assert!(
            token_path.starts_with(&agent_dir),
            "the minted file landed in the shared agent dir: {token_path:?}"
        );
        assert!(
            token_path.is_file(),
            "the minted token file exists while the run serves"
        );
        // The graceful exit a supervisor's plain `kill` drives.
        let _ = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(child.child.id().to_string())
            .status()
            .expect("kill runs");
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.child.try_wait().expect("the child's wait answers") {
                break status;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the SIGTERM did not end the mode within the bound"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(
            status.success(),
            "the mode exited gracefully on SIGTERM (its own exit code, not a signal death): {status:?}"
        );
        assert!(
            !token_path.is_file(),
            "the exited run removed its minted token file: {token_path:?}"
        );
    }
    let files: Vec<String> = std::fs::read_dir(&agent_dir)
        .expect("the agent dir lists")
        .filter_map(|entry| {
            let name = entry.expect("the entry").file_name();
            let name = name.to_string_lossy().to_string();
            name.starts_with("a2a-token-").then_some(name)
        })
        .collect();
    assert!(
        files.len() <= 1,
        "two sequential token-less port-0 runs leave at most one minted token file: {files:?}"
    );
}

/// The token's environment variable never reaches the session workers:
/// the mode scrubs it before the supervisor spawns. A scripted faux
/// `ipython` tool call — the worker's own kernel, the exact environment
/// its bash and python tools inherit — writes what it observes to a
/// probe file the test reads back: the direct pin of the production
/// scrub call (a revert of the call answers the secret in the
/// worker's own read). The secret never appears anywhere in the
/// sandboxed home either.
#[test]
fn a2a_worker_environments_never_carry_the_bearer_token() {
    let script = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "checking the environment" },
            { "type": "toolCall", "name": "ipython",
                "arguments": { "code": "import os
observed = os.environ.get('PRIME_AGENT_A2A_TOKEN', 'TOKEN-UNSET')
open(os.path.expanduser('~/a2a-token-probe.txt'), 'w').write(observed)
print('the worker environment observed:', observed)" }
            },
        ] },
        "the check is done",
    ]});
    let child =
        A2aChild::spawn_with_env(&[("PRIME_AGENT_A2A_TOKEN", "scrub-secret-1")], &[], &script);
    // The configured token rides the send explicitly (a configured run
    // mints nothing, so the harness injects no default auth).
    let reply = child.request(
        "POST",
        "/",
        &[("Authorization", "Bearer scrub-secret-1")],
        Some(&A2aChild::send_message_body("check", None, None)),
        Some("1.0"),
    );
    let reply = A2aChild::body_json(&reply);
    assert_eq!(
        reply["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the tool-calling turn completed: {reply}"
    );
    // The direct read of the worker's environment — the assertion the
    // session rows cannot carry (the a2a sessions' message persistence
    // drops the tool-result row, a pre-existing gap): the worker's own
    // kernel observed its environment for the test. The mode's entry
    // scrub removes the variable before the supervisor spawns (the
    // production call at `run_a2a_mode`), and a revert of that call
    // answers the secret in this read first.
    let probe = child.home.path().join("a2a-token-probe.txt");
    let observed =
        std::fs::read_to_string(&probe).expect("the worker's kernel ran the environment probe");
    assert_eq!(
        observed.trim(),
        "TOKEN-UNSET",
        "the worker's environment never carried the bearer token"
    );
    // The scan holds the secret out of everything else the run wrote
    // on disk (the session files, the daemon's control log, every
    // jsonl under the home) — the transcript is the leak surface
    // beyond the worker's own environment.
    let mut found = Vec::new();
    collect_jsonl(child.home.path(), std::path::Path::new(""), &mut found);
    assert!(!found.is_empty(), "the conversation's transcript exists");
    let mut transcript = String::new();
    for path in &found {
        transcript.push_str(&std::fs::read_to_string(path).unwrap_or_default());
    }
    assert!(
        !transcript.contains("scrub-secret-1"),
        "the bearer secret never reached any artifact the run wrote: {} collected bytes",
        transcript.len()
    );
    // The run resolved its token from the environment: no minted file
    // exists (the mint only fires with nothing configured — no
    // per-port token file at all).
    let minted: Vec<_> = std::fs::read_dir(child.home.path().join(".prime/agent"))
        .expect("the agent dir reads")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("a2a-token"))
        .collect();
    assert!(
        minted.is_empty(),
        "the environment token served; nothing was minted: {:?}",
        minted
            .iter()
            .map(std::fs::DirEntry::file_name)
            .collect::<Vec<_>>()
    );
}

/// One foreign client's persistent attach: the stream stays open — its
/// client id live on the session — until the returned stream drops
/// (the supervisor then detaches it from the worker, the same path a
/// disconnecting TUI takes).
fn attach_observer(
    socket: &std::path::Path,
    session: &str,
) -> Box<dyn pa_types::platform::transport::BlockingTransportStream> {
    use std::io::Write as _;
    let stream = pa_types::platform::transport::connect_blocking(socket)
        .expect("the sandboxed supervisor socket answers");
    let mut writer = stream.try_clone_box().expect("the observer's write half");
    let frame = format!(
        "{{\"type\":\"command\",\"id\":\"observer\",\"protocol\":{{\"name\":\"prime-agent.daemon\",\"version\":{}}},\"command\":{{\"type\":\"attach\",\"activeSessionId\":{}}}}}\n",
        pa_types::daemon::DAEMON_PROTOCOL_VERSION,
        serde_json::to_string(&json!(session)).unwrap()
    );
    writer
        .write_all(frame.as_bytes())
        .expect("the attach writes");
    writer.flush().expect("the flush lands");
    let mut reader = BufReader::new(stream.try_clone_box().expect("the observer's read half"));
    let mut line = String::new();
    loop {
        line.clear();
        assert!(
            reader.read_line(&mut line).unwrap_or(0) > 0,
            "the observer's attach answered"
        );
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if value.get("type").and_then(Value::as_str) == Some("response") {
                assert!(value["success"].as_bool().unwrap_or(false), "{value}");
                break;
            }
        }
    }
    stream
}

/// The bound's idle reclamation never takes a session one client still
/// observes: the worker's own attached-client refusal keeps the
/// conversation (the A2A link detaches before the kill asks, so a
/// client left attached is a foreign observer whose connection the
/// reclamation never drops), a new conversation past the bound answers
/// the honest table-full refusal until the observer leaves, and the
/// observed conversation serves the whole time.
#[test]
fn a2a_the_eviction_never_takes_an_observed_session() {
    let child = A2aChild::spawn_with_settings(
        &json!({ "a2a": { "maxContexts": 1 } }),
        &[],
        &json!({ "engine": "faux", "responses": ["R-1", "R-2", "R-3"] }),
    );
    let first = child.send_message("one", None);
    assert_eq!(
        first["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{first}"
    );
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .unwrap()
        .to_string();
    let session = daemon_live_session(&child.socket);
    // One foreign observer attaches and stays connected: the row's
    // attached-client count is the observable the attach landed.
    let observer = attach_observer(&child.socket, &session);
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let attached = daemon_row(&child.socket, &session)["attachedClients"]
            .as_u64()
            .unwrap_or(0);
        if attached > 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the observer's attach landed on the live row"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // A new conversation past the bound cannot reclaim the observed
    // context: the honest table-full refusal, never the observer's
    // session closed under them.
    let refused = child.send_message("two", None);
    assert_eq!(
        refused["error"]["code"], -32603,
        "the table answers full while its only context is observed: {refused}"
    );
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("context table is full")),
        "{refused}"
    );
    // The observed conversation keeps serving.
    let still = child.send_message("still", Some(&context_id));
    assert_eq!(
        still["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the observed conversation serves through the refused reclamation: {still}"
    );
    // The observer leaves: the row's count is the observable the
    // detach landed, and the next conversation reclaims and serves.
    drop(observer);
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let attached = daemon_row(&child.socket, &session)["attachedClients"]
            .as_u64()
            .unwrap_or(0);
        if attached == 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the observer's detach landed on the live row"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let third = child.send_message("three", None);
    assert_eq!(
        third["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the freed context reclaims for the next conversation: {third}"
    );
}

/// `--no-session`: every send on
/// one context answers — the create's EMPTY session file is no file at
/// all, so the re-attach after the first task's idle detach re-opens
/// the client-owned session instead of a pathed create the daemon
/// refuses.
#[test]
fn a2a_no_session_contexts_serve_every_send() {
    let script = json!({ "engine": "faux", "responses": ["NS-1", "NS-2"] });
    let child = A2aChild::spawn(&["--no-session"], &script);
    let first = child.send_message("one", None);
    assert_eq!(
        first["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the first client-owned send serves: {first}"
    );
    let context = first["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();
    let second = child.send_message("two", Some(&context));
    assert_eq!(
        second["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the second send on a client-owned context serves: {second}"
    );
    assert_eq!(
        second["result"]["task"]["artifacts"][0]["parts"][0]["text"], "NS-2",
        "the second send answered its own reply: {second}"
    );
}

/// The leak classes the by-class credit missed, pinned on the real
/// wire: while the task's turn is held, another agent's
/// `agent_message` delivery (the injected policy, no admission) and
/// another client's admission-NAMED prompt both run on the shared
/// session — and neither reply ever lands in the task's artifact or
/// history (the run-anchor identity, never the class, decides the
/// credit).
#[test]
fn a2a_foreign_agent_messages_and_admissions_never_reach_the_task() {
    let script = json!({ "engine": "faux", "responses": [
        { "text": "A2A-REPLY", "delayMs": 6000 },
        "AGENT-MSG-REPLY",
        "FOREIGN-ADMISSION-REPLY",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "held",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let task_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    let session = daemon_live_session(&child.socket);
    let streaming = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let list = daemon_list(&child.socket);
            let streaming = list["data"]["sessions"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["activeSessionId"].as_str() == Some(session.as_str()))
                })
                .and_then(|row| row["isStreaming"].as_bool())
                .unwrap_or(false);
            if streaming {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(streaming, "the A2A turn is streaming");
    // Another agent's agent_message delivery rides the shared session
    // (the injected class the by-class credit once leaked): a real
    // second session on the sandboxed daemon is the sender.
    let created = daemon_command(
        &child.socket,
        &json!({
            "type": "create",
            "name": "probe-sender",
            "noSession": true,
            "cwd": child.home.path().to_string_lossy(),
        }),
    );
    let sender = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("the sender session created");
    let messaged = daemon_command(
        &child.socket,
        &json!({
            "type": "send_message",
            "targetActiveSessionId": session,
            "message": "a foreign agent's question",
            "fromActiveSessionId": sender,
            "agentOrigin": true,
        }),
    );
    assert!(
        messaged["success"].as_bool().unwrap_or(false),
        "the foreign agent message delivered: {messaged}"
    );
    // A one-shot client's prompt with its OWN admission id (the
    // admission-named class the by-class credit once leaked).
    let admitted = daemon_command(
        &child.socket,
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": session,
            "message": "a foreign admission prompt",
            "admissionId": "prompt-admission:foreign-1",
        }),
    );
    assert!(
        admitted["success"].as_bool().unwrap_or(false),
        "the foreign admission prompt queued: {admitted}"
    );
    // The task completes with its OWN reply alone.
    let completed = {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 71,
                    "method": "GetTask",
                    "params": { "id": task_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            if get["result"]["status"]["state"] == "TASK_STATE_COMPLETED" {
                break get;
            }
            if std::time::Instant::now() > deadline {
                break get;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert_eq!(
        completed["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the task completed: {completed}"
    );
    let artifact = completed["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(
        artifact, "A2A-REPLY",
        "the task's artifact is its own reply alone: {artifact:?}"
    );
    let foreign_texts = ["AGENT-MSG-REPLY", "FOREIGN-ADMISSION-REPLY"];
    let history = completed["result"]["history"]
        .as_array()
        .expect("the history");
    assert!(
        history.iter().all(|row| {
            !foreign_texts.contains(&row["parts"][0]["text"].as_str().unwrap_or_default())
        }),
        "the foreign replies never joined the history: {history:?}"
    );
}

/// A child's `agent_message` reply runs as the task's own continuation:
/// the delivery intake stamps the queued reply with the child's spawning
/// delivery (the registry record's stamp — the same identity its
/// terminal notice carries), so the reply turn's answer — the delegated
/// work's result — credits the task still waiting it out. Without the
/// stamp the reply turn resolves foreign and the task completes on its
/// interim text alone (the review probe's defect). The child sends
/// through the raw kernel host request (the skill module of a sandboxed
/// home may not import), its reply lands AFTER the parent's own turn
/// (its own send delays past the parent's tool round), and the child's
/// settle lands last so the no-reply notice cannot race in and spend
/// the reply turn's response: the whole-run artifact must carry the
/// parent's own answer AND the reply turn's answer.
#[test]
fn a2a_a_childs_agent_message_reply_reaches_the_task_artifact() {
    // The child's one turn answers through agent_message (the reply the
    // parent answers in a new turn), then settles with its final text.
    let child_reply_cell = "from rlm import host_request\nawait host_request(\"agent_message.send\", {\"message\": \"CHILD-REPLY-42\", \"receiver_role\": \"parent\", \"receiver_name\": None})\nprint(\"CHILD-SENT\")";
    // The reply fires a full second after the child's turn starts: the
    // parent's own turn has long ended, so the reply row runs as its own
    // turn — and the child's settle lands another second and a half
    // later, past the reply's marker window, so the no-reply notice
    // stays withheld.
    let child = json!({ "engine": "faux", "responses": [
        { "content": [{ "type": "toolCall", "name": "ipython", "arguments": { "code": child_reply_cell } }], "delayMs": 1000 },
        { "text": "the child finished", "delayMs": 1500 },
    ]});
    let parent = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Delegating." },
            { "type": "toolCall", "name": "ipython", "arguments": { "code": "handle = await rlm.spawn(\"run the child task\", name=\"kid\")\nprint(\"SPAWNED\", handle.rlm_child_id)" } },
        ] },
        "the parent's own answer",
        "REPLY-TURN-ANSWER",
        "the children were processed",
    ]});
    let a2a_child = A2aChild::spawn_with_child_script(&[], &parent, &child);
    let send = a2a_child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "delegate the work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    // The reply turn runs on the parent session while the task waits the
    // child out: the transcript observes both the child's delivery and
    // the turn that processed it.
    loop {
        let transcript = collected_transcript(a2a_child.home.path());
        if transcript.contains("CHILD-REPLY-42") && transcript.contains("REPLY-TURN-ANSWER") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the child's reply turn never ran: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let task = loop {
        let get = a2a_child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 81,
                "method": "GetTask",
                "params": { "id": task_id },
            })),
            Some("1.0"),
        );
        let get = A2aChild::body_json(&get);
        let state = get["result"]["status"]["state"].as_str().unwrap_or("");
        if matches!(
            state,
            "TASK_STATE_COMPLETED" | "TASK_STATE_CANCELED" | "TASK_STATE_FAILED"
        ) {
            break get;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the task never settled behind the child: {get}"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        task["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the task completes with the delegated result: {task}"
    );
    let artifact = task["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        artifact.contains("the parent's own answer"),
        "the artifact carries the parent's own answer: {artifact:?}"
    );
    assert!(
        artifact.contains("REPLY-TURN-ANSWER"),
        "the artifact carries the reply turn's answer — the delegated result: {artifact:?}"
    );
}

/// The admission-scoped completion wait holds the task's OWN background
/// kernel `bash()`: the turn that launched it ends with interim text,
/// but the barrier (the A2A headless wait names the task's delivery)
/// holds the launch table's binding, so the `[bash-done]` notice turn
/// runs as the delivery's continuation BEFORE the task settles — the
/// artifact carries the turn that processed the completion, exactly as
/// print mode delivers the same wait. Without the arm the task completes
/// on the interim text and the notice turn credits nothing (the probe's
/// defect); this lane holds NO child open, so the bash arm alone owns
/// the hold.
#[test]
fn a2a_the_completion_wait_holds_the_tasks_own_kernel_bash() {
    let home = tempfile::TempDir::new().unwrap();
    let helper = home.path().join("slow-bash.py");
    std::fs::write(
        &helper,
        "import time\ntime.sleep(3)\nprint(\"BASH-DONE-OUT\")\n",
    )
    .expect("the slow-bash helper writes");
    let launch_cell = format!(
        "h = bash(\"/usr/bin/python3 {}\")\nprint(\"BASH-LAUNCHED\")",
        helper.display()
    );
    let script = json!({ "engine": "faux", "responses": [
        { "content": [{ "type": "toolCall", "name": "ipython", "arguments": { "code": launch_cell } }] },
        "the interim answer",
        "PARENT-PROCESSED-BASH",
    ]});
    let child = A2aChild::spawn_in_home(home, &[], &[], &script);
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "run the job in the background",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    // The task's own turn: launch the bash and answer the interim text.
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("the interim answer") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the task's own turn never settled: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // The barrier must NOT settle on the interim answer while the bash
    // runs (2 s): the wait holds the delivery's binding.
    let early = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 82,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let early = A2aChild::body_json(&early);
    assert_eq!(
        early["result"]["status"]["state"], "TASK_STATE_WORKING",
        "the task holds behind its own background bash: {early}"
    );
    let task = loop {
        let get = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 83,
                "method": "GetTask",
                "params": { "id": task_id },
            })),
            Some("1.0"),
        );
        let get = A2aChild::body_json(&get);
        if get["result"]["status"]["state"] == "TASK_STATE_COMPLETED" {
            break get;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the task never settled behind the background bash: {get}"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    let artifact = task["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        artifact.contains("PARENT-PROCESSED-BASH"),
        "the artifact carries the completion notice's turn — the background job's result: {artifact:?}"
    );
}

/// An A2A `CancelTask` never pauses another client's goal on the shared
/// session: the withdrawal's goal stop matches the delivery whose turn
/// STARTED the goal (the Active transition's ownership stamp), so the
/// canceled task's own loop retires while a foreign daemon client's
/// goal — started by ITS delivery's `/goal` prompt — stays active.
/// Without the ownership match every withdrawal paused whichever goal
/// the session held (the probe's defect); the foreign goal's state rows
/// after the cancel are the observable.
#[test]
fn a2a_a_cancel_does_not_pause_a_foreign_clients_goal() {
    let spawn_cell = "handle = await rlm.spawn(\"run the child task\", name=\"kid\")\nprint(\"SPAWNED\", handle.rlm_child_id)";
    let parent = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Delegating." },
            { "type": "toolCall", "name": "ipython", "arguments": { "code": spawn_cell } },
        ] },
        "the original task own answer",
        "FOREIGN-GOAL-REPLY",
        "the children were processed",
    ]});
    // The held child's window is a few seconds: long enough to cancel
    // inside, short enough that whatever holds the session's
    // shared-persistence lock through the child releases it inside this
    // lane's observation window (an unconditional pause waits that lock
    // out; the pin must observe its landing).
    let child = A2aChild::spawn_with_child_script(
        &[],
        &parent,
        &rlm_child_script("the child finished", 6_000),
    );
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "delegate the original work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();
    let session = daemon_live_session(&child.socket);
    // The task waits its held child out (the children window).
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let get = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 84,
                "method": "GetTask",
                "params": { "id": task_id },
            })),
            Some("1.0"),
        );
        let get = A2aChild::body_json(&get);
        if get["result"]["status"]["state"] == "TASK_STATE_WORKING"
            && get["result"]["artifacts"]
                .to_string()
                .contains("own answer")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the task never reached the children window: {get}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // A foreign daemon client starts ITS OWN goal on the shared session
    // (its delivery's `/goal` prompt, its own admission).
    let goal_prompt = daemon_command(
        &child.socket,
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": session,
            "message": "/goal the foreign client work",
            "admissionId": "prompt-admission:foreign-client-goal",
        }),
    );
    assert!(
        goal_prompt["success"].as_bool().unwrap_or(false),
        "the foreign goal prompt ran: {goal_prompt}"
    );
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("FOREIGN-GOAL-REPLY")
            && transcript.contains(r#""objective":"the foreign client work""#)
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the foreign goal never turned active: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // The task's cancel settles CANCELED at once.
    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 85,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the cancel settles its own task: {cancel}"
    );
    // The observation window: the foreign goal must stay active through
    // the withdrawal's fire-and-forget pause (the probe saw a pause land
    // four seconds after the cancel) and past the held child's run-on.
    let observe = std::time::Instant::now() + Duration::from_secs(8);
    while std::time::Instant::now() < observe {
        assert!(
            !goal_paused_row(&collected_transcript(child.home.path())),
            "the foreign goal must survive the canceled task's withdrawal: the pause landed anyway"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    // The run-on child settled inside the window and the foreign
    // goal's own loop wrote its own rows since (its continuation may
    // have failed on the exhausted script — its own doing). The pin's
    // observable: the goal's last word is its OWN — never the
    // canceled task's withdrawal pause.
    let transcript = collected_transcript(child.home.path());
    let last_state_row = transcript
        .lines()
        .rev()
        .find(|line| line.contains("thread_goal_state") && line.contains("the foreign client work"))
        .expect("the foreign goal's state row");
    assert!(
        !last_state_row.contains(r#""status":"paused""#)
            && !last_state_row.contains("Paused by the canceled task"),
        "the foreign goal survived the canceled task's withdrawal: {last_state_row}"
    );
}

/// Whether the foreign-goal lanes' transcript holds a PAUSED row for the
/// shared session's goal (the withdrawal's unscoped pause marker).
fn goal_paused_row(transcript: &str) -> bool {
    transcript.lines().any(|row| {
        row.contains("thread_goal_state")
            && row.contains("the foreign client work")
            && row.contains(r#""status":"paused""#)
    })
}

/// An own `/autonomous` task canceled in the children window mints no
/// turn after its CANCELED answer: the in-run hook's deferral records
/// the deferring delivery, and the withdrawal's retire matches it (the
/// settle hook's mint consult then finds no owed continuation). Without
/// the recorded owner the retire dropped whatever deferral the session
/// held — and with the retire gone entirely the canceled task's loop
/// minted one turn after another with no client to answer them.
#[test]
fn a2a_an_autonomous_cancel_in_the_children_window_retires_the_deferral() {
    let spawn_cell = "handle = await rlm.spawn(\"run the child task\", name=\"kid\")\nprint(\"SPAWNED\", handle.rlm_child_id)";
    let parent = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Delegating." },
            { "type": "toolCall", "name": "ipython", "arguments": { "code": spawn_cell } },
        ] },
        "the task own answer",
        "the children were processed",
        "the next send's own answer",
    ]});
    let child = A2aChild::spawn_with_child_script(
        &[],
        &parent,
        &rlm_child_script("the child finished", 5_000),
    );
    // The conversation arms the autonomous mode first (a session-command
    // turn, no model call), then the work turn defers its continuation
    // behind the child it spawns.
    let arm = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "/autonomous on --max-continuations 2 --max-turns 5",
            None,
            None,
            json!({}),
        )),
        Some("1.0"),
    );
    let arm = A2aChild::body_json(&arm);
    assert_eq!(
        arm["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the arming command settles at once: {arm}"
    );
    let context_id = arm["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "do the delegated work",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("the task own answer")
            && !transcript.contains("rlm_child_terminal_notice")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the work turn never reached the children window: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 86,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the children window's cancel settles at once: {cancel}"
    );
    // The run-on notice turn resolves foreign (the settled child's
    // terminal notice), then the retired deferral must mint NOTHING:
    // the next send's own turn takes the first scripted response. A
    // surviving deferral would spend that response on a phantom turn
    // with no client to answer it, and the next send would fail on the
    // exhausted script.
    let run_on = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("rlm_child_terminal_notice")
            && transcript.contains("the children were processed")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < run_on,
            "the child's notice turn never ran on: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    // Disarm the loop first so the next send's own boundary mints
    // nothing (the loop's own continuation would consume a response).
    assert!(
        !collected_transcript(child.home.path()).contains("the next send's own answer"),
        "a phantom turn already consumed the next send's response: {}",
        collected_transcript(child.home.path())
    );
    let off = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "/autonomous off",
            Some(&context_id),
            None,
            json!({}),
        )),
        Some("1.0"),
    );
    let off = A2aChild::body_json(&off);
    assert_eq!(
        off["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the disarm command settles at once: {off}"
    );
    let next = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "the next question",
            Some(&context_id),
            None,
            json!({}),
        )),
        Some("1.0"),
    );
    let next = A2aChild::body_json(&next);
    assert_eq!(
        next["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the next send answers on the conversation: {next}"
    );
    let artifact = next["result"]["task"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(
        artifact, "the next send's own answer",
        "the next send's own turn answered, never a retired deferral's phantom: {artifact:?}"
    );
}

/// The auto-retry's re-emitted run carries the delivery's identity (the
/// anchor's tags): a turn whose first attempt ends with no visible
/// answer — the retry path's own trigger — recovers through the retry
/// and the task's artifact is the RECOVERED answer, never a lost
/// reply (the tag-less re-emit would credit nothing and strand the
/// turn's answer).
#[test]
fn a2a_a_retried_turn_artifact_is_the_recovered_answer() {
    let script = json!({ "engine": "faux", "responses": [
        { "content": [ { "type": "thinking", "thinking": "hidden reasoning" } ] },
        "RECOVERED-ANSWER",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let reply = child.send_message("explain the retry", None);
    assert_eq!(
        reply["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the retried turn completes: {reply}"
    );
    assert_eq!(
        reply["result"]["task"]["artifacts"][0]["parts"][0]["text"], "RECOVERED-ANSWER",
        "the recovered reply is the artifact: {reply}"
    );
    let history = reply["result"]["task"]["history"]
        .as_array()
        .expect("the history");
    assert!(
        history
            .iter()
            .any(|row| row["parts"][0]["text"] == "RECOVERED-ANSWER"),
        "the recovered answer joined the history: {history:?}"
    );
}

/// A second daemon client's delivery on the shared session is never the
/// A2A task's reply: the task's artifact, history, and stream carry
/// the task's OWN run alone (a foreign `follow_up` queued during the
/// task's turn runs after it, and its reply never lands in the task).
#[test]
fn a2a_a_foreign_clients_turn_never_reaches_the_task() {
    let script = json!({ "engine": "faux", "responses": [
        { "text": "A2A-REPLY", "delayMs": 4000 },
        "FOREIGN-REPLY",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "held",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let task_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    // The A2A turn is streaming (the observable readiness).
    let session = daemon_live_session(&child.socket);
    let streaming = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let list = daemon_list(&child.socket);
            let streaming = list["data"]["sessions"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["activeSessionId"].as_str() == Some(session.as_str()))
                })
                .and_then(|row| row["isStreaming"].as_bool())
                .unwrap_or(false);
            if streaming {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(streaming, "the A2A turn is streaming");
    // A second daemon client queues a follow_up on the same session —
    // the foreign delivery runs after the task's own turn.
    let queued = daemon_command(
        &child.socket,
        &json!({ "type": "follow_up", "activeSessionId": session, "message": "foreign client question" }),
    );
    assert!(
        queued["success"].as_bool().unwrap_or(false),
        "the foreign follow_up queued: {queued}"
    );
    // The task completes with its OWN reply alone.
    let completed = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 61,
                    "method": "GetTask",
                    "params": { "id": task_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            if get["result"]["status"]["state"] == "TASK_STATE_COMPLETED" {
                break get;
            }
            if std::time::Instant::now() > deadline {
                break get;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert_eq!(
        completed["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the task completed: {completed}"
    );
    let artifact = completed["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(
        artifact, "A2A-REPLY",
        "the task's artifact is its own reply alone — the foreign turn's text never joined: {artifact:?}"
    );
    let history = completed["result"]["history"]
        .as_array()
        .expect("the history");
    assert!(
        history
            .iter()
            .all(|row| { row["parts"][0]["text"] != "FOREIGN-REPLY" }),
        "the foreign reply never entered the task's history: {history:?}"
    );
}

/// `SubscribeToTask` (spec 3.1.6): the first SSE frame wraps the task
/// snapshot in the stream response oneof (`result.task`) — a conforming
/// client recovers the task id and state from it, and the terminal
/// frame closes the stream.
#[test]
fn a2a_subscribe_first_frame_wraps_the_task_snapshot() {
    let script = json!({ "engine": "faux", "tokensPerSecond": 2, "responses": [
        "a paced reply that streams slowly enough for a subscription to attach",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "held",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let task_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    // The subscribe attaches to a LIVE mid-flight task: wait for the
    // dispatch's WORKING (the admit-to-dispatch gap is a real state —
    // a first frame wrapping a SUBMITTED task is honest, but this pin
    // asserts the live one, so it must wait for it, never race it).
    wait_for_task_in_state(&child, "TASK_STATE_WORKING")
        .expect("the paced reply keeps the task WORKING");
    let body = json!({
        "jsonrpc": "2.0",
        "id": 62,
        "method": "SubscribeToTask",
        "params": { "id": task_id },
    });
    let reply = child.request_sse("POST", "/", &[], Some(&body), Some("1.0"));
    assert_eq!(reply.status, 200, "the subscription answered SSE");
    let frames = A2aChild::sse_lines(&reply);
    assert_eq!(frames[0]["id"], 62);
    assert!(
        frames[0]["result"].get("task").is_some(),
        "the subscribe's first frame carries the task inside the stream response oneof: {frames:?}"
    );
    assert_eq!(
        frames[0]["result"]["task"]["id"], task_id,
        "the wrapped snapshot identifies the task: {frames:?}"
    );
    assert_eq!(
        frames[0]["result"]["task"]["status"]["state"], "TASK_STATE_WORKING",
        "the wrapped snapshot carries the live state: {frames:?}"
    );
    assert!(
        frames[0]["result"].get("statusUpdate").is_none(),
        "exactly one oneof member: {frames:?}"
    );
    assert!(
        frames
            .iter()
            .any(|frame| frame["result"].get("artifactUpdate").is_some()),
        "the live stream carried the reply's chunks: {frames:?}"
    );
}

/// A task waiting out the daemon's autonomous continuation (a goal
/// loop) is cancelable: the cancel stops the owed run, and the task
/// settles CANCELED — never the -32002 refusal while the loop keeps
/// spending turns.
#[test]
fn a2a_a_goal_loop_task_is_cancelable_while_awaiting_completion() {
    // The second continuation is held too: the session stays busy
    // through the cancel window (a quiet session lets the flow's
    // headless-completion settle the task before the cancel lands).
    let script = json!({ "engine": "faux", "responses": [
        "GOAL-1",
        { "text": "GOAL-2", "delayMs": 8000 },
        { "text": "GOAL-3", "delayMs": 20000 },
        "",
        "",
        "",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "/goal write three short lines",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let task_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    // The first continuation is streaming (the task's response settled
    // into the awaiting state and the loop owes turns).
    let session = daemon_live_session(&child.socket);
    let continuation_running = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 63,
                    "method": "GetTask",
                    "params": { "id": task_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            let artifact = get["result"]["artifacts"][0]["parts"][0]["text"]
                .as_str()
                .unwrap_or_default();
            if artifact.contains("GOAL-2") {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(
        continuation_running,
        "the goal loop's continuation reached the task (the awaiting phase is observable)"
    );
    // A `taskId` continuation in the awaiting window answers the
    // standing -32004 refusal (the daemon's internal refusal text
    // never leaks as the protocol's answer).
    let context_id = held["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();
    let refused = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "continue the awaiting task",
            Some(&context_id),
            Some(&task_id),
            json!({}),
        )),
        Some("1.0"),
    );
    let refused = A2aChild::body_json(&refused);
    assert_eq!(
        refused["error"]["code"], -32004,
        "the awaiting task's refused continuation answers the standing contract: {refused}"
    );
    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 64,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the awaiting task is cancelable: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the cancel stopped the owed run: {cancel}"
    );
    // The session-side check: the cancel stops the owed run AT ONCE.
    // The abort of the running continuation settles the session well
    // inside the held response's 20 s delay — a loop that survived its
    // cancel would stream GOAL-3 to the delay's end, so the settle
    // time itself is the witness the task artifact cannot carry (a
    // terminal task's late frames never reach it).
    let settled = {
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            let list = daemon_list(&child.socket);
            let streaming = list["data"]["sessions"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["activeSessionId"].as_str() == Some(session.as_str()))
                })
                .and_then(|row| row["isStreaming"].as_bool())
                .unwrap_or(false);
            if !streaming {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(
        settled,
        "the session settled at once after the cancel — the held continuation's turn was aborted, not waited out"
    );
    // The session-side check: the held continuation never ran to a
    // persisted row after the cancel. The artifact alone cannot pin
    // the stop (a terminal task's late frames never reach it) — the
    // session file is the honest witness: a turn that survived the
    // cancel would persist its later answers here.

    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 65,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    let artifact = get["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        !artifact.contains("GOAL-3"),
        "the goal loop spent no further turn after the cancel: {artifact:?}"
    );
}

/// The dispatched task is WORKING at its own turn's start (spec 3.4.2),
/// not at its first assistant frame: through the provider's whole time
/// to first token, `GetTask` reports the live state — and the v1
/// `taskId` continuation still answers the -32004 refusal for that
/// WORKING turn (the pre-first-frame window is not a mid-turn
/// injection seam).
#[test]
fn a2a_a_dispatched_task_is_working_before_its_first_assistant_frame() {
    let script = json!({ "engine": "faux", "responses": [
        { "text": "FIRST-REPLY", "delayMs": 4000 },
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "held",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let task_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    let context_id = held["result"]["task"]["contextId"]
        .as_str()
        .unwrap()
        .to_string();
    // The state reaches WORKING through the turn's whole time to first
    // token (the delay holds every frame away): the wait POLLS to the
    // dispatched mark (the send's reply can beat the mark's write under
    // load) and the task is WORKING well before its first assistant
    // frame could exist.
    wait_for_task_in_state(&child, "TASK_STATE_WORKING")
        .expect("the dispatched task works before its first frame");
    // The turn must be RUNNING before the continuation joins it: the
    // worker arms its running admission ids at the turn's pickup, and
    // the daemon's streaming row is the observable readiness that the
    // turn is live (the 4 s hold keeps the window open).
    let session = daemon_live_session(&child.socket);
    let streaming = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let row = daemon_row(&child.socket, &session);
            if row["isStreaming"].as_bool().unwrap_or(false) {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    assert!(streaming, "the held turn is streaming");
    let continuation = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "continuation",
            Some(&context_id),
            Some(&task_id),
            json!({}),
        )),
        Some("1.0"),
    );
    let continuation = A2aChild::body_json(&continuation);
    assert_eq!(
        continuation["error"]["code"], -32004,
        "the WORKING turn's continuation answers the v1 refusal: {continuation}"
    );
    // The refusal reached no session: the task settles with its own
    // reply alone.
    let settled = wait_for_task_in_state(&child, "TASK_STATE_COMPLETED")
        .expect("the refused-continuation task settles");
    assert_eq!(
        settled, task_id,
        "the settled task is the held one: {settled}"
    );
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 44,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(
        get["result"]["artifacts"][0]["parts"][0]["text"], "FIRST-REPLY",
        "{get}"
    );
    assert_eq!(
        get["result"]["history"].as_array().map(Vec::len),
        Some(2),
        "the task's history is its admitted row and its own answer: {get}"
    );
    assert!(
        !get["result"]["history"]
            .to_string()
            .contains("continuation"),
        "the refused continuation joined no history: {get}"
    );
}

/// The live-context bound's reclamation never interrupts another
/// client's turn: a full table whose only idle context's session is
/// streaming (a foreign client's turn) refuses the new conversation —
/// the task route answers the table-full error while the foreign turn
/// keeps running.
#[test]
fn a2a_the_bound_never_evicts_a_session_another_client_is_using() {
    let script = json!({ "engine": "faux", "responses": [
        "R-1",
        { "text": "FOREIGN-WORK", "delayMs": 9000 },
    ]});
    let child =
        A2aChild::spawn_with_settings(&json!({ "a2a": { "maxContexts": 1 } }), &[], &script);
    let first = child.send_message("one", None);
    assert_eq!(
        first["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the first conversation completes (the only context)"
    );
    let session = daemon_live_session(&child.socket);
    // A separate daemon client starts a held turn on the shared
    // session (the row reports it streaming; the prompt's answer rides
    // the turn's end, so it runs on its own thread).
    let foreign = {
        let socket = child.socket.clone();
        let session = session.clone();
        std::thread::spawn(move || {
            daemon_command(
                &socket,
                &json!({ "type": "prompt", "activeSessionId": session, "message": "foreign work" }),
            )
        })
    };
    let streaming = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let list = daemon_list(&child.socket);
            let streaming = list["data"]["sessions"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["activeSessionId"].as_str() == Some(session.as_str()))
                })
                .and_then(|row| row["isStreaming"].as_bool())
                .unwrap_or(false);
            if streaming {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    assert!(streaming, "the foreign client's turn is streaming");
    // The new conversation answers the table-full error — the busy
    // session never reclaims.
    let refused = child.send_message("new conversation", None);
    assert_eq!(
        refused["error"]["code"], -32603,
        "the full table with a busy session refuses the new conversation: {refused}"
    );
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("full")),
        "the refusal names the bound: {refused}"
    );
    // The refused conversation never touched the session: the foreign
    // turn is still streaming, and it completes with its own reply —
    // never aborted, never withdrawn.
    let list = daemon_list(&child.socket);
    let still_streaming = list["data"]["sessions"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["activeSessionId"].as_str() == Some(session.as_str()))
        })
        .and_then(|row| row["isStreaming"].as_bool())
        .unwrap_or(false);
    assert!(
        still_streaming,
        "the foreign turn outlived the refused conversation (never aborted by a reclaim): {list}"
    );
    let foreign = foreign.join().expect("the foreign turn answered");
    assert!(
        foreign["success"].as_bool().unwrap_or(false),
        "the foreign client's turn completed on its own terms: {foreign}"
    );
}

/// The live-context bound holds under concurrent new conversations:
/// the reservation counts in-flight creates, so N simultaneous sends
/// at a bound of one serve exactly one conversation and refuse the
/// rest — never creating workers past the configured bound.
#[test]
fn a2a_concurrent_new_conversations_hold_the_bound() {
    let script = json!({ "engine": "faux", "responses": ["R-1", "R-2", "R-3", "R-4"] });
    let child =
        A2aChild::spawn_with_settings(&json!({ "a2a": { "maxContexts": 1 } }), &[], &script);
    let bodies: Vec<Value> = (0..4)
        .map(|index| {
            let mut body = A2aChild::send_message_body(&format!("send-{index}"), None, None);
            body["params"]["message"]["messageId"] = json!(format!("m-{index}"));
            body
        })
        .collect();
    let replies: Vec<Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = bodies
            .iter()
            .map(|body| {
                scope.spawn(|| {
                    let reply = child.request("POST", "/", &[], Some(body), Some("1.0"));
                    A2aChild::body_json(&reply)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("the send ran"))
            .collect()
    });
    let served = replies
        .iter()
        .filter(|reply| reply["result"]["task"]["status"]["state"] == "TASK_STATE_COMPLETED")
        .count();
    let refused = replies
        .iter()
        .filter(|reply| reply["error"]["code"] == -32603.0)
        .count();
    assert_eq!(
        served, 1,
        "exactly one concurrent conversation serves at the bound of one: {replies:?}"
    );
    assert_eq!(
        refused, 3,
        "the rest answer the table-full error: {replies:?}"
    );
    // The daemon hosts exactly one live a2a session (the bound held —
    // no extra worker was ever created).
    let list = daemon_list(&child.socket);
    let live = list["data"]["sessions"].as_array().map_or(0, |rows| {
        rows.iter()
            .filter(|row| {
                row["sessionName"]
                    .as_str()
                    .is_some_and(|name| name.starts_with("a2a-"))
            })
            .count()
    });
    assert_eq!(live, 1, "one live session at the bound of one: {list}");
}

/// The session-level cancel withdraw is identity-scoped: the task's
/// own queued rows leave the lanes and its running delivery aborts,
/// while ANOTHER client's queued row on the shared session — an
/// unattached client's `follow_up` — survives the cancel untouched
/// (the cancel never clears the session's whole queue).
#[test]
fn a2a_the_cancel_withdraw_leaves_a_foreign_clients_queued_row() {
    // The second continuation is held too: the session stays busy
    // through the cancel window (a quiet session lets the flow's
    // headless-completion settle the task first).
    let script = json!({ "engine": "faux", "responses": [
        "GOAL-1",
        { "text": "GOAL-2", "delayMs": 12000 },
        { "text": "GOAL-3", "delayMs": 20000 },
        "",
        "",
        "",
    ]});
    let child = A2aChild::spawn(&[], &script);
    let held = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "/goal write three short lines",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let held = A2aChild::body_json(&held);
    let task_id = held["result"]["task"]["id"].as_str().unwrap().to_string();
    let session = daemon_live_session(&child.socket);
    // The awaiting phase is observable through the first continuation.
    let continuation_running = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 67,
                    "method": "GetTask",
                    "params": { "id": task_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            let artifact = get["result"]["artifacts"][0]["parts"][0]["text"]
                .as_str()
                .unwrap_or_default();
            if artifact.contains("GOAL-2") {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(continuation_running, "the goal loop's continuation runs");
    // An unattached daemon client queues its own `follow_up` on the
    // shared session (a row no A2A delivery owns).
    let queued = daemon_command(
        &child.socket,
        &json!({
            "type": "follow_up",
            "activeSessionId": session,
            "message": "an unattached client's queued question",
        }),
    );
    assert!(
        queued["success"].as_bool().unwrap_or(false),
        "the foreign follow_up queued: {queued}"
    );
    // The cancel serves while the foreign row sits on the same
    // session: the withdraw names the task's own deliveries alone.
    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 68,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the identity-scoped cancel serves: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the owed run stopped: {cancel}"
    );
    // The foreign client's queued row SURVIVED the cancel, observed on
    // the row's own existence: the sweep withdrew only the
    // conversation's own rows, so the row either still sits on the
    // lane, or the runner picked it up and its own user row landed in
    // the session (a cancel that stops the conversation's owed run can
    // idle the shared session, and the runner legitimately picks the
    // foreign row up — it was never the cancel's to take). A wrongly
    // withdrawn row leaves neither observable.
    let survived = {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let queue = daemon_command(
                &child.socket,
                &json!({
                    "type": "get_queue",
                    "activeSessionId": session,
                }),
            );
            let queued = queue["data"]["followUp"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row.as_str() == Some("an unattached client's queued question"))
            });
            if queued {
                break true;
            }
            let messages = daemon_command(
                &child.socket,
                &json!({
                    "type": "get_messages",
                    "activeSessionId": session,
                }),
            );
            let delivered = serde_json::to_string(&messages["data"]["messages"])
                .unwrap_or_default()
                .contains("an unattached client's queued question");
            if delivered {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(
        survived,
        "the unattached client's queued row survived the cancel — still on the lane or delivered as its own turn"
    );
}

/// A canceled BLOCKING send answers without waiting out the foreign
/// turn its idle wait rides (spec 3.2.2's settled answer): the flow
/// races the session's idle wait against the task's own terminal
/// frame, so the HTTP reply carries the CANCELED task while the
/// foreign client's run is still streaming — never held until the
/// unrelated turn ends, and the foreign turn is never aborted.
#[test]
fn a2a_a_canceled_blocking_send_answers_without_waiting_the_foreign_turn() {
    let script = json!({ "engine": "faux", "responses": [
        "first reply",
        { "text": "the foreign client's held turn", "delayMs": 20000 },
    ]});
    let child = A2aChild::spawn(&[], &script);
    // The conversation's first task completes, leaving its session
    // quiet for the foreign turn below (the context's binding stays).
    let first = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "first",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let first = A2aChild::body_json(&first);
    let first_id = first["result"]["task"]["id"]
        .as_str()
        .expect("the task")
        .to_string();
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();
    let settled = {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 71,
                    "method": "GetTask",
                    "params": { "id": first_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            if get["result"]["status"]["state"] == "TASK_STATE_COMPLETED" {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    assert!(settled, "the first task completed before the foreign turn");
    let session = daemon_live_session(&child.socket);
    // A foreign daemon client starts a held turn on the shared session
    // (its answer rides the turn's end, so the command waits on its own
    // thread).
    let foreign = {
        let socket = child.socket.clone();
        let session = session.clone();
        std::thread::spawn(move || {
            daemon_command(
                &socket,
                &json!({ "type": "prompt", "activeSessionId": session, "message": "a foreign client's held turn" }),
            )
        })
    };
    let streaming = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let list = daemon_list(&child.socket);
            let streaming = list["data"]["sessions"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["activeSessionId"].as_str() == Some(session.as_str()))
                })
                .and_then(|row| row["isStreaming"].as_bool())
                .unwrap_or(false);
            if streaming {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    assert!(streaming, "the foreign client's turn is streaming");
    // The blocking send on the same conversation waits out the foreign
    // turn in its own thread; its task is admitted (SUBMITTED) the whole
    // wait.
    let (tx_reply, rx_reply) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let reply = child.request(
                "POST",
                "/",
                &[],
                Some(&send_body(
                    "blocked behind the foreign turn",
                    Some(&context_id),
                    None,
                    json!({}),
                )),
                Some("1.0"),
            );
            let _ = tx_reply.send(reply);
        });
        let blocked_id = {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let list = child.request(
                    "POST",
                    "/",
                    &[],
                    Some(&json!({
                        "jsonrpc": "2.0",
                        "id": 72,
                        "method": "ListTasks",
                        "params": { "contextId": context_id },
                    })),
                    Some("1.0"),
                );
                let list = A2aChild::body_json(&list);
                if let Some(task) = list["result"]["tasks"].as_array().and_then(|tasks| {
                    tasks
                        .iter()
                        .find(|task| task["id"].as_str() != Some(first_id.as_str()))
                }) {
                    break task["id"].as_str().expect("the blocked task").to_string();
                }
                assert!(
                    std::time::Instant::now() <= deadline,
                    "the blocked task never appeared: {list}"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        // The cancel of the undispatched task settles it at once; the
        // blocking reply must follow while the foreign turn still runs.
        let cancel = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 73,
                "method": "CancelTask",
                "params": { "id": blocked_id },
            })),
            Some("1.0"),
        );
        let cancel = A2aChild::body_json(&cancel);
        assert!(
            cancel.get("error").is_none(),
            "the undispatched task is cancelable: {cancel}"
        );
        assert_eq!(
            cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the cancel settles the blocked task: {cancel}"
        );
        // The foreign held turn outlasts this bound by far (20 s), so
        // a reply held behind the idle wait fails it.
        let Ok(reply) = rx_reply.recv_timeout(Duration::from_secs(6)) else {
            panic!("the blocking reply was held behind the foreign turn past the cancel");
        };
        let reply = A2aChild::body_json(&reply);
        assert_eq!(
            reply["result"]["task"]["status"]["state"], "TASK_STATE_CANCELED",
            "the blocking reply answers the canceled task at once: {reply}"
        );
        // The foreign turn is STILL streaming: the reply beat its end
        // by far (the 20 s hold has ~18 s left), never the reverse.
        let list = daemon_list(&child.socket);
        let still_streaming = list["data"]["sessions"]
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row["activeSessionId"].as_str() == Some(session.as_str()))
            })
            .and_then(|row| row["isStreaming"].as_bool())
            .unwrap_or(false);
        assert!(
            still_streaming,
            "the foreign turn outlived the reply (never aborted, never the reply's bound): {list}"
        );
    });
    // The foreign turn was never aborted: it completes with its own
    // reply on its own terms.
    let foreign = foreign.join().expect("the foreign turn answered");
    assert!(
        foreign["success"].as_bool().unwrap_or(false),
        "the foreign client's turn completed on its own terms: {foreign}"
    );
}

/// The message parts the client sent are the message parts the task's
/// history keeps (spec 4.1.4): joined text parts never fuse into one
/// (the daemon prompt joins with a newline, and the history keeps the
/// client's own two-part shape), and an all-text message with no text
/// is the honest parameter error, never the content-type error (the
/// part IS text).
#[test]
fn a2a_the_history_keeps_the_received_parts_and_refuses_empty_text() {
    let child = A2aChild::spawn(&[], &plain_script());
    let mut message = json!({
        "messageId": "m-2-parts",
        "role": "ROLE_USER",
        "parts": [{ "text": "Translate to French:" }, { "text": "Good morning" }],
    });
    message.as_object_mut().unwrap().remove("contextId");
    let sent = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 71,
            "method": "SendMessage",
            "params": { "message": message },
        })),
        Some("1.0"),
    );
    let sent = A2aChild::body_json(&sent);
    assert_eq!(
        sent["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the two-part send serves: {sent}"
    );
    let history = sent["result"]["task"]["history"]
        .as_array()
        .expect("the history");
    let user_row = history
        .iter()
        .find(|row| row["messageId"] == "m-2-parts")
        .expect("the client's row");
    let parts = user_row["parts"].as_array().expect("the row's parts");
    assert_eq!(
        parts.len(),
        2,
        "the history keeps the two parts: {user_row}"
    );
    assert_eq!(parts[0]["text"], "Translate to French:");
    assert_eq!(parts[1]["text"], "Good morning");

    // An all-text message whose text is empty is the parameter error.
    let empty = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 72,
            "method": "SendMessage",
            "params": { "message": {
                "messageId": "m-empty",
                "role": "ROLE_USER",
                "parts": [{ "text": "" }],
            } },
        })),
        Some("1.0"),
    );
    let empty = A2aChild::body_json(&empty);
    assert_eq!(
        empty["error"]["code"], -32602,
        "the empty text message answers invalid params: {empty}"
    );
    assert!(
        empty["error"]["data"][0]["fieldViolations"][0]["field"]
            .as_str()
            .is_some_and(|field| field.contains("message.parts")),
        "the violation names the empty parts: {empty}"
    );
}

/// A garbage `statusTimestampAfter` is a parameter error, never a
/// silent zero-instant filter (the strict RFC 3339 parse at the
/// boundary).
#[test]
fn a2a_a_garbage_timestamp_filter_answers_invalid_params() {
    let child = A2aChild::spawn(&[], &plain_script());
    let refused = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 80,
            "method": "ListTasks",
            "params": { "statusTimestampAfter": "not-a-timestamp" },
        })),
        Some("1.0"),
    );
    let refused = A2aChild::body_json(&refused);
    assert_eq!(
        refused["error"]["code"], -32602,
        "the garbage timestamp answers invalid params: {refused}"
    );
}

/// A foreign abort that lands while a task's flow waits out a foreign
/// turn re-parks the queue behind a fresh suspension: the runner never
/// drains a suspended lane, so the daemon's idle wait would never
/// answer and the next task would wedge at its pre-write wait forever
/// (a manual `resume_queue` unwedged it). The flow's parked-queue
/// resume is not one-shot before the wait — it re-issues on a cadence
/// while the wait holds, so the mid-wait park unwedges at the next tick
/// and the task's turn settles in the bound. The cadence itself is
/// pinned by the controlled-link `a_pending_pre_write_wait_keeps_
/// resuming_the_parked_queue`; this e2e drives the whole abort path
/// against the real daemon with no fixed sleep — the abort may land
/// before or after the flow's wait, and both orders settle in the
/// bound.
#[test]
fn a2a_a_foreign_abort_during_the_pre_write_wait_still_settles_the_next_task() {
    let script = json!({
        "engine": "faux",
        "responses": [
            "FIRST-REPLY",
            { "text": "FOREIGN-LONG", "delayMs": 20000 },
            "FOREIGN-QUEUED",
            "SECOND-REPLY",
        ],
    });
    let child =
        A2aChild::spawn_with_settings(&json!({ "retry": { "enabled": false } }), &[], &script);
    let first = child.send_message("one", None);
    assert_eq!(
        first["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{first}"
    );
    let context_id = first["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();
    let session = daemon_live_session(&child.socket);
    // A foreign daemon client runs a long turn on the shared session,
    // then queues one row behind it.
    let foreign = daemon_command(
        &child.socket,
        &json!({ "type": "prompt", "activeSessionId": session, "message": "a foreign long turn" }),
    );
    assert!(foreign["success"].as_bool().unwrap_or(false), "{foreign}");
    let streaming = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let row = daemon_row(&child.socket, &session);
            if row["isStreaming"].as_bool().unwrap_or(false) {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    assert!(streaming, "the foreign turn is streaming");
    let queued = daemon_command(
        &child.socket,
        &json!({ "type": "follow_up", "activeSessionId": session, "message": "a foreign queued question" }),
    );
    assert!(queued["success"].as_bool().unwrap_or(false), "{queued}");
    // The A2A client's next task: its flow runs its pre-write resume
    // and parks at the WaitForIdle behind the foreign turn.
    let next = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "the next task",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let next = A2aChild::body_json(&next);
    let next_id = next["result"]["task"]["id"].as_str().unwrap().to_string();
    let abort = daemon_command(
        &child.socket,
        &json!({ "type": "abort", "activeSessionId": session }),
    );
    assert!(abort["success"].as_bool().unwrap_or(false), "{abort}");
    let next_final = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let get = child.request(
                "POST",
                "/",
                &[],
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": 62,
                    "method": "GetTask",
                    "params": { "id": next_id },
                })),
                Some("1.0"),
            );
            let get = A2aChild::body_json(&get);
            let state = get["result"]["status"]["state"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            if state == "TASK_STATE_COMPLETED"
                || state == "TASK_STATE_FAILED"
                || state == "TASK_STATE_CANCELED"
                || std::time::Instant::now() > deadline
            {
                break get;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    };
    assert_eq!(
        next_final["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the next task settles within the bound: {next_final}"
    );
}

/// The mode's interrupt exit removes its minted token file like every
/// other graceful exit: a terminal Ctrl-C after readiness answers the
/// mode's own zero exit, never a signal death that strands the
/// owner-only file behind. (The interrupt watch is installed at the
/// entry beside the SIGTERM watch — see the mode's exit select.)
#[test]
fn the_minted_token_file_leaves_on_sigint() {
    let shared = tempfile::TempDir::new().unwrap();
    let agent_dir = shared.path().join(".prime/agent");
    std::fs::create_dir_all(&agent_dir).expect("the agent dir creates");
    let mut child = A2aChild::spawn_with_env(
        &[(
            "PRIME_AGENT_CODING_AGENT_DIR",
            agent_dir.to_str().expect("the agent dir is utf-8"),
        )],
        &[],
        &plain_script(),
    );
    let token_path = child.minted_token_path();
    assert!(
        token_path.is_file(),
        "the minted token file exists while the run serves"
    );
    // The graceful exit a terminal Ctrl-C drives.
    let _ = std::process::Command::new("kill")
        .arg("-INT")
        .arg(child.child.id().to_string())
        .status()
        .expect("kill runs");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.child.try_wait().expect("the child's wait answers") {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the SIGINT did not end the mode within the bound"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "the mode exited gracefully on SIGINT (its own exit code, not a signal death): {status:?}"
    );
    assert!(
        !token_path.is_file(),
        "the interrupted run removed its minted token file: {token_path:?}"
    );
}

/// The mode's graceful exit stops the turns it admitted: teardown
/// withdraws every live task's delivery before the link drops (the
/// same `withdraw_admission` the `CancelTask` withdraw arm sends —
/// the sweep and the running-turn abort), so a SIGINT mid-turn aborts
/// the turn at the exit instead of leaving it running on in the
/// daemon with no client left to answer. The
/// session row stops streaming inside the bound and the persisted
/// assistant row ends aborted, never the paced reply's natural stop
/// seconds later.
#[test]
fn a2a_a_graceful_exit_aborts_the_live_task_turn() {
    // The paced reply streams for ~15 s at two words per second: a
    // turn that survived the exit would outlive the stop bound by far.
    let script = json!({
        "engine": "faux",
        "tokensPerSecond": 2,
        "responses": [
            "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty",
        ],
    });
    let mut child = A2aChild::spawn(&[], &script);
    let admitted = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "run the long task",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let admitted = A2aChild::body_json(&admitted);
    let task_id = admitted["result"]["task"]["id"]
        .as_str()
        .expect("the admitted task id")
        .to_string();
    // The turn is WORKING (its prompt dispatched; the turn may not
    // have streamed yet).
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let get = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 61,
                "method": "GetTask",
                "params": { "id": task_id },
            })),
            Some("1.0"),
        );
        let get = A2aChild::body_json(&get);
        if get["result"]["status"]["state"] == "TASK_STATE_WORKING" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the paced reply never reached WORKING: {get}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let session = daemon_live_session(&child.socket);
    assert!(
        daemon_row(&child.socket, &session)["isStreaming"]
            .as_bool()
            .unwrap_or(false),
        "the task's turn is streaming at the exit"
    );
    // The graceful exit a terminal Ctrl-C drives.
    let _ = std::process::Command::new("kill")
        .arg("-INT")
        .arg(child.child.id().to_string())
        .status()
        .expect("kill runs");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.child.try_wait().expect("the child's wait answers") {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the SIGINT did not end the mode within the bound"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "the mode exited gracefully on SIGINT: {status:?}"
    );
    // The daemon outlives the server: its session row shows whether
    // the exit's withdrawal stopped the turn.
    let stop_deadline = std::time::Instant::now() + Duration::from_secs(10);
    let stopped = loop {
        if !daemon_row(&child.socket, &session)["isStreaming"]
            .as_bool()
            .unwrap_or(false)
        {
            break true;
        }
        if std::time::Instant::now() > stop_deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(
        stopped,
        "the exit withdrew the live task's delivery: the turn stopped inside the bound"
    );
    // The withdrawal's durable abort mark: the worker checkpoints the
    // suspended queue when it aborts the withdrawn turn, inside the
    // withdraw handler itself (before its response travels), so the
    // mark lands whatever the engine's abort-unwind does — the abort
    // lands before the assistant message starts, so no aborted
    // assistant row persists at all (these tests run resident
    // sessions; the teardown closes only client-owned ones), and the
    // suspended-queue checkpoint is the deterministic witness that the
    // exit's withdrawal ran.
    let suspension_deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if collected_transcript(child.home.path()).contains("\"suspended\":true") {
            break;
        }
        assert!(
            std::time::Instant::now() < suspension_deadline,
            "the exit's withdrawal left no suspended-queue mark: {}",
            collected_transcript(child.home.path())
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // The turn never streams to its natural end behind the exit: a
    // leaked turn persists its assistant row with the natural `stop`
    // reason at its completion (~16 s of streaming, landing ~15 s
    // after this exit) — an aborted row never carries it, so the whole
    // completion window must stay clean of the natural stop.
    let natural_deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let natural = collected_transcript(child.home.path()).contains("\"stopReason\":\"stop\"");
        assert!(
            !natural,
            "the exit's turn leaked: the paced reply completed naturally after the exit"
        );
        if std::time::Instant::now() >= natural_deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The graceful exit with a QUEUED task behind a running one (the
/// exit settles the queued task at its guard): the exit is one
/// settlement decision under the state
/// guard — the queued task settles CANCELED there and its prompt never
/// reaches the session, so no row of its turn exists in the daemon
/// after the exit. The running task's delivery withdraws the same
/// way the live-exit test's does, and the rotation that abort frees
/// must not carry the queued
/// task to a write: a leaked queued flow would write its user row and
/// run its turn with the server already gone.
#[test]
fn a2a_a_graceful_exit_settles_the_queued_task_turn() {
    // The paced reply streams for ~15 s at two words per second: a
    // turn that survived the exit would outlive the stop bound by far.
    let script = json!({
        "engine": "faux",
        "tokensPerSecond": 2,
        "responses": [
            "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty",
        ],
    });
    let mut child = A2aChild::spawn(&[], &script);
    let admitted = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "run the long task",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let admitted = A2aChild::body_json(&admitted);
    let task_id = admitted["result"]["task"]["id"]
        .as_str()
        .expect("the admitted task id")
        .to_string();
    let context_id = admitted["result"]["task"]["contextId"]
        .as_str()
        .expect("the conversation id")
        .to_string();
    // The running task is WORKING (its prompt dispatched; the turn may
    // not have streamed yet).
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let get = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 61,
                "method": "GetTask",
                "params": { "id": task_id },
            })),
            Some("1.0"),
        );
        let get = A2aChild::body_json(&get);
        if get["result"]["status"]["state"] == "TASK_STATE_WORKING" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the paced reply never reached WORKING: {get}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // The queued second task on the same conversation: acknowledged
    // SUBMITTED behind the running head, its prompt never dispatched.
    let second = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "run the queued marker task",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let second = A2aChild::body_json(&second);
    assert_eq!(
        second["result"]["task"]["status"]["state"], "TASK_STATE_SUBMITTED",
        "the second task queues behind the running head: {second}"
    );
    // The graceful exit a terminal Ctrl-C drives.
    let _ = std::process::Command::new("kill")
        .arg("-INT")
        .arg(child.child.id().to_string())
        .status()
        .expect("kill runs");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.child.try_wait().expect("the child's wait answers") {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the SIGINT did not end the mode within the bound"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "the mode exited gracefully on SIGINT: {status:?}"
    );
    // The running task's turn stopped (the same durable witnesses the
    // live-exit test reads — see its comment for the abort-unwind
    // race).
    let session = daemon_live_session(&child.socket);
    let stop_deadline = std::time::Instant::now() + Duration::from_secs(10);
    let stopped = loop {
        if !daemon_row(&child.socket, &session)["isStreaming"]
            .as_bool()
            .unwrap_or(false)
        {
            break true;
        }
        if std::time::Instant::now() > stop_deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(
        stopped,
        "the exit withdrew the running task's delivery: the turn stopped inside the bound"
    );
    let suspension_deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if collected_transcript(child.home.path()).contains("\"suspended\":true") {
            break;
        }
        assert!(
            std::time::Instant::now() < suspension_deadline,
            "the exit's withdrawal left no suspended-queue mark: {}",
            collected_transcript(child.home.path())
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // The exit settled the queued task CANCELED before its flow could
    // write: nothing names its turn after the exit. One window covers
    // both leak signatures — the queued flow's own prompt write (the
    // marker text, the only writer being the flow itself; the abort's
    // rotation is exactly the queue head a leaked flow would take) and
    // the running head streaming to its natural end behind the exit
    // (the paced reply's full text persists at its natural completion
    // ~15 s after this exit only if the withdrawal failed to stop it).
    let leak_deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let transcript = collected_transcript(child.home.path());
        assert!(
            !transcript.contains("run the queued marker task"),
            "the queued task's prompt reached the session after the exit settled it"
        );
        assert!(
            !transcript.contains("\"stopReason\":\"stop\""),
            "the exit's head turn leaked: the paced reply completed naturally after the exit"
        );
        if std::time::Instant::now() >= leak_deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The parent faux script of the RLM-children lanes: the spawn turn
/// spawns one named child through the product `rlm.spawn` surface (the
/// worker's own kernel executes it), the parent answers its own
/// prompt, and the next response belongs to the settled child's
/// terminal-notice turn — `notice_delay_ms` holds that turn open (the
/// cancel lane needs a runnable window to cancel inside).
fn rlm_children_parent_script(notice_answer: &str, notice_delay_ms: u64) -> Value {
    let spawn_cell = "handle = await rlm.spawn(\"run the child task\", name=\"kid\")\nprint(\"SPAWNED\", handle.rlm_child_id)";
    json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Delegating." },
            { "type": "toolCall", "name": "ipython", "arguments": { "code": spawn_cell } },
        ] },
        "the parent's own answer",
        { "text": notice_answer, "delayMs": notice_delay_ms },
    ]})
}

/// The child worker's own faux script: its one turn answers so the
/// child settles and its terminal notice reaches the parent's queue.
fn rlm_child_script(child_answer: &str, hold_ms: u64) -> Value {
    json!({ "engine": "faux", "responses": [
        { "text": child_answer, "delayMs": hold_ms },
    ]})
}

/// The parent session's transcript under the sandboxed home: the
/// a2a contexts host their sessions in the agent dir the harness
/// isolates, so every `jsonl` file the run wrote is the read surface.
fn collected_transcript(home: &std::path::Path) -> String {
    let mut files = Vec::new();
    collect_jsonl(home, std::path::Path::new(""), &mut files);
    let mut transcript = String::new();
    for path in files {
        transcript.push_str(&std::fs::read_to_string(path).unwrap_or_default());
    }
    transcript
}

/// An RLM child spawned by the task's own delivery reaches the task's
/// artifact through the whole real chain: the worker's child registry
/// stamps the running delivery's identity on the child (the
/// `set_child_delivery_identity` wiring — the identity probe the
/// parent worker installs over its core), the terminal notice carries
/// it as `clientAdmissionId`, the notice turn runs as the delivery's
/// own continuation, and the A2A consumer credits the run. The
/// whole-run artifact then carries the parent's answer AND the notice
/// turn's continuation text. A revert of the wiring's probe (a `None`
/// answer) leaves the notice unstamped: the notice turn credits
/// nothing and the task never settles — the poll below times out on
/// its observable readiness, never a fabricated verdict.
#[test]
fn a2a_an_rlm_childs_notice_turn_reaches_the_task_artifact() {
    let child = A2aChild::spawn_with_child_script(
        &[],
        &rlm_children_parent_script("the children were processed", 0),
        &rlm_child_script("the child finished", 0),
    );
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "delegate the work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let task = loop {
        let get = child.request(
            "POST",
            "/",
            &[],
            Some(&json!({
                "jsonrpc": "2.0",
                "id": 47,
                "method": "GetTask",
                "params": { "id": task_id },
            })),
            Some("1.0"),
        );
        let get = A2aChild::body_json(&get);
        let state = get["result"]["status"]["state"].as_str().unwrap_or("");
        let settled = matches!(
            state,
            "TASK_STATE_COMPLETED" | "TASK_STATE_CANCELED" | "TASK_STATE_FAILED"
        );
        if settled {
            break get;
        }
        assert!(
            state == "TASK_STATE_WORKING" || state == "TASK_STATE_SUBMITTED",
            "the spawned-children task holds its working state, not {state}: {get}"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "the task never settled behind the unstamped children notice: {get}"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        task["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "the notice turn's credit settles the task: {task}"
    );
    let artifact = task["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        artifact.contains("the parent's own answer")
            && artifact.contains("the children were processed"),
        "the artifact carries the parent's answer and the credited notice turn: {artifact:?}"
    );
}

/// The notice turn of an RLM child runs anchored on the task's
/// delivery identity, so a `CancelTask` that lands inside it withdraws
/// the post-children work: the identity-scoped withdrawal aborts the
/// running notice turn and answers the CANCELED verdict at once, and
/// the session stops streaming well inside the held response's script
/// delay — the abort's own observable, because the CANCELED verdict
/// alone cannot witness the stamp (a withdrawal that matched nothing
/// settles the same verdict while the held turn streams on). The
/// readiness is the notice row the worker journals at the turn's
/// pickup (the transcript read), so the cancel lands inside the held
/// notice turn, never before it.
#[test]
fn a2a_a_cancel_withdraws_the_post_children_notice_turn() {
    let child = A2aChild::spawn_with_child_script(
        &[],
        &rlm_children_parent_script("the children were processed", 60_000),
        &rlm_child_script("the child finished", 0),
    );
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "delegate the work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("rlm_child_terminal_notice") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the settled child's terminal notice never reached the parent transcript"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 48,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the cancel withdraws the stamped post-children notice turn: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the withdrawal settles the canceled verdict: {cancel}"
    );
    // The session-side check: the withdrawal aborted the held notice
    // turn, so the context session stops streaming well inside its 60 s
    // script delay. A withdrawal that matched nothing would settle the
    // same CANCELED verdict while the held turn streams to its delay's
    // end — the settle time is the witness the verdict cannot carry.
    let session = {
        let list = daemon_list(&child.socket);
        list["data"]["sessions"]
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row["sessionName"]
                        .as_str()
                        .is_some_and(|name| name.starts_with("a2a-"))
                })
            })
            .and_then(|row| row["activeSessionId"].as_str())
            .expect("the context's session row")
            .to_string()
    };
    let stopped = {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let row = daemon_row(&child.socket, &session);
            if !row["isStreaming"].as_bool().unwrap_or(false) {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(
        stopped,
        "the cancel aborted the held notice turn — the session settled well inside its script delay"
    );
}

/// The children window of a delegating task settles the cancel at
/// once, the main/TS abort contract: a `CancelTask` that lands while
/// the task's spawned RLM child still runs — after the parent's own
/// answer, before any terminal notice queues — answers the CANCELED
/// verdict immediately, and the child RUNS ON (the way a TUI Esc
/// leaves it): its own turn finishes, its terminal
/// notice queues, and the notice turn runs on the parent session —
/// but its text resolves FOREIGN against the settled task and never
/// reaches the canceled task's artifact. No -32002 window waits the
/// children out.
#[test]
fn a2a_a_cancel_during_the_childrens_run_runs_the_child_on() {
    // The child's own turn is held open past the cancel's landing
    // window, and settles shortly after it.
    let child = A2aChild::spawn_with_child_script(
        &[],
        &rlm_children_parent_script("the children were processed", 0),
        &rlm_child_script("the child finished", 5_000),
    );
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "delegate the work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();

    // The readiness is the parent's own answer in the transcript: the
    // parent's turn closed and the task is awaiting its child, whose
    // terminal notice has NOT queued (the held child never settled).
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("the parent's own answer")
            && !transcript.contains("rlm_child_terminal_notice")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the parent's own turn never closed inside the children window"
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 49,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the cancel settles the awaiting task at once: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the children window's cancel settles the canceled verdict immediately: {cancel}"
    );

    // The child runs on: its own turn finishes, its terminal notice
    // queues, and the notice turn runs on the parent session. The
    // observation waits for the notice turn's answer — the text only
    // lands when the turn really ran, so a task that was never
    // canceled or a child that stopped early cannot pass it.
    let run_on_deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("the child finished")
            && transcript.contains("rlm_child_terminal_notice")
            && transcript.contains("the children were processed")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < run_on_deadline,
            "the canceled task's child never ran on to its notice turn: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    // The ran-on child's notice turn resolved FOREIGN: the canceled
    // task keeps its verdict and its artifact never gains the notice
    // turn's text.
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 50,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(
        get["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the canceled task keeps its verdict: {get}"
    );
    let artifact = get["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        artifact.contains("the parent's own answer"),
        "the canceled task keeps its own answer in the artifact: {artifact:?}"
    );
    assert!(
        !artifact.contains("the children were processed"),
        "the ran-on child's notice turn resolved Foreign, never the settled task's artifact: {artifact:?}"
    );
}

/// The spawning turn's own window is cancelable: a `CancelTask` that
/// lands while the task's turn still runs — after that turn spawned an
/// RLM child (the kickoff defers to the turn's end), before the turn
/// closed — takes the admission ladder, and the ladder's accepted abort
/// owns the verdict: the abort can end the engine's tool phase with a
/// success outcome, so the stop the client asked for settles CANCELED,
/// never a COMPLETED the partial artifact would read as. The aborted
/// turn's end releases the spawned child's deferred kickoff, and the
/// child RUNS ON (the main/TS abort contract: the way a TUI Esc
/// leaves it): it runs, its terminal notice queues, and the
/// notice turn runs on the parent session — all AFTER the CANCELED
/// answer, resolving FOREIGN against the settled task, never its
/// artifact.
#[test]
fn a2a_a_cancel_inside_the_spawning_turn_runs_the_child_on() {
    let spawn_cell = "kid = await rlm.spawn(\"run the child task\", name=\"kid\")\nprint(\"SPAWNED\", kid.rlm_child_id)";
    let parent = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Delegating." },
            { "type": "toolCall", "name": "ipython", "arguments": { "code": spawn_cell } },
        ] },
        // The held second response keeps the spawning turn RUNNING: the
        // cancel lands inside the task's own turn, not the children
        // window the test above covers.
        { "text": "the parent's own answer", "delayMs": 60_000 },
        { "text": "the children were processed" },
    ]});
    let child =
        A2aChild::spawn_with_child_script(&[], &parent, &rlm_child_script("the child finished", 0));
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "delegate the work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();

    // The readiness is the spawn cell's own result row in the parent
    // transcript: the child was spawned INSIDE the task's running turn,
    // and the held second response keeps that turn open.
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("SPAWNED sub-") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the spawn cell never ran inside the spawning turn: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 49,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the ladder's accepted abort closes the task: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the accepted abort owns the verdict the success settle raced: {cancel}"
    );

    // The canceled task's child runs on: the aborted spawning turn's
    // end releases the deferred kickoff, the child's own turn finishes,
    // its terminal notice queues, and the notice turn runs on the
    // parent session — all after the CANCELED answer. The observation
    // waits for the notice turn's answer text (it only lands when the
    // turn really ran).
    let run_on_deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("[task from parent]")
            && transcript.contains("the child finished")
            && transcript.contains("the children were processed")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < run_on_deadline,
            "the canceled task's child never ran on to its notice turn: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    // The ran-on work resolved FOREIGN: the canceled task keeps its
    // verdict and its artifact never gains the notice turn's text.
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 50,
            "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(
        get["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the canceled task keeps its verdict: {get}"
    );
    let artifact = get["result"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        !artifact.contains("the children were processed"),
        "the ran-on child's notice turn resolved Foreign, never the settled task's artifact: {artifact:?}"
    );
}

/// A kernel bash completion carries its CREATING delivery's identity
/// (the launch-time pid binding): a foreign daemon client's held bash
/// completes while the A2A task waits out its own RLM child, and the
/// notice turn — the FOREIGN delivery's continuation — never joins the
/// task: its run resolves against the creator's id, not the awaiting
/// head. A revert of the launch binding leaves the notice unstamped
/// (the session-owned class, credited to the head), and the foreign
/// reply lands in the task's artifact — this pin fails there.
#[test]
fn a2a_a_foreign_daemon_clients_bash_notice_never_joins_the_task() {
    let home = tempfile::TempDir::new().unwrap();
    let helper = home.path().join("foreign-held-bash.py");
    let ready = home.path().join("foreign-bash-ready");
    let release = home.path().join("foreign-bash-release");
    std::fs::write(&helper, format!(
        "from pathlib import Path\nimport time\nPath({:?}).write_text('ready')\nwhile not Path({:?}).exists():\n    time.sleep(0.01)\nprint('foreign bash result')\n",
        ready.to_str().unwrap(), release.to_str().unwrap()))
    .expect("the held-bash helper writes");
    let child_script_path = home.path().join("child-script.json");
    std::fs::write(
        &child_script_path,
        rlm_child_script("the child finished", 60_000).to_string(),
    )
    .expect("the child script writes");
    let child_script_arg = child_script_path.to_string_lossy().to_string();
    let bash_code = format!(
        "bash({:?})",
        format!("/usr/bin/python3 {}", helper.display())
    );
    let script = json!({ "engine": "faux", "responses": [
        { "text": "seed reply" },
        { "content": [{ "type": "toolCall", "name": "ipython", "arguments": { "code":
            bash_code } }] },
        { "text": "foreign initial reply" },
        { "content": [{ "type": "toolCall", "name": "ipython", "arguments": { "code":
            "kid = await rlm.spawn('hold this task open', name='kid')" } }] },
        { "text": "own pending answer" },
        { "text": "FOREIGN_BASH_REPLY" },
        { "text": "post-child answer" }
    ]});
    let child = A2aChild::spawn_in_home(
        home,
        &[("PRIME_AGENT_FAUX_CHILD_SCRIPT", child_script_arg.as_str())],
        &[],
        &script,
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    // The seed task creates the conversation's session.
    let seed = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body("seed", None, None, json!({}))),
        Some("1.0"),
    );
    let seed = A2aChild::body_json(&seed);
    assert_eq!(
        seed["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{seed}"
    );
    let context_id = seed["result"]["task"]["contextId"]
        .as_str()
        .unwrap()
        .to_string();
    // The FOREIGN delivery: a plain daemon client's prompt whose turn
    // launches the held bash through the kernel's own tool.
    let session = daemon_live_session(&child.socket);
    let foreign = daemon_command(
        &child.socket,
        &json!({
            "type": "prompt", "activeSessionId": session,
            "message": "foreign client's own background work",
        }),
    );
    assert_eq!(foreign["success"], true, "{foreign}");
    loop {
        if ready.exists()
            && collected_transcript(child.home.path()).contains("foreign initial reply")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the foreign prompt never settled its first reply"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // The A2A task on the shared session: its own turn answers, and it
    // waits out its spawned child (the held child keeps it WORKING).
    let own = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "only my own reply",
            Some(&context_id),
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let own = A2aChild::body_json(&own);
    let task_id = own["result"]["task"]["id"].as_str().unwrap().to_string();
    loop {
        if collected_transcript(child.home.path()).contains("own pending answer") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the own task never reached its completion wait"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Release the foreign bash: its completion notice runs the FOREIGN
    // continuation turn — the transcript observes the reply the
    // SESSION produced.
    std::fs::write(&release, "release").expect("the release writes");
    loop {
        if collected_transcript(child.home.path()).contains("FOREIGN_BASH_REPLY") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the foreign bash's notice turn never ran"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0", "id": 91, "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert!(
        !get["result"]["artifacts"]
            .to_string()
            .contains("FOREIGN_BASH_REPLY"),
        "a foreign daemon client's kernel continuation never joins the task: {get}"
    );
    assert!(
        !get["result"]["history"]
            .to_string()
            .contains("FOREIGN_BASH_REPLY"),
        "the foreign reply joined no history row either: {get}"
    );
    assert_eq!(
        get["result"]["status"]["state"], "TASK_STATE_WORKING",
        "the task keeps waiting out its own child: {get}"
    );
}

/// The task's OWN kernel bash completion is its continuation: the
/// launch-time binding names the task, so the notice turn runs as the
/// task's own work — and an identity-scoped `CancelTask` withdraws it
/// mid-run: the running-turn abort answers the CANCELED verdict at
/// once, and the session stops streaming well inside the held
/// response's script delay — the abort's own observable, because the
/// CANCELED verdict alone cannot witness the binding (a withdrawal
/// that matched nothing settles the same verdict while the held turn
/// streams on).
#[test]
fn a2a_a_cancel_withdraws_the_tasks_kernel_notice_turn() {
    let home = tempfile::TempDir::new().unwrap();
    let helper = home.path().join("held-bash.py");
    let ready = home.path().join("bash-ready");
    let release = home.path().join("bash-release");
    std::fs::write(&helper, format!(
        "from pathlib import Path\nimport time\nPath({:?}).write_text('ready')\nwhile not Path({:?}).exists():\n    time.sleep(0.01)\nprint('bash result')\n",
        ready.to_str().unwrap(), release.to_str().unwrap()))
    .expect("the held-bash helper writes");
    let child_script_path = home.path().join("child-script.json");
    std::fs::write(
        &child_script_path,
        rlm_child_script("the child finished", 60_000).to_string(),
    )
    .expect("the child script writes");
    let child_script_arg = child_script_path.to_string_lossy().to_string();
    let code = format!(
        "kid = await rlm.spawn(\"hold the task open\", name=\"kid\")\nh = bash({:?})\nprint('BASH-LAUNCHED')",
        format!("/usr/bin/python3 {}", helper.display())
    );
    let script = json!({ "engine": "faux", "responses": [
        { "content": [{ "type": "toolCall", "name": "ipython", "arguments": { "code": code } }] },
        { "text": "the initial reply" },
        { "text": "the kernel notice was processed", "delayMs": 60_000 }
    ]});
    let child = A2aChild::spawn_in_home(
        home,
        &[("PRIME_AGENT_FAUX_CHILD_SCRIPT", child_script_arg.as_str())],
        &[],
        &script,
    );
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "do work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"].as_str().unwrap().to_string();
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    // The task's own turn: spawn the child, launch the held bash, and
    // answer. The task then waits out the child (its headless
    // completion barrier).
    loop {
        if ready.exists() && collected_transcript(child.home.path()).contains("the initial reply") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the task's own turn never settled: {}",
            collected_transcript(child.home.path())
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Release the bash: its completion notice runs the task's own
    // continuation turn (the held scripted response keeps the notice
    // turn open).
    std::fs::write(&release, "release").expect("the release writes");
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("bash_completion") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no kernel completion notice landed: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let before = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0", "id": 92, "method": "GetTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let before = A2aChild::body_json(&before);
    assert_eq!(
        before["result"]["status"]["state"], "TASK_STATE_WORKING",
        "the task still owns its notice turn: {before}"
    );
    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0", "id": 93, "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert!(
        cancel.get("error").is_none(),
        "the cancel withdraws the task's own kernel notice turn: {cancel}"
    );
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the withdrawal settles the canceled verdict: {cancel}"
    );
    // The session-side check: the withdrawal aborted the task's held
    // notice turn, so the context session stops streaming well inside
    // its 60 s script delay (the spawned child's own held turn keeps
    // streaming — it runs on). A withdrawal that matched nothing would
    // settle the same CANCELED verdict while the held notice turn
    // streams to its delay's end — the settle time is the witness the
    // verdict cannot carry.
    let session = {
        let list = daemon_list(&child.socket);
        list["data"]["sessions"]
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row["sessionName"]
                        .as_str()
                        .is_some_and(|name| name.starts_with("a2a-"))
                })
            })
            .and_then(|row| row["activeSessionId"].as_str())
            .expect("the context's session row")
            .to_string()
    };
    let stopped = {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let row = daemon_row(&child.socket, &session);
            if !row["isStreaming"].as_bool().unwrap_or(false) {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(
        stopped,
        "the cancel aborted the task's held notice turn — the context session settled well inside its script delay"
    );
}

/// The canceled task's goal loop retires with the withdrawal: a
/// `/goal` prompt whose turn spawned an RLM child leaves its next
/// continuation OWED behind the unsettled child (the loop the task's
/// prompt started is the task's own work — the run-on contract keeps
/// only the delegated child running). Without the withdrawal's loop
/// stop, the children's settle hook would mint the owed continuation
/// one turn after another on the session long after the CANCELED
/// answer — every mint landing a `[goal: continuation]` row on the
/// session file, and every later send on the conversation waiting the
/// loop out. The withdrawal pauses the goal and drops the owed mint:
/// the child runs on (its notice turn resolves foreign), no
/// continuation row lands after the cancel, and the context's next
/// blocking send answers with its own turn's artifact — the first
/// script response after the notice turn, never one a phantom loop
/// would have spent first.
#[test]
fn a2a_a_cancel_in_the_children_window_retires_the_goal_loop() {
    // The goal turn spawns the child and answers; the child's terminal
    // notice takes the next response; the delayed later responses
    // would feed a phantom loop's turns — with the loop retired, the
    // next send's own turn takes the first of them.
    let spawn_cell = "handle = await rlm.spawn(\"run the child task\", name=\"kid\")\nprint(\"SPAWNED\", handle.rlm_child_id)";
    let parent = json!({ "engine": "faux", "responses": [
        { "content": [
            { "type": "text", "text": "Delegating." },
            { "type": "toolCall", "name": "ipython", "arguments": { "code": spawn_cell } },
        ] },
        "the parent's own answer",
        "the children were processed",
        { "text": "the fourth response", "delayMs": 3000 },
        { "text": "the fifth response", "delayMs": 3000 },
        { "text": "the sixth response", "delayMs": 3000 },
    ]});
    let child = A2aChild::spawn_with_child_script(
        &[],
        &parent,
        &rlm_child_script("the child finished", 5_000),
    );
    let send = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "/goal finish the delegated work",
            None,
            None,
            json!({ "returnImmediately": true }),
        )),
        Some("1.0"),
    );
    let send = A2aChild::body_json(&send);
    let task_id = send["result"]["task"]["id"]
        .as_str()
        .expect("the acknowledged task")
        .to_string();
    let context_id = send["result"]["task"]["contextId"]
        .as_str()
        .expect("the context")
        .to_string();

    // The children window: the goal turn closed with its own answer,
    // the spawned child still holds, nothing noticed yet. The goal
    // turn's own context row is the baseline a phantom loop's minted
    // continuations would add to.
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("the parent's own answer")
            && !transcript.contains("rlm_child_terminal_notice")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the goal turn never reached the children window: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let goal_context_rows = collected_transcript(child.home.path())
        .matches(r#""customType":"goal_context""#)
        .count();
    assert!(
        goal_context_rows >= 1,
        "the goal prompt's own turn wrote its context row"
    );

    let cancel = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 66,
            "method": "CancelTask",
            "params": { "id": task_id },
        })),
        Some("1.0"),
    );
    let cancel = A2aChild::body_json(&cancel);
    assert_eq!(
        cancel["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "the children window's cancel settles at once: {cancel}"
    );

    // The child runs on: its terminal notice queues and the notice
    // turn runs on the parent session, resolving foreign to the
    // settled task (the run-on contract).
    let run_on_deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let transcript = collected_transcript(child.home.path());
        if transcript.contains("rlm_child_terminal_notice")
            && transcript.contains("the children were processed")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < run_on_deadline,
            "the child's notice turn never ran on: {transcript}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }

    // The next blocking send on the context: its own turn must be the
    // first turn after the notice turn — a phantom goal loop would
    // have spent the delayed responses one by one while the send
    // waited the loop out.
    let next = child.request(
        "POST",
        "/",
        &[],
        Some(&send_body(
            "the next question",
            Some(&context_id),
            None,
            json!({}),
        )),
        Some("1.0"),
    );
    let next = A2aChild::body_json(&next);
    assert_eq!(
        next["result"]["task"]["status"]["state"],
        "TASK_STATE_COMPLETED",
        "the next send answers on the conversation: {next}\nsession: {}",
        collected_transcript(child.home.path())
    );
    let artifact = next["result"]["task"]["artifacts"][0]["parts"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(
        artifact, "the fourth response",
        "the next send's own turn answered, never a phantom loop's: {artifact:?}"
    );

    // The session file carries no minted continuation row: the loop
    // retired with the withdrawal's pause, and every turn after the
    // cancel was the notice turn and the next send's own — the
    // goal-context row count the cancel found is the count the
    // settled conversation keeps.
    let transcript = collected_transcript(child.home.path());
    assert_eq!(
        transcript.matches(r#""customType":"goal_context""#).count(),
        goal_context_rows,
        "the canceled task's goal loop spent no continuation turn: {transcript}"
    );
}

/// The A2A mode's adoption telemetry survives a try-out run: the
/// served-request event tracks fire-and-forget through the delivery
/// worker, and the mode's exit drains the queued events under the
/// shared exit bound — a run that serves one request and quits inside
/// the delivery window still reports it — with the base attribution
/// every event carries (the schema version and the execution mode, so
/// the event maps to a release and a mode, never unattributed
/// traffic). The event name + properties joined the versioned schema
/// with the mode itself.
#[test]
fn the_a2a_adoption_event_survives_a_quick_exit_attributed() {
    // The child carries the telemetry opt-in: the cargo test config's
    // DO_NOT_TRACK never reaches the spawned tree.
    let mut child = A2aChild::spawn_with_env(&[("DO_NOT_TRACK", "0")], &[], &plain_script());
    let get = child.request(
        "POST",
        "/",
        &[],
        Some(&json!({
            "jsonrpc": "2.0",
            "id": 71,
            "method": "GetTask",
            "params": { "id": "unknown" },
        })),
        Some("1.0"),
    );
    let get = A2aChild::body_json(&get);
    assert_eq!(
        get["error"]["code"], -32001,
        "the probe request served: {get}"
    );
    // The interrupt exit at once: the queued adoption event must still
    // reach the local mirror (the mode's exit drain, never the
    // delivery window the short run never reaches).
    let _ = std::process::Command::new("kill")
        .arg("-INT")
        .arg(child.child.id().to_string())
        .status()
        .expect("kill runs");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.child.try_wait().expect("the child's wait answers") {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the SIGINT did not end the mode within the bound"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "the mode exited gracefully on SIGINT: {status:?}"
    );
    let mirror = std::fs::read_to_string(child.home.path().join(".prime/agent/telemetry.jsonl"))
        .unwrap_or_default();
    let served: Vec<Value> = mirror
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["name"] == "a2a request served")
        .collect();
    assert!(
        !served.is_empty(),
        "the quick-exit run still delivered the served-request event: {mirror}"
    );
    let properties = &served[0]["properties"];
    assert!(
        properties["schema_version"].is_number(),
        "the served-request event carries the schema's base attribution: {served:?}"
    );
    assert_eq!(
        properties["execution_mode"], "a2a",
        "the served-request event names its execution mode: {served:?}"
    );
    assert_eq!(
        properties["method"], "GetTask",
        "the served-request event names the served method: {served:?}"
    );
}

/// The protocol gates report the served requests they refuse: the
/// content-type gate (-32005) and the version gate (-32009) both
/// answer a parsed request, and the adoption event counts each refusal
/// with outcome `error` — the same served-request record every
/// dispatched method reports. A refused first contact is the adoption
/// signal a silent drop would hide.
#[test]
fn the_protocol_gates_report_the_served_request_event() {
    let mut child = A2aChild::spawn_with_env(&[("DO_NOT_TRACK", "0")], &[], &plain_script());
    let get = json!({
        "jsonrpc": "2.0",
        "id": 72,
        "method": "GetTask",
        "params": { "id": "unknown" },
    });
    let refused_type = child.request(
        "POST",
        "/",
        &[("Content-Type", "text/plain;charset=UTF-8")],
        Some(&get),
        Some("1.0"),
    );
    let refused_type = A2aChild::body_json(&refused_type);
    assert_eq!(
        refused_type["error"]["code"], -32005,
        "the content-type gate answers the parsed request: {refused_type}"
    );
    let refused_version = child.request("POST", "/", &[], Some(&get), None);
    let refused_version = A2aChild::body_json(&refused_version);
    assert_eq!(
        refused_version["error"]["code"], -32009,
        "the version gate answers the parsed request: {refused_version}"
    );
    let _ = std::process::Command::new("kill")
        .arg("-INT")
        .arg(child.child.id().to_string())
        .status()
        .expect("kill runs");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.child.try_wait().expect("the child's wait answers") {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the SIGINT did not end the mode within the bound"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "the mode exited gracefully on SIGINT: {status:?}"
    );
    let mirror = std::fs::read_to_string(child.home.path().join(".prime/agent/telemetry.jsonl"))
        .unwrap_or_default();
    let served: Vec<Value> = mirror
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["name"] == "a2a request served")
        .collect();
    assert_eq!(
        served.len(),
        2,
        "both gate-refused requests reported their served-request event: {mirror}"
    );
    for event in &served {
        assert_eq!(event["properties"]["method"], "GetTask", "{event}");
        assert_eq!(event["properties"]["outcome"], "error", "{event}");
    }
}

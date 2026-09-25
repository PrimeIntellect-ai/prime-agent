//! End-to-end verifier for the `/mcp` service catalog view: a
//! settings-declared stdio MCP server (the committed echo fixture) must
//! appear in the daemon's `get_mcp_connections` roster and in the
//! resolved service cards, answered from local state (no kernel
//! round-trip, so the view opens instantly), and the headless TUI
//! driving `/mcp` must render the inline view — the connected card with
//! its status, one fixed detail line, the key hint — while the
//! login/logout argument arms keep their notes.
#![cfg(unix)]

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};

/// The committed stdio echo fixture (pure stdlib; any Python 3 runs it).
fn echo_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pa-daemon/tests/fixtures/mcp_echo_server.py")
        .canonicalize()
        .expect("echo fixture")
}

/// The scripted-engine config: the `{"engine": "faux"}` script drives the
/// real agent engine over the scripted faux provider (no ambient
/// credentials, no network), so the session owns a real MCP manager and
/// kernel like a product session.
fn scripted_engine(dir: &Path) -> PathBuf {
    let script = dir.join("script.json");
    std::fs::write(
        &script,
        json!({ "engine": "faux", "responses": [] }).to_string(),
    )
    .expect("write script");
    script
}

/// The held-turn script: the one scripted response paces its stream closed
/// (`delayMs`) well past the probe window, so the turn it drives holds the
/// session slot across its provider wait exactly like a real running turn.
fn held_engine(dir: &Path) -> PathBuf {
    let script = dir.join("script.json");
    std::fs::write(
        &script,
        json!({ "engine": "faux", "responses": [
            { "text": "a slow scripted turn", "delayMs": 20_000 },
        ] })
        .to_string(),
    )
    .expect("write script");
    script
}

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        let worker_pids = child_pids_of(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        for pid in worker_pids {
            kill_worker(&pid);
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn kill_worker(pid: &u32) {
    unsafe {
        libc::kill(*pid as i32, libc::SIGKILL);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_alive(*pid) {
        assert!(
            Instant::now() < deadline,
            "worker {pid} survived the teardown kill"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn child_pids_of(ppid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    let entries = std::fs::read_dir("/proc").expect("read /proc");
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        fields.next();
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

fn process_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, rest)) = stat.rsplit_once(')') else {
        return false;
    };
    let state = rest.split_whitespace().next().unwrap_or_default();
    !state.starts_with('Z') && !state.starts_with('X')
}

fn graceful_shutdown(socket: &Path) {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixStream;

    let Ok(stream) = UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello);
    let command = json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let mut line = serde_json::to_string(&command).expect("serialize");
    line.push('\n');
    if writer.write_all(line.as_bytes()).is_err() {
        return;
    }
    let _ = writer.flush();
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
}

/// Spawn the real supervisor binary over a hermetic agent dir whose
/// settings declare the fixture echo server, a hermetic kernel venv, and
/// no ambient provider credentials.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "mcpServers": {
                "fixture-echo": {
                    "type": "stdio",
                    "command": "python3",
                    "args": [echo_fixture().display().to_string()],
                }
            }
        })
        .to_string(),
    )
    .expect("write settings");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("PRIME_AGENT_KERNEL_VENV", dir.join("kernel-venv"))
        .env("PI_OFFLINE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
    ] {
        command.env_remove(var);
    }
    for provider in pa_ai::models_generated::get_providers() {
        if let Some(vars) = pa_ai::env_api_keys::get_api_key_env_vars(provider) {
            for var in vars {
                command.env_remove(var);
            }
        }
    }
    command.env_remove("PRIME_TEAM_ID");
    command.env_remove("PRIME_API_KEY");
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// The interactive options the headless run attaches with (the same shape
/// the other TUI e2e verifiers use; `client_auth` stays `None` so the
/// login/logout argument arms answer through the same client path).
fn headless_options(socket: &Path, dir: &Path) -> pa_tui::interactive::InteractiveOptions {
    pa_tui::interactive::InteractiveOptions {
        socket_path: socket.to_path_buf(),
        cwd: dir.to_path_buf(),
        session_dir: Some(dir.join("agent").join("sessions")),
        script_path: Some(scripted_engine(dir)),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
        show_images: true,
        client_settings: None,
        fullscreen_mouse: true,
        initial_message: None,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
    }
}

/// The empty `PromptInput` (the same explicit shape the interactive
/// daemon e2e uses; the struct carries no `Default`).
fn empty_prompt_input() -> pa_types::daemon::PromptInput {
    pa_types::daemon::PromptInput {
        content: None,
        images: None,
        streaming_behavior: None,
        queue_if_busy: None,
        expand_prompt_templates: None,
        source: None,
        agent_message_id: None,
        custom_message: None,
        queue_key: None,
        prefix_messages: None,
        admission_id: None,
    }
}

/// Create a live session through the daemon protocol, returning its id.
async fn create_session(socket: &Path, dir: &Path) -> String {
    create_session_with(socket, dir, &scripted_engine(dir)).await
}

/// Create a live session driven by the given script (the empty-response
/// default or the held-turn variant).
async fn create_session_with(socket: &Path, dir: &Path, script: &Path) -> String {
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect supervisor");
    let data = client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: None,
            config: Some(json!({
                "cwd": dir.display().to_string(),
                "sessionDir": dir.join("agent").join("sessions").display().to_string(),
                "script": script.display().to_string(),
            })),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: serde_json::Map::default(),
        })
        .await
        .expect("create session");
    client.close();
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .expect("session id")
        .to_string()
}

/// The daemon seam: `get_mcp_connections` answers from local state —
/// the roster and the resolved service catalog, never a kernel
/// round-trip — so the FIRST request after create returns within the
/// interactive deadline (the old handler waited out the session build
/// and then listed each connected server's tools, freezing `/mcp` for
/// seconds). Assert the fast answer's shape: the connected fixture
/// roster row (no live tool listing), its service card, and the
/// disconnected built-ins.
async fn assert_roster_answers_fast(socket: &Path, dir: &Path) {
    let session = create_session(socket, dir).await;
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect supervisor");
    // The worker's created flag commits before the create response, but
    // a fresh supervisor can still be settling: retry within the
    // overall deadline, and every single request must answer fast.
    let deadline = Instant::now() + Duration::from_mins(2);
    let mut last_error = String::new();
    let data = loop {
        assert!(
            Instant::now() < deadline,
            "get_mcp_connections never answered; last error: {last_error}"
        );
        let request_started = Instant::now();
        let request = client
            .request_ok(DaemonCommand::GetMcpConnections {
                id: None,
                active_session_id: session.clone(),
                rest: serde_json::Map::default(),
            })
            .await;
        let elapsed = request_started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "get_mcp_connections took {elapsed:?}: the view open must be instant"
        );
        match request {
            Err(error) => {
                last_error = format!("{error:#}");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Ok(data) => break data,
        }
    };
    client.close();
    let connections = data
        .get("connections")
        .and_then(Value::as_array)
        .expect("connections array");
    let fixture = connections
        .iter()
        .find(|entry| entry.get("server").and_then(Value::as_str) == Some("fixture-echo"))
        .expect("fixture-echo entry");
    assert_eq!(fixture.get("connected"), Some(&json!(true)));
    assert_eq!(fixture.get("authKind"), Some(&json!("stdio")));
    // No live tool listing rides the roster (the picker opens from local
    // state; the kernel stays untouched).
    assert_eq!(fixture.get("tools"), None, "no tools overlay: {fixture}");
    assert_eq!(fixture.get("error"), None, "no error overlay: {fixture}");
    // The disconnected built-ins keep their roster rows.
    let linear = connections
        .iter()
        .find(|entry| entry.get("server").and_then(Value::as_str) == Some("linear"))
        .expect("linear entry");
    assert_eq!(linear.get("connected"), Some(&json!(false)));
    assert_eq!(linear.get("authKind"), Some(&json!("subscription")));
    // The service cards: the fixture's user-declared stdio card is
    // connected-first with its account id (TS `buildPluginViews` rank).
    let services = data
        .get("services")
        .and_then(Value::as_array)
        .expect("services array");
    let fixture_card = services
        .iter()
        .find(|service| service.get("serviceId").and_then(Value::as_str) == Some("fixture-echo"))
        .expect("fixture-echo card");
    assert_eq!(
        fixture_card.get("connectionStatus"),
        Some(&json!("connected")),
        "the user stdio card: {fixture_card}"
    );
    assert_eq!(fixture_card.get("source"), Some(&json!("user")));
    assert_eq!(
        fixture_card.get("connectionIds"),
        Some(&json!(["fixture-echo"])),
        "the account id joins the card: {fixture_card}"
    );
    assert_eq!(
        services[0].get("serviceId"),
        Some(&json!("fixture-echo")),
        "connected cards lead (TS rank): {services:?}"
    );
}

/// The TUI surface: the headless client opens `/mcp`, the inline view
/// renders the service catalog — the connected fixture card with its
/// status flush right, ONE fixed detail line, the hint — Esc closes it,
/// Enter dispatches the selected card's login command, and the argument
/// arms keep their notes.
#[tokio::test]
async fn mcp_view_lists_the_configured_mock_connection() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    std::fs::create_dir_all(dir.path().join("agent").join("sessions")).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // Part A: the daemon seam answers from local state, instantly.
    assert_roster_answers_fast(&supervisor.socket, dir.path()).await;

    // Part B: the rendered surface. Escape closes; a second open plus
    // Enter resolves to the fixture's login command (this client wires no
    // auth hook, so the command lands in the not-available note — the
    // login/logout arms still route through the client seam); the
    // argument-only invocations keep their notes.
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/mcp".to_string()),
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Esc,
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::Submit("/mcp".to_string()),
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::Submit("/mcp logout fixture-echo".to_string()),
        ],
        width: 110,
        height: 30,
    };
    let options = headless_options(&supervisor.socket, dir.path());
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    assert!(!outcome.frames.is_empty(), "frames were captured");
    let rendered = outcome.frames.join("\n");

    // The inline view: the bordered search field, the connected fixture
    // card with its status flush right, ONE fixed detail line, the hint.
    assert!(
        rendered.contains("Search MCP connections"),
        "search field rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("fixture-echo"),
        "connection row rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Connected"),
        "status rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Enter manage accounts \u{b7} Esc close"),
        "key hint rendered:\n{rendered}"
    );
    // The live tool listing is gone: the picker opens from local state,
    // and no kernel ever boots for the view.
    assert!(
        !rendered.contains("Echoes the message argument back."),
        "no live tool detail: {rendered}"
    );
    // Esc closed the view: a frame after the last open one shows the
    // editor dock again (no search field).
    let last_open = outcome
        .frames
        .iter()
        .rposition(|frame| frame.contains("Search MCP connections"))
        .expect("the view rendered");
    assert!(
        outcome.frames[last_open + 1..]
            .iter()
            .any(|frame| !frame.contains("Search MCP connections")),
        "the view closed on Esc:\n{rendered}"
    );
    // Enter dispatched the selected connection's login command, and the
    // logout argument arm kept its routing: without a client auth hook
    // both land in the not-available note (the same client seam the
    // client_auth unit tests cover for the wired wording).
    assert!(
        rendered.contains("/mcp is not available in this client yet"),
        "Enter dispatched the login and the logout arm stayed routed:\n{rendered}"
    );
}

/// The mid-turn open (the operator's freeze): a running turn holds the
/// session slot across its provider wait, and the old daemon handler
/// waited out the whole session-build window before answering the roster
/// alone, so `/mcp`/`/plugins` opened mid-turn froze the view for the
/// bound (the `SESSION_BUILD_WAIT` seconds the freeze reported). The TS
/// picker builds its rows from local state, so the mid-turn open is
/// instant: the held-turn probe must answer within the interactive
/// deadline.
#[tokio::test]
async fn get_mcp_connections_answers_instantly_mid_turn() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    std::fs::create_dir_all(dir.path().join("agent").join("sessions")).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = held_engine(dir.path());
    let session = create_session_with(&supervisor.socket, dir.path(), &script).await;
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect supervisor");
    client
        .request_ok(DaemonCommand::Prompt {
            id: None,
            active_session_id: session.clone(),
            message: "hold this turn open".to_string(),
            input: empty_prompt_input(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("start the held turn");
    // The held turn's admission settles before the probe: the scripted
    // response keeps the stream closed for the whole assertion window, so
    // the session slot stays held across the provider wait.
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let started = Instant::now();
    let data = client
        .request_ok(DaemonCommand::GetMcpConnections {
            id: None,
            active_session_id: session.clone(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("mid-turn get_mcp_connections");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "mid-turn get_mcp_connections took {elapsed:?}: the catalog open must be instant (the TS picker reads local state; the old handler waited out the session-build bound and froze the open mid-turn)"
    );
    // The roster itself answered with the connected fixture (local state,
    // not a kernel listing).
    let connections = data
        .get("connections")
        .and_then(Value::as_array)
        .expect("connections array");
    assert!(
        connections.iter().any(|entry| {
            entry.get("server").and_then(Value::as_str) == Some("fixture-echo")
                && entry.get("connected") == Some(&json!(true))
        }),
        "the roster answered mid-turn: {connections:?}"
    );
    client.close();
}

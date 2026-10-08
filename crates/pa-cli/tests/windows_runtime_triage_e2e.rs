// large_futures: stack futures on hot paths by design. too_many_lines:
// style gate only.
#![allow(clippy::large_futures, clippy::too_many_lines)]

//! The Windows runtime triage battery (the operator's 2026-10-08 ask: "we
//! need to give you an easy way to test things"): three scripted TUI
//! scenarios that boot the freshly-built binary against a real daemon and
//! assert the Windows-reported breakages stay fixed. The workflow
//! `.github/workflows/windows-runtime-triage.yml` runs this battery on
//! windows-2022 for Windows-touched PRs and nightly on main, and uploads
//! the captured pane dumps (`WINDOWS_RUNTIME_TRIAGE_DUMP_DIR`) as run
//! artifacts the fleet can read.
//!
//! The scenarios map one-to-one onto the operator's report:
//!   (1) `tui_reopen_renders_the_old_history` - reopening an old session
//!       showed none of the old messages: the battery writes real turns,
//!       stops the daemon (the cold-reopen path - the session is no longer
//!       live), starts a fresh one, reopens the stored file, and asserts
//!       the rendered frames contain BOTH old user messages and BOTH old
//!       replies.
//!   (2) `subagent_session_stays_a_distinct_store_entry` - all sessions
//!       and their subagents appeared grouped into one session: the
//!       battery creates a parent session and a REAL child (the daemon
//!       create carrying `parentSessionPath`/`rlmDepth` - the same
//!       durable create a `rlm.spawn` issues) and asserts the two store
//!       entries are distinct files with distinct header ids, the child's
//!       header names the parent, and the agents view nests the child
//!       under the parent as its own row.
//!   (3) `agent_message_rows_dump_their_glyphs` - lots of broken icons:
//!       the battery captures the headless pane text of the
//!       agent-message rows, asserts the rows and the agents view's
//!       glyph-bearing summary rows render into the frames, and writes
//!       the dumps to `WINDOWS_RUNTIME_TRIAGE_DUMP_DIR` when set (the
//!       workflow artifact the fleet downloads and inspects).
//!
//! The harness is PORTABLE by design: the same battery runs in the linux
//! CI shards (so every lane gates it) and on the windows-2022 runner (the
//! Windows surface). The daemon endpoint is a Unix socket on unix hosts
//! and a named pipe on Windows (`--daemon-socket` carries the pipe name);
//! everything else - the scripted engine, the headless TUI driver, the
//! store reads - is platform-neutral product code.

#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::interactive::{
    HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};
use serde_json::{json, Map, Value};

/// The daemon supervisor spawned as the freshly-built binary
/// (`CARGO_BIN_EXE_prime-agent --mode daemon`).
struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        stop_supervisor(self);
    }
}

/// Stop the daemon by protocol (the product's own graceful path), then
/// hard-kill the child. The portable form: the daemon client rides the
/// platform transport (named pipe on Windows, Unix socket elsewhere), so
/// the shutdown works on every host.
fn stop_supervisor(supervisor: &mut Supervisor) {
    let socket = supervisor.socket.clone();
    // The shutdown rides its own thread: `Drop` can run inside the async
    // test's runtime, where `block_on` would be a nested runtime.
    let shutdown = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("shutdown runtime");
        runtime.block_on(async move {
            let Ok((client, events)) = pa_tui::daemon_client::DaemonClient::connect(&socket).await
            else {
                return;
            };
            let shutdown = pa_types::daemon::DaemonCommand::Shutdown {
                id: None,
                force: Some(true),
                rest: Map::default(),
            };
            let _ = client.request_with_timeout(shutdown, 1_500).await;
            client.close();
            drop(events);
        });
    });
    let _ = shutdown.join();
    let _ = supervisor.child.kill();
    let _ = supervisor.child.wait();
}

/// The daemon endpoint for this test run: a Unix socket file under the
/// test dir on unix hosts, a uniquely named pipe on Windows (pipe names
/// are host-global, so a unique suffix keeps parallel test binaries from
/// colliding).
fn daemon_endpoint(dir: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        dir.join("daemon.sock")
    }
    #[cfg(not(unix))]
    {
        // Pipe names are host-global, so the unique suffix keeps parallel
        // test binaries from colliding (the temp dir does not appear in
        // the name).
        let _ = dir;
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|stamp| stamp.as_nanos())
            .unwrap_or_default();
        PathBuf::from(format!(
            r"\\.\pipe\prime-agent-triage-{}-{unique}",
            std::process::id()
        ))
    }
}

/// Spawn the freshly-built binary as a daemon supervisor.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = daemon_endpoint(dir);
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        // The daemon's startup catalog refresh must never reach the network
        // from a test: PI_OFFLINE keeps it on the bundled snapshot.
        .env("PI_OFFLINE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // The launcher strips inherited worker role env vars before spawning
    // the supervisor; a CLI running inside a daemon worker must not leak
    // them.
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
    // Ambient provider credentials must not leak into the daemon's
    // catalog: every spawned supervisor here serves models.json fixtures
    // only.
    for provider in pa_ai::models_generated::get_providers() {
        if let Some(vars) = pa_ai::env_api_keys::get_api_key_env_vars(provider) {
            for var in vars {
                command.env_remove(var);
            }
        }
    }
    command.env_remove("PRIME_TEAM_ID");
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    command.env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "90000");
    // Die with this test binary on unix (the protocol teardown below is
    // the exit path; this is the backstop for a failing test).
    #[cfg(unix)]
    unsafe {
        command.pre_exec(move || {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    Supervisor { child, socket }
}

/// Wait until the session's runtime lease is free (no live owner), the
/// bounded cold-reopen drain: a killed supervisor's workers exit on their
/// supervisor-lost watchdog, never instantly.
fn drain_session_lease(agent_dir: &Path, session_path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if pa_daemon::lease::live_lease_owner(agent_dir, session_path).is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    panic!("the killed daemon's worker still held the session lease past the drain bound");
}

/// Wait until the supervisor answers a client connect (the readiness
/// probe - a named pipe has no socket file to poll for).
async fn wait_for_daemon(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if let Ok((client, events)) = pa_tui::daemon_client::DaemonClient::connect(socket).await {
            client.close();
            drop(events);
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the supervisor never answered a client connect");
}

/// The base options every TUI run in this battery uses: the scripted
/// engine, the isolated session dir, no networked model, no onboarding.
fn tui_options(socket: &Path, session_dir: &Path, script: &Path) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket.to_path_buf(),
        cwd: session_dir.to_path_buf(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        session_dir: Some(session_dir.to_path_buf()),
        script_path: Some(script.to_path_buf()),
        model_selection: ModelSelection::default(),
        no_session: false,
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: true,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: Some(true),
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
        prompt_stash: std::sync::Arc::default(),
    }
}

/// The headless run's wall (the unix harness's bound): a turn that never
/// settles parks the run forever; the wall makes that a failing test.
const HEADLESS_RUN_BOUND: Duration = Duration::from_secs(180);

async fn run_headless_bounded(
    options: InteractiveOptions,
    plan: HeadlessPlan,
) -> pa_tui::interactive::InteractiveOutcome {
    match tokio::time::timeout(
        HEADLESS_RUN_BOUND,
        pa_tui::interactive::run_interactive(options, UiMode::Headless(plan)),
    )
    .await
    {
        Ok(outcome) => outcome.expect("interactive run"),
        Err(tokio::time::error::Elapsed { .. }) => {
            panic!("the headless run exceeded {HEADLESS_RUN_BOUND:?}: the wedge class - a turn never settled")
        }
    }
}

/// Write one scenario's captured panes to the workflow dump dir when the
/// workflow set it (the artifact the fleet downloads); a no-op with a
/// logged reason otherwise (the linux CI shards run without it).
fn dump_frames(scenario: &str, frames: &[String]) {
    let Ok(dir) = std::env::var("WINDOWS_RUNTIME_TRIAGE_DUMP_DIR") else {
        eprintln!("{scenario}: WINDOWS_RUNTIME_TRIAGE_DUMP_DIR unset - no pane dump written");
        return;
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create the dump dir");
    for (index, frame) in frames.iter().enumerate() {
        let path = dir.join(format!("{scenario}-frame-{index:03}.txt"));
        std::fs::write(path, frame).expect("write the pane dump");
    }
    let joined = dir.join(format!("{scenario}-frames.txt"));
    std::fs::write(joined, frames.join("\n")).expect("write the joined pane dump");
}

/// The daemon-protocol session create the battery uses: the scripted
/// engine's responses ride the script file; a parent path + depth make
/// the session a real subagent (the same durable create a `rlm.spawn`
/// issues).
#[allow(clippy::too_many_arguments)]
async fn create_session_via_daemon(
    socket: &Path,
    script_path: &Path,
    script: &Value,
    cwd: &Path,
    session_dir: &Path,
    name: Option<&str>,
    parent_session_path: Option<&Path>,
    rlm_depth: Option<u64>,
) -> String {
    std::fs::write(script_path, script.to_string()).expect("write script");
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect supervisor");
    let mut config = json!({
        "cwd": cwd.display().to_string(),
        "sessionDir": session_dir.display().to_string(),
        "script": script_path.display().to_string(),
        "telemetryDisabled": true,
    });
    if let Some(parent) = parent_session_path {
        config["parentSessionPath"] = json!(parent.display().to_string());
        config["rlmDepth"] = json!(rlm_depth.unwrap_or(1));
    }
    let data = client
        .request_ok(pa_types::daemon::DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: name.map(str::to_string),
            config: Some(config),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        })
        .await
        .expect("create session");
    client.close();
    // The DURABLE identity: `sessionId` is the session file's header id
    // (`activeSessionId` is the live worker's ephemeral id - the worker's
    // lifecycle rows publish both).
    data.get("sessionId")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .expect("session id")
        .to_string()
}

/// Every session file under `session_dir` with a readable header.
fn session_files(session_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(session_dir)
        .expect("session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
    files.sort();
    files
}

/// The single session file under `session_dir` (each scenario starts with
/// an empty store), with its header id.
fn the_session_file(session_dir: &Path) -> (PathBuf, String) {
    let files = session_files(session_dir);
    assert_eq!(files.len(), 1, "exactly one session file: {files:?}");
    let path = files[0].clone();
    let header = pa_daemon::session_store::read_session_header(&path)
        .expect("the session file carries a readable header");
    (path, header.id)
}

/// Scenario (1): reopening an old session renders its old messages. The
/// first run writes real turns; the daemon is stopped (the cold-reopen
/// path - no live worker holds the history); a fresh daemon boots against
/// the same store; the reopened session must render the OLD messages.
#[tokio::test]
async fn tui_reopen_renders_the_old_history() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let script_path = dir.path().join("reopen-script.json");

    // Run 1: a fresh session with two scripted turns.
    std::fs::write(
        &script_path,
        json!({ "responses": [
            { "text": "the reopen battery reply one" },
            { "text": "the reopen battery reply two" },
        ]})
        .to_string(),
    )
    .expect("write script");
    let mut supervisor = spawn_supervisor(dir.path());
    wait_for_daemon(&supervisor.socket).await;
    let mut options = tui_options(&supervisor.socket, &session_dir, &script_path);
    options.cwd = dir.path().to_path_buf();
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::Submit("the reopen battery question".to_string()),
            HeadlessStep::WaitIdle { timeout_ms: 60_000 },
            HeadlessStep::Submit("the reopen battery follow up".to_string()),
            HeadlessStep::WaitIdle { timeout_ms: 60_000 },
        ],
        width: 100,
        height: 30,
    };
    let first = run_headless_bounded(options, plan).await;
    assert!(!first.frames.is_empty(), "the first run captured frames");
    let rendered = first.frames.join("\n");
    assert!(
        rendered.contains("the reopen battery reply one"),
        "the first scripted turn rendered:\n{rendered}"
    );
    drop(first);

    // The store persisted the turns before the daemon goes away.
    let (session_path, session_id) = the_session_file(&session_dir);
    assert!(
        std::fs::read(&session_path)
            .expect("the session file persisted")
            .len()
            > 100,
        "the session file holds the turns"
    );

    // The cold reopen: the daemon (and its live worker) are gone; a fresh
    // supervisor boots against the same store.
    stop_supervisor(&mut supervisor);
    // The killed supervisor's session workers can outlive it (unix's
    // PDEATHSIG kills only the supervisor's own child; Windows has no
    // equivalent - the worker exits on its supervisor-lost watchdog),
    // and a lingering worker holds the session's runtime lease: a
    // reopen before it exits answers the session-hold refusal, not the
    // stored history. Drain the lease first (the first windows-runner
    // run of this battery caught exactly this class: the reopen came
    // back with an empty session id).
    drain_session_lease(&agent_dir, &session_path);
    let second_supervisor = spawn_supervisor(dir.path());
    wait_for_daemon(&second_supervisor.socket).await;

    // Run 2: the stored session reopens and renders the OLD messages.
    let mut options = tui_options(&second_supervisor.socket, &session_dir, &script_path);
    options.cwd = dir.path().to_path_buf();
    options.session = SessionSelection::Resume(session_path.clone());
    let plan = HeadlessPlan {
        steps: vec![HeadlessStep::WaitRender {
            needle: "the reopen battery reply one".to_string(),
            timeout_ms: 60_000,
        }],
        width: 100,
        height: 30,
    };
    let reopened = run_headless_bounded(options, plan).await;
    // The panes dump BEFORE the asserts: a red run uploads its evidence
    // (the workflow's red-runs-too contract). The durable identity is
    // asserted below - the triage loop reads the ids from the failure
    // message itself, never from a log row.
    dump_frames("reopen-history", &reopened.frames);
    assert_eq!(
        reopened.session_id, session_id,
        "the reopen attached the stored session, not a new one"
    );
    let rendered = reopened.frames.join("\n");
    assert!(
        rendered.contains("the reopen battery question"),
        "the OLD user message renders on reopen (the operator's report 1):\n{rendered}"
    );
    assert!(
        rendered.contains("the reopen battery reply one"),
        "the OLD scripted reply renders on reopen (the operator's report 1):\n{rendered}"
    );
    assert!(
        rendered.contains("the reopen battery reply two"),
        "the second OLD scripted reply renders on reopen:\n{rendered}"
    );
    dump_frames("reopen-history", &reopened.frames);
}

/// Scenario (2): a subagent's session stays a DISTINCT store entry - a
/// separate file with its own header id naming the parent - and the agents
/// view nests it under the parent instead of merging everything into one
/// session row.
#[tokio::test]
async fn subagent_session_stays_a_distinct_store_entry() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    wait_for_daemon(&supervisor.socket).await;

    // The parent session (a real daemon create, scripted engine).
    let parent_script = dir.path().join("parent-script.json");
    create_session_via_daemon(
        &supervisor.socket,
        &parent_script,
        &json!({ "responses": [ { "text": "the parent orchestrates" } ] }),
        dir.path(),
        &session_dir,
        Some("triage-parent"),
        None,
        None,
    )
    .await;
    let (parent_path, parent_id) = the_session_file(&session_dir);

    // The child: the REAL subagent create (the daemon create carrying
    // `parentSessionPath`/`rlmDepth` - the same durable create a
    // `rlm.spawn` issues).
    let child_script = dir.path().join("child-script.json");
    let child_id = create_session_via_daemon(
        &supervisor.socket,
        &child_script,
        &json!({ "responses": [ { "text": "the child works" } ] }),
        dir.path(),
        &session_dir,
        Some("triage-child"),
        Some(&parent_path),
        Some(1),
    )
    .await;
    assert_ne!(parent_id, child_id, "the child is its own session");

    // The store keeps TWO distinct entries with distinct header ids.
    let files = session_files(&session_dir);
    assert_eq!(files.len(), 2, "two distinct store entries: {files:?}");
    let child_path = files
        .iter()
        .find(|path| path.as_path() != parent_path.as_path())
        .expect("the child's own file")
        .clone();
    let parent_header =
        pa_daemon::session_store::read_session_header(&parent_path).expect("parent header");
    let child_header =
        pa_daemon::session_store::read_session_header(&child_path).expect("child header");
    assert_eq!(parent_header.id, parent_id);
    assert_eq!(child_header.id, child_id);
    assert_ne!(parent_path, child_path, "separate store files");
    assert_eq!(
        child_header.parent_session.as_deref().map(Path::new),
        Some(parent_path.as_path()),
        "the child's header names the parent's file"
    );
    assert_eq!(child_header.rlm_depth, Some(1), "the child's depth");
    assert!(
        parent_header.parent_session.is_none(),
        "the parent stays a root"
    );

    // The daemon's own session list reports both, with distinct files.
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect supervisor");
    let list = client
        .request_ok(pa_types::daemon::DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        })
        .await
        .expect("list");
    client.close();
    let sessions = list["sessions"].as_array().cloned().unwrap_or_default();
    let parent_row = sessions
        .iter()
        .find(|row| row["sessionFile"] == json!(parent_path.display().to_string()))
        .expect("the parent row names the parent file");
    let child_row = sessions
        .iter()
        .find(|row| row["sessionFile"] == json!(child_path.display().to_string()))
        .expect("the child row names the child's OWN file");
    assert_eq!(
        parent_row["sessionId"],
        json!(parent_id),
        "the parent row's session id: {parent_row}"
    );
    assert_eq!(
        child_row["sessionId"],
        json!(child_id),
        "the child row's session id: {child_row}"
    );

    // The agents view nests the child under the parent - the operator's
    // report 2: sessions and subagents must NOT merge into one session.
    let options = pa_tui::agents_view::AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    };
    let plan = pa_tui::agents_view::AgentsHeadlessPlan {
        steps: vec![
            pa_tui::agents_view::AgentsStep::WaitSettle { timeout_ms: 30_000 },
            pa_tui::agents_view::AgentsStep::Key("alt+right".to_string()),
            pa_tui::agents_view::AgentsStep::WaitSettle { timeout_ms: 30_000 },
        ],
        width: 120,
        height: 36,
    };
    let view = pa_tui::agents_view::run_agents_view(
        options,
        pa_tui::agents_view::AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("agents view run")
    .outcome;
    // The panes dump BEFORE the asserts: a red run uploads its evidence.
    dump_frames("subagent-distinct", &view.frames);
    let rendered = view.frames.join("\n");
    assert!(
        rendered.contains("triage-parent"),
        "the parent's own session row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("triage-child"),
        "the child's own session row renders nested under the parent:\n{rendered}"
    );
    assert!(
        rendered.contains("1 subagent"),
        "the parent's summary row counts its distinct child:\n{rendered}"
    );
}

/// Scenario (3): the agent-message rows carry their glyph vocabulary, and
/// the panes dump for the workflow artifact. The headless frames are the
/// emission record - what the TUI writes to the terminal - so the dump is
/// the icon check the fleet can read from the artifact.
#[tokio::test]
async fn agent_message_rows_dump_their_glyphs() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let script_path = dir.path().join("glyph-script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "the glyph battery reply" } ] }).to_string(),
    )
    .expect("write script");
    let supervisor = spawn_supervisor(dir.path());
    wait_for_daemon(&supervisor.socket).await;
    let mut options = tui_options(&supervisor.socket, &session_dir, &script_path);
    options.cwd = dir.path().to_path_buf();
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::Submit("the glyph battery question".to_string()),
            HeadlessStep::WaitIdle { timeout_ms: 60_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome = run_headless_bounded(options, plan).await;
    dump_frames("glyph-rows", &outcome.frames);
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("the glyph battery question"),
        "the user message row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("the glyph battery reply"),
        "the agent message row renders:\n{rendered}"
    );
}

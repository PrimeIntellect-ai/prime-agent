//! End-to-end verifier for the clipboard/auth/update command group: a
//! scripted daemon session driven headlessly — `/copy` emits the TS OSC 52
//! clipboard sequence after a turn, `/import` replaces the session from a
//! fixture JSONL (with the missing-cwd confirm retry and the TS file error),
//! `/traces` renders the status block and writes the setting through the
//! composition-root hook, `/login` + `/logout` run the provider auth flows
//! through a scripted hook, and `/update` applies the busy guard and runs
//! the package child.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_types::daemon::DaemonCommand;

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

fn process_alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|stat| {
            let rest = stat
                .rsplit_once(')')
                .map(|(_, rest)| rest)
                .unwrap_or_default();
            !rest.starts_with('Z')
        })
        .unwrap_or(false)
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
        fields.next(); // process state
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

fn graceful_shutdown(socket: &Path) {
    use std::io::{BufRead, BufReader, Write};
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
    let _ = reader.read_line(&mut hello); // daemon_hello
    let command = serde_json::json!({
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

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
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

// ---------------------------------------------------------------------------
// Scripted hooks (the composition-root seams; the real implementations live
// inside the crate, so the verifier drives the traits directly).
// ---------------------------------------------------------------------------

use std::sync::{Arc, Mutex};

use pa_tui::provider_auth::{
    AuthCategory, AuthFlow, AuthStatusIndicator, AuthStatusStyle, AuthType, ProviderAuthCommands,
    ProviderAuthFuture, ProviderAuthOutcome, ProviderRow, ProviderRowsFuture,
    PRIME_INFERENCE_PROVIDER_ID,
};
use pa_tui::traces::{
    TraceLoginOutcome, TracePreviewInfo, TracePreviewOutcome, TraceUploadAllNote,
    TraceUploadAllNoteSender, TraceUploadAllReport, TraceUploadCancel, TraceUploadStatus,
    TracesCommands, TracesCommandsHandle, TracesFuture,
};
use pa_tui::update_command::{UpdateChildFuture, UpdateCommands, UpdateCommandsHandle};

struct ScriptedTraces {
    credential: Mutex<Option<String>>,
    enabled: Mutex<Vec<bool>>,
    set_calls: Mutex<Vec<bool>>,
    logins: Mutex<std::collections::VecDeque<TraceLoginOutcome>>,
    uploads: Mutex<std::collections::VecDeque<pa_tui::traces::TraceUploadReport>>,
}

impl ScriptedTraces {
    fn new(credential: Option<String>) -> Self {
        ScriptedTraces {
            credential: Mutex::new(credential),
            enabled: Mutex::new(vec![false]),
            set_calls: Mutex::new(Vec::new()),
            logins: Mutex::new(Default::default()),
            uploads: Mutex::new(Default::default()),
        }
    }

    fn handle(self: &Arc<Self>) -> TracesCommandsHandle {
        TracesCommandsHandle(Arc::clone(self) as Arc<dyn TracesCommands>)
    }
}

impl TracesCommands for ScriptedTraces {
    fn enabled(&self) -> TracesFuture<bool> {
        let last = self
            .enabled
            .lock()
            .unwrap()
            .last()
            .copied()
            .unwrap_or(false);
        Box::pin(async move { last })
    }

    fn set_enabled(&self, enabled: bool) -> TracesFuture<anyhow::Result<()>> {
        self.enabled.lock().unwrap().push(enabled);
        self.set_calls.lock().unwrap().push(enabled);
        Box::pin(async move { Ok(()) })
    }

    fn credential(&self) -> TracesFuture<Option<String>> {
        let credential = self.credential.lock().unwrap().clone();
        Box::pin(async move { credential })
    }

    fn preview(&self, session_file: Option<&str>) -> TracesFuture<TracePreviewOutcome> {
        // The scripted preview: a session file renders the ready block
        // header; no file is the TS fallback row.
        let outcome = match session_file {
            Some(file) => TracePreviewOutcome::Ready(Box::new(TracePreviewInfo {
                session_file: file.to_string(),
                size: 64,
                max_bytes: 20 * 1024 * 1024,
                uploadable: true,
                endpoint: "https://api.primeintellect.ai/api/v1/agent-traces/sessions/s"
                    .to_string(),
                session_id: "s".to_string(),
                trace_id: "s".to_string(),
                parent_session_id: None,
                git_repo: None,
                git_commit: None,
                content_preview: "{\"type\":\"session\"}".to_string(),
                truncated: false,
            })),
            None => TracePreviewOutcome::NoSessionFile,
        };
        Box::pin(async move { outcome })
    }

    fn upload_current(
        &self,
        _session_file: Option<&str>,
    ) -> TracesFuture<pa_tui::traces::TraceUploadReport> {
        // The scripted one-shot upload: the queued reports answer in
        // order, defaulting to the uploaded row.
        let report =
            self.uploads
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(pa_tui::traces::TraceUploadReport {
                    status: TraceUploadStatus::Uploaded,
                    text: "Trace uploaded (64 bytes).".to_string(),
                });
        Box::pin(async move { report })
    }

    fn upload_all(
        &self,
        _session_dir: Option<&str>,
        progress: TraceUploadAllNoteSender,
        cancel: TraceUploadCancel,
    ) -> TracesFuture<TraceUploadAllReport> {
        // The scripted sweep: two files upload with a live counter; the
        // 300ms hold keeps the run in flight across a second submit (the
        // one-sweep-at-a-time guard reads the live run synchronously).
        Box::pin(async move {
            let _ = cancel;
            let _ = progress.send(TraceUploadAllNote::Progress {
                completed: 0,
                total: 2,
            });
            // The hold keeps the run in flight across the next submit
            // (the one-sweep guard reads the live run synchronously).
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let _ = progress.send(TraceUploadAllNote::Progress {
                completed: 2,
                total: 2,
            });
            TraceUploadAllReport {
                total: 2,
                uploaded: 2,
                failed: 0,
                skipped: 0,
                bytes_stored: 128,
                log_path: "/agent/logs/agent-traces.log".to_string(),
            }
        })
    }

    fn login(
        &self,
        _panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> TracesFuture<TraceLoginOutcome> {
        // The scripted login flow: the queued outcomes answer in order,
        // defaulting to the credential's resolution.
        let outcome = self.logins.lock().unwrap().pop_front().unwrap_or_else(|| {
            match self.credential.lock().unwrap().is_some() {
                true => TraceLoginOutcome::Status(
                    "Saved API key for Prime Agent Traces. Credentials saved to /agent/auth.json."
                        .to_string(),
                ),
                false => TraceLoginOutcome::Cancelled,
            }
        });
        Box::pin(async move { outcome })
    }
}

/// The login/logout flows the scripted hook serves: one API-key provider
/// whose key the hook stores, like the composition root's auth store.
struct ScriptedProviderAuth {
    stored_keys: Mutex<std::collections::HashMap<String, String>>,
    calls: Mutex<Vec<String>>,
    /// Whether the login catalog carries the Prime Inference row (the
    /// panel-driven flow's team picker test drives it).
    prime_row: bool,
}

impl ScriptedProviderAuth {
    fn new() -> Self {
        ScriptedProviderAuth {
            stored_keys: Mutex::new(Default::default()),
            calls: Mutex::new(Vec::new()),
            prime_row: false,
        }
    }

    fn with_prime_row() -> Self {
        ScriptedProviderAuth {
            prime_row: true,
            ..ScriptedProviderAuth::new()
        }
    }

    fn handle(self) -> pa_tui::provider_auth::ProviderAuthCommandsHandle {
        pa_tui::provider_auth::ProviderAuthCommandsHandle(Arc::new(self))
    }

    fn openai_row(&self, name: &str, auth_type: AuthType) -> ProviderRow {
        let configured = self.stored_keys.lock().unwrap().contains_key("openai");
        ProviderRow {
            id: "openai".to_string(),
            name: name.to_string(),
            auth_type,
            category: AuthCategory::Provider,
            status: (!configured).then(|| AuthStatusIndicator {
                style: AuthStatusStyle::Muted,
                label: "unconfigured".to_string(),
            }),
            flow: AuthFlow::ApiKeyPrompt,
        }
    }

    /// The Prime Inference row (the panel-driven flow the team picker
    /// test drives).
    fn prime_row(&self) -> ProviderRow {
        ProviderRow {
            id: PRIME_INFERENCE_PROVIDER_ID.to_string(),
            name: "Prime Inference".to_string(),
            auth_type: AuthType::ApiKey,
            category: AuthCategory::Provider,
            status: Some(AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "configured".to_string(),
            }),
            flow: AuthFlow::TerminalFlow,
        }
    }
}

impl ProviderAuthCommands for ScriptedProviderAuth {
    fn login_options(&self) -> ProviderRowsFuture {
        let row = self.openai_row("OpenAI", AuthType::ApiKey);
        // TS sorts prime-inference first among the configured rows.
        let rows = if self.prime_row {
            vec![self.prime_row(), row]
        } else {
            vec![row]
        };
        Box::pin(async move { rows })
    }

    fn logout_options(&self) -> ProviderRowsFuture {
        let stored: Vec<String> = self.stored_keys.lock().unwrap().keys().cloned().collect();
        Box::pin(async move {
            stored
                .into_iter()
                .map(|id| ProviderRow {
                    name: "OpenAI".to_string(),
                    auth_type: AuthType::ApiKey,
                    category: AuthCategory::Provider,
                    status: Some(AuthStatusIndicator {
                        style: AuthStatusStyle::Success,
                        label: "configured".to_string(),
                    }),
                    id,
                    flow: AuthFlow::ApiKeyPrompt,
                })
                .collect()
        })
    }

    fn login(&self, provider: &ProviderRow, api_key: Option<&str>) -> ProviderAuthFuture {
        let key = api_key.unwrap_or_default().to_string();
        let (id, name) = (provider.id.clone(), provider.name.clone());
        if key.is_empty() {
            return Box::pin(async move {
                ProviderAuthOutcome::Error(format!(
                    "Failed to save API key for {name}: API key cannot be empty."
                ))
            });
        }
        self.stored_keys.lock().unwrap().insert(id.clone(), key);
        self.calls.lock().unwrap().push(format!("login:{id}"));
        Box::pin(async move {
            ProviderAuthOutcome::Status(format!(
                "Saved API key for {name}. Credentials saved to /agent/auth.json"
            ))
        })
    }

    fn logout(&self, provider: &ProviderRow) -> ProviderAuthFuture {
        let (id, name) = (provider.id.clone(), provider.name.clone());
        self.stored_keys.lock().unwrap().remove(&id);
        self.calls.lock().unwrap().push(format!("logout:{id}"));
        Box::pin(async move {
            ProviderAuthOutcome::Status(format!(
                "Removed stored API key for {name}. Environment variables and models.json config are unchanged."
            ))
        })
    }

    /// The panel-driven flow (the Prime Inference login): one progress
    /// line, then the team picker; the pick settles the TS status.
    fn login_on_panel(
        &self,
        provider: &ProviderRow,
        panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> ProviderAuthFuture {
        let name = provider.name.clone();
        self.calls
            .lock()
            .unwrap()
            .push("login_on_panel".to_string());
        Box::pin(async move {
            panel.progress("Loading Prime teams...");
            let teams = vec![
                pa_tui::auth_panel::PrimeTeamOption {
                    team_id: "team-acme".to_string(),
                    name: "Acme Corp".to_string(),
                    slug: Some("acme".to_string()),
                    role: Some("Owner".to_string()),
                    created_at: None,
                },
                pa_tui::auth_panel::PrimeTeamOption {
                    team_id: "team-beta".to_string(),
                    name: "Beta Team".to_string(),
                    slug: None,
                    role: None,
                    created_at: None,
                },
            ];
            match panel.select_team(teams, None).await {
                pa_tui::auth_panel::PrimeTeamPick::Team(team) => ProviderAuthOutcome::Status(
                    format!("Saved API key for {name}. Using team \"{}\".", team.name),
                ),
                pa_tui::auth_panel::PrimeTeamPick::PersonalAccount => ProviderAuthOutcome::Status(
                    format!("Saved API key for {name}. Using personal account."),
                ),
                pa_tui::auth_panel::PrimeTeamPick::Cancelled => ProviderAuthOutcome::Status(
                    format!("Saved API key for {name}. Using personal account."),
                ),
            }
        })
    }
}

/// The update child runner the verifier scripts: record the child args,
/// answer success. The relaunch is never exercised headlessly (it replaces
/// the process); its scripted arm exits so a bug cannot hang the test.
struct ScriptedUpdate {
    calls: Mutex<Vec<Vec<String>>>,
}

impl UpdateCommands for ScriptedUpdate {
    fn run_cli_child(&self, args: Vec<String>) -> UpdateChildFuture {
        self.calls.lock().unwrap().push(args);
        Box::pin(async move { Ok(0) })
    }

    fn relaunch(&self, _args: Vec<String>) -> ! {
        // A self-update must never run headlessly: the verifier only drives
        // package targets. Reaching this arm is a bug.
        eprintln!("the scripted relaunch arm ran in a headless verifier");
        std::process::exit(87)
    }
}

/// The interactive options over one attached scripted session, with the
/// command hooks injected.
#[allow(clippy::too_many_arguments)]
fn command_options(
    socket: &Path,
    dir: &Path,
    session_dir: &Path,
    script_path: &Path,
    session_id: &str,
    traces: Option<TracesCommandsHandle>,
    provider_auth: Option<pa_tui::provider_auth::ProviderAuthCommandsHandle>,
    update_commands: Option<UpdateCommandsHandle>,
) -> pa_tui::interactive::InteractiveOptions {
    pa_tui::interactive::InteractiveOptions {
        socket_path: socket.to_path_buf(),
        cwd: dir.to_path_buf(),
        session_dir: Some(session_dir.to_path_buf()),
        script_path: Some(script_path.to_path_buf()),
        model_selection: Default::default(),
        model_catalog: Vec::new(),
        model_configured_providers: Default::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::Attach(session_id.to_string()),
        show_images: false,
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
        traces,
        provider_auth,
        update_commands,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: Default::default(),
        session_has_children: false,
    }
}

/// One scripted session created directly against the supervisor (the same
/// create flow the interactive run uses).
async fn create_session_via_daemon(
    socket: &Path,
    script_path: &Path,
    script: &serde_json::Value,
    cwd: &Path,
    session_dir: &Path,
) -> String {
    std::fs::write(script_path, script.to_string()).expect("write script");
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
            config: Some(serde_json::json!({
                "cwd": cwd.display().to_string(),
                "sessionDir": session_dir.display().to_string(),
                "script": script_path.display().to_string(),
            })),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Default::default(),
        })
        .await
        .expect("create session");
    client.close();
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(serde_json::Value::as_str)
        .expect("session id")
        .to_string()
}

/// The joined rendered frames of one headless run.
fn rendered_frames(outcome: &pa_tui::interactive::InteractiveOutcome) -> String {
    outcome.frames.join("\n")
}

fn enter() -> pa_tui::interactive::HeadlessStep {
    pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::NONE,
    ))
}

// ---------------------------------------------------------------------------
// /copy
// ---------------------------------------------------------------------------

/// `/copy` before any assistant message answers the TS error row; after a
/// turn it copies the last assistant text through the OSC 52 channel (the
/// headless capture holds the exact TS sequence).
#[tokio::test]
async fn tui_copy_emits_the_ts_osc52_sequence() {
    // No platform clipboard tools in the verifier: the copy chain falls to
    // OSC 52 (the TS fallback when no tool copied).
    for var in [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "MOSH_CONNECTION",
    ] {
        std::env::remove_var(var);
    }
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "hello from scripted" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // Before any assistant message: the TS error row.
            pa_tui::interactive::HeadlessStep::Submit("/copy".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            // Let the turn start before the idle barrier samples the
            // session state (the barrier passes while no turn is active).
            pa_tui::interactive::HeadlessStep::WaitMs(400),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // After the turn: the status row plus the OSC 52 emission.
            pa_tui::interactive::HeadlessStep::Submit("/copy".to_string()),
            // An argument is the TS usage error.
            pa_tui::interactive::HeadlessStep::Submit("/copy extra".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("No agent messages to copy yet."),
        "the empty-transcript error renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Copied last agent message to clipboard"),
        "the copy status renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Usage: /copy"),
        "the usage error renders:\n{rendered}"
    );
    // The exact TS OSC 52 sequence for the scripted assistant text.
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode("hello from scripted");
    assert_eq!(
        outcome.clipboard_emissions,
        vec![format!("\x1b]52;c;{encoded}\x07")],
        "the OSC 52 emission holds the TS byte shape"
    );
}

/// Three consecutive `/copy` commands COALESCE into one toast (the count
/// bump `(x3)`): every copy still registers (three OSC 52 emissions), but
/// the frames never stack duplicate toast rows and no frame shows the
/// label more than once — the toast is the compact ephemeral overlay, and
/// once its TTL passes the acknowledgment is gone from the settled frame
/// (never a durable transcript row).
#[tokio::test]
async fn tui_copy_toast_coalesces_consecutive_copies_and_auto_dismisses() {
    // No platform clipboard tools in the verifier: the copy chain falls to
    // OSC 52 (the TS fallback when no tool copied).
    for var in [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "MOSH_CONNECTION",
    ] {
        std::env::remove_var(var);
    }
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "hello from scripted" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // Three consecutive copies inside the toast's TTL.
            pa_tui::interactive::HeadlessStep::Submit("/copy".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/copy".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/copy".to_string()),
            // Frames settle with the coalesced toast on screen.
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            // Past the toast's TTL: the overlay dismisses.
            pa_tui::interactive::HeadlessStep::WaitMs(3_500),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dir) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dir).join(format!("frame-{index:03}.txt")),
                frame,
            );
        }
    }
    let label = "Copied last agent message to clipboard";
    // Every copy registered: three OSC 52 emissions.
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode("hello from scripted");
    assert_eq!(
        outcome.clipboard_emissions,
        vec![
            format!("\x1b]52;c;{encoded}\x07"),
            format!("\x1b]52;c;{encoded}\x07"),
            format!("\x1b]52;c;{encoded}\x07"),
        ],
        "every copy ran the OSC 52 chain"
    );
    // The coalesced toast acknowledges the count, exactly one row per
    // frame: consecutive identical copies never stack duplicate rows.
    let coalesced = outcome
        .frames
        .iter()
        .any(|frame| frame.contains(&format!("{label} (x3)")))
        .then_some(())
        .expect("the coalesced count-bump toast renders");
    let _ = coalesced;
    for (index, frame) in outcome.frames.iter().enumerate() {
        let rows = frame.lines().filter(|row| row.contains(label)).count();
        assert!(
            rows <= 1,
            "frame {index} shows the copy toast at most once, got {rows}"
        );
    }
    // The toast is ephemeral: past its TTL the settled frame no longer
    // carries the acknowledgment (a durable status row would persist).
    let last = outcome.frames.last().expect("the settled frame");
    assert!(
        !last.contains(label),
        "the expired toast auto-dismisses:\n{last}"
    );
}

// ---------------------------------------------------------------------------
// /login Prime Inference: the inline team picker
// ---------------------------------------------------------------------------

/// One raw key step (the arrows and Esc the typed-text path cannot
/// express).
fn key(code: crossterm::event::KeyCode) -> pa_tui::interactive::HeadlessStep {
    pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
        code,
        crossterm::event::KeyModifiers::NONE,
    ))
}

/// `/login` → the Prime Inference row → the login flow drives the inline
/// auth panel: the progress line and the team PICKER render in the TUI
/// (TS `PrimeTeamSelectorComponent`), Enter picks the team, and the
/// settled status lands — with no terminal takeover anywhere in the
/// frames.
#[tokio::test]
async fn tui_prime_login_renders_the_inline_team_picker() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let auth = Arc::new(ScriptedProviderAuth::with_prime_row());
    let auth_view = Arc::clone(&auth);
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        Some(pa_tui::provider_auth::ProviderAuthCommandsHandle(
            Arc::clone(&auth) as Arc<dyn ProviderAuthCommands>,
        )),
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // The selector opens; Enter selects the Prime Inference row;
            // the flow drives the inline auth panel (progress, then the
            // team picker).
            pa_tui::interactive::HeadlessStep::Submit("/login".to_string()),
            enter(),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
            // Personal rides first (TS order): down selects Acme Corp.
            key(crossterm::event::KeyCode::Down),
            enter(),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    // The login dialog's panel title (TS `LoginDialogComponent`).
    assert!(
        rendered.contains("Login to Prime Inference"),
        "the auth panel mounts with the TS dialog title:\n{rendered}"
    );
    // The progress line rides the panel (TS `dialog.showProgress`).
    assert!(
        rendered.contains("Loading Prime teams..."),
        "the panel renders the flow's progress:\n{rendered}"
    );
    // The team picker is the TS `PrimeTeamSelectorComponent` panel.
    assert!(
        rendered.contains("Select a Prime Team:"),
        "the team picker mounts with the TS panel title:\n{rendered}"
    );
    assert!(
        rendered.contains("Choose which account pays for Prime Inference usage."),
        "the team picker renders the TS subtitle:\n{rendered}"
    );
    assert!(
        rendered.contains("Search teams"),
        "the team picker renders the TS search field:\n{rendered}"
    );
    // Personal first, the slug/role meta, the current marker on the
    // stored selection (none stored: personal is current).
    assert!(
        rendered.contains("Personal"),
        "the personal-account row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("personal account · current"),
        "the personal row carries its meta and the current marker:\n{rendered}"
    );
    assert!(
        rendered.contains("Acme Corp"),
        "the team row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("slug: acme, role: owner"),
        "the team row carries the TS slug/role meta (the role lowercased):\n{rendered}"
    );
    assert!(
        rendered.contains("Beta Team"),
        "the second team row renders:\n{rendered}"
    );
    // The pick settles the TS status row.
    assert!(
        rendered.contains("Saved API key for Prime Inference. Using team \"Acme Corp\"."),
        "the team pick settles the TS status:\n{rendered}"
    );
    assert_eq!(
        auth_view.calls.lock().unwrap().clone(),
        vec!["login_on_panel".to_string()],
        "the panel flow ran"
    );
    // No terminal takeover anywhere: the flow never clears the screen
    // (the old numbered prompt and the alt-screen leave are gone).
    assert!(
        !rendered.contains("\u{1b}[2J"),
        "no clear-screen escape in any frame:\n{rendered}"
    );
    assert!(
        !rendered.contains("\u{1b}[?1049l"),
        "no alternate-screen leave in any frame:\n{rendered}"
    );
    assert!(
        !rendered.contains("Enter a team number"),
        "the numbered stdin prompt is gone:\n{rendered}"
    );
}

/// Esc on the team picker cancels the SELECTION (TS `onCancel`): the
/// stored selection stays and the login completes with the default team
/// status — the login itself is not cancelled.
#[tokio::test]
async fn tui_prime_login_escape_keeps_the_default_team_status() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let auth = Arc::new(ScriptedProviderAuth::with_prime_row());
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        Some(pa_tui::provider_auth::ProviderAuthCommandsHandle(
            Arc::clone(&auth) as Arc<dyn ProviderAuthCommands>,
        )),
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/login".to_string()),
            enter(),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
            key(crossterm::event::KeyCode::Esc),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Select a Prime Team:"),
        "the team picker mounted:\n{rendered}"
    );
    // TS `onCancel` resolves the default team status: the login itself
    // succeeded (the key was stored before the picker).
    assert!(
        rendered.contains("Saved API key for Prime Inference. Using personal account."),
        "the cancelled pick settles the default team status:\n{rendered}"
    );
    // The panel unmounted: a later frame no longer renders the picker.
    let last = outcome.frames.last().expect("a final frame");
    assert!(
        !last.contains("Select a Prime Team:"),
        "the panel unmounts after the settle:\n{last}"
    );
}

// ---------------------------------------------------------------------------
// /import
// ---------------------------------------------------------------------------

/// `/import` on a missing file answers the TS error; on the exported
/// fixture it replaces the session after the confirm; on a fixture whose
/// stored cwd is gone it asks the TS missing-cwd confirm and retries with
/// the fallback cwd.
#[tokio::test]
async fn tui_import_replaces_the_session_from_a_fixture() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "fixture turn text" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        None,
        None,
    );
    // The fixture: the live session's exported JSONL branch, plus a copy
    // whose header cwd points at a gone directory (the missing-cwd path).
    let fixture = dir.path().join("fixture.jsonl");
    let gone_fixture = dir.path().join("gone-cwd-fixture.jsonl");
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // The missing-file error (confirm first, then the TS error).
            pa_tui::interactive::HeadlessStep::Submit(
                "/import /definitely/not/there.jsonl".to_string(),
            ),
            enter(),
            // A turn to make the fixture worth importing.
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // Export the live branch to the fixture file.
            pa_tui::interactive::HeadlessStep::Submit(format!("/export {}", fixture.display())),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Import session"),
        "the confirm panel renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Replace current session with /definitely/not/there.jsonl?"),
        "the confirm message renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Failed to import session: File not found: /definitely/not/there.jsonl"),
        "the TS file error renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Session exported to:"),
        "the export status renders:\n{rendered}"
    );
    assert!(fixture.is_file(), "the export wrote the fixture");
    // The gone-cwd fixture: the exported branch with a header cwd that no
    // longer exists (the TS `MissingSessionCwdError` path).
    let gone_cwd = dir.path().join("gone-dir");
    let lines: Vec<String> = std::fs::read_to_string(&fixture)
        .expect("read fixture")
        .lines()
        .map(str::to_string)
        .collect();
    let mut header: serde_json::Value =
        serde_json::from_str(&lines[0]).expect("the fixture header parses");
    header["cwd"] = serde_json::json!(gone_cwd.display().to_string());
    let mut gone_lines = vec![header.to_string()];
    gone_lines.extend(lines.into_iter().skip(1));
    std::fs::write(&gone_fixture, gone_lines.join("\n")).expect("write gone-cwd fixture");

    // A fresh session for the import itself.
    let fresh_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &fresh_id,
        None,
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // The import: confirm, then the status row plus the imported
            // branch's messages.
            pa_tui::interactive::HeadlessStep::Submit(format!("/import {}", fixture.display())),
            enter(),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
            // The gone-cwd fixture: the TS missing-cwd confirm, Yes
            // retries with the fallback cwd.
            pa_tui::interactive::HeadlessStep::Submit(format!(
                "/import {}",
                gone_fixture.display()
            )),
            enter(),
            enter(),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Session imported from:"),
        "the import status renders:\n{rendered}"
    );
    assert!(
        rendered.contains("fixture turn text"),
        "the imported branch's messages render:\n{rendered}"
    );
    assert!(
        rendered.contains("Session cwd not found"),
        "the missing-cwd confirm renders:\n{rendered}"
    );
    assert!(
        rendered.contains("cwd from session file does not exist"),
        "the missing-cwd message renders:\n{rendered}"
    );
    // The imported branch answers on the fresh session's daemon state.
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect supervisor");
    let last = client
        .request_ok(DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: fresh_id.clone(),
            rest: Default::default(),
        })
        .await
        .expect("get last assistant text");
    assert_eq!(
        last.get("text").and_then(serde_json::Value::as_str),
        Some("fixture turn text"),
        "the imported branch's assistant text answers on the fresh session"
    );
    client.close();
    // The usage error for a missing argument.
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &fresh_id,
        None,
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![pa_tui::interactive::HeadlessStep::Submit(
            "/import".to_string(),
        )],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    assert!(
        rendered_frames(&outcome).contains("Usage: /import <path.jsonl>"),
        "the usage error renders"
    );
}

// ---------------------------------------------------------------------------
// /traces
// ---------------------------------------------------------------------------

/// `/traces` renders the TS status block and drives the settings writes
/// through the hook; the upload/preview/login arms run the engine surface
/// end to end (the one-shot upload, the preview block, the upload-all
/// sweep with its live counter, and the login flow's parked terminal
/// run).
#[tokio::test]
async fn tui_traces_renders_status_and_toggles_the_setting() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let traces = Arc::new(ScriptedTraces::new(Some("PRIME_API_KEY".to_string())));
    let traces_view = Arc::clone(&traces);
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        Some(traces.handle()),
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/traces".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/traces on".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/traces off".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/traces sideways".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/traces preview".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/traces upload".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Trace Sharing"),
        "the status block renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Automatic uploads: Disabled"),
        "the flag row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Credential: PRIME_API_KEY"),
        "the credential row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Endpoint: https://api.primeintellect.ai"),
        "the endpoint row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Session file: "),
        "the session file row renders:\n{rendered}"
    );
    // The enable arm: the setting write, then the one-shot upload's
    // message riding the status row (TS `formatTraceUploadResult`).
    assert!(
        rendered.contains("Trace sharing enabled. Trace uploaded (64 bytes)."),
        "the enable status renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Trace sharing disabled."),
        "the disable status renders:\n{rendered}"
    );
    assert!(
        rendered.contains(
            "Usage: /traces [status|on|off|preview|upload|upload-current|upload-all|login]"
        ),
        "the usage warning renders:\n{rendered}"
    );
    // The preview arm renders the TS block over the scripted engine
    // result.
    assert!(
        rendered.contains("Trace Preview"),
        "the preview block renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Nothing has been uploaded by this command."),
        "the preview disclaimer renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Uploadable: Yes"),
        "the preview uploadable row renders:\n{rendered}"
    );
    // The one-shot upload arm: the same formatted row, as a status row
    // (no credential only would be the error).
    assert!(
        rendered.contains("Trace uploaded (64 bytes)."),
        "the upload row renders:\n{rendered}"
    );
    assert_eq!(
        *traces_view.set_calls.lock().unwrap(),
        vec![true, false],
        "the on/off writes reached the hook in order"
    );
}

/// The upload-all sweep runs in the background: the live counter rewrites
/// the status row, and the settled summary lands when the run finishes.
#[tokio::test]
async fn tui_traces_upload_all_sweeps_with_live_progress() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let traces = Arc::new(ScriptedTraces::new(Some("PRIME_API_KEY".to_string())));
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        Some(traces.handle()),
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/traces upload-all".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/traces upload-all".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    // The live counter (TS `showStatus`: the clear-key hint follows the
    // run loop's binding).
    assert!(
        rendered.contains("Uploading traces: 2/2 (Ctrl+C to cancel)"),
        "the progress row renders:\n{rendered}"
    );
    // The settled summary (TS's parts joined with `; `).
    assert!(
        rendered.contains("Uploaded 2 of 2 traces; 128 bytes stored."),
        "the summary row renders:\n{rendered}"
    );
    // The one-sweep guard: the second submit while the first still runs
    // never starts a second sweep (the TS warning it shows is a status
    // row the later progress rewrites in place, exactly like TS).
    assert_eq!(
        rendered.matches("Uploading traces: 0/2").count(),
        1,
        "exactly one sweep started:\n{rendered}"
    );
}

/// Without a credential the upload arms answer the TS errors; the enable
/// arm parks the login first (a cancelled login stops it silently, an
/// errored login shows the flow's row).
#[tokio::test]
async fn tui_traces_without_a_credential_runs_the_login_flow() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    // The enable arm's parked login: the scripted flow fails.
    let traces = Arc::new(ScriptedTraces::new(None));
    traces
        .logins
        .lock()
        .unwrap()
        .push_back(TraceLoginOutcome::Error(
            "Failed to login to Prime Agent Traces: no browser and no pasted key.".to_string(),
        ));
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        Some(traces.handle()),
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/traces on".to_string()),
            // The login flow runs in the background against the inline
            // auth panel: the settle wait lets its outcome row land in
            // the captured frames.
            pa_tui::interactive::HeadlessStep::WaitMs(400),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Failed to login to Prime Agent Traces: no browser and no pasted key."),
        "the login flow's error row renders:\n{rendered}"
    );
    assert!(
        !rendered.contains("Trace sharing enabled"),
        "the enable stops after the failed login:\n{rendered}"
    );

    // A cancelled login stays silent (TS the cancelled dialog); the
    // upload arms answer their TS rows.
    let traces = Arc::new(ScriptedTraces::new(None));
    let traces_view = Arc::clone(&traces);
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        Some(traces.handle()),
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/traces on".to_string()),
            pa_tui::interactive::HeadlessStep::WaitMs(400),
            pa_tui::interactive::HeadlessStep::Submit("/traces upload-current".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/traces upload-all".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        !rendered.contains("Trace sharing enabled"),
        "the enable stops after the cancelled login:\n{rendered}"
    );
    assert!(
        rendered.contains("Trace sharing needs a Prime API key. Run /traces login."),
        "the upload error renders:\n{rendered}"
    );
    assert!(
        traces_view.set_calls.lock().unwrap().is_empty(),
        "no setting write happened without a credential"
    );
}

/// A successful login lets the enable arm continue (TS the login-first
/// `on` path): the setting write, then the one-shot upload message.
#[tokio::test]
async fn tui_traces_login_enables_and_uploads() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let traces = Arc::new(ScriptedTraces::new(None));
    // The login succeeds and the credential resolves afterwards (TS
    // re-reads it after the flow).
    traces
        .logins
        .lock()
        .unwrap()
        .push_back(TraceLoginOutcome::Status(
            "Saved API key for Prime Agent Traces. Credentials saved to /agent/auth.json."
                .to_string(),
        ));
    traces
        .credential
        .lock()
        .unwrap()
        .replace("Prime Agent Traces credential".to_string());
    let traces_view = Arc::clone(&traces);
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        Some(traces.handle()),
        None,
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/traces on".to_string()),
            // The login flow runs in the background against the inline
            // auth panel: the settle wait lets its outcome row land in
            // the captured frames.
            pa_tui::interactive::HeadlessStep::WaitMs(400),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    // TS `showStatus` rewrites back-to-back status rows in place: the
    // login's row is superseded by the enable row (the surviving TS
    // observable); the enable write proves the flow itself completed.
    assert!(
        rendered.contains("Trace sharing enabled. Trace uploaded (64 bytes)."),
        "the enable continues after the login:\n{rendered}"
    );
    assert_eq!(
        *traces_view.set_calls.lock().unwrap(),
        vec![true],
        "the enable write reached the hook"
    );
}

// ---------------------------------------------------------------------------
// /login + /logout
// ---------------------------------------------------------------------------

/// `/login` opens the provider selector, prompts for the key in the panel,
/// and stores it through the hook; `/logout` lists the stored credential
/// and removes it.
#[tokio::test]
async fn tui_login_and_logout_run_the_provider_flows() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let auth = Arc::new(ScriptedProviderAuth::new());
    let auth_view = Arc::clone(&auth);
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        Some(pa_tui::provider_auth::ProviderAuthCommandsHandle(
            Arc::clone(&auth) as Arc<dyn ProviderAuthCommands>,
        )),
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // The selector opens; Enter selects the api-key row; the
            // panel prompt takes the key; Enter stores it.
            pa_tui::interactive::HeadlessStep::Submit("/login".to_string()),
            enter(),
            pa_tui::interactive::HeadlessStep::Type("sk-test-key".to_string()),
            enter(),
            // The logout selector lists the stored credential; Enter
            // removes it.
            pa_tui::interactive::HeadlessStep::Submit("/logout".to_string()),
            enter(),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Providers"),
        "the selector panel renders:\n{rendered}"
    );
    assert!(
        rendered.contains("OpenAI · api key"),
        "the provider row renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Enter API key:"),
        "the panel prompt renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Saved API key for OpenAI. Credentials saved to /agent/auth.json"),
        "the store status renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Saved Credentials"),
        "the logout panel renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Removed stored API key for OpenAI. Environment variables and models.json config are unchanged."),
        "the removal status renders:\n{rendered}"
    );
    assert_eq!(
        auth_view.calls.lock().unwrap().clone(),
        vec!["login:openai".to_string(), "logout:openai".to_string()],
        "the flows ran in order"
    );
    assert!(
        auth_view.stored_keys.lock().unwrap().is_empty(),
        "the logout removed the stored key"
    );

    let auth = Arc::new(ScriptedProviderAuth::new());
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        Some(pa_tui::provider_auth::ProviderAuthCommandsHandle(
            Arc::clone(&auth) as Arc<dyn ProviderAuthCommands>,
        )),
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/login arg".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/logout arg".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Usage: /login"),
        "the login usage error renders"
    );
    assert!(
        rendered.contains("Usage: /logout"),
        "the logout usage error renders"
    );
}

// ---------------------------------------------------------------------------
// /update
// ---------------------------------------------------------------------------

/// `/update --extensions` waits for the running turn (the TS busy guard
/// for package targets), then runs the package child and reports the TS
/// status; the self target skips the guard (the TS rule).
#[tokio::test]
async fn tui_update_busy_guard_and_package_child() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    // A slow scripted turn keeps the session busy for the guard.
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "slow turn", "delayMs": 2500 },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let update = Arc::new(ScriptedUpdate {
        calls: Mutex::new(Vec::new()),
    });
    let update_view = Arc::clone(&update);
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        None,
        Some(UpdateCommandsHandle(
            Arc::clone(&update) as Arc<dyn UpdateCommands>
        )),
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitMs(800),
            // Package targets wait for the running turn.
            pa_tui::interactive::HeadlessStep::Submit("/update --extensions".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // After the turn the same command runs the child.
            pa_tui::interactive::HeadlessStep::Submit("/update --extensions".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    assert!(
        rendered.contains("Wait for the current work to finish before updating."),
        "the busy guard renders:\n{rendered}"
    );
    assert!(
        rendered.contains("Packages updated. Reloading resources..."),
        "the package status renders:\n{rendered}"
    );
    assert_eq!(
        update_view.calls.lock().unwrap().clone(),
        vec![vec![
            "package".to_string(),
            "update".to_string(),
            "--extensions".to_string()
        ]],
        "the guard blocked the first attempt and the second ran the child"
    );
}

/// `/logout` with an empty store answers the TS status directly, with no
/// selector.
#[tokio::test]
async fn tui_logout_with_no_stored_credentials_reports_the_ts_status() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "ok" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let session_id = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let options = command_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        &session_id,
        None,
        Some(ScriptedProviderAuth::new().handle()),
        None,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![pa_tui::interactive::HeadlessStep::Submit(
            "/logout".to_string(),
        )],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = rendered_frames(&outcome);
    // The long status wraps at the frame width; assert its two line
    // segments.
    assert!(
        rendered.contains("No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and"),
        "the empty-store status head renders:\n{rendered}"
    );
    assert!(
        rendered.contains("models.json config are unchanged."),
        "the empty-store status tail renders:\n{rendered}"
    );
    assert!(
        !rendered.contains("Saved Credentials"),
        "no selector mounts for an empty store:\n{rendered}"
    );
}

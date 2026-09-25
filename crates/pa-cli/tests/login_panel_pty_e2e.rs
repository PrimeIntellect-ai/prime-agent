//! Real-terminal e2e for the inline auth panel (the `/login` Prime
//! Inference team picker): the product's terminal renderer runs on a
//! pty, and the harness proves the login flow NEVER takes the terminal
//! over — no alternate-screen leave, no screen clear, no mouse-tracking
//! release — while the panel and the team picker render inline (the TS
//! `LoginDialogComponent` + `PrimeTeamSelectorComponent` surfaces).
//!
//! The child halves re-execute this binary in terminal mode against a
//! mock supervisor: the `/login` Prime Inference child (a scripted
//! provider-auth hook that drives the panel through the team picker) and
//! the `/mcp`-view child (a scripted client-auth hook + the roster whose
//! Enter runs the login). The byte stream the pty collects is the
//! product's own rendering path. A plain `cargo test` run (no
//! `PA_LOGIN_PANEL_CHILD_SOCKET`) passes trivially — only the parent
//! tests drive the real path.
#![cfg(unix)]

use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use serde_json::{json, Value};

use pa_tui::auth_panel::{AuthPanelHandle, PrimeTeamOption, PrimeTeamPick};
use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};
use pa_tui::provider_auth::{
    AuthFlow, AuthStatusIndicator, AuthStatusStyle, AuthType, ProviderAuthCommands,
    ProviderAuthCommandsHandle, ProviderAuthOutcome, ProviderRow, ProviderRowsFuture,
    PRIME_INFERENCE_PROVIDER_ID,
};
use std::pin::Pin;
use std::sync::Arc;

/// The child-mode socket: set (with the socket path) only when this very
/// binary is re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_LOGIN_PANEL_CHILD_SOCKET";

/// The child half of the e2e: runs the real interactive loop in terminal
/// mode (the harness pty) against the parent's mock supervisor, with the
/// scripted provider-auth hook that drives the panel. A plain `cargo
/// test` run (no `CHILD_SOCKET_ENV`) passes trivially.
#[test]
fn login_panel_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime.block_on(run_interactive(options, UiMode::Terminal));
}

/// The `/mcp`-view child half: the same real interactive loop with a
/// scripted client-auth hook (the `/mcp` view's login dispatch) and a
/// roster that carries the connectable `linear` service.
#[test]
fn login_panel_mcp_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = mcp_child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime.block_on(run_interactive(options, UiMode::Terminal));
}

/// The model-picker sign-in child half: the real interactive loop with a
/// catalog whose one model comes from a provider the client does not
/// count as signed in (the picker's "require sign in" discovery row) and
/// a scripted provider-auth hook whose API-key login succeeds — the
/// picked model must route through the login flow and apply after it.
#[test]
fn model_sign_in_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = model_sign_in_child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime.block_on(run_interactive(options, UiMode::Terminal));
}

/// The scripted provider-auth hook: the Prime Inference row and the
/// panel-driven login (a progress line, then the team picker, then the
/// TS status row).
struct ScriptedProviderAuth;

impl ProviderAuthCommands for ScriptedProviderAuth {
    fn login_options(&self) -> ProviderRowsFuture {
        let row = ProviderRow {
            id: PRIME_INFERENCE_PROVIDER_ID.to_string(),
            name: "Prime Inference".to_string(),
            auth_type: AuthType::ApiKey,
            status: Some(AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "configured".to_string(),
            }),
            flow: AuthFlow::TerminalFlow,
            available: true,
        };
        Box::pin(async move { vec![row] })
    }

    fn logout_options(&self) -> ProviderRowsFuture {
        Box::pin(async move { Vec::new() })
    }

    fn login(
        &self,
        provider: &ProviderRow,
        _api_key: Option<&str>,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>> {
        let name = provider.name.clone();
        Box::pin(async move {
            ProviderAuthOutcome::Error(format!("{name} login is not available in this build yet."))
        })
    }

    fn login_on_panel(
        &self,
        provider: &ProviderRow,
        panel: AuthPanelHandle,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>> {
        let name = provider.name.clone();
        Box::pin(async move {
            panel.progress("Loading Prime teams...");
            let teams = vec![
                PrimeTeamOption {
                    team_id: "team-acme".to_string(),
                    name: "Acme Corp".to_string(),
                    slug: Some("acme".to_string()),
                    role: Some("Owner".to_string()),
                    created_at: None,
                },
                PrimeTeamOption {
                    team_id: "team-beta".to_string(),
                    name: "Beta Team".to_string(),
                    slug: None,
                    role: None,
                    created_at: None,
                },
            ];
            match panel.select_team(teams, None).await {
                PrimeTeamPick::Team(team) => ProviderAuthOutcome::Status(format!(
                    "Saved API key for {name}. Using team \"{}\".",
                    team.name
                )),
                _ => ProviderAuthOutcome::Status(format!(
                    "Saved API key for {name}. Using personal account."
                )),
            }
        })
    }

    fn logout(
        &self,
        _provider: &ProviderRow,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>> {
        Box::pin(async move { ProviderAuthOutcome::Cancelled })
    }
}

fn child_options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
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
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: Some(ProviderAuthCommandsHandle(Arc::new(ScriptedProviderAuth))),
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    }
}

/// The `/mcp` view's client-auth hook (the login the view's Enter runs):
/// one progress line, then the TS status. The paste arm shares the panel
/// (the masked field).
struct ScriptedClientAuth;

impl pa_tui::client_auth::ClientAuthCommands for ScriptedClientAuth {
    fn login(
        &self,
        server: &str,
        panel: AuthPanelHandle,
    ) -> Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>> {
        let server = server.to_string();
        Box::pin(async move {
            panel.progress("Authorizing...");
            Ok(format!(
                "Connected {server}. Its skill activates in new sessions (/new)."
            ))
        })
    }

    fn paste_token(
        &self,
        _server: &str,
        _panel: AuthPanelHandle,
    ) -> Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>> {
        Box::pin(async move { Ok("Connected.".to_string()) })
    }

    fn logout(
        &self,
        server: &str,
    ) -> Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>> {
        let server = server.to_string();
        Box::pin(async move { Ok(format!("{server} is not connected.")) })
    }
}

fn mcp_child_options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        client_auth: Some(pa_tui::client_auth::ClientAuthCommandsHandle(Arc::new(
            ScriptedClientAuth,
        ))),
        ..child_options(socket)
    }
}

/// The model-picker sign-in catalog: one model from a provider the client
/// does not count as signed in (the operator's discovery path — the
/// picker keeps the row visible, marked "require sign in").
fn unauthenticated_catalog_model() -> pa_types::ai::Model {
    serde_json::from_value(serde_json::json!({
        "id": "glm-5.3-fast", "name": "GLM 5.3 Fast",
        "api": "openai-completions", "provider": "zai",
        "baseUrl": "https://example.invalid/v1", "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 4096,
    }))
    .expect("mock model deserializes")
}

/// The model-picker sign-in provider-auth hook: the `zai` API-key row and
/// a login that succeeds for any submitted key (the sign-in the picked
/// model routes through).
struct ScriptedModelPickerAuth;

impl ProviderAuthCommands for ScriptedModelPickerAuth {
    fn login_options(&self) -> ProviderRowsFuture {
        let row = ProviderRow {
            id: "zai".to_string(),
            name: "ZAI".to_string(),
            auth_type: AuthType::ApiKey,
            status: None,
            flow: AuthFlow::ApiKeyPrompt,
            // The lane's menu-rule field: a working API-key login row is
            // available (Enter routes the picked model's sign-in through
            // it; an unavailable row renders dimmed and inert).
            available: true,
        };
        Box::pin(async move { vec![row] })
    }

    fn logout_options(&self) -> ProviderRowsFuture {
        Box::pin(async move { Vec::new() })
    }

    fn login(
        &self,
        provider: &ProviderRow,
        api_key: Option<&str>,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>> {
        let name = provider.name.clone();
        // Own the borrowed key before the boxed future (the trait's
        // future has no lifetime).
        let api_key = api_key.map(str::to_string);
        Box::pin(async move {
            if api_key.as_deref().is_some_and(|key| !key.is_empty()) {
                ProviderAuthOutcome::Status(format!("Saved API key for {name}."))
            } else {
                ProviderAuthOutcome::Error(format!(
                    "Failed to save API key for {name}: API key cannot be empty."
                ))
            }
        })
    }

    fn login_on_panel(
        &self,
        provider: &ProviderRow,
        _panel: AuthPanelHandle,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>> {
        let name = provider.name.clone();
        Box::pin(async move {
            ProviderAuthOutcome::Error(format!("{name} login is not available in this build yet."))
        })
    }

    fn logout(
        &self,
        _provider: &ProviderRow,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>> {
        Box::pin(async move { ProviderAuthOutcome::Cancelled })
    }
}

/// The model-picker sign-in child's options: the unauthenticated-provider
/// catalog, no configured providers (the picker marks the row), and the
/// scripted provider-auth hook.
fn model_sign_in_child_options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        model_catalog: vec![unauthenticated_catalog_model()],
        provider_auth: Some(ProviderAuthCommandsHandle(Arc::new(
            ScriptedModelPickerAuth,
        ))),
        ..child_options(socket)
    }
}

/// The terminal takeover signatures the login flow must never emit: the
/// alternate-screen leave (`?1049l`), the screen clear (`\x1b[2J`), and
/// the SGR mouse-tracking release (the `renderer.suspend` bracket's
/// bytes).
const ALT_SCREEN_LEAVE: &str = "\x1b[?1049l";
const SCREEN_CLEAR: &str = "\x1b[2J";
const MOUSE_DISABLE: &str = "\x1b[?1006l\x1b[?1002l";

/// The terminal-sequence e2e: `/login` selects the Prime Inference row,
/// the login drives the inline auth panel, and the pty's byte stream
/// shows the panel and the team picker rendering WITHOUT any terminal
/// takeover — the old flow's alt-screen leave + screen clear + raw
/// stdin prompt never happen.
#[test]
fn prime_login_renders_the_team_picker_without_a_terminal_takeover() {
    let mut harness = LoginPanelHarness::start();

    // The startup contract: the fullscreen surface enters the alternate
    // screen before any input is handled.
    harness.wait_from_start("\x1b[?1049h", "the startup alternate-screen enter");

    // `/login` opens the provider selector.
    harness.write(b"/login\r");
    harness.wait_from_start("Search providers", "the provider selector panel");

    // Enter selects the Prime Inference row: the login flow starts. The
    // window from here to the settled status is the takeover-free proof.
    let mark = harness.mark();
    harness.write(b"\r");
    harness.wait_from(mark, "Select a Prime Team:", "the inline team picker");

    // The picker's rows render inline (the TS selector rows).
    harness.wait_from(mark, "Acme Corp", "the team row");
    harness.wait_from(mark, "personal account", "the personal row");

    // Enter picks the personal account; the settled status lands.
    harness.write(b"\r");
    harness.wait_from(
        mark,
        "Saved API key for Prime Inference. Using personal account.",
        "the settled login status",
    );

    // The terminal takeover never happened: no alternate-screen leave,
    // no screen clear, no mouse-tracking release anywhere in the login
    // window (the whole flow stayed on the TUI's alternate screen).
    let window = harness.window_since(mark);
    assert!(
        find_subsequence(window, ALT_SCREEN_LEAVE.as_bytes()).is_none(),
        "the login never leaves the alternate screen"
    );
    assert!(
        find_subsequence(window, SCREEN_CLEAR.as_bytes()).is_none(),
        "the login never clears the screen"
    );
    assert!(
        find_subsequence(window, MOUSE_DISABLE.as_bytes()).is_none(),
        "the login never releases the mouse tracking (the old suspend bracket)"
    );
    // The numbered stdin prompt is gone too: the flow renders through
    // the panel, not the plain terminal.
    assert!(
        find_subsequence(window, "Enter a team number".as_bytes()).is_none(),
        "the numbered stdin prompt never prints"
    );

    harness.finish();
}

/// The `/mcp`-view login e2e (the operator's exact action): Enter on the
/// connection row runs the login flow, and the pty's byte stream shows
/// the panel rendering INLINE — no alternate-screen leave, no screen
/// clear, no mouse-tracking release — with the settled status landing
/// as a transcript note.
#[test]
fn mcp_view_enter_login_renders_inline_without_a_terminal_takeover() {
    let mut harness = LoginPanelHarness::start_mcp();

    harness.wait_from_start("\x1b[?1049h", "the startup alternate-screen enter");

    // `/mcp` opens the connections view with the roster's Linear row.
    harness.write(b"/mcp\r");
    harness.wait_from_start("Linear", "the connections view row");

    // Enter runs the row's login flow: the panel mounts inline (the TS
    // login dialog), the flow's progress renders, and the settled status
    // lands as a transcript note — the window from here proves no
    // terminal takeover.
    let mark = harness.mark();
    harness.write(b"\r");
    // Ratatui's diff paints changed cells word by word, so the waits pin
    // single-word needles: the progress line only renders inside the
    // panel, and the settle note's word is unique after the view closed.
    // Ratatui's diff paints changed cells word by word and the frame
    // scheduler coalesces (a fast scripted flow can settle inside one
    // frame), so the wait pins the settle note's word — unique after the
    // view closed — and the window assertion below proves the panel
    // mounted inline (its title's first word).
    harness.wait_from(mark, "Connected", "the settled login status");

    let window = harness.window_since(mark);
    assert!(
        find_subsequence(window, b"Login").is_some(),
        "the inline login panel mounted (its title word)"
    );
    assert!(
        find_subsequence(window, ALT_SCREEN_LEAVE.as_bytes()).is_none(),
        "the /mcp login never leaves the alternate screen"
    );
    assert!(
        find_subsequence(window, SCREEN_CLEAR.as_bytes()).is_none(),
        "the /mcp login never clears the screen"
    );
    assert!(
        find_subsequence(window, MOUSE_DISABLE.as_bytes()).is_none(),
        "the /mcp login never releases the mouse tracking (the old suspend bracket)"
    );

    harness.finish();
}

/// The model-picker sign-in e2e (the operator's bug report): a model from
/// a provider the user is not signed in to stays visible in the picker
/// (marked "require sign in"), selecting it sends the switch, the
/// daemon's typed not-signed-in refusal routes the provider's sign-in
/// flow (the `/login` provider menu, preselected on the provider's row,
/// then the API-key prompt), and a successful sign-in applies the model
/// automatically (the `Model: <id>` status row after the login's own
/// status row, never the old dead-end refusal).
#[test]
fn model_picker_routes_the_sign_in_flow_and_applies_after_login() {
    let mut harness = LoginPanelHarness::start_model_sign_in();

    harness.wait_from_start("\x1b[?1049h", "the startup alternate-screen enter");

    // `/model` opens the picker: the unauthenticated provider's row stays
    // visible and carries the sign-in marking (the TS "require sign in"
    // trailing).
    harness.write(b"/model\r");
    harness.wait_from_start("Search models", "the model picker");
    harness.wait_from_start("GLM 5.3 Fast", "the unauthenticated provider's model row");
    harness.wait_from_start("require sign in", "the row's sign-in marking");

    // Enter selects the model: the daemon's typed not-signed-in refusal
    // routes the sign-in flow — the note explains why, the `/login`
    // provider menu mounts, the provider's row is preselected.
    let mark = harness.mark();
    harness.write(b"\r");
    harness.wait_from(
        mark,
        "Sign in to zai to use zai/glm-5.3-fast",
        "the sign-in note",
    );
    harness.wait_from(mark, "Search providers", "the provider login menu");
    harness.wait_from(mark, "ZAI", "the preselected provider row");

    // Enter opens the API-key prompt; the submitted key signs in.
    harness.write(b"\r");
    harness.wait_from(mark, "Enter API key:", "the API-key prompt");
    harness.write(b"sk-fake\r");

    // The sign-in automatically applies the parked model. The login's
    // status row and the switch's `Model:` row are back-to-back TS
    // `showStatus` notes — the model note rewrites the login note in
    // place (the last-wins rule), so the pty only ever carries the
    // final row: the `Model:` retry landing is itself the proof the
    // login succeeded (the retry fires only on the parked provider's
    // successful login).
    harness.wait_from(mark, "Model: glm-5.3-fast", "the automatic model retry");

    // The old dead-end refusal never appeared: the daemon rejection the
    // operator reported is gone from the whole flow.
    let window = harness.window_since(mark);
    assert!(
        !find_subsequence(window, "Model not found".as_bytes()).is_some(),
        "the sign-in route never surfaces the dead-end refusal"
    );

    harness.finish();
}

/// One pty-backed product child plus the mock supervisor it attaches to.
struct LoginPanelHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (it exits with
    /// the child's connection).
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl LoginPanelHarness {
    /// The `/login` child (the provider-auth hook).
    fn start() -> LoginPanelHarness {
        LoginPanelHarness::start_for("login_panel_child_mode")
    }

    /// The `/mcp`-view child (the client-auth hook + the roster).
    fn start_mcp() -> LoginPanelHarness {
        LoginPanelHarness::start_for("login_panel_mcp_child_mode")
    }

    /// The model-picker sign-in child (the unauthenticated catalog + the
    /// provider-auth hook).
    fn start_model_sign_in() -> LoginPanelHarness {
        LoginPanelHarness::start_for("model_sign_in_child_mode")
    }

    fn start_for(child_test: &'static str) -> LoginPanelHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let supervisor = MockSupervisor::bind(&socket);
        let server = std::thread::spawn(move || supervisor.serve());

        let pty = openpty(
            Some(&Winsize {
                ws_row: 24,
                ws_col: 100,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .expect("open pty");

        let child = spawn_child(&socket, &pty.slave, child_test);
        // Leak the temp dir's socket path on purpose: the child needs the
        // socket for the lifetime of the test, and the whole tree dies
        // with the child at teardown.
        std::mem::forget(dir);
        LoginPanelHarness {
            child,
            _server: server,
            master: PtyReader::new(pty.master),
        }
    }

    fn mark(&self) -> usize {
        self.master.mark()
    }

    fn write(&mut self, payload: &[u8]) {
        self.master.write(payload);
    }

    fn wait_from_start(&mut self, needle: &str, what: &str) {
        self.master.wait_from(0, needle, what);
    }

    fn wait_from(&mut self, mark: usize, needle: &str, what: &str) {
        self.master.wait_from(mark, needle, what);
    }

    fn window_since(&self, mark: usize) -> &[u8] {
        &self.master.output[mark..]
    }

    fn finish(mut self) {
        let _ = self.child.kill();
        // Reap the child so no zombie is left behind.
        let _ = self.child.wait();
    }
}

fn spawn_child(socket: &std::path::Path, slave: &OwnedFd, child_test: &str) -> Child {
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .arg("--exact")
        .arg(child_test)
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    command.spawn().expect("spawn child")
}

fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

/// Non-blocking reader over the pty master, collecting the raw byte
/// stream the child writes.
struct PtyReader {
    file: std::fs::File,
    output: Vec<u8>,
}

impl PtyReader {
    fn new(master: OwnedFd) -> PtyReader {
        let fd = master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK)).expect("pty master non-blocking");
        PtyReader {
            file: master.into(),
            output: Vec::new(),
        }
    }

    fn mark(&self) -> usize {
        self.output.len()
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// Drain the master until the needle appears in the output collected
    /// since the given mark, bounded by a generous harness deadline
    /// (attach + first renders).
    fn wait_from(&mut self, mark: usize, needle: &str, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if find_subsequence(&self.output[mark..], needle.as_bytes()).is_some() {
                return;
            }
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => {}
                Ok(n) => self.output.extend_from_slice(&buffer[..n]),
            }
            if Instant::now() > deadline {
                let text = String::from_utf8_lossy(&self.output[mark..]);
                panic!(
                    "timeout waiting for {what} (needle {needle:?}); pty tail since mark:\n{text}"
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// One attached session behind a mock supervisor socket (the same frame
/// contract the headless e2e harness serves).
struct MockSupervisor {
    listener: std::os::unix::net::UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    fn serve(self) {
        let Ok((stream, _)) = self.listener.accept() else {
            return;
        };
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = std::io::BufReader::new(stream);
        write_json(
            &mut writer,
            &json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "serverCapabilities": [],
                "clientId": "mock",
            }),
        );
        // The model-picker sign-in child's set_model sequence: the
        // unsigned provider's first switch answers with the daemon's
        // typed refusal (the wire shape `resolve_set_model_selection`
        // produces), the post-login retry succeeds.
        let mut set_model_count = 0usize;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let id = envelope.get("id").and_then(Value::as_str).unwrap_or("");
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match command_type.as_str() {
                "create" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "create",
                            "success": true,
                            "data": {
                                "activeSessionId": "s1",
                                "id": "s1",
                                "sessionId": "sess-1",
                                "sessionFile": "/tmp/sess-1.jsonl",
                            },
                        }),
                    );
                }
                "attach" => {
                    write_json(&mut writer, &attach_data(id));
                }
                "set_model" => {
                    set_model_count += 1;
                    if set_model_count == 1 {
                        // The not-signed-in class: the typed refusal the
                        // TUI routes to the sign-in flow (never the old
                        // dead-end "Model not found" text).
                        write_json(
                            &mut writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": "set_model",
                                "success": false,
                                "error": "Provider \"zai\" is not signed in. Sign in to the provider (the TUI's /login command), then set the model again.",
                                "errorInfo": {
                                    "code": "model_provider_unauthenticated",
                                    "provider": "zai",
                                },
                            }),
                        );
                    } else {
                        write_json(
                            &mut writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": "set_model",
                                "success": true,
                                "data": {},
                            }),
                        );
                    }
                }
                "get_model_catalog" => {
                    // The model-picker sign-in child's catalog: the
                    // unauthenticated provider's model stays listed
                    // (discovery), the provider stays unconfigured (the
                    // row keeps its "require sign in" marking and the
                    // selection routes to the login flow).
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_model_catalog",
                            "success": true,
                            "data": {
                                "models": [serde_json::to_value(unauthenticated_catalog_model())
                                    .expect("mock model serializes")],
                                "configuredProviders": [],
                            }
                        }),
                    );
                }
                "get_mcp_connections" => {
                    // The roster the `/mcp` view renders: one connectable
                    // OAuth service (Enter runs its login flow).
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_mcp_connections",
                            "success": true,
                            "data": {
                                "connections": [
                                    {
                                        "server": "linear",
                                        "label": "Linear",
                                        "connected": false,
                                        "usesOAuth": true,
                                        "authKind": "subscription",
                                        "transport": "http",
                                        "userDeclared": false,
                                        "generic": false,
                                        "tools": null,
                                        "error": null
                                    }
                                ]
                            },
                        }),
                    );
                }
                _ => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": command_type,
                            "success": true,
                            "data": {},
                        }),
                    );
                }
            }
        }
    }
}

fn write_json(writer: &mut std::os::unix::net::UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..4)
        .map(|index| {
            json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{ "type": "text", "text": format!("row {index}") }],
            })
        })
        .collect();
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "s1",
            "snapshot": {
                "activeSessionId": "s1",
                "summary": { "id": "s1", "cwd": "/tmp" },
                "state": {
                    "activeSessionId": "s1",
                    "cwd": "/tmp",
                    "sessionId": "sess-1",
                    "sessionName": "login panel session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}

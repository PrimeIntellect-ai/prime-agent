// large_futures: stack futures on hot paths by design. too_many_lines: style gate
// only. Casts: 64-bit targets; narrowing sits at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Real-pty e2e for the kitty key-release contract around the chat->agents
//! handoff (the `enhanced_keys` drain): the LEFT press's companion release is
//! in flight during the teardown, and later releases arrive on the adopting
//! surface — none may become user-visible input; the exit pops the flags.
#![cfg(unix)]

use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use serde_json::{json, Value};

use pa_tui::agents_view::{AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

/// The kitty flags push the app writes when armed (flags `1|2|4`, TS `ProcessTerminal`).
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// The kitty flags pop every teardown writes.
const KITTY_FLAGS_POP: &[u8] = b"\x1b[<u";
/// The probe's capability query (flags query followed by the DA1 query).
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The harness's answer: flags `1|2|4` supported, then primary device attributes.
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The kitty CSI-u release of the LEFT arrow (key 57417, event type 3): the
/// companion of the handoff-triggering press, injected around the teardown.
const LEFT_RELEASE: &[u8] = b"\x1b[57417;1:3u";
/// Releases of the Up/Down arrows and `a`: late arrivals on the adopting surface.
const UP_RELEASE: &[u8] = b"\x1b[57419;1:3u";
const DOWN_RELEASE: &[u8] = b"\x1b[57420;1:3u";
const A_RELEASE: &[u8] = b"\x1b[97;1:3u";
/// The alt-screen leave (the real-exit restore tail).
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";

/// Set (with the socket path) only when re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_KITTY_CHILD_SOCKET";

/// The child half of the e2e: runs the real chat surface against the mock
/// supervisor, then hands off like the CLI composition (a plain `cargo test` passes).
#[test]
fn kitty_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    // A current-thread runtime keeps the child's thread count down.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let outcome = run_interactive(options.clone(), UiMode::Terminal)
            .await
            .expect("the chat surface ran");
        // TS `main.ts`'s agents-back arm: hand the terminal to the agents view.
        if outcome.return_to_agents_view {
            let anchor = (!outcome.session_id.is_empty()).then(|| outcome.session_id.clone());
            let view_options = AgentsViewOptions {
                socket_path: options.socket_path.clone(),
                cwd: options.cwd.clone(),
                session_dir: options.session_dir.clone(),
                theme: options.theme.clone(),
                version: options.version.clone(),
                anchor_session_id: anchor,
                scope: None,
                query: None,
                expanded_ancestors: Vec::new(),
                selected_row_identity: None,
                selected_key: None,
                status_message: outcome.agents_view_notice.clone(),
                keybindings: options.keybindings.clone(),
                show_hardware_cursor: false,
                incident_notice_state: None,
                create_config: serde_json::json!({}),
            };
            let view_run = pa_tui::agents_view::run_agents_view(
                view_options,
                AgentsViewUiMode::Terminal,
                None,
            )
            .await
            .expect("the agents view ran");
            if let Some(link) = view_run.link {
                link.close();
            }
        }
    });
}

/// The pty harnesses serialize: concurrent process-group signals and raw ptys flake on shared CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn releases_around_the_handoff_never_become_visible() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = HandoffHarness::start();

    // Answer the probe like a kitty terminal; require the flags push (the arm proof).
    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(KITTY_FLAGS_PUSH, "the kitty flags push");

    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // The handoff: the LEFT press with its release injected in flight — the exact
    // window the teardown drain guards. The view must mount regardless.
    let mark_left = harness.mark();
    harness.write(b"\x1b[D");
    harness.write(LEFT_RELEASE);
    harness.wait_from(mark_left, b"Search sessions", "the agents view mounts");
    assert!(
        harness.child_alive(),
        "the child survived the handoff with an in-flight release"
    );

    // Late releases on the adopting surface drop at dispatch (TS tui.ts). The
    // settle window keeps the assert away from the mount's trailing paints.
    harness.drain_until_quiet(40);
    let mark_late = harness.mark();
    harness.write(UP_RELEASE);
    harness.write(DOWN_RELEASE);
    harness.write(A_RELEASE);
    harness.drain_until_quiet(20);
    let after_late = harness.output_since(mark_late);
    assert!(
        after_late.is_empty(),
        "late key releases produced output ({} bytes) — a release leaked          into the view's dispatch",
        after_late.len()
    );

    // A real press still works: the search editor repaints on input. The frame
    // paints styled cells one at a time, so the needle is the painted `z` cell.
    let mark_query = harness.mark();
    harness.write(b"zz");
    harness.wait_from(mark_query, b"z", "the search editor repaints");
    harness.write(b"\x7f\x7f");
    harness.drain_until_quiet(20);

    // Exit through the real restore, injecting one more release around the
    // exit's drain window. With disambiguate armed a kitty terminal sends Esc as
    // the CSI-u form, so the exit drives the real encoding.
    harness.drain_until_quiet(10);
    let mark_exit = harness.mark();
    // The exit key and the release ride together: the release must land INSIDE
    // the exit path's drain window (a quiet-wait between the writes would drop
    // it on a pty nobody reads).
    harness.write(b"\x1b[27u");
    harness.write(LEFT_RELEASE);
    harness.wait_from(mark_exit, ALT_SCREEN_LEAVE, "the exit restore ran");
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    harness.drain_until_quiet(10);
    let stream = harness.output();

    // Stream hygiene: the LAST kitty-mode byte is a pop — a probe answer around
    // the exit must not re-arm CSI-u on the parent shell.
    let last_push =
        find_subsequence_last(&stream, KITTY_FLAGS_PUSH).expect("the flags push is in the stream");
    let last_pop =
        find_subsequence_last(&stream, KITTY_FLAGS_POP).expect("the flags pop is in the stream");
    assert!(
        last_pop > last_push,
        "the stream's last kitty-mode write is a push at {last_push} after          the last pop at {last_pop} — the exit left CSI-u reporting armed"
    );
    // No release bytes echo back after the alt-screen leave: the exit consumed
    // them through the drain, and the restore handed a quiet terminal to the shell.
    let leave = find_subsequence_last(&stream, ALT_SCREEN_LEAVE)
        .expect("the alt-screen leave is in the stream");
    assert!(
        !contains(&stream[leave..], LEFT_RELEASE),
        "the release sequence echoed into the restored terminal's output"
    );
    assert!(
        exit.is_some_and(|code| code == 0),
        "the child exited cleanly (code {exit:?})"
    );

    harness.finish();
}

/// One pty-backed product child plus the mock supervisor it attaches to.
struct HandoffHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (exits with the child's connection).
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl HandoffHarness {
    fn start() -> HandoffHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let supervisor = MockSupervisor::bind(&socket);
        let server = std::thread::spawn(move || supervisor.serve());

        let pty = openpty(
            Some(&Winsize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .expect("open pty");

        let child = spawn_child(&socket, &pty.slave);
        // Leak the temp dir's socket path on purpose: the child needs it, and the
        // whole tree dies with the child at teardown.
        std::mem::forget(dir);
        HandoffHarness {
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

    fn wait_from_start(&mut self, needle: &[u8], what: &str) {
        self.master.wait_from(0, needle, what);
    }

    fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        self.master.wait_from(mark, needle, what);
    }

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    fn output_since(&self, mark: usize) -> Vec<u8> {
        self.master.output[mark..].to_vec()
    }

    fn child_alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }

    fn wait_child_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().ok().flatten() {
                return status.code();
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn finish(mut self) {
        let _ = self.child.kill();
        // Reap the child so no zombie is left behind.
        let _ = self.child.wait();
    }
}

impl Drop for HandoffHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child: it owns its session's
        // controlling terminal and outlives the harness.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Non-blocking reader over the pty master, collecting the child's byte stream.
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

    /// Drain until quiet for `quiet_polls` polls: a settle window keeps every
    /// later byte (the pty driver drops writes on a full kernel buffer).
    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        let mut quiet = 0;
        while quiet < quiet_polls {
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => quiet += 1,
                Ok(n) => {
                    self.output.extend_from_slice(&buffer[..n]);
                    quiet = 0;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Drain until the needle appears since the mark (bounded by a generous deadline).
    fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if find_subsequence(&self.output[mark..], needle).is_some() {
                return;
            }
            let mut buffer = [0u8; 8192];
            let result = self.file.read(&mut buffer);
            match result {
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
    if needle.is_empty() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find_subsequence(haystack, needle).is_some()
}

fn find_subsequence_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rev()
        .position(|window| window == needle)
        .map(|at| haystack.len() - at - needle.len())
}

/// A child of this very binary, re-executed with the pty as its CONTROLLING
/// terminal (`setsid` + `TIOCSCTTY`): raw-mode and event reads go through `/dev/tty`.
fn spawn_child(socket: &Path, slave: &OwnedFd) -> Child {
    // Runs between fork and exec: become a session leader and claim the pty slave.
    fn claim_controlling_tty(fd: i32) -> std::io::Result<()> {
        nix::unistd::setsid()?;
        let rc = unsafe { libc::ioctl(fd, libc::TIOCSCTTY as libc::c_ulong, 0) };
        if rc < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    let slave_fd = slave.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .arg("--exact")
        .arg("kitty_child_mode")
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    // SAFETY: the pre_exec hook is the supported std seam for
    // session/terminal setup; it runs post-fork pre-exec in the child
    // only and cannot allocate.
    unsafe {
        command.pre_exec(move || claim_controlling_tty(slave_fd));
    }
    command.spawn().expect("spawn pty child")
}

fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

fn child_options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
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
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// One attached session behind a mock supervisor socket (the family's frame contract).
struct MockSupervisor {
    listener: std::os::unix::net::UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// One listener, every connection served in turn: the handoff opens a second
    /// connection, which a single-accept mock would refuse.
    fn serve(self) {
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => Self::serve_connection(stream),
                Err(_) => return,
            }
        }
    }

    fn serve_connection(stream: std::os::unix::net::UnixStream) {
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
                    "sessionName": "kitty release e2e",
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

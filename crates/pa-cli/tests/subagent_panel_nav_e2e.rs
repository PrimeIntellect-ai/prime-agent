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

//! End-to-end verifier for the subagent panel's keyboard path from the main
//! chat (Kevin's live-dogfood ruling, TS parity): the attached session with a
//! ledger-seeded child renders the subagent summary box; Down at the end of
//! the prompt hands the focus to the panel (the unfocused `↓ select` hint
//! flips to `Enter/→ open`); Enter opens the scoped agents view listing the
//! child; Enter drills into the child's transcript (the ancestor carry); and
//! the agents-back key returns from the child to the agents view.
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::SessionSelection;
use pa_tui::interactive::UiMode;

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Stop the daemon on `socket` by protocol; kill the child when it fails.
fn graceful_shutdown(socket: &Path) {
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
    let Ok(mut line) = serde_json::to_string(&command) else {
        return;
    };
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
    // The daemon's default sessions dir must stay the agent dir under the
    // tempdir: an ambient `PRIME_AGENT_SESSION_DIR` (every agent-session
    // shell on the fleet box exports one) would otherwise become the
    // daemon's default session dir, so `rlm_spawn_ledger_for(None)`
    // resolves the family ledger against the foreign dir and the seeded
    // family never registers (the same env hygiene the sibling e2e
    // spawns pin: ambient overrides must not leak in).
    command.env_remove("PRIME_AGENT_SESSION_DIR");
    command.env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR");
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

/// One saved-session fixture: a session header whose `parentSession` and
/// `rlmDepth` give the catalog the subagent linkage, a display name, and a
/// user/assistant exchange.
fn write_fixture(
    dir: &Path,
    id: &str,
    name: &str,
    parent: Option<&Path>,
    rlm_depth: u64,
    turns: &[(&str, &str)],
) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\""
    );
    if let Some(parent) = parent {
        let _ = write!(content, ",\"parentSession\":\"{}\"", parent.display());
    }
    let _ = write!(content, ",\"rlmDepth\":{rlm_depth}}}");
    content.push('\n');
    let _ = writeln!(content,
        "{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}"
    );
    for (index, (user, assistant)) in turns.iter().enumerate() {
        let _ = writeln!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}u\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{user}\",\"timestamp\":{}}}}}",
            index * 1000
        );
        let _ = writeln!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}a\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{assistant}\"}}],\"timestamp\":{}}}}}",
            index * 1000 + 1
        );
    }
    std::fs::write(&path, content).expect("write fixture");
    path
}

/// One billed assistant turn appended to a fixture transcript: the
/// usage-bearing row the own-usage fold reads.
fn append_billed_turn(path: &Path, id: &str, input: u64, output: u64, cost: f64) {
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open the fixture for its billed turn");
    let _ = writeln!(
        file,
        "{{\"type\":\"message\",\"id\":\"{id}\",\"timestamp\":\"2026-09-29T00:00:02.100Z\",\"message\":{{\"role\":\"assistant\",\"provider\":\"prime-inference\",\"model\":\"internal/glm-5.3-fast\",\"content\":[{{\"type\":\"text\",\"text\":\"work complete\"}}],\"stopReason\":\"stop\",\"timestamp\":2100,\"usage\":{{\"input\":{input},\"output\":{output},\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":{},\"cost\":{{\"input\":0.0,\"output\":{cost},\"cacheRead\":0.0,\"cacheWrite\":0.0,\"total\":{cost}}}}}}}}}",
        input + output,
    );
}

/// The first frame showing `marker` (the state before the later keystrokes
/// mutate it).
fn first_frame_of(frames: &[String], marker: &str) -> String {
    frames
        .iter()
        .find(|frame| frame.contains(marker))
        .unwrap_or_else(|| {
            panic!(
                "no frame shows {marker:?}; frames:\n{}",
                frames.join("\n---frame---\n")
            )
        })
        .clone()
}

/// The last frame showing `marker`.
fn frame_of(frames: &[String], marker: &str) -> String {
    frames
        .iter()
        .rev()
        .find(|frame| frame.contains(marker))
        .unwrap_or_else(|| {
            panic!(
                "no frame shows {marker:?}; frames:\n{}",
                frames.join("\n---frame---\n")
            )
        })
        .clone()
}

/// The interactive options for one fixture session.
fn session_options(
    socket: &Path,
    session_dir: &Path,
    session: SessionSelection,
    rlm_depth: Option<u32>,
    has_children: bool,
) -> pa_tui::interactive::InteractiveOptions {
    pa_tui::interactive::InteractiveOptions {
        models: None,
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        session_dir: Some(session_dir.to_path_buf()),
        script_path: None,
        model_selection: pa_tui::interactive::ModelSelection::default(),
        no_session: false,
        session,
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
        client_settings: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: rlm_depth,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: has_children,
        restore_dock_focus: false,
    }
}

#[tokio::test]
async fn down_arrow_focuses_the_dock_and_enter_opens_the_scoped_agents_view() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The family fixture: a parent with a transcript, and a child under it
    // (the linkage the ledger edge carries, with the child's own exchange
    // for its transcript frames).
    let parent_path = write_fixture(
        &session_dir,
        "panel-nav-parent",
        "panel nav parent",
        None,
        0,
        &[("dispatch the worker", "worker dispatched")],
    );
    let child_path = write_fixture(
        &session_dir,
        "panel-nav-worker",
        "panel nav worker",
        Some(&parent_path),
        1,
        &[("do the work", "work complete alpha")],
    );
    // The durable spawn edge: the roster surfaces the child as the parent's
    // passive descendant (the `roster_subscribe` seed walks it), so the
    // attached parent renders the subagent summary box from the real daemon.
    let ledger = pa_daemon::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &session_dir, |_m| {});
    ledger
        .append_spawn(&pa_daemon::rlm_ledger::RlmSpawnInput {
            child_id: "panel-nav-child".to_string(),
            parent: parent_path.to_string_lossy().to_string(),
            child: child_path.to_string_lossy().to_string(),
            depth: 1,
            name: "panel nav worker".to_string(),
        })
        .expect("append spawn edge");

    // Run 1 — the attached parent's main chat: Down at the end of the empty
    // prompt focuses the activity dock, and Enter opens the scoped agents
    // view DIRECTLY (the operator's direct-navigation redesign — the
    // grouped activity panel is gone, no intermediate step).
    let parent_options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Resume(parent_path.clone()),
        None,
        true,
    );
    let parent_plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Down,
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
        ],
        width: 120,
        height: 36,
    };
    let parent_run =
        pa_tui::interactive::run_interactive(parent_options, UiMode::Headless(parent_plan))
            .await
            .expect("parent session run");

    // The dock renders at attach as the one-line activity row (unfocused,
    // hint-free by design; Enter is the direct launcher). The subagents
    // segment reads `\u{25c6} N subagents` — one consolidated item (the
    // operator's 2026-09-25 consolidation), the running count riding
    // the label in the dock's color: the passivated child is finished,
    // so the count reads zero — the dock stays mounted and selectable
    // because the child remains browsable history.
    let attached = first_frame_of(&parent_run.frames, "subagent");
    assert!(
        attached.contains("\u{25c6} 0 subagents"),
        "the unfocused dock shows the consolidated subagents segment:\n{attached}"
    );
    // The single Enter opened the scoped agents view directly: no
    // grouped panel frame ever renders.
    assert!(
        !parent_run
            .frames
            .iter()
            .any(|frame| frame.contains("Activity")),
        "the grouped activity panel never opens (the direct-navigation redesign)"
    );
    assert!(
        parent_run.return_to_agents_view,
        "the dock's Enter hands the pane to the scoped agents view"
    );
    let scope = parent_run
        .agents_view_scope
        .clone()
        .expect("the open came from the dock's direct navigation (scoped)");

    // Run 2 — the scoped agents view: the child lists as the root's direct
    // child, and Enter drills into its transcript.
    let view_options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: Some(scope),
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
    let view_plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let view = pa_tui::agents_view::run_agents_view(
        view_options,
        AgentsViewUiMode::Headless(view_plan),
        None,
    )
    .await
    .expect("scoped agents view run")
    .outcome;
    let scoped = frame_of(&view.frames, "panel nav worker");
    assert!(
        scoped.contains("panel nav parent") || scoped.contains("subagent"),
        "the scoped view lists the child under the parent's subtree:\n{scoped}"
    );
    assert_eq!(
        view.selection,
        Some(SessionSelection::Resume(child_path.clone())),
        "Enter on the child row opened the child's transcript"
    );
    // The scoped view lists the child as a top-level row (the scope root is
    // excluded from its own subtree), so the open carries no ancestor
    // expansion chain — the return re-entry lands back in the scope frame
    // (TS `openSelected` on a direct scoped child).
    assert!(
        view.expanded_ancestors.is_empty(),
        "a direct scoped child carries no expansion ancestors: {:?}",
        view.expanded_ancestors
    );
    assert_eq!(view.opened_rlm_depth, Some(1), "the child's rlmDepth");

    // Run 3 — the child's transcript: its rows render with the `depth 1`
    // tray label, and the agents-back key returns to the agents view (the
    // TS escape path back from the nested transcript).
    let child_options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Resume(child_path.clone()),
        view.opened_rlm_depth,
        view.opened_has_children,
    );
    let child_plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            pa_tui::interactive::HeadlessStep::ScrollTop,
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Left,
                crossterm::event::KeyModifiers::NONE,
            )),
        ],
        width: 120,
        height: 36,
    };
    let child_run =
        pa_tui::interactive::run_interactive(child_options, UiMode::Headless(child_plan))
            .await
            .expect("child session run");
    let child_frame = frame_of(&child_run.frames, "work complete alpha");
    assert!(
        child_frame.contains("\u{2190} manage  depth 1"),
        "the drilled-in child tray shows the manage hint and its depth:\n{child_frame}"
    );
    assert!(
        child_run.return_to_agents_view,
        "the agents-back key returned to the view"
    );
}

/// The attached parent's top bar bills the ledger-seeded passive child's
/// spend: the parent's own $1.00 plus the child's $0.30.
#[tokio::test]
async fn the_title_bills_a_passive_subagents_spend() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The family fixture: the parent and its ledger-linked child, each
    // with one billed assistant turn (the parent $1.00, the child $0.30).
    let parent_path = write_fixture(
        &session_dir,
        "title-bill-parent",
        "title bill parent",
        None,
        0,
        &[],
    );
    let child_path = write_fixture(
        &session_dir,
        "title-bill-worker",
        "title bill worker",
        Some(&parent_path),
        1,
        &[],
    );
    for (path, id, input, output, cost) in [
        (&parent_path, "pm1a", 100, 10, 1.0),
        (&child_path, "cm1a", 50, 5, 0.3),
    ] {
        append_billed_turn(path, id, input, output, cost);
    }

    // The durable spawn edge: the roster surfaces the child as the
    // parent's passive descendant, so the attached parent's title rolls
    // the child's spend up from the real daemon's seeded row.
    let ledger = pa_daemon::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &session_dir, |_m| {});
    ledger
        .append_spawn(&pa_daemon::rlm_ledger::RlmSpawnInput {
            child_id: "title-bill-child".to_string(),
            parent: parent_path.to_string_lossy().to_string(),
            child: child_path.to_string_lossy().to_string(),
            depth: 1,
            name: "title bill worker".to_string(),
        })
        .expect("append spawn edge");

    let options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Resume(parent_path.clone()),
        None,
        true,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "$1.30".to_string(),
                timeout_ms: 15_000,
            },
        ],
        width: 120,
        height: 36,
    };
    let run = pa_tui::interactive::run_interactive(options, UiMode::Headless(plan))
        .await
        .expect("parent session run");
    // The top bar row (render_top_bar): the chat name plus one cost span,
    // the family rollup - the parent's own $1.00 plus the passive child's
    // $0.30 - with no split.
    let top_bar = frame_of(&run.frames, "$1.30")
        .lines()
        .next()
        .expect("the top bar row")
        .to_string();
    assert!(
        top_bar.contains("title bill parent") && top_bar.contains("$1.30"),
        "the top bar bills the family rollup beside the chat name:\n{top_bar}"
    );
}

/// The attached parent's top bar bills a deleted subagent's spend: the
/// RLM-deleted child keeps its transcript under session-artifacts (no
/// catalog row exists for it), so its captured spend rides the parent's
/// roster row through the deleted-descendant bucket. This test asserts
/// the top bar; the agents-view row reads the same row through the same
/// `compute_rollups`, so it bills the same number.
#[tokio::test]
async fn the_title_bills_a_deleted_subagents_spend() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The parent ($1.00 own) and its child, whose transcript lives under
    // the parent's session-artifacts tree (the real RLM child location:
    // the flat catalog never lists it, so the child has no row anywhere).
    let parent_path = write_fixture(
        &session_dir,
        "title-del-parent",
        "title del parent",
        None,
        0,
        &[],
    );
    let child_dir = agent_dir
        .join("session-artifacts")
        .join("title-del-parent")
        .join("title-del-child");
    std::fs::create_dir_all(&child_dir).expect("child artifacts dir");
    let child_path = write_fixture(
        &child_dir,
        "title-del-worker",
        "title del worker",
        Some(&parent_path),
        1,
        &[],
    );
    // The billed turns: the parent $1.00, the deleted child $0.30.
    append_billed_turn(&parent_path, "dm1a", 100, 10, 1.0);
    append_billed_turn(&child_path, "dm1c", 50, 5, 0.3);

    // The durable spawn edge plus the RLM delete's tombstone carrying
    // the captured usage (the amendment the stop finalize appends after
    // the flush barrier): the child's spend survives the deletion.
    let ledger = pa_daemon::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &session_dir, |_m| {});
    ledger
        .append_spawn(&pa_daemon::rlm_ledger::RlmSpawnInput {
            child_id: "title-del-child".to_string(),
            parent: parent_path.to_string_lossy().to_string(),
            child: child_path.to_string_lossy().to_string(),
            depth: 1,
            name: "title del worker".to_string(),
        })
        .expect("append spawn edge");
    ledger
        .append_delete_with_usage(
            "title-del-child",
            &child_path.to_string_lossy(),
            pa_daemon::rlm_ledger::RlmLedgerDeleteReason::User,
            &pa_daemon::session_usage::SessionUsageSummary {
                input_tokens: 50,
                output_tokens: 5,
                cost: 0.3,
            },
        )
        .expect("append delete tombstone");

    let options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Resume(parent_path.clone()),
        None,
        true,
    );
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "$1.30".to_string(),
                timeout_ms: 15_000,
            },
        ],
        width: 120,
        height: 36,
    };
    let run = pa_tui::interactive::run_interactive(options, UiMode::Headless(plan))
        .await
        .expect("parent session run");
    // The top bar row (render_top_bar): the parent's own $1.00 plus the
    // deleted child's $0.30, the family rollup - the child's spend
    // bills through the bucket even though no row exists for it.
    let top_bar = frame_of(&run.frames, "$1.30")
        .lines()
        .next()
        .expect("the top bar row")
        .to_string();
    assert!(
        top_bar.contains("title del parent") && top_bar.contains("$1.30"),
        "the top bar bills the family rollup beside the chat name:\n{top_bar}"
    );
}

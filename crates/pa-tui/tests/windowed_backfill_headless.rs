#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

const HISTORY_MESSAGES: usize = 4;
const HISTORY_LEAF_ID: &str = "attached-branch-leaf";

enum RebuildResponse {
    FullHistory,
    Reject,
}

struct MockSupervisor {
    listener: UnixListener,
    windowed: bool,
    failures: usize,
    /// Hold the history backfill page instead of answering it: the plan then
    /// leaves the request in flight across an exit or a transcript rebuild.
    hold_backfill: bool,
    rebuild_response: RebuildResponse,
    history_leaf_id: Option<&'static str>,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, windowed: bool, requests: Arc<Mutex<Vec<Value>>>) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            windowed,
            failures: 0,
            hold_backfill: false,
            rebuild_response: RebuildResponse::FullHistory,
            history_leaf_id: Some(HISTORY_LEAF_ID),
            requests,
        }
    }

    fn serve(mut self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let mut writer = stream.try_clone().expect("clone mock socket");
        let mut reader = BufReader::new(stream);
        let mut held_backfill: Option<String> = None;

        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
            "clientId": "mock",
        });
        write_json(&mut writer, &hello);

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
                .unwrap_or_default();
            match command_type {
                "attach" => {
                    write_json(&mut writer, &attach_response(id, self.windowed));
                }
                "get_messages" => {
                    self.requests.lock().unwrap().push(command.clone());
                    if self.failures > 0 {
                        self.failures -= 1;
                        write_json(&mut writer, &history_failure(id));
                        continue;
                    }
                    if command["page"].get("before").is_some() {
                        if self.hold_backfill {
                            held_backfill = Some(id.to_string());
                            // The frame is proof the server received this request;
                            // the headless plan cannot leave or reload before it.
                            write_json(
                                &mut writer,
                                &json!({
                                    "type": "session_event", "activeSessionId": "s1",
                                    "event": {"type": "message_end", "message": {
                                        "role": "assistant", "content": [{"type": "text", "text": "backfill request received"}],
                                    }},
                                }),
                            );
                            continue;
                        }
                        write_json(&mut writer, &get_messages_response(id, &self));
                        continue;
                    }
                    if matches!(self.rebuild_response, RebuildResponse::Reject) {
                        write_json(&mut writer, &history_failure(id));
                        continue;
                    }
                    // A cursor-less page is a transcript rebuild. Release the
                    // obsolete response before it; the separate unit regression
                    // injects an already-queued note to verify the epoch fence.
                    if let Some(held) = held_backfill.take() {
                        write_json(&mut writer, &get_messages_response(&held, &self));
                    }
                    write_json(&mut writer, &whole_head_response(id));
                }
                "get_session_stats" => {
                    write_json(
                        &mut writer,
                        &success_response(
                            id,
                            "get_session_stats",
                            &json!({
                                "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
                                "cost": 0.01,
                            }),
                        ),
                    );
                }
                _ => {
                    write_json(&mut writer, &success_response(id, command_type, &json!({})));
                }
            }
        }
    }
}

fn history_failure(id: &str) -> Value {
    json!({
        "type": "response", "id": id, "command": "get_messages",
        "success": false, "error": "temporary history rejection",
    })
}

fn success_response(id: &str, command: &str, data: &Value) -> Value {
    json!({
        "type": "response", "id": id, "command": command,
        "success": true, "data": data,
    })
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn message(index: usize) -> Value {
    let marker = format!("msg-{index:02}");
    let body =
        format!("{marker} line one\n{marker} line two\n{marker} line three\n{marker} line four");
    let timestamp = 100 + index;
    if index.is_multiple_of(2) {
        json!({ "role": "user", "content": body, "timestamp": timestamp })
    } else {
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": body }],
            "timestamp": timestamp,
        })
    }
}

fn all_messages() -> Vec<Value> {
    (0..16).map(message).collect()
}

fn attach_response(id: &str, windowed: bool) -> Value {
    let messages = all_messages();
    let (snapshot_messages, history_before) = if windowed {
        (messages[4..].to_vec(), json!(entry_id(HISTORY_MESSAGES)))
    } else {
        (messages, Value::Null)
    };
    let mut snapshot = json!({
        "activeSessionId": "s1",
        "summary": { "id": "s1", "cwd": "/tmp" },
        "state": {
            "activeSessionId": "s1",
            "cwd": "/tmp",
            "sessionId": "sess-1",
            "sessionName": "backfill probe",
            "model": "faux-1",
            "isStreaming": false,
            "isCompacting": false,
            "compactionCount": 0,
            "leafId": HISTORY_LEAF_ID,
            "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
        },
        "messages": snapshot_messages,
        "lastEventSequence": 0,
        "lastEventCursor": null,
    });
    if windowed {
        snapshot["historyBeforeEntryId"] = history_before;
        snapshot["lastUserPromptMs"] = json!(114u64);
    }
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "s1",
            "snapshot": snapshot,
            "replay": { "status": "complete", "toSequence": 0 },
            "lastEventSequence": 0,
            "lastEventCursor": null,
            "client": { "id": "mock", "capabilities": [] },
        },
    })
}

fn get_messages_response(id: &str, supervisor: &MockSupervisor) -> Value {
    let messages = if supervisor.windowed {
        all_messages()[..4].to_vec()
    } else {
        Vec::new()
    };
    let mut response = json!({
        "type": "response",
        "id": id,
        "command": "get_messages",
        "success": true,
        "data": {
            "messages": messages,
            "firstEntryId": entry_id(0),
            "lastEntryId": entry_id(HISTORY_MESSAGES - 1),
            "more": false,
        },
    });
    if let Some(history_leaf_id) = supervisor.history_leaf_id {
        response["data"]["historyLeafId"] = json!(history_leaf_id);
    }
    response
}

fn whole_head_response(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "get_messages",
        "success": true,
        "data": {
            "messages": all_messages(),
            "firstEntryId": entry_id(0),
            "lastEntryId": entry_id(15),
            "more": false,
            "historyLeafId": HISTORY_LEAF_ID,
        },
    })
}

fn entry_id(index: usize) -> String {
    format!("e{index:02}")
}

fn options(socket: PathBuf) -> InteractiveOptions {
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
        session: SessionSelection::Attach("s1".to_string()),
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

fn run_attached(windowed: bool, steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<Value>) {
    run_attached_with_failures(windowed, /*failures*/ 0, steps)
}

fn run_attached_with_failures(
    windowed: bool,
    failures: usize,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<Value>) {
    run_attached_with_validation(windowed, failures, Some(HISTORY_LEAF_ID), steps)
}

fn run_attached_with_validation(
    windowed: bool,
    failures: usize,
    history_leaf_id: Option<&'static str>,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<Value>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut supervisor = MockSupervisor::bind(&socket, windowed, Arc::clone(&requests));
    supervisor.failures = failures;
    supervisor.history_leaf_id = history_leaf_id;
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 100,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let requests = requests.lock().unwrap().clone();
    (outcome.frames, requests)
}

fn run_attached_holding_backfill(
    windowed: bool,
    rebuild_response: RebuildResponse,
    height: u16,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<Value>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut supervisor = MockSupervisor::bind(&socket, windowed, Arc::clone(&requests));
    supervisor.hold_backfill = true;
    supervisor.rebuild_response = rebuild_response;
    let (served_tx, served_rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || {
        supervisor.serve();
        let _ = served_tx.send(());
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    assert!(
        outcome
            .frames
            .iter()
            .any(|frame| frame.contains("backfill request received")),
        "the plan observed the held request receipt"
    );
    assert!(
        !outcome
            .frames
            .iter()
            .any(|frame| frame.contains("timed out waiting")),
        "readiness barriers completed without timeouts"
    );
    served_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the run returned, but the mock supervisor socket never closed: the obsolete transcript backfill task still holds the daemon connection");
    handle.join().expect("mock supervisor finished");
    let requests = requests.lock().unwrap().clone();
    (outcome.frames, requests)
}

fn first_marker_line(frame: &str) -> Option<String> {
    frame
        .lines()
        .find(|line| line.contains("msg-"))
        .map(|line| {
            line.split_whitespace()
                .find(|word| word.starts_with("msg-"))
                .expect("marker token")
                .to_string()
        })
}

/// The history rows a frame renders, top to bottom: one entry per row, since a
/// row's body repeats its marker across wrapped lines.
fn collapsed_markers(frame: &str) -> Vec<String> {
    frame
        .split_whitespace()
        .filter(|token| token.starts_with("msg-"))
        .fold(Vec::new(), |mut rows: Vec<String>, token| {
            if rows.last().is_none_or(|last| last != token) {
                rows.push(token.to_string());
            }
            rows
        })
}

#[test]
fn a_windowed_open_backfills_history_above_the_tail() {
    let (frames, requests) = run_attached(
        true,
        vec![
            HeadlessStep::WaitRender {
                needle: "msg-00".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::ScrollTop,
            HeadlessStep::WaitRender {
                needle: "msg-00".to_string(),
                timeout_ms: 5000,
            },
        ],
    );
    assert!(!frames.is_empty(), "frames were captured");
    assert!(
        frames[0].contains("msg-15"),
        "the first frame renders the tail's bottom: {}",
        frames[0]
    );
    assert!(
        !frames[0].contains("msg-00"),
        "the windowed first frame holds no head rows: {}",
        frames[0]
    );
    let final_frame = frames.last().expect("the settled frame renders");
    assert_eq!(
        first_marker_line(final_frame).as_deref(),
        Some("msg-00"),
        "the true top renders the first message: {final_frame}"
    );
    assert_eq!(requests.len(), 1, "exactly one backfill request");
    assert_eq!(
        requests[0]["page"]["before"],
        json!(entry_id(HISTORY_MESSAGES)),
        "the backfill requests the omitted history range"
    );
    assert_eq!(
        requests[0]["historyLeafId"],
        json!(HISTORY_LEAF_ID),
        "the prefix request stays anchored to the attached branch"
    );
}

#[test]
fn an_unverified_history_leaf_echo_keeps_the_attached_tail_and_reports_incomplete_history() {
    // An older worker omits the echo; a wrong echo belongs to another branch.
    // Both otherwise return a successful prefix and matching session/compaction
    // state, so only the branch-anchor validation can reject these responses.
    for history_leaf_id in [None, Some("another-branch-leaf")] {
        let (frames, requests) = run_attached_with_validation(
            /*windowed*/ true,
            /*failures*/ 0,
            history_leaf_id,
            vec![HeadlessStep::WaitRender {
                needle: "History could not be loaded".to_string(),
                timeout_ms: 5000,
            }],
        );
        assert_eq!(
            requests.len(),
            1,
            "unverified branch history is not retried"
        );
        assert!(
            frames
                .iter()
                .any(|frame| frame.contains("History could not be loaded")),
            "an absent or wrong history anchor must fail visibly: {history_leaf_id:?}"
        );
        assert_eq!(requests[0]["historyLeafId"], json!(HISTORY_LEAF_ID));
        assert!(
            !frames
                .iter()
                .any(|frame| frame.contains("timed out waiting")),
            "the warning is an observed result, not a headless timeout"
        );
        assert!(
            frames.iter().all(|frame| (0..HISTORY_MESSAGES)
                .all(|index| !frame.contains(&format!("msg-{index:02}")))),
            "no frame may expose the unverified prefix"
        );
        assert_eq!(
            collapsed_markers(frames.last().expect("the warning frame renders")),
            (HISTORY_MESSAGES..16)
                .map(|index| format!("msg-{index:02}"))
                .collect::<Vec<_>>(),
            "the complete attached tail remains ordered and visible"
        );
    }
}

#[test]
fn a_full_snapshot_attach_never_backfills() {
    let (frames, requests) = run_attached(
        false,
        vec![
            HeadlessStep::ScrollTop,
            HeadlessStep::WaitRender {
                needle: "msg-00".to_string(),
                timeout_ms: 5000,
            },
        ],
    );
    assert!(!frames.is_empty(), "frames were captured");
    assert!(
        frames[0].contains("msg-15"),
        "the full snapshot's first frame renders the tail: {}",
        frames[0]
    );
    assert!(
        frames.iter().any(|frame| frame.contains("msg-00")),
        "the full history is reachable by scrolling"
    );
    assert!(
        requests.is_empty(),
        "a complete snapshot never backfills: {requests:?}"
    );
}

#[test]
fn a_rejected_backfill_retries_then_reports_incomplete_history() {
    let (frames, requests) = run_attached_with_failures(
        true,
        /*failures*/ 2,
        vec![HeadlessStep::WaitRender {
            needle: "History could not be loaded".to_string(),
            timeout_ms: 5000,
        }],
    );
    assert!(frames
        .iter()
        .any(|frame| frame.contains("History could not be loaded")));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1]);
}

#[test]
fn an_exit_with_backfill_in_flight_releases_the_daemon_connection() {
    let (frames, requests) = run_attached_holding_backfill(
        /*windowed*/ true,
        RebuildResponse::FullHistory,
        30,
        vec![HeadlessStep::WaitRender {
            needle: "backfill request received".to_string(),
            timeout_ms: 5000,
        }],
    );
    assert_eq!(
        requests.len(),
        1,
        "the held history request stayed in flight across the run: {requests:?}"
    );
    assert_eq!(
        requests[0]["page"]["before"],
        json!(entry_id(HISTORY_MESSAGES)),
        "the windowed attach armed exactly the history backfill: {requests:?}"
    );
    assert!(!frames.is_empty(), "frames were captured");
    assert!(
        frames[0].contains("msg-15"),
        "the windowed first frame renders the tail's bottom: {}",
        frames[0]
    );
}

#[test]
fn a_reload_rebuild_during_an_in_flight_backfill_keeps_rows_unique_and_ordered() {
    let (frames, requests) = run_attached_holding_backfill(
        /*windowed*/ true,
        RebuildResponse::FullHistory,
        50,
        vec![
            HeadlessStep::WaitRender {
                needle: "backfill request received".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::Submit("/reload".to_string()),
            HeadlessStep::WaitRender {
                needle: "Reloaded keybindings, skills, prompts, themes".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitGone {
                needle: "backfill request received".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::ScrollTop,
            HeadlessStep::WaitRender {
                needle: "msg-00".to_string(),
                timeout_ms: 5000,
            },
        ],
    );
    assert_eq!(
        requests.len(),
        2,
        "one held backfill page plus the reload's whole-head rebuild: {requests:?}"
    );
    assert_eq!(
        requests[0]["page"]["before"],
        json!(entry_id(HISTORY_MESSAGES)),
        "the backfill page carries the history cursor: {requests:?}"
    );
    assert!(
        requests[1]["page"].get("before").is_none(),
        "the rebuild fetches the whole head without a cursor: {requests:?}"
    );
    for (index, frame) in frames.iter().enumerate() {
        let markers = collapsed_markers(frame);
        assert!(
            markers.windows(2).all(|pair| pair[0] < pair[1]),
            "frame {index} renders a history row twice or out of order: {frame}"
        );
    }
    let final_frame = frames.last().expect("the settled frame renders");
    assert_eq!(
        first_marker_line(final_frame).as_deref(),
        Some("msg-00"),
        "the rebuild's true top renders the first message: {final_frame}"
    );
}

#[test]
fn a_failed_rebuild_reports_cancelled_incomplete_history() {
    let (frames, requests) = run_attached_holding_backfill(
        /*windowed*/ true,
        RebuildResponse::Reject,
        100,
        vec![
            HeadlessStep::WaitRender {
                needle: "backfill request received".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::Submit("/reload".to_string()),
            HeadlessStep::WaitRender {
                needle: "Transcript refresh failed; displayed history may be incomplete or stale"
                    .to_string(),
                timeout_ms: 5000,
            },
        ],
    );
    assert_eq!(
        requests.len(),
        2,
        "held prefix and failed whole-history rebuild only"
    );
    assert_eq!(
        requests[0]["page"]["before"],
        json!(entry_id(HISTORY_MESSAGES))
    );
    assert!(
        requests[1]["page"].get("before").is_none(),
        "the cancelled positional cursor is never rearmed"
    );
    assert!(
        frames.iter().any(|frame| frame
            .contains("Transcript refresh failed; displayed history may be incomplete or stale")),
        "a failed rebuild must disclose that older history is unavailable"
    );
    let last = frames.last().unwrap();
    assert!(last.contains("msg-15"), "loaded tail stays visible");
    assert!(!last.contains("msg-00"), "the held prefix was never loaded");
}

//! Headless perf verifier for mouse drag-selection: the per-frame cost of a drag is independent of
//! the session size (a drag frame restyles the visible cached rows' selection diff, never the
//! transcript geometry). The budget measures a 100-drag burst after the initial viewport is
//! rendered, excluding cold attach/setup and teardown on both session sizes; each session size
//! samples several marker-bracketed drag runs, and the budget compares the least
//! load-contaminated sample of each size (see `drag_cost`).
#![cfg(unix)]
// Casts: structurally bounded terminal-layout arithmetic; guarded conversions add panic paths.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Render routes are flat tables (one arm per route); splitting adds indirection.
#![allow(clippy::too_many_lines)]
// Widget state structs carry independent flag bits.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// Futures are bounded by the surface's lifetime; boxing adds a steady-state allocation.
#![allow(clippy::large_futures)]
// The wrappers preserve a uniform Result-returning API surface.
#![allow(clippy::unnecessary_wraps)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize.
static RUN_LOCK: Mutex<()> = Mutex::new(());

fn run_lock() -> MutexGuard<'static, ()> {
    match RUN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The SGR reports a real terminal sends with ?1002+?1006 tracking active.
fn press(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}M")
}

fn drag(col: usize, row: usize) -> String {
    format!("\x1b[<32;{col};{row}M")
}

fn release(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}m")
}

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    fn serve(self, messages: usize) {
        let (stream, _) = self.listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);

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
                    write_json(&mut writer, &attach_data(id, messages));
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

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The slim attach result: `messages` alternating user/assistant messages with ~9KB bodies each
/// (`messages == 4000` approximates the 42MB dogfood session; the small control uses 40).
fn attach_data(id: &str, messages: usize) -> Value {
    let body: Vec<Value> = (0..messages)
        .map(|index| {
            let big = "lorem ipsum dolor sit amet ".repeat(350);
            if index % 2 == 0 {
                json!({ "role": "user", "content": [{ "type": "text", "text": format!("row {index} {big}") }] })
            } else {
                json!({ "role": "assistant", "content": [{ "type": "text", "text": format!("answer {index} {big}") }] })
            }
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
                    "sessionName": "drag perf session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": body,
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
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
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        client_settings: None,
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
    }
}

fn run_plan(messages: usize, steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<String>) {
    let _guard = run_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve(messages));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    let _ = handle.join();
    (outcome.frames, outcome.copies)
}

/// The scroll-paused drag burst: mount the window at the transcript top, then press-drag-release
/// across the first rows. The chat opens directly into content (the operator's 2026-09-26
/// zero-shift directive), so the first user message's text row is row 3 (SGR 0-based 2).
fn drag_burst(
    timing: Option<std::sync::mpsc::Sender<(std::time::Instant, usize)>>,
) -> Vec<HeadlessStep> {
    let mut steps = vec![HeadlessStep::ScrollTop];
    if let Some(sender) = &timing {
        steps.push(HeadlessStep::Timestamp(sender.clone()));
    }
    steps.push(HeadlessStep::Mouse(press(3, 3)));
    for index in 0..100 {
        steps.push(HeadlessStep::Mouse(drag(3 + (index % 40), 3 + (index % 6))));
    }
    steps.push(HeadlessStep::Mouse(release(43, 8)));
    if let Some(sender) = timing {
        steps.push(HeadlessStep::Timestamp(sender));
    }
    steps
}

fn timed_drag(messages: usize) -> (Vec<String>, Vec<String>, Duration, usize) {
    let (timing_tx, timing_rx) = std::sync::mpsc::channel();
    let (frames, copies) = run_plan(messages, drag_burst(Some(timing_tx)));
    let markers: Vec<_> = timing_rx.try_iter().collect();
    let [(started, first_render), (finished, last_render)]: [(std::time::Instant, usize); 2] =
        markers
            .try_into()
            .expect("the rendered drag burst records both timing boundaries");
    let elapsed = finished
        .checked_duration_since(started)
        .expect("timing markers arrive in monotonic order");
    (frames, copies, elapsed, last_render - first_render)
}

#[test]
fn timing_checkpoints_preserve_rendered_frames_and_copies() {
    let expected = run_plan(40, drag_burst(None));
    let (frames, copies, ..) = timed_drag(40);
    assert_eq!((frames, copies), expected);
}

/// How many marker-bracketed drag runs each session size samples after its discarded warm-up run.
const MEASURED_RUNS: usize = 3;

/// One session size's drag-burst cost: the minimum marker-bracketed drag interval across
/// `MEASURED_RUNS` measured runs, preceded by one discarded warm-up run. Every measured run
/// must first prove it rendered the full burst and copied the same selection — the minimum is
/// taken only over validated runs, so an incomplete run can never win it.
///
/// The interval's boundaries are timing markers consumed on the UI loop: it covers press, every
/// drag frame, release/copy and its final frame, and excludes the separately variable cold
/// attach/initial viewport work and teardown. Wall-clock noise on a loaded shared runner only
/// ever adds time, so the minimum over several runs is the robust estimate of the drag's own
/// cost. The guard stays real: a session-size regression inflates every run (a burst that
/// resolves the transcript once per frame adds seconds to each), so the minimum still trips the
/// bounds.
fn drag_cost(messages: usize) -> (Duration, Vec<Duration>, String) {
    // The warm-up run primes the page cache and allocator arenas (the process's first run
    // reads about 2x its steady state); its numbers are discarded.
    let _ = run_plan(messages, drag_burst(None));

    let mut intervals = Vec::with_capacity(MEASURED_RUNS);
    let mut extracted = String::new();
    for run in 0..MEASURED_RUNS {
        let (frames, copies, drag, renders) = timed_drag(messages);
        // The plain-text frame capture dedupes and strips styles, so a selection restyle adds
        // no frame: the markers carry the render invocation count as the drag-render witness.
        // Press, every drag, and release each render once, so fewer than 102 renders between
        // the markers means the burst was skipped or coalesced, not measured.
        assert!(
            !frames.is_empty(),
            "the headless capture recorded the run's frames"
        );
        assert!(
            renders >= 102,
            "the measured run rendered {renders} times — press, 100 drags, and release must \
             each render individually"
        );
        assert_eq!(copies.len(), 1, "each drag burst copies once");
        let text = copies.concat();
        // The fixed coordinates pin the expected copy: the press (row 3, col 3) anchors the
        // selection in message 0's wrapped block ("row 0 lorem ipsum ..."), the drag rows
        // extend it down through the block's wrapped rows, and the release never crosses
        // into message 1 ("answer 1 ..."). A one-row copy, or one leaking the next message,
        // means the drag never extended the selection — the run is not measuring a drag.
        assert!(
            text.starts_with("row 0 lorem"),
            "the selection anchored at the pressed row: {:?}",
            &text[..text.len().min(40)]
        );
        assert!(
            text.lines().count() > 1,
            "the selection extended beyond the pressed row: {:?}",
            &text[..text.len().min(80)]
        );
        assert!(
            !text.contains("answer 1"),
            "the drag stayed inside the pressed message's block: {:?}",
            &text[..text.len().min(80)]
        );
        if run == 0 {
            extracted = text;
        } else {
            assert_eq!(
                text, extracted,
                "every measured run copies the same selection"
            );
        }
        intervals.push(drag);
    }
    let best = *intervals.iter().min().expect("at least one measured run");
    (best, intervals, extracted)
}

#[test]
fn drag_select_frame_cost_is_independent_of_session_size() {
    let small = 40usize;
    let large = 4000usize;

    let (small_cost, small_samples, small_copy) = drag_cost(small);
    let (large_cost, large_samples, large_copy) = drag_cost(large);

    // The copies read the same text both sizes: the drag extracts the spanned rows through the
    // same coordinates on either session.
    assert_eq!(
        large_copy, small_copy,
        "the large session drags the same rows"
    );

    // The drag path's own cost (marker-bracketed interval, minimum over the sampled runs) stays
    // in the same band on either session: no per-frame geometry resolve scales it with the
    // transcript.
    assert!(
        large_cost < small_cost + Duration::from_millis(250),
        "the large session's drag cost (best of {large_samples:?}) must stay within \
         250ms of the small session's (best of {small_samples:?})"
    );
    assert!(
        large_cost < Duration::from_millis(500),
        "100 drag frames on a ~40MB session cost {large_cost:?} \
         (samples {large_samples:?}) — the per-frame cost is not session-size independent \
         (the pre-fix release alone resolved the full geometry once per copy)"
    );
}

use std::time::Duration;

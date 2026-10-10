//! Headless perf verifier for mouse drag-selection: the per-frame cost of a drag is independent of
//! the session size (a drag frame restyles the visible cached rows' selection diff, never the
//! transcript geometry). The budget compares a 100-drag burst vs. a no-drag baseline and a small
//! session; each session size samples several (baseline, drag) pairs, and the budget compares
//! the least load-contaminated sample of each size (see `drag_excess`).
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

fn run_plan(
    messages: usize,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<String>, std::time::Duration) {
    let _guard = run_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve(messages));
    let started = std::time::Instant::now();
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
    let elapsed = started.elapsed();
    let _ = handle.join();
    (outcome.frames, outcome.copies, elapsed)
}

/// The scroll-paused drag burst: mount the window at the transcript top, then press-drag-release
/// across the first rows. The chat opens directly into content (the operator's 2026-09-26
/// zero-shift directive), so the first user message's text row is row 3 (SGR 0-based 2).
fn drag_burst() -> Vec<HeadlessStep> {
    let mut steps = vec![HeadlessStep::ScrollTop];
    steps.push(HeadlessStep::Mouse(press(3, 3)));
    for index in 0..100 {
        steps.push(HeadlessStep::Mouse(drag(3 + (index % 40), 3 + (index % 6))));
    }
    steps.push(HeadlessStep::Mouse(release(43, 8)));
    steps
}

/// One no-drag baseline of the same session shape: the drag burst's excess over this is the
/// selection path's own cost.
fn baseline() -> Vec<HeadlessStep> {
    vec![HeadlessStep::ScrollTop]
}

/// How many (baseline, drag) pairs each session size samples after its discarded warm-up pair.
const MEASURED_PAIRS: usize = 3;

/// One session size's drag-burst cost: the minimum excess across `MEASURED_PAIRS` measured
/// (baseline, drag) pairs, preceded by one discarded warm-up pair.
///
/// A single pair's excess is the true drag-burst cost plus the pair's differential wall-clock
/// noise, and the large session's ~40MB attach makes that differential spike hundreds of ms to
/// seconds on loaded shared runners — the CI flake class (identical failures on pure main and
/// on PRs with no drag-path commits). A one-pair budget flakes on the load spike, not the drag.
/// The minimum over several pairs rejects the positive spikes; its residual error is a negative
/// differential bounded by one baseline run's own noise, an order of magnitude below the signal
/// the guard exists to catch. The guard stays real: a session-size regression inflates every
/// pair (a burst that resolves the transcript once per frame adds seconds to each), so the
/// minimum still trips the bounds.
fn drag_excess(messages: usize) -> (Duration, Vec<Duration>, String) {
    // The warm-up pair primes the page cache and allocator arenas (the process's first run
    // reads about 2x its steady state); its numbers are discarded.
    let _ = run_plan(messages, baseline());
    let _ = run_plan(messages, drag_burst());

    let mut excesses = Vec::with_capacity(MEASURED_PAIRS);
    let mut extracted = String::new();
    for pair in 0..MEASURED_PAIRS {
        let (_, _, baseline) = run_plan(messages, baseline());
        let (frames, copies, drag) = run_plan(messages, drag_burst());
        // The headless capture renders per change: the drag frames flowed.
        assert!(!frames.is_empty(), "the drag burst rendered frames");
        assert_eq!(copies.len(), 1, "each drag burst copies once");
        assert!(
            copies[0].starts_with("row 0"),
            "the copy reads the pressed row: {:?}",
            &copies[0][..copies[0].len().min(40)]
        );
        if pair == 0 {
            extracted = copies.concat();
        }
        excesses.push(drag.saturating_sub(baseline));
    }
    let best = *excesses.iter().min().expect("at least one measured pair");
    (best, excesses, extracted)
}

#[test]
fn drag_select_frame_cost_is_independent_of_session_size() {
    let small = 40usize;
    let large = 4000usize;

    let (small_excess, small_samples, small_copy) = drag_excess(small);
    let (large_excess, large_samples, large_copy) = drag_excess(large);

    // The copies read the same text both sizes: the drag extracts the spanned rows through the
    // same coordinates on either session.
    assert_eq!(
        large_copy, small_copy,
        "the large session drags the same rows"
    );

    // The drag path's own cost (burst minus baseline, minimum over the sampled pairs) stays in
    // the same band on either session: no per-frame geometry resolve scales it with the
    // transcript.
    assert!(
        large_excess < small_excess + Duration::from_millis(250),
        "the large session's drag excess (best of {large_samples:?}) must stay within \
         250ms of the small session's (best of {small_samples:?})"
    );
    assert!(
        large_excess < Duration::from_millis(500),
        "100 drag frames on a ~40MB session cost {large_excess:?} \
         (samples {large_samples:?}) — the per-frame cost is not session-size independent \
         (the pre-fix release alone resolved the full geometry once per copy)"
    );
}

use std::time::Duration;

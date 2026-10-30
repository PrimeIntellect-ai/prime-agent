//! Headless e2e for the in-app mouse selection surface (TS
//! `handleFullscreenInput`): a press-drag-release over transcript rows
//! copies the spanned text (recorded `copies` stand in for the OSC 52
//! write); a dock press starts a frame selection; a plain click copies nothing.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize (each asserts on the
/// tracking-active branch it drives).
static RUN_LOCK: Mutex<()> = Mutex::new(());

fn run_lock() -> MutexGuard<'static, ()> {
    match RUN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, UiMode,
};
use serde_json::{json, Value};

use support::{
    attach_response, create_response, detach_response, options, serve_connection,
    session_stats_response, write_json, MockSupervisor, Request,
};

/// The SGR reports a real terminal sends with ?1002+?1006 tracking active: a left press, a left
/// drag (button 0 + the motion bit 32), and a release.
fn press(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}M")
}

fn drag(col: usize, row: usize) -> String {
    format!("\x1b[<32;{col};{row}M")
}

fn release(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}m")
}

impl MockSupervisor {
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &attach_data(id));
                }
                "get_session_stats" => {
                    write_json(writer, &session_stats_response(id));
                }
                "prompt" => {
                    write_json(
                        writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": true,
                        }),
                    );
                }
                "detach" => {
                    write_json(writer, &detach_response(id));
                }
                _ => return false,
            }
            true
        });
    }
}

/// The slim attach result: 40 alternating one-row messages — the transcript is far taller than the
/// 30-row frame.
fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..40)
        .map(|index| {
            if index % 2 == 0 {
                json!({ "role": "user", "content": [{ "type": "text", "text": format!("row {index}") }] })
            } else {
                json!({
                    "role": "assistant",
                    "content": [{ "type": "text", "text": format!("answer {index}") }],
                })
            }
        })
        .collect();
    let mut response = attach_response(id, "mouse session");
    response["data"]["snapshot"]["messages"] = json!(messages);
    response
}

/// Run the headless plan and return the captured frames and selection copies. Holds the run lock:
/// mouse tracking is process-global.
fn run_plan(steps: Vec<HeadlessStep>, fullscreen_mouse: bool) -> (Vec<String>, Vec<String>) {
    let _guard = run_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());

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
        .block_on(run_interactive(
            InteractiveOptions {
                fullscreen_mouse,
                ..options(socket)
            },
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    let _ = handle.join();
    (outcome.frames, outcome.copies)
}

/// The last frame holding a needle and its (row, column) — the coordinates a press targets.
fn locate<'a>(frames: &'a [String], needle: &str) -> Option<(usize, usize, usize, &'a str)> {
    frames
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| {
            let rows: Vec<&str> = frame.split('\n').collect();
            let row = rows.iter().position(|r| r.contains(needle))?;
            let col = rows[row].find(needle)?;
            Some((index, row, col, frame.as_str()))
        })
        .next_back()
}

/// The transcript window at the top after `ScrollTop`: the first user message's text sits at
/// row 2, its spacer rows at 3-4, the first assistant answer at row 5 (the geometry is asserted,
/// not assumed, before each drag).
fn top_layout() -> (usize, usize, usize, usize, usize, usize) {
    let probe = run_plan(vec![HeadlessStep::ScrollTop], true).0;
    let (_, row0, col0, _) = locate(&probe, "row 0").expect("row 0 rendered at the top");
    let (_, answer_row, answer_col, _) =
        locate(&probe, "answer 1").expect("answer 1 rendered below row 0");
    let (_, ctx_row, ctx_col, _) =
        locate(&probe, "Collapsed mode").expect("the prompt-context row rendered");
    (row0, col0, answer_row, answer_col, ctx_row, ctx_col)
}

#[test]
fn press_drag_release_copies_the_spanned_transcript_text() {
    let (row0, col0, ..) = top_layout();
    assert_eq!(
        (row0, col0),
        (2, 2),
        "the first user message renders at 2:2"
    );
    let steps = vec![
        // The located press targets are valid only while the view sits at the transcript top.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(drag(col0 + 6, row0 + 1)),
        HeadlessStep::Mouse(release(col0 + 6, row0 + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    assert_eq!(copies, vec!["row 0".to_string()], "the dragged text copied");
}

/// A drag spanning rows copies each row's slice — the anchor's row from the anchor column, the
/// spacer rows as empty lines, the head's row up to the head column (TS `extractSelectionText`).
#[test]
fn multi_row_drag_copies_each_line() {
    let (row0, col0, answer_row, answer_col, ..) = top_layout();
    assert_eq!(
        answer_row - row0,
        3,
        "two spacer rows sit between the messages"
    );
    let steps = vec![
        // The located press targets are valid only while the view sits at the transcript top.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(drag(answer_col + 8, answer_row + 1)),
        HeadlessStep::Mouse(release(answer_col + 8, answer_row + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    // `  row 0` from column 2; two blank spacer rows; ` answer 1` up to column 8 — the leading pad
    // is TS-faithful (only the trailing side trims).
    assert_eq!(
        copies,
        vec!["row 0\n\n\n answer".to_string()],
        "the spanned rows copied with their column slices"
    );
}

/// TS: the anchor and head coincide, so the release takes the clear branch.
#[test]
fn click_without_drag_copies_nothing() {
    let (row0, col0, ..) = top_layout();
    let steps = vec![
        // The located press targets are valid only while the view sits at the transcript top.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(release(col0 + 1, row0 + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    assert!(copies.is_empty(), "a click never copies: {copies:?}");
}

/// A press on the dock starts a frame selection over the row's visible span (TS
/// `beginFrameSelection`).
#[test]
fn dock_press_drag_copies_the_frame_region() {
    let (_, _, _, _, ctx_row, ctx_col) = top_layout();
    // The right-aligned detail label (operator directive 2026-09-28: "Collapsed mode (Ctrl+O to
    // expand)", 2 columns longer than the details label) renders at 23:66.
    assert_eq!(
        (ctx_row, ctx_col),
        (23, 66),
        "the context row renders at 23:66"
    );
    let steps = vec![
        // The located press targets are valid only while the view sits at the transcript top.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(ctx_col + 1, ctx_row + 1)),
        HeadlessStep::Mouse(drag(ctx_col + 7, ctx_row + 1)),
        HeadlessStep::Mouse(release(ctx_col + 7, ctx_row + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    assert_eq!(copies, vec!["Collap".to_string()], "the dock span copied");
}

#[test]
fn selection_reports_are_consumed_when_tracking_is_disabled() {
    let (row0, col0, ..) = top_layout();
    let steps = vec![
        // The located press targets are valid only while the view sits at the transcript top.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(drag(col0 + 6, row0 + 1)),
        HeadlessStep::Mouse(release(col0 + 6, row0 + 1)),
    ];
    let (_, copies) = run_plan(steps, false);
    assert!(
        copies.is_empty(),
        "no copy with tracking disabled: {copies:?}"
    );
}

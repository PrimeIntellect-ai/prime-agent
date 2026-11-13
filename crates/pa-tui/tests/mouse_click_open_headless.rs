//! Headless e2e for the click-to-open hyperlink dispatch (TS
//! `handleFullscreenInput`): a plain release over a link opens its OSC 8
//! target (recorded `opened_urls` stand in for the browser spawn); a
//! release after a drag selects instead; plain text opens nothing.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize (the capability override
/// rides the same thread-local the render reads).
static RUN_LOCK: Mutex<()> = Mutex::new(());

fn run_lock() -> MutexGuard<'static, ()> {
    match RUN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

use pa_tui::interactive::{run_interactive, HeadlessPlan, HeadlessStep, UiMode};
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
                "detach" => {
                    write_json(writer, &detach_response(id));
                }
                _ => return false,
            }
            true
        });
    }
}

/// The slim attach result with the linked transcript: the assistant message carries one markdown
/// link, the row a click targets.
fn attach_data(id: &str) -> Value {
    let messages = vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "show the docs link" }] }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "see [handbook](https://example.com/docs) for more" },
            ],
        }),
    ];
    let mut response = attach_response(id, "click session");
    response["data"]["snapshot"]["messages"] = json!(messages);
    response
}

/// Run the headless plan and return the captured frames, the opened links, and the selection
/// copies. Holds the run lock: mouse tracking is process-global.
fn run_plan(steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<String>, Vec<String>) {
    let _guard = run_lock();
    // A hyperlink-capable terminal: the link's label carries its OSC 8 target, exactly the row the
    // click dispatch resolves.
    pa_tui::hyperlinks::set_hyperlinks_override(Some(true));
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
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    pa_tui::hyperlinks::set_hyperlinks_override(None);
    let _ = handle.join();
    (outcome.frames, outcome.opened_urls, outcome.copies)
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

/// The link label's rendered position after `ScrollTop` (the probe's captured frame is the click
/// target's geometry).
fn link_position() -> (usize, usize) {
    let (frames, opened, _) = run_plan(vec![HeadlessStep::ScrollTop]);
    assert!(opened.is_empty(), "the probe never clicks: {opened:?}");
    let (_, row, col, _) = locate(&frames, "handbook").expect("the link label rendered");
    (row, col)
}

/// The dock's detail row — plain text, never a link — as a click target.
fn plain_position() -> (usize, usize) {
    let (frames, _, _) = run_plan(vec![HeadlessStep::ScrollTop]);
    let (_, row, col, _) = locate(&frames, "Collapsed mode").expect("the detail row rendered");
    (row, col)
}

/// A press-release without a drag over the link label opens its OSC 8 target (TS
/// `fullscreenPressedHyperlink`'s release branch).
#[test]
fn click_on_a_transcript_link_opens_it() {
    let (row, col) = link_position();
    let steps = vec![
        // The located click target is valid only while the view sits at the top.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col + 4, row + 1)),
        HeadlessStep::Mouse(release(col + 4, row + 1)),
    ];
    let (_, opened, copies) = run_plan(steps);
    assert_eq!(
        opened,
        vec!["https://example.com/docs".to_string()],
        "the click opened the link target"
    );
    assert!(copies.is_empty(), "a click copies nothing: {copies:?}");
}

/// The release with a selection copies and never opens (TS: the hasSelection branch wins).
#[test]
fn drag_over_a_link_selects_it_instead_of_opening() {
    let (row, col) = link_position();
    let steps = vec![
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col + 1, row + 1)),
        HeadlessStep::Mouse(drag(col + 8, row + 1)),
        HeadlessStep::Mouse(release(col + 8, row + 1)),
    ];
    let (_, opened, copies) = run_plan(steps);
    assert!(opened.is_empty(), "a drag never opens: {opened:?}");
    assert_eq!(
        copies,
        vec!["handboo".to_string()],
        "the dragged label cells copied"
    );
}

/// Only cells inside a link's OSC 8 range resolve a URL.
#[test]
fn click_on_plain_text_opens_nothing() {
    let (row, col) = plain_position();
    let steps = vec![
        // The dock's detail row sits far from every link range; no ScrollTop is needed (the dock
        // never moves).
        HeadlessStep::Mouse(press(col + 1, row + 1)),
        HeadlessStep::Mouse(release(col + 1, row + 1)),
    ];
    let (_, opened, copies) = run_plan(steps);
    assert!(
        opened.is_empty(),
        "a plain-text click opens nothing: {opened:?}"
    );
    assert!(
        copies.is_empty(),
        "the zero-width click copies nothing: {copies:?}"
    );
}

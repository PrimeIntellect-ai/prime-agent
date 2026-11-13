//! Headless e2e for the prompt-bar editing keybind set (operator ask 2026-09-24): undo/redo of a
//! paste, shift+arrow selection, select-all replace, doc/paragraph jumps. SANCTIONED DIVERGENCE
//! from TS (per the #289 precedent): the TS editor has none of these; pins the forward feature.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::os::unix::net::UnixListener;
use std::path::Path;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{HeadlessPlan, HeadlessStep};

use support::{
    attach_response, create_response, options, run_headless, serve_connection, write_json, Request,
};

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: ack every command; the plan never submits —
    /// the editor state is the subject.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &attach_response(id, "editing session"));
                }
                _ => return false,
            }
            true
        });
    }
}

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    let outcome = run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 30,
        },
        options,
        |socket| {
            let supervisor = MockSupervisor::bind(socket);
            move || supervisor.serve()
        },
    );
    outcome.frames
}

/// The key events a terminal sends (crossterm's parsed forms): the legacy control bytes this layer
/// remaps (`0x1f` -> `Char('7')+CTRL` is `ctrl+-`), the kitty shift+ctrl letter family, and the
/// bare modifiers.
fn key(code: KeyCode, modifiers: KeyModifiers) -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(code, modifiers))
}

/// Undo: the byte a terminal sends for `Ctrl+-` (`0x1f`), which crossterm parses as
/// `Char('7')+CTRL` and keys.rs remaps to the `ctrl+-` id.
fn undo_key() -> HeadlessStep {
    key(KeyCode::Char('7'), KeyModifiers::CONTROL)
}

/// Redo: a kitty terminal sends `Ctrl+Shift+Z` as the shifted alternate, which crossterm resolves
/// to `Char('Z')+CTRL` (SHIFT cleared) — the `shift+ctrl+z` id that matches the redo binding.
fn redo_key() -> HeadlessStep {
    key(KeyCode::Char('Z'), KeyModifiers::CONTROL)
}

/// Select all: `Ctrl+Shift+A`, the same kitty shifted-alternate shape.
fn select_all_key() -> HeadlessStep {
    key(KeyCode::Char('A'), KeyModifiers::CONTROL)
}

/// A real terminal sends `Ctrl+Home` as `CSI 1;5H`; crossterm parses it to Home+CTRL, which keys.rs
/// reports as the `ctrl+home` id.
fn ctrl_home() -> HeadlessStep {
    key(KeyCode::Home, KeyModifiers::CONTROL)
}

#[test]
fn paste_undo_redo_round_trip() {
    let frames = run_plan(vec![
        HeadlessStep::Type("draft before".to_string()),
        HeadlessStep::Paste("PASTED PAYLOAD".to_string()),
        undo_key(),
        redo_key(),
    ]);
    let all = frames.join("\n");
    assert!(
        all.contains("draft before"),
        "the draft text renders in the editor surface"
    );
    assert!(
        all.contains("PASTED PAYLOAD"),
        "the pasted payload renders after redo"
    );
    // The undo landed between: some frame shows the draft without the payload (the paste undone)
    // before the redo frame re-adds it.
    let undone = frames
        .iter()
        .any(|frame| frame.contains("draft before") && !frame.contains("PASTED PAYLOAD"));
    assert!(
        undone,
        "undo removes the whole paste in one press (pre-paste draft restored)"
    );
    let pasted_frame = frames
        .iter()
        .position(|frame| frame.contains("PASTED PAYLOAD"));
    // The LAST draft-without-payload frame is the undo frame (the first one is the pre-paste
    // typing).
    let undone_frame = frames
        .iter()
        .rposition(|frame| frame.contains("draft before") && !frame.contains("PASTED PAYLOAD"));
    assert!(
        match (pasted_frame, undone_frame) {
            (Some(pasted), Some(undone)) => undone > pasted,
            _ => false,
        },
        "the undo frame follows the paste frame (undo, not pre-paste state)"
    );
}

#[test]
fn select_all_replaces_and_undo_restores() {
    let frames = run_plan(vec![
        HeadlessStep::Type("original draft text".to_string()),
        select_all_key(),
        HeadlessStep::Type("replacement".to_string()),
        undo_key(),
    ]);
    let all = frames.join("\n");
    assert!(all.contains("replacement"), "the typed replace landed");
    let restored = frames
        .iter()
        .any(|frame| frame.contains("original draft text"));
    assert!(
        restored,
        "undo restores the replaced original after the select-all overwrite"
    );
    assert!(
        frames
            .last()
            .is_some_and(|frame| frame.contains("original draft text")),
        "the final frame is the restored original: {frames:?}"
    );
}

#[test]
fn shift_selection_backspace_deletes_the_selection() {
    let frames = run_plan(vec![
        HeadlessStep::Type("abcdef".to_string()),
        key(KeyCode::Left, KeyModifiers::SHIFT),
        key(KeyCode::Left, KeyModifiers::SHIFT),
        key(KeyCode::Backspace, KeyModifiers::NONE),
    ]);
    assert!(
        frames.last().is_some_and(|frame| frame.contains("abcd")),
        "backspace removed the whole two-char selection: {frames:?}"
    );
    assert!(
        frames.last().is_some_and(|frame| !frame.contains("abcde")),
        "the selection (not one character) was deleted: {frames:?}"
    );
}

#[test]
fn ctrl_home_jumps_to_the_start() {
    let frames = run_plan(vec![
        HeadlessStep::Type("tail text".to_string()),
        ctrl_home(),
        HeadlessStep::Type("HEAD ".to_string()),
    ]);
    assert!(
        frames
            .last()
            .is_some_and(|frame| frame.contains("HEAD tail text")),
        "the doc-start jump placed the insertion at the head: {frames:?}"
    );
}

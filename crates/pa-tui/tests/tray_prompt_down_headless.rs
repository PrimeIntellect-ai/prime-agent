//! Headless e2e for the prompt's Down into the activity dock (the tray
//! row under the editor), the operator's 2026-10-01 consistency ruling:
//! Down at the end of the prompt ALWAYS hands the focus to the dock — the
//! all-zero dock and a dock with only shells running included —
//! Left/Right walk its groups, Enter opens the focused group's view even
//! when it is empty, and Up/Esc return to the prompt. Before the fix the
//! Down only took the dock while subagents existed, so with zero
//! subagents every group below the prompt was out of the arrows' reach.
#![cfg(unix)]
// Pedantic-gate exceptions (every other pedantic warning in this crate is
// fixed in place; each exception carries its one-line justification):
// - the casts: terminal-layout arithmetic narrows structurally bounded
//   values (screen coordinates, byte counts, timestamps); guarded
//   conversions would add panic paths the bounds guarantee away.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// - the render routes are flat tables (one arm per route); splitting them
//   would add indirection without changing the flow.
#![allow(clippy::too_many_lines)]
// - widget state structs carry independent flag bits; a nested struct
//   would add indirection without changing the shape.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// - the futures are bounded by the surface's lifetime; boxing them would
//   add an allocation to the steady-state loop.
#![allow(clippy::large_futures)]
// - the wrappers preserve a uniform Result-returning API surface; unwrap
//   removals would ripple through the callers without changing behavior.
#![allow(clippy::unnecessary_wraps)]

mod support;

use std::os::unix::net::UnixListener;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{HeadlessPlan, HeadlessStep, InteractiveOptions};
use serde_json::json;

use support::{
    accept_within_idle_window, attach_response, create_response, options, run_headless,
    serve_connection, write_json, Request,
};

struct MockSupervisor {
    listener: UnixListener,
    /// Serve one running shell from `list_kernel_bash` (`false` serves
    /// the empty registry — the all-zero dock).
    shell_running: bool,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, shell_running: bool) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            shell_running,
        }
    }

    /// Serve one client connection until it goes quiet (bounded, so the
    /// plan teardown join always finishes).
    fn serve(self) {
        let Some(stream) = accept_within_idle_window(&self.listener) else {
            return;
        };
        serve_connection(
            stream,
            &["kernel_bash_activity"],
            |writer, Request { id, kind, .. }| {
                match kind {
                    "create" => {
                        write_json(writer, &create_response(id));
                    }
                    "attach" => {
                        write_json(writer, &attach_response(id, "tray session"));
                    }
                    "list_kernel_bash" => {
                        let activities = if self.shell_running {
                            json!([
                                {"id": "shell-1", "command": "render the frames", "pid": 4242, "status": "running"},
                            ])
                        } else {
                            json!([])
                        };
                        write_json(
                            writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": "list_kernel_bash",
                                "success": true,
                                "data": { "activities": activities },
                            }),
                        );
                    }
                    _ => return false,
                }
                true
            },
        );
    }
}

/// One Down key event (the prompt's hand-off into the dock).
fn down() -> KeyEvent {
    KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)
}

/// One Up key event (the focused dock's return to the prompt).
fn up() -> KeyEvent {
    KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)
}

/// One left-arrow key event (the focused dock's return to the prompt).
fn left() -> KeyEvent {
    KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)
}

/// One plain Enter key event (the focused section's open).
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

/// One Esc key event (`tui.select.cancel`: the open view closes and the
/// focus returns to the editor).
fn escape() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames.
fn run_plan(
    steps: Vec<HeadlessStep>,
    shell_running: bool,
) -> pa_tui::interactive::InteractiveOutcome {
    run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 40,
        },
        |socket| InteractiveOptions {
            fullscreen_mouse: false,
            ..options(socket)
        },
        |socket| {
            let supervisor = MockSupervisor::bind(socket, shell_running);
            move || supervisor.serve()
        },
    )
}

/// The all-zero dock row.
const ALL_ZERO_DOCK: &str =
    " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells";

/// Bug 1: with zero subagents (every count zero), the prompt's Down
/// enters the dock on its subagents group, and Enter opens the scoped
/// agents view — whose empty roster is the view's own empty state.
#[test]
fn prompt_down_enters_the_all_zero_dock_and_enter_opens_subagents() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: ALL_ZERO_DOCK.to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(300),
    ];
    let outcome = run_plan(steps, false);
    assert!(
        outcome.return_to_agents_view,
        "Down then Enter opened the scoped agents view:\n{}",
        outcome.frames.join("\n")
    );
}

/// Every empty group stays reachable from the prompt's Down: Down walks
/// to the empty heartbeats and shells rows, and Enter opens each view's
/// empty state.
#[test]
fn prompt_down_reaches_every_empty_group() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: ALL_ZERO_DOCK.to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No running or paused heartbeats".to_string(),
            timeout_ms: 5_000,
        },
        // The panel's exit lands back on its own dock item.
        HeadlessStep::Key(escape()),
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No background commands".to_string(),
            timeout_ms: 5_000,
        },
    ];
    let outcome = run_plan(steps, false);
    let all = outcome.frames.join("\n");
    assert!(
        all.contains("No running or paused heartbeats"),
        "the empty heartbeats group opened its view:\n{all}"
    );
    assert!(
        all.contains("No background commands"),
        "the empty shells group opened its view:\n{all}"
    );
}

/// Bug 2: with a shell running and zero subagents, the prompt's Down
/// enters the dock and two more Down presses reach the shells row, whose
/// Enter opens the bash view listing the running shell.
#[test]
fn prompt_down_reaches_the_shells_group_with_zero_subagents() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "\u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 1 shell"
                .to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(down()),
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "render the frames".to_string(),
            timeout_ms: 5_000,
        },
    ];
    let outcome = run_plan(steps, true);
    let all = outcome.frames.join("\n");
    assert!(
        all.contains("render the frames"),
        "the shells group opened the bash view with the running shell:\n{all}"
    );
    assert!(!outcome.return_to_agents_view);
}

/// Up from the top row, and Esc or Left from any row, return to the
/// prompt: the Enter that follows reaches the empty prompt, never a dock
/// page (the agents view or the heartbeats view's empty state), and the
/// typed text after it lands in the prompt — the barrier proves the Enter
/// was handled.
#[test]
fn up_from_the_top_row_and_esc_or_left_return_from_the_dock_to_the_prompt() {
    let cases = [
        (vec![down()], up()),
        (vec![down(), down()], escape()),
        (vec![down(), down()], left()),
    ];
    for (grab, back) in cases {
        let mut steps = vec![HeadlessStep::WaitRender {
            needle: ALL_ZERO_DOCK.to_string(),
            timeout_ms: 5_000,
        }];
        steps.extend(grab.into_iter().map(HeadlessStep::Key));
        steps.extend([
            HeadlessStep::Key(back),
            HeadlessStep::Key(enter()),
            HeadlessStep::Type("back at the prompt".to_string()),
            HeadlessStep::WaitRender {
                needle: "back at the prompt".to_string(),
                timeout_ms: 5_000,
            },
        ]);
        let outcome = run_plan(steps, false);
        let all = outcome.frames.join("\n");
        let last = outcome.frames.last().cloned().unwrap_or_default();
        assert!(
            last.contains("back at the prompt")
                && last.contains(ALL_ZERO_DOCK)
                && !all.contains("No running or paused heartbeats")
                && !outcome.return_to_agents_view,
            "{back:?} collapsed the dock and returned the focus to the prompt before the Enter:\n{all}"
        );
    }
}

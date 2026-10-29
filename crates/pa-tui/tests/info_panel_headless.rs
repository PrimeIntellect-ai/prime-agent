//! Headless e2e for the read-only inline info panel (operator directive
//! 2026-09-26): the flooding client commands (`/context`, `/session`,
//! `/system-prompt`, `/logs`, `/changelog`, `/hotkeys`, `/list`) open the
//! docked panel; ESC closes it; `?` types into the editor (guide removed).
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

mod support;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{HeadlessPlan, HeadlessStep};
use serde_json::json;

use support::{
    attach_response, create_response, detach_response, options, run_headless, serve_connection,
    session_stats_response, write_json, MockSupervisor, Request,
};

impl MockSupervisor {
    /// Serve one connection: the info commands' daemon fetches all land in the default arm's
    /// empty-data success.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "get_commands" => {
                    write_json(
                        writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_commands",
                            "success": true,
                            "data": { "commands": [] },
                        }),
                    );
                }
                "attach" => {
                    write_json(writer, &attach_response(id, "info panel session"));
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

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    let outcome = run_headless(
        HeadlessPlan {
            steps,
            width: 110,
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

fn submit(text: &str) -> HeadlessStep {
    HeadlessStep::Submit(text.to_string())
}

fn key(code: KeyCode) -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn wait_render(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 30_000,
    }
}

fn wait_gone(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitGone {
        needle: needle.to_string(),
        timeout_ms: 30_000,
    }
}

/// The panel's key hint (the shared docked-panel grammar): the scroll keys and the close key.
const PANEL_HINT: &str = "Esc close";

/// Every flooding command opens the read-only info panel inline, ESC closes it, and the transcript
/// gains nothing; `?` types into the editor instead of mounting the removed guide.
#[test]
fn info_commands_open_inline_panels_that_esc_closes_without_transcript_rows() {
    let steps = vec![
        // `/context`: the tree opens the panel (its `Tokens` section is panel-only content).
        submit("/context"),
        wait_render("Tokens"),
        key(KeyCode::Down),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/session`: the Session Info rows.
        submit("/session"),
        wait_render("Session Info"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/system-prompt`: the unbounded document, paged by the panel.
        submit("/system-prompt"),
        wait_render("chars)"),
        key(KeyCode::PageDown),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/logs`: the client-side directory listing.
        submit("/logs"),
        wait_render("Directory:"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/changelog`: the What's New title rides the panel.
        submit("/changelog"),
        wait_render("What's New"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/hotkeys`: the guide's rows ride the panel; End jumps to the guide's bottom.
        submit("/hotkeys"),
        wait_render("Move cursor / browse history"),
        key(KeyCode::End),
        wait_render("mouse click on link"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/list`: the live-sessions listing (the mock answers an empty roster).
        submit("/list"),
        wait_render("live sessions:"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // The removed `?` command: with an empty editor the key types a literal `?`; Esc clears the
        // editor.
        key(KeyCode::Char('?')),
        key(KeyCode::Esc),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let rendered = frames.join("\n");

    assert!(
        rendered.contains("\u{2191}/\u{2193} scroll \u{b7} Esc close"),
        "the panel hint rendered:\n{rendered}"
    );
    // End put the guide's last rows on screen (the first window never shows them).
    assert!(
        rendered.contains("mouse click on link"),
        "the End key jumped the panel to the guide's bottom:\n{rendered}"
    );
    // The `?` quick-shortcut guide never mounted anywhere in the run: the `?` press typed editor
    // text instead.
    assert!(
        !rendered.contains("full reference"),
        "the removed ? guide must never mount:\n{rendered}"
    );
    assert!(
        !rendered.contains("quick shortcuts"),
        "the removed ? guide's vocabulary is gone:\n{rendered}"
    );

    // The transcript after every panel closed: the editor dock and none of the panel content (the
    // operator's no-flooding directive).
    let last = frames.last().expect("frames");
    assert!(
        last.contains("Collapsed mode ("),
        "the editor dock returned after every panel closed:\n{last}"
    );
    for absent in [
        "Session Info",
        "Tokens",
        "Directory:",
        "What's New",
        "Move cursor / browse history",
        "live sessions:",
        "Use /context for token",
    ] {
        assert!(
            !last.contains(absent),
            "the panel content `{absent}` must not persist in the transcript:\n{last}"
        );
    }
}

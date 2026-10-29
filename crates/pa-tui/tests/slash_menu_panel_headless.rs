//! Headless e2e for the slash-menu panel's top border (operator directive
//! 2026-09-26): the dropdown opens with the full-width muted rule every
//! inline menu panel opens with (TS `MenuPanel.render`), drawn directly
//! above the menu rows.
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

use pa_tui::interactive::{run_interactive, HeadlessPlan, HeadlessStep, UiMode};
use serde_json::json;

use support::{
    attach_response, create_response, detach_response, options, serve_connection,
    session_stats_response, write_json, MockSupervisor, Request,
};

impl MockSupervisor {
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "get_commands" => {
                    // No skill commands: the dropdown lists the builtin
                    // registry alone, the plain slash menu.
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
                    write_json(writer, &attach_response(id, "slash menu session"));
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

const WIDTH: usize = 100;

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    std::env::remove_var("TMUX");
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
        width: WIDTH as u16,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

#[test]
fn slash_menu_opens_with_the_top_border_rule() {
    let steps = vec![
        // The command-catalog fetch lands in the background (the attach
        // spawns it); give the fold a beat before typing.
        HeadlessStep::WaitMs(300),
        HeadlessStep::Type("/".to_string()),
        HeadlessStep::SettleIdle,
        HeadlessStep::WaitMs(100),
    ];
    let frames = run_plan(steps);
    let frame = frames
        .iter()
        .rev()
        .find(|frame| {
            frame
                .split('\n')
                .any(|line| line.trim_start().starts_with('\u{203a}'))
        })
        .expect("a frame renders the open slash menu");
    let lines: Vec<&str> = frame.split('\n').collect();
    let marker = lines
        .iter()
        .position(|line| line.trim_start().starts_with('\u{203a}'))
        .expect("the selected marker row");
    assert!(
        marker > 0,
        "the marker row is not the frame's first row:\n{frame}"
    );
    assert_eq!(
        lines[marker - 1],
        "\u{2500}".repeat(WIDTH),
        "the panel's top border sits directly above the menu rows:\n{frame}"
    );
}

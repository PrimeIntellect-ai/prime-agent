//! Headless e2e for the chat-open first frame (operator 2026-09-26
//! layout-shift report): opening a chat must paint its final geometry in
//! the FIRST frame — the dock folds synchronously with the attach even
//! when the catalog responses lag; no captured frame repaints the dock.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, SessionSelection, UiMode,
};
use serde_json::{json, Value};

use support::{
    attach_response, options, serve_connection, session_stats_response, write_json, MockSupervisor,
    Request,
};

/// The loaded-daemon stand-in: the dock's data requests answer this late, far past the first
/// frame's render — late enough that a fire-and-forget open-time fetch (the layout-shift bug)
/// always paints a first frame without the dock, short enough to sit inside the attach's waits.
const DOCK_DATA_DELAY_MS: u64 = 300;

impl MockSupervisor {
    /// Serve one connection: attach, subscribe the roster, and answer the dock data requests after
    /// the delay.
    fn serve(self, with_content: bool) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(
            stream,
            &["kernel_bash_activity"],
            |writer, Request { id, kind, .. }| {
                match kind {
                    "attach" => {
                        write_json(writer, &attach_data(id, with_content));
                    }
                    "heartbeats_list" => {
                        std::thread::sleep(std::time::Duration::from_millis(DOCK_DATA_DELAY_MS));
                        write_json(
                            writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": "heartbeats_list",
                                "success": true,
                                "data": {
                                    "heartbeats": [
                                        {
                                            "job": {
                                                "id": "hb-1",
                                                "status": "active",
                                                "source": "heartbeat",
                                                "activeSessionId": "s1",
                                                "sessionId": "sess-1",
                                                "schedule": {"kind": "interval", "expression": "every 30m"},
                                            },
                                            "sessionName": "layout probe",
                                        },
                                    ],
                                },
                            }),
                        );
                    }
                    "list_kernel_bash" => {
                        std::thread::sleep(std::time::Duration::from_millis(DOCK_DATA_DELAY_MS));
                        write_json(
                            writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": "list_kernel_bash",
                                "success": true,
                                "data": {
                                    "activities": [
                                        {
                                            "id": "run-1",
                                            "command": "echo settled",
                                            "status": "finished",
                                            "exitCode": 0,
                                        },
                                    ],
                                },
                            }),
                        );
                    }
                    "get_session_stats" => {
                        write_json(writer, &session_stats_response(id));
                    }
                    _ => return false,
                }
                true
            },
        );
    }
}

/// The attach result: one live session whose transcript either carries a settled exchange or is
/// empty.
fn attach_data(id: &str, with_content: bool) -> Value {
    let messages = if with_content {
        json!([
            { "role": "user", "content": "hello", "timestamp": 1 },
            { "role": "assistant", "content": "settled answer", "provider": "scripted", "model": "faux-1", "timestamp": 2 },
        ])
    } else {
        json!([])
    };
    let mut response = attach_response(id, "layout probe");
    response["data"]["snapshot"]["state"]["model"] = json!("faux-1");
    response["data"]["snapshot"]["messages"] = messages;
    response
}

/// The attach snapshot's transcript shape the open drives.
enum OpeningTranscript {
    /// No messages: the chat opens empty (the splash's parity case).
    Empty,
    /// A settled user/assistant exchange: a direct open into content.
    Content,
}

fn run_open(transcript: &OpeningTranscript) -> Vec<String> {
    let with_content = matches!(transcript, OpeningTranscript::Content);
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve(with_content));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitMs(100),
            HeadlessStep::WaitMs(100),
            HeadlessStep::WaitMs(100),
        ],
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(
            InteractiveOptions {
                session: SessionSelection::Attach("s1".to_string()),
                ..options(socket)
            },
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// The dock's divider rule: one full-width row of box-drawing heavies.
fn is_divider_row(line: &str, width: usize) -> bool {
    !line.is_empty() && line.chars().count() == width && line.chars().all(|c| c == '\u{2500}')
}

/// The dock's counts are first-frame state: every captured frame carries both rows with the final
/// count, so the delayed dock data never repaints the row in late.
#[test]
fn the_activity_dock_is_in_every_frame_from_the_first() {
    let frames = run_open(&OpeningTranscript::Empty);
    assert!(!frames.is_empty(), "frames were captured");
    let offenders: Vec<usize> = frames
        .iter()
        .enumerate()
        .filter(|(_, frame)| {
            !frame.contains("\u{25f7} 1 heartbeat")
                || !frame.lines().any(|line| is_divider_row(line, 100))
        })
        .map(|(index, _)| index)
        .collect();
    assert!(
        offenders.is_empty(),
        "every frame from the first carries the dock divider plus the \
         heartbeat panel row (frames {offenders:?} lack it) — the dock \
         data must fold with the attach, never land as a late repaint:\n{}",
        frames.join("\n---frame---\n")
    );
}

/// A chat that opens directly into content paints its first frame from the snapshot: the
/// transcript, the pinned title row, and the dock all ride that same frame, and the brand splash
/// (the new chat's header) never renders — no splash flash above the title, no one-row shift.
#[test]
fn a_direct_open_into_content_never_renders_the_splash() {
    let frames = run_open(&OpeningTranscript::Content);
    assert!(!frames.is_empty(), "frames were captured");
    let first = &frames[0];
    assert!(
        first.contains("settled answer"),
        "the first frame is the content frame:\n{first}"
    );
    assert!(
        first.contains("layout probe"),
        "the pinned title row rides the first content frame:\n{first}"
    );
    assert!(
        frames.iter().all(|frame| !frame.contains("prime agent")),
        "the brand splash never renders for a direct open into content:\n{}",
        frames.join("\n---frame---\n")
    );
}

/// The counter-pin: an empty chat keeps its brand splash — TS `BrandSplashHeader` is the new chat's
/// header, and the suppression is scoped to opens into content.
#[test]
fn an_empty_open_keeps_the_brand_splash() {
    let frames = run_open(&OpeningTranscript::Empty);
    assert!(!frames.is_empty(), "frames were captured");
    assert!(
        frames.iter().any(|frame| frame.contains("prime agent")),
        "the empty chat renders its header splash:\n{}",
        frames.join("\n---frame---\n")
    );
}

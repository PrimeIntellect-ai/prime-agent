//! Headless e2e for the prompt ack window: a follow-up submitted during a run is admitted after
//! that run settles, so the daemon starts it as its own run. The daemon answers its ack after its
//! `agent_start`; a `WaitIdle` in the window between the two runs must hold until the follow-up's
//! own run settles.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::time::Duration;

use pa_tui::interactive::{HeadlessPlan, HeadlessStep};
use serde_json::json;

use support::{
    attach_response, create_response, options, run_headless, serve_connection, write_json,
    write_session_event, MockSupervisor, Request,
};

/// The session rename the follow-up's run writes just before its `agent_end`.
const SECOND_RUN_SETTLED: &str = "second run settled";
const TYPED_AFTER_IDLE: &str = "typed after idle";

fn ack(writer: &mut std::os::unix::net::UnixStream, id: &str) {
    write_json(
        writer,
        &json!({ "type": "response", "id": id, "command": "prompt", "success": true }),
    );
}

impl MockSupervisor {
    /// The first prompt starts a run that stays open. The second prompt settles that run and,
    /// in the daemon's wire order, starts its own run, then answers its ack; its run settles later.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let mut prompts = 0;
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => write_json(writer, &create_response(id)),
                "attach" => write_json(writer, &attach_response(id, "ack window")),
                "prompt" => {
                    if prompts > 0 {
                        write_session_event(writer, &json!({ "type": "turn_end" }));
                        write_session_event(writer, &json!({ "type": "agent_end" }));
                    }
                    write_session_event(writer, &json!({ "type": "agent_start" }));
                    write_session_event(writer, &json!({ "type": "turn_start" }));
                    ack(writer, id);
                    if prompts > 0 {
                        let mut settle = writer.try_clone().expect("clone mock socket");
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(600));
                            write_session_event(
                                &mut settle,
                                &json!({ "type": "session_info_changed", "name": SECOND_RUN_SETTLED }),
                            );
                            write_session_event(&mut settle, &json!({ "type": "turn_end" }));
                            write_session_event(&mut settle, &json!({ "type": "agent_end" }));
                        });
                    }
                    prompts += 1;
                }
                _ => return false,
            }
            true
        });
    }
}

#[test]
fn wait_idle_holds_until_a_follow_ups_own_run_settles() {
    let outcome = run_headless(
        HeadlessPlan {
            steps: vec![
                HeadlessStep::Submit("first".to_string()),
                HeadlessStep::WaitMs(200),
                HeadlessStep::Submit("second".to_string()),
                HeadlessStep::WaitIdle { timeout_ms: 5000 },
                HeadlessStep::Type(TYPED_AFTER_IDLE.to_string()),
            ],
            width: 100,
            height: 30,
        },
        options,
        |socket| {
            let supervisor = MockSupervisor::bind(socket);
            move || supervisor.serve()
        },
    );
    let typed = outcome
        .frames
        .iter()
        .find(|frame| frame.contains(TYPED_AFTER_IDLE))
        .expect("the typed text rendered");
    assert!(
        typed.contains(SECOND_RUN_SETTLED),
        "WaitIdle released before the follow-up's run settled:\n{typed}"
    );
}

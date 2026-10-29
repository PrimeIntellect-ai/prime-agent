//! Headless e2e for the `/tier` service-tier command (TS #2144): the bare
//! command reports current and available tiers; an unsupported tier errors
//! with the list; a supported tier applies through `set_service_tier` and
//! the tray badge shows the non-default tier.
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

use std::os::unix::net::UnixListener;

use pa_tui::interactive::{HeadlessPlan, HeadlessStep, InteractiveOptions};
use serde_json::{json, Value};

use support::{
    attach_response, create_response, detach_response, options, run_headless, serve_connection,
    write_json, Request,
};

struct MockSupervisor {
    listener: UnixListener,
}

/// The `OpenRouter` catalog entry as the daemon's `get_model_catalog` answer carries it:
/// completions API, so flex and priority are both eligible. The same json seeds
/// `InteractiveOptions::model_catalog` (the composition-root snapshot the picker serves before the
/// fetch lands).
fn openrouter_model_value() -> Value {
    json!({
        "id": "openai/gpt-5.5",
        "name": "OpenAI: GPT-5.5",
        "api": "openai-completions",
        "provider": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "reasoning": true,
        "input": ["text"],
        "cost": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 0 },
        "contextWindow": 272_000,
        "maxTokens": 128_000
    })
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach an OpenRouter-model session; `set_service_tier` applies,
    /// `get_state` reports the tier.
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
                "set_service_tier" => {
                    // The daemon arm answers success with no data; the follow-up get_state read
                    // reports the applied tier.
                    write_json(
                        writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "set_service_tier",
                            "success": true,
                            "data": {},
                        }),
                    );
                }
                "get_model_catalog" => {
                    // The startup fetch (`spawn_model_catalog_refresh`) replaces the
                    // composition-root catalog; serve the same OpenRouter entry the eligibility
                    // reads run against.
                    write_json(
                        writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_model_catalog",
                            "success": true,
                            "data": {
                                "models": [openrouter_model_value()],
                                "configuredProviders": ["openrouter"],
                            },
                        }),
                    );
                }
                "get_connection_state" => {
                    write_json(
                        writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_connection_state",
                            "success": true,
                            "data": {
                                "activeSessionId": "s1",
                                "sessionId": "sess-1",
                                "serviceTier": "flex",
                                "steeringMode": "one-at-a-time",
                                "model": { "id": "openai/gpt-5.5", "provider": "openrouter" },
                                "isStreaming": false,
                            },
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

/// The slim attach result: one session on an `OpenRouter` completions model (the catalog entry the
/// eligibility predicate reads).
fn attach_data(id: &str) -> Value {
    let mut response = attach_response(id, "tier session");
    response["data"]["snapshot"]["state"]["model"] =
        json!({ "id": "openai/gpt-5.5", "provider": "openrouter" });
    response
}

/// The composition-root catalog seed (the options snapshot).
fn openrouter_catalog() -> Vec<pa_types::ai::Model> {
    serde_json::from_value(openrouter_model_value())
        .map(|model| vec![model])
        .expect("catalog model")
}

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    let outcome = run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 30,
        },
        |socket| InteractiveOptions {
            model_catalog: openrouter_catalog(),
            ..options(socket)
        },
        |socket| {
            let supervisor = MockSupervisor::bind(socket);
            move || supervisor.serve()
        },
    );
    outcome.frames
}

#[test]
fn tier_command_shows_applies_and_rejects() {
    // The leading settle (the sibling harnesses' pattern): the attach must land its model +
    // provider before the first submit reads them.
    let steps = vec![
        HeadlessStep::WaitMs(400),
        HeadlessStep::Submit("/tier".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/tier scale".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/tier flex".to_string()),
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    assert!(
        all.contains("Service tier: default (available: default, flex, priority)"),
        "the show note rendered:\n{all}"
    );
    // `scale` is not a user-facing choice: the TS error names the tier and lists the available ones
    // (the rendered row wraps the list at the frame width, so the assertion stays on the
    // single-line head).
    assert!(
        all.contains("Service tier 'scale' is not available for the current model"),
        "the unsupported error rendered:\n{all}"
    );
    assert!(
        all.contains("Available: default, flex,"),
        "the error lists the available tiers:\n{all}"
    );
    assert!(
        all.contains("Service tier: flex"),
        "the applied-tier note rendered:\n{all}"
    );
    assert!(
        frames
            .iter()
            .any(|frame| frame.contains("openai/gpt-5.5 \u{00b7} flex")),
        "the tray badge rendered the applied tier:\n{all}"
    );
}

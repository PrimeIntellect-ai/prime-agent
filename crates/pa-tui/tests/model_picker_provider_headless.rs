//! Headless e2e for the `/model` picker's current-model resolution across
//! providers: with the session on `prime-inference/z-ai/glm-5.3` and the
//! catalog listing the SAME id under openrouter too, the picker must
//! resolve the session's OWN provider's entry, not the openrouter row.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::os::unix::net::UnixListener;
use std::path::PathBuf;

use pa_tui::interactive::{HeadlessPlan, HeadlessStep, InteractiveOptions};
use pa_types::ai::Model;
use serde_json::{json, Value};

use support::{
    attach_response, create_response, detach_response, run_headless, serve_connection, write_json,
    Request,
};

/// One catalog model: the id `z-ai/glm-5.3` under a provider, with a provider-distinct name so the
/// picker's rows identify by name.
fn duplicate_id_model(provider: &str, name: &str) -> Model {
    serde_json::from_value(json!({
        "id": "z-ai/glm-5.3", "name": name, "api": "openai-completions", "provider": provider,
        "baseUrl": "https://example.invalid/v1", "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 4096,
    }))
    .expect("mock model deserializes")
}

/// The catalog the daemon serves and the run opens with: openrouter's z-ai/glm-5.3 entry FIRST,
/// prime-inference's second — the first-match order the id-only find resolved from before the fix.
fn duplicate_id_catalog() -> Vec<Model> {
    vec![
        duplicate_id_model("openrouter", "GLM 5.3 Open"),
        duplicate_id_model("prime-inference", "GLM 5.3 Prime"),
    ]
}

/// The mock supervisor: one attached session whose state reports `prime-inference/z-ai/glm-5.3`,
/// serving the duplicate-id catalog to both the startup snapshot and the refresh.
struct MockSupervisor {
    listener: UnixListener,
    catalog: Vec<Model>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, catalog: Vec<Model>) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            catalog,
        }
    }

    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &Self::attach_data(id));
                }
                "get_model_catalog" => {
                    write_json(
                        writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_model_catalog",
                            "success": true,
                            "data": {
                                "models": self.catalog,
                                "configuredProviders": ["prime-inference", "openrouter"],
                            },
                        }),
                    );
                }
                "get_state" | "get_connection_state" => {
                    write_json(writer, &Self::state_data(id, kind));
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

    /// The slim attach result: the state carries the current model identity — the id AND the
    /// provider (`state.model.provider`).
    fn attach_data(id: &str) -> Value {
        let mut response = attach_response(id, "provider session");
        response["data"]["snapshot"]["state"]["model"] =
            json!({ "id": "z-ai/glm-5.3", "provider": "prime-inference" });
        response
    }

    /// The live session state: the same prime-inference model identity.
    fn state_data(id: &str, command: &str) -> Value {
        json!({
            "type": "response",
            "id": id,
            "command": command,
            "success": true,
            "data": {
                "model": { "id": "z-ai/glm-5.3", "provider": "prime-inference" },
                "isStreaming": false,
                "isCompacting": false,
                "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
            },
        })
    }
}

fn options(socket: PathBuf, catalog: Vec<Model>) -> InteractiveOptions {
    // The startup snapshot mirrors the daemon's `get_model_catalog` answer exactly: the background
    // refresh can land before or after the picker opens; either snapshot must render the same rows.
    let mut configured_providers = std::collections::HashSet::new();
    configured_providers.insert("prime-inference".to_string());
    configured_providers.insert("openrouter".to_string());
    InteractiveOptions {
        model_catalog: catalog,
        model_configured_providers: configured_providers,
        ..support::options(socket)
    }
}

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    let outcome = run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 30,
        },
        |socket| options(socket, duplicate_id_catalog()),
        |socket| {
            let supervisor = MockSupervisor::bind(socket, duplicate_id_catalog());
            move || supervisor.serve()
        },
    );
    outcome.frames
}

/// The operator's duplicate-id repro: the session runs `prime-inference/z-ai/glm-5.3`, the catalog
/// lists the same id under openrouter FIRST — the prime-inference row carries `current`.
#[test]
fn the_picker_marks_the_sessions_own_provider_current() {
    let frames = run_plan(vec![
        HeadlessStep::Submit("/model".to_string()),
        HeadlessStep::WaitRender {
            needle: "GLM 5.3 Prime".to_string(),
            timeout_ms: 30_000,
        },
    ]);
    let last = frames.last().expect("a frame with the picker open");
    let rows: Vec<&str> = last.split('\n').collect();
    let prime_row = rows
        .iter()
        .find(|row| row.contains("GLM 5.3 Prime"))
        .expect("the prime-inference row renders");
    assert!(
        prime_row.contains("current") && prime_row.contains("prime-inference"),
        "the session's own provider's row is the current model: {prime_row}"
    );
    assert!(
        prime_row.starts_with("\u{203a}"),
        "the selection band lands on the session's own provider's row: {prime_row}"
    );
    let open_row = rows
        .iter()
        .find(|row| row.contains("GLM 5.3 Open"))
        .expect("the openrouter row renders");
    assert!(
        !open_row.contains("current"),
        "another provider's same-id row is NOT the current model: {open_row}"
    );
    assert!(
        !open_row.starts_with("\u{203a}"),
        "another provider's same-id row is NOT selected: {open_row}"
    );
}

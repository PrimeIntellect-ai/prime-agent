//! Headless e2e for the `/plugins` command (TS `handlePluginsCommand` ->
//! `showServiceCatalogPicker`): opens the external-services catalog view
//! (the merged `/mcp` view) and an argument prefills the search field.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use pa_tui::interactive::{HeadlessPlan, HeadlessStep};
use serde_json::{json, Value};

use support::{
    attach_response, create_response, detach_response, options, run_headless, serve_connection,
    session_stats_response, write_json, MockSupervisor, Request,
};

impl MockSupervisor {
    /// Serve one connection: the roster carries two catalog services.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &attach_response(id, "plugins session"));
                }
                "get_mcp_connections" => {
                    write_json(writer, &roster_data(id));
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

/// The daemon roster: two catalog services (the resolved `services` cards
/// the catalog picker renders).
fn roster_data(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "get_mcp_connections",
        "success": true,
        "data": {
            "services": [
                {
                    "serviceId": "github",
                    "label": "GitHub",
                    "connectionStatus": "not_connected",
                    "connectable": true,
                    "connectionIds": [],
                },
                {
                    "serviceId": "linear",
                    "label": "Linear",
                    "connectionStatus": "not_connected",
                    "connectable": true,
                    "connectionIds": [],
                },
            ],
            "connections": [],
        },
    })
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

#[test]
fn plugins_opens_the_catalog_view() {
    let steps = vec![
        HeadlessStep::Submit("/plugins".to_string()),
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    assert!(
        all.contains("Search MCP connections"),
        "the catalog view's search field rendered:\n{all}"
    );
    assert!(
        all.contains("GitHub") && all.contains("Linear"),
        "both service cards rendered:\n{all}"
    );
}

#[test]
fn plugins_argument_prefills_the_search() {
    let steps = vec![
        HeadlessStep::Submit("/plugins lin".to_string()),
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let filtered = frames
        .iter()
        .rev()
        .find(|frame| frame.contains("Linear"))
        .expect("the matching service row rendered");
    assert!(
        filtered.contains(" > lin"),
        "the catalog search is prefilled with the query:\n{filtered}"
    );
    assert!(
        filtered.contains("Linear"),
        "the matching row stayed after the prefilled search:\n{filtered}"
    );
    assert!(
        !filtered.contains("GitHub"),
        "the non-matching row is filtered out:\n{filtered}"
    );
}

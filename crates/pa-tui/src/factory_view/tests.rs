//! The `/factory` view's battery: the snapshot parsing, the diagram's
//! highlighted rendering (asserted per span, so removing the active-node
//! marking fails the test — the mutation check), the Mermaid emission,
//! the key loop, and the repaint hysteresis.

use super::*;
use crate::keybindings::KeybindingsManager;
use crate::theme::{ColorMode, Theme};
use serde_json::json;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

/// Rendered rows as trimmed plain text (tmux-capture shape).
fn frame_text(view: &mut FactoryView) -> Vec<String> {
    view.render(&theme(), 110, &kb())
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .map(|row| row.trim_end().to_string())
        .collect()
}

/// One span row's styles, for the highlighting assertions.
fn frame_spans(view: &mut FactoryView) -> Vec<Vec<crate::Span>> {
    view.render(&theme(), 110, &kb())
}

/// A scripted run: the review-loop machine mid-flight — collect done,
/// reviewing running (its first entry settled, so the collect edge fired),
/// fixing pending — plus the usage and milestone tail.
fn scripted_snapshot() -> serde_json::Value {
    json!({
        "runId": "run-abc12345",
        "specId": "review-loop",
        "name": "review-loop",
        "state": "running",
        "elapsedMs": 45_000,
        "budget": { "limitMs": 600_000, "consumedMs": 45_000 },
        "machine": {
            "run": { "maxParallel": 4, "maxTransitions": 40, "failurePolicy": "continue", "budgetMs": 600_000 },
            "states": [
                { "id": "collect", "entry": true, "lifecycle": "task", "maxEntries": 1, "subagent": "researcher" },
                { "id": "reviewing", "entry": false, "lifecycle": "task", "maxEntries": 4, "retries": 1 },
                { "id": "fixing", "entry": false, "lifecycle": "task", "maxEntries": 3 }
            ],
            "transitions": [
                { "from": "collect", "to": "reviewing", "on": "settled" },
                { "from": "reviewing", "to": "fixing", "on": "settled",
                  "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false } },
                { "from": "fixing", "to": "reviewing", "on": "settled" }
            ],
            "order": ["collect", "reviewing", "fixing"]
        },
        "nodes": [
            { "id": "collect", "status": "done", "lifecycle": "task", "entriesUsed": 1,
              "maxEntries": 1, "attempts": 1, "entries": [ { "index": 0, "status": "done" } ],
              "instances": [ { "index": 0, "entry": 0, "status": "done", "attempt": 1 } ] },
            { "id": "reviewing", "status": "running", "lifecycle": "task", "entriesUsed": 1,
              "maxEntries": 4, "attempts": 1, "entries": [ { "index": 0, "status": "running" } ],
              "instances": [ { "index": 0, "entry": 0, "status": "running", "attempt": 1 } ] },
            { "id": "fixing", "status": "pending", "lifecycle": "task", "entriesUsed": 0,
              "maxEntries": 3, "attempts": 0, "entries": [], "instances": [] }
        ],
        "activeNodes": ["reviewing"],
        "last_fired": [ { "from": "collect", "to": "reviewing", "seq": 4 } ],
        "events": [
            { "kind": "milestone", "milestone": "started", "stage": "delivered" },
            { "kind": "transition_fired", "from": "collect", "to": "reviewing", "seq": 4 }
        ],
        "usage": { "spawns": 2, "settled": 1, "toolUses": 5, "maxParallel": 4,
                   "running": 1, "transitionsFired": 1 }
    })
}

fn runs_response(snapshot: &serde_json::Value) -> serde_json::Value {
    json!({ "runs": [snapshot] })
}

/// The parser fuses the structure and the live overlay.
#[test]
fn parsing_fuses_structure_and_live_state() {
    let runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(run.run_id, "run-abc12345");
    assert_eq!(run.state.as_deref(), Some("running"));
    assert_eq!(run.states.len(), 3);
    assert!(run.states[0].entry);
    assert_eq!(run.transitions.len(), 3);
    assert_eq!(run.nodes["reviewing"].status, "running");
    assert_eq!(run.last_fired[0].to, "reviewing");
    assert_eq!(run.milestones, vec!["started".to_string()]);
    assert_eq!(run.usage.as_ref().unwrap().running, 1);
    assert_eq!(
        run.active_state_ids(),
        vec!["reviewing".to_string()],
        "the running node is the active one"
    );
}

/// The diagram renders the machine's rows and connectors, with the fired
/// edge marked.
#[test]
fn the_diagram_renders_states_edges_and_the_fired_marker() {
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&scripted_snapshot())), 40);
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(
        joined.contains("factory: review-loop — running"),
        "{joined}"
    );
    assert!(joined.contains("✓ collect"), "the done row: {joined}");
    assert!(joined.contains("reviewing"), "{joined}");
    assert!(joined.contains("fixing"), "{joined}");
    assert!(joined.contains("collect"), "{joined}");
    assert!(joined.contains("»"), "the last-fired marker: {joined}");
    assert!(
        joined.contains("when verdict.approved eq false"),
        "the guard label: {joined}"
    );
    assert!(joined.contains("milestones: started"), "{joined}");
    assert!(joined.contains("1 running"), "{joined}");
}

/// The highlighting: the active node's row paints in the accent (bright)
/// color and the pending node in the dim color — removing the marking
/// fails this test (the mutation check on the diagram's highlighting).
#[test]
fn active_nodes_paint_bright_and_pending_paints_dim() {
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&scripted_snapshot())), 40);
    let rows = frame_spans(&mut view);
    let accent = theme().fg_style(ThemeColor::Accent);
    let dim = theme().fg_style(ThemeColor::Dim);
    let styled = |rows: &Vec<crate::Span>, style: crate::Style, text: &str| {
        rows.iter()
            .any(|span| span.content.contains(text) && span.style == style)
    };
    // The active node's id is accent-bright.
    let reviewing_bright = rows.iter().any(|row| styled(row, accent, "reviewing"));
    assert!(reviewing_bright, "reviewing must paint accent");
    // The never-entered node paints dim.
    let fixing_dim = rows.iter().any(|row| styled(row, dim, "fixing"));
    assert!(fixing_dim, "fixing must paint dim");
    // The last-fired edge's marker paints success.
    let success = theme().fg_style(ThemeColor::Success);
    let fired_marked = rows.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("»") && span.style == success)
    });
    assert!(fired_marked, "the fired marker must paint success");
}

/// The Mermaid emission: the same graph model, with the active class and
/// the last-fired link styles — pasteable and rendering the same
/// highlighting.
#[test]
fn mermaid_source_carries_the_active_classdef_and_fired_link_styles() {
    let runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    let source = diagram::mermaid_source(&runs[0]);
    assert!(
        source.starts_with("%% factory: review-loop — running"),
        "{source}"
    );
    assert!(source.contains("flowchart TD"), "{source}");
    assert!(
        source.contains("s0[\"collect*\"]"),
        "the entry marker: {source}"
    );
    assert!(
        source.contains("classDef active fill:#16a34a"),
        "the active classDef: {source}"
    );
    assert!(
        source.contains("class s1 active"),
        "the running node carries the active class: {source}"
    );
    assert!(
        source.contains("class s0 done"),
        "the settled node carries the done class: {source}"
    );
    assert!(
        source.contains("s0 -->|settled| s1"),
        "the plain edge: {source}"
    );
    assert!(
        source.contains("s1 -->|verdict.approved eq false| s2"),
        "the guarded edge label: {source}"
    );
    assert!(
        source.contains("linkStyle 0 stroke:#16a34a"),
        "the fired edge's link style: {source}"
    );
    assert!(
        source.contains("s2 -->|settled| s1"),
        "the back edge renders like every plain edge: {source}"
    );
}

/// The empty state and the key hint.
#[test]
fn the_empty_state_names_the_surface() {
    let mut view = FactoryView::new(Vec::new(), 40);
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(joined.contains("No live factory runs."), "{joined}");
    assert!(joined.contains("await rlm.factory.run"), "{joined}");
    assert!(joined.contains("select"), "{joined}");
    assert!(joined.contains("copy mermaid"), "{joined}");
}

/// The key loop: stop/resume ride the selected run, resume only while
/// paused, the mermaid copy carries the source, and Esc closes.
#[test]
fn the_key_loop_resolves_the_orchestration_actions() {
    let runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    let mut view = FactoryView::new(runs, 40);
    // Stop the selected run.
    assert_eq!(
        view.handle_key("s", &kb()),
        FactoryViewAction::Stop {
            run_id: "run-abc12345".to_string()
        }
    );
    // A running run never offers resume.
    assert_eq!(view.handle_key("r", &kb()), FactoryViewAction::None);
    // The mermaid copy carries genuine source.
    match view.handle_key("m", &kb()) {
        FactoryViewAction::CopyMermaid { source } => {
            assert!(source.contains("flowchart TD"), "{source}");
        }
        other => panic!("expected CopyMermaid, got {other:?}"),
    }
    assert_eq!(view.handle_key("esc", &kb()), FactoryViewAction::Close);
    // A paused run offers resume.
    let mut paused = parse_factory_runs(&runs_response(&scripted_snapshot()));
    paused[0].state = Some("paused".to_string());
    let mut view = FactoryView::new(paused, 40);
    assert_eq!(
        view.handle_key("r", &kb()),
        FactoryViewAction::Resume {
            run_id: "run-abc12345".to_string()
        }
    );
}

/// The repaint hysteresis: an unchanged snapshot applies without a
/// changed marker, and a state/instance change lights it exactly for
/// that run.
#[test]
fn apply_runs_lights_the_marker_only_on_notice_worthy_changes() {
    let runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    let mut view = FactoryView::new(runs, 40);
    // The same snapshot: no change.
    let changed = view.apply_runs(parse_factory_runs(&runs_response(&scripted_snapshot())));
    assert!(!changed, "an identical snapshot changes nothing");
    let rows = frame_text(&mut view);
    assert!(
        !rows.join("\n").contains("changed"),
        "the marker stays off for an identical snapshot"
    );
    // The instance settles: a notice-worthy change.
    let mut settled = scripted_snapshot();
    settled["nodes"][1]["status"] = json!("done");
    settled["nodes"][1]["instances"][0]["status"] = json!("done");
    let changed = view.apply_runs(parse_factory_runs(&runs_response(&settled)));
    assert!(changed, "a state/instance change is notice-worthy");
    let rows = frame_text(&mut view);
    assert!(
        rows.join("\n").contains("changed"),
        "the changed marker lights on the state change"
    );
    // The marker decays on the next unchanged cycle.
    let changed = view.apply_runs(parse_factory_runs(&runs_response(&settled)));
    assert!(!changed);
    let rows = frame_text(&mut view);
    assert!(
        !rows.join("\n").contains("changed"),
        "the marker decays once quiescent"
    );
}

/// Two runs: the selection moves and the panels keep their identities.
#[test]
fn multiple_runs_keep_the_selection_on_the_same_run() {
    let second = scripted_snapshot();
    let mut response = runs_response(&scripted_snapshot());
    response["runs"].as_array_mut().unwrap().push(second);
    response["runs"][1]["runId"] = json!("run-def67890");
    response["runs"][1]["nodes"][1]["status"] = json!("done");
    let runs = parse_factory_runs(&response);
    let mut view = FactoryView::new(runs, 40);
    assert_eq!(view.selected, 0);
    let _ = view.handle_key("j", &kb());
    assert_eq!(view.selected, 1);
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-def67890".to_string())
    );
    // The refresh keeps the selection on the same run id.
    view.apply_runs(parse_factory_runs(&response));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-def67890".to_string())
    );
}

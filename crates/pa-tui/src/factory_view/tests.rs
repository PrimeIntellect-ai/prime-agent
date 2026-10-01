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

/// A scripted run in the ACTIVITY LANE's wire shape — derived from a
/// real `factory_activity` graph reply (the kernel's `_graph_snapshot`
/// rows converted by `_wire_payload` in `rlm/factory.py`: the reply
/// keys are camelCase end to end, matching the protocol's request
/// frame): the review-loop machine mid-flight — collect done, reviewing
/// running (its first entry settled, so the collect edge fired), fixing
/// pending — plus the usage and milestone tail.
fn scripted_snapshot() -> serde_json::Value {
    json!({
        "runId": "run-abc12345",
        "specId": "review-loop",
        "name": "review-loop",
        "state": "running",
        "pauseReason": null,
        "elapsedMs": 45_000,
        "machine": {
            "run": { "maxParallel": 4, "maxTransitions": 40, "failurePolicy": "continue", "budgetMs": 600_000 },
            "states": [
                { "id": "collect", "entry": true, "lifecycle": "task", "maxEntries": 1, "retries": 0, "subagent": "researcher" },
                { "id": "reviewing", "entry": false, "lifecycle": "task", "maxEntries": 4, "retries": 1 },
                { "id": "fixing", "entry": false, "lifecycle": "task", "maxEntries": 3, "retries": 0 }
            ],
            "transitions": [
                { "from": "collect", "to": "reviewing", "on": "settled" },
                { "from": "reviewing", "to": "fixing", "on": "settled",
                  "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false } },
                { "from": "reviewing", "to": "reviewing", "on": "settled", "when": { "output": "verdict", "op": "exists" } },
                { "from": "fixing", "to": "reviewing", "on": "settled" }
            ],
            "order": ["collect", "reviewing", "fixing"]
        },
        "nodes": [
            { "id": "collect", "status": "done", "lifecycle": "task", "attempts": 1,
              "entriesUsed": 1, "maxEntries": 1,
              "entries": [ { "index": 0, "status": "done", "error": null } ],
              "instances": [ { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-1", "durationMs": 5, "error": null } ] },
            { "id": "reviewing", "status": "running", "lifecycle": "task", "attempts": 1,
              "entriesUsed": 1, "maxEntries": 4,
              "entries": [ { "index": 0, "status": "running", "error": null } ],
              "instances": [ { "index": 0, "entry": 0, "status": "running", "attempt": 1, "child": "child-2", "durationMs": 0, "error": null } ] },
            { "id": "fixing", "status": "pending", "lifecycle": "task", "attempts": 0,
              "entriesUsed": 0, "maxEntries": 3, "entries": [], "instances": [] }
        ],
        "activeNodes": ["reviewing"],
        "lastFired": [ { "from": "collect", "to": "reviewing", "seq": 7 } ],
        "events": [
            { "seq": 1, "kind": "milestone", "stage": "shown", "milestone": "started" },
            { "seq": 7, "kind": "transition_fired", "stage": "recorded", "from": "collect", "to": "reviewing" }
        ],
        "usage": { "spawns": 2, "settled": 1, "toolUses": 5, "maxParallel": 4,
                   "running": 1, "transitionsFired": 1 },
        "budget": { "limitMs": 600_000, "consumedMs": 45_000 }
    })
}

/// The same reply in the KERNEL's conversation shape (the wire fixture
/// with every key re-spelled `snake_case`): the parser tolerates both
/// spellings, so this fixture must parse to the identical struct.
fn kernel_shape_snapshot() -> serde_json::Value {
    rekey_snake(&scripted_snapshot())
}

/// Re-spell a wire fixture's keys `snake_case` (`runId` -> `run_id`),
/// the mechanical mirror of the kernel's `_wire_payload` so the two
/// fixtures can never drift.
fn rekey_snake(value: &serde_json::Value) -> serde_json::Value {
    fn snake(key: &str) -> String {
        let mut out = String::with_capacity(key.len() + 4);
        for character in key.chars() {
            if character.is_ascii_uppercase() {
                out.push('_');
                out.push(character.to_ascii_lowercase());
            } else {
                out.push(character);
            }
        }
        out
    }
    match value {
        serde_json::Value::Object(object) => object
            .iter()
            .map(|(key, item)| (snake(key), rekey_snake(item)))
            .collect(),
        serde_json::Value::Array(rows) => rows.iter().map(rekey_snake).collect(),
        other => other.clone(),
    }
}

fn runs_response(snapshot: &serde_json::Value) -> serde_json::Value {
    json!({ "runs": [snapshot] })
}

/// Two live runs for the window battery: the second panel's name differs
/// so the header rows tell the runs apart.
fn two_run_response() -> serde_json::Value {
    let mut response = runs_response(&scripted_snapshot());
    let second = scripted_snapshot();
    response["runs"].as_array_mut().unwrap().push(second);
    response["runs"][1]["runId"] = json!("run-def67890");
    response["runs"][1]["name"] = json!("second-run");
    response
}

/// The parser fuses the structure and the live overlay from the wire
/// reply's `camelCase` keys (a wrong-spelling read defaults every field,
/// so each field below is the mutation check on its key).
#[test]
fn parsing_fuses_structure_and_live_state() {
    let runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(run.run_id, "run-abc12345");
    assert_eq!(run.spec_id, "review-loop");
    assert_eq!(run.state.as_deref(), Some("running"));
    assert_eq!(run.elapsed_ms, 45_000, "elapsedMs (the wire spelling)");
    assert_eq!(run.budget_limit_ms, Some(600_000), "budget.limitMs");
    assert_eq!(run.states.len(), 3);
    assert!(run.states[0].entry);
    assert_eq!(run.states[1].max_entries, 4, "state maxEntries");
    assert_eq!(run.transitions.len(), 4);
    assert_eq!(run.nodes["reviewing"].status, "running");
    assert_eq!(run.nodes["reviewing"].entries_used, 1, "node entriesUsed");
    assert_eq!(run.nodes["reviewing"].max_entries, 4, "node maxEntries");
    assert_eq!(run.last_fired[0].to, "reviewing");
    assert_eq!(run.milestones, vec!["started".to_string()]);
    let usage = run.usage.as_ref().expect("usage parses");
    assert_eq!(usage.running, 1);
    assert_eq!(usage.tool_uses, 5, "usage toolUses");
    assert_eq!(usage.max_parallel, 4, "usage maxParallel");
    assert_eq!(usage.transitions_fired, 1, "usage transitionsFired");
    assert_eq!(
        run.active_state_ids(),
        vec!["reviewing".to_string()],
        "the running node is the active one"
    );
}

/// Both spellings parse: the activity wire's `camelCase` reply and the
/// kernel's `snake_case` conversation shape fuse to the identical
/// struct (the tolerance pin — a single-spelling parser drops the other
/// side's rows, which is exactly the always-empty-view bug).
#[test]
fn parsing_tolerates_both_wire_spellings() {
    let wire = parse_factory_runs(&runs_response(&scripted_snapshot()));
    let kernel = parse_factory_runs(&runs_response(&kernel_shape_snapshot()));
    assert_eq!(kernel.len(), 1, "the snake_case conversation shape parses");
    assert_eq!(kernel[0].run_id, "run-abc12345");
    assert_eq!(kernel[0].usage.as_ref().unwrap().tool_uses, 5);
    assert_eq!(wire.len(), 1, "the camelCase wire shape parses");
    assert_eq!(wire[0], kernel[0], "both spellings fuse to the same run");
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
    assert!(
        joined.contains("1/4 parallel"),
        "the max_parallel stat: {joined}"
    );
    assert!(
        joined.contains("1 transitions"),
        "the transitions_fired stat: {joined}"
    );
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
/// highlighting (the pending node carries the dim pending class, never
/// the bright active one — the mutation check on the class assignment).
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
        source.contains("classDef pending fill:#1e293b"),
        "the dim pending classDef: {source}"
    );
    assert!(
        source.contains("class s1 active"),
        "the running node carries the active class: {source}"
    );
    assert!(
        source.contains("class s2 pending"),
        "the queued node carries the dim pending class: {source}"
    );
    assert!(
        !source.contains("class s2 active"),
        "the queued node never paints active: {source}"
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

/// The reply-shape contract: a graph reply without the runs list is a
/// malformed lane, never zero runs (the empty state reflects real
/// emptiness — the mutation check on the malformed-reply guard).
#[test]
fn a_reply_without_the_runs_list_is_malformed_not_empty() {
    assert!(
        factory_reply_lists_runs(&json!({ "runs": [] })),
        "the empty runs list IS the real empty state"
    );
    assert!(
        !factory_reply_lists_runs(&json!({})),
        "a missing runs list is a malformed lane"
    );
    assert!(
        !factory_reply_lists_runs(&json!({ "machine": {} })),
        "a wrong-shape reply is a malformed lane"
    );
    assert!(
        !factory_reply_lists_runs(&json!("runs")),
        "a non-object reply is a malformed lane"
    );
}

/// The fired-edge identity includes the guard: two transitions may share
/// one from+to pair with different guards, so the fired marking must
/// light only the one that fired (the mutation check: matching on
/// from+to alone cross-marks the sibling).
#[test]
fn the_fired_edge_identity_includes_the_guard() {
    let mut snapshot = scripted_snapshot();
    snapshot["machine"]["transitions"] = json!([
        { "from": "collect", "to": "reviewing", "on": "settled" },
        { "from": "reviewing", "to": "fixing", "on": "settled",
          "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false } },
        { "from": "reviewing", "to": "fixing", "on": "settled",
          "when": { "output": "verdict", "path": "approved", "op": "eq", "value": true } }
    ]);
    // Only the first guard fired; the edge carries its guard.
    snapshot["lastFired"] = json!([
        { "from": "reviewing", "to": "fixing", "seq": 9,
          "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false } }
    ]);
    let runs = parse_factory_runs(&runs_response(&snapshot));
    let source = diagram::mermaid_source(&runs[0]);
    assert!(
        source.contains("linkStyle 1 stroke:#16a34a"),
        "the fired guard's edge carries the fired mark: {source}"
    );
    assert!(
        !source.contains("linkStyle 2"),
        "the sibling guard with the same from+to never cross-marks: {source}"
    );
}

/// The Mermaid source stays one valid diagram when runtime text carries
/// Mermaid syntax characters: a guard whose value contains the
/// edge-label delimiter `|`, a run name with a newline, and a state id
/// with the node-label quote (the mutation check: unsanitized
/// interpolation breaks the labels).
#[test]
fn the_mermaid_source_neutralizes_label_breaking_text() {
    let mut snapshot = scripted_snapshot();
    snapshot["name"] = json!("run\nname");
    // An unreferenced state carries the node-label quote.
    snapshot["machine"]["states"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "qu\"ote", "entry": false, "lifecycle": "task", "maxEntries": 1 }));
    snapshot["machine"]["transitions"][0]["when"] = json!({
        "output": "verdict", "op": "eq", "value": "x|y"
    });
    let runs = parse_factory_runs(&runs_response(&snapshot));
    let source = diagram::mermaid_source(&runs[0]);
    let first_line = source.lines().next().unwrap_or_default();
    assert!(
        first_line.starts_with("%% factory: run name"),
        "the header comment collapses newlines: {source}"
    );
    assert!(
        source.contains("x¦y"),
        "the pipe inside the guard neutralizes: {source}"
    );
    assert!(
        source.contains("qu″ote"),
        "the quote inside the state id neutralizes: {source}"
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
    // The real key id for the Escape key is "escape" (`key_event_to_id`)
    // — the page must close on it (the mutation check: matching only
    // "esc" strands the Escape key).
    assert_eq!(
        view.handle_key("escape", &kb()),
        FactoryViewAction::Close,
        "the Escape key closes the page"
    );
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
/// changed marker, a state/instance change lights it exactly for that
/// run, the marker decays once quiescent, and the clock never trips it
/// (elapsed-only movement is not notice-worthy — the mutation check on
/// the signature).
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
    // The clock never trips the marker: an elapsed-only bump repaints the
    // stats line but is not a notice-worthy run-shape change.
    let mut older = settled;
    older["elapsed_ms"] = json!(120_000);
    let changed = view.apply_runs(parse_factory_runs(&runs_response(&older)));
    assert!(
        !changed,
        "an elapsed-only bump is not a notice-worthy change"
    );
    let rows = frame_text(&mut view);
    assert!(
        !rows.join("\n").contains("changed"),
        "the clock keeps the changed marker off"
    );
}

/// Two runs: the selection moves and the panels keep their identities.
#[test]
fn multiple_runs_keep_the_selection_on_the_same_run() {
    let runs = parse_factory_runs(&two_run_response());
    let mut view = FactoryView::new(runs, 40);
    assert_eq!(view.selected, 0);
    let _ = view.handle_key("j", &kb());
    assert_eq!(view.selected, 1);
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-def67890".to_string())
    );
    // The refresh keeps the selection on the same run id.
    view.apply_runs(parse_factory_runs(&two_run_response()));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-def67890".to_string())
    );
}

/// The degenerate budget (a sub-chrome viewport on a short terminal):
/// the render still never exceeds what the viewport asked for, and the
/// tail-clip keeps the hint (the chrome's last row) — a 1-row viewport
/// shows the hint, never six rows (the mutation check: the old
/// `.max(6)` floor overflowed the dock on short terminals).
#[test]
fn the_degenerate_budget_still_honors_the_viewport() {
    let mut one_row = FactoryView::new(parse_factory_runs(&runs_response(&scripted_snapshot())), 1);
    let rows = frame_text(&mut one_row);
    assert_eq!(rows.len(), 1, "a 1-row viewport renders exactly one row");
    assert!(
        rows[0].contains("copy mermaid"),
        "the tail-clip keeps the hint: {:?}",
        rows[0]
    );
    let mut two_rows = FactoryView::new(parse_factory_runs(&two_run_response()), 2);
    let rows = frame_text(&mut two_rows);
    assert_eq!(rows.len(), 2, "a 2-row viewport renders exactly two rows");
    assert!(
        rows[1].contains("close"),
        "the hint is the last row: {:?}",
        rows[1]
    );
}

/// The render budget window (a tall view at a small viewport): the view
/// never renders more rows than the viewport asked for, the trailing key
/// hint always stays painted, and the selected run's panel header stays
/// visible even when the selection sits outside the trailing window —
/// a stop/resume target never hides behind the budget (the mutation
/// checks: leading-row truncation drops the hint, tail-only retention
/// drops the selected header).
#[test]
fn the_budget_window_keeps_the_hint_and_the_selected_panel() {
    let mut view = FactoryView::new(parse_factory_runs(&two_run_response()), 8);
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    // The budget contract: never more than the viewport asked for.
    assert!(
        rows.len() <= 8,
        "the view stays inside the budget: {joined}"
    );
    // The key hint stays painted (the trailing chrome never truncates).
    assert!(
        joined.contains("copy mermaid"),
        "the key hint stays painted: {joined}"
    );
    // The selected (first) run's header stays visible with its marker.
    assert!(
        joined.contains("▸ factory: review-loop — running"),
        "the selected run's header stays visible: {joined}"
    );

    // The selection on the newest run: the window follows the selection,
    // keeps the hint, and drops the older panel instead.
    let mut selected_newest = FactoryView::new(parse_factory_runs(&two_run_response()), 8);
    let _ = selected_newest.handle_key("j", &kb());
    let rows = frame_text(&mut selected_newest);
    let joined = rows.join("\n");
    assert!(
        rows.len() <= 8,
        "the view stays inside the budget: {joined}"
    );
    assert!(
        joined.contains("copy mermaid"),
        "the key hint stays painted: {joined}"
    );
    assert!(
        joined.contains("▸ factory: second-run — running"),
        "the newest selection's header stays visible: {joined}"
    );
    assert!(
        !joined.contains("factory: review-loop"),
        "the older panel drops instead of the chrome: {joined}"
    );
}

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

/// Two live runs for the battery, in the reply's start order (oldest
/// first — the kernel's documented polling order): review-loop started
/// first, second-run after it, so second-run is the NEWEST run and
/// renders on top. The name differs so the header rows tell the runs
/// apart, and the elapsed clocks match on purpose — a same-clock pair
/// is exactly where an elapsed sort would be ambiguous and the reply's
/// start order is not.
fn two_run_response() -> serde_json::Value {
    let mut response = runs_response(&scripted_snapshot());
    let second = scripted_snapshot();
    response["runs"].as_array_mut().unwrap().push(second);
    response["runs"][1]["runId"] = json!("run-def67890");
    response["runs"][1]["name"] = json!("second-run");
    response
}

/// Three live runs, again in the reply's start order (oldest first):
/// the third row is a run created after both — the fold battery's
/// "a newer run appears on top" case.
fn three_run_response() -> serde_json::Value {
    let mut response = two_run_response();
    let third = scripted_snapshot();
    response["runs"].as_array_mut().unwrap().push(third);
    response["runs"][2]["runId"] = json!("run-ghi13579");
    response["runs"][2]["name"] = json!("third-run");
    response
}

/// The two newer runs remain after the oldest leaves the reply (the wire
/// cap's oldest-end trim), still in the reply's start order.
fn later_pair_response() -> serde_json::Value {
    let mut response = runs_response(&scripted_snapshot());
    response["runs"][0]["runId"] = json!("run-def67890");
    response["runs"][0]["name"] = json!("second-run");
    let third = scripted_snapshot();
    response["runs"].as_array_mut().unwrap().push(third);
    response["runs"][1]["runId"] = json!("run-ghi13579");
    response["runs"][1]["name"] = json!("third-run");
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
    assert!(
        joined.contains("when verdict exists"),
        "the valueless guard label: {joined}"
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

/// The node's live activity paints the row, not the aggregate status: a
/// multi-entry state whose latest entry settled while an earlier one
/// still runs stays bright in both the terminal diagram and the
/// Mermaid export (the mutation check: keying on `status` alone paints
/// the in-flight state settled).
#[test]
fn a_multi_entry_state_with_an_in_flight_entry_stays_bright() {
    let mut snapshot = scripted_snapshot();
    // `reviewing` has maxEntries 4: its latest entry settled (status
    // "done") while an earlier entry still runs.
    snapshot["nodes"][1]["status"] = json!("done");
    snapshot["nodes"][1]["entries"] = json!([
        { "index": 0, "status": "running", "error": null },
        { "index": 1, "status": "done", "error": null },
    ]);
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 40);
    let rows = frame_spans(&mut view);
    let accent = theme().fg_style(ThemeColor::Accent);
    let bright = rows.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("reviewing") && span.style == accent)
    });
    assert!(bright, "the in-flight earlier entry keeps the row accent");
    let runs = parse_factory_runs(&runs_response(&snapshot));
    let source = diagram::mermaid_source(&runs[0]);
    assert!(
        source.contains("class s1 active"),
        "the Mermaid export paints the same live activity: {source}"
    );
    assert!(
        !source.contains("class s1 done"),
        "the settled-looking aggregate status never demotes it: {source}"
    );
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
    assert!(
        !factory_reply_lists_runs(&json!({ "runs": {} })),
        "a present non-array runs value is a malformed lane"
    );
    assert!(
        !factory_reply_lists_runs(&json!({ "runs": "x" })),
        "a string runs value is a malformed lane"
    );
}

/// The terminal-safety pin (the daemon-text scrub): every string the
/// view paints comes from the daemon's reply, and a reply carrying an
/// OSC 52 payload — or any ANSI/OSC sequence — must never drive the
/// terminal (e.g. overwrite the operator's clipboard). The parse seam
/// scrubs control bytes to spaces (`scrub_controls`, the bash activity
/// lane's rule); the run id alone stays raw — it never paints and must
/// round-trip the kernel's registry as the stop/resume/watch identity
/// (the mutation checks: an unscrubbed name, state id, or error line
/// fails the assertions here).
#[test]
fn daemon_text_never_carries_terminal_control_sequences() {
    let mut snapshot = scripted_snapshot();
    // The OSC 52 clipboard-overwrite payload and an ANSI SGR sequence,
    // in every display string the view paints.
    snapshot["name"] = json!("run\x1b]52;c;dGVzdA==\x07name");
    snapshot["specId"] = json!("spec\x1b[31mid");
    snapshot["machine"]["states"][0]["id"] = json!("col\x1b]52;c;evil\x07lect");
    snapshot["nodes"][0]["id"] = json!("col\x1b]52;c;evil\x07lect");
    snapshot["machine"]["states"][0]["subagent"] = json!("sub\x1b[31magent");
    snapshot["machine"]["transitions"][0]["when"] = json!({
        "output": "ver\x1b]52;c;evil\x07dict", "op": "eq", "value": false
    });
    snapshot["nodes"][0]["error"] = json!("err\x1b]52;c;evil\x07or");
    snapshot["events"][0]["milestone"] = json!("mile\x1b[31mstone");
    let has_control = |text: &str| text.chars().any(|c| c.is_control() && c != '\n');
    let runs = parse_factory_runs(&runs_response(&snapshot));
    assert!(
        runs.iter().all(|run| !has_control(&run.display_name())
            && !has_control(&run.states[0].id)
            && run.milestones.iter().all(|m| !has_control(m))),
        "the parsed display strings carry no control byte"
    );
    // The run id stays raw: it never paints, and the kernel's registry
    // answers it verbatim.
    assert_eq!(runs[0].run_id, "run-abc12345");
    // The painted frame and the copied Mermaid source carry no control
    // byte either — scrubbed text is the only thing that reaches a
    // span or the clipboard.
    let mut view = FactoryView::new(runs, 40);
    view.set_error(Some("boom\x1b]52;c;evil\x07".to_string()));
    let rows = frame_text(&mut view);
    for row in &rows {
        assert!(
            !has_control(row),
            "a rendered row carries no control byte: {row:?}"
        );
    }
    assert!(
        rows.iter().any(|row| row.contains("Error: boom")),
        "the scrubbed error text still paints: {rows:?}"
    );
    let run = view.selected_run().expect("a run is live");
    let source = diagram::mermaid_source(run);
    assert!(
        !has_control(&source),
        "the Mermaid copy carries no control byte: {source}"
    );
}

/// The mount contract (the open path's malformed cache): a cached reply
/// without the runs list is a malformed lane, not zero runs — mounting
/// from it sets the malformed-reply error at once instead of painting a
/// silent fake empty state for a poll cycle until the first fold
/// reports the lane (the fold's contract, held at mount; the mutation
/// check: mounting without the check paints no error line).
#[test]
fn a_malformed_cached_reply_mounts_with_the_error_not_a_silent_empty() {
    // A malformed cache mounts with the error line painted.
    let mut view = FactoryView::from_reply(&json!({ "machine": {} }), 40);
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("Error: malformed factory reply (no runs list)"),
        "the malformed cache reports itself at mount: {joined}"
    );
    // A real empty reply (the runs list present) mounts clean: the
    // genuine empty state, no error line.
    let mut view = FactoryView::from_reply(&json!({ "runs": [] }), 40);
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("No live factory runs."),
        "an empty runs list is the real empty state: {joined}"
    );
    assert!(
        !joined.contains("Error:"),
        "a real empty state never reports a malformed lane: {joined}"
    );
    // A good cache mounts its runs with no error line.
    let mut view = FactoryView::from_reply(&two_run_response(), 40);
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("factory: second-run"),
        "the cached runs mount newest-first: {joined}"
    );
    assert!(
        !joined.contains("Error:"),
        "a good cache mounts clean: {joined}"
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

/// The reading order (the UX pin): the reply carries the registry's
/// start order, oldest run first, and the view reads it NEWEST-FIRST
/// like a live activity feed — a run created after an existing one
/// renders ABOVE it, and the page opens with the newest run selected
/// (the mutation check: rendering the reply's insertion order instead
/// fails every assertion here).
#[test]
fn the_runs_list_reads_newest_first_and_opens_on_the_newest_run() {
    // The reply's order is start order: review-loop started first,
    // second-run after it.
    let runs = parse_factory_runs(&two_run_response());
    assert_eq!(
        runs.iter()
            .map(|run| run.run_id.as_str())
            .collect::<Vec<_>>(),
        vec!["run-def67890", "run-abc12345"],
        "the parsed list reads newest-first"
    );
    // The page opens with the newest run selected.
    let mut view = FactoryView::new(runs, 40);
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-def67890".to_string()),
        "the newest run is the default selection"
    );
    // The rendered frame: the newest run's panel is the first panel and
    // the older run renders below it.
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    let first_header = rows
        .iter()
        .find(|row| row.contains("factory: "))
        .expect("the panels render");
    assert!(
        first_header.contains("second-run"),
        "the newest run's panel renders first: {joined}"
    );
    let newest = rows
        .iter()
        .position(|row| row.contains("factory: second-run"))
        .expect("the newest run's header renders");
    let older = rows
        .iter()
        .position(|row| row.contains("factory: review-loop"))
        .expect("the older run's header renders");
    assert!(
        newest < older,
        "a run created after an existing one appears above it: {joined}"
    );
}

/// Two runs: the selection moves down the feed, and a refresh keeps
/// the selection on the SAME RUN, never the same index — a newer run
/// folding in on top moves the selected run down the list without
/// stealing the selection, and a run that left the batch returns the
/// selection to the feed's head (the mutation check: index-tracking
/// jumps to the new newest run and fails the fold assertions).
#[test]
fn multiple_runs_keep_the_selection_on_the_same_run() {
    let runs = parse_factory_runs(&two_run_response());
    let mut view = FactoryView::new(runs, 40);
    // The page opens on the newest run.
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-def67890".to_string())
    );
    // j moves the selection down the feed, to the older run.
    let _ = view.handle_key("j", &kb());
    assert_eq!(view.selected, 1);
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-abc12345".to_string())
    );
    // An unchanged refresh keeps the selection on the same run id.
    view.apply_runs(parse_factory_runs(&two_run_response()));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-abc12345".to_string())
    );
    // A run created after both folds in on top: the selected run moves
    // down the list (index 1 becomes index 2) and the selection stays
    // on the same run — the same index would be the new newest run.
    view.apply_runs(parse_factory_runs(&three_run_response()));
    assert_eq!(view.selected, 2);
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-abc12345".to_string()),
        "the selection stays on the same run, not the same index"
    );
    // The selected run leaves the batch (the wire cap's oldest-end trim
    // dropped it): the selection returns to the feed's head, the newest
    // run.
    view.apply_runs(parse_factory_runs(&later_pair_response()));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-ghi13579".to_string()),
        "a run that left the batch returns the selection to the head"
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
/// visible even when the selection sits below the top window — a
/// stop/resume target never hides behind the budget. The window keeps
/// the TOP of the newest-first feed (the newest panels render first,
/// the oldest panels drop first) and slides to the selection when it
/// falls below (the mutation check: a window without the slide hides
/// the selected run's header).
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
    // The default selection is the newest run: its header stays visible
    // with its marker, and the older panel drops first.
    assert!(
        joined.contains("▸ factory: second-run — running"),
        "the newest (selected) run's header stays visible: {joined}"
    );
    assert!(
        !joined.contains("factory: review-loop"),
        "the older panel drops instead of the chrome: {joined}"
    );

    // The selection moved down the feed (the older run): the window
    // follows the selection, keeps the hint, and drops the newest
    // panel instead.
    let mut selected_older = FactoryView::new(parse_factory_runs(&two_run_response()), 8);
    let _ = selected_older.handle_key("j", &kb());
    let rows = frame_text(&mut selected_older);
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
        joined.contains("▸ factory: review-loop — running"),
        "the selected run's header stays visible: {joined}"
    );
    assert!(
        !joined.contains("factory: second-run"),
        "the unselected newest panel drops instead of the chrome: {joined}"
    );
}

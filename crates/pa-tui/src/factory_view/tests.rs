//! The `/factory` view's battery: the snapshot parsing, the diagram's
//! highlighted rendering (asserted per span, so removing the active-node
//! marking fails the test — the mutation check), the key loop (the row
//! walk, the session open, and the two-press stop), the repaint
//! hysteresis, and the scale battery (the complex machine and the
//! fifteen-run world: selection stability, the dock's liveness count,
//! the render window, the refresh markers, and the churn discipline).

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
/// pending — plus the usage and milestone tail. Every node row carries
/// the kernel's per-stage agent counts (`running`/`queued`, single-word
/// keys both wire spellings carry identically).
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
              "instances": [ { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-1", "durationMs": 5, "error": null } ],
              "running": 0, "queued": 0 },
            { "id": "reviewing", "status": "running", "lifecycle": "task", "attempts": 1,
              "entriesUsed": 1, "maxEntries": 4,
              "entries": [ { "index": 0, "status": "running", "error": null } ],
              "instances": [ { "index": 0, "entry": 0, "status": "running", "attempt": 1, "child": "child-2", "durationMs": 0, "error": null } ],
              "running": 1, "queued": 0 },
            { "id": "fixing", "status": "pending", "lifecycle": "task", "attempts": 0,
              "entriesUsed": 0, "maxEntries": 3, "entries": [], "instances": [],
              "running": 0, "queued": 0 }
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

/// The same wire reply with a full per-stage occupancy: reviewing runs
/// a five-instance entry under the run's three-slot cap — three
/// admitted (running), two queued — with the kernel's counts and the
/// instance rows agreeing (`maxParallel` drops to 3: the cap is why
/// two instances queue).
fn occupied_snapshot() -> serde_json::Value {
    let mut snapshot = scripted_snapshot();
    snapshot["machine"]["run"]["maxParallel"] = json!(3);
    snapshot["usage"]["maxParallel"] = json!(3);
    snapshot["usage"]["spawns"] = json!(3);
    snapshot["usage"]["running"] = json!(3);
    snapshot["nodes"][1]["running"] = json!(3);
    snapshot["nodes"][1]["queued"] = json!(2);
    snapshot["nodes"][1]["instances"] = json!([
        { "index": 0, "entry": 0, "status": "running", "attempt": 1, "child": "child-2", "durationMs": 0, "error": null },
        { "index": 1, "entry": 0, "status": "running", "attempt": 1, "child": "child-3", "durationMs": 0, "error": null },
        { "index": 2, "entry": 0, "status": "running", "attempt": 1, "child": "child-4", "durationMs": 0, "error": null },
        { "index": 3, "entry": 0, "status": "pending", "attempt": 0, "child": null, "durationMs": null, "error": null },
        { "index": 4, "entry": 0, "status": "pending", "attempt": 0, "child": null, "durationMs": null, "error": null }
    ]);
    snapshot
}

/// The occupied reply without the kernel's count keys: an older
/// kernel's shape, where the occupancy derives from the instance rows.
fn occupied_snapshot_without_counts() -> serde_json::Value {
    let mut snapshot = occupied_snapshot();
    for node in snapshot["nodes"].as_array_mut().unwrap().iter_mut() {
        let object = node.as_object_mut().expect("node rows are objects");
        object.remove("running");
        object.remove("queued");
    }
    snapshot
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
    assert_eq!(
        run.nodes["reviewing"].running,
        Some(1),
        "the per-state running count"
    );
    assert_eq!(
        run.nodes["reviewing"].queued,
        Some(0),
        "the per-state queued count"
    );
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

/// A python state paints its callable where a subagent state paints its
/// subagent name.
#[test]
fn a_python_state_renders_its_callable() {
    let mut snapshot = scripted_snapshot();
    snapshot["machine"]["states"][0] = json!({
        "id": "collect", "entry": true, "lifecycle": "task", "maxEntries": 1, "retries": 0,
        "python": "my_tools.gh.open_prs"
    });
    let runs = parse_factory_runs(&runs_response(&snapshot));
    assert_eq!(
        runs[0].states[0].python.as_deref(),
        Some("my_tools.gh.open_prs")
    );
    let mut view = FactoryView::new(runs, 40);
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("collect (py my_tools.gh.open_prs)"),
        "{joined}"
    );
}

/// The per-stage agent occupancy (the UX ask): a stage's label carries
/// how many agents sit at it — `reviewing (3 run · 2 queued)` — read
/// from the kernel's per-state counts, with the instance rows as the
/// fallback for an older kernel's reply; a stage at rest carries no
/// fragment (the mutation checks: removing the label render empties
/// the row of the counts, and dropping the kernel-count parse or the
/// instance-row fallback fails the count assertions below).
#[test]
fn the_diagram_renders_per_stage_agent_occupancy() {
    let runs = parse_factory_runs(&runs_response(&occupied_snapshot()));
    assert_eq!(
        runs[0].nodes["reviewing"].running,
        Some(3),
        "the kernel's running count parses"
    );
    assert_eq!(
        runs[0].nodes["reviewing"].queued,
        Some(2),
        "the kernel's queued count parses"
    );
    let mut view = FactoryView::new(runs, 40);
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(
        joined.contains("reviewing (3 run · 2 queued)"),
        "the occupied stage's label carries its agent counts: {joined}"
    );
    assert!(
        !joined.contains("(0 run"),
        "a stage at rest carries no occupancy fragment: {joined}"
    );
    // An older kernel's reply (no count keys) derives the same counts
    // from the instance rows.
    let runs = parse_factory_runs(&runs_response(&occupied_snapshot_without_counts()));
    assert_eq!(
        runs[0].nodes["reviewing"].running, None,
        "no count keys ride the older reply"
    );
    assert_eq!(
        runs[0].nodes["reviewing"].running_agents(),
        3,
        "running derives from the instance rows"
    );
    assert_eq!(
        runs[0].nodes["reviewing"].queued_agents(),
        2,
        "queued derives from the instance rows"
    );
    let mut view = FactoryView::new(runs, 40);
    let rows = frame_text(&mut view);
    assert!(
        rows.join("\n").contains("reviewing (3 run · 2 queued)"),
        "the fallback renders the same occupancy"
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

/// The instance layer paints the row too: a foreach entry that failed
/// permanently is terminal at the entry layer while its admitted
/// siblings still run (the continue policy), so the occupancy label
/// keeps showing agents at the stage and the row stays bright (the
/// mutation check: keying on the entry rows alone paints a stage with
/// live children settled).
#[test]
fn a_terminal_entry_with_running_instances_stays_bright() {
    let mut snapshot = scripted_snapshot();
    // `reviewing`'s single foreach entry failed permanently; its second
    // instance is still in flight, so the occupancy keeps one agent.
    snapshot["nodes"][1]["status"] = json!("error");
    snapshot["nodes"][1]["entries"] = json!([
        { "index": 0, "status": "error", "error": "boom" },
    ]);
    snapshot["nodes"][1]["instances"] = json!([
        { "index": 0, "entry": 0, "status": "error", "attempt": 1, "child": "child-2", "durationMs": 5, "error": "boom" },
        { "index": 1, "entry": 0, "status": "running", "attempt": 1, "child": "child-3", "durationMs": 0, "error": null }
    ]);
    snapshot["nodes"][1]["running"] = json!(1);
    snapshot["nodes"][1]["queued"] = json!(0);
    snapshot["usage"]["running"] = json!(1);
    snapshot["activeNodes"] = json!(["reviewing"]);
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 40);
    let rows = frame_spans(&mut view);
    let accent = theme().fg_style(ThemeColor::Accent);
    let bright = rows.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("reviewing") && span.style == accent)
    });
    assert!(
        bright,
        "the running sibling keeps the failed entry's row bright"
    );
    let text = frame_text(&mut view);
    assert!(
        text.join("\n").contains("reviewing (1 run · 0 queued)"),
        "the occupancy label still shows the in-flight sibling"
    );
}

/// The node's live activity paints the row, not the aggregate status: a
/// multi-entry state whose latest entry settled while an earlier one
/// still runs stays bright in the terminal diagram (the mutation check:
/// keying on `status` alone paints the in-flight state settled).
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
    // The painted frame carries no control byte either — scrubbed
    // text is the only thing that reaches a span.
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
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 40);
    let rows = frame_text(&mut view);
    // Both sibling edges render; the fired `»` sits ONLY on the row of
    // the guard that fired — the sibling row with the same from+to
    // carries no marker.
    let fired_row = rows
        .iter()
        .find(|row| row.contains("\u{bb}"))
        .expect("the fired marker renders");
    assert!(
        fired_row.contains("verdict.approved eq false"),
        "the fired marker sits on the fired guard's edge: {fired_row}"
    );
    let sibling = rows
        .iter()
        .find(|row| row.contains("verdict.approved eq true"))
        .expect("the sibling guard's edge renders");
    assert!(
        !sibling.contains("\u{bb}"),
        "the sibling guard with the same from+to never cross-marks: {sibling}"
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
    assert!(
        joined.contains("move"),
        "the hint names the arrows: {joined}"
    );
    assert!(joined.contains("open"), "{joined}");
    assert!(joined.contains("back"), "{joined}");
}

/// The selected row as `(run id, state id)`.
fn selected_row(view: &FactoryView) -> (String, Option<String>) {
    let row = view.selected.clone().expect("a row is selected");
    (row.run_id, row.state_id)
}

/// Select a run's header directly (the many-run battery targets a run
/// without walking every row above it).
fn select_run(view: &mut FactoryView, run_id: &str) {
    view.selected = Some(FactoryRow::header(run_id));
}

fn row(run_id: &str, state_id: Option<&str>) -> (String, Option<String>) {
    (run_id.to_string(), state_id.map(str::to_string))
}

/// The arrows walk the run headers and the states that ran a session,
/// flattened across panels (newest run first); a state without a child —
/// never entered, or entered with no child spawned yet — is skipped and
/// paints dim, never accent. Both ends clamp.
#[test]
fn the_arrows_walk_headers_and_session_states_across_panels() {
    let mut response = two_run_response();
    // The newest run's `fixing` entered but spawned no child yet.
    response["runs"][1]["nodes"][2]["status"] = json!("running");
    response["runs"][1]["nodes"][2]["entries"] =
        json!([ { "index": 0, "status": "running", "error": null } ]);
    let mut view = FactoryView::new(parse_factory_runs(&response), 80);
    let expected = [
        row("run-def67890", None),
        row("run-def67890", Some("collect")),
        row("run-def67890", Some("reviewing")),
        row("run-abc12345", None),
        row("run-abc12345", Some("collect")),
        row("run-abc12345", Some("reviewing")),
    ];
    assert_eq!(selected_row(&view), expected[0]);
    for want in &expected[1..] {
        let _ = view.handle_key("down", &kb());
        assert_eq!(&selected_row(&view), want);
    }
    let _ = view.handle_key("down", &kb());
    assert_eq!(selected_row(&view), expected[5], "down clamps");
    for want in expected[..5].iter().rev() {
        let _ = view.handle_key("up", &kb());
        assert_eq!(&selected_row(&view), want);
    }
    let _ = view.handle_key("up", &kb());
    assert_eq!(selected_row(&view), expected[0], "up clamps");
    // The selected row carries the marker; the session-less state paints
    // dim even though it is active.
    let _ = view.handle_key("down", &kb());
    let text = frame_text(&mut view);
    assert!(
        text.iter().any(|row| row.starts_with(" ▸ ✓ collect")),
        "{text:?}"
    );
    let spans = frame_spans(&mut view);
    let paints = |color: ThemeColor| {
        spans
            .iter()
            .flatten()
            .any(|span| span.content == "fixing" && span.style == theme().fg_style(color))
    };
    assert!(paints(ThemeColor::Dim) && !paints(ThemeColor::Accent));
}

/// Enter and → open the selected state's LATEST child (a retry overwrites
/// the instance's child; a later entry's child wins); on a header they
/// open nothing.
#[test]
fn enter_and_right_open_the_latest_child_and_headers_open_nothing() {
    let mut snapshot = scripted_snapshot();
    snapshot["nodes"][1]["instances"] = json!([
        { "index": 0, "entry": 0, "status": "done", "attempt": 2, "child": "child-2-retry", "durationMs": 5, "error": null },
        { "index": 0, "entry": 1, "status": "running", "attempt": 1, "child": "child-5", "durationMs": 0, "error": null },
        { "index": 1, "entry": 1, "status": "pending", "attempt": 0, "child": null, "durationMs": null, "error": null }
    ]);
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 40);
    for key in ["enter", "right"] {
        assert_eq!(view.handle_key(key, &kb()), FactoryViewAction::None);
    }
    let _ = view.handle_key("down", &kb());
    let open = |child: &str| FactoryViewAction::Open {
        child_id: child.to_string(),
    };
    assert_eq!(view.handle_key("enter", &kb()), open("child-1"));
    let _ = view.handle_key("down", &kb());
    assert_eq!(view.handle_key("enter", &kb()), open("child-5"));
    assert_eq!(view.handle_key("right", &kb()), open("child-5"));
}

/// The accident this page had: on a live run, repeated navigation —
/// →→, Enter Enter, on the header or a running state — never stops or
/// resumes anything (paused, so both run actions are on offer).
#[test]
fn navigation_never_stops_or_resumes_a_run() {
    let mut runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    runs[0].state = Some("paused".to_string());
    let mut view = FactoryView::new(runs, 40);
    for _ in 0..3 {
        for key in ["right", "right", "enter", "enter"] {
            let action = view.handle_key(key, &kb());
            assert!(
                matches!(
                    action,
                    FactoryViewAction::None | FactoryViewAction::Open { .. }
                ),
                "{key} on {:?} acted: {action:?}",
                selected_row(&view)
            );
        }
        let _ = view.handle_key("down", &kb());
    }
}

/// The stop's two-press grammar (the agents view's `app.agents.delete`):
/// the first press arms the selected row and the footer asks to confirm,
/// a second press on the same row stops it — the run on a header, the
/// running child on a state — and any other key between the presses
/// disarms and does nothing else. A state whose child settled offers no
/// stop.
#[test]
fn the_stop_key_arms_then_stops_the_selected_row() {
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&scripted_snapshot())), 40);
    let hint = |view: &mut FactoryView| frame_text(view).last().cloned().unwrap_or_default();
    assert!(
        hint(&mut view).contains("stop"),
        "a live header offers stop"
    );
    assert_eq!(view.handle_key("ctrl+x", &kb()), FactoryViewAction::None);
    assert!(
        hint(&mut view).contains("stop review-loop? Ctrl+X again to confirm"),
        "{}",
        hint(&mut view)
    );
    assert_eq!(
        view.handle_key("ctrl+x", &kb()),
        FactoryViewAction::Stop {
            run_id: "run-abc12345".to_string()
        }
    );
    // Any other key between the presses disarms and does nothing else:
    // the arrow does not move, Esc does not close.
    for key in ["down", "escape", "enter"] {
        let _ = view.handle_key("ctrl+x", &kb());
        assert_eq!(view.handle_key(key, &kb()), FactoryViewAction::None);
        assert_eq!(selected_row(&view), row("run-abc12345", None));
        assert_eq!(
            view.handle_key("ctrl+x", &kb()),
            FactoryViewAction::None,
            "{key} disarmed: the next press re-arms"
        );
        let _ = view.handle_key("left", &kb());
    }
    // A settled child offers no stop; the running child stops.
    let _ = view.handle_key("down", &kb());
    assert!(!hint(&mut view).contains("stop"), "{}", hint(&mut view));
    assert_eq!(view.handle_key("ctrl+x", &kb()), FactoryViewAction::None);
    assert_eq!(view.handle_key("ctrl+x", &kb()), FactoryViewAction::None);
    let _ = view.handle_key("down", &kb());
    let _ = view.handle_key("ctrl+x", &kb());
    assert!(hint(&mut view).contains("stop review-loop/reviewing?"));
    assert_eq!(
        view.handle_key("ctrl+x", &kb()),
        FactoryViewAction::StopChild {
            child_id: "child-2".to_string(),
            label: "review-loop/reviewing".to_string()
        }
    );
    // A retry that replaces the armed child disarms: the next press arms
    // the new child, never stops it unconfirmed.
    let _ = view.handle_key("ctrl+x", &kb());
    let mut retried = scripted_snapshot();
    retried["nodes"][1]["instances"][0]["child"] = json!("child-9");
    view.apply_runs(parse_factory_runs(&runs_response(&retried)));
    assert_eq!(view.handle_key("ctrl+x", &kb()), FactoryViewAction::None);
    assert_eq!(
        view.handle_key("ctrl+x", &kb()),
        FactoryViewAction::StopChild {
            child_id: "child-9".to_string(),
            label: "review-loop/reviewing".to_string()
        }
    );
    // A fold that settles the armed child disarms it.
    let _ = view.handle_key("ctrl+x", &kb());
    let mut settled = scripted_snapshot();
    settled["nodes"][1]["instances"][0]["status"] = json!("done");
    view.apply_runs(parse_factory_runs(&runs_response(&settled)));
    assert!(!hint(&mut view).contains("again to confirm"));
    assert_eq!(view.handle_key("ctrl+x", &kb()), FactoryViewAction::None);
}

/// `r` resumes the selected row's run only while it is paused (no
/// confirmation); the footer offers it exactly then.
#[test]
fn r_resumes_only_a_paused_run() {
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&scripted_snapshot())), 40);
    assert_eq!(view.handle_key("r", &kb()), FactoryViewAction::None);
    assert!(!frame_text(&mut view).join("\n").contains("r resume"));
    let mut paused = parse_factory_runs(&runs_response(&scripted_snapshot()));
    paused[0].state = Some("paused".to_string());
    let mut view = FactoryView::new(paused, 40);
    let _ = view.handle_key("down", &kb());
    assert!(frame_text(&mut view).join("\n").contains("r resume"));
    assert_eq!(
        view.handle_key("r", &kb()),
        FactoryViewAction::Resume {
            run_id: "run-abc12345".to_string()
        }
    );
}

/// ← and Esc (the real `escape` key id), `esc`, and ctrl+c close the
/// page; a rebound Left keeps its configured action.
#[test]
fn left_and_escape_close_the_page() {
    let mut view = FactoryView::new(parse_factory_runs(&two_run_response()), 40);
    for key in ["left", "escape", "esc", "ctrl+c"] {
        assert_eq!(view.handle_key(key, &kb()), FactoryViewAction::Close);
    }
    let rebound: KeybindingsManager = KeybindingsManager::with_user_bindings(
        serde_json::from_value(json!({"tui.select.up": ["left"]})).unwrap(),
    );
    let _ = view.handle_key("down", &rebound);
    assert_eq!(view.handle_key("left", &rebound), FactoryViewAction::None);
    assert_eq!(selected_row(&view), row("run-def67890", None));
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

/// A refresh keeps the selection on the SAME ROW, never the same index:
/// a newer run folding in on top shifts every index without stealing the
/// selection, a state that lost its session falls back to its run's
/// header, and a run that left the batch hands the selection to the
/// first row (the newest run's header).
#[test]
fn a_fold_keeps_the_selection_on_the_same_row() {
    let mut view = FactoryView::new(parse_factory_runs(&two_run_response()), 40);
    for _ in 0..5 {
        let _ = view.handle_key("down", &kb());
    }
    assert_eq!(selected_row(&view), row("run-abc12345", Some("reviewing")));
    view.apply_runs(parse_factory_runs(&three_run_response()));
    assert_eq!(
        selected_row(&view),
        row("run-abc12345", Some("reviewing")),
        "a newer run on top never steals the selection"
    );
    let mut without_session = three_run_response();
    without_session["runs"][0]["nodes"][1]["instances"] = json!([]);
    view.apply_runs(parse_factory_runs(&without_session));
    assert_eq!(
        selected_row(&view),
        row("run-abc12345", None),
        "a vanished state falls back to its run's header"
    );
    view.apply_runs(parse_factory_runs(&later_pair_response()));
    assert_eq!(
        selected_row(&view),
        row("run-ghi13579", None),
        "a run that left the batch hands the selection to the first row"
    );
    view.apply_runs(Vec::new());
    assert!(view.selected.is_none(), "no runs, nothing selected");
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
        rows[0].contains("back"),
        "the tail-clip keeps the hint: {:?}",
        rows[0]
    );
    let mut two_rows = FactoryView::new(parse_factory_runs(&two_run_response()), 2);
    let rows = frame_text(&mut two_rows);
    assert_eq!(rows.len(), 2, "a 2-row viewport renders exactly two rows");
    assert!(
        rows[1].contains("back"),
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
        joined.contains("Enter/→ open"),
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
    select_run(&mut selected_older, "run-abc12345");
    let rows = frame_text(&mut selected_older);
    let joined = rows.join("\n");
    assert!(
        rows.len() <= 8,
        "the view stays inside the budget: {joined}"
    );
    assert!(
        joined.contains("Enter/→ open"),
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

// ---------------------------------------------------------------------------
// The scale battery's scenario data: the complex machine (the seed
// pr-manager shape) and the synthetic many-run world.
// ---------------------------------------------------------------------------

/// One pr-manager-shaped run (the machine-library seed's shape, the wire
/// lane's camelCase): SEVEN states — the `triage` entry, the bounded
/// review loop (`review` ⇄ `fix` on the verdict's two guarded branches),
/// the `verify` pass, the `merge`, the resident `watchdog` (admitted
/// once triage settles, running until stop), and the `report` behind the
/// fan-in join `[merge, verify]` — mid-flight: triage settled (both its
/// edges fired), the review entry in flight, the watchdog resident
/// running.
fn pr_manager_run(run_id: &str, name: &str) -> serde_json::Value {
    json!({
        "runId": run_id,
        "specId": "pr-manager",
        "name": name,
        "state": "running",
        "pauseReason": null,
        "elapsedMs": 120_000,
        "machine": {
            "run": { "maxParallel": 4, "maxTransitions": 40, "failurePolicy": "continue", "budgetMs": 900_000 },
            "states": [
                { "id": "triage", "entry": true, "lifecycle": "task", "maxEntries": 1, "retries": 0, "subagent": "triager" },
                { "id": "review", "entry": false, "lifecycle": "task", "maxEntries": 4, "retries": 1, "subagent": "reviewer" },
                { "id": "fix", "entry": false, "lifecycle": "task", "maxEntries": 3, "retries": 0, "subagent": "fixer" },
                { "id": "verify", "entry": false, "lifecycle": "task", "maxEntries": 1, "retries": 0, "subagent": "verifier" },
                { "id": "merge", "entry": false, "lifecycle": "task", "maxEntries": 1, "retries": 0, "subagent": "merger" },
                { "id": "watchdog", "entry": false, "lifecycle": "resident", "maxEntries": 1, "retries": 0, "subagent": "watchdog" },
                { "id": "report", "entry": false, "lifecycle": "task", "maxEntries": 1, "retries": 0, "subagent": "reporter" }
            ],
            "transitions": [
                { "from": "triage", "to": "review", "on": "settled" },
                { "from": "triage", "to": "watchdog", "on": "settled" },
                { "from": "review", "to": "fix", "on": "settled",
                  "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false } },
                { "from": "review", "to": "merge", "on": "settled",
                  "when": { "output": "verdict", "path": "approved", "op": "eq", "value": true } },
                { "from": "fix", "to": "review", "on": "settled" },
                { "from": "fix", "to": "verify", "on": "settled" },
                { "from": "verify", "to": "merge", "on": "settled" },
                { "from": ["merge", "verify"], "to": "report", "on": "settled" }
            ],
            "order": ["triage", "review", "fix", "verify", "merge", "watchdog", "report"]
        },
        "nodes": [
            { "id": "triage", "status": "done", "lifecycle": "task", "attempts": 1,
              "entriesUsed": 1, "maxEntries": 1,
              "entries": [ { "index": 0, "status": "done", "error": null } ],
              "instances": [ { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-t1", "durationMs": 8, "error": null } ],
              "running": 0, "queued": 0 },
            { "id": "review", "status": "running", "lifecycle": "task", "attempts": 1,
              "entriesUsed": 1, "maxEntries": 4,
              "entries": [ { "index": 0, "status": "running", "error": null } ],
              "instances": [ { "index": 0, "entry": 0, "status": "running", "attempt": 1, "child": "child-r1", "durationMs": 0, "error": null } ],
              "running": 1, "queued": 0 },
            { "id": "fix", "status": "pending", "lifecycle": "task", "attempts": 0,
              "entriesUsed": 0, "maxEntries": 3, "entries": [], "instances": [],
              "running": 0, "queued": 0 },
            { "id": "verify", "status": "pending", "lifecycle": "task", "attempts": 0,
              "entriesUsed": 0, "maxEntries": 1, "entries": [], "instances": [],
              "running": 0, "queued": 0 },
            { "id": "merge", "status": "pending", "lifecycle": "task", "attempts": 0,
              "entriesUsed": 0, "maxEntries": 1, "entries": [], "instances": [],
              "running": 0, "queued": 0 },
            { "id": "watchdog", "status": "running", "lifecycle": "resident", "attempts": 1,
              "entriesUsed": 1, "maxEntries": 1,
              "entries": [ { "index": 0, "status": "running", "error": null } ],
              "instances": [ { "index": 0, "entry": 0, "status": "running", "attempt": 1, "child": "child-w1", "durationMs": 0, "error": null } ],
              "running": 1, "queued": 0 },
            { "id": "report", "status": "pending", "lifecycle": "task", "attempts": 0,
              "entriesUsed": 0, "maxEntries": 1, "entries": [], "instances": [],
              "running": 0, "queued": 0 }
        ],
        "activeNodes": ["review", "watchdog"],
        "lastFired": [
            { "from": "triage", "to": "review", "seq": 2 },
            { "from": "triage", "to": "watchdog", "seq": 3 }
        ],
        "events": [
            { "seq": 1, "kind": "milestone", "stage": "shown", "milestone": "started" },
            { "seq": 2, "kind": "transition_fired", "stage": "recorded", "from": "triage", "to": "review" },
            { "seq": 3, "kind": "transition_fired", "stage": "recorded", "from": "triage", "to": "watchdog" },
            { "seq": 4, "kind": "milestone", "stage": "shown", "milestone": "triaged" }
        ],
        "usage": { "spawns": 2, "settled": 1, "toolUses": 12, "maxParallel": 4,
                   "running": 2, "transitionsFired": 2 },
        "budget": { "limitMs": 900_000, "consumedMs": 120_000 }
    })
}

/// The review node's many-instance variant (the occupied stage): one
/// entry holding four prepared instances — three admitted under the
/// run's four-slot cap (the resident watchdog holds the fourth), one
/// queued; with `queued_too`, two more queue behind the cap.
fn occupied_review_node(run: &mut serde_json::Value, queued_too: bool) {
    let mut instances = vec![
        json!({ "index": 0, "entry": 0, "status": "running", "attempt": 1, "child": "child-r1", "durationMs": 0, "error": null }),
        json!({ "index": 1, "entry": 0, "status": "running", "attempt": 1, "child": "child-r2", "durationMs": 0, "error": null }),
        json!({ "index": 2, "entry": 0, "status": "running", "attempt": 1, "child": "child-r3", "durationMs": 0, "error": null }),
    ];
    let mut queued = 0;
    if queued_too {
        instances.push(json!({ "index": 3, "entry": 0, "status": "pending", "attempt": 0, "child": null, "durationMs": null, "error": null }));
        instances.push(json!({ "index": 4, "entry": 0, "status": "pending", "attempt": 0, "child": null, "durationMs": null, "error": null }));
        queued = 2;
    }
    run["nodes"][1]["instances"] = json!(instances);
    run["nodes"][1]["running"] = json!(3);
    run["nodes"][1]["queued"] = json!(queued);
    run["usage"]["spawns"] = json!(4 + queued);
    run["usage"]["running"] = json!(4);
}

/// One world run at its scripted stage: the orchestrated page's varied
/// world — eight live (two carrying many instances at a stage), one
/// stopping, two paused, two done-with-residents (the resident still
/// running), one failed (torn down), one stopped (the residents
/// teardown's terminal state, no child in flight).
fn world_run(index: usize) -> serde_json::Value {
    let mut run = pr_manager_run(&format!("run-w{index:02}"), &format!("world-run-{index}"));
    match index % 15 {
        2 => occupied_review_node(&mut run, false),
        5 => occupied_review_node(&mut run, true),
        8 => {
            // The stop was issued mid-review: the transitional state, the
            // children still in flight while they tear down.
            run["state"] = json!("stopping");
        }
        9 | 10 => {
            run["state"] = json!("paused");
        }
        11 | 12 => {
            // The machine completed with the resident still watching: a
            // `done` run whose children are in flight stays live.
            run["state"] = json!("done");
            run["nodes"][1] = json!({
                "id": "review", "status": "done", "lifecycle": "task", "attempts": 1,
                "entriesUsed": 1, "maxEntries": 4,
                "entries": [ { "index": 0, "status": "done", "error": null } ],
                "instances": [ { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-r1", "durationMs": 30, "error": null } ],
                "running": 0, "queued": 0
            });
            for (node, status) in [(3, "done"), (4, "done"), (6, "done")] {
                run["nodes"][node]["status"] = json!(status);
                run["nodes"][node]["attempts"] = json!(1);
                run["nodes"][node]["entriesUsed"] = json!(1);
                run["nodes"][node]["entries"] =
                    json!([ { "index": 0, "status": "done", "error": null } ]);
                run["nodes"][node]["instances"] = json!([
                    { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-x1", "durationMs": 5, "error": null }
                ]);
            }
            run["activeNodes"] = json!(["watchdog"]);
            run["lastFired"] = json!([
                { "from": ["merge", "verify"], "to": "report", "seq": 9 },
                { "from": "verify", "to": "merge", "seq": 8 },
                { "from": "review", "to": "merge", "seq": 7,
                  "when": { "output": "verdict", "path": "approved", "op": "eq", "value": true } },
                { "from": "triage", "to": "review", "seq": 2 },
                { "from": "triage", "to": "watchdog", "seq": 3 }
            ]);
            run["usage"] = json!({ "spawns": 5, "settled": 5, "toolUses": 41, "maxParallel": 4,
                                   "running": 1, "transitionsFired": 5 });
        }
        13 => {
            // The failure policy failed the run: the review error, the
            // residents torn down, no child in flight.
            run["state"] = json!("failed");
            run["nodes"][1]["status"] = json!("error");
            run["nodes"][1]["error"] = json!("the reviewer rejected the diff: malformed patch");
            run["nodes"][5]["status"] = json!("cancelled");
            run["nodes"][5]["entries"] =
                json!([ { "index": 0, "status": "cancelled", "error": null } ]);
            run["nodes"][5]["instances"] = json!([
                { "index": 0, "entry": 0, "status": "cancelled", "attempt": 1, "child": "child-w1", "durationMs": 12, "error": null }
            ]);
            run["nodes"][5]["running"] = json!(0);
            run["activeNodes"] = json!([]);
            run["usage"]["running"] = json!(0);
            run["usage"]["settled"] = json!(2);
        }
        14 => {
            // The operator stopped it mid-review: the terminal teardown
            // state, no child in flight.
            run["state"] = json!("stopped");
            run["nodes"][1]["status"] = json!("cancelled");
            run["nodes"][1]["entries"] =
                json!([ { "index": 0, "status": "cancelled", "error": null } ]);
            run["nodes"][1]["instances"] = json!([
                { "index": 0, "entry": 0, "status": "cancelled", "attempt": 1, "child": "child-r1", "durationMs": 9, "error": null }
            ]);
            run["nodes"][1]["running"] = json!(0);
            run["nodes"][5]["status"] = json!("cancelled");
            run["nodes"][5]["entries"] =
                json!([ { "index": 0, "status": "cancelled", "error": null } ]);
            run["nodes"][5]["instances"] = json!([
                { "index": 0, "entry": 0, "status": "cancelled", "attempt": 1, "child": "child-w1", "durationMs": 9, "error": null }
            ]);
            run["nodes"][5]["running"] = json!(0);
            run["activeNodes"] = json!([]);
            run["usage"]["running"] = json!(0);
            run["usage"]["settled"] = json!(2);
        }
        _ => {}
    }
    run
}

/// The many-run world's first fold: fifteen runs in the reply's start
/// order (oldest first — the kernel's documented order), every stage
/// the page must read at once.
fn world_response() -> serde_json::Value {
    let runs: Vec<serde_json::Value> = (0..15).map(world_run).collect();
    json!({ "runs": runs })
}

/// The done-with-residents pair settles: their residents stopped, the
/// runs now fully terminal (no child in flight).
fn stop_residents(run: &mut serde_json::Value) {
    run["state"] = json!("stopped");
    run["nodes"][5]["status"] = json!("cancelled");
    run["nodes"][5]["entries"] = json!([ { "index": 0, "status": "cancelled", "error": null } ]);
    run["nodes"][5]["instances"] = json!([
        { "index": 0, "entry": 0, "status": "cancelled", "attempt": 1, "child": "child-w1", "durationMs": 40, "error": null }
    ]);
    run["nodes"][5]["running"] = json!(0);
    run["usage"]["running"] = json!(0);
}

/// Fold two: the two OLDEST runs left the batch (the wire cap's
/// oldest-end trim), three brand-new runs folded in on top (w15-w17),
/// the done-with-residents pair settled to fully terminal, and one
/// paused run resumed — one refresh tick's worth of a busy world.
fn world_fold_two() -> serde_json::Value {
    let mut runs: Vec<serde_json::Value> = Vec::new();
    for index in 2..15 {
        let mut run = world_run(index);
        match index {
            11 | 12 => stop_residents(&mut run),
            9 => run["state"] = json!("running"),
            _ => {}
        }
        runs.push(run);
    }
    for index in 15..18 {
        runs.push(world_run(index));
    }
    json!({ "runs": runs })
}

/// Fold three: fold two's shape minus the selected run w07 — it left
/// the batch mid-orchestration.
fn world_fold_three() -> serde_json::Value {
    let mut reply = world_fold_two();
    reply["runs"]
        .as_array_mut()
        .expect("the world reply carries runs")
        .retain(|run| run["runId"] != json!("run-w07"));
    reply
}

/// Run w02's review entry one instance deeper (the settle script: 3
/// run -> 2 run -> 1 run), the instance counts kept consistent with the
/// kernel's per-stage report.
fn w02_settled(review_running: u64) -> serde_json::Value {
    let mut reply = world_response();
    settle_w02_run(
        &mut reply["runs"].as_array_mut().expect("runs")[2],
        review_running,
    );
    reply
}

/// One run's review entry `review_running` instances still in flight
/// (the earliest instances settled first, exactly how the kernel
/// reports a draining entry).
fn settle_w02_run(run: &mut serde_json::Value, review_running: u64) {
    let done = 3 - review_running;
    let mut instances = Vec::new();
    for index in 0..3 {
        instances.push(json!({
            "index": index, "entry": 0,
            "status": if (index as u64) < done { "done" } else { "running" },
            "attempt": 1, "child": format!("child-r{}", index + 1),
            "durationMs": if (index as u64) < done { 5 } else { 0 }, "error": null
        }));
    }
    run["nodes"][1]["instances"] = json!(instances);
    run["nodes"][1]["running"] = json!(review_running);
    run["usage"]["running"] = json!(review_running + 1);
    run["usage"]["settled"] = json!(1 + done);
}

/// Run w02's review entry fully settled with the verdict's
/// disapproval: the guarded loop edge fired, `fix` entered, the review
/// node drained — the folded snapshot one transition deeper.
fn w02_entry_fired() -> serde_json::Value {
    let mut reply = w02_settled(0);
    let run = &mut reply["runs"].as_array_mut().expect("runs")[2];
    run["nodes"][1]["status"] = json!("done");
    run["nodes"][1]["entries"] = json!([ { "index": 0, "status": "done", "error": null } ]);
    run["nodes"][2] = json!({
        "id": "fix", "status": "running", "lifecycle": "task", "attempts": 1,
        "entriesUsed": 1, "maxEntries": 3,
        "entries": [ { "index": 0, "status": "running", "error": null } ],
        "instances": [ { "index": 0, "entry": 0, "status": "running", "attempt": 1, "child": "child-f1", "durationMs": 0, "error": null } ],
        "running": 1, "queued": 0
    });
    run["activeNodes"] = json!(["fix", "watchdog"]);
    run["lastFired"] = json!([
        { "from": "review", "to": "fix", "seq": 5,
          "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false } },
        { "from": "triage", "to": "review", "seq": 2 },
        { "from": "triage", "to": "watchdog", "seq": 3 }
    ]);
    run["usage"]["running"] = json!(2);
    run["usage"]["settled"] = json!(5);
    run["usage"]["transitionsFired"] = json!(3);
    reply
}

/// The world with every run's elapsed clock bumped one tick — the
/// clock-only fold: nothing is notice-worthy, no marker may fire.
fn world_clock_tick() -> serde_json::Value {
    let mut reply = world_response();
    for run in reply["runs"].as_array_mut().expect("runs") {
        run["elapsedMs"] = json!(run["elapsedMs"].as_u64().unwrap_or_default() + 2_000);
    }
    reply
}

/// The world with run w07's stop landed: the transitional state, its
/// panel now reads stopping.
fn world_w07_stopping() -> serde_json::Value {
    let mut reply = world_response();
    reply["runs"].as_array_mut().expect("runs")[7]["state"] = json!("stopping");
    reply
}

/// A burst of five brand-new runs folded in on top of the world (the
/// newest runs render first, the feed grows by five in one tick).
fn world_with_burst() -> serde_json::Value {
    let mut reply = world_response();
    for index in 15..20 {
        reply["runs"]
            .as_array_mut()
            .expect("runs")
            .push(world_run(index));
    }
    reply
}

/// One busy tick at once (the churn script): the five-run burst folds in
/// on top, w02's review entry settles one deeper, w09 resumes, and the
/// done-with-residents pair's residents stop — many notice-worthy
/// changes landing in a single fold, the page's rapid-change world.
fn world_churn_tick() -> serde_json::Value {
    let mut reply = world_with_burst();
    for run in reply["runs"].as_array_mut().expect("runs").iter_mut() {
        match run["runId"].as_str() {
            Some("run-w02") => settle_w02_run(run, 2),
            Some("run-w09") => run["state"] = json!("running"),
            Some("run-w11" | "run-w12") => stop_residents(run),
            _ => {}
        }
    }
    reply
}

/// One run's panel rows from the rendered frame: its header through the
/// row before the next run's header (the frame's own reading order).
fn panel_rows<'a>(rows: &'a [String], name: &str) -> &'a [String] {
    let start = rows
        .iter()
        .position(|row| row.contains(name))
        .unwrap_or_else(|| panic!("the panel for {name} renders"));
    let end = rows[start + 1..]
        .iter()
        .position(|row| row.contains("factory: "))
        .map_or(rows.len(), |offset| start + 1 + offset);
    &rows[start..end]
}

/// The complex machine's whole shape renders: the seven states in the
/// declared order (entry marker, resident, guarded branches with their
/// guards, the loop's back edge, the fan-in join rendered once), the
/// fired markers on the fired edges, and the live highlighting on the
/// in-flight and resident nodes.
#[test]
fn a_complex_machine_renders_its_whole_shape() {
    let mut view = FactoryView::new(
        parse_factory_runs(&runs_response(&pr_manager_run("run-pm1", "pr run"))),
        60,
    );
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(
        joined.contains("factory: pr run — running"),
        "the run header: {joined}"
    );
    // The declared order's rows, the entry and resident markers.
    assert!(joined.contains("triage"), "{joined}");
    assert!(
        joined.contains("[entry]"),
        "the entry state's marker: {joined}"
    );
    assert!(joined.contains("watchdog"), "{joined}");
    assert!(
        panel_rows(&rows, "factory: pr run")
            .iter()
            .any(|row| row.contains("✓ triage")),
        "the settled entry state: {joined}"
    );
    // The two guarded branches carry their guards.
    assert!(
        joined.contains("when verdict.approved eq false"),
        "the loop's guard: {joined}"
    );
    assert!(
        joined.contains("when verdict.approved eq true"),
        "the merge branch's guard: {joined}"
    );
    // The loop's back edge renders with the return marker; the fan-in
    // join renders ONCE with its join label (not once per source).
    let panel = panel_rows(&rows, "factory: pr run");
    let back_edge = panel
        .iter()
        .find(|row| row.contains("↩"))
        .expect("the loop's back edge renders");
    assert!(
        back_edge.contains("review"),
        "the back edge returns to the loop head: {back_edge}"
    );
    let joins = panel
        .iter()
        .filter(|row| row.contains("join: merge + verify"))
        .count();
    assert_eq!(joins, 1, "the fan-in join renders once: {joined}");
    // The fired markers sit on the fired edges (both of triage's).
    let fired = panel.iter().filter(|row| row.contains("»")).count();
    assert_eq!(fired, 2, "both fired edges carry the marker: {joined}");
    // The live highlighting: the in-flight review and the resident
    // watchdog paint accent; the never-entered states paint dim.
    let spans = frame_spans(&mut view);
    let accent = theme().fg_style(ThemeColor::Accent);
    let dim = theme().fg_style(ThemeColor::Dim);
    let accent_span = |text: &str| {
        spans.iter().any(|row| {
            row.iter()
                .any(|span| span.content == text && span.style == accent)
        })
    };
    let dim_span = |text: &str| {
        spans.iter().any(|row| {
            row.iter()
                .any(|span| span.content == text && span.style == dim)
        })
    };
    assert!(accent_span("review"), "the in-flight state paints accent");
    assert!(
        accent_span("watchdog"),
        "the resident state paints accent while its child runs"
    );
    assert!(dim_span("fix"), "the never-entered state paints dim");
    assert!(dim_span("report"), "{joined}");
}

/// The dock's factory count reads ONE liveness rule across the whole
/// world: the live states count (running/stopping/paused), the
/// done-with-residents pair counts (children still in flight — their
/// stop control is live), and the fully terminal runs never count (the
/// mutation check: the state-only filter drops the two resident pairs).
#[test]
fn the_dock_count_reads_one_liveness_rule_across_many_runs() {
    let runs = parse_factory_runs(&world_response());
    assert_eq!(runs.len(), 15, "the whole world parses");
    let live = runs.iter().filter(|run| run.is_live()).count();
    assert_eq!(
        live, 13,
        "eight live + one stopping + two paused + two done-with-residents"
    );
    // The dock and the agents view split those live runs on the ONE paused
    // predicate: the two paused runs never count as running.
    assert_eq!(
        FactoryRunCounts::of(&runs),
        FactoryRunCounts {
            running: 11,
            paused: 2
        }
    );
    let find = |id: &str| {
        runs.iter()
            .find(|run| run.run_id == id)
            .unwrap_or_else(|| panic!("run {id} parses"))
    };
    // The done-with-residents pair: state says done, the children say
    // live — the panel and its stop control must stay.
    for id in ["run-w11", "run-w12"] {
        let run = find(id);
        assert_eq!(run.state.as_deref(), Some("done"));
        assert!(run.children_in_flight(), "{id}'s resident still runs");
        assert!(run.is_live(), "{id} stays live while its children run");
        assert!(
            !FactoryView::available_actions(run).is_empty(),
            "{id} keeps its stop control"
        );
    }
    // The fully terminal runs never count.
    for id in ["run-w13", "run-w14"] {
        assert!(!find(id).is_live(), "{id} is fully terminal");
        assert!(
            FactoryView::available_actions(find(id)).is_empty(),
            "{id} offers nothing"
        );
    }
    // The stopping and paused runs count.
    assert!(find("run-w08").is_live());
    assert!(find("run-w09").is_live());
    assert!(find("run-w10").is_live());
}

/// Selection stability across many runs: selecting run #7 among fifteen
/// and folding a busy world — new runs folding in ON TOP (newest-first),
/// runs finishing and leaving above, the oldest-end trim dropping runs
/// below — the selection stays on the SAME RUN, never the same index;
/// when the selected run itself leaves the batch the trim hands the
/// selection back to the feed's head (the mutation check:
/// index-tracking jumps to the wrong run on every fold here).
#[test]
fn selection_stays_on_the_same_run_across_a_many_run_churn() {
    let mut view = FactoryView::new(parse_factory_runs(&world_response()), 400);
    // The head is the newest run.
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-w14".to_string()),
        "the page opens on the feed's head"
    );
    select_run(&mut view, "run-w07");
    // Fold two: three new runs folded in on top, the two oldest left
    // the batch, the done-with-residents pair settled. The selection
    // stays on run w07 — at a NEW index (the same index would name a
    // different run).
    view.apply_runs(parse_factory_runs(&world_fold_two()));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-w07".to_string()),
        "the selection stays on the same run, not the same index"
    );
    // Fold three: the selected run itself left the batch — the trim
    // hands the selection back to the feed's head, the newest run.
    view.apply_runs(parse_factory_runs(&world_fold_three()));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-w17".to_string()),
        "a selected run that left the batch hands back to the head"
    );
}

/// Render windowing at scale: fifteen panels on a small viewport never
/// exceed the budget, the trailing hint always paints, and the leading
/// window slides to the focused panel (the walk target) without
/// clipping the chrome — the degenerate budgets still honor the
/// viewport (the mutation check: a window without the slide hides the
/// focused run's header).
#[test]
fn fifteen_panels_window_to_the_focus_on_a_small_viewport() {
    let mut view = FactoryView::new(parse_factory_runs(&world_response()), 26);
    let rows = frame_text(&mut view);
    assert!(
        rows.len() <= 26,
        "fifteen panels never exceed the viewport: {:?}",
        rows.len()
    );
    assert!(
        rows.last().is_some_and(|row| row.contains("back")),
        "the hint paints as the chrome's last row: {:?}",
        rows.last()
    );
    // The leading window keeps the feed's head: the newest panel
    // renders first.
    assert!(
        rows.iter().any(|row| row.contains("factory: world-run-14")),
        "the newest panel renders first: {}",
        rows.join("\n")
    );
    // Focus run #7: the window slides to it — its header paints, the
    // head panel drops instead, and the hint survives.
    select_run(&mut view, "run-w07");
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(rows.len() <= 26, "the windowed frame stays in budget");
    assert!(
        joined.contains("▸ factory: world-run-7 — running"),
        "the focused panel's header paints after the slide: {joined}"
    );
    assert!(
        !joined.contains("factory: world-run-14"),
        "the head panel dropped instead of the chrome: {joined}"
    );
    assert!(
        rows.last().is_some_and(|row| row.contains("back")),
        "the hint still paints after the slide"
    );
    // A selected state deep inside a tall panel: the window slides to
    // the row itself, so the open/stop target stays visible.
    let mut short = FactoryView::new(parse_factory_runs(&world_response()), 10);
    short.selected = Some(FactoryRow {
        run_id: "run-w07".to_string(),
        state_id: Some("watchdog".to_string()),
    });
    let rows = frame_text(&mut short);
    assert!(rows.len() <= 10);
    assert!(
        rows.iter()
            .any(|row| row.contains("▸") && row.contains("watchdog")),
        "the selected state paints: {}",
        rows.join("\n")
    );
    // Degenerate budgets honor the viewport exactly.
    let mut one_row = FactoryView::new(parse_factory_runs(&world_response()), 1);
    let rows = frame_text(&mut one_row);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].contains("back"), "{:?}", rows[0]);
    let mut three_rows = FactoryView::new(parse_factory_runs(&world_response()), 3);
    let rows = frame_text(&mut three_rows);
    assert_eq!(rows.len(), 3);
    assert!(rows[2].contains("back"), "{:?}", rows[2]);
}

/// The refresh tick across the fifteen-run world: the changed marker
/// fires only on notice-worthy changes — never on the elapsed clock,
/// never on identical structural replies, exactly on the runs that
/// changed — and the changed shape paints: the fired-edge marker moves
/// to the newly fired transition, the per-stage occupancy counts update
/// as instances settle (3 run -> 2 run -> 1 run), and the active-node
/// highlighting follows the settling states.
#[test]
fn the_refresh_tick_lights_only_notice_worthy_changes_across_many_runs() {
    let mut view = FactoryView::new(parse_factory_runs(&world_response()), 400);
    let changed_headers = |view: &mut FactoryView| {
        frame_text(view)
            .iter()
            .filter(|row| row.contains("● changed"))
            .count()
    };
    // An identical structural reply applies nothing.
    assert!(!view.apply_runs(parse_factory_runs(&world_response())));
    assert_eq!(changed_headers(&mut view), 0, "no run changed");
    // The clock tick across the whole world lights nothing.
    assert!(!view.apply_runs(parse_factory_runs(&world_clock_tick())));
    assert_eq!(
        changed_headers(&mut view),
        0,
        "the elapsed clock is not notice-worthy, at any scale"
    );
    // The settle script on run w02: one instance settles — the marker
    // lights on THAT run alone, and its occupancy label drops to
    // 2 run.
    assert!(view.apply_runs(parse_factory_runs(&w02_settled(2))));
    let rows = frame_text(&mut view);
    assert_eq!(changed_headers(&mut view), 1, "exactly one run changed");
    let panel = panel_rows(&rows, "factory: world-run-2");
    assert!(
        panel.iter().any(|row| row.contains("● changed")),
        "the changed run is w02: {}",
        rows.join("\n")
    );
    assert!(
        panel
            .iter()
            .any(|row| row.contains("review (2 run · 0 queued)")),
        "the occupancy label drops to 2 run: {panel:?}"
    );
    // One instance deeper: 1 run, still exactly one marker.
    assert!(view.apply_runs(parse_factory_runs(&w02_settled(1))));
    let rows = frame_text(&mut view);
    assert_eq!(changed_headers(&mut view), 1);
    assert!(
        panel_rows(&rows, "factory: world-run-2")
            .iter()
            .any(|row| row.contains("review (1 run · 0 queued)")),
        "the occupancy label drops to 1 run"
    );
    // The entry settles and the guarded loop edge fires: the marker
    // moves to the newly fired transition, the review stage drains
    // (no occupancy fragment), and the active node moves to fix.
    assert!(view.apply_runs(parse_factory_runs(&w02_entry_fired())));
    let rows = frame_text(&mut view);
    assert_eq!(changed_headers(&mut view), 1, "still exactly one run");
    let panel = panel_rows(&rows, "factory: world-run-2");
    let fired_edge = panel
        .iter()
        .find(|row| row.contains("»") && row.contains("fix"))
        .expect("the newly fired edge carries the marker");
    assert!(
        fired_edge.contains("verdict.approved eq false"),
        "the fired marker sits on the loop's guarded edge: {fired_edge}"
    );
    assert!(
        !panel.iter().any(|row| row.contains("review (1 run")),
        "the drained stage carries no occupancy fragment: {panel:?}"
    );
    // The active-node highlighting follows the settling: the entered
    // fix stage paints accent, the settled review stage does not.
    let spans = frame_spans(&mut view);
    let accent = theme().fg_style(ThemeColor::Accent);
    let accent_ids: Vec<String> = spans
        .iter()
        .flat_map(|row| {
            row.iter()
                .filter(|span| span.style == accent)
                .map(|span| span.content.clone())
        })
        .collect();
    assert!(
        accent_ids.iter().any(|id| id == "fix"),
        "the entered fix stage paints accent: {accent_ids:?}"
    );
    let rows = frame_text(&mut view);
    let panel = panel_rows(&rows, "factory: world-run-2");
    let panel_start = rows
        .iter()
        .position(|row| row.contains("factory: world-run-2"))
        .expect("the panel renders");
    let panel_end = panel_start + panel.len();
    let review_accent = spans[panel_start..panel_end].iter().any(|row| {
        row.iter()
            .any(|span| span.content == "review" && span.style == accent)
    });
    assert!(
        !review_accent,
        "the settled review stage loses the accent: {accent_ids:?}"
    );
}

/// Orchestration at scale: the stop targets THE FOCUSED run among
/// fifteen — no cross-run leakage — and the stop's immediate refresh
/// updates its panel to stopping without losing the selection. The
/// offered actions read the run's state: a paused run resumes, a
/// done-with-residents run keeps its stop (the residents teardown), a
/// terminal run offers nothing, and a fold that ends the armed run's
/// stop disarms it (the mutation check: a blindly kept arm would fire a
/// stale stop here).
#[test]
fn orchestration_targets_the_focused_run_among_many() {
    let mut view = FactoryView::new(parse_factory_runs(&world_response()), 400);
    let stop = |run_id: &str| FactoryViewAction::Stop {
        run_id: run_id.to_string(),
    };
    select_run(&mut view, "run-w07");
    let _ = view.handle_key("ctrl+x", &kb());
    assert_eq!(view.handle_key("ctrl+x", &kb()), stop("run-w07"));
    view.apply_runs(parse_factory_runs(&world_w07_stopping()));
    assert_eq!(selected_row(&view), row("run-w07", None));
    let rows = frame_text(&mut view);
    assert!(
        panel_rows(&rows, "factory: world-run-7")
            .iter()
            .any(|row| row.contains("— stopping")),
        "the stopped run's panel reads stopping"
    );
    // A paused run resumes.
    select_run(&mut view, "run-w09");
    assert_eq!(
        view.handle_key("r", &kb()),
        FactoryViewAction::Resume {
            run_id: "run-w09".to_string()
        }
    );
    // A done-with-residents run keeps its stop; the fold that stops its
    // residents ends the offer and disarms the armed stop.
    select_run(&mut view, "run-w11");
    let _ = view.handle_key("ctrl+x", &kb());
    view.apply_runs(parse_factory_runs(&world_fold_two()));
    assert_eq!(view.handle_key("ctrl+x", &kb()), FactoryViewAction::None);
    assert!(view.armed.is_none(), "a run without a stop never arms");
    // A terminal run offers nothing.
    select_run(&mut view, "run-w13");
    let _ = view.handle_key("ctrl+x", &kb());
    assert_eq!(view.handle_key("ctrl+x", &kb()), FactoryViewAction::None);
}

/// Rapid-change churn (the serialized fold discipline at scale): one
/// busy tick settles runs in quick succession, bursts new runs in,
/// resumes, and stops residents — the folded page stays coherent: the
/// markers light exactly on the runs whose shape changed (never the
/// new runs, never the untouched), the selection tracks the same run
/// through the burst, a selected run that vanishes hands back to the
/// head, and every keypress between folds resolves against the folded
/// batch (no dropped key, no stale-index action).
#[test]
fn rapid_churn_keeps_the_folded_page_coherent() {
    let mut view = FactoryView::new(parse_factory_runs(&world_response()), 400);
    select_run(&mut view, "run-w07");
    // The busy tick: a five-run burst folds in on top while four runs
    // change shape underneath.
    assert!(view.apply_runs(parse_factory_runs(&world_churn_tick())));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-w07".to_string()),
        "the selection tracks the same run through the burst"
    );
    // Exactly the four changed runs light the marker — the burst's new
    // runs paint none, the untouched runs none.
    let rows = frame_text(&mut view);
    let marked: Vec<&String> = rows
        .iter()
        .filter(|row| row.contains("● changed"))
        .collect();
    assert_eq!(marked.len(), 4, "exactly the changed runs: {marked:?}");
    for name in ["world-run-2", "world-run-9", "world-run-11", "world-run-12"] {
        assert!(
            marked.iter().any(|row| row.contains(name)),
            "{name}'s panel carries the changed marker: {marked:?}"
        );
    }
    for name in [
        "world-run-19",
        "world-run-15",
        "world-run-5",
        "world-run-14",
    ] {
        assert!(
            !marked.iter().any(|row| row.contains(name)),
            "{name} never carries a marker: {marked:?}"
        );
    }
    // The page stays coherent: the burst's panels render, the focused
    // panel paints, the hint paints.
    let joined = rows.join("\n");
    assert!(joined.contains("factory: world-run-19"), "{joined}");
    assert!(
        joined.contains("▸ factory: world-run-7 — running"),
        "{joined}"
    );
    assert!(joined.contains("Enter/→ open"), "{joined}");
    // The focused run vanishes mid-orchestration: the selection hands
    // back to the head, and the very next keypress resolves against
    // the folded batch — never a stale index.
    let mut vanished = world_churn_tick();
    vanished["runs"]
        .as_array_mut()
        .expect("runs")
        .retain(|run| run["runId"] != json!("run-w07"));
    view.apply_runs(parse_factory_runs(&vanished));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-w19".to_string()),
        "the vanished run hands the selection back to the head"
    );
    let _ = view.handle_key("ctrl+x", &kb());
    assert_eq!(
        view.handle_key("ctrl+x", &kb()),
        FactoryViewAction::Stop {
            run_id: "run-w19".to_string()
        }
    );
    // Interleaved folds never drop a key: a walk with a fold between
    // every press lands exactly where an unfolded walk would.
    let mut view = FactoryView::new(parse_factory_runs(&world_churn_tick()), 400);
    for _ in 0..3 {
        let _ = view.handle_key("down", &kb());
        let _ = view.apply_runs(parse_factory_runs(&world_churn_tick()));
    }
    assert_eq!(
        selected_row(&view),
        row("run-w19", Some("watchdog")),
        "every keypress resolved against the folded batch"
    );
}

/// The dock's factory row lists the live runs (the dock count's own set), paused runs first.
#[test]
fn the_dock_factory_items_list_live_runs_paused_first() {
    let mut response = three_run_response();
    response["runs"][0]["state"] = json!("done");
    response["runs"][0]["usage"]["running"] = json!(0);
    response["runs"][1]["state"] = json!("running");
    response["runs"][2]["state"] = json!("paused");
    let mut fourth = scripted_snapshot();
    fourth["runId"] = json!("run-jkl24680");
    fourth["name"] = json!("fourth-run");
    fourth["state"] = json!("paused");
    response["runs"].as_array_mut().unwrap().push(fourth);
    assert_eq!(
        dock_factory_items(&parse_factory_runs(&response)),
        vec![
            "fourth-run paused",
            "third-run paused",
            "second-run running"
        ]
    );
}

/// A graph reply's factory counts: the host's stored-spec count and the live runs only (a fully
/// terminal run never counts), a paused run apart from the running ones.
#[test]
fn a_graph_reply_counts_stored_specs_and_live_runs() {
    let mut response = three_run_response();
    response["runs"][0]["state"] = json!("done");
    response["runs"][0]["usage"]["running"] = json!(0);
    response["runs"][1]["state"] = json!("running");
    response["runs"][2]["state"] = json!("paused");
    response["factorySpecs"] = json!(2);
    assert_eq!(
        FactoryCounts::of(&response).label().as_deref(),
        Some("2 factories \u{b7} 1 running \u{b7} 1 paused")
    );
}

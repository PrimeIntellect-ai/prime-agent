//! The run view's battery: the snapshot parsing, the merged diagram's
//! overlaid rendering (asserted per span, so removing the overlay's
//! status paint or fired-edge green fails the test — the mutation
//! check), the key loop (the row walk, the node view, the session open,
//! and the two-press stop), the repaint hysteresis, and the scale
//! battery (the complex machine and the fifteen-run world: selection
//! stability, the render window, and the churn discipline).

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

/// The merged run view: the run header + stats + milestones ride the
/// SAME block diagram the machine view draws (the merge's one-canvas
/// promise), with the fired edge lit (the mutation checks: dropping the
/// diagram render loses the boxes; dropping the overlay loses the fired
/// paint).
#[test]
fn the_diagram_renders_states_edges_and_the_fired_marker() {
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&scripted_snapshot())), 40);
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(joined.contains("run: review-loop — running"), "{joined}");
    // The machine draws as the block diagram: every state a box.
    for state in ["collect", "reviewing", "fixing"] {
        assert!(joined.contains(state), "the {state} box renders: {joined}");
    }
    assert!(
        joined.contains("▼ start"),
        "the entry arrow labels the entry state: {joined}"
    );
    assert!(
        joined.contains("false"),
        "the guarded branch's short label: {joined}"
    );
    assert!(
        joined.contains("↺ verdict exists"),
        "the self-loop's guard label: {joined}"
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
    // The fired edge (collect → reviewing) paints success on its arrow.
    let spans = frame_spans(&mut view);
    let success = theme().fg_style(ThemeColor::Success);
    let fired_arrow = spans.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("▼") && span.style == success)
    });
    assert!(fired_arrow, "the fired edge's arrow paints success");
    // The spawned child nests under its state's box.
    assert!(
        joined.contains("└─ run-ab-researcher"),
        "the settled child nests under the collect box: {joined}"
    );
}

/// Each spawned instance of one state nests under its box with its own
/// label, so a foreach's children stay apart.
#[test]
fn each_instance_of_a_state_nests_with_its_own_label() {
    let mut snapshot = scripted_snapshot();
    snapshot["nodes"][0]["instances"] = json!([
        { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-1" },
        { "index": 1, "entry": 0, "status": "done", "attempt": 1, "child": "child-4" }
    ]);
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 40);
    let joined = frame_text(&mut view).join("\n");
    for label in ["run-ab-researcher #0 · e0", "run-ab-researcher #1 · e0"] {
        assert!(joined.contains(label), "missing {label:?}: {joined}");
    }
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
    // The box's detail line names the callable (clipped at the box's
    // TEXT_MAX like every box detail — the same clip the machine view's
    // diagram applies).
    assert!(
        joined.contains("python · my_tools.gh.open…"),
        "the box's detail line names the callable: {joined}"
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
        joined.contains("agent · 3 run · 2 queued"),
        "the occupied stage's box carries its agent counts: {joined}"
    );
    assert!(
        !joined.contains("0 run"),
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
        rows.join("\n").contains("agent · 3 run · 2 queued"),
        "the fallback renders the same occupancy"
    );
}

/// The overlay's highlighting: the active state's box frame and title
/// paint in the accent (bright) color and the never-entered state's box
/// paints dim, the status glyph rides the active box's top border, and
/// the fired edge's arrow paints success — removing any arm of the
/// overlay fails this test (the mutation check on the overlay).
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
    // The active state's box frame and title paint accent.
    let reviewing_bright = rows.iter().any(|row| styled(row, accent, "reviewing"));
    assert!(reviewing_bright, "reviewing's box must paint accent");
    let reviewing_frame = rows.iter().any(|row| styled(row, accent, "●"));
    assert!(reviewing_frame, "the running glyph rides the accent frame");
    // The never-entered state's box paints dim.
    let fixing_dim = rows.iter().any(|row| styled(row, dim, "fixing"));
    assert!(fixing_dim, "fixing must paint dim");
    let pending_glyph = rows.iter().any(|row| styled(row, dim, "◐"));
    assert!(pending_glyph, "the pending glyph rides the dim frame");
    // The last-fired edge's arrow paints success.
    let success = theme().fg_style(ThemeColor::Success);
    let fired_marked = rows.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("▼") && span.style == success)
    });
    assert!(fired_marked, "the fired edge's arrow must paint success");
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
        text.join("\n").contains("1 run · 0 queued"),
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
        joined.contains("run: second-run"),
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
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 60);
    // Both sibling guards render as labels at the shared arrow; only the
    // FIRED guard's label paints success — the sibling label with the
    // same from+to never cross-marks (the mutation check: matching on
    // from+to alone lights both).
    let spans = frame_spans(&mut view);
    let success = theme().fg_style(ThemeColor::Success);
    let styled = |text: &str, style: crate::Style| {
        spans.iter().any(|row| {
            row.iter()
                .any(|span| span.content.contains(text) && span.style == style)
        })
    };
    assert!(
        styled("false", success),
        "the fired guard's label paints success"
    );
    assert!(
        !styled("true", success),
        "the sibling guard's label never cross-marks"
    );
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("false") && joined.contains("true"),
        "both sibling guards render: {joined}"
    );
}

/// A join's fired edge lights whatever order the fired window lists its
/// sources in, and its `join` label paints as fired.
#[test]
fn a_fired_join_lights_whatever_its_source_order() {
    let mut snapshot = scripted_snapshot();
    snapshot["machine"]["transitions"] = json!([
        { "from": ["collect", "reviewing"], "to": "fixing", "on": "settled" }
    ]);
    snapshot["lastFired"] = json!([
        { "from": ["reviewing", "collect"], "to": "fixing", "seq": 9 }
    ]);
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 60);
    let spans = frame_spans(&mut view);
    let success = theme().fg_style(ThemeColor::Success);
    assert!(
        spans.iter().any(|row| row
            .iter()
            .any(|span| span.content.contains("join") && span.style == success)),
        "the fired join's label paints success: {:?}",
        frame_text(&mut view)
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
        joined.contains("node"),
        "the hint names the node walk: {joined}"
    );
    assert!(joined.contains("open session"), "{joined}");
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

/// The arrows walk the focused run's header and EVERY state in declared
/// order — the run view is the single-run detail (the machines list is
/// the multi-run surface), and a state without a child (never entered,
/// or a python state) stays selectable for node inspection. Both ends
/// clamp. (The mutation check: reverting the walk to child-carrying
/// states only drops `fixing` from the expected walk.)
#[test]
fn the_arrows_walk_headers_and_session_states_across_panels() {
    let mut response = two_run_response();
    // The newest run's `fixing` entered but spawned no child yet.
    response["runs"][1]["nodes"][2]["status"] = json!("running");
    response["runs"][1]["nodes"][2]["entries"] =
        json!([ { "index": 0, "status": "running", "error": null } ]);
    let mut view = FactoryView::new(parse_factory_runs(&response), 80);
    // The page opens on the NEWEST run (the feed's reading order).
    let expected = [
        row("run-def67890", None),
        row("run-def67890", Some("collect")),
        row("run-def67890", Some("reviewing")),
        row("run-def67890", Some("fixing")),
    ];
    assert_eq!(selected_row(&view), expected[0]);
    for want in &expected[1..] {
        let _ = view.handle_key("down", &kb());
        assert_eq!(&selected_row(&view), want);
    }
    let _ = view.handle_key("down", &kb());
    assert_eq!(selected_row(&view), expected[3], "down clamps");
    for want in expected[..3].iter().rev() {
        let _ = view.handle_key("up", &kb());
        assert_eq!(&selected_row(&view), want);
    }
    let _ = view.handle_key("up", &kb());
    assert_eq!(selected_row(&view), expected[0], "up clamps");
    // The selected state's box carries the selection frame (the accent
    // double-line box), distinct from the status paint.
    let _ = view.handle_key("down", &kb());
    let text = frame_text(&mut view);
    assert!(
        text.iter().any(|row| row.contains("┏")),
        "the selected state's box frames in the selection style: {text:?}"
    );
    assert!(
        text.iter().any(|row| row.contains("┃ collect")),
        "the selected state's title rides the selection frame: {text:?}"
    );
}

/// Enter opens the selected state's NODE VIEW (the shared inspection
/// surface); `o` and → open the state's LATEST child session (a retry
/// overwrites the instance's child; a later entry's child wins); on a
/// header both open nothing. (The mutation check: Enter falling back to
/// the open action fails the `OpenNode` assertion.)
#[test]
fn enter_opens_the_node_view_and_o_opens_the_latest_child() {
    let mut snapshot = scripted_snapshot();
    snapshot["nodes"][1]["instances"] = json!([
        { "index": 0, "entry": 0, "status": "done", "attempt": 2, "child": "child-2-retry", "durationMs": 5, "error": null },
        { "index": 0, "entry": 1, "status": "running", "attempt": 1, "child": "child-5", "durationMs": 0, "error": null },
        { "index": 1, "entry": 1, "status": "pending", "attempt": 0, "child": null, "durationMs": null, "error": null }
    ]);
    let mut view = FactoryView::new(parse_factory_runs(&runs_response(&snapshot)), 40);
    for key in ["enter", "right", "o"] {
        assert_eq!(view.handle_key(key, &kb()), FactoryViewAction::None);
    }
    let _ = view.handle_key("down", &kb());
    let open = |child: &str| FactoryViewAction::Open {
        child_id: child.to_string(),
    };
    let open_node = |state: &str| FactoryViewAction::OpenNode {
        run_id: "run-abc12345".to_string(),
        state_id: state.to_string(),
    };
    assert_eq!(view.handle_key("enter", &kb()), open_node("collect"));
    // The session UI mounts the node view on OpenNode; once mounted, it
    // owns the keys — Esc steps back to the diagram (the unit harness
    // mounts the loading view the session UI would).
    view.node = Some(node::NodeView::loading("run-abc12345", "collect"));
    assert_eq!(view.handle_key("escape", &kb()), FactoryViewAction::None);
    assert!(view.node.is_none(), "Esc closed the node view");
    let _ = view.handle_key("down", &kb());
    assert_eq!(view.handle_key("enter", &kb()), open_node("reviewing"));
    assert_eq!(view.handle_key("o", &kb()), open("child-5"));
    assert_eq!(view.handle_key("right", &kb()), open("child-5"));
    // A state without a child still opens its node view.
    let _ = view.handle_key("down", &kb());
    assert_eq!(view.handle_key("enter", &kb()), open_node("fixing"));
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
                    FactoryViewAction::None
                        | FactoryViewAction::Open { .. }
                        | FactoryViewAction::OpenNode { .. }
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

/// The repaint hysteresis (the fold's return value): an unchanged
/// snapshot applies without the repaint signal, a state/instance change
/// fires it, and the clock never trips it (elapsed-only movement is not
/// notice-worthy — the mutation check on the signature).
#[test]
fn apply_runs_fires_the_repaint_signal_only_on_notice_worthy_changes() {
    let runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    let mut view = FactoryView::new(runs, 40);
    // The same snapshot: no change.
    let changed = view.apply_runs(parse_factory_runs(&runs_response(&scripted_snapshot())));
    assert!(!changed, "an identical snapshot changes nothing");
    // The instance settles: a notice-worthy change.
    let mut settled = scripted_snapshot();
    settled["nodes"][1]["status"] = json!("done");
    settled["nodes"][1]["instances"][0]["status"] = json!("done");
    let changed = view.apply_runs(parse_factory_runs(&runs_response(&settled)));
    assert!(changed, "a state/instance change is notice-worthy");
    // The clock never trips the signal: an elapsed-only bump repaints
    // the stats line but is not a notice-worthy run-shape change.
    let mut older = settled;
    older["elapsed_ms"] = json!(120_000);
    let changed = view.apply_runs(parse_factory_runs(&runs_response(&older)));
    assert!(
        !changed,
        "an elapsed-only bump is not a notice-worthy change"
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
    // The rendered frame: the run view renders the FOCUSED run (the
    // newest, the default selection) — the machines list is the
    // multi-run surface now.
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(
        joined.contains("run: second-run — running"),
        "the newest (focused) run's header renders: {joined}"
    );
    assert!(
        !joined.contains("run: review-loop"),
        "the older run renders on the machines list, not here: {joined}"
    );
    // Walking the selection to the older run refocuses the view on it.
    select_run(&mut view, "run-abc12345");
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("run: review-loop — running"),
        "the selected run refocuses the view: {joined}"
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
    select_run(&mut view, "run-abc12345");
    let _ = view.handle_key("down", &kb());
    let _ = view.handle_key("down", &kb());
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
        row("run-abc12345", Some("reviewing")),
        "a state that lost its session stays selectable (node inspection)"
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
        joined.contains("open session"),
        "the key hint stays painted: {joined}"
    );
    // The default selection is the newest run: its header stays visible
    // with its marker, and the older run is not on this page.
    assert!(
        joined.contains("▸ run: second-run — running"),
        "the newest (selected) run's header stays visible: {joined}"
    );
    assert!(
        !joined.contains("run: review-loop"),
        "the older run renders on the machines list: {joined}"
    );

    // The selection moved to the older run: the view follows the
    // selection and keeps the hint.
    let mut selected_older = FactoryView::new(parse_factory_runs(&two_run_response()), 8);
    select_run(&mut selected_older, "run-abc12345");
    let rows = frame_text(&mut selected_older);
    let joined = rows.join("\n");
    assert!(
        rows.len() <= 8,
        "the view stays inside the budget: {joined}"
    );
    assert!(
        joined.contains("open session"),
        "the key hint stays painted: {joined}"
    );
    assert!(
        joined.contains("▸ run: review-loop — running"),
        "the selected run's header stays visible: {joined}"
    );
    assert!(
        !joined.contains("run: second-run"),
        "the unselected newest run is not on this page: {joined}"
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
        .position(|row| row.contains("run: "))
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
        joined.contains("run: pr run — running"),
        "the run header: {joined}"
    );
    // The declared order's boxes; the entry arrow labels the entry state.
    for state in [
        "triage", "review", "fix", "verify", "merge", "watchdog", "report",
    ] {
        assert!(joined.contains(state), "the {state} box renders: {joined}");
    }
    assert!(
        joined.contains("▼ start"),
        "the entry arrow labels the entry state: {joined}"
    );
    assert!(
        joined.contains("resident"),
        "the resident state's detail: {joined}"
    );
    // The two guarded branches carry their short guard labels; the
    // fan-in join renders ONCE with its join label.
    assert!(joined.contains("false"), "the loop's guard: {joined}");
    assert!(
        joined.contains("true"),
        "the merge branch's guard: {joined}"
    );
    assert_eq!(
        joined.matches("join").count(),
        1,
        "the fan-in join renders once: {joined}"
    );
    // The status glyphs ride the boxes' top borders: the settled entry
    // (✓), the in-flight review (●), the resident watchdog (●), the
    // never-entered states (◐).
    assert!(joined.contains("┌✓"), "the settled entry's glyph: {joined}");
    assert!(
        joined.matches("┌●").count() >= 2,
        "the in-flight and resident boxes carry the running glyph: {joined}"
    );
    assert!(
        joined.contains("┌◐"),
        "a never-entered box carries the pending glyph: {joined}"
    );
    for glyph in ['✓', '●', '◐'] {
        assert!(
            !joined.contains(&format!("└{glyph}")),
            "the bottom border carries no {glyph} glyph: {joined}"
        );
    }
    // The fired markers sit on the fired edges (both of triage's).
    let spans = frame_spans(&mut view);
    let success = theme().fg_style(ThemeColor::Success);
    let fired = spans
        .iter()
        .flat_map(|row| row.iter())
        .filter(|span| span.content.contains("▼") && span.style == success)
        .count();
    assert_eq!(fired, 2, "both fired edges light their arrows: {joined}");
    // The live highlighting: the in-flight review and the resident
    // watchdog paint accent; the never-entered states paint dim.
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
    assert!(accent_span("review"), "the in-flight review paints accent");
    assert!(
        accent_span("watchdog"),
        "the resident watchdog paints accent"
    );
    assert!(dim_span("report"), "the never-entered report paints dim");
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
    // The run view renders ONE run (the focused run): even the complex
    // machine's tall diagram never exceeds the viewport, the hint stays
    // painted, and the selected state's box slides into sight.
    let mut view = FactoryView::new(parse_factory_runs(&world_response()), 26);
    let rows = frame_text(&mut view);
    assert!(
        rows.len() <= 26,
        "the diagram never exceeds the viewport: {:?}",
        rows.len()
    );
    assert!(
        rows.last().is_some_and(|row| row.contains("back")),
        "the hint paints as the chrome's last row: {:?}",
        rows.last()
    );
    // The focused run is the feed's head: the newest run renders.
    assert!(
        rows.iter().any(|row| row.contains("run: world-run-14")),
        "the newest (focused) run renders: {}",
        rows.join("\n")
    );
    assert!(
        !rows.iter().any(|row| row.contains("run: world-run-7")),
        "the other runs render on the machines list, not here: {}",
        rows.join("\n")
    );
    // Focus run #7: the view follows the selection — its header paints.
    select_run(&mut view, "run-w07");
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(rows.len() <= 26, "the windowed frame stays in budget");
    assert!(
        joined.contains("▸ run: world-run-7 — running"),
        "the focused run's header paints after the slide: {joined}"
    );
    assert!(
        !joined.contains("run: world-run-14"),
        "the head run dropped instead of the chrome: {joined}"
    );
    // A selected state deep inside the tall diagram: the window slides
    // to the box itself, so the open/stop target stays visible.
    let mut short = FactoryView::new(parse_factory_runs(&world_response()), 10);
    short.selected = Some(FactoryRow {
        run_id: "run-w07".to_string(),
        state_id: Some("watchdog".to_string()),
    });
    let rows = frame_text(&mut short);
    assert!(rows.len() <= 10);
    assert!(
        rows.iter().any(|row| row.contains("watchdog")),
        "the selected state's box paints: {}",
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
    select_run(&mut view, "run-w02");
    // An identical structural reply applies nothing.
    assert!(!view.apply_runs(parse_factory_runs(&world_response())));
    // The clock tick across the whole world lights nothing.
    assert!(
        !view.apply_runs(parse_factory_runs(&world_clock_tick())),
        "the elapsed clock is not notice-worthy, at any scale"
    );
    // The settle script on run w02: one instance settles — the fold is
    // notice-worthy (the repaint signal fires) and the occupancy label
    // drops to 2 run.
    assert!(view.apply_runs(parse_factory_runs(&w02_settled(2))));
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("2 run · 0 queued"),
        "the occupancy label drops to 2 run: {joined}"
    );
    // One instance deeper: 1 run.
    assert!(view.apply_runs(parse_factory_runs(&w02_settled(1))));
    let joined = frame_text(&mut view).join("\n");
    assert!(
        joined.contains("1 run · 0 queued"),
        "the occupancy label drops to 1 run: {joined}"
    );
    // The entry settles and the guarded loop edge fires: the newly
    // fired edge's label paints success, the review stage drains (no
    // occupancy fragment), and the active node moves to fix.
    assert!(view.apply_runs(parse_factory_runs(&w02_entry_fired())));
    let spans = frame_spans(&mut view);
    let success = theme().fg_style(ThemeColor::Success);
    let fired_guard = spans.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("false") && span.style == success)
    });
    assert!(
        fired_guard,
        "the fired loop edge's guard label paints success"
    );
    let joined = frame_text(&mut view).join("\n");
    assert!(
        !joined.lines().any(|row| row.contains("agent · reviewer ·")),
        "the drained review stage carries no occupancy fragment: {joined}"
    );
    assert!(
        joined.contains("1 run · 0 queued"),
        "the entered fix stage carries its occupancy: {joined}"
    );
    // The active-node highlighting follows the settling: the entered
    // fix stage paints accent, the settled review stage does not.
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
    assert!(
        !accent_ids.iter().any(|id| id == "review"),
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
        panel_rows(&rows, "run: world-run-7")
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
    // change shape underneath — the fold is notice-worthy (the repaint
    // signal fires).
    assert!(view.apply_runs(parse_factory_runs(&world_churn_tick())));
    assert_eq!(
        view.selected_run().map(|run| run.run_id.clone()),
        Some("run-w07".to_string()),
        "the selection tracks the same run through the burst"
    );
    // The page stays coherent: the focused run paints, the hint paints.
    let rows = frame_text(&mut view);
    let joined = rows.join("\n");
    assert!(joined.contains("▸ run: world-run-7 — running"), "{joined}");
    assert!(joined.contains("open session"), "{joined}");
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
        },
        "the stop resolves against the folded head"
    );
}

/// The dock's expanded items list the live runs, paused first, beside
/// a count of the running runs only.
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
        Some("2 machines \u{b7} 1 running \u{b7} 1 paused")
    );
    response["factorySpecs"] = json!(1);
    assert_eq!(
        FactoryCounts::of(&response).label().as_deref(),
        Some("1 machine \u{b7} 1 running \u{b7} 1 paused")
    );
}

// ---------------------------------------------------------------------------
// The merged view's pins: the one-diagram determinism, the node view.
// ---------------------------------------------------------------------------

/// The merge's one-canvas promise (P1): for one graph, the run view's
/// diagram and the machine view's diagram produce the SAME layout —
/// identical plain text, box positions, and labels — whenever the
/// overlay is absent; a live overlay only repaints styles and nests
/// child rows, it never moves a box (the mutation check: any geometry
/// branch keyed on the overlay fails the equality).
#[test]
fn the_machine_and_run_diagrams_share_one_layout() {
    let runs = parse_factory_runs(&runs_response(&scripted_snapshot()));
    let run = &runs[0];
    let theme = theme();
    let plain = |lines: &Vec<Line>| {
        lines
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let machine = block_diagram(&theme, &run.states, &run.transitions, None, None);
    let run_view = block_diagram(&theme, &run.states, &run.transitions, None, None);
    assert_eq!(plain(&machine.lines), plain(&run_view.lines));
    assert_eq!(machine.node_rows, run_view.node_rows);
    // A selected box changes only that box's frame glyphs (the accent
    // double-line frame), never the geometry: the boxes stay on their
    // rows.
    let selected = block_diagram(&theme, &run.states, &run.transitions, Some(0), None);
    assert_eq!(
        machine.node_rows, selected.node_rows,
        "the selection never moves a box"
    );
    assert_eq!(machine.lines.len(), selected.lines.len());
    // A paint-only overlay adds status glyphs, but each glyph replaces
    // one horizontal-border cell; the box geometry stays the same.
    let mut paint_only = FactoryView::overlay_for(run);
    for node in paint_only.nodes.values_mut() {
        node.occupancy = String::new();
        node.children.clear();
    }
    let painted = block_diagram(
        &theme,
        &run.states,
        &run.transitions,
        None,
        Some(&paint_only),
    );
    assert_eq!(machine.node_rows, painted.node_rows);
    let painted_text = paint_only
        .nodes
        .values()
        .fold(plain(&painted.lines), |text, node| {
            text.replace(node.glyph, "─")
        });
    assert_eq!(plain(&machine.lines), painted_text);
    // The full overlay (occupancy widens boxes, children nest under
    // them) never moves a box: every state keeps the row the plain
    // diagram painted it on. The widened boxes, the recentered
    // connectors, and the nested child rows repaint their own rows —
    // the occupancy fragment rides the widened box's detail line and
    // the children nest under it (both renders have their own pins) —
    // and the widened box realigns the layer centers, dropping the
    // machine view's channel rows where the child rows land, so
    // row-for-row survival is not the invariant: the box anchors are.
    let overlay = FactoryView::overlay_for(run);
    let live = block_diagram(&theme, &run.states, &run.transitions, None, Some(&overlay));
    assert_eq!(
        machine.node_rows, live.node_rows,
        "the occupancy widening and the nested children never move a box"
    );
}

/// The node view's reply parse: the instance list, the run name, and
/// the selected instance's document (wire keys; the mutation check on
/// each key).
#[test]
fn the_node_view_parses_the_node_wire_reply() {
    let data = json!({
        "runId": "run-abc12345",
        "specId": "review-loop",
        "name": "review-loop",
        "state": {
            "id": "reviewing", "status": "running", "lifecycle": "task",
            "attempts": 1, "entriesUsed": 1, "maxEntries": 4,
            "entries": [ { "index": 0, "status": "running", "error": null } ],
            "instances": [
                { "index": 0, "entry": 0, "status": "done", "attempt": 2, "child": "child-2", "durationMs": 5, "error": null },
                { "index": 1, "entry": 0, "status": "running", "attempt": 1, "child": "child-3", "durationMs": 0, "error": null }
            ]
        },
        "entry": {
            "index": 0, "status": "running", "outputs": "{\n  \"result\": \"settled\"\n}",
            "outputErrors": {"report": "capture failed"}
        },
        "instance": {
            "index": 1, "entry": 0, "status": "running", "attempt": 1,
            "child": "child-3", "childName": "run-ab-reviewer", "sessionDir": "/tmp/s/sub-1",
            "durationMs": 0, "error": null,
            "prompt": "## Review\nDo the review.", "promptTruncated": true,
            "inputs": "{\"task\": \"x\"}", "inputsTruncated": true,
            "answer": "answer text", "answerTruncated": true,
            "provisional": false, "captureFailed": true
        }
    });
    let view =
        node::NodeView::parse_reply("run-abc12345", "reviewing", &data).expect("the reply parses");
    assert_eq!(view.run_name, "review-loop");
    assert_eq!(view.instances.len(), 2);
    assert_eq!(view.instances[0].attempt, 2);
    assert_eq!(view.instances[1].child.as_deref(), Some("child-3"));
    let document = view.document.as_ref().expect("the document parses");
    assert_eq!(document.child.as_deref(), Some("child-3"));
    assert_eq!(document.child_name.as_deref(), Some("run-ab-reviewer"));
    assert_eq!(document.session_dir.as_deref(), Some("/tmp/s/sub-1"));
    assert_eq!(document.prompt, "## Review\nDo the review.");
    assert!(document.prompt_truncated);
    assert_eq!(document.inputs.as_deref(), Some("{\"task\": \"x\"}"));
    assert!(document.inputs_truncated);
    assert_eq!(document.answer.as_deref(), Some("answer text"));
    assert!(document.answer_truncated);
    assert!(document.capture_failed);
    assert_eq!(
        document.outputs.as_deref(),
        Some("{\n  \"result\": \"settled\"\n}")
    );
    assert!(!document.outputs_truncated);
    assert_eq!(
        document.output_errors.as_deref(),
        Some("{\n  \"report\": \"capture failed\"\n}")
    );
    // The fresh parse starts on the first instance; the merge retargets
    // to the document's instance (see the merge pin below).
    assert_eq!(view.selected_child(), Some("child-2"));
    assert_eq!(view.selected_selector(), Some((0, 0)));
    // The return target carries the node and the instance.
    let target = view.target();
    assert_eq!(target.run_id, "run-abc12345");
    assert_eq!(target.state_id, "reviewing");
    assert_eq!(target.instance, Some((0, 0)));
}

#[test]
fn a_zero_item_node_entry_keeps_its_settle_without_an_instance() {
    let data = json!({
        "runId": "run-abc12345",
        "specId": "review-loop",
        "name": "review-loop",
        "state": {"id": "fan", "status": "done", "instances": []},
        "entry": {
            "index": 3,
            "status": "done",
            "outputs": "{}",
            "outputErrors": {}
        },
        "instance": null
    });
    let view = node::NodeView::parse_reply("run-abc12345", "fan", &data)
        .expect("the zero-item entry parses");
    assert!(view.instances.is_empty());
    let document = view.document.as_ref().expect("the settle is shown");
    assert_eq!(document.entry, Some(3));
    assert_eq!(document.index, None);
    assert_eq!(document.status, "done");
    assert_eq!(document.outputs.as_deref(), Some("{}"));
    assert!(document.output_errors.is_none());
    assert_eq!(view.target().instance, None);
    let rows = view.render(&theme(), 80, &kb(), 30);
    let text = rows
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("no instances were created"), "{text}");
    assert!(
        text.contains("outputs"),
        "the empty settle remains visible: {text}"
    );
    assert!(
        text.contains("{}"),
        "the empty output map remains visible: {text}"
    );
}

#[test]
fn a_never_entered_node_state_renders_without_fabricating_an_entry() {
    let data = json!({
        "runId": "run-abc12345",
        "specId": "review-loop",
        "name": "review-loop",
        "state": {"id": "fixing", "status": "pending", "instances": []},
        "entry": null,
        "instance": null
    });
    let mut view = node::NodeView::loading("run-abc12345", "fixing");
    view.merge_reply(&data);
    assert!(
        view.error.is_none(),
        "a never-entered state is not an error"
    );
    assert!(view.instances.is_empty());
    assert!(view.document.is_none(), "no entry is fabricated");
    assert_eq!(view.selected_selector(), None);
    assert_eq!(view.document_selector(), None);
    assert_eq!(view.target().instance, None);
    let text = view
        .render(&theme(), 80, &kb(), 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("not yet entered"), "{text}");
    assert!(!text.contains("no instances were created"), "{text}");
}

#[test]
fn a_later_zero_item_node_entry_keeps_its_settle_without_selecting_history() {
    let data = json!({
        "state": {"id": "fan", "status": "done", "instances": [
            {"index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "older-child"}
        ]},
        "entry": {
            "index": 1,
            "status": "done",
            "outputs": "{\"result\": \"latest\"}",
            "outputErrors": {}
        },
        "instance": null
    });
    let mut view = node::NodeView::loading("run-abc12345", "fan");
    view.merge_reply(&data);
    assert_eq!(view.instances.len(), 1);
    assert_eq!(view.selected_selector(), None);
    assert_eq!(view.document_selector(), None);
    assert_eq!(view.target().instance, None);

    let bindings = kb();
    let text = view
        .render(&theme(), 80, &bindings, 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("#0 \u{b7} e0 \u{b7} done"), "{text}");
    assert!(
        text.contains("the entry settled without creating an instance"),
        "{text}"
    );
    assert!(
        !text.contains("▸ #0"),
        "the older instance is not selected: {text}"
    );

    let page_down = bindings
        .first_key("tui.select.pageDown")
        .expect("the page-down binding");
    assert!(view.handle_key(&page_down, &bindings, 30));
    assert_eq!(
        view.selected_selector(),
        None,
        "scrolling keeps the empty entry selected"
    );

    let down = bindings
        .first_key("tui.select.down")
        .expect("the down binding");
    assert!(view.handle_key(&down, &bindings, 30));
    assert_eq!(
        view.selected_selector(),
        Some((0, 0)),
        "explicit navigation still selects historical instances"
    );
}

#[test]
fn the_node_view_flags_truncated_output_error_details_without_renaming_ports() {
    let data = json!({
        "state": {"id": "report", "status": "error", "instances": []},
        "entry": {
            "index": 0,
            "status": "error",
            "outputs": null,
            "outputErrors": {"risk_score": "invalid json at end…"},
            "outputErrorsTruncated": true
        },
        "instance": null
    });
    let view = node::NodeView::parse_reply("run-abc12345", "report", &data)
        .expect("the node report parses");
    let text = view
        .render(&theme(), 80, &kb(), 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        text.contains("\"risk_score\""),
        "port names stay verbatim: {text}"
    );
    assert!(
        text.contains("truncated to fit the activity frame"),
        "the bounded preview is explicit: {text}"
    );
}

#[test]
fn the_node_view_flags_a_bounded_output_preview() {
    let data = json!({
        "state": {"id": "reviewing", "instances": []},
        "entry": {
            "index": 2,
            "status": "done",
            "outputs": "{\"result\": \"preview\"}",
            "outputsTruncated": true,
            "outputErrors": {}
        },
        "instance": null
    });
    let view = node::NodeView::parse_reply("run-abc12345", "reviewing", &data)
        .expect("the preview reply parses");
    let document = view.document.as_ref().expect("the settle is shown");
    assert!(document.outputs_truncated);
    let text = view
        .render(&theme(), 80, &kb(), 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("… (truncated)"), "{text}");
}

#[test]
fn a_late_node_reply_does_not_replace_the_newer_instance_document() {
    let reply = |prompt: &str| {
        json!({
            "name": "review-loop",
            "state": {"instances": [{"index": 0, "entry": 0, "status": "running"}]},
            "entry": {"index": 0, "status": "running", "outputs": null, "outputErrors": {}},
            "instance": {
                "index": 0,
                "entry": 0,
                "status": "running",
                "prompt": prompt
            }
        })
    };
    let mut view = node::NodeView::loading("run-abc12345", "reviewing");
    view.set_request_epoch(2);
    assert!(view.apply_request_result(2, Ok(reply("newer"))));
    assert!(!view.apply_request_result(1, Ok(reply("older"))));
    assert!(!view.apply_request_result(1, Err("old timeout".to_string())));
    assert_eq!(
        view.error, None,
        "a stale error leaves the newer reply alone"
    );
    assert!(view.apply_request_result(2, Err("current timeout".to_string())));
    assert_eq!(view.error.as_deref(), Some("current timeout"));
    assert_eq!(
        view.document
            .as_ref()
            .map(|document| document.prompt.as_str()),
        Some("newer")
    );
}

#[test]
fn narrow_node_markdown_wrap_and_scroll_preserve_the_full_paragraph() {
    let words = (0..240)
        .map(|index| format!("word-{index:03}"))
        .collect::<Vec<_>>();
    let prompt = words.join(" ");
    let data = json!({
        "state": {"id": "reviewing", "instances": [
            {"index": 0, "entry": 0, "status": "done"}
        ]},
        "entry": {"index": 0, "status": "done", "outputs": null, "outputErrors": {}},
        "instance": {
            "index": 0,
            "entry": 0,
            "status": "done",
            "prompt": prompt
        }
    });
    let mut view =
        node::NodeView::parse_reply("run-abc12345", "reviewing", &data).expect("the reply parses");
    let theme = theme();
    let kb = kb();
    let page_down = kb
        .first_key("tui.select.pageDown")
        .expect("the page-down binding");
    let mut rendered = String::new();
    for _ in 0..40 {
        for row in view.render(&theme, 80, &kb, 12) {
            let clipped = crate::width::truncate_line(&row, 80, "");
            rendered.push_str(
                &clipped
                    .iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>(),
            );
            rendered.push('\n');
        }
        assert!(view.handle_key(&page_down, &kb, 12));
    }
    let last_page = view
        .render(&theme, 80, &kb, 12)
        .iter()
        .map(|row| {
            crate::width::truncate_line(row, 80, "")
                .iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    rendered.push_str(&last_page);
    for word in words {
        assert!(rendered.contains(&word), "narrow rendering dropped {word}");
    }
    assert!(
        last_page.contains("word-239"),
        "scroll measurement reached the final paragraph row: {last_page}"
    );
}

/// The key loop scrolls by the window render draws: while an error row shows, the window is
/// one row shorter, and paging down still reaches the document's last row.
#[test]
fn paging_reaches_the_last_row_while_an_error_shows() {
    let prompt = (0..80)
        .map(|index| format!("line-{index:02}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let data = json!({
        "state": {"id": "reviewing", "instances": [
            {"index": 0, "entry": 0, "status": "done"}
        ]},
        "entry": {"index": 0, "status": "done", "outputs": null, "outputErrors": {}},
        "instance": {"index": 0, "entry": 0, "status": "done", "prompt": prompt}
    });
    let mut view =
        node::NodeView::parse_reply("run-abc12345", "reviewing", &data).expect("the reply parses");
    view.set_error("the node request timed out".to_string());
    let theme = theme();
    let kb = kb();
    let page_down = kb
        .first_key("tui.select.pageDown")
        .expect("the page-down binding");
    let _ = view.render(&theme, 80, &kb, 12);
    for _ in 0..60 {
        assert!(view.handle_key(&page_down, &kb, 12));
    }
    let last_page = view
        .render(&theme, 80, &kb, 12)
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        last_page.contains("Error: the node request timed out"),
        "{last_page}"
    );
    assert!(last_page.contains("line-79"), "{last_page}");
}

#[test]
fn narrow_file_markdown_scroll_uses_the_rendered_width() {
    let words = (0..240)
        .map(|index| format!("fileword-{index:03}"))
        .collect::<Vec<_>>();
    let text = words.join(" ");
    let data = json!({
        "state": {"id": "reviewing", "instances": [
            {"index": 0, "entry": 0, "status": "done"}
        ]},
        "entry": {"index": 0, "status": "done", "outputs": null, "outputErrors": {}},
        "instance": {"index": 0, "entry": 0, "status": "done", "prompt": "current"}
    });
    let mut view =
        node::NodeView::parse_reply("run-abc12345", "reviewing", &data).expect("the reply parses");
    view.set_files(node::NodeFiles {
        files: vec![("README.md".to_string(), text)],
        state_files: vec![("reviewing".to_string(), vec!["README.md".to_string()])],
    });
    let theme = theme();
    let kb = kb();
    let page_down = kb
        .first_key("tui.select.pageDown")
        .expect("the page-down binding");
    assert!(view.handle_key("enter", &kb, 12));
    assert!(!view.render(&theme, 80, &kb, 12).is_empty());
    for _ in 0..40 {
        assert!(view.handle_key(&page_down, &kb, 12));
    }
    let last_page = view
        .render(&theme, 80, &kb, 12)
        .iter()
        .map(|row| {
            crate::width::truncate_line(row, 80, "")
                .iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        last_page.contains("fileword-239"),
        "file scroll measurement reached the final wrapped row: {last_page}"
    );
}

#[test]
fn the_node_view_renders_markdown_and_toggles_the_files() {
    let data = json!({
        "name": "review-loop",
        "state": { "id": "reviewing", "instances": [
            { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-2", "durationMs": 5 }
        ]},
        "entry": {"index": 0, "status": "done", "outputs": null, "outputErrors": {}},
        "instance": {
            "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-2",
            "prompt": "## Design\n\nWrite the design **now**.", "prompt_truncated": false
        }
    });
    let mut view =
        node::NodeView::parse_reply("run-abc12345", "design", &data).expect("the reply parses");
    let theme = theme();
    let kb = kb();
    let rows = view.render(&theme, 110, &kb, 40);
    let text = rows
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        text.contains("realized prompt"),
        "the document names the prompt section: {text}"
    );
    // The prompt's Markdown renders: the `## Design` heading paints the
    // Markdown heading style, the bold word paints bold — never the
    // plain text style the scratch rendered.
    let heading_style = crate::markdown::MarkdownStyle::from_theme(&theme)
        .heading
        .add_modifier(ratatui::style::Modifier::BOLD);
    let heading = rows.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("Design") && span.style == heading_style)
    });
    assert!(heading, "the prompt's heading paints the Markdown style");
    // Enter toggles the template-files document. Until its separate
    // fetch lands, the page says loading rather than falsely claiming an
    // empty library.
    assert!(view.handle_key("enter", &kb, 40), "Enter is handled");
    let rows = view.render(&theme, 110, &kb, 40);
    let text = rows
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        text.contains("node: design · review-loop · 0 files"),
        "the files document mounts: {text}"
    );
    assert!(
        text.contains("Loading files…"),
        "the files request is pending: {text}"
    );
    view.set_files(node::NodeFiles::default());
    let empty_text = view
        .render(&theme, 110, &kb, 40)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        empty_text.contains("No files recorded for this state."),
        "the settled empty files response is honest: {empty_text}"
    );
    // Fold the library payload: the file renders with the machine
    // view's own colored files rendering.
    view.set_files(node::NodeFiles::parse(&json!({
        "files": [ { "path": "prompts/design.md", "text": "## Design\n\nWrite **DESIGN.md**.\n" } ],
        "stateFiles": [ { "state": "design", "paths": ["prompts/design.md"] } ]
    })));
    let rows = view.render(&theme, 110, &kb, 40);
    let text = rows
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("── prompts/design.md"), "{text}");
    let heading = rows.iter().any(|row| {
        row.iter()
            .any(|span| span.content.contains("Design") && span.style == heading_style)
    });
    assert!(
        heading,
        "the template file's Markdown keeps its color: {text}"
    );
    // Esc steps back: files → document → (the caller closes).
    assert!(view.step_back(), "Esc closes the files first");
    assert!(!view.step_back(), "the next Esc leaves the view");
}

#[test]
fn node_and_files_errors_clear_only_with_their_matching_success() {
    let initial = json!({
        "state": {"id": "reviewing", "instances": [
            {"index": 0, "entry": 0, "status": "running"}
        ]},
        "entry": {"index": 0, "status": "running", "outputs": null, "outputErrors": {}},
        "instance": {"index": 0, "entry": 0, "status": "running", "prompt": "initial"}
    });
    let mut view = node::NodeView::parse_reply("run-abc12345", "reviewing", &initial)
        .expect("the node reply parses");
    view.set_request_epoch(1);
    view.set_error("node request failed".to_string());
    view.set_files_error("library request failed");
    let next = json!({
        "state": {"id": "reviewing", "instances": [
            {"index": 0, "entry": 0, "status": "running"}
        ]},
        "entry": {"index": 0, "status": "running", "outputs": null, "outputErrors": {}},
        "instance": {"index": 0, "entry": 0, "status": "running", "prompt": "latest"}
    });
    assert!(view.apply_request_result(1, Ok(next)));

    let theme = theme();
    let kb = kb();
    let document_text = view
        .render(&theme, 80, &kb, 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!document_text.contains("node request failed"));
    assert!(view.handle_key("enter", &kb, 30));
    let files_text = view
        .render(&theme, 80, &kb, 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        files_text.contains("Error: library request failed"),
        "{files_text}"
    );
    assert!(
        !files_text.contains("No files recorded for this state."),
        "{files_text}"
    );

    view.set_files(node::NodeFiles::default());
    let files_text = view
        .render(&theme, 80, &kb, 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        files_text.contains("No files recorded for this state."),
        "{files_text}"
    );
    assert!(
        !files_text.contains("library request failed"),
        "{files_text}"
    );

    assert!(view.step_back());
    view.set_error("node request failed".to_string());
    view.set_files(node::NodeFiles::default());
    let document_text = view
        .render(&theme, 80, &kb, 30)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        document_text.contains("Error: node request failed"),
        "{document_text}"
    );
}

/// The node view's merge: a reply for a moved selection retargets it,
/// a malformed reply keeps the last good document, and the files
/// document survives every merge (the fold contract).
#[test]
fn the_node_view_merge_keeps_the_files_and_fixes_the_selection() {
    let data = json!({
        "name": "review-loop",
        "state": { "id": "reviewing", "instances": [
            { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-2" },
            { "index": 1, "entry": 0, "status": "running", "attempt": 1, "child": "child-3" }
        ]},
        "entry": {"index": 0, "status": "running", "outputs": null, "outputErrors": {}},
        "instance": { "index": 0, "entry": 0, "status": "done", "child": "child-2", "prompt": "first" }
    });
    let mut view =
        node::NodeView::parse_reply("run-abc12345", "reviewing", &data).expect("the reply parses");
    view.set_files(node::NodeFiles::parse(&json!({
        "files": [ { "path": "prompts/design.md", "text": "## Design\n" } ],
        "stateFiles": [ { "state": "reviewing", "paths": ["prompts/design.md"] } ]
    })));
    // The walk moves to instance 1; the refetched reply answers it: the
    // merge retargets the selection to the document's instance.
    view.handle_key("down", &kb(), 40);
    let moved = json!({
        "name": "review-loop",
        "state": { "id": "reviewing", "instances": [
            { "index": 0, "entry": 0, "status": "done", "attempt": 1, "child": "child-2" },
            { "index": 1, "entry": 0, "status": "running", "attempt": 1, "child": "child-3" }
        ]},
        "entry": {"index": 0, "status": "running", "outputs": null, "outputErrors": {}},
        "instance": { "index": 1, "entry": 0, "status": "running", "child": "child-3", "prompt": "second" }
    });
    view.merge_reply(&moved);
    assert_eq!(
        view.selected_selector(),
        Some((0, 1)),
        "the selection follows the document"
    );
    assert_eq!(
        view.document
            .as_ref()
            .map(|document| document.prompt.as_str()),
        Some("second")
    );
    assert!(
        view.files.is_some(),
        "the files document survives the merge"
    );
    // A malformed reply keeps the last good document.
    view.merge_reply(&json!({ "nothing": "here" }));
    assert_eq!(
        view.document
            .as_ref()
            .map(|document| document.prompt.as_str()),
        Some("second"),
        "the malformed reply keeps the last good document"
    );
    assert!(view.error.is_some(), "the malformed reply reports");
}

/// A mermaid fence with no parseable states (a header only, or a one-line
/// `graph TD; A-->B`) renders nothing instead of crashing the files page.
#[test]
fn a_mermaid_block_without_states_renders_nothing() {
    for text in ["flowchart TB", "graph TD; A-->B", "stateDiagram-v2"] {
        assert!(
            super::mermaid::mermaid_block_lines(&theme(), text).is_empty(),
            "{text:?}"
        );
    }
}

/// A mermaid flowchart node keeps only the label inside its shape, compound shapes included.
#[test]
fn compound_flowchart_shapes_keep_only_their_label() {
    use super::mermaid::{parse_mermaid, Mermaid};
    let Some(Mermaid::Diagram { states, .. }) = parse_mermaid(
        "flowchart TB\n  a((circle)) --> b([stadium])\n  c[(cylinder)] --> d{{hexagon}}\n  e[box] --> f>flag]",
    ) else {
        panic!("a flowchart parses to a diagram");
    };
    let labels: Vec<(&str, Option<&str>)> = states
        .iter()
        .map(|state| (state.id.as_str(), state.label.as_deref()))
        .collect();
    assert_eq!(
        labels,
        vec![
            ("a", Some("circle")),
            ("b", Some("stadium")),
            ("c", Some("cylinder")),
            ("d", Some("hexagon")),
            ("e", Some("box")),
            ("f", Some("flag")),
        ]
    );
}

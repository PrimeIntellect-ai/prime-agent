//! The factory capability eval's deterministic battery (port of
//! `packages/coding-agent/test/factory-eval.test.ts`): spec shapes, prompt
//! invariants, the ANSWER parser, the task-success checkers, the replay
//! checker, the verdicts, the report renderer, and the CLI parsing. No
//! test here spends tokens or needs a live model.

use serde_json::{json, Value};

use super::{
    build_baseline_prompt, build_broken_dag, build_builder_dag, build_collector_prompt,
    build_factory_parent_prompt, build_files_node_prompt, build_harness_state_file,
    build_pr_fixing_prompt_template, build_pr_manager_machine, build_pr_monitoring_prompt,
    build_pr_reviewing_prompt_template, build_reference_factories, build_reference_parent_prompts,
    build_report_node_prompt, build_resident_watcher_dag, build_review_sweep_dag,
    build_review_sweep_fail_dag, build_reviewer_prompt_template, build_task_a_prompt,
    build_task_b_prompt_template, build_watcher_prompt, builder_marker,
    check_no_orchestration_code, check_replay_ledger, check_task_success, compute_verdicts,
    parse_answer_line, parse_eval_args, parse_fenced_json, render_markdown_report,
    review_issue_ids, run_replay_checks, serialize_eval_report, EvalArgsError, EvalArm,
    EvalReportFile, FactoryEvalConfig, FactoryEvalTrialResult, ParsedAnswer, ReferenceFactoryKind,
    TaskCheckOutcome, TrialVerdict, MAX_WIDTH, NODE_BUDGET_MS, REVIEW_FOREACH_MAX, RUN_BUDGET_MS,
};

const WIDTH: u64 = 6;

fn factories() -> Vec<super::ReferenceFactory> {
    build_reference_factories(WIDTH)
}

fn by_kind(kind: ReferenceFactoryKind) -> super::ReferenceFactory {
    factories()
        .into_iter()
        .find(|factory| factory.kind == kind)
        .unwrap_or_else(|| panic!("missing factory {kind:?}"))
}

fn answer(overrides: &Value) -> Option<ParsedAnswer> {
    let defaults = json!({
        "issues": [],
        "markers": [],
        "state": null,
        "stopped": [],
        "failed_node": null,
        "report_status": null,
        "rejected": null,
        "children": null,
        "message": null,
        "approved": null,
        "defects": [],
        "rounds": null
    });
    let merged = match (defaults.clone(), overrides.clone()) {
        (mut base, Value::Object(over)) => {
            if let Some(object) = base.as_object_mut() {
                for (key, value) in over {
                    object.insert(key, value);
                }
            }
            base
        }
        _ => defaults,
    };
    serde_json::from_value(merged).expect("answer fixture")
}

// -- fixtures: the executor's status ledger shapes ------------------------

fn event_fixture(seq: i64, kind: &str, extra: Value) -> Value {
    let mut event = json!({ "seq": seq, "kind": kind, "stage": "delivered" });
    if let (Some(object), Value::Object(extra)) = (event.as_object_mut(), extra) {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }
    event
}

fn instance_fixture(index: i64, status: &str, extra: Value) -> Value {
    let mut instance = json!({ "index": index, "status": status, "attempt": 1, "child": "child-1", "duration_ms": null });
    if let (Some(object), Value::Object(extra)) = (instance.as_object_mut(), extra) {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }
    instance
}

fn node_fixture(id: &str, status: &str, extra: Value) -> Value {
    let mut node = json!({
        "id": id,
        "status": status,
        "lifecycle": "task",
        "attempts": 1,
        "instances": [instance_fixture(-1, status, json!({}))],
    });
    if let (Some(object), Value::Object(extra)) = (node.as_object_mut(), extra) {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }
    node
}

fn status_ledger_fixture(overrides: Value) -> Value {
    let mut ledger = json!({
        "run_id": "run-1",
        "spec_id": "factory-dag-eval-review-sweep",
        "name": null,
        "state": "done",
        "nodes": [],
        "events": [],
        "elapsed_ms": 12_345,
        "usage": { "spawns": 0, "settled": 0, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    });
    if let (Some(object), Value::Object(over)) = (ledger.as_object_mut(), overrides) {
        for (key, value) in over {
            object.insert(key, value);
        }
    }
    ledger
}

fn review_sweep_ledger() -> Value {
    let mut events = vec![
        event_fixture(
            1,
            "run_started",
            json!({ "detail": "3 nodes, max_parallel 8" }),
        ),
        event_fixture(2, "node_ready", json!({ "node": "files" })),
        event_fixture(3, "spawned", json!({ "node": "files", "instance": -1 })),
        event_fixture(
            4,
            "settled",
            json!({ "node": "files", "instance": -1, "status": "done", "duration_ms": 4_000 }),
        ),
        event_fixture(
            5,
            "answer_captured",
            json!({ "node": "files", "instance": -1 }),
        ),
        event_fixture(6, "node_ready", json!({ "node": "review" })),
    ];
    let mut seq = 7;
    for index in 0..4 {
        events.push(event_fixture(
            seq,
            "spawned",
            json!({ "node": "review", "instance": index }),
        ));
        events.push(event_fixture(
            seq + 1,
            "settled",
            json!({ "node": "review", "instance": index, "status": "done", "duration_ms": 8_000 }),
        ));
        events.push(event_fixture(
            seq + 2,
            "answer_captured",
            json!({ "node": "review", "instance": index }),
        ));
        seq += 3;
    }
    events.extend([
        event_fixture(19, "node_ready", json!({ "node": "report" })),
        event_fixture(20, "spawned", json!({ "node": "report", "instance": -1 })),
        event_fixture(
            21,
            "settled",
            json!({ "node": "report", "instance": -1, "status": "done", "duration_ms": 3_000 }),
        ),
        event_fixture(
            22,
            "answer_captured",
            json!({ "node": "report", "instance": -1 }),
        ),
        event_fixture(23, "milestone", json!({ "milestone": "finished" })),
    ]);
    status_ledger_fixture(json!({
        "state": "done",
        "nodes": [
            node_fixture("files", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 4_000 }))] })),
            node_fixture("review", "done", json!({
                "instances": (0..4).map(|index| instance_fixture(index, "done", json!({ "duration_ms": 8_000 }))).collect::<Vec<_>>()
            })),
            node_fixture("report", "done", json!({
                "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 3_000 }))],
                "answer_preview": "```json\n{\"issues\": [\"AUDIT-A1\",\"AUDIT-B1\",\"AUDIT-C1\",\"AUDIT-D1\"]}\n```"
            }))
        ],
        "events": events,
        "usage": { "spawns": 6, "settled": 6, "tool_uses": 6, "max_parallel": 8, "running": 0 }
    }))
}

fn resident_ledger() -> Value {
    status_ledger_fixture(json!({
        "spec_id": "factory-dag-eval-resident-watcher",
        "state": "stopped",
        "nodes": [
            node_fixture("watcher", "cancelled", json!({
                "lifecycle": "resident",
                "instances": [instance_fixture(-1, "cancelled", json!({}))]
            })),
            node_fixture("task-a", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 5_000 }))] })),
            node_fixture("task-b", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 4_000 }))] }))
        ],
        "events": [
            event_fixture(1, "run_started", json!({})),
            event_fixture(2, "node_ready", json!({ "node": "watcher" })),
            event_fixture(3, "spawned", json!({ "node": "watcher", "instance": -1 })),
            event_fixture(4, "node_ready", json!({ "node": "task-a" })),
            event_fixture(5, "spawned", json!({ "node": "task-a", "instance": -1 })),
            event_fixture(6, "settled", json!({ "node": "task-a", "instance": -1, "status": "done", "duration_ms": 5_000 })),
            event_fixture(7, "answer_captured", json!({ "node": "task-a", "instance": -1 })),
            event_fixture(8, "node_ready", json!({ "node": "task-b" })),
            event_fixture(9, "spawned", json!({ "node": "task-b", "instance": -1 })),
            event_fixture(10, "settled", json!({ "node": "task-b", "instance": -1, "status": "done", "duration_ms": 4_000 })),
            event_fixture(11, "answer_captured", json!({ "node": "task-b", "instance": -1 })),
            event_fixture(12, "milestone", json!({ "milestone": "finished" })),
            event_fixture(13, "node_cancelled", json!({ "node": "watcher" })),
            event_fixture(14, "cancelled", json!({ "node": "watcher", "instance": -1 })),
            event_fixture(15, "run_stopped", json!({ "detail": "stopped; 1 node(s) cancelled" }))
        ],
        "usage": { "spawns": 3, "settled": 2, "tool_uses": 2, "max_parallel": 8, "running": 0 }
    }))
}

fn escalation_ledger() -> Value {
    status_ledger_fixture(json!({
        "spec_id": "factory-dag-eval-review-fail",
        "state": "paused",
        "nodes": [
            node_fixture("files", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 4_000 }))] })),
            node_fixture("review", "running", json!({
                "instances": (0..4).map(|index| instance_fixture(index, "running", json!({}))).collect::<Vec<_>>()
            })),
            node_fixture("review-broken", "error", json!({
                "instances": [instance_fixture(-1, "error", json!({ "error": "spawn admission failed: no such model" }))],
                "error": "spawn admission failed: no such model"
            })),
            node_fixture("report", "pending", json!({ "instances": [] }))
        ],
        "events": [
            event_fixture(1, "run_started", json!({})),
            event_fixture(2, "node_ready", json!({ "node": "files" })),
            event_fixture(3, "spawned", json!({ "node": "files", "instance": -1 })),
            event_fixture(4, "settled", json!({ "node": "files", "instance": -1, "status": "done", "duration_ms": 4_000 })),
            event_fixture(5, "node_ready", json!({ "node": "review" })),
            event_fixture(6, "spawned", json!({ "node": "review", "instance": 0 })),
            event_fixture(7, "spawned", json!({ "node": "review", "instance": 1 })),
            event_fixture(8, "spawned", json!({ "node": "review", "instance": 2 })),
            event_fixture(9, "spawned", json!({ "node": "review", "instance": 3 })),
            event_fixture(10, "node_ready", json!({ "node": "review-broken" })),
            event_fixture(11, "settled", json!({ "node": "review-broken", "instance": -1, "status": "error", "error": "spawn admission failed: no such model" })),
            event_fixture(12, "node_error", json!({ "node": "review-broken", "error": "spawn admission failed" })),
            event_fixture(13, "milestone", json!({ "milestone": "paused" }))
        ],
        "usage": { "spawns": 5, "settled": 1, "tool_uses": 1, "max_parallel": 8, "running": 4 }
    }))
}

/// The pr-manager's closed two-round loop ledger: entry -> reviewing (fix
/// report null, verdict false, all four findings) -> fixing (`fix_report`
/// with all four ids) -> reviewing (verdict approved true) -> resident
/// monitoring, then the caller stops the run.
fn pr_manager_ledger() -> Value {
    // Built with a small helper (one event list, one sequence counter):
    // the closed two-round loop's ledger.
    struct LedgerBuilder {
        events: Vec<Value>,
        seq: i64,
    }
    impl LedgerBuilder {
        fn push(&mut self, kind: &str, extra: Value) {
            self.seq += 1;
            self.events.push(event_fixture(self.seq, kind, extra));
        }
        fn settle(&mut self, node: &str, entry: i64, instance: i64, answer: &str) {
            self.push(
                "node_ready",
                json!({ "node": node, "entry": entry, "instance": instance }),
            );
            self.push(
                "spawned",
                json!({ "node": node, "entry": entry, "instance": instance }),
            );
            self.push(
                "settled",
                json!({ "node": node, "entry": entry, "instance": instance, "status": "done", "duration_ms": 6_000 }),
            );
            self.push(
                "answer_captured",
                json!({ "node": node, "entry": entry, "instance": instance, "answer": answer }),
            );
        }
    }
    let review_instances: Vec<Value> = [0_i64, 1]
        .iter()
        .map(|index| {
            instance_fixture(
                *index,
                "done",
                json!({ "entry": index, "duration_ms": 6_000 }),
            )
        })
        .collect();
    let review_entries: Vec<Value> = [0_i64, 1]
        .iter()
        .map(|index| json!({ "index": index, "status": "done" }))
        .collect();
    let mut builder = LedgerBuilder {
        events: Vec::new(),
        seq: 0,
    };
    builder.push(
        "run_started",
        json!({ "detail": "4 states, max_parallel 8" }),
    );
    builder.push(
        "state_entry",
        json!({ "node": "entry", "entry": 0, "detail": "entry state" }),
    );
    builder.settle(
        "entry",
        0,
        0,
        "PR swp://mini-repo: the snapshot under review carries four planted defects with audit notes",
    );
    builder.push(
        "transition_fired",
        json!({ "from": "entry", "to": "reviewing", "detail": "'entry' -> 'reviewing'" }),
    );
    builder.push(
        "state_entry",
        json!({ "node": "reviewing", "entry": 0, "detail": "entered from entry" }),
    );
    builder.settle(
        "reviewing",
        0,
        0,
        "```json\n{\"verdict\": {\"approved\": false, \"findings\": [\"AUDIT-A1\",\"AUDIT-B1\",\"AUDIT-C1\",\"AUDIT-D1\"]}}\n```",
    );
    builder.push(
        "transition_fired",
        json!({ "from": "reviewing", "to": "fixing", "detail": "'reviewing' -> 'fixing'" }),
    );
    builder.push(
        "state_entry",
        json!({ "node": "fixing", "entry": 0, "detail": "entered from reviewing" }),
    );
    builder.settle(
        "fixing",
        0,
        0,
        "```json\n{\"fix_report\": {\"fixed\": [\"AUDIT-A1\",\"AUDIT-B1\",\"AUDIT-C1\",\"AUDIT-D1\"]}}\n```",
    );
    builder.push(
        "transition_fired",
        json!({ "from": "fixing", "to": "reviewing", "detail": "'fixing' -> 'reviewing'" }),
    );
    builder.push(
        "state_entry",
        json!({ "node": "reviewing", "entry": 1, "detail": "entered from fixing" }),
    );
    builder.settle(
        "reviewing",
        1,
        1,
        "```json\n{\"verdict\": {\"approved\": true, \"findings\": []}}\n```",
    );
    builder.push(
        "transition_fired",
        json!({ "from": "reviewing", "to": "monitoring", "detail": "'reviewing' -> 'monitoring'" }),
    );
    builder.push(
        "state_entry",
        json!({ "node": "monitoring", "entry": 0, "detail": "entered from reviewing" }),
    );
    builder.push(
        "node_ready",
        json!({ "node": "monitoring", "entry": 0, "instance": 0, "detail": "resident still running" }),
    );
    builder.push(
        "spawned",
        json!({ "node": "monitoring", "entry": 0, "instance": 0, "child": "child-5" }),
    );
    builder.push(
        "milestone",
        json!({ "milestone": "finished", "detail": "run complete: 4 state(s), 3 transition(s) fired" }),
    );
    builder.push(
        "node_cancelled",
        json!({ "node": "monitoring", "detail": "resident still running" }),
    );
    builder.push(
        "cancelled",
        json!({ "node": "monitoring", "entry": 0, "instance": 0, "child": "child-5", "detail": "resident torn down" }),
    );
    builder.push(
        "run_stopped",
        json!({ "detail": "stopped; 1 state(s) cancelled" }),
    );
    let events = builder.events;
    status_ledger_fixture(json!({
        "spec_id": "factory-dag-eval-pr-manager",
        "state": "stopped",
        "nodes": [
            node_fixture("entry", "done", json!({
                "instances": [instance_fixture(0, "done", json!({ "duration_ms": 6_000 }))],
                "entries_used": 1,
                "max_entries": 1,
                "entries": [json!({ "index": 0, "status": "done" })]
            })),
            node_fixture("reviewing", "done", json!({
                "attempts": 2,
                "instances": review_instances,
                "entries_used": 2,
                "max_entries": 4,
                "entries": review_entries,
                "answer_preview": "```json\n{\"verdict\": {\"approved\": true, \"findings\": []}}\n```"
            })),
            node_fixture("fixing", "done", json!({
                "instances": [instance_fixture(0, "done", json!({ "duration_ms": 6_000 }))],
                "entries_used": 1,
                "max_entries": 3,
                "entries": [json!({ "index": 0, "status": "done" })],
                "answer_preview": "```json\n{\"fix_report\": {\"fixed\": [\"AUDIT-A1\",\"AUDIT-B1\",\"AUDIT-C1\",\"AUDIT-D1\"]}}\n```"
            })),
            node_fixture("monitoring", "cancelled", json!({
                "lifecycle": "resident",
                "attempts": 1,
                "instances": [instance_fixture(0, "cancelled", json!({ "entry": 0 }))],
                "entries_used": 1,
                "max_entries": 1,
                "entries": [json!({ "index": 0, "status": "cancelled" })]
            }))
        ],
        "events": events,
        "usage": { "spawns": 5, "settled": 4, "tool_uses": 5, "max_parallel": 8, "running": 0, "transitions_fired": 4 }
    }))
}
fn check(
    factory: &super::ReferenceFactory,
    ans: Option<&ParsedAnswer>,
    ledger: Option<&Value>,
) -> TaskCheckOutcome {
    check_task_success(factory, ans, ledger, EvalArm::Factory, None)
}

fn check_baseline(
    factory: &super::ReferenceFactory,
    ans: Option<&ParsedAnswer>,
    baseline_ledger: Option<&Value>,
) -> TaskCheckOutcome {
    check_task_success(factory, ans, None, EvalArm::Baseline, baseline_ledger)
}

// -- spec shapes ---------------------------------------------------------

#[test]
fn builds_the_review_sweep_with_typed_fan_in_and_a_bounded_foreach() {
    let dag = build_review_sweep_dag();
    let nodes = dag["nodes"].as_array().expect("nodes");
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[0]["id"], "files");
    assert_eq!(nodes[1]["id"], "review");
    assert_eq!(nodes[2]["id"], "report");
    let run = &dag["run"];
    assert_eq!(run["budget_ms"], RUN_BUDGET_MS);
    assert_eq!(run["failure_policy"], "escalate");
    assert_eq!(run["max_parallel"], REVIEW_FOREACH_MAX);
    let review = &nodes[1];
    assert_eq!(review["foreach"]["over"], "files");
    assert_eq!(review["foreach"]["max"], REVIEW_FOREACH_MAX);
    assert_eq!(review["inputs"][0]["from"], "files.files");
    assert_eq!(review["inputs"][0]["type"], "json");
    assert_eq!(review["outputs"][0]["name"], "found");
    assert_eq!(review["outputs"][0]["type"], "text");
    for node in nodes {
        assert_eq!(node["budget_ms"], NODE_BUDGET_MS);
    }
    let report = &nodes[2];
    let inputs = report["inputs"].as_array().expect("report inputs");
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["type"], "json");
    assert_eq!(inputs[1]["type"], "text");
}

#[test]
fn plants_one_real_checkable_issue_per_review_file() {
    use super::REVIEW_FILES;
    assert_eq!(REVIEW_FILES.len(), 4);
    let mut ids: Vec<&str> = REVIEW_FILES.iter().map(|file| file.issue_id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), REVIEW_FILES.len(), "audit ids must be unique");
    let template = build_reviewer_prompt_template();
    for file in REVIEW_FILES {
        assert!(
            template.contains(file.name),
            "reviewer template covers {}",
            file.name
        );
        assert!(
            template.contains(file.issue_id),
            "reviewer template carries {}",
            file.issue_id
        );
    }
}

#[test]
fn plants_a_failing_reviewer_that_cannot_be_admitted() {
    let dag = build_review_sweep_fail_dag();
    let nodes = dag["nodes"].as_array().expect("nodes");
    assert_eq!(nodes.len(), 4);
    let broken = nodes
        .iter()
        .find(|node| node["id"] == "review-broken")
        .expect("planted failing reviewer");
    // An unresolvable model pin: admission fails deterministically, zero
    // child tokens.
    assert_eq!(
        broken["subagent"]["model"],
        "internal/no-such-model-for-eval"
    );
    assert_eq!(broken["failure_policy"], "escalate");
    // Inserted after the foreach, so the sweep is under way when it fails.
    assert_eq!(nodes[1]["id"], "review");
    assert_eq!(nodes[2]["id"], "review-broken");
    assert_eq!(nodes[3]["id"], "report");
    // Every other node is the plain review sweep.
    let plain = build_review_sweep_dag();
    let plain_ids: Vec<&str> = plain["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|node| node["id"].as_str())
        .collect();
    let fail_ids: Vec<&str> = nodes
        .iter()
        .filter(|node| node["id"] != "review-broken")
        .filter_map(|node| node["id"].as_str())
        .collect();
    assert_eq!(plain_ids, fail_ids);
}

#[test]
fn builds_the_n_wide_builder_with_per_node_budgets_and_a_typed_fan_in_collector() {
    for width in [2_u64, 6, MAX_WIDTH] {
        let dag = build_builder_dag(width);
        let nodes = dag["nodes"].as_array().expect("nodes");
        assert_eq!(nodes.len() as u64, width + 1, "width {width}");
        for (index, node) in nodes.iter().enumerate() {
            assert_eq!(node["budget_ms"], NODE_BUDGET_MS);
            if index < width as usize {
                assert_eq!(node["id"], format!("builder-{}", index + 1));
                assert_eq!(node["outputs"][0]["type"], "text");
            }
        }
        let collector = &nodes[width as usize];
        assert_eq!(collector["id"], "collector");
        let inputs = collector["inputs"].as_array().expect("collector inputs");
        assert_eq!(inputs.len() as u64, width);
        for (index, input) in inputs.iter().enumerate() {
            assert_eq!(input["name"], format!("line-{}", index + 1));
            assert_eq!(input["type"], "text");
            assert_eq!(input["from"], format!("builder-{}.line", index + 1));
        }
        let run = &dag["run"];
        assert_eq!(run["budget_ms"], RUN_BUDGET_MS);
        assert_eq!(run["max_parallel"], 8);
    }
}

#[test]
fn builds_the_resident_watcher_with_a_resident_head_and_a_task_chain() {
    let dag = build_resident_watcher_dag();
    let nodes = dag["nodes"].as_array().expect("nodes");
    assert_eq!(nodes.len(), 3);
    let watcher = nodes
        .iter()
        .find(|node| node["id"] == "watcher")
        .expect("watcher");
    assert_eq!(watcher["lifecycle"], "resident");
    assert!(
        watcher.get("outputs").is_none() || watcher["outputs"].is_null(),
        "residents declare no outputs"
    );
    let task_a = nodes
        .iter()
        .find(|node| node["id"] == "task-a")
        .expect("task-a");
    let task_b = nodes
        .iter()
        .find(|node| node["id"] == "task-b")
        .expect("task-b");
    assert_eq!(task_b["inputs"][0]["from"], "task-a.step");
    assert_eq!(task_b["inputs"][0]["type"], "text");
    assert_eq!(task_a["budget_ms"], NODE_BUDGET_MS);
    assert_eq!(task_b["budget_ms"], NODE_BUDGET_MS);
}

#[test]
fn builds_the_broken_spec_as_a_structurally_valid_but_unresolvable_reference() {
    let dag = build_broken_dag();
    let node = &dag["nodes"][0];
    assert_eq!(node["id"], "broken-source");
    assert_eq!(node["subagent"], "no-such-subagent-entry");
}

#[test]
fn builds_the_pr_manager_machine_with_a_closed_review_fix_loop_and_a_resident_monitor() {
    let machine = build_pr_manager_machine();
    let run = &machine["run"];
    assert_eq!(run["budget_ms"], RUN_BUDGET_MS);
    assert_eq!(run["failure_policy"], "escalate");
    assert_eq!(run["max_parallel"], 8);
    assert_eq!(run["max_transitions"], 24);
    let states = machine["states"].as_array().expect("states");
    assert_eq!(states.len(), 4);
    let entry = states
        .iter()
        .find(|state| state["id"] == "entry")
        .expect("entry");
    assert_eq!(entry["entry"], true);
    assert_eq!(entry["outputs"][0]["name"], "pr_url");
    let reviewing = states
        .iter()
        .find(|state| state["id"] == "reviewing")
        .expect("reviewing");
    assert_eq!(reviewing["max_entries"], 4);
    let review_inputs = reviewing["inputs"].as_array().expect("reviewing inputs");
    assert_eq!(review_inputs.len(), 2);
    assert_eq!(review_inputs[0]["from"], "entry.pr_url");
    assert_eq!(review_inputs[1]["from"], "fixing.fix_report");
    assert_eq!(
        review_inputs[1]["optional"], true,
        "the fix_report input is optional (null on the first review)"
    );
    assert_eq!(reviewing["outputs"][0]["name"], "verdict");
    let fixing = states
        .iter()
        .find(|state| state["id"] == "fixing")
        .expect("fixing");
    assert_eq!(fixing["max_entries"], 3);
    assert_eq!(fixing["inputs"][0]["from"], "reviewing.verdict");
    assert_eq!(fixing["outputs"][0]["name"], "fix_report");
    let monitoring = states
        .iter()
        .find(|state| state["id"] == "monitoring")
        .expect("monitoring");
    assert_eq!(monitoring["lifecycle"], "resident");
    let transitions = machine["transitions"].as_array().expect("transitions");
    assert_eq!(transitions.len(), 4);
    assert_eq!(transitions[0]["from"], "entry");
    assert_eq!(transitions[0]["to"], "reviewing");
    assert_eq!(transitions[1]["when"]["output"], "verdict");
    assert_eq!(transitions[1]["when"]["path"], "approved");
    assert_eq!(transitions[1]["when"]["op"], "eq");
    assert_eq!(transitions[1]["when"]["value"], false);
    assert_eq!(transitions[2]["to"], "monitoring");
    assert_eq!(transitions[2]["when"]["value"], true);
    assert_eq!(transitions[3]["from"], "fixing");
    assert_eq!(transitions[3]["to"], "reviewing");
}

#[test]
fn seeds_the_pr_manager_as_a_machine_form_reference_factory() {
    let pr_manager = by_kind(ReferenceFactoryKind::PrManager);
    assert_eq!(
        pr_manager.machine.as_ref().expect("machine form"),
        &build_pr_manager_machine()
    );
    assert!(
        pr_manager.dag.is_none(),
        "exactly one of machine/dag is present"
    );
    let arguments = pr_manager.spec_arguments();
    assert!(arguments.get("machine").is_some());
    assert!(arguments.get("dag").is_none());
    let sweep = by_kind(ReferenceFactoryKind::ReviewSweep);
    assert!(sweep.dag.is_some());
    assert!(sweep.machine.is_none());
    assert_eq!(
        sweep.spec_arguments().get("dag"),
        Some(&build_review_sweep_dag())
    );
}

// -- prompt invariants ---------------------------------------------------

#[test]
fn factory_parent_prompts_contain_no_task_specific_orchestration_code() {
    let prompts = build_reference_parent_prompts(WIDTH);
    assert_eq!(prompts.len(), 6);
    assert!(
        check_no_orchestration_code(&prompts),
        "no rlm.spawn/rlm.collect may leak into a factory parent prompt"
    );
    // Falsifiable: a spawn call flips the verdict.
    let mut forged = prompts;
    forged[0].push_str("\nawait rlm.spawn('extra child')");
    assert!(!check_no_orchestration_code(&forged));
}

#[test]
fn baseline_snippets_await_every_settle_one_call() {
    // The pr-manager baseline's loop is executable as written: every
    // spawn/collect site awaits its settle.
    let factory = by_kind(ReferenceFactoryKind::PrManager);
    let baseline = build_baseline_prompt(&factory, "/tmp/ledger.json");
    for line in baseline.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("rlm.spawn") || trimmed.contains("rlm.collect(") {
            assert!(
                trimmed.contains("await "),
                "unawaited orchestration call: {trimmed}"
            );
        }
    }
    assert!(baseline.contains("await settle_one(reviewing)"));
    assert!(baseline.contains("await settle_one(fixing)"));
}

#[test]
fn baseline_prompts_orchestrate_manually_and_never_touch_rlm_factory() {
    for kind in ReferenceFactoryKind::selections() {
        let factory = by_kind(kind);
        let baseline = build_baseline_prompt(&factory, "/tmp/ledger.json");
        assert!(
            baseline.contains("rlm.spawn"),
            "baseline {kind:?} spawns children itself"
        );
        assert!(
            baseline.contains("rlm.collect"),
            "baseline {kind:?} collects children itself"
        );
        assert!(
            !baseline.contains("rlm.factory"),
            "baseline {kind:?} must not touch the factory executor"
        );
    }
}

#[test]
fn the_reviewer_template_carries_the_foreach_placeholder_and_every_audit_id() {
    let template = build_reviewer_prompt_template();
    assert!(
        template.contains("{files}"),
        "the foreach placeholder survives verbatim"
    );
    for issue_id in review_issue_ids() {
        assert!(template.contains(issue_id));
    }
}

#[test]
fn the_review_sweep_baseline_embeds_the_mini_repo_exactly_once() {
    // A snippet unique to file fa's listing line: the shared mini-repo must
    // appear exactly once in the baseline (the honest lower bound).
    let unique_snippet = "Math.max(value, max)";
    let factory = by_kind(ReferenceFactoryKind::ReviewSweep);
    let baseline = build_baseline_prompt(&factory, "/tmp/ledger.json");
    assert_eq!(
        baseline.matches(unique_snippet).count(),
        1,
        "the shared mini-repo appears exactly once (the honest lower bound)"
    );
    // The baseline composes reviewer prompts by substitution from the shared template.
    assert!(baseline.contains("reviewer_template.replace(\"{files}\", name)"));
    // No baseline bakes in a STATE answer (the outcome is the children's).
    for kind in ReferenceFactoryKind::selections() {
        assert!(!build_baseline_prompt(&by_kind(kind), "/tmp/ledger.json").contains("STATE: done"));
    }
    // The factory parent prompt never embeds the mini-repo (the children own it).
    let parent = build_factory_parent_prompt(&factory, "/tmp/ledger.json");
    assert_eq!(parent.matches(unique_snippet).count(), 0);
}

#[test]
fn the_shared_child_prompts_are_checkable_and_placeholder_faithful() {
    // The files node emits the exact file list as one fenced json block.
    let files = build_files_node_prompt();
    assert!(files.contains("```json"));
    for file in super::REVIEW_FILES {
        assert!(files.contains(file.name));
    }
    // The report node consumes both typed ports through placeholders.
    let report = build_report_node_prompt();
    assert!(report.contains("{file_list}"));
    assert!(report.contains("{found}"));
    assert!(report.contains("issues"));
    // The collector lists one placeholder per builder line and the expected
    // marker form.
    let collector = build_collector_prompt(WIDTH);
    for index in 1..=WIDTH {
        assert!(collector.contains(&format!("{{line-{index}}}")));
        assert!(collector.contains(&builder_marker(index)));
    }
    // The task chain templates bind {prev} and emit the step markers.
    let task_a = build_task_a_prompt();
    assert!(task_a.contains("STEP swt-1"));
    let task_b = build_task_b_prompt_template();
    assert!(task_b.contains("{prev}"));
    assert!(task_b.contains("STEP swt-2"));
    // The pr-manager templates bind their round inputs.
    let reviewing = build_pr_reviewing_prompt_template();
    assert!(reviewing.contains("{pr_url}"));
    assert!(reviewing.contains("{fix_report}"));
    let fixing = build_pr_fixing_prompt_template();
    assert!(fixing.contains("{verdict}"));
}

#[test]
fn the_resident_watcher_prompt_replies_once_and_holds_its_turn_open() {
    let watcher = build_watcher_prompt();
    assert!(
        watcher.contains("agent_message.send(\"WATCHER-UP swr-marker\", receiver_role=\"parent\")")
    );
    assert!(watcher.contains(&format!(
        "await asyncio.sleep({})",
        super::RESIDENT_WATCHER_SLEEP_SECONDS
    )));
    assert!(watcher.contains("Do not end your turn before the sleep finishes"));
    // The pr-manager's monitoring state idles the same way with its own marker.
    let monitoring = build_pr_monitoring_prompt();
    assert!(monitoring
        .contains("agent_message.send(\"MERGE-READY swr-marker\", receiver_role=\"parent\")"));
}

#[test]
fn pr_manager_machine_prompts_carry_no_orchestration_code() {
    for prompt in [
        build_pr_reviewing_prompt_template(),
        build_pr_fixing_prompt_template(),
        build_pr_monitoring_prompt(),
        super::build_pr_entry_prompt(),
    ] {
        assert!(!prompt.contains("rlm.spawn"));
        assert!(!prompt.contains("rlm.collect"));
        assert!(!prompt.contains("rlm.factory"));
    }
}

#[test]
fn the_pr_manager_parent_prompt_runs_the_machine_and_stops_the_resident() {
    let factory = by_kind(ReferenceFactoryKind::PrManager);
    let parent = build_factory_parent_prompt(&factory, "/tmp/ledger.json");
    assert!(parent.contains("rlm.factory.run"));
    assert!(parent.contains("rlm.factory.status"));
    assert!(parent.contains("rlm.factory.stop"));
    assert!(parent.contains("ANSWER: APPROVED:"));
    let baseline = build_baseline_prompt(&factory, "/tmp/ledger.json");
    assert!(baseline.contains("rlm.spawn"));
    assert!(!baseline.contains("rlm.factory"));
}

// -- harness seeding ------------------------------------------------------

#[test]
fn seeds_factory_entries_the_host_can_load_back() {
    let specs = factories();
    let body = build_harness_state_file(&specs, "2026-01-01T00:00:00.000Z");
    let parsed: Value = serde_json::from_str(&body).expect("the seeded body parses back");
    assert_eq!(parsed["schema"], 1);
    for kind in ["prompt", "memory", "skill", "subagent"] {
        assert!(
            parsed["entries"][kind].is_object(),
            "{kind} entries exist (empty)"
        );
    }
    let factory_entries = parsed["entries"]["factory"]
        .as_object()
        .expect("factory entries");
    assert_eq!(factory_entries.len(), specs.len());
}

#[test]
fn writes_one_entry_per_seeded_spec_with_the_local_schema() {
    let specs = factories();
    let body = build_harness_state_file(&specs, "2026-01-01T00:00:00.000Z");
    let parsed: Value = serde_json::from_str(&body).expect("parse");
    let factory_entries = parsed["entries"]["factory"]
        .as_object()
        .expect("factory entries");
    for spec in &specs {
        let entry = &factory_entries[&spec.id];
        assert_eq!(entry["id"], spec.id);
        assert_eq!(entry["kind"], "factory");
        assert_eq!(entry["title"], spec.title);
        assert_eq!(entry["content"], spec.description);
        assert_eq!(entry["path"], "factory-dag-eval");
        assert_eq!(entry["scope"], "local");
        assert_eq!(entry["source"], "agent");
        assert_eq!(entry["version"], 1);
        assert_eq!(entry["created_at"], "2026-01-01T00:00:00.000Z");
        assert_eq!(entry["updated_at"], "2026-01-01T00:00:00.000Z");
    }
}

#[test]
fn seeds_machine_form_reference_factories_under_arguments_machine() {
    let specs = factories();
    let body = build_harness_state_file(&specs, "2026-01-01T00:00:00.000Z");
    let parsed: Value = serde_json::from_str(&body).expect("parse");
    let pr_entry = &parsed["entries"]["factory"]["factory-dag-eval-pr-manager"];
    assert!(
        pr_entry["arguments"].get("machine").is_some(),
        "the machine form wins when present"
    );
    assert!(
        pr_entry["arguments"].get("dag").is_none(),
        "never both forms"
    );
    assert_eq!(
        pr_entry["arguments"]["machine"]["states"][0]["id"],
        build_pr_manager_machine()["states"][0]["id"]
    );
    // The dag arms seed under arguments.dag (compiler-path compatibility).
    let sweep_entry = &parsed["entries"]["factory"]["factory-dag-eval-review-sweep"];
    assert!(sweep_entry["arguments"].get("dag").is_some());
}

// -- answer parsing -------------------------------------------------------

#[test]
fn parses_every_answer_format() {
    // The full pr-manager line.
    let text = "here is the outcome\nANSWER: APPROVED: yes; DEFECTS: AUDIT-A1, AUDIT-B1; ROUNDS: 2; STOPPED: monitoring; STATE: stopped\ntrailing text";
    let parsed = parse_answer_line(Some(text)).expect("pr-manager line parses");
    assert_eq!(parsed.approved, Some(true));
    assert_eq!(
        parsed.defects,
        vec!["AUDIT-A1".to_string(), "AUDIT-B1".to_string()]
    );
    assert_eq!(parsed.rounds, Some(2));
    assert_eq!(parsed.stopped, vec!["monitoring".to_string()]);
    assert_eq!(parsed.state.as_deref(), Some("stopped"));

    // The review sweep line.
    let sweep = parse_answer_line(Some("ANSWER: ISSUES: AUDIT-A1,AUDIT-B1; STATE: done"));
    assert_eq!(
        sweep.as_ref().map(|answer| answer.issues.clone()),
        Some(vec!["AUDIT-A1".to_string(), "AUDIT-B1".to_string()])
    );
    assert_eq!(
        sweep.and_then(|answer| answer.state).as_deref(),
        Some("done")
    );

    // Case-insensitive prefix, lower-case yes/no.
    let lowercase = parse_answer_line(Some("answer: approved: YES; rejected: no"));
    let lowercase = lowercase.expect("lowercase prefix parses");
    assert_eq!(lowercase.approved, Some(true));
    assert_eq!(lowercase.rejected, Some(false));

    // The escalation probe line.
    let escalation = parse_answer_line(Some("ANSWER: STATE: paused; FAILED-NODE: review-broken; REPORT-STATUS: pending; MESSAGE: unknown model")).expect("escalation line");
    assert_eq!(escalation.failed_node.as_deref(), Some("review-broken"));
    assert_eq!(escalation.report_status.as_deref(), Some("pending"));

    // The dry-run line (children count parses as a number).
    let dry_run = parse_answer_line(Some(
        "ANSWER: REJECTED: yes; CHILDREN: 0; MESSAGE: references unknown subagent",
    ))
    .expect("dry-run line");
    assert_eq!(dry_run.children, Some(0));

    // Absent or malformed lines do not parse.
    assert!(parse_answer_line(None).is_none());
    assert!(parse_answer_line(Some("no answer here")).is_none());
    assert!(parse_answer_line(Some("ANSWER:")).is_none());
}

// -- task-success checks --------------------------------------------------

#[test]
fn accepts_a_complete_review_sweep_and_rejects_a_missing_planted_issue() {
    let factory = by_kind(ReferenceFactoryKind::ReviewSweep);
    let issues: Vec<String> = review_issue_ids().into_iter().map(str::to_string).collect();
    let good = answer(&json!({ "issues": issues, "state": "done" }));
    assert!(check(&factory, good.as_ref(), Some(&review_sweep_ledger())).ok);
    // A missing planted issue fails.
    let short = answer(&json!({ "issues": ["AUDIT-A1", "AUDIT-B2"], "state": "done" }));
    let outcome = check(&factory, short.as_ref(), Some(&review_sweep_ledger()));
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-B1")));
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-C1")));
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-D1")));
}

#[test]
fn cross_checks_the_review_sweep_ledger_against_the_aggregator_preview() {
    let factory = by_kind(ReferenceFactoryKind::ReviewSweep);
    let issues: Vec<String> = review_issue_ids().into_iter().map(str::to_string).collect();
    let good = answer(&json!({ "issues": issues, "state": "done" }));
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [
            node_fixture("files", "done", json!({})),
            node_fixture("review", "done", json!({})),
            node_fixture("report", "done", json!({ "answer_preview": "```json\n{\"issues\": [\"AUDIT-A1\",\"AUDIT-B2\"]}\n```" }))
        ]
    }));
    let outcome = check(&factory, good.as_ref(), Some(&ledger));
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-B1 missing from the report node answer preview")));
    // A ledger whose state disagrees fails.
    let wrong_state = status_ledger_fixture(json!({
        "state": "failed",
        "nodes": [
            node_fixture("report", "done", json!({ "answer_preview": json!(review_issue_ids()).to_string() }))
        ]
    }));
    let outcome = check(
        &factory,
        answer(&json!({ "issues": review_issue_ids(), "state": "done" })).as_ref(),
        Some(&wrong_state),
    );
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("ledger state is failed, expected done")));
}

#[test]
fn checks_the_builder_markers_against_the_collector_preview() {
    let factory = by_kind(ReferenceFactoryKind::Builder);
    let markers: Vec<String> = (1..=WIDTH).map(builder_marker).collect();
    assert!(
        check(
            &factory,
            answer(&json!({ "markers": markers, "state": "done" })).as_ref(),
            None
        )
        .ok
    );
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [node_fixture("collector", "done", json!({ "answer_preview": "COLLECTED swb-marker-1" }))]
    }));
    let outcome = check(
        &factory,
        answer(&json!({ "markers": markers, "state": "done" })).as_ref(),
        Some(&ledger),
    );
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("swb-marker-2 missing from the collector answer preview")));
}

#[test]
fn checks_the_resident_teardown_tasks_settled_watcher_cancelled() {
    let factory = by_kind(ReferenceFactoryKind::ResidentWatcher);
    let good = answer(
        &json!({ "markers": ["swt-1", "swt-2"], "stopped": ["watcher"], "state": "stopped" }),
    );
    assert!(check(&factory, good.as_ref(), None).ok);
    assert!(
        !check(
            &factory,
            answer(&json!({ "markers": ["swt-1", "swt-2"], "stopped": [], "state": "stopped" }))
                .as_ref(),
            None
        )
        .ok
    );
    assert!(check(&factory, good.as_ref(), Some(&resident_ledger())).ok);
    let bad_ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [
            node_fixture("watcher", "running", json!({ "lifecycle": "resident" })),
            node_fixture("task-a", "done", json!({})),
            node_fixture("task-b", "done", json!({}))
        ]
    }));
    let outcome = check(&factory, good.as_ref(), Some(&bad_ledger));
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("expected stopped")));
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("watcher node is not cancelled")));
}

#[test]
fn checks_the_escalation_probe_answer_and_ledger() {
    let factory = by_kind(ReferenceFactoryKind::ReviewSweepFail);
    let good = answer(
        &json!({ "state": "paused", "failed_node": "review-broken", "report_status": "pending" }),
    );
    assert!(check(&factory, good.as_ref(), None).ok);
    let outcome = check(&factory, good.as_ref(), Some(&escalation_ledger()));
    assert!(
        outcome.ok,
        "the paused ledger matches the probe answer: {:?}",
        outcome.problems
    );
    // A report node that started despite the pause fails.
    let mut ledger = escalation_ledger();
    ledger["events"]
        .as_array_mut()
        .expect("events")
        .push(event_fixture(14, "spawned", json!({ "node": "report" })));
    let outcome = check(
        &factory,
        answer(&json!({ "state": "paused", "failed_node": "review-broken", "report_status": "pending" })).as_ref(),
        Some(&ledger),
    );
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("report node started despite the escalation pause")));
}

#[test]
fn checks_the_dry_run_rejection_answer() {
    let factory = by_kind(ReferenceFactoryKind::DryRunReject);
    let good = answer(&json!({
        "rejected": true,
        "children": 0,
        "message": "node 'broken-source' references unknown subagent 'no-such-subagent-entry'"
    }));
    assert!(check(&factory, good.as_ref(), None).ok);
    let bad = answer(&json!({ "rejected": false, "children": 2, "message": "no error" }));
    assert!(!check(&factory, bad.as_ref(), None).ok);
    let none = check_task_success(&factory, None, None, EvalArm::Factory, None);
    assert_eq!(
        none.problems,
        vec!["no ANSWER line in the parent's final text".to_string()]
    );
}

#[test]
fn baseline_arms_cross_check_the_collect_ledger_against_the_answer_ids() {
    let factory = by_kind(ReferenceFactoryKind::ReviewSweep);
    let baseline_ledger = json!({
        "reviewer-fa": "FOUND AUDIT-A1",
        "reviewer-fb": "FOUND AUDIT-B1",
        "reviewer-fc": "FOUND AUDIT-C1",
        "reviewer-fd": "FOUND AUDIT-D1"
    });
    let good = check_baseline(
        &factory,
        answer(&json!({ "issues": review_issue_ids() })).as_ref(),
        Some(&baseline_ledger),
    );
    assert!(
        good.ok,
        "no STATE field is required for baselines: {:?}",
        good.problems
    );

    // A planted id the children never reported must fail.
    let short_ledger = json!({ "reviewer-fa": "FOUND AUDIT-A1" });
    let missing = check_baseline(
        &factory,
        answer(&json!({ "issues": review_issue_ids() })).as_ref(),
        Some(&short_ledger),
    );
    assert!(!missing.ok);
    assert!(missing
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-B1 missing from the baseline collect ledger")));

    // An ANSWER id absent from the ledger must fail (the parent cannot invent it).
    let mut invented_issues: Vec<String> =
        review_issue_ids().into_iter().map(str::to_string).collect();
    invented_issues.push("AUDIT-Z9".to_string());
    let invented = check_baseline(
        &factory,
        answer(&json!({ "issues": invented_issues })).as_ref(),
        Some(&baseline_ledger),
    );
    assert!(!invented.ok);
    assert!(invented
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-Z9 is not present in the baseline collect ledger")));

    // A missing ledger fails completion instead of passing on the self-reported ANSWER.
    let no_ledger = check_baseline(
        &factory,
        answer(&json!({ "issues": review_issue_ids() })).as_ref(),
        None,
    );
    assert!(!no_ledger.ok);
    assert!(no_ledger
        .problems
        .iter()
        .any(|problem| problem.contains("baseline collect ledger missing")));
}

#[test]
fn baseline_arms_check_builder_markers_and_the_resident_chain_against_the_collect_ledger() {
    let builder = by_kind(ReferenceFactoryKind::Builder);
    let markers: Vec<String> = (1..=WIDTH).map(builder_marker).collect();
    let builder_ledger: Value = {
        let mut map = serde_json::Map::new();
        for marker in &markers {
            map.insert(
                format!("builder-{marker}"),
                json!(format!("BUILT {marker}")),
            );
        }
        Value::Object(map)
    };
    assert!(
        check_baseline(
            &builder,
            answer(&json!({ "markers": markers })).as_ref(),
            Some(&builder_ledger)
        )
        .ok
    );
    let short = json!({ "builder-1": "BUILT swb-marker-1" });
    let missing = check_baseline(
        &builder,
        answer(&json!({ "markers": markers })).as_ref(),
        Some(&short),
    );
    assert!(!missing.ok);
    assert!(missing
        .problems
        .iter()
        .any(|problem| problem.contains("swb-marker-2 missing from the baseline collect ledger")));

    let resident = by_kind(ReferenceFactoryKind::ResidentWatcher);
    let resident_ledger = json!({ "task-a": "STEP swt-1", "task-b": "STEP swt-2" });
    assert!(
        check_baseline(
            &resident,
            answer(&json!({ "markers": ["swt-1", "swt-2"], "stopped": ["watcher"] })).as_ref(),
            Some(&resident_ledger)
        )
        .ok
    );
    let missing_task = check_baseline(
        &resident,
        answer(&json!({ "markers": ["swt-1"], "stopped": ["watcher"] })).as_ref(),
        Some(&resident_ledger),
    );
    assert!(!missing_task.ok);
    assert!(missing_task
        .problems
        .iter()
        .any(|problem| problem.contains("swt-2 missing from the ANSWER line")));
}

fn pr_answer(overrides: &Value) -> Option<ParsedAnswer> {
    let mut base = json!({
        "approved": true,
        "defects": review_issue_ids(),
        "rounds": 2,
        "stopped": ["monitoring"],
        "state": "stopped"
    });
    if let (Some(object), Value::Object(over)) = (base.as_object_mut(), overrides.clone()) {
        for (key, value) in over {
            object.insert(key, value);
        }
    }
    serde_json::from_value(base).expect("pr-manager answer")
}

#[test]
fn accepts_the_pr_manager_answer_and_machine_ledger() {
    let factory = by_kind(ReferenceFactoryKind::PrManager);
    let good = pr_answer(&json!({}));
    assert!(check(&factory, good.as_ref(), None).ok);
    assert!(
        check(&factory, good.as_ref(), Some(&pr_manager_ledger())).ok,
        "the machine ledger cross-checks clean"
    );
}

#[test]
fn rejects_an_unapproved_final_verdict_wrong_rounds_and_missing_defects() {
    let factory = by_kind(ReferenceFactoryKind::PrManager);
    let unapproved = check(
        &factory,
        pr_answer(&json!({ "approved": false })).as_ref(),
        None,
    );
    assert!(!unapproved.ok);
    assert!(unapproved
        .problems
        .iter()
        .any(|problem| problem.contains("ANSWER approved is false, expected yes")));
    let wrong_rounds = check(&factory, pr_answer(&json!({ "rounds": 3 })).as_ref(), None);
    assert!(!wrong_rounds.ok);
    assert!(wrong_rounds
        .problems
        .iter()
        .any(|problem| problem.contains("ANSWER rounds is 3, expected 2")));
    let missing = check(
        &factory,
        pr_answer(&json!({ "defects": ["AUDIT-A1"] })).as_ref(),
        None,
    );
    assert!(!missing.ok);
    assert!(missing
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-B1 missing from the ANSWER line")));
}

#[test]
fn cross_checks_the_machine_ledger_review_rounds_the_fix_ledger_and_the_resident_teardown() {
    let factory = by_kind(ReferenceFactoryKind::PrManager);
    let ledger = pr_manager_ledger();
    let outcome = check(&factory, pr_answer(&json!({})).as_ref(), Some(&ledger));
    assert!(
        outcome.ok,
        "the happy ledger passes: {:?}",
        outcome.problems
    );

    // Wrong review rounds: reviewing entries_used must be exactly 2.
    let mut bad = pr_manager_ledger();
    if let Some(reviewing) = bad["nodes"]
        .as_array_mut()
        .expect("nodes")
        .iter_mut()
        .find(|node| node["id"] == "reviewing")
    {
        reviewing["entries_used"] = json!(3);
    }
    let outcome = check(&factory, pr_answer(&json!({})).as_ref(), Some(&bad));
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("ledger reviewing entries_used is 3, expected 2")));

    // An unapproved final verdict in the reviewing answer fails even when the
    // ANSWER claims approval.
    let mut bad = pr_manager_ledger();
    if let Some(reviewing) = bad["nodes"]
        .as_array_mut()
        .expect("nodes")
        .iter_mut()
        .find(|node| node["id"] == "reviewing")
    {
        reviewing["answer_preview"] = json!(
            "```json\n{\"verdict\": {\"approved\": false, \"findings\": [\"AUDIT-A1\"]}}\n```"
        );
    }
    let outcome = check(&factory, pr_answer(&json!({})).as_ref(), Some(&bad));
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem.contains("final reviewing verdict is not approved true")));

    // A multi-line fenced verdict parses (the accepted review fix: a
    // pretty-printed verdict is a valid verdict).
    let multiline =
        "```json\n{\n  \"verdict\": {\n    \"approved\": true,\n    \"findings\": []\n  }\n}\n```";
    assert_eq!(
        parse_fenced_json(multiline).and_then(|object| object.get("verdict").cloned()),
        Some(json!({ "approved": true, "findings": [] }))
    );
}

#[test]
fn accepts_the_baseline_arm_against_the_collect_dump_ids_rounds_no_inventions() {
    let factory = by_kind(ReferenceFactoryKind::PrManager);
    // The dump carries the fix answers as an ARRAY plus a numeric rounds field:
    // both must contribute to the cross-check text (the accepted review fix).
    let baseline_ledger = json!({
        "fix_answers": [
            "```json\n{\"fix_report\": {\"fixed\": [\"AUDIT-A1\",\"AUDIT-B1\",\"AUDIT-C1\",\"AUDIT-D1\"]}}\n```"
        ],
        "rounds": 2
    });
    let good = check_baseline(
        &factory,
        pr_answer(&json!({})).as_ref(),
        Some(&baseline_ledger),
    );
    assert!(
        good.ok,
        "the array's ids and the numeric rounds both cross-check: {:?}",
        good.problems
    );

    // An id the fix answers never carried fails the trial.
    let short = json!({
        "fix_answers": ["```json\n{\"fix_report\": {\"fixed\": [\"AUDIT-A1\"]}}\n```"],
        "rounds": 2
    });
    let missing = check_baseline(&factory, pr_answer(&json!({})).as_ref(), Some(&short));
    assert!(!missing.ok);
    assert!(missing
        .problems
        .iter()
        .any(|problem| problem.contains("AUDIT-B1 missing from the baseline collect ledger")));

    // A rounds value the dump never recorded fails.
    let wrong_rounds = json!({
        "fix_answers": ["```json\n{\"fix_report\": {\"fixed\": [\"AUDIT-A1\",\"AUDIT-B1\",\"AUDIT-C1\",\"AUDIT-D1\"]}}\n```"],
        "rounds": 1
    });
    let outcome = check_baseline(
        &factory,
        pr_answer(&json!({})).as_ref(),
        Some(&wrong_rounds),
    );
    assert!(!outcome.ok);
    assert!(outcome
        .problems
        .iter()
        .any(|problem| problem
            .contains("ANSWER rounds 2 is not present in the baseline collect ledger")));
}

// -- the replay checker ---------------------------------------------------

#[test]
fn accepts_the_reference_ledgers_with_stable_identities_and_full_accounting() {
    for ledger in [
        review_sweep_ledger(),
        resident_ledger(),
        escalation_ledger(),
    ] {
        let result = check_replay_ledger(&ledger);
        assert!(
            result.ok,
            "reference ledger replays clean: {:?}",
            result.problems
        );
    }
}

#[test]
fn accepts_machine_form_ledgers_with_the_state_machine_event_kinds() {
    let result = check_replay_ledger(&pr_manager_ledger());
    assert!(
        result.ok,
        "the pr-manager machine ledger replays clean: {:?}",
        result.problems
    );

    // A wait-state machine: a wait_settled node with zero spawned instances
    // and a max_entries-blocked self-target transition.
    let wait_ledger = status_ledger_fixture(json!({
        "spec_id": "factory-dag-eval-wait-probe",
        "state": "done",
        "nodes": [
            node_fixture("watch", "done", json!({
                "instances": [],
                "entries_used": 1,
                "max_entries": 1,
                "entries": [json!({ "index": 0, "status": "done" })]
            })),
            node_fixture("act", "done", json!({
                "instances": [instance_fixture(0, "done", json!({ "duration_ms": 2_000 }))],
                "entries_used": 1,
                "max_entries": 1,
                "entries": [json!({ "index": 0, "status": "done" })]
            }))
        ],
        "events": [
            event_fixture(1, "run_started", json!({ "detail": "2 states, max_parallel 8" })),
            event_fixture(2, "state_entry", json!({ "node": "watch", "entry": 0, "detail": "entry state" })),
            event_fixture(3, "node_ready", json!({ "node": "watch", "entry": 0, "detail": "waiting on path '/tmp/x'" })),
            event_fixture(4, "wait_settled", json!({ "node": "watch", "entry": 0, "detail": "path changed: /tmp/x", "timed_out": false })),
            event_fixture(5, "transition_fired", json!({ "from": "watch", "to": "act", "detail": "'watch' -> 'act'" })),
            event_fixture(6, "state_entry", json!({ "node": "act", "entry": 0, "detail": "entered from watch" })),
            event_fixture(7, "node_ready", json!({ "node": "act", "entry": 0, "instance": 0 })),
            event_fixture(8, "spawned", json!({ "node": "act", "entry": 0, "instance": 0 })),
            event_fixture(9, "settled", json!({ "node": "act", "entry": 0, "instance": 0, "status": "done", "duration_ms": 2_000 })),
            event_fixture(10, "answer_captured", json!({ "node": "act", "entry": 0, "instance": 0, "answer": "acted on the event" })),
            event_fixture(11, "transition_blocked", json!({ "from": "act", "to": "act", "detail": "state 'act' is at max_entries 1" })),
            event_fixture(12, "milestone", json!({ "milestone": "finished", "detail": "run complete: 2 state(s), 1 transition(s) fired" }))
        ],
        "usage": { "spawns": 1, "settled": 1, "tool_uses": 1, "max_parallel": 8, "running": 0, "transitions_fired": 1 }
    }));
    let result = check_replay_ledger(&wait_ledger);
    assert!(
        result.ok,
        "the wait-machine ledger replays clean: {:?}",
        result.problems
    );
}

#[test]
fn flags_a_state_entry_index_gap() {
    let mut ledger = pr_manager_ledger();
    // Drop the second reviewing state_entry event (forge a gap: 0, 2).
    let events = ledger["events"].as_array_mut().expect("events");
    events.retain(|event| {
        !(event["kind"] == "state_entry" && event["node"] == "reviewing" && event["entry"] == 1)
    });
    let result = check_replay_ledger(&ledger);
    assert!(!result.ok);
    assert!(
        result.problems.iter().any(|problem| problem
            .contains("state_entry indices are not contiguous")
            || problem.contains("seq gap")),
        "problems: {:?}",
        result.problems
    );
}

#[test]
fn flags_a_wait_settled_node_that_spawned_instances() {
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [
            node_fixture("watch", "done", json!({
                "instances": [instance_fixture(0, "done", json!({ "duration_ms": 100 }))],
                "entries": [json!({ "index": 0, "status": "done" })]
            }))
        ],
        "events": [
            event_fixture(1, "run_started", json!({})),
            event_fixture(2, "state_entry", json!({ "node": "watch", "entry": 0 })),
            event_fixture(3, "spawned", json!({ "node": "watch", "instance": 0 })),
            event_fixture(4, "wait_settled", json!({ "node": "watch", "entry": 0 })),
            event_fixture(5, "settled", json!({ "node": "watch", "instance": 0, "status": "done", "duration_ms": 100 })),
            event_fixture(6, "milestone", json!({ "milestone": "finished" }))
        ],
        "usage": { "spawns": 1, "settled": 1, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    }));
    let result = check_replay_ledger(&ledger);
    assert!(!result.ok);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("settled a wait but spawned")));
}

#[test]
fn flags_transition_events_missing_their_from_to_endpoints() {
    let mut ledger = pr_manager_ledger();
    let events = ledger["events"].as_array_mut().expect("events");
    let first_fire = events
        .iter_mut()
        .find(|event| event["kind"] == "transition_fired")
        .expect("a fired transition");
    first_fire.as_object_mut().expect("object").remove("from");
    let result = check_replay_ledger(&ledger);
    assert!(!result.ok);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("requires from and to states")));
}

#[test]
fn cross_checks_usage_transitions_fired_against_the_transition_fired_events() {
    let mut ledger = pr_manager_ledger();
    ledger["usage"]["transitions_fired"] = json!(3);
    let result = check_replay_ledger(&ledger);
    assert!(!result.ok);
    assert!(result.problems.iter().any(|problem| problem
        .contains("usage.transitions_fired 3 does not match 4 transition_fired event(s)")));
}

#[test]
fn flags_transitions_that_reference_unknown_states() {
    let mut ledger = pr_manager_ledger();
    let events = ledger["events"].as_array_mut().expect("events");
    let first_fire = events
        .iter_mut()
        .find(|event| event["kind"] == "transition_fired")
        .expect("a fired transition");
    first_fire["to"] = json!("no-such-state");
    let result = check_replay_ledger(&ledger);
    assert!(!result.ok);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("transitions to unknown state \"no-such-state\"")));
}

#[test]
fn rejects_a_ledger_that_does_not_match_the_status_shape() {
    let cases = [
        json!({}),
        json!({ "run_id": "", "spec_id": "x", "state": "done", "nodes": [], "events": [], "elapsed_ms": 1, "usage": {} }),
        json!({ "run_id": "r", "spec_id": "x", "state": "wedged", "nodes": [], "events": [], "elapsed_ms": 1, "usage": {} }),
        json!({ "run_id": "r", "spec_id": "x", "state": "done", "events": [], "elapsed_ms": 1, "usage": {} }),
        json!({ "run_id": "r", "spec_id": "x", "state": "done", "nodes": [], "events": [], "elapsed_ms": -1, "usage": {} }),
    ];
    for case in cases {
        let result = check_replay_ledger(&case);
        assert!(!result.ok, "shape must be rejected: {case}");
        assert!(result
            .problems
            .iter()
            .any(|problem| problem.contains("does not match the factory status shape")));
    }
}

#[test]
fn flags_a_settled_done_event_without_a_duration() {
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [node_fixture("a", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 500 }))] }))],
        "events": [
            event_fixture(1, "spawned", json!({ "node": "a", "instance": -1 })),
            event_fixture(2, "settled", json!({ "node": "a", "instance": -1, "status": "done" })),
            event_fixture(3, "milestone", json!({ "milestone": "finished" }))
        ],
        "usage": { "spawns": 1, "settled": 1, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    }));
    let result = check_replay_ledger(&ledger);
    assert!(!result.ok);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("settles done without a duration_ms")));
}

#[test]
fn flags_non_increasing_and_duplicate_event_seqs() {
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [node_fixture("a", "done", json!({}))],
        "events": [
            event_fixture(2, "run_started", json!({})),
            event_fixture(2, "milestone", json!({ "milestone": "finished" }))
        ],
        "usage": { "spawns": 0, "settled": 0, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    }));
    let result = check_replay_ledger(&ledger);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("non-increasing seq")));
}

#[test]
fn flags_a_dropped_event_as_a_seq_gap_within_the_window() {
    // The window holds seq 1, 2, 4: one dropped event between 2 and 4.
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [node_fixture("a", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 10 }))] }))],
        "events": [
            event_fixture(1, "spawned", json!({ "node": "a", "instance": -1 })),
            event_fixture(2, "settled", json!({ "node": "a", "instance": -1, "status": "done", "duration_ms": 10 })),
            event_fixture(4, "milestone", json!({ "milestone": "finished" }))
        ],
        "usage": { "spawns": 1, "settled": 1, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    }));
    let result = check_replay_ledger(&ledger);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("seq gap: expected 3, got 4 (dropped event)")));
}

#[test]
fn accepts_a_retry_ledger_two_settled_events_on_one_spawned_key_match_usage_settled() {
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [node_fixture("a", "done", json!({
            "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 9_000 }))]
        }))],
        "events": [
            event_fixture(1, "spawned", json!({ "node": "a", "instance": -1 })),
            event_fixture(2, "settled", json!({ "node": "a", "instance": -1, "status": "error", "error": "child failed" })),
            event_fixture(3, "retry", json!({ "node": "a", "instance": -1, "detail": "attempt 1 failed; re-spawning" })),
            event_fixture(4, "spawned", json!({ "node": "a", "instance": -1 })),
            event_fixture(5, "settled", json!({ "node": "a", "instance": -1, "status": "done", "duration_ms": 9_000 })),
            event_fixture(6, "milestone", json!({ "milestone": "finished" }))
        ],
        "usage": { "spawns": 2, "settled": 2, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    }));
    let result = check_replay_ledger(&ledger);
    assert!(
        result.ok,
        "the retried instance's two settled events match usage.settled: {:?}",
        result.problems
    );
}

#[test]
fn flags_unknown_event_kinds_and_stages() {
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [node_fixture("a", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 10 }))] }))],
        "events": [
            event_fixture(1, "spawned", json!({ "node": "a", "instance": -1, "stage": "hallucinated" })),
            event_fixture(2, "teleported", json!({})),
            event_fixture(3, "settled", json!({ "node": "a", "instance": -1, "status": "done", "duration_ms": 10 })),
            event_fixture(4, "milestone", json!({ "milestone": "finished" }))
        ],
        "usage": { "spawns": 1, "settled": 1, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    }));
    let result = check_replay_ledger(&ledger);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("unknown kind: \"teleported\"")));
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("unknown stage: \"hallucinated\"")));
}

#[test]
fn flags_usage_counts_that_disagree_with_the_event_stream() {
    let mut ledger = review_sweep_ledger();
    ledger["usage"]["spawns"] = json!(5);
    ledger["usage"]["settled"] = json!(7);
    let result = check_replay_ledger(&ledger);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("usage.spawns 5 does not match 6 spawned event(s)")));
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("usage.settled 7 does not match 6 collect settlement(s)")));
}

#[test]
fn flags_a_done_run_without_a_finished_milestone() {
    let mut ledger = review_sweep_ledger();
    let events = ledger["events"].as_array_mut().expect("events");
    events.retain(|event| event["kind"] != "milestone");
    let result = check_replay_ledger(&ledger);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("run state done without a finished milestone")));
}

#[test]
fn flags_a_spawned_instance_that_never_settles_on_a_completed_run() {
    let ledger = status_ledger_fixture(json!({
        "state": "done",
        "nodes": [
            node_fixture("a", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 10 }))] })),
            node_fixture("b", "done", json!({ "instances": [instance_fixture(-1, "done", json!({ "duration_ms": 10 }))] }))
        ],
        "events": [
            event_fixture(1, "spawned", json!({ "node": "a", "instance": -1 })),
            event_fixture(2, "settled", json!({ "node": "a", "instance": -1, "status": "done", "duration_ms": 10 })),
            // b spawned but never settled or cancelled.
            event_fixture(3, "spawned", json!({ "node": "b", "instance": -1 })),
            event_fixture(4, "milestone", json!({ "milestone": "finished" }))
        ],
        "usage": { "spawns": 2, "settled": 1, "tool_uses": 0, "max_parallel": 8, "running": 0 }
    }));
    let result = check_replay_ledger(&ledger);
    assert!(result.problems.iter().any(|problem| problem
        .contains("spawned instance b#-1 never settled or cancelled (1 spawn event(s))")));
}

#[test]
fn notes_a_truncated_event_window_instead_of_asserting_counts() {
    let mut ledger = review_sweep_ledger();
    let events = ledger["events"].as_array_mut().expect("events");
    // Drop the first event: the window now starts at seq 2.
    events.remove(0);
    // The count assertions must be skipped, but the truncation is noted.
    let result = check_replay_ledger(&ledger);
    assert!(result
        .problems
        .iter()
        .any(|problem| problem.contains("event window is truncated (first seq is not 1)")));
    assert!(!result
        .problems
        .iter()
        .any(|problem| problem.contains("usage.spawns")));
}

#[test]
fn runs_over_a_saved_report_json_and_a_bare_ledger() {
    let config = FactoryEvalConfig {
        out_dir: "out".to_string(),
        ..FactoryEvalConfig::default()
    };
    let rows = vec![
        FactoryEvalTrialResult::factory_row(
            &by_kind(ReferenceFactoryKind::ReviewSweep),
            1,
            "test/model",
            &TaskCheckOutcome {
                ok: true,
                problems: vec![],
            },
            vec![],
            None,
            Some(review_sweep_ledger()),
            Some(&check_replay_ledger(&review_sweep_ledger())),
            12_000,
            Some(4_000),
            Some(9_000),
        ),
        FactoryEvalTrialResult::baseline_row(
            &by_kind(ReferenceFactoryKind::ReviewSweep),
            1,
            "test/model",
            &TaskCheckOutcome {
                ok: true,
                problems: vec![],
            },
            vec![],
            None,
            12_000,
            Some(4_000),
            Some(9_000),
        ),
    ];
    let report = serialize_eval_report(&config, rows, "2026-01-01T00:00:00.000Z");
    let serialized = serde_json::to_value(&report).expect("serialize report");
    let outcome = run_replay_checks(&serialized);
    assert!(outcome.ok);
    assert_eq!(
        outcome.ledgers.len(),
        1,
        "only the factory arm carries a ledger"
    );
    assert_eq!(outcome.ledgers[0].id, "review-sweep/factory/trial-1");

    // A bare ledger checks on its own.
    let outcome = run_replay_checks(&resident_ledger());
    assert!(outcome.ok);
    assert_eq!(outcome.ledgers.len(), 1);
    assert_eq!(outcome.ledgers[0].id, "ledger");

    // The older hand-built trials key still works.
    let legacy = json!({ "trials": [ { "factory": "review-sweep", "arm": "factory", "trial": 2, "ledger": resident_ledger() } ] });
    let outcome = run_replay_checks(&legacy);
    assert!(outcome.ok);
    assert_eq!(outcome.ledgers[0].id, "review-sweep/factory/trial-2");

    // An empty input never silently passes.
    let outcome = run_replay_checks(&json!({}));
    assert!(
        !outcome.ok,
        "a report with no ledgers must not replay clean"
    );
}

// -- verdicts, args, and the report ---------------------------------------

fn passing_row(
    kind: ReferenceFactoryKind,
    arm: EvalArm,
    trial: u64,
    context: Option<u64>,
    overshoot: u64,
) -> FactoryEvalTrialResult {
    let factory = by_kind(kind);
    let problems = if kind == ReferenceFactoryKind::DryRunReject {
        vec!["planted problem".to_string()]
    } else {
        vec![]
    };
    FactoryEvalTrialResult {
        factory: kind.as_str().to_string(),
        arm,
        trial,
        model: "test/model".to_string(),
        task_success: true,
        problems,
        state: Some("done".to_string()),
        wall_ms: 1_000,
        context_tokens: context,
        total_tokens: Some(9_000),
        declared_fan_in: factory.declared_fan_in,
        queue_latency_ms: None,
        teardown_latency_ms: None,
        declared_budget_ms: factory.declared_budget_ms,
        budget_overshoot_ms: overshoot,
        elapsed_ms: Some(factory.declared_budget_ms + overshoot),
        spawns: Some(1),
        settled: Some(1),
        replay_ok: Some(true),
        replay_problems: vec![],
        answer: None,
        ledger: None,
        verdict: TrialVerdict::Pass,
    }
}

#[test]
fn excludes_the_escalation_and_dry_run_probes_from_the_budget_sum() {
    let rows = vec![
        passing_row(
            ReferenceFactoryKind::ReviewSweep,
            EvalArm::Factory,
            1,
            Some(5_000),
            0,
        ),
        passing_row(
            ReferenceFactoryKind::Builder,
            EvalArm::Factory,
            1,
            Some(5_000),
            30_000,
        ),
        // The probes never enter the sum, whatever their overshoot.
        passing_row(
            ReferenceFactoryKind::ReviewSweepFail,
            EvalArm::Factory,
            1,
            None,
            500_000,
        ),
        passing_row(
            ReferenceFactoryKind::DryRunReject,
            EvalArm::Factory,
            1,
            None,
            700_000,
        ),
        passing_row(
            ReferenceFactoryKind::ReviewSweep,
            EvalArm::Baseline,
            1,
            Some(8_000),
            0,
        ),
    ];
    let verdicts = compute_verdicts(&rows, None);
    assert_eq!(
        verdicts.budget_overshoot_ms, 30_000,
        "only the paired factory arms count"
    );
    assert_eq!(verdicts.budget_overshoot_zero, super::DefenseVerdict::Fail);
    assert_eq!(
        verdicts.failure_policy_matched,
        super::DefenseVerdict::Pass,
        "the escalation probe's verdict"
    );
}

#[test]
fn reports_inconclusive_probe_verdicts_when_the_probes_did_not_run() {
    let rows = vec![passing_row(
        ReferenceFactoryKind::ReviewSweep,
        EvalArm::Factory,
        1,
        Some(5_000),
        0,
    )];
    let verdicts = compute_verdicts(&rows, None);
    assert_eq!(
        verdicts.failure_policy_matched,
        super::DefenseVerdict::Inconclusive,
        "unrun probes are never a silent pass"
    );
    assert_eq!(
        verdicts.dry_run_rejected,
        super::DefenseVerdict::Inconclusive
    );
    // A factory-less sweep has no budget verdict at all.
    let empty = vec![passing_row(
        ReferenceFactoryKind::ReviewSweep,
        EvalArm::Baseline,
        1,
        None,
        0,
    )];
    let verdicts = compute_verdicts(&empty, None);
    assert_eq!(
        verdicts.budget_overshoot_zero,
        super::DefenseVerdict::Inconclusive
    );
}

#[test]
fn averages_context_tokens_per_pair_and_flags_lower_only_when_measured() {
    let rows = vec![
        passing_row(
            ReferenceFactoryKind::ReviewSweep,
            EvalArm::Factory,
            1,
            Some(4_000),
            0,
        ),
        passing_row(
            ReferenceFactoryKind::ReviewSweep,
            EvalArm::Factory,
            2,
            Some(6_000),
            0,
        ),
        passing_row(
            ReferenceFactoryKind::ReviewSweep,
            EvalArm::Baseline,
            1,
            Some(9_000),
            0,
        ),
        passing_row(
            ReferenceFactoryKind::Builder,
            EvalArm::Factory,
            1,
            Some(1_000_000),
            0,
        ),
        // The builder baseline never measured: lower stays Inconclusive.
        passing_row(ReferenceFactoryKind::Builder, EvalArm::Baseline, 1, None, 0),
    ];
    let verdicts = compute_verdicts(&rows, None);
    let sweep = verdicts
        .context_pairs
        .iter()
        .find(|pair| pair.factory == "review-sweep")
        .expect("sweep pair");
    assert_eq!(
        sweep.factory_context_tokens,
        Some(5_000),
        "the factory arm averages"
    );
    assert_eq!(sweep.baseline_context_tokens, Some(9_000));
    assert_eq!(sweep.lower, Some(true));
    assert!(sweep.both_correct);
    let builder = verdicts
        .context_pairs
        .iter()
        .find(|pair| pair.factory == "builder")
        .expect("builder pair");
    assert_eq!(
        builder.lower, None,
        "unmeasured arms report Inconclusive, never a pass or fail"
    );
}

#[test]
fn keeps_the_no_orchestration_verdict_computed_from_the_built_prompts() {
    let rows = vec![passing_row(
        ReferenceFactoryKind::ReviewSweep,
        EvalArm::Factory,
        1,
        Some(5_000),
        0,
    )];
    let verdicts = compute_verdicts(&rows, None);
    assert!(
        verdicts.no_orchestration_code,
        "computed from the built reference prompts"
    );
    // Falsifiable: a forged prompt set flips the verdict.
    let forged = vec!["await rlm.spawn('rogue')".to_string()];
    assert!(!check_no_orchestration_code(&forged));
}

#[test]
fn parses_args_with_defaults_and_clamps_the_width() {
    let config = parse_eval_args(&[]).expect("defaults");
    assert_eq!(config.model, "prime-inference/internal/glm-5.2-fast");
    assert_eq!(config.trials, 1);
    assert_eq!(config.width, 6);
    assert_eq!(config.timeout_minutes, 20);
    assert_eq!(
        config.factories,
        ReferenceFactoryKind::selections().to_vec()
    );
    assert_eq!(config.out_dir, "factory-dag-eval-reports");

    let args = [
        "--model".to_string(),
        "provider/model-x".to_string(),
        "--factories".to_string(),
        "builder,pr-manager".to_string(),
        "--width".to_string(),
        "99".to_string(),
        "--trials".to_string(),
        "3".to_string(),
        "--timeout-minutes".to_string(),
        "45".to_string(),
        "--out".to_string(),
        "reports".to_string(),
    ]
    .to_vec();
    let config = parse_eval_args(&args).expect("full args");
    assert_eq!(config.model, "provider/model-x");
    assert_eq!(
        config.factories,
        vec![
            ReferenceFactoryKind::Builder,
            ReferenceFactoryKind::PrManager
        ]
    );
    assert_eq!(config.width, MAX_WIDTH, "the width clamps");
    assert_eq!(config.trials, 3);
    assert_eq!(config.timeout_minutes, 45);
    assert_eq!(config.out_dir, "reports");

    assert!(
        matches!(parse_eval_args(&["--width".to_string(), "1".to_string()]), Err(EvalArgsError::Message(message)) if message.contains("integer >= 2"))
    );
    assert!(matches!(
        parse_eval_args(&["--help".to_string()]),
        Err(EvalArgsError::Help)
    ));
    assert!(matches!(
        parse_eval_args(&["-h".to_string()]),
        Err(EvalArgsError::Help)
    ));
}

#[test]
fn rejects_huge_and_non_integer_trial_counts_before_any_token_is_spent() {
    // The TS-era float spellings (1e100, 1.5) fail the integer parse.
    for bad in [
        "1e100",
        "1.5",
        "-1",
        "0",
        "abc",
        "99999999999999999999999999",
    ] {
        let result = parse_eval_args(&["--trials".to_string(), bad.to_string()]);
        assert!(
            matches!(&result, Err(EvalArgsError::Message(message)) if message.contains("positive integer")),
            "--trials {bad} must fail the parse: {result:?}"
        );
    }
    for bad in ["1e100", "0", "-3", "2.5"] {
        let result = parse_eval_args(&["--timeout-minutes".to_string(), bad.to_string()]);
        assert!(
            matches!(&result, Err(EvalArgsError::Message(message)) if message.contains("positive integer"))
        );
    }
    // A trailing flag without a value is incomplete, not omitted.
    assert!(
        matches!(parse_eval_args(&["--trials".to_string()]), Err(EvalArgsError::Message(message)) if message.contains("Missing value for --trials"))
    );
}

#[test]
fn rejects_an_empty_factories_selection_instead_of_running_the_defaults() {
    // The accepted review fix: `--factories ""` (or "," only) used to
    // silently run the token-spending defaults.
    for bad in ["", "  ", ","] {
        let result = parse_eval_args(&["--factories".to_string(), bad.to_string()]);
        assert!(
            matches!(&result, Err(EvalArgsError::Message(message)) if message.contains("at least one factory name")),
            "--factories {bad:?} must fail: {result:?}"
        );
    }
}

#[test]
fn rejects_the_probe_kinds_as_factories_selections() {
    // The probes run automatically once per sweep and have no baseline
    // arm; selecting one would panic the baseline build, so the flag
    // rejects them with the selections list.
    for probe in ["review-sweep-fail", "dry-run-reject"] {
        let result = parse_eval_args(&["--factories".to_string(), probe.to_string()]);
        assert!(
            matches!(&result, Err(EvalArgsError::Message(message)) if message.contains("is a probe, not a selectable factory")),
            "--factories {probe} must be rejected as a probe: {result:?}"
        );
    }
}

#[test]
fn rejects_an_unknown_factory_before_any_token_is_spent() {
    let result = parse_eval_args(&["--factories".to_string(), "review-sweep,typo".to_string()]);
    assert!(
        matches!(&result, Err(EvalArgsError::Message(message)) if message.contains("Unknown factory in --factories: typo") && message.contains("known: review-sweep, builder, resident-watcher, pr-manager")),
        "the typo must fail with the known list: {result:?}"
    );
    // Unknown arguments fail too.
    let result = parse_eval_args(&["--nonsense".to_string()]);
    assert!(
        matches!(&result, Err(EvalArgsError::Message(message)) if message.contains("Unknown argument: --nonsense"))
    );
}

#[test]
fn renders_the_markdown_table_pair_comparison_and_verdict_rules() {
    let rows = vec![
        passing_row(
            ReferenceFactoryKind::ReviewSweep,
            EvalArm::Factory,
            1,
            Some(4_000),
            0,
        ),
        FactoryEvalTrialResult::factory_row(
            &by_kind(ReferenceFactoryKind::ReviewSweepFail),
            1,
            "test/model",
            &TaskCheckOutcome {
                ok: true,
                problems: vec![],
            },
            vec![],
            None,
            Some(escalation_ledger()),
            Some(&check_replay_ledger(&escalation_ledger())),
            12_000,
            Some(4_000),
            Some(9_000),
        ),
        FactoryEvalTrialResult::baseline_row(
            &by_kind(ReferenceFactoryKind::ReviewSweep),
            1,
            "test/model",
            &TaskCheckOutcome {
                ok: false,
                problems: vec!["planted issue AUDIT-A1 missing from the ANSWER line".to_string()],
            },
            vec![],
            None,
            12_000,
            Some(9_000),
            Some(9_000),
        ),
    ];
    let config = FactoryEvalConfig {
        model: "test/model".to_string(),
        out_dir: "reports".to_string(),
        ..FactoryEvalConfig::default()
    };
    let markdown = render_markdown_report(&rows, &config);
    assert!(markdown.contains("# Factory capability eval report"));
    assert!(markdown.contains("- model: test/model"));
    assert!(markdown.contains("| review-sweep | factory | 1 | ok | done |"));
    assert!(markdown.contains("## Factory vs hand-written baseline (parent context tokens)"));
    assert!(markdown.contains("## Verdict rules (Notion spec, Proposed evaluation)"));
    assert!(markdown.contains("- no task-specific orchestration code in factory prompts (computed from the built prompts): PASS"));
    assert!(markdown
        .contains("- declared failure policy matches observed behavior (escalation): (PASS)"));
    assert!(markdown.contains("- no node starts after a failed dry run: (not run)"));
    assert!(markdown.contains("- total budget overshoot (factory arms only): 0 ms (PASS)"));
    assert!(markdown.contains(
        "- review-sweep/baseline/trial 1: planted issue AUDIT-A1 missing from the ANSWER line"
    ));
    // The teardown column carries this port's deviation note.
    assert!(markdown.contains("teardown latency: n/a on this port"));
}

#[test]
fn serializes_the_report_json_shape_the_replay_mode_reads_back() {
    let rows = vec![FactoryEvalTrialResult::factory_row(
        &by_kind(ReferenceFactoryKind::ReviewSweep),
        1,
        "test/model",
        &TaskCheckOutcome {
            ok: true,
            problems: vec![],
        },
        vec![],
        None,
        Some(review_sweep_ledger()),
        Some(&check_replay_ledger(&review_sweep_ledger())),
        12_000,
        Some(4_000),
        Some(9_000),
    )];
    let config = FactoryEvalConfig {
        out_dir: "reports".to_string(),
        ..FactoryEvalConfig::default()
    };
    let report: EvalReportFile = serialize_eval_report(&config, rows, "2026-01-01T00:00:00.000Z");
    assert_eq!(report.generated_at, "2026-01-01T00:00:00.000Z");
    assert_eq!(report.results.len(), 1);
    assert!(report.verdicts.no_orchestration_code);
    // The verdicts ride the report file itself (the TS-era body shape).
    let value = serde_json::to_value(&report).expect("serialize");
    assert!(value.get("verdicts").is_some());
    let replay = run_replay_checks(&value);
    assert!(replay.ok);
}

#[test]
fn an_over_budget_trial_fails_even_when_its_task_succeeded() {
    // The accepted review fix: the per-trial verdict includes the
    // zero-overshoot condition, so the live exit check and the verdicts
    // cannot disagree. The ledger is replay-clean (the sweep fixture with
    // its elapsed time pushed over budget), so the overshoot is the ONLY
    // failing condition — the mutation check (dropping the budget term
    // from the verdict) makes exactly this test pass wrongly.
    let factory = by_kind(ReferenceFactoryKind::ReviewSweep);
    let mut ledger = review_sweep_ledger();
    ledger["elapsed_ms"] = json!(RUN_BUDGET_MS + 1_000);
    let replay = check_replay_ledger(&ledger);
    assert!(
        replay.ok,
        "the fixture stays replay-clean with a bumped elapsed time: {:?}",
        replay.problems
    );
    let over = FactoryEvalTrialResult::factory_row(
        &factory,
        1,
        "test/model",
        &TaskCheckOutcome {
            ok: true,
            problems: vec![],
        },
        vec![],
        None,
        Some(ledger),
        Some(&replay),
        12_000,
        Some(4_000),
        Some(9_000),
    );
    assert_eq!(
        over.verdict,
        TrialVerdict::Fail,
        "an over-budget trial fails"
    );
    assert_eq!(over.budget_overshoot_ms, 1_000);
}

#[test]
fn a_thrown_trial_stays_in_the_sweep_as_its_own_failed_row() {
    // The accepted review fix: a thrown trial is logged and counted,
    // never swallowed — the report can never cover a subset of the
    // planned trials.
    let factory = by_kind(ReferenceFactoryKind::PrManager);
    let row = FactoryEvalTrialResult::error_row(
        &factory,
        EvalArm::Factory,
        1,
        "test/model",
        "prompt timed out after 600000 ms",
        604_000,
    );
    assert_eq!(row.verdict, TrialVerdict::Fail);
    assert_eq!(row.factory, "pr-manager");
    assert_eq!(
        row.problems,
        vec!["trial error: prompt timed out after 600000 ms".to_string()]
    );
    // The errored row stays a factory arm in the sweep (its zero overshoot
    // rides the sum like the TS-era harness folded it), but the pair it
    // belongs to reports both_correct false.
    let verdicts = compute_verdicts(&[row], None);
    assert_eq!(verdicts.budget_overshoot_ms, 0);
    let pair = verdicts
        .context_pairs
        .iter()
        .find(|pair| pair.factory == "pr-manager")
        .expect("the errored trial's pair stays in the report");
    assert!(
        !pair.both_correct,
        "the errored trial's task is not correct"
    );
}

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::{compile, convert_spec, load_machine_dir, MachineMeta};

const MACHINE: &str = r#"format = 1
name = "review-loop"
version = 2
description = "Plan, judge twice, and route"

[params]
task = { type = "text" }
max_loc = { type = "int", default = 400 }

[run]
budget = "2h"
max_parallel = 3

[roles]
judge = { model = "prime-inference/anthropic/claude-opus-5.5", thinking = "max" }

[types.finding]
severity = "enum(blocker, nit)"
at = "text"

[types.verdict]
decision = "enum(approve, rework)"
findings = "list[finding]"

[states.design]
entry = true
agent = { prompt = "prompts/design.md", model = "m/builder" }
inputs = { rework = "triage.rework?" }
outputs = { plan = "text" }
max_entries = 3
next = ["review-a", "review-b"]

[states.review-a]
agent = { role = "judge", prompt = "prompts/review.md", rubric = "rubrics/quality.toml", name = "judge-a" }
inputs = { plan = "design.plan" }
outputs = { verdict = "verdict" }
next = "triage"

[states.review-b]
agent = { role = "judge", prompt = "prompts/review.md", name = "judge-b" }
inputs = { plan = "design.plan" }
outputs = { verdict = "verdict" }
next = "triage"

[states.triage]
kind = "python"
run = "nodes/triage.py:decide"
join = ["review-a", "review-b"]
inputs = { a = "review-a.verdict", b = "review-b.verdict" }
outputs = { action = "enum(ship, rework)", rework = "list[finding]" }
route = { on = "action", ship = "ship", rework = "design" }

[states.ship]
agent = { prompt = "prompts/ship.md" }
inputs = { plan = "design.plan" }
outputs = { url = "text" }
"#;

const FILES: &[(&str, &str)] = &[
    ("prompts/_context.md", "Task: {{task}}\n"),
    ("prompts/design.md", "Write a plan under {{max_loc}} lines.\n\nRework: {{rework}}\n"),
    ("prompts/review.md", "Review this plan:\n\n{{plan}}\n"),
    ("prompts/ship.md", "Ship {{plan}}.\n"),
    (
        "rubrics/quality.toml",
        "[[rule]]\nid = \"tests.unpinned\"\ncheck = \"Does a test fail without the fix?\"\ndefault = \"blocker\"\n",
    ),
    ("nodes/triage.py", "def decide(inputs):\n    return {\"action\": \"ship\", \"rework\": []}\n"),
];

/// Text replacements, or (path, content) files.
type Edits<'a> = &'a [(&'a str, &'a str)];

fn write_dir(root: &Path, machine: &str, files: &[(&str, &str)]) {
    std::fs::write(root.join("machine.toml"), machine).unwrap();
    for (path, content) in files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
    }
}

/// Load the base machine with `edits` applied to machine.toml and
/// `extra` files written over the base ones; return the diagnostics.
fn problems(edits: &[(&str, &str)], extra: &[(&str, &str)]) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let mut machine = MACHINE.to_string();
    for (old, new) in edits {
        assert!(machine.contains(old), "the base machine has no {old:?}");
        machine = machine.replacen(old, new, 1);
    }
    write_dir(dir.path(), &machine, FILES);
    write_dir(dir.path(), &machine, extra);
    match load_machine_dir(dir.path()) {
        Ok(_) => Vec::new(),
        Err(found) => found.iter().map(ToString::to_string).collect(),
    }
}

const VERDICT_PORTS: &str = "- `verdict`: a verdict\n\nA verdict is an object with these fields:\n  - `decision`: one of approve | rework\n  - `findings`: a list of finding objects\n\nA finding is an object with these fields:\n  - `severity`: one of blocker | nit\n  - `at`: text\n";

/// The generated Outputs section for an `emit(<call>)` with `ports` lines.
fn outputs(call: &str, ports: &str) -> String {
    format!(
        "## Outputs\n\nBefore you finish, hand back your outputs from your Python REPL:\n\n    await rlm.factory.emit({call})\n\n{ports}\nThe call checks every value and raises with the exact field when one is wrong; fix it and call again. Each call sets the outputs it names, and a later call replaces them. A file output takes a path, and the file is copied when you emit it. Your inputs, as typed values, are `await rlm.factory.inputs()`."
    )
}

fn finding_record() -> Value {
    json!([["severity", "enum(blocker, nit)"], ["at", "text"]])
}

#[test]
fn compiles_the_base_machine_to_the_executor_spec() {
    let dir = tempfile::tempdir().unwrap();
    write_dir(dir.path(), MACHINE, FILES);
    let machine = load_machine_dir(dir.path()).unwrap();
    let mut params = Map::new();
    params.insert("task".to_string(), json!("fix the retry loop"));
    let spec = compile(&machine, &params).unwrap();
    let nodes = std::path::absolute(dir.path().join("nodes")).unwrap();
    let rubric = "## Rubric\n\nJudge against these rules. Each finding names the rule it falls under and carries that rule's severity unless the evidence argues for another.\n\n- `tests.unpinned` (blocker): Does a test fail without the fix?";
    let expected = json!({
        "run": {"budget_ms": 7_200_000, "max_parallel": 3},
        "params": {"task": "fix the retry loop", "max_loc": 400},
        "states": [
            {
                "id": "design", "entry": true,
                "subagent": {
                    "prompt": format!("Task: {{task}}\n\nWrite a plan under {{max_loc}} lines.\n\nRework: {{rework}}\n\n{}", outputs("plan=...", "- `plan`: text\n")),
                    "model": "m/builder",
                },
                "inputs": [{"name": "rework", "type": "json", "from": "triage.rework", "optional": true}],
                "outputs": [{"name": "plan", "type": "text"}],
                "emit": {"outputs": [{"name": "plan", "type": "text"}], "records": {}},
                "max_entries": 3,
            },
            {
                "id": "review-a",
                "subagent": {
                    "prompt": format!("Task: {{task}}\n\nReview this plan:\n\n{{plan}}\n\n{rubric}\n\n{}", outputs("verdict=...", VERDICT_PORTS)),
                    "name": "judge-a",
                    "model": "prime-inference/anthropic/claude-opus-5.5",
                    "thinking": "max",
                },
                "inputs": [{"name": "plan", "type": "text", "from": "design.plan"}],
                "outputs": [{"name": "verdict", "type": "json"}],
                "emit": {"outputs": [{"name": "verdict", "type": "verdict"}], "records": {"finding": finding_record(), "verdict": [["decision", "enum(approve, rework)"], ["findings", "list[finding]"]]}},
            },
            {
                "id": "review-b",
                "subagent": {
                    "prompt": format!("Task: {{task}}\n\nReview this plan:\n\n{{plan}}\n\n{}", outputs("verdict=...", VERDICT_PORTS)),
                    "name": "judge-b",
                    "model": "prime-inference/anthropic/claude-opus-5.5",
                    "thinking": "max",
                },
                "inputs": [{"name": "plan", "type": "text", "from": "design.plan"}],
                "outputs": [{"name": "verdict", "type": "json"}],
                "emit": {"outputs": [{"name": "verdict", "type": "verdict"}], "records": {"finding": finding_record(), "verdict": [["decision", "enum(approve, rework)"], ["findings", "list[finding]"]]}},
            },
            {
                "id": "triage",
                "python": {"import": "triage", "callable": "decide", "path": nodes.to_string_lossy()},
                "inputs": [
                    {"name": "a", "type": "json", "from": "review-a.verdict"},
                    {"name": "b", "type": "json", "from": "review-b.verdict"},
                ],
                "outputs": [{"name": "action", "type": "json"}, {"name": "rework", "type": "json"}],
                "emit": {"outputs": [{"name": "action", "type": "enum(ship, rework)"}, {"name": "rework", "type": "list[finding]"}], "records": {"finding": finding_record()}},
            },
            {
                "id": "ship",
                "subagent": {"prompt": format!("Task: {{task}}\n\nShip {{plan}}.\n\n{}", outputs("url=...", "- `url`: text\n"))},
                "inputs": [{"name": "plan", "type": "text", "from": "design.plan"}],
                "outputs": [{"name": "url", "type": "text"}],
                "emit": {"outputs": [{"name": "url", "type": "text"}], "records": {}},
            },
        ],
        "transitions": [
            {"from": "design", "to": "review-a"},
            {"from": "design", "to": "review-b"},
            {"from": "triage", "to": "ship", "when": {"output": "action", "op": "eq", "value": "ship"}},
            {"from": "triage", "to": "design", "when": {"output": "action", "op": "eq", "value": "rework"}},
            {"from": ["review-a", "review-b"], "to": "triage"},
        ],
    });
    assert_eq!(spec, expected);
}

/// A state with inputs and no outputs still carries an (empty) emit
/// contract: the contract is what gives its child `factory.inputs`.
#[test]
fn a_state_without_outputs_still_carries_an_emit_contract() {
    let dir = tempfile::tempdir().unwrap();
    write_dir(
        dir.path(),
        &MACHINE.replacen("outputs = { url = \"text\" }\n", "", 1),
        FILES,
    );
    let machine = load_machine_dir(dir.path()).unwrap();
    let mut params = Map::new();
    params.insert("task".to_string(), json!("fix the retry loop"));
    let spec = compile(&machine, &params).unwrap();
    let ship = &spec["states"][4];
    assert_eq!(ship["id"], "ship");
    assert_eq!(ship["emit"], json!({"outputs": [], "records": {}}));
    assert!(
        ship["subagent"]["prompt"].as_str().unwrap().ends_with(
            "## Inputs\n\nYour inputs, as typed values, are `await rlm.factory.inputs()`."
        ),
        "the no-output state's prompt must name factory.inputs: {}",
        ship["subagent"]["prompt"]
    );
}

/// A top-level `file` output still loads, and its emit contract keeps the
/// `file` type that `factory.emit` checks and copies.
#[test]
fn a_top_level_file_output_still_loads() {
    let dir = tempfile::tempdir().unwrap();
    write_dir(
        dir.path(),
        &MACHINE.replacen(
            "outputs = { url = \"text\" }",
            "outputs = { url = \"file\" }",
            1,
        ),
        FILES,
    );
    let machine = load_machine_dir(dir.path()).unwrap();
    let mut params = Map::new();
    params.insert("task".to_string(), json!("fix the retry loop"));
    let spec = compile(&machine, &params).unwrap();
    assert_eq!(
        spec["states"][4]["emit"],
        json!({"outputs": [{"name": "url", "type": "file"}], "records": {}})
    );
}

/// A python state has no `factory.emit`, so a top-level `file` output
/// would reach a later state as the child's own path. The loader refuses
/// it; an agent state's emit is the only path that copies a file.
#[test]
fn a_python_state_cannot_declare_a_file_output() {
    let dir = tempfile::tempdir().unwrap();
    write_dir(
        dir.path(),
        &MACHINE.replacen(
            "outputs = { action = \"enum(ship, rework)\", rework = \"list[finding]\" }",
            "outputs = { action = \"enum(ship, rework)\", rework = \"list[finding]\", report = \"file\" }",
            1,
        ),
        FILES,
    );
    let errors: Vec<String> = load_machine_dir(dir.path())
        .unwrap_err()
        .iter()
        .map(ToString::to_string)
        .collect();
    assert_eq!(
        errors,
        vec![
            "machine.toml: states.triage.outputs.report: a python state cannot return a file output; a file port needs an agent state's `rlm.factory.emit`, which copies it beside the session".to_string()
        ]
    );
}

#[test]
#[expect(clippy::too_many_lines, reason = "one row per load error")]
fn every_load_error_names_its_place() {
    let cases: &[(Edits, Edits, &str)] = &[
        (
            &[("format = 1", "format = 2")],
            &[],
            "machine.toml: format: format 2 is newer than this Prime Agent reads",
        ),
        (
            &[("format = 1\n", "")],
            &[],
            "machine.toml: format: missing",
        ),
        (
            &[(
                "next = \"triage\"\n\n[states.review-b]",
                "nxt = \"triage\"\n\n[states.review-b]",
            )],
            &[],
            "unknown field `nxt`",
        ),
        (
            &[(
                "outputs = { url = \"text\" }",
                "outputs = { from = \"text\" }",
            )],
            &[],
            "outputs.from: output names are lowercase identifiers (a-z, 0-9, _) and not Python keywords",
        ),
        (
            &[(
                "outputs = { url = \"text\" }",
                "outputs = { url = \"Text\" }",
            )],
            &[],
            "states.ship.outputs.url: \"Text\" is not a type",
        ),
        (
            &[(
                "outputs = { url = \"text\" }",
                "outputs = { url = \"receipt\" }",
            )],
            &[],
            "states.ship.outputs.url: unknown type \"receipt\"",
        ),
        (
            &[(
                "role = \"judge\", prompt = \"prompts/review.md\", name = \"judge-b\"",
                "role = \"jduge\", prompt = \"prompts/review.md\", name = \"judge-b\"",
            )],
            &[],
            "states.review-b.agent.role: unknown role \"jduge\" (declared: judge)",
        ),
        (
            &[("prompts/ship.md", "prompts/missing.md")],
            &[],
            "states.ship.agent.prompt: cannot read prompts/missing.md",
        ),
        (
            &[("prompts/ship.md", "../ship.md")],
            &[],
            "\"../ship.md\" must be a relative path inside the machine directory",
        ),
        (
            &[("triage.py:decide", "triage.py:choose")],
            &[],
            "nodes/triage.py: no top-level def choose(...)",
        ),
        (
            &[("a = \"review-a.verdict\"", "a = \"review-a.verdikt\"")],
            &[],
            "states.triage.inputs.a: review-a has no output \"verdikt\" (it has: verdict)",
        ),
        (
            &[("a = \"review-a.verdict\"", "a = \"review-c.verdict\"")],
            &[],
            "states.triage.inputs.a: \"review-c.verdict\" names no state",
        ),
        (
            &[("rework = \"triage.rework?\"", "rework = \"triage.rework\"")],
            &[],
            "states.design.inputs.rework: an entry state's inputs must be optional",
        ),
        (
            &[(", rework = \"design\" }", " }")],
            &[],
            "states.triage.route: no route for rework",
        ),
        (
            &[(
                ", rework = \"design\" }",
                ", rework = \"design\", hold = \"ship\" }",
            )],
            &[],
            "states.triage.route.hold: \"hold\" is not a value of action",
        ),
        (
            &[("route = { on = \"action\"", "route = { on = \"rework\"")],
            &[],
            "a route switches on an enum or bool, not a list of finding objects",
        ),
        (
            &[(
                "next = \"triage\"\n\n[states.triage]",
                "next = \"ship\"\n\n[states.triage]",
            )],
            &[],
            "states.triage.join: review-b must name triage in its next",
        ),
        (
            &[(
                "join = [\"review-a\", \"review-b\"]",
                "join = [\"review-a\"]",
            )],
            &[],
            "states.review-b.next: triage joins review-a; add review-b to its join list",
        ),
        (
            &[(
                "next = [\"review-a\", \"review-b\"]",
                "next = [\"review-a\"]",
            )],
            &[],
            "states.review-b: unreachable",
        ),
        (
            &[],
            &[("prompts/ship.md", "Ship {{plann}}.\n")],
            "prompts/ship.md: states.ship: {{plann}} is neither a param nor an input of this state",
        ),
        (
            &[],
            &[("prompts/ship.md", "Ship {plan}.\n")],
            "prompts/ship.md: states.ship: {plan} has single braces; write {{plan}}",
        ),
        (
            &[("entry = true\n", "")],
            &[],
            "machine.toml: states: no entry state",
        ),
        (
            &[("budget = \"2h\"", "budget = \"2 hours\"")],
            &[],
            "machine.toml: run.budget: \"2 hours\" is not a duration",
        ),
        (
            &[],
            &[(
                "rubrics/quality.toml",
                "[[rule]]\nid = \"a\"\ncheck = \"b\"\ndefault = \"high\"\n",
            )],
            "rubrics/quality.toml: rule[0].default: \"high\" is not a severity",
        ),
        (
            &[],
            &[(
                "rubrics/quality.toml",
                "[[rule]]\nid = \"a\"\ncheck = \"Does {{nope}} hold?\"\ndefault = \"blocker\"\n",
            )],
            "rubrics/quality.toml: states.review-a: {{nope}} is neither a param nor an input of this state",
        ),
        (
            &[("name = \"judge-b\"", "name = \"judge-a\"")],
            &[],
            "states.review-b.agent.name: \"judge-a\" already labels state \"review-a\"",
        ),
        (
            &[(
                "outputs = { url = \"text\" }",
                "outputs = { url = \"text?\" }",
            )],
            &[],
            "optional outputs are not supported yet",
        ),
        (
            &[(
                "outputs = { url = \"text\" }",
                "outputs = { url = \"list[file]\" }",
            )],
            &[],
            "machine.toml: states.ship.outputs.url: file ports inside a list or a record are not supported yet (url[])",
        ),
        (
            &[("at = \"text\"", "at = \"file\"")],
            &[],
            "machine.toml: states.review-a.outputs.verdict: file ports inside a list or a record are not supported yet (verdict.findings[].at)",
        ),
        (
            &[(
                "max_entries = 3\nnext",
                "max_entries = 3\nbudget = \"3h\"\nnext",
            )],
            &[],
            "states.design.budget: exceeds the run budget",
        ),
        (
            &[("default = 400", "default = \"400\"")],
            &[],
            "params.max_loc.default: expected an integer, got string \"400\"",
        ),
        (
            &[(
                "outputs = { url = \"text\" }",
                "outputs = { url = \"text\" }\nroute = { on = \"url\" }\nnext = \"design\"",
            )],
            &[],
            "a route needs at least one",
        ),
        (
            &[("at = \"text\"", "at = \"text\"\nnested = \"finding?\"")],
            &[],
            "types.finding: a record cannot contain itself",
        ),
    ];
    for (edits, extra, expected) in cases {
        let found = problems(edits, extra);
        assert!(
            found.iter().any(|problem| problem.contains(expected)),
            "expected {expected:?} in {found:#?}"
        );
    }
}

#[test]
fn a_template_binds_no_params() {
    let dir = tempfile::tempdir().unwrap();
    write_dir(dir.path(), MACHINE, FILES);
    let machine = load_machine_dir(dir.path()).unwrap();
    let template = crate::compile_template(&machine).unwrap();
    let mut params = Map::new();
    params.insert("task".to_string(), json!("t"));
    let mut bound = compile(&machine, &params).unwrap();
    bound.as_object_mut().unwrap().remove("params");
    assert_eq!(template, bound);
}

#[test]
fn compile_checks_params() {
    let dir = tempfile::tempdir().unwrap();
    write_dir(dir.path(), MACHINE, FILES);
    let machine = load_machine_dir(dir.path()).unwrap();
    let render = |params: Value| -> Vec<String> {
        let Value::Object(params) = params else {
            unreachable!()
        };
        compile(&machine, &params)
            .unwrap_err()
            .iter()
            .map(ToString::to_string)
            .collect()
    };
    assert_eq!(
        render(json!({})),
        ["machine.toml: params.task: required: pass it when the live machine starts (task=text)"]
    );
    assert_eq!(
        render(json!({"task": "t", "max_loc": "lots", "tsak": "t"})),
        [
            "machine.toml: params: unknown param \"tsak\" (declared: task, max_loc)",
            "machine.toml: params.max_loc: expected an integer, got string \"lots\"",
        ]
    );
}

fn bundled_seed(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../prime-agent-runtime/src/rlm/machines")
        .join(name)
        .join("MACHINE.md");
    let text = std::fs::read_to_string(path).unwrap();
    let start = text.find("```machine-spec").unwrap() + "```machine-spec".len();
    let end = start + text[start..].find("\n```").unwrap();
    serde_json::from_str(&text[start..end]).unwrap()
}

fn meta(name: &str) -> MachineMeta {
    MachineMeta {
        name: name.to_string(),
        description: "a bundled seed".to_string(),
        version: 1,
        author: None,
    }
}

/// The compiled spec with each prompt replaced by whether it starts with
/// the seed's own prompt.
fn structure(spec: &Value, seed_prompts: &[&str]) -> Value {
    let mut spec = spec.clone();
    for (state, original) in spec["states"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(seed_prompts)
    {
        let prompt = state["subagent"]["prompt"].as_str().unwrap();
        state["subagent"]["prompt"] = json!(prompt.starts_with(original.trim_end()));
    }
    spec
}

#[test]
fn guard_free_bundled_seeds_convert_and_compile_to_the_same_machine() {
    let seed = bundled_seed("builder");
    let files = convert_spec(&seed, &meta("builder")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for file in &files {
        write_dir(
            dir.path(),
            &files[0].content,
            &[(file.path.as_str(), file.content.as_str())],
        );
    }
    let machine = load_machine_dir(dir.path()).unwrap();
    let spec = compile(&machine, &Map::new()).unwrap();
    let prompts: Vec<&str> = seed["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["subagent"]["prompt"].as_str().unwrap())
        .collect();
    assert_eq!(
        structure(&spec, &prompts),
        json!({
            "run": {"budget_ms": 900_000, "max_parallel": 8, "failure_policy": "escalate"},
            "states": [
                {"id": "scope", "entry": true, "subagent": {"prompt": true, "name": "builder-scope"},
                 "outputs": [{"name": "outline", "type": "json"}],
                 "emit": {"outputs": [{"name": "outline", "type": "json"}], "records": {}}, "budget_ms": 240_000},
                {"id": "notes", "subagent": {"prompt": true, "name": "builder-notes"},
                 "inputs": [{"name": "outline", "type": "json", "from": "scope.outline"}],
                 "outputs": [{"name": "section", "type": "text"}],
                 "emit": {"outputs": [{"name": "section", "type": "text"}], "records": {}}, "budget_ms": 240_000,
                 "foreach": {"over": "outline", "max": 8}},
                {"id": "collect", "subagent": {"prompt": true, "name": "build-collector"},
                 "inputs": [{"name": "sections", "type": "text", "from": "notes.section"}],
                 "outputs": [{"name": "merged", "type": "text"}],
                 "emit": {"outputs": [{"name": "merged", "type": "text"}], "records": {}}, "budget_ms": 240_000},
            ],
            "transitions": [{"from": "scope", "to": "notes"}, {"from": "notes", "to": "collect"}],
        })
    );
    let review_sweep = convert_spec(&bundled_seed("review-sweep"), &meta("review-sweep")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for file in &review_sweep {
        write_dir(
            dir.path(),
            &review_sweep[0].content,
            &[(file.path.as_str(), file.content.as_str())],
        );
    }
    load_machine_dir(dir.path()).unwrap();
}

#[test]
fn unknown_subagent_keys_are_refused_not_dropped() {
    let spec = json!({"states": [{"id": "a", "entry": true, "subagent": {"prompt": "P.", "reply": {"fenced_json": true}}}]});
    assert_eq!(
        convert_spec(&spec, &meta("a")).unwrap_err(),
        ["state a: the subagent key \"reply\" has no machine.toml form (an agent takes prompt, model, thinking, name)"]
    );
}

#[test]
fn a_state_id_that_is_not_a_file_name_is_refused_before_writing() {
    let spec =
        json!({"states": [{"id": "../../victim", "entry": true, "subagent": {"prompt": "P."}}]});
    assert_eq!(
        convert_spec(&spec, &meta("a")).unwrap_err(),
        ["\"../../victim\" is not a state id: lowercase letters, digits and -, at most 64 characters"]
    );
}

#[test]
fn a_null_guard_is_an_unguarded_transition_and_two_joins_to_one_state_are_refused() {
    let state = |id: &str, entry: bool| json!({"id": id, "entry": entry, "subagent": {"prompt": "P."}});
    let null_guard = json!({
        "states": [state("a", true), state("b", false)],
        "transitions": [{"from": "a", "to": "b", "when": null}],
    });
    assert!(convert_spec(&null_guard, &meta("a")).is_ok());
    let two_joins = json!({
        "states": [state("a", true), state("b", true), state("c", true), state("d", false)],
        "transitions": [{"from": ["a", "b"], "to": "d"}, {"from": ["b", "c"], "to": "d"}],
    });
    assert_eq!(
        convert_spec(&two_joins, &meta("a")).unwrap_err(),
        ["more than one join ends at state \"d\", which machine.toml cannot express"]
    );
}

#[test]
fn params_are_refused_not_dropped() {
    let spec = json!({"params": {"task": "ship it"}, "states": [{"id": "a", "entry": true, "subagent": {"prompt": "Do {task}."}}]});
    assert_eq!(
        convert_spec(&spec, &meta("a")).unwrap_err(),
        ["params have no converted form yet: declare each under [params] in machine.toml and write {{name}} where a prompt uses it"]
    );
}

#[test]
fn guards_are_refused_with_the_guard_spelled_out() {
    let errors = convert_spec(&bundled_seed("pr-manager"), &meta("pr-manager")).unwrap_err();
    assert_eq!(
        errors,
        [
            "the guarded transition \"reviewing\" -> fixing (when {\"output\":\"verdict\",\"path\":\"approved\",\"op\":\"eq\",\"value\":false}) has no machine.toml form: switch on an enum output with route, or compute the choice in a python state",
            "the guarded transition \"reviewing\" -> monitoring (when {\"output\":\"verdict\",\"path\":\"approved\",\"op\":\"eq\",\"value\":true}) has no machine.toml form: switch on an enum output with route, or compute the choice in a python state",
        ]
    );
}

/// A relative in-dir path that leaves the machine dir through a symlink is
/// refused before any text is read (the opus F-10 probe: a
/// `prompts/a.md -> /tmp/secret` handed the machine outside content, into
/// a child prompt and the factory page's files).
#[test]
#[cfg(unix)]
fn a_symlink_pointing_outside_the_dir_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().with_extension("secret");
    std::fs::write(&outside, "SECRET-OUTSIDE-THE-MACHINE-DIR {task}").unwrap();
    write_dir(dir.path(), MACHINE, FILES);
    let symlink = dir.path().join("prompts/design.md");
    std::fs::remove_file(&symlink).unwrap();
    std::os::unix::fs::symlink(&outside, &symlink).unwrap();
    match load_machine_dir(dir.path()) {
        Ok(_) => panic!("a symlink pointing outside the machine dir loaded"),
        Err(found) => {
            let lines: Vec<String> = found.iter().map(ToString::to_string).collect();
            assert!(
                lines
                    .iter()
                    .any(|line| line.contains("escapes the machine directory")),
                "the symlink must name its escape: {lines:?}"
            );
            for line in &lines {
                assert!(
                    !line.contains("SECRET-OUTSIDE"),
                    "the outside content must never be read: {line:?}"
                );
            }
        }
    }
}

/// The guard does not regress the missing-file report: a machine naming a
/// nonexistent file still reports the file, not a silent drop.
#[test]
fn a_missing_file_still_reports_its_own_diagnostic() {
    let lines = problems(
        &[(
            "prompt = \"prompts/design.md\"",
            "prompt = \"prompts/missing.md\"",
        )],
        &[],
    );
    assert!(
        lines.iter().any(|line| line.contains("prompts/missing.md")),
        "the missing file must be named: {lines:?}"
    );
}

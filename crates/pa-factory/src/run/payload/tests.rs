use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::*;

/// A canonical spec: a design state, a review state with three outputs, a
/// resident helper, and a fix state that reads the review.
fn spec(fix_inputs: Value, fix_foreach: Option<Value>) -> Value {
    let mut fix = json!({"id": "fix"});
    fix["inputs"] = fix_inputs;
    if let Some(foreach) = fix_foreach {
        fix["foreach"] = foreach;
    }
    json!({
        "states": [
            {"id": "design", "entry": true, "outputs": [{"name": "plan", "type": "text"}]},
            {"id": "review", "outputs": [
                {"name": "verdict", "type": "json"},
                {"name": "notes", "type": "text"},
                {"name": "findings", "type": "json"},
            ]},
            {"id": "helper", "lifecycle": "resident", "outputs": [{"name": "hint", "type": "text"}]},
            fix,
        ],
        "transitions": [],
    })
}

fn input(name: &str, ty: &str, from: &str) -> Value {
    json!({"name": name, "type": ty, "from": from})
}

fn optional(name: &str, ty: &str, from: &str) -> Value {
    json!({"name": name, "type": ty, "from": from, "optional": true})
}

fn plan(inputs: Value) -> PayloadPlan {
    plan_payloads(&spec(inputs, None), &no_assets())
        .unwrap()
        .remove("fix")
        .unwrap()
}

fn fan_plan(max: u64) -> PayloadPlan {
    plan_payloads(
        &spec(
            json!([optional("finding", "json", "review.findings")]),
            Some(json!({"over": "finding", "max": max})),
        ),
        &no_assets(),
    )
    .unwrap()
    .remove("fix")
    .unwrap()
}

fn plan_errors(inputs: Value) -> Vec<PlanError> {
    plan_payloads(&spec(inputs, None), &no_assets()).unwrap_err()
}

fn fix_error(input: &str, problem: PlanProblem) -> PlanError {
    PlanError {
        state: "fix".to_string(),
        input: input.to_string(),
        problem,
    }
}

fn done(outputs: Value) -> Settle {
    let Value::Object(outputs) = outputs else {
        panic!("outputs must be an object");
    };
    Settle::Done {
        outputs,
        output_errors: BTreeMap::new(),
    }
}

/// A cache for specs with no asset inputs; nothing reads it.
fn no_assets() -> AssetCache {
    AssetCache::new(env!("CARGO_MANIFEST_DIR"))
}

/// Bind with each source's settles and live flag.
fn bind(plan: &PayloadPlan, sources: &[(&str, &[Settle], bool)]) -> Bind {
    bind_with(plan, sources, &mut no_assets())
}

fn bind_with(
    plan: &PayloadPlan,
    sources: &[(&str, &[Settle], bool)],
    assets: &mut AssetCache,
) -> Bind {
    plan.bind(
        |state| {
            sources.iter().find(|(id, _, _)| *id == state).map_or(
                SourceView {
                    settles: &[],
                    live: false,
                },
                |(_, settles, live)| SourceView {
                    settles,
                    live: *live,
                },
            )
        },
        assets,
    )
}

fn fields(value: Value) -> Map<String, Value> {
    let Value::Object(fields) = value else {
        panic!("fields must be an object");
    };
    fields
}

fn ready(fields_value: Value) -> Bind {
    Bind::Ready(Payload {
        fields: fields(fields_value),
        fan: None,
    })
}

#[test]
fn a_plan_reads_each_binding_of_a_state() {
    let plan = plan(json!([
        input("verdict", "json", "review.verdict"),
        optional("plan", "text", "design.plan"),
    ]));
    assert_eq!(
        plan.bindings(),
        [
            Binding {
                name: "verdict".to_string(),
                ty: PortType::Json,
                from: Reference::Port(Selector::parse("review.verdict").unwrap()),
                optional: false,
            },
            Binding {
                name: "plan".to_string(),
                ty: PortType::Text,
                from: Reference::Port(Selector::parse("design.plan").unwrap()),
                optional: true,
            },
        ]
    );
}

#[test]
fn bind_copies_typed_values_into_the_payload() {
    let plan = plan(json!([
        input("verdict", "json", "review.verdict"),
        input("notes", "text", "review.notes"),
    ]));
    let review = [done(
        json!({"verdict": {"action": "ship", "score": 3}, "notes": "fine"}),
    )];
    assert_eq!(
        bind(&plan, &[("review", &review, false)]),
        ready(json!({"verdict": {"action": "ship", "score": 3}, "notes": "fine"}))
    );
}

#[test]
fn a_text_input_reads_a_json_value_as_json_text() {
    let plan = plan(json!([input("notes", "text", "review.notes")]));
    let review = [done(json!({"notes": ["a", 1]}))];
    assert_eq!(
        bind(&plan, &[("review", &review, false)]),
        ready(json!({"notes": "[\"a\",1]"}))
    );
}

#[test]
fn a_required_input_waits_for_its_source() {
    let plan = plan(json!([input("verdict", "json", "review.verdict")]));
    assert_eq!(bind(&plan, &[]), Bind::Wait);
}

#[test]
fn an_optional_input_binds_null_when_its_source_has_no_value() {
    let plan = plan(json!([
        optional("verdict", "json", "review.verdict"),
        optional("plan", "text", "design.plan"),
    ]));
    assert_eq!(
        bind(&plan, &[("design", &[Settle::Failed], false)]),
        ready(json!({"verdict": null, "plan": null}))
    );
}

#[test]
fn an_optional_input_waits_for_a_live_source() {
    let plan = plan(json!([optional("verdict", "json", "review.verdict")]));
    assert_eq!(bind(&plan, &[("review", &[], true)]), Bind::Wait);
}

#[test]
fn an_optional_self_input_binds_null_while_the_state_is_live() {
    let mut spec = spec(json!([]), None);
    spec["states"][3]["outputs"] = json!([{"name": "draft", "type": "text"}]);
    spec["states"][3]["inputs"] = json!([optional("draft", "text", "fix.draft")]);
    let plan = plan_payloads(&spec, &no_assets())
        .unwrap()
        .remove("fix")
        .unwrap();
    assert_eq!(
        bind(&plan, &[("fix", &[], true)]),
        ready(json!({"draft": null}))
    );
}

#[test]
fn a_required_input_fails_when_its_settled_source_has_no_value() {
    let plan = plan(json!([input("verdict", "json", "review.verdict")]));
    let review = [done(json!({"notes": "fine"}))];
    assert_eq!(
        bind(&plan, &[("review", &review, false)]),
        Bind::Failed(BindError {
            input: "verdict".to_string(),
            from: Reference::Port(Selector::parse("review.verdict").unwrap()),
            failure: BindFailure::Unavailable(Unavailable::NoValue),
        })
    );
}

#[test]
fn a_foreach_payload_gives_one_record_per_item_up_to_max() {
    let review = [done(json!({"findings": ["a", "b", "c"]}))];
    let Bind::Ready(payload) = bind(&fan_plan(2), &[("review", &review, false)]) else {
        panic!("expected a ready payload");
    };
    assert_eq!(
        (payload.records(), payload.dropped()),
        (
            vec![
                fields(json!({"finding": "a"})),
                fields(json!({"finding": "b"}))
            ],
            1
        )
    );
}

#[test]
fn an_optional_foreach_input_without_a_value_gives_no_records() {
    let review = [Settle::Failed];
    let Bind::Ready(payload) = bind(&fan_plan(2), &[("review", &review, false)]) else {
        panic!("expected a ready payload");
    };
    assert_eq!(payload.records(), Vec::<Map<String, Value>>::new());
}

#[test]
fn a_foreach_input_that_is_not_a_list_fails() {
    let review = [done(json!({"findings": {"a": 1}}))];
    assert_eq!(
        bind(&fan_plan(2), &[("review", &review, false)]),
        Bind::Failed(BindError {
            input: "finding".to_string(),
            from: Reference::Port(Selector::parse("review.findings").unwrap()),
            failure: BindFailure::NotAList,
        })
    );
}

#[test]
fn a_missing_port_fails_the_plan_and_names_the_port() {
    let errors = plan_errors(json!([input("score", "json", "review.score")]));
    assert_eq!(
        errors,
        [fix_error(
            "score",
            PlanProblem::MissingPort(Selector::parse("review.score").unwrap())
        )]
    );
    assert_eq!(
        errors[0].to_string(),
        "state \"fix\" input \"score\": state \"review\" does not declare output \"score\""
    );
}

#[test]
fn an_unknown_state_fails_the_plan() {
    assert_eq!(
        plan_errors(json!([input("score", "json", "judge.score")])),
        [fix_error(
            "score",
            PlanProblem::UnknownState("judge".to_string())
        )]
    );
}

#[test]
fn an_ambiguous_selector_fails_the_plan() {
    assert_eq!(
        plan_errors(json!([input("action", "json", "review.verdict.action")])),
        [fix_error(
            "action",
            PlanProblem::Selector(SelectorError::Ambiguous(
                "review.verdict.action".to_string()
            ))
        )]
    );
}

#[test]
fn a_type_mismatch_fails_the_plan() {
    assert_eq!(
        plan_errors(json!([input("verdict", "text", "review.verdict")])),
        [fix_error(
            "verdict",
            PlanProblem::TypeMismatch {
                selector: Selector::parse("review.verdict").unwrap(),
                input: PortType::Text,
                output: PortType::Json,
            }
        )]
    );
}

#[test]
fn a_resident_source_fails_the_plan() {
    assert_eq!(
        plan_errors(json!([input("hint", "text", "helper.hint")])),
        [fix_error(
            "hint",
            PlanProblem::ResidentSource("helper".to_string())
        )]
    );
}

#[test]
fn a_malformed_input_fails_the_plan() {
    assert_eq!(
        plan_errors(json!([input("verdict", "record", "review.verdict")])),
        [fix_error(
            "verdict",
            PlanProblem::Malformed("the type is not \"text\" or \"json\"".to_string())
        )]
    );
}

#[test]
fn a_duplicate_input_fails_the_plan() {
    assert_eq!(
        plan_errors(json!([
            input("verdict", "json", "review.verdict"),
            input("verdict", "json", "review.findings"),
        ])),
        [fix_error("verdict", PlanProblem::DuplicateInput)]
    );
}

#[test]
fn a_foreach_over_a_text_input_fails_the_plan() {
    let errors = plan_payloads(
        &spec(
            json!([input("notes", "text", "review.notes")]),
            Some(json!({"over": "notes", "max": 2})),
        ),
        &no_assets(),
    )
    .unwrap_err();
    assert_eq!(errors, [fix_error("notes", PlanProblem::ForeachOver)]);
}

/// A machine directory with `assets/rubric.md`, and a fix state that
/// reads it as the `rubric` input.
fn asset_spec(asset: &str) -> (tempfile::TempDir, Value) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("assets")).unwrap();
    std::fs::write(dir.path().join("assets/rubric.md"), "v1").unwrap();
    let spec = spec(json!([input("rubric", "text", asset)]), None);
    (dir, spec)
}

#[test]
fn a_missing_asset_fails_the_plan_with_its_path() {
    let (dir, spec) = asset_spec("assets/missing.md");
    assert_eq!(
        plan_payloads(&spec, &AssetCache::new(dir.path())).unwrap_err(),
        [fix_error(
            "rubric",
            PlanProblem::Asset(AssetError::Missing {
                path: "assets/missing.md".to_string(),
                dir: dir.path().to_path_buf(),
            })
        )]
    );
}

#[test]
fn an_asset_input_binds_the_asset_text() {
    let (dir, spec) = asset_spec("assets/rubric.md");
    let mut assets = AssetCache::new(dir.path());
    let plan = plan_payloads(&spec, &assets)
        .unwrap()
        .remove("fix")
        .unwrap();
    assert_eq!(
        bind_with(&plan, &[], &mut assets),
        ready(json!({"rubric": "v1"}))
    );
}

/// The plan reads nothing. The first bind reads the asset, and later
/// binds of the same run use the cached text. A new run reads it again.
#[test]
fn assets_load_lazily_and_are_cached_per_run() {
    let (dir, spec) = asset_spec("assets/rubric.md");
    let file = dir.path().join("assets/rubric.md");
    let mut assets = AssetCache::new(dir.path());
    let plan = plan_payloads(&spec, &assets)
        .unwrap()
        .remove("fix")
        .unwrap();
    std::fs::write(&file, "v2").unwrap();
    assert_eq!(
        bind_with(&plan, &[], &mut assets),
        ready(json!({"rubric": "v2"}))
    );
    std::fs::write(&file, "v3").unwrap();
    assert_eq!(
        bind_with(&plan, &[], &mut assets),
        ready(json!({"rubric": "v2"}))
    );
    assert_eq!(
        bind_with(&plan, &[], &mut AssetCache::new(dir.path())),
        ready(json!({"rubric": "v3"}))
    );
}

#[test]
fn an_asset_removed_after_the_plan_fails_the_entry() {
    let (dir, spec) = asset_spec("assets/rubric.md");
    let mut assets = AssetCache::new(dir.path());
    let plan = plan_payloads(&spec, &assets)
        .unwrap()
        .remove("fix")
        .unwrap();
    std::fs::remove_file(dir.path().join("assets/rubric.md")).unwrap();
    assert_eq!(
        bind_with(&plan, &[], &mut assets),
        Bind::Failed(BindError {
            input: "rubric".to_string(),
            from: Reference::parse("assets/rubric.md").unwrap(),
            failure: BindFailure::Asset(AssetError::Missing {
                path: "assets/rubric.md".to_string(),
                dir: dir.path().to_path_buf(),
            }),
        })
    );
}

//! Action-space, digest, and prompt-compilation battery.

use super::super::test_support as support;
use super::*;

#[test]
fn the_digest_matches_the_ts_fnv1a_over_utf16_code_units() {
    // Parity vector computed with the TS algorithm (`charCodeAt` code units,
    // 32-bit fnv1a, 8 lowercase hex chars) over the canonicalized material.
    assert_eq!(
        observation_digest(&support::observation("hello")),
        "227ae8aa"
    );
    assert_eq!(
        observation_digest(&support::observation("\u{1F642}")),
        "bdffb513"
    );
}

#[test]
fn the_digest_is_stable_and_canonicalizes_nested_key_order() {
    let first = observation_digest(&support::observation("step"));
    assert_eq!(first, observation_digest(&support::observation("step")));
    assert_eq!(first.len(), 8);
    assert!(first.chars().all(|character| character.is_ascii_hexdigit()));

    let mut left = support::observation("state");
    left.fields
        .insert("digest".to_string(), serde_json::json!({ "b": 1, "a": 2 }));
    let mut right = support::observation("state");
    right
        .fields
        .insert("digest".to_string(), serde_json::json!({ "a": 2, "b": 1 }));
    assert_eq!(
        observation_digest(&left),
        observation_digest(&right),
        "nested objects hash key-sorted"
    );

    assert_ne!(
        observation_digest(&support::observation("a")),
        observation_digest(&support::observation("b"))
    );
    let mut with_fields = support::observation("a");
    with_fields
        .fields
        .insert("hp".to_string(), serde_json::json!(3));
    assert_ne!(
        observation_digest(&support::observation("a")),
        observation_digest(&with_fields)
    );
    let mut with_image = support::observation("a");
    with_image.image = Some("png".to_string());
    assert_ne!(
        observation_digest(&support::observation("a")),
        observation_digest(&with_image)
    );
}

#[test]
fn truncation_keeps_a_marker_within_the_budget() {
    assert_eq!(truncate_observation("short", 10), "short");
    let truncated = truncate_observation(&"x".repeat(100), 40);
    assert!(truncated.ends_with("<observation truncated>"));
    assert_eq!(truncated.chars().count(), 40);
    // A budget at or below the marker's own length carries just the marker
    // (the TS slice clamps at zero).
    let marker = "\n<observation truncated>";
    assert_eq!(truncate_observation(&"x".repeat(100), 5), marker);
    assert_eq!(
        truncate_observation(&"x".repeat(100), marker.chars().count()),
        marker
    );
}

#[test]
fn gates_follow_the_action_risk_and_never_gate_escalation() {
    let actions = compile_action_space(&support::sample_action_space()).unwrap();
    let gate = RouterGateSpec {
        read: Some(0.9),
        ..RouterGateSpec::default()
    };
    let look = &actions.by_name["look"];
    assert_eq!(gate_threshold(gate, look), 0.9);
    let press = &actions.by_name["press"];
    assert_eq!(gate_threshold(gate, press), 0.6, "the write default");
    assert_eq!(gate_threshold(gate, &actions.by_name[FINISH_ACTION]), 0.5);
    assert_eq!(
        gate_threshold(gate, &actions.by_name[ESCALATE_ACTION]),
        0.0,
        "the escalation door is never gated"
    );
}

#[test]
fn the_gate_label_names_the_gate_the_threshold_came_from() {
    let actions = compile_action_space(&support::sample_action_space()).unwrap();
    // `finish` is compiled with the `read` risk but gated by `gate.finish`,
    // so its refusal diagnostic must name the `finish` gate, not `read`.
    assert_eq!(gate_label(&actions.by_name[FINISH_ACTION]), "finish");
    assert_eq!(gate_label(&actions.by_name["look"]), "read");
    assert_eq!(gate_label(&actions.by_name["press"]), "write");
}

#[test]
fn the_compiled_space_appends_the_loop_owned_actions_in_order() {
    let compiled = compile_action_space(&support::sample_action_space()).unwrap();
    assert_eq!(
        compiled.action_names,
        vec!["look", "press", FINISH_ACTION, ESCALATE_ACTION]
    );
    assert_eq!(compiled.by_name[FINISH_ACTION].risk, RouterActionRisk::Read);
    assert!(compiled.by_name[ESCALATE_ACTION].params.is_empty());
}

#[test]
fn a_declared_reserved_action_name_is_refused() {
    let mut actions = support::sample_action_space();
    actions.insert(
        FINISH_ACTION.to_string(),
        RouterActionSpec {
            description: "Taken.".to_string(),
            risk: RouterActionRisk::Read,
            params: BTreeMap::new(),
        },
    );
    let error = compile_action_space(&actions).unwrap_err();
    assert!(
        error.to_string().contains("reserved for the loop itself"),
        "{error}"
    );
}

#[test]
fn history_entries_render_params_and_cap_long_results() {
    let params = BTreeMap::from([("button".to_string(), "a".to_string())]);
    assert_eq!(
        format_history_entry("press", &params, "screen advanced"),
        "press(button=\"a\") -> screen advanced"
    );
    let long = format_history_entry("press", &params, &"x".repeat(400));
    assert!(long.ends_with("..."));
    assert_eq!(
        long.chars().count(),
        "press(button=\"a\") -> ".chars().count() + 160
    );
}

#[test]
fn the_decision_prompt_carries_the_goal_observation_history_and_space() {
    let compiled = compile_action_space(&support::sample_action_space()).unwrap();
    let mut observation = support::observation("the title screen is up");
    observation
        .fields
        .insert("hp".to_string(), serde_json::json!(12));
    let prompt = compile_decision_prompt(
        "Get into the overworld.",
        &observation,
        &["press(button=\"a\") -> screen advanced".to_string()],
        &compiled,
        6_000,
    );
    assert!(prompt.contains("GOAL\nGet into the overworld."));
    assert!(prompt.contains("the title screen is up\nhp: 12"));
    assert!(prompt.contains("press(button=\"a\") -> screen advanced"));
    assert!(prompt.contains("- look [risk=read]: Look at the screen."));
    assert!(prompt.contains(
        "- press [risk=write]: Press a button.\n    param \"button\": one of \"a\" (the A button), \"b\" (the B button)"
    ));
    assert!(prompt.contains(FINISH_ACTION));
    assert!(prompt.contains(ESCALATE_ACTION));
    assert!(prompt.contains("Reply with ONE JSON object and nothing else"));
    assert!(!prompt.contains("HISTORY (oldest first)\n<no steps yet>"));

    let empty_history = compile_decision_prompt("g", &observation, &[], &compiled, 6_000);
    assert!(empty_history.contains("HISTORY (oldest first)\n<no steps yet>"));
}

#[test]
fn the_observation_budget_bounds_text_and_fields_together() {
    let compiled = compile_action_space(&support::sample_action_space()).unwrap();
    let mut observation = support::observation(&"s".repeat(1_000));
    for index in 0..20 {
        observation
            .fields
            .insert(format!("field_{index:02}"), serde_json::json!("value"));
    }
    let prompt = compile_decision_prompt("g", &observation, &[], &compiled, 200);
    assert!(prompt.contains("<observation truncated>"));
    assert!(prompt.contains("more fields truncated>"));
    assert!(prompt.contains("field_00"));
    assert!(
        !prompt.contains("field_19"),
        "the tail of the field list is dropped"
    );

    // A budget large enough for everything carries no truncation marker.
    let prompt = compile_decision_prompt("g", &observation, &[], &compiled, 32_000);
    assert!(prompt.contains("field_19"));
    assert!(!prompt.contains("more fields truncated>"));
}

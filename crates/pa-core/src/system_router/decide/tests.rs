//! Decision-parsing battery: strict single-choice extraction from model
//! replies.

use std::collections::HashMap;

use pa_types::ai::{Model, ModelThinkingLevel};

use super::super::action_space::{compile_action_space, CompiledAction};
use super::super::test_support as support;
use super::super::types::{RouterActionParamSpec, RouterActionRisk, RouterActionSpec};
use super::*;

fn space() -> HashMap<String, CompiledAction> {
    compile_action_space(&support::sample_action_space())
        .unwrap()
        .by_name
}

fn parse(raw: &str) -> RouterDecisionOutcome {
    parse_decision(raw, &space())
}

#[test]
fn a_clean_single_choice_parses() {
    let outcome = parse(r#"{"action": "press", "params": {"button": "a"}, "confidence": 0.8}"#);
    assert_eq!(outcome.action.as_deref(), Some("press"));
    assert_eq!(outcome.params["button"], "a");
    assert_eq!(outcome.confidence, Some(0.8));
    assert!(outcome.parse_error.is_none());
}

#[test]
fn only_listed_actions_and_parameter_values_pass() {
    let unknown_action = parse(r#"{"action": "jump", "confidence": 0.9}"#);
    assert!(unknown_action.action.is_none());
    assert!(unknown_action
        .parse_error
        .as_deref()
        .unwrap()
        .contains("unknown action"));

    let unknown_param =
        parse(r#"{"action": "press", "params": {"trigger": "a"}, "confidence": 0.9}"#);
    assert_eq!(
        unknown_param.parse_error.as_deref(),
        Some("unknown param \"trigger\" for action \"press\"")
    );

    let bad_value = parse(r#"{"action": "press", "params": {"button": "x"}, "confidence": 0.9}"#);
    assert_eq!(
        bad_value.parse_error.as_deref(),
        Some("param \"button\" value must be one of its declared choices")
    );

    let missing = parse(r#"{"action": "press", "confidence": 0.9}"#);
    assert_eq!(
        missing.parse_error.as_deref(),
        Some("missing param(s) button for action \"press\"")
    );
}

#[test]
fn undeclared_params_on_a_paramless_action_are_refused() {
    let outcome = parse(r#"{"action": "look", "params": {"button": "a"}, "confidence": 0.9}"#);
    assert_eq!(
        outcome.parse_error.as_deref(),
        Some("unknown param \"button\" for action \"look\"")
    );
}

#[test]
fn confidence_must_be_a_number_in_the_unit_interval() {
    for raw in [
        r#"{"action": "look", "confidence": 1.5}"#,
        r#"{"action": "look", "confidence": -0.1}"#,
        r#"{"action": "look", "confidence": "high"}"#,
        r#"{"action": "look"}"#,
    ] {
        let outcome = parse(raw);
        assert_eq!(
            outcome.parse_error.as_deref(),
            Some("confidence must be a number in [0, 1]"),
            "{raw}"
        );
    }
    // The bounds are inclusive.
    assert_eq!(
        parse(r#"{"action": "look", "confidence": 0}"#).confidence,
        Some(0.0)
    );
    assert_eq!(
        parse(r#"{"action": "look", "confidence": 1}"#).confidence,
        Some(1.0)
    );
}

#[test]
fn free_text_never_passes() {
    let outcome = parse("I will press the A button now.");
    assert_eq!(
        outcome.parse_error.as_deref(),
        Some("reply was not a JSON object")
    );
    let outcome = parse("[1, 2, 3]");
    assert_eq!(
        outcome.parse_error.as_deref(),
        Some("reply was not a JSON object")
    );
}

#[test]
fn prose_and_fences_before_the_decision_do_not_refuse_it() {
    let fenced = parse(
        "Sure. Here is my choice:\n```json\n{\"action\": \"look\", \"confidence\": 0.7}\n```\n",
    );
    assert_eq!(fenced.action.as_deref(), Some("look"));

    let prose = parse("I considered {\"action\": \"jump\"} but settled on {\"action\": \"look\", \"confidence\": 0.6}");
    assert_eq!(prose.action.as_deref(), Some("look"));
}

#[test]
fn a_draft_object_before_the_decision_does_not_refuse_the_reply() {
    // The first candidate is an unknown action; the second is the choice.
    let outcome =
        parse("Draft {\"action\": \"unknown\"} then {\"action\": \"look\", \"confidence\": 0.6}");
    assert_eq!(outcome.action.as_deref(), Some("look"));
}

#[test]
fn two_distinct_valid_decisions_refuse_the_reply() {
    // Both objects are valid choices; executing the first would silently
    // discard the stated final answer.
    let outcome = parse(
        "Draft {\"action\": \"press\", \"params\": {\"button\": \"a\"}, \"confidence\": 0.9} \
         Final {\"action\": \"look\", \"confidence\": 0.9}",
    );
    assert!(outcome.action.is_none());
    assert!(outcome.params.is_empty());
    assert!(outcome.confidence.is_none());
    assert_eq!(
        outcome.parse_error.as_deref(),
        Some("reply contained more than one distinct decision")
    );
}

#[test]
fn identical_copies_of_one_decision_count_once() {
    // The same object in the raw text twice (the greedy and balanced scans
    // re-extract it) is one decision, not a conflict.
    let repeated = parse(
        "{\"action\": \"look\", \"confidence\": 0.7} {\"action\": \"look\", \"confidence\": 0.7}",
    );
    assert_eq!(repeated.action.as_deref(), Some("look"));

    // The same decision inside and outside the fence still resolves to one.
    let fenced = parse(
        "see {\"action\": \"look\", \"confidence\": 0.7} or \
         ```json\n{\"action\": \"look\", \"confidence\": 0.7}\n```",
    );
    assert_eq!(fenced.action.as_deref(), Some("look"));
}

#[test]
fn a_conflicting_fenced_final_after_a_valid_raw_draft_refuses() {
    // The fenced block holds the stated final answer; the raw draft holds a
    // different valid choice. The reply is ambiguous either way.
    let outcome = parse(
        "Draft {\"action\": \"look\", \"confidence\": 0.6} final: \
         ```json\n{\"action\": \"press\", \"params\": {\"button\": \"a\"}, \"confidence\": 0.9}\n```",
    );
    assert!(outcome.action.is_none());
    assert_eq!(
        outcome.parse_error.as_deref(),
        Some("reply contained more than one distinct decision")
    );
}

#[test]
fn braces_inside_parameter_values_do_not_misread_the_object_boundary() {
    let mut actions = support::sample_action_space();
    actions.insert(
        "wait".to_string(),
        RouterActionSpec {
            description: "Wait.".to_string(),
            risk: RouterActionRisk::Read,
            params: BTreeMap::from([(
                "frames".to_string(),
                RouterActionParamSpec {
                    choices: BTreeMap::from([("{8}".to_string(), "eight frames".to_string())]),
                },
            )]),
        },
    );
    let compiled = compile_action_space(&actions).unwrap().by_name;
    let outcome = parse_decision(
        "{\"action\": \"wait\", \"params\": {\"frames\": \"{8}\"}, \"confidence\": 0.6}",
        &compiled,
    );
    assert_eq!(outcome.action.as_deref(), Some("wait"));
    assert_eq!(outcome.params["frames"], "{8}");
}

#[test]
fn params_must_be_an_object() {
    let outcome = parse(r#"{"action": "press", "params": ["button", "a"], "confidence": 0.9}"#);
    assert_eq!(
        outcome.parse_error.as_deref(),
        Some("params must be an object")
    );
}

#[test]
fn the_first_refusal_keeps_its_diagnostic() {
    let outcome = parse("{\"action\": \"nope\"} {\"action\": \"alsonope\"}");
    assert!(outcome.parse_error.as_deref().unwrap().contains("\"nope\""));
}

#[test]
fn the_fenced_block_is_extracted_like_the_ts_regex() {
    // The lazy body runs to the closing fence, keeping the trailing newline;
    // the caller trims it before parsing.
    assert_eq!(
        fenced_block("a\n```json\n{\"x\":1}\n```\nb"),
        Some("{\"x\":1}\n")
    );
    assert_eq!(fenced_block("```\n{\"x\":1}\n```"), Some("{\"x\":1}\n"));
    assert_eq!(fenced_block("no fence here"), None);
    // A fence that never closes has no body.
    assert_eq!(fenced_block("```json\n{\"x\":1}"), None);
}

#[test]
fn image_support_follows_the_model_input_modalities() {
    let text_only: Model = serde_json::from_value(serde_json::json!({
        "id": "m", "name": "M", "api": "openai-completions", "provider": "test",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 1000, "maxTokens": 100
    }))
    .unwrap();
    assert!(!supports_images(&text_only));
    assert_eq!(router_thinking_level(&text_only), ModelThinkingLevel::Off);
}

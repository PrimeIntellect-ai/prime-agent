use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::*;

fn selector() -> Selector {
    Selector::parse("review.verdict").unwrap()
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

#[test]
fn a_reference_names_one_state_and_one_port() {
    assert_eq!(
        selector(),
        Selector {
            state: "review".to_string(),
            port: "verdict".to_string(),
        }
    );
}

#[test]
fn a_reference_with_two_dots_is_ambiguous() {
    assert_eq!(
        Selector::parse("review.verdict.action"),
        Err(SelectorError::Ambiguous(
            "review.verdict.action".to_string()
        ))
    );
}

#[test]
fn a_reference_without_a_state_and_a_port_is_malformed() {
    let found: Vec<_> = ["review", ".verdict", "review."]
        .into_iter()
        .map(Selector::parse)
        .collect();
    assert_eq!(
        found,
        ["review", ".verdict", "review."]
            .map(|reference| Err(SelectorError::Malformed(reference.to_string())))
    );
}

#[test]
fn the_latest_settle_gives_the_value() {
    let settles = [
        done(json!({"verdict": "old"})),
        done(json!({"verdict": "new"})),
    ];
    assert_eq!(selector().select(&settles), Selection::Value(&json!("new")));
}

#[test]
fn a_source_without_a_settle_is_not_settled() {
    assert_eq!(selector().select(&[]), Selection::NotSettled);
}

#[test]
fn a_failed_latest_settle_is_unavailable() {
    let settles = [done(json!({"verdict": "old"})), Settle::Failed];
    assert_eq!(
        selector().select(&settles),
        Selection::Unavailable(Unavailable::Failed)
    );
}

#[test]
fn a_capture_failure_is_unavailable_with_its_reason() {
    let settles = [Settle::Done {
        outputs: Map::new(),
        output_errors: BTreeMap::from([("verdict".to_string(), "no JSON object".to_string())]),
    }];
    assert_eq!(
        selector().select(&settles),
        Selection::Unavailable(Unavailable::CaptureFailed("no JSON object".to_string()))
    );
}

#[test]
fn a_settle_without_the_port_has_no_value() {
    let settles = [done(json!({"notes": "fine"}))];
    assert_eq!(
        selector().select(&settles),
        Selection::Unavailable(Unavailable::NoValue)
    );
}

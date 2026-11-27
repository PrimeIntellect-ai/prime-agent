use super::*;
use serde_json::json;

/// Every spec the runtime's Python validator was exercised with (its unit
/// tests, recorded with their answers before the port): the Rust check
/// gives the same sentences in the same order.
#[test]
fn the_structural_check_matches_the_recorded_corpus() {
    let corpus: Vec<Value> =
        serde_json::from_str(include_str!("../../testdata/spec_corpus.json")).unwrap();
    let mut mismatches = Vec::new();
    for case in &corpus {
        let expected: Vec<String> = serde_json::from_value(case["errors"].clone()).unwrap();
        let found = match case["kind"].as_str() {
            Some("machine") => check_machine(&case["spec"]),
            _ => check_structure(&case["spec"]),
        };
        if found != expected {
            mismatches.push(format!(
                "{}\n  expected: {expected:?}\n  found:    {found:?}",
                case["spec"]
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} cases differ:\n{}",
        mismatches.len(),
        corpus.len(),
        mismatches.join("\n")
    );
}

#[test]
fn limits_follow_the_structural_errors() {
    let spec = json!({
        "run": {"max_parallel": 65, "failure_policy": "nope"},
        "states": [{"id": "a", "entry": true, "subagent": "w", "retries": 11}],
    });
    assert_eq!(
        check_spec(&spec),
        [
            "run failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got 'nope'",
            "state a retries must be an integer between 0 and 10",
            "run max_parallel must be an integer between 1 and 64",
        ]
    );
}

#[test]
fn values_render_like_python_repr() {
    assert_eq!(
        py_repr(&json!({"a": [1, 1.5, true, null, "it's"]})),
        r#"{'a': [1, 1.5, True, None, "it's"]}"#
    );
    assert_eq!(py_repr(&json!(1e20)), "1e+20");
    assert_eq!(py_repr(&json!("a\nb")), "'a\\nb'");
}

//! Spec parsing and action-space validation battery.

use serde_json::{json, Map};

use super::*;

fn minimal() -> Value {
    json!({ "goal": "win", "environment": { "stdio": { "command": ["node", "adapter.mjs"] } } })
}

fn error_of(payload: &Value) -> String {
    parse_system_router_run_spec(payload)
        .unwrap_err()
        .to_string()
}

#[test]
fn a_minimal_spec_takes_every_documented_default() {
    let spec = parse_system_router_run_spec(&minimal()).unwrap();
    assert_eq!(spec.goal, "win");
    assert_eq!(spec.environment.stdio.command, vec!["node", "adapter.mjs"]);
    assert_eq!(spec.environment.stdio.cwd, None);
    assert_eq!(
        spec.environment.stdio.request_timeout_ms,
        DEFAULT_ROUTER_ENV_REQUEST_TIMEOUT_MS
    );
    assert_eq!(spec.environment.stdio.init, None);
    assert_eq!(spec.model, None);
    assert_eq!(spec.max_steps, DEFAULT_ROUTER_MAX_STEPS);
    assert_eq!(spec.timeout_ms, DEFAULT_ROUTER_TIMEOUT_MS);
    assert_eq!(spec.history_steps, DEFAULT_ROUTER_HISTORY_STEPS);
    assert_eq!(spec.observation_chars, DEFAULT_ROUTER_OBSERVATION_CHARS);
    assert!(spec.actions.is_none());
    assert_eq!(spec.gate, RouterGateSpec::default());
    assert_eq!(resolve_gate(spec.gate), default_router_gate());
}

#[test]
fn a_full_spec_round_trips_every_declared_field() {
    let spec = parse_system_router_run_spec(&json!({
        "goal": "reach the overworld",
        "model": "  prime-inference/internal/glm-5.3-fast  ",
        "maxSteps": 40,
        "timeoutMs": 90000,
        "historySteps": 4,
        "observationChars": 2000,
        "gate": { "read": 0.1, "write": 0.2, "destructive": 0.3, "finish": 0.4 },
        "actions": { "press_a": { "description": "Press A.", "risk": "write" } },
        "environment": {
            "stdio": {
                "command": ["node", " adapter.mjs "],
                "cwd": "/w",
                "requestTimeoutMs": 5000,
                "init": { "romPath": "/r.gba" },
            }
        }
    }))
    .unwrap();
    assert_eq!(
        spec.model.as_deref(),
        Some("prime-inference/internal/glm-5.3-fast")
    );
    assert_eq!(spec.max_steps, 40);
    assert_eq!(spec.timeout_ms, 90_000);
    assert_eq!(spec.history_steps, 4);
    assert_eq!(spec.observation_chars, 2_000);
    assert_eq!(spec.environment.stdio.command, vec!["node", "adapter.mjs"]);
    assert_eq!(spec.environment.stdio.cwd.as_deref(), Some("/w"));
    assert_eq!(spec.environment.stdio.request_timeout_ms, 5_000);
    assert_eq!(
        spec.environment.stdio.init,
        Some(json!({ "romPath": "/r.gba" }))
    );
    assert_eq!(
        resolve_gate(spec.gate),
        ResolvedGate {
            read: 0.1,
            write: 0.2,
            destructive: 0.3,
            finish: 0.4,
        }
    );
    let actions = spec.actions.expect("declared actions");
    assert_eq!(actions.len(), 1);
    assert_eq!(actions["press_a"].description, "Press A.");
    assert_eq!(actions["press_a"].risk, RouterActionRisk::Write);
}

/// A fractional budget is not a whole number: the TS `Number.isInteger`
/// floor rejection carries over.
#[test]
fn fractional_budgets_are_rejected() {
    let error = error_of(&json!({
        "goal": "win",
        "maxSteps": 25.5,
        "environment": { "stdio": { "command": ["node"] } }
    }));
    assert_eq!(
        error,
        "system_router.run maxSteps must be a whole number in [1, 200]"
    );
    // An integer-valued float is accepted (JS `Number.isInteger(25.0)`).
    let spec = parse_system_router_run_spec(&json!({
        "goal": "win",
        "maxSteps": 25.0,
        "environment": { "stdio": { "command": ["node"] } }
    }))
    .unwrap();
    assert_eq!(spec.max_steps, 25);
}

#[test]
fn budgets_are_bounded_at_both_ends() {
    for (field, value, message) in [
        ("maxSteps", json!(0), "maxSteps"),
        ("maxSteps", json!(201), "maxSteps"),
        ("timeoutMs", json!(0), "timeoutMs"),
        ("timeoutMs", json!(600_001), "timeoutMs"),
        ("historySteps", json!(0), "historySteps"),
        ("historySteps", json!(33), "historySteps"),
        ("observationChars", json!(0), "observationChars"),
        ("observationChars", json!(32_001), "observationChars"),
    ] {
        let mut payload = minimal();
        payload[field] = value;
        let error = error_of(&payload);
        assert!(
            error.contains(message),
            "expected a {field} bound error, got {error}"
        );
    }
}

#[test]
fn the_envelope_is_validated() {
    assert_eq!(
        error_of(&json!(["not", "an", "object"])),
        "system_router.run payload must be an object"
    );
    assert_eq!(
        error_of(&json!({ "environment": { "stdio": { "command": ["node"] } } })),
        "system_router.run goal must be a non-empty string"
    );
    assert_eq!(
        error_of(&json!({ "goal": "   ", "environment": { "stdio": { "command": ["node"] } } })),
        "system_router.run goal must be a non-empty string"
    );
    assert_eq!(
        error_of(&json!({ "goal": "win" })),
        "system_router.run environment must be an object with a stdio adapter"
    );
    assert_eq!(
        error_of(&json!({ "goal": "win", "environment": {} })),
        "system_router.run environment must be an object with a stdio adapter"
    );
    for command in [
        json!([]),
        json!("node"),
        json!(["node", " "]),
        json!(["node", 7]),
    ] {
        let error = error_of(&json!({
            "goal": "win",
            "environment": { "stdio": { "command": command } }
        }));
        assert_eq!(
            error,
            "system_router.run environment.stdio.command must be a non-empty string array"
        );
    }
    assert_eq!(
        error_of(&json!({
            "goal": "win",
            "environment": { "stdio": { "command": ["node"], "cwd": 7 } }
        })),
        "system_router.run environment.stdio.cwd must be a string when provided"
    );
    assert_eq!(
        error_of(&json!({
            "goal": "win",
            "model": "  ",
            "environment": { "stdio": { "command": ["node"] } }
        })),
        "system_router.run model must be a non-empty string when provided"
    );
    // A provided falsy init payload reaches the adapter as the caller's value.
    let spec = parse_system_router_run_spec(&json!({
        "goal": "win",
        "environment": { "stdio": { "command": ["node"], "init": null } }
    }))
    .unwrap();
    assert_eq!(spec.environment.stdio.init, Some(Value::Null));
}

#[test]
fn the_gate_is_validated() {
    for (gate, expected) in [
        (
            json!({ "read": 1.5 }),
            "system_router.run gate.read must be a number in [0, 1]",
        ),
        (
            json!({ "write": -0.1 }),
            "system_router.run gate.write must be a number in [0, 1]",
        ),
        (
            json!({ "destructive": "high" }),
            "system_router.run gate.destructive must be a number in [0, 1]",
        ),
        (
            json!({ "finish": 2 }),
            "system_router.run gate.finish must be a number in [0, 1]",
        ),
        (
            json!("high"),
            "system_router.run gate must be an object when provided",
        ),
    ] {
        let error = error_of(&json!({
            "goal": "win",
            "gate": gate,
            "environment": { "stdio": { "command": ["node"] } }
        }));
        assert_eq!(error, expected);
    }
}

#[test]
fn the_action_space_rejects_each_malformed_shape() {
    for (actions, expected) in [
        (
            json!({}),
            "system_router.run actions must be a non-empty object of actions, or omitted when the environment supplies its own",
        ),
        (json!("press_a"), "system_router.run actions must be a non-empty object of actions, or omitted when the environment supplies its own"),
        (
            json!({ "press_a": "press" }),
            "system_router.run action \"press_a\" must be an object",
        ),
        (
            json!({ "press_a": { "description": "  " } }),
            "system_router.run action \"press_a\" description must be a non-empty string",
        ),
        (
            json!({ "press_a": { "description": "Press.", "risk": "sometimes" } }),
            "system_router.run action \"press_a\" risk must be \"read\", \"write\", or \"destructive\"",
        ),
        (
            json!({ "press_a": { "description": "Press.", "params": [] } }),
            "system_router.run action \"press_a\" params must be an object when provided",
        ),
        (
            json!({ "press_a": { "description": "Press.", "params": { "button": { "choices": {} } } } }),
            "system_router.run action \"press_a\" param \"button\" must declare a non-empty finite choices set",
        ),
        (
            json!({ "press_a": { "description": "Press.", "params": { "button": { "choices": { "a": "" } } } } }),
            "system_router.run action \"press_a\" param \"button\" choice \"a\" needs a non-empty description",
        ),
        (
            json!({ "press_a": { "description": "Press.", "params": { "Button": { "choices": { "a": "A." } } } } }),
            "system_router.run action \"press_a\" param name \"Button\" must be lowercase snake_case (max 32 chars)",
        ),
    ] {
        let error = error_of(&json!({
            "goal": "win",
            "actions": actions,
            "environment": { "stdio": { "command": ["node"] } }
        }));
        assert_eq!(error, expected);
    }
}

#[test]
fn action_and_param_names_are_constrained() {
    for actions in [
        json!({ "Press": { "description": "Press." } }),
        json!({ "press-a": { "description": "Press." } }),
        json!({ "": { "description": "Press." } }),
        json!({ "pressaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { "description": "Press." } }),
    ] {
        let error = error_of(&json!({
            "goal": "win",
            "actions": actions,
            "environment": { "stdio": { "command": ["node"] } }
        }));
        assert!(
            error.contains("must be lowercase snake_case (max 32 chars)"),
            "{error}"
        );
    }
}

#[test]
fn the_loop_owned_action_names_are_reserved() {
    for name in [FINISH_ACTION, ESCALATE_ACTION, "__proto__"] {
        let mut actions = Map::new();
        actions.insert(name.to_string(), json!({ "description": "Taken." }));
        let error = error_of(&json!({
            "goal": "win",
            "actions": Value::Object(actions),
            "environment": { "stdio": { "command": ["node"] } }
        }));
        let expected = if name == "__proto__" {
            format!("system_router.run action name \"{name}\" is reserved")
        } else {
            format!("system_router.run action name \"{name}\" is reserved for the loop itself")
        };
        assert_eq!(error, expected);
    }
}

#[test]
fn the_environment_action_space_inherits_only_when_undeclared() {
    let declared = parse_action_space(&json!({ "look": { "description": "Look." } })).unwrap();
    let supplied = json!({ "wait": { "description": "Wait." } });
    // The declaration wins.
    let resolved = parse_environment_actions(Some(&declared), Some(&supplied))
        .unwrap()
        .expect("declared space");
    assert!(resolved.contains_key("look"));
    assert!(!resolved.contains_key("wait"));
    // No declaration, no supplied space: nothing to run against.
    assert!(parse_environment_actions(None, None).unwrap().is_none());
    // No declaration, a supplied space: it is parsed and validated.
    let resolved = parse_environment_actions(None, Some(&supplied))
        .unwrap()
        .expect("supplied space");
    assert!(resolved.contains_key("wait"));
    // A malformed supplied space fails loudly.
    let error =
        parse_environment_actions(None, Some(&json!({ "Wait": { "description": "Wait." } })))
            .unwrap_err();
    assert!(error.to_string().contains("snake_case"), "{error}");
}

#[test]
fn the_risk_defaults_to_write() {
    let actions = parse_action_space(&json!({ "press_a": { "description": "Press." } })).unwrap();
    assert_eq!(actions["press_a"].risk, RouterActionRisk::Write);
}

//! The segment-runner battery: action-space precedence, adapter cleanup on
//! every path, and the init budget.

use std::sync::Arc;

use serde_json::json;

use super::super::decide::RouterDecisionFn;
use super::super::test_support as support;
use super::super::types::{
    parse_system_router_run_spec, RouterRunStatus, RouterSegmentEnvironment, FINISH_ACTION,
};
use super::*;

fn action_model() -> Model {
    serde_json::from_value(json!({
        "id": "action-model", "name": "Action Model", "api": "openai-completions",
        "provider": "testprov", "baseUrl": "http://localhost", "reasoning": false,
        "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 8_000, "maxTokens": 512
    }))
    .unwrap()
}

fn options(
    env: Arc<support::ScriptedEnvironment>,
    decide: RouterDecisionFn,
) -> RouterSegmentOptions {
    RouterSegmentOptions {
        model: action_model(),
        api_key: Some("test-key".to_string()),
        headers: None,
        session_id: Some("session-1".to_string()),
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
        env: Some(env),
        decide: Some(decide),
        default_cwd: None,
        signal: None,
    }
}

fn spec(actions: Option<serde_json::Value>, timeout_ms: u64) -> ParsedSystemRouterRunSpec {
    let mut payload = json!({
        "goal": "reach the overworld",
        "timeoutMs": timeout_ms,
        "environment": { "stdio": { "command": ["python3", "adapter.py"] } }
    });
    if let Some(actions) = actions {
        payload["actions"] = actions;
    }
    parse_system_router_run_spec(&payload).unwrap()
}

#[tokio::test]
async fn the_declared_action_space_wins_over_the_adapters_defaults() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("title screen"))
        .then_init_actions(json!({ "wait": { "description": "Wait one tick." } }))
        .then_execute("advanced", false);
    let decide = support::scripted_decide(vec![
        support::valid_decision("look", &[], 0.9),
        support::valid_decision(FINISH_ACTION, &[], 0.9),
    ]);
    let spec = spec(
        Some(json!({ "look": { "description": "Look at the screen.", "risk": "read" } })),
        5_000,
    );
    let result = run_router_segment(&spec, options(Arc::clone(&env), decide))
        .await
        .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.executed, 1);
    assert_eq!(result.model.provider, "testprov");
    assert_eq!(result.model.thinking_level, "off");
    assert!(env.calls.lock().unwrap().contains(&"init".to_string()));
    assert!(*env.closes.lock().unwrap() >= 1, "the adapter is closed");
}

#[tokio::test]
async fn an_undeclared_space_uses_the_adapters_defaults() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("idle"))
        .then_init_actions(json!({ "wait": { "description": "Wait one tick." } }))
        .then_execute("waited", false);
    let decide = support::scripted_decide(vec![
        support::valid_decision("wait", &[], 0.9),
        support::valid_decision(FINISH_ACTION, &[], 0.9),
    ]);
    let result = run_router_segment(&spec(None, 5_000), options(Arc::clone(&env), decide))
        .await
        .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.executed, 1);
}

#[tokio::test]
async fn a_missing_action_space_fails_and_closes_the_adapter() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("idle"));
    let error = run_router_segment(
        &spec(None, 5_000),
        options(Arc::clone(&env), support::scripted_decide(vec![])),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "system_router.run has no action space: declare one or use an adapter that supplies its own"
    );
    assert!(*env.closes.lock().unwrap() >= 1, "the adapter never leaks");
}

#[tokio::test]
async fn an_init_failure_closes_the_adapter() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("idle"))
        .then_init_error("no rom loaded");
    let error = run_router_segment(
        &spec(Some(json!({ "look": { "description": "Look." } })), 5_000),
        options(Arc::clone(&env), support::scripted_decide(vec![])),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "environment adapter init failed: no rom loaded"
    );
    assert!(*env.closes.lock().unwrap() >= 1);
}

#[tokio::test]
async fn an_already_aborted_segment_never_touches_the_adapter() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("idle"));
    let controller = pa_agent::abort::AbortController::new();
    controller.abort();
    let mut options = options(Arc::clone(&env), support::scripted_decide(vec![]));
    options.signal = Some(controller.signal());
    let result = run_router_segment(
        &spec(Some(json!({ "look": { "description": "Look." } })), 5_000),
        options,
    )
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Failed);
    assert_eq!(result.reason, "aborted");
    assert!(env.calls.lock().unwrap().is_empty());
    assert_eq!(result.steps, 0);
}

#[tokio::test]
async fn adapter_init_is_bounded_by_the_segment_budget() {
    let mut payload = json!({
        "goal": "reach the overworld",
        "timeoutMs": 150,
        "environment": { "stdio": { "command": ["sh", "-c", "sleep 30"] } }
    });
    payload["actions"] = json!({ "look": { "description": "Look." } });
    let spec = parse_system_router_run_spec(&payload).unwrap();
    let options = RouterSegmentOptions {
        model: action_model(),
        api_key: Some("test-key".to_string()),
        headers: None,
        session_id: None,
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
        env: None,
        decide: Some(support::scripted_decide(vec![])),
        default_cwd: None,
        signal: None,
    };
    let started = std::time::Instant::now();
    let error = run_router_segment(&spec, options).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("environment adapter init exceeded the segment timeout of 150ms"),
        "unexpected error: {error}"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

/// The spec's adapter cwd wins; an omitted one falls back to the caller's
/// session working directory instead of the host process cwd.
#[tokio::test]
async fn the_adapter_runs_in_the_session_working_directory_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("adapter-cwd.txt");
    let command = format!("pwd > {} ; exit 0", marker.display());
    let payload = json!({
        "goal": "reach the overworld",
        "timeoutMs": 2_000,
        "actions": { "look": { "description": "Look." } },
        "environment": { "stdio": { "command": ["sh", "-c", command] } }
    });
    let spec = parse_system_router_run_spec(&payload).unwrap();
    let options = RouterSegmentOptions {
        model: action_model(),
        api_key: Some("test-key".to_string()),
        headers: None,
        session_id: None,
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
        env: None,
        decide: Some(support::scripted_decide(vec![])),
        default_cwd: Some(dir.path().to_string_lossy().into_owned()),
        signal: None,
    };
    // The adapter cannot speak the protocol, so the segment fails after the
    // shell wrote its cwd.
    let _ = run_router_segment(&spec, options).await;
    let written = std::fs::read_to_string(&marker).expect("the adapter ran in the default cwd");
    let expected = std::fs::canonicalize(dir.path()).unwrap();
    let actual = std::fs::canonicalize(written.trim()).unwrap();
    assert_eq!(actual, expected);
}

/// A relative declared adapter cwd joins the session working directory
/// instead of resolving against the host process cwd (#3184 review): the
/// two differ in a daemon worker switched onto another session, and
/// `current_dir` on the raw relative path would run the adapter in the
/// wrong place.
#[tokio::test]
async fn a_relative_adapter_cwd_joins_the_session_working_directory() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("adapter-sub");
    std::fs::create_dir(&nested).unwrap();
    let marker = nested.join("adapter-cwd.txt");
    let command = format!("pwd > {} ; exit 0", marker.display());
    let payload = json!({
        "goal": "reach the overworld",
        "timeoutMs": 2_000,
        "actions": { "look": { "description": "Look." } },
        "environment": {
            "stdio": { "command": ["sh", "-c", command], "cwd": "adapter-sub" }
        }
    });
    let spec = parse_system_router_run_spec(&payload).unwrap();
    let options = RouterSegmentOptions {
        model: action_model(),
        api_key: Some("test-key".to_string()),
        headers: None,
        session_id: None,
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
        env: None,
        decide: Some(support::scripted_decide(vec![])),
        default_cwd: Some(dir.path().to_string_lossy().into_owned()),
        signal: None,
    };
    // The adapter cannot speak the protocol, so the segment fails after the
    // shell wrote its cwd.
    let _ = run_router_segment(&spec, options).await;
    let written =
        std::fs::read_to_string(&marker).expect("the adapter ran in the session's subdirectory");
    let expected = std::fs::canonicalize(&nested).unwrap();
    let actual = std::fs::canonicalize(written.trim()).unwrap();
    assert_eq!(actual, expected);
}

/// An empty declared adapter cwd (`""`) is treated as omitted, not as a
/// path: models often emit `""` for optional fields, and the TS reference
/// drops it at the segment seam (`spec.environment.stdio.cwd ? { cwd }
/// : {}`), so the run falls back to the session working directory instead
/// of failing the spawn (`Command::current_dir` on an empty path errors,
/// #3184 review).
#[tokio::test]
async fn an_empty_adapter_cwd_is_treated_as_omitted() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("adapter-cwd.txt");
    let command = format!("pwd > {} ; exit 0", marker.display());
    let payload = json!({
        "goal": "reach the overworld",
        "timeoutMs": 2_000,
        "actions": { "look": { "description": "Look." } },
        "environment": {
            "stdio": { "command": ["sh", "-c", command], "cwd": "" }
        }
    });
    let spec = parse_system_router_run_spec(&payload).unwrap();
    let options = RouterSegmentOptions {
        model: action_model(),
        api_key: Some("test-key".to_string()),
        headers: None,
        session_id: None,
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
        env: None,
        decide: Some(support::scripted_decide(vec![])),
        default_cwd: Some(dir.path().to_string_lossy().into_owned()),
        signal: None,
    };
    // The adapter cannot speak the protocol, so the segment fails after the
    // shell wrote its cwd.
    let _ = run_router_segment(&spec, options).await;
    let written = std::fs::read_to_string(&marker)
        .expect("the empty declared cwd fell back to the session working directory");
    let expected = std::fs::canonicalize(dir.path()).unwrap();
    let actual = std::fs::canonicalize(written.trim()).unwrap();
    assert_eq!(actual, expected);
}

/// An absolute declared adapter cwd wins as-is: the session working
/// directory is only the anchor for relative paths and the undeclared
/// default, never an override.
#[tokio::test]
async fn an_absolute_adapter_cwd_wins_over_the_session_directory() {
    let session_dir = tempfile::tempdir().unwrap();
    let declared_dir = tempfile::tempdir().unwrap();
    let marker = declared_dir.path().join("adapter-cwd.txt");
    let command = format!("pwd > {} ; exit 0", marker.display());
    let payload = json!({
        "goal": "reach the overworld",
        "timeoutMs": 2_000,
        "actions": { "look": { "description": "Look." } },
        "environment": {
            "stdio": {
                "command": ["sh", "-c", command],
                "cwd": declared_dir.path().to_string_lossy().into_owned()
            }
        }
    });
    let spec = parse_system_router_run_spec(&payload).unwrap();
    let options = RouterSegmentOptions {
        model: action_model(),
        api_key: Some("test-key".to_string()),
        headers: None,
        session_id: None,
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
        env: None,
        decide: Some(support::scripted_decide(vec![])),
        default_cwd: Some(session_dir.path().to_string_lossy().into_owned()),
        signal: None,
    };
    let _ = run_router_segment(&spec, options).await;
    let written = std::fs::read_to_string(&marker).expect("the adapter ran in the declared cwd");
    let expected = std::fs::canonicalize(declared_dir.path()).unwrap();
    let actual = std::fs::canonicalize(written.trim()).unwrap();
    assert_eq!(actual, expected);
}

/// A slow adapter `init` spends part of the declared budget; every timeout
/// summary must still report the figure System 2 set, not the leftover the
/// loop runs on.
#[tokio::test]
async fn the_timeout_summary_reports_the_declared_segment_timeout() {
    // Answers `init`, then hangs on `reset`: the loop hits the leftover budget.
    let command = r#"read line; printf '{"id":0,"ok":true}\n'; read line; sleep 30"#;
    let payload = json!({
        "goal": "reach the overworld",
        "timeoutMs": 900,
        "actions": { "look": { "description": "Look." } },
        "environment": { "stdio": { "command": ["sh", "-c", command] } }
    });
    let spec = parse_system_router_run_spec(&payload).unwrap();
    let options = RouterSegmentOptions {
        model: action_model(),
        api_key: Some("test-key".to_string()),
        headers: None,
        session_id: None,
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
        env: None,
        decide: Some(support::scripted_decide(vec![])),
        default_cwd: None,
        signal: None,
    };
    let result = run_router_segment(&spec, options).await.unwrap();
    assert_eq!(result.status, RouterRunStatus::Incomplete);
    assert_eq!(result.reason, "timeout");
    assert_eq!(
        result.summary,
        "Stopped before the first step: the segment timeout of 900ms elapsed during reset."
    );
}

/// The env trait object is what the loop closes; keep the compiler honest
/// about the `RouterSegmentEnvironment` supertrait.
#[test]
fn a_scripted_environment_implements_the_segment_contract() {
    fn assert_segment<T: RouterSegmentEnvironment>(_env: &T) {}
    let env = support::ScriptedEnvironment::with_observation(support::observation("x"));
    assert_segment(&*env);
}

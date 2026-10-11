//! The Decision API's real-runtime fixtures: the kernel's settings-gated
//! skill pre-import and the real skill loop over the host bridge.

use std::path::Path;

use serde_json::{json, Value};

use super::engine::{create_session, SessionEngine, SessionEngineConfig};

async fn build_session(root: &Path, agent_dir: &std::path::Path) -> SessionEngine {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = std::sync::Arc::new(pa_agent::scripted::ScriptedProvider::new(model.clone()));
    create_session(SessionEngineConfig {
        cwd: root.to_path_buf(),
        agent_dir: agent_dir.to_path_buf(),
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    })
    .await
    .unwrap()
}

// Real fixtures own their process-wide kernel registry and environment.
#[tracing::instrument]
async fn run_runtime_fixture_in_child(name: &str) -> bool {
    const CHILD_FIXTURE: &str = "PA_DECISION_API_RUNTIME_FIXTURE_CHILD";
    let test = format!("session_engine::decision_runtime_tests::{name}");
    if std::env::var(CHILD_FIXTURE).as_deref() == Ok(test.as_str()) {
        return false;
    }
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", &test, "--nocapture"])
        .env(CHILD_FIXTURE, &test)
        .env("RUST_TEST_THREADS", "1")
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(240), command.output())
        .await
        .expect("isolated real fixture deadline")
        .expect("isolated real fixture starts");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        eprintln!("[decision fixture child] {line}");
    }
    assert!(
        output.status.success(),
        "isolated fixture {test}: {}",
        output.status
    );
    assert!(
        stdout.contains("running 1 test"),
        "the exact child fixture must run"
    );
    assert!(
        stdout.contains(&format!("DECISION_API_REAL_FIXTURE_EXECUTED: {name}"))
            || stderr.contains("no installed kernel Python"),
        "fixture must report execution or its explicit runtime skip",
    );
    true
}

#[tokio::test]
async fn decision_api_preimports_the_skill_only_while_the_setting_is_set() {
    use crate::kernel::shared::{ExecuteOptions, ExecuteStatus};
    if run_runtime_fixture_in_child(
        "decision_api_preimports_the_skill_only_while_the_setting_is_set",
    )
    .await
    {
        return;
    }
    // This verifier needs an installed runtime; hermetic hosts can run the
    // metadata regressions without downloading a Python environment.
    let installed = std::env::var_os("PRIME_AGENT_KERNEL_PYTHON")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                std::path::PathBuf::from(home).join(".prime/agent/kernel-venv/bin/python")
            })
        });
    if !installed.is_some_and(|path| path.exists()) {
        eprintln!("skipping decision API real-kernel verifier: no installed kernel Python");
        return;
    }
    for (configured, expected) in [(true, "True"), (false, "False")] {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let settings = if configured {
            json!({ "decisionApi": { "systemOneModel": "fixture/model" } })
        } else {
            json!({})
        };
        std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
        let engine = build_session(dir.path(), &agent_dir).await;
        let skill_entry = "<name>decision-api</name>";
        assert_eq!(engine.system_prompt.contains(skill_entry), configured);
        let kernel = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            engine.provisioner.ensure(None, None),
        )
        .await
        .expect("kernel bootstrap deadline")
        .expect("real kernel must start");
        let code = format!("assert ('decision_api' in globals()) == {expected}\nprint('ok')");
        let result = kernel
            .execute(&code, ExecuteOptions::default())
            .await
            .unwrap();
        assert_eq!(
            result.status,
            ExecuteStatus::Ok,
            "{:?}\n{}\n{}",
            result.error,
            result.stdout,
            result.stderr
        );
        engine.dispose_kernel().await;
    }
    println!("DECISION_API_REAL_FIXTURE_EXECUTED: decision_api_preimports_the_skill_only_while_the_setting_is_set");
}

#[tokio::test]
async fn decision_api_real_runtime_loop_routes_decisions_and_child_delivery_then_cleans_up() {
    use std::sync::{Arc, Mutex};

    use crate::kernel::manager::{KernelStartOptions, ReplKernelManager};
    use crate::kernel::shared::{
        host_handler, ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions,
        KernelShutdownOptions,
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FixtureRequest {
        Spawn,
        Send,
        Decision,
        Delete,
    }
    if run_runtime_fixture_in_child(
        "decision_api_real_runtime_loop_routes_decisions_and_child_delivery_then_cleans_up",
    )
    .await
    {
        return;
    }
    // This is a real REPL/skill bridge with synthetic child and reply
    // handlers. It never invokes a paid provider or starts a daemon child.
    let python = std::env::var_os("PRIME_AGENT_KERNEL_PYTHON")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                std::path::PathBuf::from(home).join(".prime/agent/kernel-venv/bin/python")
            })
        });
    let Some(python) = python.filter(|path| path.exists()) else {
        eprintln!("skipping decision API real-runtime fixture: no installed kernel Python");
        return;
    };
    let events = Arc::new(Mutex::new(Vec::new()));
    let replies = Arc::new(Mutex::new(std::collections::HashMap::<String, Value>::new()));
    let mut handlers = HostRequestHandlers::new();
    for (name, kind) in [
        ("rlm.run", FixtureRequest::Spawn),
        ("agent_message.send", FixtureRequest::Send),
        ("decision_api.decision", FixtureRequest::Decision),
        ("rlm.delete_subagent", FixtureRequest::Delete),
    ] {
        let events = Arc::clone(&events);
        let replies = Arc::clone(&replies);
        handlers.register(name, host_handler(move |payload| {
            let events = Arc::clone(&events);
            let replies = Arc::clone(&replies);
            Box::pin(async move {
                events.lock().unwrap().push((kind, payload.data.clone()));
                match kind {
                    FixtureRequest::Spawn => {
                        let name = payload.data["kwargs"]["name"].clone();
                        Ok(json!({"rlm_child_id":"fixture-child","name":name,"session_dir":"/tmp/fixture-child","model":"synthetic/child"}))
                    }
                    FixtureRequest::Send => {
                        let text = payload.data["message"].as_str().unwrap();
                        let message: serde_json::Value = serde_json::from_str(text)?;
                        let name = payload.data["receiver_name"].as_str().unwrap_or("system-1");
                        // The decision child's answer routes back through
                        // the parent's per-child slot (the child records the
                        // latest message-sourced goal and serves one decide).
                        let state = message["state"].clone();
                        let mut decision_state = state;
                        if decision_state.get("goal").is_none() {
                            decision_state["goal"] = json!("follow fixture strategy");
                        }
                        replies.lock().unwrap().insert(
                            name.to_string(),
                            json!({
                                "type":"decision_api.decision","seq":message["seq"],
                                "model":"synthetic/child",
                                "decision":{"choice":"left","confidence":0.9,"probabilities":{"left":0.9,"right":0.1}}
                            }),
                        );
                        Ok(json!({"deliveryStatus":"sent"}))
                    }
                    FixtureRequest::Decision => {
                        let name = payload.data["name"].as_str().unwrap_or_default().to_string();
                        if payload.data["close"] == true {
                            replies.lock().unwrap().remove(&name);
                            return Ok(Value::Null);
                        }
                        Ok(replies
                            .lock()
                            .unwrap()
                            .get(&name)
                            .cloned()
                            .unwrap_or(Value::Null))
                    }
                    FixtureRequest::Delete => Ok(json!({"subagent":{
                        "rlm_child_id":"fixture-child","session_name":payload.data["target"],
                        "session_dir":"/tmp/fixture-child","status":"completed"
                    },"outcome":"deleted"})),
                }
            })
        }));
    }
    let dir = tempfile::tempdir().unwrap();
    let manager = ReplKernelManager::new(KernelManagerOptions {
        python: Some(python),
        cwd: Some(dir.path().to_path_buf()),
        env: std::collections::HashMap::new(),
        session_id: Some("decision-runtime-fixture".to_string()),
        host_handlers: handlers,
        python_skills: Vec::new(),
        on_background_work_settled: None,
        snapshot: None,
        bootstrap_code: None,
        stderr_log_path: None,
    });
    manager.start(KernelStartOptions::default()).await.unwrap();
    // The fixture kernel carries no skill set (a bare ReplKernelManager),
    // so the skill imports resolve from the checkout's skill sources, never
    // a side-effect skill install some other test raced into the shared venv.
    let decision_skill =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills/decision-api/src");
    let messaging_skill =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills/agent-message/src");
    let source = serde_json::to_string(&decision_skill.display().to_string()).unwrap();
    let messaging_source = serde_json::to_string(&messaging_skill.display().to_string()).unwrap();
    let code = format!(
        r#"
import sys, asyncio, pathlib
sys.path.insert(0, {messaging_source})
sys.path.insert(0, {source})
import decision_api
assert pathlib.Path(decision_api.__file__).resolve().is_relative_to(pathlib.Path({source}).resolve())
assert decision_api.rlm.__file__ and decision_api.agent_message.__file__
actions_taken = []
observations_seen = 0
async def observe_fixture():
    global observations_seen
    observations_seen += 1
    if observations_seen > 2:
        return None
    return {{"frame": observations_seen}}
loop = decision_api.Loop(observe_fixture, actions_taken.append, {{"left":"go left", "right":"go right"}},
    objective="fixture objective", decide_timeout=15)
status = await asyncio.wait_for(loop.run(), 60)
assert actions_taken == ["left", "left"], actions_taken
assert loop.goal == "fixture objective", loop.status()
assert loop.errors == [], loop.errors
assert not status["running"]
print("fixture passed")
"#
    );
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        manager.execute(&code, ExecuteOptions::default()),
    )
    .await
    .expect("real runtime fixture deadline")
    .expect("real runtime fixture execution");
    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .unwrap();
    assert_eq!(
        result.status,
        ExecuteStatus::Ok,
        "{:?}\n{}\n{}",
        result.error,
        result.stdout,
        result.stderr
    );
    assert_eq!(result.stdout, "fixture passed\n");
    let events = events.lock().unwrap();
    // The spawn carries the decision kind; the requests carry the step seqs.
    let spawned = events
        .iter()
        .find(|(kind, _)| *kind == FixtureRequest::Spawn)
        .unwrap();
    assert_eq!(spawned.1["kwargs"]["kind"], json!("decision"));
    assert!(
        spawned.1["prompt"]
            .as_str()
            .is_some_and(|prompt| prompt.contains("You are System 1")),
        "the child's protocol prompt composes from the skill material"
    );
    let sends: Vec<&Value> = events
        .iter()
        .filter(|(kind, _)| *kind == FixtureRequest::Send)
        .map(|(_, data)| data)
        .collect();
    assert_eq!(sends.len(), 2);
    let seqs: Vec<i64> = sends
        .iter()
        .filter_map(|send| {
            let message: Value = serde_json::from_str(send["message"].as_str()?).ok()?;
            message["seq"].as_i64()
        })
        .collect();
    assert_eq!(seqs, vec![0, 1]);
    assert!(
        sends
            .iter()
            .all(|send| send["receiver_role"] == json!("child")),
        "the requests address the decision child"
    );
    let deleted = events
        .iter()
        .find(|(kind, _)| *kind == FixtureRequest::Delete)
        .unwrap();
    assert_eq!(
        deleted.1["target"], spawned.1["kwargs"]["name"],
        "the loop's teardown deletes its decision child"
    );
    println!("DECISION_API_REAL_FIXTURE_EXECUTED: decision_api_real_runtime_loop_routes_decisions_and_child_delivery_then_cleans_up");
}

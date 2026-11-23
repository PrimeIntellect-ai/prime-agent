// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines).
#![allow(clippy::large_futures, clippy::too_many_lines)]

//! Verifier: typed factory outputs over a REAL kernel and the full
//! session-engine tool path. A factory child (a session created with an
//! output contract) emits a wrong value, gets the exact field back as a
//! `MachineEmitError` in the same turn, emits the fixed value, and the
//! accepted outputs (with the file port copied) land beside its session
//! file, where the parent's executor reads them. No model call: the
//! `ScriptedProvider` answers from the pushed turns.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use pa_agent::scripted::{tool_call_turn_steps, ScriptedProvider, ScriptedTurn};
use pa_core::session::manager::SessionManager;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::PromptOptions;
use serde_json::json;

/// The kernel Python with prime-agent-runtime installed (the interpreter the
/// TS product's kernel venv bootstraps). Skipped (with a note) on machines
/// without a live install; `PA_CORE_KERNEL_PYTHON` points at an explicit one.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_CORE_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_CORE_KERNEL_PYTHON {} not found",
            explicit.display()
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live kernel test",
        candidate.display()
    );
    None
}

/// The process env is global and both live-kernel tests in this binary run
/// concurrently on separate test threads: each overrides
/// `PRIME_AGENT_KERNEL_PYTHON` and friends, and one test's restore would pull
/// the variable out from under the other's kernel bootstrap. Each test holds
/// this lock for its whole body (taken before its `EnvOverride`, so the
/// override is restored before the lock is released).
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn env_lock() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Scoped process-env overrides: applied on construction, restored on drop.
/// Callers hold `env_lock()` for as long as the override lives.
struct EnvOverride {
    saved: Vec<(String, Option<String>)>,
}

impl EnvOverride {
    fn apply(pairs: &[(&str, Option<String>)]) -> Self {
        let saved = pairs
            .iter()
            .map(|(key, _)| ((*key).to_string(), std::env::var(key).ok()))
            .collect();
        for (key, value) in pairs {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        EnvOverride { saved }
    }
}

impl Drop for EnvOverride {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn scripted_model() -> pa_agent::types::Model {
    serde_json::from_value(json!({
        "id": "faux-1", "name": "Faux", "api": "test", "provider": "faux",
        "baseUrl": "http://localhost", "reasoning": false,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 200_000, "maxTokens": 4_000
    }))
    .expect("faux loop model")
}

/// The registry model `model.info` reports from: input modalities included.
fn registry_model() -> pa_types::ai::Model {
    serde_json::from_value(json!({
        "id": "faux-1", "name": "Faux", "api": "test", "provider": "faux",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 200_000, "maxTokens": 4_000
    }))
    .expect("faux registry model")
}

#[allow(clippy::await_holding_lock)] // the env lock must span the async kernel flow
#[tokio::test]
async fn a_child_fixes_a_rejected_emit_in_the_same_turn() {
    let _env_lock = env_lock();
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("project dir");
    std::fs::write(cwd.join("DESIGN.md"), "# Design\n").expect("design file");
    let _env = EnvOverride::apply(&[
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);
    let mut session = SessionManager::in_memory(&cwd);
    session.materialize_session_file(Some(sessions_dir.clone()));

    let model = scripted_model();
    let provider = std::sync::Arc::new(ScriptedProvider::new(model.clone()));
    provider.push_turn(ScriptedTurn::Events(tool_call_turn_steps(
        &model,
        Some("handing back the outputs"),
        vec![
            (
                "call-1",
                "python_repl",
                json!({ "code": "from pathlib import Path\ntry:\n    await rlm.machine.emit(risk='medium', design=Path('DESIGN.md'))\nexcept Exception as error:\n    print('REFUSED', type(error).__name__, error)" }),
            ),
            (
                "call-2",
                "python_repl",
                json!({ "code": "print('INPUTS', await rlm.machine.inputs())\nprint('ACCEPTED', await rlm.machine.emit(risk='low', design=Path('DESIGN.md')))" }),
            ),
        ],
    )));
    provider.push_text_turn("done");

    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        inbox: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: Vec::new(),
        custom_system_prompt: None,
        prompt_guidelines: Vec::new(),
        generic_mcp_servers: Vec::new(),
        allow_recursion: None,
        session_manager: Some(session),
        extra_host_handlers: None,
        conversation_log_path: None,
        additional_skill_paths: Vec::new(),
        additional_prompt_paths: Vec::new(),
        extra_builtin_skill_overrides: Vec::new(),
        rlm_subagent_host: None,
        rlm_usage_store: None,
        progress_note_emit: None,
        rlm_depth: Some(1),
        factory_child: true,
        factory_contract: Some(json!({
            "outputs": [{"name": "risk", "type": "enum(low, high)"}, {"name": "design", "type": "file"}],
            "records": {},
            "inputs": {"task": "fix the retry loop"},
        })),
        daemonless: true,
        telemetry: None,
        model_info: Some(registry_model()),
        mcp_manager: None,
        prewarm_ipython_kernel: None,
        kernel_ready_gate: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        queued_goal_context_purge: None,
    })
    .await
    .expect("create_session");

    engine
        .prompt("hand back your outputs", PromptOptions::default())
        .await
        .expect("prompt");
    let serialized = {
        let entries = engine.session.entries().await;
        serde_json::to_string(&entries).expect("entries json")
    };
    assert!(
        serialized.contains(r#"REFUSED MachineEmitError risk: \"medium\" is not one of low, high"#),
        "the wrong value must fail inside the child with the exact field: {serialized}"
    );
    assert!(
        serialized.contains("INPUTS {'task': 'fix the retry loop'}"),
        "the child reads its typed inputs: {serialized}"
    );
    assert!(
        serialized.contains("ACCEPTED {'accepted': ['risk', 'design'], 'missing': []}"),
        "the fixed value is accepted in the same turn: {serialized}"
    );
    let outputs: serde_json::Value = serde_json::from_slice(
        &std::fs::read(sessions_dir.join("factory-outputs.json")).expect("outputs file"),
    )
    .expect("outputs json");
    // Each emit stages its files under its own id:
    // `factory-files/<port>/<emit id>/<name>`.
    let copy = PathBuf::from(outputs["design"].as_str().expect("design path"));
    assert_eq!(
        copy.parent().and_then(Path::parent),
        Some(sessions_dir.join("factory-files/design").as_path())
    );
    assert_eq!(copy.file_name(), Some("DESIGN.md".as_ref()));
    assert_eq!(
        outputs,
        json!({"risk": "low", "design": copy.display().to_string()})
    );
    assert_eq!(
        std::fs::read_to_string(copy).expect("copied file"),
        "# Design\n"
    );
}

/// The daemon worker's child shape: the engine session stays non-persisted
/// (`in_memory_in_session_dir` — the worker owns the durable file), and the
/// session file reaches the engine only as `conversation_log_path`. The
/// factory emit handlers must still register from that path: without the
/// fallback a daemon-worker machine child's `factory.emit` is refused as
/// unbound from its very first turn, and
/// its outputs never land beside its session file.
#[allow(clippy::await_holding_lock)] // the env lock must span the async kernel flow
#[tokio::test]
async fn a_daemon_worker_child_emits_from_its_conversation_log_path() {
    let _env_lock = env_lock();
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("project dir");
    std::fs::write(cwd.join("DESIGN.md"), "# Design\n").expect("design file");
    let _env = EnvOverride::apply(&[
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);
    // The worker owns the durable file; the engine session is in-memory in
    // the same directory. No materialized session file: the in-memory
    // manager reports none.
    let session_file = sessions_dir.join("child-session.jsonl");
    std::fs::write(&session_file, "{\"type\":\"session\"}\n").expect("session file");
    let mut session = SessionManager::in_memory_in_session_dir(&cwd, &sessions_dir);
    session.new_session(&pa_core::session::manager::NewSessionOptions {
        id: Some("child-session".to_string()),
        ..Default::default()
    });
    assert!(
        session.get_session_file().is_none(),
        "the daemon worker's engine session reports no session file"
    );

    let model = scripted_model();
    let provider = std::sync::Arc::new(ScriptedProvider::new(model.clone()));
    provider.push_turn(ScriptedTurn::Events(tool_call_turn_steps(
        &model,
        Some("handing back the outputs"),
        vec![(
            "call-1",
            "python_repl",
            json!({ "code": "from pathlib import Path\nprint('ACCEPTED', await rlm.machine.emit(risk='low', design=Path('DESIGN.md')))" }),
        )],
    )));
    provider.push_text_turn("done");

    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        inbox: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: Vec::new(),
        custom_system_prompt: None,
        prompt_guidelines: Vec::new(),
        generic_mcp_servers: Vec::new(),
        allow_recursion: None,
        session_manager: Some(session),
        extra_host_handlers: None,
        conversation_log_path: Some(session_file.clone()),
        additional_skill_paths: Vec::new(),
        additional_prompt_paths: Vec::new(),
        extra_builtin_skill_overrides: Vec::new(),
        rlm_subagent_host: None,
        rlm_usage_store: None,
        progress_note_emit: None,
        rlm_depth: Some(2),
        factory_child: true,
        factory_contract: Some(json!({
            "outputs": [{"name": "risk", "type": "enum(low, high)"}, {"name": "design", "type": "file"}],
            "records": {},
            "inputs": {"task": "fix the retry loop"},
        })),
        daemonless: true,
        telemetry: None,
        model_info: Some(registry_model()),
        mcp_manager: None,
        prewarm_ipython_kernel: None,
        kernel_ready_gate: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        queued_goal_context_purge: None,
    })
    .await
    .expect("create_session");

    engine
        .prompt("hand back your outputs", PromptOptions::default())
        .await
        .expect("prompt");
    let serialized = {
        let entries = engine.session.entries().await;
        serde_json::to_string(&entries).expect("entries json")
    };
    assert!(
        !serialized.contains("REFUSED"),
        "the daemon worker child's emit is bound by its conversation-log path: {serialized}"
    );
    assert!(
        serialized.contains("ACCEPTED {'accepted': ['risk', 'design'], 'missing': []}"),
        "the emit routes and is accepted in the same turn: {serialized}"
    );
    let outputs: serde_json::Value = serde_json::from_slice(
        &std::fs::read(sessions_dir.join("factory-outputs.json")).expect("outputs file"),
    )
    .expect("outputs json");
    // Each emit stages its files under its own id:
    // `factory-files/<port>/<emit id>/<name>`.
    let copy = PathBuf::from(outputs["design"].as_str().expect("design path"));
    assert_eq!(
        copy.parent().and_then(Path::parent),
        Some(sessions_dir.join("factory-files/design").as_path())
    );
    assert_eq!(copy.file_name(), Some("DESIGN.md".as_ref()));
    assert_eq!(
        outputs,
        json!({"risk": "low", "design": copy.display().to_string()})
    );
}

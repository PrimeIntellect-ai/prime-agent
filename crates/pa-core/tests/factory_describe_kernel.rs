// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines).
#![allow(clippy::large_futures, clippy::too_many_lines)]

//! Verifier: a machine directory resolved BY NAME from the library over a
//! REAL kernel. The kernel's library code finds the directory and sends
//! `factory.describe` to the session's Rust loader, which answers the
//! machine's fields, its declared params, its template spec, and each
//! state's files: the listing and graph payloads the factory page reads.
//! No model call: the `ScriptedProvider` answers from the pushed turns.
#![cfg(unix)]

use std::path::PathBuf;

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

/// Scoped process-env overrides: applied on construction, restored on drop.
/// This binary carries exactly one live-kernel test, so nothing races.
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

#[tokio::test]
async fn a_machine_directory_resolves_by_name_through_factory_describe() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let repo = dir.path().join("repo-machines");
    let user = dir.path().join("user-machines");
    let machine_dir = repo.join("hello");
    std::fs::create_dir_all(machine_dir.join("prompts")).expect("machine dir");
    std::fs::write(
        machine_dir.join("machine.toml"),
        "format = 1\nname = \"hello\"\nversion = 1\ndescription = \"Say hello\"\n\n[params]\nwho = { type = \"text\" }\n\n[states.greet]\nentry = true\nagent = { prompt = \"prompts/greet.md\" }\noutputs = { line = \"text\" }\n",
    )
    .expect("machine.toml");
    std::fs::write(machine_dir.join("prompts/greet.md"), "Greet {{who}}.\n").expect("prompt");
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

    let code = format!(
        "from rlm.factory import library_graph_any, library_listing\n\
         dirs = dict(repo_dir=r'{repo}', user_dir=r'{user}')\n\
         rows, warnings = await library_listing(**dirs)\n\
         print('LISTED', [(row['name'], row['kind'], row['source'], row['version']) for row in rows], warnings)\n\
         graph = await library_graph_any('hello', **dirs)\n\
         print('DESCRIBED', graph['name'], graph['params'], graph['state_files'], [state['id'] for state in graph['spec']['states']], 'params' in graph['spec'])",
        repo = repo.display(),
        user = user.display(),
    );
    let model = scripted_model();
    let provider = std::sync::Arc::new(ScriptedProvider::new(model.clone()));
    provider.push_turn(ScriptedTurn::Events(tool_call_turn_steps(
        &model,
        Some("reading the library"),
        vec![("call-1", "python_repl", json!({ "code": code }))],
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
        rlm_depth: None,
        factory_child: false,
        factory_contract: None,
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
        .prompt("describe the hello machine", PromptOptions::default())
        .await
        .expect("prompt");
    let serialized = {
        let entries = engine.session.entries().await;
        serde_json::to_string(&entries).expect("entries json")
    };
    assert!(
        serialized.contains("LISTED [('hello', 'directory', 'repo', '1')] []"),
        "the listing names the directory machine from its level: {serialized}"
    );
    assert!(
        serialized.contains("DESCRIBED hello [{'name': 'who', 'type': 'text'}] [{'state': 'greet', 'paths': ['prompts/greet.md']}] ['greet'] False"),
        "factory.describe answers the params, state files, and template spec: {serialized}"
    );
}

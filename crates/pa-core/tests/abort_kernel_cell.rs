// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Verifier: an abort during a running kernel cell must settle the turn at once: Ctrl+C interrupts
//! the cell, force-aborts the execution after the grace window, and returns the loop to ready. The
//! cell writes a `started` marker and then spins, so the abort lands mid-cell.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use pa_agent::scripted::{tool_call_turn_steps, ScriptedProvider, ScriptedTurn};
use pa_core::session::manager::SessionManager;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
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

/// The wedge: a busy cell the abort must interrupt. It writes the `started`
/// marker (the test aborts strictly after it) and then spins: an in-cell sleep
/// of 5s or longer is declined by the async stack, and the SIGINT raises
/// inside the loop.
fn wedge_cell(started: &Path) -> String {
    format!(
        "open({started:?}, \"w\").write(\"started\")\nwhile True:\n    pass",
        started = started.display().to_string(),
    )
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

/// The abort budget is generous for CI; an unaborted wedge cell spins forever.
#[tokio::test]
async fn abort_during_a_kernel_cell_settles_the_turn_immediately() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let started = dir.path().join("cell-started");

    let _env = EnvOverride::apply(&[
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);

    let mut session = SessionManager::in_memory(&cwd);
    session.materialize_session_file(Some(sessions_dir));

    let model = scripted_model();
    let provider = std::sync::Arc::new(ScriptedProvider::new(model.clone()));
    let steps = tool_call_turn_steps(
        &model,
        Some("running the wedge cell"),
        vec![(
            "call-1",
            "python_repl",
            json!({ "code": wedge_cell(&started) }),
        )],
    );
    provider.push_turn(ScriptedTurn::Events(steps));
    provider.push_text_turn("the cell completed");

    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
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

        inbox: None,
        progress_note_emit: None,
        rlm_depth: None,
        factory_child: false,
        daemonless: true,
        telemetry: None,
        model_info: None,
        mcp_manager: None,
        kernel_ready_gate: None,
        prewarm_ipython_kernel: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        queued_goal_context_purge: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
    })
    .await
    .expect("create_session");

    // Run the prompt on a task so the test can abort mid-cell. The
    // SessionEngine (the engine handle) is Send + 'static, so it moves
    // into the task and the abort goes through the agent handle kept here.
    let agent = engine.session.agent().clone();
    let prompt_engine = engine;
    let prompt = tokio::spawn(async move {
        prompt_engine
            .session
            .prompt(
                "run the wedge cell",
                pa_core::session_engine::PromptOptions::default(),
            )
            .await
    });

    // The cell started (bounded by the kernel boot).
    let boot_budget = std::time::Duration::from_secs(
        std::env::var("PA_ABORT_TEST_BOOT_BUDGET_S")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(180),
    );
    if !std::path::Path::new(&started).exists() {
        let watch = tokio::time::timeout(boot_budget, async {
            while !started.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await;
        if watch.is_err() {
            // Dump the persisted session rows so the failure is readable.
            if let Ok(entries) = std::fs::read_dir(dir.path()) {
                for entry in entries.flatten() {
                    eprintln!("tempdir entry: {:?}", entry.path());
                }
            }
            let mut stack = vec![dir.path().to_path_buf()];
            while let Some(path) = stack.pop() {
                if path.is_dir() {
                    if let Ok(children) = std::fs::read_dir(&path) {
                        for child in children.flatten() {
                            stack.push(child.path());
                        }
                    }
                } else if let Ok(text) = std::fs::read_to_string(&path) {
                    if text.len() < 20_000 {
                        eprintln!("--- {} ---\n{}", path.display(), text);
                    } else {
                        eprintln!("--- {} (first 4k) ---\n{}", path.display(), &text[..4000]);
                    }
                }
            }
            panic!("marker {} never appeared", started.display());
        }
    }
    // Abort strictly mid-cell.
    agent.abort();

    // The turn settles at once: an abort wedge hangs here for the rest of the cell (or forever).
    let settled = tokio::time::timeout(std::time::Duration::from_secs(30), prompt)
        .await
        .expect("the aborted turn must settle within 30s")
        .expect("prompt task join");
    // Either the abort surfaces as an error or the turn outcome settles;
    // both mean the loop returned.
    let _ = settled;
    // The agent is ready for the next prompt (the loop unwound).
    let state = agent.state().await;
    assert!(
        !state.is_streaming,
        "the agent must be idle after the aborted turn"
    );
}

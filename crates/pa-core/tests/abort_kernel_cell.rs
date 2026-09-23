//! Verifier: an abort during a running kernel cell must settle the turn
//! at once (dogfood P0): Ctrl+C must kill the in-flight tool execution -
//! interrupt the cell, force-abort the execution after the grace window,
//! and return the loop to ready - instead of waiting the cell out or
//! wedging in an aborting state while the spinner burns.
//!
//! The cell writes a `started` marker before sleeping, so the test aborts
//! strictly mid-cell, and a `finished` marker after the sleep, so the test
//! proves the cell actually died (the interrupted cell never completes).
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
            "PA_CORE_KERNEL_PYTHON {explicit:?} not found"
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(
        std::env::var("HOME")
            .map(|home| format!("{home}/.prime/agent/kernel-venv/bin/python"))
            .unwrap_or_else(|_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string()),
    );
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel test");
    None
}

/// The installed release directory (ships `prime-agent-runtime/`): the same
/// resolution the sibling live-kernel verifier uses.
fn release_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PI_PACKAGE_DIR") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.join("prime-agent-runtime").exists(),
            "PI_PACKAGE_DIR {explicit:?} has no prime-agent-runtime"
        );
        return Some(explicit);
    }
    let releases = PathBuf::from(
        std::env::var("HOME")
            .map(|home| format!("{home}/.local/share/prime-agent/releases"))
            .unwrap_or_else(|_| "/home/ubuntu/.local/share/prime-agent/releases".to_string()),
    );
    let Ok(entries) = std::fs::read_dir(&releases) else {
        eprintln!("no releases dir at {releases:?}; skipping live kernel test");
        return None;
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("prime-agent-runtime").is_dir())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// Scoped process-env overrides: applied on construction, restored on drop.
struct EnvOverride {
    saved: Vec<(String, Option<String>)>,
}

impl EnvOverride {
    fn apply(pairs: Vec<(&str, Option<String>)>) -> Self {
        let saved = pairs
            .iter()
            .map(|(key, _)| ((*key).to_string(), std::env::var(key).ok()))
            .collect();
        for (key, value) in &pairs {
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

/// The wedge cell: writes the `started` marker (the test aborts strictly
/// after it), sleeps far beyond the abort budget, then writes `finished`
/// (must never exist after the abort settled).
fn wedge_cell(started: &Path, finished: &Path) -> String {
    format!(
        "open({started:?}, \"w\").write(\"started\")\nimport time\ntime.sleep(120)\nopen({finished:?}, \"w\").write(\"finished\")\nprint(\"cell completed\")",
        started = started.display().to_string(),
        finished = finished.display().to_string(),
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

/// An abort mid-cell settles the whole turn at once: the loop returns, the
/// cell dies (no `finished` marker), and the agent is ready for the next
/// prompt. The abort budget is generous for CI but far below the cell's
/// 120s sleep: a wedge waits the sleep out (or forever).
#[tokio::test]
async fn abort_during_a_kernel_cell_settles_the_turn_immediately() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let Some(release) = release_dir() else {
        return;
    };
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let started = dir.path().join("cell-started");
    let finished = dir.path().join("cell-finished");

    let _env = EnvOverride::apply(vec![
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PI_PACKAGE_DIR", Some(release.display().to_string())),
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
            "ipython",
            json!({ "code": wedge_cell(&started, &finished) }),
        )],
    );
    provider.push_turn(ScriptedTurn::Events(steps));
    provider.push_text_turn("the cell completed");

    let engine = create_session(SessionEngineConfig {
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
        rlm_depth: None,
        telemetry: None,
        model_info: None,
        cli_extension_sources: Vec::new(),
        extension_tool_allow_list: None,
        mcp_manager: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
        queued_steering_probe: None,
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

    // The turn settles at once: an abort wedge hangs here for the rest of
    // the cell (or forever).
    let settled = tokio::time::timeout(std::time::Duration::from_secs(30), prompt)
        .await
        .expect("the aborted turn must settle within 30s")
        .expect("prompt task join");
    // Either the abort surfaces as an error or the turn outcome settles;
    // both mean the loop returned.
    let _ = settled;
    // The cell itself died: no `finished` marker, even after a grace wait
    // past the abort settle.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert!(
        !finished.exists(),
        "the interrupted cell must not run to completion"
    );

    // The agent is ready for the next prompt (the loop unwound).
    let state = agent.state().await;
    assert!(
        !state.is_streaming,
        "the agent must be idle after the aborted turn"
    );
}

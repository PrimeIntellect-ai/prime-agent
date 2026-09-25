//! Verifier: the turn-boundary host-request contract (`model.info`,
//! `compact.*`, `refine.*`) over a REAL kernel, driven in-process through
//! `create_session` (completion-matrix family 10).
//!
//! The scripted faux provider drives one turn whose `ipython` cell calls the
//! kernel's `rlm.host_request` bridge directly — the exact surface the
//! installed `refine`/`compact` skill modules use (`rlm.host_request("<type>",
//! {...})`). The cell records the raw handler responses on disk; the test
//! asserts them against the TS contract, then checks the scheduled refinement
//! reached the turn-boundary seam the runtime consumes after the turn settles.
//!
//! The daemon-level dogfood (a daemon session's boundary consuming a
//! kernel-scheduled refinement end to end) is the documented follow-up
//! (completion-matrix family 10); this test proves the wire contract with a
//! real kernel without the daemon turn choreography.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use pa_agent::scripted::{tool_call_turn_steps, ScriptStep, ScriptedProvider, ScriptedTurn};
use pa_agent::stream::AssistantMessageEvent;
use pa_core::session::manager::SessionManager;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::turn_boundary::PendingRefine;
use pa_core::session_engine::PromptOptions;
use serde_json::{json, Value};

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
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel test");
    None
}

/// The installed release directory (ships `prime-agent-runtime/` and the
/// bundled skill packages): `PI_PACKAGE_DIR` wins, else the newest release
/// under ~/.local/share/prime-agent/releases. Skipped when absent.
fn release_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PI_PACKAGE_DIR") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.join("prime-agent-runtime").exists(),
            "PI_PACKAGE_DIR {explicit:?} has no prime-agent-runtime"
        );
        return Some(explicit);
    }
    let releases = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.local/share/prime-agent/releases".to_string(),
        |home| format!("{home}/.local/share/prime-agent/releases"),
    ));
    let Ok(entries) = std::fs::read_dir(&releases) else {
        eprintln!("no releases dir at {releases:?}; skipping live kernel test");
        return None;
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("prime-agent-runtime").is_dir() && path.join("skills").is_dir())
        .collect();
    candidates.sort();
    let Some(latest) = candidates.pop() else {
        eprintln!(
            "no release with prime-agent-runtime under {releases:?}; skipping live kernel test"
        );
        return None;
    };
    Some(latest)
}

/// Scoped process-env overrides: applied on construction, restored on drop.
/// This binary carries exactly one live-kernel test, so nothing races.
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

/// The kernel cell: the raw host requests the `refine`/`compact` skill modules
/// issue, recorded on disk for the verifier (and printed so the tool result
/// carries the same proof into the session transcript).
fn harness_cell(receipt_path: &Path) -> String {
    format!(
        "import json\nfrom rlm import host_request\npayload = {{}}\npayload[\"model_info\"] = await host_request(\"model.info\", {{}})\npayload[\"compact_status\"] = await host_request(\"compact.status\", {{}})\npayload[\"refine_status_before\"] = await host_request(\"refine.status\", {{}})\npayload[\"refine_run\"] = await host_request(\"refine.run\", {{\"instructions\": \"persist the kernel round-trip contract observation\", \"global\": True}})\npayload[\"refine_status_after\"] = await host_request(\"refine.status\", {{}})\npayload[\"compact_run\"] = await host_request(\"compact.run\", {{\"instructions\": \"keep the observation\"}})\nopen({receipt_path:?}, \"w\").write(json.dumps(payload))\nprint(\"HARNESS_CELL_OK\")",
        receipt_path = receipt_path.display().to_string(),
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

/// The turn-boundary host requests round-trip through a real kernel: the
/// registered handlers answer the `rlm.host_request` bridge with the TS
/// contract shapes, and the scheduled refinement lands on the boundary seam.
#[tokio::test]
async fn turn_boundary_host_requests_round_trip_through_a_real_kernel() {
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
    let receipt_path = dir.path().join("harness-receipt.json");

    // Hermeticity: the kernel runs on the installed runtime (PI_PACKAGE_DIR +
    // the ambient kernel venv), and no ambient agent state leaks in.
    let _env = EnvOverride::apply(vec![
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PI_PACKAGE_DIR", Some(release.display().to_string())),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);

    // A persisted session: the refine handlers register only for depth-0
    // sessions with a local harness state dir (TS `_autoRefineAllowedForSession`).
    let mut session = SessionManager::in_memory(&cwd);
    session.materialize_session_file(Some(sessions_dir));

    let model = scripted_model();
    let provider = std::sync::Arc::new(ScriptedProvider::new(model.clone()));
    // One turn: the model calls the kernel cell. Then the turn settles.
    // The scripted provider reports zero usage, but `compact.status` anchors
    // its estimate on the last assistant usage (TS `getContextUsage`), so the
    // tool-call turn carries a real one: 120 tokens.
    let mut steps = tool_call_turn_steps(
        &model,
        Some("running the harness cell"),
        vec![(
            "call-1",
            "ipython",
            json!({ "code": harness_cell(&receipt_path) }),
        )],
    );
    for step in &mut steps {
        if let ScriptStep::Event(event) = step {
            if let AssistantMessageEvent::Done { message, .. } = &mut **event {
                message.usage = pa_agent::types::Usage {
                    input: 100,
                    output: 20,
                    cache_read: 0,
                    cache_write: 0,
                    total_tokens: 120,
                    cost: Default::default(),
                };
            }
        }
    }
    provider.push_turn(ScriptedTurn::Events(steps));
    provider.push_text_turn("boundary reached");

    let engine = create_session(SessionEngineConfig {
        cron_store: None,
        queued_steering_probe: None,
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
        model_info: Some(registry_model()),
        cli_extension_sources: Vec::new(),
        extension_tool_allow_list: None,
        mcp_manager: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .expect("create_session");

    let outcome = engine
        .prompt("run the harness cell", PromptOptions::default())
        .await
        .expect("prompt");
    assert_eq!(
        outcome,
        pa_core::session_engine::PromptOutcome::Prompt,
        "the prompt must reach the model loop"
    );

    // The kernel cell recorded the raw handler responses.
    let raw = std::fs::read_to_string(&receipt_path)
        .unwrap_or_else(|_| panic!("kernel cell wrote no receipt at {}", receipt_path.display()));
    let payload: Value = serde_json::from_str(&raw).expect("receipt json");

    // model.info: the resolved model with its input modalities.
    assert_eq!(
        payload["model_info"],
        json!({ "id": "faux-1", "provider": "faux", "input": ["text"] }),
        "model_info: {}",
        payload["model_info"]
    );
    // compact.status: the usage estimate over the session, nothing scheduled.
    let compact_status = &payload["compact_status"];
    assert_eq!(compact_status["scheduled"], false, "{payload}");
    assert_eq!(compact_status["context_window"], 200_000, "{payload}");
    // The usage anchor (the faux turn's 120 tokens) with nothing trailing it.
    assert_eq!(compact_status["tokens"], 120, "{payload}");
    assert_eq!(compact_status["percent"], 0.06, "{payload}");
    // refine.status before the run: nothing pending, never in flight.
    assert_eq!(
        payload["refine_status_before"],
        json!({ "pending": false, "in_flight": false }),
        "{payload}"
    );
    // refine.run mid-turn: scheduled with the TS note.
    assert_eq!(payload["refine_run"]["scheduled"], true, "{payload}");
    assert_eq!(
        payload["refine_run"]["note"],
        "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally."
    );
    // refine.status after the run: pending until the boundary consumes it.
    assert_eq!(
        payload["refine_status_after"],
        json!({ "pending": true, "in_flight": false }),
        "{payload}"
    );
    // compact.run on the fresh session: the TS prepare skip reason.
    assert_eq!(payload["compact_run"]["scheduled"], false, "{payload}");
    assert_eq!(
        payload["compact_run"]["reason"],
        "session is too short to compact"
    );

    // The cell output entered the session transcript (the model saw the
    // same proof the receipt carries).
    let serialized = {
        let entries = engine.session.entries().await;
        serde_json::to_string(&entries).expect("entries json")
    };
    assert!(
        serialized.contains("HARNESS_CELL_OK"),
        "no kernel cell output in the session rows"
    );

    // The scheduled refinement reached the turn-boundary seam: the runtime
    // consumes exactly this request after the settled turn (the daemon
    // worker's boundary pass; unit-tested at the registry level).
    assert_eq!(
        engine.turn_boundary.take_refine().await,
        Some(PendingRefine {
            instructions: Some("persist the kernel round-trip contract observation".to_string()),
            global: true,
        })
    );
    assert!(
        engine.turn_boundary.take_refine().await.is_none(),
        "the refinement request must be consumed exactly once"
    );
    assert!(
        engine.turn_boundary.take_compaction().await.is_none(),
        "the skipped compact.run must not schedule anything"
    );
}

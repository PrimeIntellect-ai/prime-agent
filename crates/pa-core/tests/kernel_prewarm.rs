//! Verifier integration tests for the session-creation kernel prewarm (TS
//! `prewarmIpythonKernel` from `createDefaultRuntimeFactory`, gated by
//! `rlmDepth === 0` in the session):
//!
//! - a main session whose engine config requests the prewarm boots its
//!   kernel in the background at creation — observable through the
//!   `kernel bootstrap` telemetry event — so a compaction with NO `ipython`
//!   tool use still lands the `ipython_state` notice row (TS parity: the
//!   TS daemon prewarms, so its sessions always have the running kernel the
//!   post-compaction notice reads);
//! - a depth-1 (subagent) session keeps the lazy first-call start: the same
//!   config boots nothing.
//!
//! The kernel Python is ambient product state (the auto-bootstrapped kernel
//! venv); like `kernel_lifecycle.rs`, these tests skip (with a note) on
//! machines without a live install so the suite stays hermetic elsewhere.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use pa_core::session_engine::compact_session::CompactOutcome;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use pa_core::session_engine::telemetry::{build_client, TelemetryWiring};
use pa_core::session_engine::{PromptOptions, PromptOutcome};
use pa_core::settings::SettingsManager;
use pa_types::session::FileEntry;

/// The faux provider registry is process-global and both tests drive it:
/// the std lock serializes them (they are the only contenders, so holding
/// it across awaits is safe).
static FAUX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The kernel Python with prime-agent-runtime installed (the interpreter
/// the session-path provisioner resolves). Skipped (with a note) on
/// machines without a live install; set `PA_CORE_KERNEL_PYTHON` to point at
/// an explicit interpreter instead.
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
    eprintln!("kernel python {candidate:?} not found; skipping live prewarm test");
    None
}

/// One faux provider session: the model, its agent-loop shape, and the
/// stream function, with the scripted responses queued.
struct FauxSession {
    model: pa_types::ai::Model,
    stream_fn: pa_agent::stream::StreamFn,
}

fn faux_session(responses: Vec<String>) -> FauxSession {
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(100_000),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    registration.set_responses(
        responses
            .into_iter()
            .map(|text| {
                pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
                    &text,
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            })
            .collect(),
    );
    let model = registration.get_model();
    let stream_fn = real_stream_fn(None, model.clone());
    FauxSession { model, stream_fn }
}

/// The agent-loop model shape the engine config takes.
fn agent_model(model: &pa_types::ai::Model) -> pa_agent::types::Model {
    json_round_trip(model).expect("model conversion")
}

/// Every `kernel bootstrap` telemetry event flushed to the local mirror so
/// far (`<agentDir>/telemetry.jsonl`, the transparency sink).
async fn kernel_bootstrap_events(
    client: &pa_telemetry::TelemetryClient,
    agent_dir: &Path,
) -> Vec<serde_json::Value> {
    client.flush().await.expect("telemetry flush");
    let mirror = agent_dir.join("telemetry.jsonl");
    let body = std::fs::read_to_string(&mirror).unwrap_or_default();
    body.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|event| {
            event.get("name").and_then(serde_json::Value::as_str) == Some("kernel bootstrap")
        })
        .collect()
}

/// Wait for the prewarmed boot to finish: poll the telemetry mirror for the
/// `kernel bootstrap` success event (the boot is a background task, and the
/// client flushes on its interval, so both waits fold into this poll).
async fn wait_for_kernel_boot(client: &pa_telemetry::TelemetryClient, agent_dir: &Path) {
    let deadline = Instant::now() + Duration::from_mins(2);
    loop {
        let events = kernel_bootstrap_events(client, agent_dir).await;
        if events
            .iter()
            .any(|event| event["properties"]["outcome"] == "success")
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the prewarmed kernel never reported its bootstrap"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// The prewarm fires at creation (no `ipython` tool use anywhere): the
/// background boot reports through telemetry, the session's compaction sees
/// a running kernel, and the hidden `ipython_state` notice lands on the
/// durable entries — with the empty-namespace arm, because the model never
/// ran a cell.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn prewarmed_kernel_lands_compaction_notice_without_tool_use() {
    let Some(_kernel_python) = kernel_python() else {
        return;
    };
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({
            "compaction": { "enabled": true, "reserveTokens": 1000, "keepRecentTokens": 10 }
        })
        .to_string(),
    )
    .expect("settings");
    let settings = SettingsManager::create(&cwd, &agent_dir);
    let client = build_client(&settings, &agent_dir);

    // Two plain text turns (a single turn is too short for a cut) and the
    // compaction summarizer's reply; no `ipython` tool call anywhere.
    let faux = faux_session(vec![
        "history one noted".to_string(),
        "history two noted".to_string(),
        "the compaction summary".to_string(),
    ]);
    let engine = create_session(SessionEngineConfig {
        cron_store: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: agent_dir.clone(),
        model: Some(agent_model(&faux.model)),
        stream_fn: Some(faux.stream_fn),
        tools: Vec::new(),
        telemetry: Some(TelemetryWiring {
            client: client.clone(),
            execution_mode: Some("test".to_string()),
            now: None,
        }),
        prewarm_ipython_kernel: Some(true),
        ..Default::default()
    })
    .await
    .expect("create the prewarmed session");

    // The prewarm's boot, without a single ipython tool call.
    wait_for_kernel_boot(&client, &agent_dir).await;

    // Plain text turns: history for the compaction, no tool use.
    for turn in ["history turn one", "history turn two"] {
        let outcome = engine
            .prompt(turn, PromptOptions::default())
            .await
            .expect("prompt");
        assert_eq!(outcome, PromptOutcome::Prompt);
        engine.session.agent().wait_for_idle().await;
    }

    let compacted = engine
        .session
        .compact(None, &faux.model, None, None)
        .await
        .expect("compact");
    let run = match compacted {
        CompactOutcome::Ran(run) => run,
        CompactOutcome::Skipped(reason) => panic!("compaction must run, skipped: {reason}"),
    };
    let notice = run
        .ipython_state
        .expect("the prewarmed kernel must land the ipython_state notice");
    assert_eq!(notice.custom_type, "ipython_state");
    assert!(!notice.display, "the notice is never rendered");
    let pa_types::ai::UserContent::Text(content) = &notice.content else {
        panic!("the notice content is text");
    };
    assert!(content.contains("[python-state]"), "{content}");
    assert!(
        content.contains("Your Python kernel persisted through compaction"),
        "{content}"
    );
    // The live-names detail arm is environment-dependent (the bootstrap
    // pre-imports the installed Python skills as live names), so only the
    // persistence sentence is pinned here — same scoping as the battery's
    // kernel-notice differential.
    // The durable row landed on the session entries.
    let entries = engine.session.entries().await;
    assert!(
        entries.iter().any(|entry| match entry {
            FileEntry::CustomMessage { payload, .. } => {
                payload.custom_type == "ipython_state"
            }
            _ => false,
        }),
        "the notice must be durable"
    );
}

/// The TS depth gate: subagent sessions (rlmDepth > 0) keep the lazy
/// first-call start even when the runtime factory passes
/// `prewarmIpythonKernel: true` — no boot, no `kernel bootstrap` event.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn subagent_sessions_stay_lazy_despite_the_prewarm_flag() {
    let Some(_kernel_python) = kernel_python() else {
        return;
    };
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let settings = SettingsManager::create(&cwd, &agent_dir);
    let client = build_client(&settings, &agent_dir);

    let faux = faux_session(vec!["ok".to_string()]);
    let engine = create_session(SessionEngineConfig {
        cron_store: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: agent_dir.clone(),
        model: Some(agent_model(&faux.model)),
        stream_fn: Some(faux.stream_fn),
        tools: Vec::new(),
        telemetry: Some(TelemetryWiring {
            client: client.clone(),
            execution_mode: Some("test".to_string()),
            now: None,
        }),
        rlm_depth: Some(1),
        prewarm_ipython_kernel: Some(true),
        ..Default::default()
    })
    .await
    .expect("create the subagent session");

    // The depth-1 session still carries the kernel-backed `ipython` tool
    // (the lazy first-call start, just not prewarmed).
    let tool_names: Vec<String> = engine
        .session
        .agent()
        .state()
        .await
        .tools
        .iter()
        .map(|tool| tool.name().to_string())
        .collect();
    assert!(
        tool_names.iter().any(|name| name == "ipython"),
        "the subagent keeps the lazy ipython tool: {tool_names:?}"
    );

    // Long enough for a wrongly-fired prewarm to boot and report; the
    // lazy session reports nothing.
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let events = kernel_bootstrap_events(&client, &agent_dir).await;
        assert!(
            events.is_empty(),
            "a depth-1 session must not prewarm: {events:?}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

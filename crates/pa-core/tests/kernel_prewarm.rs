// The Tier-C/D ruling (fleet-uniform, 2026-09-28) - this target's own
// crate root: the same bounded-boundary disposition as src/lib.rs
// (large_futures/too_many_lines/the cast family; details there).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

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

use std::path::PathBuf;
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
        "kernel python {} not found; skipping live prewarm test",
        candidate.display()
    );
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

/// Wait for the prewarmed boot to finish (a background task): poll the
/// session's kernel provisioner until a kernel runs.
async fn wait_for_kernel_boot(engine: &pa_core::session_engine::engine::SessionEngine) {
    let deadline = Instant::now() + Duration::from_mins(2);
    loop {
        if engine
            .kernel_provisioner_weak()
            .upgrade()
            .is_some_and(|provisioner| provisioner.has_running_kernel())
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the prewarmed kernel never booted"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// The prewarm fires at creation (no `ipython` tool use anywhere): the
/// background boot completes, the session's compaction sees
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
            telemetry_enabled: None,
        }),
        prewarm_ipython_kernel: Some(true),
        ..Default::default()
    })
    .await
    .expect("create the prewarmed session");

    // The prewarm's boot, without a single ipython tool call.
    wait_for_kernel_boot(&engine).await;

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
/// `prewarmIpythonKernel: true` — no boot.
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
            telemetry_enabled: None,
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
        assert!(
            !engine
                .kernel_provisioner_weak()
                .upgrade()
                .is_some_and(|provisioner| provisioner.has_running_kernel()),
            "a depth-1 session must not prewarm"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// The live opt-out env is process-wide: the counters' switch test scrubs
/// the three override vars (the Cargo test config sets `DO_NOT_TRACK`)
/// while it runs and restores them after, serialized through its own lock.
static TELEMETRY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const TELEMETRY_ENV_VARS: [&str; 3] = ["DO_NOT_TRACK", "PI_OFFLINE", "PRIME_AGENT_TELEMETRY"];

struct CleanTelemetryEnv {
    saved: Vec<(&'static str, Option<String>)>,
    _env_lock: std::sync::MutexGuard<'static, ()>,
}

impl CleanTelemetryEnv {
    fn default() -> Self {
        // Held first: the vars may not be touched while another env test
        // runs.
        let env_lock = TELEMETRY_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let saved = TELEMETRY_ENV_VARS
            .iter()
            .map(|var| {
                let value = std::env::var(var).ok();
                std::env::remove_var(var);
                (*var, value)
            })
            .collect();
        Self {
            saved,
            _env_lock: env_lock,
        }
    }
}

impl Drop for CleanTelemetryEnv {
    fn drop(&mut self) {
        for (var, value) in self.saved.drain(..) {
            match value {
                Some(value) => std::env::set_var(var, value),
                None => std::env::remove_var(var),
            }
        }
    }
}

/// The counters' live switch is installed at the engine's creation, before
/// the MCP and kernel seams that count into them capture their handles:
/// a settings opt-out through the whole prewarm window (the boot
/// completes while telemetry is off) never records the boot, and a later
/// enable cannot send what the off period counted. Regression for the
/// pre-install-window finding: the switch used to arrive only at the
/// first-turn install, so an off-period prewarm boot counted.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn an_off_switch_at_creation_keeps_the_prewarm_window_uncounted() {
    let Some(_kernel_python) = kernel_python() else {
        return;
    };
    let _env = CleanTelemetryEnv::default();
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let mut settings = SettingsManager::create(&cwd, &agent_dir);
    // Telemetry off through the whole prewarm window.
    settings.set_telemetry_enabled(false).expect("settings off");
    let mock = std::sync::Arc::new(pa_telemetry::MockSink::new());
    let mut config = pa_telemetry::TelemetryClientConfig::new("install-1");
    config.sinks = vec![mock.clone() as std::sync::Arc<dyn pa_telemetry::TelemetrySink>];
    let client = pa_telemetry::TelemetryClient::spawn(config).expect("client");

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
            client,
            execution_mode: Some("test".to_string()),
            now: None,
            telemetry_enabled: Some(
                pa_core::session_engine::telemetry::telemetry_enabled_switch(&cwd, &agent_dir),
            ),
        }),
        prewarm_ipython_kernel: Some(true),
        ..Default::default()
    })
    .await
    .expect("create the prewarmed session");

    // The boot completes inside the off window (however the creation
    // interleaved, the switch already gated the counters).
    wait_for_kernel_boot(&engine).await;

    // A later enable must not send the off-period boot.
    settings.set_telemetry_enabled(true).expect("settings on");
    let outcome = engine
        .prompt("hello", PromptOptions::default())
        .await
        .expect("prompt");
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;
    engine
        .telemetry
        .as_ref()
        .expect("the depth-0 session installed telemetry")
        .end()
        .await
        .expect("end");

    let events = mock.events();
    let ended = events
        .iter()
        .find(|event| event.name == "agent session ended")
        .expect("the session-ended event flushed after the re-enable");
    assert_eq!(
        ended.properties.get("kernel_bootstrap_count"),
        Some(&serde_json::json!(0)),
        "the off-window prewarm boot never counted:\n{:?}",
        ended.properties
    );
}

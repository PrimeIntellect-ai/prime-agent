//! Verifier integration tests for the kernel snapshot lifecycle (TS
//! `state-snapshot.ts` + `IpythonKernelProvisioner`'s `snapshotDir` /
//! `onRestore` seams, agent-session.ts's `hasSnapshot` prewarm arm):
//!
//! - a persisted session that runs cells and ends (the dispose kernel
//!   teardown) leaves a `kernel-state.dill` snapshot in its artifact dir;
//! - a resumed session PREWARMS from the snapshot alone (the config flag
//!   stays off — only `hasSnapshot` fires the boot), so the boot lands
//!   before the first prompt and reports `cold: false` through the
//!   `kernel bootstrap` telemetry;
//! - the first `ipython` call in the resumed session sees the old
//!   variables WITHOUT re-running the setup cell — the namespace revived;
//! - the `ipython_state_restored` notice (TS `_onIpythonStateRestored`,
//!   `deliverAs: "nextTurn"`) rides the next admitted turn and lands
//!   durably, naming what came back;
//! - a fresh session without a snapshot and without the config prewarm
//!   stays lazy (no boot, no event).
//!
//! The kernel Python is ambient product state (the auto-bootstrapped
//! kernel venv); like `kernel_lifecycle.rs`, these tests skip (with a
//! note) on machines without a live install so the suite stays hermetic
//! elsewhere. `PA_CORE_KERNEL_PYTHON` points at an explicit interpreter.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use pa_ai::faux::{
    faux_assistant_message, register_faux_provider, FauxAssistantMessageOptions,
    FauxModelDefinition, FauxResponseStep, RegisterFauxProviderOptions,
};
use pa_core::session::manager::SessionManager;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use pa_core::session_engine::state_restore_notice::IPYTHON_STATE_RESTORED_CUSTOM_TYPE;
use pa_core::session_engine::telemetry::{build_client, TelemetryWiring};
use pa_core::session_engine::{PromptOptions, PromptOutcome};
use pa_core::settings::SettingsManager;
use pa_types::session::FileEntry;

/// The faux provider registry is process-global and the tests drive it:
/// the std lock serializes them (they are the only contenders, so holding
/// it across awaits is safe).
static FAUX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The kernel Python with prime-agent-runtime installed (see
/// `kernel_lifecycle.rs`); skipped with a note when absent.
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
    eprintln!("kernel python {candidate:?} not found; skipping live snapshot test");
    None
}

/// One faux provider session: the model and its stream function, with the
/// scripted responses queued.
struct FauxSession {
    model: pa_types::ai::Model,
    stream_fn: pa_agent::stream::StreamFn,
}

fn faux_session(responses: Vec<FauxResponseStep>) -> FauxSession {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        models: Some(vec![FauxModelDefinition {
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
    registration.set_responses(responses);
    let model = registration.get_model();
    let stream_fn = real_stream_fn(None, model.clone());
    FauxSession { model, stream_fn }
}

/// One assistant turn that calls the `ipython` tool with `code` (the
/// loop's tool-call shape: `StopReason::ToolUse` + a ToolCall block).
fn ipython_tool_call_step(call_id: &str, code: &str) -> FauxResponseStep {
    let message = faux_assistant_message(
        vec![pa_types::ai::AssistantContentBlock::ToolCall(
            pa_types::ai::ToolCall {
                id: call_id.to_string(),
                name: "ipython".to_string(),
                arguments: serde_json::json!({ "code": code })
                    .as_object()
                    .cloned()
                    .expect("object"),
                thought_signature: None,
                rest: Default::default(),
            },
        )],
        FauxAssistantMessageOptions {
            stop_reason: Some(pa_types::ai::StopReason::ToolUse),
            ..Default::default()
        },
    );
    FauxResponseStep::Message(message)
}

fn text_step(text: &str) -> FauxResponseStep {
    pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
        text,
        FauxAssistantMessageOptions::default(),
    ))
}

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

/// One property of a telemetry event (the payload lives under
/// `properties`).
fn event_prop<'a>(event: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    event.get("properties").and_then(|props| props.get(key))
}

/// Wait for a specific boot to report: a background task flushes the
/// `kernel bootstrap` event on the client's interval, and an agent dir can
/// already carry earlier sessions' boot events — so the wait matches on
/// the `cold` flag rather than "any event".
async fn wait_for_boot(
    client: &pa_telemetry::TelemetryClient,
    agent_dir: &Path,
    cold: bool,
) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let events = kernel_bootstrap_events(client, agent_dir).await;
        if let Some(event) = events.iter().find(|event| {
            event_prop(event, "cold").and_then(serde_json::Value::as_bool) == Some(cold)
        }) {
            return event.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the kernel never reported a cold={cold} bootstrap: {events:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The text of every `ToolResult` message the loop carries (the model-side
/// view of an ipython cell's output).
async fn tool_result_texts(engine: &pa_core::session_engine::engine::SessionEngine) -> Vec<String> {
    let state = engine.session.agent().state().await;
    state
        .messages
        .iter()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(
                result,
            )) => Some(
                result
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        pa_agent::types::ToolResultContent::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .collect()
}

/// Drive one prompt to idle and return the loop's settled messages.
async fn run_turn(engine: &pa_core::session_engine::engine::SessionEngine, text: &str) {
    let outcome = engine
        .prompt(text, PromptOptions::default())
        .await
        .expect("prompt");
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;
}

/// The session test fixtures: isolated agent dir, sessions dir, cwd, and
/// the telemetry client.
struct Fixture {
    dir: tempfile::TempDir,
    agent_dir: PathBuf,
    sessions_dir: PathBuf,
    cwd: PathBuf,
    client: pa_telemetry::TelemetryClient,
}

fn fixture() -> Fixture {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let sessions_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let settings = SettingsManager::create(&cwd, &agent_dir);
    let client = build_client(&settings, &agent_dir);
    Fixture {
        dir,
        agent_dir,
        sessions_dir,
        cwd,
        client,
    }
}

impl Fixture {
    fn engine_config(
        &self,
        session_manager: SessionManager,
        faux: &FauxSession,
    ) -> SessionEngineConfig {
        SessionEngineConfig {
            cwd: self.cwd.clone(),
            agent_dir: self.agent_dir.clone(),
            model: Some(agent_model(&faux.model)),
            stream_fn: Some(faux.stream_fn.clone()),
            tools: Vec::new(),
            session_manager: Some(session_manager),
            telemetry: Some(TelemetryWiring {
                client: self.client.clone(),
                execution_mode: Some("test".to_string()),
                now: None,
            }),
            ..Default::default()
        }
    }
}

/// The full lifecycle: a session defines kernel state and ends (dispose
/// flushes the final snapshot), a resumed session prewarms from the
/// snapshot with the config flag OFF, and its FIRST ipython call sees the
/// old namespace without re-running the setup — with the restore notice
/// riding the turn.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn session_end_then_resume_prewarms_and_revives_the_namespace() {
    let Some(_kernel_python) = kernel_python() else {
        return;
    };
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = fixture();

    // ---- Session one: define state through a real ipython cell, then end.
    let faux_one = faux_session(vec![
        ipython_tool_call_step(
            "call-setup",
            "data = {'n': 42}\nmarker = 'lane-snapshot'\nprint('setup done')",
        ),
        text_step("state defined"),
    ]);
    let session_manager = SessionManager::persisted(&fixture.cwd, &fixture.sessions_dir);
    let session_id = session_manager.get_session_id().to_string();
    let session_file = session_manager
        .get_session_file()
        .expect("persisted session file")
        .to_path_buf();
    let engine = create_session(fixture.engine_config(session_manager, &faux_one))
        .await
        .expect("create the first session");
    run_turn(&engine, "set up the data").await;
    let results = tool_result_texts(&engine).await;
    assert!(
        results.iter().any(|text| text.contains("setup done")),
        "the setup cell must have run: {results:?}"
    );
    // The session end (the daemon's dispose seam): the final snapshot flush.
    engine.dispose_kernel().await;

    // The snapshot landed in the session's artifact dir (TS
    // `snapshotPathIn(getSessionArtifactDir())`).
    let artifact_dir = fixture
        .dir
        .path()
        .join("session-artifacts")
        .join(&session_id);
    let snapshot = artifact_dir.join("kernel-state.dill");
    assert!(
        snapshot.exists(),
        "snapshot {snapshot:?} must exist after dispose"
    );
    drop(engine);

    // ---- Session two: RESUME the same session file with the prewarm
    // config flag off. Only `hasSnapshot` (the TS arm) may fire the boot.
    let faux_two = faux_session(vec![
        ipython_tool_call_step("call-read", "print(marker)"),
        text_step("read back"),
    ]);
    let resumed_manager = SessionManager::open(&fixture.cwd, &fixture.sessions_dir, &session_file);
    assert_eq!(
        resumed_manager.get_session_id(),
        session_id,
        "the resumed session keeps its identity (and artifact dir)"
    );
    let session_open = Instant::now();
    let resumed = create_session(fixture.engine_config(resumed_manager, &faux_two))
        .await
        .expect("resume the session");
    // The benchmark dimension: session-open to first-cell readiness with
    // the namespace restored — the boot (spawn + restore + bootstrap)
    // completes here, BEFORE any prompt, so the first ipython call is a
    // warm hit. `cold: false` is the revived-boot report (a snapshot
    // existed to restore).
    let restored_boot = wait_for_boot(&fixture.client, &fixture.agent_dir, false).await;
    let ready_elapsed = session_open.elapsed();
    assert_eq!(
        event_prop(&restored_boot, "outcome").and_then(serde_json::Value::as_str),
        Some("success"),
        "the restored boot must have succeeded"
    );
    // The warm-hit bound: the boot finished before this assertion ran; a
    // generous ceiling only (the sandbox may be loaded), the structural
    // claim is "ready before the first prompt", proven by the event.
    assert!(
        ready_elapsed < Duration::from_secs(60),
        "resume boot took too long: {ready_elapsed:?}"
    );

    // The first ipython call in the resumed session sees the old
    // variables WITHOUT re-running the setup cell.
    run_turn(&resumed, "read the marker back").await;
    let results = tool_result_texts(&resumed).await;
    assert!(
        results.iter().any(|text| text.contains("lane-snapshot")),
        "the resumed namespace must revive: {results:?}"
    );

    // The restore notice rode the turn and landed durably, naming what
    // came back (TS `_onIpythonStateRestored`, display row with the
    // `restored` details flag).
    let entries = resumed.session.entries().await;
    let notice = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == IPYTHON_STATE_RESTORED_CUSTOM_TYPE =>
            {
                Some(payload.clone())
            }
            _ => None,
        })
        .expect("the ipython_state_restored notice must land on the resumed session");
    let pa_types::ai::UserContent::Text(content) = &notice.content else {
        panic!("the notice content is text");
    };
    assert!(content.contains("[python-state-restored]"), "{content}");
    assert!(
        content.contains("revived from your previous session"),
        "{content}"
    );
    assert!(
        content.contains("marker"),
        "the notice names what returned: {content}"
    );
    assert_eq!(
        notice.details,
        Some(serde_json::json!({ "restored": true })),
        "the notice's details flag the revive"
    );
    assert!(notice.display, "the notice is user-visible");
    resumed.dispose_kernel().await;
}

/// The prewarm arm does not over-fire: a FRESH session (no snapshot) with
/// the config flag off stays lazy — no boot, no `kernel bootstrap` event.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn fresh_session_without_snapshot_stays_lazy_without_the_flag() {
    let Some(_kernel_python) = kernel_python() else {
        return;
    };
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = fixture();
    let faux = faux_session(vec![text_step("ok")]);
    let session_manager = SessionManager::persisted(&fixture.cwd, &fixture.sessions_dir);
    let engine = create_session(fixture.engine_config(session_manager, &faux))
        .await
        .expect("create the lazy session");

    // Long enough for a wrongly-fired prewarm to boot and report; the
    // lazy session reports nothing.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let events = kernel_bootstrap_events(&fixture.client, &fixture.agent_dir).await;
        assert!(
            events.is_empty(),
            "a fresh session without a snapshot must not prewarm: {events:?}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = engine;
}

//! Agent engine tests (moved with their concerns).
/// The faux provider registry is process-global; faux-driven tests must
/// not register concurrently (each registration replaces the queue).
#[cfg(test)]
pub(crate) static FAUX_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

use super::*;
use serde_json::Map;

// The test families: each child holds its battery and its family-local
// fixtures; the shared faux harness (the lock, admission, and the
// event-collection helpers below) stays here for every family and for
// the sibling test modules that reach them through this path.
mod abort;
mod autonomous;
mod compaction;
mod goal;
mod model_resolution;
mod quota_park;
mod rlm_children;
mod saved_context;
mod session;
mod streaming;

fn bare_engine(dir: &std::path::Path) -> AgentSessionEngine {
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap()
}

/// A settings.json with an explicit compaction reserve (the f14 battery
/// shape: `reserveTokens` set so a seeded usage crosses the headroom).
fn write_compaction_settings(dir: &std::path::Path, reserve_tokens: u64) {
    std::fs::create_dir_all(dir.join("agent")).unwrap();
    std::fs::write(
        dir.join("agent").join("settings.json"),
        serde_json::json!({ "compaction": { "enabled": true, "reserveTokens": reserve_tokens, "keepRecentTokens": 10 } })
            .to_string(),
    )
    .unwrap();
}

/// One faux-driven engine over its own tempdir (settings written before
/// the first prompt so the session build resolves them).
pub(crate) fn faux_engine_with_settings(
    script: serde_json::Value,
    reserve_tokens: u64,
) -> (AgentSessionEngine, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().unwrap();
    write_compaction_settings(dir.path(), reserve_tokens);
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    (engine, dir)
}

/// The goal-admission collector: installs the turn-end seam (a probe
/// reporting no queued input plus a sink capturing minted work) on an
/// engine built without a worker.
pub(crate) fn goal_admission_collector(
    engine: &std::sync::Arc<AgentSessionEngine>,
) -> std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> {
    let collected: std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&collected);
    engine.set_goal_admission(
        std::sync::Arc::new(|| false),
        std::sync::Arc::new(move |work| sink.lock().unwrap().push(work)),
        std::sync::Arc::new(|| {}),
    );
    collected
}

/// Admit one prompt through the engine, collecting its events.
pub(crate) fn admit(engine: &AgentSessionEngine, message: String, events: &mut Vec<EngineEvent>) {
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message,
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
}

/// The engine session's durable entry chain carries the outcome row.
pub(crate) fn outcome_row_in_entries(engine: &AgentSessionEngine) -> bool {
    let guard = engine.session.blocking_lock();
    let Some(core) = guard.as_deref() else {
        return false;
    };
    let persistence = core.session.shared_persistence();
    let entries = engine
        .runtime
        .block_on(async { persistence.lock().await.get_entries() });
    entries.iter().any(|entry| {
        matches!(entry, pa_types::session::FileEntry::CustomMessage { payload, .. }
            if payload.custom_type == "compaction_outcome")
    })
}

/// The live loop context carries the outcome row (TS
/// `agent.state.messages.push`); the loop's converter keeps it out of
/// the provider request.
pub(crate) fn outcome_row_in_live_context(engine: &AgentSessionEngine) -> bool {
    let guard = engine.session.blocking_lock();
    let Some(core) = guard.as_deref() else {
        return false;
    };
    engine.runtime.block_on(async {
        let state = core.session.agent().state().await;
        state
            .messages
            .last()
            .is_some_and(|message| message.role() == "custom")
    })
}

/// The engine session's durable entry chain carries a compaction
/// entry (an aborted run must never commit one).
pub(crate) fn compaction_entry_in_entries(engine: &AgentSessionEngine) -> bool {
    let guard = engine.session.blocking_lock();
    let Some(core) = guard.as_deref() else {
        return false;
    };
    let persistence = core.session.shared_persistence();
    let entries = engine.runtime.block_on(async {
        let snapshot = persistence.lock().await.history_snapshot();
        snapshot.await.expect("history snapshot")
    });
    entries
        .iter()
        .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. }))
}

/// Admit one prompt on a parked thread, sharing its events; `started`
/// flips on the first compaction start event so the caller can abort
/// the run mid-flight. Returns the join handle.
pub(crate) fn admit_parked(
    engine: &std::sync::Arc<AgentSessionEngine>,
    message: String,
    events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>>,
    started: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    let engine = std::sync::Arc::clone(engine);
    std::thread::spawn(move || {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message,
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                if matches!(event, EngineEvent::CompactionStart { .. }) {
                    started.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                events
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(event);
                true
            },
        );
    })
}

/// Wait until the parked admission's compaction started (a deadline
/// instead of a hang when the run never reaches the summarizer).
pub(crate) fn wait_for_compaction_start(started: &std::sync::atomic::AtomicBool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !started.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "the auto compaction never started"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// The aborted `compaction_end` event for a cancelled auto compaction:
/// `aborted` with no `errorMessage`, no `errorSeverity`, and no
/// `result` (TS `_endCompactionUnsuccessfully`'s `{ aborted: true }`).
pub(crate) fn assert_cancelled_end_event(
    events: &[EngineEvent],
    expected_reason: &str,
    expected_row_message: &str,
) {
    let row_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "compaction_outcome")
        })
        .expect("the cancelled outcome row was broadcast");
    let EngineEvent::CustomMessage(row) = &events[row_index] else {
        unreachable!("matched above");
    };
    assert_eq!(row["customType"], "compaction_outcome");
    assert_eq!(row["content"], serde_json::json!(expected_row_message));
    assert_eq!(
        row["details"],
        serde_json::json!({
            "reason": expected_reason,
            "outcome": "cancelled",
        })
    );
    assert_eq!(row["display"], serde_json::json!(true));
    let EngineEvent::Compaction { event, .. } = events
        .iter()
        .rev()
        .find(|event| {
            matches!(event, EngineEvent::Compaction { event, .. }
                if event["type"] == "compaction_end" && event["reason"] == expected_reason)
        })
        .expect("the aborted compaction_end follows the row")
    else {
        unreachable!("matched above");
    };
    assert_eq!(event["aborted"], serde_json::json!(true));
    assert_eq!(event["willRetry"], serde_json::json!(false));
    assert!(
        event.get("errorMessage").is_none(),
        "aborts carry no error message: {event}"
    );
    assert!(
        event.get("errorSeverity").is_none(),
        "aborts carry no error severity: {event}"
    );
    assert!(
        event.get("result").is_none(),
        "an aborted run has no result: {event}"
    );
}

/// A driver loop test harness: faux script + collected events. Holds the
/// faux lock while the engine runs.
#[cfg(test)]
fn run_prompts(
    script: serde_json::Value,
    prompts: &[&str],
) -> (std::sync::Arc<AgentSessionEngine>, Vec<EngineEvent>) {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let mut events: Vec<EngineEvent> = Vec::new();
    for prompt in prompts {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: prompt.to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
    }
    (engine, events)
}

/// The user rows emitted by one run (message texts in order).
#[cfg(test)]
fn user_texts(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::UserMessage(value) => Some(
                value["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
fn assistant_texts(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AssistantMessage(value) => Some(
                value["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
fn custom_rows(events: &[EngineEvent]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CustomMessage(value) => Some(value.clone()),
            _ => None,
        })
        .collect()
}

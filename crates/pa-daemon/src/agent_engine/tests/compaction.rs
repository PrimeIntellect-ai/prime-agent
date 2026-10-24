//! The compaction tests (threshold/requested/manual compaction, telemetry, the
//! durable outcome rows, the /compact command).
use super::*;

/// The faux model's per-request output budget (maxTokens `16_384` under the
/// `32_000` request cap): threshold fixtures subtract it from the window
/// alongside the headroom (the combined input+output ceiling).
const FAUX_REQUEST_BUDGET: u64 = 16_384;

/// The automatic threshold compaction at the turn boundary. The faux
/// provider estimates usage from the serialized context, so the headroom
/// sits halfway between a baseline turn and the baseline plus the big prompt.
#[test]
fn threshold_crossing_auto_compacts_with_the_event_pair() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (probe, _probe_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    assert!(
        baseline < 100_000,
        "the probe baseline is implausibly large: {baseline}"
    );
    drop(probe);

    // ~12k tokens of deterministic extra context on the crossing turn.
    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    // The headroom sits between the two turns' usage (the f14 battery
    // shape: reserveTokens so exactly the seeded crossing fires).
    let headroom = baseline + big_tokens / 2;
    let (engine, _engine_dir) = faux_engine_with_settings(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                {"text": "the summary"},
            ],
        }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );

    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    assert_eq!(
        assistant_texts(&events),
        vec!["seed reply".to_string()],
        "the seed turn answered"
    );
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
        )),
        "no compaction below the headroom"
    );
    admit(&engine, big_prompt, &mut events);
    let assistant_index = events
        .iter()
        .rposition(|event| matches!(event, EngineEvent::AssistantMessage(_)))
        .expect("assistant message emitted");
    let start_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold")
        })
        .expect("threshold compaction_start emitted");
    assert!(
        start_index > assistant_index,
        "the check fires at the settled turn boundary"
    );
    let EngineEvent::CompactionStart { event } = &events[start_index] else {
        unreachable!();
    };
    assert_eq!(
        event,
        &serde_json::json!({ "type": "compaction_start", "reason": "threshold" })
    );
    let compaction_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Compaction { .. }))
        .expect("compaction_end emitted");
    let EngineEvent::Compaction { entry, event } = &events[compaction_index] else {
        unreachable!();
    };
    assert!(compaction_index > start_index);
    assert_eq!(event["reason"], "threshold");
    assert_eq!(event["result"]["summary"], "the summary");
    assert_eq!(
        event["result"]["details"],
        serde_json::json!({ "readFiles": [], "modifiedFiles": [] })
    );
    assert!(entry["firstKeptEntryId"].is_string());
    // Exactly one pair: the pre-turn check sees no built session, the
    // post-turn check fires once.
    let start_count = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
        .count();
    let end_count = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
        .count();
    assert_eq!((start_count, end_count), (1, 1));
}

/// The compaction summarizer stays on the session's provider when a
/// fresh resolution drifts mid-session (R8). The settings default changes
/// under the built session, so `resolve_model` lands on a dead provider —
/// but the threshold arm follows `session_model`.
#[test]
fn threshold_compaction_stays_on_the_session_provider_after_a_resolution_drift() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let script = json!({
        "responses": [
            {"text": "seed reply"},
            {"text": "crossing reply"},
            {"text": "the drifted summary"},
        ],
    });
    let parsed = pa_ai::faux::script::parse_faux_script(&script).expect("faux script parses");
    let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    // The registry catalog: the faux model, and the drift model — an
    // openai-completions endpoint nothing serves, so a request fails.
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "faux": {
                    "api": "faux",
                    "baseUrl": "http://localhost:0",
                    "apiKey": "sk-faux",
                    "models": [{
                        "id": "faux-1",
                        "name": "Faux Model",
                        "contextWindow": 128_000,
                        "maxTokens": 16384,
                    }],
                },
                "drift": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-drift",
                    "models": [{
                        "id": "drift-1",
                        "name": "Drift Model",
                        "contextWindow": 128_000,
                        "maxTokens": 16384,
                    }],
                },
            }
        })
        .to_string(),
    )
    .unwrap();
    let write_settings = |default_provider: &str, default_model: &str, reserve_tokens: u64| {
        std::fs::write(
            agent_dir.join("settings.json"),
            json!({
                "defaultProvider": default_provider,
                "defaultModel": default_model,
                "compaction": {
                    "enabled": true,
                    "reserveTokens": reserve_tokens,
                    "keepRecentTokens": 10,
                },
            })
            .to_string(),
        )
        .unwrap();
    };
    let new_engine = || {
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
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
    };
    write_settings("faux", "faux-1", 1);
    let probe = new_engine();
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    assert!(baseline < 100_000, "implausible baseline: {baseline}");
    drop(probe);

    // The combined input+output ceiling sits between the two turns'
    // usage (the 16_384 output budget is part of it).
    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let reserve = 128_000u64
        .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
        .max(1);
    write_settings("faux", "faux-1", reserve);
    registration.set_responses(parsed.responses);
    let engine = new_engine();
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    assert_eq!(assistant_texts(&events), vec!["seed reply".to_string()]);
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
        )),
        "no compaction below the threshold"
    );

    // The mid-session resolution drift: the settings default changes
    // under the built session; the live model stays.
    write_settings("drift", "drift-1", reserve);
    let drifted = engine.resolve_model().expect("the drift model resolves");
    assert_eq!(
        (drifted.provider.as_str(), drifted.id.as_str()),
        ("drift", "drift-1")
    );
    let session = engine.session_model().expect("the session model resolves");
    assert_eq!(
        (session.provider.as_str(), session.id.as_str()),
        ("faux", "faux-1")
    );

    // The threshold arm compacts on the session's provider: the
    // summarizer runs through the faux provider, never the drift model.
    let calls_before_crossing = registration.call_count();
    let mut crossing_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, big_prompt, &mut crossing_events);
    let starts = crossing_events
        .iter()
        .filter(
            |event| matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold"),
        )
        .count();
    let ends = crossing_events
        .iter()
        .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
        .count();
    assert_eq!((starts, ends), (1, 1));
    let summary = crossing_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::Compaction { event, .. } => {
                event["result"]["summary"].as_str().map(str::to_string)
            }
            _ => None,
        })
        .expect("the compaction end carries the summarizer's text");
    assert_eq!(summary, "the drifted summary");
    assert_eq!(
        registration.call_count(),
        calls_before_crossing + 2,
        "the crossing turn and the summarizer ran on the session provider"
    );
    assert_eq!(
        assistant_texts(&crossing_events),
        vec!["crossing reply".to_string()]
    );
    // The summarizer followed the live target's key too (the R8
    // seam's key arm): every request carried the faux key.
    let keys = registration.received_api_keys();
    assert_eq!(keys.len() as u64, registration.call_count());
    assert!(
        keys.iter().all(|key| key.as_deref() == Some("sk-faux")),
        "every call followed the live target's key"
    );
    assert!(matches!(
        crossing_events.last(),
        Some(EngineEvent::Done(Ok(())))
    ));
}

#[test]
fn retire_clears_the_provider_target_for_the_replacement_build() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let script = json!({ "responses": [{"text": "seed reply"}] });
    let parsed = pa_ai::faux::script::parse_faux_script(&script).expect("faux script parses");
    let _registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "faux": {
                    "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-faux",
                    "models": [{
                        "id": "faux-1", "name": "Faux Model",
                        "contextWindow": 128_000, "maxTokens": 16384,
                    }],
                },
                "drift": {
                    "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-drift",
                    "models": [{
                        "id": "drift-1", "name": "Drift Model",
                        "contextWindow": 128_000, "maxTokens": 16384,
                    }],
                },
            }
        })
        .to_string(),
    )
    .unwrap();
    let write_settings = |default_provider: &str, default_model: &str| {
        std::fs::write(
            agent_dir.join("settings.json"),
            json!({
                "defaultProvider": default_provider,
                "defaultModel": default_model,
            })
            .to_string(),
        )
        .unwrap();
    };
    let new_engine = || {
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
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
    };
    write_settings("faux", "faux-1");
    let engine = new_engine();
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    let model = engine.session_model().expect("the session model resolves");
    assert_eq!(
        (model.provider.as_str(), model.id.as_str()),
        ("faux", "faux-1")
    );

    write_settings("drift", "drift-1");
    engine
        .runtime
        .block_on(async { engine.retire_session_runtime().await });
    assert!(engine
        .runtime
        .block_on(async { engine.session.lock().await.is_none() }));

    let model = engine
        .session_model()
        .expect("the replacement model resolves");
    assert_eq!(
        (model.provider.as_str(), model.id.as_str()),
        ("drift", "drift-1"),
        "the retired session's provider target must not outlive it"
    );
}

/// End the session telemetry (flushing every queued event) and read
/// one named event's properties from the transparency mirror.
fn mirror_telemetry_properties(
    engine: &AgentSessionEngine,
    dir: &std::path::Path,
    name: &str,
) -> Vec<Value> {
    {
        let guard = engine.session.blocking_lock();
        let telemetry = guard
            .as_ref()
            .and_then(|core| core.telemetry.as_ref())
            .expect("the faux engine has telemetry installed");
        engine
            .runtime
            .block_on(async { telemetry.end().await })
            .expect("telemetry end flushes");
    }
    let mirror = std::fs::read_to_string(dir.join("agent").join("telemetry.jsonl"))
        .expect("the telemetry mirror exists");
    mirror
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["name"] == name)
        .map(|event| event["properties"].clone())
        .collect()
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "release builds send to the real endpoint"
)]
fn threshold_compaction_counts_into_the_run_telemetry() {
    let _telemetry = super::telemetry_opt_in();
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (probe, _probe_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    drop(probe);

    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let (engine, dir) = faux_engine_with_settings(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                {"text": "the summary"},
            ],
        }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, big_prompt, &mut events);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::Compaction { .. })),
        "the crossing turn compacted"
    );
    let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
    assert_eq!(runs.len(), 2, "one run per admitted prompt");
    assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
    assert_eq!(
        runs[1]["compaction_count"],
        serde_json::json!(1),
        "the threshold compaction counted into the open run"
    );
    let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "release builds send to the real endpoint"
)]
fn requested_compaction_counts_into_the_run_telemetry() {
    let _telemetry = super::telemetry_opt_in();
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A tiny reserve keeps the threshold arm silent (TS reserve 1 means
    // the context must nearly fill the window).
    let (engine, dir) = faux_engine_with_settings(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "second reply"},
                {"text": "the summary"},
            ]
        }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        format!("turn one {}", "x".repeat(48_000)),
        &mut events,
    );
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine
            .runtime
            .block_on(async { core.turn_boundary.schedule_compaction(None).await });
    }
    // The second turn carries enough tokens that the keep-recent cut
    // leaves the first turn summarizable (a tiny prompt cuts past it
    // and the compaction skips as too short).
    admit(
        &engine,
        format!("turn two {}", "x".repeat(2_000)),
        &mut events,
    );
    assert!(
        events.iter().any(|event| matches!(
            event,
            EngineEvent::Compaction { event, .. } if event["reason"] == "requested"
        )),
        "the requested compaction ran"
    );
    let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
    assert_eq!(runs.len(), 2, "one run per admitted prompt");
    assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
    assert_eq!(
        runs[1]["compaction_count"],
        serde_json::json!(1),
        "the requested compaction counted into the open run"
    );
    let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
    assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "release builds send to the real endpoint"
)]
fn manual_wire_compaction_counts_into_the_run_telemetry() {
    let _telemetry = super::telemetry_opt_in();
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, dir) = faux_engine_with_settings(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "second reply"},
                {"text": "the summary"},
            ]
        }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        format!("turn one {}", "x".repeat(48_000)),
        &mut events,
    );
    admit(
        &engine,
        format!("turn two {}", "x".repeat(2_000)),
        &mut events,
    );
    let controller = std::sync::Arc::new(pa_agent::abort::AbortController::new());
    let signal = controller.signal();
    let outcome = engine.run_compaction(
        crate::engine::CompactionRequest {
            custom_instructions: None,
        },
        &signal,
    );
    assert!(
        matches!(outcome, crate::engine::CompactionOutcome::Compacted { .. }),
        "the manual compaction ran"
    );
    let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
    assert_eq!(runs.len(), 2, "one run per admitted prompt");
    assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
    assert_eq!(
        runs[1]["compaction_count"],
        serde_json::json!(1),
        "the manual wire compaction counted into the open run"
    );
    let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
    assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
}

/// The `compaction_outcome` rows an unsuccessful auto-compaction
/// records, with the indices of the disclosure pair and the end event
/// (TS `_endCompactionUnsuccessfully`).
fn outcome_row_and_end_event(
    events: &[EngineEvent],
    expected_reason: &str,
    expected_outcome: &str,
    expected_message: &str,
    expected_severity: &str,
) -> (usize, Value) {
    let row_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "compaction_outcome")
        })
        .expect("the outcome row was broadcast as a custom message");
    let row = match &events[row_index] {
        EngineEvent::CustomMessage(row) => row.clone(),
        _ => unreachable!("matched above"),
    };
    assert_eq!(row["role"], "custom", "the row is a custom message");
    assert_eq!(row["customType"], "compaction_outcome");
    assert_eq!(row["content"], serde_json::json!(expected_message));
    assert_eq!(row["display"], serde_json::json!(true));
    assert_eq!(
        row["details"],
        serde_json::json!({
            "reason": expected_reason,
            "outcome": expected_outcome,
        })
    );
    let end_index = events[row_index + 1..]
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::Compaction { event, .. } if event["type"] == "compaction_end")
        })
        .map(|offset| offset + row_index + 1)
        .expect("the settled compaction_end follows the row");
    let event = match &events[end_index] {
        EngineEvent::Compaction { event, .. } => event.clone(),
        _ => unreachable!("matched above"),
    };
    assert_eq!(event["reason"], serde_json::json!(expected_reason));
    assert_eq!(event["errorMessage"], serde_json::json!(expected_message));
    assert_eq!(event["errorSeverity"], serde_json::json!(expected_severity));
    assert_eq!(event["aborted"], serde_json::json!(false));
    assert_eq!(event["willRetry"], serde_json::json!(false));
    assert!(
        event.get("result").is_none(),
        "no result on an unsuccessful compaction"
    );
    (row_index, event)
}

#[test]
fn threshold_skip_records_the_durable_outcome_row() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (probe, _probe_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    drop(probe);

    // One big crossing turn whose only summarizable history is itself:
    // the threshold fires, and the compaction skips (too short).
    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let (engine, _engine_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": [{"text": "crossing reply"}] }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, big_prompt, &mut events);
    assert_eq!(
        assistant_texts(&events),
        vec!["crossing reply".to_string()],
        "the crossing turn answered"
    );
    let skip_message =
        "Auto-compaction skipped: Session is too short to compact — try again once it grows";
    let (row_index, _) =
        outcome_row_and_end_event(&events, "threshold", "skipped", skip_message, "warning");
    let start_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold")
        })
        .expect("threshold compaction_start emitted");
    assert!(
        row_index > start_index,
        "the disclosure pair goes out after the start event"
    );
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
    let guard = engine.session.blocking_lock();
    let core = guard.as_deref().expect("session built");
    let persistence = core.session.shared_persistence();
    let has_compaction_entry = engine.runtime.block_on(async {
        persistence
            .lock()
            .await
            .get_entries()
            .iter()
            .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. }))
    });
    assert!(
        !has_compaction_entry,
        "a skipped compaction persists no compaction entry"
    );
}

#[test]
fn requested_compaction_skip_records_the_durable_outcome_row() {
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
        faux_script: Some(
            serde_json::json!({ "responses": [{"text": "seed reply"}, {"text": "second reply"}] })
                .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "turn one".to_string(), &mut events);
    // Schedule a requested compaction (the `compact.run` write path):
    // the boundary consumes it after the next turn settles.
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine
            .runtime
            .block_on(async { core.turn_boundary.schedule_compaction(None).await });
    }
    admit(&engine, "turn two".to_string(), &mut events);
    assert_eq!(
        assistant_texts(&events),
        vec!["seed reply".to_string(), "second reply".to_string()],
        "both turns answered"
    );
    outcome_row_and_end_event(
        &events,
        "requested",
        "skipped",
        "Requested compaction skipped: Session is too short to compact — try again once it grows",
        "warning",
    );
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
}

#[test]
fn threshold_compaction_aborted_mid_run_records_the_cancelled_outcome() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (probe, _probe_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    drop(probe);

    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let (engine, _engine_dir) = faux_engine_with_settings(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                // The summarizer held in flight: the abort lands while
                // the request is open.
                {"text": "the summary", "delayMs": 30_000},
            ],
        }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );
    let engine = std::sync::Arc::new(engine);
    let mut seed_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut seed_events);
    assert!(
        !seed_events
            .iter()
            .any(|event| matches!(event, EngineEvent::CompactionStart { .. })),
        "the seed turn stays below the headroom"
    );

    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let admission = admit_parked(
        &engine,
        big_prompt,
        std::sync::Arc::clone(&events),
        std::sync::Arc::clone(&started),
    );
    wait_for_compaction_start(&started);
    engine.abort_auto_compaction();
    admission.join().expect("the aborted admission settles");

    let events = events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_cancelled_end_event(&events, "threshold", "Compaction cancelled");
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
    assert!(
        !compaction_entry_in_entries(&engine),
        "the aborted threshold compaction never commits"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::Done(Ok(())))),
        "the turn settles after the cancelled compaction"
    );
}

#[test]
fn requested_compaction_aborted_mid_run_records_the_cancelled_outcome() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A tiny reserve keeps the threshold check silent while the
    // 10-token keep-recent budget leaves the turns summarizable.
    let (engine, _engine_dir) = faux_engine_with_settings(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "second reply"},
                            {"text": "the summary", "delayMs": 30_000},
            ],
        }),
        1_000,
    );
    let engine = std::sync::Arc::new(engine);
    let mut seed_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "turn one".to_string(), &mut seed_events);
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine
            .runtime
            .block_on(async { core.turn_boundary.schedule_compaction(None).await });
    }

    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // A padded second turn keeps the cut's kept tail over the
    // 10-token keep-recent budget, leaving the first turn summarizable.
    let padded_turn_two = format!("turn two {}", "y".repeat(400));
    let admission = admit_parked(
        &engine,
        padded_turn_two,
        std::sync::Arc::clone(&events),
        std::sync::Arc::clone(&started),
    );
    wait_for_compaction_start(&started);
    let start_reason = events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find_map(|event| match event {
            EngineEvent::CompactionStart { event } => Some(event["reason"].clone()),
            _ => None,
        })
        .expect("the requested compaction_start event");
    assert_eq!(start_reason, serde_json::json!("requested"));
    engine.abort_auto_compaction();
    admission.join().expect("the aborted admission settles");

    let events = events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_cancelled_end_event(&events, "requested", "Requested compaction cancelled");
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
    assert!(
        !compaction_entry_in_entries(&engine),
        "the aborted requested compaction never commits"
    );
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        assert!(!engine
            .runtime
            .block_on(async { core.turn_boundary.compaction_scheduled().await }));
    }
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::Done(Ok(())))),
        "the turn settles after the cancelled compaction"
    );
}

#[test]
fn threshold_below_the_headroom_stays_silent() {
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
        faux_script: Some(
            serde_json::json!({ "responses": [{"text": "plain reply"}] }).to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "a small turn".to_string(),
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
    assert_eq!(assistant_texts(&events), vec!["plain reply".to_string()]);
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
        )),
        "no compaction events below the headroom"
    );
}

/// The wire events one `/compact` produced, in order.
#[cfg(test)]
fn compaction_events(events: &[EngineEvent]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CompactionStart { event } | EngineEvent::Compaction { event, .. } => {
                Some(event.clone())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn compact_session_command_emits_the_ts_event_pair_on_a_skip() {
    let (_engine, events) = run_prompts(
        &serde_json::json!({ "responses": ["unused"] }),
        &["/compact"],
    );
    // The echo row precedes the events (TS `_executeSelectedSessionCommand`
    // records it before the queue runs the command); a skip records no
    // result row.
    let rows = custom_rows(&events);
    assert_eq!(rows.len(), 1, "echo only, no result row: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
    assert_eq!(rows[0]["content"], "/compact");
    let compaction = compaction_events(&events);
    assert_eq!(compaction.len(), 2, "start + end: {compaction:?}");
    assert_eq!(
        compaction[0],
        serde_json::json!({ "type": "compaction_start", "reason": "manual" })
    );
    assert_eq!(
        compaction[1],
        serde_json::json!({
            "type": "compaction_end",
            "reason": "manual",
            "aborted": false,
            "willRetry": false,
            "errorMessage": "Session is too short to compact \u{2014} try again once it grows",
            "errorSeverity": "warning",
        })
    );
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

#[test]
fn compact_session_command_emits_the_result_on_success() {
    // Two big turns (~12k tokens each) push the history past the
    // keep-recent budget. The crossing rides the second turn's USER
    // message — a cut inside a turn would make TWO summarizer wire
    // calls (TS parity), which this single-summary script does not serve.
    let filler = "history ".repeat(6_000); // ~48k chars = ~12k tokens each
    let big_second = format!("second {}", "padded ".repeat(6_000)); // ~10.5k tokens
    let (_engine, events) = run_prompts(
        &serde_json::json!({
            "responses": [
                { "text": filler },
                { "text": filler },
                { "text": "## Summary\nthe session story" },
            ]
        }),
        &["first", &big_second, "/compact focus on the goal"],
    );
    let compaction = compaction_events(&events);
    assert_eq!(compaction.len(), 2, "{compaction:?}");
    assert_eq!(
        compaction[0],
        serde_json::json!({
            "type": "compaction_start",
            "reason": "manual",
            "customInstructions": "focus on the goal",
        })
    );
    let end = &compaction[1];
    assert_eq!(end["type"], "compaction_end");
    assert_eq!(end["reason"], "manual");
    assert_eq!(end["aborted"], false);
    assert_eq!(end["customInstructions"], "focus on the goal");
    let result = end["result"].as_object().expect("the result payload");
    assert_eq!(result["summary"], "## Summary\nthe session story");
    assert!(result["tokensBefore"].as_u64().unwrap_or_default() > 0);
    // The TS dataKeys on the wire result (the live golden,
    // `tests/goldens/compaction-live-ts.json`): summary, firstKeptEntryId,
    // tokensBefore, details — the file-op lists verbatim from the durable
    // entry, and the summarizer usage never rides the wire.
    let mut result_keys: Vec<&str> = result.keys().map(String::as_str).collect();
    result_keys.sort_unstable();
    assert_eq!(
        result_keys,
        ["details", "firstKeptEntryId", "summary", "tokensBefore"],
        "CompactionResult key set"
    );
    assert_eq!(
        result["details"],
        serde_json::json!({ "readFiles": [], "modifiedFiles": [] })
    );
    assert!(result.get("usage").is_none());
    // The durable rows stay minimal (TS's queued `/compact` catch arm
    // records no result row): the echo row is the only custom row —
    // except the kernel-dependent `ipython_state` notice, scoped out of
    // this assertion.
    let rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] != "ipython_state")
        .collect();
    assert_eq!(rows.len(), 1, "the /compact echo only: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
}

/// One faux-driven engine over its own tempdir, the test holding its registration.
fn faux_engine_with_registration(
    script: &serde_json::Value,
    reserve_tokens: u64,
) -> (
    AgentSessionEngine,
    tempfile::TempDir,
    pa_ai::faux::FauxProviderRegistration,
) {
    faux_engine_with_steering_probe(script, reserve_tokens, None)
}

/// [`faux_engine_with_registration`] with the queued-steering probe the
/// agent loop consults right before each in-run threshold hook.
fn faux_engine_with_steering_probe(
    script: &serde_json::Value,
    reserve_tokens: u64,
    queued_steering_probe: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
) -> (
    AgentSessionEngine,
    tempfile::TempDir,
    pa_ai::faux::FauxProviderRegistration,
) {
    let parsed = pa_ai::faux::script::parse_faux_script(script).expect("faux script parses");
    let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("agent")).unwrap();
    std::fs::write(
        dir.path().join("agent").join("models.json"),
        json!({
            "providers": {
                "faux": {
                    "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-faux",
                    "models": [{
                        "id": "faux-1", "name": "Faux Model",
                        "contextWindow": 128_000, "maxTokens": 16_384,
                    }],
                },
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("agent").join("settings.json"),
        json!({
            "defaultProvider": "faux", "defaultModel": "faux-1",
            "compaction": {
                "enabled": true, "reserveTokens": reserve_tokens, "keepRecentTokens": 10,
            },
        })
        .to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
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
        queued_steering_probe,
    })
    .unwrap();
    (engine, dir, registration)
}

/// The reserve landing the measured crossing usage inside the background band.
/// The band starts no lower than the retention floor (`keep + 2 * reserve`),
/// so the crossing must be large (~65k tokens) to land above it.
fn background_band_reserve(seed_usage: u64, crossing_usage: u64) -> u64 {
    (2 * (128_000 - FAUX_REQUEST_BUDGET) - seed_usage - crossing_usage) / 6
}

/// One probe engine over the prompts, returning each turn's measured usage.
fn probe_usages(prompts: &[String]) -> Vec<u64> {
    let script = serde_json::json!({
        "responses": prompts
            .iter()
            .map(|_| serde_json::json!({"text": "probe reply"}))
            .collect::<Vec<_>>(),
    });
    let (probe, _probe_dir, _probe_registration) = faux_engine_with_registration(&script, 128_000);
    let mut usages = Vec::new();
    for prompt in prompts {
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&probe, prompt.clone(), &mut events);
        let usage = events
            .iter()
            .rev()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
                _ => None,
            })
            .expect("the turn produced usage");
        usages.push(usage);
    }
    usages
}

/// Wait until the registration served `calls` requests (red-detection bound).
fn wait_for_calls(registration: &pa_ai::faux::FauxProviderRegistration, calls: u64) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while registration.call_count() < calls {
        assert!(
            std::time::Instant::now() < deadline,
            "the background summarize never started: {} calls so far",
            registration.call_count()
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn no_compaction_events(events: &[EngineEvent]) -> bool {
    !events.iter().any(|event| {
        matches!(
            event,
            EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
        )
    })
}

fn reply_step(text: &str) -> pa_ai::faux::FauxResponseStep {
    pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
        text,
        pa_ai::faux::FauxAssistantMessageOptions::default(),
    ))
}

/// Crossing the background watermark starts the summarize in the background
/// without blocking the next model request; no compaction pair fires.
#[test]
fn background_watermark_summarizes_without_blocking_the_next_turn() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _engine_dir, registration) = faux_engine_with_registration(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                {"text": "the held summary", "delayMs": 30_000},
                {"text": "next reply"},
            ]
        }),
        background_band_reserve(usages[0], usages[1]),
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    wait_for_calls(&registration, 3);
    admit(&engine, "a small next turn".to_string(), &mut events);
    assert_eq!(
        assistant_texts(&events),
        vec![
            "seed reply".to_string(),
            "crossing reply".to_string(),
            "next reply".to_string(),
        ],
        "the next model request ran while the summarizer stayed held"
    );
    assert_eq!(
        registration.call_count(),
        4,
        "the held summarizer is still the only background call"
    );
    assert!(
        no_compaction_events(&events),
        "no compaction events while the background summarize holds"
    );
    registration.unregister();
}

/// Within the reserve the boundary joins the in-flight background summary:
/// the pair commits THAT summary (exactly one summarizer call), and the
/// next turn runs clean.
#[test]
fn reserve_crossing_commits_the_in_flight_background_summary() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let filler = format!("history {}", "x".repeat(320_000));
    let crossing = format!("crossing {}", "y".repeat(48_000));
    let reserve_prompt = format!("reserve {}", "z".repeat(180_000));
    let usages = probe_usages(&["seed turn".to_string(), filler.clone()]);
    let (engine, _engine_dir, registration) = faux_engine_with_registration(
        &serde_json::json!({ "responses": [] }),
        (128_000 - FAUX_REQUEST_BUDGET - usages[1] - 6_000) / 3,
    );
    let (summarizer_started, summarizer_started_rx) = std::sync::mpsc::channel::<()>();
    let (release, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = std::sync::Arc::new(std::sync::Mutex::new(release_rx));
    let held = {
        let release_rx = std::sync::Arc::clone(&release_rx);
        move |_: &pa_types::ai::Context,
              _: Option<&pa_ai::types::StreamOptions>,
              _: u64,
              _: &pa_types::ai::Model| {
            let _ = summarizer_started.send(());
            let _ = release_rx.lock().expect("release lock").recv();
            Ok(pa_ai::faux::faux_assistant_text_message(
                "the held summary",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        }
    };
    registration.set_responses(vec![
        reply_step("seed reply"),
        reply_step("filler reply"),
        reply_step("crossing reply"),
        pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(held)),
        reply_step("reserve reply"),
        reply_step("next reply"),
    ]);
    let engine = std::sync::Arc::new(engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, filler, &mut events);
    admit(&engine, crossing, &mut events);
    summarizer_started_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("the background summarize started");
    let boundary_events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> =
        std::sync::Arc::default();
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let admission = admit_parked(
        &engine,
        reserve_prompt,
        std::sync::Arc::clone(&boundary_events),
        std::sync::Arc::clone(&started),
    );
    wait_for_compaction_start(&started);
    release.send(()).expect("the held summarizer released");
    admission.join().expect("the reserve admission settles");
    let events = boundary_events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let assistant_index = events
        .iter()
        .rposition(|event| matches!(event, EngineEvent::AssistantMessage(_)))
        .expect("the reserve turn answered");
    let start_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::CompactionStart { .. }))
        .expect("the reserve boundary emitted compaction_start");
    assert!(
        start_index > assistant_index,
        "the pair fires at the settled boundary, joining the in-flight summary"
    );
    let EngineEvent::AssistantMessage(assistant) = &events[assistant_index] else {
        unreachable!();
    };
    assert_eq!(
        assistant["content"][0]["text"],
        serde_json::json!("reserve reply")
    );
    let EngineEvent::Compaction { event, .. } = events
        .iter()
        .rev()
        .find(|event| matches!(event, EngineEvent::Compaction { .. }))
        .expect("the compaction_end event")
    else {
        unreachable!();
    };
    assert_eq!(
        event["result"]["summary"],
        serde_json::json!("the held summary")
    );
    assert_eq!(
        registration.call_count(),
        5,
        "the join committed the held summary without a second summarizer call"
    );
    let mut next_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "a small next turn".to_string(), &mut next_events);
    assert_eq!(
        assistant_texts(&next_events),
        vec!["next reply".to_string()]
    );
    assert!(
        no_compaction_events(&next_events),
        "the join relieved the context; no re-compaction follows"
    );
    registration.unregister();
}

/// A finished background summary commits at the next boundary without a
/// reserve crossing (the pressure stays in the band).
#[test]
fn a_finished_background_summary_commits_at_the_next_boundary() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _engine_dir, registration) = faux_engine_with_registration(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                {"text": "the summary"},
                {"text": "follow-up reply"},
            ]
        }),
        background_band_reserve(usages[0], usages[1]),
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    wait_for_calls(&registration, 3);
    let mut follow_events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "a small follow-up turn".to_string(),
        &mut follow_events,
    );
    let starts = follow_events
        .iter()
        .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
        .count();
    let ends = follow_events
        .iter()
        .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
        .count();
    assert_eq!(
        (starts, ends),
        (1, 1),
        "the finished background summary commits at the boundary"
    );
    let EngineEvent::Compaction { event, .. } = follow_events
        .iter()
        .rev()
        .find(|event| matches!(event, EngineEvent::Compaction { .. }))
        .expect("the compaction_end event")
    else {
        unreachable!();
    };
    assert_eq!(event["reason"], serde_json::json!("threshold"));
    assert_eq!(event["result"]["summary"], serde_json::json!("the summary"));
    assert_eq!(
        assistant_texts(&follow_events),
        vec!["follow-up reply".to_string()],
        "the boundary's turn answered"
    );
    registration.unregister();
}

/// A summarizer error in the background flight never blocks the band: the
/// boundaries stay silent and the summarize keeps retrying in the
/// background — the blocking fresh compact stays reserved for the
/// reserve crossing.
#[test]
fn a_failed_background_summarize_never_blocks_the_watermark_band() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _engine_dir, registration) = faux_engine_with_registration(
        &serde_json::json!({ "responses": [] }),
        background_band_reserve(usages[0], usages[1]),
    );
    // Every turn answers; every summarize request errors: the summarize
    // context carries no tools, the session turns do.
    let route = |context: &pa_types::ai::Context,
                 _: Option<&pa_ai::types::StreamOptions>,
                 _: u64,
                 _: &pa_types::ai::Model| {
        if context.tools.is_none() {
            Err("summarizer down".to_string())
        } else {
            Ok(pa_ai::faux::faux_assistant_text_message(
                "turn reply",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        }
    };
    registration.set_responses(vec![
        pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(route)
        );
        12
    ]);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    wait_for_calls(&registration, 3);
    let mut follow_events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "a small follow-up turn".to_string(),
        &mut follow_events,
    );
    admit(
        &engine,
        "another follow-up turn".to_string(),
        &mut follow_events,
    );
    assert_eq!(
        assistant_texts(&follow_events),
        vec!["turn reply".to_string(), "turn reply".to_string()],
        "the band's turns answer while the summarizer keeps failing"
    );
    assert!(
        no_compaction_events(&follow_events),
        "a failed background summarize never blocks the watermark band"
    );
    registration.unregister();
}

/// Arm a routed image-model target directly (the slot the boundary checks
/// read): the routed model feeds the pressure decision while the session
/// model keeps summarizing — no turn serves on it in this test.
fn arm_routed_window(engine: &AgentSessionEngine, window: u64) {
    let routed: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
        "id": "faux-routed", "name": "Faux Routed", "api": "faux", "provider": "faux",
        "baseUrl": "http://localhost:0", "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": window, "maxTokens": 16_384,
    }))
    .expect("the routed model parses");
    let route = crate::image_route::ImageRoute {
        target: pa_core::session_engine::provider_adapter::ProviderTarget {
            service_tier: None,
            api_key: engine.resolve_request_api_key(&routed),
            model: routed.clone(),
            headers: None,
        },
        agent_override: pa_agent::agent::AgentModelOverride {
            thinking_level: pa_core::session_engine::provider_adapter::map_thinking_level(
                engine.effective_thinking(),
            ),
            model: pa_core::session_engine::provider_adapter::json_round_trip(&routed)
                .expect("the routed agent model converts"),
        },
        session_target: None,
    };
    *engine
        .image_route
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(route);
}

/// The relief check follows the routed run model, not the session model: a
/// joined summary that relieves the SESSION window but leaves the routed
/// context over its own blocking threshold is discarded and re-summarized.
#[test]
fn a_routed_window_rejects_a_join_that_only_relieves_the_session_window() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Reserve 20_000 puts the session band at (51_616, 91_616] — the
    // background flight starts there — while the 64k routed window's
    // threshold sits at 27_616: the same context is Reserve on the routed
    // model, and its kept tail alone already passes the session window's
    // relief check.
    let band_prompt = format!("band turn {}", "x".repeat(260_000));
    let (engine, _engine_dir, registration) = faux_engine_with_registration(
        &serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "band reply"},
                {"text": "the join summary"},
                {"text": "the fresh summary"},
            ]
        }),
        20_000,
    );
    let engine = std::sync::Arc::new(engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    assert!(
        no_compaction_events(&events),
        "the session-window boundaries stay silent"
    );
    // The band crossing started the background summarize (the join).
    wait_for_calls(&registration, 3);
    // Arm the routed target: the boundary below measures the same context
    // against the routed window.
    arm_routed_window(&engine, 64_000);
    let mut drive_events: Vec<EngineEvent> = Vec::new();
    engine.run_auto_compaction(&|| false, &mut |event| {
        drive_events.push(event);
        true
    });
    let starts = drive_events
        .iter()
        .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
        .count();
    assert_eq!(starts, 1, "one threshold pair: {drive_events:?}");
    let EngineEvent::Compaction { event, .. } = drive_events
        .iter()
        .rev()
        .find(|event| matches!(event, EngineEvent::Compaction { .. }))
        .expect("the routed reserve crossing compacted")
    else {
        unreachable!("matched above");
    };
    assert_eq!(event["reason"], serde_json::json!("threshold"));
    assert_eq!(
        event["result"]["summary"],
        serde_json::json!("the fresh summary"),
        "the join that only relieved the session window was discarded and re-summarized"
    );
    assert_eq!(
        registration.call_count(),
        4,
        "the join summarized once and the fresh path once"
    );
    registration.unregister();
}

/// A finished background summary that would not relieve the context never
/// blocks the band: the boundary discards it and restarts the summarize
/// in the background — the blocking fresh compact stays reserved for the
/// reserve crossing.
#[test]
fn an_unrelieving_finished_background_summary_never_blocks_the_watermark_band() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _engine_dir, _replaced) = faux_engine_with_registration(
        &serde_json::json!({ "responses": [] }),
        background_band_reserve(usages[0], usages[1]),
    );
    // The script registration above is replaced by one serving both lanes,
    // with response chunks large enough that even the oversized summary
    // streams in a few deltas. Every turn answers; every summarize
    // returns a summary too big to relieve the context (the session turns
    // carry tools, the summarize context does not).
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some("faux".to_string()),
            provider: Some("faux".to_string()),
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux Model".to_string()),
                reasoning: Some(false),
                input: Some(vec![
                    pa_types::ai::ModelInput::Text,
                    pa_types::ai::ModelInput::Image,
                ]),
                cost: None,
                context_window: Some(128_000),
                max_tokens: Some(16_384),
            }]),
            token_size_min: Some(50_000),
            token_size_max: Some(50_000),
            ..Default::default()
        });
    let route = |context: &pa_types::ai::Context,
                 _: Option<&pa_ai::types::StreamOptions>,
                 _: u64,
                 _: &pa_types::ai::Model| {
        let reply = if context.tools.is_none() {
            format!("the oversized summary {}", "z".repeat(400_000))
        } else {
            "turn reply".to_string()
        };
        Ok(pa_ai::faux::faux_assistant_text_message(
            &reply,
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ))
    };
    registration.set_responses(vec![
        pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(route)
        );
        12
    ]);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    // The band's own consults (the real arm): each one resolves a finished
    // flight, and this join never relieves, so every consult discards it
    // and restarts the summarize in the background — the fourth call is
    // that restart (the two turns and the first summarize are the other
    // three), and no consult ever compacts.
    let mut consult_events: Vec<EngineEvent> = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while registration.call_count() < 4 {
        assert!(
            std::time::Instant::now() < deadline,
            "the band never restarted the discarded join: {} calls so far",
            registration.call_count()
        );
        engine.run_auto_compaction(&|| false, &mut |event| {
            consult_events.push(event);
            true
        });
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        no_compaction_events(&consult_events),
        "an unusable finished join never makes the band block"
    );
    // The restart never blocks the next turn either: the follow-up answers
    // while the restarted summarize churns in the background.
    let mut follow_events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "a small follow-up turn".to_string(),
        &mut follow_events,
    );
    assert_eq!(
        assistant_texts(&follow_events),
        vec!["turn reply".to_string()],
        "the band's turn answered without blocking"
    );
    assert!(
        no_compaction_events(&follow_events),
        "the restarted flight never blocks the band"
    );
    registration.unregister();
}

/// Stop reaches a watermark flight even after the foreground turn has settled.
#[test]
fn stop_discards_a_finished_background_summary_before_the_next_boundary() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _dir, registration) = faux_engine_with_registration(
        &json!({"responses": [
            {"text": "seed reply"}, {"text": "crossing reply"},
            {"text": "cancelled summary"}, {"text": "fresh summary", "delayMs": 30_000}
        ]}),
        background_band_reserve(usages[0], usages[1]),
    );
    let mut events = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    let model = engine.session_model().unwrap();
    // Holding this lock reproduces the active-turn lock: Stop must use its
    // independent mirror, never wait for this guard.
    let guard = engine.session.blocking_lock();
    let core = guard.as_ref().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !engine
        .runtime
        .block_on(core.session.auto_compaction_now(&model, &model, None))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "summary never became ready"
        );
        std::thread::yield_now();
    }
    let before = engine.runtime.block_on(core.session.entries());
    engine.abort_in_flight_turn();
    assert!(
        !engine
            .runtime
            .block_on(core.session.auto_compaction_now(&model, &model, None)),
        "Stop must discard the finished summary, not commit it at the next boundary"
    );
    assert_eq!(engine.runtime.block_on(core.session.entries()), before);
    wait_for_calls(&registration, 4);
    registration.unregister();
}

#[test]
fn stop_cancels_a_held_background_summary_and_allows_a_fresh_flight() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _dir, registration) = faux_engine_with_registration(
        &json!({"responses": [
            {"text": "seed reply"}, {"text": "crossing reply"},
            {"text": "cancelled summary", "delayMs": 30_000},
            {"text": "fresh summary", "delayMs": 30_000}
        ]}),
        background_band_reserve(usages[0], usages[1]),
    );
    let mut events = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    wait_for_calls(&registration, 3);
    let model = engine.session_model().unwrap();
    let guard = engine.session.blocking_lock();
    let core = guard.as_ref().unwrap();
    let before = engine.runtime.block_on(core.session.entries());
    engine.abort_in_flight_turn();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    // These explicit consults simulate a later admitted turn. Stop itself
    // only cancels; it must not schedule replacement work.
    while registration.call_count() < 4 {
        assert!(!engine
            .runtime
            .block_on(core.session.auto_compaction_now(&model, &model, None)));
        assert!(
            std::time::Instant::now() < deadline,
            "Stop left the old summarize running"
        );
        std::thread::yield_now();
    }
    assert_eq!(engine.runtime.block_on(core.session.entries()), before);
    assert!(no_compaction_events(&events));
    registration.unregister();
}

#[test]
fn stop_at_compaction_start_never_restarts_a_cancelled_background_join() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _dir, registration) = faux_engine_with_registration(
        &json!({"responses": [
            {"text": "seed reply"}, {"text": "crossing reply"},
            {"text": "cancelled summary"}, {"text": "must not request a replacement"}
        ]}),
        background_band_reserve(usages[0], usages[1]),
    );
    let mut events = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    let model = engine.session_model().unwrap();
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_ref().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !engine
            .runtime
            .block_on(core.session.auto_compaction_now(&model, &model, None))
        {
            assert!(
                std::time::Instant::now() < deadline,
                "summary never became ready"
            );
            std::thread::yield_now();
        }
    }
    let mut boundary_events = Vec::new();
    engine.run_auto_compaction(&|| false, &mut |event| {
        if matches!(event, EngineEvent::CompactionStart { .. }) {
            engine.abort_in_flight_turn();
        }
        boundary_events.push(event);
        // The emit gate already passed when Stop arrived. Cancellation must
        // reach the registered controller independently of this return value.
        true
    });
    assert_eq!(
        registration.call_count(),
        3,
        "Stop must not issue a fresh summary"
    );
    let events = compaction_events(&boundary_events);
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["aborted"], true);
    let guard = engine.session.blocking_lock();
    let entries = engine
        .runtime
        .block_on(guard.as_ref().unwrap().session.entries());
    assert!(!entries
        .iter()
        .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })));
    registration.unregister();
}

#[test]
fn stop_before_the_core_consult_does_not_start_a_replacement_flight() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let band_prompt = format!("seed turn {} crossing", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), band_prompt.clone()]);
    let (engine, _dir, registration) = faux_engine_with_registration(
        &json!({"responses": [
            {"text": "seed reply"}, {"text": "crossing reply"},
            {"text": "cancelled summary"}, {"text": "must not request a replacement"}
        ]}),
        background_band_reserve(usages[0], usages[1]),
    );
    let engine = std::sync::Arc::new(engine);
    let mut events = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, band_prompt, &mut events);
    let model = engine.session_model().unwrap();
    let guard = engine.session.blocking_lock();
    let core = guard.as_ref().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !engine
        .runtime
        .block_on(core.session.auto_compaction_now(&model, &model, None))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "summary never became ready"
        );
        std::thread::yield_now();
    }
    assert!(engine.auto_compaction_abort.lock().unwrap().is_none());
    let boundary = {
        let engine = std::sync::Arc::clone(&engine);
        std::thread::spawn(move || {
            let mut emitted = Vec::new();
            let outcome = engine.run_auto_compaction(&|| false, &mut |event| {
                emitted.push(event);
                true
            });
            (outcome, emitted)
        })
    };
    // The boundary publishes its controller before waiting for this guard.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while engine.auto_compaction_abort.lock().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "boundary never armed cancellation"
        );
        std::thread::yield_now();
    }
    engine.abort_in_flight_turn();
    drop(guard);
    let (outcome, emitted) = boundary.join().unwrap();
    assert_eq!(outcome, crate::auto_compaction::AutoCompactionRun::NotDue);
    assert!(emitted.is_empty());
    assert_eq!(registration.call_count(), 3);
    assert!(engine.auto_compaction_abort.lock().unwrap().is_none());
    // A Stop before the next boundary registered its controller is caught by
    // the worker's persisted abort flag, rather than starting a new epoch.
    // NotDue: nothing ran, so the turn loop's own abort handling settles
    // the run (Cancelled would stop the loop without the trailing Done).
    assert_eq!(
        engine.run_auto_compaction(&|| true, &mut |_| panic!("stopped boundary emitted")),
        crate::auto_compaction::AutoCompactionRun::NotDue,
    );
    assert_eq!(registration.call_count(), 3);
    assert!(engine.auto_compaction_abort.lock().unwrap().is_none());
    registration.unregister();
}

#[test]
fn threshold_crossing_inside_one_run_compacts_before_the_next_model_turn() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _dir) = faux_engine_with_settings(
        &json!({
            "responses": [
                {"text":"seed reply"},
                {"content":[{"type":"text","text":"x".repeat(80_000)}, {"type":"toolCall","id":"synthetic-call","name":"synthetic_missing_tool","arguments":{}}]},
                {"text":"history summary"},
                {"text":"prefix summary"},
                {"text":"task finished"}
            ]
        }),
        128_000 - FAUX_REQUEST_BUDGET - 20_000,
    );
    let mut events = Vec::new();
    admit(&engine, "seed".into(), &mut events);
    events.clear();
    admit(&engine, "continue task".into(), &mut events);
    let compaction = events
        .iter()
        .position(|event| matches!(event, EngineEvent::CompactionStart { .. }))
        .expect("threshold crossed inside run");
    let assistants: Vec<_> = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            matches!(event, EngineEvent::AssistantMessage(_)).then_some(index)
        })
        .collect();
    assert_eq!(assistants.len(), 2, "one tool turn and one final turn");
    assert!(
        assistants[0] < compaction && compaction < assistants[1],
        "compaction must precede the next ordinary model call"
    );
    assert_eq!(
        assistant_texts(&events).last().map(String::as_str),
        Some("task finished")
    );
}

#[test]
fn failed_mid_run_compaction_resumes_without_retrying_each_tool_round() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tool_turn = json!({"content":[{"type":"text","text":"x".repeat(80_000)}, {"type":"toolCall","id":"synthetic-call","name":"synthetic_missing_tool","arguments":{}}]});
    let (engine, _dir) = faux_engine_with_settings(
        &json!({
            "responses": [
                {"text":"seed reply"}, tool_turn,
                {"text":"", "stopReason":"error", "errorMessage":"synthetic summary failure"},
                {"text":"prefix summary"}, tool_turn,
                {"text":"task finished"}
            ]
        }),
        128_000 - FAUX_REQUEST_BUDGET - 20_000,
    );
    let mut events = Vec::new();
    admit(&engine, "seed".into(), &mut events);
    events.clear();
    admit(&engine, "continue task".into(), &mut events);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
            .count(),
        1
    );
    assert_eq!(
        assistant_texts(&events).last().map(String::as_str),
        Some("task finished")
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, EngineEvent::Done(Ok(())))));
    let core = engine.session.blocking_lock().clone().unwrap();
    let entries = engine
        .runtime
        .block_on(async { core.session.shared_persistence().lock().await.get_entries() });
    let user_prompts: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            pa_types::session::FileEntry::Message {
                message: pa_types::session::AgentMessage::User(user),
                ..
            } => Some(user.content.text()),
            _ => None,
        })
        .collect();
    assert_eq!(user_prompts, ["seed", "continue task"]);
}

/// An in-run crossing into the Background band starts the background
/// summarize without yielding the tool run: the flight's requests issue
/// during the run — before its next model turn — no compaction pair fires
/// between the tool-round assistant and the run's next assistant, and the
/// run finishes its tool turns.
#[test]
fn an_in_run_background_crossing_starts_a_flight_without_yielding_the_tool_run() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let crossing_prompt = format!("crossing {}", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), crossing_prompt.clone()]);
    let (engine, _engine_dir, registration) = faux_engine_with_registration(
        &serde_json::json!({ "responses": [] }),
        background_band_reserve(usages[0], usages[1]),
    );
    // One factory serves both lanes: session turns (tools in the context)
    // pop scripted turn messages; the background summarize (no tools in the
    // context) marks its issuance and answers with the summary. The run's
    // last turn holds its response for that mark, proving the flight
    // started before the run finished — without blocking the run on it.
    let turn_messages: std::sync::Arc<
        std::sync::Mutex<std::collections::VecDeque<pa_ai::types::AssistantMessage>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(
        [
            pa_ai::faux::faux_assistant_text_message(
                "seed reply",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
            pa_ai::faux::faux_assistant_message(
                vec![
                    pa_ai::faux::faux_text("tool turn reply"),
                    pa_ai::faux::faux_tool_call(
                        "synthetic_missing_tool",
                        &serde_json::json!({}),
                        Some("synthetic-call"),
                    ),
                ],
                pa_ai::faux::FauxAssistantMessageOptions {
                    stop_reason: Some(pa_ai::types::StopReason::ToolUse),
                    ..Default::default()
                },
            ),
            pa_ai::faux::faux_assistant_text_message(
                "task finished",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        ]
        .into(),
    ));
    let turn_calls = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let summarize_calls = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let summarize_issued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let route = {
        let turn_messages = std::sync::Arc::clone(&turn_messages);
        let turn_calls = std::sync::Arc::clone(&turn_calls);
        let summarize_calls = std::sync::Arc::clone(&summarize_calls);
        let summarize_issued = std::sync::Arc::clone(&summarize_issued);
        move |context: &pa_types::ai::Context,
              _: Option<&pa_ai::types::StreamOptions>,
              _: u64,
              _: &pa_types::ai::Model| {
            if context.tools.is_none() {
                summarize_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                summarize_issued.store(true, std::sync::atomic::Ordering::SeqCst);
                return Ok(pa_ai::faux::faux_assistant_text_message(
                    "the background summary",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ));
            }
            turn_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (reply, remaining) = {
                let mut queue = turn_messages
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let remaining = queue.len() - 1;
                (queue.pop_front(), remaining)
            };
            if remaining == 0 {
                // The run's next model turn holds its response until the
                // background flight's request issues: proving the flight
                // started before this turn answered, without blocking the
                // run on it.
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while !summarize_issued.load(std::sync::atomic::Ordering::SeqCst) {
                    if std::time::Instant::now() > deadline {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            Ok(reply.expect("a scripted turn response"))
        }
    };
    registration.set_responses(vec![
        pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(route)
        );
        10
    ]);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    events.clear();
    admit(&engine, crossing_prompt, &mut events);
    let assistants: Vec<usize> = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            matches!(event, EngineEvent::AssistantMessage(_)).then_some(index)
        })
        .collect();
    assert_eq!(
        assistant_texts(&events),
        vec!["tool turn reply".to_string(), "task finished".to_string()],
        "the tool run continued to its final turn"
    );
    assert_eq!(
        assistants.len(),
        2,
        "one tool turn and one final turn: {events:?}"
    );
    assert!(
        !events[assistants[0]..assistants[1]]
            .iter()
            .any(|event| matches!(
                event,
                EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
            )),
        "a Background crossing must not compact between the tool turn and the next model turn"
    );
    assert_eq!(
        turn_calls.load(std::sync::atomic::Ordering::SeqCst),
        3,
        "the seed turn and the crossing run's two turns"
    );
    assert!(
        summarize_calls.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "the background flight's summarize issued"
    );
    assert!(
        summarize_issued.load(std::sync::atomic::Ordering::SeqCst),
        "the summarize issued before the run's next model turn answered"
    );
    registration.unregister();
}

/// Stop landing right before the in-run threshold hook (the queued-steering
/// probe the loop consults first) must not let the hook start a background
/// summarize in the epoch Stop just opened.
#[test]
fn stop_before_the_in_run_hook_starts_no_background_summarize() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let crossing_prompt = format!("crossing {}", "x".repeat(260_000));
    let usages = probe_usages(&["seed turn".to_string(), crossing_prompt.clone()]);
    let turn_calls = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let engine_slot =
        std::sync::Arc::new(std::sync::OnceLock::<std::sync::Weak<AgentSessionEngine>>::new());
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync> = {
        let turn_calls = std::sync::Arc::clone(&turn_calls);
        let engine_slot = std::sync::Arc::clone(&engine_slot);
        let stopped = std::sync::Arc::clone(&stopped);
        std::sync::Arc::new(move || {
            // After the crossing run's tool turn: Stop arrives here.
            if turn_calls.load(std::sync::atomic::Ordering::SeqCst) == 2
                && !stopped.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                if let Some(engine) = engine_slot.get().and_then(std::sync::Weak::upgrade) {
                    engine.abort_in_flight_turn();
                }
            }
            false
        })
    };
    let (engine, _engine_dir, registration) = faux_engine_with_steering_probe(
        &serde_json::json!({ "responses": [] }),
        background_band_reserve(usages[0], usages[1]),
        Some(probe),
    );
    let engine = std::sync::Arc::new(engine);
    engine_slot.set(std::sync::Arc::downgrade(&engine)).unwrap();
    let (summarize_tx, summarize_rx) = std::sync::mpsc::channel::<()>();
    let summarize_tx = std::sync::Mutex::new(summarize_tx);
    let turn_messages = std::sync::Mutex::new(std::collections::VecDeque::from([
        pa_ai::faux::faux_assistant_text_message(
            "seed reply",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
        pa_ai::faux::faux_assistant_message(
            vec![
                pa_ai::faux::faux_text("tool turn reply"),
                pa_ai::faux::faux_tool_call(
                    "synthetic_missing_tool",
                    &serde_json::json!({}),
                    Some("synthetic-call"),
                ),
            ],
            pa_ai::faux::FauxAssistantMessageOptions {
                stop_reason: Some(pa_ai::types::StopReason::ToolUse),
                ..Default::default()
            },
        ),
    ]));
    let route = {
        let turn_calls = std::sync::Arc::clone(&turn_calls);
        move |context: &pa_types::ai::Context,
              _: Option<&pa_ai::types::StreamOptions>,
              _: u64,
              _: &pa_types::ai::Model| {
            // The background summarize carries no tools.
            if context.tools.is_none() {
                let _ = summarize_tx.lock().unwrap().send(());
                return Ok(pa_ai::faux::faux_assistant_text_message(
                    "the background summary",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ));
            }
            turn_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let reply = turn_messages.lock().unwrap().pop_front();
            Ok(reply.expect("a scripted turn response"))
        }
    };
    registration.set_responses(vec![
        pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(route)
        );
        10
    ]);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, crossing_prompt, &mut events);
    assert!(
        stopped.load(std::sync::atomic::Ordering::SeqCst),
        "Stop landed before the tool turn's hook"
    );
    assert_eq!(
        summarize_rx.recv_timeout(std::time::Duration::from_secs(2)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        "a stopped run's hook started a background summarize"
    );
    registration.unregister();
}

/// A not-due recheck after a threshold yield keeps the in-run threshold
/// machinery armed: the suppression is reserved for a summary attempt
/// that failed to commit (cursor: "Recheck mismatch disables further
/// compaction").
#[test]
fn a_not_due_recheck_keeps_threshold_checks_armed() {
    use crate::auto_compaction::AutoCompactionRun;
    assert!(
        AutoCompactionRun::NotDue.continues_threshold_checks(),
        "a not-due recheck is not a failed summary"
    );
    assert!(
        AutoCompactionRun::Compacted.continues_threshold_checks(),
        "a committed summary keeps checking"
    );
    assert!(
        !AutoCompactionRun::Ran.continues_threshold_checks(),
        "a failed or skipped summary suppresses the rest of the run"
    );
}

#[test]
fn low_custom_percentage_compacts_real_history_once_and_then_makes_progress() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, dir) = faux_engine_with_settings(
        &serde_json::json!({
            "responses": vec![serde_json::json!({"text": "short response"}); 80],
        }),
        16_384,
    );
    std::fs::write(
        dir.path().join("agent/settings.json"),
        serde_json::json!({"compaction": {
            "enabled": true, "thresholdPercent": 5,
            "reserveTokens": 16_384, "keepRecentTokens": 20_000
        }})
        .to_string(),
    )
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    engine.register_arc();
    let mut events = Vec::new();
    let mut compacted = false;
    for turn in 0..30 {
        admit(
            &engine,
            format!("turn {turn} {}", "x".repeat(12_000)),
            &mut events,
        );
        if let Some(EngineEvent::Compaction { event, entry }) = events
            .iter()
            .find(|event| matches!(event, EngineEvent::Compaction { .. }))
        {
            assert!(event["result"]["summary"]
                .as_str()
                .unwrap()
                .contains("short response"));
            assert!(entry["firstKeptEntryId"].is_string());
            compacted = true;
            break;
        }
    }
    assert!(compacted, "the 5% setting ran an actual compaction");
    let usage = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .next_back()
        .unwrap();
    assert!(
        usage < 95_232,
        "compaction occurred before the unchanged default trigger"
    );
    for turn in 0..4 {
        admit(&engine, format!("short continuation {turn}"), &mut events);
    }
    let starts = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
        .count();
    let ends = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
        .count();
    assert_eq!(
        (starts, ends),
        (1, 1),
        "short turns do not recompact retained history"
    );
    assert_eq!(
        assistant_texts(&events).last().map(String::as_str),
        Some("short response")
    );

    // The autonomous mirror shares the same live getter rather than a copied refresh.
    let mut settings =
        pa_core::settings::SettingsManager::create(dir.path(), dir.path().join("agent"));
    settings.set_compaction_threshold_percent(75.0).unwrap();
    let mirror = engine.autonomous_boundary.lock().unwrap().clone().unwrap();
    let session = mirror.session.upgrade().unwrap();
    assert_eq!(
        session.session.compaction_settings(),
        pa_core::session_engine::compaction::CompactionSettings {
            threshold_percent: 75.0,
            reserve_tokens: 16_384,
            keep_recent_tokens: 20_000,
            ..Default::default()
        }
    );
}

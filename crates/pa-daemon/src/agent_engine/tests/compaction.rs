//! The compaction tests (threshold/requested/manual compaction, telemetry, the durable outcome rows, the /compact command).
use super::*;

/// The faux model's per-request output budget (maxTokens `16_384` under the
/// `32_000` request cap): threshold fixtures subtract it from the window
/// alongside the headroom (the combined input+output ceiling).
const FAUX_REQUEST_BUDGET: u64 = 16_384;

/// The automatic threshold compaction at the turn boundary (TS
/// `_checkCompaction` threshold arm): a settled turn whose usage
/// crosses the reserve headroom emits the `compaction_start` /
/// `compaction_end` pair with the `threshold` reason, runs the
/// summarizer, and rewrites the loop context.
///
/// The faux provider estimates usage from the serialized context (the
/// f14 battery's mock-provider shape is not part of the faux script),
/// so the probe engine first measures one baseline turn's usage and the
/// threshold engine places the headroom halfway between that baseline
/// and the baseline plus the big prompt (~12k tokens of `x`s) —
/// environment-independent margins on both sides.
#[test]
fn threshold_crossing_auto_compacts_with_the_event_pair() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (system prompt included).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
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
        serde_json::json!({
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
    // The seed turn stays below the headroom: no compaction events.
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
    // The threshold-crossing turn: the settled usage fires the
    // `compaction_start`/`compaction_end` pair with the `threshold`
    // reason, after the assistant message (TS agent_end order).
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
    // The durable end event carries the entry and the client-facing
    // result with the summarizer's text (the summarizer consumed the
    // third scripted response).
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
    // The threshold event's result carries the TS dataKeys too: the
    // file-op `details` verbatim from the durable entry.
    assert_eq!(
        event["result"]["details"],
        serde_json::json!({ "readFiles": [], "modifiedFiles": [] })
    );
    assert!(entry["firstKeptEntryId"].is_string());
    // Exactly one pair for the admission: the pre-turn check on the
    // first iteration sees no built session (nothing to compact), and
    // the post-turn check fires once — no double compaction.
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
/// fresh startup-chain resolution drifts mid-session (R8): the live
/// report was a prime-inference session whose threshold
/// auto-compaction re-resolved to `amazon-bedrock` and failed with
/// "No AWS credentials available for Bedrock" while the session's
/// turns kept streaming through the target's provider. The session
/// builds on the models.json faux model; the settings default then
/// changes under it (the drift a live catalog or settings edit
/// produces), so [`AgentSessionEngine::resolve_model`] now lands on
/// a dead provider — but the threshold arm follows the session's
/// provider target ([`AgentSessionEngine::session_model`]): the
/// summarizer request still hits the faux provider and the
/// compaction succeeds instead of failing on the drift model.
#[test]
fn threshold_compaction_stays_on_the_session_provider_after_a_resolution_drift() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The session's provider: the process-global faux provider
    // (api "faux"), serving the turn replies and the summarizer.
    let script = json!({
        "responses": [
            {"text": "seed reply"},
            {"text": "crossing reply"},
            {"text": "the drifted summary"},
        ],
    });
    let parsed = pa_ai::faux::script::parse_faux_script(&script).expect("faux script parses");
    let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    // The registry catalog: the faux model the session builds on,
    // and the drift model — an openai-completions endpoint nothing
    // serves (the live R8 shape: Bedrock with no credentials), so a
    // request against it fails.
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
    // Probe: the baseline turn's total usage (the faux provider
    // estimates usage from the serialized context, system prompt
    // included) with the threshold far away.
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

    // The threshold engine: the combined input+output ceiling sits
    // between the seed turn's usage and the crossing turn's (the
    // same probe margins the sibling threshold tests use; the
    // 16_384 per-request output budget is part of the ceiling).
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

    // The mid-session resolution drift (the live R8 shape): the
    // settings default changes under the built session, so a fresh
    // startup-chain resolution lands on the dead provider while the
    // session's live model stays the provider target.
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
    // crossing turn's boundary runs the summarizer through the faux
    // provider (its queued reply is the compaction result), never
    // the dead drift model.
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
    // The crossing turn and the summarizer both served through the
    // session's provider — the drift model was never called.
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
    // seam's key arm): every request against the registration carried
    // the models.json faux key — the engine's config key is `None`,
    // so a summarizer reading the stale config key would surface as
    // a `None` entry here.
    let keys = registration.received_api_keys();
    assert_eq!(keys.len() as u64, registration.call_count());
    assert!(
        keys.iter().all(|key| key.as_deref() == Some("sk-faux")),
        "every call followed the live target's key: {keys:?}"
    );
    assert!(matches!(
        crossing_events.last(),
        Some(EngineEvent::Done(Ok(())))
    ));
}

/// Retirement clears the provider target with the session (the TS
/// replacement teardown): a demand seam before the replacement build
/// (an immediate `/compact` after the teardown) resolves the CURRENT
/// model through the pre-build `resolve_model` fallback, never the
/// retired session's target — a cwd/settings model change lands with
/// the replacement, not the stale target.
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
    // The turn builds the session and pins the provider target.
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    let model = engine.session_model().expect("the session model resolves");
    assert_eq!(
        (model.provider.as_str(), model.id.as_str()),
        ("faux", "faux-1")
    );

    // The replacement teardown retires the session while the settings
    // default moves under it (the cwd/settings change the
    // replacement carries).
    write_settings("drift", "drift-1");
    engine
        .runtime
        .block_on(async { engine.retire_session_runtime().await });
    assert!(engine
        .runtime
        .block_on(async { engine.session.lock().await.is_none() }));

    // A demand seam before the replacement build (the prewarm has not
    // rebuilt yet) resolves the CURRENT model, never the retired
    // session's target.
    let model = engine
        .session_model()
        .expect("the replacement model resolves");
    assert_eq!(
        (model.provider.as_str(), model.id.as_str()),
        ("drift", "drift-1"),
        "the retired session's provider target must not outlive it"
    );
}

/// End the session telemetry (flushing every queued event through the
/// local mirror sink) and read one named event's properties: the
/// transparency mirror is the product's own observable surface for the
/// run counters.
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

/// The threshold arm feeds the compaction telemetry seam: the crossing
/// turn's compaction counts into the open run's `compaction_count` and
/// the session total (TS `compaction_end` handling).
#[test]
fn threshold_compaction_counts_into_the_run_telemetry() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (system prompt included).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
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
        serde_json::json!({
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

/// The requested arm feeds the same seam: the boundary compaction the
/// kernel's `compact.run` scheduled counts into the open run.
#[test]
fn requested_compaction_counts_into_the_run_telemetry() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A tiny reserve keeps the threshold arm silent (TS reserve 1 means
    // the context must nearly fill the window).
    let (engine, dir) = faux_engine_with_settings(
        serde_json::json!({
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

/// The manual wire `compact` command (TS daemon-mode `compact`) feeds
/// the same seam: the compaction the `CompactionManager` runs counts
/// into the still-open run it interrupts.
#[test]
fn manual_wire_compaction_counts_into_the_run_telemetry() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, dir) = faux_engine_with_settings(
        serde_json::json!({
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
    // A second, small-but-not-tiny turn: the keep-recent cut keeps it
    // (with turn one's tiny tail it would cut past everything and the
    // compaction would skip as too short).
    admit(
        &engine,
        format!("turn two {}", "x".repeat(2_000)),
        &mut events,
    );
    // The wire `compact` command: the CompactionManager's engine call
    // (the run happens between turns, so it counts into the deferred
    // run exactly like TS `compact()` between agent runs).
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
/// within the event list (the disclosure goes out first, the end event
/// second — TS `_endCompactionUnsuccessfully`).
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

/// The threshold call site (TS `_runAutoCompaction` -> the
/// `CompactionSkippedError` arm): a threshold compaction that skips
/// records the durable `compaction_outcome` row, broadcasts its
/// message pair before the settled `compaction_end` warning, keeps it
/// in the live context, and never persists a compaction entry.
#[test]
fn threshold_skip_records_the_durable_outcome_row() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (system prompt included).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
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
        serde_json::json!({ "responses": [{"text": "crossing reply"}] }),
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
    // The engine's durable entry chain and the live context both carry
    // the row; no compaction entry was written for the skip.
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

/// The requested call site (the turn-boundary consumption): a scheduled
/// `compact.run` request that skips at consumption records the same
/// durable disclosure with the `requested` reason.
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

/// TS `_runAutoCompaction`'s aborted arm at the threshold call site: a
/// threshold compaction aborted while the summarizer is in flight
/// records the durable cancelled outcome row (`Compaction cancelled`,
/// `{threshold, cancelled}`), broadcasts the aborted `compaction_end`
/// (no error message — the row owns the disclosure), and never commits
/// a compaction entry; the turn still settles.
#[test]
fn threshold_compaction_aborted_mid_run_records_the_cancelled_outcome() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (the same shape as the
    // threshold crossing test; the headroom sits between the two
    // turns' usage).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
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
        serde_json::json!({
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

/// The aborted arm at the requested call site (the turn-boundary
/// consumption): a `compact.run` request aborted mid-summarizer
/// records the `Requested compaction cancelled` row with the
/// `requested` reason, broadcasts the aborted `compaction_end`
/// (`compaction_start` carries the run's reason), consumes the
/// pending request, and never commits.
#[test]
fn requested_compaction_aborted_mid_run_records_the_cancelled_outcome() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A tiny reserve keeps the threshold check silent (the headroom is
    // the whole window) while the 10-token keep-recent budget leaves
    // the turns summarizable for the requested run.
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "second reply"},
                // The summarizer held in flight for the abort.
                {"text": "the summary", "delayMs": 30_000},
            ],
        }),
        1_000,
    );
    let engine = std::sync::Arc::new(engine);
    let mut seed_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "turn one".to_string(), &mut seed_events);
    // Schedule a requested compaction (the `compact.run` write path):
    // the boundary consumes it after the next turn settles.
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine
            .runtime
            .block_on(async { core.turn_boundary.schedule_compaction(None).await });
    }

    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // A padded second turn keeps the cut's kept tail over the 10-token
    // keep-recent budget, leaving the first turn as summarizable
    // history for the requested run.
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
    // The pending request was consumed: no stale compaction runs at
    // the next boundary (TS `_runAutoCompaction` takes it before the
    // run).
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

/// Below the headroom nothing fires: the threshold check stays silent
/// for turns whose usage fits the default 16k reserve (a 111k headroom
/// on the 128k window).
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

/// The wire events one `/compact` produced, in order: the compaction
/// event pair around the durable rows.
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
        serde_json::json!({ "responses": ["unused"] }),
        &["/compact"],
    );
    // The echo row precedes the events (TS `_executeSelectedSessionCommand`
    // records it before the queue runs the command); a skip records no
    // result row.
    let rows = custom_rows(&events);
    assert_eq!(rows.len(), 1, "echo only, no result row: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
    assert_eq!(rows[0]["content"], "/compact");
    // The event pair: start, then the settled skip warning.
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
    // Two big turns (each ~12k tokens by the chars/4 estimate) push the
    // history past the keep-recent budget: the cut keeps the last turn,
    // the summarizer (the third queued faux response) covers the first.
    // The second turn's user message carries the crossing: the
    // keep-recent walk (the 20k default budget) must absorb its budget at
    // the USER message of the last turn — a cut inside a turn (an
    // assistant crossing) is a split-turn compaction that makes TWO
    // summarizer wire calls (TS parity), which this single-summary script
    // does not serve.
    let filler = "history ".repeat(6_000); // ~48k chars = ~12k tokens each
    let big_second = format!("second {}", "padded ".repeat(6_000)); // ~10.5k tokens
    let (_engine, events) = run_prompts(
        serde_json::json!({
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
    // records no result row): the echo row is the only custom row — except
    // the `ipython_state` notice, which follows the compaction whenever the
    // session's prewarmed kernel finished booting on this machine in time
    // (kernel-dependent, so it is scoped out of this assertion).
    let rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] != "ipython_state")
        .collect();
    assert_eq!(rows.len(), 1, "the /compact echo only: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
}

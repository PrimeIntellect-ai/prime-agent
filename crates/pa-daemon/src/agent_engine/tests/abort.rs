//! The abort tests (the in-flight cancel, settled-turn payloads, retries, the live-kernel cancel).
use super::*;

/// The eager turn abort (TS `requestAbort`'s closing `this.agent.abort()`):
/// an abort that lands while the provider response is pending — the
/// compaction flow's interrupt-and-settle wait, the `abort` command, kill,
/// shutdown — cancels the in-flight fetch immediately instead of at the
/// next streamed event. The turn settles on its aborted message with
/// `EMPTY_USAGE` (TS `createAbortedAssistantMessage` with no partial), so the
/// aborted turn's usage never reaches the goal accounting.
#[test]
fn abort_in_flight_turn_cancels_a_mid_provider_wait() {
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
            json!({
                "engine": "faux",
                "responses": [{ "text": "held reply", "delayMs": 60000 }],
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let turn_engine = std::sync::Arc::clone(&engine);
    let turn_events = std::sync::Arc::clone(&events);
    let turn = std::thread::spawn(move || {
        turn_engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "hello".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                turn_events.lock().unwrap().push(event);
                true
            },
        );
    });
    // Wait until the turn is live (the agent run started) so the abort
    // lands mid-provider-wait, the window TS's requestAbort owns.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let agent = engine.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            let state = engine.runtime.block_on(agent.state());
            if state.is_streaming {
                break;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the turn never started streaming"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let started = std::time::Instant::now();
    engine.abort_in_flight_turn();
    // The fetch cancels now (TS aborts the fetch, not the next event): the
    // turn settles far inside the 60s hold.
    let (settled_tx, settled_rx) = std::sync::mpsc::channel::<()>();
    let waiter = std::thread::spawn(move || {
        turn.join().unwrap();
        let _ = settled_tx.send(());
    });
    settled_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the aborted turn settles immediately, not after the 60s hold");
    waiter.join().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    // The aborted turn settles on the aborted message with EMPTY usage —
    // the accounting input the goal accounting's aborted guard sees, so
    // the aborted turn's usage is not counted (TS parity).
    let events = events.lock().unwrap();
    let assistant = events
        .iter()
        .rev()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => Some(message.clone()),
            _ => None,
        })
        .expect("an assistant message settled");
    assert_eq!(assistant["stopReason"], json!("aborted"));
    assert_eq!(assistant["errorMessage"], json!("Request was aborted"));
    assert_eq!(assistant["usage"]["totalTokens"], json!(0));
    assert_eq!(assistant["usage"]["input"], json!(0));
    assert_eq!(assistant["usage"]["output"], json!(0));
    // The terminal `turn_end` frame follows the aborted row's message
    // pair (TS `turn_end` on an aborted turn): the aborted assistant
    // message is the payload, the tool-result list is empty, and the
    // frame precedes the trailing `DoneAborted` settle.
    let turn_end_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::TurnEnd { message, .. }
                if message["stopReason"] == json!("aborted"))
        })
        .expect("the aborted turn's turn_end event");
    let EngineEvent::TurnEnd {
        message,
        tool_results,
    } = &events[turn_end_index]
    else {
        unreachable!();
    };
    assert_eq!(message, &assistant, "the aborted row is the payload");
    assert!(tool_results.is_empty(), "the aborted turn ran no tools");
    // The run's terminal settle is the structural aborted one
    // (`DoneAborted`, the #2617 typed-settles rework): TS classifies the
    // aborted settle structurally — an abort is not a failure, so the
    // retry backoff never applies and the wire keeps its own
    // `turn_end`/`agent_end` frames — not the generic `Done` variant this
    // pin predates.
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::DoneAborted))
        .expect("the run's trailing DoneAborted settle");
    assert!(turn_end_index < done_index, "turn_end precedes the settle");
    // The aborted run still ends with its `agent_end` (TS emits it on the
    // abort paths): the payload carries the run's whole message set with
    // the aborted row as the terminal message.
    let agent_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentEnd { .. }))
        .expect("the aborted run's agent_end event");
    assert!(
        turn_end_index < agent_end_index && agent_end_index < done_index,
        "agent_end sits between the turn_end and the DoneAborted settle: {events:?}"
    );
    let EngineEvent::AgentEnd { messages } = &events[agent_end_index] else {
        unreachable!();
    };
    assert!(
        messages
            .iter()
            .any(|message| message["stopReason"] == json!("aborted")),
        "the aborted row rides the agent_end payload: {messages:?}"
    );
}

/// The abort-and-send idle race's engine seam (the gate-pool lane's solo
/// finding, reproduced at rate): an abort landing after the delivery's
/// pickup but before the agent run registers — the lazy session build and
/// the policy reads widened TS's microscopic registration gap to the whole
/// admission prefix — was entirely lost: `abort_in_flight_turn`'s
/// `agent.abort()` found an empty run slot, the run registered fresh after
/// it, and the turn ran its full provider hold (the session never went
/// idle after the abort). The delivery's cancel flag (the worker's
/// probe, armed by the abort after the pickup's clear) is consulted at
/// the model-turn admission: the turn settles aborted BEFORE the provider
/// call, no run registers, and the scripted response survives untouched —
/// the next delivery serves it as its first reply (the served-path
/// proof).
#[test]
fn abort_racing_the_admission_prefix_settles_the_turn_before_the_provider_call() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": ["raced reply", "next reply"] }),
        1,
    );
    // The racing abort, pinned exactly as the race arms it: the probe
    // reads the delivery's cancel flag TRUE at the model-turn admission
    // (cleared at the pickup, armed by the abort before the consult).
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "held turn for the racing abort".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| true,
        &mut |event| {
            events.push(event);
            true
        },
    );
    // The accepted row persists; the turn settles the structural aborted
    // (never a failure the retry backoff would re-issue).
    assert!(
        matches!(&events[0], EngineEvent::UserMessage(_)),
        "the accepted row leads: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::DoneAborted)),
        "the raced turn settles aborted: {events:?}"
    );
    // No run registered, so no assistant row ever streamed and no
    // turn/agent boundary frames fired (the worker's settle synthesizes
    // its own trailing `agent_end` fallback for runs without a model
    // turn).
    assert!(
        events.iter().all(|event| !matches!(
            event,
            EngineEvent::AssistantMessage(_) | EngineEvent::AssistantUpdate { .. }
        )),
        "no assistant row streamed (the provider call never started): {events:?}"
    );
    assert!(
        events.iter().all(|event| !matches!(
            event,
            EngineEvent::TurnEnd { .. } | EngineEvent::AgentEnd { .. }
        )),
        "no run boundary frames (no run registered): {events:?}"
    );
    // The served-path proof: the scripted response was never consumed —
    // the next delivery receives it as its first reply.
    let mut next_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "the next turn".to_string(), &mut next_events);
    assert!(
        next_events.iter().any(|event| matches!(
            event,
            EngineEvent::AssistantMessage(message)
                if message["content"]
                    == serde_json::json!([{ "type": "text", "text": "raced reply" }])
        )),
        "the untouched first response served the next delivery: {next_events:?}"
    );
}

/// The settled turn's terminal frame (TS `turn_end`): the loop's boundary
/// event carries the final assistant message as its payload with the
/// turn's (empty) tool-result list, positioned between the final
/// `AssistantMessage` and the trailing `Done` — the worker frames it as
/// the wire `turn_end` with the TS shape.
#[test]
fn settled_turn_emits_the_terminal_turn_end_payload() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": [{"text": "settled reply"}] }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "plain turn".to_string(), &mut events);
    let assistant_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::AssistantMessage(message) if message["content"] == json!([{ "type": "text", "text": "settled reply" }]))
        })
        .expect("the settled assistant message");
    let turn_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .expect("the settled turn's turn_end event");
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Done(_)))
        .expect("the trailing Done");
    assert!(
        assistant_index < turn_end_index && turn_end_index < done_index,
        "turn_end sits between the final message and the Done: {events:?}"
    );
    let EngineEvent::TurnEnd {
        message,
        tool_results,
    } = &events[turn_end_index]
    else {
        unreachable!();
    };
    let EngineEvent::AssistantMessage(assistant) = &events[assistant_index] else {
        unreachable!();
    };
    assert_eq!(message, assistant, "the terminal message is the payload");
    assert!(tool_results.is_empty(), "the text-only turn ran no tools");
}

/// The run's terminal frame (TS `agent_end`): the loop's run-end event
/// carries the run's whole message set — the accepted user row and the
/// settled assistant row, in the session wire shapes — positioned after
/// the terminal `turn_end` and before the trailing `Done`. The worker
/// frames it as the wire `agent_end` with the TS `messages` payload; the
/// run-opening `agent_start` stays with the worker's own opening frames,
/// so the engine forwards none for the item's first run.
#[test]
fn settled_turn_emits_the_run_agent_end_payload() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        &serde_json::json!({ "responses": [{"text": "settled reply"}] }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "plain turn".to_string(), &mut events);
    let turn_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .expect("the settled turn's turn_end event");
    let agent_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentEnd { .. }))
        .expect("the run's agent_end event");
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Done(_)))
        .expect("the trailing Done");
    assert!(
        turn_end_index < agent_end_index && agent_end_index < done_index,
        "agent_end sits between the turn_end and the Done: {events:?}"
    );
    let EngineEvent::AgentEnd { messages } = &events[agent_end_index] else {
        unreachable!();
    };
    let roles = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["custom", "user", "assistant"],
        "the run's message set (the deferred harness digest rides first)"
    );
    assert_eq!(
        messages[0]["customType"],
        json!("harness_digest"),
        "the deferred digest row is the run's first message"
    );
    assert_eq!(
        messages[1]["content"],
        json!([{ "type": "text", "text": "plain turn" }]),
        "the accepted user row rides the payload"
    );
    assert_eq!(
        messages[2]["content"],
        json!([{ "type": "text", "text": "settled reply" }]),
        "the settled assistant row rides the payload"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::AgentStart)),
        "the first run's agent_start stays with the worker's opening frames: {events:?}"
    );
}

/// One `agent_end` per agent run (TS emits per run, so a retried run
/// restarts with its own frames): a retryable provider failure ends the
/// first run with its whole message set — the user row and the failed
/// assistant row — then the retry re-issues as a new run whose `agent_end`
/// carries only the retry's messages (the failed row left the loop
/// context first, TS `messages.slice(0, -1)`). The retry run's opening
/// `agent_start` and `turn_start` forward — a boundary frame (the first
/// run's `agent_end`) already passed in the item.
#[test]
fn retried_run_restarts_with_its_own_agent_frames() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("agent")).unwrap();
    std::fs::write(
        dir.path().join("agent").join("settings.json"),
        serde_json::json!({
            "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 },
            "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 10 }
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
        faux_script: Some(
            serde_json::json!({
                "responses": [
                    { "stopReason": "error", "errorMessage": "faux provider overloaded" },
                    { "text": "recovered reply" },
                ]
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "retried turn".to_string(), &mut events);
    let agent_end_indexes = events
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event, EngineEvent::AgentEnd { .. }))
        .map(|(index, _)| index)
        .collect::<Vec<usize>>();
    assert_eq!(
        agent_end_indexes.len(),
        2,
        "one agent_end per run: {events:?}"
    );
    let EngineEvent::AgentEnd { messages: first } = &events[agent_end_indexes[0]] else {
        unreachable!();
    };
    let roles = first
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["custom", "user", "assistant"],
        "the failed run's message set (the digest row rides first)"
    );
    assert_eq!(
        first[2]["stopReason"],
        json!("error"),
        "the failed run ends on the error row"
    );
    let EngineEvent::AgentEnd { messages: second } = &events[agent_end_indexes[1]] else {
        unreachable!();
    };
    let roles = second
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["assistant"],
        "the retried run carries only its own messages: {events:?}"
    );
    assert_eq!(
        second[0]["content"],
        json!([{ "type": "text", "text": "recovered reply" }]),
        "the retried run's settled row"
    );
    // The retry run restarted with its own opening frames: the forwarded
    // `agent_start` and `turn_start` both follow the first run's
    // `agent_end`.
    let agent_start_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentStart))
        .expect("the retry run's agent_start forwarded");
    assert!(
        agent_start_index > agent_end_indexes[0],
        "the retry run's agent_start follows the failed run's agent_end: {events:?}"
    );
    let retry_turn_start_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnStart))
        .expect("the retry run's turn_start forwarded");
    assert!(
        agent_start_index < retry_turn_start_index && retry_turn_start_index < agent_end_indexes[1],
        "the retry run's turn_start sits between its agent_start and agent_end: {events:?}"
    );
    // The retry itself surfaced on the events between the two runs.
    let auto_retry_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AutoRetryStart { .. }))
        .expect("the retry start event");
    assert!(
        agent_end_indexes[0] < auto_retry_index && auto_retry_index < agent_start_index,
        "the retry start sits between the two runs: {events:?}"
    );
}

/// Scoped process-env overrides for the live-kernel tests: applied on
/// construction, restored on drop. The live-kernel tests are serialized by
/// the faux lock, so nothing races.
#[cfg(test)]
struct KernelEnvOverride {
    saved: Vec<(String, Option<String>)>,
}

#[cfg(test)]
impl KernelEnvOverride {
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
        KernelEnvOverride { saved }
    }
}

#[cfg(test)]
impl Drop for KernelEnvOverride {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// The kernel python for the live-kernel abort test (skipped without a live
/// install).
#[cfg(test)]
fn live_kernel_python() -> Option<std::path::PathBuf> {
    let candidate = std::path::PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel test");
    None
}

#[cfg(test)]
fn live_release_dir() -> Option<std::path::PathBuf> {
    let releases = std::path::PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.local/share/prime-agent/releases".to_string(),
        |home| format!("{home}/.local/share/prime-agent/releases"),
    ));
    let Ok(entries) = std::fs::read_dir(&releases) else {
        eprintln!("no releases dir at {releases:?}; skipping live kernel test");
        return None;
    };
    let mut candidates: Vec<std::path::PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("prime-agent-runtime").is_dir())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// The abort wedge repro (dogfood P0): a turn executing a long kernel cell
/// must unwind at `abort_in_flight_turn` (the kernel interrupt +
/// force-abort path settles the tool race) - not keep the turn alive while
/// the cell runs out. Red: the run thread wedged past the cell's sleep
/// (the daemon worker's `run_turn_once` awaits the admission forever).
#[test]
fn abort_in_flight_turn_cancels_a_running_kernel_cell() {
    let Some(kernel_python) = live_kernel_python() else {
        return;
    };
    let Some(release) = live_release_dir() else {
        return;
    };
    let _env = KernelEnvOverride::apply(&[
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PI_PACKAGE_DIR", Some(release.display().to_string())),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);
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
            json!({
                "engine": "faux",
                "modelId": "faux-1",
                "modelName": "Faux",
                "reasoning": false,
                "contextWindow": 128_000,
                "tokensPerSecond": 30,
                "responses": [
                    {"content": [
                        {"type": "text", "text": "Running the wedge cell."},
                        {"type": "toolCall", "name": "ipython", "id": "toolu_wedge01",
                         "arguments": {"code":
                            "import time\nopen('wedge-started', 'w').write('1')\ntime.sleep(300)\nopen('wedge-finished', 'w').write('1')\nprint('cell completed')"}}
                    ]},
                    {"content": [{"type": "text", "text": "The cell completed."}]}
                ]
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    engine.register_arc();
    let marker = dir.path().join("wedge-started");
    let finished = dir.path().join("wedge-finished");
    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let runner = {
        let engine = std::sync::Arc::clone(&engine);
        let events = std::sync::Arc::clone(&events);
        std::thread::spawn(move || {
            let events = events;
            engine.run_prompt(
                0,
                PromptRequest {
                    batch: Vec::new(),
                    images: Vec::new(),
                    message: "run the wedge cell".to_string(),
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: None,
                },
                &|| false,
                &mut move |event: EngineEvent| {
                    events.lock().unwrap().push(event);
                    true
                },
            );
        })
    };
    // The cell started (bounded by the kernel boot).
    let deadline = std::time::Instant::now() + std::time::Duration::from_mins(3);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !marker.exists() {
        let events = events.lock().unwrap();
        let wire: Vec<String> = events.iter().map(|event| format!("{event:?}")).collect();
        panic!("the wedge cell never started; events: {wire:?}");
    }
    // Abort strictly mid-cell; the run must settle within the budget.
    engine.abort_in_flight_turn();
    let settled = runner.join();
    match settled {
        Ok(()) => {}
        Err(payload) => std::panic::resume_unwind(payload),
    }
    // The cell died: the finish marker never appears.
    std::thread::sleep(std::time::Duration::from_secs(3));
    assert!(
        !finished.exists(),
        "the interrupted cell must not run to completion"
    );
}

//! The wire broadcast family: the custom-row replacement, the
//! agent-message row, the per-run `agent_end` broadcast (and its bare
//! fallback).
use super::*;

/// A turn that settles without a model turn: only the trailing `Done`
/// reaches the worker, so the run closes on the bare fallback frames.
struct DoneOnlyEngine;

impl SessionEngine for DoneOnlyEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        emit(EngineEvent::Done(Ok(())));
    }

    fn run_side_question(
        &self,
        _request: SideQuestionRequest,
        _signal: &pa_agent::abort::AbortSignal,
        _sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        SideQuestionOutcome::Failed {
            answer: String::new(),
            error: "unsupported".to_string(),
        }
    }

    fn run_compaction(
        &self,
        _request: CompactionRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        CompactionOutcome::Skipped {
            message: "nothing to compact".to_string(),
        }
    }

    fn run_branch_summary(
        &self,
        _request: crate::engine::BranchSummaryRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        crate::engine::BranchSummaryOutcome::Failed {
            error: "unsupported".to_string(),
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }
}

/// Run one scripted turn and return its session-event frames, with
/// the queued item carrying an injected custom row.
async fn turn_session_events_with_custom_message(
    engine: Arc<dyn SessionEngine>,
    custom_message: Value,
) -> Vec<Value> {
    let runner = burst_runner(Arc::clone(&engine));
    let mut subscription = runner.events.subscribe();
    runner
        .run_turn(
            engine,
            vec![QueuedItem {
                priority: QueuePriority::Background,
                preview: None,
                message: "[child-exited: no-reply child:lane]".to_string(),
                custom_message: Some(custom_message),
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            }],
        )
        .await;
    let mut events = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                events.push(outbound["event"].clone());
            }
        }
    }
    events
}

#[tokio::test]
async fn an_injected_custom_turn_replaces_the_user_row() {
    let engine = Arc::new(
        ScriptedEngine::from_value(&json!({
            "responses": ["notice acknowledged"],
        }))
        .unwrap_or_default(),
    );
    let custom = json!({
        "role": "custom",
        "customType": "rlm_child_terminal_notice",
        "content": "[child-exited: no-reply child:lane]",
        "display": true,
        "details": {
            "kind": "completed_without_reply",
            "childId": "sub-1",
            "sessionName": "lane",
        },
    });
    let events = turn_session_events_with_custom_message(engine, custom).await;

    let starts = positions_of(&events, "message_start");
    let ends = positions_of(&events, "message_end");
    // The scripted assistant reply opens as a `message_update` (the harness
    // carries no provider `start` stream event), so exactly one start is
    // on the wire.
    assert_eq!(starts.len(), 1, "only the custom row opens a start");
    assert_eq!(
        ends.len(),
        2,
        "the custom row and the assistant reply settle"
    );
    assert_eq!(events[starts[0]]["message"]["role"], "custom");
    assert_eq!(
        events[starts[0]]["message"]["customType"],
        "rlm_child_terminal_notice"
    );
    let user_rows = events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("message_start")
            && event["message"]["role"] == "user"
    });
    assert!(!user_rows, "the injected turn must not emit a user row");
    assert_eq!(events[ends[1]]["message"]["role"], "assistant");
    assert_eq!(events[ends[1]]["message"]["content"], "notice acknowledged");
}

#[tokio::test]
async fn a_delivered_agent_message_turn_emits_the_custom_row() {
    let dir = std::env::temp_dir().join(format!("pa-worker-amw-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // A busy session parks the delivery on the steering lane, so the queued
    // item is exactly what the served runner would pop.
    worker.core.lock().unwrap().busy = true;
    let delivered = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "the research is done",
                "sender": {
                    "activeSessionId": "source-session",
                    "sessionName": "research-lane",
                    "runtimeKind": "subagent",
                    // The child label derives from this parent edge,
                    // never the runtime kind alone.
                    "parentActiveSessionId": "target-session",
                },
            }),
        )
        .await;
    assert!(delivered.success, "deliver failed: {delivered:?}");
    let item = worker
        .core
        .lock()
        .unwrap()
        .steering
        .pop_front()
        .expect("the delivery parked on the steering lane");
    let engine: Arc<dyn SessionEngine> =
        Arc::new(ScriptedEngine::from_value(&json!({ "responses": ["ack"] })).unwrap_or_default());
    let runner = burst_runner(Arc::clone(&engine));
    let mut subscription = runner.events.subscribe();
    runner.run_turn(engine, vec![item]).await;
    let mut events = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                events.push(outbound["event"].clone());
            }
        }
    }
    let starts = positions_of(&events, "message_start");
    assert_eq!(
        starts.len(),
        1,
        "only the custom row opens a start: {events:?}"
    );
    assert_eq!(events[starts[0]]["message"]["role"], "custom");
    assert_eq!(events[starts[0]]["message"]["customType"], "agent_message");
    assert_eq!(
        events[starts[0]]["message"]["content"],
        "[agent-message from child:research-lane]\n\nthe research is done"
    );
    let user_rows = events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("message_start")
            && event["message"]["role"] == "user"
    });
    assert!(!user_rows, "the delivered turn must not emit a user row");
    let ends = positions_of(&events, "message_end");
    assert_eq!(ends.len(), 2, "the custom row and the reply settle");
    assert_eq!(events[ends[1]]["message"]["role"], "assistant");
}

/// TS emits one `agent_end` per agent run; the worker's trailing fallback stays silent.
#[tokio::test]
async fn a_settled_turn_broadcasts_the_engine_agent_end_with_its_messages() {
    let engine = Arc::new(
        ScriptedEngine::from_value(&json!({ "responses": ["settled reply"] })).unwrap_or_default(),
    );
    let events = turn_session_events(engine).await;
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(
        agent_ends.len(),
        1,
        "exactly one agent_end per run: {events:?}"
    );
    let agent_end = &events[agent_ends[0]];
    assert!(
        agent_end.get("messages").is_some(),
        "the frame carries the TS messages payload: {agent_end:?}"
    );
    let messages = agent_end["messages"]
        .as_array()
        .cloned()
        .expect("the messages payload");
    let roles = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(roles, ["user", "assistant"], "the run's message set");
    assert_eq!(
        messages[0]["content"],
        json!("burst"),
        "the accepted user row rides the payload"
    );
    assert_eq!(
        messages[1]["content"],
        json!("settled reply"),
        "the settled assistant row rides the payload"
    );
    let turn_ends = positions_of(&events, "turn_end");
    assert_eq!(turn_ends.len(), 1, "the scripted turn's turn_end");
    assert!(
        turn_ends[0] < agent_ends[0],
        "turn_end precedes agent_end: {events:?}"
    );
}

/// The bare `agent_end` fallback (a Rust-only shape kept for the TUI's silent-failure backstop).
#[tokio::test]
async fn a_turn_without_a_model_turn_keeps_the_bare_fallback_frames() {
    let events = turn_session_events(Arc::new(DoneOnlyEngine)).await;
    let turn_ends = positions_of(&events, "turn_end");
    assert_eq!(turn_ends.len(), 1, "the fallback turn_end: {events:?}");
    assert!(
        events[turn_ends[0]]
            .as_object()
            .is_some_and(|object| object.len() == 1),
        "the fallback turn_end carries no payload: {events:?}"
    );
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(agent_ends.len(), 1, "the fallback agent_end: {events:?}");
    assert!(
        events[agent_ends[0]]
            .as_object()
            .is_some_and(|object| object.len() == 1),
        "the fallback agent_end carries no payload: {events:?}"
    );
    assert!(
        turn_ends[0] < agent_ends[0],
        "the fallback pair closes the turn in order: {events:?}"
    );
}

/// One `agent_end` per agent run on the wire: the retry run re-opens with
/// its own `agent_start` + `turn_start` frames, and its `agent_end`
/// carries only the retry's messages; no bare synthesized frame trails.
#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
#[tokio::test]
async fn a_retried_turn_broadcasts_one_agent_end_per_run() {
    fn roles_of(frame: &Value) -> Vec<String> {
        frame["messages"]
            .as_array()
            .map(|messages| {
                messages
                    .iter()
                    .map(|message| message["role"].as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!(
        "pa-worker-agent-end-retry-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(dir.join("agent")).unwrap();
    std::fs::write(
        dir.join("agent").join("settings.json"),
        json!({ "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 10 } }).to_string(),
    )
    .unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "agent-end-retry-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "engine": "faux",
            "responses": [
                { "stopReason": "error", "errorMessage": "faux provider overloaded" },
                { "text": "recovered reply" },
            ],
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "agent-end-retry" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let mut subscription = worker.events.subscribe();
    let prompt = worker
        .dispatch(
            "prompt",
            &json!({
                "activeSessionId": "agent-end-retry-session",
                "message": "retried turn for the agent end probe",
            }),
        )
        .await;
    assert!(prompt.success, "prompt failed: {prompt:?}");
    // The busy flag is not a reliable admission marker (the faux retry
    // settles in milliseconds): drain the stream until both runs' `agent_end`
    // frames arrived.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut events = Vec::new();
    loop {
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type != "session_event" {
                continue;
            }
            let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
                continue;
            };
            if let Some(event) = outbound.get("event") {
                events.push(event.clone());
            }
        }
        let agent_ends = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_end"))
            .count();
        if agent_ends >= 2 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the retried turn never settled: {events:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    // The turn settled: drain the trailing frames (the settle-side queue
    // snapshot rides after the final `agent_end`).
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type != "session_event" {
            continue;
        }
        let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
            continue;
        };
        if let Some(event) = outbound.get("event") {
            events.push(event.clone());
        }
    }
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(
        agent_ends.len(),
        2,
        "one agent_end per agent run: {events:?}"
    );
    let first = &events[agent_ends[0]];
    assert_eq!(
        roles_of(first),
        ["custom", "user", "assistant"],
        "the failed run's message set (the deferred digest rides first): {events:?}"
    );
    assert_eq!(
        first["messages"][2]["stopReason"],
        json!("error"),
        "the failed run ends on the error row"
    );
    let second = &events[agent_ends[1]];
    assert_eq!(
        roles_of(second),
        ["assistant"],
        "the retried run carries only its own messages: {events:?}"
    );
    assert_eq!(
        second["messages"][0]["content"],
        json!([{ "type": "text", "text": "recovered reply" }]),
        "the retried run's settled row"
    );
    let agent_starts = positions_of(&events, "agent_start");
    assert_eq!(agent_starts.len(), 2, "one agent_start per run: {events:?}");
    let turn_starts = positions_of(&events, "turn_start");
    assert_eq!(
        turn_starts.len(),
        2,
        "the run-opening turn_start plus the retry run's: {events:?}"
    );
    let retry_starts = positions_of(&events, "auto_retry_start");
    assert_eq!(retry_starts.len(), 1, "the retry start frame: {events:?}");
    assert!(
        agent_ends[0] < retry_starts[0]
            && retry_starts[0] < agent_starts[1]
            && agent_starts[1] < turn_starts[1]
            && turn_starts[1] < agent_ends[1],
        "the retry run's frames sit between the two agent_ends: {events:?}"
    );
    assert!(
        events.iter().all(|event| {
            event.get("type").and_then(Value::as_str) != Some("agent_end")
                || event.get("messages").is_some()
        }),
        "no bare agent_end frames: {events:?}"
    );
}

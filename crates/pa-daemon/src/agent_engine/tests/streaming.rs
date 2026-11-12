//! The streaming tests (prompt content, live assistant updates, the final message).
use super::*;

/// Images ride as multimodal blocks after the text, even when the model
/// turn cannot run.
#[test]
fn prompt_images_ride_the_user_message_content() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = bare_engine(dir.path());
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: vec![pa_agent::types::ImageContent {
                data: "QUJD".to_string(),
                mime_type: "image/png".to_string(),
            }],
            message: "look at this".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            streaming_behavior: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    let user = events.iter().find_map(|event| match event {
        EngineEvent::UserMessage(message) => Some(message.clone()),
        _ => None,
    });
    let user = user.expect("user message emitted");
    assert_eq!(
        user["content"][0],
        json!({ "type": "text", "text": "look at this" })
    );
    assert_eq!(
        user["content"][1],
        json!({ "type": "image", "data": "QUJD", "mimeType": "image/png" })
    );
}

#[test]
fn assistant_updates_stream_live_while_the_turn_runs() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    // A paced script: if the engine buffered events until the turn
    // settled, every update would share one emit timestamp; live
    // forwarding spreads them.
    let words = (0..40).fold(String::new(), |mut words, i| {
        use std::fmt::Write;
        write!(words, "w{i} ").expect("write to String");
        words
    });
    let script = serde_json::json!({
        "engine": "faux",
        "tokensPerSecond": 100.0,
        "responses": [
            {"content": [{"type": "text", "text": words}]}
        ],
    });
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
    // The worker registers the engine's own arc: the live-auth resolver
    // upgrades it per provider call.
    engine.register_arc();
    let start = std::time::Instant::now();
    let mut updates: Vec<(std::time::Duration, usize)> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            streaming_behavior: None,
        },
        &|| false,
        &mut |event| {
            if let EngineEvent::AssistantUpdate { message, .. } = &event {
                let message = message.clone().into_wire().expect("wire form");
                let text_len = message["content"].as_array().map_or(0, |blocks| {
                    blocks
                        .iter()
                        .map(|block| {
                            block
                                .get("text")
                                .and_then(Value::as_str)
                                .map_or(0, str::len)
                        })
                        .sum()
                });
                updates.push((start.elapsed(), text_len));
            }
            true
        },
    );
    assert!(
        updates.len() >= 10,
        "the paced stream must produce many updates, got {}",
        updates.len()
    );
    let first = updates.first().unwrap().0;
    let last = updates.last().unwrap().0;
    assert!(
        last.checked_sub(first).unwrap() >= std::time::Duration::from_millis(200),
        "updates must spread across the stream, got {first:?}..{last:?}"
    );
    // Content grows monotonically: every update carries the full partial.
    let lengths: Vec<usize> = updates.iter().map(|(_, len)| *len).collect();
    let mut monotonic = lengths.clone();
    monotonic.sort_unstable();
    assert_eq!(lengths, monotonic, "partial message lengths regress");
    // The settled final message arrives too (message_end, not just updates).
    let final_len = lengths.last().copied().unwrap_or(0);
    assert!(final_len >= 40 * 3, "final partial is the full text");
}

#[test]
fn agent_engine_streams_updates_and_final_message() {
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
        faux_script: Some(serde_json::json!({ "responses": ["streamed answer"] }).to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    // The worker registers the engine's own arc: the live-auth resolver
    // upgrades it per provider call.
    engine.register_arc();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            streaming_behavior: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    assert!(matches!(&events[0], EngineEvent::UserMessage(_)));
    assert!(events
        .iter()
        .any(|event| matches!(event, EngineEvent::AssistantUpdate { .. })));
    let final_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AssistantMessage(_)))
        .expect("final assistant message");
    let EngineEvent::AssistantMessage(message) = &events[final_index] else {
        unreachable!();
    };
    assert_eq!(message["content"][0]["text"], "streamed answer");
    assert_eq!(message["role"], "assistant");
    assert_eq!(message["stopReason"], "stop");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

/// The worker persists the accepted row before the lazy core builds. Its
/// pre-admission leaf must keep that row out of restored model history, while
/// repeated text and image blocks remain distinct turns after a runtime rebuild.
#[test]
fn lazy_build_restores_only_the_pre_admission_prompt_context() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut store =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap(), None, 0);
    store.set_path(path.clone());
    store.rewrite().expect("initialize worker-owned transcript");
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: Some(path),
        faux_script: Some(
            r#"{"responses":[{"text":"first"},{"text":"second"},{"text":"restored"}]}"#.to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    // The worker registers the engine's own arc: the live-auth resolver
    // upgrades it per provider call.
    engine.register_arc();
    let expected_content = json!([
        { "type": "text", "text": "repeat this exact prompt" },
        { "type": "image", "mimeType": "image/png", "data": "QUJD" },
    ]);
    for prompt_index in 0..3 {
        if prompt_index == 2 {
            engine.runtime.block_on(engine.retire_session_runtime());
        }
        engine.set_prompt_context_boundary(store.leaf_id().map(str::to_string));
        let mut accepted = false;
        let mut model_user_content = None;
        let mut result = None;
        engine.run_prompt(
            prompt_index,
            PromptRequest {
                batch: Vec::new(),
                images: vec![pa_agent::types::ImageContent {
                    data: "QUJD".to_string(),
                    mime_type: "image/png".to_string(),
                }],
                message: "repeat this exact prompt".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
                streaming_behavior: None,
            },
            &|| false,
            &mut |event| {
                match event {
                    EngineEvent::UserMessage(message) => {
                        if prompt_index != 1 {
                            assert!(
                                engine.session.blocking_lock().is_none(),
                                "accepted prompt must render before the lazy session builds"
                            );
                        }
                        accepted = true;
                        store
                            .persist_entry("message", json!({ "message": message }))
                            .expect("worker persists accepted prompt");
                    }
                    EngineEvent::AssistantMessage(message)
                    | EngineEvent::ToolResultMessage(message) => {
                        store
                            .persist_entry("message", json!({ "message": message }))
                            .expect("worker persists settled message");
                    }
                    EngineEvent::AgentEnd { messages } => {
                        model_user_content = Some(
                            messages
                                .into_iter()
                                .filter(|message| message["role"] == "user")
                                .map(|message| message["content"].clone())
                                .collect::<Vec<_>>(),
                        );
                    }
                    EngineEvent::Done(done) => result = Some(done),
                    _ => {}
                }
                true
            },
        );
        engine.on_turn_done();
        assert!(accepted);
        assert_eq!(result, Some(Ok(())));
        assert_eq!(
            model_user_content,
            Some(vec![expected_content.clone()]),
            "each run emits exactly its own admitted prompt/image pair"
        );
        let core = engine.session.blocking_lock().clone().expect("core built");
        let live_content = engine.runtime.block_on(async {
            core.session
                .agent()
                .state()
                .await
                .messages
                .into_iter()
                .filter_map(|message| match message {
                    pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::User(
                        user,
                    )) => Some(
                        serde_json::to_value(user).expect("user serializes")["content"].clone(),
                    ),
                    _ => None,
                })
                .collect::<Vec<_>>()
        });
        assert_eq!(
            live_content,
            vec![expected_content.clone(); prompt_index + 1],
            "live model history keeps each repeated prompt/image pair once"
        );
        let persistence = core.session.shared_persistence();
        let inner = persistence.blocking_lock();
        let is_user = |entry: &&pa_types::session::FileEntry| {
            matches!(
                entry,
                pa_types::session::FileEntry::Message {
                    message: pa_types::session::AgentMessage::User(_),
                    ..
                }
            )
        };
        assert_eq!(
            inner.retained_entries().iter().filter(is_user).count(),
            prompt_index + 1,
            "inner retained history must not double append the accepted row"
        );
        assert_eq!(
            inner
                .active_context()
                .messages
                .iter()
                .filter(|message| matches!(message, pa_types::session::AgentMessage::User(_)))
                .count(),
            prompt_index + 1,
            "compact/refine context must retain each repeated prompt once"
        );
        assert_eq!(
            store.branch_file_entries().iter().filter(is_user).count(),
            prompt_index + 1,
            "the worker-owned durable branch remains single-copy"
        );
    }
}

/// The busy-session delivery seam: a delivery admitted while another run
/// streams must not settle on the streaming run's state. It waits for the
/// run to settle, then drains the parked lane so the queued row actually
/// runs on its own seat (the `resumeIfIdle` contract, covering the
/// final-poll window where the streaming run exits without consuming it).
/// Mutation: reverting the seat to the instant return settles the stale
/// harvest instead (`No response produced.` with the row still parked), so
/// the `Done(Ok)` and empty-lane pins go red.
#[test]
fn a_busy_delivery_waits_for_the_run_and_drains_the_parked_row() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let words = (0..120).fold(String::new(), |mut words, i| {
        use std::fmt::Write;
        write!(words, "w{i} ").expect("write to String");
        words
    });
    let script = serde_json::json!({
        "engine": "faux",
        "tokensPerSecond": 30.0,
        "responses": [
            {"content": [{"type": "text", "text": words}]},
            {"content": [{"type": "text", "text": "drained reply"}]}
        ],
    });
    // The run-stop lever (the worker's `_steeringStopPending` probe): armed
    // before the delivery admits, it makes the streaming run exit at its
    // next boundary WITHOUT consuming the parked row — the exact final-poll
    // window `drain_queued_delivery` covers.
    let stop_pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let probe = {
        let stop_pending = std::sync::Arc::clone(&stop_pending);
        std::sync::Arc::new(move || stop_pending.load(std::sync::atomic::Ordering::SeqCst))
            as std::sync::Arc<dyn Fn() -> bool + Send + Sync>
    };
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
        queued_steering_probe: Some(probe),
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    engine.register_arc();
    // Run #1 streams a paced turn on its own thread.
    let first_events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let runner = {
        let engine = std::sync::Arc::clone(&engine);
        let first_events = std::sync::Arc::clone(&first_events);
        std::thread::spawn(move || {
            engine.run_prompt(
                0,
                PromptRequest {
                    batch: Vec::new(),
                    images: Vec::new(),
                    message: "hold".to_string(),
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: None,
                    streaming_behavior: None,
                },
                &|| false,
                &mut move |event: EngineEvent| {
                    first_events.lock().unwrap().push(event);
                    true
                },
            );
        })
    };
    // Wait until the run streams: the admission's busy window. The
    // session build provisions the kernel skills, so the registration
    // deadline leaves headroom for a loaded runner.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let streaming = {
            let guard = engine.session.blocking_lock();
            match guard.as_deref() {
                Some(core) => engine
                    .runtime
                    .block_on(async { core.session.agent().state().await.is_streaming }),
                None => false,
            }
        };
        if streaming {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the first run never registered"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // Arm the stop lever: run #1 exits at its next boundary with the
    // delivery's row still parked on the agent's steering lane.
    stop_pending.store(true, std::sync::atomic::Ordering::SeqCst);
    // The delivery admits while run #1 streams: it parks, waits for the
    // run, drains the lane, and settles on the drained run's reply.
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "continue-queued".to_string(), &mut events);
    let dump = format!("{events:?}");
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::Done(result) if result.is_ok())),
        "the parked delivery settles its own run: {dump}"
    );
    assert!(
        dump.contains("drained reply"),
        "the parked row drained on the delivery's seat: {dump}"
    );
    // The parked phase forwards nothing from the streaming run: its
    // stream belongs to that run's own seat (no duplicated rows, no
    // doubled usage accounting). The drain's own run re-opens the gate,
    // which is how `drained reply` above reached this seat at all.
    // Mutation: dropping the parked gate forwards the first run's frames
    // (its distinctive tail `w119` appears here).
    assert!(
        !dump.contains("w119"),
        "the streaming run's frames never ride the parked seat: {dump}"
    );
    let (steering, follow_up) = {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        let agent = core.session.agent();
        (agent.steering_previews(), agent.follow_up_previews())
    };
    assert!(
        steering.is_empty() && follow_up.is_empty(),
        "the parked row left the lanes: {steering:?} {follow_up:?}"
    );
    let _ = runner.join();
}

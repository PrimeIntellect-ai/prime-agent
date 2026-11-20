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
                    EngineEvent::AgentEnd { messages, .. } => {
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
    // The delivery admits while run #1 streams: it parks, waits for the
    // run, drains the lane, and settles on the drained run's reply. The
    // admission runs on its own thread so the stop lever arms only AFTER
    // the row parks: arming first races the probe's first boundary check
    // against the row's landing (a loaded runner's early exit leaves the
    // row to run #1's settle pump, and the drain answers Consumed
    // without the reply - the CI flake this structure pins shut).
    let (delivery_tx, delivery_rx) = std::sync::mpsc::channel::<Vec<EngineEvent>>();
    let delivery = {
        let engine = std::sync::Arc::clone(&engine);
        std::thread::spawn(move || {
            let mut events: Vec<EngineEvent> = Vec::new();
            admit(&engine, "continue-queued".to_string(), &mut events);
            let _ = delivery_tx.send(events);
        })
    };
    // Wait until the delivery's row parks on the steering lane.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let parked = {
            let guard = engine.session.blocking_lock();
            match guard.as_deref() {
                Some(core) => core.session.agent().steering_previews().len(),
                None => 0,
            }
        };
        if parked >= 1 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the delivery never parked its row (parked so far: {parked})"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // Arm the stop lever: run #1 exits at its next boundary with the
    // delivery's row still parked on the agent's steering lane.
    stop_pending.store(true, std::sync::atomic::Ordering::SeqCst);
    let events = delivery_rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("the parked delivery settles: the drain must run the parked row");
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
    let _ = delivery.join();
}

/// Two deliveries that queue behind one streaming run must not deadlock
/// on the seat count: a parked drainer leaves the drain's seat wait (a
/// parked seat forwards and accounts nothing, so it is not an active
/// stream owner), the drainers self-elect through `continue_run`'s slot
/// refusal, and ONE drained run serves both parked rows. Mutation:
/// counting parked seats as active (the plain `seats != 1` wait)
/// deadlocks the pair — neither drain ever starts, and the join
/// deadline below fails with this test's name.
#[test]
fn two_parked_deliveries_elect_one_drainer_and_both_settle() {
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
            {"content": [{"type": "text", "text": "drained reply one"}]},
            {"content": [{"type": "text", "text": "drained reply two"}]}
        ],
    });
    // The run-stop lever (the worker's `_steeringStopPending` probe):
    // armed after BOTH deliveries park, it makes the streaming run exit
    // at its next boundary without consuming either parked row.
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
    let runner = {
        let engine = std::sync::Arc::clone(&engine);
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
                &mut |_event: EngineEvent| true,
            );
        })
    };
    // Wait until the run streams: the admission's busy window.
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
    // TWO deliveries admit while run #1 streams: each parks on the
    // steering lane and holds a seat in the drain wait.
    let delivery = |message: &'static str| {
        let engine = std::sync::Arc::clone(&engine);
        let (tx, rx) = std::sync::mpsc::channel::<Vec<EngineEvent>>();
        let handle = std::thread::spawn(move || {
            let mut events: Vec<EngineEvent> = Vec::new();
            engine.run_prompt(
                0,
                PromptRequest {
                    batch: Vec::new(),
                    images: Vec::new(),
                    message: message.to_string(),
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: None,
                    streaming_behavior: None,
                },
                &|| false,
                &mut |event: EngineEvent| {
                    events.push(event);
                    true
                },
            );
            let _ = tx.send(events);
        });
        (handle, rx)
    };
    let (_handle_a, rx_a) = delivery("continue-a");
    let (_handle_b, rx_b) = delivery("continue-b");
    // Wait until BOTH rows park on the steering lane.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let parked = {
            let guard = engine.session.blocking_lock();
            match guard.as_deref() {
                Some(core) => core.session.agent().steering_previews().len(),
                None => 0,
            }
        };
        if parked >= 2 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the two deliveries never parked their rows (parked so far: {parked})"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // Arm the stop lever: run #1 exits at its next boundary with BOTH
    // rows still parked — the parked-drainer election this test pins.
    stop_pending.store(true, std::sync::atomic::Ordering::SeqCst);
    // Join both deliveries under a deadline: the pair must elect one
    // drainer (one drained run serves both rows), never wait on each
    // other's seats.
    let events_a = rx_a
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("delivery A settled: two parked drainers must not deadlock on the seat count");
    let events_b = rx_b
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("delivery B settled: two parked drainers must not deadlock on the seat count");
    let dump_a = format!("{events_a:?}");
    let dump_b = format!("{events_b:?}");
    for (name, dump) in [("A", &dump_a), ("B", &dump_b)] {
        assert!(
            dump.contains("Done(Ok"),
            "delivery {name} settles its own seat: {dump}"
        );
    }
    // The drained rows ran on the drainers' own seats (never an error
    // from a run that found no response, never a seat left waiting):
    // whichever seat won each row's run, both replies surfaced across
    // the two seats' dumps.
    let drained_seen =
        dump_a.matches("drained reply").count() + dump_b.matches("drained reply").count();
    assert!(
        drained_seen >= 2,
        "both parked rows ran on the drainers' seats: {dump_a} {dump_b}"
    );
    assert!(
        !dump_a.contains("No more faux responses queued")
            && !dump_b.contains("No more faux responses queued"),
        "no seat ran a response-starved turn: {dump_a} {dump_b}"
    );
    let (steering, follow_up) = {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        let agent = core.session.agent();
        (agent.steering_previews(), agent.follow_up_previews())
    };
    assert!(
        steering.is_empty() && follow_up.is_empty(),
        "both parked rows left the lanes: {steering:?} {follow_up:?}"
    );
    let _ = runner.join();
}

/// Two deliveries that queue behind one busy turn must not deadlock the
/// drain: a parked seat is not an active stream owner, so the seat wait
/// counts `turn_seats` minus the parked drainers and two concurrent
/// drainers self-elect — the slot winner runs the first parked row, the
/// `Busy` loser re-parks behind the winner's run and drains the row that
/// remains. Mutation: reverting the wait to `turn_seats == 1` (counting
/// parked drainers as active owners) leaves each drainer waiting for the
/// other's seat to drop — neither settles, the deadline below fails
/// naming the deadlock.
#[test]
fn two_parked_drainers_self_elect_instead_of_deadlocking_the_seat_wait() {
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
            {"content": [{"type": "text", "text": "drained reply a"}]},
            {"content": [{"type": "text", "text": "drained reply b"}]}
        ],
    });
    // The run-stop lever (the worker's `_steeringStopPending` probe):
    // armed while run #1 streams, it makes the streaming run exit at its
    // next boundary WITHOUT consuming the parked rows — the final-poll
    // window `drain_queued_delivery` covers, reached here by TWO parked
    // seats at once.
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
    // Wait until the run streams: the admissions' busy window.
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
    // Arm the stop lever: run #1 exits at its next boundary with both
    // deliveries' rows still parked on the steering lane.
    stop_pending.store(true, std::sync::atomic::Ordering::SeqCst);
    // TWO deliveries admit while run #1 streams: both park, and when the
    // run exits both drainers contend for the drain at once.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<EngineEvent>>();
    let seats: Vec<_> = ["queued-a", "queued-b"]
        .iter()
        .map(|message| {
            let engine = std::sync::Arc::clone(&engine);
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut events: Vec<EngineEvent> = Vec::new();
                engine.run_prompt(
                    0,
                    PromptRequest {
                        batch: Vec::new(),
                        images: Vec::new(),
                        message: message.to_string(),
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
                tx.send(events).expect("the collecting test stays alive");
            })
        })
        .collect();
    drop(tx);
    // Both rows are parked before the run can exit: the steering lane
    // holds exactly the two queued rows.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let previews = {
            let guard = engine.session.blocking_lock();
            match guard.as_deref() {
                Some(core) => core.session.agent().steering_previews(),
                None => Vec::new(),
            }
        };
        if previews.len() == 2 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "both deliveries never parked: {previews:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // THE deadlock pin: both parked drainers settle. Two queued deliveries
    // each hold a seat; a seat wait that counts parked drainers as active
    // stream owners waits forever here (each drainer waits for the other's
    // seat to drop).
    let mut seat_events: Vec<Vec<EngineEvent>> = Vec::new();
    for seat in ["first", "second"] {
        let events = rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap_or_else(|_| {
                panic!("the {seat} parked drainer never settled: the parked-drainer deadlock (each queued delivery waits for the other's seat)")
            });
        seat_events.push(events);
    }
    for (index, events) in seat_events.iter().enumerate() {
        let dump = format!("{events:?}");
        assert!(
            events
                .iter()
                .any(|event| matches!(event, EngineEvent::Done(result) if result.is_ok())),
            "the parked delivery {index} settles its own run: {dump}"
        );
        assert!(
            !dump.contains("w119"),
            "the streaming run's frames never ride a parked seat: {dump}"
        );
    }
    // The two drained runs belong one-to-one to the two seats: each reply
    // reaches exactly one seat (the winner's drain and the loser's retry),
    // never both and never neither.
    let dumps: Vec<String> = seat_events
        .iter()
        .map(|events| format!("{events:?}"))
        .collect();
    for reply in ["drained reply a", "drained reply b"] {
        let seats_with_reply = dumps.iter().filter(|dump| dump.contains(reply)).count();
        assert_eq!(
            seats_with_reply, 1,
            "{reply} must reach exactly one seat: {dumps:?}"
        );
    }
    assert!(
        dumps.iter().all(|dump| dump.contains("drained reply")),
        "both seats carry their drained run's reply: {dumps:?}"
    );
    // The lanes drained: no row outlives the seats.
    let (steering, follow_up) = {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        let agent = core.session.agent();
        (agent.steering_previews(), agent.follow_up_previews())
    };
    assert!(
        steering.is_empty() && follow_up.is_empty(),
        "the parked rows left the lanes: {steering:?} {follow_up:?}"
    );
    // Both rows ran exactly once (the history holds run #1's user row plus
    // each queued row, and three assistant replies — the held turn plus
    // one drained run per row).
    let (user_rows, assistant_rows) = {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine.runtime.block_on(async {
            let state = core.session.agent().state().await;
            let user_rows = state
                .messages
                .iter()
                .filter(|message| {
                    matches!(
                        message,
                        pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::User(_))
                    )
                })
                .count();
            let assistant_rows = state
                .messages
                .iter()
                .filter(|message| {
                    matches!(
                        message,
                        pa_agent::types::AgentMessage::Standard(
                            pa_agent::types::Message::Assistant(_)
                        )
                    )
                })
                .count();
            (user_rows, assistant_rows)
        })
    };
    assert_eq!(user_rows, 3, "run #1's row plus both queued rows ran once");
    assert_eq!(
        assistant_rows, 3,
        "the held turn plus one drained run per parked row"
    );
    let _ = runner.join();
    for seat in seats {
        seat.join().expect("delivery thread");
    }
}

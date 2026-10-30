use super::*;
use std::sync::Arc;

/// The planner's reply message: the wire `AssistantMessage` fixture (the
/// pa-ai provider constructors' initial-assistant shape, built directly).
fn assistant_fixture(
    model: &Model,
    content: Vec<pa_types::ai::AssistantContentBlock>,
) -> pa_types::ai::AssistantMessage {
    pa_types::ai::AssistantMessage {
        content,
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_types::ai::Usage::default(),
        stop_reason: pa_types::ai::StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
        rest: serde_json::Map::default(),
    }
}

struct HeldPlanner {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    reply: &'static str,
}

impl pa_ai::registry::Provider for HeldPlanner {
    fn api(&self) -> &'static str {
        "test-held-refinement-host"
    }

    fn stream(
        &self,
        model: &Model,
        _context: &pa_ai::types::Context,
        _options: Option<&pa_ai::types::StreamOptions>,
    ) -> pa_ai::AssistantMessageEventStream {
        let (writer, stream) = pa_ai::AssistantMessageEventStream::new();
        let started = self.started.clone();
        let release = self.release.clone();
        let message = assistant_fixture(
            model,
            vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: self.reply.to_string(),
                    text_signature: None,
                    rest: serde_json::Map::default(),
                },
            )],
        );
        tokio::spawn(async move {
            started.notify_one();
            release.notified().await;
            writer.push(pa_types::ai::AssistantMessageEvent::Done {
                reason: pa_types::ai::DoneStopReason::Stop,
                message: message.clone(),
            });
            writer.end(Some(message));
        });
        stream
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &pa_ai::types::Context,
        _options: Option<&pa_ai::types::SimpleStreamOptions>,
    ) -> pa_ai::AssistantMessageEventStream {
        self.stream(model, context, None)
    }
}

#[derive(Clone, Copy, Debug)]
enum Origin {
    Slash,
    Requested,
    Auto,
}

impl Origin {
    async fn schedule(
        self,
        engine: &SessionEngine,
        planner_model: &Model,
        boundary: &mut TurnBoundary,
        global_dir: std::path::PathBuf,
    ) -> Option<
        tokio::task::JoinHandle<
            anyhow::Result<pa_core::session_engine::refine::CommittedRefinement>,
        >,
    > {
        let mut pending = None;
        match self {
            Origin::Slash => {
                let mut autonomous =
                    pa_core::autonomous::create_autonomous_runtime_state(None, None);
                let mut params = pa_core::session_engine::session_commands::SessionCommandParams {
                    model: planner_model,
                    api_key: None,
                    global_harness_dir: global_dir,
                    autonomous: &mut autonomous,
                };
                let command = pa_core::session_engine::slash_commands::SessionSlashCommand {
                    name: "refine",
                    args: String::new(),
                    text: "/refine".to_string(),
                };
                let execution = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    pa_core::session_engine::session_commands::execute_session_command(
                        engine,
                        &mut params,
                        &command,
                        &[],
                    ),
                )
                .await
                .expect("slash command must return while planner is held");
                assert!(execution.error.is_none());
                pending = execution.pending_refinement;
                assert!(pending.is_some());
            }
            Origin::Requested => {
                engine
                    .turn_boundary
                    .schedule_refine(pa_core::session_engine::turn_boundary::PendingRefine {
                        instructions: None,
                        global: false,
                    })
                    .await;
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    boundary.run_at_settled_turn(engine, planner_model, None, global_dir),
                )
                .await
                .expect("requested planning must leave the boundary")
                .unwrap();
            }
            Origin::Auto => {
                boundary.compact_auto_refine_pending = true;
                boundary.consume_compact_auto_refine(
                    engine,
                    planner_model,
                    None,
                    global_dir,
                    RefineSurface::Checkpoint,
                );
            }
        }
        pending
    }
}

/// Real host scheduling calls use a held provider. Readiness comes from provider
/// entry, and the next user turn must complete before the planner is released.
#[tokio::test]
async fn held_refinement_planning_never_blocks_the_next_prompt_or_rebuilds_its_prefix() {
    let _faux = FAUX_TEST_LOCK.lock().await;
    for origin in [Origin::Slash, Origin::Requested, Origin::Auto] {
        let (engine, dir, model) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed"}, {"text": "next user reply"}] }),
            json!({ "compaction": {"enabled": false}, "autoRefine": {"enabled": true, "compact": true, "cooldownMs": 0} }),
            None,
        ).await;
        engine
            .session
            .prompt("seed", pa_core::session_engine::PromptOptions::default())
            .await
            .unwrap();
        engine.session.agent().wait_for_idle().await;
        // A failed assistant retained on disk but dropped from the live retry
        // context must not reappear when the user runs /refine.
        let mut failed = assistant_fixture(&model, Vec::new());
        failed.stop_reason = pa_types::ai::StopReason::Error;
        failed.error_message = Some("discarded retry attempt".to_string());
        engine
            .session
            .shared_persistence()
            .lock()
            .await
            .append_message(SessionAgentMessage::Assistant(failed))
            .unwrap();
        let before = pa_core::session_engine::messages::loop_convert_to_llm(
            engine.session.agent().state().await.messages,
        );
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let reply = match origin {
            Origin::Auto => r#"{"shouldRefine":false,"rationale":"decline"}"#,
            Origin::Slash | Origin::Requested => r#"{"summary":"background note","edits":[]}"#,
        };
        pa_ai::registry::register_api_provider(
            Arc::new(HeldPlanner {
                started: started.clone(),
                release: release.clone(),
                reply,
            }),
            Some("test-held-refinement-host"),
        );
        let mut planner_model = model.clone();
        planner_model.api = "test-held-refinement-host".to_string();
        let mut boundary = TurnBoundary::new(false);
        let global_dir = dir.path().join("global-refinement");
        let pending = origin
            .schedule(&engine, &planner_model, &mut boundary, global_dir)
            .await;
        tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
            .await
            .expect("planner entered");
        assert_eq!(
            pa_core::session_engine::messages::loop_convert_to_llm(
                engine.session.agent().state().await.messages
            ),
            before,
            "{origin:?} changed the live provider prefix before commit"
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            engine
                .session
                .prompt(
                    "next user input",
                    pa_core::session_engine::PromptOptions::default(),
                )
                .await
                .unwrap();
            engine.session.agent().wait_for_idle().await;
        })
        .await
        .expect("held planning must not delay the user's next run");
        assert_eq!(
            serde_json::to_value(last_assistant(&engine).await.unwrap()).unwrap()["content"][0]
                ["text"],
            "next user reply"
        );
        release.notify_one();
        if let Some(pending) = pending {
            pending.await.unwrap().unwrap();
        }
        boundary.wait_for_refinement_reports().await;
        pa_ai::registry::unregister_api_providers("test-held-refinement-host");
    }
}

/// The disposal drain owns finishing pending refinement work: a held
/// refinement still in flight when the print runtime disposes the session
/// must land its durable outcome rows through the drain — returning first
/// would let the session drop abort the planning.
#[tokio::test]
async fn disposal_drain_awaits_a_held_refinement_before_the_session_drops() {
    let _faux = FAUX_TEST_LOCK.lock().await;
    let (engine, dir, model) = faux_engine_with_settings(
        json!({ "responses": [{"text": "seed"}] }),
        json!({ "compaction": {"enabled": false}, "autoRefine": {"enabled": true, "compact": true, "cooldownMs": 0} }),
        None,
    )
    .await;
    engine
        .session
        .prompt("seed", pa_core::session_engine::PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    pa_ai::registry::register_api_provider(
        Arc::new(HeldPlanner {
            started: started.clone(),
            release: release.clone(),
            reply: r#"{"summary":"background note","edits":[]}"#,
        }),
        Some("test-held-refinement-host"),
    );
    let mut planner_model = model.clone();
    planner_model.api = "test-held-refinement-host".to_string();
    let mut boundary = TurnBoundary::new(false);
    let global_dir = dir.path().join("global-refinement");
    // The last turn's requested refinement: the boundary owns its report.
    let _pending = Origin::Requested
        .schedule(&engine, &planner_model, &mut boundary, global_dir.clone())
        .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .expect("planner entered");
    let mut drain = std::pin::pin!(async {
        boundary
            .drain_compact_auto_refine_at_disposal(&engine, &planner_model, None, global_dir)
            .await;
    });
    // While the planner is held the drain must stay pending: the session
    // drops the moment the drain returns, and the drop aborts refinement
    // planning, losing the outcome rows.
    assert!(futures::poll!(drain.as_mut()).is_pending());
    release.notify_one();
    drain.await;
    let rows = refine_rows(&engine).await;
    assert_eq!(rows.len(), 1, "the durable outcome row landed");
    assert_eq!(rows[0].custom_type, "refinement_outcome");
    pa_ai::registry::unregister_api_providers("test-held-refinement-host");
}

/// The print `/refine` command's pending refinement is tracked by the same
/// disposal drain: a detached reporter would be aborted by the session drop
/// the drain cannot wait for.
#[tokio::test]
async fn a_print_refine_command_is_tracked_by_the_disposal_drain() {
    let _faux = FAUX_TEST_LOCK.lock().await;
    let (engine, dir, model) = faux_engine_with_settings(
        json!({ "responses": [{"text": "seed"}] }),
        json!({ "compaction": {"enabled": false}, "autoRefine": {"enabled": true, "compact": true, "cooldownMs": 0} }),
        None,
    )
    .await;
    let engine = Arc::new(engine);
    engine
        .session
        .prompt("seed", pa_core::session_engine::PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    pa_ai::registry::register_api_provider(
        Arc::new(HeldPlanner {
            started: started.clone(),
            release: release.clone(),
            reply: r#"{"summary":"background note","edits":[]}"#,
        }),
        Some("test-held-refinement-host"),
    );
    let mut planner_model = model.clone();
    planner_model.api = "test-held-refinement-host".to_string();
    let mut boundary = TurnBoundary::new(false);
    let global_dir = dir.path().join("global-refinement");
    let goal = Arc::new(crate::print_goal::PrintGoalSurface::new(false));
    let autonomous = Arc::new(tokio::sync::Mutex::new(
        pa_core::autonomous::create_autonomous_runtime_state(None, None),
    ));
    let command = pa_core::session_engine::slash_commands::SessionSlashCommand {
        name: "refine",
        args: String::new(),
        text: "/refine".to_string(),
    };
    crate::print_session_command::execute_prompt_session_command(
        &engine,
        &goal,
        &planner_model,
        None,
        global_dir.clone(),
        &autonomous,
        &mut boundary,
        &command,
        &[],
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .expect("planner entered");
    let mut drain = std::pin::pin!(async {
        boundary
            .drain_compact_auto_refine_at_disposal(&engine, &planner_model, None, global_dir)
            .await;
    });
    assert!(
        futures::poll!(drain.as_mut()).is_pending(),
        "the /refine report must be inside the boundary's tracked reports"
    );
    release.notify_one();
    drain.await;
    let rows = refine_rows(&engine).await;
    assert_eq!(rows.len(), 1, "the durable outcome row landed");
    assert_eq!(rows[0].custom_type, "refinement_outcome");
    pa_ai::registry::unregister_api_providers("test-held-refinement-host");
}

/// Every print exit path runs the disposal drain: a `/refine` still planning
/// when a later prompt fails through `?` must land its outcome row before the
/// run returns — the session drop would abort it.
#[tokio::test(start_paused = true)]
async fn a_failed_print_run_still_drains_an_in_flight_refine() {
    let _faux = FAUX_TEST_LOCK.lock().await;
    let (engine, dir, model) = faux_engine_with_settings(
        json!({ "responses": [{"text": "seed"}] }),
        json!({ "compaction": {"enabled": false}, "autoRefine": {"enabled": true, "compact": true, "cooldownMs": 0} }),
        None,
    )
    .await;
    let engine = Arc::new(engine);
    engine
        .session
        .prompt("seed", pa_core::session_engine::PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    // The next run fails at its start: its prompt wait returns the error.
    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let listener_failed = failed.clone();
    let _failing = engine
        .session
        .agent()
        .subscribe(move |event, _signal| {
            let failed = listener_failed.clone();
            Box::pin(async move {
                if matches!(event, pa_agent::types::AgentEvent::AgentStart) {
                    failed.store(true, std::sync::atomic::Ordering::SeqCst);
                    anyhow::bail!("listener failed");
                }
                Ok(())
            })
        })
        .await;
    let release = Arc::new(tokio::sync::Notify::new());
    pa_ai::registry::register_api_provider(
        Arc::new(HeldPlanner {
            started: Arc::new(tokio::sync::Notify::new()),
            release: release.clone(),
            reply: r#"{"summary":"background note","edits":[]}"#,
        }),
        Some("test-held-refinement-host"),
    );
    let mut planner_model = model.clone();
    planner_model.api = "test-held-refinement-host".to_string();
    let options = crate::mode::RunOptions {
        app_mode: crate::mode::AppMode::Print,
        config: crate::mode::RuntimeConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            ..Default::default()
        },
        session: crate::mode::SessionOptions::default(),
        messages: vec!["/refine".to_string(), "next".to_string()],
        file_args: Vec::new(),
        daemon_socket: None,
        list_models: None,
        initial_message: None,
        initial_images: Vec::new(),
        verbose: false,
        offline: true,
        agents_view_requested: false,
        attach_agent: None,
    };
    let root_node =
        crate::print_rlm::root_node(&options, &SessionManager::in_memory(dir.path()), None);
    let mut run = std::pin::pin!(crate::print_runtime::run_prompts_and_emit(
        &engine,
        &planner_model,
        None,
        &options,
        &root_node,
    ));
    // The paused clock fires this sleep only once the runtime idles. Past the
    // failed prompt nothing but the held planner can block the run, so an idle
    // run is waiting on it in the drain and may release it. An idle before the
    // failure would let the plan commit early, so it fails the test instead.
    let result = tokio::select! {
        biased;
        result = &mut run => result,
        () = tokio::time::sleep(std::time::Duration::from_secs(3600)) => {
            assert!(
                failed.load(std::sync::atomic::Ordering::SeqCst),
                "the run idled before the prompt failed"
            );
            release.notify_one();
            run.await
        }
    };
    let error = result.expect_err("the failed prompt fails the run");
    assert!(error.contains("listener failed"), "{error}");
    let outcomes = refine_rows(&engine)
        .await
        .into_iter()
        .filter(|row| row.custom_type == "refinement_outcome")
        .count();
    assert_eq!(
        outcomes, 1,
        "the /refine outcome row landed before the run returned"
    );
    pa_ai::registry::unregister_api_providers("test-held-refinement-host");
}

/// One `refine.status` round trip through the engine's turn-boundary
/// handler registration.
async fn refine_status(engine: &SessionEngine) -> serde_json::Value {
    let mut handlers = pa_core::kernel::shared::HostRequestHandlers::default();
    engine.turn_boundary.register_refine_handlers(&mut handlers);
    let status = handlers
        .get("refine.status")
        .expect("the refine surface registered")
        .clone();
    status(pa_core::kernel::shared::HostRequestPayload { data: json!({}) })
        .await
        .expect("refine.status answers")
}

/// `refine.status` answers `in_flight` for a user-run `/refine` too: the
/// flight counts every refinement run at its one shared start, not only
/// the model-requested boundary consumption.
#[tokio::test]
async fn refine_status_reports_a_user_refine_in_flight() {
    let _faux = FAUX_TEST_LOCK.lock().await;
    let (engine, dir, model) = faux_engine_with_settings(
        json!({ "responses": [{"text": "seed"}] }),
        json!({ "compaction": {"enabled": false}, "autoRefine": {"enabled": true, "compact": true, "cooldownMs": 0} }),
        None,
    )
    .await;
    engine
        .session
        .prompt("seed", pa_core::session_engine::PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    pa_ai::registry::register_api_provider(
        Arc::new(HeldPlanner {
            started: started.clone(),
            release: release.clone(),
            reply: r#"{"summary":"background note","edits":[]}"#,
        }),
        Some("test-held-refinement-host"),
    );
    let mut planner_model = model.clone();
    planner_model.api = "test-held-refinement-host".to_string();
    let mut boundary = TurnBoundary::new(false);
    let global_dir = dir.path().join("global-refinement");
    let pending = Origin::Slash
        .schedule(&engine, &planner_model, &mut boundary, global_dir)
        .await
        .expect("the user /refine scheduled its refinement");
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .expect("planner entered");
    // Planning is held: the user-scheduled run is in flight.
    let status = refine_status(&engine).await;
    assert_eq!(status["pending"], false, "{status}");
    assert_eq!(
        status["in_flight"], true,
        "a held user refinement must answer in flight: {status}"
    );
    release.notify_one();
    pending.await.unwrap().unwrap();
    let status = refine_status(&engine).await;
    assert_eq!(
        status["in_flight"], false,
        "the settled run clears the flight: {status}"
    );
    pa_ai::registry::unregister_api_providers("test-held-refinement-host");
}

/// The background completion reporter replays the rows the commit
/// persisted — outcome then notice — instead of rebuilding them with a
/// fresh timestamp after the fact.
#[tokio::test]
async fn background_completion_replays_the_persisted_refinement_rows() {
    let _faux = FAUX_TEST_LOCK.lock().await;
    let (engine, dir, model) = faux_engine_with_settings(
        json!({ "responses": [{"text": "seed"}] }),
        json!({ "compaction": {"enabled": false}, "autoRefine": {"enabled": true, "compact": true, "cooldownMs": 0} }),
        None,
    )
    .await;
    engine
        .session
        .prompt("seed", pa_core::session_engine::PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    pa_ai::registry::register_api_provider(
        Arc::new(HeldPlanner {
            started: started.clone(),
            release: release.clone(),
            reply: r#"{"summary":"background note","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#,
        }),
        Some("test-held-refinement-host"),
    );
    let mut planner_model = model.clone();
    planner_model.api = "test-held-refinement-host".to_string();
    let (sink, events) = capture_sink();
    let mut boundary = TurnBoundary::with_sink(true, sink);
    let global_dir = dir.path().join("global-refinement");
    let pending = Origin::Slash
        .schedule(&engine, &planner_model, &mut boundary, global_dir)
        .await
        .expect("the user /refine scheduled its refinement");
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .expect("planner entered");
    release.notify_one();
    // Let the run settle on its own; the handle stays unawaited so the
    // reporter consumes the completed result.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !pending.is_finished() {
        assert!(
            std::time::Instant::now() < deadline,
            "the refinement run never settled"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // Force the wall clock past the commit's row timestamps: a reporter
    // rebuilding the rows would stamp a later now_millis().
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    boundary.report_background_refinement(pending, /*fails_run*/ true);
    boundary.wait_for_refinement_reports().await;
    let durable = refine_rows(&engine).await;
    assert_eq!(durable.len(), 2, "the outcome and notice rows landed");
    let streamed: Vec<serde_json::Value> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "message_end")
        .map(|event| event["message"].clone())
        .filter(|message| {
            message["customType"] == "refinement_outcome"
                || message["customType"] == "refinement_notice"
        })
        .collect();
    assert_eq!(streamed.len(), 2, "the reporter streamed both rows");
    for (streamed, durable) in streamed.iter().zip(durable.iter()) {
        assert_eq!(
            streamed,
            &serde_json::to_value(SessionAgentMessage::Custom(durable.clone())).unwrap(),
            "the streamed row must equal the durable transcript row, timestamp included"
        );
    }
    pa_ai::registry::unregister_api_providers("test-held-refinement-host");
}

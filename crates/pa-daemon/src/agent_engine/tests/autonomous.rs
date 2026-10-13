//! The autonomous tests (the driver loop, its gate and its limit).
use super::*;

#[test]
fn autonomous_on_enables_the_driver_loop() {
    let (engine, events) = run_prompts(
        &serde_json::json!({ "responses": ["unused"] }),
        &["/autonomous on --max-continuations 1 --max-turns 5"],
    );
    // The enable prompt runs the session command; no model turn admits.
    let status = custom_rows(&events);
    assert!(status
        .iter()
        .any(|row| row["customType"] == "autonomous_status"
            && row["content"]
                .as_str()
                .unwrap_or_default()
                .starts_with("[autonomous-status: on]")));
    assert_eq!(assistant_texts(&events), Vec::<String>::new());
    let state = engine.autonomous.blocking_lock();
    assert!(state.enabled);
    assert_eq!(state.limits.max_continuations, 1);
    assert_eq!(state.limits.max_turns, 5);
}

#[test]
fn autonomous_limit_stops_the_run_without_a_row() {
    let (engine, events) = run_prompts(
        &serde_json::json!({ "responses": ["first", "second"] }),
        &["/autonomous on --max-continuations 1 --max-turns 5", "go"],
    );
    // The continuation churns INSIDE the one run (the TS in-run shape):
    // no run boundary between the settled turn and the continuation. Turn
    // 2 hits the cap; the stop writes no row.
    assert_eq!(assistant_texts(&events), vec!["first", "second"]);
    let texts = user_texts(&events);
    assert_eq!(
        texts,
        vec![
            "go".to_string(),
            "[autonomous-continuation]\n\nNo human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.".to_string()
        ]
    );
    // One `turn_start` frame between the settled `turn_end` and the continuation user row.
    let turn_ends = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .count();
    let turn_starts = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::TurnStart))
        .count();
    assert_eq!(turn_ends, 2);
    assert_eq!(turn_starts, 1, "the continuation turn's inner start");
    // The stop surfaces no `autonomous_status` row: the enable announcement is the only one.
    let status_rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] == "autonomous_status")
        .collect();
    assert_eq!(status_rows.len(), 1, "the enable announcement only");
    assert!(status_rows[0]["content"]
        .as_str()
        .unwrap_or_default()
        .starts_with("[autonomous-status: on]"));
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // Per-turn usage accounting: two settled turns.
    let state = engine.autonomous.blocking_lock();
    assert_eq!(state.turns_used, 2);
    assert_eq!(state.continuations_used, 1);
}

#[test]
fn autonomous_gate_pass_and_failure_drive_the_loop() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The gate passes only on its second run (a counter file in the cwd).
    let dir = tempfile::TempDir::new().unwrap();
    let gate = format!(
        "n=$(cat {0}/cnt 2>/dev/null || echo 0); echo $((n+1)) > {0}/cnt; [ $n -ge 1 ]",
        dir.path().display()
    );
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                serde_json::json!({ "responses": ["first attempt", "fixed it"] }).to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let on = format!("/autonomous on --gate {gate:?}");
    let mut events: Vec<EngineEvent> = Vec::new();
    for prompt in [on.as_str(), "go"] {
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
    // Turn 1 fails the gate -> a gate-failure continuation in the same
    // run; turn 2 passes -> the run stops with no row.
    assert_eq!(assistant_texts(&events), vec!["first attempt", "fixed it"]);
    let texts = user_texts(&events);
    assert_eq!(texts.len(), 2);
    assert!(texts[1].starts_with("[autonomous-continuation: gate-failed]"));
    assert!(texts[1].contains("exited with code 1"));
    let status_rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] == "autonomous_status")
        .collect();
    assert_eq!(status_rows.len(), 1, "the enable announcement only");
    assert!(status_rows[0]["content"]
        .as_str()
        .unwrap_or_default()
        .starts_with("[autonomous-status: on]"));
    let state = engine.autonomous.blocking_lock();
    assert_eq!(state.gates.commands, vec![gate]);
    assert_eq!(state.last_gate_failure, None);
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

/// A scripted policy driver: inject what the trait returns, consult after every turn, account
/// every settled message.
#[cfg(test)]
struct ScriptedDriver {
    /// Pops from the end, so reverse the desired order when building.
    follow_ups: std::sync::Mutex<Vec<pa_core::autonomous::AutonomousFollowUp>>,
    accounted: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl pa_core::autonomous::AutonomousDriver for ScriptedDriver {
    fn account_message(
        &self,
        _state: &mut pa_core::autonomous::AutonomousRuntimeState,
        message: &pa_types::ai::AssistantMessage,
    ) {
        assert_ne!(message.stop_reason, pa_types::ai::StopReason::Error);
        self.accounted
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn after_turn<'a>(
        &'a self,
        _state: &'a mut pa_core::autonomous::AutonomousRuntimeState,
        _message: &'a pa_types::ai::AssistantMessage,
    ) -> pa_core::autonomous::AutonomousFollowUpFuture<'a> {
        let next = self
            .follow_ups
            .lock()
            .unwrap()
            .pop()
            .unwrap_or(pa_core::autonomous::AutonomousFollowUp::Inactive);
        Box::pin(async move { next })
    }
}

#[test]
fn the_turn_loop_is_driven_by_the_driver_trait() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(serde_json::json!({ "responses": ["one", "two"] }).to_string()),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let status = pa_core::autonomous::autonomous_status(&engine.autonomous.blocking_lock());
    // The queue pops from the end: the continuation is consulted first,
    // the stop on the second settled turn.
    let driver = std::sync::Arc::new(ScriptedDriver {
        follow_ups: std::sync::Mutex::new(vec![
            pa_core::autonomous::AutonomousFollowUp::Stop {
                reason: pa_core::autonomous::AutonomousStopReason::Limit(
                    pa_core::autonomous::AutonomousLimitReason::MaxTurns,
                ),
                status: Box::new(status),
            },
            pa_core::autonomous::AutonomousFollowUp::Continue {
                text: "scripted continuation".to_string(),
            },
        ]),
        accounted: std::sync::atomic::AtomicUsize::new(0),
    });
    engine
        .set_autonomous_driver(std::sync::Arc::clone(&driver)
            as std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>);
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "go".to_string(),
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
    // The engine holds no autonomous logic of its own: the injected text
    // and the turn count come straight from the trait, minted by the
    // in-run hook (the continuation runs inside the one agent run).
    assert_eq!(
        user_texts(&events),
        vec!["go".to_string(), "scripted continuation".to_string()]
    );
    assert_eq!(
        assistant_texts(&events),
        vec!["one".to_string(), "two".to_string()]
    );
    // The stop surfaces no row (the TS shape).
    assert!(custom_rows(&events)
        .into_iter()
        .all(|row| row["customType"] != "autonomous_status"));
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // Per-message accounting ran through the trait for both settled turns.
    assert_eq!(
        driver.accounted.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

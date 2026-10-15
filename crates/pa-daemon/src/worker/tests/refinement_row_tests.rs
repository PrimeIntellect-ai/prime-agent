use super::*;
use crate::engine::{EngineEvent, PromptRequest};
use pa_core::session_engine::refine::RefinementSource;

#[tokio::test]
async fn refinement_row_cannot_broadcast_into_a_replacement_session() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "original-active".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": [] })),
        },
        None,
    );
    let original = SessionFile::create("/tmp", None, 0);
    let original_id = original.session_id().to_string();
    let generation = {
        let mut core = worker.core.lock().unwrap();
        core.store = Some(original);
        core.generation.clone()
    };
    let mut subscription = worker.events.subscribe();
    let replacement_blocked = std::rc::Rc::new(std::cell::Cell::new(false));
    let observed = replacement_blocked.clone();
    let core = Arc::clone(&worker.core);
    // Interleave navigation at the precise persistence-to-broadcast boundary.
    // Before the fix, this acquires the released lock and both frames land on
    // replacement-active. With the fix, navigation must wait for the pair.
    BEFORE_REFINEMENT_ROW_BROADCAST.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || match core.try_lock() {
            Ok(mut core) => {
                core.store = Some(SessionFile::create("/tmp", None, 0));
                core.active_session_id = "replacement-active".to_string();
                core.generation = "replacement-generation".to_string();
            }
            Err(std::sync::TryLockError::WouldBlock) => observed.set(true),
            Err(std::sync::TryLockError::Poisoned(_)) => panic!("core lock poisoned"),
        }));
    });
    let message = json!({
        "role": "custom",
        "customType": "refinement_outcome",
        "content": "Refinement complete",
        "display": true,
        "details": { "refinementId": "refine-test" },
    });
    assert!(emit_refinement_row(
        &worker.core,
        &worker.events,
        &original_id,
        &message,
    ));
    let mut actual = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        let outbound: Value = serde_json::from_slice(&frame.payload).unwrap();
        actual.push(json!({
            "activeSessionId": outbound["activeSessionId"],
            "event": outbound["event"],
            "metaSession": outbound["meta"]["activeSessionId"],
            "cursor": outbound["meta"]["cursor"],
        }));
    }
    let expected: Vec<_> = ["message_start", "message_end"]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| {
            json!({
                "activeSessionId": "original-active",
                "event": { "type": kind, "message": message },
                "metaSession": "original-active",
                "cursor": { "generation": generation, "sequence": index + 1 },
            })
        })
        .collect();
    assert_eq!(actual, expected);
    assert!(replacement_blocked.get());
    // Returning to the same session file creates a new generation. A completed
    // old callback must not append its rows a second time after that return.
    worker.core.lock().unwrap().generation = "reattached-generation".to_string();
    assert!(!emit_refinement_row_for_generation(
        &worker.core,
        &worker.events,
        &original_id,
        Some(&generation),
        &message,
    ));
    assert!(!emit_refinement_event_for_generation(
        &worker.core,
        &worker.events,
        &original_id,
        Some(&generation),
        json!({ "type": "refine_complete" }),
    ));
    assert!(subscription.try_recv().is_err());
    {
        let mut core = worker.core.lock().unwrap();
        assert_eq!(core.store.as_ref().unwrap().entries().len(), 1);
        core.store = Some(SessionFile::create("/tmp", None, 0));
        core.active_session_id = "replacement-active".to_string();
    }
    assert!(!emit_refinement_row(
        &worker.core,
        &worker.events,
        &original_id,
        &message,
    ));
    assert!(subscription.try_recv().is_err());
    assert!(worker
        .core
        .lock()
        .unwrap()
        .store
        .as_ref()
        .unwrap()
        .entries()
        .is_empty());
}

/// A committed refinement whose rows carry fixed old timestamps: the
/// synchronous emitters must replay these rows verbatim, so any rebuild
/// (a fresh `now_millis()`) shows up as a timestamp mismatch.
fn committed_fixture(
    source: RefinementSource,
) -> pa_core::session_engine::refine::CommittedRefinement {
    let result = pa_core::refinement::RefinementResult {
        id: "refine_fixture".to_string(),
        summary: "note the tactic".to_string(),
        rationale: "repeated".to_string(),
        expected_outcome: "recall".to_string(),
        applied_edits: vec![pa_core::refinement::AppliedRefinementEdit {
            action: pa_core::refinement::RefinementAction::Create,
            kind: pa_core::refinement::RefinementKind::Memory,
            id: "m1".to_string(),
            before: None,
            after: None,
            applied: true,
            error: None,
            reason: None,
            title: Some("Tactic".to_string()),
            content: Some("Use tactic A".to_string()),
            path: None,
            reference: None,
            arguments: None,
            metadata: None,
        }],
        harness_state_path: String::new(),
        rollback_of: None,
        scope: Some(pa_core::refinement::HarnessScope::Local),
    };
    let mut outcome = pa_core::session_engine::refine::create_refinement_outcome_message(&result);
    outcome.timestamp = 1_000;
    let mut notice =
        pa_core::session_engine::refine::create_refinement_notice_message(&result, source);
    notice.timestamp = 1_001;
    pa_core::session_engine::refine::CommittedRefinement {
        result,
        rows: vec![outcome, notice],
    }
}

/// The fixture rows in the wire form the emitters broadcast: the same
/// serialization `emit_refinement_row` frames carry.
fn fixture_rows_on_the_wire(source: RefinementSource) -> Vec<Value> {
    committed_fixture(source)
        .rows
        .iter()
        .map(|row| {
            serde_json::to_value(pa_types::session::AgentMessage::Custom(row.clone())).unwrap()
        })
        .collect()
}

/// The scripted-harness engine serving the fixed committed refinement from
/// both synchronous seams: the compact-trigger round and the `refine`
/// command (the create-path seams keep their trait defaults).
struct CommittedRowsEngine;
impl SessionEngine for CommittedRowsEngine {
    fn run_prompt(
        &self,
        _: usize,
        _: PromptRequest,
        _: &dyn Fn() -> bool,
        _: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
    }
    fn run_side_question(
        &self,
        request: crate::engine::SideQuestionRequest,
        signal: &pa_agent::abort::AbortSignal,
        sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> crate::engine::SideQuestionOutcome {
        crate::engine::ScriptedEngine::default().run_side_question(request, signal, sink)
    }
    fn run_compaction(
        &self,
        request: crate::engine::CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::CompactionOutcome {
        crate::engine::ScriptedEngine::default().run_compaction(request, signal)
    }
    fn run_branch_summary(
        &self,
        request: crate::engine::BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        crate::engine::ScriptedEngine::default().run_branch_summary(request, signal)
    }
    fn rebuild_session_context(
        &self,
        _: Vec<pa_types::session::FileEntry>,
        _: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }
    fn consume_compact_auto_refine(
        &self,
    ) -> anyhow::Result<Option<pa_core::session_engine::refine::CommittedRefinement>> {
        Ok(Some(committed_fixture(RefinementSource::Auto)))
    }
    fn run_refinement(
        &self,
        _options: pa_core::session_engine::refine::RefineOptions,
    ) -> anyhow::Result<pa_core::session_engine::refine::CommittedRefinement> {
        Ok(committed_fixture(RefinementSource::User))
    }
}

/// A created worker over the committed-rows engine, with a durable session
/// directory (the row emitters persist through the store).
async fn committed_rows_worker(dir: &std::path::Path) -> Worker {
    let session_dir = dir.join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    let mut worker = Worker::new(
        WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "replay-rows".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "replay-rows".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({ "responses": [] })),
        },
        None,
    );
    worker.engine = Arc::new(CommittedRowsEngine);
    let created = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "name": "replay"}),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

/// The refinement rows the subscription carried, in wire order.
fn streamed_refinement_rows(events: Vec<Value>) -> Vec<Value> {
    events
        .into_iter()
        .filter(|event| event["type"] == "message_end")
        .map(|event| event["message"].clone())
        .filter(|message| {
            message["customType"] == "refinement_outcome"
                || message["customType"] == "refinement_notice"
        })
        .collect()
}

/// The `compact` command's synchronous completion replays the persisted
/// rows — the committed outcome and notice the engine already recorded —
/// instead of rebuilding them with a fresh timestamp.
#[tokio::test]
async fn compact_command_replays_the_persisted_refinement_rows() {
    let dir = tempfile::tempdir().unwrap();
    let worker = committed_rows_worker(dir.path()).await;
    let mut subscription = worker.events.subscribe();
    let compacted = worker.dispatch("compact", &json!({})).await;
    assert!(compacted.success, "compact failed: {compacted:?}");
    let streamed = streamed_refinement_rows(session_events_since(&mut subscription));
    assert_eq!(
        streamed,
        fixture_rows_on_the_wire(RefinementSource::Auto),
        "the streamed rows must equal the persisted rows, timestamp included"
    );
}

/// The turn settle's background review completion replays the persisted
/// rows for the serviced session.
#[tokio::test]
async fn turn_settle_review_replays_the_persisted_refinement_rows() {
    let engine: Arc<dyn SessionEngine> = Arc::new(CommittedRowsEngine);
    let runner = crate::worker::turn_stream_tests::burst_runner(Arc::clone(&engine));
    // The row emitters fence on the serviced session's store.
    runner.core.lock().unwrap().store = Some(SessionFile::create("/tmp", None, 0));
    let mut subscription = runner.events.subscribe();
    runner
        .run_turn(
            Arc::clone(&engine),
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "burst".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            }],
        )
        .await;
    // The review services in a detached task after the settle: await the
    // two frames instead of draining synchronously.
    let deadline = std::time::Duration::from_secs(5);
    let mut streamed = Vec::new();
    while streamed.len() < 2 {
        let frame = tokio::time::timeout(deadline, subscription.recv()).await;
        let frame = frame
            .expect("the settle review never streamed both rows")
            .expect("the event pump dropped the subscriber");
        if frame.outbound_type == "session_event" {
            let outbound: Value = serde_json::from_slice(&frame.payload).unwrap();
            let event = outbound["event"].clone();
            if event["type"] == "message_end"
                && (event["message"]["customType"] == "refinement_outcome"
                    || event["message"]["customType"] == "refinement_notice")
            {
                streamed.push(event["message"].clone());
            }
        }
    }
    assert_eq!(
        streamed,
        fixture_rows_on_the_wire(RefinementSource::Auto),
        "the streamed rows must equal the persisted rows, timestamp included"
    );
}

/// The `refine` command's synchronous completion replays the persisted rows
/// for the serviced generation and answers the unchanged result shape.
#[tokio::test]
async fn refine_command_replays_the_persisted_refinement_rows() {
    let dir = tempfile::tempdir().unwrap();
    let worker = committed_rows_worker(dir.path()).await;
    let mut subscription = worker.events.subscribe();
    let refined = worker.dispatch("refine", &json!({})).await;
    assert!(refined.success, "refine failed: {refined:?}");
    assert_eq!(
        refined.data,
        Some(serde_json::to_value(&committed_fixture(RefinementSource::User).result).unwrap()),
        "the response keeps answering the result"
    );
    let streamed = streamed_refinement_rows(session_events_since(&mut subscription));
    assert_eq!(
        streamed,
        fixture_rows_on_the_wire(RefinementSource::User),
        "the streamed rows must equal the persisted rows, timestamp included"
    );
}

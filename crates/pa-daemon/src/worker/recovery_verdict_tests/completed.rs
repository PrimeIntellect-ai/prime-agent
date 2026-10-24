//! Shutdown arriving after terminal success but before the engine thread returns.
use super::*;

struct CompletedBeforeReturnEngine {
    completed: Arc<Notify>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

impl SessionEngine for CompletedBeforeReturnEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        let mut content = vec![json!({ "type": "text", "text": request.message })];
        content.extend(request.images.iter().map(
            |image| json!({ "type": "image", "data": image.data, "mimeType": image.mime_type }),
        ));
        let user = json!({ "role": "user", "content": content, "timestamp": 1 });
        let assistant = json!({
            "role": "assistant", "content": "completed synthetic task", "timestamp": 2,
            "stopReason": "stop",
        });
        assert!(emit(EngineEvent::UserMessage(user.clone())));
        assert!(emit(EngineEvent::AssistantMessage(assistant.clone())));
        assert!(emit(EngineEvent::AgentEnd {
            messages: vec![user, assistant],
        }));
        assert!(emit(EngineEvent::Done(Ok(()))));
        // Notification proves that the real worker callback consumed Done(Ok),
        // including its terminal settle result, before shutdown is requested.
        self.completed.notify_one();
        // A failed async assertion drops the sender and releases this thread.
        let _ = self.release.lock().unwrap().recv();
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
            message: "unsupported".to_string(),
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

#[tokio::test]
async fn completed_turn_shutdown_does_not_mint_a_restart_continuation() {
    let fixture = tempfile::tempdir().unwrap();
    let worker = worker_with_journal_in(fixture.path());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if worker.core.lock().unwrap().last_activity_ms != 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ordinary runner must park before the test-owned runner picks input");
    let session_path = fixture.path().join("session.jsonl");
    let mut store = SessionFile::create(fixture.path().to_str().unwrap(), None, 0);
    store.set_path(session_path.clone());
    let (settle, settled) = oneshot::channel();
    {
        let mut core = worker.core.lock().unwrap();
        core.created = true;
        core.store = Some(store);
        core.steering.push_back(QueuedItem {
            message: "completed original with image".to_string(),
            priority: QueuePriority::Human,
            preview: Some("completed original".to_string()),
            custom_message: None,
            agent_message: None,
            queue_key: Some("completed-original".to_string()),
            admission_id: Some("completed-admission".to_string()),
            images: vec![pa_agent::types::ImageContent {
                data: "QUJD".to_string(),
                mime_type: "image/png".to_string(),
            }],
            done: Some(settle),
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    }
    worker.checkpoint_queue(QueueCheckpoint::Admitted {
        operation: "prompt_accepted",
    });
    let (release, released) = std::sync::mpsc::channel();
    let engine = Arc::new(CompletedBeforeReturnEngine {
        completed: Arc::new(Notify::new()),
        release: std::sync::Mutex::new(released),
    });
    let completed_notify = Arc::clone(&engine.completed);
    let completed = completed_notify.notified();
    let runner = gated_turn_runner(&worker, engine);
    let running = tokio::spawn(async move { runner.run().await });
    tokio::time::timeout(std::time::Duration::from_secs(5), completed)
        .await
        .expect("engine never reached the post-Done pre-return gate");
    {
        let core = worker.core.lock().unwrap();
        assert!(core.busy, "engine thread has not joined or settled yet");
        assert!(core.steering.is_empty() && core.follow_up.is_empty());
        assert!(!core.shutdown_requested && !core.abort_requested);
    }
    let expected_messages = vec![
        json!({
            "role": "user", "timestamp": 1,
            "content": [
                { "type": "text", "text": "completed original with image" },
                { "type": "image", "data": "QUJD", "mimeType": "image/png" },
            ],
        }),
        json!({
            "role": "assistant", "content": "completed synthetic task", "timestamp": 2,
            "stopReason": "stop",
        }),
    ];
    let read_messages = || {
        std::fs::read_to_string(&session_path)
            .expect("completed messages must already be in the physical transcript")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|row| row["type"] == "message")
            .map(|row| row["message"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(read_messages(), expected_messages);
    let stopping = Arc::clone(&worker);
    let shutdown = tokio::spawn(async move {
        stopping
            .handle_shutdown(&json!({ "daemonShutdown": true }))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if worker.core.lock().unwrap().shutdown_requested {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("actual shutdown never armed its close gate");
    assert!(worker.core.lock().unwrap().abort_requested);
    release
        .send(())
        .expect("release the completed engine thread");
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
        .await
        .expect("actual shutdown never settled")
        .expect("shutdown task panicked");
    assert!(reply.success, "shutdown failed: {reply:?}");
    tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .expect("test-owned runner never exited")
        .expect("test-owned runner panicked");
    assert_eq!(read_messages(), expected_messages);
    let durable_queue = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("the actual shutdown must leave a durable queue checkpoint");
    assert_eq!(
        serde_json::to_value(durable_queue).unwrap(),
        json!([[], [], false]),
        "terminal success must not mint a generic restart continuation or replay the original"
    );
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(5), settled)
            .await
            .expect("the completed prompt must receive its real settle result")
            .unwrap(),
        TurnSettle::Completed
    );
    let verdict = latest_record(&worker);
    assert_eq!(verdict.operation, "shutdown");
    assert!(!verdict.busy, "a completed turn leaves no interrupted work");
}

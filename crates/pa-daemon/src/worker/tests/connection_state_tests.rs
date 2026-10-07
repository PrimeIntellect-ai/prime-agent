//! The attach snapshot's context-usage fill (TS `createAgentConnectionState`
//! parity): the state block carries `contextUsage` off the same store walk
//! `get_session_stats` serves, so the client's first frame reads the tray's
//! usage off the snapshot instead of blocking on a stats round-trip.
use super::*;
use crate::engine::{PromptRequest, SessionEngine};
use crate::worker::WorkerConfig;

/// The scripted harness engine with a resolved model context window: the
/// tray-usage fill's one input beyond the store.
struct WindowedEngine;
impl SessionEngine for WindowedEngine {
    fn run_prompt(
        &self,
        _: usize,
        _: PromptRequest,
        _: &dyn Fn() -> bool,
        _: &mut dyn FnMut(crate::engine::EngineEvent) -> bool,
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
    fn model_context_window(&self) -> Option<u64> {
        Some(128_000)
    }
}

/// The attach snapshot's state carries the tray's context usage exactly as
/// `get_session_stats` serves it (TS `createAgentConnectionState`'s
/// `contextUsage: session.getContextUsage()`): the same walk, the same
/// store, so the snapshot-fed tray row is byte-identical to the row a
/// blocking stats fetch would have painted.
#[tokio::test]
async fn the_attach_state_carries_the_stats_context_usage() {
    let dir = tempfile::tempdir().unwrap();
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    let mut worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "context-usage-test".into(),
            worker_instance_id: String::new(),
            active_session_id: "ctx-usage".into(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({"responses":[]})),
        },
        None,
    );
    worker.engine = std::sync::Arc::new(WindowedEngine);
    let created = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "name": "usage"}),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");

    let snapshot_state = {
        let core = worker.core.lock().unwrap();
        let sealed = worker.connection_state_locked(&core);
        serde_json::to_value(&sealed).unwrap()
    };
    assert_eq!(
        snapshot_state.get("contextUsage"),
        Some(&json!({"tokens": 0, "contextWindow": 128_000, "percent": 0.0})),
        "the attach state carries the tray usage: {snapshot_state}"
    );

    // The equivalence the byte-identity oracle rests on: the stats
    // response serves the very same usage object.
    let stats = worker.dispatch("get_session_stats", &json!({})).await;
    assert!(stats.success, "{stats:?}");
    assert_eq!(
        stats.data.as_ref().unwrap().get("contextUsage"),
        snapshot_state.get("contextUsage"),
        "the snapshot fill equals the stats response"
    );

    // A model-less engine keeps the field off the wire exactly like a TS
    // session without a model (the scripted default).
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker2.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "context-usage-test-2".into(),
            worker_instance_id: String::new(),
            active_session_id: "ctx-usage-2".into(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery2.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({"responses":[]})),
        },
        None,
    );
    worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "name": "usage-2"}),
        )
        .await;
    let modelless = {
        let core = worker.core.lock().unwrap();
        let sealed = worker.connection_state_locked(&core);
        serde_json::to_value(&sealed).unwrap()
    };
    assert!(
        modelless.get("contextUsage").is_none(),
        "a model-less session omits the field: {modelless}"
    );
}

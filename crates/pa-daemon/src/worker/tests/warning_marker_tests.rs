//! The Anthropic subscription warning's once-per-session-lifecycle gate at
//! the worker surface (operator directive 2026-09-29): the
//! `mark_anthropic_warning_shown` command persists the marker row through
//! the session file, `get_state` serves the hydrated flag, a repeated mark
//! is idempotent, and a fresh worker's open of the same file reads the same
//! gate — the reattach/resume contract.
use super::*;
use crate::engine::{EngineEvent, PromptRequest};
use crate::worker::WorkerConfig;

/// The scripted harness engine (the create-path seams keep their trait
/// defaults; the run seams stay inert — this suite drives no turn).
struct QuietEngine;
impl SessionEngine for QuietEngine {
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
}

fn worker_in(dir: &std::path::Path, session_id: &str) -> Worker {
    let mut worker = Worker::new(
        WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "warning-marker-test".into(),
            worker_instance_id: String::new(),
            active_session_id: session_id.into(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({"responses":[]})),
            decision_child: false,
        },
        None,
    );
    worker.engine = std::sync::Arc::new(QuietEngine);
    worker
}

#[tokio::test]
async fn the_mark_command_persists_and_serves_the_gate() {
    let dir = tempfile::tempdir().unwrap();
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    let worker = worker_in(dir.path(), "warning-mark");

    let created = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "name": "gate"}),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");

    // Before the mark the gate is closed: `get_state` carries the flag a
    // reattach reads.
    let state = worker.dispatch("get_state", &json!({})).await;
    assert!(state.success, "{state:?}");
    assert_eq!(
        state.data.as_ref().unwrap().get("anthropicWarningShown"),
        Some(&json!(false)),
        "an unmarked session reports the gate closed"
    );

    // The mark: persisted through the session file.
    let marked = worker
        .dispatch("mark_anthropic_warning_shown", &json!({}))
        .await;
    assert!(marked.success, "the mark failed: {marked:?}");
    let file = {
        let core = worker.core.lock().unwrap();
        core.store.as_ref().expect("created store").path.clone()
    };
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("anthropic_subscription_warning_shown"),
        "the marker row reached the session file: {text}"
    );

    // `get_state` serves the gate open.
    let state = worker.dispatch("get_state", &json!({})).await;
    assert_eq!(
        state.data.as_ref().unwrap().get("anthropicWarningShown"),
        Some(&json!(true)),
        "the marked session reports the gate open"
    );

    // A repeated mark is idempotent: one marker row, not one per client.
    let again = worker
        .dispatch("mark_anthropic_warning_shown", &json!({}))
        .await;
    assert!(again.success, "{again:?}");
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(
        text.matches("anthropic_subscription_warning_shown").count(),
        1,
        "the idempotent mark appended no second row"
    );

    // The reattach/resume contract: a fresh worker's session file opens
    // with the gate hydrated (the replacement/replay read).
    let reopened = crate::session_store::SessionFile::open(&file).unwrap();
    assert!(
        reopened.anthropic_warning_shown(),
        "the persisted marker hydrates a fresh open"
    );

    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "{killed:?}");
}

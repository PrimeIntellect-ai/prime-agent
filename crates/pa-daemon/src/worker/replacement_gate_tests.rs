//! Worker tests (moved with their concerns).
use super::*;
use crate::engine::SessionEngine;
use std::path::Path;

/// A recording engine whose session-model restore holds open for a
/// fixed window (the restore's readiness awaits): the event log proves
/// whether two concurrent replacement commands interleave their
/// teardown/swap/restore/rebuild critical sections.
struct RecordingEngine {
    events: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl SessionEngine for RecordingEngine {
    fn restore_session_model(
        &self,
        session_path: &std::path::Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let events = std::sync::Arc::clone(&self.events);
        let path = session_path.display().to_string();
        Box::pin(async move {
            events.lock().unwrap().push(format!("restore-enter {path}"));
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            events.lock().unwrap().push(format!("restore-exit {path}"));
        })
    }

    fn rebuild_session_context(
        &self,
        _: Vec<pa_types::session::FileEntry>,
        _: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        self.events.lock().unwrap().push("rebuild".to_string());
        Ok(())
    }

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
        ScriptedEngine::default().run_side_question(request, signal, sink)
    }

    fn run_compaction(
        &self,
        request: crate::engine::CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::CompactionOutcome {
        ScriptedEngine::default().run_compaction(request, signal)
    }

    fn run_branch_summary(
        &self,
        request: crate::engine::BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        ScriptedEngine::default().run_branch_summary(request, signal)
    }
}

fn written_session_file(dir: &Path, name: &str) -> PathBuf {
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    let path = dir.join(name);
    session.set_path(path.clone());
    session.rewrite().unwrap();
    path
}

fn recording_worker(dir: &Path, events: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> Worker {
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "replacement-gate".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: Some(true),
        script: Some(json!({ "responses": ["ack"] })),
    };
    let mut worker = Worker::new(config, None);
    let engine: std::sync::Arc<dyn SessionEngine> = std::sync::Arc::new(RecordingEngine { events });
    let core = std::sync::Arc::clone(&worker.core);
    worker.engine = std::sync::Arc::clone(&engine);
    worker.navigation = crate::session_navigation::SessionNavigation::new(engine, core);
    worker
}

/// Two concurrent `switch_session` commands must not interleave their
/// replacement critical sections: the teardown, the store/file swap,
/// the restore, and the rebuild move the worker onto one session as a
/// unit — the second command runs only after the first settles, so
/// the restore windows never overlap (an overlap would leave the
/// store, the branch context, and the model from different sessions).
#[tokio::test]
async fn concurrent_replacements_never_interleave_their_critical_sections() {
    let dir = std::env::temp_dir().join(format!(
        "pa-replacement-gate-{}-{}",
        std::process::id(),
        line!()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let worker = recording_worker(&dir, std::sync::Arc::clone(&events));
    let created = worker
        .dispatch("create", &json!({ "noSession": true, "cwd": "/tmp" }))
        .await;
    assert!(created.success, "create failed: {created:?}");

    let file_a = written_session_file(&dir, "session-a.jsonl");
    let file_b = written_session_file(&dir, "session-b.jsonl");
    let payload_a = json!({ "sessionPath": file_a.to_string_lossy(), "cwdOverride": "/tmp" });
    let payload_b = json!({ "sessionPath": file_b.to_string_lossy(), "cwdOverride": "/tmp" });
    let (first, second) = tokio::join!(
        worker.dispatch("switch_session", &payload_a),
        worker.dispatch("switch_session", &payload_b)
    );
    assert!(first.success, "first switch failed: {first:?}");
    assert!(second.success, "second switch failed: {second:?}");

    // The restore windows never overlap: no restore may enter while
    // another is still open.
    let log = events.lock().unwrap().clone();
    let mut open = false;
    for event in &log {
        if event.starts_with("restore-enter") {
            assert!(
                !open,
                "a replacement restored while another was in flight: {log:?}"
            );
            open = true;
        } else if event.starts_with("restore-exit") {
            open = false;
        }
    }
    assert_eq!(
        log.iter().filter(|e| e.starts_with("rebuild")).count(),
        2,
        "both replacements rebuilt: {log:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A failed existing-session `create` (a held lease, an unreadable
/// file) must never bind the engine to the failed path: the
/// session-model restore runs only after the file opened, so a later
/// create on a different session never resolves against the failed
/// path's model or records it in its creation prefix.
#[tokio::test]
async fn a_failed_existing_session_create_never_binds_the_engine() {
    let dir =
        std::env::temp_dir().join(format!("pa-create-bind-{}-{}", std::process::id(), line!()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let worker = recording_worker(&dir, std::sync::Arc::clone(&events));

    // An unreadable "session file" (a directory at the path): the
    // existing-session arm fails its windowed open.
    let held = dir.join("held.jsonl");
    std::fs::create_dir_all(&held).expect("directory at the session path");

    let failed = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": held.to_string_lossy(), "cwd": "/tmp" }),
        )
        .await;
    assert!(
        !failed.success,
        "the unreadable path must fail the create: {failed:?}"
    );

    // The engine never bound to the failed path: no restore ran for
    // it.
    let log = events.lock().unwrap().clone();
    assert!(
        log.iter().all(|event| !event.starts_with("restore-enter")),
        "a failed open never restores the failed path: {log:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

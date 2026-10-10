//! Worker tests.
use super::*;
use crate::engine::SessionEngine;
use std::path::Path;

/// A recording engine whose session-model restore holds open for a fixed
/// window: the event log proves whether two concurrent replacements interleave.
struct RecordingEngine {
    events: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl SessionEngine for RecordingEngine {
    fn restore_session_model(
        &self,
        session_path: &std::path::Path,
        _saved: Option<crate::engine::SavedSessionContext>,
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
    session.set_path(path.clone()).unwrap();
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
        decision_child: false,
    };
    let mut worker = Worker::new(config, None);
    let engine: std::sync::Arc<dyn SessionEngine> = std::sync::Arc::new(RecordingEngine { events });
    let core = std::sync::Arc::clone(&worker.core);
    worker.engine = std::sync::Arc::clone(&engine);
    worker.navigation = crate::session_navigation::SessionNavigation::new(engine, core);
    worker
}

/// Two concurrent `switch_session` commands must not interleave their
/// replacement critical sections — an overlap would leave the store, the
/// branch context, and the model from different sessions.
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

/// A failed existing-session `create` must never bind the engine to the
/// failed path: a later create on a different session never resolves against
/// the failed path's model.
#[tokio::test]
async fn a_failed_existing_session_create_never_binds_the_engine() {
    let dir =
        std::env::temp_dir().join(format!("pa-create-bind-{}-{}", std::process::id(), line!()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let worker = recording_worker(&dir, std::sync::Arc::clone(&events));

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

    let log = events.lock().unwrap().clone();
    assert!(
        log.iter().all(|event| !event.starts_with("restore-enter")),
        "a failed open never restores the failed path: {log:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_switched_session_repairs_a_torn_tail_before_its_first_append() {
    let dir = tempfile::tempdir().unwrap();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let worker = recording_worker(dir.path(), std::sync::Arc::clone(&events));
    let live = written_session_file(dir.path(), "live.jsonl");
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": live.to_string_lossy(), "cwd": "/tmp" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");

    let path = dir.path().join("torn.jsonl");
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    session.set_path(path.clone()).unwrap();
    session.append_message(&json!({"role":"user","content":"before","timestamp":0}));
    session.rewrite().unwrap();
    {
        use std::io::Write as _;
        let mut torn = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        torn.write_all(
            b"{\"type\":\"message\",\"id\":\"torn\",\"timestamp\":\"2026-10-07T00:00:00Z\",\"message\":{\"role\":\"user\",\"con\xc3",
        )
        .unwrap();
    }

    let switched = worker
        .dispatch(
            "switch_session",
            &json!({ "sessionPath": path.to_string_lossy(), "cwdOverride": "/tmp" }),
        )
        .await;
    assert!(switched.success, "switch failed: {switched:?}");
    let appended = {
        let mut core = worker.core.lock().unwrap();
        let store = core.store.as_mut().expect("the switched store is live");
        store
            .persist_entry(
                "message",
                json!({"message":{"role":"user","content":"after","timestamp":1}}),
            )
            .unwrap()
    };
    let reopened = crate::session_store::SessionFile::open(&path).unwrap();
    assert!(
        reopened.entry(&appended).is_some(),
        "the appended row reloads"
    );
    assert_eq!(reopened.leaf_id(), Some(appended.as_str()));
    drop(reopened);

    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "kill failed: {killed:?}");
    drop(worker);
}

#[tokio::test]
async fn a_switched_non_session_file_is_never_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let worker = recording_worker(dir.path(), std::sync::Arc::clone(&events));
    let live = written_session_file(dir.path(), "live.jsonl");
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": live.to_string_lossy(), "cwd": "/tmp" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");

    let path = dir.path().join("notes.txt");
    std::fs::write(&path, b"hello\nworld").unwrap();
    let switched = worker
        .dispatch(
            "switch_session",
            &json!({ "sessionPath": path.to_string_lossy(), "cwdOverride": "/tmp" }),
        )
        .await;
    assert!(!switched.success, "the switch must fail: {switched:?}");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"hello\nworld".to_vec(),
        "the non-session file keeps its bytes"
    );
    drop(worker);
}

#[tokio::test]
async fn a_resumed_session_repairs_a_non_utf8_torn_tail_before_its_first_append() {
    let dir = tempfile::tempdir().unwrap();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let worker = recording_worker(dir.path(), std::sync::Arc::clone(&events));
    let path = dir.path().join("resume-torn.jsonl");
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    session.set_path(path.clone()).unwrap();
    session.append_message(&json!({"role":"user","content":"before","timestamp":0}));
    session.rewrite().unwrap();
    {
        use std::io::Write as _;
        let mut torn = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        torn.write_all(
            b"{\"type\":\"message\",\"id\":\"torn\",\"timestamp\":\"2026-10-07T00:00:00Z\",\"message\":{\"role\":\"user\",\"con\xc3",
        )
        .unwrap();
    }

    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": path.to_string_lossy(), "cwd": "/tmp" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let appended = {
        let mut core = worker.core.lock().unwrap();
        let store = core.store.as_mut().expect("the resumed store is live");
        store
            .persist_entry(
                "message",
                json!({"message":{"role":"user","content":"after","timestamp":1}}),
            )
            .unwrap()
    };
    let reopened = crate::session_store::SessionFile::open(&path).unwrap();
    assert!(
        reopened.entry(&appended).is_some(),
        "the appended row reloads"
    );
    assert_eq!(reopened.leaf_id(), Some(appended.as_str()));
    drop(reopened);

    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "kill failed: {killed:?}");
    drop(worker);
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_session_repairs_its_target_and_keeps_the_append_lease() {
    let dir = tempfile::tempdir().unwrap();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let worker = recording_worker(dir.path(), events);
    let live = written_session_file(dir.path(), "live.jsonl");
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": live.to_string_lossy(), "cwd": "/tmp" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");

    let target = written_session_file(dir.path(), "target.jsonl");
    let alias = dir.path().join("alias.jsonl");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    {
        use std::io::Write as _;
        let mut torn = std::fs::OpenOptions::new()
            .append(true)
            .open(&target)
            .unwrap();
        torn.write_all(b"{\"type\":\"message\",\"id\":\"torn\",\"message\":\"con\xc3")
            .unwrap();
    }
    let switched = worker
        .dispatch(
            "switch_session",
            &json!({ "sessionPath": alias.to_string_lossy(), "cwdOverride": "/tmp" }),
        )
        .await;
    assert!(switched.success, "switch failed: {switched:?}");
    assert!(std::fs::symlink_metadata(&alias)
        .unwrap()
        .file_type()
        .is_symlink());
    let appended = {
        let mut core = worker.core.lock().unwrap();
        let store = core.store.as_mut().expect("the switched store is live");
        assert!(store.lease.is_some(), "the target has a held lease");
        store
            .persist_entry(
                "message",
                json!({"message":{"role":"user","content":"after","timestamp":1}}),
            )
            .expect("append through the alias under its target lease")
    };
    assert!(std::fs::symlink_metadata(&alias)
        .unwrap()
        .file_type()
        .is_symlink());
    let reopened = crate::session_store::SessionFile::open(&target).unwrap();
    assert!(
        reopened.entry(&appended).is_some(),
        "the target contains the append"
    );

    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "kill failed: {killed:?}");
    drop(worker);
}

#[test]
fn a_large_valid_last_row_stays_intact_during_tail_repair() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large-last-row.jsonl");
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    session.set_path(path.clone()).unwrap();
    let id = session.append_message(&json!({
        "role": "user",
        "content": "x".repeat(1024 * 1024 + 1),
        "timestamp": 0,
    }));
    session.rewrite().unwrap();
    let original = std::fs::read(&path).unwrap();
    assert!(original.len() > 1024 * 1024);
    pa_core::session::manager::repair_jsonl_damage(&path);
    assert_eq!(std::fs::read(&path).unwrap(), original);

    {
        use std::io::Write as _;
        let mut torn = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        torn.write_all(b"{\"type\":\"message\",\"id\":\"torn\"\xc3")
            .unwrap();
    }
    pa_core::session::manager::repair_jsonl_damage(&path);
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let reopened = crate::session_store::SessionFile::open(&path).unwrap();
    assert!(reopened.entry(&id).is_some(), "the large row reloads");
}

#[tokio::test]
async fn an_unleased_switch_never_rewrites_another_workers_damaged_file() {
    let dir = tempfile::tempdir().unwrap();
    let target = written_session_file(dir.path(), "owned.jsonl");
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let owner = recording_worker(dir.path(), std::sync::Arc::clone(&events));
    let created = owner
        .dispatch(
            "create",
            &json!({ "sessionPath": target.to_string_lossy(), "cwd": "/tmp" }),
        )
        .await;
    assert!(created.success, "owner create failed: {created:?}");
    assert!(owner
        .core
        .lock()
        .unwrap()
        .store
        .as_ref()
        .unwrap()
        .lease
        .is_some());
    {
        use std::io::Write as _;
        let mut torn = std::fs::OpenOptions::new()
            .append(true)
            .open(&target)
            .unwrap();
        torn.write_all(b"{\"type\":\"message\",\"id\":\"torn\",\"message\":\"con\xc3")
            .unwrap();
    }
    let before = std::fs::read(&target).unwrap();
    let visitor = recording_worker(dir.path(), events);
    let created = visitor
        .dispatch("create", &json!({ "noSession": true, "cwd": "/tmp" }))
        .await;
    assert!(created.success, "visitor create failed: {created:?}");
    let switched = visitor
        .dispatch(
            "switch_session",
            &json!({ "sessionPath": target.to_string_lossy(), "cwdOverride": "/tmp" }),
        )
        .await;
    assert!(
        !switched.success,
        "the damaged target must fail open: {switched:?}"
    );
    assert_eq!(std::fs::read(&target).unwrap(), before);
    assert!(owner
        .core
        .lock()
        .unwrap()
        .store
        .as_ref()
        .unwrap()
        .lease
        .is_some());

    let killed = visitor.dispatch("kill", &json!({})).await;
    assert!(killed.success, "visitor kill failed: {killed:?}");
    let killed = owner.dispatch("kill", &json!({})).await;
    assert!(killed.success, "owner kill failed: {killed:?}");
    drop(visitor);
    drop(owner);
}

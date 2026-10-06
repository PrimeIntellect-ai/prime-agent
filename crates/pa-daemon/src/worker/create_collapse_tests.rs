//! Tests for the fresh-path create write collapse: the single durable write
//! (header + prefix + state + name) is byte-equivalent to the sequential writes
//! it replaces, the failure window leaves no session file, and an old build's
//! header-only crash artifact is neither consumed nor bled into.

use std::path::PathBuf;

use super::*;
use crate::engine::{
    BranchSummaryOutcome, BranchSummaryRequest, CompactionOutcome, CompactionRequest, EngineEvent,
    PromptRequest, ScriptedEngine,
};
use crate::worker::WorkerConfig;

/// The scripted harness engine: the create-path seams keep their trait
/// defaults (no `model_change`, `"off"` thinking).
struct OffEngine;
impl SessionEngine for OffEngine {
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
        request: CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        ScriptedEngine::default().run_compaction(request, signal)
    }
    fn run_branch_summary(
        &self,
        request: BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> BranchSummaryOutcome {
        ScriptedEngine::default().run_branch_summary(request, signal)
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
            token: "collapse-test".into(),
            worker_instance_id: String::new(),
            active_session_id: session_id.into(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({"responses":[]})),
        },
        None,
    );
    worker.engine = std::sync::Arc::new(OffEngine);
    worker
}

/// The pre-collapse fresh-path write sequence, replayed with the same
/// primitives the old arm used: header-only rewrite, creation prefix,
/// `active` state, second rewrite, name append.
fn legacy_sequence_file(
    dir: &std::path::Path,
    session_dir: &std::path::Path,
    name: &str,
) -> std::path::PathBuf {
    let mut legacy = SessionFile::create("/tmp", None, 0);
    let path = session_dir.join(session_file_name(legacy.session_id()));
    legacy.set_path(path.clone());
    legacy.rewrite().unwrap();
    append_creation_prefix(&mut legacy, &OffEngine, &dir.join("agent"), "/tmp", true);
    let _ = legacy.append_session_state("active");
    legacy.rewrite().unwrap();
    legacy
        .persist_entry("session_info", json!({ "name": name }))
        .unwrap();
    path
}

/// Parsed lines with the per-run identity masked (minted `id`s, the
/// `parentId` chain, the `timestamp`s); everything else must be byte-equal.
fn masked_lines(path: &std::path::Path) -> Vec<Value> {
    let mut rows = Vec::new();
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let mut value: Value = serde_json::from_str(line).unwrap();
        let is_header = value.get("type").and_then(Value::as_str) == Some("session");
        if let Value::Object(map) = &mut value {
            map.remove("id");
            map.remove("parentId");
            map.remove("timestamp");
            if is_header {
                map.remove("parentSession");
            }
        }
        rows.push(value);
    }
    rows
}

fn entry_types(path: &std::path::Path) -> Vec<String> {
    masked_lines(path)
        .iter()
        .map(|row| {
            row.get("type")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string()
        })
        .collect()
}

#[tokio::test]
async fn fresh_create_single_write_matches_legacy_sequence_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_dir = dir.path().join("legacy");
    let fresh_dir = dir.path().join("fresh");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::create_dir_all(&fresh_dir).unwrap();
    let legacy = legacy_sequence_file(dir.path(), &legacy_dir, "lane-child");
    let worker = worker_in(dir.path(), "collapse-diff");
    let response = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": fresh_dir, "name": "lane-child"}),
        )
        .await;
    assert!(response.success, "{response:?}");
    let fresh = {
        let core = worker.core.lock().unwrap();
        core.store.as_ref().unwrap().path.clone()
    };
    assert!(
        fresh.exists(),
        "the fresh arm's own file must exist after its single write"
    );
    assert_eq!(
        masked_lines(&legacy),
        masked_lines(&fresh),
        "the single-write fresh file must carry the legacy sequence's exact masked bytes"
    );
    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "{killed:?}");
}

#[tokio::test]
async fn fresh_create_folds_name_into_the_single_write() {
    let dir = tempfile::tempdir().unwrap();
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    let worker = worker_in(dir.path(), "collapse-name");
    let response = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "name": "named-child"}),
        )
        .await;
    assert!(response.success, "{response:?}");
    let file = {
        let core = worker.core.lock().unwrap();
        core.store.as_ref().unwrap().path.clone()
    };
    assert_eq!(
        entry_types(&file),
        vec![
            "session".to_string(),
            "thinking_level_change".to_string(),
            "service_tier_change".to_string(),
            "session_state".to_string(),
            "session_info".to_string(),
        ],
        "the folded file must carry exactly one session_info, written by the single rewrite"
    );
    let lines = masked_lines(&file);
    let infos: Vec<&Value> = lines
        .iter()
        .filter(|row| row.get("type").and_then(Value::as_str) == Some("session_info"))
        .collect();
    assert_eq!(infos.len(), 1, "exactly one session_info line");
    assert_eq!(
        infos[0].get("name").and_then(Value::as_str),
        Some("named-child")
    );
    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "{killed:?}");
}

#[tokio::test]
async fn fresh_create_failed_write_leaves_no_session_file() {
    let dir = tempfile::tempdir().unwrap();
    // A FILE at the session-dir path makes the single write's create_dir_all
    // fail: the create must surface the failure with no session file left
    // behind (no header-only intermediate to leak).
    let blocked_dir = dir.path().join("blocked");
    std::fs::write(&blocked_dir, b"not a directory").unwrap();
    let worker = worker_in(dir.path(), "collapse-fail");
    let response = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": blocked_dir, "name": "failing"}),
        )
        .await;
    assert!(!response.success, "{response:?}");
    {
        let core = worker.core.lock().unwrap();
        assert!(core.store.is_none(), "a failed create installs no store");
        assert!(
            !core.created,
            "a failed create never marks the core created"
        );
    }
}

#[tokio::test]
async fn fresh_create_ignores_a_legacy_crash_orphan() {
    let dir = tempfile::tempdir().unwrap();
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    // The old build's crash-window artifact: a header-only file an interrupted
    // fresh create left behind; the orphan must neither block the create nor
    // bleed into the new file.
    let mut orphan = SessionFile::create("/tmp", None, 0);
    let orphan_path = session_dir.join(session_file_name(orphan.session_id()));
    orphan.set_path(orphan_path.clone());
    orphan.rewrite().unwrap();
    let worker = worker_in(dir.path(), "collapse-orphan");
    let response = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "name": "orphan-sibling"}),
        )
        .await;
    assert!(response.success, "{response:?}");
    let file = {
        let core = worker.core.lock().unwrap();
        core.store.as_ref().unwrap().path.clone()
    };
    assert_ne!(file, orphan_path, "the fresh arm mints its own file");
    assert_eq!(
        entry_types(&file).last().map(String::as_str),
        Some("session_info"),
        "the created file completes with the folded name row"
    );
    assert_eq!(
        std::fs::read_to_string(&orphan_path)
            .unwrap()
            .lines()
            .count(),
        1,
        "the legacy orphan stays untouched"
    );
    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "{killed:?}");
}

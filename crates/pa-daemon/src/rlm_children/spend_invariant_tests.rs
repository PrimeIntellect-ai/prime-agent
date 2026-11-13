//! Session spend invariants at the parent worker: a child's spend, its own
//! descendants' included, reaches the parent's durable total exactly once,
//! across restarts, replays, and deletes that remove the child's transcript.

use super::*;
use pa_types::{ai::Usage, session::ChildSpendEntry};
use std::sync::Arc;

fn usage(cost: f64) -> Usage {
    serde_json::from_value(serde_json::json!({
        "input": 10, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 11,
        "cost": {"input": 0.0, "output": cost, "cacheRead": 0.0, "cacheWrite": 0.0, "total": cost}
    }))
    .unwrap()
}

fn assistant(cost: f64) -> serde_json::Value {
    serde_json::json!({"message": {"role": "assistant", "content": [], "stopReason": "toolUse",
        "timestamp": 1, "usage": usage(cost)}})
}

/// A session file at `path` with one billed assistant turn.
fn session_with_turn(path: &Path, cost: f64) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    session.set_path(path.to_path_buf());
    session.rewrite().unwrap();
    session.persist_entry("message", assistant(cost)).unwrap();
}

/// The parent worker's session transcript (the worker's `CoreUsageStore`).
struct ParentStore(std::sync::Mutex<crate::session_store::SessionFile>);

impl ChildSpendStore for ParentStore {
    fn append_child_spend(&self, entry: &ChildSpendEntry) -> anyhow::Result<Option<Usage>> {
        self.0.lock().unwrap().append_child_spend(entry)
    }
}

struct Home {
    _dir: tempfile::TempDir,
    agent: PathBuf,
    socket: PathBuf,
    parent: PathBuf,
    child: PathBuf,
}

/// A supervisor home: the parent ($1.00) and its ledger child ($0.50).
fn home() -> Home {
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agent");
    let sessions = dir.path().join("sessions");
    let socket = dir.path().join("supervisor.sock");
    let parent = sessions.join("parent.jsonl");
    let child = agent.join("session-artifacts/parent/sub-c/child.jsonl");
    session_with_turn(&parent, 1.0);
    session_with_turn(&child, 0.5);
    crate::descriptor::persist_supervisor_config(
        &crate::descriptor::descriptor_dir(&agent, &socket)
            .join(crate::descriptor::SUPERVISOR_CONFIG_FILE_NAME),
        &crate::descriptor::PersistedSupervisorConfig {
            version: 1,
            socket_path: socket.to_string_lossy().to_string(),
            default_session_dir: Some(sessions.display().to_string()),
        },
    )
    .unwrap();
    crate::rlm_ledger::RlmSpawnLedger::new(&agent, &sessions, |_| {})
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "sub-c".to_string(),
            parent: parent.to_string_lossy().to_string(),
            child: child.to_string_lossy().to_string(),
            depth: 1,
            name: "lane".to_string(),
            factory: None,
        })
        .unwrap();
    Home {
        _dir: dir,
        agent,
        socket,
        parent,
        child,
    }
}

/// One parent worker lifetime: the children registry over the reopened
/// parent transcript.
fn parent_worker(home: &Home) -> SupervisorChildSessions {
    let sessions = SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(home.socket.clone())),
        home.agent.clone(),
        "parent-live".to_string(),
        Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            home.agent.clone(),
            /*telemetry_disabled*/ true,
        )),
        String::new(),
    );
    sessions.set_identity(ParentIdentity {
        session_file: Some(home.parent.to_string_lossy().to_string()),
        ..ParentIdentity::with_default_depth()
    });
    let store = crate::session_store::SessionFile::open(&home.parent).unwrap();
    sessions.set_spend_sink(Arc::new(ChildSpendWriter::new(Arc::new(ParentStore(
        std::sync::Mutex::new(store),
    )))));
    sessions
}

fn total_cost(path: &Path) -> f64 {
    crate::session_store::read_session_info(path)
        .expect("readable transcript")
        .totals
        .total
        .cost
        .total
        .as_f64()
}

/// The child's zero row at spawn.
fn spawned(home: &Home) -> SupervisorChildSessions {
    let sessions = parent_worker(home);
    let child = home.child.to_string_lossy().to_string();
    sessions
        .inner
        .record_child_spawn(ChildSpendSource::of_file(&child, None).unwrap());
    sessions
}

/// (c) After the parent worker restarts, the child's new spend and its
/// grandchild's spend still reach the parent's total.
#[tokio::test]
async fn grandchild_spend_reaches_the_root_across_a_parent_restart() {
    let home = home();
    drop(spawned(&home));
    // The child's grandchild bills $0.25 into the child (the child worker's
    // own snapshots), then the child spends $0.125 more.
    let grandchild = home.child.with_file_name("grandchild.jsonl");
    let mut child_store = crate::session_store::SessionFile::open(&home.child).unwrap();
    for total in [Usage::default(), usage(0.25)] {
        child_store
            .append_child_spend(&ChildSpendEntry {
                child_session_id: "grandchild".to_string(),
                child_session_file: grandchild.to_string_lossy().to_string(),
                total,
            })
            .unwrap();
    }
    child_store
        .persist_entry("message", assistant(0.125))
        .unwrap();

    // The restarted parent worker: its reseed and the supervisor's notice.
    let sessions = parent_worker(&home);
    sessions.inner.reseed_from_ledger().await;
    sessions
        .child_spend_changed(&home.child.to_string_lossy())
        .await;

    assert!(
        (total_cost(&home.parent) - 1.875).abs() < 1e-9,
        "the root's total: {}",
        total_cost(&home.parent)
    );
}

/// (d) Re-observing the same child (a duplicate notice, then a parent
/// restart and reseed) never bills its spend twice.
#[tokio::test]
async fn replayed_observations_never_double_count() {
    let home = home();
    let sessions = spawned(&home);
    let child = home.child.to_string_lossy().to_string();
    sessions.child_spend_changed(&child).await;
    sessions.child_spend_changed(&child).await;
    drop(sessions);
    let sessions = parent_worker(&home);
    sessions.inner.reseed_from_ledger().await;
    sessions.child_spend_changed(&child).await;

    assert!(
        (total_cost(&home.parent) - 1.5).abs() < 1e-9,
        "the root's total: {}",
        total_cost(&home.parent)
    );
}

/// A saved delete removes the transcript of a passive parent's child: the
/// tombstone carries the child's total, and the parent's next start
/// records it as the child's final snapshot.
#[tokio::test]
async fn a_passive_parent_bills_a_saved_deleted_childs_final_spend() {
    let home = home();
    drop(spawned(&home));
    let child = home.child.to_string_lossy().to_string();
    let capture =
        crate::saved_session_commands::capture_saved_session_delete(&child, Some("subagent"));
    std::fs::remove_file(&home.child).unwrap();
    let sessions_dir = home.parent.parent().unwrap().to_path_buf();
    crate::saved_session_commands::tombstone_saved_session_delete_captured(
        &home.agent,
        &sessions_dir,
        &capture,
    );

    parent_worker(&home).inner.reseed_from_ledger().await;

    assert!(
        (total_cost(&home.parent) - 1.5).abs() < 1e-9,
        "the root's total: {}",
        total_cost(&home.parent)
    );
}

//! Session spend invariants: a session's total (own + every descendant's
//! spend) never drops, whatever happens to its subagents. Every surface reads
//! a row's `totalUsage`, which the supervisor stamps from its usage ledger.

use super::*;
use crate::supervisor_roster_seed::tests::register_root_worker;

/// One billed assistant turn appended to a transcript (the header first).
fn append_turn(path: &Path, row_id: &str, cost: f64) {
    use std::io::Write;
    std::fs::create_dir_all(path.parent().expect("transcript dir")).unwrap();
    let mut lines = String::new();
    if !path.exists() {
        let id = path.file_stem().unwrap().to_string_lossy();
        lines.push_str(
            &json!({"type": "session", "version": 3, "id": id, "timestamp": "t", "cwd": "/c"})
                .to_string(),
        );
        lines.push('\n');
    }
    lines.push_str(&turn(row_id, cost).to_string());
    lines.push('\n');
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap()
        .write_all(lines.as_bytes())
        .unwrap();
}

fn turn(row_id: &str, cost: f64) -> Value {
    json!({
        "type": "message", "id": row_id, "parentId": null, "timestamp": "t",
        "message": {"role": "assistant", "content": [], "stopReason": "stop", "timestamp": 1,
            "usage": usage(cost)}
    })
}

fn usage(cost: f64) -> Value {
    json!({"input": 10, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 11,
        "cost": {"input": 0.0, "output": cost, "cacheRead": 0.0, "cacheWrite": 0.0, "total": cost}})
}

struct Family {
    dir: tempfile::TempDir,
    root: PathBuf,
    child: PathBuf,
    grandchild: PathBuf,
}

/// root -> child -> grandchild in the real RLM layout (descendants persist
/// under `session-artifacts/<parent id>/`), linked by spawn records.
fn family() -> Family {
    let dir = tempfile::TempDir::new().unwrap();
    let agent = dir.path().join("agent");
    let root = agent.join("sessions").join("root.jsonl");
    let child = agent.join("session-artifacts/root/sub-c/child.jsonl");
    let grandchild = agent.join("session-artifacts/child/sub-g/grandchild.jsonl");
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent, &agent.join("sessions"), |_| {});
    for (child_id, parent, file, depth) in [
        ("sub-c", &root, &child, 1),
        ("sub-g", &child, &grandchild, 2),
    ] {
        ledger
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: child_id.to_string(),
                parent: parent.to_string_lossy().into_owned(),
                child: file.to_string_lossy().into_owned(),
                depth,
                name: child_id.to_string(),
                factory: None,
            })
            .unwrap();
    }
    Family {
        dir,
        root,
        child,
        grandchild,
    }
}

fn supervisor_over(family: &Family) -> Arc<Supervisor> {
    Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: family.dir.path().join("daemon.sock"),
            agent_dir: family.dir.path().join("agent"),
        })
        .expect("supervisor"),
    )
}

/// The root's roster row; `worker` names its resident worker (`None`: a
/// passive row, no worker).
fn write_root_row(supervisor: &Supervisor, root: &Path, worker: Option<&str>) {
    supervisor.write_roster_summary(
        &json!({
            "id": "root", "sessionId": "root", "activeSessionId": "root",
            "runtimeKind": "top-level", "rlmDepth": 0,
            "sessionFile": root.to_string_lossy(),
        }),
        worker,
    );
}

/// One persisted turn and its worker's report.
async fn spend(supervisor: &Arc<Supervisor>, worker: &str, file: &Path, row_id: &str, cost: f64) {
    append_turn(file, row_id, cost);
    let session_id = file.file_stem().unwrap().to_string_lossy();
    let response = supervisor
        .handle_worker_usage(
            "u",
            "worker_usage",
            &format!("{worker}-token"),
            &session_id,
            row_id,
            serde_json::from_value(usage(cost)).unwrap(),
        )
        .await;
    assert!(response.success, "{response:?}");
}

/// The session's total as the title and the agents view bill it.
fn total(supervisor: &Supervisor, session_id: &str) -> f64 {
    supervisor
        .roster
        .lock()
        .unwrap()
        .entries()
        .iter()
        .find(|entry| entry.summary["sessionId"] == json!(session_id))
        .and_then(|entry| entry.summary["totalUsage"]["cost"].as_f64())
        .unwrap_or(0.0)
}

fn assert_total(supervisor: &Supervisor, expected: f64, moment: &str) {
    let total = total(supervisor, "root");
    assert!((total - expected).abs() < 1e-9, "{moment}: {total}");
}

async fn route_rlm_delete(supervisor: &Arc<Supervisor>, selector: &str, child_id: &str) -> Value {
    let (targeted_tx, _targeted_rx) = tokio::sync::mpsc::channel::<Arc<Value>>(16);
    let attached = subscribers::ClientSubscriptions::new("c".to_string(), targeted_tx);
    let command: DaemonCommand = serde_json::from_value(json!({
        "type": "kill",
        "activeSessionId": selector,
        "rlmLedgerDelete": "user",
        "rlmChildId": child_id,
    }))
    .expect("command");
    let (lines, _) = supervisor
        .route_client_command(
            &command,
            "c",
            &attached,
            "k-1".to_string(),
            "kill".to_string(),
            None,
        )
        .await;
    lines.into_iter().next().expect("one response line")
}

/// (a) The parent's agent deletes an idle child (`rlm.delete_subagent`'s
/// kill marker): the root's total keeps every spend, the grandchild's turn
/// after the child went idle included, also across the next supervisor start.
#[tokio::test]
async fn an_agent_delete_keeps_the_roots_total() {
    let family = family();
    let supervisor = supervisor_over(&family);
    for (worker, file) in [
        ("w-root", &family.root),
        ("w-child", &family.child),
        ("w-grand", &family.grandchild),
    ] {
        register_root_worker(&supervisor, worker, file).await;
    }
    write_root_row(&supervisor, &family.root, Some("w-root"));
    spend(&supervisor, "w-root", &family.root, "r1", 1.0).await;
    spend(&supervisor, "w-child", &family.child, "c1", 0.5).await;
    // The grandchild's last turn lands after the child went idle.
    supervisor.registry.remove("w-child").await;
    spend(&supervisor, "w-grand", &family.grandchild, "g1", 0.25).await;
    supervisor.registry.remove("w-grand").await;
    assert_total(&supervisor, 1.75, "before the delete");

    let response = route_rlm_delete(&supervisor, "child", "sub-c").await;
    assert_eq!(response["success"], json!(true), "{response}");
    assert_total(&supervisor, 1.75, "after the delete");

    let restarted = supervisor_over(&family);
    write_root_row(&restarted, &family.root, None);
    assert_total(&restarted, 1.75, "after the next start");
}

/// (b) A supervisor restart keeps the root's total from the first frame, and
/// a report lost while the supervisor was down is reconciled exactly once by
/// the registration's family reconcile.
#[tokio::test]
async fn a_supervisor_restart_keeps_the_total_and_reconciles_a_lost_report() {
    let family = family();
    let supervisor = supervisor_over(&family);
    for (worker, file) in [
        ("w-root", &family.root),
        ("w-child", &family.child),
        ("w-grand", &family.grandchild),
    ] {
        register_root_worker(&supervisor, worker, file).await;
    }
    write_root_row(&supervisor, &family.root, Some("w-root"));
    spend(&supervisor, "w-root", &family.root, "r1", 1.0).await;
    spend(&supervisor, "w-child", &family.child, "c1", 0.5).await;
    spend(&supervisor, "w-grand", &family.grandchild, "g1", 0.25).await;
    assert_total(&supervisor, 1.75, "before the restart");
    drop(supervisor);

    // The child spends while no supervisor listens: its report is lost.
    append_turn(&family.child, "c2", 0.125);
    let restarted = supervisor_over(&family);
    register_root_worker(&restarted, "w-root", &family.root).await;
    write_root_row(&restarted, &family.root, Some("w-root"));
    assert_total(&restarted, 1.75, "the first frame after the restart");
    // The root's registration reconciles its family (what
    // `handle_worker_register` runs); the child's own registration repeats
    // it and adds nothing.
    let moved = restarted.reconcile_usage(&family.root).await;
    restarted.push_spend(&moved);
    assert_total(&restarted, 1.875, "after the registration reconcile");
    assert!(restarted.reconcile_usage(&family.child).await.is_empty());
    assert_total(&restarted, 1.875, "after a repeated reconcile");
}

/// (c) A grandchild's report raises the root's total while the child in
/// between has no worker.
#[tokio::test]
async fn grandchild_spend_reaches_the_root() {
    let family = family();
    let supervisor = supervisor_over(&family);
    for (worker, file) in [
        ("w-root", &family.root),
        ("w-child", &family.child),
        ("w-grand", &family.grandchild),
    ] {
        register_root_worker(&supervisor, worker, file).await;
    }
    write_root_row(&supervisor, &family.root, Some("w-root"));
    spend(&supervisor, "w-root", &family.root, "r1", 1.0).await;
    spend(&supervisor, "w-child", &family.child, "c1", 0.5).await;
    supervisor.registry.remove("w-child").await;
    assert_total(&supervisor, 1.5, "before the grandchild spends");
    spend(&supervisor, "w-grand", &family.grandchild, "g1", 0.25).await;
    assert_total(&supervisor, 1.75, "after the grandchild's report");
}

/// (d) A passive parent's row (no worker runs for it) moves while its child
/// spends.
#[tokio::test]
async fn a_passive_parents_total_moves_while_its_child_spends() {
    let family = family();
    let supervisor = supervisor_over(&family);
    register_root_worker(&supervisor, "w-root", &family.root).await;
    spend(&supervisor, "w-root", &family.root, "r1", 1.0).await;
    // The root's worker stops: its row stays, passive.
    supervisor.registry.remove("w-root").await;
    write_root_row(&supervisor, &family.root, None);
    assert_total(&supervisor, 1.0, "the passive root's own spend");
    register_root_worker(&supervisor, "w-child", &family.child).await;
    spend(&supervisor, "w-child", &family.child, "c1", 0.5).await;
    assert_total(&supervisor, 1.5, "after the child's first turn");
    spend(&supervisor, "w-child", &family.child, "c2", 0.25).await;
    assert_total(&supervisor, 1.75, "after the child's second turn");
    assert!(supervisor
        .registry
        .find_by_session_file(&family.root.to_string_lossy())
        .await
        .is_none());
}

//! Session spend invariants: a session's total (own + every descendant's
//! spend) never drops, whatever happens to its subagents. Every surface
//! reads the root row's published `totalUsage`, the root transcript's fold.

use super::*;
use crate::supervisor_roster_seed::tests::register_root_worker;

/// One transcript: the header plus one billed assistant turn.
fn write_transcript(path: &std::path::Path, id: &str, cost: f64) {
    std::fs::create_dir_all(path.parent().expect("transcript dir")).unwrap();
    let header = json!({"type": "session", "version": 3, "id": id, "timestamp": "t", "cwd": "/c"});
    let turn = json!({
        "type": "message", "id": format!("{id}-a1"), "parentId": null, "timestamp": "t",
        "message": {"role": "assistant", "content": [], "stopReason": "stop", "timestamp": 1,
            "usage": {"input": 10, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 11,
                "cost": {"input": 0.0, "output": cost, "cacheRead": 0.0, "cacheWrite": 0.0, "total": cost}}}
    });
    std::fs::write(path, format!("{header}\n{turn}\n")).unwrap();
}

/// The parent worker's snapshots of one child: its zero row at spawn, then
/// its current total.
fn bill_child(parent: &std::path::Path, child: &std::path::Path) {
    let mut store = crate::session_store::SessionFile::open(parent).unwrap();
    let snapshot = |total| pa_types::session::ChildSpendEntry {
        child_session_id: crate::rlm_children::child_session_id(child).unwrap(),
        child_session_file: child.to_string_lossy().into_owned(),
        total,
    };
    store
        .append_child_spend(&snapshot(pa_types::ai::Usage::default()))
        .unwrap();
    let total = crate::session_store::read_session_info(child)
        .unwrap()
        .totals
        .total;
    store.append_child_spend(&snapshot(total)).unwrap();
}

struct Family {
    dir: tempfile::TempDir,
    root: PathBuf,
}

/// root ($1.00) -> child ($0.50) -> grandchild ($0.25), the real RLM
/// layout (descendants persist under `session-artifacts/<parent id>/`),
/// each parent's worker having snapshotted its child.
fn family() -> Family {
    let dir = tempfile::TempDir::new().unwrap();
    let agent = dir.path().join("agent");
    let root = agent.join("sessions").join("root.jsonl");
    let child = agent.join("session-artifacts/root/sub-c/child.jsonl");
    let grandchild = agent.join("session-artifacts/child/sub-g/grandchild.jsonl");
    write_transcript(&root, "root", 1.0);
    write_transcript(&child, "child", 0.5);
    write_transcript(&grandchild, "grandchild", 0.25);
    bill_child(&child, &grandchild);
    bill_child(&root, &child);
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
    Family { dir, root }
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

/// The root's resident worker registers and publishes its summary (the
/// worker's spend fields come from its transcript's fold).
async fn register_root(supervisor: &Arc<Supervisor>, root: &std::path::Path) {
    register_root_worker(supervisor, "w-root", root).await;
    let info = crate::session_store::read_session_info(root).expect("root info");
    let mut summary = json!({
        "id": "root", "sessionId": "root", "activeSessionId": "w-root",
        "runtimeKind": "top-level", "rlmDepth": 0,
        "sessionFile": root.to_string_lossy(),
    });
    info.insert_spend(summary.as_object_mut().unwrap());
    supervisor.write_roster_summary(&summary, Some("w-root"));
}

/// The registration seed the supervisor runs for a newly resident root.
async fn seed_family(supervisor: &Arc<Supervisor>, root: &std::path::Path) {
    let seeded = supervisor.seed_roster_family_edges(root).await;
    supervisor.spawn_seeded_hydration(seeded).await.unwrap();
}

/// The root session's total as the title and the agents view bill it.
fn root_total(supervisor: &Supervisor) -> f64 {
    supervisor
        .roster
        .lock()
        .unwrap()
        .entries()
        .iter()
        .find(|entry| entry.summary["sessionId"] == json!("root"))
        .and_then(|entry| entry.summary["totalUsage"]["cost"].as_f64())
        .unwrap_or(0.0)
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

/// (a) An agent's `rlm.delete_subagent` of an idle child (the worker arm's
/// kill marker, no child worker left) keeps the root's total, also across
/// the next supervisor start.
#[tokio::test]
async fn an_agent_delete_keeps_the_roots_total() {
    let family = family();
    let supervisor = supervisor_over(&family);
    register_root(&supervisor, &family.root).await;
    seed_family(&supervisor, &family.root).await;
    assert!(
        (root_total(&supervisor) - 1.75).abs() < 1e-9,
        "before: {}",
        root_total(&supervisor)
    );

    let response = route_rlm_delete(&supervisor, "child", "sub-c").await;
    assert_eq!(response["success"], json!(true), "{response}");
    assert!(
        (root_total(&supervisor) - 1.75).abs() < 1e-9,
        "after the delete: {}",
        root_total(&supervisor)
    );

    let restarted = supervisor_over(&family);
    register_root(&restarted, &family.root).await;
    seed_family(&restarted, &family.root).await;
    assert!(
        (root_total(&restarted) - 1.75).abs() < 1e-9,
        "after the next start: {}",
        root_total(&restarted)
    );
}

/// (b) A supervisor restart keeps the root's total from the first frame:
/// the re-registered root's family must not bill less while its rows hydrate.
#[tokio::test]
async fn a_supervisor_restart_keeps_the_roots_total() {
    let family = family();
    let supervisor = supervisor_over(&family);
    register_root(&supervisor, &family.root).await;
    seed_family(&supervisor, &family.root).await;
    let before = root_total(&supervisor);
    assert!((before - 1.75).abs() < 1e-9, "before: {before}");

    let restarted = supervisor_over(&family);
    register_root(&restarted, &family.root).await;
    // The registration seed's tracked part: the rows the first frame renders.
    let _seeded = restarted.seed_roster_family_edges(&family.root).await;
    assert!(
        (root_total(&restarted) - before).abs() < 1e-9,
        "the first frame after the restart: {}",
        root_total(&restarted)
    );
}

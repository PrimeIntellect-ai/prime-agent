//! The roster passivation + snapshot family: the
//! stop-path passivation (the anchored-child preservation, the live-field
//! stripping, the family pruning), the rewrite/diff-baseline snapshots, and
//! the registration-mark + re-registration rules.
use super::*;
use crate::supervisor_roster_seed::tests::{
    append_family_edge, drain_pending_seeds_for_tests, live_child_summary, register_root_worker,
    roster_fixture, roster_row_for_child, write_display_file,
};
use pa_types::daemon::agent_roster::AgentRosterStatus;

/// `roster_subscribe` is a pure in-memory snapshot: a family the
/// ledger knows (with readable transcripts, unseeded) never enters
/// the roster through the subscribe answer - the old per-switch
/// reseed read the whole family here.
#[tokio::test]
async fn subscribe_is_a_pure_in_memory_snapshot() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    register_root_worker(&supervisor, "w-root", &root_file).await;
    let agent_dir = dir.join("agent");
    append_family_edge(
        &agent_dir,
        &agent_dir.join("sessions"),
        "sub-9",
        &root_file,
        &child_file,
    );
    let mut events = supervisor.events.subscribe();
    // The root's live row is the only roster row.
    let mut root_summary = live_child_summary(&root_file, &child_file);
    root_summary["runtimeKind"] = json!("top-level");
    root_summary["sessionId"] = json!("root-persisted");
    root_summary["id"] = json!("root-persisted");
    root_summary["sessionFile"] = json!(root_file.to_string_lossy());
    root_summary.as_object_mut().unwrap().remove("rlmChildId");
    root_summary
        .as_object_mut()
        .unwrap()
        .remove("parentSessionPath");
    supervisor.write_roster_summary(&root_summary, Some("w-root"));
    let _ = drain_roster_pushes(&mut events);

    let first = supervisor
        .handle_roster_subscribe("s1", "roster_subscribe")
        .await;
    assert!(first.success);
    let roster = first.data.expect("roster snapshot")["roster"].clone();
    assert_eq!(
        roster.as_array().map(Vec::len),
        Some(1),
        "only the in-memory row answers: {roster}"
    );
    // A pure snapshot is stable: subscribing again answers the same.
    let second = supervisor
        .handle_roster_subscribe("s2", "roster_subscribe")
        .await;
    assert_eq!(second.data.expect("roster snapshot")["roster"], roster);
    assert!(
        drain_roster_pushes(&mut events).is_empty(),
        "subscribe never pushes"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// TS #2481 (the P3 port): an identical rewrite broadcasts nothing.
/// The content-diff guard drops a `roster_update` whose entries all
/// match their last published forms, so the wire never re-ships an
/// unchanged row.
#[tokio::test]
async fn an_identical_rewrite_does_not_broadcast() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    register_root_worker(&supervisor, "w-root", &root_file).await;
    let mut events = supervisor.events.subscribe();
    let mut summary = live_child_summary(&root_file, &child_file);
    summary["runtimeKind"] = json!("top-level");
    summary["sessionId"] = json!("root-persisted");
    summary["id"] = json!("root-persisted");
    summary["sessionFile"] = json!(root_file.to_string_lossy());
    summary.as_object_mut().unwrap().remove("rlmChildId");
    summary.as_object_mut().unwrap().remove("parentSessionPath");
    supervisor.write_roster_summary(&summary, Some("w-root"));
    let first = drain_roster_pushes(&mut events);
    assert_eq!(first.len(), 1, "the first write publishes: {first:?}");

    // The identical rewrite: the same summary through the same write
    // path (a fresh classification of equal content).
    supervisor.write_roster_summary(&summary, Some("w-root"));
    assert!(
        drain_roster_pushes(&mut events).is_empty(),
        "an identical rewrite broadcasts nothing"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// TS #2481 (the P3 port): only an actual content change broadcasts -
/// and the changed form becomes the new diff baseline (the guard
/// compares against the last published form, not the first).
#[tokio::test]
async fn a_changed_rewrite_broadcasts_and_resets_the_diff_baseline() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    register_root_worker(&supervisor, "w-root", &root_file).await;
    let mut events = supervisor.events.subscribe();
    let mut summary = live_child_summary(&root_file, &child_file);
    summary["runtimeKind"] = json!("top-level");
    summary["sessionId"] = json!("root-persisted");
    summary["id"] = json!("root-persisted");
    summary["sessionFile"] = json!(root_file.to_string_lossy());
    summary.as_object_mut().unwrap().remove("rlmChildId");
    summary.as_object_mut().unwrap().remove("parentSessionPath");
    supervisor.write_roster_summary(&summary, Some("w-root"));
    let _ = drain_roster_pushes(&mut events);

    summary["model"] = json!("changed-model");
    supervisor.write_roster_summary(&summary, Some("w-root"));
    let changed = drain_roster_pushes(&mut events);
    assert_eq!(changed.len(), 1, "the changed row broadcasts: {changed:?}");
    assert_eq!(
        changed[0]["changed"][0]["summary"]["model"],
        json!("changed-model"),
        "the push carries the changed form: {changed:?}"
    );

    // The changed form is the new baseline: repeating it is now an
    // identical rewrite.
    supervisor.write_roster_summary(&summary, Some("w-root"));
    assert!(
        drain_roster_pushes(&mut events).is_empty(),
        "the rebased identical rewrite broadcasts nothing"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// TS `flipWorkerRosterEntriesInactive`: a stopped subagent under a
/// surviving resident root passivates in place - the summary keeps
/// its model, thinking level, and cwd, and drops only the
/// live-runtime fields. One push carries the settled row.
#[tokio::test]
async fn stop_passivates_an_anchored_child_preserving_display_fields() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    register_root_worker(&supervisor, "w-root", &root_file).await;
    let agent_dir = dir.join("agent");
    append_family_edge(
        &agent_dir,
        &agent_dir.join("sessions"),
        "sub-9",
        &root_file,
        &child_file,
    );
    let mut events = supervisor.events.subscribe();
    supervisor.write_roster_summary(
        &live_child_summary(&root_file, &child_file),
        Some("w-child"),
    );
    let _ = drain_roster_pushes(&mut events);

    supervisor.passivate_roster_worker("w-child", false).await;
    let pushes = drain_roster_pushes(&mut events);
    assert_eq!(pushes.len(), 1, "one settle push: {pushes:?}");
    assert_eq!(pushes[0]["changed"].as_array().map(Vec::len), Some(1));
    assert!(pushes[0]["removed"].is_null() || pushes[0]["removed"].as_array().is_none());
    let row = roster_row_for_child(&supervisor, "sub-9");
    assert_eq!(row.worker_id, None, "the row is no longer worker-owned");
    assert!(row.summary.get("activeSessionId").is_none());
    assert!(row.summary.get("workerState").is_none());
    assert!(row.summary.get("workerPid").is_none());
    assert_eq!(row.summary["activity"], "idle");
    assert_eq!(row.summary["isStreaming"], false);
    assert_eq!(row.status, AgentRosterStatus::Inactive);
    // The durable display rows survive the stop.
    assert_eq!(row.summary["cwd"], "/the/live/cwd");
    assert_eq!(row.summary["model"]["provider"], "live");
    assert_eq!(row.summary["thinkingLevel"], "low");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A live worker's summary carries the full live-catalog model
/// descriptor (`{id, name, provider, reasoning}`, the #2631
/// reasoning-controls metadata); the passivated row keeps the
/// DURABLE display field - the `{provider, modelId}` pair the
/// ledger-seed hydrate writes and the agents view reads (the
/// `thinking_level` e2e's post-stop assertion).
#[tokio::test]
async fn passivation_normalizes_the_live_model_descriptor_to_the_durable_pair() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    register_root_worker(&supervisor, "w-root", &root_file).await;
    let agent_dir = dir.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    append_family_edge(&agent_dir, &sessions_dir, "sub-9", &root_file, &child_file);
    let mut live = live_child_summary(&root_file, &child_file);
    live["model"] = json!({
        "id": "mock-1",
        "name": "Mock 1",
        "provider": "battery",
        "reasoning": true,
    });
    let _ = supervisor.write_roster_summary(&live, Some("w-child"));
    let mut events = supervisor.events.subscribe();
    let _ = drain_roster_pushes(&mut events);
    supervisor.passivate_roster_worker("w-child", false).await;
    let pushes = drain_roster_pushes(&mut events);
    assert_eq!(pushes.len(), 1, "the passivated row publishes: {pushes:?}");
    let row = roster_row_for_child(&supervisor, "sub-9");
    assert_eq!(
        row.summary["model"],
        json!({ "provider": "battery", "modelId": "mock-1" }),
        "the durable pair, not the live descriptor: {row:?}"
    );
    assert_eq!(row.summary["thinkingLevel"], json!("low"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// The RLM delete's stop: the passivation's single push carries both
/// the tombstoned child's removal and its parent's refreshed
/// deleted-descendant bucket. The child's transcript survives under
/// session-artifacts (the real RLM-delete shape: no catalog row
/// exists for it), so its captured spend bills through the bucket
/// on the parent's row - not through a row anywhere.
#[tokio::test]
async fn stop_carries_the_deleted_childs_spend_to_its_parent() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    let agent_dir = dir.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    register_root_worker(&supervisor, "w-root", &root_file).await;
    // The parent's top-level row: the bucket's target.
    let mut parent_summary = live_child_summary(&root_file, &child_file);
    parent_summary["runtimeKind"] = json!("top-level");
    parent_summary["sessionId"] = json!("root-persisted");
    parent_summary["id"] = json!("root-persisted");
    parent_summary["sessionFile"] = json!(root_file.to_string_lossy());
    parent_summary.as_object_mut().unwrap().remove("rlmChildId");
    parent_summary
        .as_object_mut()
        .unwrap()
        .remove("parentSessionPath");
    supervisor.write_roster_summary(&parent_summary, Some("w-root"));
    // The deleted child's real transcript location: under the agent
    // dir's session-artifacts tree (the file exists - the shape the
    // RLM delete leaves behind).
    let child_artifact = agent_dir
        .join("session-artifacts")
        .join("root-1")
        .join("sub-9")
        .join("sub-9.jsonl");
    std::fs::create_dir_all(child_artifact.parent().expect("artifact dir")).unwrap();
    write_display_file(&child_artifact, "/the/deleted/cwd");
    // The flushed transcript carries the child's final own spend
    // ($0.30): the kill route was the flush barrier, so the
    // passivation fold reads this row.
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&child_artifact)
            .expect("open the child transcript for its billed turn");
        writeln!(
            file,
            "{}",
            json!({
                "type": "message",
                "id": "dm1a",
                "parentId": null,
                "timestamp": "2026-09-29T00:00:02.100Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "work complete"}],
                    "timestamp": 2100,
                    "usage": {
                        "input": 60,
                        "output": 6,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 66,
                        "cost": {"input": 0.0, "output": 0.3, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.3}
                    }
                }
            })
        )
        .expect("append the billed turn");
    }
    append_family_edge(
        &agent_dir,
        &sessions_dir,
        "sub-9",
        &root_file,
        &child_artifact,
    );
    // The RLM delete's tombstone carries no usage yet (the capture
    // amendment lands after the stop); the passivation fold bills
    // the flushed transcript.
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
    ledger
        .append_delete(
            "sub-9",
            &child_artifact.to_string_lossy(),
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .expect("append delete");
    // The child's live roster row, owned by the stopping worker.
    let mut events = supervisor.events.subscribe();
    supervisor.write_roster_summary(
        &live_child_summary(&root_file, &child_artifact),
        Some("w-child"),
    );
    let child_agent_id = drain_roster_pushes(&mut events)[0]["changed"][0]["agentId"]
        .as_str()
        .expect("the child agent id")
        .to_string();

    supervisor.passivate_roster_worker("w-child", false).await;
    let pushes = drain_roster_pushes(&mut events);
    assert_eq!(pushes.len(), 1, "one settle push: {pushes:?}");
    // The parent's refreshed row is the push's whole `changed`.
    let parent_after = supervisor
        .roster
        .lock()
        .unwrap()
        .entries()
        .into_iter()
        .find(|entry| {
            entry.summary.get("sessionId").and_then(Value::as_str) == Some("root-persisted")
        })
        .expect("the parent row");
    assert_eq!(
        pushes[0]["changed"],
        serde_json::to_value(vec![parent_after]).expect("serialized parent"),
        "the push carries the parent's refreshed row: {pushes:?}"
    );
    assert_eq!(
        pushes[0]["changed"][0]["summary"]["deletedDescendantUsage"],
        json!({ "inputTokens": 60, "outputTokens": 6, "cost": 0.3 }),
        "the deleted child's captured spend bills through the parent"
    );
    assert_eq!(
        pushes[0]["removed"],
        json!([child_agent_id]),
        "the tombstoned child's row dies in the same push: {pushes:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A saved delete of a subagent whose only row was the saved listing
/// (no roster row - its parent is stopped, so no seed ever wrote
/// one) still refreshes the bucket: the ledger tombstone is the
/// event, and the parent's roster row bills the deleted child's
/// captured spend in the delete's own push.
#[tokio::test]
async fn a_saved_delete_without_a_roster_row_bills_the_parent() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    let agent_dir = dir.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    register_root_worker(&supervisor, "w-root", &root_file).await;
    // The parent's top-level row: the ONLY roster row (the child has
    // none).
    let mut parent_summary = live_child_summary(&root_file, &child_file);
    parent_summary["runtimeKind"] = json!("top-level");
    parent_summary["sessionId"] = json!("root-persisted");
    parent_summary["id"] = json!("root-persisted");
    parent_summary["sessionFile"] = json!(root_file.to_string_lossy());
    parent_summary.as_object_mut().unwrap().remove("rlmChildId");
    parent_summary
        .as_object_mut()
        .unwrap()
        .remove("parentSessionPath");
    supervisor.write_roster_summary(&parent_summary, Some("w-root"));
    // The child: a transcript under the session-artifacts tree whose
    // header links it to the parent (the capture's child shape), with
    // one billed assistant row ($0.30), plus its spawn edge.
    let child_artifact = agent_dir
        .join("session-artifacts")
        .join("root-1")
        .join("sub-9")
        .join("sub-9.jsonl");
    std::fs::create_dir_all(child_artifact.parent().expect("artifact dir")).unwrap();
    std::fs::write(
        &child_artifact,
        format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"sub-9\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/the/deleted/cwd\",\"parentSession\":\"{}\",\"rlmDepth\":1}}\n",
            root_file.to_string_lossy()
        ),
    )
    .unwrap();
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&child_artifact)
            .expect("open the child transcript for its billed turn");
        writeln!(
            file,
            "{}",
            json!({
                "type": "message",
                "id": "dm1a",
                "parentId": null,
                "timestamp": "2026-09-29T00:00:02.100Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "work complete"}],
                    "timestamp": 2100,
                    "usage": {
                        "input": 60,
                        "output": 6,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 66,
                        "cost": {"input": 0.0, "output": 0.3, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.3}
                    }
                }
            })
        )
        .expect("append the billed turn");
    }
    append_family_edge(
        &agent_dir,
        &sessions_dir,
        "sub-9",
        &root_file,
        &child_artifact,
    );
    // The selector-less saved delete of the child: the supervisor arm.
    let mut events = supervisor.events.subscribe();
    let command = pa_types::daemon::DaemonCommand::DeleteSavedSession {
        id: None,
        active_session_id: None,
        session_path: child_artifact.to_string_lossy().to_string(),
        rest: Map::default(),
    };
    let (responses, _) = supervisor
        .handle_delete_saved_session(&command, "client-1", "c1", "delete_saved_session")
        .await;
    assert_eq!(
        responses[0]["success"],
        json!(true),
        "the delete succeeded: {responses:?}"
    );
    assert!(!child_artifact.is_file(), "the child transcript is gone");
    // The delete's own push carries the parent's refreshed row - the
    // whole `changed`, with no removal (the child had no row).
    let pushes = drain_roster_pushes(&mut events);
    assert_eq!(pushes.len(), 1, "one refresh push: {pushes:?}");
    let parent_after = supervisor
        .roster
        .lock()
        .unwrap()
        .entries()
        .into_iter()
        .find(|entry| {
            entry.summary.get("sessionId").and_then(Value::as_str) == Some("root-persisted")
        })
        .expect("the parent row");
    assert_eq!(
        pushes[0]["changed"],
        serde_json::to_value(vec![parent_after]).expect("serialized parent"),
        "the push carries the parent's refreshed row: {pushes:?}"
    );
    assert_eq!(
        pushes[0]["changed"][0]["summary"]["deletedDescendantUsage"],
        json!({ "inputTokens": 60, "outputTokens": 6, "cost": 0.3 }),
        "the deleted child's captured spend bills through the parent"
    );
    assert!(
        pushes[0].get("removed").is_none() || pushes[0]["removed"].is_null(),
        "no removal rides the push: {pushes:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Unanchored subagent rows are removed, never passivated (a
/// tombstoned ledger edge - the user deleted the subagent - or a live
/// edge with no resident root), a queued child and an ephemeral
/// worker's rows die with the stop, and the TOP-LEVEL row passivates
/// (TS keeps every stopped non-ephemeral row visible: the operator's
/// rows-disappear report), surviving later stops' unowned sweeps.
#[tokio::test]
async fn stop_removes_unanchored_children_and_passivates_the_top_level_row() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    let agent_dir = dir.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    let mut events = supervisor.events.subscribe();

    // A tombstoned child: the edge is deleted, so no live edge
    // carries the row even though the files exist.
    append_family_edge(&agent_dir, &sessions_dir, "sub-9", &root_file, &child_file);
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
    ledger
        .append_delete(
            "sub-9",
            &child_file.to_string_lossy(),
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .expect("append delete");
    register_root_worker(&supervisor, "w-root", &root_file).await;
    supervisor.write_roster_summary(
        &live_child_summary(&root_file, &child_file),
        Some("w-child"),
    );
    let _ = drain_roster_pushes(&mut events);
    supervisor.passivate_roster_worker("w-child", false).await;
    let pushes = drain_roster_pushes(&mut events);
    let removed: Vec<String> = pushes[0]["removed"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect();
    assert_eq!(removed.len(), 1, "the tombstoned row dies: {pushes:?}");
    assert!(supervisor.roster.lock().unwrap().get(&removed[0]).is_none());

    // A live edge but no resident root: no surviving root, no row.
    let orphan_file = sessions_dir.join("sub-orphan.jsonl");
    write_display_file(&orphan_file, "/the/orphan/cwd");
    append_family_edge(
        &agent_dir,
        &sessions_dir,
        "sub-orphan",
        &root_file,
        &orphan_file,
    );
    let mut orphan_summary = live_child_summary(&root_file, &orphan_file);
    orphan_summary["rlmChildId"] = json!("sub-orphan");
    supervisor.write_roster_summary(&orphan_summary, Some("w-orphan"));
    // Drop every resident worker: nothing anchors the family.
    for worker in supervisor.registry.list().await {
        supervisor.registry.remove(&worker.worker_id).await;
    }
    let _ = drain_roster_pushes(&mut events);
    supervisor.passivate_roster_worker("w-orphan", false).await;
    let pushes = drain_roster_pushes(&mut events);
    assert!(
        pushes[0]["removed"]
            .as_array()
            .is_some_and(|ids| !ids.is_empty()),
        "an unanchored row dies: {pushes:?}"
    );

    // A top-level row PASSIVATES with the stop (TS
    // `flipWorkerRosterEntriesInactive` keeps every stopped
    // non-ephemeral row visible; the operator's rows-disappear
    // report): the push carries the passivated entry - `lifecycle`
    // stays "live", the live-only fields drop - and the roster keeps
    // the row, so the agents view's Inactive section keeps the
    // stopped session instead of losing it until the next catalog
    // scan.
    let mut top_summary = live_child_summary(&root_file, &child_file);
    top_summary["runtimeKind"] = json!("top-level");
    top_summary["sessionId"] = json!("root-persisted");
    top_summary["id"] = json!("root-persisted");
    top_summary["sessionFile"] = json!(root_file.to_string_lossy());
    // The real worker's summary carries its lifecycle (the view's
    // visibility gate); the passivation preserves it.
    top_summary["lifecycle"] = json!("live");
    top_summary.as_object_mut().unwrap().remove("rlmChildId");
    top_summary
        .as_object_mut()
        .unwrap()
        .remove("parentSessionPath");
    supervisor.write_roster_summary(&top_summary, Some("w-top"));
    let _ = drain_roster_pushes(&mut events);
    supervisor.passivate_roster_worker("w-top", false).await;
    let pushes = drain_roster_pushes(&mut events);
    assert!(
        pushes[0]["changed"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| {
                entry["summary"]["sessionId"] == json!("root-persisted")
                    && entry["status"] == json!("inactive")
                    && entry["summary"]["lifecycle"] == json!("live")
            })),
        "the top-level row passivates (lifecycle stays live): {pushes:?}"
    );
    assert!(
        pushes[0]["removed"].is_null() || pushes[0]["removed"] == json!([]),
        "the passivated top-level row is not a removal: {pushes:?}"
    );
    let entries = supervisor.roster.lock().unwrap().entries();
    let passivated = entries
        .iter()
        .find(|entry| {
            entry.summary.get("sessionId").and_then(Value::as_str) == Some("root-persisted")
        })
        .expect("the passivated top-level row stays in the roster");
    assert_eq!(passivated.status, AgentRosterStatus::Inactive);
    assert!(
        passivated.summary.get("workerState").is_none()
            && passivated.summary.get("activeSessionId").is_none(),
        "the live-only fields dropped with the passivation: {passivated:?}"
    );
    // A queued child and an ephemeral worker's rows die with the stop.
    let mut queued_summary = live_child_summary(&root_file, &child_file);
    queued_summary["rlmChildId"] = json!("sub-queued");
    queued_summary["queuedChild"] = json!(true);
    let queued_child_file = sessions_dir.join("sub-queued.jsonl");
    write_display_file(&queued_child_file, "/the/queued/cwd");
    append_family_edge(
        &agent_dir,
        &sessions_dir,
        "sub-queued",
        &root_file,
        &queued_child_file,
    );
    queued_summary["sessionFile"] = json!(queued_child_file.to_string_lossy());
    supervisor.write_roster_summary(&queued_summary, Some("w-queued"));
    let _ = drain_roster_pushes(&mut events);
    supervisor.passivate_roster_worker("w-queued", true).await;
    let pushes = drain_roster_pushes(&mut events);
    assert!(
        pushes[0]["removed"]
            .as_array()
            .is_some_and(|ids| ids.len() == 1),
        "the queued/ephemeral row dies: {pushes:?}"
    );
    assert!(supervisor
        .roster
        .lock()
        .unwrap()
        .entries()
        .iter()
        .all(
            |entry| entry.summary.get("rlmChildId").and_then(Value::as_str) != Some("sub-queued")
        ));

    // A LATER stop's unowned sweep never revisits the passivated
    // top-level row (the sweep's business is the dead seeded
    // families, not the stopped sessions' visible rows): the queued
    // arm above was one stop pass since the row passivated, and this
    // one is a second - the row survives both sweeps. The lock drops
    // before the test's end; no await runs under it.
    supervisor.passivate_roster_worker("w-none", false).await;
    let roster = supervisor.roster.lock().unwrap();
    assert!(
        roster.entries().iter().any(|entry| {
            entry.summary.get("sessionId").and_then(Value::as_str) == Some("root-persisted")
        }),
        "the passivated top-level row survives later stops' sweeps"
    );
    drop(roster);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The unowned half of the stop pass: the rows the boot and
/// registration seeds write carry no worker, so the family's
/// departure never revisited them - the rows a departed root seeded
/// outlived the root and the agents view rendered them as top-level
/// rows until the saved catalog re-parented them minutes later (the
/// operator's flash). The anchor rule settles them with the same
/// verdict as the owned rows: the family that lost its last resident
/// root returns to the saved catalog alone, while another root's
/// anchored seeded row keeps its display.
#[tokio::test]
async fn stop_prunes_seeded_rows_of_a_family_that_lost_its_root() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    let agent_dir = dir.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    // The surviving root's family: its seeded child stays anchored
    // through the other root's stop.
    let survivor_file = sessions_dir.join("root-2.jsonl");
    let survivor_child = sessions_dir.join("sub-live.jsonl");
    write_display_file(&survivor_file, "/the/survivor/cwd");
    write_display_file(&survivor_child, "/the/survivor/child/cwd");
    register_root_worker(&supervisor, "w-survivor", &survivor_file).await;
    append_family_edge(
        &agent_dir,
        &sessions_dir,
        "sub-live",
        &survivor_file,
        &survivor_child,
    );
    append_family_edge(&agent_dir, &sessions_dir, "sub-9", &root_file, &child_file);
    register_root_worker(&supervisor, "w-root", &root_file).await;
    // The stopping root owns its own top-level row, like the
    // production stop does (the worker's summary push).
    let mut root_summary = live_child_summary(&root_file, &child_file);
    root_summary["runtimeKind"] = json!("top-level");
    root_summary["sessionId"] = json!("root-persisted");
    root_summary["id"] = json!("root-persisted");
    root_summary["sessionFile"] = json!(root_file.to_string_lossy());
    root_summary.as_object_mut().unwrap().remove("rlmChildId");
    root_summary
        .as_object_mut()
        .unwrap()
        .remove("parentSessionPath");
    supervisor.write_roster_summary(&root_summary, Some("w-root"));
    // The boot seed publishes both families' seeded rows.
    supervisor.spawn_roster_boot_seed();
    drain_pending_seeds_for_tests(&supervisor).await;
    let mut events = supervisor.events.subscribe();
    let _ = drain_roster_pushes(&mut events);
    let _ = roster_row_for_child(&supervisor, "sub-9");
    let _ = roster_row_for_child(&supervisor, "sub-live");

    // The stop: the caller removed the resident from the registry
    // first (both `stop_worker` and the give-up do exactly this).
    supervisor.registry.remove("w-root").await;
    supervisor.passivate_roster_worker("w-root", false).await;

    let pushes = drain_roster_pushes(&mut events);
    let removed: Vec<String> = pushes
        .iter()
        .flat_map(|push| {
            push["removed"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(
        removed.iter().any(|id| id.ends_with("#sub-9")),
        "the orphaned family's seeded row leaves the roster (and the subscribers): {removed:?}"
    );
    let roster = supervisor.roster.lock().unwrap();
    assert!(
        !roster.entries().iter().any(|entry| entry
            .summary
            .get("rlmChildId")
            .and_then(Value::as_str)
            == Some("sub-9")),
        "the departed family's seeded row is gone"
    );
    drop(roster);
    // The surviving root's family keeps its seeded display row.
    let kept = roster_row_for_child(&supervisor, "sub-live");
    assert_eq!(
        kept.worker_id, None,
        "the anchored seeded row stays unowned"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The operator's flash at the response boundary: a store seeded with
/// hundreds of dead subagent sessions under a family whose root
/// departs. While the root is resident the roster serves the seeded
/// family (TS `seedRosterLedger` parity - a resident root's passive
/// descendants render); the stop must leave the first roster snapshot
/// clean, so the agents view's first frame never dumps the dead
/// family's rows as top-level entries.
#[tokio::test]
async fn stop_leaves_the_first_roster_snapshot_clean_behind_hundreds_of_seeded_rows() {
    let (dir, supervisor, root_file, _child_file) = roster_fixture().await;
    let agent_dir = dir.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    register_root_worker(&supervisor, "w-root", &root_file).await;
    for index in 0..300 {
        let seeded_child = sessions_dir.join(format!("sub-flash-{index}.jsonl"));
        write_display_file(&seeded_child, "/the/flash/cwd");
        append_family_edge(
            &agent_dir,
            &sessions_dir,
            &format!("sub-flash-{index}"),
            &root_file,
            &seeded_child,
        );
    }
    supervisor.spawn_roster_boot_seed();
    drain_pending_seeds_for_tests(&supervisor).await;
    let before = supervisor
        .handle_roster_subscribe("s1", "roster_subscribe")
        .await;
    let roster = before.data.expect("roster snapshot")["roster"].clone();
    let family_rows = roster
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|entry| {
                    entry["summary"]["rlmChildId"]
                        .as_str()
                        .is_some_and(|id| id.starts_with("sub-flash-"))
                })
                .count()
        })
        .unwrap_or_default();
    assert_eq!(
        family_rows, 300,
        "a resident root's seeded family serves to subscribers (TS parity)"
    );

    // The root departs: its family loses its only anchor.
    supervisor.registry.remove("w-root").await;
    supervisor.passivate_roster_worker("w-root", false).await;

    let after = supervisor
        .handle_roster_subscribe("s2", "roster_subscribe")
        .await;
    let roster = after.data.expect("roster snapshot")["roster"].clone();
    let family_rows = roster
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|entry| {
                    entry["summary"]["rlmChildId"]
                        .as_str()
                        .is_some_and(|id| id.starts_with("sub-flash-"))
                })
                .count()
        })
        .unwrap_or_default();
    assert_eq!(
        family_rows, 0,
        "the first roster snapshot behind a departed family is clean: {roster:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// TS `passivatedWorkerRosterEntry` keeps the registration marks that
// were true and strips the live-runtime fields, including the
// heartbeat's own active flag.
#[test]
fn passivation_keeps_registration_marks_and_strips_live_fields() {
    let passivated = passivated_summary(json!({
        "sessionId": "persisted-id",
        "activeSessionId": "a-child",
        "activity": "working",
        "isSessionActive": true,
        "isStreaming": true,
        "isCompacting": true,
        "attachedClients": 2,
        "directAttachedClients": 2,
        "hasActiveHeartbeat": true,
        "hasRegisteredHeartbeat": true,
        "hasRegisteredCronJob": false,
        "hasRunningRlmChildren": true,
        "isBashRunning": true,
        "isRunningTools": true,
        "workerState": "ready",
        "workerPid": 4242,
        "cwd": "/the/live/cwd",
        "model": { "provider": "live", "modelId": "lm" },
        "thinkingLevel": "low",
    }));
    assert_eq!(passivated["id"], "persisted-id");
    assert_eq!(passivated["activity"], "idle");
    assert_eq!(passivated["isSessionActive"], false);
    assert_eq!(passivated["isStreaming"], false);
    assert_eq!(passivated["isCompacting"], false);
    assert_eq!(passivated["attachedClients"], 0);
    for key in [
        "activeSessionId",
        "directAttachedClients",
        "hasActiveHeartbeat",
        "hasRegisteredCronJob",
        "hasRunningRlmChildren",
        "isBashRunning",
        "isRunningTools",
        "workerState",
        "workerPid",
    ] {
        assert!(passivated.get(key).is_none(), "{key} is live-only");
    }
    assert_eq!(
        passivated["hasRegisteredHeartbeat"], true,
        "the mark survives"
    );
    assert_eq!(passivated["cwd"], "/the/live/cwd");
    assert_eq!(
        passivated["model"],
        json!({ "provider": "live", "modelId": "lm" })
    );
    assert_eq!(passivated["thinkingLevel"], "low");
}

/// Live roster parity: a re-registration over the same session file
/// replaces the passivated row with the live one, so a resumed
/// session never renders its stale passive row.
#[tokio::test]
async fn a_reregistration_replaces_the_passive_row() {
    let (dir, supervisor, root_file, child_file) = roster_fixture().await;
    register_root_worker(&supervisor, "w-root", &root_file).await;
    let agent_dir = dir.join("agent");
    append_family_edge(
        &agent_dir,
        &agent_dir.join("sessions"),
        "sub-9",
        &root_file,
        &child_file,
    );
    let mut events = supervisor.events.subscribe();
    supervisor.write_roster_summary(
        &live_child_summary(&root_file, &child_file),
        Some("w-child"),
    );
    let _ = drain_roster_pushes(&mut events);
    supervisor.passivate_roster_worker("w-child", false).await;
    let _ = drain_roster_pushes(&mut events);

    let mut resumed = live_child_summary(&root_file, &child_file);
    resumed["model"] = json!({ "provider": "resumed", "modelId": "rm" });
    resumed["activity"] = json!("idle");
    resumed["isStreaming"] = json!(false);
    resumed["isSessionActive"] = json!(false);
    supervisor.write_roster_summary(&resumed, Some("w-resumed"));
    let row = roster_row_for_child(&supervisor, "sub-9");
    assert_eq!(row.worker_id.as_deref(), Some("w-resumed"));
    assert_eq!(row.summary["model"]["provider"], "resumed");
    assert_eq!(row.status, AgentRosterStatus::Idle);
    assert_eq!(
        supervisor.roster.lock().unwrap().entries().len(),
        1,
        "the passive row was replaced, not duplicated"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

//! The RLM ledger test battery: grammar, replay, tombstone, seed, display,
//! and usage-bucket families.
use super::*;
use crate::session_usage::SessionUsageSummary;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pa-ledger-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn ledger_for(dir: &Path) -> RlmSpawnLedger {
    RlmSpawnLedger::new(dir, &dir.join("sessions"), |_| {})
}

/// A ledger over an explicit agent dir and sessions dir (the artifact tree roots there).
fn ledger_over(agent_dir: &Path, sessions_dir: &Path) -> RlmSpawnLedger {
    RlmSpawnLedger::new(agent_dir, sessions_dir, |_| {})
}

#[test]
fn legacy_registry_probe_reads_the_header_line_bounded() {
    let dir = temp_dir("legacy-bounded");
    let parent = dir.join("p.jsonl");
    let mut content = json!({"type": "session", "id": "p1"}).to_string();
    content.push('\n');
    content.push_str(&"x".repeat(LEGACY_REGISTRY_HEADER_READ_MAX_BYTES * 2));
    fs::write(&parent, content).unwrap();
    let registry = legacy_registry_path(&parent).expect("registry path");
    assert!(
        registry
            .to_string_lossy()
            .ends_with("session-artifacts/p1/rlm-subagents.jsonl"),
        "the header id resolves without reading the padded tail"
    );

    let mut over_long = String::from("{\"id\":\"");
    over_long.push_str(&"p".repeat(LEGACY_REGISTRY_HEADER_READ_MAX_BYTES));
    over_long.push_str("\"}");
    fs::write(dir.join("long.jsonl"), over_long).unwrap();
    assert_eq!(
        legacy_registry_path(&dir.join("long.jsonl")),
        None,
        "a first line longer than the cap is not judged on truncated bytes"
    );
}

#[test]
fn legacy_registry_probe_resolves_a_readable_header_over_a_corrupt_tail() {
    let dir = temp_dir("legacy-corrupt-tail");
    let parent = dir.join("p.jsonl");
    let mut bytes = json!({"type": "session", "id": "p1"})
        .to_string()
        .into_bytes();
    bytes.push(b'\n');
    bytes.extend_from_slice(&[0xff_u8; 4096]);
    fs::write(&parent, bytes).unwrap();
    let registry = legacy_registry_path(&parent).expect("registry path over a corrupt tail");
    assert!(
        registry
            .to_string_lossy()
            .ends_with("session-artifacts/p1/rlm-subagents.jsonl"),
        "a torn-write tail no longer masks the readable header"
    );
}

#[test]
fn ledger_path_hashes_the_canonical_sessions_dir() {
    let dir = temp_dir("path");
    let a = rlm_ledger_path(&dir, &dir.join("sessions"));
    let b = rlm_ledger_path(&dir, &dir.join("sessions/../sessions"));
    assert_eq!(a, b);
    assert!(a.to_string_lossy().contains(RLM_LEDGER_DIR));
    let c = rlm_ledger_path(&dir, &dir.join("other"));
    assert_ne!(a, c);
}

#[test]
fn spawn_rename_delete_replay_in_order() {
    let dir = temp_dir("replay");
    let ledger = ledger_for(&dir);
    let parent = dir.join("parent.jsonl");
    let child = dir.join("child.jsonl");
    fs::write(&parent, "{\"type\":\"session\",\"id\":\"p\"}").unwrap();
    fs::write(&child, "{\"type\":\"session\",\"id\":\"c\"}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "worker".into(),
        })
        .unwrap();
    ledger
        .append_rename("sub-1", &child.to_string_lossy(), "renamed")
        .unwrap();
    let edges = ledger.edges(false).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].name, "renamed");
    assert_eq!(edges[0].depth, 1);
    assert_eq!(ledger.live_edges().unwrap().len(), 1);
    ledger
        .append_delete(
            "sub-1",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
        )
        .unwrap();
    assert!(ledger.edges(false).unwrap().is_empty());
    let tombstones = ledger.edges(true).unwrap();
    assert_eq!(tombstones.len(), 1);
    assert_eq!(tombstones[0].deleted, Some(RlmLedgerDeleteReason::User));
    // The stat guard serves the same replay until the file changes.
    assert_eq!(ledger.edges(true).unwrap(), tombstones);
}

#[test]
fn edge_is_live_reflects_tombstones_and_files() {
    let dir = temp_dir("liveness");
    let ledger = ledger_for(&dir);
    let parent = dir.join("p.jsonl");
    let child = dir.join("c.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, "{}").unwrap();
    let child_path = child.to_string_lossy().into_owned();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: parent.to_string_lossy().into_owned(),
            child: child_path.clone(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    assert!(ledger.edge_is_live("sub-1", &child_path));
    fs::remove_file(&child).unwrap();
    assert!(!ledger.edge_is_live("sub-1", &child_path));
    fs::write(&child, "{}").unwrap();
    assert!(ledger.edge_is_live("sub-1", &child_path));
    fs::remove_file(&parent).unwrap();
    assert!(!ledger.edge_is_live("sub-1", &child_path));
    fs::write(&parent, "{}").unwrap();
    assert!(ledger.edge_is_live("sub-1", &child_path));
    // A completed delete tombstones the edge: no resurrection, and
    // a different edge sharing the child id (a different child
    // path) cannot keep the deleted edge live.
    let other_child = dir.join("other.jsonl");
    fs::write(&other_child, "{}").unwrap();
    let other_path = other_child.to_string_lossy().into_owned();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: parent.to_string_lossy().into_owned(),
            child: other_path,
            depth: 1,
            name: "w2".into(),
        })
        .unwrap();
    ledger
        .append_delete("sub-1", &child_path, RlmLedgerDeleteReason::User)
        .unwrap();
    assert!(
        !ledger.edge_is_live("sub-1", &child_path),
        "the tombstoned edge stays dead beside a shared-id sibling"
    );
    assert!(
        ledger.edge_is_live("sub-1", &other_child.to_string_lossy()),
        "the live sibling still reads live"
    );
    assert!(!ledger.edge_is_live("sub-none", &child_path));
}

// File changes do not invalidate the ledger's stat-identity cache. A
// canonical path recorded at spawn can later become a symlink, so the
// replay index alone cannot establish that no live edge matches a path.
#[cfg(unix)]
#[test]
fn edge_is_live_revalidates_paths_without_a_ledger_append() {
    use std::os::unix::fs::symlink;

    let dir = temp_dir("liveness-retarget");
    let ledger = ledger_for(&dir);
    let parent = dir.join("p.jsonl");
    let child = dir.join("a.jsonl");
    let target = dir.join("b.jsonl");
    for path in [&parent, &child, &target] {
        fs::write(path, "{}").unwrap();
    }
    for path in [&child, &target] {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into_owned(),
                child: path.to_string_lossy().into_owned(),
                depth: 1,
                name: "child".into(),
            })
            .unwrap();
    }
    ledger
        .append_delete(
            "sub-1",
            &target.to_string_lossy(),
            RlmLedgerDeleteReason::User,
        )
        .unwrap();
    let child_path = child.to_string_lossy();
    let target_path = target.to_string_lossy();
    assert!(ledger.edge_is_live("sub-1", &child_path));
    assert!(!ledger.edge_is_live("sub-1", &target_path));
    let cached = ledger.replay_cached().unwrap();
    let identity = file_identity(&ledger.path).unwrap();

    fs::remove_file(&child).unwrap();
    symlink(&target, &child).unwrap();
    assert_eq!(file_identity(&ledger.path).unwrap(), identity);
    assert!(Arc::ptr_eq(&cached, &ledger.replay_cached().unwrap()));
    // The query now hits the target's tombstoned index entry, but the
    // original live edge resolves to the same path and must still count.
    assert!(ledger.edge_is_live("sub-1", &child_path));
    assert!(ledger.edge_is_live("sub-1", &target_path));

    let unindexed = dir.join("c.jsonl");
    fs::write(&unindexed, "{}").unwrap();
    fs::remove_file(&child).unwrap();
    symlink(&unindexed, &child).unwrap();
    assert_eq!(file_identity(&ledger.path).unwrap(), identity);
    assert!(Arc::ptr_eq(&cached, &ledger.replay_cached().unwrap()));
    // This query misses the index entirely after the second retarget.
    assert!(ledger.edge_is_live("sub-1", &child_path));
    assert!(ledger.edge_is_live("sub-1", &unindexed.to_string_lossy()));
    assert!(!ledger.edge_is_live("sub-1", &target_path));

    fs::remove_file(&unindexed).unwrap();
    assert!(!ledger.edge_is_live("sub-1", &child_path));
    assert!(!ledger.edge_is_live("sub-1", &target_path));
}

/// A respawned child id: the tombstoned edge at the old path stays dead,
/// the new path's edge is live, and a later respawn on the old path's key
/// re-lives that edge in place (the fold keeps one edge per key).
#[test]
fn a_respawned_child_id_on_a_new_path_is_live_and_the_old_one_is_not() {
    let dir = temp_dir("respawn");
    let ledger = ledger_for(&dir);
    let parent = dir.join("p.jsonl");
    let a = dir.join("a.jsonl");
    let b = dir.join("b.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&a, "{}").unwrap();
    fs::write(&b, "{}").unwrap();
    let spawn = |child: &Path, name: &str| {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into_owned(),
                child: child.to_string_lossy().into_owned(),
                depth: 1,
                name: name.into(),
            })
            .unwrap();
    };
    spawn(&a, "first");
    ledger
        .append_delete("sub-1", &a.to_string_lossy(), RlmLedgerDeleteReason::User)
        .unwrap();
    spawn(&b, "second");
    assert!(!ledger.edge_is_live("sub-1", &a.to_string_lossy()));
    assert!(ledger.edge_is_live("sub-1", &b.to_string_lossy()));
    spawn(&a, "third");
    assert!(ledger.edge_is_live("sub-1", &a.to_string_lossy()));
    assert!(ledger.edge_is_live("sub-1", &b.to_string_lossy()));
}

#[test]
fn dead_child_or_parent_drops_from_live_edges() {
    let dir = temp_dir("live");
    let ledger = ledger_for(&dir);
    let parent = dir.join("p.jsonl");
    let child = dir.join("c.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    assert_eq!(ledger.live_edges().unwrap().len(), 1);
    fs::remove_file(&child).unwrap();
    assert!(ledger.live_edges().unwrap().is_empty());
    assert_eq!(ledger.edges(false).unwrap().len(), 1);
}

/// A recorded edge path whose file moved resolves through its durable session id, and the returned
/// edge carries the resolved path; a session with no file anywhere stays dead.
#[test]
fn moved_edge_paths_resolve_through_the_session_id() {
    let agent_dir = temp_dir("agent");
    let sessions_dir = agent_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    let ledger = ledger_over(&agent_dir, &sessions_dir);

    // The parent moved: recorded under an old root, now resident in
    // the artifacts tree; the child moved into the sessions dir.
    let recorded_parent = "/old-root/sessions/sess-p.jsonl";
    let recorded_child = "/old-root/session-artifacts/sess-p/sub-1/sess-c.jsonl";
    let live_parent = agent_dir
        .join("session-artifacts")
        .join("sess-g")
        .join("sub-9")
        .join("sess-p.jsonl");
    let live_child = sessions_dir.join("sess-c.jsonl");
    fs::create_dir_all(live_parent.parent().unwrap()).unwrap();
    fs::write(&live_parent, "{}").unwrap();
    fs::write(&live_child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: recorded_parent.into(),
            child: recorded_child.into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();

    let edges = ledger.live_edges().unwrap();
    assert_eq!(edges.len(), 1, "{edges:?}");
    // The resolved paths are canonicalized (the sessions dir the
    // resolver anchors to is canonical).
    let canonical = |path: &Path| -> String {
        crate::lease::canonical_session_path(path)
            .to_string_lossy()
            .to_string()
    };
    assert_eq!(
        edges[0].parent,
        canonical(&live_parent),
        "the parent edge resolves to the migrated path"
    );
    assert_eq!(
        edges[0].child,
        canonical(&live_child),
        "the child edge resolves to the migrated path"
    );

    fs::remove_file(&live_child).unwrap();
    assert!(ledger.live_edges().unwrap().is_empty());
    let raw = ledger.edges(false).unwrap();
    assert_eq!(raw.len(), 1);
    assert_eq!(raw[0].parent, recorded_parent);
    assert_eq!(raw[0].child, recorded_child);
}

#[test]
fn the_artifact_index_updates_after_a_new_partition() {
    let agent_dir = temp_dir("index-partition");
    let sessions_dir = agent_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    let ledger = ledger_over(&agent_dir, &sessions_dir);

    let parent = sessions_dir.join("sess-p.jsonl");
    fs::write(&parent, "{}").unwrap();
    let first = agent_dir
        .join("session-artifacts")
        .join("sess-p")
        .join("sub-1")
        .join("sess-1.jsonl");
    fs::create_dir_all(first.parent().unwrap()).unwrap();
    fs::write(&first, "{}").unwrap();
    let spawn = |child_id: &str, child: &str| {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: child_id.into(),
                parent: parent.to_string_lossy().into(),
                child: child.into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
    };
    spawn("sub-1", "/gone-root/sess-1.jsonl");
    let edges = ledger.live_edges().unwrap();
    assert_eq!(edges.len(), 1, "{edges:?}");
    assert_eq!(
        edges[0].child,
        canonical_session_path(&first).to_string_lossy().to_string()
    );

    let second = agent_dir
        .join("session-artifacts")
        .join("sess-p")
        .join("sub-2")
        .join("sess-2.jsonl");
    fs::create_dir_all(second.parent().unwrap()).unwrap();
    fs::write(&second, "{}").unwrap();
    spawn("sub-2", "/gone-root/sess-2.jsonl");
    let edges = ledger.live_edges().unwrap();
    assert_eq!(edges.len(), 2, "{edges:?}");
    let appended = edges
        .iter()
        .find(|edge| edge.child_id == "sub-2")
        .expect("the appended edge");
    assert_eq!(
        appended.child,
        canonical_session_path(&second)
            .to_string_lossy()
            .to_string(),
        "the new partition resolves after its append: {edges:?}"
    );
}

/// The parent-scoped live read bounds the liveness work to the opened
/// parent's own edges: foreign edges with missing endpoints never
/// resolve (no per-edge stats, no artifacts-tree walk), while the own
/// edges resolve - a moved child through its session id - and a
/// tombstoned own child is skipped before any resolution.
#[test]
fn live_edges_of_parent_bounds_the_liveness_work() {
    let agent_dir = temp_dir("scoped");
    let sessions_dir = agent_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    let ledger = ledger_over(&agent_dir, &sessions_dir);

    let parent = sessions_dir.join("sess-p.jsonl");
    let moved_child = sessions_dir.join("sess-a.jsonl");
    let resident_child = sessions_dir.join("sess-b.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&moved_child, "{}").unwrap();
    fs::write(&resident_child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-a".into(),
            parent: parent.to_string_lossy().into(),
            child: "/gone-root/sess-a.jsonl".into(),
            depth: 1,
            name: "a".into(),
        })
        .unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-b".into(),
            parent: parent.to_string_lossy().into(),
            child: resident_child.to_string_lossy().into(),
            depth: 1,
            name: "b".into(),
        })
        .unwrap();
    let deleted_child = sessions_dir.join("sess-d.jsonl");
    fs::write(&deleted_child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-d".into(),
            parent: parent.to_string_lossy().into(),
            child: deleted_child.to_string_lossy().into(),
            depth: 1,
            name: "d".into(),
        })
        .unwrap();
    ledger
        .append_delete(
            "sub-d",
            &deleted_child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
        )
        .unwrap();
    for n in 0..50 {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: format!("sub-f{n}"),
                parent: format!("/gone-root/sess-f{n}.jsonl"),
                child: format!("/gone-root/sess-f{n}-child.jsonl"),
                depth: 1,
                name: format!("f{n}"),
            })
            .unwrap();
    }

    let edges = ledger.live_edges_of_parent(&parent).unwrap();
    let ids: Vec<&str> = edges.iter().map(|edge| edge.child_id.as_str()).collect();
    assert_eq!(ids, ["sub-a", "sub-b"], "{edges:?}");
    assert_eq!(
        edges[0].child,
        canonical_session_path(&moved_child)
            .to_string_lossy()
            .to_string(),
        "the moved child resolves through its session id"
    );

    let state = ledger.replay_of_parent(&parent).unwrap();
    let mut resolver = LivePathResolver::new(
        agent_dir.clone(),
        sessions_dir.clone(),
        &state.artifact_index,
    );
    let scoped = resolve_live_edges(&state, &mut resolver).unwrap();
    assert_eq!(scoped.len(), 2, "{scoped:?}");
    assert_eq!(
        resolver.resolved.len(),
        3,
        "{:?}",
        resolver.resolved.keys().collect::<Vec<_>>()
    );
    assert!(
        state.artifact_index.get().is_none(),
        "no foreign miss walks the artifacts tree"
    );
    let full = ledger.replay_cached().unwrap();
    let mut unscoped = LivePathResolver::new(agent_dir, sessions_dir, &full.artifact_index);
    assert_eq!(resolve_live_edges(&full, &mut unscoped).unwrap().len(), 2);
    assert!(full.artifact_index.get().is_some());
    assert_eq!(unscoped.resolved.len(), 103);
}

#[test]
fn a_dead_endpoint_under_an_archived_parent_resolves_without_a_tree_walk() {
    let agent_dir = temp_dir("archive-dead");
    let sessions_dir = agent_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    let ledger = ledger_over(&agent_dir, &sessions_dir);
    let child = sessions_dir.join("sess-c.jsonl");
    fs::write(&child, "{}").unwrap();
    let archived = crate::session_archive::archive_dir(&agent_dir)
        .join(crate::session_store::session_file_name("sess-p"));
    fs::create_dir_all(archived.parent().unwrap()).unwrap();
    fs::write(&archived, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: "/old-root/sessions/sess-p.jsonl".into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    assert!(
        ledger.live_edges().unwrap().is_empty(),
        "an archived parent is a dead endpoint"
    );
    assert!(
        ledger
            .replay_cached()
            .unwrap()
            .artifact_index
            .get()
            .is_none(),
        "the archive stat answers without the artifacts walk"
    );
}

/// A parent that moved (recorded path gone, same stem under the sessions
/// dir) still lists its children through the scoped read; an edge whose
/// recorded parent merely shares the opened file's stem but resolves to
/// another live file is not the opened parent's.
#[test]
fn live_edges_of_parent_follows_a_moved_parent() {
    let agent_dir = temp_dir("scoped-moved");
    let sessions_dir = agent_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    let ledger = ledger_over(&agent_dir, &sessions_dir);

    let recorded_parent = "/old-root/sessions/sess-p.jsonl";
    let child = sessions_dir.join("sess-c.jsonl");
    let live_parent = sessions_dir.join("sess-p.jsonl");
    fs::write(&child, "{}").unwrap();
    fs::write(&live_parent, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: recorded_parent.into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    let edges = ledger.live_edges_of_parent(&live_parent).unwrap();
    assert_eq!(edges.len(), 1, "{edges:?}");
    assert_eq!(
        edges[0].parent,
        canonical_session_path(&live_parent)
            .to_string_lossy()
            .to_string(),
        "the moved parent still lists its children"
    );

    let elsewhere = agent_dir
        .join("session-artifacts")
        .join("host")
        .join("sess-p2.jsonl");
    fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
    fs::write(&elsewhere, "{}").unwrap();
    fs::write(sessions_dir.join("sess-p2.jsonl"), "{}").unwrap();
    fs::write(sessions_dir.join("sess-c2.jsonl"), "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-2".into(),
            parent: "/old-root/sessions/sess-p2.jsonl".into(),
            child: sessions_dir.join("sess-c2.jsonl").to_string_lossy().into(),
            depth: 1,
            name: "w2".into(),
        })
        .unwrap();
    let edges = ledger.live_edges_of_parent(&elsewhere).unwrap();
    assert!(
        edges.is_empty(),
        "a same-stem parent resolved to another live file is not the opened parent: {edges:?}"
    );
}

#[test]
fn duplicate_child_path_and_bad_spawn_inputs_fail_but_bad_lines_skip() {
    let dir = temp_dir("dup");
    let ledger = ledger_for(&dir);
    let parent = dir.join("p.jsonl");
    let child = dir.join("c.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    let duplicate = ledger.append_spawn(&RlmSpawnInput {
        child_id: "sub-2".into(),
        parent: parent.to_string_lossy().into(),
        child: child.to_string_lossy().into(),
        depth: 1,
        name: "w".into(),
    });
    assert!(duplicate.is_err());
    let depth_zero = ledger.append_spawn(&RlmSpawnInput {
        child_id: "sub-3".into(),
        parent: parent.to_string_lossy().into(),
        child: child.to_string_lossy().into(),
        depth: 0,
        name: "w".into(),
    });
    assert!(depth_zero.is_err());
    // A torn tail or bad line costs that record only; later appends still land.
    let path = ledger.ledger_path().to_path_buf();
    let mut content = fs::read_to_string(&path).unwrap();
    content.push_str("{\"v\":1,\"op\":\"spawn\"}\n{\"v\":1,\"op\":\"spa");
    fs::write(&path, content).unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-4".into(),
            parent: parent.to_string_lossy().into(),
            child: dir.join("c4.jsonl").to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    let edges = ledger.edges(false).unwrap();
    let ids: Vec<_> = edges.into_iter().map(|edge| edge.child_id).collect();
    assert_eq!(ids, ["sub-1", "sub-4"]);
}

#[test]
fn unknown_op_records_are_skipped_forward_compatible() {
    let dir = temp_dir("fwd");
    let ledger = ledger_for(&dir);
    let path = ledger.ledger_path().to_path_buf();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let parent = dir.join("p.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(
        &path,
        format!(
            "{{\"v\":1,\"op\":\"meta\",\"at\":\"t\",\"sessionsDir\":\"x\"}}\n\
             {{\"v\":1,\"op\":\"future\",\"at\":\"t\"}}\n\
             {{\"v\":1,\"op\":\"spawn\",\"at\":\"t\",\"childId\":\"sub-1\",\"parent\":\"{}\",\"child\":\"{}\",\"depth\":1,\"name\":\"w\"}}\n",
            parent.to_string_lossy(),
            parent.to_string_lossy().replace("p.jsonl", "c.jsonl"),
        ),
    )
    .unwrap();
    let edges = ledger.edges(false).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].child_id, "sub-1");
}

#[test]
fn seeds_from_legacy_registries_once_and_atomically() {
    let dir = temp_dir("seed");
    let sessions = dir.join("sessions");
    let artifacts = dir.join("session-artifacts").join("p1");
    fs::create_dir_all(&sessions).unwrap();
    fs::create_dir_all(&artifacts).unwrap();
    let parent = sessions.join("p1.jsonl");
    fs::write(
        &parent,
        "{\"type\":\"session\",\"id\":\"p1\",\"cwd\":\"/x\"}",
    )
    .unwrap();
    let child = dir.join("child.jsonl");
    fs::write(&child, "{}").unwrap();
    fs::write(
        artifacts.join("rlm-subagents.jsonl"),
        format!(
            "{{\"type\":\"rlm_subagent\",\"childId\":\"sub-9\",\"sessionName\":\"w\",\"sessionFile\":\"{}\",\"rlmDepth\":1,\"status\":\"completed\",\"createdAt\":1}}\n",
            child.to_string_lossy()
        ),
    )
    .unwrap();
    let ledger = ledger_for(&dir);
    let edges = ledger.edges(false).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].child_id, "sub-9");
    assert_eq!(edges[0].depth, 1);
    assert_eq!(
        edges[0].parent,
        canonical_session_path(&parent)
            .to_string_lossy()
            .to_string()
    );
    let content = fs::read_to_string(ledger.ledger_path()).unwrap();
    let first = content.lines().next().unwrap();
    assert!(first.contains("\"op\":\"meta\""));
}

#[test]
fn display_entries_round_trip_and_tombstones_stick() {
    let dir = temp_dir("display");
    let child_dir = dir.join("sub-1");
    fs::create_dir_all(&child_dir).unwrap();
    let entry = RlmSubagentDisplayEntry {
        type_tag: "rlm_subagent".into(),
        child_id: "sub-1".into(),
        session_name: "w".into(),
        session_dir: child_dir.to_string_lossy().into(),
        session_file: dir.join("c.jsonl").to_string_lossy().into(),
        rlm_parent_node_id: None,
        prompt: Some("do work".into()),
        spawn_code: None,
        model: Some(json!({"provider": "p", "modelId": "m"})),
        status: "running".into(),
        created_at: 1,
    };
    assert!(write_rlm_subagent_display(&entry).unwrap());
    let read = read_rlm_subagent_display(&child_dir).unwrap();
    assert_eq!(read.child_id, "sub-1");
    assert_eq!(read.prompt.as_deref(), Some("do work"));
    let mut tombstone = entry.clone();
    tombstone.status = "deleted".into();
    assert!(write_rlm_subagent_display(&tombstone).unwrap());
    assert!(!write_rlm_subagent_display(&entry).unwrap());
}

#[test]
fn display_entry_file_is_owner_only() {
    let dir = temp_dir("display-mode");
    let child_dir = dir.join("sub-1");
    fs::create_dir_all(&child_dir).unwrap();
    let entry = RlmSubagentDisplayEntry {
        type_tag: "rlm_subagent".into(),
        child_id: "sub-1".into(),
        session_name: "w".into(),
        session_dir: child_dir.to_string_lossy().into(),
        session_file: dir.join("c.jsonl").to_string_lossy().into(),
        rlm_parent_node_id: None,
        prompt: None,
        spawn_code: None,
        model: None,
        status: "running".into(),
        created_at: 1,
    };
    assert!(write_rlm_subagent_display(&entry).unwrap());
    // The TS display writer creates its temp 0o600; the rename carries
    // that mode onto the visible file.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(child_dir.join("rlm-subagent.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}

fn usage_summary(cost: f64) -> crate::session_usage::SessionUsageSummary {
    crate::session_usage::SessionUsageSummary {
        input_tokens: 1_000,
        output_tokens: 100,
        cost,
    }
}

/// One assistant row with billable usage (the scan's only foldable row shape).
fn assistant_usage_row(id: &str, cost: f64) -> String {
    serde_json::json!({
        "type": "message",
        "id": id,
        "message": {
            "role": "assistant",
            "usage": {
                "input": 1_000,
                "output": 100,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 1_100,
                "cost": { "input": cost, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": cost }
            }
        }
    })
    .to_string()
}

/// The deletion amendment's snapshot rides the delete record, merges into the same tombstoned edge,
/// and survives an idempotent re-tombstone until a fresh capture replaces it.
#[test]
fn delete_amendment_carries_the_usage_snapshot() {
    let dir = temp_dir("amendment");
    let ledger = ledger_for(&dir);
    let parent = dir.join("parent.jsonl");
    let child = dir.join("child.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    ledger
        .append_delete(
            "sub-1",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
        )
        .unwrap();
    // No capture yet: the tombstone predates the settlement barrier.
    assert_eq!(
        ledger.edges(true).unwrap()[0].deleted_usage,
        None,
        "a bare tombstone carries no snapshot"
    );
    ledger
        .append_delete_with_usage(
            "sub-1",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.40),
        )
        .unwrap();
    let edges = ledger.edges(true).unwrap();
    assert_eq!(edges.len(), 1, "the amendment merges into the one edge");
    assert_eq!(edges[0].deleted, Some(RlmLedgerDeleteReason::User));
    assert_eq!(edges[0].deleted_usage, Some(usage_summary(0.40)));
    ledger
        .append_delete(
            "sub-1",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
        )
        .unwrap();
    assert_eq!(
        ledger.edges(true).unwrap()[0].deleted_usage,
        Some(usage_summary(0.40)),
        "the snapshot is sticky across re-tombstones"
    );
    ledger
        .append_delete_with_usage(
            "sub-1",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.45),
        )
        .unwrap();
    assert_eq!(
        ledger.edges(true).unwrap()[0].deleted_usage,
        Some(usage_summary(0.45))
    );
}

/// The writer never records what the reader refuses: a negative or NaN
/// usage cost rides as absent (a bare delete record), so the ledger stays readable.
#[test]
fn append_delete_with_usage_sanitizes_a_rejectable_cost() {
    let dir = temp_dir("usage-neg");
    let ledger = ledger_for(&dir);
    let parent = dir.join("parent.jsonl");
    let child = dir.join("child.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "neg".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    for bad_cost in [-0.40, -0.0, f64::NAN, f64::INFINITY] {
        ledger
            .append_delete_with_usage(
                "neg",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                &usage_summary(bad_cost),
            )
            .unwrap();
        let edges = ledger.edges(true).expect("the ledger must stay readable");
        assert_eq!(
            edges[0].deleted_usage, None,
            "a cost the reader would reject rides as absent ({bad_cost})",
        );
    }
    ledger
        .append_delete_with_usage(
            "neg",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.40),
        )
        .unwrap();
    assert_eq!(
        ledger.edges(true).unwrap()[0].deleted_usage,
        Some(usage_summary(0.40))
    );
}

#[test]
fn tombstone_child_path_with_usage_snapshots_every_edge() {
    let dir = temp_dir("path-usage");
    let ledger = ledger_for(&dir);
    let parent = dir.join("parent.jsonl");
    let child = dir.join("child.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, "{}").unwrap();
    for child_id in ["sub-1", "sub-2"] {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: child_id.into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
        ledger
            .append_delete(
                child_id,
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
            )
            .unwrap();
    }
    let edges = ledger
        .tombstone_child_path_with_usage(
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            Some(&usage_summary(0.30)),
        )
        .unwrap();
    assert_eq!(edges.len(), 2);
    for edge in ledger.edges(true).unwrap() {
        assert_eq!(edge.deleted_usage, Some(usage_summary(0.30)));
    }
}

/// The deleted-descendant bucket: the numeric fixture (own $0 + deleted
/// child $0.40 + its deleted grandchild $0.10 => the parent's bucket
/// $0.50). The snapshots are OWN-ONLY: one carrying the child's
/// aggregate would double count the grandchild.
#[test]
fn bucket_folds_own_snapshots_post_order_without_double_counting() {
    let dir = temp_dir("bucket-fixture");
    let ledger = ledger_for(&dir);
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("p.jsonl");
    let child_1 = sessions.join("c1.jsonl");
    let grandchild_1 = sessions.join("gc1.jsonl");
    let child_2 = sessions.join("c2.jsonl");
    let grandchild_2 = sessions.join("gc2.jsonl");
    for (path, cost) in [
        (&parent, 0.0),
        (&child_1, 0.40),
        (&grandchild_1, 0.10),
        (&child_2, 0.20),
        (&grandchild_2, 0.30),
    ] {
        fs::write(path, assistant_usage_row("m1", cost)).unwrap();
    }
    let spawn = |child_id: &str, parent: &Path, child: &Path, depth: u32| {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: child_id.into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth,
                name: "w".into(),
            })
            .unwrap();
    };
    spawn("c1", &parent, &child_1, 1);
    spawn("gc1", &child_1, &grandchild_1, 2);
    spawn("c2", &parent, &child_2, 1);
    spawn("gc2", &child_2, &grandchild_2, 2);
    // The deleted child's own spend is 0.40 even though its file also
    // carries the deleted grandchild's attribution (total 0.50): the
    // capture reads own, never the aggregate.
    ledger
        .append_delete_with_usage(
            "c1",
            &child_1.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.40),
        )
        .unwrap();
    ledger
        .append_delete_with_usage(
            "gc1",
            &grandchild_1.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.10),
        )
        .unwrap();
    // The tombstoned children's transcripts are gone (a transcript
    // directly in the sessions dir keeps its catalog row and the bucket
    // skips it).
    fs::remove_file(&child_1).unwrap();
    fs::remove_file(&grandchild_1).unwrap();
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    let parent_key = crate::lease::canonical_session_path(&parent)
        .to_string_lossy()
        .to_string();
    let child_key = crate::lease::canonical_session_path(&child_1)
        .to_string_lossy()
        .to_string();
    let deleted = bucket
        .get(&parent_key)
        .expect("the parent bills its deleted descendants");
    assert!(
        (deleted.cost - 0.50).abs() < 1e-9,
        "own 0.40 + deleted grandchild 0.10 = 0.50, got {}",
        deleted.cost
    );
    // TS `usageByParent` also keys the tombstoned intermediate parent:
    // inert, no row exists there to consume it.
    assert!(
        (bucket.get(&child_key).map_or(0.0, |d| d.cost) - 0.10).abs() < 1e-9,
        "the tombstoned intermediate keeps its inert TS key"
    );
    assert_eq!(bucket.len(), 2, "live descendants contribute no bucket");
    // The regression pin: a snapshot carrying the child's aggregate
    // (0.50 instead of own 0.40) double counts the grandchild.
    let mut ledger_lines: Vec<String> = fs::read_to_string(ledger.ledger_path())
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    let amend = ledger_lines
        .iter()
        .position(|line| line.contains("\"childId\":\"c1\"") && line.contains("\"usage\""))
        .expect("the c1 amendment");
    ledger_lines[amend] = ledger_lines[amend].replace("\"cost\":0.4}", "\"cost\":0.5}");
    fs::write(ledger.ledger_path(), ledger_lines.join("\n") + "\n").unwrap();
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    let over_billed = bucket.get(&parent_key).unwrap().cost;
    assert!(
        (over_billed - 0.60).abs() < 1e-9,
        "an aggregate snapshot double counts the deleted grandchild: {over_billed}"
    );
}

/// Legacy tombstones (pre-capture): a live transcript rides its own row
/// (billing both would double the spend); once it is gone the documented historical gap bills zero.
#[test]
fn bucket_legacy_tombstones_fall_back_then_gap_to_zero() {
    let dir = temp_dir("bucket-legacy");
    let ledger = ledger_for(&dir);
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("p.jsonl");
    let child = sessions.join("c.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, assistant_usage_row("m1", 0.25)).unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-1".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    ledger
        .append_delete(
            "sub-1",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
        )
        .unwrap();
    let parent_key = crate::lease::canonical_session_path(&parent)
        .to_string_lossy()
        .to_string();
    // A tombstoned transcript directly in the sessions dir keeps its
    // catalog row (the rollup sums the row AND the parent bucket, so
    // billing both would double the spend): the bucket skips it,
    // legacy tombstone or not.
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    assert!(
        !bucket.contains_key(&parent_key),
        "a live transcript rides its own row, not the bucket"
    );
    // The transcript goes (a saved-session delete, a cleanup): no
    // snapshot, no file, no spend — the gap is zero, not invented.
    fs::remove_file(&child).unwrap();
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    assert!(
        !bucket.contains_key(&parent_key),
        "the historical gap bills nothing"
    );
}

/// A tombstoned child whose transcript lives under session-artifacts
/// (every real RLM child: the flat catalog scans only the sessions dir,
/// so no archived row bills it) has no catalog row: the bucket bills its
/// captured snapshot, and a legacy tombstone that predates the capture
/// falls back to the transcript's own-usage fold. A transcript directly
/// in the sessions dir keeps its catalog row and stays skipped (the
/// flat-dir tests above pin that half).
#[test]
fn bucket_bills_tombstoned_children_without_catalog_rows() {
    let dir = temp_dir("bucket-no-row");
    let ledger = ledger_for(&dir);
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("p.jsonl");
    fs::write(&parent, "{}").unwrap();
    // The real RLM child locations: under the agent dir's
    // session-artifacts tree, one per child id.
    let snapshot_child = dir
        .join("session-artifacts")
        .join("p")
        .join("sub-1")
        .join("sub-1.jsonl");
    let legacy_child = dir
        .join("session-artifacts")
        .join("p")
        .join("sub-2")
        .join("sub-2.jsonl");
    for child in [&snapshot_child, &legacy_child] {
        fs::create_dir_all(child.parent().unwrap()).unwrap();
    }
    fs::write(&snapshot_child, assistant_usage_row("m1", 0.30)).unwrap();
    // The legacy child's transcript predates the capture: its own fold
    // is the only record of its spend. Its rows carry the persisted
    // shape - the top-level timestamp every real entry has, which the
    // resumable scan's fold reads.
    let mut legacy = String::from(
        "{\"type\":\"session\",\"version\":3,\"id\":\"sub-2\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}\n",
    );
    legacy.push_str(
        &serde_json::json!({
            "type": "message",
            "id": "m1",
            "timestamp": "2024-01-01T00:00:01.000Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "work complete" }],
                "stopReason": "stop",
                "timestamp": 1000,
                "usage": {
                    "input": 1_000,
                    "output": 100,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 1_100,
                    "cost": { "input": 0.0, "output": 0.25, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.25 }
                }
            }
        })
        .to_string(),
    );
    legacy.push('\n');
    fs::write(&legacy_child, legacy).unwrap();
    let spawn = |child_id: &str, child: &Path| {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: child_id.into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
    };
    spawn("sub-1", &snapshot_child);
    spawn("sub-2", &legacy_child);
    // The captured delete, and the legacy (snapshot-less) delete.
    ledger
        .append_delete_with_usage(
            "sub-1",
            &snapshot_child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.30),
        )
        .unwrap();
    ledger
        .append_delete(
            "sub-2",
            &legacy_child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
        )
        .unwrap();
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    let parent_key = crate::lease::canonical_session_path(&parent)
        .to_string_lossy()
        .to_string();
    assert_eq!(
        bucket,
        HashMap::from([(
            parent_key,
            SessionUsageSummary {
                input_tokens: 2_000,
                output_tokens: 200,
                cost: 0.55,
            },
        )]),
        "the captured snapshot 0.30 + the legacy transcript's own fold 0.25; only the parent bills"
    );
}

/// A raced ledger claims each tombstoned path once (first writer wins):
/// one child path billed to two parents would double the spend.
#[test]
fn bucket_claims_each_tombstoned_path_once() {
    let dir = temp_dir("bucket-claim");
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent_a = sessions.join("pa.jsonl");
    let parent_b = sessions.join("pb.jsonl");
    let child = sessions.join("c.jsonl");
    for path in [&parent_a, &parent_b] {
        fs::write(path, "{}").unwrap();
    }
    fs::write(&child, assistant_usage_row("m1", 0.15)).unwrap();
    // A corrupt raced ledger: two edges for one child path under two
    // parents, both tombstoned. Hand-written records — the append API
    // refuses the live duplicate path.
    let lines = [
        json!({
            "v": 1, "op": "spawn", "at": "2026-01-01T00:00:00Z",
            "childId": "x1", "parent": parent_a.to_string_lossy(),
            "child": child.to_string_lossy(), "depth": 1, "name": "w",
        }),
        json!({
            "v": 1, "op": "delete", "at": "2026-01-01T00:00:01Z",
            "childId": "x1", "child": child.to_string_lossy(), "reason": "user",
            // The captured snapshot rides the tombstone: a claim with
            // real spend is observable in the bucket, so the
            // first-writer-wins claim pins the parent by VALUE.
            "usage": {"inputTokens": 1000, "outputTokens": 100, "cost": 0.15},
        }),
        json!({
            "v": 1, "op": "spawn", "at": "2026-01-01T00:00:02Z",
            "childId": "x2", "parent": parent_b.to_string_lossy(),
            "child": child.to_string_lossy(), "depth": 1, "name": "w",
        }),
        json!({
            "v": 1, "op": "delete", "at": "2026-01-01T00:00:03Z",
            "childId": "x2", "child": child.to_string_lossy(), "reason": "user",
        }),
    ];
    let body = lines.iter().fold(String::new(), |mut body, line| {
        use std::fmt::Write;
        writeln!(body, "{line}").expect("write to String");
        body
    });
    let path = rlm_ledger_path(&dir, &sessions);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, body).unwrap();
    let ledger = ledger_for(&dir);
    // The raced child's transcript is gone (the bucket is for files
    // that died — a live file rides its own row).
    fs::remove_file(&child).unwrap();
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    let key_a = crate::lease::canonical_session_path(&parent_a)
        .to_string_lossy()
        .to_string();
    let key_b = crate::lease::canonical_session_path(&parent_b)
        .to_string_lossy()
        .to_string();
    assert!(
        bucket.contains_key(&key_a),
        "the first tombstone claims the path"
    );
    let claimed = &bucket[&key_a];
    assert_eq!(claimed.input_tokens, 1000);
    assert_eq!(claimed.output_tokens, 100);
    assert!((claimed.cost - 0.15).abs() < 1e-9);
    assert!(
        !bucket.contains_key(&key_b),
        "the second parent never bills the same path"
    );
}

/// A recreated path is live: its old tombstone never bills spend that
/// the new live child's own row carries.
#[test]
fn bucket_skips_recreated_live_paths() {
    let dir = temp_dir("bucket-live");
    let ledger = ledger_for(&dir);
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("p.jsonl");
    let child = sessions.join("c.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, "{}").unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "old".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        })
        .unwrap();
    ledger
        .append_delete_with_usage(
            "old",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.20),
        )
        .unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "new".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w2".into(),
        })
        .unwrap();
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    assert!(bucket.is_empty(), "a live path never bills the bucket");
}

#[test]
fn the_bucket_updates_after_an_append_on_the_same_ledger() {
    let dir = temp_dir("bucket-append");
    let ledger = ledger_for(&dir);
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("p.jsonl");
    let child_1 = sessions.join("c1.jsonl");
    let child_2 = sessions.join("c2.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child_1, "{}").unwrap();
    fs::write(&child_2, "{}").unwrap();
    let parent_key = crate::lease::canonical_session_path(&parent)
        .to_string_lossy()
        .to_string();
    let spawn_delete = |child_id: &str, child: &Path, cost: f64| {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: child_id.into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
        ledger
            .append_delete_with_usage(
                child_id,
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                &usage_summary(cost),
            )
            .unwrap();
        fs::remove_file(child).unwrap();
    };
    spawn_delete("sub-1", &child_1, 0.25);
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    assert_eq!(
        bucket,
        HashMap::from([(parent_key.clone(), usage_summary(0.25))]),
        "the first delete bills: {bucket:?}"
    );
    spawn_delete("sub-2", &child_2, 0.50);
    let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
    assert_eq!(
        bucket,
        HashMap::from([(
            parent_key,
            SessionUsageSummary {
                input_tokens: 2_000,
                output_tokens: 200,
                cost: 0.75,
            }
        )]),
        "the appended delete bills on the same instance: {bucket:?}"
    );
}

#[test]
fn a_restored_tombstoned_child_stops_billing_the_parent_without_an_append() {
    let dir = temp_dir("bucket-restore");
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("parent.jsonl");
    let child = sessions.join("child.jsonl");
    fs::write(&parent, "{}").unwrap();
    fs::write(&child, assistant_usage_row("m1", 0.25)).unwrap();
    let ledger = ledger_for(&dir);
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-child".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "child".into(),
        })
        .unwrap();
    ledger
        .append_delete_with_usage(
            "sub-child",
            &child.to_string_lossy(),
            RlmLedgerDeleteReason::User,
            &usage_summary(0.25),
        )
        .unwrap();
    let archive = crate::session_archive::archive_dir(&dir);
    fs::create_dir_all(&archive).unwrap();
    let archived = archive.join(crate::session_store::session_file_name("child"));
    fs::rename(&child, &archived).unwrap();
    let key = canonical_session_path(&parent)
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        ledger.deleted_descendant_usage_by_parent().unwrap(),
        HashMap::from([(key, usage_summary(0.25))])
    );
    crate::session_archive::restore_session(&archive, &sessions, "child").unwrap();
    assert_eq!(
        ledger.deleted_descendant_usage_by_parent().unwrap(),
        HashMap::new()
    );
}

#[test]
fn the_artifact_index_rechecks_deleted_and_relocated_transcripts_without_an_append() {
    let dir = temp_dir("index-disk-change");
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("parent.jsonl");
    fs::write(&parent, "{}").unwrap();
    let child = dir.join("session-artifacts/parent/sub/child.jsonl");
    fs::create_dir_all(child.parent().unwrap()).unwrap();
    fs::write(&child, "{}").unwrap();
    let ledger = ledger_for(&dir);
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub".into(),
            parent: parent.to_string_lossy().into(),
            child: "/gone/child.jsonl".into(),
            depth: 1,
            name: "child".into(),
        })
        .unwrap();
    let initial = ledger.live_edges().unwrap();
    assert_eq!(initial.len(), 1);
    fs::remove_file(&child).unwrap();
    assert_eq!(ledger.live_edges().unwrap(), Vec::new());
    let relocated = dir.join("session-artifacts/other/sub/child.jsonl");
    fs::create_dir_all(relocated.parent().unwrap()).unwrap();
    fs::write(&relocated, "{}").unwrap();
    let mut expected = initial;
    expected[0].child = canonical_session_path(&relocated)
        .to_string_lossy()
        .into_owned();
    assert_eq!(ledger.live_edges().unwrap(), expected);
}

#[test]
fn artifact_misses_stay_cached_until_a_directory_changes() {
    let dir = temp_dir("index-negative-cache");
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("parent.jsonl");
    fs::write(&parent, "{}").unwrap();
    let partition = dir.join("session-artifacts/parent/sub");
    fs::create_dir_all(&partition).unwrap();
    let ledger = ledger_for(&dir);
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub".into(),
            parent: parent.to_string_lossy().into(),
            child: "/gone/child.jsonl".into(),
            depth: 1,
            name: "child".into(),
        })
        .unwrap();
    let scans = replay::ARTIFACT_SCANS.with(std::cell::Cell::get);
    assert_eq!(ledger.live_edges().unwrap(), Vec::new());
    assert_eq!(ledger.live_edges().unwrap(), Vec::new());
    assert_eq!(replay::ARTIFACT_SCANS.with(std::cell::Cell::get), scans + 1);
    let restored = partition.join("child.jsonl");
    fs::write(&restored, "{}").unwrap();
    let expected = vec![RlmLedgerEdge {
        child_id: "sub".into(),
        parent: canonical_session_path(&parent).to_string_lossy().into(),
        child: canonical_session_path(&restored).to_string_lossy().into(),
        depth: 1,
        name: "child".into(),
        deleted: None,
        deleted_usage: None,
    }];
    assert_eq!(ledger.live_edges().unwrap(), expected);
    assert_eq!(ledger.live_edges().unwrap(), expected);
    assert_eq!(replay::ARTIFACT_SCANS.with(std::cell::Cell::get), scans + 2);
}

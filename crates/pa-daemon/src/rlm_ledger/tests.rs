//! The RLM ledger test battery: grammar, replay, tombstone, seed, display,
//! and usage-bucket families.
use super::*;

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
            factory: None,
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
            factory: None,
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
            factory: None,
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
                factory: None,
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
                factory: None,
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
            factory: None,
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
            factory: None,
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
                factory: None,
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
            factory: None,
        })
        .unwrap();
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub-b".into(),
            parent: parent.to_string_lossy().into(),
            child: resident_child.to_string_lossy().into(),
            depth: 1,
            name: "b".into(),
            factory: None,
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
            factory: None,
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
                factory: None,
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
fn a_parent_left_in_the_archive_dir_is_a_dead_endpoint_walked_once() {
    let agent_dir = temp_dir("archive-dead");
    let sessions_dir = agent_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    let ledger = ledger_over(&agent_dir, &sessions_dir);
    let child = sessions_dir.join("sess-c.jsonl");
    fs::write(&child, "{}").unwrap();
    let archived = agent_dir
        .join("sessions-archive")
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
            factory: None,
        })
        .unwrap();
    let scans = replay::ARTIFACT_SCANS.with(std::cell::Cell::get);
    assert_eq!(ledger.live_edges().unwrap(), Vec::new());
    assert_eq!(ledger.live_edges().unwrap(), Vec::new());
    assert_eq!(replay::ARTIFACT_SCANS.with(std::cell::Cell::get), scans + 1);
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
            factory: None,
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
            factory: None,
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
            factory: None,
        })
        .unwrap();
    let duplicate = ledger.append_spawn(&RlmSpawnInput {
        child_id: "sub-2".into(),
        parent: parent.to_string_lossy().into(),
        child: child.to_string_lossy().into(),
        depth: 1,
        name: "w".into(),
        factory: None,
    });
    assert!(duplicate.is_err());
    let depth_zero = ledger.append_spawn(&RlmSpawnInput {
        child_id: "sub-3".into(),
        parent: parent.to_string_lossy().into(),
        child: child.to_string_lossy().into(),
        depth: 0,
        name: "w".into(),
        factory: None,
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
            factory: None,
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
            factory: None,
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
            factory: None,
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
        factory: None,
    }];
    assert_eq!(ledger.live_edges().unwrap(), expected);
    assert_eq!(ledger.live_edges().unwrap(), expected);
    assert_eq!(replay::ARTIFACT_SCANS.with(std::cell::Cell::get), scans + 2);
}

#[test]
fn family_edges_track_restore_and_relocation_without_a_ledger_append() {
    let dir = temp_dir("family-disk-change");
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let parent = sessions.join("parent.jsonl");
    let child = sessions.join("child.jsonl");
    fs::write(&parent, "{}").unwrap();
    let parent = canonical_session_path(&parent);
    fs::write(&child, "{}").unwrap();
    let ledger = ledger_for(&dir);
    ledger
        .append_spawn(&RlmSpawnInput {
            child_id: "sub".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "child".into(),
            factory: None,
        })
        .unwrap();
    let family_children = || -> Vec<PathBuf> {
        ledger
            .family_edges([parent.clone()])
            .unwrap()
            .into_iter()
            .map(|edge| PathBuf::from(edge.child))
            .collect()
    };
    let archived = dir.join("sessions-archive").join("child.jsonl");
    fs::create_dir_all(archived.parent().unwrap()).unwrap();
    fs::rename(&child, &archived).unwrap();
    assert!(family_children().is_empty());
    fs::rename(&archived, &child).unwrap();
    assert_eq!(family_children(), vec![canonical_session_path(&child)]);
    let relocated = dir.join("session-artifacts/parent/sub/child.jsonl");
    fs::create_dir_all(relocated.parent().unwrap()).unwrap();
    fs::rename(&child, &relocated).unwrap();
    assert_eq!(family_children(), vec![canonical_session_path(&relocated)]);
    fs::remove_file(&relocated).unwrap();
    assert!(family_children().is_empty());
}

#[cfg(unix)]
#[test]
fn family_edges_recheck_symlink_targets_without_a_ledger_append() {
    use std::os::unix::fs::symlink;
    let dir = temp_dir("family-symlink");
    let parent = dir.join("parent.jsonl");
    let first = dir.join("first.jsonl");
    let second = dir.join("second.jsonl");
    let grandchild = dir.join("grandchild.jsonl");
    for file in [&parent, &first, &second, &grandchild] {
        fs::write(file, "{}").unwrap();
    }
    let ledger = ledger_for(&dir);
    for (child_id, parent, child) in [("sub", &parent, &first), ("grand", &first, &grandchild)] {
        ledger
            .append_spawn(&RlmSpawnInput {
                child_id: child_id.into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: child_id.into(),
                factory: None,
            })
            .unwrap();
    }
    let family_children = || -> Vec<PathBuf> {
        ledger
            .family_edges([parent.clone()])
            .unwrap()
            .into_iter()
            .map(|edge| PathBuf::from(edge.child))
            .collect()
    };
    assert_eq!(
        family_children(),
        vec![
            canonical_session_path(&first),
            canonical_session_path(&grandchild)
        ]
    );
    fs::remove_file(&first).unwrap();
    symlink(&second, &first).unwrap();
    // The retargeted child resolves to its new file; its own children,
    // recorded under the old path's id, stay in the family.
    assert_eq!(
        family_children(),
        vec![
            canonical_session_path(&second),
            canonical_session_path(&grandchild)
        ]
    );
}

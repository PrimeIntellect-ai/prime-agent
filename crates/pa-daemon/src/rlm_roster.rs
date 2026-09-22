//! Passive (non-resident) RLM children for the roster surfaces: the ledger
//! walk that keeps historical children visible in `list --all` and the
//! saved-session catalog after their parent (or the whole daemon) has
//! passivated. Port of the TS passive-RLM roster walk
//! (`walkPassiveRlmSubagents` + `withPassiveRlmDescendantInfos`): roots are
//! the saved session files plus every resident session file, live ledger
//! edges group children by parent, resident children walk as roots (their
//! rows come from the live registry), and every other live child's file is
//! read for display data. Topology always comes from the ledger edge; the
//! session file is display-grade.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::rlm_ledger::{
    read_legacy_registry, read_rlm_subagent_display, LegacyRlmSubagentEntry, RlmLedgerEdge,
    RlmSpawnLedger,
};
use crate::session_store::{read_session_info, SessionInfo};

/// Hydration metadata fields beyond the edge (prompt, model, node ids):
/// display-grade, never topology.
#[derive(Debug, Clone, Default)]
pub struct RlmChildMetadata {
    pub spawn_code: Option<String>,
    pub rlm_parent_node_id: Option<String>,
    pub parent_session_id: Option<String>,
}

/// One walk root: a saved or resident session file. Resident roots carry
/// their active session id (a passive child of a resident parent reports it
/// as `parentActiveSessionId`).
#[derive(Debug, Clone)]
pub struct RosterWalkRoot {
    pub session_file: PathBuf,
    pub active_session_id: Option<String>,
}

/// One walked passive child: the authoritative ledger edge plus the
/// display-grade session info and hydration metadata.
#[derive(Debug, Clone)]
pub struct PassiveRlmChild {
    pub edge: RlmLedgerEdge,
    pub info: SessionInfo,
    pub metadata: RlmChildMetadata,
    /// Set when the child's direct parent is a resident root (TS: a
    /// chain of length one rooted at a resident parent).
    pub parent_active_session_id: Option<String>,
}

/// Walk every non-resident child reachable from the roots. A ledger read
/// error propagates (the caller decides between failing the command and
/// degrading); unreadable child files are skipped row-less, never fatal.
pub fn walk_passive_rlm_children(
    ledger: &RlmSpawnLedger,
    roots: &[RosterWalkRoot],
) -> anyhow::Result<Vec<PassiveRlmChild>> {
    let edges = ledger.live_edges()?;
    let mut children_by_parent: HashMap<PathBuf, Vec<&RlmLedgerEdge>> = HashMap::new();
    for edge in &edges {
        children_by_parent
            .entry(canonical_session_path(std::path::Path::new(&edge.parent)))
            .or_default()
            .push(edge);
    }
    let resident_paths: HashMap<PathBuf, String> = roots
        .iter()
        .filter_map(|root| {
            root.active_session_id
                .as_ref()
                .map(|id| (canonical_session_path(&root.session_file), id.clone()))
        })
        .collect();
    let mut visited: HashSet<PathBuf> = roots
        .iter()
        .map(|root| canonical_session_path(&root.session_file))
        .collect();
    // Roots in order (saved first, then residents); children are visited
    // in ledger order within each parent.
    let mut queue: Vec<PathBuf> = roots
        .iter()
        .map(|root| canonical_session_path(&root.session_file))
        .collect();
    let mut registry_cache: HashMap<PathBuf, Vec<LegacyRlmSubagentEntry>> = HashMap::new();
    let mut walked = Vec::new();
    while let Some(parent) = queue.pop() {
        let Some(edges) = children_by_parent.get(&parent) else {
            continue;
        };
        for edge in edges.iter().copied() {
            let child = canonical_session_path(std::path::Path::new(&edge.child));
            if !visited.insert(child.clone()) {
                continue;
            }
            // A resident child contributes no passive row: its row comes
            // from the live registry, and it walks as its own root.
            if resident_paths.contains_key(&child) {
                queue.push(child);
                continue;
            }
            let Some(info) = read_session_info(&child) else {
                continue;
            };
            let metadata = rlm_child_metadata(edge, &mut registry_cache);
            let parent_active_session_id = resident_paths
                .get(&canonical_session_path(std::path::Path::new(&edge.parent)))
                .cloned();
            walked.push(PassiveRlmChild {
                edge: edge.clone(),
                info,
                metadata,
                parent_active_session_id,
            });
            // Passive children are walk roots for their own children.
            queue.push(child);
        }
    }
    Ok(walked)
}

/// Lifecycle for an off-daemon session (TS `inactiveLifecycleForSession`):
/// explicit archived/crash markers stay archived, everything else is live
/// once a message exists, draft otherwise.
fn inactive_lifecycle(info: &SessionInfo) -> &'static str {
    match info.state.as_deref() {
        Some("archived") | Some("crash") => "archived",
        _ if info.message_count > 0 => "live",
        _ => "draft",
    }
}

/// Hydration metadata for one live ledger edge: the child's display file
/// first, then the parent's legacy registry for pre-ledger children (one
/// registry read per parent, cached for the walk). The edge itself is
/// always the topology authority. Mirrors TS `passiveRlmSubagentEntryForEdge`.
pub(crate) fn rlm_child_metadata(
    edge: &RlmLedgerEdge,
    registry_cache: &mut HashMap<PathBuf, Vec<LegacyRlmSubagentEntry>>,
) -> RlmChildMetadata {
    if let Some(child_dir) = Path::new(&edge.child).parent() {
        if let Some(display) = read_rlm_subagent_display(child_dir) {
            if display.child_id == edge.child_id {
                return RlmChildMetadata {
                    spawn_code: display.spawn_code,
                    rlm_parent_node_id: display.rlm_parent_node_id,
                    parent_session_id: None,
                };
            }
        }
    }
    let parent = Path::new(&edge.parent).to_path_buf();
    let registry = registry_cache
        .entry(parent)
        .or_insert_with(|| read_legacy_registry(Path::new(&edge.parent)));
    match registry
        .iter()
        .find(|entry| entry.child_id == edge.child_id)
    {
        Some(entry) => RlmChildMetadata {
            spawn_code: entry.spawn_code.clone(),
            rlm_parent_node_id: entry.rlm_parent_node_id.clone(),
            parent_session_id: (!entry.parent_session_id.is_empty())
                .then(|| entry.parent_session_id.clone()),
        },
        None => RlmChildMetadata::default(),
    }
}

/// One passive child as a daemon list summary row (TS
/// `buildSessionListWithPassiveRlmSubagents`: the inactive-session summary
/// with the subagent identity fields merged in).
pub fn passive_child_summary(child: &PassiveRlmChild) -> Value {
    let PassiveRlmChild {
        edge,
        info,
        metadata,
        parent_active_session_id,
    } = child;
    let mut row = json!({
        "id": info.id,
        "lifecycle": inactive_lifecycle(info),
        "activity": "idle",
        "isSessionActive": false,
        "activeSessionId": info.id,
        "sessionId": info.id,
        "sessionFile": info.path.to_string_lossy(),
        "sessionName": info.name,
        "cwd": info.cwd,
        "isStreaming": false,
        "isCompacting": false,
        "attachedClients": 0,
        "messageCount": info.message_count,
        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
        "created": info.created,
        "modified": info.modified,
        "lastActivityAt": info.modified,
        "firstMessage": info.first_message,
        "runtimeKind": "subagent",
        "parentSessionPath": edge.parent,
        "rlmDepth": edge.depth,
        "rlmChildId": edge.child_id,
        "rlmParentNodeId": metadata
            .rlm_parent_node_id
            .clone()
            .unwrap_or_else(|| edge.child_id.clone()),
    });
    let object = row.as_object_mut().expect("summary object");
    if let Some(parent_id) = parent_active_session_id {
        object.insert("parentActiveSessionId".to_string(), json!(parent_id));
    }
    if let Some(parent_session_id) = &metadata.parent_session_id {
        object.insert("parentSessionId".to_string(), json!(parent_session_id));
    }
    if let Some(spawn_code) = &metadata.spawn_code {
        object.insert("spawnCode".to_string(), json!(spawn_code));
    }
    // The persisted thinking level rides the passive-child row like the
    // saved-session row: the agents-view Model column keeps rendering
    // "model:level" for passivated subagents.
    if let Some(level) = &info.thinking_level {
        object.insert("thinkingLevel".to_string(), json!(level));
    }
    row
}

/// The passive child as a saved-session catalog row: the ordinary session
/// info with the ledger edge as the topology authority (TS
/// `withPassiveRlmDescendantInfos`).
pub fn passive_child_info(child: &PassiveRlmChild) -> SessionInfo {
    let mut info = child.info.clone();
    info.parent_session_path = Some(child.edge.parent.clone());
    info.rlm_depth = child.edge.depth;
    info
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rlm_ledger::{RlmLedgerDeleteReason, RlmSpawnInput};
    use serde_json::json;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-roster-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session_with_thinking(path: &std::path::Path, id: &str, level: &str) {
        let content = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"t\",\"cwd\":\"/x\"}}\n             {{\"type\":\"thinking_level_change\",\"id\":\"t1\",\"parentId\":null,\"timestamp\":\"t\",\"thinkingLevel\":\"{level}\"}}\n"
        );
        fs::write(path, content).unwrap();
    }

    /// The passive-child summary row carries the persisted thinking level:
    /// a passivated subagent keeps rendering "model:level" in the agents
    /// view, like its live counterpart.
    #[test]
    fn passive_child_summary_carries_the_persisted_thinking_level() {
        let dir = temp_dir("thinking");
        let child = dir.join("sub-tl.jsonl");
        write_session_with_thinking(&child, "sub-tl", "high");
        let info = read_session_info(&child).expect("child info");
        assert_eq!(info.thinking_level.as_deref(), Some("high"));
        let child_row = PassiveRlmChild {
            edge: RlmLedgerEdge {
                child_id: "sub-tl".to_string(),
                parent: "/live/root.jsonl".to_string(),
                child: child.to_string_lossy().to_string(),
                depth: 1,
                name: "worker-a".to_string(),
                deleted: None,
            },
            info,
            metadata: RlmChildMetadata::default(),
            parent_active_session_id: None,
        };
        let summary = passive_child_summary(&child_row);
        assert_eq!(summary["thinkingLevel"], json!("high"));

        // A child file without a persisted level stays bare.
        let plain = dir.join("sub-plain.jsonl");
        write_session(&plain, "sub-plain", 0);
        let plain_info = read_session_info(&plain).expect("plain info");
        assert_eq!(plain_info.thinking_level, None);
        let plain_row = PassiveRlmChild {
            edge: RlmLedgerEdge {
                child_id: "sub-plain".to_string(),
                parent: "/live/root.jsonl".to_string(),
                child: plain.to_string_lossy().to_string(),
                depth: 1,
                name: "worker-b".to_string(),
                deleted: None,
            },
            info: plain_info,
            metadata: RlmChildMetadata::default(),
            parent_active_session_id: None,
        };
        assert!(passive_child_summary(&plain_row)
            .get("thinkingLevel")
            .is_none());
    }

    fn write_session(path: &std::path::Path, id: &str, messages: usize) {
        let mut content = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"t\",\"cwd\":\"/x\"}}\n"
        );
        for i in 0..messages {
            content.push_str(&format!(
                "{{\"type\":\"message\",\"id\":\"m{i}\",\"timestamp\":\"t\",\"message\":{{\"role\":\"user\",\"content\":\"msg {i}\",\"timestamp\":{i}}}}}\n"
            ));
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn walks_passive_children_from_saved_and_resident_roots() {
        let dir = temp_dir("walk");
        let sessions = dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let parent = sessions.join("parent.jsonl");
        write_session(&parent, "p", 1);
        let child = dir.join("child.jsonl");
        write_session(&child, "c1", 2);
        let grandchild = dir.join("grandchild.jsonl");
        write_session(&grandchild, "c2", 1);
        let dead = dir.join("dead.jsonl");

        let ledger = RlmSpawnLedger::new(&dir, &sessions, |_| {});
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w1".into(),
            })
            .unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-2".into(),
                parent: child.to_string_lossy().into(),
                child: grandchild.to_string_lossy().into(),
                depth: 2,
                name: "w2".into(),
            })
            .unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-3".into(),
                parent: parent.to_string_lossy().into(),
                child: dead.to_string_lossy().into(),
                depth: 1,
                name: "gone".into(),
            })
            .unwrap();
        // A deleted child tombstones out of the walk.
        ledger
            .append_delete(
                "sub-3",
                &dead.to_string_lossy(),
                RlmLedgerDeleteReason::User,
            )
            .unwrap();
        // A tombstoned edge whose child file exists still walks nothing.
        assert!(!dead.exists());

        let roots = vec![RosterWalkRoot {
            session_file: parent.clone(),
            active_session_id: None,
        }];
        let walked = walk_passive_rlm_children(&ledger, &roots).unwrap();
        assert_eq!(walked.len(), 2);
        assert_eq!(walked[0].edge.child_id, "sub-1");
        assert_eq!(walked[0].edge.depth, 1);
        assert_eq!(walked[1].edge.child_id, "sub-2");
        assert_eq!(walked[1].edge.depth, 2);

        // A resident child contributes no row but stays a walk root for
        // its own children; a resident parent keys parentActiveSessionId.
        let roots = vec![
            RosterWalkRoot {
                session_file: parent.clone(),
                active_session_id: None,
            },
            RosterWalkRoot {
                session_file: child.clone(),
                active_session_id: Some("act-1".into()),
            },
        ];
        let walked = walk_passive_rlm_children(&ledger, &roots).unwrap();
        assert_eq!(walked.len(), 1);
        assert_eq!(walked[0].edge.child_id, "sub-2");
        assert_eq!(walked[0].parent_active_session_id.as_deref(), Some("act-1"));

        // Saved children of the walk are not re-listed as passive rows.
        let roots = vec![
            RosterWalkRoot {
                session_file: parent.clone(),
                active_session_id: None,
            },
            RosterWalkRoot {
                session_file: child.clone(),
                active_session_id: None,
            },
        ];
        let walked = walk_passive_rlm_children(&ledger, &roots).unwrap();
        assert_eq!(walked.len(), 1);
        assert_eq!(walked[0].edge.child_id, "sub-2");
    }

    #[test]
    fn passive_rows_carry_the_subagent_identity() {
        let dir = temp_dir("rows");
        let sessions = dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let parent = sessions.join("p.jsonl");
        write_session(&parent, "p", 1);
        let child = dir.join("c.jsonl");
        write_session(&child, "c", 2);
        let ledger = RlmSpawnLedger::new(&dir, &sessions, |_| {});
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-7".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "worker".into(),
            })
            .unwrap();
        let walked = walk_passive_rlm_children(
            &ledger,
            &[RosterWalkRoot {
                session_file: parent.clone(),
                active_session_id: Some("act-9".into()),
            }],
        )
        .unwrap();
        assert_eq!(walked.len(), 1);
        let row = passive_child_summary(&walked[0]);
        assert_eq!(row["runtimeKind"], "subagent");
        assert_eq!(row["rlmChildId"], "sub-7");
        assert_eq!(row["rlmParentNodeId"], "sub-7");
        assert_eq!(
            row["parentSessionPath"].as_str(),
            Some(parent.canonicalize().unwrap().to_string_lossy().as_ref())
        );
        assert_eq!(row["parentActiveSessionId"], "act-9");
        assert_eq!(row["lifecycle"], "live");
        assert_eq!(row["activity"], "idle");
        assert_eq!(row["messageCount"], 2);
        let info = passive_child_info(&walked[0]);
        assert_eq!(info.rlm_depth, 1);
        assert!(info.parent_session_path.is_some());
    }
}

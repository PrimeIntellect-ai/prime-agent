//! The session-artifact trees: per-session artifact dirs (kernel-state
//! stubs, harness state, retired heartbeat jobs), the subagent session
//! files, and the ledger edges that make them roster-visible — all through
//! the product's own writers where they exist.

use std::path::{Path, PathBuf};

use pa_core::refinement::{
    HarnessEntry, HarnessRefinementEvent, HarnessScope, HarnessState, RefinementKind,
};
use pa_daemon::rlm_ledger::{RlmSpawnInput, RlmSpawnLedger};
use serde_json::json;

use crate::corpus::rows::SessionSpec;
use crate::rng::{iso_from_millis, Rng};

/// The subagent tree shape: fanout per level, total depth, and the row count
/// of each child session file, plus whether to populate artifact partitions.
pub(crate) struct SubagentTree {
    pub fanout: usize,
    pub max_depth: u32,
    pub child_rows: usize,
    pub artifacts: bool,
}

/// The worker-name bank for subagent ledger edges.
const WORKER_NAMES: [&str; 12] = [
    "worker",
    "helper",
    "scout",
    "reviewer",
    "implementer",
    "planner",
    "auditor",
    "fixer",
    "researcher",
    "summarizer",
    "verifier",
    "optimizer",
];

/// A valid empty-dict pickle payload (protocol 4): the kernel-state sidecar
/// stub unpickles cleanly to zero restored names.
const EMPTY_PICKLE: &[u8] = b"\x80\x04}\x94.";

/// Write one session's artifact partition: the kernel-state manifest and
/// payload, plus (per `rng`) a local harness store and a retired heartbeat.
///
/// # Errors
///
/// Propagates filesystem failures.
pub(crate) fn write_artifact_dir(
    dir: &Path,
    session_id: &str,
    seed_text: &str,
    rng: &mut Rng,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(
        dir.join("kernel-state.json"),
        json!({ "version": 1, "savedNames": [], "skipped": [] }).to_string(),
    )?;
    std::fs::write(dir.join("kernel-state.dill"), EMPTY_PICKLE)?;

    if rng.chance(30) {
        let harness_dir = dir.join("harness");
        std::fs::create_dir_all(&harness_dir)?;
        let entries = (1..=1 + rng.below(3))
            .map(|index| {
                (
                    format!("{seed_text}-memory-{index}"),
                    format!("corpus memory entry {index}: {}", seed_text),
                )
            })
            .collect::<Vec<_>>();
        let at = iso_from_millis(1_700_000_000_000 + rng.below(10_000_000));
        let state = HarnessState {
            schema: 1,
            entries: [(
                RefinementKind::Memory,
                entries
                    .iter()
                    .map(|(id, content)| {
                        (
                            id.clone(),
                            HarnessEntry {
                                id: id.clone(),
                                kind: RefinementKind::Memory,
                                title: format!("corpus memory {}", id),
                                content: content.clone(),
                                path: "general".to_string(),
                                scope: Some(HarnessScope::Local),
                                reference: serde_json::Map::new(),
                                arguments: serde_json::Map::new(),
                                metadata: serde_json::Map::new(),
                                source: "agent".to_string(),
                                created_at: at.clone(),
                                updated_at: at.clone(),
                                version: 1,
                            },
                        )
                    })
                    .collect(),
            )]
            .into_iter()
            .collect(),
            refinements: vec![HarnessRefinementEvent {
                id: format!("{seed_text}-event-1"),
                trigger: "test".to_string(),
                changes: vec![format!("create memory:{seed_text}-memory-1")],
                evidence: String::new(),
                outcome: String::new(),
                created_at: at,
            }],
        };
        std::fs::write(
            harness_dir.join("harness_state.json"),
            serde_json::to_string(&state)?,
        )?;
        std::fs::write(
            harness_dir.join("refinement_history.jsonl"),
            serde_json::to_string(&state.refinements[0])? + "\n",
        )?;
    }

    if rng.chance(10) {
        std::fs::write(
            dir.join("scheduled-jobs.json"),
            json!({
                "jobs": [{
                    "id": format!("{:08x}-b1c7-4f80-9d0e-be9ecdc78a65", rng.below(1 << 32)),
                    "status": "cancelled",
                    "source": "rlm_heartbeat",
                    "runtimeKind": "top-level",
                    "deliveryMode": "follow_up",
                    "activeSessionId": rng.next_u64().to_string(),
                    "sessionId": session_id,
                    "sessionFile": String::new(),
                    "cwd": "/tmp",
                    "label": WORKER_NAMES[rng.below(WORKER_NAMES.len() as u64) as usize],
                    "prompt": "retired corpus heartbeat",
                    "schedule": { "kind": "interval", "expression": "every 30m", "intervalMs": 1_800_000 },
                    "createdAt": iso_from_millis(1_700_000_000_000),
                    "updatedAt": iso_from_millis(1_700_010_000_000),
                    "runCount": 0,
                }]
            })
            .to_string(),
        )?;
    }
    Ok(())
}

/// One subagent tree node's spawn: the child session dir + file, its own
/// artifact partition, the ledger edge, and the recursion into grandchildren.
/// The child session file lives at
/// `<agent>/session-artifacts/<parent-session-id>/sub-<childId>/` (the
/// product's `rlm_child_session_dir` layout); grandchildren key on the
/// child's own session id at the artifact root.
///
/// # Errors
///
/// Propagates ledger and filesystem failures.
#[allow(clippy::too_many_arguments)] // one node carries the ledger, parent identity and tree-generation context
pub(crate) fn spawn_child(
    ledger: &RlmSpawnLedger,
    artifacts_root: &Path,
    parent_session_id: &str,
    parent_file: &Path,
    depth: u32,
    tree: &SubagentTree,
    cwd: &str,
    rng: &mut Rng,
) -> anyhow::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    if depth > tree.max_depth {
        return Ok(written);
    }
    for _ in 0..tree.fanout {
        let child_tag = format!("sub-{:07x}", rng.below(1 << 28));
        let child_dir = artifacts_root.join(parent_session_id).join(&child_tag);
        std::fs::create_dir_all(&child_dir)?;
        let child_start = 1_700_000_000_000 + rng.below(90_000_000_000);
        let child_session_id = crate::corpus::rows::session_id(rng, child_start);
        let child_file = child_dir.join(format!("{child_session_id}.jsonl"));
        crate::corpus::rows::write_session_file(
            &child_file,
            &SessionSpec {
                id: child_session_id.clone(),
                start_ms: child_start,
                cwd: cwd.to_string(),
                rows: tree.child_rows,
                name: None,
                marker: None,
                parent_session: Some(parent_file.display().to_string()),
                rlm_depth: None,
                ordinals: false,
            },
            rng,
        )?;
        crate::corpus::set_mtime(&child_file, child_start + 10_000)?;
        // The child's OWN artifact partition sits under the parent's tree.
        if tree.artifacts {
            write_artifact_dir(
                &artifacts_root
                    .join(parent_session_id)
                    .join("session-artifacts")
                    .join(&child_session_id),
                &child_session_id,
                &child_session_id,
                rng,
            )?;
        }
        ledger.append_spawn(&RlmSpawnInput {
            child_id: child_tag.clone(),
            parent: parent_file.display().to_string(),
            child: child_file.display().to_string(),
            depth,
            name: WORKER_NAMES[rng.below(WORKER_NAMES.len() as u64) as usize].to_string(),
        })?;
        written.push(child_file.clone());
        if depth < tree.max_depth {
            written.extend(spawn_child(
                ledger,
                artifacts_root,
                &child_session_id,
                &child_file,
                depth + 1,
                tree,
                cwd,
                rng,
            )?);
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    #[test]
    fn generated_kernel_snapshot_unpickles_to_an_empty_dictionary() {
        let directory = tempfile::tempdir().expect("artifact directory");
        super::write_artifact_dir(
            directory.path(),
            "session",
            "seed",
            &mut crate::rng::Rng::new(7),
        )
        .expect("write real artifact partition");
        let output = std::process::Command::new("python3")
            .arg("-c")
            .arg("import pickle,sys; value=pickle.load(open(sys.argv[1],'rb')); assert type(value) is dict and not value")
            .arg(directory.path().join("kernel-state.dill"))
            .output()
            .expect("run hosted Python pickle reader");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

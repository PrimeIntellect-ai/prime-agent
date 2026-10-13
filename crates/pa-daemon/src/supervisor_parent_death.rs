//! Supervisor-side parent-death cleanup for RLM children: TS hosts them in the
//! parent's process (they die with it, even SIGKILL); the Rust redesign hosts each
//! child as its own worker, so the worker-death monitor closes them instead — a plain
//! kill (spawn edge and passive row survive; grandchildren ride the child's handler).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::backpressure::RouteAdmission;
use crate::registry::ResidentWorker;
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS};
use pa_types::daemon::DaemonWorkerDescriptor;

/// Retries for a child that could not be closed at death time (the kill route can
/// arrive before the worker's socket exists).
const CHILD_CLOSE_RETRY_ATTEMPTS: u32 = 3;
/// Space between the close retries: long enough for a starting child to
/// finish connecting, short enough to bound the orphan window.
const CHILD_CLOSE_RETRY_DELAY_MS: u64 = 5_000;

impl Supervisor {
    /// Close the resident RLM children of a worker that died without a teardown,
    /// before the crash recovery, so a relaunched parent never resumes beside an
    /// orphaned child. Best-effort: the close never blocks the restart.
    pub(crate) async fn close_children_of_dead_parent(
        self: &Arc<Self>,
        parent: &Arc<ResidentWorker>,
    ) {
        let children = self.resident_children_of(parent).await;
        if children.is_empty() {
            return;
        }
        self.log_line(&format!(
            "session worker {} died with {} resident RLM child(ren); closing them with the parent",
            parent.worker_id,
            children.len()
        ));
        let mut closed = 0usize;
        let mut unclosed: Vec<Arc<ResidentWorker>> = Vec::new();
        for child in children {
            if self.close_dead_child(&child).await {
                closed += 1;
            } else {
                unclosed.push(child);
            }
        }
        self.note_children_closed(closed);
        if !unclosed.is_empty() {
            let supervisor = Arc::clone(self);
            tokio::spawn(async move {
                supervisor.retry_close_children(unclosed).await;
            });
        }
    }

    /// Bounded retries for children the death close could not reach: never a fresh
    /// registry join (the respawned parent shares the dead worker's id, so a re-join
    /// could catch its legitimate children).
    async fn retry_close_children(self: Arc<Self>, children: Vec<Arc<ResidentWorker>>) {
        let mut unclosed = children;
        for _ in 0..CHILD_CLOSE_RETRY_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(CHILD_CLOSE_RETRY_DELAY_MS)).await;
            if self.is_shutting_down() {
                return;
            }
            let mut still_open = Vec::new();
            let mut closed = 0usize;
            for child in unclosed {
                if self.close_dead_child(&child).await {
                    closed += 1;
                } else {
                    still_open.push(child);
                }
            }
            self.note_children_closed(closed);
            unclosed = still_open;
            if unclosed.is_empty() {
                return;
            }
        }
        for child in &unclosed {
            self.log_line(&format!(
                "RLM child worker {} outlived its dead parent and could not be closed",
                child.worker_id
            ));
        }
    }

    /// Close one child of a dead parent: the same plain-kill route the worker-side
    /// close drives, plus the supervisor-side completion: registry + roster drop,
    /// ledger reseed (the passive row appears). The child keeps its resume entry - no
    /// job cancel, no `archived` state - exactly like TS. `false` means still resident.
    async fn close_dead_child(self: &Arc<Self>, child: &Arc<ResidentWorker>) -> bool {
        match self
            .route_command_typed(
                child,
                "kill",
                json!({ "rlmCloseReason": "shutdown" }),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        {
            Ok(response) if response.success => {
                // The kill is already routed, so the child dies regardless of the
                // tombstone's durability: the exit must read as intentional BEFORE the
                // cleanup, or a failed tombstone persist would look like a crash — the
                // monitor would relaunch the orphan.
                child
                    .intentional_stop
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                if let Err(error) = self.stop_worker(child).await {
                    self.log_line(&format!(
                        "parent-death stop of RLM child worker {} failed: {error:#}; the routed kill owns the rest",
                        child.worker_id
                    ));
                }
                true
            }
            Ok(response) => {
                self.log_line(&format!(
                    "parent-death close of RLM child worker {} failed: {}",
                    child.worker_id,
                    response
                        .error
                        .unwrap_or_else(|| "worker refused the close".to_string())
                ));
                false
            }
            Err(error) => {
                self.log_line(&format!(
                    "parent-death close of RLM child worker {} failed: {error:#}",
                    child.worker_id
                ));
                false
            }
        }
    }

    /// The resident workers whose durable create names the dead worker as their RLM
    /// parent. The join is the metadata's `parentActiveSessionId` alone: a resumed or
    /// forked copy of the parent's session must never adopt another worker's children.
    async fn resident_children_of(&self, parent: &Arc<ResidentWorker>) -> Vec<Arc<ResidentWorker>> {
        let parent_id = {
            let descriptor = parent.descriptor.lock().await;
            descriptor.root_active_session_id.clone()
        };
        let mut children = Vec::new();
        for resident in self.registry.list().await {
            if resident.worker_id == parent.worker_id {
                continue;
            }
            let descriptor = resident.descriptor.lock().await;
            if child_names_parent(&descriptor, &parent_id) {
                drop(descriptor);
                children.push(resident);
            }
        }
        children
    }
}

/// Whether one resident's durable create names `parent_id` as its RLM parent. Top-level
/// and depth-0 roots never match.
fn child_names_parent(descriptor: &DaemonWorkerDescriptor, parent_id: &str) -> bool {
    descriptor
        .create_command
        .rest
        .get("runtimeMetadata")
        .and_then(|metadata| metadata.get("parentActiveSessionId"))
        .and_then(Value::as_str)
        .is_some_and(|candidate| candidate == parent_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One durable descriptor from a JSON literal (the same fields the
    /// supervisor persists at launch).
    fn descriptor(runtime_metadata: Option<Value>) -> DaemonWorkerDescriptor {
        // The durable create command flattens its `rest` map, so the runtime metadata
        // sits directly under `createCommand`.
        let mut create_command = json!({
            "sessionPath": "/tmp/child.jsonl",
            "noSession": false,
            "cwd": "/work",
        });
        if let Some(metadata) = runtime_metadata {
            create_command["runtimeMetadata"] = metadata;
        }
        serde_json::from_value(json!({
            "version": 2,
            "workerId": "w-child",
            "pid": 42,
            "socketPath": "/tmp/w.sock",
            "recoveryJournalPath": "/tmp/w.recovery.jsonl",
            "supervisorSocketPath": "/tmp/s.sock",
            "authenticationToken": "token",
            "rootActiveSessionId": "child-root",
            "createdAt": "t",
            "updatedAt": "t",
            "lifecycle": "starting",
            "consecutiveFailures": 0,
            "createCommand": create_command,
        }))
        .expect("descriptor json")
    }

    #[test]
    fn a_subagent_names_its_parent_by_active_session_id() {
        let metadata = json!({
            "kind": "subagent",
            "rlmChildId": "sub-1",
            "parentActiveSessionId": "parent-root",
            "rlmDepth": 1,
        });
        let child = descriptor(Some(metadata));
        assert!(child_names_parent(&child, "parent-root"));
        assert!(!child_names_parent(&child, "another-root"));
    }

    #[test]
    fn a_top_level_session_never_matches_a_parent() {
        // No runtime metadata: a plain top-level session create.
        assert!(!child_names_parent(&descriptor(None), "parent-root"));
        // A depth-0 `rlm.create_session` root carries metadata with no
        // parent link.
        let root = descriptor(Some(json!({ "kind": "root" })));
        assert!(!child_names_parent(&root, "parent-root"));
    }
}

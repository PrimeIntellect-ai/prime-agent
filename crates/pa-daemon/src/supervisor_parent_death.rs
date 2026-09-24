//! Supervisor-side parent-death cleanup for RLM children: the seam that
//! closes a hard-killed parent worker's resident children (the #246
//! adjacent gap).
//!
//! TS ground truth (`modes/daemon/daemon-mode.ts`): RLM children are hosted
//! in the parent's process, so they die with it - any death of the parent,
//! including SIGKILL, takes its children down, and the durable spawn ledger
//! keeps their roster rows as passive family rows. The Rust redesign hosts
//! each child as its own supervisor-owned worker process, and the #246
//! close runs inside the parent worker (the replacement/kill/shutdown
//! teardowns), so a SIGKILL bypasses every close path and the children
//! would survive their parent as orphaned workers. The supervisor's
//! worker-death monitoring is the only component that observes the death,
//! so the close ports there: on an unexpected exit, every resident worker
//! whose durable create names the dead worker as its parent (the runtime
//! metadata's `parentActiveSessionId`, the same join TS
//! `getChildActiveSessionStates` runs) stops with its parent - the same
//! wire action the #246 `SupervisorChildSessions::close_children` issues
//! per child (a `kill` with no `rlmLedgerDelete` marker: a plain stop, so
//! the spawn edge and the passive roster row survive, and the child
//! worker's own kill handler closes the child's children first - the
//! grandchild cascade is the kill route's recursion, TS
//! `closeSessionOnce`'s cascade).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::registry::ResidentWorker;
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS};
use pa_types::daemon::DaemonWorkerDescriptor;

/// Retries for a child that could not be closed at death time (a child
/// worker may still be starting: the supervisor registers a resident
/// before its worker process connects, so the kill route can arrive
/// before the socket exists).
const CHILD_CLOSE_RETRY_ATTEMPTS: u32 = 3;
/// Space between the close retries: long enough for a starting child to
/// finish connecting, short enough to bound the orphan window.
const CHILD_CLOSE_RETRY_DELAY_MS: u64 = 5_000;

impl Supervisor {
    /// Close the resident RLM children of a worker whose process died
    /// without a teardown (the SIGKILL class: none of the #246 worker-side
    /// close paths ran). Runs once per unexpected exit, before the crash
    /// recovery, so a relaunched parent never resumes beside an orphaned
    /// child worker. Best-effort, like the TS daemon kill handler's
    /// swallowed close error: a child that cannot be closed yet is handed
    /// to a bounded retry walk (never a fresh join - the respawned parent
    /// keeps the dead worker's active session id, so only the residents
    /// captured here belong to the dead instance), and the close never
    /// blocks the restart that follows.
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

    /// Bounded retries for children the death close could not reach: the
    /// same per-child close, never a fresh registry join (the respawned
    /// parent shares the dead worker's active session id, so a re-join
    /// could catch its legitimately spawned children). Gives up loudly
    /// when a child stays unreachable - its durable parent link keeps it
    /// joinable for an explicit kill.
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

    /// Close one child of a dead parent: the same kill route the #246
    /// `close_children` drives per child (a plain stop - the child
    /// worker's kill handler aborts its in-flight turn and closes its own
    /// children first, so the cascade to grandchildren rides the
    /// recursion) plus the supervisor-side completion of a kill (the
    /// steps the client kill route runs after the worker answers): drop
    /// the worker from the registry and the live roster, then reseed the
    /// ledger so the closed child's passive row appears. `false` means the
    /// child is still resident (a later retry owns it).
    ///
    /// The close carries the `shutdown` reason marker: the parent died,
    /// the child did not (TS's in-process child dies with the parent
    /// worker without a close; the Rust worker must be told). The child
    /// keeps its resume entry — no job cancel, no `archived` state — so
    /// its passive row and its scheduled jobs survive the orphaning,
    /// exactly like TS (the wake model owns reviving it later).
    async fn close_dead_child(self: &Arc<Self>, child: &Arc<ResidentWorker>) -> bool {
        match self
            .route_command(
                child,
                "kill",
                json!({ "rlmCloseReason": "shutdown" }),
                ROUTE_TIMEOUT_MS,
            )
            .await
        {
            Ok(response) if response.success => {
                self.stop_worker(child).await;
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

    /// The resident workers whose durable create names the dead worker as
    /// their RLM parent. The join is the runtime metadata's
    /// `parentActiveSessionId` alone (TS
    /// `getChildActiveSessionStates`): a depth-0 `rlm.create_session`
    /// root carries no parent link and never matches, and a resumed or
    /// forked copy of the parent's session file under another worker
    /// must never adopt another worker's children. The dead parent
    /// itself never matches.
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

/// Whether one resident's durable create names `parent_id` as its RLM
/// parent: the supervisor-side copy of the TS create `runtimeMetadata`
/// (`parentActiveSessionId`, the field `getChildActiveSessionStates`
/// joins on). A top-level session and a depth-0 `rlm.create_session`
/// root carry no `parentActiveSessionId` and never match.
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
        // The durable create command flattens its `rest` map, so the
        // runtime metadata sits directly under `createCommand` - the same
        // shape the supervisor persists at launch.
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

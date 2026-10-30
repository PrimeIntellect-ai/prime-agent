//! The per-session shells and factory-run counts behind the agents-view activity lines.
use super::{AgentsViewMode, DaemonClient, DaemonCommand, SessionActivity};
use crate::bash_view::ShellCounts;
use anyhow::Result;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

/// One session's counts from one cycle: `None` is a failed read, which keeps that session's last
/// count.
pub(super) struct ActivityRead {
    pub(super) active_session_id: String,
    pub(super) shells: Option<ShellCounts>,
    pub(super) factory_runs: Option<crate::factory_view::FactoryRunCounts>,
}

/// One fetch cycle over the live sessions, off the key loop: each session's kernel answers its
/// own shells list and factory graph; the cycle lands once every session answered.
pub(super) fn spawn_session_activity_fetch(
    client: &DaemonClient,
    sessions: Vec<String>,
) -> oneshot::Receiver<Vec<ActivityRead>> {
    let shells_supported = client.supports_server_capability("kernel_bash_activity");
    let factory_supported = client.supports_server_capability("factory_activity");
    let client = client.clone();
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let mut reads = tokio::task::JoinSet::new();
        for active_session_id in sessions {
            let client = client.clone();
            reads.spawn(async move {
                let shells = async {
                    if !shells_supported {
                        return Some(ShellCounts::default());
                    }
                    let reply = client
                        .request_ok(DaemonCommand::ListKernelBash {
                            id: None,
                            active_session_id: active_session_id.clone(),
                            rest: Map::default(),
                        })
                        .await;
                    count(reply, |data| {
                        Some(crate::bash_view::running_shell_counts(data))
                    })
                };
                let factory_runs = async {
                    if !factory_supported {
                        return Some(crate::factory_view::FactoryRunCounts::default());
                    }
                    let reply = client
                        .request_ok(DaemonCommand::FactoryActivity {
                            id: None,
                            active_session_id: active_session_id.clone(),
                            action: "graph".to_string(),
                            run_id: None,
                            spec_id: None,
                            timeout_ms: None,
                            rest: Map::default(),
                        })
                        .await;
                    count(reply, |data| {
                        crate::factory_view::factory_reply_lists_runs(data).then(|| {
                            crate::factory_view::FactoryRunCounts::of(
                                &crate::factory_view::parse_factory_runs(data),
                            )
                        })
                    })
                };
                let (shells, factory_runs) = tokio::join!(shells, factory_runs);
                ActivityRead {
                    active_session_id,
                    shells,
                    factory_runs,
                }
            });
        }
        let reads = reads.join_all().await;
        let _ = tx.send(reads);
    });
    rx
}

/// The daemon's no-kernel refusal reads as zero, not a failed read.
fn count<T: Default>(reply: Result<Value>, count: impl Fn(&Value) -> Option<T>) -> Option<T> {
    match reply {
        Ok(data) => count(&data),
        Err(error) if crate::daemon_client::is_kernel_not_running(&error) => Some(T::default()),
        Err(_) => None,
    }
}

impl AgentsViewMode {
    /// The roster's live sessions a fetch cycle asks: saved rows have no kernel.
    pub(super) fn live_session_ids(&self) -> Vec<String> {
        self.roster
            .iter()
            .filter_map(|entry| entry.get("summary")?.get("activeSessionId")?.as_str())
            .filter(|active| !active.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// Fold one cycle into the counts (a failed read keeps that session's last count) and
    /// rebuild only when a count moved.
    pub(super) fn apply_session_activity(&mut self, reads: Vec<ActivityRead>) {
        let live = reads
            .into_iter()
            .map(|read| {
                let last = self
                    .session_activity
                    .live
                    .get(&read.active_session_id)
                    .copied()
                    .unwrap_or_default();
                let counts = SessionActivity {
                    shells: read.shells.unwrap_or(last.shells),
                    factory_runs: read.factory_runs.unwrap_or(last.factory_runs),
                };
                (read.active_session_id, counts)
            })
            .collect();
        if live != self.session_activity.live {
            self.session_activity.live = live;
            self.rebuild_rows();
        }
    }
}

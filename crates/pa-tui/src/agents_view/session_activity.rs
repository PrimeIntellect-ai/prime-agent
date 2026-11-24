//! The per-session shells and factory counts behind the agents-view activity lines.
use super::{AgentsViewMode, DaemonClient, DaemonCommand, SessionActivity};
use crate::bash_view::ShellCounts;
use crate::factory_view::FactoryCounts;
use anyhow::Result;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

/// One session's counts from one cycle: `None` is a failed read, which keeps that session's last
/// count.
pub(super) struct ActivityRead {
    pub(super) active_session_id: String,
    pub(super) shells: Option<ShellCounts>,
    pub(super) factory: Option<FactoryCounts>,
    /// The machine children this session's runs spawned (the M1 marker's
    /// source): each spawned child's rlm child id with its run and state
    /// label, bounded by `MACHINE_CHILDREN_CAP`. `None` is a failed graph read, which keeps the
    /// session's last markers like its factory count.
    pub(super) machine_children: Option<Vec<(String, String)>>,
}

/// One machine child's marker: the session whose run spawned it and its `<run>/<state>` label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MachineMarker {
    pub(super) session: String,
    pub(super) label: String,
}

/// The per-session machine-children bound (Appendix B's proposal).
pub(super) const MACHINE_CHILDREN_CAP: usize = 512;

/// The machine children one graph reply carries: every node's instances'
/// child ids with `<run>/<state>` labels (the marker and the note line's
/// vocabulary).
fn machine_children(data: &Value) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    let Some(runs) = data.get("runs").and_then(Value::as_array) else {
        return rows;
    };
    for run in runs {
        let name = run
            .get("name")
            .or_else(|| run.get("specId"))
            .and_then(Value::as_str)
            .unwrap_or("run");
        let Some(nodes) = run.get("nodes").and_then(Value::as_array) else {
            continue;
        };
        for node in nodes {
            let state = node.get("id").and_then(Value::as_str).unwrap_or("");
            let Some(instances) = node.get("instances").and_then(Value::as_array) else {
                continue;
            };
            for instance in instances {
                let Some(child) = instance.get("child").and_then(Value::as_str) else {
                    continue;
                };
                if child.is_empty() || rows.len() >= MACHINE_CHILDREN_CAP {
                    continue;
                }
                rows.push((child.to_string(), format!("{name}/{state}")));
            }
        }
    }
    rows
}

/// One fetch cycle over the live sessions, off the key loop: each session's kernel answers its
/// own shells list and factory graph (its stored specs and live runs); the cycle lands once every
/// session answered.
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
                let factory = async {
                    if !factory_supported {
                        return (Some(FactoryCounts::default()), Some(Vec::new()));
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
                    // One reply feeds both reads: the counts fold and the
                    // machine-children markers (the M1 chip's source).
                    match reply {
                        Ok(data) if crate::factory_view::factory_reply_lists_runs(&data) => {
                            let children = machine_children(&data);
                            (Some(FactoryCounts::of(&data)), Some(children))
                        }
                        Err(error) if crate::daemon_client::is_kernel_not_running(&error) => {
                            (Some(FactoryCounts::default()), Some(Vec::new()))
                        }
                        Ok(_) | Err(_) => (None, None),
                    }
                };
                let (shells, (factory, machine_children)) = tokio::join!(shells, factory);
                ActivityRead {
                    active_session_id,
                    shells,
                    factory,
                    machine_children,
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

    /// Fold one cycle into the counts and markers (a failed read keeps that session's last count
    /// and markers) and rebuild only when one moved.
    pub(super) fn apply_session_activity(&mut self, reads: Vec<ActivityRead>) {
        let mut machine_children = std::collections::HashMap::new();
        let live = reads
            .into_iter()
            .map(|read| {
                match &read.machine_children {
                    Some(children) => {
                        for (child, label) in children {
                            let marker = MachineMarker {
                                session: read.active_session_id.clone(),
                                label: label.clone(),
                            };
                            machine_children.insert(child.clone(), marker);
                        }
                    }
                    None => {
                        for (child, marker) in &self.machine_children {
                            if marker.session == read.active_session_id {
                                machine_children.insert(child.clone(), marker.clone());
                            }
                        }
                    }
                }
                let last = self
                    .session_activity
                    .live
                    .get(&read.active_session_id)
                    .copied()
                    .unwrap_or_default();
                let counts = SessionActivity {
                    shells: read.shells.unwrap_or(last.shells),
                    factory: read.factory.unwrap_or(last.factory),
                };
                (read.active_session_id, counts)
            })
            .collect();
        let children_changed = machine_children != self.machine_children;
        self.machine_children = machine_children;
        if live != self.session_activity.live || children_changed {
            self.session_activity.live = live;
            self.rebuild_rows();
        }
    }
}

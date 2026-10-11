//! Request relationships using nano-rlm's semantic-edges-v1 vocabulary.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{CompactionStatus, SemanticEdgeLedgerEvent};

/// A causal relationship between two intercepted model requests.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SemanticEdge {
    pub source_request_id: String,
    pub target_request_id: String,
    #[serde(rename = "type")]
    pub kind: SemanticEdgeKind,
}

/// The labels published by nano-rlm's semantic tracker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticEdgeKind {
    Continuation,
    SubagentCall,
    SubagentReturn,
    SubagentFailed,
    SubagentCancel,
    AgentMessage,
    CompactionAttempt,
    Compaction,
}

/// The cumulative payload under `ai.prime.acp/semantic-edges-v1`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticEdgeSnapshot {
    pub edges: Vec<SemanticEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingEdge {
    source: String,
    kind: SemanticEdgeKind,
}

#[derive(Debug, Clone)]
struct Request {
    inbound: Vec<PendingEdge>,
    compaction_id: Option<String>,
}

#[derive(Debug, Clone)]
struct Compaction {
    source: Option<String>,
    pending: Vec<PendingEdge>,
    summaries: Vec<String>,
}

/// One session's fold; child ledgers contain their own continuation points.
#[derive(Debug, Clone, Default)]
pub(super) struct Graph {
    last_request: Option<String>,
    spawn_source: Option<String>,
    spawn_claimed: bool,
    pending: Vec<PendingEdge>,
    requests: BTreeMap<String, Request>,
    compactions: BTreeMap<String, Compaction>,
    returned: BTreeMap<String, String>,
    cancelled: BTreeSet<String>,
    pub(super) children: BTreeSet<PathBuf>,
    pub(super) edges: Vec<SemanticEdge>,
}

impl Graph {
    pub(super) fn apply(&mut self, event: &SemanticEdgeLedgerEvent) {
        match event {
            SemanticEdgeLedgerEvent::SessionRegistered {
                spawned_by_request_id,
                ..
            } => {
                self.spawn_source.clone_from(spawned_by_request_id);
            }
            SemanticEdgeLedgerEvent::RequestStarted {
                request_id,
                compaction_id,
                ..
            } => {
                // The ledger may repeat an in-flight id for an identical wire body.
                // Its dependencies were already claimed by the first start.
                if self.requests.contains_key(request_id) {
                    return;
                }
                let mut inbound = if let Some(id) = compaction_id {
                    let Some(compaction) = self.compactions.get(id) else {
                        return;
                    };
                    let mut edges = Vec::new();
                    if let Some(source) = &compaction.source {
                        edges.push(PendingEdge {
                            source: source.clone(),
                            kind: SemanticEdgeKind::CompactionAttempt,
                        });
                    }
                    edges.extend(
                        compaction
                            .pending
                            .iter()
                            .filter(|edge| Some(&edge.source) != compaction.source.as_ref())
                            .cloned(),
                    );
                    edges
                } else {
                    let mut edges = std::mem::take(&mut self.pending);
                    if let Some(source) = self.spawn_source.as_ref().filter(|_| !self.spawn_claimed)
                    {
                        edges.push(PendingEdge {
                            source: source.clone(),
                            kind: SemanticEdgeKind::SubagentCall,
                        });
                        self.spawn_claimed = true;
                    }
                    if let Some(source) = self
                        .last_request
                        .as_ref()
                        .filter(|source| !edges.iter().any(|edge| &edge.source == *source))
                    {
                        edges.push(PendingEdge {
                            source: source.clone(),
                            kind: SemanticEdgeKind::Continuation,
                        });
                    }
                    edges
                };
                let mut unique = Vec::new();
                for edge in inbound.drain(..) {
                    if !unique.contains(&edge) {
                        unique.push(edge);
                    }
                }
                self.requests.insert(
                    request_id.clone(),
                    Request {
                        inbound: unique,
                        compaction_id: compaction_id.clone(),
                    },
                );
            }
            SemanticEdgeLedgerEvent::RequestFinished { request_id } => {
                let Some(request) = self.requests.remove(request_id) else {
                    return;
                };
                for edge in request.inbound {
                    self.push_edge(edge.source, request_id.clone(), edge.kind);
                }
                if let Some(id) = request.compaction_id {
                    if let Some(compaction) = self.compactions.get_mut(&id) {
                        compaction.summaries.push(request_id.clone());
                    }
                } else {
                    self.last_request = Some(request_id.clone());
                }
            }
            SemanticEdgeLedgerEvent::RequestFailed { request_id } => {
                if let Some(request) = self
                    .requests
                    .remove(request_id)
                    .filter(|request| request.compaction_id.is_none())
                {
                    let mut pending = request.inbound;
                    pending.append(&mut self.pending);
                    self.pending = pending;
                }
            }
            SemanticEdgeLedgerEvent::CompactionBegun { compaction_id, .. } => {
                self.compactions.insert(
                    compaction_id.clone(),
                    Compaction {
                        source: self.last_request.clone(),
                        pending: self.pending.clone(),
                        summaries: Vec::new(),
                    },
                );
            }
            SemanticEdgeLedgerEvent::CompactionFinished {
                compaction_id,
                status,
            } => {
                if let Some(compaction) =
                    self.compactions.remove(compaction_id).filter(|compaction| {
                        *status == CompactionStatus::Completed && !compaction.summaries.is_empty()
                    })
                {
                    // Every accepted split summary contributes to the resumed context.
                    self.pending
                        .retain(|edge| !compaction.pending.contains(edge));
                    self.last_request = compaction.summaries.last().cloned();
                    for source in compaction.summaries {
                        self.receive(source, SemanticEdgeKind::Compaction);
                    }
                }
            }
            SemanticEdgeLedgerEvent::DependencyReceived { request_id, kind } => {
                self.receive(request_id.clone(), *kind);
            }
            SemanticEdgeLedgerEvent::ChildResultCollected {
                child_session_id,
                request_id,
                failed,
            } => {
                if self.returned.get(child_session_id) != Some(request_id) {
                    self.returned
                        .insert(child_session_id.clone(), request_id.clone());
                    self.receive(
                        request_id.clone(),
                        if *failed {
                            SemanticEdgeKind::SubagentFailed
                        } else {
                            SemanticEdgeKind::SubagentReturn
                        },
                    );
                }
            }
            SemanticEdgeLedgerEvent::ChildCancelled {
                child_session_id,
                source_request_id,
                target_request_id,
            } => {
                if self.cancelled.insert(child_session_id.clone()) {
                    self.push_edge(
                        source_request_id.clone(),
                        target_request_id.clone(),
                        SemanticEdgeKind::SubagentCancel,
                    );
                }
            }
            SemanticEdgeLedgerEvent::ChildRegistered { ledger_path } => {
                self.children.insert(ledger_path.clone());
            }
            // Settlement alone does not mean the parent consumed the result.
            SemanticEdgeLedgerEvent::ChildReturned { .. } | SemanticEdgeLedgerEvent::Unknown => {}
        }
    }

    fn receive(&mut self, source: String, kind: SemanticEdgeKind) {
        let edge = PendingEdge { source, kind };
        if !self.pending.contains(&edge) {
            self.pending.push(edge);
        }
    }

    fn push_edge(
        &mut self,
        source_request_id: String,
        target_request_id: String,
        kind: SemanticEdgeKind,
    ) {
        let edge = SemanticEdge {
            source_request_id,
            target_request_id,
            kind,
        };
        self.edges.push(edge);
    }
}

/// Read a session and all child ledgers registered by its recorder.
///
/// # Errors
/// Returns an I/O or ledger parse error instead of publishing an incomplete graph.
pub fn read_semantic_edges(path: &Path) -> std::io::Result<SemanticEdgeSnapshot> {
    let mut graph = Graph::default();
    for event in super::ledger::read_events(path)?.unwrap_or_default() {
        graph.apply(&event);
    }
    snapshot_family(graph.edges, graph.children)
}

/// The continuation point after successful turns and installed compactions.
/// Successful summaries from failed compactions do not replace this request.
///
/// # Errors
/// Returns an I/O or ledger parse error.
pub fn read_semantic_request_id(path: &Path) -> std::io::Result<Option<String>> {
    let mut graph = Graph::default();
    for event in super::ledger::read_events(path)?.unwrap_or_default() {
        graph.apply(&event);
    }
    Ok(graph.last_request)
}

pub(super) fn snapshot_family(
    mut edges: Vec<SemanticEdge>,
    children: BTreeSet<PathBuf>,
) -> std::io::Result<SemanticEdgeSnapshot> {
    let mut pending: Vec<_> = children.into_iter().collect();
    while let Some(path) = pending.pop() {
        let mut graph = Graph::default();
        for event in super::ledger::read_events(&path)?.unwrap_or_default() {
            graph.apply(&event);
        }
        edges.extend(graph.edges);
        pending.extend(graph.children);
    }
    Ok(SemanticEdgeSnapshot { edges })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_snapshot_matches_nano_rlm_semantics() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../testdata/nano-semantic-edges-v1.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let mut sessions: BTreeMap<String, Graph> = BTreeMap::new();
            for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
                let event = serde_json::from_value(step["event"].clone()).unwrap();
                sessions
                    .entry(step["session"].as_str().unwrap().to_string())
                    .or_default()
                    .apply(&event);
                let mut actual = SemanticEdgeSnapshot {
                    edges: sessions
                        .values()
                        .flat_map(|graph| graph.edges.clone())
                        .collect(),
                };
                let mut expected: SemanticEdgeSnapshot =
                    serde_json::from_value(step["expected"].clone()).unwrap();
                actual.edges.sort();
                expected.edges.sort();
                assert_eq!(actual, expected, "{} step {index}", case["name"]);
            }
        }
    }

    #[test]
    fn durable_family_replay_matches_nano_snapshots() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../testdata/nano-semantic-edges-v1.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("root.jsonl");
            let mut children = BTreeSet::new();
            for step in case["steps"].as_array().unwrap() {
                let session = step["session"].as_str().unwrap();
                let path = dir.path().join(format!("{session}.jsonl"));
                if session != "root" && children.insert(session) {
                    super::super::ledger::append_event(
                        &root,
                        &SemanticEdgeLedgerEvent::ChildRegistered {
                            ledger_path: path.clone(),
                        },
                    )
                    .unwrap();
                }
                let event = serde_json::from_value(step["event"].clone()).unwrap();
                super::super::ledger::append_event(&path, &event).unwrap();
                let mut actual = read_semantic_edges(&root).unwrap();
                let mut expected: SemanticEdgeSnapshot =
                    serde_json::from_value(step["expected"].clone()).unwrap();
                actual.edges.sort();
                expected.edges.sort();
                assert_eq!(actual, expected, "{}", case["name"]);
            }
        }
    }
}

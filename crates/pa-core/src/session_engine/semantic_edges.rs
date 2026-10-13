//! The ACP semantic-edge ledger (TS `semantic-edges.ts`, the WRITER only):
//! a durable per-session append-only log of model-request events, plus the
//! ids that thread them onto the wire and through child spawns.
//!
//! Ledger events are written before the effects they describe (ledger
//! before wire, a child's return before the notice that triggers the
//! parent's next turn). Provenance is best-effort: the first ledger
//! failure permanently disables the recorder with one warning, and
//! callers stop emitting request ids on the wire rather than weakening
//! that invariant. Edge semantics (the pure fold over one or more
//! ledgers) stay in TS: nothing in the Rust product reads or derives
//! edges yet, so the fold is not ported.
//!
//! The ledger is a SEPARATE owner from the spawn ledger (`rlm_ledger.rs`):
//! topology (spawn/delete records) and request semantics (this ledger)
//! share no records or ids. `ledger.rs` owns the on-disk tail rule,
//! `stream.rs` the stream wrapper, `compaction.rs` the compaction guard,
//! and the tests live in `semantic_edges/tests.rs`.

mod compaction;
mod ledger;
mod stream;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

pub(crate) use compaction::{summary_slice_call, SemanticCompaction};
pub(crate) use stream::wrap_stream_fn;

/// The outbound request-id header (TS `MODEL_REQUEST_ID_HEADER`).
pub const MODEL_REQUEST_ID_HEADER: &str = "X-ACP-Model-Request-ID";
/// The idempotency header carrying the same id (TS `IDEMPOTENCY_KEY_HEADER`).
pub const IDEMPOTENCY_KEY_HEADER: &str = "Idempotency-Key";
/// The ledger's file name inside its owning directory (TS
/// `SEMANTIC_EDGES_LEDGER_FILENAME`).
pub const SEMANTIC_EDGES_LEDGER_FILENAME: &str = "semantic-edges.jsonl";

/// How a compaction settled (TS `CompactionStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionStatus {
    Completed,
    Failed,
    Cancelled,
}

/// One ledger line. Field order matches the TS object literals so the
/// serialized bytes are identical (`JSON.stringify` insertion order).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SemanticEdgeLedgerEvent {
    SessionRegistered {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        spawned_by_request_id: Option<String>,
    },
    RequestStarted {
        request_id: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        compaction_id: Option<String>,
    },
    RequestFinished {
        request_id: String,
    },
    RequestFailed {
        request_id: String,
    },
    CompactionBegun {
        compaction_id: String,
        session_id: String,
    },
    CompactionFinished {
        compaction_id: String,
        status: CompactionStatus,
    },
    ChildReturned {
        session_id: String,
        child_session_id: String,
        request_id: String,
    },
    /// An event a newer writer appended (TS `JSON.parse` accepts any line
    /// and the replay ignores unknown types): forward-compatible resume.
    #[serde(other)]
    Unknown,
}

/// The one derivation of where a session's ledger lives (TS
/// `semanticEdgeLedgerPath`, "recorder and outbox must agree"): the RLM
/// session dir when the session is a spawned child, else the session
/// artifact dir. `None` keeps the recorder in memory-only mode (ids are
/// still minted and sent, events are not).
#[must_use]
pub fn semantic_edge_ledger_path(
    rlm_session_dir: Option<&Path>,
    session_artifact_dir: Option<&Path>,
) -> Option<PathBuf> {
    rlm_session_dir
        .or(session_artifact_dir)
        .map(|dir| dir.join(SEMANTIC_EDGES_LEDGER_FILENAME))
}

/// One session's ledger identity: the durable session id the events name,
/// where the ledger lives, and the spawn provenance a child registers with
/// (TS `SemanticEdgeRecorder`'s constructor options).
#[derive(Debug, Clone)]
pub struct SemanticEdgeIdentity {
    pub session_id: String,
    pub ledger_path: Option<PathBuf>,
    pub parent_session_id: Option<String>,
    pub spawned_by_request_id: Option<String>,
}

/// A minted id (TS `mintId`: `randomUUID().replaceAll("-", "")`, 32
/// lowercase hex).
fn mint_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The two id-carrying headers one request sends (TS `modelRequestHeaders`).
#[must_use]
pub(crate) fn model_request_headers(
    request_id: &str,
) -> std::collections::BTreeMap<String, String> {
    [
        (MODEL_REQUEST_ID_HEADER, request_id),
        (IDEMPOTENCY_KEY_HEADER, request_id),
    ]
    .into_iter()
    .map(|(header, id)| (header.to_string(), id.to_string()))
    .collect()
}

/// The in-flight turn a parked retry may reuse (TS `_lastTurn`): the id,
/// the recorder epoch it minted in, and the turn-body fingerprint captured
/// before the wire call (a replayed turn has none, so it is never reused).
#[derive(Debug, Clone)]
struct Turn {
    request_id: String,
    epoch: u64,
    fingerprint: Option<[u8; 32]>,
}

#[derive(Debug, Default)]
struct RecorderState {
    disabled: bool,
    epoch: u64,
    last_turn: Option<Turn>,
    parked_retry: Option<Turn>,
    open_compactions: HashSet<String>,
}

/// Append-only semantic-edge recorder for one session (TS
/// `SemanticEdgeRecorder`): it only WRITES events; edge semantics live in
/// the TS fold. Constructing one over an existing ledger replays it;
/// registration is idempotent across resumes.
pub struct SemanticEdgeRecorder {
    session_id: String,
    ledger_path: Option<PathBuf>,
    state: Mutex<RecorderState>,
}

impl SemanticEdgeRecorder {
    /// Open (or reopen) this session's recorder: replay the ledger, fold the
    /// replayed events back into memory, and register the session when its
    /// id is not yet on the ledger. A missing or absent ledger starts empty;
    /// a corrupt interior line or an unwritable ledger permanently disables
    /// the recorder with one warning (TS `_disable`).
    #[must_use]
    pub fn open(identity: SemanticEdgeIdentity) -> Self {
        let mut state = RecorderState::default();
        let mut existing = Vec::new();
        let replay_failed = match identity.ledger_path.as_deref() {
            None => false,
            Some(path) => match ledger::read_events(path) {
                Ok(None) => false,
                Ok(Some(events)) => {
                    existing = events;
                    false
                }
                Err(error) => {
                    disable(&mut state, path, &error.to_string());
                    true
                }
            },
        };
        if !replay_failed {
            let registered = existing.iter().any(|event| {
                matches!(
                    event,
                    SemanticEdgeLedgerEvent::SessionRegistered { session_id, .. }
                        if session_id == &identity.session_id
                )
            });
            if registered {
                for event in &existing {
                    replay_event(&mut state, &identity.session_id, event);
                }
            } else {
                append_locked(
                    &mut state,
                    &identity.session_id,
                    identity.ledger_path.as_deref(),
                    &SemanticEdgeLedgerEvent::SessionRegistered {
                        session_id: identity.session_id.clone(),
                        parent_session_id: identity.parent_session_id.clone(),
                        spawned_by_request_id: identity.spawned_by_request_id.clone(),
                    },
                );
            }
        }
        Self {
            session_id: identity.session_id,
            ledger_path: identity.ledger_path,
            state: Mutex::new(state),
        }
    }

    fn state(&self) -> MutexGuard<'_, RecorderState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Durable append first, in-memory state second (TS `_append`): a
    /// failed write must not leave commit state pointing at events that
    /// never reached the ledger. Requires the state lock; returns whether
    /// the event recorded (a disabled or failed recorder records nothing).
    fn append(&self, state: &mut RecorderState, event: &SemanticEdgeLedgerEvent) -> bool {
        append_locked(state, &self.session_id, self.ledger_path.as_deref(), event)
    }

    /// Mint (or, for a body-identical retry, reuse) the id for one turn
    /// call (TS `startTurnRequest`). `None` means the recorder is disabled:
    /// the call carries no id. A reused retry re-logs `request_started` so
    /// the fold re-claims the failed attempt's returned pending edges.
    pub(crate) fn start_turn_request(&self, fingerprint: [u8; 32]) -> Option<String> {
        let mut state = self.state();
        // A parked retry is consumed only by the body it parked for, in
        // the epoch it parked in (TS `startTurnRequest`'s reuse gate).
        let epoch = state.epoch;
        let request_id = state
            .parked_retry
            .take_if(|parked| parked.epoch == epoch && parked.fingerprint == Some(fingerprint))
            .map_or_else(mint_id, |parked| parked.request_id);
        let recorded = self.append(
            &mut state,
            &SemanticEdgeLedgerEvent::RequestStarted {
                request_id: request_id.clone(),
                session_id: self.session_id.clone(),
                compaction_id: None,
            },
        );
        if !recorded {
            return None;
        }
        state.last_turn = Some(Turn {
            request_id: request_id.clone(),
            epoch: state.epoch,
            fingerprint: Some(fingerprint),
        });
        Some(request_id)
    }

    /// Park the last turn so the upcoming auto-retry reuses its id (TS
    /// `prepareTurnRetry`).
    pub fn prepare_turn_retry(&self) {
        let mut state = self.state();
        let parked = state.last_turn.clone();
        state.parked_retry = parked;
    }

    /// Drop the parked retry (TS `clearTurnRetry`).
    pub fn clear_turn_retry(&self) {
        self.state().parked_retry = None;
    }

    /// Commit one request (TS `finishRequest`).
    pub(crate) fn finish_request(&self, request_id: &str) {
        let mut state = self.state();
        self.append(
            &mut state,
            &SemanticEdgeLedgerEvent::RequestFinished {
                request_id: request_id.to_string(),
            },
        );
    }

    /// Fail one request (TS `failRequest`).
    pub(crate) fn fail_request(&self, request_id: &str) {
        let mut state = self.state();
        self.append(
            &mut state,
            &SemanticEdgeLedgerEvent::RequestFailed {
                request_id: request_id.to_string(),
            },
        );
    }

    /// The last turn's request id (TS `lastTurnRequestId`): the id a
    /// mid-turn child spawn anchors to.
    #[must_use]
    pub(crate) fn last_turn_request_id(&self) -> Option<String> {
        self.state()
            .last_turn
            .as_ref()
            .map(|turn| turn.request_id.clone())
    }

    /// The parent claims a child's return (TS `recordChildReturned`): the
    /// child's last committed request, captured at the success point. A
    /// child with nothing committed returns nothing (the no-op).
    pub fn record_child_returned(
        &self,
        child_session_id: &str,
        child_last_committed_request_id: Option<String>,
    ) {
        let Some(request_id) = child_last_committed_request_id else {
            return;
        };
        let mut state = self.state();
        self.append(
            &mut state,
            &SemanticEdgeLedgerEvent::ChildReturned {
                session_id: self.session_id.clone(),
                child_session_id: child_session_id.to_string(),
                request_id,
            },
        );
    }
}

/// The last `request_finished` in a ledger: the parent's read of a child's
/// last committed request (the cross-process form of TS's in-process
/// `child.semanticEdges.lastCommittedRequestId`), through the same parser
/// the recorder replays with. A missing ledger, a torn final line, or a
/// corrupt read yields `None` — an absent edge beats a wrong one.
#[must_use]
pub fn last_committed_request_id(ledger_path: &Path) -> Option<String> {
    match ledger::read_events(ledger_path) {
        Ok(None) | Err(_) => None,
        Ok(Some(events)) => events.into_iter().rev().find_map(|event| match event {
            SemanticEdgeLedgerEvent::RequestFinished { request_id } => Some(request_id),
            _ => None,
        }),
    }
}

/// Durable append first, in-memory state second (TS `_append`): a failed
/// write must not leave commit state pointing at events that never reached
/// the ledger. Requires the state lock.
fn append_locked(
    state: &mut RecorderState,
    session_id: &str,
    ledger_path: Option<&Path>,
    event: &SemanticEdgeLedgerEvent,
) -> bool {
    if state.disabled {
        return false;
    }
    if let Some(path) = ledger_path {
        if let Err(error) = ledger::append_event(path, event) {
            disable(state, path, &error.to_string());
            return false;
        }
    }
    replay_event(state, session_id, event);
    true
}

/// Fold one event back into the in-memory state (TS `_replay`): restores
/// turn attribution and compaction epochs after a resume.
fn replay_event(state: &mut RecorderState, session_id: &str, event: &SemanticEdgeLedgerEvent) {
    match event {
        // Restores spawn attribution after resume; the fingerprint is
        // unknowable on disk, so a replayed turn is never reused as a
        // parked retry.
        SemanticEdgeLedgerEvent::RequestStarted {
            request_id,
            session_id: event_session_id,
            compaction_id: None,
        } if event_session_id == session_id => {
            state.last_turn = Some(Turn {
                request_id: request_id.clone(),
                epoch: state.epoch,
                fingerprint: None,
            });
        }
        SemanticEdgeLedgerEvent::CompactionBegun {
            compaction_id,
            session_id: event_session_id,
        } if event_session_id == session_id => {
            state.open_compactions.insert(compaction_id.clone());
        }
        SemanticEdgeLedgerEvent::CompactionFinished {
            compaction_id,
            status,
        } => {
            if state.open_compactions.remove(compaction_id)
                && *status == CompactionStatus::Completed
            {
                state.epoch += 1;
            }
        }
        SemanticEdgeLedgerEvent::RequestStarted { .. }
        | SemanticEdgeLedgerEvent::RequestFinished { .. }
        | SemanticEdgeLedgerEvent::RequestFailed { .. }
        | SemanticEdgeLedgerEvent::SessionRegistered { .. }
        | SemanticEdgeLedgerEvent::CompactionBegun { .. }
        | SemanticEdgeLedgerEvent::ChildReturned { .. }
        | SemanticEdgeLedgerEvent::Unknown => {}
    }
}

/// Permanently disable all writes with one warning (TS `_disable`), so the
/// ledger-before-wire invariant is preserved rather than weakened.
fn disable(state: &mut RecorderState, ledger_path: &Path, error: &str) {
    if state.disabled {
        return;
    }
    state.disabled = true;
    // A disabled recorder names no turn: a later spawn would otherwise
    // anchor to a request that is not the in-flight one (TS keeps
    // `_lastTurn`; an absent edge beats a wrong one).
    state.last_turn = None;
    eprintln!(
        "pa-core: semantic-edge ledger disabled at {}: {error}",
        ledger_path.display()
    );
}

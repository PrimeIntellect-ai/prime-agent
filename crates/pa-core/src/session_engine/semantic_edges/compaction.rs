//! The compaction half of the ledger (TS `agent-session.ts`'s
//! `semanticCompaction` / `uncommittedSlices` / `summaryCall`): the RAII
//! guard that owns one compaction's events, and the wrapper its summary
//! wire calls run under.

use std::sync::Arc;

use pa_agent::abort::AbortSignal;

use super::{model_request_headers, SemanticEdgeLedgerEvent, SemanticEdgeRecorder};

impl SemanticEdgeRecorder {
    /// Begin one compaction and return its RAII guard (TS `beginCompaction`):
    /// every wire summary slice is minted through the guard, and the
    /// compaction's terminal event lands exactly once — at `commit`, or at
    /// the guard's drop on every `?`/abort exit (TS settles the same paths
    /// through its try/catch).
    pub(crate) fn begin_compaction(
        self: &Arc<Self>,
        abort: Option<&AbortSignal>,
    ) -> SemanticCompaction {
        let compaction_id = super::mint_id();
        let mut state = self.state();
        self.append(
            &mut state,
            &SemanticEdgeLedgerEvent::CompactionBegun {
                compaction_id: compaction_id.clone(),
                session_id: self.session_id.clone(),
            },
        );
        SemanticCompaction {
            recorder: Arc::clone(self),
            compaction_id,
            open_slices: std::sync::Mutex::new(Vec::new()),
            committed: false,
            abort: abort.cloned(),
        }
    }
}

/// One compaction's ledger guard: slices mint their ids through it, and
/// the compaction's terminal event lands exactly once — `commit()` before
/// the compaction entry persists, or the drop (failed / cancelled) on every
/// early exit, exactly like the TS try/catch that settles the same paths.
pub(crate) struct SemanticCompaction {
    recorder: Arc<SemanticEdgeRecorder>,
    compaction_id: String,
    /// Every started slice that has not settled on the ledger (TS
    /// `uncommittedSlices`, widened to cover a slice whose future is
    /// dropped mid-call): a failure removes and fails its own id, commit
    /// finishes the rest, and the drop fails the rest — so no
    /// `request_started{compaction_id}` is ever left without a terminal
    /// event. A resolved slice moves to the tail (TS pushes
    /// `uncommittedSlices` on resolve), so commit finishes the slices in
    /// resolve order. A split turn's two slices run concurrently on one
    /// task, so the list is interior-mutable.
    open_slices: std::sync::Mutex<Vec<String>>,
    committed: bool,
    /// The run's abort signal: a dropped guard records `cancelled` only
    /// when it aborted, `failed` otherwise (TS's catch classification).
    abort: Option<AbortSignal>,
}

impl SemanticCompaction {
    /// Mint one summary wire call's id (TS `startCompactionRequest`):
    /// `None` when the recorder is disabled — the call carries no id.
    pub(crate) fn start_slice(&self) -> Option<String> {
        let request_id = super::mint_id();
        let mut state = self.recorder.state();
        let recorded = self.recorder.append(
            &mut state,
            &SemanticEdgeLedgerEvent::RequestStarted {
                request_id: request_id.clone(),
                session_id: self.recorder.session_id.clone(),
                compaction_id: Some(self.compaction_id.clone()),
            },
        );
        if !recorded {
            return None;
        }
        self.open_slices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request_id.clone());
        Some(request_id)
    }

    /// A wire slice failed (TS `failRequest` in `summaryCall`'s catch):
    /// it settles now, so commit and drop no longer own it.
    pub(crate) fn slice_failed(&self, request_id: &str) {
        self.open_slices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|open| open != request_id);
        self.recorder.fail_request(request_id);
    }

    /// A wire slice resolved (TS pushes `uncommittedSlices` on resolve):
    /// it moves to the tail, so `commit` finishes the slices in resolve
    /// order and the last-resolved slice is the session's last commit (the
    /// compaction edge's source).
    fn slice_resolved(&self, request_id: &str) {
        let mut open = self
            .open_slices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        open.retain(|open| open != request_id);
        open.push(request_id.to_string());
    }

    /// The compaction committed (ledger before effect: TS marks
    /// `compactionRecorded` first, finishes the slices, then appends the
    /// `compaction_finished` event, all ahead of `appendCompaction`).
    pub(crate) fn commit(&mut self) {
        self.committed = true;
        for request_id in self.take_open_slices() {
            self.recorder.finish_request(&request_id);
        }
        let mut state = self.recorder.state();
        self.recorder.append(
            &mut state,
            &SemanticEdgeLedgerEvent::CompactionFinished {
                compaction_id: self.compaction_id.clone(),
                status: super::CompactionStatus::Completed,
            },
        );
    }
}

impl SemanticCompaction {
    /// Drain the unsettled slice ids (commit and drop both consume them).
    fn take_open_slices(&self) -> Vec<String> {
        std::mem::take(
            &mut *self
                .open_slices
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}

impl Drop for SemanticCompaction {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for request_id in self.take_open_slices() {
            self.recorder.fail_request(&request_id);
        }
        let status = if self
            .abort
            .as_ref()
            .is_some_and(pa_agent::abort::AbortSignal::is_aborted)
        {
            super::CompactionStatus::Cancelled
        } else {
            super::CompactionStatus::Failed
        };
        let mut state = self.recorder.state();
        self.recorder.append(
            &mut state,
            &SemanticEdgeLedgerEvent::CompactionFinished {
                compaction_id: self.compaction_id.clone(),
                status,
            },
        );
    }
}

/// Run one summary wire call under its compaction's ledger (TS
/// `summaryCall`): mint the slice's id, merge its headers into the call's,
/// and report the outcome. Without a guard (no semantic identity, or a
/// disabled recorder) the call runs unchanged.
///
/// # Errors
///
/// Returns the wrapped call's error after the guard recorded the failed
/// slice.
pub(crate) async fn summary_slice_call<T, F, Fut>(
    compaction: Option<&SemanticCompaction>,
    summary_headers: Option<std::collections::BTreeMap<String, String>>,
    call: F,
) -> anyhow::Result<T>
where
    F: FnOnce(Option<std::collections::BTreeMap<String, String>>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let Some(compaction) = compaction else {
        return call(summary_headers).await;
    };
    // A disabled recorder mints no id: the call carries the plain summary
    // headers, exactly like TS's `requestId === undefined` arm.
    let Some(request_id) = compaction.start_slice() else {
        return call(summary_headers).await;
    };
    // The id's headers win over the routed model's (TS
    // `{ ...summarization.headers, ...modelRequestHeaders(requestId) }`),
    // and they ride even a headerless target (the common direct-key case).
    let mut headers = summary_headers.unwrap_or_default();
    headers.extend(model_request_headers(&request_id));
    let result = call(Some(headers)).await;
    match &result {
        Ok(_) => compaction.slice_resolved(&request_id),
        Err(_) => compaction.slice_failed(&request_id),
    }
    result
}

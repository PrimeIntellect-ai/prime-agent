//! Guest command dispatch: the claiming loop and the session-executor
//! seam (TS `CloudProtocolServer.dispatchLoop` + the daemon's
//! `dispatch`).
//!
//! Claims are sequential: the claim's running transition is fsynced
//! before the request is handed out (the journal's contract), the
//! dispatched work is not settled until the executor answers, and the
//! settle journals the terminal receipt before its command-state event
//! is emitted. Restored uncertain commands are never claimed; restored
//! accepted commands are claimed exactly once.
//!
//! The executor is a seam: the engine-backed implementation
//! ([`crate::cloud_guest::executor`]) drives the real session engine;
//! the loopback harness substitutes its own to prove the durability
//! contract without the engine.

use std::sync::Arc;

use futures::future::BoxFuture;
use pa_types::daemon::cloud::CloudCommandRequest;

use crate::cloud_guest::journal::parse_claimed_request;
use crate::cloud_guest::server::GuestProtocolServer;

/// The terminal outcome of one dispatched command (TS
/// `CloudProtocolDispatchResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuestDispatchOutcome {
    Completed { result: Option<String> },
    Failed { error: Option<String> },
    Cancelled,
}

/// The session-facing snapshot fields the executor owns (the rest of
/// the protocol snapshot — the active and queued command ids — is
/// journal state the server folds in).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestSessionSnapshot {
    pub cwd: String,
    pub model: Option<String>,
}

/// One claimed command's executor (TS `CloudProtocolServerCallbacks.dispatch`):
/// executes the request and answers with the terminal state, never by
/// panicking across the seam (failures are [`GuestDispatchOutcome::Failed`]).
pub trait GuestExecutor: Send + Sync {
    /// Execute one claimed command under its stable id (the executor
    /// may key its own idempotence on the id, though the journal
    /// already guarantees one execution per admitted command).
    fn dispatch(
        &self,
        command_id: String,
        request: CloudCommandRequest,
    ) -> BoxFuture<'static, GuestDispatchOutcome>;

    /// The session-facing snapshot (cwd, model) for protocol snapshots.
    fn snapshot(&self) -> GuestSessionSnapshot;
}

/// Serve claims until the server stops: claim, emit the running state,
/// dispatch, settle. One loop serves every connection; the journal is
/// the claim gate.
pub(super) async fn dispatch_loop(
    server: Arc<GuestProtocolServer>,
    executor: Arc<dyn GuestExecutor>,
) {
    server.refresh_snapshot(executor.snapshot());
    // A restart must replay restored-pending commands without waiting
    // for a new submit to wake the loop.
    server.notify_work();
    loop {
        if server.is_stopping() {
            return;
        }
        let Some(claimed) = server.claim_and_begin().await else {
            server.wait_for_work().await;
            continue;
        };
        let command_id = claimed.receipt.command_id.clone();
        let mut release = false;
        let outcome = match parse_claimed_request(&claimed.request) {
            Ok(request) => {
                release = matches!(request, CloudCommandRequest::Release);
                executor.dispatch(command_id.clone(), request).await
            }
            Err(_) => GuestDispatchOutcome::Failed {
                error: Some("command request failed canonical parse".to_string()),
            },
        };
        server.settle(&command_id, &outcome, release).await;
        if release {
            return;
        }
        server.refresh_snapshot(executor.snapshot());
    }
}

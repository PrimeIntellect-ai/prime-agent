//! Guest-side half of the exchange: durable requests out, journaled answers
//! in.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use pa_types::daemon::cloud::{
    CloudAgentMessageReceipt, CloudFamilyCommand, CloudFamilyCommandPayload, CloudFamilyEvent,
    CloudFamilyEventPayload, CloudFamilyRow,
};
use tokio::sync::oneshot;

use super::{CloudFamilyRequestError, CloudFamilyRequestOutcome, ResolveOutcome};
use crate::cloud_family::log::FamilyRequestLog;
use crate::cloud_family::{MESSAGE_REQUEST_PREFIX, REMOTE_REQUEST_TIMEOUT, ROSTER_REQUEST_PREFIX};

/// The result value one pending request waits for.
enum PendingKind {
    Roster(oneshot::Sender<Result<Vec<CloudFamilyRow>, String>>),
    Message(oneshot::Sender<Result<CloudAgentMessageReceipt, String>>),
}

/// Guest-side half of the exchange: durable requests out, journaled answers
/// in.
pub struct CloudFamilyRequester {
    log: Mutex<FamilyRequestLog>,
    pending: Mutex<HashMap<String, PendingKind>>,
    request_timeout: Duration,
}

impl CloudFamilyRequester {
    /// Build a requester over an opened request log with the TS
    /// [`REMOTE_REQUEST_TIMEOUT`] (30s) pending window.
    #[must_use]
    pub fn new(log: FamilyRequestLog) -> Self {
        Self {
            log: Mutex::new(log),
            pending: Mutex::new(HashMap::new()),
            request_timeout: REMOTE_REQUEST_TIMEOUT,
        }
    }

    /// Same as [`new`](Self::new) with an explicit pending window (the
    /// tests drive short windows; production wiring uses the TS constant).
    #[must_use]
    pub fn with_request_timeout(log: FamilyRequestLog, request_timeout: Duration) -> Self {
        Self {
            log: Mutex::new(log),
            pending: Mutex::new(HashMap::new()),
            request_timeout,
        }
    }

    /// Send one agent message across the boundary. The request is appended
    /// to the durable log first; the returned future resolves `Answered`
    /// only when the journaled receipt arrives, `Pending` at the timeout,
    /// and an error when the log stalls or the answer rejects.
    ///
    /// While the tunnel is down the request rides the durable log; the
    /// send resolves `Pending` (or errors on a stalled log) — it never
    /// reports delivered or queued without a receiver-admitted receipt.
    ///
    /// # Errors
    ///
    /// Returns an error when the durable request log stalls the append or
    /// the journaled answer rejects the delivery; the outcome is never a
    /// fabricated receipt.
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    pub async fn send_agent_message(
        &self,
        from_remote_session_id: &str,
        target_selector: &str,
        message: &str,
    ) -> Result<CloudFamilyRequestOutcome<CloudAgentMessageReceipt>, CloudFamilyRequestError> {
        let request_id = format!("{MESSAGE_REQUEST_PREFIX}{}", uuid::Uuid::new_v4());
        self.append_request(
            CloudFamilyEventPayload::AgentMessageRequest {
                request_id: request_id.clone(),
                from_remote_session_id: from_remote_session_id.to_string(),
                target_selector: target_selector.to_string(),
                message: message.to_string(),
            },
            "the guest event log is stalled; agent messaging is unavailable",
        )?;
        self.await_answer(request_id, PendingKind::Message).await
    }

    /// Ask the local side for this session's cross-boundary family rows.
    /// Same admission and answer contract as
    /// [`send_agent_message`](Self::send_agent_message); the TS guest
    /// degrades an unanswered roster to an empty list plus a warning.
    ///
    /// # Errors
    ///
    /// Returns an error when the durable request log stalls the append or
    /// the journaled answer rejects the roster fetch.
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    pub async fn request_family_roster(
        &self,
        from_remote_session_id: &str,
    ) -> Result<CloudFamilyRequestOutcome<Vec<CloudFamilyRow>>, CloudFamilyRequestError> {
        let request_id = format!("{ROSTER_REQUEST_PREFIX}{}", uuid::Uuid::new_v4());
        self.append_request(
            CloudFamilyEventPayload::FamilyRosterRequest {
                request_id: request_id.clone(),
                from_remote_session_id: from_remote_session_id.to_string(),
            },
            "the guest event log is stalled; the family roster is unavailable",
        )?;
        self.await_answer(request_id, PendingKind::Roster).await
    }

    /// Feed one journaled answer command back to its pending request. The
    /// TS default rejection applies when an `agent_message_result` carries
    /// no error.
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    pub fn resolve_result(&self, command: &CloudFamilyCommand) -> ResolveOutcome {
        let mut pending = self.pending.lock().expect("pending map poisoned");
        let Some(sender) = pending.remove(command.request_id()) else {
            return ResolveOutcome::UnknownRequestId;
        };
        match (command.payload.clone(), sender) {
            (
                CloudFamilyCommandPayload::FamilyRosterResult { entries, .. },
                PendingKind::Roster(sender),
            ) => {
                let _ = sender.send(Ok(entries));
            }
            (
                CloudFamilyCommandPayload::AgentMessageResult {
                    ok, receipt, error, ..
                },
                PendingKind::Message(sender),
            ) => {
                if ok {
                    if let Some(receipt) = receipt {
                        let _ = sender.send(Ok(receipt));
                        return ResolveOutcome::Resolved;
                    }
                }
                let _ = sender.send(Err(error.unwrap_or_else(|| {
                    "the supervisor could not deliver the agent message".to_string()
                })));
            }
            (_, PendingKind::Roster(sender)) => {
                let _ = sender.send(Err(
                    "a family roster request received an agent message result".to_string(),
                ));
            }
            (_, PendingKind::Message(sender)) => {
                let _ = sender.send(Err(
                    "an agent message request received a family roster result".to_string(),
                ));
            }
        }
        ResolveOutcome::Resolved
    }

    /// Reject every pending request (shutdown): dropping the senders closes
    /// their channels, so each awaiter gets
    /// [`CloudFamilyRequestError::Released`]. New answers for released ids
    /// resolve as unknown.
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    pub fn release(&self) {
        self.pending.lock().expect("pending map poisoned").clear();
    }

    /// The sequence of the newest admitted request (transport
    /// observability).
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    #[must_use]
    pub fn tail_sequence(&self) -> u64 {
        self.log
            .lock()
            .expect("request log poisoned")
            .tail_sequence()
    }

    /// Admitted requests after `sequence`, oldest first — the replay view
    /// the transport pushes across the boundary on (re)connect. A
    /// `sequence` beyond the tail is a cursor error.
    ///
    /// # Errors
    ///
    /// Returns the TS cursor problem string when `sequence` is beyond the
    /// event tail.
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    pub fn events_after(&self, sequence: u64) -> Result<Vec<CloudFamilyEvent>, String> {
        self.log
            .lock()
            .expect("request log poisoned")
            .events_after(sequence)
    }

    fn append_request(
        &self,
        payload: CloudFamilyEventPayload,
        stall_message: &str,
    ) -> Result<(), CloudFamilyRequestError> {
        self.log
            .lock()
            .expect("request log poisoned")
            .append(payload)
            .map(|_| ())
            .map_err(|_| CloudFamilyRequestError::Stalled(stall_message.to_string()))
    }

    async fn await_answer<T>(
        &self,
        request_id: String,
        register: impl FnOnce(oneshot::Sender<Result<T, String>>) -> PendingKind,
    ) -> Result<CloudFamilyRequestOutcome<T>, CloudFamilyRequestError> {
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending map poisoned")
            .insert(request_id.clone(), register(sender));
        let answer = tokio::time::timeout(self.request_timeout, receiver).await;
        match answer {
            Ok(Ok(Ok(value))) => Ok(CloudFamilyRequestOutcome::Answered(value)),
            Ok(Ok(Err(error))) => Err(CloudFamilyRequestError::Rejected(error)),
            Ok(Err(_)) => {
                // The sender half was dropped without an answer (release
                // paths drop the map entry only through this send).
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&request_id);
                Err(CloudFamilyRequestError::Released)
            }
            Err(_elapsed) => {
                // Timed out: the request is durably admitted but has no
                // journaled answer. Never report it delivered or queued.
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&request_id);
                Ok(CloudFamilyRequestOutcome::Pending { request_id })
            }
        }
    }
}

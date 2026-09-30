//! Local-side half of the exchange: request events in, journaled answers
//! out through the delivery and submit seams.

use std::sync::Mutex;

use pa_types::daemon::cloud::{
    CloudFamilyCommand, CloudFamilyCommandPayload, CloudFamilyEvent, CloudFamilyEventPayload,
};

use super::{
    AgentMessageLookup, CloudDeliveryError, CloudFamilyDelivery, FamilyResultSubmitter,
    HandleOutcome, IncomingCloudMessage,
};
use crate::cloud_family::log::{Admission, FamilyResultLog};

/// Local-side half of the exchange: request events in, journaled answers
/// out through the delivery and submit seams. The durable journal is the
/// single dedupe authority — there is no in-memory processed set: a
/// duplicate finds either its journaled answer (re-submit), its durable
/// admission ([`HandleOutcome::Uncertain`], never re-delivered), or a
/// fresh slot.
pub struct CloudFamilyResponder {
    results: Mutex<FamilyResultLog>,
}

impl CloudFamilyResponder {
    /// Build a responder over an opened result log.
    #[must_use]
    pub fn new(results: FamilyResultLog) -> Self {
        Self {
            results: Mutex::new(results),
        }
    }

    /// Handle one admitted family request event: durably admit the request
    /// BEFORE delivery, deliver through the seam, record the answer
    /// durably, then submit it.
    ///
    /// Crash safety: a crash after delivery but before the answer record
    /// leaves the request durably admitted with no answer — replaying it
    /// surfaces [`HandleOutcome::Uncertain`] and never re-delivers; the
    /// wiring layer reconciles it (the receiver is idempotent by request
    /// id) and records the answer, after which a replay re-submits it.
    ///
    /// # Errors
    ///
    /// Returns an error when the durable admission or answer record cannot
    /// be written (a disk-level failure: the request is not answered, and
    /// the requester times out — at-least-once, TS parity).
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    pub async fn handle_event<D: CloudFamilyDelivery, S: FamilyResultSubmitter>(
        &self,
        event: &CloudFamilyEvent,
        delivery: &D,
        submitter: &S,
    ) -> Result<HandleOutcome, String> {
        let request_id = event.request_id().to_string();
        // A journaled answer exists: re-submit it without re-delivering.
        let durable_answer = self
            .results
            .lock()
            .expect("result log poisoned")
            .result(&request_id);
        if let Some(answer) = durable_answer {
            return match submitter
                .submit_family_result(&answer.journal_command_id(), &answer)
                .await
            {
                Ok(()) => Ok(HandleOutcome::DuplicateResubmitted),
                Err(error) => Ok(HandleOutcome::SubmitFailed(error)),
            };
        }
        // Durable admission gate: the fsync'd `admitted` record precedes
        // any delivery, so a crash in the delivery gap can never cause a
        // replay to re-deliver.
        let admission = self
            .results
            .lock()
            .expect("result log poisoned")
            .admit(&request_id)
            .map_err(|error| format!("admit {request_id}: {error}"))?;
        if admission == Admission::Already {
            // Uncertain: durably admitted, answer unknown (a crash
            // interrupted the first handling). Never re-deliver —
            // reconcile instead through the receiver's idempotent seam.
            let command = match &event.payload {
                CloudFamilyEventPayload::AgentMessageRequest { request_id, .. } => {
                    match delivery.lookup_agent_message(request_id).await {
                        AgentMessageLookup::Admitted(receipt) => CloudFamilyCommand {
                            payload: CloudFamilyCommandPayload::AgentMessageResult {
                                request_id: request_id.clone(),
                                ok: true,
                                receipt: Some(receipt),
                                error: None,
                            },
                        },
                        // No idempotent record (provably never
                        // attempted) or an unresolvable outcome (the
                        // receiver may already hold the message): either
                        // way the request stays uncertain — the wiring
                        // layer reconciles it through the seam and
                        // records the answer, never this substrate.
                        AgentMessageLookup::Unknown | AgentMessageLookup::Uncertain => {
                            return Ok(HandleOutcome::Uncertain);
                        }
                    }
                }
                // The roster read is idempotent: re-running it is the
                // reconciliation.
                CloudFamilyEventPayload::FamilyRosterRequest {
                    from_remote_session_id,
                    request_id,
                } => {
                    let rows = delivery
                        .family_roster(from_remote_session_id)
                        .await
                        .unwrap_or_default();
                    CloudFamilyCommand {
                        payload: CloudFamilyCommandPayload::FamilyRosterResult {
                            request_id: request_id.clone(),
                            entries: rows,
                        },
                    }
                }
            };
            self.results
                .lock()
                .expect("result log poisoned")
                .record(command.clone())
                .map_err(|error| format!("record answer for {request_id}: {error}"))?;
            let outcome = match submitter
                .submit_family_result(&command.journal_command_id(), &command)
                .await
            {
                Ok(()) => HandleOutcome::Reconciled,
                Err(error) => HandleOutcome::SubmitFailed(error),
            };
            return Ok(outcome);
        }
        let command = match &event.payload {
            CloudFamilyEventPayload::AgentMessageRequest {
                request_id,
                from_remote_session_id,
                target_selector,
                message,
            } => {
                let delivered = delivery
                    .deliver_agent_message(IncomingCloudMessage {
                        request_id: request_id.clone(),
                        from_remote_session_id: from_remote_session_id.clone(),
                        target_selector: target_selector.clone(),
                        message: message.clone(),
                    })
                    .await;
                match delivered {
                    Ok(receipt) => CloudFamilyCommand {
                        payload: CloudFamilyCommandPayload::AgentMessageResult {
                            request_id: request_id.clone(),
                            ok: true,
                            receipt: Some(receipt),
                            error: None,
                        },
                    },
                    Err(CloudDeliveryError::Rejected(error)) => CloudFamilyCommand {
                        payload: CloudFamilyCommandPayload::AgentMessageResult {
                            request_id: request_id.clone(),
                            ok: false,
                            receipt: None,
                            error: Some(truncate_utf16(error, 2000)),
                        },
                    },
                    Err(CloudDeliveryError::Unresolved(_)) => {
                        return Ok(HandleOutcome::Uncertain);
                    }
                }
            }
            CloudFamilyEventPayload::FamilyRosterRequest {
                from_remote_session_id,
                ..
            } => {
                // The roster answer degrades to empty rows on error (TS
                // parity: the guest renders a degraded local family).
                let rows = delivery
                    .family_roster(from_remote_session_id)
                    .await
                    .unwrap_or_default();
                CloudFamilyCommand {
                    payload: CloudFamilyCommandPayload::FamilyRosterResult {
                        request_id,
                        entries: rows,
                    },
                }
            }
        };
        self.results
            .lock()
            .expect("result log poisoned")
            .record(command.clone())
            .map_err(|error| format!("record answer for {}: {error}", event.request_id()))?;
        let outcome = match submitter
            .submit_family_result(&command.journal_command_id(), &command)
            .await
        {
            Ok(()) => HandleOutcome::Answered,
            Err(error) => HandleOutcome::SubmitFailed(error),
        };
        Ok(outcome)
    }

    /// Record the answer for a durably admitted request that has none —
    /// the wiring layer's reconciliation path for an uncertain request
    /// (the receiver is idempotent by request id, so it can answer "what
    /// did the delivery do" and this records it). After the answer is
    /// recorded, a replayed request re-submits it without re-delivering.
    ///
    /// # Errors
    ///
    /// Returns an error when the request was never admitted or the
    /// durable answer record cannot be written.
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    pub fn record_answer(&self, command: CloudFamilyCommand) -> Result<(), String> {
        self.results
            .lock()
            .expect("result log poisoned")
            .record(command)
            .map_err(|error| error.to_string())
    }

    /// Request ids durably admitted without a journaled answer — the
    /// uncertain set the wiring layer must reconcile before replaying
    /// their request events.
    ///
    /// # Panics
    ///
    /// Panics when an internal lock is poisoned (a writer panicked while
    /// holding it).
    #[must_use]
    pub fn uncertain(&self) -> Vec<String> {
        self.results
            .lock()
            .expect("result log poisoned")
            .uncertain()
    }
}

/// TS `message.slice(0, 2000)`: truncate at a UTF-16 unit boundary so the
/// answer error never exceeds the TS slice, whatever the error's content.
fn truncate_utf16(text: String, units: usize) -> String {
    let mut result = String::new();
    let mut count = 0usize;
    for character in text.chars() {
        let width = character.len_utf16();
        if count + width > units {
            break;
        }
        count += width;
        result.push(character);
    }
    result
}

//! The submit/poll/ack read-write paths of the guest protocol server
//! (TS `handleSubmit`/`handleGetCommand`/`handleAck`'s journal halves).
//!
//! The connection layer owns the transport's drop semantics; these
//! arms own the durable ones: the request byte bound, the journal
//! admission with its digest-deduped stable id, the queue-full failure,
//! and the acknowledged-cursor advance.

use anyhow::Context as _;
use pa_types::daemon::cloud::{
    serialize_cloud_message, CloudCommand, CloudCommandReceipt, CloudCursor, CloudEvent,
    CloudMessage, CloudSessionState, CLOUD_MAX_QUEUED_COMMANDS,
};

use crate::cloud_guest::journal::GuestAdmission;
use crate::cloud_guest::now_iso;
use crate::cloud_guest::outbox::GuestEventInput;
use crate::cloud_guest::server::GuestProtocolServer;

impl GuestProtocolServer {
    /// Admit one submit: the byte bound, the journal admission, the
    /// queue-full failure, and the command-state event. The receipt
    /// frame is written through `write_frame` between the
    /// command-accepted and command-state events, exactly like TS.
    /// Returns whether this call was the first admission; `Err` is the
    /// connection-layer drop signal (invalid request, journal failure,
    /// or an id conflict).
    pub fn admit_submit(
        &self,
        command_id: &str,
        request: &serde_json::Value,
        write_frame: &dyn Fn(&str),
    ) -> Option<bool> {
        if let Some(problem) = pa_types::daemon::cloud::cloud_request_json_problem(request) {
            self.record_dispatch_error(&format!("submit refused: {problem}"));
            return None;
        }
        let (admission, admitted_receipt) = {
            let mut journal = self.journal_lock();
            match journal.admit(command_id, request) {
                Ok(admitted) => admitted,
                Err(error) => {
                    self.record_dispatch_error(&format!("admit {command_id}: {error:#}"));
                    return None;
                }
            }
        };
        if admission == GuestAdmission::Conflict {
            return None;
        }
        if admission == GuestAdmission::New {
            self.mark_work_admitted();
            self.append_event(GuestEventInput::CommandAccepted {
                recorded_at: now_iso(),
                receipt: admitted_receipt.clone(),
            });
            // The durable admission stays honest: the receipt fails
            // rather than silently wedging behind an unbounded queue.
            if self.journal_lock().list_pending().len() > CLOUD_MAX_QUEUED_COMMANDS {
                let settled = {
                    let mut journal = self.journal_lock();
                    journal
                        .fail(command_id, Some("guest command queue is full"))
                        .and_then(|()| journal.receipt(command_id).context("receipt vanished"))
                };
                if let Err(error) = settled {
                    self.record_dispatch_error(&format!("queue-full settle: {error:#}"));
                }
            }
        }
        // The receipt frame carries the admission's receipt (TS writes
        // `admitted.receipt`); the command-state event carries the
        // current journaled state (post queue-full failure).
        write_frame(&self.command_frame(&admitted_receipt));
        let receipt = self.poll_receipt(command_id).unwrap_or(admitted_receipt);
        self.append_event(GuestEventInput::CommandState {
            recorded_at: now_iso(),
            receipt,
        });
        self.notify_work();
        Some(admission == GuestAdmission::New)
    }

    /// The receipt poll (TS `handleGetCommand`'s read-only arm): the
    /// connection layer owns the drop semantics.
    #[must_use]
    pub fn poll_receipt(&self, command_id: &str) -> Option<CloudCommandReceipt> {
        self.journal_lock().receipt(command_id)
    }

    /// Advance the acknowledged-cursor (TS `handleAck`): the connection
    /// layer owns the generation fence and the drop semantics.
    ///
    /// # Errors
    ///
    /// Returns the TS cursor problem string when the acknowledgement is
    /// invalid; the connection layer drops the client on it.
    pub fn acknowledge(&self, cursor: &CloudCursor) -> Result<(), String> {
        self.outbox_lock().ack(cursor)
    }

    /// Events after one cursor (the snapshot/subscribe read path).
    /// `None` is the cursor problem (the connection layer resyncs or
    /// drops per the TS arms).
    #[must_use]
    pub fn events_after(&self, cursor: &CloudCursor, limit: usize) -> Option<Vec<CloudEvent>> {
        self.outbox_lock().events_after(cursor, limit).ok()
    }

    /// The session-facing protocol state (TS `snapshotState`): the
    /// executor's cwd/model plus the journal's active and queued ids.
    #[must_use]
    pub fn session_state(&self) -> CloudSessionState {
        let queued_command_ids = self
            .journal_lock()
            .list_pending()
            .into_iter()
            .map(|receipt| receipt.command_id)
            .collect();
        let snapshot = self
            .snapshot_state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let active_command_id = self
            .active_command
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        CloudSessionState {
            cwd: snapshot.cwd,
            model_id: snapshot.model.unwrap_or_default(),
            active_command_id,
            queued_command_ids,
        }
    }

    /// The serialized command-receipt frame (TS `commandFrame`).
    #[must_use]
    pub fn command_frame(&self, receipt: &CloudCommandReceipt) -> String {
        let frame = CloudMessage::Command(CloudCommand {
            session_id: self.session_id().to_string(),
            generation: self.event_generation(),
            receipt: receipt.clone(),
            request: None,
        });
        serialize_cloud_message(&frame).unwrap_or_default()
    }
}

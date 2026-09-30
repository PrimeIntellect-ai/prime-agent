//! The journaled request/response exchange over the family wire slice.
//!
//! Two roles, both driven by durable state (TS `cloud-daemon.ts` guest-side
//! pending requests + `cloud-session-registry.ts` remote-request arms):
//!
//! - [`CloudFamilyRequester`] (guest side, `requester.rs`): one request is
//!   appended to the durable request log BEFORE anything is awaited — the
//!   append is the admission gate, and a stalled log fails the send
//!   honestly. The answer arrives only as a journaled `family_roster_result`
//!   / `agent_message_result` command; until then the send is `Pending`,
//!   never "queued" or "delivered". While the laptop is offline the request
//!   sits durably in the log and no receiver truth exists; on reconnect the
//!   answer rides the journal back.
//! - [`CloudFamilyResponder`] (local side, `responder.rs`): one request event
//!   is durably ADMITTED before any delivery, delivered through the
//!   [`CloudFamilyDelivery`] seam (which owns the family-reach assert and
//!   the durable local inbox admission), and answered through the
//!   [`FamilyResultSubmitter`] seam with the answer durably recorded before
//!   it is submitted. A request admitted without an answer is UNCERTAIN —
//!   a crash may or may not have delivered it — and is never re-delivered
//!   by this substrate; the wiring layer reconciles it and records the
//!   answer, after which a replay re-submits it.
//!
//! Neither role fabricates a delivery path: the delivery and submit seams
//! are wired by the cloud registry attachment; nothing here falls back to
//! local delivery for a cloud target, and a receipt exists only after the
//! receiver admitted the message.

mod requester;
mod responder;

pub use requester::CloudFamilyRequester;
pub use responder::CloudFamilyResponder;

use std::future::Future;

use pa_types::daemon::cloud::{CloudAgentMessageReceipt, CloudFamilyCommand, CloudFamilyRow};

/// The sender's view of one cross-boundary send. `Answered` is the only
/// branch that ever carries the receiver's delivery truth: it exists only
/// after the journaled result command arrived, which requires the tunnel
/// up and the target having admitted the message. `Pending` is durable
/// admission without an answer — the request is not lost, but nothing may
/// report it delivered or queued (the wiring layer surfaces it as the TS
/// `cross-boundary request <id> timed out` failure).
#[derive(Debug, Clone, PartialEq)]
pub enum CloudFamilyRequestOutcome<T> {
    /// The journaled answer arrived: the receiver's admitted receipt (or
    /// roster rows).
    Answered(T),
    /// Durably admitted to the request log; no journaled answer within the
    /// request timeout. A late answer for this id is dropped as unknown.
    Pending { request_id: String },
}

/// Why one cross-boundary send failed. None of these variants ever carries
/// or implies a delivery receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudFamilyRequestError {
    /// The durable request log refused the append (full or unwritable):
    /// the request was never admitted, nothing is pending (TS:
    /// `the guest event log is stalled; ...`).
    Stalled(String),
    /// The journaled answer carried an error (TS default:
    /// `the supervisor could not deliver the agent message`).
    Rejected(String),
    /// The exchange was released while the request was pending.
    Released,
}

/// Guest-side outcome of feeding one journaled answer back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveOutcome {
    /// The pending request received its journaled answer.
    Resolved,
    /// No pending request knew the id (an already-timed-out request, or a
    /// replay after restart): a harmless failed dispatch, exactly like TS.
    UnknownRequestId,
}

/// One guest agent message after wire validation and dedupe, as the local
/// delivery seam receives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingCloudMessage {
    pub request_id: String,
    pub from_remote_session_id: String,
    pub target_selector: String,
    pub message: String,
}

/// What the receiver's idempotent lookup found for one request id.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentMessageLookup {
    /// The receiver recorded this request id's admission: the receipt is
    /// its delivery truth, and an uncertain request reconciles to it.
    Admitted(CloudAgentMessageReceipt),
    /// The receiver has no idempotent record for this request id. For a
    /// receiver whose inbox is keyed by request id (the production
    /// [`crate::cloud_family::LocalFamilyDelivery`]: the seam admits
    /// durably BEFORE any delivery), `Unknown` proves no delivery was
    /// ever attempted — which is what makes the wiring reconcile's
    /// re-drive safe. A receiver whose inbox is not keyed by request id
    /// answers `Unknown` for the unknowable case too: then the request
    /// stays uncertain, never re-delivered.
    Unknown,
    /// The receiver durably admitted this request id but its delivery
    /// outcome could not be resolved: the receiver may already hold the
    /// message (a crash interrupted the handling, and the resolve re-drive
    /// failed — the target unreachable, the family reach now refused).
    /// Nothing may record a negative answer from this state: the wiring
    /// retries the resolve until a verified receipt or rejection exists,
    /// and the request stays uncertain meanwhile.
    Uncertain,
}

/// A definite pre-dispatch rejection versus an attempted delivery whose
/// outcome is not yet known. Only `Rejected` may become durable `ok:false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudDeliveryError {
    Rejected(String),
    Unresolved(String),
}

/// The local-side delivery seam for cross-boundary family traffic: the
/// cloud registry attachment wires this once cloud rows join the roster.
/// The implementation owns the nuclear-family reach assert and the durable
/// local inbox admission; it returns the receiver-admitted receipt, so
/// nothing in this substrate can claim delivery on its behalf.
pub trait CloudFamilyDelivery: Send + Sync {
    /// Deliver one guest agent message into the local family. The returned
    /// definite rejection is reported to the requester verbatim (TS slices
    /// it to 2000 UTF-16 units). An unresolved attempt is NOT an answer.
    fn deliver_agent_message(
        &self,
        message: IncomingCloudMessage,
    ) -> impl Future<Output = Result<CloudAgentMessageReceipt, CloudDeliveryError>> + Send;

    /// Receiver-side idempotent receipt lookup by request id — the
    /// reconciliation seam for an uncertain request (durably admitted,
    /// answer unknown because a crash interrupted the handling): the
    /// receiver that recorded the admission answers it
    /// ([`AgentMessageLookup::Admitted`]); a request the seam never
    /// admitted answers [`AgentMessageLookup::Unknown`] (provably never
    /// attempted — safe to re-drive); a durably-admitted request whose
    /// outcome the lookup could not resolve answers
    /// [`AgentMessageLookup::Uncertain`] (the receiver may already hold
    /// the message — never a negative answer from that state).
    fn lookup_agent_message(
        &self,
        request_id: &str,
    ) -> impl Future<Output = AgentMessageLookup> + Send;

    /// Cross-boundary family rows for the requesting remote session (self,
    /// parent, siblings). An error degrades to empty rows, like the TS
    /// registry handler.
    fn family_roster(
        &self,
        for_remote_session_id: &str,
    ) -> impl Future<Output = Result<Vec<CloudFamilyRow>, String>> + Send;
}

/// The journaled-command submit seam for answers (the registry's
/// `submitResident` path): one deterministic command id per request id, so
/// a re-submitted answer dedupes at the receiver's journal.
pub trait FamilyResultSubmitter: Send + Sync {
    /// Submit one answer command under `command_id`. A repeat of the same
    /// id must be a no-op at the receiver's journal.
    fn submit_family_result(
        &self,
        command_id: &str,
        command: &CloudFamilyCommand,
    ) -> impl Future<Output = Result<(), String>> + Send;
}

/// Responder-side outcome of handling one request event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandleOutcome {
    /// Delivered through the seam; the answer is durable and submitted.
    Answered,
    /// The request was durably admitted with its outcome unknown (crash
    /// gap), and the replay reconciled it WITHOUT re-delivering: the
    /// receiver's idempotent lookup supplied the message receipt, or the
    /// roster read simply re-ran. The answer is durable and submitted.
    Reconciled,
    /// A duplicate request whose answer is already durable: the same
    /// journaled answer re-submitted, no re-delivery.
    DuplicateResubmitted,
    /// The request is durably admitted without a journaled answer: a
    /// duplicate in flight, or a crash-gap survivor (delivery may or may
    /// not have happened before the crash). Never re-delivered here; the
    /// wiring layer reconciles the uncertain set
    /// ([`CloudFamilyResponder::uncertain`]) and records the answer
    /// ([`CloudFamilyResponder::record_answer`]).
    Uncertain,
    /// The submit seam failed after the answer was recorded durably: the
    /// next replay re-submits the same answer.
    SubmitFailed(String),
}

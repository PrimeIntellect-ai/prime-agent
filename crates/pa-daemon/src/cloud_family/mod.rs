//! Cloud cross-boundary family messaging substrate.
//!
//! First slice of the cloud family design (`cloud-cross-boundary-messaging-design.md`,
//! D1/D4): the durable wire types live in `pa_types::daemon::cloud` (TS
//! protocol v3 family surface, byte parity); this module adds the journaled
//! request/response exchange and the two seams the cloud registry
//! attachment will wire:
//!
//! - [`exchange::CloudFamilyRequester`] — the guest side. A request is
//!   durably admitted (fsync) before it is awaited; the only delivery truth
//!   is a journaled answer. Offline laptop: the request rides the durable
//!   log and the send surfaces `Pending`, never a receipt.
//! - [`exchange::CloudFamilyResponder`] — the local side. The request is
//!   durably admitted (fsync) BEFORE delivery through
//!   [`exchange::CloudFamilyDelivery`] (the seam that will own the
//!   family-reach assert and the durable local inbox), the answer recorded
//!   durably before it is submitted through
//!   [`exchange::FamilyResultSubmitter`]. A replay with a journaled answer
//!   re-submits it; a replay of an admitted-but-unanswered request (crash
//!   gap, in-flight duplicate) is UNCERTAIN and never re-delivered — the
//!   wiring layer reconciles it and records the answer.
//!
//! Local->guest `send_message` (the [`pa_types::daemon::cloud::CloudSendMessageRequest`]
//! wire form) is submit-journaled by the registry attachment and requires the
//! tunnel attached; it cannot be initiated while the laptop is offline.
//! Nothing in this module fabricates delivery: no fake transport, no local
//! fallback for cloud targets, and no receipt before receiver admission.
//!
//! Local family messaging (`agent_messaging.rs`, supervisor `send_message`)
//! is untouched; the existing e2e harnesses stay the regression gate.

pub mod exchange;
pub mod log;

pub use exchange::{
    AgentMessageLookup, CloudFamilyDelivery, CloudFamilyRequestError, CloudFamilyRequestOutcome,
    CloudFamilyRequester, CloudFamilyResponder, FamilyResultSubmitter, HandleOutcome,
    IncomingCloudMessage, ResolveOutcome,
};
pub use log::{Admission, FamilyRequestLog, FamilyResultLog};

/// Pending-request window before a send surfaces `Pending` (TS
/// `REMOTE_REQUEST_TIMEOUT_MS`).
pub const REMOTE_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Durable request-log record cap (TS outbox `DEFAULT_MAX_RECORDS`): a full
/// unacked log stalls honestly.
pub const DEFAULT_OUTBOX_RECORDS: usize = 50_000;
/// Guest request-id prefixes (TS `cloud-daemon.ts`): `msgreq_` /
/// `famreq_`.
pub const MESSAGE_REQUEST_PREFIX: &str = "msgreq_";
pub const ROSTER_REQUEST_PREFIX: &str = "famreq_";

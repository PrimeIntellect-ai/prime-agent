//! The production cross-boundary delivery seam: one cloud family agent
//! message delivered into the LOCAL family through the real supervisor
//! (the registry, the roster, the worker route), with the receiver-side
//! idempotent admission keyed by the guest request id.
//!
//! Three layers make a duplicate impossible:
//!
//! 1. The seam inbox ([`CloudInboxLog`]) durably binds the request id to
//!    its delivery parameters before the delivery is attempted, and the
//!    receiver-admitted receipt after the target answered — the
//!    reconcile truth for both crash gaps.
//! 2. The receiver inbox (the worker's `cloud_inbox_admission`) admits
//!    the request id in the SAME flush as the queue snapshot that made
//!    the message visible — so a re-drive of an admitted request id can
//!    never produce a second visible message.
//! 3. [`CloudFamilyDelivery::lookup_agent_message`] reconciles: a
//!    recorded receipt answers `Admitted` without re-delivering, and an
//!    admitted-without-receipt request (a crash interrupted the first
//!    handling) is re-driven — safely, because the receiver inbox
//!    dedupes — and the fresh receipt answers `Admitted`.
//!
//! Family reach is asserted over the real roster rows (the durable
//! parent edges): the source resolves like the TS registry
//! (`resolveActive`, by active session id or session id) and the target
//! like the TS supervisor (`findWorker`, by any accepted selector), and
//! the pure TS policy ([`crate::cloud_family::family`]) decides
//! parent/sibling/child. No fabricated transport: the delivery rides
//! the same `worker_deliver_message` route the local supervisor arm
//! uses, and a receipt exists only after the target admitted the
//! message.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pa_types::daemon::cloud::{CloudAgentMessageReceipt, CloudFamilyRow, CloudFamilyRowStatus};
use serde_json::{json, Map, Value};

use pa_types::daemon::cloud::{CloudFamilyEvent, CloudFamilyEventPayload};

use super::family::{agent_family_relationship, family_row_from_summary, AGENT_FAMILY_REACH_ERROR};
use super::inbox::CloudInboxLog;
use super::{AgentMessageLookup, CloudDeliveryError, CloudFamilyDelivery, IncomingCloudMessage};
use crate::lease::canonical_session_path;
use crate::registry::ResidentWorker;
use crate::supervisor::Supervisor;
use std::path::Path;

/// The worker round-trip budget for the delivery route (TS
/// `WORKER_REQUEST_TIMEOUT_MS`).
const WORKER_REQUEST_TIMEOUT_MS: u64 = 30_000;

/// The production [`CloudFamilyDelivery`]: the real supervisor's
/// registry, roster, and worker route, plus the seam's request-id keyed
/// durable inbox journal.
pub struct LocalFamilyDelivery {
    supervisor: Arc<Supervisor>,
    inbox: Mutex<CloudInboxLog>,
}

impl LocalFamilyDelivery {
    /// Build the delivery seam over the live supervisor, with the inbox
    /// journal at `inbox_path` (the cloud registry attachment owns the
    /// placement; the journal survives supervisor restarts).
    ///
    /// # Errors
    ///
    /// Returns an error when the inbox journal cannot be opened.
    pub fn new(supervisor: Arc<Supervisor>, inbox_path: PathBuf) -> anyhow::Result<Self> {
        Ok(Self {
            supervisor,
            inbox: Mutex::new(CloudInboxLog::open(&inbox_path)?),
        })
    }

    /// Deliver one cross-boundary message, idempotently by request id.
    async fn deliver_idempotent(
        &self,
        message: &IncomingCloudMessage,
    ) -> Result<CloudAgentMessageReceipt, CloudDeliveryError> {
        // The recorded receipt is the delivery truth: a duplicate event
        // (a wire replay) answers it without any new delivery.
        {
            let mut inbox = self.locked_inbox();
            if let Some(receipt) = inbox.receipt(&message.request_id) {
                return Ok(receipt);
            }
            // Durable admission BEFORE the delivery (the crash-gap
            // protocol): the re-drive input survives the crash.
            inbox.admit(message).map_err(|error| {
                CloudDeliveryError::Rejected(format!("admit {}: {error:#}", message.request_id))
            })?;
        }
        let receipt = self.deliver_to_local_family(message).await?;
        {
            let mut inbox = self.locked_inbox();
            inbox
                .record_receipt(&message.request_id, receipt.clone())
                .map_err(|error| {
                    CloudDeliveryError::Unresolved(format!(
                        "record the receipt for {}: {error:#}",
                        message.request_id
                    ))
                })?;
        }
        Ok(receipt)
    }

    /// The TS `deliverCloudAgentMessage` local arm: resolve the source
    /// and the target from the real registry and roster, assert the
    /// nuclear-family reach, and route `worker_deliver_message` with the
    /// idempotency key.
    async fn deliver_to_local_family(
        &self,
        message: &IncomingCloudMessage,
    ) -> Result<CloudAgentMessageReceipt, CloudDeliveryError> {
        // The source resolves first, like the TS registry handler
        // (`resolveActive`): an unknown source answers with the TS error.
        let source_summary = self
            .remote_summary(&message.from_remote_session_id)
            .ok_or_else(|| {
                CloudDeliveryError::Rejected(format!(
                    "Unknown cloud message source: {}",
                    message.from_remote_session_id
                ))
            })?;
        let target = self
            .supervisor
            .registry
            .resolve(&message.target_selector)
            .await
            .map_err(|error| CloudDeliveryError::Rejected(error.to_string()))?;
        let target_summary = self
            .target_summary(&target, &message.target_selector)
            .await
            .map_err(CloudDeliveryError::Rejected)?;
        let source_row = family_row_from_summary(&source_summary);
        let target_row = family_row_from_summary(&target_summary);
        // The nuclear-family reach assert (TS `assertAgentFamilyReach`).
        if agent_family_relationship(&source_row, &target_row).is_none() {
            return Err(CloudDeliveryError::Rejected(
                AGENT_FAMILY_REACH_ERROR.to_string(),
            ));
        }
        // The TS self-target guard.
        let source_active = source_summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .or_else(|| source_summary.get("id").and_then(Value::as_str))
            .unwrap_or_default();
        // TS `target.summary.activeSessionId ?? target.summary.id`.
        let target_active = target_summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .or_else(|| target_summary.get("id").and_then(Value::as_str))
            .unwrap_or_default();
        if source_active == target_active {
            return Err(CloudDeliveryError::Rejected(
                "Agent messaging cannot target the sending session".to_string(),
            ));
        }
        // The TS sender block for a cloud source: the endpoint fields,
        // no parent edges (the local arm of `deliverCloudAgentMessage`).
        let mut sender = json!({
            "activeSessionId": source_active,
            "sessionId": source_summary
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "runtimeKind": source_summary
                .get("runtimeKind")
                .and_then(Value::as_str)
                .unwrap_or("top-level"),
        });
        if let Some(name) = source_summary
            .get("sessionName")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        {
            sender["sessionName"] = json!(name);
        }
        let mut rest = Map::new();
        rest.insert("cloudRequestId".to_string(), json!(message.request_id));
        let delivery = pa_types::daemon::DaemonWorkerCommand::WorkerDeliverMessage {
            id: None,
            target_active_session_id: target_active.to_string(),
            message: message.message.clone(),
            sender,
            delivery_mode: None,
            rest,
        };
        let payload = serde_json::to_value(&delivery).map_err(|error| {
            CloudDeliveryError::Rejected(format!("invalid delivery command: {error}"))
        })?;
        let response = self
            .supervisor
            .route_command_typed(
                &target,
                "worker_deliver_message",
                payload,
                WORKER_REQUEST_TIMEOUT_MS,
                crate::backpressure::RouteAdmission::SupervisorInternal,
            )
            .await
            .map_err(|error| CloudDeliveryError::Unresolved(error.to_string()))?;
        if !response.success {
            let error = response
                .error
                .unwrap_or_else(|| "delivery failed".to_string());
            return Err(if error.starts_with(super::CLOUD_COMMIT_UNCERTAIN) {
                CloudDeliveryError::Unresolved(error)
            } else {
                CloudDeliveryError::Rejected(error)
            });
        }
        let data = response.data.unwrap_or(Value::Null);
        // TS receipt validation: `id` and `deliveryStatus` must be
        // strings, else the TS invalid-receipt error.
        if data.get("id").and_then(Value::as_str).is_none()
            || data.get("deliveryStatus").and_then(Value::as_str).is_none()
        {
            return Err(CloudDeliveryError::Unresolved(
                "Session worker returned an invalid agent-message receipt".to_string(),
            ));
        }
        serde_json::from_value::<CloudAgentMessageReceipt>(data).map_err(|_| {
            CloudDeliveryError::Unresolved(
                "Session worker returned an invalid agent-message receipt".to_string(),
            )
        })
    }

    /// One remote session's roster summary (TS `resolveActive`): by its
    /// active session id first, then by its session id (the roster agent
    /// id of a top-level row).
    fn remote_summary(&self, remote_session_id: &str) -> Option<Value> {
        let roster = self
            .supervisor
            .roster
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        roster
            .by_active_session_id(remote_session_id)
            .or_else(|| roster.get(remote_session_id))
            .map(|entry| entry.summary.clone())
    }

    /// The resolved target's roster summary (the TS `findWorker`
    /// target: the roster entry of the resident's root session).
    async fn target_summary(
        &self,
        target: &Arc<ResidentWorker>,
        selector: &str,
    ) -> Result<Value, String> {
        let (root_active_session_id, _, _) = target.labels().await;
        let roster = self
            .supervisor
            .roster
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        roster
            .by_active_session_id(&root_active_session_id)
            .map(|entry| entry.summary.clone())
            .ok_or_else(|| format!("Unknown active session: {selector}"))
    }

    fn locked_inbox(&self) -> std::sync::MutexGuard<'_, CloudInboxLog> {
        self.inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl CloudFamilyDelivery for LocalFamilyDelivery {
    async fn deliver_agent_message(
        &self,
        message: IncomingCloudMessage,
    ) -> Result<CloudAgentMessageReceipt, CloudDeliveryError> {
        self.deliver_idempotent(&message).await
    }

    /// The reconciliation lookup: the recorded receipt answers
    /// `Admitted`; an admitted-without-receipt request (a crash
    /// interrupted the first handling) is re-driven — safe, because the
    /// receiver inbox dedupes by request id — and its fresh receipt
    /// answers `Admitted`; a request this seam never admitted answers
    /// `Unknown` (provably never attempted — the seam admits durably
    /// BEFORE any delivery); an admitted request whose outcome the
    /// re-drive could not resolve answers `Uncertain` — the receiver
    /// may already hold the message, so nothing downstream may record a
    /// negative answer from that state.
    async fn lookup_agent_message(&self, request_id: &str) -> AgentMessageLookup {
        let (admission, receipt) = {
            let inbox = self.locked_inbox();
            (inbox.admission(request_id), inbox.receipt(request_id))
        };
        if let Some(receipt) = receipt {
            return AgentMessageLookup::Admitted(receipt);
        }
        let Some(message) = admission else {
            return AgentMessageLookup::Unknown;
        };
        match self.deliver_idempotent(&message).await {
            Ok(receipt) => AgentMessageLookup::Admitted(receipt),
            // The re-drive failed (the target is gone, the reach is now
            // refused): the request WAS durably admitted at this seam,
            // so the receiver may already hold the message. Answer
            // `Uncertain` — never `Unknown` (which reads as
            // never-attempted and would let the wiring re-drive into a
            // durable negative answer for a delivered message) and never
            // a fabricated receipt.
            Err(_) => AgentMessageLookup::Uncertain,
        }
    }

    /// The TS `cloudFamilyRowsFor` port over the real roster: the
    /// requesting remote session's own row, its parent (through the
    /// durable session-file edge), and its siblings (same parent file,
    /// same depth). A session without a parent edge answers its own row
    /// alone (TS returns early); a resolution failure degrades to empty
    /// rows.
    async fn family_roster(
        &self,
        for_remote_session_id: &str,
    ) -> Result<Vec<CloudFamilyRow>, String> {
        let Some(source_summary) = self.remote_summary(for_remote_session_id) else {
            return Ok(Vec::new());
        };
        let roster = self
            .supervisor
            .roster
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let self_row = family_row_from_summary(&source_summary);
        let mut rows = vec![self_row.clone()];
        let Some(parent_path) = self_row.parent_session_path.clone() else {
            return Ok(rows);
        };
        // The parent row: the roster entry for the parent's session
        // file, else the bare file identity (TS falls back to the spawn
        // record's parent id, then the file name).
        if let Some(parent) = roster.by_session_file(&parent_path) {
            let parent_row = family_row_from_summary(&parent.summary);
            rows.push(parent_row);
        } else {
            let file_name = std::path::Path::new(&parent_path).file_name().map_or_else(
                || parent_path.clone(),
                |name| name.to_string_lossy().to_string(),
            );
            rows.push(CloudFamilyRow {
                id: file_name,
                name: None,
                depth: self_row.depth.saturating_sub(1),
                status: CloudFamilyRowStatus::Running,
                parent_session_id: None,
                parent_session_path: None,
                session_path: Some(parent_path.clone()),
            });
        }
        // Siblings: same parent file, same depth, any runtime kind (the
        // scan runs whatever the parent lookup found, exactly like TS).
        let self_session_id = source_summary
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        for entry in roster.entries() {
            let summary = entry.summary;
            if summary.get("sessionId").and_then(Value::as_str) == Some(self_session_id) {
                continue;
            }
            let depth = summary
                .get("rlmDepth")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| {
                    usize::from(
                        summary
                            .get("parentSessionPath")
                            .and_then(Value::as_str)
                            .is_some_and(|path| !path.is_empty()),
                    )
                    .try_into()
                    .unwrap_or(0)
                });
            if depth != self_row.depth {
                continue;
            }
            let sibling_parent = summary
                .get("parentSessionPath")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .map(|path| {
                    canonical_session_path(Path::new(path))
                        .to_string_lossy()
                        .to_string()
                });
            if sibling_parent.as_deref() != Some(parent_path.as_str()) {
                continue;
            }
            rows.push(family_row_from_summary(&summary));
        }
        Ok(rows)
    }
}

/// The wiring layer's uncertain-request reconcile (TS parity for the
/// outcome, Rust parity for the crash gaps the TS side cannot close): one
/// pass over the responder's admitted-without-answer ids, driving each
/// through the receiver's idempotent seam and recording the answer so
/// the next replay re-submits it. Two crash gaps close here:
///
/// - A receiver that recorded the admission answers the LOOKUP with the
///   recorded receipt — no re-delivery, no duplicate visible message.
/// - A request the seam never admitted was provably never attempted
///   (the seam admits durably BEFORE any delivery), so re-delivering is
///   safe — and the receiver inbox dedupes by request id, so even an
///   in-flight first attempt cannot double-deliver.
///
/// Returns the reconcile outcome: the ids whose answers are now DURABLE
/// (the next replay re-submits them without delivery) and the ids that
/// stayed unanswered — an unresolvable seam state (the receiver may
/// already hold the message: never converted to a negative answer), a
/// missing event payload, or a failed answer append. The unanswered set
/// stays uncertain for the next pass.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct UncertainReconcile {
    /// Request ids whose answers are durably recorded.
    pub reconciled: Vec<String>,
    /// Request ids still admitted-without-answer (retry the next pass).
    pub unanswered: Vec<String>,
}
pub async fn reconcile_uncertain<D: CloudFamilyDelivery>(
    responder: &crate::cloud_family::CloudFamilyResponder,
    delivery: &D,
    events: &[CloudFamilyEvent],
) -> UncertainReconcile {
    use pa_types::daemon::cloud::{CloudFamilyCommand, CloudFamilyCommandPayload};

    let uncertain = responder.uncertain();
    let mut outcome = UncertainReconcile::default();
    for request_id in uncertain {
        // The replayed event carrying the payload (an id whose event is
        // not in this batch stays for the next pass).
        let Some(event) = events.iter().find(|event| event.request_id() == request_id) else {
            outcome.unanswered.push(request_id);
            continue;
        };
        let CloudFamilyEventPayload::AgentMessageRequest {
            request_id,
            from_remote_session_id,
            target_selector,
            message,
        } = &event.payload
        else {
            outcome.unanswered.push(request_id);
            continue;
        };
        let incoming = IncomingCloudMessage {
            request_id: request_id.clone(),
            from_remote_session_id: from_remote_session_id.clone(),
            target_selector: target_selector.clone(),
            message: message.clone(),
        };
        let answer = match delivery.lookup_agent_message(request_id).await {
            // The receiver admitted: its receipt is the delivery truth.
            AgentMessageLookup::Admitted(receipt) => Some((true, Some(receipt), None)),
            // The seam never admitted this id: no delivery was ever
            // attempted through it — re-drive safely. A failure of the
            // fresh attempt is the honest negative (nothing was ever
            // visible), exactly like the responder's own delivery-error
            // arm (TS `handleAgentMessageRequest`'s catch).
            AgentMessageLookup::Unknown => match delivery.deliver_agent_message(incoming).await {
                Ok(receipt) => Some((true, Some(receipt), None)),
                Err(CloudDeliveryError::Rejected(error)) => Some((false, None, Some(error))),
                Err(CloudDeliveryError::Unresolved(_)) => None,
            },
            // The seam durably admitted but the outcome could not be
            // resolved: the receiver may already hold the message, so
            // NEVER a durable answer from this state — it stays
            // uncertain for the next pass, until a verified receipt or
            // rejection exists.
            AgentMessageLookup::Uncertain => None,
        };
        let Some((ok, receipt, error)) = answer else {
            outcome.unanswered.push(request_id.clone());
            continue;
        };
        // Only a durably-recorded answer reconciles the request: a
        // failed answer append leaves it admitted-without-answer for the
        // next pass (never reported as reconciled).
        if responder
            .record_answer(CloudFamilyCommand {
                payload: CloudFamilyCommandPayload::AgentMessageResult {
                    request_id: request_id.clone(),
                    ok,
                    receipt,
                    error,
                },
            })
            .is_err()
        {
            outcome.unanswered.push(request_id.clone());
            continue;
        }
        outcome.reconciled.push(request_id.clone());
    }
    outcome
}

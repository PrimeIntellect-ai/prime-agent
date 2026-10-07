//! Parent-owned terminal-notice inbox: one durable row, one live delivery,
//! and one coalesced wake pump per session (never one task per notice).

use std::sync::Arc;

use pa_agent::admission::{AdmitStatus, QueuedAdmission};
use pa_agent::agent::Agent;
use pa_types::session::CustomMessage;

use super::AgentSession;

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalGatePoint {
    RowDurable { key: String },
    AssistantBeforePersist { keys: Vec<String> },
    AssistantBeforeMarker { keys: Vec<String> },
}

#[cfg(test)]
pub(crate) type TerminalTestGate = Arc<
    dyn Fn(TerminalGatePoint) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

#[cfg(test)]
pub(crate) type TerminalGateSlot = Arc<std::sync::RwLock<Option<TerminalTestGate>>>;

#[cfg(test)]
pub(crate) async fn pause_terminal_gate(slot: &TerminalGateSlot, point: TerminalGatePoint) {
    let gate = slot.read().expect("terminal test gate lock").clone();
    if let Some(gate) = gate {
        gate(point).await;
    }
}

#[derive(Debug, thiserror::Error)]
#[error("the parent session generation is closed")]
pub(crate) struct ClosedTerminalGeneration;

#[derive(Debug, thiserror::Error)]
#[error("terminal notice belongs to a different parent session generation")]
pub(crate) struct MismatchedTerminalGeneration;

impl AgentSession {
    /// Admit the winning child's row into this exact parent generation.
    /// Disk admission and live registration are serial under the session
    /// admission lock; a failed step leaves the child unpublished for retry.
    pub(crate) async fn admit_terminal_notice(
        &self,
        parent_session_id: &str,
        child_id: &str,
        row: &CustomMessage,
    ) -> anyhow::Result<()> {
        let mut admission = self.terminal_admission.lock().await;
        if admission.closed {
            return Err(ClosedTerminalGeneration.into());
        }
        let mut row = row.clone();
        let key = format!("{parent_session_id}:{child_id}");
        let mut session = self.session.lock().await;
        if session.get_session_id() != parent_session_id {
            return Err(MismatchedTerminalGeneration.into());
        }
        row.details
            .get_or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("terminal notice details must be an object"))?
            .insert(
                "noticeKey".to_string(),
                serde_json::Value::String(key.clone()),
            );
        session.append_terminal_notice(&row)?;
        drop(session);
        #[cfg(test)]
        pause_terminal_gate(
            &self.terminal_test_gate,
            TerminalGatePoint::RowDurable { key: key.clone() },
        )
        .await;
        if admission.registered.contains(&key) {
            return Ok(());
        }
        let batch = self.injected_prompt_messages(&row).await?;
        // The atomic pa-agent decision owns the streaming/idle boundary.
        // Busy queues steering; idle starts a notice-only run; the final
        // steering-poll race is closed by its stateful idle wake.
        match self
            .agent
            .admit_or_enqueue(pa_agent::agent::AgentMessageBatch::Batch(batch))
        {
            AdmitStatus::Admitted | AdmitStatus::Busy => {
                admission.registered.insert(key);
                Ok(())
            }
        }
    }

    /// Strictly retain one explicit child reply before accepting it into
    /// the parent's live agent. The reply's stable `details.id` is the
    /// file-backed settle proof for a no-notice `DoneReplied` claim.
    pub(crate) async fn admit_durable_reply(
        &self,
        row: &CustomMessage,
    ) -> anyhow::Result<AdmitStatus> {
        let mut admission = self.terminal_admission.lock().await;
        if admission.closed {
            return Err(ClosedTerminalGeneration.into());
        }
        let id = row
            .details
            .as_ref()
            .and_then(|details| details.get("id"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("explicit reply lacks a stable id"))?;
        self.session.lock().await.append_agent_message(row)?;
        self.pre_synced_reply_ids
            .lock()
            .expect("pre-synced reply lock")
            .insert(id.to_string());
        if admission.registered_replies.contains(id) {
            return Ok(AdmitStatus::Busy);
        }
        let batch = self.injected_prompt_messages(row).await?;
        let status = self
            .agent
            .admit_or_enqueue(pa_agent::agent::AgentMessageBatch::Batch(batch));
        admission.registered_replies.insert(id.to_string());
        Ok(status)
    }

    /// Re-admit from the original JSONL rows after binding an engine. The
    /// manager's stable-key append is idempotent: replay never writes a
    /// second notice row. A synced notice without a consumed marker remains
    /// pending even if an earlier model request may already have seen it.
    pub(crate) async fn replay_terminal_notices(&self) -> anyhow::Result<()> {
        let (session_id, notices) = {
            let session = self.session.lock().await;
            (
                session.get_session_id().to_string(),
                session.unconsumed_terminal_notices()?,
            )
        };
        let admission = self.terminal_admission.lock().await;
        let replay_keys: std::collections::HashSet<&str> = notices
            .iter()
            .map(|(key, _)| key.as_str())
            .filter(|key| !admission.registered.contains(*key))
            .collect();
        if !replay_keys.is_empty() {
            let messages = self.agent.state().await.messages;
            self.agent
                .set_messages(
                    messages
                        .into_iter()
                        .filter(|message| match message {
                            pa_agent::types::AgentMessage::Custom(custom) => !custom
                                .payload
                                .get("details")
                                .and_then(|details| details.get("noticeKey"))
                                .and_then(serde_json::Value::as_str)
                                .is_some_and(|key| replay_keys.contains(key)),
                            pa_agent::types::AgentMessage::Standard(_) => true,
                        })
                        .collect(),
                )
                .await;
        }
        drop(admission);
        for (_, row) in notices {
            let child_id = row
                .details
                .as_ref()
                .and_then(|details| details.get("childId"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("terminal notice lacks childId"))?;
            self.admit_terminal_notice(&session_id, child_id, &row)
                .await?;
        }
        Ok(())
    }
}

/// One session-owned, coalescing pump. The watch is stateful: a queue
/// remaining after the run's last steering poll remains armed until this
/// task has started a queued turn (without a fabricated user prompt).
pub(super) fn start_pump(agent: Arc<Agent>, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        let mut wake = agent.idle_queued_wake();
        loop {
            if *shutdown.borrow() {
                break;
            }
            if !*wake.borrow_and_update() {
                tokio::select! {
                    changed = wake.changed() => { if changed.is_err() { break; } }
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow_and_update() { break; }
                    }
                }
                continue;
            }
            match agent.admit_queued_turn() {
                QueuedAdmission::Admitted | QueuedAdmission::Busy => {
                    tokio::select! {
                        () = agent.wait_for_idle() => {}
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow_and_update() { break; }
                        }
                    }
                }
                QueuedAdmission::Empty => {}
            }
        }
    });
}

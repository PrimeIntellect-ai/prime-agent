//! Namespaced `_meta` payloads for prime-agent capabilities that ACP has no
//! native concept for (cwd reporting, quiescence observation, correlation).
//!
//! ACP reserves `_meta` on capability objects, notifications, and content
//! blocks so agents can carry non-standard data. Vanilla ACP clients ignore
//! these keys; a prime-agent-aware client reads them. Non-standard fields
//! never appear at an ACP object root.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Reverse-domain namespace for every prime-agent `_meta` payload.
pub const PRIME_AGENT_META_NAMESPACE: &str = "ai.primeintellect.prime-agent";

/// A client-requested cwd that differs from the agent's actual startup cwd.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrimeAgentCwdMeta {
    pub requested: String,
    pub actual: String,
}

/// Observed subagent and autonomous-continuation counts at a completion point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentQuiescenceMeta {
    pub outstanding_subagents: u64,
    pub remaining_autonomous_continuations: u64,
}

/// Producer-side ordering of an update inside its prompt turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrimeAgentEventPhase {
    /// Ordinary streamed work.
    #[serde(rename = "event")]
    Event,
    /// The correlated boundary in front of a prompt response.
    #[serde(rename = "responseBoundary")]
    ResponseBoundary,
    /// The final settled state after the response boundary.
    #[serde(rename = "terminalQuiescence")]
    TerminalQuiescence,
}

/// The outcome carried by a response boundary and terminal envelope. ACP
/// transport stop reasons (including `end_turn`) are never a causal
/// completion signal, so this is deliberately only `result` and `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrimeAgentOutcome {
    #[serde(rename = "result")]
    Result,
    #[serde(rename = "error")]
    Error,
}

/// The prime-agent payload under the `_meta` namespace key.
///
/// `prompt_turn_id` is allocated when ACP accepts a prompt, never inferred
/// from whichever prompt happens to be running when an update is delivered;
/// `0` means a session-scoped event with no prompt origin. `event_sequence`
/// is connection-wide and strictly increases for every published update.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentSessionMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_turn_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<PrimeAgentEventPhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<PrimeAgentOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_quiescence_expected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PrimeAgentCwdMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quiescence: Option<PrimeAgentQuiescenceMeta>,
    /// Rich kernel output reported by the ipython tool (attachments the cell
    /// loaded into context, plus the number of diffs it displayed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipython: Option<Value>,
    /// Set when the session's heartbeat or cron schedule changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heartbeats_changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<PrimeAgentGoalMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refinement: Option<PrimeAgentRefinementMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_message: Option<PrimeAgentAgentMessageMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction: Option<PrimeAgentCompactionMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<PrimeAgentSubagentMeta>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autonomous: Option<PrimeAgentAutonomousMeta>,
}

/// A goal's live state, surfaced after `/goal` commands and driver turns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentGoalMeta {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_used: Option<u64>,
}

/// The outcome of one continual-harness refinement run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentRefinementMeta {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An agent-to-agent message sent from inside a kernel cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentAgentMessageMeta {
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
}

/// One compaction that ran during the session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentCompactionMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// One RLM subagent roster row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentSubagentMeta {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Autonomous-mode accounting surfaced with a turn's completion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeAgentAutonomousMeta {
    pub enabled: bool,
    pub continuations_used: u64,
    pub turns_used: u64,
    pub tokens_used: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_attempt: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reason: Option<String>,
}

/// The `_meta.autonomous` accounting for a completion update: per-run usage
/// plus the latest gate attempt and failure (TS `autonomousMeta` in
/// acp-mode.ts). Shared by the in-process and daemon-attached settlements.
pub fn autonomous_meta(
    status: &pa_core::autonomous::AgentAutonomousStatus,
) -> PrimeAgentAutonomousMeta {
    let gate_attempt = std::iter::once(
        status
            .last_gate_failure
            .as_ref()
            .map_or(0, |failure| failure.attempt),
    )
    .chain(status.gate_attempts.values().copied())
    .max()
    .unwrap_or(0);
    PrimeAgentAutonomousMeta {
        enabled: status.enabled,
        continuations_used: status.continuations_used,
        turns_used: status.turns_used,
        tokens_used: status.tokens_used,
        gate_attempt: (gate_attempt > 0).then_some(gate_attempt),
        gate_failure: status
            .last_gate_failure
            .as_ref()
            .map(|failure| failure.exit_text.clone()),
        limit_reason: None,
    }
}

/// Map a finished turn onto an ACP stop reason (TS `acpStopReason` in
/// acp-stop-reason.ts: autonomous quality gates deliberately never surface
/// as a stop reason; token exhaustion is the one natively-expressed limit).
pub fn acp_stop_reason_for_status(
    cancelled: bool,
    status: Option<&pa_core::autonomous::AgentAutonomousStatus>,
) -> super::types::AcpStopReason {
    use pa_core::autonomous::{autonomous_limit_reason_of_status, AutonomousLimitReason};
    if cancelled {
        return super::types::AcpStopReason::Cancelled;
    }
    let Some(status) = status else {
        return super::types::AcpStopReason::EndTurn;
    };
    if !status.enabled {
        return super::types::AcpStopReason::EndTurn;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    match autonomous_limit_reason_of_status(status, now) {
        Some(AutonomousLimitReason::MaxTokens) => super::types::AcpStopReason::MaxTokens,
        Some(_) => super::types::AcpStopReason::MaxTurnRequests,
        None => super::types::AcpStopReason::EndTurn,
    }
}

/// Wrap a prime-agent payload in its reverse-domain `_meta` envelope.
pub fn prime_agent_meta(payload: PrimeAgentSessionMeta) -> Value {
    json!({ PRIME_AGENT_META_NAMESPACE: payload })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_wraps_under_the_namespace_key() {
        let wrapped = prime_agent_meta(PrimeAgentSessionMeta {
            prompt_turn_id: Some(1),
            event_sequence: Some(2),
            phase: Some(PrimeAgentEventPhase::ResponseBoundary),
            outcome: Some(PrimeAgentOutcome::Error),
            ..Default::default()
        });
        assert_eq!(
            wrapped,
            json!({ "ai.primeintellect.prime-agent": {
                "promptTurnId": 1,
                "eventSequence": 2,
                "phase": "responseBoundary",
                "outcome": "error",
            }})
        );
    }

    #[test]
    fn quiescence_serializes_camel_case() {
        let wrapped = prime_agent_meta(PrimeAgentSessionMeta {
            quiescence: Some(PrimeAgentQuiescenceMeta {
                outstanding_subagents: 0,
                remaining_autonomous_continuations: 0,
            }),
            ..Default::default()
        });
        assert_eq!(
            wrapped[PRIME_AGENT_META_NAMESPACE]["quiescence"],
            json!({ "outstandingSubagents": 0, "remainingAutonomousContinuations": 0 })
        );
    }
}

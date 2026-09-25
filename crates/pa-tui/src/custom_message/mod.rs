//! Custom-message chat rows: the decorated transcript surfaces for
//! `role: "custom"` wire messages (TS `agent-message.ts`,
//! `injected-prompt-message.ts`, `compaction-outcome-message.ts`,
//! `refinement-outcome-message.ts`, `shell-completion.ts`, and the generic
//! `custom-message.ts` box) plus the user-message skill-invocation card
//! (TS `skill-invocation-message.ts`, parsed out of a user message's
//! `<skill>` block). Decode maps every custom type to the component
//! the TS dispatch (`createDisplayedCustomMessageComponent` /
//! `buildConversationComponents`) picks; rendering ports each component's
//! row geometry and theme colors.
//!
//! Rendering lives in the sibling modules (`render` for most components,
//! `injected_prompt` for the injected-prompt rows, `refinement` for the
//! refinement-outcome component).
//!
//! The dispatch follows the TS live path
//! (`createDisplayedCustomMessageComponent`): non-display rows render
//! nothing, every displayed type without a dedicated component (engine
//! bookkeeping like `harness_digest`, unknown types) renders the generic
//! `[<customType>]` box. (The TS replay path `buildConversationComponents`
//! drops unknown types instead; the live interactive path is the TUI ground
//! truth, and the Rust engine persists those types with `display: false`.)

pub(crate) mod geometry;
pub(crate) use geometry::agent_message_body_count;
pub(crate) mod injected_prompt;
pub(crate) mod refinement;
pub(crate) mod render;
pub mod skill_invocation;

pub use skill_invocation::{skill_invocation_entries, SkillInvocationRow};

use injected_prompt::injected_prompt_row;
pub use injected_prompt::{InjectedPromptKind, InjectedPromptRow, RlmChildOutcome};

use crate::chat::{ChatEntry, StatusKind};
use crate::theme::ThemeColor;
use serde_json::Value;

/// Custom types with a dedicated component (TS constants; pa-core owns the
/// engine-side vocabulary, the render dispatch owns these).
pub const AGENT_MESSAGE_CUSTOM_TYPE: &str = "agent_message";
pub const HEARTBEAT_PROMPT_CUSTOM_TYPE: &str = "heartbeat_prompt";
pub const GOAL_CONTEXT_CUSTOM_TYPE: &str = "goal_context";
pub const IPYTHON_STATE_RESTORED_CUSTOM_TYPE: &str = "ipython_state_restored";
pub const RLM_CHILD_FAILURE_CUSTOM_TYPE: &str = "rlm_child_failure";
pub const RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE: &str = "rlm_child_terminal_notice";
pub const ASYNC_BASH_COMPLETION_CUSTOM_TYPE: &str = "async_bash_completion";
pub const COMPACTION_OUTCOME_CUSTOM_TYPE: &str = "compaction_outcome";
pub const REFINEMENT_OUTCOME_CUSTOM_TYPE: &str = "refinement_outcome";
/// The durable single-line outcome of one provider-retry episode (SANCTIONED
/// DIVERGENCE, operator ruling 2026-09-23: one resolved/terminal row per
/// episode instead of the per-attempt error rows TS keeps). Wire twin of
/// `pa_core::session_engine::messages::PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE`.
pub const PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE: &str = "provider_retry_outcome";

// ---------------------------------------------------------------------------
// Row payloads (carried by ChatEntry variants)
// ---------------------------------------------------------------------------

/// Which agent-message side a row renders: the received label of the
/// transcript custom-message rows (TS `AgentMessageComponent`), or the
/// sent/queued receipt labels of the ipython cell output (TS
/// `renderSentAgentMessages`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMessageDirection {
    /// `Agent message received` (the transcript custom-message rows).
    Received,
    /// `Agent message sent` (a delivered receipt in ipython cell output).
    Sent,
    /// `Agent message queued` (an undelivered receipt in ipython cell output).
    Queued,
}

impl AgentMessageDirection {
    /// The summary-line label (TS labels in `agent-message.ts` and
    /// `ipython-cell.ts`).
    pub fn label(self) -> &'static str {
        match self {
            AgentMessageDirection::Received => "Agent message received",
            AgentMessageDirection::Sent => "Agent message sent",
            AgentMessageDirection::Queued => "Agent message queued",
        }
    }
}

/// One agent-message summary row: `✉ <label> · <participant>[ · <preview>]`
/// plus the guttered body when expanded (TS `AgentMessageComponent` for
/// received rows; the sent/queued directions feed the ipython cell
/// receipt rows). The `✉` mail envelope is the row's icon — a sanctioned
/// divergence (Kevin directive 2026-09-24) from the TS `◆` diamond; the
/// TS side is expected to adopt the same glyph.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentMessageRow {
    /// Which side renders: the label text follows it.
    pub direction: AgentMessageDirection,
    /// `from <role> <name>` / `to <role> <name>` (TS
    /// `formatAgentMessageParticipant`).
    pub participant: String,
    /// `details.message` (the collapsed preview source and the body shown
    /// expanded).
    pub message: String,
}

/// One background-shell completion row (TS `ShellCompletionComponent`,
/// standalone form: the completion attaches to a tool card only in the TS
/// live path, which the Rust engine does not emit).
#[derive(Debug, Clone, PartialEq)]
pub struct ShellCompletionRow {
    pub pid: Option<i64>,
    pub exit_code: Option<i64>,
    /// Raw content (`[bash-done pid:N exit:M] ...`).
    pub content: String,
}

/// One refinement outcome row (TS `RefinementOutcomeMessageComponent`).
#[derive(Debug, Clone, PartialEq)]
pub struct RefinementOutcomeRow {
    /// `◆ <header>` (`Harness refined` or the full outcome line).
    pub header: String,
    /// Summary text (collapsed: two-line clamp).
    pub summary: String,
    /// `<outcome> · Refinement <id> · <scope>[ · rollback of <id>]` (dim).
    pub meta: String,
    pub edits: Vec<RefinementEditRow>,
}

/// One applied-edit section of a refinement outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct RefinementEditRow {
    /// Label spans: the verb (or the whole failed line) carries its color.
    pub label: Vec<LabelPart>,
    pub reason: Option<String>,
    /// Expanded detail fields (label + plain value or removed/added change).
    pub fields: Vec<EditField>,
}

/// One label span: text plus an optional theme color.
#[derive(Debug, Clone, PartialEq)]
pub struct LabelPart {
    pub text: String,
    pub color: Option<ThemeColor>,
}

/// One edit field (TS `EditFieldRows`): plain value rows or a -/+ change.
#[derive(Debug, Clone, PartialEq)]
pub struct EditField {
    pub label: String,
    pub value: Vec<String>,
    pub change: Option<(Vec<String>, Vec<String>)>,
}

/// One generic custom row (TS `CustomMessageComponent`): the
/// `[<customType>]` label box on `customMessageBg` with the markdown body in
/// `customMessageText`. Every display-true custom type without a dedicated
/// component renders this way (e.g. `autonomous_status`).
#[derive(Debug, Clone, PartialEq)]
pub struct CustomPanelRow {
    pub custom_type: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/// The transcript entries for one `custom`-role message, mirroring the TS
/// dispatch order: slash rows, compaction and refinement outcomes, agent
/// messages, shell completions, injected prompts, then the generic box.
/// Non-display rows render nothing.
pub fn custom_message_entries(message: &Value) -> Vec<ChatEntry> {
    use pa_types::slash_commands::{
        SESSION_SLASH_COMMAND_CUSTOM_TYPE, SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
    };
    let custom_type = message
        .get("customType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let display = message
        .get("display")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !display {
        return Vec::new();
    }
    let content = crate::snapshot::message_text(message);
    let details = message.get("details").unwrap_or(&Value::Null);
    match custom_type {
        SESSION_SLASH_COMMAND_CUSTOM_TYPE | SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE => {
            slash_row_entries(message, custom_type, &content, details)
        }
        COMPACTION_OUTCOME_CUSTOM_TYPE => vec![compaction_outcome_entry(message, details)],
        PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE => {
            // The ONE line a retry episode leaves in the chat: the row text
            // the daemon carried (the live rows use the same text), the
            // tone from the structured verdict.
            vec![ChatEntry::Status {
                text: content,
                kind: if details.get("success").and_then(Value::as_bool) == Some(true) {
                    crate::chat::StatusKind::Info
                } else {
                    crate::chat::StatusKind::Error
                },
            }]
        }
        REFINEMENT_OUTCOME_CUSTOM_TYPE => refinement::refinement_outcome_entries(message, details),
        AGENT_MESSAGE_CUSTOM_TYPE => agent_message_entry(details).map_or_else(
            || vec![generic_panel_entry(custom_type, message)],
            |entry| vec![entry],
        ),
        ASYNC_BASH_COMPLETION_CUSTOM_TYPE => vec![ChatEntry::ShellCompletion(Box::new(
            shell_completion_row(message, details),
        ))],
        HEARTBEAT_PROMPT_CUSTOM_TYPE
        | GOAL_CONTEXT_CUSTOM_TYPE
        | IPYTHON_STATE_RESTORED_CUSTOM_TYPE
        | RLM_CHILD_FAILURE_CUSTOM_TYPE
        | RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE => {
            vec![ChatEntry::InjectedPrompt(Box::new(injected_prompt_row(
                custom_type,
                message,
                details,
            )))]
        }
        // Everything else - engine bookkeeping (`harness_digest`,
        // `refinement_notice`, worker recovery) and unknown types - renders
        // the generic box, exactly like the TS live dispatch fallthrough
        // (those types persist with `display: false` and render nothing).
        _ => vec![generic_panel_entry(custom_type, message)],
    }
}

/// TS `CustomMessageComponent` fallthrough: the `[<customType>]` box row.
fn generic_panel_entry(custom_type: &str, message: &Value) -> ChatEntry {
    ChatEntry::CustomPanel(Box::new(CustomPanelRow {
        custom_type: custom_type.to_string(),
        content: custom_content_text(message),
    }))
}

/// The session-command echo/result rows: the echo decodes to the
/// user-block slash row (the typed command IS user input); the result
/// row decodes to the status-row class with the severity's tone.
fn slash_row_entries(
    message: &Value,
    custom_type: &str,
    content: &str,
    details: &Value,
) -> Vec<ChatEntry> {
    use pa_types::slash_commands::SESSION_SLASH_COMMAND_CUSTOM_TYPE;
    let is_command_row = custom_type == SESSION_SLASH_COMMAND_CUSTOM_TYPE;
    let content_is_text = match message.get("content") {
        Some(Value::String(_)) => true,
        Some(Value::Array(blocks)) => {
            blocks.len() == 1
                && matches!(
                    blocks[0].get("type").and_then(Value::as_str),
                    Some("text") | None
                )
        }
        _ => false,
    };
    let command_details_valid = details.get("command").is_some_and(|command| {
        command.get("name").is_some()
            && command.get("args").is_some()
            && command.get("text").is_some()
    });
    if !content_is_text || (is_command_row && !command_details_valid) {
        return vec![ChatEntry::User {
            text: "[Malformed session command message]".to_string(),
        }];
    }
    if is_command_row {
        vec![ChatEntry::SlashCommand {
            text: content.to_string(),
        }]
    } else {
        // The outcome row is system output, never user text (the
        // operator's 2026-09-25 bug report: the user-message box read as
        // the "no active goal" reply being a user prompt): it renders in
        // the status-row class, the severity driving the tone like the
        // compaction and retry outcome rows.
        let kind = match details.get("severity").and_then(Value::as_str) {
            Some("error") => StatusKind::Error,
            Some("warning") => StatusKind::Warning,
            _ => StatusKind::Info,
        };
        vec![ChatEntry::Status {
            text: content.to_string(),
            kind,
        }]
    }
}

/// TS `isCompactionOutcomeMessage` envelope: content string + a known
/// reason/outcome pair; anything else is the malformed notice.
fn compaction_outcome_entry(message: &Value, details: &Value) -> ChatEntry {
    let valid = message
        .get("content")
        .map(Value::is_string)
        .unwrap_or(false)
        && matches!(
            details.get("reason").and_then(Value::as_str),
            Some("threshold" | "overflow" | "requested")
        )
        && matches!(
            details.get("outcome").and_then(Value::as_str),
            Some("skipped" | "cancelled" | "failed")
        );
    if !valid {
        return ChatEntry::Status {
            text: "[Malformed compaction outcome message]".to_string(),
            kind: StatusKind::Error,
        };
    }
    let outcome = details
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    ChatEntry::Status {
        text: crate::snapshot::message_text(message),
        kind: if outcome == "skipped" {
            StatusKind::Warning
        } else {
            StatusKind::Error
        },
    }
}

/// TS `isAgentSessionMessage`: string `details.id` + string
/// `details.message` (no emptiness check); anything else is not an
/// agent-message row and the dispatch falls through to the generic box.
fn agent_message_entry(details: &Value) -> Option<ChatEntry> {
    details.get("id").and_then(Value::as_str)?;
    let message = details.get("message").and_then(Value::as_str)?;
    let from = details.get("from").unwrap_or(&Value::Null);
    let relationship = details
        .get("fromRelationship")
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = ["sessionName", "activeSessionId", "clientId", "sessionId"]
        .iter()
        .find_map(|key| {
            from.get(*key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|name| !name.trim().is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());
    let participant = match relationship {
        Some(role) => format!("from {role} {name}"),
        None => format!("from {name}"),
    };
    Some(ChatEntry::AgentMessage(Box::new(AgentMessageRow {
        direction: AgentMessageDirection::Received,
        participant,
        message: message.to_string(),
    })))
}

/// TS `readShellCompletion` + `ShellCompletionComponent.render`: a valid
/// completion needs an object details block with a positive-integer `pid`,
/// a string `command`, and an integer `exitCode`; anything else renders the
/// default finished row. The expanded raw text follows the same validity:
/// `shellCompletionText` for a valid completion (content string or text
/// blocks joined with newlines, images as `[image]`), the content string or
/// its JSON form otherwise.
fn shell_completion_row(message: &Value, details: &Value) -> ShellCompletionRow {
    let pid = details.get("pid").and_then(Value::as_i64);
    let command = details.get("command").and_then(Value::as_str);
    let exit_code = details.get("exitCode").and_then(Value::as_i64);
    let valid = details.is_object()
        && pid.is_some_and(|pid| pid > 0)
        && command.is_some()
        && exit_code.is_some();
    if valid {
        ShellCompletionRow {
            pid,
            exit_code,
            content: custom_content_text(message),
        }
    } else {
        ShellCompletionRow {
            pid: None,
            exit_code: None,
            content: match message.get("content") {
                Some(Value::String(_)) => custom_content_text(message),
                Some(value) => serde_json::to_string(value).unwrap_or_default(),
                None => String::new(),
            },
        }
    }
}

/// TS `readCustomText`: content string or blocks joined with newlines
/// (text blocks keep their text, every non-text block renders `[image]`).
pub(crate) fn custom_content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                } else {
                    "[image]".to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decoded(message: serde_json::Value) -> Vec<ChatEntry> {
        custom_message_entries(&message)
    }

    #[test]
    fn non_display_rows_render_nothing() {
        // TS skips display=false rows everywhere (harness digests,
        // refinement notices, worker recovery are bookkeeping).
        for custom_type in [
            "harness_digest",
            "refinement_notice",
            "prime-agent.worker_recovery",
            AGENT_MESSAGE_CUSTOM_TYPE,
        ] {
            let entries = decoded(json!({
                "role": "custom",
                "customType": custom_type,
                "content": "kept out of the transcript",
                "display": false,
                "details": { "id": "agentmsg_1", "message": "body" },
            }));
            assert!(entries.is_empty(), "{custom_type} rendered {entries:?}");
        }
    }

    #[test]
    fn bookkeeping_types_render_the_generic_box_when_displayed() {
        // The TS live dispatch has no dedicated component for engine
        // bookkeeping, so a stray display=true row falls through to the
        // generic `CustomMessageComponent` box (in practice these persist
        // with display=false and render nothing).
        for custom_type in [
            "harness_digest",
            "refinement_notice",
            "prime-agent.worker_recovery",
            "ipython_state",
            "thread_goal_state",
        ] {
            let entries = decoded(json!({
                "role": "custom",
                "customType": custom_type,
                "content": "digest",
                "display": true,
            }));
            assert!(
                matches!(
                    entries.as_slice(),
                    [ChatEntry::CustomPanel(row)]
                        if row.custom_type == custom_type
                            && row.content == "digest"
                ),
                "{custom_type} rendered {entries:?}"
            );
        }
    }

    #[test]
    fn agent_message_decodes_participant_and_body() {
        let entries = decoded(json!({
            "role": "custom",
            "customType": AGENT_MESSAGE_CUSTOM_TYPE,
            "content": "[agent-message from child:model-probe]\n\nready",
            "display": true,
            "details": {
                "id": "agentmsg_1",
                "message": "ready",
                "from": {
                    "sessionName": "model-probe",
                    "sessionId": "sess-1",
                    "activeSessionId": "aaa111",
                    "runtimeKind": "subagent",
                },
                "fromRelationship": "child",
            },
        }));
        let [ChatEntry::AgentMessage(row)] = entries.as_slice() else {
            panic!("agent message row: {entries:?}");
        };
        assert_eq!(row.participant, "from child model-probe");
        assert_eq!(row.message, "ready");
    }

    #[test]
    fn agent_message_participant_falls_back_to_ids() {
        // TS `formatAgentMessageParticipant`: session name, then active
        // session id, client id, session id, then "unknown".
        let base = |from: serde_json::Value, relationship: Option<&str>| {
            let mut details = json!({
                "id": "agentmsg_2",
                "message": "hi",
                "from": from,
            });
            if let Some(role) = relationship {
                details["fromRelationship"] = json!(role);
            }
            decoded(json!({
                "role": "custom",
                "customType": AGENT_MESSAGE_CUSTOM_TYPE,
                "content": "[agent-message from x]\n\nhi",
                "display": true,
                "details": details,
            }))
        };
        let entry = |entries: Vec<ChatEntry>| match entries.as_slice() {
            [ChatEntry::AgentMessage(row)] => row.participant.clone(),
            other => panic!("agent message row: {other:?}"),
        };
        assert_eq!(
            entry(base(
                json!({ "activeSessionId": "aaa111", "sessionId": "s1" }),
                None
            )),
            "from aaa111"
        );
        assert_eq!(
            entry(base(
                json!({ "clientId": "client-9", "sessionId": "s1" }),
                None
            )),
            "from client-9"
        );
        assert_eq!(entry(base(json!({ "sessionId": "s1" }), None)), "from s1");
        assert_eq!(entry(base(json!(null), None)), "from unknown");
        assert_eq!(
            entry(base(json!({ "sessionName": "parent" }), Some("parent"))),
            "from parent parent"
        );
        // Without valid id/message details the row is not an agent message;
        // it falls through to the generic box.
        let entries = decoded(json!({
            "role": "custom",
            "customType": AGENT_MESSAGE_CUSTOM_TYPE,
            "content": "[agent-message from x]",
            "display": true,
            "details": { "id": 1, "message": null },
        }));
        assert!(matches!(entries.as_slice(), [ChatEntry::CustomPanel(_)]));
    }

    #[test]
    fn injected_prompt_kinds_decode() {
        let heartbeat = decoded(json!({
            "role": "custom",
            "customType": HEARTBEAT_PROMPT_CUSTOM_TYPE,
            "content": "[heartbeat: every 10m run#0]\n\nnudge",
            "display": true,
            "details": { "jobId": "j1", "schedule": "every 10m", "runCount": 0 },
        }));
        assert!(matches!(
            heartbeat.as_slice(),
            [ChatEntry::InjectedPrompt(boxed)]
                if matches!(boxed.kind, InjectedPromptKind::Heartbeat { ref schedule }
                    if schedule.as_deref() == Some("every 10m"))
        ));
        let goal = decoded(json!({
            "role": "custom",
            "customType": GOAL_CONTEXT_CUSTOM_TYPE,
            "content": "[goal: continuation]",
            "display": true,
            "details": { "kind": "continuation", "objective": "ship it" },
        }));
        assert!(matches!(
            goal.as_slice(),
            [ChatEntry::InjectedPrompt(boxed)]
                if matches!(&boxed.kind,
                    InjectedPromptKind::Goal { kind, objective }
                        if kind.as_deref() == Some("continuation")
                            && objective.as_deref() == Some("ship it"))
        ));
        let restored = decoded(json!({
            "role": "custom",
            "customType": IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
            "content": "[python-state-restored]",
            "display": true,
            "details": { "restored": false },
        }));
        assert!(matches!(
            restored.as_slice(),
            [ChatEntry::InjectedPrompt(boxed)]
                if matches!(boxed.kind, InjectedPromptKind::KernelRestored { restored: false })
        ));
        // The RLM child rows decode the outcome and the session name (the
        // render shapes live with the kind, in `injected_prompt`).
        let failed = decoded(json!({
            "role": "custom",
            "customType": RLM_CHILD_FAILURE_CUSTOM_TYPE,
            "content": "[child-failed child:lane]\n\nboom",
            "display": true,
            "details": { "childId": "sub-1", "sessionName": "lane", "error": "boom" },
        }));
        assert!(matches!(
            failed.as_slice(),
            [ChatEntry::InjectedPrompt(boxed)]
                if matches!(
                    &boxed.kind,
                    InjectedPromptKind::RlmChildStatus {
                        outcome: RlmChildOutcome::Failed,
                        session_name,
                    } if session_name == "lane"
                ) && boxed.body.as_deref() == Some("boom")
        ));
        for (kind, outcome) in [
            ("completed_without_reply", RlmChildOutcome::Finished),
            ("cancelled", RlmChildOutcome::Cancelled),
        ] {
            let row = decoded(json!({
                "role": "custom",
                "customType": RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
                "content": "[child-exited: no-reply child:lane]",
                "display": true,
                "details": { "childId": "sub-2", "sessionName": "lane", "kind": kind },
            }));
            // Neither fixture carries a reason, so both stay
            // header-only.
            assert!(
                matches!(
                    row.as_slice(),
                    [ChatEntry::InjectedPrompt(boxed)]
                        if matches!(
                            &boxed.kind,
                            InjectedPromptKind::RlmChildStatus { outcome: decoded_outcome, .. }
                                if decoded_outcome == &outcome
                        ) && boxed.body.is_none()
                ),
                "outcome {outcome:?} of kind {kind:?} did not decode"
            );
        }
        // The kernel-state row carries no expandable body.
        let restored = decoded(json!({
            "role": "custom",
            "customType": IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
            "content": "[python-state-restored]",
            "display": true,
            "details": { "restored": true },
        }));
        assert!(matches!(
            restored.as_slice(),
            [ChatEntry::InjectedPrompt(boxed)] if boxed.body.is_none()
        ));
    }

    #[test]
    fn shell_completion_decodes_details() {
        let entries = decoded(json!({
            "role": "custom",
            "customType": ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
            "content": "[bash-done pid:4371 exit:0]\n\nCommand: \"ls\"",
            "display": true,
            "details": { "pid": 4371, "command": "ls", "exitCode": 0 },
        }));
        assert!(matches!(
            entries.as_slice(),
            [ChatEntry::ShellCompletion(row)]
                if row.pid == Some(4371) && row.exit_code == Some(0)
        ));
        // An invalid details block (TS `readShellCompletion` requires a
        // positive pid, a string command, and an integer exit code) keeps
        // the default finished row and the JSON content fallback.
        let entries = decoded(json!({
            "role": "custom",
            "customType": ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
            "content": [{ "type": "text", "text": "[bash-done]" }],
            "display": true,
            "details": { "pid": -1, "exitCode": 3 },
        }));
        assert!(matches!(
            entries.as_slice(),
            [ChatEntry::ShellCompletion(row)]
                if row.pid.is_none() && row.exit_code.is_none()
        ));
    }

    #[test]
    fn agent_message_accepts_empty_string_details() {
        // TS `isAgentSessionMessage` checks only `typeof id === "string"`
        // and `typeof message === "string"`; empty strings still decode as
        // agent-message rows.
        let entries = decoded(json!({
            "role": "custom",
            "customType": AGENT_MESSAGE_CUSTOM_TYPE,
            "content": "[agent-message from x]",
            "display": true,
            "details": { "id": "", "message": "" },
        }));
        assert!(matches!(entries.as_slice(), [ChatEntry::AgentMessage(_)]));
    }

    #[test]
    fn compaction_outcome_maps_to_status_rows() {
        let skipped = decoded(json!({
            "role": "custom",
            "customType": COMPACTION_OUTCOME_CUSTOM_TYPE,
            "content": "Compaction skipped: below threshold",
            "display": true,
            "details": { "reason": "threshold", "outcome": "skipped" },
        }));
        assert_eq!(
            skipped,
            vec![ChatEntry::Status {
                text: "Compaction skipped: below threshold".to_string(),
                kind: StatusKind::Warning,
            }]
        );
        let failed = decoded(json!({
            "role": "custom",
            "customType": COMPACTION_OUTCOME_CUSTOM_TYPE,
            "content": "Compaction failed",
            "display": true,
            "details": { "reason": "requested", "outcome": "failed" },
        }));
        assert_eq!(
            failed,
            vec![ChatEntry::Status {
                text: "Compaction failed".to_string(),
                kind: StatusKind::Error,
            }]
        );
        let malformed = decoded(json!({
            "role": "custom",
            "customType": COMPACTION_OUTCOME_CUSTOM_TYPE,
            "content": "Compaction?",
            "display": true,
            "details": { "reason": "wat" },
        }));
        assert_eq!(
            malformed,
            vec![ChatEntry::Status {
                text: "[Malformed compaction outcome message]".to_string(),
                kind: StatusKind::Error,
            }]
        );
    }

    #[test]
    fn unknown_displayed_types_render_the_generic_box() {
        let entries = decoded(json!({
            "role": "custom",
            "customType": "autonomous_status",
            "content": "[autonomous-status: on]",
            "display": true,
            "details": { "enabled": true },
        }));
        assert!(matches!(
            entries.as_slice(),
            [ChatEntry::CustomPanel(row)]
                if row.custom_type == "autonomous_status"
                    && row.content == "[autonomous-status: on]"
        ));
    }
}

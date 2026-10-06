//! Daemon session-event mapping: the TS `acpUpdatesForSessionEvent` port
//! for the wire shapes a daemon worker streams (`message_start/update/end`,
//! `tool_execution_*`, `bash_*`, `compaction_end`, `goal_update`, ...): the
//! ACP frames the daemon worker's session events produce.
//!
//! Events with no ACP counterpart (`turn_end`, `auto_retry_*`,
//! `agent_begin/end`, `session_action_update`) map to nothing, exactly like
//! the TS switch's default arm.

use serde_json::{json, Value};

use super::meta::{prime_agent_meta, PrimeAgentCompactionMeta, PrimeAgentSessionMeta};
use super::types::{AcpSessionUpdate, AcpToolKind, AcpToolStatus, TextBlock};

/// The model-facing Python REPL tool.
const IPYTHON_TOOL_NAME: &str = "ipython";

/// Correlates streamed chunks with their owning assistant message (the
/// daemon stream carries the delta on `assistantMessageEvent`) and bash
/// output chunks with the run that produced them.
#[derive(Debug, Default)]
pub struct WireMappingState {
    next_assistant_message_sequence: u64,
    active_assistant_message_id: Option<String>,
    active_bash_run_id: Option<String>,
}

impl WireMappingState {
    fn start_assistant_message(&mut self) -> String {
        self.next_assistant_message_sequence += 1;
        let id = format!(
            "prime-agent-assistant-{}",
            self.next_assistant_message_sequence
        );
        self.active_assistant_message_id = Some(id.clone());
        id
    }

    fn message_started(&mut self) -> String {
        self.active_assistant_message_id
            .clone()
            .unwrap_or_else(|| self.start_assistant_message())
    }
}

/// The newest assistant stop reason carried by a `message_end` event (the
/// transport reads it after the turn for the stop-reason response); also
/// captures an error message on a failed turn.
pub struct AssistantStop {
    pub stop_reason: Option<String>,
}

/// Extract the assistant stop/error fields from one wire event, when the
/// event settles an assistant message.
pub fn assistant_stop(event: &Value) -> Option<AssistantStop> {
    if event.get("type").and_then(Value::as_str) != Some("message_end") {
        return None;
    }
    let message = event.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    Some(AssistantStop {
        stop_reason: message
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Map one daemon session event to zero or more ACP updates.
pub fn wire_updates(event: &Value, state: &mut WireMappingState) -> Vec<AcpSessionUpdate> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "message_start" => {
            if event
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("assistant")
            {
                state.start_assistant_message();
            }
            Vec::new()
        }
        "message_update" => {
            let message = event.get("message");
            if message
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                != Some("assistant")
            {
                return Vec::new();
            }
            let stream = event.get("assistantMessageEvent");
            let delta = stream
                .and_then(|stream| stream.get("delta"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                return Vec::new();
            }
            let message_id = state.message_started();
            match stream
                .and_then(|stream| stream.get("type"))
                .and_then(Value::as_str)
            {
                Some("thinking_delta") => vec![AcpSessionUpdate::AgentThoughtChunk {
                    message_id,
                    content: TextBlock::new(delta),
                }],
                Some("text_delta") => vec![AcpSessionUpdate::AgentMessageChunk {
                    message_id,
                    content: TextBlock::new(delta),
                }],
                _ => Vec::new(),
            }
        }
        "message_end" => {
            if event
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("assistant")
            {
                state.active_assistant_message_id = None;
            }
            Vec::new()
        }
        "tool_execution_start" => {
            let tool_call_id = event
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let tool_name = event
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let args = event.get("args").cloned().unwrap_or(Value::Null);
            let cell = if tool_name == IPYTHON_TOOL_NAME {
                args.get("code").and_then(Value::as_str).map(str::to_string)
            } else {
                None
            };
            let title = if tool_name == IPYTHON_TOOL_NAME {
                "Python cell".to_string()
            } else {
                tool_name.clone()
            };
            vec![AcpSessionUpdate::ToolCall {
                tool_call_id,
                title,
                kind: AcpToolKind::of_tool(&tool_name),
                status: AcpToolStatus::InProgress,
                raw_input: match cell {
                    Some(code) => json!({ "code": code }),
                    None => args,
                },
            }]
        }
        "tool_execution_end" => {
            let tool_call_id = event
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let is_error = event
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let text = tool_result_text(event.get("result"));
            let rich = ipython_rich_output(event.get("result"));
            let update = AcpSessionUpdate::ToolCallUpdate {
                tool_call_id,
                status: Some(if is_error {
                    AcpToolStatus::Failed
                } else {
                    AcpToolStatus::Completed
                }),
                content: text.map(|text| vec![super::types::ToolCallContent::new(text)]),
                meta: rich.map(|rich| {
                    prime_agent_meta(&PrimeAgentSessionMeta {
                        ipython: Some(rich),
                        ..Default::default()
                    })
                }),
            };
            vec![update]
        }
        // User-level bash runs outside the tool-call lifecycle: a synthetic
        // tool call keyed by run id keeps the streamed chunks addressable.
        "bash_start" => {
            let command = event
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let run_id = event
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string);
            state.active_bash_run_id.clone_from(&run_id);
            vec![AcpSessionUpdate::ToolCall {
                tool_call_id: bash_tool_call_id(run_id),
                title: command.clone(),
                kind: AcpToolKind::Execute,
                status: AcpToolStatus::InProgress,
                raw_input: json!({ "command": command }),
            }]
        }
        "bash_output" => {
            let chunk = event
                .get("chunk")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            vec![AcpSessionUpdate::ToolCallUpdate {
                tool_call_id: bash_tool_call_id(state.active_bash_run_id.clone()),
                status: Some(AcpToolStatus::InProgress),
                content: Some(vec![super::types::ToolCallContent::new(chunk)]),
                meta: None,
            }]
        }
        "bash_end" => {
            let run_id = event
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string);
            if state.active_bash_run_id == run_id {
                state.active_bash_run_id = None;
            }
            let completed = event.get("exitCode").and_then(Value::as_i64) == Some(0)
                && !event
                    .get("cancelled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            vec![AcpSessionUpdate::ToolCallUpdate {
                tool_call_id: bash_tool_call_id(run_id),
                status: Some(if completed {
                    AcpToolStatus::Completed
                } else {
                    AcpToolStatus::Failed
                }),
                content: None,
                meta: None,
            }]
        }
        "goal_update" => {
            let goal = event.get("goal");
            vec![AcpSessionUpdate::SessionInfoUpdate {
                meta: prime_agent_meta(&PrimeAgentSessionMeta {
                    goal: Some(super::meta::PrimeAgentGoalMeta {
                        status: goal
                            .and_then(|goal| goal.get("status"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        objective: goal
                            .and_then(|goal| goal.get("objective"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        token_budget: goal
                            .and_then(|goal| goal.get("tokenBudget"))
                            .and_then(Value::as_u64),
                        tokens_used: goal
                            .and_then(|goal| goal.get("tokensUsed"))
                            .and_then(Value::as_u64),
                    }),
                    ..Default::default()
                }),
            }]
        }
        "compaction_end" => {
            let result = event.get("result");
            vec![AcpSessionUpdate::SessionInfoUpdate {
                meta: prime_agent_meta(&PrimeAgentSessionMeta {
                    compaction: Some(PrimeAgentCompactionMeta {
                        tokens_before: result
                            .and_then(|result| result.get("tokensBefore"))
                            .and_then(Value::as_u64),
                        summary: result
                            .and_then(|result| result.get("summary"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }),
                    ..Default::default()
                }),
            }]
        }
        "rlm_child_update" => {
            let child = event.get("child");
            vec![AcpSessionUpdate::SessionInfoUpdate {
                meta: prime_agent_meta(&PrimeAgentSessionMeta {
                    subagents: Some(vec![super::meta::PrimeAgentSubagentMeta {
                        id: child
                            .and_then(|child| child.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        session_name: child
                            .and_then(|child| child.get("sessionName"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        status: child
                            .and_then(|child| child.get("status"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        model: child
                            .and_then(|child| child.get("model"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        depth: None,
                        token_count: child
                            .and_then(|child| child.get("tokenCount"))
                            .and_then(Value::as_u64),
                        error: child
                            .and_then(|child| child.get("error"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }]),
                    ..Default::default()
                }),
            }]
        }
        "refine_complete" => {
            let result = event.get("result");
            let changes = result
                .and_then(|result| result.get("appliedEdits"))
                .and_then(Value::as_array)
                .map(|edits| {
                    edits
                        .iter()
                        .filter(|edit| edit.get("applied") == Some(&json!(true)))
                        .filter_map(|edit| {
                            let action = edit.get("action").and_then(Value::as_str)?;
                            let kind = edit.get("kind").and_then(Value::as_str)?;
                            let id = edit.get("id").and_then(Value::as_str)?;
                            Some(format!("{action} {kind}:{id}"))
                        })
                        .collect::<Vec<String>>()
                });
            vec![AcpSessionUpdate::SessionInfoUpdate {
                meta: prime_agent_meta(&PrimeAgentSessionMeta {
                    refinement: Some(super::meta::PrimeAgentRefinementMeta {
                        status: "complete".to_string(),
                        summary: result
                            .and_then(|result| result.get("summary"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        changes,
                        error: None,
                    }),
                    ..Default::default()
                }),
            }]
        }
        "refine_failed" => {
            vec![AcpSessionUpdate::SessionInfoUpdate {
                meta: prime_agent_meta(&PrimeAgentSessionMeta {
                    refinement: Some(super::meta::PrimeAgentRefinementMeta {
                        status: "failed".to_string(),
                        summary: None,
                        changes: None,
                        error: event
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }),
                    ..Default::default()
                }),
            }]
        }
        "ipython_sent_agent_message" => {
            let message = event.get("message");
            vec![AcpSessionUpdate::SessionInfoUpdate {
                meta: prime_agent_meta(&PrimeAgentSessionMeta {
                    agent_message: Some(super::meta::PrimeAgentAgentMessageMeta {
                        tool_call_id: event
                            .get("toolCallId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        target: message
                            .and_then(|message| message.get("target"))
                            .and_then(|target| {
                                target
                                    .get("sessionName")
                                    .or_else(|| target.get("sessionId"))
                            })
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        delivery_status: message
                            .and_then(|message| message.get("deliveryStatus"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }),
                    ..Default::default()
                }),
            }]
        }
        _ => Vec::new(),
    }
}

/// The synthetic tool-call id of a user-level bash run:
/// `prime-agent-bash-<runId>`; a run without an id keys the bare prefix
/// (TS `bashToolCallId`).
fn bash_tool_call_id(run_id: Option<String>) -> String {
    match run_id {
        Some(run_id) => format!("prime-agent-bash-{run_id}"),
        None => "prime-agent-bash".to_string(),
    }
}

/// TS `toolResultText`: the text of a tool result, wherever the engine
/// carries it. Empty text blocks drop out before the join and an empty
/// text yields `None`, so no update carries empty content (the TS call
/// site's `text ? { content } : {}`).
fn tool_result_text(result: Option<&Value>) -> Option<String> {
    let result = result?;
    if let Some(text) = result.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    if let Some(output) = result.get("output").and_then(Value::as_str) {
        return (!output.is_empty()).then(|| output.to_string());
    }
    let content = result.get("content")?.as_array()?;
    let parts: Vec<String> = content
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .flatten()
        })
        .filter(|text| !text.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// Decoded byte length of a base64 payload, without materializing it.
fn base64_byte_length(data: &str) -> u64 {
    let padding = if data.ends_with("==") {
        2
    } else {
        u64::from(data.ends_with('='))
    };
    (data.len() as u64 * 3 / 4).saturating_sub(padding)
}

/// TS `ipythonRichOutput`: media and diffs ride the namespaced meta.
fn ipython_rich_output(result: Option<&Value>) -> Option<Value> {
    let details = result?.get("details")?;
    let attachments = details
        .get("attachments")
        .and_then(Value::as_array)
        .map(|attachments| {
            attachments
                .iter()
                .map(|attachment| {
                    let mut row = serde_json::Map::new();
                    if let Some(mime_type) = attachment.get("mimeType").and_then(Value::as_str) {
                        row.insert("mimeType".to_string(), json!(mime_type));
                    }
                    if let Some(path) = attachment.get("path").and_then(Value::as_str) {
                        row.insert("path".to_string(), json!(path));
                    }
                    if let Some(bytes) = attachment
                        .get("data")
                        .and_then(Value::as_str)
                        .map(base64_byte_length)
                    {
                        row.insert("bytes".to_string(), json!(bytes));
                    }
                    Value::Object(row)
                })
                .collect::<Vec<_>>()
        })
        .filter(|attachments| !attachments.is_empty());
    let diff_count = details
        .get("diffs")
        .and_then(Value::as_array)
        .map(|diffs| diffs.len() as u64);
    if attachments.is_none() && diff_count.is_none() {
        return None;
    }
    let mut meta = serde_json::Map::new();
    if let Some(attachments) = attachments {
        meta.insert("attachments".to_string(), Value::Array(attachments));
    }
    if let Some(diff_count) = diff_count {
        meta.insert("diffCount".to_string(), json!(diff_count));
    }
    Some(Value::Object(meta))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_deltas_map_to_chunks() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "message_update",
                "message": { "role": "assistant" },
                "assistantMessageEvent": { "type": "thinking_delta", "delta": "think" },
            }),
            &mut state,
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(
            serde_json::to_value(&updates[0]).unwrap()["sessionUpdate"],
            "agent_thought_chunk"
        );
        let updates = wire_updates(
            &json!({
                "type": "message_update",
                "message": { "role": "assistant" },
                "assistantMessageEvent": { "type": "text_delta", "delta": "answer" },
            }),
            &mut state,
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(
            serde_json::to_value(&updates[0]).unwrap()["sessionUpdate"],
            "agent_message_chunk"
        );
    }

    #[test]
    fn goal_update_maps_to_the_namespaced_goal_meta() {
        // TS acp-events.ts `case "goal_update"`: the GoalState fields the
        // meta carries, nothing else.
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "goal_update",
                "goal": {
                    "active": true,
                    "status": "active",
                    "goalId": "g1",
                    "objective": "Name a river",
                    "tokenBudget": 500,
                    "tokensUsed": 0,
                    "timeUsedSeconds": 0,
                    "continuationsUsed": 0,
                },
            }),
            &mut state,
        );
        assert_eq!(updates.len(), 1);
        let value = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(value["sessionUpdate"], "session_info_update");
        assert_eq!(
            value["_meta"]["ai.primeintellect.prime-agent"]["goal"],
            json!({
                "status": "active",
                "objective": "Name a river",
                "tokenBudget": 500,
                "tokensUsed": 0,
            })
        );
    }

    #[test]
    fn user_messages_and_lifecycle_events_map_to_nothing() {
        let mut state = WireMappingState::default();
        for event_type in [
            "message_start",
            "message_end",
            "turn_end",
            "agent_begin",
            "session_action_update",
            "auto_retry_start",
        ] {
            let updates = wire_updates(
                &json!({ "type": event_type, "message": { "role": "user" } }),
                &mut state,
            );
            assert!(updates.is_empty(), "{event_type} maps to nothing");
        }
    }

    #[test]
    fn tool_calls_and_completions_map_like_the_ts_adapter() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "tool_execution_start",
                "toolCallId": "call-1",
                "toolName": "ipython",
                "args": { "code": "print(1)" },
            }),
            &mut state,
        );
        let value = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(value["sessionUpdate"], "tool_call");
        assert_eq!(value["title"], "Python cell");
        assert_eq!(value["rawInput"], json!({ "code": "print(1)" }));
        let updates = wire_updates(
            &json!({
                "type": "tool_execution_end",
                "toolCallId": "call-1",
                "result": { "output": "1\n" },
                "isError": false,
            }),
            &mut state,
        );
        let value = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(value["sessionUpdate"], "tool_call_update");
        assert_eq!(value["status"], "completed");
        assert_eq!(value["content"][0]["content"]["text"], "1\n");
    }

    #[test]
    fn compaction_end_publishes_the_meta_payload() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "compaction_end",
                "result": { "tokensBefore": 4200, "summary": "a summary" },
            }),
            &mut state,
        );
        let value = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(value["sessionUpdate"], "session_info_update");
        assert_eq!(
            value["_meta"]["ai.primeintellect.prime-agent"]["compaction"],
            json!({ "tokensBefore": 4200, "summary": "a summary" })
        );
    }

    #[test]
    fn assistant_stop_reason_is_captured_from_message_end() {
        let stop = assistant_stop(&json!({
            "type": "message_end",
            "message": { "role": "assistant", "stopReason": "end_turn" },
        }))
        .expect("assistant message_end");
        assert_eq!(stop.stop_reason.as_deref(), Some("end_turn"));
        assert!(assistant_stop(&json!({
            "type": "message_end",
            "message": { "role": "user" },
        }))
        .is_none());
    }

    #[test]
    fn empty_tool_results_carry_no_content() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "tool_execution_end",
                "toolCallId": "t1",
                "result": { "output": "" },
                "isError": false,
            }),
            &mut state,
        );
        let value = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(value["sessionUpdate"], "tool_call_update");
        assert_eq!(value["status"], "completed");
        assert!(value.get("content").is_none(), "no empty content: {value}");
    }

    #[test]
    fn empty_text_blocks_drop_out_of_the_joined_result() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "tool_execution_end",
                "toolCallId": "t1",
                "result": { "content": [
                    { "type": "text", "text": "" },
                    { "type": "text", "text": "a" },
                ] },
                "isError": false,
            }),
            &mut state,
        );
        let value = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(value["content"][0]["content"]["text"], "a");
    }

    fn namespaced(update: &AcpSessionUpdate) -> Value {
        update.to_bare_value()["_meta"]["ai.primeintellect.prime-agent"].clone()
    }

    #[test]
    fn rlm_child_update_maps_to_the_subagents_meta() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "rlm_child_update",
                "child": {
                    "id": "child-1",
                    "parentId": "node-1",
                    "activeSessionId": "child-live",
                    "sessionName": "worker-a",
                    "model": "z-ai/glm-5.3-flash",
                    "label": "run the lane task",
                    "status": "running",
                    "durationMs": 500,
                    "sessionDir": "/sessions/child-1",
                },
            }),
            &mut state,
        );
        let value = updates[0].to_bare_value();
        assert_eq!(value["sessionUpdate"], "session_info_update");
        assert_eq!(
            namespaced(&updates[0])["subagents"],
            json!([{
                "id": "child-1",
                "sessionName": "worker-a",
                "status": "running",
                "model": "z-ai/glm-5.3-flash",
            }])
        );
        let updates = wire_updates(
            &json!({
                "type": "rlm_child_update",
                "child": {
                    "id": "child-2",
                    "status": "cancelled",
                    "error": "Deleted by parent orchestrator",
                },
            }),
            &mut state,
        );
        assert_eq!(
            namespaced(&updates[0])["subagents"],
            json!([{
                "id": "child-2",
                "status": "cancelled",
                "error": "Deleted by parent orchestrator",
            }])
        );
    }

    #[test]
    fn refine_complete_maps_the_applied_edits_changes() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "refine_complete",
                "result": {
                    "id": "ref-1",
                    "summary": "applied 2 edits",
                    "appliedEdits": [
                        { "action": "create", "kind": "memory", "id": "x", "applied": true },
                        { "action": "update", "kind": "skill", "id": "y", "applied": true },
                        { "action": "delete", "kind": "prompt", "id": "z", "applied": false },
                    ],
                },
            }),
            &mut state,
        );
        assert_eq!(
            namespaced(&updates[0])["refinement"],
            json!({
                "status": "complete",
                "summary": "applied 2 edits",
                "changes": ["create memory:x", "update skill:y"],
            })
        );
        let updates = wire_updates(
            &json!({
                "type": "refine_complete",
                "result": { "id": "ref-2", "summary": "no edits" },
            }),
            &mut state,
        );
        assert_eq!(
            namespaced(&updates[0])["refinement"],
            json!({ "status": "complete", "summary": "no edits" })
        );
    }

    #[test]
    fn refine_failed_maps_the_error_meta() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({ "type": "refine_failed", "error": "Summarization failed: no responses" }),
            &mut state,
        );
        assert_eq!(
            namespaced(&updates[0])["refinement"],
            json!({ "status": "failed", "error": "Summarization failed: no responses" })
        );
    }

    #[test]
    fn ipython_sent_agent_message_maps_the_target_fallback() {
        let mut state = WireMappingState::default();
        let updates = wire_updates(
            &json!({
                "type": "ipython_sent_agent_message",
                "toolCallId": "t7",
                "message": {
                    "id": "agentmsg_1",
                    "message": "Ping.",
                    "deliveryStatus": "delivered",
                    "target": {
                        "activeSessionId": "peer-live",
                        "sessionId": "peer-session",
                        "sessionName": "Worker",
                    },
                },
            }),
            &mut state,
        );
        assert_eq!(
            namespaced(&updates[0])["agentMessage"],
            json!({
                "toolCallId": "t7",
                "target": "Worker",
                "deliveryStatus": "delivered",
            })
        );
        let updates = wire_updates(
            &json!({
                "type": "ipython_sent_agent_message",
                "toolCallId": "t8",
                "message": {
                    "id": "agentmsg_2",
                    "message": "Ping.",
                    "deliveryStatus": "queued",
                    "target": {
                        "activeSessionId": "peer-live",
                        "sessionId": "peer-session",
                    },
                },
            }),
            &mut state,
        );
        assert_eq!(
            namespaced(&updates[0])["agentMessage"],
            json!({
                "toolCallId": "t8",
                "target": "peer-session",
                "deliveryStatus": "queued",
            })
        );
    }
}

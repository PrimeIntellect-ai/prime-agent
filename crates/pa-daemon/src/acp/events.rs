//! Translate agent-loop events into ACP `session/update` payloads.
//!
//! Pure mapping: one loop event fans out to zero or more updates. The
//! mapping state correlates streamed chunks with their owning assistant
//! message, exactly like the TS event adapter.

use serde_json::{json, Value};

use super::meta::PrimeAgentSessionMeta;
use super::types::{AcpSessionUpdate, TextBlock, ToolCallContent};
pub use super::types::{AcpToolKind, AcpToolStatus};

/// The model-facing Python REPL tool.
pub const IPYTHON_TOOL_NAME: &str = "ipython";

/// Correlates streamed assistant chunks with their owning message and bash
/// output chunks with the run that produced them.
#[derive(Debug, Default)]
pub struct MappingState {
    next_assistant_message_sequence: u64,
    active_assistant_message_id: Option<String>,
    active_bash_run_id: Option<String>,
}

impl MappingState {
    fn start_assistant_message(&mut self) -> String {
        self.next_assistant_message_sequence += 1;
        let id = format!(
            "prime-agent-assistant-{}",
            self.next_assistant_message_sequence
        );
        self.active_assistant_message_id = Some(id.clone());
        id
    }

    /// The owning message id for a streamed chunk, allocating one lazily if
    /// the stream began without a `message_start` (the TS adapter does the
    /// same, so a missed start never crashes the stream).
    fn message_started(&mut self) -> &str {
        if self.active_assistant_message_id.is_none() {
            self.start_assistant_message();
        }
        self.active_assistant_message_id
            .as_deref()
            .expect("a started message id exists")
    }
}

/// The event kinds the ACP adapter consumes from the agent loop.
///
/// A thin projection of the loop's `AgentEvent`: only the discriminants the
/// adapter maps to ACP updates, with the fields the mapping reads. Keeping
/// it as a value enum makes the mapping testable without a live agent.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpEngineEvent {
    MessageStart {
        role: String,
    },
    /// One streaming assistant delta: reasoning or visible text.
    AssistantDelta {
        thinking: bool,
        delta: String,
    },
    MessageEnd {
        role: String,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        result: Value,
        is_error: bool,
    },
    /// A compaction ran (session `/compact` or an auto-compaction cut).
    CompactionEnd {
        tokens_before: Option<u64>,
        summary: Option<String>,
    },
    /// The session goal changed (`/goal` commands and driver turns).
    GoalUpdate {
        status: String,
        objective: Option<String>,
        token_budget: Option<u64>,
        tokens_used: Option<u64>,
    },
    /// A continual-harness refinement completed.
    RefineComplete {
        summary: String,
        changes: Vec<String>,
    },
    /// A continual-harness refinement failed.
    RefineFailed {
        error: String,
    },
    /// One RLM subagent roster change.
    ///
    /// No in-process producer yet: in-process sessions have no RLM
    /// children. The mapping is the daemon-attached parity contract
    /// (slice 4) and is locked by unit tests.
    #[allow(dead_code)]
    RlmChildUpdate {
        child: RlmChildRow,
    },
    /// A kernel cell sent an agent-to-agent message. No in-process producer
    /// yet (the messaging host is daemon-wired); mapping locked by tests.
    #[allow(dead_code)]
    IpythonSentAgentMessage {
        tool_call_id: String,
        target: Option<String>,
        delivery_status: Option<String>,
    },
    /// The session's heartbeat/cron schedule changed (connection-scoped).
    /// No in-process producer yet; mapping locked by tests.
    #[allow(dead_code)]
    HeartbeatsChanged,
    /// A user-level bash run started: outside the tool-call lifecycle, so
    /// it gets a synthetic tool call keyed by run id. No in-process
    /// producer yet (user bash is an interactive/daemon surface); mapping
    /// locked by tests.
    #[allow(dead_code)]
    BashStart {
        command: String,
        run_id: Option<String>,
    },
    /// Incremental output of the active user-level bash run.
    #[allow(dead_code)]
    BashOutput {
        chunk: String,
    },
    /// The active user-level bash run finished.
    #[allow(dead_code)]
    BashEnd {
        run_id: Option<String>,
        exit_code: Option<i64>,
        cancelled: bool,
    },
}

/// One RLM subagent roster row in the `_meta.subagents` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct RlmChildRow {
    pub id: String,
    pub session_name: Option<String>,
    pub status: String,
    pub model: Option<String>,
    pub token_count: Option<u64>,
    pub error: Option<String>,
}

/// Map one loop event to zero or more ACP updates.
///
/// - Assistant reasoning deltas become `agent_thought_chunk` and visible
///   text deltas become `agent_message_chunk`, so a client can render or
///   hide them separately.
/// - Tool calls become `tool_call` / `tool_call_update` pairs keyed by the
///   loop's tool-call id.
/// - Everything else has no ACP representation and maps to nothing.
pub fn acp_updates_for_event(
    event: &AcpEngineEvent,
    state: &mut MappingState,
) -> Vec<AcpSessionUpdate> {
    match event {
        AcpEngineEvent::MessageStart { role } if role == "assistant" => {
            state.start_assistant_message();
            Vec::new()
        }
        AcpEngineEvent::AssistantDelta {
            thinking: true,
            delta,
        } if !delta.is_empty() => {
            vec![AcpSessionUpdate::AgentThoughtChunk {
                message_id: state.message_started().to_string(),
                content: TextBlock::new(delta.clone()),
            }]
        }
        AcpEngineEvent::AssistantDelta {
            thinking: false,
            delta,
        } if !delta.is_empty() => {
            vec![AcpSessionUpdate::AgentMessageChunk {
                message_id: state.message_started().to_string(),
                content: TextBlock::new(delta.clone()),
            }]
        }
        AcpEngineEvent::MessageEnd { role } if role == "assistant" => {
            state.active_assistant_message_id = None;
            Vec::new()
        }
        AcpEngineEvent::MessageStart { .. }
        | AcpEngineEvent::AssistantDelta { .. }
        | AcpEngineEvent::MessageEnd { .. } => Vec::new(),
        AcpEngineEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => {
            let cell = if tool_name == IPYTHON_TOOL_NAME {
                args.get("code").and_then(Value::as_str)
            } else {
                None
            };
            let title = if tool_name == IPYTHON_TOOL_NAME {
                "Python cell"
            } else {
                tool_name
            };
            vec![AcpSessionUpdate::ToolCall {
                tool_call_id: tool_call_id.clone(),
                title: title.to_string(),
                kind: AcpToolKind::of_tool(tool_name),
                status: AcpToolStatus::InProgress,
                raw_input: match cell {
                    Some(code) => json!({ "code": code }),
                    None => args.clone(),
                },
            }]
        }
        AcpEngineEvent::CompactionEnd {
            tokens_before,
            summary,
        } => {
            vec![session_info_update(PrimeAgentSessionMeta {
                compaction: Some(super::meta::PrimeAgentCompactionMeta {
                    tokens_before: *tokens_before,
                    summary: summary.clone(),
                }),
                ..Default::default()
            })]
        }
        AcpEngineEvent::GoalUpdate {
            status,
            objective,
            token_budget,
            tokens_used,
        } => {
            vec![session_info_update(PrimeAgentSessionMeta {
                goal: Some(super::meta::PrimeAgentGoalMeta {
                    status: status.clone(),
                    objective: objective.clone(),
                    token_budget: *token_budget,
                    tokens_used: *tokens_used,
                }),
                ..Default::default()
            })]
        }
        AcpEngineEvent::RefineComplete { summary, changes } => {
            vec![session_info_update(PrimeAgentSessionMeta {
                refinement: Some(super::meta::PrimeAgentRefinementMeta {
                    status: "complete".to_string(),
                    summary: Some(summary.clone()),
                    changes: Some(changes.clone()),
                    error: None,
                }),
                ..Default::default()
            })]
        }
        AcpEngineEvent::RefineFailed { error } => {
            vec![session_info_update(PrimeAgentSessionMeta {
                refinement: Some(super::meta::PrimeAgentRefinementMeta {
                    status: "failed".to_string(),
                    summary: None,
                    changes: None,
                    error: Some(error.clone()),
                }),
                ..Default::default()
            })]
        }
        AcpEngineEvent::RlmChildUpdate { child } => {
            vec![session_info_update(PrimeAgentSessionMeta {
                subagents: Some(vec![super::meta::PrimeAgentSubagentMeta {
                    id: child.id.clone(),
                    session_name: child.session_name.clone(),
                    status: child.status.clone(),
                    model: child.model.clone(),
                    depth: None,
                    token_count: child.token_count,
                    error: child.error.clone(),
                }]),
                ..Default::default()
            })]
        }
        AcpEngineEvent::IpythonSentAgentMessage {
            tool_call_id,
            target,
            delivery_status,
        } => {
            vec![session_info_update(PrimeAgentSessionMeta {
                agent_message: Some(super::meta::PrimeAgentAgentMessageMeta {
                    tool_call_id: tool_call_id.clone(),
                    target: target.clone(),
                    delivery_status: delivery_status.clone(),
                }),
                ..Default::default()
            })]
        }
        AcpEngineEvent::HeartbeatsChanged => {
            vec![session_info_update(PrimeAgentSessionMeta {
                heartbeats_changed: Some(true),
                ..Default::default()
            })]
        }
        AcpEngineEvent::BashStart { command, run_id } => {
            state.active_bash_run_id.clone_from(run_id);
            vec![AcpSessionUpdate::ToolCall {
                tool_call_id: bash_tool_call_id(run_id.clone()),
                title: command.clone(),
                kind: AcpToolKind::Execute,
                status: AcpToolStatus::InProgress,
                raw_input: json!({ "command": command }),
            }]
        }
        AcpEngineEvent::BashOutput { chunk } => {
            vec![AcpSessionUpdate::ToolCallUpdate {
                tool_call_id: bash_tool_call_id(state.active_bash_run_id.clone()),
                status: Some(AcpToolStatus::InProgress),
                content: Some(vec![ToolCallContent::new(chunk.clone())]),
                meta: None,
            }]
        }
        AcpEngineEvent::BashEnd {
            run_id,
            exit_code,
            cancelled,
        } => {
            if state.active_bash_run_id == *run_id {
                state.active_bash_run_id = None;
            }
            let completed = *exit_code == Some(0) && !cancelled;
            vec![AcpSessionUpdate::ToolCallUpdate {
                tool_call_id: bash_tool_call_id(run_id.clone()),
                status: Some(if completed {
                    AcpToolStatus::Completed
                } else {
                    AcpToolStatus::Failed
                }),
                content: None,
                meta: None,
            }]
        }
        AcpEngineEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => {
            let text = tool_result_text(result);
            let rich = if tool_name == IPYTHON_TOOL_NAME {
                ipython_rich_output(result)
            } else {
                None
            };
            vec![AcpSessionUpdate::ToolCallUpdate {
                tool_call_id: tool_call_id.clone(),
                status: Some(if *is_error {
                    AcpToolStatus::Failed
                } else {
                    AcpToolStatus::Completed
                }),
                content: text.map(|text| vec![ToolCallContent::new(text)]),
                meta: rich.map(|rich| {
                    super::meta::prime_agent_meta(super::meta::PrimeAgentSessionMeta {
                        ipython: Some(rich),
                        ..Default::default()
                    })
                }),
            }]
        }
    }
}

/// A `session_info_update` carrying one namespaced payload.
fn session_info_update(meta: PrimeAgentSessionMeta) -> AcpSessionUpdate {
    AcpSessionUpdate::SessionInfoUpdate {
        meta: super::meta::prime_agent_meta(meta),
    }
}

/// The synthetic tool-call id for a bash run: `prime-agent-bash-<runId>`.
fn bash_tool_call_id(run_id: Option<String>) -> String {
    match run_id {
        Some(run_id) => format!("prime-agent-bash-{run_id}"),
        None => "prime-agent-bash".to_string(),
    }
}

/// Extract the text of a tool result: a plain string, an `output` field, or
/// joined text blocks of a `content` array. Rich media has no text form and
/// yields `None`.
fn tool_result_text(result: &Value) -> Option<String> {
    if let Some(text) = result.as_str() {
        return Some(text.to_string());
    }
    let object = result.as_object()?;
    if let Some(output) = object.get("output").and_then(Value::as_str) {
        return Some(output.to_string());
    }
    let content = object.get("content")?.as_array()?;
    let parts: Vec<&str> = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// Rich kernel output that ACP has no content type for: media the cell loaded
/// into context plus the number of diffs it displayed, reported under the
/// `_meta` namespace. Attachment payloads are never inlined (ACP already
/// carries images as content blocks); the decoded byte length is reported
/// instead of a `bytes` field the kernel never sends.
fn ipython_rich_output(result: &Value) -> Option<Value> {
    let details = result.get("details")?.as_object()?;
    let attachments = details
        .get("attachments")
        .and_then(Value::as_array)
        .map(|attachments| {
            attachments
                .iter()
                .map(|attachment| {
                    let mut meta = serde_json::Map::new();
                    if let Some(mime_type) = attachment.get("mimeType").and_then(Value::as_str) {
                        meta.insert("mimeType".to_string(), json!(mime_type));
                    }
                    if let Some(path) = attachment.get("path").and_then(Value::as_str) {
                        meta.insert("path".to_string(), json!(path));
                    }
                    if let Some(data) = attachment.get("data").and_then(Value::as_str) {
                        meta.insert("bytes".to_string(), json!(base64_byte_length(data)));
                    }
                    Value::Object(meta)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let diff_count = details
        .get("diffs")
        .and_then(Value::as_array)
        .map(std::vec::Vec::len);
    if attachments.is_empty() && diff_count.is_none() {
        return None;
    }
    let mut rich = serde_json::Map::new();
    if !attachments.is_empty() {
        rich.insert("attachments".to_string(), Value::Array(attachments));
    }
    if let Some(diff_count) = diff_count {
        rich.insert("diffCount".to_string(), json!(diff_count));
    }
    Some(Value::Object(rich))
}

/// Decoded byte length of a base64 payload, without materializing it.
fn base64_byte_length(data: &str) -> usize {
    let padding = if data.ends_with("==") {
        2
    } else {
        usize::from(data.ends_with('='))
    };
    ((data.len() * 3) / 4).saturating_sub(padding)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update_values(event: AcpEngineEvent) -> Vec<Value> {
        let mut state = MappingState::default();
        acp_updates_for_event(&event, &mut state)
            .iter()
            .map(AcpSessionUpdate::to_bare_value)
            .collect()
    }

    fn full_turn() -> Vec<Value> {
        let mut state = MappingState::default();
        let events = [
            AcpEngineEvent::MessageStart {
                role: "assistant".into(),
            },
            AcpEngineEvent::AssistantDelta {
                thinking: true,
                delta: "hmm".into(),
            },
            AcpEngineEvent::AssistantDelta {
                thinking: false,
                delta: "hello".into(),
            },
            AcpEngineEvent::ToolExecutionStart {
                tool_call_id: "t1".into(),
                tool_name: "ipython".into(),
                args: json!({ "code": "1+1" }),
            },
            AcpEngineEvent::ToolExecutionEnd {
                tool_call_id: "t1".into(),
                tool_name: "ipython".into(),
                result: json!({ "output": "2" }),
                is_error: false,
            },
            AcpEngineEvent::MessageEnd {
                role: "assistant".into(),
            },
        ];
        events
            .iter()
            .flat_map(|event| {
                acp_updates_for_event(event, &mut state)
                    .iter()
                    .map(AcpSessionUpdate::to_bare_value)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn assistant_deltas_map_to_distinct_chunk_kinds() {
        let values = update_values(AcpEngineEvent::AssistantDelta {
            thinking: true,
            delta: "think".into(),
        });
        assert_eq!(values[0]["sessionUpdate"], "agent_thought_chunk");
        let values = update_values(AcpEngineEvent::AssistantDelta {
            thinking: false,
            delta: "say".into(),
        });
        assert_eq!(values[0]["sessionUpdate"], "agent_message_chunk");
    }

    #[test]
    fn empty_deltas_map_to_nothing() {
        let mut state = MappingState::default();
        state.start_assistant_message();
        let updates = acp_updates_for_event(
            &AcpEngineEvent::AssistantDelta {
                thinking: false,
                delta: String::new(),
            },
            &mut state,
        );
        assert!(updates.is_empty());
    }

    #[test]
    fn one_turn_yields_the_ts_frame_sequence() {
        let values = full_turn();
        let tags: Vec<&str> = values
            .iter()
            .map(|value| value["sessionUpdate"].as_str().expect("tagged"))
            .collect();
        assert_eq!(
            tags,
            vec![
                "agent_thought_chunk",
                "agent_message_chunk",
                "tool_call",
                "tool_call_update"
            ]
        );
        // The thought and the message share the turn's assistant message id.
        assert_eq!(values[0]["messageId"], "prime-agent-assistant-1");
        assert_eq!(values[1]["messageId"], "prime-agent-assistant-1");
        assert_eq!(values[2]["title"], "Python cell");
        assert_eq!(values[2]["rawInput"], json!({ "code": "1+1" }));
        assert_eq!(values[3]["status"], "completed");
        assert_eq!(values[3]["content"][0]["content"]["text"], "2");
    }

    #[test]
    fn second_turn_allocates_a_new_message_id() {
        let values = full_turn();
        let _ = values;
        let mut state = MappingState::default();
        for event in [
            AcpEngineEvent::MessageStart {
                role: "assistant".into(),
            },
            AcpEngineEvent::MessageEnd {
                role: "assistant".into(),
            },
            AcpEngineEvent::MessageStart {
                role: "assistant".into(),
            },
        ] {
            acp_updates_for_event(&event, &mut state);
        }
        assert_eq!(
            state.active_assistant_message_id.as_deref(),
            Some("prime-agent-assistant-2")
        );
    }

    #[test]
    fn failed_tool_result_reports_failed_status() {
        let mut state = MappingState::default();
        let updates = acp_updates_for_event(
            &AcpEngineEvent::ToolExecutionEnd {
                tool_call_id: "t9".into(),
                tool_name: "bash".into(),
                result: json!("boom"),
                is_error: true,
            },
            &mut state,
        );
        let value = updates[0].to_bare_value();
        assert_eq!(value["sessionUpdate"], "tool_call_update");
        assert_eq!(value["status"], "failed");
        assert_eq!(value["content"][0]["content"]["text"], "boom");
    }

    #[test]
    fn ipython_rich_output_rides_under_the_namespace() {
        let mut state = MappingState::default();
        let result = json!({
            "output": "42",
            "details": {
                "attachments": [ { "mimeType": "image/png", "data": "QUJD" } ],
                "diffs": [ {}, {} ],
            },
        });
        let updates = acp_updates_for_event(
            &AcpEngineEvent::ToolExecutionEnd {
                tool_call_id: "t2".into(),
                tool_name: "ipython".into(),
                result,
                is_error: false,
            },
            &mut state,
        );
        let value = updates[0].to_bare_value();
        let meta = &value["_meta"]["ai.primeintellect.prime-agent"]["ipython"];
        assert_eq!(meta["diffCount"], 2);
        assert_eq!(meta["attachments"][0]["mimeType"], "image/png");
        // "QUJD" decodes to 3 bytes ("ABC").
        assert_eq!(meta["attachments"][0]["bytes"], 3);
        assert!(meta["attachments"][0].get("data").is_none());
    }

    fn meta_of(value: &Value) -> Value {
        value["_meta"]["ai.primeintellect.prime-agent"].clone()
    }

    #[test]
    fn compaction_maps_to_namespaced_meta() {
        let mut state = MappingState::default();
        let updates = acp_updates_for_event(
            &AcpEngineEvent::CompactionEnd {
                tokens_before: Some(1234),
                summary: Some("a summary".into()),
            },
            &mut state,
        );
        let value = updates[0].to_bare_value();
        assert_eq!(value["sessionUpdate"], "session_info_update");
        assert_eq!(
            meta_of(&value)["compaction"],
            json!({ "tokensBefore": 1234, "summary": "a summary" })
        );
        // A skipped compaction still publishes the empty payload, matching
        // the TS compaction_end with result undefined.
        let updates = acp_updates_for_event(
            &AcpEngineEvent::CompactionEnd {
                tokens_before: None,
                summary: None,
            },
            &mut state,
        );
        assert_eq!(
            meta_of(&updates[0].to_bare_value())["compaction"],
            json!({})
        );
    }

    #[test]
    fn goal_update_maps_to_namespaced_meta() {
        let mut state = MappingState::default();
        let updates = acp_updates_for_event(
            &AcpEngineEvent::GoalUpdate {
                status: "active".into(),
                objective: Some("ship it".into()),
                token_budget: Some(1000),
                tokens_used: Some(42),
            },
            &mut state,
        );
        let meta = meta_of(&updates[0].to_bare_value());
        assert_eq!(
            meta["goal"],
            json!({ "status": "active", "objective": "ship it", "tokenBudget": 1000, "tokensUsed": 42 })
        );
    }

    #[test]
    fn refinement_outcomes_map_to_namespaced_meta() {
        let mut state = MappingState::default();
        let updates = acp_updates_for_event(
            &AcpEngineEvent::RefineComplete {
                summary: "applied 2 edits".into(),
                changes: vec!["create memory:x".into(), "update skill:y".into()],
            },
            &mut state,
        );
        assert_eq!(
            meta_of(&updates[0].to_bare_value())["refinement"],
            json!({ "status": "complete", "summary": "applied 2 edits", "changes": ["create memory:x", "update skill:y"] })
        );
        let updates = acp_updates_for_event(
            &AcpEngineEvent::RefineFailed {
                error: "boom".into(),
            },
            &mut state,
        );
        assert_eq!(
            meta_of(&updates[0].to_bare_value())["refinement"],
            json!({ "status": "failed", "error": "boom" })
        );
    }

    #[test]
    fn rlm_child_and_agent_message_map_to_namespaced_meta() {
        let mut state = MappingState::default();
        let updates = acp_updates_for_event(
            &AcpEngineEvent::RlmChildUpdate {
                child: RlmChildRow {
                    id: "child-1".into(),
                    session_name: Some("worker-a".into()),
                    status: "running".into(),
                    model: Some("z-ai/glm-5.3-flash".into()),
                    token_count: Some(500),
                    error: None,
                },
            },
            &mut state,
        );
        assert_eq!(
            meta_of(&updates[0].to_bare_value())["subagents"][0],
            json!({
                "id": "child-1",
                "sessionName": "worker-a",
                "status": "running",
                "model": "z-ai/glm-5.3-flash",
                "tokenCount": 500,
            })
        );
        let updates = acp_updates_for_event(
            &AcpEngineEvent::IpythonSentAgentMessage {
                tool_call_id: "t3".into(),
                target: Some("worker-a".into()),
                delivery_status: Some("delivered".into()),
            },
            &mut state,
        );
        assert_eq!(
            meta_of(&updates[0].to_bare_value())["agentMessage"],
            json!({ "toolCallId": "t3", "target": "worker-a", "deliveryStatus": "delivered" })
        );
    }

    #[test]
    fn heartbeats_changed_maps_to_namespaced_meta() {
        let mut state = MappingState::default();
        let updates = acp_updates_for_event(&AcpEngineEvent::HeartbeatsChanged, &mut state);
        assert_eq!(
            meta_of(&updates[0].to_bare_value())["heartbeatsChanged"],
            true
        );
    }

    #[test]
    fn bash_runs_map_to_synthetic_tool_calls() {
        let mut state = MappingState::default();
        let start = acp_updates_for_event(
            &AcpEngineEvent::BashStart {
                command: "echo hi".into(),
                run_id: Some("run-7".into()),
            },
            &mut state,
        );
        let value = start[0].to_bare_value();
        assert_eq!(value["sessionUpdate"], "tool_call");
        assert_eq!(value["toolCallId"], "prime-agent-bash-run-7");
        assert_eq!(value["title"], "echo hi");
        assert_eq!(value["kind"], "execute");
        assert_eq!(value["status"], "in_progress");
        assert_eq!(value["rawInput"], json!({ "command": "echo hi" }));

        let output = acp_updates_for_event(
            &AcpEngineEvent::BashOutput {
                chunk: "hi\n".into(),
            },
            &mut state,
        );
        let value = output[0].to_bare_value();
        assert_eq!(value["sessionUpdate"], "tool_call_update");
        assert_eq!(value["toolCallId"], "prime-agent-bash-run-7");
        assert_eq!(value["status"], "in_progress");
        assert_eq!(value["content"][0]["content"]["text"], "hi\n");

        let end = acp_updates_for_event(
            &AcpEngineEvent::BashEnd {
                run_id: Some("run-7".into()),
                exit_code: Some(0),
                cancelled: false,
            },
            &mut state,
        );
        let value = end[0].to_bare_value();
        assert_eq!(value["status"], "completed");
        assert!(value.get("content").is_none());
        // The active run cleared, so later output keys the bare id.
        assert_eq!(state.active_bash_run_id, None);

        let end = acp_updates_for_event(
            &AcpEngineEvent::BashEnd {
                run_id: None,
                exit_code: Some(1),
                cancelled: true,
            },
            &mut state,
        );
        let value = end[0].to_bare_value();
        assert_eq!(value["toolCallId"], "prime-agent-bash");
        assert_eq!(value["status"], "failed");
    }

    #[test]
    fn non_assistant_roles_map_to_nothing() {
        let values = update_values(AcpEngineEvent::MessageStart {
            role: "user".into(),
        });
        assert!(values.is_empty());
    }
}

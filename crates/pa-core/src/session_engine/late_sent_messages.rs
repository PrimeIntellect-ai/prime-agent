//! Late (fire-and-forget) `agent_message.send` receipts: the persisted
//! custom entry plus the `python_repl` tool-result patch (TS
//! `IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY` handling in agent-session.ts).

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::{AgentMessage, Message};
use pa_types::session::FileEntry;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::kernel::shared::{parse_sent_agent_message, KernelSentAgentMessage};
use crate::session::manager::SessionManager;
use crate::tools::ipython::sent_agent_message_json;

/// The persisted row for one receipt that landed after its cell's tool
/// result (TS `IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY`).
pub const IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_TYPE: &str = "ipython_sent_agent_message";

/// One persisted receipt parsed off the session branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedSentAgentMessage {
    pub tool_call_id: String,
    pub message: KernelSentAgentMessage,
}

/// The custom-entry payload: `{ toolCallId, message }` with the TS wire
/// shape for the message.
#[must_use]
pub fn sent_agent_message_entry(tool_call_id: &str, message: &KernelSentAgentMessage) -> Value {
    json!({
        "toolCallId": tool_call_id,
        "message": sent_agent_message_json(message),
    })
}

/// Parse one persisted receipt payload; `None` on a malformed record.
#[must_use]
pub fn parse_persisted_sent_agent_message(payload: &Value) -> Option<PersistedSentAgentMessage> {
    let tool_call_id = payload.get("toolCallId")?.as_str()?;
    let message = parse_sent_agent_message(payload.get("message")?)?;
    Some(PersistedSentAgentMessage {
        tool_call_id: tool_call_id.to_string(),
        message,
    })
}

/// The receipts on session entries, oldest first.
#[must_use]
pub fn scan_sent_agent_message_entries<'a>(
    entries: impl IntoIterator<Item = &'a FileEntry>,
) -> Vec<PersistedSentAgentMessage> {
    entries
        .into_iter()
        .filter_map(|entry| match entry {
            FileEntry::Custom { payload, .. }
                if payload.custom_type == IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_TYPE =>
            {
                payload
                    .data
                    .as_ref()
                    .and_then(parse_persisted_sent_agent_message)
            }
            _ => None,
        })
        .collect()
}

/// Patch one receipt onto a `python_repl` tool result's `sentAgentMessages`
/// details (TS `appendSentAgentMessageToToolResult`): `true` when the row
/// is the matching tool result, whether or not the receipt is new.
pub(crate) fn append_to_tool_result(
    row: &mut AgentMessage,
    tool_call_id: &str,
    sent: &KernelSentAgentMessage,
) -> bool {
    let AgentMessage::Standard(Message::ToolResult(result)) = row else {
        return false;
    };
    // The python tool's aliases all count (an `ipython`/`python`-named
    // call, and TS-era files, store the name the model called): the
    // receipt patches the row whatever the alias was.
    if result.tool_call_id != tool_call_id || !pa_types::ai::is_python_tool_name(&result.tool_name)
    {
        return false;
    }
    let details = result.details.take().unwrap_or(Value::Null);
    let mut map = match details {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let mut current = match map.remove("sentAgentMessages") {
        Some(Value::Array(rows)) => rows,
        _ => Vec::new(),
    };
    let already = current
        .iter()
        .any(|entry| entry.get("id").and_then(Value::as_str) == Some(sent.id.as_str()));
    if !already {
        current.push(sent_agent_message_json(sent));
    }
    map.insert("sentAgentMessages".to_string(), Value::Array(current));
    result.details = Some(Value::Object(map));
    true
}

/// Record one late receipt (TS `_recordLateIpythonSentAgentMessage`): the
/// custom entry persists it (once per message id) and the newest matching
/// `python_repl` tool result in agent state carries it.
pub(crate) async fn record(
    session: &Arc<Mutex<SessionManager>>,
    agent: &Arc<Agent>,
    tool_call_id: &str,
    message: &KernelSentAgentMessage,
) -> anyhow::Result<()> {
    let persistence = {
        let mut session = session.lock().await;
        let already = session.late_sent_agent_messages().iter().any(|persisted| {
            persisted.tool_call_id == tool_call_id && persisted.message.id == message.id
        });
        if already {
            Ok(())
        } else {
            session
                .append_custom_entry(
                    IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_TYPE,
                    Some(sent_agent_message_entry(tool_call_id, message)),
                )
                .map(|_| ())
                .map_err(|error| {
                    anyhow::anyhow!("late agent-message receipt not persisted: {error}")
                })
        }
    };
    agent
        .mutate_messages(|rows| {
            for row in rows.iter_mut().rev() {
                if append_to_tool_result(row, tool_call_id, message) {
                    break;
                }
            }
        })
        .await;
    persistence
}

/// Patch every persisted receipt onto the rebuilt tool results (TS
/// `_restoreLateIpythonSentAgentMessages`): the engine build's
/// restoration pass over the session's loaded branch.
pub(crate) async fn restore(session: &Arc<Mutex<SessionManager>>, agent: &Arc<Agent>) {
    let persisted = session.lock().await.late_sent_agent_messages();
    if persisted.is_empty() {
        return;
    }
    agent
        .mutate_messages(|rows| {
            for entry in &persisted {
                for row in rows.iter_mut().rev() {
                    if append_to_tool_result(row, &entry.tool_call_id, &entry.message) {
                        break;
                    }
                }
            }
        })
        .await;
}

/// The landing arm (TS `_applyLateIpythonSentAgentMessages`): one row
/// landing through the agent's `MessageEnd` seam picks up every receipt
/// already persisted for its call. The session's custom entries are the
/// single parked-receipt source, so no second map exists here.
pub(crate) fn landing_transform(
    session: &Arc<Mutex<SessionManager>>,
) -> pa_agent::agent::MessageEndTransformFn {
    let session = Arc::clone(session);
    Arc::new(move |message| {
        let session = Arc::clone(&session);
        Box::pin(async move {
            // The cheap filter runs before any lock: only a python tool
            // result can carry receipts. `append_to_tool_result` owns the
            // call-id match.
            if !matches!(
                &message,
                AgentMessage::Standard(Message::ToolResult(result))
                    if pa_types::ai::is_python_tool_name(&result.tool_name)
            ) {
                return message;
            }
            let mut message = message;
            for entry in session.lock().await.late_sent_agent_messages() {
                append_to_tool_result(&mut message, &entry.tool_call_id, &entry.message);
            }
            message
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
    use pa_agent::types::{Message, ThinkingLevel, ToolResultMessage};
    use pa_types::ai::PYTHON_TOOL_NAME;

    fn receipt(id: &str) -> KernelSentAgentMessage {
        KernelSentAgentMessage {
            id: id.to_string(),
            message: "Ping.".to_string(),
            delivery_status: crate::kernel::shared::SentDeliveryStatus::Delivered,
            receiver_role: Some(crate::kernel::shared::ReceiverRole::Parent),
            target: crate::kernel::shared::SentAgentMessageTarget {
                active_session_id: "a1".to_string(),
                session_id: "s1".to_string(),
                session_name: Some("Worker".to_string()),
            },
        }
    }

    fn python_tool_result(tool_call_id: &str, details: Option<Value>) -> AgentMessage {
        AgentMessage::Standard(Message::ToolResult(ToolResultMessage {
            tool_call_id: tool_call_id.to_string(),
            tool_name: PYTHON_TOOL_NAME.to_string(),
            content: Vec::new(),
            details,
            is_error: false,
            timestamp: 0,
        }))
    }

    fn agent_with(messages: Vec<AgentMessage>) -> Arc<Agent> {
        Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(pa_agent::types::Model {
                    id: "m".into(),
                    name: "m".into(),
                    api: "test".into(),
                    provider: "test".into(),
                    base_url: "http://localhost".into(),
                    reasoning: false,
                    cost: pa_agent::types::UsageCost::default(),
                    context_window: 1_000,
                    max_tokens: 100,
                    max_tokens_explicit: false,
                }),
                thinking_level: Some(ThinkingLevel::Off),
                tools: None,
                messages: Some(messages),
            },
            stream_fn: None,
            ..Default::default()
        }))
    }

    fn tool_result_details(row: &AgentMessage) -> Option<&Value> {
        match row {
            AgentMessage::Standard(Message::ToolResult(result)) => result.details.as_ref(),
            _ => None,
        }
    }

    #[test]
    fn append_to_tool_result_patches_only_the_matching_python_repl_row() {
        let mut matching = python_tool_result("call-1", Some(json!({ "status": "ok" })));
        let sent = receipt("agentmsg_1");

        assert!(append_to_tool_result(&mut matching, "call-1", &sent));
        let details = tool_result_details(&matching).expect("details");
        assert_eq!(details["status"], "ok");
        let rows = details["sentAgentMessages"].as_array().expect("receipts");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "agentmsg_1");
        assert_eq!(rows[0]["target"]["sessionName"], "Worker");

        // The same receipt id does not double-append.
        assert!(append_to_tool_result(&mut matching, "call-1", &sent));
        assert_eq!(
            tool_result_details(&matching).expect("details")["sentAgentMessages"]
                .as_array()
                .expect("receipts")
                .len(),
            1
        );

        // A row without details gains them; a foreign tool id and a
        // non-python_repl result stay untouched.
        let mut bare = python_tool_result("call-2", None);
        assert!(append_to_tool_result(&mut bare, "call-2", &sent));
        assert_eq!(
            tool_result_details(&bare).expect("details")["sentAgentMessages"]
                .as_array()
                .expect("receipts")
                .len(),
            1
        );
        assert!(!append_to_tool_result(
            &mut bare,
            "call-9",
            &receipt("agentmsg_2")
        ));
        let mut foreign_tool = AgentMessage::Standard(Message::ToolResult(ToolResultMessage {
            tool_call_id: "call-3".to_string(),
            tool_name: "echo".to_string(),
            content: Vec::new(),
            details: None,
            is_error: false,
            timestamp: 0,
        }));
        assert!(!append_to_tool_result(&mut foreign_tool, "call-3", &sent));
        assert!(tool_result_details(&foreign_tool).is_none());

        // The python tool's aliases count too (an `ipython`-named call,
        // the name TS-era files store).
        let mut aliased = AgentMessage::Standard(Message::ToolResult(ToolResultMessage {
            tool_call_id: "call-4".to_string(),
            tool_name: "ipython".to_string(),
            content: Vec::new(),
            details: None,
            is_error: false,
            timestamp: 0,
        }));
        assert!(append_to_tool_result(&mut aliased, "call-4", &sent));
        assert_eq!(
            tool_result_details(&aliased).expect("details")["sentAgentMessages"]
                .as_array()
                .expect("receipts")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn record_persists_one_entry_per_message_and_patches_agent_state() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionManager::persisted(dir.path(), &dir.path().join("sessions"));
        let session = Arc::new(Mutex::new(session));
        let agent = agent_with(vec![python_tool_result("call-1", None)]);

        record(&session, &agent, "call-1", &receipt("agentmsg_1"))
            .await
            .unwrap();
        record(&session, &agent, "call-1", &receipt("agentmsg_1"))
            .await
            .unwrap();
        record(&session, &agent, "call-1", &receipt("agentmsg_2"))
            .await
            .unwrap();

        let entries = {
            let session = session.lock().await;
            scan_sent_agent_message_entries(session.retained_entries())
        };
        assert_eq!(entries.len(), 2, "one custom entry per message id");
        assert_eq!(entries[0].message.id, "agentmsg_1");
        assert_eq!(entries[1].message.id, "agentmsg_2");

        let state = agent.state().await;
        let details = state
            .messages
            .iter()
            .find_map(tool_result_details)
            .expect("patched details");
        assert_eq!(details["sentAgentMessages"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn persistence_failure_is_reported_before_or_after_the_result_lands() {
        for landed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut session = SessionManager::persisted(dir.path(), &dir.path().join("sessions"));
            session
                .append_message(pa_types::session::AgentMessage::Assistant(
                    pa_types::ai::AssistantMessage {
                        content: vec![],
                        api: "openai-completions".to_string(),
                        provider: "fixture".to_string(),
                        model: "fixture".to_string(),
                        response_model: None,
                        response_id: None,
                        diagnostics: None,
                        usage: pa_types::ai::Usage::default(),
                        stop_reason: pa_types::ai::StopReason::Stop,
                        stop_reason_raw: None,
                        error_message: None,
                        timestamp: 0,
                        rest: serde_json::Map::default(),
                    },
                ))
                .unwrap();
            let file = session.get_session_file().unwrap().to_path_buf();
            std::fs::remove_file(&file).unwrap();
            std::fs::create_dir(&file).unwrap(); // deterministic append failure, even as root
            let session = Arc::new(Mutex::new(session));
            let agent = agent_with(if landed {
                vec![python_tool_result("call-1", None)]
            } else {
                vec![]
            });
            let error = record(&session, &agent, "call-1", &receipt("agentmsg_1"))
                .await
                .expect_err("a failed durable append cannot acknowledge recording");
            assert!(error.to_string().contains("not persisted"));
            assert!(session.lock().await.late_sent_agent_messages().is_empty());
            if landed {
                let state = agent.state().await;
                let details = state.messages.iter().find_map(tool_result_details).unwrap();
                assert_eq!(details["sentAgentMessages"][0]["id"], "agentmsg_1");
            }
        }
    }

    #[tokio::test]
    async fn restore_patches_the_rebuilt_tool_results() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionManager::persisted(dir.path(), &dir.path().join("sessions"));
        let session = Arc::new(Mutex::new(session));
        record(
            &session,
            &agent_with(Vec::new()),
            "call-1",
            &receipt("agentmsg_1"),
        )
        .await
        .unwrap();
        record(
            &session,
            &agent_with(Vec::new()),
            "call-1",
            &receipt("agentmsg_2"),
        )
        .await
        .unwrap();

        // The rebuilt engine's rows: the tool result alone, without the
        // receipts (they landed after the cell settled).
        let agent = agent_with(vec![python_tool_result("call-1", None)]);
        restore(&session, &agent).await;
        let state = agent.state().await;
        let details = state
            .messages
            .iter()
            .find_map(tool_result_details)
            .expect("patched details");
        let rows = details["sentAgentMessages"].as_array().expect("receipts");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "agentmsg_1");
        assert_eq!(rows[1]["id"], "agentmsg_2");
    }
}

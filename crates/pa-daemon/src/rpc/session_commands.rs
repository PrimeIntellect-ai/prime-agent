//! The RPC command surface, part two: session-level commands (fork, tree
//! messages, name, export, stats, commands listing), the scheduling and
//! agent-messaging surfaces with their TS in-process semantics, and the
//! gap-set commands whose backends the in-process transport does not
//! host (TS `rpc-mode.ts` cases; the daemon-attached transport serves
//! them for real).

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use pa_types::usage::{calculate_context_tokens, estimate_tokens, valid_assistant_usage};
use pa_types::session::FileEntry;

use super::commands::RpcState;
use super::protocol::ResponseData;
use super::session::RpcEngineRequest;

/// The TS in-process error texts for the daemon-mode surfaces
/// (`InProcessAgentConnection`'s throws, verbatim).
const CRON_REQUIRES_DAEMON: &str = "Cron jobs require daemon mode";
const HEARTBEATS_REQUIRE_DAEMON: &str = "Heartbeats require daemon mode";
const AGENT_MESSAGING_REQUIRES_DAEMON: &str = "Agent messaging requires daemon mode";
/// The in-process bash executor is not ported to the Rust session engine
/// yet (TS `AgentSession.executeBash`); the daemon-attached transport
/// serves the command over the worker's bash slot.
const BASH_BACKEND_GAP: &str = "Bash execution requires the session bash executor, which is not linked into the in-process RPC transport yet; the daemon-attached RPC transport serves it";

/// Handle one session-level command.
pub async fn handle(
    state: &Arc<RpcState>,
    name: &str,
    payload: &Value,
) -> Result<ResponseData, String> {
    match name {
        "switch_session" => switch_session(state, payload).await,
        "fork" => fork(state, payload).await,
        "clone" => clone(state).await,
        "get_fork_messages" => get_fork_messages(state).await,
        "get_last_assistant_text" => get_last_assistant_text(state).await,
        "set_session_name" => set_session_name(state, payload).await,
        "get_messages" => get_messages(state).await,
        "export_html" => export_html(state, payload).await,
        "get_session_stats" => get_session_stats(state).await,
        "get_commands" => get_commands(state).await,
        // The TS in-process scheduling surface: the list/get commands
        // answer empty (no scheduler lives in-process); the mutating
        // commands answer their daemon-mode errors.
        "list_schedules" => Ok(ResponseData::Present(json!({ "jobs": [] }))),
        "list_heartbeats" => Ok(ResponseData::Present(json!({ "heartbeats": [] }))),
        "get_heartbeat" => Ok(ResponseData::Present(json!({ "heartbeat": Value::Null }))),
        "add_schedule" | "cancel_schedule" => Err(CRON_REQUIRES_DAEMON.to_string()),
        "set_heartbeat" | "update_heartbeat" | "manage_heartbeat" => {
            Err(HEARTBEATS_REQUIRE_DAEMON.to_string())
        }
        "send_message" | "agent_messages_status" | "agent_messages_pause"
        | "agent_messages_resume" | "agent_messages_clear" => {
            Err(AGENT_MESSAGING_REQUIRES_DAEMON.to_string())
        }
        // The in-process session hosts no family, so no active session
        // is observable: the TS `watchSession` miss for an unknown child
        // id is the exact answer here.
        "observe" => {
            let id = payload
                .get("activeSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Err(format!("Unknown active session: {id}"))
        }
        // TS `stopObservation` of a session this connection never
        // observed: a no-op success.
        "unobserve" => Ok(ResponseData::Absent),
        "bash" => Err(BASH_BACKEND_GAP.to_string()),
        "abort_bash" => Ok(ResponseData::Absent),
        unknown => Err(format!("Unknown command: {unknown}")),
    }
}

/// `switch_session` (TS `runtimeHost.switchSession`): open the session
/// file as the connection's replacement session.
async fn switch_session(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let session_path = payload
        .get("sessionPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "switch_session requires a sessionPath".to_string())?;
    state
        .session
        .replace(RpcEngineRequest::Open {
            session_path: std::path::PathBuf::from(session_path),
        })
        .await?;
    super::commands::resume_pump(state);
    Ok(ResponseData::Present(json!({ "cancelled": false })))
}

/// `fork` (TS `runtimeHost.fork(entryId)`, position "before" the user
/// entry): branch the session file at the entry's parent leaf and move
/// the connection onto the fork.
async fn fork(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let entry_id = payload
        .get("entryId")
        .and_then(Value::as_str)
        .ok_or_else(|| "fork requires an entryId".to_string())?;
    let selected_text = {
        let handle = state.session.handle().await;
        let persistence = handle.engine.session.shared_persistence();
        let manager = persistence.lock().await;
        let Some(entry) = manager.get_entry_by_id(entry_id) else {
            return Err("Invalid entry ID for forking".to_string());
        };
        let FileEntry::Message {
            message: pa_types::session::AgentMessage::User(user),
            ..
        } = entry
        else {
            return Err("Invalid entry ID for forking".to_string());
        };
        let text = user.content.text();
        (entry.parent_id().map(str::to_string), text)
    };
    let (target_leaf, selected_text) = selected_text;
    // In-memory session: TS non-persisted `createBranchedSession` moves
    // the entries in place; persisted sessions branch into a new file the
    // connection switches onto.
    let persisted = {
        let handle = state.session.handle().await;
        let persistence = handle.engine.session.shared_persistence();
        let manager = persistence.lock().await;
        manager.is_persisted() && manager.get_session_file().is_some()
    };
    if !persisted {
        let handle = state.session.handle().await;
        let persistence = handle.engine.session.shared_persistence();
        let mut manager = persistence.lock().await;
        match target_leaf.as_deref() {
            Some(leaf) => manager.branch(leaf),
            None => manager.reset_leaf(),
        }
        return Ok(ResponseData::Present(json!({
            "text": selected_text.unwrap_or_default(),
            "cancelled": false,
        })));
    }
    let forked_path = {
        let handle = state.session.handle().await;
        let persistence = handle.engine.session.shared_persistence();
        let manager = persistence.lock().await;
        let session_file = manager
            .get_session_file()
            .ok_or_else(|| "Persisted session is missing a session file".to_string())?
            .to_path_buf();
        let session_dir = manager.get_session_dir().to_path_buf();
        drop(manager);
        drop(handle);
        let mut store = crate::session_store::SessionFile::open(&session_file)
            .map_err(|error| format!("{error:#}"))?;
        match target_leaf.as_deref() {
            Some(leaf) => store
                .create_branched_file(leaf, &session_dir)
                .map_err(|error| format!("{error:#}"))?,
            None => {
                // Fork at the root: a fresh session under the source.
                let mut forked = crate::session_store::SessionFile::create(
                    &state.cwd.display().to_string(),
                    session_file.to_str(),
                    0,
                );
                let file = session_dir
                    .join(crate::session_store::session_file_name(forked.session_id()));
                forked.set_path(file);
                if forked.rewrite().is_err() {
                    return Err("Failed to create forked session".to_string());
                }
                forked.path.clone()
            }
        }
    };
    state
        .session
        .replace(RpcEngineRequest::Open {
            session_path: forked_path,
        })
        .await?;
    super::commands::resume_pump(state);
    let mut data = json!({ "cancelled": false });
    if let Some(text) = selected_text {
        data["text"] = json!(text);
    }
    Ok(ResponseData::Present(data))
}

/// `clone` (TS `connection.clone`): fork at the current leaf, position
/// "at"; a session without a current entry answers the TS error.
async fn clone(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let leaf = {
        let handle = state.session.handle().await;
        let persistence = handle.engine.session.shared_persistence();
        let manager = persistence.lock().await;
        manager.get_leaf_id().map(str::to_string)
    };
    let Some(leaf_id) = leaf else {
        return Err("Cannot clone session: no current entry selected".to_string());
    };
    let payload = json!({ "entryId": leaf_id });
    let response = fork(state, &payload).await?;
    // The clone response drops the fork's text (TS `{ cancelled }`).
    match response {
        ResponseData::Present(mut value) => {
            if let Some(object) = value.as_object_mut() {
                object.remove("text");
            }
            Ok(ResponseData::Present(value))
        }
        ResponseData::Absent => Ok(ResponseData::Absent),
    }
}

/// `get_fork_messages` (TS `getUserMessagesForForking`): the user
/// messages with text, in file order.
async fn get_fork_messages(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let handle = state.session.handle().await;
    let persistence = handle.engine.session.shared_persistence();
    let manager = persistence.lock().await;
    let mut messages = Vec::new();
    for entry in manager.get_all_entries() {
        let FileEntry::Message {
            message: pa_types::session::AgentMessage::User(user),
            base,
            ..
        } = entry
        else {
            continue;
        };
        let text = user.content.text();
        if text.is_empty() {
            continue;
        }
        messages.push(json!({
            "entryId": base.id.clone().unwrap_or_default(),
            "text": text,
        }));
    }
    Ok(ResponseData::Present(json!({ "messages": messages })))
}

/// `get_last_assistant_text` (TS `getLastAssistantText`): the last
/// assistant message's concatenated text.
async fn get_last_assistant_text(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let handle = state.session.handle().await;
    let message = handle.engine.session.last_assistant_message().await;
    let text = message.as_ref().and_then(assistant_text);
    Ok(ResponseData::Present(json!({ "text": text })))
}

/// `set_session_name` (TS `session.setSessionName`): the durable
/// session-info row plus the `session_info_changed` event.
async fn set_session_name(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| "set_session_name requires a name".to_string())?;
    if name.is_empty() {
        return Err("Session name cannot be empty".to_string());
    }
    {
        let handle = state.session.handle().await;
        let persistence = handle.engine.session.shared_persistence();
        let mut manager = persistence.lock().await;
        let _ = manager.append_session_info(name);
    }
    state
        .writer
        .write(json!({ "type": "session_info_changed", "name": name }));
    Ok(ResponseData::Absent)
}

/// `get_messages` (TS `session.state.messages`).
async fn get_messages(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let handle = state.session.handle().await;
    let agent = handle.engine.session.agent();
    let agent_state = agent.state().await;
    let messages: Vec<Value> = agent_state
        .messages
        .iter()
        .map(|message| serde_json::to_value(message).unwrap_or(Value::Null))
        .collect();
    Ok(ResponseData::Present(json!({ "messages": messages })))
}

/// `export_html` (TS `session.exportToHtml`): the standalone viewer file
/// over the live session; the response carries the written path.
async fn export_html(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let output_path = payload
        .get("outputPath")
        .and_then(Value::as_str)
        .map(str::to_string);
    let handle = state.session.handle().await;
    let persistence = handle.engine.session.shared_persistence();
    let manager = persistence.lock().await;
    let Some(session_file) = manager.get_session_file().map(Path::to_path_buf) else {
        return Err("Cannot export an in-memory session".to_string());
    };
    let mut entries: Vec<Value> = Vec::new();
    let mut header = Value::Null;
    for entry in manager.get_all_entries() {
        let value = serde_json::to_value(entry).unwrap_or(Value::Null);
        if matches!(entry, FileEntry::Header { .. }) {
            header = value;
            continue;
        }
        entries.push(value);
    }
    drop(manager);
    let agent = handle.engine.session.agent();
    let tools: Vec<Value> = agent
        .state()
        .await
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name(),
                "description": tool.description(),
                "parameters": tool.parameters(),
            })
        })
        .collect();
    let data = pa_core::export_html::SessionExportData {
        header,
        entries,
        leaf_id: {
            let persistence = handle.engine.session.shared_persistence();
            let manager = persistence.lock().await;
            manager.get_leaf_id().map(str::to_string)
        },
        system_prompt: Some(handle.engine.system_prompt.clone()),
        tools: Some(tools),
        rendered_tools: None,
    };
    drop(handle);
    let path = pa_core::export_html::export_session_to_html(
        &data,
        None,
        &state.agent_dir,
        &session_file,
        output_path.as_deref(),
    )
    .map_err(|error| format!("{error:#}"))?;
    Ok(ResponseData::Present(json!({ "path": path })))
}

/// `get_session_stats` (TS `getSessionStats` over `state.messages`).
async fn get_session_stats(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let handle = state.session.handle().await;
    let engine = &handle.engine;
    let agent = engine.session.agent();
    let agent_state = agent.state().await;
    let messages: Vec<Value> = agent_state
        .messages
        .iter()
        .map(|message| serde_json::to_value(message).unwrap_or(Value::Null))
        .collect();
    let persistence = engine.session.shared_persistence();
    let manager = persistence.lock().await;

    let mut user_messages = 0u64;
    let mut assistant_messages = 0u64;
    let mut tool_calls = 0u64;
    let mut tool_results = 0u64;
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    let mut cost = 0.0;
    for message in &messages {
        match message.get("role").and_then(Value::as_str) {
            Some("user") => user_messages += 1,
            Some("assistant") => {
                assistant_messages += 1;
                if let Some(blocks) = message.get("content").and_then(Value::as_array) {
                    tool_calls += blocks
                        .iter()
                        .filter(|block| {
                            block.get("type").and_then(Value::as_str) == Some("toolCall")
                        })
                        .count() as u64;
                }
                if let Some(usage) = message.get("usage") {
                    input += usage.get("input").and_then(Value::as_u64).unwrap_or_default();
                    output += usage.get("output").and_then(Value::as_u64).unwrap_or_default();
                    cache_read += usage
                        .get("cacheRead")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    cache_write += usage
                        .get("cacheWrite")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    cost += usage
                        .get("cost")
                        .and_then(|cost| cost.get("total"))
                        .and_then(Value::as_f64)
                        .unwrap_or_default();
                }
            }
            Some("toolResult") => tool_results += 1,
            _ => {}
        }
    }
    let mut stats = json!({
        "sessionFile": manager
            .get_session_file()
            .map(|file| file.display().to_string()),
        "sessionId": manager.get_session_id(),
        "userMessages": user_messages,
        "assistantMessages": assistant_messages,
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "totalMessages": messages.len(),
        "tokens": {
            "input": input,
            "output": output,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
            "total": input + output + cache_read + cache_write,
        },
        "cost": cost,
    });
    // TS `estimateContextTokens`: the last valid assistant usage anchors
    // the estimate; messages after it add their char/4 estimates.
    let context_window = handle.model.context_window;
    if context_window > 0 {
        // TS `estimateContextTokens`: the last valid assistant usage
        // anchors the estimate; messages after it add their char/4
        // estimates, and no anchor estimates every message.
        let tokens = match messages
            .iter()
            .rposition(|message| valid_assistant_usage(message).is_some())
        {
            Some(anchor_index) => {
                let usage = valid_assistant_usage(&messages[anchor_index])
                    .expect("checked by rposition");
                calculate_context_tokens(&usage)
                    + messages[anchor_index + 1..]
                        .iter()
                        .map(|message| estimate_tokens(message))
                        .sum::<u64>()
            }
            None => messages.iter().map(|message| estimate_tokens(message)).sum(),
        };
        stats["contextUsage"] = json!({
            "tokens": tokens,
            "contextWindow": context_window,
            "percent": tokens as f64 / context_window as f64 * 100.0,
        });
    }
    Ok(ResponseData::Present(stats))
}

/// `get_commands` (TS `createAgentConnectionCommands`): extension
/// commands, prompt templates, then skills.
async fn get_commands(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let handle = state.session.handle().await;
    let engine = &handle.engine;
    let mut commands: Vec<Value> = Vec::new();
    if let Some(runner) = &engine.extension_runner {
        let registry = runner.registry().await;
        for command in registry.commands() {
            let mut entry = json!({
                "name": command.invocation_name,
                "registeredName": command.name,
                "source": "extension",
            });
            if let Some(description) = &command.description {
                entry["description"] = json!(description);
            }
            commands.push(entry);
        }
    }
    for template in &engine.prompt_templates {
        let mut entry = json!({
            "name": template.name,
            "source": "prompt",
            "sourceInfo": template.source_info,
        });
        if let Some(hint) = &template.argument_hint {
            entry["argumentHint"] = json!(hint);
        }
        if !template.description.is_empty() {
            entry["description"] = json!(template.description);
        }
        commands.push(entry);
    }
    for skill in &engine.skills {
        let mut entry = json!({
            "name": format!("skill:{}", skill.name),
            "source": "skill",
            "sourceInfo": skill.source_info,
        });
        if !skill.description.is_empty() {
            entry["description"] = json!(skill.description);
        }
        commands.push(entry);
    }
    Ok(ResponseData::Present(json!({ "commands": commands })))
}


/// The concatenated text blocks of one assistant message (TS
/// `getLastAssistantText`).
fn assistant_text(message: &pa_types::session::AgentMessage) -> Option<String> {
    match message {
        pa_types::session::AgentMessage::Assistant(assistant) => Some(
            assistant
                .content
                .iter()
                .filter_map(|block| match block {
                    pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        ),
        _ => None,
    }
}

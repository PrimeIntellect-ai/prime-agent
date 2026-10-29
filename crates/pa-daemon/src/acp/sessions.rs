//! ACP `session/list` and `session/load` over the daemon's saved-session
//! catalog. The ACP session id is the prime-agent session id, so the ids
//! `session/new`, `session/list` and `session/load` report round-trip.

use std::path::PathBuf;
use std::sync::Arc;

use pa_types::daemon::{DaemonCommand, DaemonSessionLifecycle};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use super::daemon::{
    admit_session, attach_daemon_session, create_daemon_session, reserve_session_slot, summary_str,
    teardown, DaemonAcpOptions, DaemonAcpState, DaemonBinding, DaemonLink,
};
use super::jsonrpc;
use super::producer::FrameSink;
use super::types::{self, AcpSessionUpdate, TextBlock};
use super::wire_events::{wire_updates, WireMappingState};

/// The most session files one `session/list` page folds.
const LIST_PAGE_FILES: u64 = 100;

/// `session/list`: one page of the saved catalog as ACP `SessionInfo`
/// rows. The cursor is the catalog's own `nextCursor`.
pub(super) async fn handle_session_list(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    tx: FrameSink,
) {
    let active_session_id = state.lock().await.binding.active_session_id.clone();
    let cursor = params.get("cursor").and_then(Value::as_str);
    let page = match saved_sessions(link, &active_session_id, Some(LIST_PAGE_FILES), cursor).await {
        Ok(page) => page,
        Err(error) => {
            let _ = tx.send(super::internal_error(&id, &error.to_string()));
            return;
        }
    };
    let cwd = params.get("cwd").and_then(Value::as_str);
    let sessions: Vec<Value> = page["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| cwd.is_none_or(|cwd| row["cwd"].as_str() == Some(cwd)))
        .filter_map(session_info)
        .collect();
    let mut result = json!({ "sessions": sessions });
    if let Some(next_cursor) = page.get("nextCursor") {
        result["nextCursor"] = next_cursor.clone();
    }
    let _ = tx.send(jsonrpc::response(&id, &result));
}

/// One catalog row as an ACP `SessionInfo`; subagent sessions and sessions
/// without messages are not listed.
fn session_info(row: &Value) -> Option<Value> {
    if row["rlmDepth"].as_u64().unwrap_or(0) != 0 || row["messageCount"].as_u64().unwrap_or(0) == 0
    {
        return None;
    }
    let mut info = json!({ "sessionId": row["id"], "cwd": row["cwd"] });
    if let Some(title) = row["name"].as_str().or(row["firstMessage"].as_str()) {
        info["title"] = json!(title);
    }
    if let Some(modified) = row["modified"]
        .as_str()
        .filter(|modified| !modified.is_empty())
    {
        info["updatedAt"] = json!(modified);
    }
    Some(info)
}

/// The `list_saved_sessions` response data, addressed by the bound
/// session (its session dir).
async fn saved_sessions(
    link: &Arc<DaemonLink>,
    active_session_id: &str,
    limit: Option<u64>,
    cursor: Option<&str>,
) -> anyhow::Result<Value> {
    let response = link
        .request(DaemonCommand::ListSavedSessions {
            id: None,
            active_session_id: Some(active_session_id.to_string()),
            cwd: None,
            session_dir: None,
            scope: Value::Null,
            limit,
            cursor: cursor.map(str::to_string),
            rest: Map::default(),
        })
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    Ok(response.data.unwrap_or(Value::Null))
}

/// `session/load`: open the saved session the id names, bind the
/// connection to it, and host it like `session/new`, replaying its
/// conversation before the response.
pub(super) async fn handle_session_load(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    options: &DaemonAcpOptions,
    tx: FrameSink,
) {
    if !reserve_session_slot(&id, state, &tx).await {
        return;
    }
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let history = match bind_saved_session(session_id, link, state, options).await {
        Ok(Some(history)) => history,
        Ok(None) => {
            state.lock().await.session_new_in_flight = false;
            let _ = tx.send(jsonrpc::error_response(
                &id,
                jsonrpc::INVALID_PARAMS,
                "Invalid params",
                Some(&json!({ "reason": format!("Unknown session: {session_id}") })),
            ));
            return;
        }
        Err(error) => {
            state.lock().await.session_new_in_flight = false;
            let _ = tx.send(super::internal_error(&id, &format!("{error:#}")));
            return;
        }
    };
    admit_session(
        id,
        types::NewSessionParams::parse(&params),
        Some(history),
        link,
        state,
        tx,
    )
    .await;
}

/// Open the saved session through the daemon's create (which reuses the
/// live worker already serving the file), attach it, leave the previously
/// bound daemon session the way EOF would, and return the stored
/// conversation. `None` when no saved session has the id.
async fn bind_saved_session(
    session_id: &str,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    options: &DaemonAcpOptions,
) -> anyhow::Result<Option<Vec<Value>>> {
    let bound = state.lock().await.binding.clone();
    let catalog = saved_sessions(link, &bound.active_session_id, None, None).await?;
    let Some(row) = catalog["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| row["id"].as_str() == Some(session_id))
    else {
        return Ok(None);
    };
    let mut create = options.create.clone();
    if let DaemonCommand::Create {
        session_path,
        no_session,
        lifecycle,
        config,
        ..
    } = &mut create
    {
        *session_path = row["path"].as_str().map(str::to_string);
        *no_session = None;
        *lifecycle = Some(DaemonSessionLifecycle::Resident);
        if let Some(config) = config.as_mut() {
            config["cwd"] = row["cwd"].clone();
        }
    }
    let summary = create_daemon_session(link, create).await?;
    let loaded = DaemonBinding {
        active_session_id: summary_str(&summary, "activeSessionId"),
        session_id: summary_str(&summary, "sessionId"),
        cwd: PathBuf::from(summary_str(&summary, "cwd")),
        client_owned: false,
        mcp_owner_id: bound.mcp_owner_id.clone(),
    };
    // Loading the session this connection already hosts keeps the binding.
    if loaded.active_session_id != bound.active_session_id {
        attach_daemon_session(link, &loaded.active_session_id).await?;
        teardown(link, state, &bound).await;
        if !bound.client_owned {
            let _ = link
                .request(DaemonCommand::Detach {
                    id: None,
                    active_session_id: Some(bound.active_session_id.clone()),
                    rest: Map::default(),
                })
                .await;
        }
        state.lock().await.binding = loaded.clone();
    }
    let messages = link
        .request(DaemonCommand::GetMessages {
            id: None,
            active_session_id: state.lock().await.binding.active_session_id.clone(),
            page: None,
            capabilities: None,
            rest: Map::default(),
        })
        .await?;
    if !messages.success {
        anyhow::bail!(messages
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    Ok(Some(
        messages
            .data
            .and_then(|data| data.get("messages").and_then(Value::as_array).cloned())
            .unwrap_or_default(),
    ))
}

/// The stored conversation as `session/update`s, in order. User text is
/// a `user_message_chunk`; assistant and tool-result messages go through
/// the live event mapping as the events their live turn streamed.
pub(super) fn history_updates(
    messages: &[Value],
    mapping: &mut WireMappingState,
) -> Vec<AcpSessionUpdate> {
    let mut updates = Vec::new();
    for message in messages {
        let events = match message["role"].as_str() {
            Some("user") => {
                let text =
                    serde_json::from_value::<pa_types::ai::UserContent>(message["content"].clone())
                        .map(|content| content.text())
                        .unwrap_or_default();
                if !text.is_empty() {
                    updates.push(AcpSessionUpdate::UserMessageChunk {
                        content: TextBlock::new(text),
                    });
                }
                continue;
            }
            Some("assistant") => assistant_events(message),
            Some("toolResult") => vec![json!({
                "type": "tool_execution_end",
                "toolCallId": message["toolCallId"],
                "result": { "content": message["content"], "details": message["details"] },
                "isError": message["isError"],
            })],
            _ => continue,
        };
        for event in &events {
            updates.extend(wire_updates(event, mapping));
        }
    }
    updates
}

/// The live events of one stored assistant message: its text and thinking
/// as deltas, then a tool start per tool call.
fn assistant_events(message: &Value) -> Vec<Value> {
    let role = json!({ "role": "assistant" });
    let blocks = message["content"].as_array().map_or(&[][..], Vec::as_slice);
    let mut events = vec![json!({ "type": "message_start", "message": role })];
    for block in blocks {
        let delta = match block["type"].as_str() {
            Some("text") => json!({ "type": "text_delta", "delta": block["text"] }),
            Some("thinking") => json!({ "type": "thinking_delta", "delta": block["thinking"] }),
            _ => continue,
        };
        events.push(json!({
            "type": "message_update",
            "message": role,
            "assistantMessageEvent": delta,
        }));
    }
    events.push(json!({ "type": "message_end", "message": role }));
    for block in blocks.iter().filter(|block| block["type"] == "toolCall") {
        events.push(json!({
            "type": "tool_execution_start",
            "toolCallId": block["id"],
            "toolName": block["name"],
            "args": block["arguments"],
        }));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_replays_user_text_assistant_output_and_settled_tool_calls_in_order() {
        let messages = vec![
            json!({ "role": "user", "content": [{ "type": "text", "text": "Run it." }], "timestamp": 1 }),
            json!({
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "plan" },
                    { "type": "text", "text": "Running." },
                    { "type": "toolCall", "id": "call-1", "name": "python_repl", "arguments": { "code": "1+1" } },
                ],
                "timestamp": 2,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "call-1",
                "toolName": "python_repl",
                "content": [{ "type": "text", "text": "2" }],
                "isError": false,
                "timestamp": 3,
            }),
            json!({ "role": "compactionSummary", "summary": "s", "tokensBefore": 1, "timestamp": 4 }),
        ];
        let updates: Vec<Value> = history_updates(&messages, &mut WireMappingState::default())
            .iter()
            .map(AcpSessionUpdate::to_bare_value)
            .collect();
        let kinds: Vec<&str> = updates
            .iter()
            .map(|update| update["sessionUpdate"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            [
                "user_message_chunk",
                "agent_thought_chunk",
                "agent_message_chunk",
                "tool_call",
                "tool_call_update",
            ]
        );
        assert_eq!(updates[0]["content"]["text"], "Run it.");
        assert_eq!(updates[1]["messageId"], updates[2]["messageId"]);
        assert_eq!(updates[2]["content"]["text"], "Running.");
        assert_eq!(updates[3]["toolCallId"], "call-1");
        assert_eq!(updates[3]["rawInput"], json!({ "code": "1+1" }));
        assert_eq!(updates[4]["status"], "completed");
        assert_eq!(updates[4]["content"][0]["content"]["text"], "2");
    }
}

//! `rlm.respond`: the model sends text to the user as its reply. The handler
//! attaches one `rlm_response` row to the running tool batch, so the row lands
//! right after the sending cell's tool result — one row the transcript, the
//! session log, and the model's next request all read in that place.

use std::sync::Arc;

use serde_json::Value;

use crate::kernel::shared::{host_handler, HostRequestHandlers};

use super::bash_notices::{bound_agent, SessionAgentSlot};
use super::messages::create_rlm_response_message;
use super::{session_message_to_loop, SessionAgentMessage};

/// Register the `rlm.respond` host handler over the session's agent.
pub(super) fn register_respond_handler(
    agent_slot: &SessionAgentSlot,
    handlers: &mut HostRequestHandlers,
) {
    let agent_slot = Arc::clone(agent_slot);
    handlers.register(
        "rlm.respond",
        host_handler(move |payload| {
            let agent_slot = Arc::clone(&agent_slot);
            async move {
                let Some(text) = payload
                    .data
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                else {
                    anyhow::bail!("rlm.respond text must be a non-empty string");
                };
                let Some(agent) = bound_agent(&agent_slot) else {
                    anyhow::bail!("rlm.respond has no session to send to");
                };
                // Outside a run no tool batch would carry the row.
                if !agent.state().await.is_streaming {
                    anyhow::bail!("rlm.respond works only inside a running cell");
                }
                let row = SessionAgentMessage::Custom(create_rlm_response_message(text));
                let Some(row) = session_message_to_loop(&row) else {
                    anyhow::bail!("rlm.respond could not build its message row");
                };
                agent.attach_to_tool_batch(row);
                Ok(serde_json::json!({}))
            }
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::{HostHandlerFn, HostRequestPayload};
    use crate::session_engine::messages::{engine_convert_to_llm, RLM_RESPONSE_PREFIX};
    use pa_agent::abort::AbortSignal;
    use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
    use pa_agent::scripted::ScriptedProvider;
    use pa_agent::types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, Model};

    const TABLE: &str = "| a | b |\n|---|---|\n| 1 | 2 |\n";

    fn send(text: &str) -> HostRequestPayload {
        HostRequestPayload {
            data: serde_json::json!({ "type": "rlm.respond", "text": text }),
        }
    }

    /// A `python_repl` stand-in whose cell calls `rlm.respond`.
    struct RespondingCell {
        respond: HostHandlerFn,
    }

    impl AgentTool for RespondingCell {
        fn name(&self) -> &'static str {
            "python_repl"
        }

        fn description(&self) -> &'static str {
            "Sends a table with rlm.respond."
        }

        fn parameters(&self) -> &Value {
            static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
            SCHEMA.get_or_init(|| serde_json::json!({ "type": "object", "properties": {} }))
        }

        fn execute(
            self: Arc<Self>,
            _tool_call_id: String,
            _params: Value,
            _signal: AbortSignal,
            _on_update: AgentToolUpdateCallback,
        ) -> pa_agent::BoxFut<'static, anyhow::Result<AgentToolResult>> {
            Box::pin(async move {
                (self.respond)(send(TABLE)).await?;
                Ok(AgentToolResult::text("Sent to the user."))
            })
        }
    }

    #[tokio::test]
    async fn a_sent_response_lands_after_its_tool_result_and_the_model_reads_it_there() {
        let slot = SessionAgentSlot::default();
        let mut handlers = HostRequestHandlers::default();
        register_respond_handler(&slot, &mut handlers);
        let respond = handlers.get("rlm.respond").expect("registered").clone();
        let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                tools: Some(vec![Arc::new(RespondingCell {
                    respond: respond.clone(),
                })]),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            convert_to_llm: Some(engine_convert_to_llm()),
            ..Default::default()
        }));
        *slot.lock().unwrap() = Some(Arc::downgrade(&agent));

        assert!(
            respond(send(TABLE)).await.is_err(),
            "no run, so no tool batch to carry the row"
        );
        assert!(respond(send("  \n")).await.is_err());

        provider.push_tool_call_turn(None, vec![("call-1", "python_repl", serde_json::json!({}))]);
        provider.push_text_turn("");
        agent.prompt("table please").await.unwrap();
        agent.wait_for_idle().await;

        let calls = provider.calls();
        assert_eq!(calls.len(), 2, "the response takes no turn of its own");
        let tail: Vec<Value> = calls[1].messages[calls[1].messages.len() - 2..]
            .iter()
            .map(|message| serde_json::to_value(message).unwrap())
            .collect();
        assert_eq!(tail[0]["role"], "toolResult");
        assert_eq!(tail[1]["role"], "user");
        assert_eq!(
            tail[1]["content"][0]["text"],
            format!("{RLM_RESPONSE_PREFIX}{TABLE}")
        );

        let messages = agent.state().await.messages;
        let rows: Vec<Value> = messages
            .iter()
            .map(|message| serde_json::to_value(message).unwrap())
            .collect();
        let row = &rows[3];
        assert_eq!(rows[2]["role"], "toolResult");
        assert_eq!(
            (
                &row["role"],
                &row["customType"],
                &row["content"],
                &row["display"]
            ),
            (
                &serde_json::json!("custom"),
                &serde_json::json!("rlm_response"),
                &serde_json::json!(TABLE),
                &serde_json::json!(true),
            ),
            "the row keeps the text verbatim for the transcript"
        );
    }
}

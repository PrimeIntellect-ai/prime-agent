//! Bridge pa-core tool definitions into the pa-agent loop's `AgentTool`.
//! Port role: TS createAgentSession assembles tools from the built-in set;
//! this adapter is the Rust equivalent of passing `ToolDefinition`s to the
//! loop unchanged.

use std::sync::Arc;

use pa_agent::abort::AbortSignal;
use pa_agent::types::{
    AgentTool, AgentToolResult, AgentToolUpdateCallback,
    ToolExecutionMode as LoopToolExecutionMode, ToolResultContent,
};

use crate::tools::tool_definition::{ExecutionMode, ToolDefinition, ToolExecutionResult};

/// A loop-visible tool backed by a pa-core definition.
pub struct ToolDefinitionBridge {
    definition: ToolDefinition,
}

impl ToolDefinitionBridge {
    pub fn new(definition: ToolDefinition) -> Self {
        Self { definition }
    }
}

fn convert_content(result: ToolExecutionResult) -> Vec<ToolResultContent> {
    convert_content_blocks(result.content)
}

fn convert_content_blocks(
    blocks: Vec<crate::tools::tool_definition::ToolContentBlock>,
) -> Vec<ToolResultContent> {
    blocks
        .into_iter()
        .map(|block| match block {
            crate::tools::tool_definition::ToolContentBlock::Text { text } => {
                ToolResultContent::text(text)
            }
            crate::tools::tool_definition::ToolContentBlock::Image { data, mime_type } => {
                ToolResultContent::Image(pa_agent::types::ImageContent { data, mime_type })
            }
        })
        .collect()
}

impl AgentTool for ToolDefinitionBridge {
    fn name(&self) -> &str {
        &self.definition.name
    }

    fn description(&self) -> &str {
        &self.definition.description
    }

    fn parameters(&self) -> &serde_json::Value {
        &self.definition.parameters
    }

    fn label(&self) -> &str {
        &self.definition.label
    }

    fn prepare_arguments(&self, args: &serde_json::Value) -> Option<serde_json::Value> {
        self.definition
            .prepare_arguments
            .as_ref()
            .map(|prepare| prepare(args.clone()))
    }

    fn execute(
        self: Arc<Self>,
        tool_call_id: String,
        params: serde_json::Value,
        signal: AbortSignal,
        on_update: AgentToolUpdateCallback,
    ) -> pa_agent::BoxFut<'static, anyhow::Result<AgentToolResult>> {
        let definition = self.definition.clone();
        Box::pin(async move {
            let abort = crate::tools::tool_definition::AbortSignal::new();
            {
                // Wire the loop's signal into the tool's cancellation token.
                let abort = abort.clone();
                let signal = signal.clone();
                tokio::spawn(async move {
                    // Park on the signal's watch channel: an abort fires the
                    // cancellation token immediately (tighter than the loop's
                    // old few-ms poll contract), and an uninterrupted call
                    // leaves no wake-up work behind — a completed tool call
                    // must not keep a 10 ms polling task alive for the
                    // session's lifetime.
                    signal.aborted().await;
                    abort.cancel();
                });
            }
            // Streamed tool updates become `tool_execution_update` events:
            // the same in-flight previews TS forwards to attached clients
            // (streaming cell/bash output, and the kernel-boot stage notes
            // the interactive loader mirrors). The loop's callback owns the
            // accepting/abort gating.
            let tool_on_update: Option<crate::tools::tool_definition::OnUpdate> =
                Some(Arc::new(move |update| {
                    on_update(AgentToolResult {
                        content: convert_content_blocks(update.content),
                        details: update.details.unwrap_or(serde_json::Value::Null),
                        terminate: None,
                    });
                }));
            let f = definition.execute.clone();
            let result: ToolExecutionResult =
                f(&tool_call_id, params, Some(abort), tool_on_update).await?;
            let details = result.details.clone().unwrap_or(serde_json::Value::Null);
            let is_error = result.is_error;
            let _ = is_error;
            Ok(AgentToolResult {
                content: convert_content(result),
                details,
                terminate: None,
            })
        })
    }

    fn execution_mode(&self) -> Option<LoopToolExecutionMode> {
        // The pa-core contract has no parallel variant; sequential tools
        // carry the only override.
        (self.definition.execution_mode == Some(ExecutionMode::Sequential))
            .then_some(LoopToolExecutionMode::Sequential)
    }
}

/// Wrap a definition in the loop's tool trait.
pub fn bridge_tool(definition: ToolDefinition) -> Arc<dyn AgentTool> {
    Arc::new(ToolDefinitionBridge::new(definition))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shout_args(mut args: serde_json::Value) -> serde_json::Value {
        if let Some(text) = args.get("text").and_then(|t| t.as_str()) {
            args["text"] = serde_json::json!(text.to_uppercase());
        }
        args
    }

    fn echo_definition(is_error: bool) -> ToolDefinition {
        let is_error = std::sync::Arc::new(is_error);
        ToolDefinition {
            name: "echo".to_string(),
            label: "Echo".to_string(),
            description: "Echoes its input".to_string(),
            prompt_snippet: String::new(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
            execution_mode: Some(ExecutionMode::Sequential),
            prepare_arguments: Some(shout_args),
            execute: Arc::new(move |_id, params, _signal, _on_update| {
                let text = params
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .to_string();
                let is_error = *is_error;
                Box::pin(async move {
                    if is_error {
                        anyhow::bail!("echo failed");
                    }
                    Ok(ToolExecutionResult::text(format!("echo: {text}")))
                })
            }),
        }
    }

    #[tokio::test]
    async fn bridges_definition_into_the_loop_contract() {
        let tool = bridge_tool(echo_definition(false));
        assert_eq!(tool.name(), "echo");
        assert_eq!(tool.description(), "Echoes its input");
        assert_eq!(tool.label(), "Echo");
        assert!(tool.parameters().get("properties").is_some());
        assert_eq!(
            tool.execution_mode(),
            Some(LoopToolExecutionMode::Sequential)
        );
        // prepare_arguments flows through.
        let prepared = tool.prepare_arguments(&serde_json::json!({ "text": "hi" }));
        assert_eq!(prepared.unwrap()["text"], "HI");
        // Execution returns the loop's result shape.
        let result = tool
            .clone()
            .execute(
                "call-1".to_string(),
                serde_json::json!({ "text": "hello" }),
                AbortSignal::default(),
                Arc::new(|_result| {}),
            )
            .await
            .unwrap();
        assert_eq!(result.content.len(), 1);
    }

    /// Streamed tool updates reach the loop's update callback (TS `onUpdate`
    /// -> `tool_execution_update`): the interactive loader's kernel-boot
    /// note and live cell output ride this channel.
    #[tokio::test]
    async fn streamed_updates_reach_the_loop_callback() {
        use std::sync::Mutex;
        let definition = ToolDefinition {
            name: "progress".to_string(),
            label: "Progress".to_string(),
            description: "Reports progress".to_string(),
            prompt_snippet: String::new(),
            parameters: serde_json::json!({ "type": "object" }),
            execution_mode: None,
            prepare_arguments: None,
            execute: Arc::new(|_id, _params, _signal, on_update| {
                Box::pin(async move {
                    if let Some(on_update) = on_update {
                        on_update(crate::tools::tool_definition::ToolUpdate {
                            content: vec![crate::tools::tool_definition::ToolContentBlock::text(
                                "starting",
                            )],
                            details: Some(serde_json::json!({ "status": "starting" })),
                        });
                    }
                    Ok(ToolExecutionResult::text("done"))
                })
            }),
        };
        let tool = bridge_tool(definition);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        tool.execute(
            "call-3".to_string(),
            serde_json::json!({}),
            AbortSignal::default(),
            Arc::new(move |result| sink.lock().unwrap().push(result)),
        )
        .await
        .unwrap();
        let updates = seen.lock().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0].details,
            serde_json::json!({ "status": "starting" })
        );
        assert_eq!(
            updates[0].content,
            vec![ToolResultContent::text("starting")]
        );
    }

    #[tokio::test]
    async fn errors_surface_as_err_like_a_throw() {
        let tool = bridge_tool(echo_definition(true));
        let error = tool
            .clone()
            .execute(
                "call-2".to_string(),
                serde_json::json!({ "text": "x" }),
                AbortSignal::default(),
                Arc::new(|_result| {}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("echo failed"));
    }
}

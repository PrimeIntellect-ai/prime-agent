//! The loop-visible bridge for extension tools (design doc §3.3): an
//! `AgentTool` whose `execute` dispatches `tool_execute` over the sidecar
//! RPC. The registration (name/label/description/JSON Schema parameters)
//! crossed the wire at load; the live `execute` stays in the sidecar.
//!
//! Port role: TS `wrapRegisteredTool` (extensions/wrapper.ts) adapts a
//! `RegisteredTool` into the loop's `AgentTool`; this is the Rust equivalent
//! for the sidecar world. Name allow-list filtering (`--tools`, TS
//! agent-session.ts `isAllowedTool`) applies before bridging
//! ([`crate::extensions::ExtensionRunner::bridge_tools`]).
//!
//! Stage-2 deviations (documented, design doc §2.3/§2.6):
//! - `prepareArguments` is a function and cannot cross the wire; extension
//!   tools receive raw validated args.
//! - `renderCall`/`renderResult` components cannot cross; the default tool
//!   rendering applies.
//! - tool `signal`/cancellation tokens arrive with the event-surface stage.

use std::sync::Arc;
use std::time::Duration;

use super::client::RpcClient;
use pa_agent::abort::AbortSignal;
use pa_agent::types::{
    AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode, ToolResultContent,
};
use pa_types::extension_rpc::{
    ToolExecuteParams, ToolExecuteResult, ToolRegistration, ToolResultBlock, METHOD_TOOL_EXECUTE,
};
/// One extension tool bridged into the loop contract. Generic over the
/// RPC writer so tests can drive a duplex (the host uses the sidecar's
/// stdin pipe).
pub struct ExtensionTool<W> {
    registration: ToolRegistration,
    client: Arc<RpcClient<W>>,
    rpc_timeout: Duration,
}

impl<W> ExtensionTool<W> {
    pub fn new(
        registration: ToolRegistration,
        client: Arc<RpcClient<W>>,
        rpc_timeout: Duration,
    ) -> Self {
        ExtensionTool {
            registration,
            client,
            rpc_timeout,
        }
    }

    /// The registration this tool was bridged from (snippets/guidelines for
    /// prompt assembly, schema provenance).
    pub fn registration(&self) -> &ToolRegistration {
        &self.registration
    }
}

fn convert_blocks(result: ToolExecuteResult) -> Vec<ToolResultContent> {
    result
        .content
        .into_iter()
        .map(|block| match block {
            ToolResultBlock::Text { text } => ToolResultContent::text(text),
            ToolResultBlock::Image { data, mime_type } => {
                ToolResultContent::Image(pa_agent::types::ImageContent { data, mime_type })
            }
        })
        .collect()
}

impl<W> AgentTool for ExtensionTool<W>
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    fn name(&self) -> &str {
        &self.registration.name
    }

    fn description(&self) -> &str {
        &self.registration.description
    }

    fn parameters(&self) -> &serde_json::Value {
        &self.registration.parameters
    }

    fn label(&self) -> &str {
        &self.registration.label
    }

    fn prepare_arguments(&self, _args: &serde_json::Value) -> Option<serde_json::Value> {
        // prepareArguments is a function and cannot cross the wire.
        None
    }

    fn execute(
        self: Arc<Self>,
        tool_call_id: String,
        params: serde_json::Value,
        _signal: AbortSignal,
        _on_update: AgentToolUpdateCallback,
    ) -> pa_agent::BoxFut<'static, anyhow::Result<AgentToolResult>> {
        let tool = self;
        Box::pin(async move {
            let request = serde_json::to_value(ToolExecuteParams {
                tool_call_id,
                tool_name: tool.registration.name.clone(),
                args: params,
            })
            .map_err(|error| anyhow::anyhow!("serializing extension tool params: {error}"))?;
            let reply = tool
                .client
                .request(METHOD_TOOL_EXECUTE, request, tool.rpc_timeout)
                .await?;
            let result: ToolExecuteResult = serde_json::from_value(reply)
                .map_err(|error| anyhow::anyhow!("parsing extension tool result: {error}"))?;
            let result_is_error = result.is_error;
            let details = result.details.clone().unwrap_or(serde_json::Value::Null);
            let content = convert_blocks(result);
            // `isError` crossed the wire, but the loop's `AgentToolResult`
            // has no error flag; surface it the way a thrown tool error
            // does in TS - the loop records an error tool result carrying
            // the (text) content in the message.
            if result_is_error {
                let text = content
                    .iter()
                    .map(|block| match block {
                        ToolResultContent::Text(text) => text.text.clone(),
                        ToolResultContent::Image(_) => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                return Err(anyhow::anyhow!(text));
            }
            Ok(AgentToolResult {
                content,
                details,
                terminate: None,
            })
        })
    }

    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        match self.registration.execution_mode.as_deref() {
            Some("sequential") => Some(ToolExecutionMode::Sequential),
            Some("parallel") => Some(ToolExecutionMode::Parallel),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_agent::types::ImageContent;
    use serde_json::json;

    #[test]
    fn wire_blocks_convert_to_loop_content() {
        let result = ToolExecuteResult {
            content: vec![
                ToolResultBlock::Text {
                    text: "Hello, world!".to_string(),
                },
                ToolResultBlock::Image {
                    data: "aGk=".to_string(),
                    mime_type: "image/png".to_string(),
                },
            ],
            details: Some(json!({"greeted": "world"})),
            is_error: false,
        };
        let blocks = convert_blocks(result);
        assert_eq!(blocks[0], ToolResultContent::text("Hello, world!"));
        assert_eq!(
            blocks[1],
            ToolResultContent::Image(ImageContent {
                data: "aGk=".to_string(),
                mime_type: "image/png".to_string()
            })
        );
    }
}

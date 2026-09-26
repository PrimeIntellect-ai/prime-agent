//! Tool definition surface: the model-facing contract of a tool.
//!
//! Port of `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`
//! plus the `ToolDefinition` shape from `core/extensions/types.ts`. TUI
//! renderers stay in `pa-tui`; this layer owns the model-facing contract
//! (name, schema, description) and execution.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use pa_types::ai::Tool;

/// How the runtime may schedule calls of this tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    /// The backing resource is single-threaded; calls must not run in parallel
    /// within a batch.
    Sequential,
}

/// One content block of a tool result.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContentBlock {
    Text {
        text: String,
    },
    Image {
        /// Base64 image payload.
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

impl ToolContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        ToolContentBlock::Text { text: text.into() }
    }

    /// The text of a text block, or `None` for images.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            ToolContentBlock::Text { text } => Some(text),
            ToolContentBlock::Image { .. } => None,
        }
    }
}

/// A streamed in-flight update of a tool execution.
#[derive(Debug, Clone)]
pub struct ToolUpdate {
    pub content: Vec<ToolContentBlock>,
    pub details: Option<serde_json::Value>,
}

/// The result of a tool execution.
///
/// Errors are not a variant here: like the TS product, a failing tool call
/// surfaces as an `Err` (thrown error) whose message is the model-facing text.
#[derive(Debug, Clone, Default)]
pub struct ToolExecutionResult {
    pub content: Vec<ToolContentBlock>,
    pub details: Option<serde_json::Value>,
    pub is_error: bool,
}

impl ToolExecutionResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContentBlock::text(text)],
            details: None,
            is_error: false,
        }
    }
}

/// Cancellation handle passed to tool executions (TS: `AbortSignal`).
pub type AbortSignal = tokio_util::sync::CancellationToken;

/// Streaming update callback (TS: `onUpdate`).
pub type OnUpdate = Arc<dyn Fn(ToolUpdate) + Send + Sync>;

pub type ExecuteFuture = Pin<Box<dyn Future<Output = anyhow::Result<ToolExecutionResult>> + Send>>;

pub type ExecuteFn = Arc<
    dyn Fn(&str, serde_json::Value, Option<AbortSignal>, Option<OnUpdate>) -> ExecuteFuture
        + Send
        + Sync,
>;

/// Normalizes tool arguments before schema validation (TS: `prepareArguments`).
pub type PrepareArgumentsFn = fn(serde_json::Value) -> serde_json::Value;

/// A model-facing tool definition: exact name, JSON schema, and executor.
#[derive(Clone)]
pub struct ToolDefinition {
    /// Tool name exposed to the model.
    pub name: String,
    /// Human-facing label.
    pub label: String,
    /// Model-facing description.
    pub description: String,
    /// Short snippet included in the system prompt.
    pub prompt_snippet: String,
    /// JSON schema for the tool input.
    pub parameters: serde_json::Value,
    /// Scheduling constraints; `None` means unconstrained.
    pub execution_mode: Option<ExecutionMode>,
    /// Argument normalization before validation.
    pub prepare_arguments: Option<PrepareArgumentsFn>,
    /// Executes the tool. The error message is the model-facing error text.
    pub execute: ExecuteFn,
}

impl ToolDefinition {
    /// Built-in tool name used for replay in recorded sessions.
    pub fn replay_built_in_tool_name(&self) -> Option<&str> {
        match self.name.as_str() {
            "bash" | "edit" | "ipython" => Some(self.name.as_str()),
            _ => None,
        }
    }

    /// The wire `Tool` sent to providers (name, description, parameters).
    pub fn to_tool(&self) -> Tool {
        Tool {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
        }
    }
}

/// Wrap a `ToolDefinition` into the plain executable form used by the agent
/// runtime (TS: `wrapToolDefinition`).
#[allow(dead_code)]
pub fn wrap_tool_definition(definition: &ToolDefinition) -> WrappedTool {
    WrappedTool {
        name: definition.name.clone(),
        label: definition.label.clone(),
        description: definition.description.clone(),
        parameters: definition.parameters.clone(),
        prepare_arguments: definition.prepare_arguments,
        execute: definition.execute.clone(),
    }
}

/// An `AgentTool`: the execution-facing projection of a definition.
#[derive(Clone)]
pub struct WrappedTool {
    pub name: String,
    pub label: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub prepare_arguments: Option<PrepareArgumentsFn>,
    pub execute: ExecuteFn,
}

impl WrappedTool {
    /// Run the wrapped tool once.
    ///
    /// # Errors
    ///
    /// Returns the wrapped tool's own execution error.
    pub async fn execute(
        &self,
        tool_call_id: &str,
        params: serde_json::Value,
        signal: Option<AbortSignal>,
        on_update: Option<OnUpdate>,
    ) -> anyhow::Result<ToolExecutionResult> {
        let f = self.execute.clone();
        f(tool_call_id, params, signal, on_update).await
    }
}

/// Synthesize a minimal [`ToolDefinition`] from a plain executable tool
/// (TS: `createToolDefinitionFromAgentTool`).
#[allow(dead_code)]
pub fn tool_definition_from_wrapped(tool: &WrappedTool) -> ToolDefinition {
    ToolDefinition {
        name: tool.name.clone(),
        label: tool.label.clone(),
        description: tool.description.clone(),
        prompt_snippet: String::new(),
        parameters: tool.parameters.clone(),
        execution_mode: None,
        prepare_arguments: tool.prepare_arguments,
        execute: tool.execute.clone(),
    }
}

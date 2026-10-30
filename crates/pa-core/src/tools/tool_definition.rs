//! Tool definition surface: the model-facing contract of a tool (name,
//! schema, description) and execution; TUI renderers stay in `pa-tui`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use pa_types::ai::Tool;

/// How the runtime may schedule calls of this tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    /// The backing resource is single-threaded; calls must not run in parallel within a batch.
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
    #[must_use]
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

/// The result of a tool execution. Errors are not a variant here: like the TS product, a
/// failing tool call surfaces as an `Err` whose message is the model-facing text.
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
    pub name: String,
    pub label: String,
    pub description: String,
    /// Short snippet included in the system prompt.
    pub prompt_snippet: String,
    pub parameters: serde_json::Value,
    /// Scheduling constraints; `None` means unconstrained.
    pub execution_mode: Option<ExecutionMode>,
    pub prepare_arguments: Option<PrepareArgumentsFn>,
    /// Executes the tool. The error message is the model-facing error text.
    pub execute: ExecuteFn,
}

impl ToolDefinition {
    /// The wire `Tool` sent to providers (name, description, parameters).
    #[must_use]
    pub fn to_tool(&self) -> Tool {
        Tool {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
        }
    }
}

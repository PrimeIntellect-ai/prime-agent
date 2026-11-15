//! The `mcp.notification` kernel host handler.
//!
//! The kernel buffers MCP server notifications and forwards them as bounded
//! entries (`prime-agent-runtime/src/rlm/mcp_notify.py`): significant kinds —
//! a tool/prompt/resource inventory change, a subscribed resource update, a
//! lost subscription — in their own frames, informational kinds (log lines,
//! progress) coalesced separately. This module turns one frame into a durable
//! transcript row, and steers a turn only for the significant kinds: a chatty
//! server must never wake the model per log line.
//!
//! Validation is fail-closed and bounded: the kernel already projects the SDK
//! notification to a summary, but the frame crosses a process boundary, so
//! unknown kinds, oversized fields, and empty batches are refused rather than
//! rendered.

use std::sync::Arc;

use pa_types::ai::UserContent;
use pa_types::session::CustomMessage;
use serde_json::{json, Value};

use super::bash_notices::{KernelNotice, KernelNoticeSink};
use crate::kernel::shared::{host_handler, HostRequestHandlers};

/// The custom row type one notification frame lands as
/// (`customType` on the wire; the TUI's generic panel renders it).
pub const MCP_NOTIFICATION_CUSTOM_TYPE: &str = "mcp_notification";
/// The input queue's preview label for the woken row.
const PREVIEW_LABEL: &str = "mcp";

const MAX_ENTRIES: usize = 8;
const MAX_SERVER_CHARS: usize = 128;
const MAX_SUMMARY_CHARS: usize = 512;
const MAX_CONTENT_CHARS: usize = 4096;

/// Kinds that mean the model's picture of the server is stale: these wake a turn.
const SIGNIFICANT_KINDS: [&str; 5] = [
    "tools_changed",
    "prompts_changed",
    "resources_changed",
    "resource_updated",
    "subscription_lost",
];
/// Informational kinds: row only, never a wake.
const NOISY_KINDS: [&str; 2] = ["logging", "progress"];

/// The durable-row seam for informational notifications: persist and broadcast
/// the row, never steer. The worker binds it to its own row emitters.
pub type McpNotificationRowSink = Arc<dyn Fn(CustomMessage) + Send + Sync>;

/// The `mcp.notification` host handler.
///
/// A frame whose entries are all significant steers `notice` (the row persists
/// and the model wakes); any other frame only writes the row through `row`.
pub fn register_mcp_notification_host_handler(
    notice: KernelNoticeSink,
    row: McpNotificationRowSink,
    handlers: &mut HostRequestHandlers,
) {
    handlers.register(
        "mcp.notification",
        host_handler(move |payload| {
            let notice = Arc::clone(&notice);
            let row = Arc::clone(&row);
            Box::pin(async move {
                let batch = validate_entries(&payload.data)?;
                let message = batch.message()?;
                if batch.all_significant {
                    notice(KernelNotice {
                        row: message,
                        preview_label: PREVIEW_LABEL,
                    });
                } else {
                    row(message);
                }
                Ok(json!({}))
            })
        }),
    );
}

/// One validated notification frame.
pub(crate) struct NotificationBatch {
    /// One `[server] kind: summary` line per entry, in order.
    lines: Vec<String>,
    /// The entries as received (bounded), carried on the row's `details`.
    entries: Value,
    /// True when every entry is a significant kind (the kernel batches them
    /// separately, so a mixed frame is informational by construction).
    pub(crate) all_significant: bool,
}

impl NotificationBatch {
    /// The durable custom row for this frame.
    pub(crate) fn message(&self) -> anyhow::Result<CustomMessage> {
        let content = self.lines.join("\n");
        anyhow::ensure!(
            !content.is_empty() && content.chars().count() <= MAX_CONTENT_CHARS,
            "mcp.notification content is empty or over {MAX_CONTENT_CHARS} characters"
        );
        Ok(CustomMessage {
            custom_type: MCP_NOTIFICATION_CUSTOM_TYPE.to_string(),
            content: UserContent::Text(content),
            display: true,
            details: Some(self.entries.clone()),
            timestamp: 0,
            rest: pa_types::JsonMap::default(),
        })
    }
}

/// Validate one `mcp.notification` payload: a non-empty bounded batch of
/// entries with a known kind.
pub(crate) fn validate_entries(data: &Value) -> anyhow::Result<NotificationBatch> {
    let entries = data
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("mcp.notification requires an `entries` array"))?;
    anyhow::ensure!(
        !entries.is_empty() && entries.len() <= MAX_ENTRIES,
        "mcp.notification carries 1..={MAX_ENTRIES} entries"
    );
    let mut lines = Vec::with_capacity(entries.len());
    let mut all_significant = true;
    for entry in entries {
        let server = bounded_str(entry, "server", MAX_SERVER_CHARS)?;
        let kind = bounded_str(entry, "kind", 32)?;
        anyhow::ensure!(
            SIGNIFICANT_KINDS.contains(&kind.as_str()) || NOISY_KINDS.contains(&kind.as_str()),
            "mcp.notification kind `{kind}` is not a known notification kind"
        );
        if !SIGNIFICANT_KINDS.contains(&kind.as_str()) {
            all_significant = false;
        }
        let summary = entry
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default();
        anyhow::ensure!(
            summary.chars().count() <= MAX_SUMMARY_CHARS,
            "mcp.notification summary is over {MAX_SUMMARY_CHARS} characters"
        );
        let count = entry.get("count").and_then(Value::as_u64).unwrap_or(1);
        let suffix = if count > 1 {
            format!(" (x{count})")
        } else {
            String::new()
        };
        let detail = if summary.is_empty() {
            format!("[{server}] {kind}{suffix}")
        } else {
            format!("[{server}] {kind}: {summary}{suffix}")
        };
        lines.push(detail);
    }
    Ok(NotificationBatch {
        lines,
        entries: Value::Array(entries.clone()),
        all_significant,
    })
}

fn bounded_str(entry: &Value, field: &str, max: usize) -> anyhow::Result<String> {
    let value = entry
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("mcp.notification entry requires a `{field}` string"))?;
    anyhow::ensure!(
        !value.trim().is_empty() && value.chars().count() <= max,
        "mcp.notification `{field}` must be 1..={max} characters"
    );
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Test-only helper: the four tuple members are the two sinks under test and
    // the two recordings they append to.
    #[allow(clippy::type_complexity)]
    fn sinks() -> (
        KernelNoticeSink,
        McpNotificationRowSink,
        Arc<Mutex<Vec<CustomMessage>>>,
        Arc<Mutex<Vec<CustomMessage>>>,
    ) {
        let steered = Arc::new(Mutex::new(Vec::new()));
        let rowed = Arc::new(Mutex::new(Vec::new()));
        let notice_sink: KernelNoticeSink = {
            let steered = Arc::clone(&steered);
            Arc::new(move |notice: KernelNotice| {
                steered.lock().unwrap().push(notice.row);
            })
        };
        let row_sink: McpNotificationRowSink = {
            let rowed = Arc::clone(&rowed);
            Arc::new(move |message: CustomMessage| {
                rowed.lock().unwrap().push(message);
            })
        };
        (notice_sink, row_sink, steered, rowed)
    }

    async fn run_frame(
        data: Value,
    ) -> (
        Vec<CustomMessage>,
        Vec<CustomMessage>,
        anyhow::Result<Value>,
    ) {
        let (notice, row, steered, rowed) = sinks();
        let mut handlers = HostRequestHandlers::new();
        register_mcp_notification_host_handler(notice, row, &mut handlers);
        let handler = handlers.get("mcp.notification").expect("registered");
        let result = handler(crate::kernel::shared::HostRequestPayload { data }).await;
        let steered = steered.lock().unwrap().clone();
        let rowed = rowed.lock().unwrap().clone();
        (steered, rowed, result)
    }

    #[tokio::test]
    async fn a_significant_frame_steers_and_writes_nothing_else() {
        let (steered, rowed, result) = run_frame(json!({
            "entries": [
                {"server": "notion", "kind": "tools_changed", "summary": "tool list changed"},
                {"server": "notion", "kind": "resource_updated", "summary": "file:///a"}
            ]
        }))
        .await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(steered.len(), 1, "one row, steered once");
        assert!(rowed.is_empty(), "the steer owns the row; no second write");
        assert_eq!(
            steered[0].content,
            UserContent::Text(
                "[notion] tools_changed: tool list changed\n[notion] resource_updated: file:///a"
                    .to_string()
            )
        );
        assert_eq!(steered[0].custom_type, MCP_NOTIFICATION_CUSTOM_TYPE);
        assert!(steered[0].display);
    }

    #[tokio::test]
    async fn an_informational_frame_writes_a_row_without_waking() {
        let (steered, rowed, result) = run_frame(json!({
            "entries": [
                {"server": "svc", "kind": "logging", "summary": "warn: slow", "count": 3}
            ]
        }))
        .await;
        assert!(result.is_ok(), "{result:?}");
        assert!(steered.is_empty(), "a log line never wakes a turn");
        assert_eq!(rowed.len(), 1);
        assert_eq!(
            rowed[0].content,
            UserContent::Text("[svc] logging: warn: slow (x3)".to_string())
        );
    }

    #[tokio::test]
    async fn a_mixed_frame_is_informational() {
        let (steered, rowed, result) = run_frame(json!({
            "entries": [
                {"server": "svc", "kind": "tools_changed", "summary": "changed"},
                {"server": "svc", "kind": "progress", "summary": "50%"}
            ]
        }))
        .await;
        assert!(result.is_ok(), "{result:?}");
        assert!(
            steered.is_empty(),
            "a mixed frame must not wake on the noisy part"
        );
        assert_eq!(rowed.len(), 1);
    }

    #[tokio::test]
    async fn an_unknown_kind_is_refused() {
        let (steered, rowed, result) = run_frame(json!({
            "entries": [{"server": "svc", "kind": "surprise", "summary": "x"}]
        }))
        .await;
        assert!(result.is_err());
        assert!(steered.is_empty() && rowed.is_empty());
    }

    #[tokio::test]
    async fn an_oversized_or_empty_batch_is_refused() {
        let too_many: Vec<Value> = (0..=MAX_ENTRIES)
            .map(|index| json!({"server": "svc", "kind": "logging", "summary": format!("{index}")}))
            .collect();
        assert!(run_frame(json!({ "entries": too_many })).await.2.is_err());
        assert!(run_frame(json!({ "entries": [] })).await.2.is_err());
        assert!(run_frame(json!({})).await.2.is_err());
        let long_summary = "x".repeat(MAX_SUMMARY_CHARS + 1);
        assert!(run_frame(json!({
            "entries": [{"server": "svc", "kind": "logging", "summary": long_summary}]
        }))
        .await
        .2
        .is_err());
    }
}

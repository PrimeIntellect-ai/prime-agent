//! The daemon's inbox wake row: how much one row carries (rule 3), when an
//! idle session takes it (rules 2 and 4), and what its delivery consumes.
//! The queue admission in `queue.rs` owns the state: the durable inbox
//! holds every message, the coalescing batch holds the messages one queued
//! row covers, and the row itself is the wake. A read before delivery
//! withdraws the message (rule 1, driven by the kernel's lifecycle in
//! `prime-agent-runtime/src/rlm/inbox_lifecycle.py`). Every unread arrival
//! reaches the agent: a busy session folds it into the live turn, and an
//! idle session takes the row once its due time passes, so an agent that
//! ended its turn to wait for a command is always woken by it.

#[cfg(test)]
mod tests;

use pa_core::session_engine::inbox::{arrival_notice, arrival_summary, InboxMessage, InboxNotice};
use pa_core::settings::{Settings, SettingsManager};
use pa_types::inbox_notice::INBOX_CLASS_BASH_DONE;
use serde_json::Value;
use std::time::Duration;

/// Rule 3: a row covering at most this many items carries their content
/// under the summary line; a larger one is the summary line only.
const INLINE_ITEM_LIMIT: usize = 2;
/// Rule 3: the output tail an inline item carries, in lines and bytes.
const INLINE_TAIL_MAX_LINES: usize = 5;
const INLINE_TAIL_MAX_BYTES: usize = 400;

/// How long an idle session waits before one arrival's wake row may start
/// a turn: a successful bash completion is held
/// (`agentInbox.successHoldMs`), anything else waits out the debounce
/// window (`agentInbox.idleDebounceMs`); the heartbeat route admits with
/// no delay. Without an engine (a bare test core), the defaults.
pub(crate) fn wake_delay(
    notice: &InboxNotice,
    engine: Option<&crate::agent_engine::AgentSessionEngine>,
) -> Duration {
    let settings = match engine {
        Some(engine) => SettingsManager::create(engine.cwd(), &engine.config.agent_dir),
        None => SettingsManager::in_memory(&Settings::default()),
    };
    let ms = if is_success(notice.class, &notice.meta) {
        settings.get_agent_inbox_success_hold_ms()
    } else {
        settings.get_agent_inbox_idle_debounce_ms()
    };
    Duration::from_millis(ms)
}

/// A bash completion that exited 0.
fn is_success(class: &str, meta: &Value) -> bool {
    class == INBOX_CLASS_BASH_DONE && meta.get("exitCode").and_then(Value::as_i64) == Some(0)
}

/// The items a delivered row shows, so its delivery consumes them (rule
/// 3): every item of a row at or under the inline limit, in full; above
/// it, each successful bash completion as one line (its result stays on
/// the handle). Everything else is only counted and waits for a read.
pub(crate) fn shown_items(batch: &[InboxMessage]) -> Vec<&InboxMessage> {
    batch
        .iter()
        .filter(|message| {
            batch.len() <= INLINE_ITEM_LIMIT || is_success(&message.class, &message.meta)
        })
        .collect()
}

/// Rule 3: the queued wake row for one batch, as `(preview, text)`: the
/// summary line (counts by class and the `rlm.inbox.read()`
/// instruction), and for one or two items their content (the message
/// text plus a capped output tail). The model receives
/// [`delivered_notice_text`] instead.
pub(crate) fn notice_text(batch: &[InboxMessage], total_waiting: usize) -> (String, String) {
    let (preview, summary) = arrival_notice(batch, total_waiting);
    if batch.len() > INLINE_ITEM_LIMIT {
        return (preview, summary);
    }
    let items = batch.iter().map(full_item).collect::<Vec<_>>().join("\n\n");
    (preview, format!("{summary}\n\n{items}"))
}

/// The row text the model receives at delivery, after the delivery
/// consumed the [`shown_items`]: the summary says how many are shown and
/// counts only what still waits (naming `rlm.inbox.read()` only then),
/// then the shown items, in full for a small row or one line each.
pub(crate) fn delivered_notice_text(
    batch: &[InboxMessage],
    total_waiting: usize,
) -> (String, String) {
    let shown = shown_items(batch);
    if shown.is_empty() {
        return notice_text(batch, total_waiting);
    }
    let Some((window, summary)) = arrival_summary(batch) else {
        return (String::new(), String::new());
    };
    let (marker, items) = if batch.len() <= INLINE_ITEM_LIMIT {
        (
            "shown below".to_string(),
            shown
                .into_iter()
                .map(full_item)
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    } else {
        (
            format!("{} shown below", shown.len()),
            shown
                .into_iter()
                .map(|message| {
                    let header = message.text.lines().next().unwrap_or_default();
                    match message.meta.get("command").and_then(Value::as_str) {
                        Some(command) => format!("{header} {command}"),
                        None => header.to_string(),
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    let read = if total_waiting > 0 {
        " Read them with msgs = await rlm.inbox.read()."
    } else {
        ""
    };
    (
        format!("Inbox: {summary}"),
        format!(
            "[inbox {window} UTC] {summary}; {marker} and marked read; total waiting: {total_waiting}.{read}\n\n{items}"
        ),
    )
}

/// One item in full: the message text plus its capped output tail.
fn full_item(message: &InboxMessage) -> String {
    match message
        .meta
        .get("outputTail")
        .and_then(Value::as_str)
        .filter(|tail| !tail.is_empty())
    {
        Some(tail) => format!("{}\n{}", message.text, capped_tail(tail)),
        None => message.text.clone(),
    }
}

/// The last [`INLINE_TAIL_MAX_LINES`] lines of a tail, then at most its
/// last [`INLINE_TAIL_MAX_BYTES`] bytes on a character boundary.
fn capped_tail(tail: &str) -> &str {
    let tail = tail.trim_end_matches('\n');
    let line_start = tail
        .rmatch_indices('\n')
        .nth(INLINE_TAIL_MAX_LINES - 1)
        .map_or(0, |(index, _)| index + 1);
    let tail = &tail[line_start..];
    let mut byte_start = tail.len().saturating_sub(INLINE_TAIL_MAX_BYTES);
    while !tail.is_char_boundary(byte_start) {
        byte_start += 1;
    }
    &tail[byte_start..]
}

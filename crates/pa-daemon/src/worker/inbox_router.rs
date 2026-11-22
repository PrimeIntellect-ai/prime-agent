//! The daemon's inbox wake row: how much one row carries (rule 3) and the
//! idle debounce setting (rule 4). The queue admission in `queue.rs` owns
//! the state: the durable inbox holds every message, the coalescing batch
//! holds the messages one queued row covers, and the row itself is the
//! wake. A read before delivery withdraws the message (rule 1, driven by
//! the kernel's lifecycle in `prime-agent-runtime/src/rlm/inbox_lifecycle.py`).
//! Every unread arrival reaches the agent: a busy session folds it into
//! the turn's one queued row, and an idle session wakes once the debounce
//! window ends, so an agent that ended its turn to wait for a command is
//! always woken by it.

#[cfg(test)]
mod tests;

use pa_core::session_engine::inbox::{arrival_notice, InboxMessage};
use pa_core::settings::{Settings, SettingsManager};
use serde_json::Value;

/// Rule 3: a row covering at most this many items carries their content
/// under the summary line; a larger one is the summary line only.
const INLINE_ITEM_LIMIT: usize = 2;
/// Rule 3: the output tail an inline item carries, in lines and bytes.
const INLINE_TAIL_MAX_LINES: usize = 5;
const INLINE_TAIL_MAX_BYTES: usize = 400;

/// `agentInbox.idleDebounceMs` for the session: how long an idle agent's
/// wake waits to cover every arrival in the window. Without an engine (a
/// bare test core), the default.
pub(crate) fn idle_debounce_ms(engine: Option<&crate::agent_engine::AgentSessionEngine>) -> u64 {
    match engine {
        Some(engine) => SettingsManager::create(engine.cwd(), &engine.config.agent_dir),
        None => SettingsManager::in_memory(&Settings::default()),
    }
    .get_agent_inbox_idle_debounce_ms()
}

/// Rule 3: the wake row for one batch, as `(preview, text)`. The text
/// always opens with the summary line (counts by class and the
/// `rlm.inbox.read()` instruction; the messages stay in the inbox). One
/// or two items also carry their content: the message text plus a capped
/// output tail.
pub(crate) fn notice_text(batch: &[InboxMessage], total_waiting: usize) -> (String, String) {
    let (preview, summary) = arrival_notice(batch, total_waiting);
    if batch.len() > INLINE_ITEM_LIMIT {
        return (preview, summary);
    }
    let items = batch
        .iter()
        .map(|message| {
            match message
                .meta
                .get("outputTail")
                .and_then(Value::as_str)
                .filter(|tail| !tail.is_empty())
            {
                Some(tail) => format!("{}\n{}", message.text, capped_tail(tail)),
                None => message.text.clone(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (preview, format!("{summary}\n\n{items}"))
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

//! The agent inbox: the daemon-owned store where machine-generated
//! kernel notices (`bash.completed` and `factory.progress`) accumulate
//! per session instead of steering their full rows, plus the
//! `rlm.inbox.read`/`rlm.inbox.count` host requests the agent reads
//! them with. The durable journal (`inbox.jsonl` under the session dir)
//! replays on open, so a daemon restart keeps unread messages. A bash
//! completion the kernel collected through its handle withdraws its
//! message (`bash.consumed`), so a collected job leaves nothing
//! waiting.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::kernel::shared::{host_handler, HostRequestHandlers};

use super::bash_notices::KernelNotice;
use super::messages::{ASYNC_BASH_COMPLETION_CUSTOM_TYPE, FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE};
use pa_types::ai::UserContent;

/// The kernel host request that drains and returns the waiting messages
/// (all of them, or the subset a targeted-read filter narrows to).
pub const INBOX_READ_REQUEST_TYPE: &str = "rlm.inbox.read";
/// The kernel host request that counts the waiting messages.
pub const INBOX_COUNT_REQUEST_TYPE: &str = "rlm.inbox.count";
/// The journal file one session's inbox appends under its session dir.
pub const INBOX_JOURNAL_FILE: &str = "inbox.jsonl";

/// The `bash.completed` notice class label.
pub const INBOX_CLASS_BASH_DONE: &str = "bash-done";
/// The `factory.progress` notice class label.
pub const INBOX_CLASS_FACTORY_PROGRESS: &str = "factory-progress";
/// The agent-message class label: one delivered `agent_message.send`
/// row (parent/sibling/child traffic) routed into the inbox.
pub const INBOX_CLASS_AGENT_MESSAGE: &str = "agent-message";

/// The coalescing batch state the daemon's notice sink owns: the
/// arrivals the currently queued short-notice row covers (reset when the
/// row delivers or clears).
pub type InboxArrivals = std::sync::Arc<std::sync::Mutex<Vec<InboxMessage>>>;

/// One inbox message: the same text the notice row carries, its arrival
/// time, and the notice's metadata. The wire and journal shapes are one
/// (camelCase, like the TS-era notice rows).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxMessage {
    pub id: String,
    pub class: String,
    /// Epoch milliseconds of the message's arrival.
    pub arrived_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    pub text: String,
    #[serde(default)]
    pub meta: Value,
}

/// The inbox projection of one routed kernel notice: the class label, the
/// sender (the command for a bash completion, the run id for a factory
/// milestone), the row's text, and its metadata. `None` for rows the
/// inbox does not route.
#[derive(Debug, Clone)]
pub struct InboxNotice {
    pub class: &'static str,
    pub sender: Option<String>,
    pub text: String,
    pub meta: Value,
}

/// The targeted-read filter for `rlm.inbox.read` (`rlm.inbox.read()` in
/// Python): every set field narrows the read (`ANDed`), an all-`None`
/// filter reads everything. The wire shape is camelCase, like the
/// message rows.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InboxReadFilter {
    /// Exact sender match (the command, the run id, or the agent name).
    pub sender: Option<String>,
    /// Exact class match (`bash-done`, `factory-progress`, `agent-message`).
    pub class: Option<String>,
    /// Arrival lower bound, inclusive (epoch milliseconds).
    pub since_ms: Option<u64>,
    /// Arrival upper bound, exclusive (epoch milliseconds).
    pub before_ms: Option<u64>,
}

impl InboxReadFilter {
    /// Whether the filter narrows the read at all (an all-`None` filter
    /// is the unfiltered drain).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sender.is_none()
            && self.class.is_none()
            && self.since_ms.is_none()
            && self.before_ms.is_none()
    }

    fn matches(&self, message: &InboxMessage) -> bool {
        self.sender
            .as_deref()
            .is_none_or(|sender| message.sender.as_deref() == Some(sender))
            && self
                .class
                .as_deref()
                .is_none_or(|class| message.class == class)
            && self
                .since_ms
                .is_none_or(|since| message.arrived_at_ms >= since)
            && self
                .before_ms
                .is_none_or(|before| message.arrived_at_ms < before)
    }
}

/// Which inbox class a kernel notice's custom type routes to, if any.
#[must_use]
pub fn inbox_class_for_custom_type(custom_type: &str) -> Option<&'static str> {
    match custom_type {
        ASYNC_BASH_COMPLETION_CUSTOM_TYPE => Some(INBOX_CLASS_BASH_DONE),
        FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE => Some(INBOX_CLASS_FACTORY_PROGRESS),
        _ => None,
    }
}

/// The inbox fields of one `bash.completed` or `factory.progress` notice.
#[must_use]
pub fn inbox_notice_fields(notice: &KernelNotice) -> Option<InboxNotice> {
    let class = inbox_class_for_custom_type(&notice.row.custom_type)?;
    let text = match &notice.row.content {
        UserContent::Text(text) => text.clone(),
        UserContent::Blocks(_) => return None,
    };
    let meta = notice.row.details.clone().unwrap_or(Value::Null);
    let sender = match class {
        INBOX_CLASS_BASH_DONE => meta.get("command").and_then(Value::as_str),
        INBOX_CLASS_FACTORY_PROGRESS => meta.get("runId").and_then(Value::as_str),
        _ => None,
    };
    Some(InboxNotice {
        class,
        sender: sender.map(str::to_string),
        text,
        meta,
    })
}

#[derive(Debug, Default)]
struct InboxState {
    messages: Vec<InboxMessage>,
    next_id: u64,
}

/// The per-session inbox store: the in-memory waiting messages plus the
/// durable journal under the session dir. `read` drains; `count`
/// summarizes; every push and drain appends one journal record, and
/// `open` replays the journal so a daemon restart keeps unread
/// messages.
#[derive(Debug)]
pub struct SessionInbox {
    journal: Option<PathBuf>,
    state: Mutex<InboxState>,
}

/// One journal record: a message arrival, a drain marker, one
/// message's withdrawal (the consumed-bash path), or the id counter's
/// high-water mark (compaction persists it so a drained restart never
/// reuses a spent id).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum InboxRecord {
    Message(InboxMessage),
    Drained,
    /// The id of one withdrawn message.
    Withdrawn {
        id: String,
    },
    /// A targeted read's taken ids: replay drops exactly these, so a
    /// partial drain never clears the messages it did not return.
    #[serde(rename_all = "camelCase")]
    Read {
        ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Counter {
        next_id: u64,
    },
}

impl SessionInbox {
    /// Open the inbox over one session dir: replay the journal and
    /// rewrite it compacted to the pending messages (bounded growth
    /// across restarts). A missing journal starts empty; a journal
    /// that cannot be read starts empty but stays untouched — and the
    /// instance stays memory-only, never appending, so nothing it does
    /// can obscure the records a later open reads; journal write
    /// failures degrade to in-process durability only.
    #[must_use]
    pub fn open(dir: Option<&Path>) -> Self {
        // The artifact dir may not exist yet on a fresh session; the
        // journal append creates the file but never the directory.
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(dir);
        }
        let journal = dir.map(|dir| dir.join(INBOX_JOURNAL_FILE));
        let (messages, next_id, readable) = journal
            .as_deref()
            .map_or((Vec::new(), 0, true), replay_journal);
        // Unreadable records are out of reach: a drain appended now
        // would erase them for a future readable replay, so the
        // memory-only instance detaches from the path entirely (the
        // open's compaction is the one write an unreadable journal
        // would have taken, and it is skipped the same way).
        let inbox = Self {
            journal: if readable { journal } else { None },
            state: Mutex::new(InboxState { messages, next_id }),
        };
        if readable {
            inbox.compact_journal();
        }
        inbox
    }

    /// The in-memory inbox (no journal).
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            journal: None,
            state: Mutex::new(InboxState::default()),
        }
    }

    /// Append one message: durable journal first, then the store. The
    /// id is a fresh monotonic `inbox-<n>`.
    pub fn push(&self, notice: InboxNotice, arrived_at_ms: u64) -> InboxMessage {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.next_id += 1;
        let message = InboxMessage {
            id: format!("inbox-{}", state.next_id),
            class: notice.class.to_string(),
            arrived_at_ms,
            sender: notice.sender,
            text: notice.text,
            meta: notice.meta,
        };
        self.append_journal(
            &serde_json::to_value(InboxRecord::Message(message.clone())).unwrap_or(Value::Null),
        );
        state.messages.push(message.clone());
        message
    }

    /// Withdraw one bash completion: the kernel read the finished
    /// command's result through its handle (`bash.consumed`), so the
    /// message the collection already answered leaves the store (and
    /// the journal's pending set) instead of waiting for a `read`. Pids
    /// are reused, so the command disambiguates — the same pair the
    /// queued-row withdrawal matches. Journal first, then the store
    /// (the push/drain order): a crash between them never resurrects
    /// a collected message.
    pub fn withdraw_bash_completion(&self, pid: u32, command: &str) -> Option<InboxMessage> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let position = state.messages.iter().position(|message| {
            message.class == INBOX_CLASS_BASH_DONE
                && message.meta.get("pid").and_then(Value::as_u64) == Some(u64::from(pid))
                && message.meta.get("command").and_then(Value::as_str) == Some(command)
        })?;
        let id = state.messages[position].id.clone();
        self.append_journal(
            &serde_json::to_value(InboxRecord::Withdrawn { id }).unwrap_or(Value::Null),
        );
        Some(state.messages.remove(position))
    }

    /// Read drains: the waiting messages return in arrival order and
    /// leave the store (and the journal's pending set).
    pub fn drain(&self) -> Vec<InboxMessage> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.append_journal(&serde_json::to_value(InboxRecord::Drained).unwrap_or(Value::Null));
        std::mem::take(&mut state.messages)
    }

    /// A targeted read: only the messages matching the filter return
    /// (in arrival order) and leave the store; the rest stay waiting.
    /// The journal records the taken ids (`Read`), never the full
    /// `Drained` marker, so a restart keeps the untouched messages.
    pub fn drain_matching(&self, filter: &InboxReadFilter) -> Vec<InboxMessage> {
        if filter.is_empty() {
            return self.drain();
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut taken = Vec::new();
        let mut remaining = Vec::new();
        for message in std::mem::take(&mut state.messages) {
            if filter.matches(&message) {
                taken.push(message);
            } else {
                remaining.push(message);
            }
        }
        if !taken.is_empty() {
            let ids = taken
                .iter()
                .map(|message| message.id.clone())
                .collect::<Vec<_>>();
            self.append_journal(
                &serde_json::to_value(InboxRecord::Read { ids }).unwrap_or(Value::Null),
            );
        }
        state.messages = remaining;
        taken
    }

    /// The waiting count, its oldest arrival time, and the per-class
    /// breakdown.
    pub fn count(&self) -> (usize, Option<u64>, BTreeMap<String, u64>) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut classes: BTreeMap<String, u64> = BTreeMap::new();
        for message in &state.messages {
            *classes.entry(message.class.clone()).or_default() += 1;
        }
        (
            state.messages.len(),
            state.messages.first().map(|message| message.arrived_at_ms),
            classes,
        )
    }

    fn append_journal(&self, record: &Value) {
        let Some(journal) = &self.journal else {
            return;
        };
        let line = serde_json::to_string(record).unwrap_or_default();
        let write = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(journal)
            .and_then(|mut file| {
                use std::io::{Read as _, Seek as _, Write as _};
                let start = file.metadata().map(|meta| meta.len()).ok();
                // One record per line: the append must start on a fresh
                // line. A fragment left by an interrupted append (a
                // failed write, a crash, a failed compaction) would
                // otherwise concatenate with this record and replay
                // would drop both lines. The guard writes the missing
                // newline first, so the fragment stays a complete
                // (unparseable, skipped) line of its own.
                if start.is_some_and(|len| len > 0) {
                    let mut last = [0u8; 1];
                    let ends_clean = file
                        .seek(std::io::SeekFrom::End(-1))
                        .and_then(|_| file.read_exact(&mut last))
                        .is_ok()
                        && last[0] == b'\n';
                    if !ends_clean {
                        file.write_all(b"\n")?;
                    }
                }
                let written = file
                    .write_all(line.as_bytes())
                    .and_then(|()| file.write_all(b"\n"));
                if written.is_err() {
                    // Drop this attempt's partial bytes: the failure
                    // never extends the torn fragment it may have left.
                    if let Some(start) = start {
                        let _ = file.set_len(start);
                    }
                }
                written
            });
        // Journal failures degrade durability only: the in-process
        // surface stays truthful.
        if let Err(error) = write {
            eprintln!(
                "pa-daemon: inbox journal append failed ({}): {error}",
                journal.display()
            );
        }
    }

    /// Rewrite the journal to the id counter and the pending messages
    /// (called at open, so drained history never outlives a restart
    /// and the counter never resets to zero on a drained restart).
    fn compact_journal(&self) {
        let Some(journal) = &self.journal else {
            return;
        };
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut lines = String::new();
        let counter = serde_json::to_value(InboxRecord::Counter {
            next_id: state.next_id,
        })
        .unwrap_or(Value::Null);
        lines.push_str(&serde_json::to_string(&counter).unwrap_or_default());
        lines.push('\n');
        for message in &state.messages {
            let record =
                serde_json::to_value(InboxRecord::Message(message.clone())).unwrap_or(Value::Null);
            lines.push_str(&serde_json::to_string(&record).unwrap_or_default());
            lines.push('\n');
        }
        let tmp = journal.with_extension("jsonl.tmp");
        let rewrite =
            std::fs::write(&tmp, lines).and_then(|()| crate::platform::rename_onto(&tmp, journal));
        if let Err(error) = rewrite {
            eprintln!(
                "pa-daemon: inbox journal compaction failed ({}): {error}",
                journal.display()
            );
        }
    }
}

/// Replay one journal: apply every complete record in order. A torn
/// tail (a crash mid-append) degrades to the records that parse — the
/// compacted rewrite that follows drops the fragment. A journal that
/// cannot be read at all returns unreadable so the open never compacts
/// over it. Returns the pending messages, the id counter's high-water
/// mark, and whether the journal was readable.
fn replay_journal(journal: &Path) -> (Vec<InboxMessage>, u64, bool) {
    let bytes = match std::fs::read(journal) {
        Ok(bytes) => bytes,
        // A missing journal starts fresh; the open's compaction
        // creates it. Any other read failure starts memory-only and
        // keeps the journal untouched, like the write failures below.
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            eprintln!(
                "pa-daemon: inbox journal read failed ({}): {error}",
                journal.display()
            );
            return (Vec::new(), 0, false);
        }
        Err(_) => return (Vec::new(), 0, true),
    };
    let mut messages = Vec::new();
    let mut next_id = 0;
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<InboxRecord>(line.trim()) else {
            continue;
        };
        match record {
            InboxRecord::Message(message) => {
                next_id = next_id.max(
                    message
                        .id
                        .rsplit('-')
                        .next()
                        .and_then(|id| id.parse().ok())
                        .unwrap_or(next_id),
                );
                messages.push(message);
            }
            InboxRecord::Drained => messages.clear(),
            InboxRecord::Withdrawn { id } => {
                messages.retain(|message| message.id != id);
            }
            InboxRecord::Read { ids } => {
                messages.retain(|message| !ids.contains(&message.id));
            }
            InboxRecord::Counter { next_id: high } => next_id = next_id.max(high),
        }
    }
    (messages, next_id, true)
}

/// UTC `HH:MM` of one epoch-ms timestamp (the notice time signature).
#[must_use]
pub fn utc_hh_mm(ms: u64) -> String {
    let seconds_of_day = (ms / 1000) % 86_400;
    format!(
        "{:02}:{:02}",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60
    )
}

/// The arrival notice for one batch of messages: the short steering row
/// that replaces the notices' full rows. The signature is the latest
/// arrival's time; a batch of one names its class, a wider batch the
/// arrival window and per-class counts.
#[must_use]
pub fn arrival_notice(batch: &[InboxMessage], total_waiting: usize) -> (String, String) {
    let Some(last) = batch.last() else {
        return (String::new(), String::new());
    };
    let signature = utc_hh_mm(last.arrived_at_ms);
    let (summary, total) = if batch.len() == 1 {
        (
            format!("1 new message ({})", last.class),
            format!("total waiting: {total_waiting}"),
        )
    } else {
        let mut classes: Vec<(&str, u64)> = Vec::new();
        for message in batch {
            match classes
                .iter_mut()
                .find(|(class, _)| class == &message.class.as_str())
            {
                Some((_, count)) => *count += 1,
                None => classes.push((&message.class, 1)),
            }
        }
        let breakdown = classes
            .iter()
            .map(|(class, count)| format!("{count} {class}"))
            .collect::<Vec<_>>()
            .join(", ");
        (
            format!(
                "+{} arrived {}-{}: {}",
                batch.len(),
                utc_hh_mm(batch[0].arrived_at_ms),
                signature,
                breakdown
            ),
            format!("total {total_waiting}"),
        )
    };
    (
        format!("Inbox: {summary}"),
        format!("[inbox {signature} UTC] {summary}; {total}. Read them with rlm.inbox.read()."),
    )
}

/// The periodic reminder text while the inbox stays unread: a minimal
/// count-only nudge (the oldest-wait detail stays on `count()`).
#[must_use]
pub fn reminder_notice(count: usize) -> String {
    let noun = if count == 1 { "message" } else { "messages" };
    format!("[inbox reminder] {count} {noun} still waiting — rlm.inbox.read()")
}

/// Register the `rlm.inbox.read`/`rlm.inbox.count` host handlers over
/// one session's store. `read` drains and returns the waiting messages
/// (an optional `{sender, class, sinceMs, beforeMs}` filter narrows the
/// drain); `count` returns the count, the oldest arrival, and the
/// per-class breakdown.
pub fn register_inbox_host_handlers(inbox: &Arc<SessionInbox>, handlers: &mut HostRequestHandlers) {
    let read_inbox = Arc::clone(inbox);
    handlers.register(
        INBOX_READ_REQUEST_TYPE,
        host_handler(move |payload| {
            let inbox = Arc::clone(&read_inbox);
            Box::pin(async move {
                let filter: InboxReadFilter = serde_json::from_value(payload.data)?;
                let messages = inbox.drain_matching(&filter);
                let drained_count = messages.len();
                Ok(json!({ "messages": messages, "drainedCount": drained_count }))
            })
        }),
    );
    let count_inbox = Arc::clone(inbox);
    handlers.register(
        INBOX_COUNT_REQUEST_TYPE,
        host_handler(move |_payload| {
            let inbox = Arc::clone(&count_inbox);
            Box::pin(async move {
                let (count, oldest_arrived_at_ms, classes) = inbox.count();
                Ok(json!({
                    "count": count,
                    "oldestArrivedAtMs": oldest_arrived_at_ms,
                    "classes": classes,
                }))
            })
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::HostRequestPayload;
    use std::io::Write as _;

    fn message(id: &str, class: &str, arrived_at_ms: u64, text: &str) -> InboxMessage {
        InboxMessage {
            id: id.to_string(),
            class: class.to_string(),
            arrived_at_ms,
            sender: None,
            text: text.to_string(),
            meta: Value::Null,
        }
    }

    fn notice(sender: &str, class: &'static str, text: &str, meta: Value) -> InboxNotice {
        InboxNotice {
            class,
            sender: Some(sender.to_string()),
            text: text.to_string(),
            meta,
        }
    }

    /// Push, drain, and count round-trip through the store's in-memory
    /// surface; ids stay monotonic across a drain.
    #[test]
    fn push_drain_and_count_round_trip() {
        let inbox = SessionInbox::in_memory();
        assert_eq!(inbox.count(), (0, None, BTreeMap::new()));
        let first = inbox.push(
            notice("sleep 1", INBOX_CLASS_BASH_DONE, "done", json!({"pid": 1})),
            1_000,
        );
        let second = inbox.push(
            notice(
                "r1",
                INBOX_CLASS_FACTORY_PROGRESS,
                "milestone",
                json!({"runId": "r1"}),
            ),
            2_000,
        );
        assert_eq!(first.id, "inbox-1");
        assert_eq!(second.id, "inbox-2");
        let (count, oldest, classes) = inbox.count();
        assert_eq!(count, 2);
        assert_eq!(oldest, Some(1_000));
        assert_eq!(
            classes,
            BTreeMap::from([
                (INBOX_CLASS_BASH_DONE.to_string(), 1),
                (INBOX_CLASS_FACTORY_PROGRESS.to_string(), 1),
            ])
        );
        let drained = inbox.drain();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].text, "done");
        assert_eq!(drained[0].meta, json!({"pid": 1}));
        assert_eq!(drained[0].arrived_at_ms, 1_000);
        assert_eq!(inbox.count(), (0, None, BTreeMap::new()));
        // Ids keep counting after a drain.
        let third = inbox.push(
            notice("echo 4", INBOX_CLASS_BASH_DONE, "next", json!({})),
            3_000,
        );
        assert_eq!(third.id, "inbox-3");
    }

    /// A collected bash completion withdraws its own message: the
    /// pid+command pair matches (pids are reused), a different command
    /// under the same pid stays, and an unknown pair withdraws nothing.
    #[test]
    fn withdraw_bash_completion_drains_only_the_matching_message() {
        let inbox = SessionInbox::in_memory();
        inbox.push(
            notice(
                "sleep 1",
                INBOX_CLASS_BASH_DONE,
                "first",
                json!({"pid": 11, "command": "sleep 1", "exitCode": 0}),
            ),
            1_000,
        );
        let second = inbox.push(
            notice(
                "sleep 2",
                INBOX_CLASS_BASH_DONE,
                "second",
                json!({"pid": 11, "command": "sleep 2", "exitCode": 0}),
            ),
            2_000,
        );
        let kept = inbox.push(
            notice(
                "r1",
                INBOX_CLASS_FACTORY_PROGRESS,
                "milestone",
                json!({"pid": 11, "runId": "r1"}),
            ),
            3_000,
        );
        assert_eq!(second.id, "inbox-2");
        assert!(
            inbox.withdraw_bash_completion(11, "make targets").is_none(),
            "an unmatched pair withdraws nothing"
        );
        let withdrawn = inbox
            .withdraw_bash_completion(11, "sleep 1")
            .expect("the matching pair withdraws");
        assert_eq!(withdrawn.text, "first");
        assert_eq!(
            withdrawn.meta,
            json!({"pid": 11, "command": "sleep 1", "exitCode": 0})
        );
        let drained = inbox.drain();
        assert_eq!(
            drained,
            vec![second, kept],
            "only the matching pair withdrew"
        );
    }

    /// A withdrawn message does not survive a restart: the journal's
    /// withdrawal record removes it from the replayed pending set, and
    /// the id counter keeps counting past it.
    #[test]
    fn a_withdrawn_message_does_not_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        {
            let inbox = SessionInbox::open(Some(dir.path()));
            inbox.push(
                notice(
                    "sleep 1",
                    INBOX_CLASS_BASH_DONE,
                    "collected",
                    json!({"pid": 11, "command": "sleep 1"}),
                ),
                1_000,
            );
            inbox.push(
                notice(
                    "sleep 2",
                    INBOX_CLASS_BASH_DONE,
                    "waiting",
                    json!({"pid": 12, "command": "sleep 2"}),
                ),
                2_000,
            );
            let withdrawn = inbox
                .withdraw_bash_completion(11, "sleep 1")
                .expect("the collected message withdraws");
            assert_eq!(withdrawn.id, "inbox-1");
        }
        let inbox = SessionInbox::open(Some(dir.path()));
        let drained = inbox.drain();
        let replayed = InboxMessage {
            id: "inbox-2".to_string(),
            class: INBOX_CLASS_BASH_DONE.to_string(),
            arrived_at_ms: 2_000,
            sender: Some("sleep 2".to_string()),
            text: "waiting".to_string(),
            meta: json!({"pid": 12, "command": "sleep 2"}),
        };
        assert_eq!(
            drained,
            vec![replayed],
            "the restart replayed only the unwithdrawn message"
        );
        let next = inbox.push(
            notice("echo", INBOX_CLASS_BASH_DONE, "next", json!({})),
            3_000,
        );
        assert_eq!(next.id, "inbox-3", "the id counter replayed");
    }

    /// The withdrawal's crash window is the order of its two steps: the
    /// Withdrawn record must be durable before the store drops the
    /// message (the push/drain order), because a torn write between
    /// them resurrects the collected bash-done on restart. The window
    /// has no runtime seam — both steps run under the state lock, and
    /// a failed append leaves the same journal either way — so the pin
    /// holds the function's own source order and goes red when the
    /// remove moves ahead of the journal append.
    #[test]
    fn the_withdrawal_journals_before_the_store_remove() {
        let source = include_str!("inbox.rs");
        let function = source
            .split_once("pub fn withdraw_bash_completion")
            .expect("the source names the withdrawal");
        let body = function
            .1
            .split_once("\n    }\n")
            .expect("the withdrawal closes its section")
            .0;
        let journal = body
            .find("append_journal")
            .expect("the withdrawal journals");
        let remove = body
            .find("state.messages.remove(position)")
            .expect("the withdrawal removes from the store");
        assert!(
            journal < remove,
            "the Withdrawn record must reach the journal before the store removes the message"
        );
    }

    /// The journal appends one line per push and drain, and an open
    /// replays the messages in order with the id counter caught up.
    #[test]
    fn journal_appends_and_replays() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        {
            let inbox = SessionInbox::open(Some(dir.path()));
            inbox.push(
                notice(
                    "sleep 1",
                    INBOX_CLASS_BASH_DONE,
                    "first",
                    json!({"pid": 11}),
                ),
                1_000,
            );
            inbox.push(
                notice(
                    "r",
                    INBOX_CLASS_FACTORY_PROGRESS,
                    "second",
                    json!({"runId": "r"}),
                ),
                2_000,
            );
        }
        // The in-process compaction rewrote the journal to the id
        // counter record plus the pending messages: one line each.
        let content = std::fs::read_to_string(&journal).unwrap();
        assert_eq!(content.lines().count(), 3, "journal: {content}");
        assert!(
            content.starts_with("{\"kind\":\"counter\""),
            "the counter record leads: {content}"
        );
        // The simulated restart: a fresh open replays both messages.
        let inbox = SessionInbox::open(Some(dir.path()));
        let (count, oldest, classes) = inbox.count();
        assert_eq!(count, 2);
        assert_eq!(oldest, Some(1_000));
        assert_eq!(classes[INBOX_CLASS_BASH_DONE], 1);
        assert_eq!(classes[INBOX_CLASS_FACTORY_PROGRESS], 1);
        let drained = inbox.drain();
        assert_eq!(drained[0].id, "inbox-1");
        assert_eq!(drained[0].text, "first");
        assert_eq!(drained[1].text, "second");
        // The drain marker survives a restart as an empty inbox.
        let reopened = SessionInbox::open(Some(dir.path()));
        assert_eq!(reopened.count(), (0, None, BTreeMap::new()));
        let next = reopened.push(
            notice("echo 3", INBOX_CLASS_BASH_DONE, "third", json!({})),
            3_000,
        );
        assert_eq!(next.id, "inbox-3", "the id counter replayed");
    }

    /// A torn journal tail degrades to the readable records.
    #[test]
    fn a_torn_journal_tail_degrades_to_the_readable_records() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        let mut file = std::fs::File::create(&journal).unwrap();
        let record = serde_json::to_value(InboxRecord::Message(message(
            "inbox-1",
            INBOX_CLASS_BASH_DONE,
            1_000,
            "done",
        )))
        .unwrap();
        writeln!(file, "{}", serde_json::to_string(&record).unwrap()).unwrap();
        writeln!(file, "{{\"kind\":\"message\"").unwrap();
        let inbox = SessionInbox::open(Some(dir.path()));
        let (count, _, _) = inbox.count();
        assert_eq!(count, 1, "the torn tail is skipped, the record replays");
    }

    /// A torn append ending in invalid UTF-8 (a crash mid-write of a
    /// multi-byte character) still replays the complete records: the
    /// journal is replayed per record, never decoded as one string, and
    /// the compaction rewrites it without the fragment.
    #[test]
    fn a_torn_tail_with_invalid_utf8_replays_the_complete_records() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        let mut file = std::fs::File::create(&journal).unwrap();
        let record = serde_json::to_value(InboxRecord::Message(message(
            "inbox-1",
            INBOX_CLASS_BASH_DONE,
            1_000,
            "done",
        )))
        .unwrap();
        writeln!(file, "{}", serde_json::to_string(&record).unwrap()).unwrap();
        // The torn tail: a partial record whose last write stopped mid
        // multi-byte character (invalid UTF-8, no newline).
        file.write_all(b"{\"kind\":\"message\",\"id\":\"inbox-2\",\"text\":\"ca")
            .unwrap();
        file.write_all(&[0xc3]).unwrap();
        drop(file);
        let inbox = SessionInbox::open(Some(dir.path()));
        let (count, _, _) = inbox.count();
        assert_eq!(count, 1, "the complete record replays");
        // The compaction dropped the fragment: the journal is valid
        // UTF-8 again, holding the counter record and the message.
        let content = std::fs::read_to_string(&journal).unwrap();
        assert_eq!(content.lines().count(), 2, "journal: {content}");
        assert!(
            content.starts_with("{\"kind\":\"counter\"") && content.contains("\"inbox-1\""),
            "the rewrite kept the record and dropped the fragment: {content}"
        );
    }

    /// A journal that cannot be read at all (here: the path is a
    /// directory) starts empty but is never compacted over: the open
    /// leaves the unread journal and its records untouched.
    #[test]
    fn an_unreadable_journal_is_never_compacted_over() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        std::fs::create_dir(&journal).unwrap();
        let inbox = SessionInbox::open(Some(dir.path()));
        assert_eq!(inbox.count(), (0, None, BTreeMap::new()));
        assert!(journal.is_dir(), "the unread journal is left untouched");
        assert!(
            !journal.with_extension("jsonl.tmp").exists(),
            "the skipped compaction wrote no throwaway tmp"
        );
    }

    /// An unreadable journal detaches the instance from the path:
    /// nothing it does can erase the records a later open replays, even
    /// after the read failure clears (without the detach, the drain's
    /// `Drained` marker would erase the unseen record).
    #[cfg(unix)]
    #[test]
    fn an_unreadable_journal_detaches_the_instance_from_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        // The unreadable cause: a symlink loop (root-safe).
        std::os::unix::fs::symlink(&journal, &journal).unwrap();
        let inbox = SessionInbox::open(Some(dir.path()));
        assert_eq!(inbox.count().0, 0, "the unreadable journal starts empty");
        // The cause clears: the path becomes a real journal with one
        // unread record the instance never saw.
        std::fs::remove_file(&journal).unwrap();
        let record = serde_json::to_value(InboxRecord::Message(message(
            "inbox-1",
            INBOX_CLASS_BASH_DONE,
            1_000,
            "kept",
        )))
        .unwrap();
        std::fs::write(
            &journal,
            format!("{}\n", serde_json::to_string(&record).unwrap()),
        )
        .unwrap();
        // The detached instance's push and drain stay in memory; the
        // path stays untouched.
        inbox.push(
            notice("echo 1", INBOX_CLASS_BASH_DONE, "memory only", json!({})),
            2_000,
        );
        assert_eq!(inbox.drain().len(), 1);
        // A later open replays the record the detached instance never
        // saw (no drain marker sits over it).
        let reopened = SessionInbox::open(Some(dir.path()));
        let drained = reopened.drain();
        assert_eq!(drained.len(), 1, "the unseen record survives");
        assert_eq!(drained[0].text, "kept");
        assert_eq!(drained[0].id, "inbox-1");
    }

    /// The id counter survives a drained restart: the compacted journal
    /// carries the counter record, so a fresh replay keeps ids monotonic
    /// instead of reissuing a spent id.
    #[test]
    fn the_id_counter_survives_a_drained_restart() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        {
            let inbox = SessionInbox::open(Some(dir.path()));
            inbox.push(
                notice("sleep 1", INBOX_CLASS_BASH_DONE, "first", json!({"pid": 1})),
                1_000,
            );
            inbox.push(
                notice(
                    "sleep 2",
                    INBOX_CLASS_BASH_DONE,
                    "second",
                    json!({"pid": 2}),
                ),
                2_000,
            );
            inbox.drain();
        }
        {
            // The reopen replays the drain and compacts: only the
            // counter record remains (the high-water mark, not zero).
            let reopened = SessionInbox::open(Some(dir.path()));
            assert_eq!(reopened.count(), (0, None, BTreeMap::new()));
            let content = std::fs::read_to_string(&journal).unwrap();
            assert_eq!(content.lines().count(), 1, "journal: {content}");
            assert!(
                content.contains("\"counter\"") && content.contains("\"nextId\":2"),
                "the counter record persists: {content}"
            );
        }
        // The restart over the drained journal still counts past the
        // spent ids.
        let reopened = SessionInbox::open(Some(dir.path()));
        let next = reopened.push(
            notice("echo 3", INBOX_CLASS_BASH_DONE, "third", json!({})),
            3_000,
        );
        assert_eq!(next.id, "inbox-3", "the drained counter replayed");
    }

    /// The notice fields project one bash completion and one factory
    /// milestone; other custom rows stay unrouted.
    #[test]
    fn inbox_notice_fields_route_by_custom_type() {
        let bash = KernelNotice::bash_completion(4321, "sleep 1", 7);
        let fields = inbox_notice_fields(&bash).expect("the completion routes");
        assert_eq!(fields.class, INBOX_CLASS_BASH_DONE);
        assert_eq!(fields.sender.as_deref(), Some("sleep 1"));
        assert!(fields.text.contains("[bash-done pid:4321 exit:7]"));
        assert_eq!(
            fields.meta,
            json!({"pid": 4321, "command": "sleep 1", "exitCode": 7})
        );
        let progress = KernelNotice {
            row: super::super::messages::create_factory_progress_message(
                "run-7",
                "budget_exceeded",
                None,
                "run budget_ms 2000 exceeded",
                1_000,
            ),
            preview_label: "Factory progress",
        };
        let fields = inbox_notice_fields(&progress).expect("the milestone routes");
        assert_eq!(fields.class, INBOX_CLASS_FACTORY_PROGRESS);
        assert_eq!(fields.sender.as_deref(), Some("run-7"));
        assert!(fields.text.contains("budget-exceeded"));
    }

    /// The arrival notice: one message names its class and the total
    /// waiting; a batch carries the arrival window and the per-class
    /// counts.
    #[test]
    fn arrival_notice_covers_the_batch() {
        // 14:03:00 UTC: one new message, two waiting before it.
        let at = (14 * 3600 + 3 * 60) * 1000u64;
        let single = message("inbox-3", INBOX_CLASS_BASH_DONE, at, "done");
        let (preview, text) = arrival_notice(std::slice::from_ref(&single), 3);
        assert_eq!(preview, "Inbox: 1 new message (bash-done)");
        assert_eq!(
            text,
            "[inbox 14:03 UTC] 1 new message (bash-done); total waiting: 3. Read them with rlm.inbox.read()."
        );
        let batch = [
            message("inbox-1", INBOX_CLASS_BASH_DONE, at - 60_000, "a"),
            message("inbox-2", INBOX_CLASS_FACTORY_PROGRESS, at - 30_000, "b"),
            message("inbox-3", INBOX_CLASS_BASH_DONE, at, "c"),
        ];
        let (preview, text) = arrival_notice(&batch, 3);
        assert_eq!(
            preview,
            "Inbox: +3 arrived 14:02-14:03: 2 bash-done, 1 factory-progress"
        );
        assert_eq!(
            text,
            "[inbox 14:03 UTC] +3 arrived 14:02-14:03: 2 bash-done, 1 factory-progress; total 3. Read them with rlm.inbox.read()."
        );
    }

    /// The reminder names the waiting count only (a minimal nudge, no
    /// content and no oldest-wait detail).
    #[test]
    fn reminder_notice_names_the_wait() {
        assert_eq!(
            reminder_notice(3),
            "[inbox reminder] 3 messages still waiting — rlm.inbox.read()"
        );
        assert_eq!(
            reminder_notice(1),
            "[inbox reminder] 1 message still waiting — rlm.inbox.read()"
        );
    }

    /// A targeted read takes exactly the messages the filter matches
    /// (class, sender, and arrival window, `ANDed`) and leaves the rest
    /// waiting; the journal replays exactly the taken ids, so a restart
    /// keeps the untouched messages.
    #[test]
    fn a_targeted_read_takes_only_the_matching_messages() {
        let dir = tempfile::tempdir().unwrap();
        {
            let inbox = SessionInbox::open(Some(dir.path()));
            inbox.push(
                notice("sleep 1", INBOX_CLASS_BASH_DONE, "first", json!({})),
                1_000,
            );
            inbox.push(
                notice("peer", INBOX_CLASS_AGENT_MESSAGE, "second", json!({})),
                2_000,
            );
            inbox.push(
                notice("sleep 2", INBOX_CLASS_BASH_DONE, "third", json!({})),
                3_000,
            );
            // Class: the two bash-done messages leave, the agent message
            // stays.
            let taken = inbox.drain_matching(&InboxReadFilter {
                class: Some(INBOX_CLASS_BASH_DONE.to_string()),
                ..Default::default()
            });
            assert_eq!(
                taken.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
                ["first", "third"]
            );
            // An empty window and an unknown sender take nothing.
            assert!(inbox
                .drain_matching(&InboxReadFilter {
                    since_ms: Some(10_000),
                    ..Default::default()
                })
                .is_empty());
            assert!(inbox
                .drain_matching(&InboxReadFilter {
                    sender: Some("nobody".to_string()),
                    ..Default::default()
                })
                .is_empty());
            assert_eq!(inbox.count().0, 1, "the unmatched message stays");
        }
        // The partial read replays: exactly the taken ids are gone, the
        // untouched agent message survives the restart.
        let reopened = SessionInbox::open(Some(dir.path()));
        let (count, _, classes) = reopened.count();
        assert_eq!(count, 1);
        assert_eq!(classes[INBOX_CLASS_AGENT_MESSAGE], 1);
        // Sender plus arrival window (ANDed) then takes it.
        let taken = reopened.drain_matching(&InboxReadFilter {
            sender: Some("peer".to_string()),
            since_ms: Some(2_000),
            before_ms: Some(2_001),
            ..Default::default()
        });
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].text, "second");
        assert_eq!(reopened.count().0, 0);
    }

    /// A fragment left by an interrupted append never swallows the next
    /// record: the next append writes the missing line boundary first,
    /// so the fragment stays its own (skipped) line.
    #[test]
    fn a_fragment_never_swallows_the_next_record() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        {
            let mut file = std::fs::File::create(&journal).unwrap();
            file.write_all(b"{\"kind\":\"message\",\"id\":\"inbox-1\",\"te")
                .unwrap();
        }
        // The store attaches straight over the fragment (the shape an
        // interrupted append leaves mid-session; a fresh open would have
        // compacted it away instead).
        let store = SessionInbox {
            journal: Some(journal),
            state: Mutex::new(InboxState::default()),
        };
        store.push(
            notice(
                "echo 1",
                INBOX_CLASS_BASH_DONE,
                "after the fragment",
                json!({}),
            ),
            1_000,
        );
        drop(store);
        let reopened = SessionInbox::open(Some(dir.path()));
        let (count, _, _) = reopened.count();
        assert_eq!(count, 1, "the record after the fragment replays");
        let drained = reopened.drain();
        assert_eq!(drained[0].text, "after the fragment");
    }

    /// The host handlers drain on read and summarize on count.
    #[tokio::test]
    async fn read_drains_and_count_summarizes() {
        let inbox = Arc::new(SessionInbox::in_memory());
        let mut handlers = HostRequestHandlers::default();
        register_inbox_host_handlers(&inbox, &mut handlers);
        inbox.push(
            notice(
                "the command",
                INBOX_CLASS_BASH_DONE,
                "the command finished",
                json!({"pid": 1}),
            ),
            1_000,
        );
        inbox.push(
            notice(
                "r1",
                INBOX_CLASS_FACTORY_PROGRESS,
                "the run paused",
                json!({"runId": "r1"}),
            ),
            2_000,
        );
        let count = handlers
            .get(INBOX_COUNT_REQUEST_TYPE)
            .expect("count registered")
            .clone();
        let reply = count(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(
            reply,
            json!({
                "count": 2,
                "oldestArrivedAtMs": 1_000,
                "classes": { "bash-done": 1, "factory-progress": 1 },
            })
        );
        let read = handlers
            .get(INBOX_READ_REQUEST_TYPE)
            .expect("read registered")
            .clone();
        let reply = read(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(reply["drainedCount"], 2);
        let messages = reply["messages"].as_array().unwrap();
        assert_eq!(messages[0]["id"], "inbox-1");
        assert_eq!(messages[0]["class"], "bash-done");
        assert_eq!(messages[0]["arrivedAtMs"], 1_000);
        assert_eq!(messages[0]["text"], "the command finished");
        assert_eq!(messages[0]["meta"], json!({"pid": 1}));
        assert_eq!(messages[1]["sender"], "r1");
        // The read drained.
        let reply = count(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(
            reply,
            json!({ "count": 0, "oldestArrivedAtMs": null, "classes": {} })
        );
        let reply = read(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(reply, json!({ "messages": [], "drainedCount": 0 }));
    }

    /// The read host handler narrows on a filter payload and rejects a
    /// malformed one (a silent default would drain everything).
    #[tokio::test]
    async fn the_read_handler_honors_a_filter_payload() {
        let inbox = Arc::new(SessionInbox::in_memory());
        let mut handlers = HostRequestHandlers::default();
        register_inbox_host_handlers(&inbox, &mut handlers);
        inbox.push(
            notice("sleep 1", INBOX_CLASS_BASH_DONE, "a", json!({})),
            1_000,
        );
        inbox.push(
            notice("peer", INBOX_CLASS_AGENT_MESSAGE, "b", json!({})),
            2_000,
        );
        let read = handlers
            .get(INBOX_READ_REQUEST_TYPE)
            .expect("read registered")
            .clone();
        let reply = read(HostRequestPayload {
            data: json!({ "class": INBOX_CLASS_AGENT_MESSAGE, "sender": "peer" }),
        })
        .await
        .unwrap();
        assert_eq!(reply["drainedCount"], 1);
        assert_eq!(reply["messages"][0]["text"], "b");
        // The unmatched message stays for the next read.
        let reply = read(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(reply["drainedCount"], 1);
        assert_eq!(reply["messages"][0]["text"], "a");
        // A malformed filter fails the read; nothing drains.
        inbox.push(
            notice("sleep 3", INBOX_CLASS_BASH_DONE, "c", json!({})),
            3_000,
        );
        let error = read(HostRequestPayload {
            data: json!({ "sinceMs": "soon" }),
        })
        .await;
        assert!(error.is_err(), "the malformed filter fails the read");
        assert_eq!(inbox.count().0, 1, "the malformed read drained nothing");
    }
}

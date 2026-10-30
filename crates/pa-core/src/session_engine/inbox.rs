//! The agent inbox: the daemon-owned store where machine-generated
//! kernel notices (`bash.completed` and `factory.progress`) accumulate
//! per session instead of steering their full rows, plus the
//! `rlm.inbox.read`/`rlm.inbox.count` host requests the agent reads
//! them with. The durable journal (`inbox.jsonl` under the session dir)
//! replays on open, so a daemon restart keeps unread messages.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::kernel::shared::{host_handler, HostRequestHandlers};

use super::bash_notices::KernelNotice;
use super::messages::{ASYNC_BASH_COMPLETION_CUSTOM_TYPE, FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE};
use pa_types::ai::UserContent;

/// The kernel host request that drains and returns every waiting message.
pub const INBOX_READ_REQUEST_TYPE: &str = "rlm.inbox.read";
/// The kernel host request that counts the waiting messages.
pub const INBOX_COUNT_REQUEST_TYPE: &str = "rlm.inbox.count";
/// The journal file one session's inbox appends under its session dir.
pub const INBOX_JOURNAL_FILE: &str = "inbox.jsonl";

/// The `bash.completed` notice class label.
pub const INBOX_CLASS_BASH_DONE: &str = "bash-done";
/// The `factory.progress` notice class label.
pub const INBOX_CLASS_FACTORY_PROGRESS: &str = "factory-progress";
/// The RLM child terminal notice class label (stage 2 routing).
pub const INBOX_CLASS_CHILD_NOTICE: &str = "child-notice";

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

/// One journal record: a message arrival, or a drain marker.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum InboxRecord {
    Message(InboxMessage),
    Drained,
}

impl SessionInbox {
    /// Open the inbox over one session dir: replay the journal and
    /// rewrite it compacted to the pending messages (bounded growth
    /// across restarts). A missing or unreadable journal starts empty;
    /// journal write failures degrade to in-process durability only.
    #[must_use]
    pub fn open(dir: Option<&Path>) -> Self {
        // The artifact dir may not exist yet on a fresh session; the
        // journal append creates the file but never the directory.
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(dir);
        }
        let journal = dir.map(|dir| dir.join(INBOX_JOURNAL_FILE));
        let (messages, next_id) = journal
            .as_deref()
            .map(replay_journal)
            .unwrap_or_else(|| (Vec::new(), 0));
        let inbox = Self {
            journal,
            state: Mutex::new(InboxState { messages, next_id }),
        };
        inbox.compact_journal();
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
            .append(true)
            .open(journal)
            .and_then(|mut file| {
                use std::io::Write as _;
                writeln!(file, "{line}")
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

    /// Rewrite the journal to the pending messages (called at open, so
    /// drained history never outlives a restart).
    fn compact_journal(&self) {
        let Some(journal) = &self.journal else {
            return;
        };
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut lines = String::new();
        for message in &state.messages {
            let record =
                serde_json::to_value(InboxRecord::Message(message.clone())).unwrap_or(Value::Null);
            lines.push_str(&serde_json::to_string(&record).unwrap_or_default());
            lines.push('\n');
        }
        let tmp = journal.with_extension("jsonl.tmp");
        let rewrite = std::fs::write(&tmp, lines).and_then(|()| std::fs::rename(&tmp, journal));
        if let Err(error) = rewrite {
            eprintln!(
                "pa-daemon: inbox journal compaction failed ({}): {error}",
                journal.display()
            );
        }
    }
}

/// Replay one journal: apply every record in order.
fn replay_journal(journal: &Path) -> (Vec<InboxMessage>, u64) {
    let content = std::fs::read_to_string(journal).unwrap_or_default();
    let mut messages = Vec::new();
    let mut next_id = 0;
    for line in content.lines() {
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
        }
    }
    (messages, next_id)
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

/// The periodic reminder text while the inbox stays unread.
#[must_use]
pub fn reminder_notice(count: usize, oldest_waited_ms: u64) -> String {
    format!(
        "[inbox reminder] {count} messages still waiting (oldest waited {}m) — rlm.inbox.read()",
        oldest_waited_ms / 60_000
    )
}

/// Register the `rlm.inbox.read`/`rlm.inbox.count` host handlers over
/// one session's store. `read` drains and returns the waiting messages;
/// `count` returns the count, the oldest arrival, and the per-class
/// breakdown.
pub fn register_inbox_host_handlers(inbox: &Arc<SessionInbox>, handlers: &mut HostRequestHandlers) {
    let read_inbox = Arc::clone(inbox);
    handlers.register(
        INBOX_READ_REQUEST_TYPE,
        host_handler(move |_payload| {
            let inbox = Arc::clone(&read_inbox);
            Box::pin(async move {
                let messages = inbox.drain();
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
        // The in-process compaction rewrote the journal to the pending
        // messages: one line each.
        let content = std::fs::read_to_string(&journal).unwrap();
        assert_eq!(content.lines().count(), 2, "journal: {content}");
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

    /// The reminder names the waiting count and the oldest wait.
    #[test]
    fn reminder_notice_names_the_wait() {
        assert_eq!(
            reminder_notice(3, 9 * 60_000),
            "[inbox reminder] 3 messages still waiting (oldest waited 9m) — rlm.inbox.read()"
        );
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
}

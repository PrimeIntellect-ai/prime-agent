//! The agent inbox: the daemon-owned store where machine-generated
//! kernel notices (`bash.completed`, `factory.progress`, agent
//! messages, child lifecycle terminals, and heartbeat fires) accumulate
//! per session instead of steering their full rows, plus the
//! `rlm.inbox.read`/`rlm.inbox.count` host requests the agent reads
//! them with. The durable journal (`inbox.jsonl` under the session dir)
//! replays on open, so a daemon restart keeps unread messages. A bash
//! completion the kernel collected through its handle withdraws its
//! message (`bash.consumed`), so a collected job leaves nothing
//! waiting.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Map, Value};

use crate::kernel::shared::{host_handler, HostRequestHandlers};

use super::bash_notices::KernelNotice;
use super::messages::{
    ASYNC_BACKGROUND_CELL_COMPLETION_CUSTOM_TYPE, ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
    FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE,
};
use pa_types::ai::UserContent;
use pa_types::session::CustomMessage;

/// The kernel host request that drains and returns the waiting messages
/// (all of them, or the subset a targeted-read filter narrows to).
pub const INBOX_READ_REQUEST_TYPE: &str = "rlm.inbox.read";
/// The kernel host request that counts the waiting messages.
pub const INBOX_COUNT_REQUEST_TYPE: &str = "rlm.inbox.count";
/// The journal file one session's inbox appends under its session dir.
pub const INBOX_JOURNAL_FILE: &str = "inbox.jsonl";
/// The notice clause while the journal's last write failed: the inbox
/// stays memory-only until a write succeeds again (nano-rlm's
/// `inbox_error` visibility — the notice names the degradation).
pub const INBOX_PERSISTENCE_ERROR_CLAUSE: &str =
    "(inbox persistence failed; messages are memory-only)";
/// The journal size below which removals never compact it. Above it, a
/// removal compacts once the file has doubled since the last compaction,
/// so the file stays within twice the live set (or this floor) and each
/// rewrite is paid for by the appends before it.
const JOURNAL_COMPACT_MIN_BYTES: u64 = 1024 * 1024;

use pa_types::inbox_notice::{
    INBOX_CLASS_AGENT_MESSAGE, INBOX_CLASS_BASH_DONE, INBOX_CLASS_CELL_DONE,
    INBOX_CLASS_CHILD_EXITED,
    INBOX_CLASS_CHILD_FAILED, INBOX_CLASS_FACTORY_PROGRESS, INBOX_CLASS_HEARTBEAT,
};

/// The coalescing batch state the daemon's notice sink owns: the
/// arrivals the currently queued short-notice row covers (reset when the
/// row delivers or clears).
pub type InboxArrivals = std::sync::Arc<std::sync::Mutex<Vec<InboxMessage>>>;

/// The daemon's post-drain seam: every successful `rlm.inbox.read` runs
/// it so the queued wake rows can retract or re-render over what is left
/// (a drained store leaves no stale notice or reminder behind).
pub type InboxReadHook = std::sync::Arc<dyn Fn(&std::sync::Arc<SessionInbox>) + Send + Sync>;

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
    /// The sending agent's name (agent messages only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    pub text: String,
    #[serde(default)]
    pub meta: Map<String, Value>,
}

impl InboxMessage {
    /// The class's own identity a targeted read's `key` matches: the
    /// command of a bash completion, the run id of a factory milestone,
    /// the cell id of a background cell completion,
    /// the child's session name of a child lifecycle notice, and the job
    /// id of a heartbeat fire. Agent messages have none (they filter by
    /// `sender`).
    #[must_use]
    pub fn key(&self) -> Option<&str> {
        let field = match self.class.as_str() {
            INBOX_CLASS_BASH_DONE => "command",
            INBOX_CLASS_FACTORY_PROGRESS => "runId",
            INBOX_CLASS_CELL_DONE => "cellId",
            INBOX_CLASS_CHILD_EXITED | INBOX_CLASS_CHILD_FAILED => "sessionName",
            INBOX_CLASS_HEARTBEAT => "jobId",
            _ => return None,
        };
        self.meta.get(field).and_then(Value::as_str)
    }

    /// Whether this is the completion of the bash job `pid` running
    /// `command` (pids are reused, so the command disambiguates).
    #[must_use]
    pub fn is_bash_completion(&self, pid: u32, command: &str) -> bool {
        self.class == INBOX_CLASS_BASH_DONE
            && self.meta.get("pid").and_then(Value::as_u64) == Some(u64::from(pid))
            && self.key() == Some(command)
    }

    /// Whether this is a fire of the heartbeat job `job_id`.
    #[must_use]
    pub fn is_heartbeat_fire(&self, job_id: &str) -> bool {
        self.class == INBOX_CLASS_HEARTBEAT && self.key() == Some(job_id)
    }
}

/// The inbox projection of one routed notice: the class label, the
/// sender (agent messages only), the row's text, and its metadata.
#[derive(Debug, Clone)]
pub struct InboxNotice {
    pub class: &'static str,
    pub sender: Option<String>,
    pub text: String,
    pub meta: Map<String, Value>,
}

/// The targeted-read filter for `rlm.inbox.read` (`rlm.inbox.read()` in
/// Python): every set field narrows the read (`ANDed`), an all-`None`
/// filter reads everything. The wire shape is camelCase, like the
/// message rows.
///
/// The shape is STRICT: an unknown field is a request error, never a
/// silently empty filter that would drain the whole inbox — a typo has
/// to fail closed. `type` is reserved for the host-request envelope's
/// routing key (the read handler strips it), so no filter field may
/// ever take that name.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct InboxReadFilter {
    /// Exact sender match; only agent messages have a sender.
    pub sender: Option<String>,
    /// Exact class match (`bash-done`, `factory-progress`, `agent-message`, ...).
    pub class: Option<String>,
    /// Exact match on the class's own key ([`InboxMessage::key`]); only
    /// valid together with `class`, so a key never matches across classes.
    pub key: Option<String>,
    /// Arrival lower bound, inclusive (epoch milliseconds).
    pub since_ms: Option<u64>,
    /// Arrival upper bound, exclusive (epoch milliseconds).
    pub before_ms: Option<u64>,
}

impl InboxReadFilter {
    fn matches(&self, message: &InboxMessage) -> bool {
        self.sender.as_deref().is_none_or(|sender| {
            message.class == INBOX_CLASS_AGENT_MESSAGE && message.sender.as_deref() == Some(sender)
        }) && self
            .class
            .as_deref()
            .is_none_or(|class| message.class == class)
            && self
                .key
                .as_deref()
                .is_none_or(|key| message.key() == Some(key))
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
        ASYNC_BACKGROUND_CELL_COMPLETION_CUSTOM_TYPE => Some(INBOX_CLASS_CELL_DONE),
        _ => None,
    }
}

/// A notice row's details as message metadata (rows without object
/// details carry none).
fn details_meta(details: Option<&Value>) -> Map<String, Value> {
    match details {
        Some(Value::Object(details)) => details.clone(),
        _ => Map::new(),
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
    let mut meta = details_meta(notice.row.details.as_ref());
    // The bash event's exit class rides beside the raw code: the handle
    // identity (pid + command) plus one word a targeted read can act on
    // without decoding the code.
    if class == INBOX_CLASS_BASH_DONE {
        if let Some(code) = meta.get("exitCode").and_then(Value::as_i64) {
            let exit_class = if code == 0 { "success" } else { "failure" };
            meta.insert("exitClass".to_string(), json!(exit_class));
        }
    }
    Some(InboxNotice {
        class,
        sender: None,
        text,
        meta,
    })
}

/// The inbox projection of one reserved child-status custom row (the
/// daemon's `rlm_child_terminal_notice`/`rlm_child_failure` wire forms):
/// the lifecycle class, the row's text as the message, and the row's
/// details as the metadata. `None` for any row that is not a reserved
/// child-status kind or that carries no text content.
#[must_use]
pub fn child_status_notice_fields(custom: &Value) -> Option<InboxNotice> {
    let class = match custom.get("customType").and_then(Value::as_str)? {
        super::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE => INBOX_CLASS_CHILD_EXITED,
        super::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE => INBOX_CLASS_CHILD_FAILED,
        _ => return None,
    };
    let text = match custom.get("content") {
        Some(Value::String(text)) => text.clone(),
        _ => return None,
    };
    Some(InboxNotice {
        class,
        sender: None,
        text,
        meta: details_meta(custom.get("details")),
    })
}

/// The inbox projection of one fired heartbeat's delivery row (the
/// scheduled turn the fire would have injected): the `heartbeat` class
/// and the delivery row's text and details.
#[must_use]
pub fn heartbeat_notice_fields(row: &CustomMessage) -> Option<InboxNotice> {
    let text = match &row.content {
        UserContent::Text(text) => text.clone(),
        UserContent::Blocks(_) => return None,
    };
    Some(InboxNotice {
        class: INBOX_CLASS_HEARTBEAT,
        sender: None,
        text,
        meta: details_meta(row.details.as_ref()),
    })
}

/// The number in an `inbox-<n>` message id.
fn id_number(id: &str) -> Option<u64> {
    id.strip_prefix("inbox-")?.parse().ok()
}

/// The open journal: one append handle kept across records, the file's
/// length, and the length at which the next removal compacts it.
#[derive(Debug)]
struct Journal {
    path: PathBuf,
    /// `None` until the first append and after a failed write or a
    /// compaction (the next append reopens it).
    file: Option<File>,
    len: u64,
    compact_at: u64,
}

impl Journal {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            len: 0,
            compact_at: JOURNAL_COMPACT_MIN_BYTES,
        }
    }

    /// Append one record line. A failed write truncates its partial
    /// bytes and drops the handle; the reopen writes a missing line
    /// boundary first, so a fragment the truncate could not remove stays
    /// its own (skipped) line instead of swallowing the next record.
    fn append(&mut self, line: &[u8]) -> std::io::Result<()> {
        let file = if let Some(file) = &mut self.file {
            file
        } else {
            let (file, len) = open_for_append(&self.path)?;
            self.len = len;
            self.file.insert(file)
        };
        if let Err(error) = file.write_all(line) {
            let _ = file.set_len(self.len);
            self.file = None;
            return Err(error);
        }
        self.len += line.len() as u64;
        Ok(())
    }
}

/// Open the journal for appending and end it on a line boundary.
fn open_for_append(path: &Path) -> std::io::Result<(File, u64)> {
    use std::io::{Read as _, Seek as _};
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).append(true);
    crate::platform::perms::set_private_mode(&mut options);
    let mut file = options.open(path)?;
    let mut len = file.metadata()?.len();
    if len > 0 {
        let mut last = [0u8; 1];
        file.seek(std::io::SeekFrom::End(-1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            file.write_all(b"\n")?;
            len += 1;
        }
    }
    Ok((file, len))
}

#[derive(Debug, Default)]
struct InboxState {
    /// The waiting messages by id number (ids are issued in arrival
    /// order, so this is arrival order too).
    messages: BTreeMap<u64, InboxMessage>,
    /// The waiting count per class, kept with `messages`.
    classes: BTreeMap<String, u64>,
    next_id: u64,
    /// `None` for an in-memory store and for a journal that could not be
    /// read (nothing may write over records the store never saw).
    journal: Option<Journal>,
    /// The journal's degradation, surfaced in the notice text (the
    /// [`INBOX_PERSISTENCE_ERROR_CLAUSE`] rides it): a failed append sets
    /// it and only a full rewrite that re-persists the pending set clears
    /// it (an unreadable journal never rewrites, so its instance keeps
    /// the slot).
    persistence_error: Option<String>,
}

impl InboxState {
    fn insert(&mut self, message: InboxMessage) {
        if let Some(number) = id_number(&message.id) {
            *self.classes.entry(message.class.clone()).or_default() += 1;
            self.messages.insert(number, message);
        }
    }

    fn remove(&mut self, id: &str) -> Option<InboxMessage> {
        let message = self.messages.remove(&id_number(id)?)?;
        self.uncount(&message.class);
        Some(message)
    }

    fn uncount(&mut self, class: &str) {
        if let Some(count) = self.classes.get_mut(class) {
            *count -= 1;
            if *count == 0 {
                self.classes.remove(class);
            }
        }
    }

    /// Journal one record. Failures degrade durability only: the
    /// in-process surface stays truthful, and the error slot names the
    /// degradation in the notices until a full rewrite re-persists the
    /// pending set. A successful append never clears it: the journal is
    /// append-only, so a later write does not persist the records whose
    /// appends failed.
    fn append(&mut self, record: &InboxRecord) {
        let Some(journal) = &mut self.journal else {
            return;
        };
        let mut line = serde_json::to_vec(record).unwrap_or_default();
        line.push(b'\n');
        if let Err(error) = journal.append(&line) {
            eprintln!(
                "pa-daemon: inbox journal append failed ({}): {error}",
                journal.path.display()
            );
            self.persistence_error = Some(format!("{}: {error}", journal.path.display()));
        }
    }

    /// Rewrite the journal to the id counter and the pending messages
    /// (at open, and when removals let the file outgrow the live set),
    /// so drained history does not accumulate and the counter never
    /// resets to zero on a drained restart.
    fn compact(&mut self) {
        let Some(journal) = &mut self.journal else {
            return;
        };
        let mut lines = String::new();
        let counter = InboxRecord::Counter {
            next_id: self.next_id,
        };
        lines.push_str(&serde_json::to_string(&counter).unwrap_or_default());
        lines.push('\n');
        for message in self.messages.values() {
            let record = InboxRecord::Message(message.clone());
            lines.push_str(&serde_json::to_string(&record).unwrap_or_default());
            lines.push('\n');
        }
        // The rewrite replaces every pending record: it must be durable
        // before the rename can drop the old file on a crash, so this
        // call site opts into the atomic write's pre-rename fsync and
        // the post-rename directory sync.
        let rewrite = crate::settings::storage::atomic_write_with(
            &journal.path,
            &lines,
            crate::settings::storage::AtomicWriteOptions { fsync: true },
        );
        match rewrite {
            Ok(()) => {
                // The rename replaced the file the handle pointed at.
                journal.file = None;
                journal.len = lines.len() as u64;
                journal.compact_at = JOURNAL_COMPACT_MIN_BYTES.max(2 * journal.len);
                // The rewrite re-persisted every pending message: the
                // degradation epoch is over (the only append-only-safe
                // clear).
                self.persistence_error = None;
            }
            Err(error) => {
                eprintln!(
                    "pa-daemon: inbox journal compaction failed ({}): {error}",
                    journal.path.display()
                );
                self.persistence_error = Some(format!("{}: {error}", journal.path.display()));
            }
        }
    }
}

/// The per-session inbox store: the in-memory waiting messages plus the
/// durable journal under the session dir. Every push and removal
/// appends one journal record, and `open` replays the journal so a
/// daemon restart keeps unread messages.
pub struct SessionInbox {
    state: Mutex<InboxState>,
    /// The daemon's post-drain seam (set once at session build): every
    /// successful read runs it so the queued wake rows can retract or
    /// re-render over what is left.
    read_hook: Mutex<Option<InboxReadHook>>,
}

impl std::fmt::Debug for SessionInbox {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionInbox")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

/// One journal record: a message arrival, the ids one removal took (a
/// read, a clear, a withdrawal), or the id counter's high-water mark
/// (compaction persists it so a drained restart never reuses a spent
/// id).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum InboxRecord {
    Message(InboxMessage),
    /// The v0.10.6 betas journaled a targeted read as `read` with the
    /// same shape.
    #[serde(alias = "read")]
    Removed {
        ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Counter {
        next_id: u64,
    },
    /// Written by the v0.10.6 betas (a full drain); replayed only.
    Drained,
    /// Written by the v0.10.6 betas (one withdrawn id); replayed only.
    Withdrawn {
        id: String,
    },
}

impl SessionInbox {
    /// Open the inbox over one session dir: replay the journal and
    /// rewrite it compacted to the pending messages. A missing journal
    /// starts empty; a journal that cannot be read starts empty but stays
    /// untouched — and the instance stays memory-only, never appending,
    /// so nothing it does can obscure the records a later open reads;
    /// journal write failures degrade to in-process durability only.
    #[must_use]
    pub fn open(dir: Option<&Path>) -> Self {
        // The artifact dir may not exist yet on a fresh session; the
        // journal append creates the file but never the directory.
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(dir);
        }
        let Some(path) = dir.map(|dir| dir.join(INBOX_JOURNAL_FILE)) else {
            return Self::in_memory();
        };
        match replay_journal(&path) {
            Some(mut state) => {
                state.journal = Some(Journal::new(path));
                state.compact();
                Self::with_state(state)
            }
            // Unreadable records are out of reach: a removal appended now
            // would erase them for a future readable replay, so the
            // memory-only instance detaches from the path entirely and
            // names the degradation from the first notice on.
            None => Self::with_state(InboxState {
                persistence_error: Some(format!("{}: unreadable", path.display())),
                ..InboxState::default()
            }),
        }
    }

    fn with_state(state: InboxState) -> Self {
        Self {
            state: Mutex::new(state),
            read_hook: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, InboxState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The journal path this store writes (the reopen/reuse seam).
    #[must_use]
    pub fn journal_path(&self) -> Option<PathBuf> {
        self.lock()
            .journal
            .as_ref()
            .map(|journal| journal.path.clone())
    }

    /// Open the store for one session dir, REUSING the existing store
    /// when it already serves the same journal: a failed build can leave
    /// its published store writable while the next attempt reopens the
    /// same journal, and a fresh open's compaction would race those
    /// appends. A different journal (or none) opens fresh.
    #[must_use]
    pub fn open_or_reuse(
        existing: Option<&std::sync::Arc<SessionInbox>>,
        dir: Option<&Path>,
    ) -> std::sync::Arc<SessionInbox> {
        let wanted = dir.map(|dir| dir.join(INBOX_JOURNAL_FILE));
        if let (Some(existing), Some(wanted)) = (existing, wanted.as_deref()) {
            if existing.journal_path().as_deref() == Some(wanted) {
                return std::sync::Arc::clone(existing);
            }
        }
        std::sync::Arc::new(Self::open(dir))
    }

    /// Install the daemon's post-drain seam (the worker's wake-row
    /// refresh); the kernel's read handler runs it after every drain.
    pub fn set_read_hook(&self, hook: InboxReadHook) {
        *self
            .read_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook);
    }

    /// The installed post-drain seam, when one is set.
    #[must_use]
    pub fn read_hook(&self) -> Option<InboxReadHook> {
        self.read_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The in-memory inbox (no journal).
    #[must_use]
    pub fn in_memory() -> Self {
        Self::with_state(InboxState::default())
    }

    /// The journal's last write failure, while the inbox is memory-only:
    /// the notice texts carry the [`INBOX_PERSISTENCE_ERROR_CLAUSE`]
    /// until a write succeeds again.
    #[must_use]
    pub fn persistence_error(&self) -> Option<String> {
        self.lock().persistence_error.clone()
    }

    /// One notice text with the degradation named while the journal's
    /// last write failed (the arrival, reminder, and withdrawal
    /// re-render sites share this decoration, so a re-rendered queued row
    /// never loses the clause its row was queued with).
    #[must_use]
    pub fn with_persistence_error_clause(&self, text: String) -> String {
        if self.persistence_error().is_some() {
            format!("{text} {INBOX_PERSISTENCE_ERROR_CLAUSE}")
        } else {
            text
        }
    }

    /// Append one message: durable journal first, then the store. The
    /// id is a fresh monotonic `inbox-<n>`.
    pub fn push(&self, notice: InboxNotice, arrived_at_ms: u64) -> InboxMessage {
        let mut state = self.lock();
        state.next_id += 1;
        let message = InboxMessage {
            id: format!("inbox-{}", state.next_id),
            class: notice.class.to_string(),
            arrived_at_ms,
            sender: notice.sender,
            text: notice.text,
            meta: notice.meta,
        };
        state.append(&InboxRecord::Message(message.clone()));
        state.insert(message.clone());
        message
    }

    /// Remove every waiting message the predicate matches and return
    /// them in arrival order: the one removal path (reads, clears, and
    /// withdrawals). The journal records the taken ids before the store
    /// drops them, so a crash between the two never resurrects a removed
    /// message; a removal that takes nothing writes nothing.
    pub fn remove_where(
        &self,
        mut matches: impl FnMut(&InboxMessage) -> bool,
    ) -> Vec<InboxMessage> {
        let mut state = self.lock();
        let ids = state
            .messages
            .values()
            .filter(|message| matches(message))
            .map(|message| message.id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Vec::new();
        }
        state.append(&InboxRecord::Removed { ids: ids.clone() });
        let removed = ids.iter().filter_map(|id| state.remove(id)).collect();
        if state
            .journal
            .as_ref()
            .is_some_and(|journal| journal.len >= journal.compact_at)
        {
            state.compact();
        }
        removed
    }

    /// Read drains: the messages the filter matches (all of them for the
    /// default filter) return in arrival order and leave the store.
    pub fn read(&self, filter: &InboxReadFilter) -> Vec<InboxMessage> {
        self.remove_where(|message| filter.matches(message))
    }

    /// The waiting messages in arrival order: the wake-row refresh
    /// rebuilds an unknown recovered batch from them.
    #[must_use]
    pub fn waiting_messages(&self) -> Vec<InboxMessage> {
        self.lock().messages.values().cloned().collect()
    }

    /// Whether the message with this id is still waiting.
    #[must_use]
    pub fn is_waiting(&self, id: &str) -> bool {
        id_number(id).is_some_and(|number| self.lock().messages.contains_key(&number))
    }

    /// The waiting count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.lock().messages.len()
    }

    /// Whether nothing is waiting.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The waiting count, its oldest arrival time, and the per-class
    /// breakdown.
    pub fn count(&self) -> (usize, Option<u64>, BTreeMap<String, u64>) {
        let state = self.lock();
        (
            state.messages.len(),
            state
                .messages
                .values()
                .next()
                .map(|message| message.arrived_at_ms),
            state.classes.clone(),
        )
    }
}

/// Replay one journal: apply every complete record in order. A torn
/// tail (a crash mid-append) degrades to the records that parse — the
/// compacted rewrite that follows drops the fragment. `None` for a
/// journal that cannot be read at all, so the open never compacts over
/// it.
fn replay_journal(journal: &Path) -> Option<InboxState> {
    let mut state = InboxState::default();
    let bytes = match std::fs::read(journal) {
        Ok(bytes) => bytes,
        // A missing journal starts fresh; the open's compaction
        // creates it.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(state),
        Err(error) => {
            eprintln!(
                "pa-daemon: inbox journal read failed ({}): {error}",
                journal.display()
            );
            return None;
        }
    };
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(record) = serde_json::from_slice::<InboxRecord>(line.trim_ascii()) else {
            continue;
        };
        match record {
            InboxRecord::Message(message) => {
                if let Some(number) = id_number(&message.id) {
                    state.next_id = state.next_id.max(number);
                }
                state.insert(message);
            }
            InboxRecord::Removed { ids } => {
                for id in &ids {
                    state.remove(id);
                }
            }
            InboxRecord::Withdrawn { id } => {
                state.remove(&id);
            }
            InboxRecord::Drained => {
                state.messages.clear();
                state.classes.clear();
            }
            InboxRecord::Counter { next_id } => state.next_id = state.next_id.max(next_id),
        }
    }
    Some(state)
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
/// that replaces the notices' full rows (see [`arrival_summary`] for the
/// count wording), then the waiting count and the read instruction.
#[must_use]
pub fn arrival_notice(batch: &[InboxMessage], total_waiting: usize) -> (String, String) {
    let Some((window, summary)) = arrival_summary(batch) else {
        return (String::new(), String::new());
    };
    (
        format!("Inbox: {summary}"),
        format!(
            "[inbox {window} UTC] {summary}; total waiting: {total_waiting}. Read them with msgs = await rlm.inbox.read()."
        ),
    )
}

/// One batch's `(window, summary)`. One count row per batch: a single
/// arrival names its class ("1 new message (bash-done)"), a same class
/// burst its count ("3 new bash-done messages"), a mixed burst the
/// per-class breakdown ("3 new messages (2 bash-done, 1 child-exited)").
/// The window is the latest arrival's UTC time; a wider batch carries
/// the arrival window. `None` for an empty batch.
#[must_use]
pub fn arrival_summary(batch: &[InboxMessage]) -> Option<(String, String)> {
    let last = batch.last()?;
    let signature = utc_hh_mm(last.arrived_at_ms);
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
    let count = batch.len();
    let summary = if count == 1 {
        format!("1 new message ({})", last.class)
    } else if classes.len() == 1 {
        format!("{count} new {} messages", classes[0].0)
    } else {
        let breakdown = classes
            .iter()
            .map(|(class, class_count)| format!("{class_count} {class}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{count} new messages ({breakdown})")
    };
    let window = if count == 1 {
        signature
    } else {
        format!("{}-{}", utc_hh_mm(batch[0].arrived_at_ms), signature)
    };
    Some((window, summary))
}

/// The periodic reminder text while the inbox stays unread: a minimal
/// count-only nudge (the oldest-wait detail stays on `count()`).
#[must_use]
pub fn reminder_notice(count: usize) -> String {
    let noun = if count == 1 { "message" } else { "messages" };
    format!("[inbox reminder] {count} {noun} still waiting. Read them with msgs = await rlm.inbox.read().")
}

// The notice rows' wire vocabulary — the customType, the notice-class
// words, and the sender identity — lives in `pa_types::inbox_notice`: ONE
// definition the daemon's queue lanes and the TUI's decode import too
// (the TUI cannot import the session engine, so a twin constant would
// drift silently); this module keeps only its own private use.
use pa_types::inbox_notice::{INBOX_NOTICE_CUSTOM_TYPE, INBOX_NOTICE_SENDER};

/// The `role: "custom"` inbox-notice row one queued notice delivers as,
/// mirroring `create_agent_session_message_row`: `content` IS the notice
/// text, so the turn's model context stays byte-identical to the
/// plain-prompt delivery, while the details carry the inbox-system sender
/// and the notice class for the transcript's own row class. `count` is
/// the number the text announces (the arrival batch size, or the
/// reminder's waiting count) for the transcript header.
///
/// `wakes_cell` is the arrival's wake eligibility — whether the covered
/// batch contained anything besides bare cell completions — and
/// `covers_cell_done` is whether the batch contained a bare cell
/// completion: both stored once at the row render. A later cell's wake
/// predicate reads `wakes_cell` (a restored row without the bit is
/// conservatively wakeable), and the quiescence observation reads
/// `covers_cell_done` so a pending cell-done delivery is never reported
/// as zero outstanding work (a restored row without the bit counts
/// conservatively).
#[must_use]
pub fn create_inbox_notice_row(
    text: &str,
    class: &str,
    count: usize,
    wakes_cell: bool,
    covers_cell_done: bool,
    timestamp: u64,
) -> Value {
    json!({
        "role": "custom",
        "customType": INBOX_NOTICE_CUSTOM_TYPE,
        "content": text,
        "display": true,
        "details": {
            "sender": INBOX_NOTICE_SENDER,
            "class": class,
            "count": count,
            "wakesCell": wakes_cell,
            "coversCellDone": covers_cell_done,
        },
        "timestamp": timestamp,
    })
}

/// Register the `rlm.inbox.read`/`rlm.inbox.count` host handlers over
/// one session's store. `read` drains and returns the waiting messages
/// (an optional `{sender, class, key, sinceMs, beforeMs}` filter narrows
/// the drain) and then runs the daemon's `read_hook`, so the queued wake
/// rows can retract or re-render over what is left; `count` returns the
/// count, the oldest arrival, and the per-class breakdown.
pub fn register_inbox_host_handlers(inbox: &Arc<SessionInbox>, handlers: &mut HostRequestHandlers) {
    let read_inbox = Arc::clone(inbox);
    handlers.register(
        INBOX_READ_REQUEST_TYPE,
        host_handler(move |payload| {
            let inbox = Arc::clone(&read_inbox);
            Box::pin(async move {
                // The host-request envelope routes on its `type` key and the
                // kernel manager hands the handler the whole request object,
                // so the transport's routing key rides beside the filter
                // fields; it is never filter data (the runtime puts the
                // request type last, so a caller-supplied `type` was already
                // overwritten before the wire).
                let mut data = payload.data;
                if let Some(fields) = data.as_object_mut() {
                    fields.remove("type");
                }
                let filter: InboxReadFilter = if data.is_null() {
                    InboxReadFilter::default()
                } else {
                    serde_json::from_value(data)?
                };
                if filter.key.is_some() && filter.class.is_none() {
                    anyhow::bail!("rlm.inbox.read: key needs inbox_class");
                }
                let messages = inbox.read(&filter);
                if let Some(hook) = inbox.read_hook() {
                    hook(&inbox);
                }
                // The wire entry adds the class key the `key` filter
                // matches, so the agent sees what it can filter on.
                let messages = messages
                    .iter()
                    .map(|message| {
                        let mut entry = json!(message);
                        if let Some(key) = message.key() {
                            entry["key"] = json!(key);
                        }
                        entry
                    })
                    .collect::<Vec<_>>();
                Ok(json!({ "messages": messages }))
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
    use pa_types::inbox_notice::{INBOX_NOTICE_CLASS_ARRIVAL, INBOX_NOTICE_CLASS_REMINDER};

    fn message(id: &str, class: &str, arrived_at_ms: u64, text: &str) -> InboxMessage {
        InboxMessage {
            id: id.to_string(),
            class: class.to_string(),
            arrived_at_ms,
            sender: None,
            text: text.to_string(),
            meta: Map::new(),
        }
    }

    /// One notice; `sender` lands only on agent messages (the other
    /// classes carry their key in `meta`).
    fn notice(sender: &str, class: &'static str, text: &str, meta: Value) -> InboxNotice {
        let Value::Object(meta) = meta else {
            panic!("notice meta is an object");
        };
        InboxNotice {
            class,
            sender: (class == INBOX_CLASS_AGENT_MESSAGE).then(|| sender.to_string()),
            text: text.to_string(),
            meta,
        }
    }

    fn drain(inbox: &SessionInbox) -> Vec<InboxMessage> {
        inbox.read(&InboxReadFilter::default())
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
        let drained = drain(&inbox);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].text, "done");
        assert_eq!(drained[0].meta["pid"], 1);
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
    fn a_bash_completion_withdrawal_takes_only_the_matching_message() {
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
            inbox
                .remove_where(|m| m.is_bash_completion(11, "make targets"))
                .is_empty(),
            "an unmatched pair withdraws nothing"
        );
        let withdrawn = inbox.remove_where(|m| m.is_bash_completion(11, "sleep 1"));
        assert_eq!(
            withdrawn
                .iter()
                .map(|m| m.text.as_str())
                .collect::<Vec<_>>(),
            ["first"]
        );
        let drained = drain(&inbox);
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
            let withdrawn = inbox.remove_where(|m| m.is_bash_completion(11, "sleep 1"));
            assert_eq!(withdrawn[0].id, "inbox-1");
        }
        let inbox = SessionInbox::open(Some(dir.path()));
        let drained = drain(&inbox);
        let replayed = InboxMessage {
            id: "inbox-2".to_string(),
            class: INBOX_CLASS_BASH_DONE.to_string(),
            arrived_at_ms: 2_000,
            sender: None,
            text: "waiting".to_string(),
            meta: json!({"pid": 12, "command": "sleep 2"})
                .as_object()
                .cloned()
                .unwrap(),
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

    /// A journal write failure degrades to memory-only and says so: the
    /// error slot holds the failure across later successful appends too
    /// (the append-only journal never re-persists the failed records)
    /// until a full rewrite re-persists the pending set.
    #[cfg(unix)]
    #[test]
    fn a_journal_write_failure_surfaces_until_a_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        let inbox = SessionInbox::open(Some(dir.path()));
        assert_eq!(
            inbox.persistence_error(),
            None,
            "the open's rewrite succeeded"
        );
        // A directory in the journal's place fails the append's open even
        // when the tests run as root (chmod alone does not); the store
        // opens its append handle at the first append.
        std::fs::remove_file(&journal).unwrap();
        std::fs::create_dir(&journal).unwrap();
        inbox.push(
            notice("sleep 1", INBOX_CLASS_BASH_DONE, "first", json!({"pid": 1})),
            1_000,
        );
        let error = inbox
            .persistence_error()
            .expect("the failed append surfaced");
        assert!(
            error.contains("inbox.jsonl"),
            "the error names the journal: {error}"
        );
        // The in-process surface stays truthful: the message waits.
        assert_eq!(inbox.len(), 1);
        std::fs::remove_dir(&journal).unwrap();
        inbox.push(
            notice(
                "sleep 2",
                INBOX_CLASS_BASH_DONE,
                "second",
                json!({"pid": 2}),
            ),
            2_000,
        );
        assert!(
            inbox.persistence_error().is_some(),
            "a later append never re-persists the failed record: the clause stays"
        );
        // The next full rewrite re-persists every pending message: the
        // only append-only-safe clear.
        inbox.lock().compact();
        assert_eq!(
            inbox.persistence_error(),
            None,
            "the rewrite re-persisted the pending set"
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
        let drained = drain(&inbox);
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
        assert!(
            inbox.persistence_error().is_some(),
            "the unreadable journal names its degradation from the start"
        );
        assert!(journal.is_dir(), "the unread journal is left untouched");
        assert!(
            !std::fs::read_dir(dir.path())
                .unwrap()
                .flatten()
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("inbox.jsonl.tmp")
                }),
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
        assert!(
            inbox.persistence_error().is_some(),
            "the detached instance keeps the unreadable degradation"
        );
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
        assert_eq!(drain(&inbox).len(), 1);
        // A later open replays the record the detached instance never
        // saw (no drain marker sits over it).
        let reopened = SessionInbox::open(Some(dir.path()));
        let drained = drain(&reopened);
        assert_eq!(drained.len(), 1, "the unseen record survives");
        assert_eq!(drained[0].text, "kept");
        assert_eq!(drained[0].id, "inbox-1");
    }

    /// An id removal takes exactly those ids and replays as removed (the
    /// agent-message clear of the durable store).
    #[test]
    fn removing_ids_takes_exactly_those_ids_and_replays() {
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
                notice("peer", INBOX_CLASS_AGENT_MESSAGE, "third", json!({})),
                3_000,
            );
            let removed = inbox.remove_where(|m| ["inbox-2", "inbox-3"].contains(&m.id.as_str()));
            assert_eq!(
                removed.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
                ["second", "third"]
            );
            let (count, _, classes) = inbox.count();
            assert_eq!(count, 1);
            assert_eq!(classes[INBOX_CLASS_BASH_DONE], 1);
        }
        // The withdrawal replays: the removed ids stay gone, the rest
        // survives, and a fresh id never collides.
        let reopened = SessionInbox::open(Some(dir.path()));
        let drained = drain(&reopened);
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].text, "first");
        let next = reopened.push(
            notice("echo", INBOX_CLASS_BASH_DONE, "later", json!({})),
            4_000,
        );
        assert_eq!(next.id, "inbox-4", "the id counter keeps counting");
    }

    /// The compaction opts into the atomic write's fsync: the rewrite
    /// must be durable before it can replace the journal.
    #[test]
    fn the_compaction_opts_into_the_fsync() {
        let before = crate::settings::storage::opt_in_fsync_calls();
        let dir = tempfile::tempdir().unwrap();
        let inbox = SessionInbox::open(Some(dir.path()));
        inbox.push(
            notice("sleep 1", INBOX_CLASS_BASH_DONE, "once", json!({})),
            1_000,
        );
        let _ = SessionInbox::open(Some(dir.path()));
        assert!(
            crate::settings::storage::opt_in_fsync_calls() > before,
            "the compaction's rewrite synced the temp file before the rename"
        );
    }

    /// The rebuild seam reuses a store over the same journal, so a failed
    /// build's published appends never race a fresh open's compaction;
    /// another journal opens fresh.
    #[test]
    fn the_rebuild_seam_reuses_the_same_journal() {
        let dir = tempfile::tempdir().unwrap();
        let first = std::sync::Arc::new(SessionInbox::open(Some(dir.path())));
        first.push(
            notice("sleep 1", INBOX_CLASS_BASH_DONE, "kept", json!({})),
            1_000,
        );
        let reused = SessionInbox::open_or_reuse(Some(&first), Some(dir.path()));
        assert!(
            std::sync::Arc::ptr_eq(&first, &reused),
            "the same journal reuses the live store"
        );
        assert_eq!(reused.count().0, 1, "the published append stays visible");
        let other = tempfile::tempdir().unwrap();
        let fresh = SessionInbox::open_or_reuse(Some(&first), Some(other.path()));
        assert!(
            !std::sync::Arc::ptr_eq(&first, &fresh),
            "another journal opens fresh"
        );
        assert_eq!(fresh.count(), (0, None, BTreeMap::new()));
        let reopened = SessionInbox::open_or_reuse(None, Some(dir.path()));
        assert_eq!(reopened.count().0, 1, "a fresh open replays the journal");
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
            drain(&inbox);
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
        assert_eq!(fields.sender, None);
        assert!(fields.text.contains("[bash-done pid:4321 exit:7]"));
        assert_eq!(
            Value::Object(fields.meta),
            json!({"pid": 4321, "command": "sleep 1", "exitCode": 7, "exitClass": "failure"})
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
        assert_eq!(fields.meta["runId"], "run-7");
        assert!(fields.text.contains("budget-exceeded"));
    }

    /// The arrival notice: one count row per batch. One message names
    /// its class and the total waiting; a same-class burst its count; a
    /// mixed burst the window and the per-class breakdown.
    #[test]
    fn arrival_notice_covers_the_batch() {
        // 14:03:00 UTC: one new message, two waiting before it.
        let at = (14 * 3600 + 3 * 60) * 1000u64;
        let single = message("inbox-3", INBOX_CLASS_BASH_DONE, at, "done");
        let (preview, text) = arrival_notice(std::slice::from_ref(&single), 3);
        assert_eq!(preview, "Inbox: 1 new message (bash-done)");
        assert_eq!(
            text,
            "[inbox 14:03 UTC] 1 new message (bash-done); total waiting: 3. Read them with msgs = await rlm.inbox.read()."
        );
        let same_class = [
            message("inbox-1", INBOX_CLASS_BASH_DONE, at - 60_000, "a"),
            message("inbox-2", INBOX_CLASS_BASH_DONE, at, "b"),
        ];
        let (preview, text) = arrival_notice(&same_class, 2);
        assert_eq!(preview, "Inbox: 2 new bash-done messages");
        assert_eq!(
            text,
            "[inbox 14:02-14:03 UTC] 2 new bash-done messages; total waiting: 2. Read them with msgs = await rlm.inbox.read()."
        );
        let batch = [
            message("inbox-1", INBOX_CLASS_BASH_DONE, at - 60_000, "a"),
            message("inbox-2", INBOX_CLASS_FACTORY_PROGRESS, at - 30_000, "b"),
            message("inbox-3", INBOX_CLASS_BASH_DONE, at, "c"),
        ];
        let (preview, text) = arrival_notice(&batch, 3);
        assert_eq!(
            preview,
            "Inbox: 3 new messages (2 bash-done, 1 factory-progress)"
        );
        assert_eq!(
            text,
            "[inbox 14:02-14:03 UTC] 3 new messages (2 bash-done, 1 factory-progress); total waiting: 3. Read them with msgs = await rlm.inbox.read()."
        );
    }

    /// The child-status projection: the terminal notice routes as
    /// `child-exited` (the child's session name in the meta, the row's
    /// details as metadata) and the failure row as `child-failed`;
    /// other custom rows stay unrouted.
    #[test]
    fn child_status_notice_fields_route_the_lifecycle_rows() {
        let terminal = serde_json::to_value(pa_types::session::AgentMessage::Custom(
            super::super::rlm_notices::create_rlm_child_terminal_notice(
                &super::super::rlm_notices::RlmChildTerminalNotice::CompletedWithoutReply {
                    child_id: "sub-8fb5284a".to_string(),
                    session_name: "f20-worker".to_string(),
                    last_assistant_text_preview: Some("done with the task".to_string()),
                },
                1_000,
            ),
        ))
        .unwrap();
        let fields = child_status_notice_fields(&terminal).expect("the terminal routes");
        assert_eq!(fields.class, INBOX_CLASS_CHILD_EXITED);
        assert_eq!(fields.meta["sessionName"], "f20-worker");
        assert!(fields
            .text
            .contains("[child-exited: no-reply child:f20-worker]"));
        assert!(fields.text.contains("done with the task"));
        assert_eq!(fields.meta["kind"], "completed_without_reply");
        assert_eq!(fields.meta["childId"], "sub-8fb5284a");
        let cancelled = serde_json::to_value(pa_types::session::AgentMessage::Custom(
            super::super::rlm_notices::create_rlm_child_terminal_notice(
                &super::super::rlm_notices::RlmChildTerminalNotice::Cancelled {
                    child_id: "sub-1".to_string(),
                    session_name: "lane".to_string(),
                    reason: Some("Deleted by parent orchestrator".to_string()),
                },
                2_000,
            ),
        ))
        .unwrap();
        let fields = child_status_notice_fields(&cancelled).expect("the cancel routes");
        assert_eq!(fields.class, INBOX_CLASS_CHILD_EXITED);
        assert_eq!(fields.meta["sessionName"], "lane");
        assert_eq!(fields.meta["kind"], "cancelled");
        let failure = serde_json::to_value(pa_types::session::AgentMessage::Custom(
            super::super::rlm_notices::create_rlm_child_failure_message(
                "sub-9", "lane", "boom", 3_000,
            ),
        ))
        .unwrap();
        let fields = child_status_notice_fields(&failure).expect("the failure routes");
        assert_eq!(fields.class, INBOX_CLASS_CHILD_FAILED);
        assert_eq!(fields.meta["sessionName"], "lane");
        assert!(fields.text.contains("[child-failed child:lane]"));
        assert_eq!(fields.meta["error"], "boom");
        assert!(
            child_status_notice_fields(&json!({"customType": "agent_message"})).is_none(),
            "a non-lifecycle row stays unrouted"
        );
    }

    /// The heartbeat projection: the fired delivery row routes as the
    /// `heartbeat` class with the row's details (the job id among them)
    /// as metadata.
    #[test]
    fn heartbeat_notice_fields_route_the_fired_prompt() {
        let job = pa_core_cron_job();
        let row = super::super::messages::create_heartbeat_prompt_message(&job, 4_000);
        let fields = heartbeat_notice_fields(&row).expect("the fire routes");
        assert_eq!(fields.class, INBOX_CLASS_HEARTBEAT);
        assert!(fields.text.contains("[heartbeat: every 10m run#3]"));
        assert!(fields.text.contains("nudge the mission"));
        assert_eq!(fields.meta["jobId"], "hb-1");
        assert_eq!(fields.meta["runCount"], 3);
    }

    fn pa_core_cron_job() -> crate::cron::AgentCronJob {
        crate::cron::AgentCronJob {
            id: "hb-1".to_string(),
            status: crate::cron::JobStatus::Active,
            source: Some("rlm_heartbeat".to_string()),
            runtime_kind: None,
            delivery_mode: Some(crate::cron::DeliveryMode::Steer),
            active_session_id: "a1".to_string(),
            session_id: "s1".to_string(),
            session_file: String::new(),
            cwd: "/w".to_string(),
            label: None,
            prompt: "nudge the mission".to_string(),
            schedule: crate::cron::AgentCronSchedule {
                kind: crate::cron::ScheduleKind::Interval,
                expression: "every 10m".to_string(),
                interval_ms: Some(600_000),
            },
            created_at: "2026-11-12T18:00:00.000Z".to_string(),
            updated_at: "2026-11-12T18:00:00.000Z".to_string(),
            next_run_at: Some("2026-11-12T18:20:00.000Z".to_string()),
            last_run_at: None,
            last_skipped_at: None,
            last_error: None,
            run_count: 3,
        }
    }

    /// The reminder names the waiting count only (a minimal nudge, no
    /// content and no oldest-wait detail).
    #[test]
    fn reminder_notice_names_the_wait() {
        assert_eq!(
            reminder_notice(3),
            "[inbox reminder] 3 messages still waiting. Read them with msgs = await rlm.inbox.read()."
        );
        assert_eq!(
            reminder_notice(1),
            "[inbox reminder] 1 message still waiting. Read them with msgs = await rlm.inbox.read()."
        );
    }

    /// A targeted read takes exactly the messages the filter matches
    /// (class, sender, key, and arrival window, `ANDed`) and leaves the
    /// rest waiting; the journal replays exactly the taken ids, so a
    /// restart keeps the untouched messages. `sender` matches agent
    /// messages only and `key` the class's own key, so a command and an
    /// agent that share a name never drain each other.
    #[test]
    fn a_targeted_read_takes_only_the_matching_messages() {
        let dir = tempfile::tempdir().unwrap();
        {
            let inbox = SessionInbox::open(Some(dir.path()));
            inbox.push(
                notice(
                    "build",
                    INBOX_CLASS_BASH_DONE,
                    "first",
                    json!({"command": "build"}),
                ),
                1_000,
            );
            inbox.push(
                notice("build", INBOX_CLASS_AGENT_MESSAGE, "second", json!({})),
                2_000,
            );
            inbox.push(
                notice(
                    "test",
                    INBOX_CLASS_BASH_DONE,
                    "third",
                    json!({"command": "test"}),
                ),
                3_000,
            );
            let read = |filter: InboxReadFilter| {
                inbox
                    .read(&filter)
                    .into_iter()
                    .map(|m| m.text)
                    .collect::<Vec<_>>()
            };
            // An empty window and an unknown sender take nothing.
            assert!(read(InboxReadFilter {
                since_ms: Some(10_000),
                ..Default::default()
            })
            .is_empty());
            assert!(read(InboxReadFilter {
                sender: Some("nobody".to_string()),
                ..Default::default()
            })
            .is_empty());
            // The class key takes the one command, never the agent of the
            // same name.
            assert_eq!(
                read(InboxReadFilter {
                    class: Some(INBOX_CLASS_BASH_DONE.to_string()),
                    key: Some("build".to_string()),
                    ..Default::default()
                }),
                ["first"]
            );
            // Class: the other bash-done message leaves, the agent message
            // stays.
            assert_eq!(
                read(InboxReadFilter {
                    class: Some(INBOX_CLASS_BASH_DONE.to_string()),
                    ..Default::default()
                }),
                ["third"]
            );
            assert_eq!(inbox.len(), 1, "the unmatched message stays");
        }
        // The partial reads replay: exactly the taken ids are gone, the
        // untouched agent message survives the restart.
        let reopened = SessionInbox::open(Some(dir.path()));
        let (count, _, classes) = reopened.count();
        assert_eq!(count, 1);
        assert_eq!(classes[INBOX_CLASS_AGENT_MESSAGE], 1);
        // Sender plus arrival window (ANDed) then takes it.
        let taken = reopened.read(&InboxReadFilter {
            sender: Some("build".to_string()),
            since_ms: Some(2_000),
            before_ms: Some(2_001),
            ..Default::default()
        });
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].text, "second");
        assert!(reopened.is_empty());
    }

    /// Removals keep the journal bounded: once the file passes the floor,
    /// a removal compacts it to the live set, so a session that reads
    /// everything it gets never grows its journal past about twice the
    /// floor.
    #[test]
    fn removals_keep_the_journal_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(INBOX_JOURNAL_FILE);
        let inbox = SessionInbox::open(Some(dir.path()));
        let body = "x".repeat(16 * 1024);
        let mut largest = 0;
        for index in 0..400 {
            inbox.push(
                notice("peer", INBOX_CLASS_AGENT_MESSAGE, &body, json!({})),
                index,
            );
            largest = largest.max(std::fs::metadata(&journal).unwrap().len());
            assert_eq!(drain(&inbox).len(), 1);
        }
        assert!(
            largest < 2 * JOURNAL_COMPACT_MIN_BYTES,
            "the journal stayed bounded: {largest} bytes"
        );
        // A compaction reopens the append handle on the rewritten file:
        // the next message persists across a restart.
        inbox.push(
            notice("peer", INBOX_CLASS_AGENT_MESSAGE, "kept", json!({})),
            1_000,
        );
        let reopened = SessionInbox::open(Some(dir.path()));
        assert_eq!(drain(&reopened)[0].text, "kept");
        assert_eq!(
            reopened
                .push(notice("peer", INBOX_CLASS_AGENT_MESSAGE, "", json!({})), 0)
                .id,
            "inbox-402"
        );
    }

    /// A journal the v0.10.6 betas wrote replays: their `read`, `drained`,
    /// and `withdrawn` records still remove what they removed.
    #[test]
    fn a_beta_journal_replays_its_removals() {
        let dir = tempfile::tempdir().unwrap();
        let record = |id: &str| {
            serde_json::to_string(&InboxRecord::Message(message(
                id,
                INBOX_CLASS_BASH_DONE,
                1_000,
                id,
            )))
            .unwrap()
        };
        let lines = [
            record("inbox-1"),
            "{\"kind\":\"drained\"}".to_string(),
            record("inbox-2"),
            record("inbox-3"),
            record("inbox-4"),
            "{\"kind\":\"withdrawn\",\"id\":\"inbox-2\"}".to_string(),
            "{\"kind\":\"read\",\"ids\":[\"inbox-3\"]}".to_string(),
        ];
        std::fs::write(dir.path().join(INBOX_JOURNAL_FILE), lines.join("\n") + "\n").unwrap();
        let inbox = SessionInbox::open(Some(dir.path()));
        assert_eq!(
            drain(&inbox).into_iter().map(|m| m.id).collect::<Vec<_>>(),
            ["inbox-4"]
        );
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
        let store = SessionInbox::with_state(InboxState {
            journal: Some(Journal::new(journal)),
            ..InboxState::default()
        });
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
        let drained = drain(&reopened);
        assert_eq!(drained[0].text, "after the fragment");
    }

    /// The notice row: `content` is the notice text byte-identical (the
    /// persistence clause included), the details carry the inbox-system
    /// sender and the notice class, and the row parses as the engine's
    /// injected-turn shape (`AgentMessage::Custom`), so a delivered turn's
    /// model context is exactly the notice text.
    #[test]
    fn inbox_notice_row_carries_the_text_and_the_sender_identity() {
        let arrival = format!(
            "[inbox 14:03 UTC] 1 new message (bash-done); total waiting: 3. Read them with msgs = await rlm.inbox.read(). {INBOX_PERSISTENCE_ERROR_CLAUSE}"
        );
        let reminder = format!("{} {INBOX_PERSISTENCE_ERROR_CLAUSE}", reminder_notice(3));
        for (class, count, text, covers_cell_done) in [
            (INBOX_NOTICE_CLASS_ARRIVAL, 1, arrival, true),
            (INBOX_NOTICE_CLASS_REMINDER, 3, reminder, false),
        ] {
            let row = create_inbox_notice_row(
                &text,
                class,
                count,
                true,
                covers_cell_done,
                1_730_000_000_000,
            );
            // Whole-object equality: the exact wire shape, no extra keys,
            // every field present at once.
            let expected = json!({
                "role": "custom",
                "customType": INBOX_NOTICE_CUSTOM_TYPE,
                "content": text.clone(),
                "display": true,
                "details": {
                    "sender": INBOX_NOTICE_SENDER,
                    "class": class,
                    "count": count,
                    "wakesCell": true,
                    "coversCellDone": covers_cell_done,
                },
                "timestamp": 1_730_000_000_000u64,
            });
            assert_eq!(row, expected, "the {class} notice row");
            match serde_json::from_value::<pa_types::session::AgentMessage>(expected) {
                Ok(pa_types::session::AgentMessage::Custom(custom)) => {
                    assert_eq!(custom.content.text(), text);
                }
                other => panic!("the notice row must parse as AgentMessage::Custom: {other:?}"),
            }
        }
    }

    /// The host handlers drain on read and summarize on count.
    /// The envelope shape the kernel manager really delivers: the
    /// host-request routing `type` key rides beside the filter fields (the
    /// runtime puts the request type last), so the read handler must treat
    /// it as transport metadata, never an unknown filter field — a bare
    /// enveloped read drains all, a filtered one drains only its class.
    #[tokio::test]
    async fn the_read_handler_treats_the_envelope_routing_key_as_transport() {
        let inbox = Arc::new(SessionInbox::in_memory());
        let mut handlers = HostRequestHandlers::default();
        register_inbox_host_handlers(&inbox, &mut handlers);
        inbox.push(
            notice(
                "peer",
                INBOX_CLASS_AGENT_MESSAGE,
                "the agent mail",
                json!({}),
            ),
            1_000,
        );
        inbox.push(
            notice(
                "child",
                INBOX_CLASS_FACTORY_PROGRESS,
                "the child notice",
                json!({}),
            ),
            2_000,
        );
        let read = handlers
            .get(INBOX_READ_REQUEST_TYPE)
            .expect("read registered")
            .clone();
        let enveloped = |class: Option<&str>| {
            let read = read.clone();
            let class = class.map(str::to_string);
            async move {
                let mut data = json!({ "type": INBOX_READ_REQUEST_TYPE });
                if let Some(class) = class {
                    data["class"] = json!(class);
                }
                read(HostRequestPayload { data }).await
            }
        };
        let filtered = enveloped(Some(INBOX_CLASS_FACTORY_PROGRESS))
            .await
            .expect("the routing key is not an unknown filter field");
        assert_eq!(filtered["messages"].as_array().unwrap().len(), 1);
        assert_eq!(
            inbox
                .waiting_messages()
                .into_iter()
                .map(|message| message.text)
                .collect::<Vec<_>>(),
            ["the agent mail"]
        );
        let bare = enveloped(None).await.expect("a bare read drains the rest");
        assert_eq!(bare["messages"].as_array().unwrap().len(), 1);
        assert!(inbox.waiting_messages().is_empty());
    }

    /// A filter with an unknown field is a REQUEST ERROR that drains
    /// nothing: silently reading it as an empty filter would drain the
    /// whole inbox on a typo. Known fields, a mixed known+unknown filter,
    /// an empty object, and a null payload keep their documented behavior.
    #[tokio::test]
    async fn unknown_read_filter_fields_do_not_drain_the_inbox() {
        let inbox = Arc::new(SessionInbox::in_memory());
        let mut handlers = HostRequestHandlers::default();
        register_inbox_host_handlers(&inbox, &mut handlers);
        let pushed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let pushed = Arc::clone(&pushed);
            inbox.set_read_hook(Arc::new(move |_inbox| {
                pushed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        }
        inbox.push(
            notice(
                "peer",
                INBOX_CLASS_AGENT_MESSAGE,
                "keep this message",
                json!({}),
            ),
            1_000,
        );
        inbox.push(
            notice(
                "child",
                INBOX_CLASS_FACTORY_PROGRESS,
                "keep this child notice",
                json!({}),
            ),
            2_000,
        );
        let read = handlers
            .get(INBOX_READ_REQUEST_TYPE)
            .expect("read registered")
            .clone();
        let read_with = |data| {
            let read = read.clone();
            async move { read(HostRequestPayload { data }).await }
        };
        let waiting_texts = || {
            inbox
                .waiting_messages()
                .into_iter()
                .map(|message| message.text)
                .collect::<Vec<_>>()
        };

        let unknown_only = read_with(json!({ "inbox_clas": INBOX_CLASS_AGENT_MESSAGE })).await;
        assert!(
            unknown_only.is_err(),
            "an unknown-only filter must be rejected"
        );
        assert_eq!(
            waiting_texts(),
            ["keep this message", "keep this child notice"],
            "the malformed request must leave every message unread"
        );
        assert_eq!(
            pushed.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "validation precedes the read hook"
        );

        let mixed_unknown = read_with(json!({
            "class": INBOX_CLASS_AGENT_MESSAGE,
            "inbox_clas": INBOX_CLASS_AGENT_MESSAGE,
        }))
        .await;
        assert!(
            mixed_unknown.is_err(),
            "known fields do not excuse an unknown field"
        );
        assert_eq!(
            waiting_texts(),
            ["keep this message", "keep this child notice"],
            "the mixed malformed request must leave every message unread"
        );
        assert_eq!(
            pushed.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "validation precedes the read hook"
        );

        let known = read_with(json!({ "class": INBOX_CLASS_AGENT_MESSAGE }))
            .await
            .expect("a known-only filter reads");
        assert_eq!(known["messages"].as_array().unwrap().len(), 1);
        assert_eq!(waiting_texts(), ["keep this child notice"]);
        let empty_object = read_with(json!({})).await.expect("an empty filter reads");
        assert_eq!(empty_object["messages"].as_array().unwrap().len(), 1);
        assert_eq!(
            pushed.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a validated read drains"
        );
    }

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
        assert_eq!(reply["messages"].as_array().unwrap().len(), 2);
        let messages = reply["messages"].as_array().unwrap();
        assert_eq!(messages[0]["id"], "inbox-1");
        assert_eq!(messages[0]["class"], "bash-done");
        assert_eq!(messages[0]["arrivedAtMs"], 1_000);
        assert_eq!(messages[0]["text"], "the command finished");
        assert_eq!(messages[0]["meta"], json!({"pid": 1}));
        assert_eq!(messages[1]["key"], "r1");
        // The read drained.
        let reply = count(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(
            reply,
            json!({ "count": 0, "oldestArrivedAtMs": null, "classes": {} })
        );
        let reply = read(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(reply, json!({ "messages": [] }));
    }

    /// The read host handler narrows on a filter payload and rejects a
    /// malformed one (a silent default would drain everything).
    #[tokio::test]
    async fn the_read_handler_honors_a_filter_payload() {
        let inbox = Arc::new(SessionInbox::in_memory());
        let mut handlers = HostRequestHandlers::default();
        // The drain hook fires once per read (the daemon's wake-row
        // refresh seam).
        let hook_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook_counter = Arc::clone(&hook_calls);
        inbox.set_read_hook(Arc::new(move |_inbox| {
            hook_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
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
        assert_eq!(reply["messages"].as_array().unwrap().len(), 1);
        assert_eq!(reply["messages"][0]["text"], "b");
        // The unmatched message stays for the next read.
        let reply = read(HostRequestPayload { data: json!({}) }).await.unwrap();
        assert_eq!(reply["messages"].as_array().unwrap().len(), 1);
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
        // A key without its class would match across classes: refused.
        let error = read(HostRequestPayload {
            data: json!({ "key": "sleep 3" }),
        })
        .await;
        assert!(error.is_err(), "a key needs its class");
        assert_eq!(inbox.len(), 1, "the refused reads drained nothing");
        assert_eq!(
            hook_calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "every successful read ran the drain hook; the refused one did not"
        );
    }
}

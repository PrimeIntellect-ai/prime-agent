//! The durable terminal-notice concern (moved with its concern): the
//! strict keyed append of a child-run terminal notice row, the
//! consumption marker, and the file-backed unconsumed scan. The parent
//! session's JSONL is the only durable store for RLM child terminal
//! notices (the in-process child host's delivery contract); this module
//! supplies the strict arm the host's inbox needs - one durable row per
//! notice key, fsync on every path, and a consumption marker that only
//! lands after the assistant response it certifies is itself durable.
//!
//! Wire vocabulary (the engine mints the key before appending; the row
//! factories live in `session_engine::rlm_notices`):
//! - `notice.details["noticeKey"]`: the stable notice identity,
//!   `"<parent session id>:<child id>"` - idempotence, the scan, and the
//!   marker all key on it.
//! - `custom` row of type `notice_consumed`: the internal marker, no
//!   model-visible text, carrying the consumed keys in
//!   `data.noticeKeys`.
//!
//! Scans read the session FILE, never the in-memory index, and only
//! fully valid rows participate: a retained-only row (a write that
//! failed while the live index kept the entry) is not file-backed and
//! must not be replayed or counted consumed; an unterminated trailing
//! line is torn damage and is ignored until open-time repair drops it.

use std::collections::HashSet;
use std::io::{self, ErrorKind};
use std::path::PathBuf;
use std::sync::Arc;

use pa_types::session::{CustomEntry, CustomMessage, CustomMessageEntry, FileEntry};

use super::{serialize_entry, SessionManager};
use crate::platform::sync_dir;

// The file-scan concern (the notice state parsed from the session
// file) lives in the child module at the same tree position
// (session::manager::notices::scan).
mod scan;
use scan::{
    keyed_message_id, last_assistant_entry_id, notice_key_of, scan_notice_content, FileNoticeScan,
};

// The durable-tail concern (file/truncation sync, pre-append tail
// hygiene, and the post-failure reconcile) lives in the child module
// at the same tree position (session::manager::notices::tail).
mod tail;
use tail::{ensure_clean_tail, poisoned_error, reconcile_tail, sync_file, ReconciledTail};

// The test-build fault hooks for the strict append; pub(crate) so
// manager.rs can lift them for the engine's in-process host tests.
#[cfg(test)]
pub(crate) mod fault_hooks;
#[cfg(test)]
use fault_hooks::Fault;

/// The `details` field carrying a terminal notice's stable key.
pub const NOTICE_KEY_FIELD: &str = "noticeKey";
/// The consumption-marker row's `customType`.
pub const NOTICE_CONSUMED_CUSTOM_TYPE: &str = "notice_consumed";
/// The consumption-marker row's `data` field holding the consumed keys.
pub const NOTICE_CONSUMED_KEYS_FIELD: &str = "noticeKeys";
/// The custom types that carry a terminal notice (TS
/// `createRlmChildTerminalNoticeMessage` / `createRlmChildFailureMessage`;
/// the canonical factories and constants live in
/// `session_engine::rlm_notices` - the durable store recognizes the same
/// wire vocabulary, so the two spellings must move together).
pub const TERMINAL_NOTICE_CUSTOM_TYPES: [&str; 2] =
    ["rlm_child_terminal_notice", "rlm_child_failure"];
/// The custom type of an agent-message reply row (the wire is TS
/// `agent_message`; the canonical factories live in
/// `session_engine::agent_messaging` - coordinated like
/// `TERMINAL_NOTICE_CUSTOM_TYPES`).
pub const AGENT_MESSAGE_CUSTOM_TYPE: &str = "agent_message";
/// The `details` field carrying an agent-message reply's stable id.
pub const AGENT_MESSAGE_KEY_FIELD: &str = "id";

/// One repair plus one retry of the same line - a second failure
/// surfaces instead of looping.
const APPEND_ATTEMPTS: u32 = 2;

impl SessionManager {
    /// The strict persisted-session precondition shared by every notice
    /// write: terminal notices are a durable-store obligation, so a
    /// non-persisted manager refuses instead of silently keeping a
    /// volatile row.
    ///
    /// # Errors
    ///
    /// Returns [`ErrorKind::Unsupported`] when the manager does not
    /// persist a session file.
    fn require_session_file(&self) -> io::Result<PathBuf> {
        if !self.persist {
            return Err(io::Error::new(
                ErrorKind::Unsupported,
                "terminal notices require a persisted session",
            ));
        }
        self.session_file.clone().ok_or_else(|| {
            io::Error::new(
                ErrorKind::Unsupported,
                "terminal notices require a session file",
            )
        })
    }

    /// Parse the notice state from the durable file; a session file not
    /// created yet is an empty scan, not an error (a fresh session
    /// appends its first notice through the rewrite arm).
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the session file cannot be
    /// read.
    fn scan_notice_file(&self) -> io::Result<FileNoticeScan> {
        let Some(path) = &self.session_file else {
            return Ok(FileNoticeScan::default());
        };
        match std::fs::read_to_string(path) {
            Ok(content) => Ok(scan_notice_content(&content)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(FileNoticeScan::default()),
            Err(error) => Err(error),
        }
    }

    /// Fold a durably appended entry into the live index (the window
    /// mirror and the id/leaf maps - the same bookkeeping
    /// `append_entry` performs on success).
    fn index_appended_entry(&mut self, index: usize) {
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
    }

    /// The strict durable append both notice rows and consumption
    /// markers go through. Exactly one row per append: a deferred,
    /// missing, or poisoned writer forces the full rewrite (header +
    /// every buffered row + this row; atomic temp + `sync_all` +
    /// rename + directory fsync, which also heals a poisoned tail);
    /// a clean flushed file appends one complete synced line, with
    /// torn-tail reconciliation (truncate + retry the same line, or
    /// re-sync a fully landed line, or surface and poison the writer).
    /// The entry is indexed only once its bytes are durable.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when any stage of the durable
    /// append fails; the entry is not kept in the in-memory index. The
    /// one exception: a failed directory fsync after a landed rewrite
    /// keeps the row, which IS on disk, and lets the idempotent
    /// retry re-sync it.
    fn strict_append_entry(&mut self, entry: FileEntry) -> io::Result<String> {
        let path = self.require_session_file()?;
        let id = entry.id().unwrap_or_default().to_string();
        if self.window.is_some() && !self.flushed {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "windowed store holds deferred rows: hydrate before a strict notice append",
            ));
        }
        if self.window.is_none() && (!self.flushed || !path.exists() || self.write_poison.is_some())
        {
            // Wholesale rewrite arm. The atomic replace never leaves a
            // torn tail, so it is also the poison's heal path.
            self.file_entries.push(entry);
            let index = self.file_entries.len() - 1;
            if let Err(error) = self.try_rewrite_file() {
                // Nothing landed: the previous file is intact.
                self.file_entries.pop();
                return Err(error);
            }
            // The content is durable (temp + sync_all + rename): index
            // the landed row BEFORE confirming the rename's directory
            // entry, so a directory-fsync failure keeps the live
            // branch pointing at the row that is on disk. The pending
            // error surfaces, and the idempotent retry re-syncs the
            // existing row instead of rewriting it.
            self.index_appended_entry(index);
            #[cfg(test)]
            if fault_hooks::take(&path, Fault::DirFsyncFail) {
                return Err(fault_hooks::injected_error());
            }
            path.parent().map_or(Ok(()), sync_dir)?;
            self.flushed = true;
            return Ok(id);
        }
        if let Some(error) = &self.write_poison {
            // A windowed store cannot heal through a rewrite.
            return Err(poisoned_error(error));
        }
        let mut line = serialize_entry(&entry).into_bytes();
        line.push(b'\n');
        let prior_len = ensure_clean_tail(&path)?;
        self.file_entries.push(entry);
        let mut attempts = 0;
        let append = loop {
            attempts += 1;
            let attempt = {
                #[cfg(test)]
                {
                    match fault_hooks::append_with_fault(&path, &line) {
                        Some(outcome) => outcome,
                        None => super::window::append_cached(&path, &line, self.append_ownership),
                    }
                }
                #[cfg(not(test))]
                {
                    super::window::append_cached(&path, &line, self.append_ownership)
                }
            };
            match attempt {
                Ok(()) => break Ok(()),
                Err(error) => match reconcile_tail(&path, prior_len, &line) {
                    Ok(ReconciledTail::Complete) => {
                        tracing::debug!(
                            %error,
                            "append error after the line landed; re-synced it"
                        );
                        break Ok(());
                    }
                    Ok(ReconciledTail::Truncated) if attempts < APPEND_ATTEMPTS => {}
                    Ok(ReconciledTail::Truncated) => break Err(error),
                    Err(repair_error) => {
                        self.write_poison = Some(Arc::new(repair_error));
                        break Err(error);
                    }
                },
            }
        };
        if let Err(error) = append {
            self.file_entries.pop();
            return Err(error);
        }
        self.notify_persist_listeners();
        let index = self.file_entries.len() - 1;
        self.index_appended_entry(index);
        // The containing directory's entry must be durable before
        // success: an existing file does not prove it - the ordinary
        // first assistant/session_info rewrite creates the file without
        // a directory fsync. A pending directory sync keeps the landed
        // row indexed - it is on disk - and the idempotent retry
        // re-syncs the existing row instead of appending a second one.
        #[cfg(test)]
        if fault_hooks::take(&path, Fault::AppendDirSyncFail) {
            return Err(fault_hooks::injected_error());
        }
        path.parent().map_or(Ok(()), sync_dir)?;
        Ok(id)
    }

    /// Fail every strict notice write on this manager before it
    /// touches the file (test builds only): [`Self::append_terminal_notice`],
    /// [`Self::append_notice_consumed`], and [`Self::append_agent_message`]
    /// return the synthetic fault without writing a byte, ordinary
    /// append paths are unaffected, and after clearing the same key
    /// still appends exactly once (the idempotence scan finds nothing,
    /// so the retry commits one row).
    #[cfg(test)]
    pub fn set_notice_append_fault(&mut self, fail: bool) {
        self.notice_append_fault = fail;
    }

    /// Append one terminal-notice custom row, idempotent by its stable
    /// notice key: the parent session's JSONL holds exactly one durable
    /// row per key even across retries and reopens. The row is forced
    /// to disk on every path (a fresh session's header and buffered
    /// first-turn rows ride the same rewrite), the write is fsynced,
    /// and the JSONL entry id - the stable row id - is returned. The
    /// engine mints `details.noticeKey`
    /// (`"<parent session id>:<child id>"`) before calling.
    ///
    /// # Errors
    ///
    /// Returns [`ErrorKind::InvalidInput`] when the notice is not a
    /// terminal-notice custom type or carries no non-empty
    /// `noticeKey`; [`ErrorKind::Unsupported`] on a non-persisted
    /// manager; and the underlying I/O error when the durable append
    /// fails (a poisoned writer fails fast until a rewrite heals it).
    pub fn append_terminal_notice(&mut self, notice: &CustomMessage) -> io::Result<String> {
        #[cfg(test)]
        if self.notice_append_fault {
            return Err(io::Error::other("notice append fault (test)"));
        }
        if !TERMINAL_NOTICE_CUSTOM_TYPES.contains(&notice.custom_type.as_str()) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "terminal notice requires a terminal custom type",
            ));
        }
        let key = notice_key_of(notice.details.as_ref())
            .ok_or_else(|| {
                io::Error::new(
                    ErrorKind::InvalidInput,
                    "terminal notice requires a non-empty details.noticeKey",
                )
            })?
            .to_string();
        let scan = self.scan_notice_file()?;
        if let Some(row) = scan.notice_rows.iter().find(|row| row.key == key) {
            // Already durable on disk: confirm the landed bytes and hand
            // back the existing row id - never a second row.
            let path = self.require_session_file()?;
            sync_file(&path)?;
            path.parent().map_or(Ok(()), sync_dir)?;
            return Ok(row.entry_id.clone());
        }
        let base = self.next_base();
        let entry = FileEntry::CustomMessage {
            payload: CustomMessageEntry {
                custom_type: notice.custom_type.clone(),
                content: notice.content.clone(),
                details: notice.details.clone(),
                display: notice.display,
                rest: notice.rest.clone(),
            },
            base,
        };
        self.strict_append_entry(entry)
    }

    /// Append one durable agent-message reply row, idempotent by its
    /// stable `details.id`: the parent session's JSONL holds exactly
    /// one durable row per reply id even across retries and reopens, so
    /// a `DoneReplied` publication can require this primitive's
    /// success without duplicating the row the live turn's `MessageEnd`
    /// would persist (the subscriber recognizes the pre-synced
    /// `details.id` and skips the duplicate; ordinary custom behavior
    /// is preserved). The row rides the same strict arm as terminal
    /// notices - fresh rewrite carrying header + buffered rows,
    /// complete line + file fsync, containing-directory fsync,
    /// torn-tail reconcile - and the JSONL entry id, the stable row id,
    /// is returned.
    ///
    /// # Errors
    ///
    /// Returns [`ErrorKind::InvalidInput`] when the row is not the
    /// `agent_message` custom type or carries no non-empty
    /// `details.id`; [`ErrorKind::Unsupported`] on a non-persisted
    /// manager; and the underlying I/O error when the durable append
    /// fails (a poisoned writer fails fast until a rewrite heals it).
    pub fn append_agent_message(&mut self, message: &CustomMessage) -> io::Result<String> {
        #[cfg(test)]
        if self.notice_append_fault {
            return Err(io::Error::other("notice append fault (test)"));
        }
        if message.custom_type != AGENT_MESSAGE_CUSTOM_TYPE {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "agent message requires the agent_message custom type",
            ));
        }
        let key = keyed_message_id(message.details.as_ref(), AGENT_MESSAGE_KEY_FIELD)
            .ok_or_else(|| {
                io::Error::new(
                    ErrorKind::InvalidInput,
                    "agent message requires a non-empty details.id",
                )
            })?
            .to_string();
        let scan = self.scan_notice_file()?;
        if let Some(entry_id) = scan.agent_message_ids.get(&key) {
            // Already durable on disk: confirm the landed bytes and hand
            // back the existing row id - never a second row.
            let path = self.require_session_file()?;
            sync_file(&path)?;
            path.parent().map_or(Ok(()), sync_dir)?;
            return Ok(entry_id.clone());
        }
        let base = self.next_base();
        let entry = FileEntry::CustomMessage {
            payload: CustomMessageEntry {
                custom_type: message.custom_type.clone(),
                content: message.content.clone(),
                details: message.details.clone(),
                display: message.display,
                rest: message.rest.clone(),
            },
            base,
        };
        self.strict_append_entry(entry)
    }

    /// The file-backed terminal notices no consumption marker covers,
    /// in file order: `(notice_key, notice)`, the notice reconstructed
    /// from the original JSONL row (the same conversion the context
    /// rebuild uses). Only fully valid file-backed rows participate - a
    /// retained-only row, a non-terminal custom type, or a torn
    /// unterminated line is not replayable.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the session file cannot be
    /// read - bind/recovery must NOT proceed as if nothing needed
    /// replay; only a session with no file yet yields an empty scan.
    pub fn unconsumed_terminal_notices(&self) -> io::Result<Vec<(String, CustomMessage)>> {
        let Some(path) = &self.session_file else {
            return Ok(Vec::new());
        };
        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let scan = scan_notice_content(&content);
        Ok(scan
            .notice_rows
            .iter()
            .filter(|row| !scan.consumed_keys.contains(&row.key))
            .map(|row| (row.key.clone(), row.message.clone()))
            .collect())
    }

    /// Record that the given notice keys were carried into a parent
    /// model turn that produced a successful assistant response. The
    /// marker is the LAST durable write of that contract, so this
    /// method first strictly syncs the already-appended assistant row
    /// itself - rewriting (and directory-fsyncing) the whole session
    /// when the durable file does not end at that assistant row,
    /// including the buffered first-turn rows - and only then appends
    /// and syncs one marker row. The caller calls this after
    /// `append_message_retained` reported no write error; on any
    /// failure here the keys stay unconsumed and recovery replays the
    /// notices (at-least-once model delivery, exactly one durable
    /// notice).
    ///
    /// # Errors
    ///
    /// Returns [`ErrorKind::InvalidInput`] when the session holds no
    /// assistant entry (the marker certifies an assistant response);
    /// [`ErrorKind::Unsupported`] on a non-persisted manager; and the
    /// underlying I/O error when the assistant sync or the marker
    /// append fails.
    pub fn append_notice_consumed(&mut self, notice_keys: &[String]) -> io::Result<()> {
        #[cfg(test)]
        if self.notice_append_fault {
            return Err(io::Error::other("notice append fault (test)"));
        }
        let path = self.require_session_file()?;
        let last_assistant = last_assistant_entry_id(&self.file_entries).ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidInput,
                "notice consumption requires an assistant entry",
            )
        })?;
        // Strictly fsync the already-appended assistant row first: when
        // the durable file does not end at that assistant row (it was
        // retained-only, or the file vanished), one wholesale rewrite
        // lands it - and the buffered first-turn rows - atomically.
        let scan = self.scan_notice_file()?;
        let assistant_needs_rewrite = scan
            .last_assistant_id
            .as_deref()
            .is_none_or(|id| id != last_assistant.as_str());
        if assistant_needs_rewrite {
            if self.window.is_some() {
                return Err(io::Error::new(
                    ErrorKind::InvalidInput,
                    "windowed store cannot rewrite a retained assistant row: hydrate first",
                ));
            }
            self.try_rewrite_file()?;
            #[cfg(test)]
            if fault_hooks::take(&path, Fault::DirFsyncFail) {
                return Err(fault_hooks::injected_error());
            }
            path.parent().map_or(Ok(()), sync_dir)?;
            self.flushed = true;
        } else {
            sync_file(&path)?;
            if let Some(dir) = path.parent() {
                sync_dir(dir)?;
            }
        }
        // Idempotence: only keys without a durable marker land, each
        // once per call.
        let mut fresh: Vec<String> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for key in notice_keys {
            if key.is_empty() || scan.consumed_keys.contains(key) || !seen.insert(key) {
                continue;
            }
            fresh.push(key.clone());
        }
        if fresh.is_empty() {
            return Ok(());
        }
        let entry = FileEntry::Custom {
            payload: CustomEntry {
                custom_type: NOTICE_CONSUMED_CUSTOM_TYPE.to_string(),
                data: Some(serde_json::json!({ NOTICE_CONSUMED_KEYS_FIELD: fresh })),
                rest: serde_json::Map::default(),
            },
            base: self.next_base(),
        };
        self.strict_append_entry(entry).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use pa_types::session::{AgentMessage, EntryBase};

    use super::*;
    use crate::session::parse_session_entries;

    fn persisted_manager() -> (tempfile::TempDir, PathBuf, SessionManager) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        let cwd = tmp.path().to_path_buf();
        (tmp, dir.clone(), SessionManager::persisted(&cwd, &dir))
    }

    fn notice(key: &str) -> CustomMessage {
        CustomMessage {
            custom_type: "rlm_child_terminal_notice".to_string(),
            content: pa_types::ai::UserContent::Text(
                "[child-exited: no-reply child:worker]".to_string(),
            ),
            display: true,
            details: Some(serde_json::json!({
                "noticeKey": key,
                "kind": "completed_without_reply",
                "childId": "sub-8fb5284a",
                "sessionName": "worker",
            })),
            timestamp: 1_000,
            rest: serde_json::Map::default(),
        }
    }

    fn expected_notice_payload(key: &str) -> CustomMessageEntry {
        CustomMessageEntry {
            custom_type: "rlm_child_terminal_notice".to_string(),
            content: pa_types::ai::UserContent::Text(
                "[child-exited: no-reply child:worker]".to_string(),
            ),
            details: Some(serde_json::json!({
                "noticeKey": key,
                "kind": "completed_without_reply",
                "childId": "sub-8fb5284a",
                "sessionName": "worker",
            })),
            display: true,
            rest: serde_json::Map::default(),
        }
    }

    fn assistant_message() -> AgentMessage {
        AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![],
            api: "openai-completions".to_string(),
            provider: "openai".to_string(),
            model: "gpt-x".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 42,
            rest: serde_json::Map::default(),
        })
    }

    fn entry_base(id: &str) -> EntryBase {
        EntryBase {
            id: Some(id.to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        }
    }

    fn read_file(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn line_count(content: &str) -> usize {
        content.trim_end_matches('\n').split('\n').count()
    }

    #[test]
    fn fresh_session_notice_forces_the_buffered_rows_to_disk() {
        let (tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        // Pre-model rows buffer without an assistant; the session file
        // does not exist yet.
        assert!(!file.exists());
        manager.append_thinking_level_change("high").unwrap();
        assert!(!file.exists());
        let id = manager
            .append_terminal_notice(&notice("sess-1:sub-8fb5284a"))
            .unwrap();
        assert!(file.exists());
        let content = read_file(&file);
        assert!(content.ends_with('\n'));
        // The rewrite carried the header and the buffered row along.
        let entries = parse_session_entries(&content);
        assert_eq!(entries.len(), 3);
        assert!(matches!(entries[0], FileEntry::Header { .. }));
        assert!(matches!(entries[1], FileEntry::ThinkingLevelChange { .. }));
        let FileEntry::CustomMessage { payload, base } = &entries[2] else {
            panic!("the notice row must be a custom_message entry");
        };
        assert_eq!(base.id.as_deref(), Some(id.as_str()));
        // The typed payload round-trips whole; the flatten sinks leave
        // the base's id/parentId/timestamp duplicated into `rest`, so
        // the identity assert rides the named fields.
        let expected = expected_notice_payload("sess-1:sub-8fb5284a");
        assert_eq!(payload.custom_type, expected.custom_type);
        assert_eq!(payload.content, expected.content);
        assert_eq!(payload.details, expected.details);
        assert_eq!(payload.display, expected.display);
        // A reopen parses the same durable row and hands back its id.
        let mut reopened =
            SessionManager::open(tmp.path(), manager.get_session_file().unwrap(), &file);
        let reopened_id = reopened
            .append_terminal_notice(&notice("sess-1:sub-8fb5284a"))
            .unwrap();
        assert_eq!(reopened_id, id);
        let _ = tmp;
    }

    #[test]
    fn notice_append_is_idempotent_per_key() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        let first = manager.append_terminal_notice(&notice("k:a")).unwrap();
        let second = manager.append_terminal_notice(&notice("k:a")).unwrap();
        assert_eq!(first, second);
        let content = read_file(&file);
        assert_eq!(line_count(&content), 2); // header + one notice row
        let other = manager.append_terminal_notice(&notice("k:b")).unwrap();
        assert_ne!(other, first);
        let content = read_file(&file);
        assert_eq!(line_count(&content), 3);
        let entries = parse_session_entries(&content);
        let keys: Vec<String> = entries
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::CustomMessage { payload, .. } => {
                    notice_key_of(payload.details.as_ref()).map(str::to_string)
                }
                _ => None,
            })
            .collect();
        assert_eq!(keys, ["k:a", "k:b"]);
    }

    #[test]
    fn flushed_session_appends_one_synced_line() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        manager.append_message(assistant_message()).unwrap();
        let file = manager.get_session_file().unwrap().to_path_buf();
        let before = read_file(&file);
        let id = manager.append_terminal_notice(&notice("k:a")).unwrap();
        let after = read_file(&file);
        // The durable prefix is untouched; exactly one line landed.
        assert!(after.starts_with(&before));
        assert_eq!(line_count(&after), line_count(&before) + 1);
        let entries = parse_session_entries(&after);
        let FileEntry::CustomMessage { payload, base } = entries.last().unwrap() else {
            panic!("the last row must be the notice");
        };
        assert_eq!(base.id.as_deref(), Some(id.as_str()));
        assert_eq!(payload.custom_type, "rlm_child_terminal_notice");
    }

    #[test]
    fn notice_rows_outside_the_contract_are_rejected() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let mut without_key = notice("k:a");
        without_key.details = None;
        let error = manager.append_terminal_notice(&without_key).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        let mut empty_key = notice("");
        empty_key.details = Some(serde_json::json!({
            "noticeKey": "",
            "childId": "sub-8fb5284a",
        }));
        let error = manager.append_terminal_notice(&empty_key).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        let mut not_terminal = notice("k:a");
        not_terminal.custom_type = "compaction_notice".to_string();
        let error = manager.append_terminal_notice(&not_terminal).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        // Nothing was appended.
        let file = manager.get_session_file().unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn scan_reads_only_terminated_file_backed_terminal_rows() {
        let (tmp, dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_terminal_notice(&notice("k:a")).unwrap();
        // A non-terminal custom message carrying a noticeKey is not a
        // notice either (it stays deferred pre-assistant, but the scan
        // filters on type regardless).
        manager
            .append_custom_message(
                "unrelated_type",
                pa_types::ai::UserContent::Text("hi".to_string()),
                true,
                Some(serde_json::json!({ "noticeKey": "k:other" })),
            )
            .unwrap();
        let keys: Vec<String> = manager
            .unconsumed_terminal_notices()
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(keys, ["k:a"]);
        // Consume it after a successful assistant turn.
        manager.append_message(assistant_message()).unwrap();
        manager
            .append_notice_consumed(&["k:a".to_string()])
            .unwrap();
        assert!(manager.unconsumed_terminal_notices().unwrap().is_empty());
        // The marker is idempotent: a repeat lands nothing.
        let lines = line_count(&read_file(&file));
        manager
            .append_notice_consumed(&["k:a".to_string()])
            .unwrap();
        assert_eq!(line_count(&read_file(&file)), lines);
        // A retained-only notice row (a write that failed while the
        // live index kept the entry) is not file-backed: with the
        // session fully flushed, it never reached the file and must
        // not replay.
        manager.file_entries.push(FileEntry::CustomMessage {
            payload: expected_notice_payload("k:retained"),
            base: entry_base("retained1"),
        });
        assert!(manager.unconsumed_terminal_notices().unwrap().is_empty());
        // Consumption survives a reopen.
        let reopened = SessionManager::open(tmp.path(), &dir, &file);
        assert!(reopened.unconsumed_terminal_notices().unwrap().is_empty());
    }

    #[test]
    fn torn_unterminated_line_is_not_a_row_and_heals_on_append() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_terminal_notice(&notice("k:a")).unwrap();
        // Simulate a torn tail: an unterminated partial row.
        let mut torn = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        torn.write_all(br#"{"type":"custom_message","id":"torn""#)
            .unwrap();
        // The torn line does not count as a notice row.
        let keys: Vec<String> = manager
            .unconsumed_terminal_notices()
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(keys, ["k:a"]);
        // The next strict append truncates the partial predecessor and
        // lands cleanly after it.
        manager.append_terminal_notice(&notice("k:b")).unwrap();
        let content = read_file(&file);
        assert!(content.ends_with('\n'));
        let keys: Vec<String> = parse_session_entries(&content)
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::CustomMessage { payload, .. } => {
                    notice_key_of(payload.details.as_ref()).map(str::to_string)
                }
                _ => None,
            })
            .collect();
        assert_eq!(keys, ["k:a", "k:b"]);
    }

    #[test]
    fn marker_requires_an_assistant_entry() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        manager.append_terminal_notice(&notice("k:a")).unwrap();
        let error = manager
            .append_notice_consumed(&["k:a".to_string()])
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        // The notice stays unconsumed.
        assert_eq!(manager.unconsumed_terminal_notices().unwrap().len(), 1);
    }

    #[test]
    fn marker_rewrites_a_retained_only_assistant_row_first() {
        let (tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_terminal_notice(&notice("k:a")).unwrap();
        // Simulate the engine's retained-only assistant: in the live
        // index, NOT on disk (its durable write never landed).
        manager.file_entries.push(FileEntry::Message {
            message: assistant_message(),
            base: entry_base("asst-1"),
        });
        let before = read_file(&file);
        assert!(!before.contains("asst-1"));
        manager
            .append_notice_consumed(&["k:a".to_string()])
            .unwrap();
        // The wholesale rewrite landed the assistant row BEFORE the
        // marker, then the marker row.
        let entries = parse_session_entries(&read_file(&file));
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[2].id(), Some("asst-1"));
        assert!(matches!(
            entries[2],
            FileEntry::Message {
                message: AgentMessage::Assistant(_),
                ..
            }
        ));
        let FileEntry::Custom { payload, .. } = &entries[3] else {
            panic!("the marker row must be a custom entry");
        };
        assert_eq!(payload.custom_type, "notice_consumed");
        assert_eq!(
            payload.data,
            Some(serde_json::json!({ "noticeKeys": ["k:a"] }))
        );
        assert!(manager.unconsumed_terminal_notices().unwrap().is_empty());
        // And consumption survives the reopen.
        let reopened = SessionManager::open(tmp.path(), file.parent().unwrap(), &file);
        assert!(reopened.unconsumed_terminal_notices().unwrap().is_empty());
    }

    #[test]
    fn reconcile_tail_handles_complete_truncated_and_garbage() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("session.jsonl");
        let prior = b"{\"type\":\"session\"}\n".to_vec();
        let mut line = br#"{"type":"custom","id":"n1","customType":"notice_consumed","data":{"noticeKeys":["k"]}}"#.to_vec();
        line.push(b'\n');
        let write = |bytes: &[u8]| {
            let mut buffer = prior.clone();
            buffer.extend_from_slice(bytes);
            std::fs::write(&file, &buffer).unwrap();
        };
        // The complete line landed despite the error: re-synced, kept.
        write(&line);
        assert!(matches!(
            reconcile_tail(&file, prior.len() as u64, &line).unwrap(),
            ReconciledTail::Complete
        ));
        assert_eq!(
            std::fs::read(&file).unwrap().len(),
            prior.len() + line.len()
        );
        // A partial prefix: truncated back to the prior offset.
        write(&line[..line.len() / 2]);
        assert!(matches!(
            reconcile_tail(&file, prior.len() as u64, &line).unwrap(),
            ReconciledTail::Truncated
        ));
        assert_eq!(std::fs::read(&file).unwrap(), prior);
        // Nothing landed: clean retry.
        write(&[]);
        assert!(matches!(
            reconcile_tail(&file, prior.len() as u64, &line).unwrap(),
            ReconciledTail::Truncated
        ));
        // Garbage and a shrunken tail surface for the poison path.
        write(b"garbage");
        assert_eq!(
            reconcile_tail(&file, prior.len() as u64, &line)
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidData
        );
        std::fs::write(&file, &prior[..prior.len() - 2]).unwrap();
        assert_eq!(
            reconcile_tail(&file, prior.len() as u64, &line)
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidData
        );
    }

    #[test]
    fn poisoned_writer_fails_fast_until_a_rewrite_heals() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        manager.append_message(assistant_message()).unwrap();
        // A failed tail repair poisons the writer.
        manager.write_poison = Some(Arc::new(io::Error::other("tail repair failed")));
        let error = manager.append_custom_entry("test", None).unwrap_err();
        assert_eq!(error.to_string(), "tail repair failed");
        // The strict notice append heals through the wholesale rewrite.
        let id = manager.append_terminal_notice(&notice("k:a")).unwrap();
        assert!(manager.write_poison.is_none());
        let content = read_file(manager.get_session_file().unwrap());
        let entries = parse_session_entries(&content);
        let FileEntry::CustomMessage { base, .. } = entries.last().unwrap() else {
            panic!("the notice row must be the last entry");
        };
        assert_eq!(base.id.as_deref(), Some(id.as_str()));
        // Ordinary appends work again after the heal.
        manager.append_custom_entry("test", None).unwrap();
    }

    #[test]
    fn in_memory_manager_refuses_strict_notice_paths() {
        let mut manager = SessionManager::in_memory(Path::new("/tmp"));
        assert_eq!(
            manager
                .append_terminal_notice(&notice("k:a"))
                .unwrap_err()
                .kind(),
            ErrorKind::Unsupported
        );
        assert_eq!(
            manager
                .append_notice_consumed(&["k:a".to_string()])
                .unwrap_err()
                .kind(),
            ErrorKind::Unsupported
        );
        assert!(manager.unconsumed_terminal_notices().unwrap().is_empty());
    }
    #[test]
    fn fault_partial_prewrite_retries_the_same_row_once() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_message(assistant_message()).unwrap();
        fault_hooks::arm(&file, Fault::PartialPrewrite, 1);
        // The torn prefix is truncated back and the SAME line retries.
        let id = manager.append_terminal_notice(&notice("k:a")).unwrap();
        let content = read_file(&file);
        assert!(content.ends_with('\n'));
        let entries = parse_session_entries(&content);
        let notice_rows: Vec<&FileEntry> = entries
            .iter()
            .filter(|entry| matches!(entry, FileEntry::CustomMessage { .. }))
            .collect();
        assert_eq!(notice_rows.len(), 1);
        assert_eq!(notice_rows[0].id(), Some(id.as_str()));
    }

    #[test]
    fn fault_partial_prewrite_twice_surfaces_a_clean_tail() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_message(assistant_message()).unwrap();
        fault_hooks::arm(&file, Fault::PartialPrewrite, 5);
        let error = manager.append_terminal_notice(&notice("k:a")).unwrap_err();
        assert_eq!(error.to_string(), "injected fault");
        // The repair kept the tail clean; no poison for a repairable
        // prefix.
        assert!(manager.write_poison.is_none());
        let content = read_file(&file);
        assert!(content.ends_with('\n'));
        // Disarm the remaining shots: a fresh retry must now land the
        // row for real (the hook would fail it otherwise).
        fault_hooks::disarm(&file);
        let id = manager.append_terminal_notice(&notice("k:a")).unwrap();
        let entries = parse_session_entries(&read_file(&file));
        let notice_rows: Vec<&FileEntry> = entries
            .iter()
            .filter(|entry| matches!(entry, FileEntry::CustomMessage { .. }))
            .collect();
        assert_eq!(notice_rows.len(), 1);
        assert_eq!(notice_rows[0].id(), Some(id.as_str()));
    }

    #[test]
    fn fault_sync_fail_re_syncs_the_landed_row() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_message(assistant_message()).unwrap();
        fault_hooks::arm(&file, Fault::SyncFail, 1);
        // The complete line landed despite the sync failure: the
        // reconcile re-syncs it and the append succeeds - no second
        // row.
        let id = manager.append_terminal_notice(&notice("k:a")).unwrap();
        let content = read_file(&file);
        assert!(content.ends_with('\n'));
        let entries = parse_session_entries(&content);
        let FileEntry::CustomMessage { payload, base } = entries.last().unwrap() else {
            panic!("the notice row must be the last entry");
        };
        assert_eq!(base.id.as_deref(), Some(id.as_str()));
        assert_eq!(payload.custom_type, "rlm_child_terminal_notice");
        let keys: Vec<String> = manager
            .unconsumed_terminal_notices()
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(keys, ["k:a"]);
    }

    #[test]
    fn fault_dir_fsync_fail_keeps_the_row_and_the_retry_resyncs() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_thinking_level_change("high").unwrap();
        // Arm through the re-exported crate path the engine tests use.
        crate::session::manager::fault_hooks::arm(&file, Fault::DirFsyncFail, 1);
        // The wholesale rewrite landed the buffered rows and the
        // notice; only the directory fsync failed: the row stays
        // durable and indexed, the error surfaces.
        let error = manager.append_terminal_notice(&notice("k:a")).unwrap_err();
        assert_eq!(error.to_string(), "injected fault");
        let content = read_file(&file);
        let entries = parse_session_entries(&content);
        assert_eq!(entries.len(), 3); // header + thinking + notice
                                      // The landed row is indexed on the live branch despite the
                                      // pending directory sync: the leaf resolves to the durable row.
        assert_eq!(manager.get_leaf_id(), entries[2].id());
        let keys: Vec<String> = manager
            .unconsumed_terminal_notices()
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(keys, ["k:a"]);
        // The idempotent retry confirms the landed row - no second
        // row.
        let id = manager.append_terminal_notice(&notice("k:a")).unwrap();
        assert_eq!(parse_session_entries(&read_file(&file)).len(), 3);
        let reopened_entries = parse_session_entries(&read_file(&file));
        let notice_rows: Vec<&FileEntry> = reopened_entries
            .iter()
            .filter(|entry| matches!(entry, FileEntry::CustomMessage { .. }))
            .collect();
        assert_eq!(notice_rows.len(), 1);
        assert_eq!(notice_rows[0].id(), Some(id.as_str()));
    }

    #[test]
    fn fault_dir_fsync_fail_on_the_marker_leaves_keys_unconsumed() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        manager.append_terminal_notice(&notice("k:a")).unwrap();
        // A retained-only assistant row (never landed on disk).
        manager.file_entries.push(FileEntry::Message {
            message: assistant_message(),
            base: entry_base("asst-1"),
        });
        fault_hooks::arm(&file, Fault::DirFsyncFail, 1);
        let error = manager
            .append_notice_consumed(&["k:a".to_string()])
            .unwrap_err();
        assert_eq!(error.to_string(), "injected fault");
        // The rewrite landed the assistant, but the marker never did:
        // the key stays unconsumed for recovery replay.
        let keys: Vec<String> = manager
            .unconsumed_terminal_notices()
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(keys, ["k:a"]);
        // The retry (fault exhausted) syncs the landed assistant and
        // then lands the marker.
        manager
            .append_notice_consumed(&["k:a".to_string()])
            .unwrap();
        assert!(manager.unconsumed_terminal_notices().unwrap().is_empty());
        let entries = parse_session_entries(&read_file(&file));
        let FileEntry::Custom { payload, .. } = entries.last().unwrap() else {
            panic!("the marker row must be the last entry");
        };
        assert_eq!(payload.custom_type, "notice_consumed");
    }

    fn agent_reply(id: &str) -> CustomMessage {
        CustomMessage {
            custom_type: "agent_message".to_string(),
            content: pa_types::ai::UserContent::Text(
                "[agent-message from worker] the reply body".to_string(),
            ),
            display: true,
            details: Some(serde_json::json!({
                "id": id,
                "message": "the reply body",
                "from": { "sessionName": "worker" },
            })),
            timestamp: 1_500,
            rest: serde_json::Map::default(),
        }
    }

    #[test]
    fn fault_append_dir_sync_fail_on_an_existing_file_keeps_the_row_durable() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        // An ordinary assistant flush creates the file WITHOUT a
        // directory fsync (the review's existing-file scenario).
        manager.append_message(assistant_message()).unwrap();
        let file = manager.get_session_file().unwrap().to_path_buf();
        let rows_before = parse_session_entries(&read_file(&file)).len();
        fault_hooks::arm(&file, Fault::AppendDirSyncFail, 1);
        let error = manager.append_terminal_notice(&notice("k:a")).unwrap_err();
        assert_eq!(error.to_string(), "injected fault");
        // The complete line landed and is indexed on the live branch,
        // but success was withheld pending the directory sync.
        let entries = parse_session_entries(&read_file(&file));
        assert_eq!(entries.len(), rows_before + 1);
        assert_eq!(manager.get_leaf_id(), entries.last().unwrap().id());
        let keys: Vec<String> = manager
            .unconsumed_terminal_notices()
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(keys, ["k:a"]);
        // The idempotent retry confirms the landed row: same id, no
        // second row.
        let id = manager.append_terminal_notice(&notice("k:a")).unwrap();
        assert_eq!(Some(id.as_str()), entries.last().unwrap().id());
        assert_eq!(
            parse_session_entries(&read_file(&file)).len(),
            rows_before + 1
        );
    }

    #[test]
    fn agent_reply_is_strict_and_idempotent_by_id() {
        let (tmp, dir, mut manager) = persisted_manager();
        let file = manager.get_session_file().unwrap().to_path_buf();
        // A busy first-turn parent has no assistant yet: the strict
        // rewrite lands header + reply together.
        let id = manager
            .append_agent_message(&agent_reply("agentmsg-1"))
            .unwrap();
        assert!(file.exists());
        let entries = parse_session_entries(&read_file(&file));
        assert_eq!(entries.len(), 2); // header + reply
        let FileEntry::CustomMessage { payload, base } = &entries[1] else {
            panic!("the reply row must be a custom_message entry");
        };
        assert_eq!(base.id.as_deref(), Some(id.as_str()));
        assert_eq!(payload.custom_type, "agent_message");
        assert_eq!(payload.details.as_ref().unwrap()["id"], "agentmsg-1");
        // The retry hands back the SAME row id without a second row.
        let retry = manager
            .append_agent_message(&agent_reply("agentmsg-1"))
            .unwrap();
        assert_eq!(retry, id);
        assert_eq!(parse_session_entries(&read_file(&file)).len(), 2);
        // A different reply id lands its own row.
        let other = manager
            .append_agent_message(&agent_reply("agentmsg-2"))
            .unwrap();
        assert_ne!(other, id);
        // Reopen: still idempotent, and reply rows are never terminal
        // notices.
        let mut reopened = SessionManager::open(tmp.path(), &dir, &file);
        let reopened_id = reopened
            .append_agent_message(&agent_reply("agentmsg-1"))
            .unwrap();
        assert_eq!(reopened_id, id);
        assert!(reopened.unconsumed_terminal_notices().unwrap().is_empty());
    }

    #[test]
    fn agent_reply_rows_outside_the_contract_are_rejected() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        let mut wrong_type = agent_reply("agentmsg-1");
        wrong_type.custom_type = "terminal_inbox_reply".to_string();
        let error = manager.append_agent_message(&wrong_type).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        let mut without_id = agent_reply("agentmsg-1");
        without_id.details = None;
        let error = manager.append_agent_message(&without_id).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        let mut empty_id = agent_reply("agentmsg-1");
        empty_id.details = Some(serde_json::json!({ "id": "", "message": "x" }));
        let error = manager.append_agent_message(&empty_id).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        // Nothing was appended.
        let file = manager.get_session_file().unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn fault_append_dir_sync_fail_on_a_reply_keeps_it_durable() {
        let (_tmp, _dir, mut manager) = persisted_manager();
        manager.append_message(assistant_message()).unwrap();
        let file = manager.get_session_file().unwrap().to_path_buf();
        fault_hooks::arm(&file, Fault::AppendDirSyncFail, 1);
        let error = manager
            .append_agent_message(&agent_reply("agentmsg-1"))
            .unwrap_err();
        assert_eq!(error.to_string(), "injected fault");
        // The reply landed and is indexed; success withheld pending the
        // directory sync.
        let entries = parse_session_entries(&read_file(&file));
        let FileEntry::CustomMessage { payload, base } = entries.last().unwrap() else {
            panic!("the reply row must be the last entry");
        };
        assert_eq!(payload.custom_type, "agent_message");
        assert_eq!(payload.details.as_ref().unwrap()["id"], "agentmsg-1");
        assert_eq!(manager.get_leaf_id(), base.id.as_deref());
        // The retry confirms the landed reply: same id, one row.
        let id = manager
            .append_agent_message(&agent_reply("agentmsg-1"))
            .unwrap();
        assert_eq!(Some(id.as_str()), base.id.as_deref());
        let reopened_entries = parse_session_entries(&read_file(&file));
        let reply_rows: Vec<&FileEntry> = reopened_entries
            .iter()
            .filter(|entry| {
                matches!(
                    entry,
                    FileEntry::CustomMessage { payload, .. }
                        if payload.custom_type == "agent_message"
                )
            })
            .collect();
        assert_eq!(reply_rows.len(), 1);
    }
}

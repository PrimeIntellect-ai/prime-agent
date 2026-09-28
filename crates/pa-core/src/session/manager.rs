//! `SessionManager`: the stateful session writer. Port of the class half of
//! core/session-manager.ts (create/new/append/persist, crash repair, index).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use pa_types::session::{
    AgentMessage, ChildUsageOrigin, EntryBase, FileEntry, GitContext, SessionHeader, SessionState,
    SessionStateStatus,
};

use super::tree::SessionTree;
use super::{migrate_to_current_version, parse_session_entries, CURRENT_SESSION_VERSION};

// The inline unit battery moved to the child module at the same tree
// position (session::manager::tests); its use-super glob keeps resolving
// through the facade bindings and re-exports (the session_store stage-1
// precedent).
#[cfg(test)]
mod tests;

// The queries concern (the derived state + accessor arm: the active
// context/history snapshot, the branch scans, the window-backed reads,
// and the getters) moved to the child module at the same tree position
// (session::manager::queries); every member keeps its pub level and the
// facade binding below serves the child super:: paths (active_context:
// SessionContext + build_session_context).
mod queries;
use super::{build_session_context, SessionContext};

// The lifecycle concern (the constructors, the open/fork/new/materialize/
// adopt arm, and the fork branch-copy helpers) moved to the child module
// at the same tree position (session::manager::lifecycle); every member
// keeps its pub level (external callers resolve through the type), the
// child resolves the facade re-exports/bindings via its use-super glob,
// and the `use super::window;` module binding serves the childrens
// super::window:: paths (open_windowed, adopt_window,
// set_append_ownership).
mod lifecycle;
use super::window;

// The id + timestamp mint (the session id minters, the session file
// path, and the ISO-8601 timestamps) moved to the child module at the
// same tree position (session::manager::ids); the re-exports keep the
// pub API paths stable (format_iso 8 + format_iso_now 5 external callers;
// get_session_file_path has zero external callers - the re-export keeps
// the path stable and avoids dead-code lint churn, the session_store
// find_most_recent_session_for_cwd precedent) and the pub(super)
// bindings keep the constructors' + the append arm's bare calls in scope.
mod ids;
pub use ids::{format_iso, format_iso_now, get_session_file_path};
use ids::{create_session_id, generate_id};

// The header + rlm-depth concern (the first-line header read and the
// RLM depth resolution) moved to the child module at the same tree
// position (session::manager::header); the re-export keeps the pub API
// path stable (discovery.rs) and the pub(super) bindings keep the
// constructors' bare calls in scope (set_session_file, new_session,
// fork_from, materialize_session_file).
mod header;
pub use header::read_session_header;
use header::{is_valid_rlm_depth, resolve_session_rlm_depth, root_rlm_depth_from_env};

// The git-context concern (the quiet git probes and the header capture)
// moved to the child module at the same tree position
// (session::manager::git); the re-export keeps the pub API path stable
// (manager_ext.rs + the git-context integration tests) and the
// constructors bare calls.
mod git;
pub use git::capture_git_context;

// The crash-repair + load concern (the serialized entry wire, the
// bounded damage scan, the torn-tail repair, and the header-validating
// load) moved to the child module at the same tree position
// (session::manager::repair); the re-export keeps the pub API path stable
// (zero external callers - the find_most_recent_session_for_cwd
// precedent) and the bindings keep the bare-path callers in scope (the
// write arms until their own cut + the test child).
mod repair;
pub use repair::load_entries_from_file;
use repair::{repair_jsonl_damage, serialize_entry};

/// A persist observer; must not break session writes (panics are contained).
pub type SessionPersistListener = Box<dyn Fn(&Path) + Send + Sync>;

/// Options for creating a new session.
#[derive(Default)]
pub struct NewSessionOptions {
    pub id: Option<String>,
    pub parent_session: Option<String>,
    pub rlm_depth: Option<u64>,
}

/// The stateful session writer/reader.
pub struct SessionManager {
    session_id: String,
    session_file: Option<PathBuf>,
    session_dir: PathBuf,
    cwd: PathBuf,
    persist: bool,
    /// Whether the manager carries a session directory of its own (any
    /// persisted manager, and the daemon's mirrored engine session): the
    /// session-owned artifacts (local harness state) resolve under it.
    session_dir_backed: bool,
    flushed: bool,
    has_assistant_entry: bool,
    append_ownership: super::window::AppendOwnership,
    file_entries: Vec<FileEntry>,
    window: Option<super::window::WindowedSessionStore>,
    by_id: HashMap<String, usize>,
    labels_by_id: HashMap<String, String>,
    label_timestamps_by_id: HashMap<String, String>,
    leaf_id: Option<String>,
    persist_listeners: Vec<SessionPersistListener>,
}

impl SessionManager {
    fn refresh_has_assistant_entry(&mut self, entries: &[FileEntry]) {
        self.has_assistant_entry = entries.iter().any(|entry| {
            matches!(
                entry,
                FileEntry::Message {
                    message: AgentMessage::Assistant(_),
                    ..
                }
            )
        });
    }

    fn build_index(&mut self) {
        self.by_id.clear();
        self.labels_by_id.clear();
        self.label_timestamps_by_id.clear();
        self.leaf_id = None;
        for (index, entry) in self.file_entries.iter().enumerate() {
            if matches!(entry, FileEntry::Header { .. }) {
                continue;
            }
            if let Some(id) = entry.id() {
                self.by_id.insert(id.to_string(), index);
                self.leaf_id = Some(id.to_string());
            }
            if let FileEntry::Label { payload, .. } = entry {
                if let Some(label) = &payload.label {
                    self.labels_by_id
                        .insert(payload.target_id.clone(), label.clone());
                    self.label_timestamps_by_id
                        .insert(payload.target_id.clone(), entry.timestamp().to_string());
                } else {
                    self.labels_by_id.remove(&payload.target_id);
                    self.label_timestamps_by_id.remove(&payload.target_id);
                }
            }
        }
    }

    fn rewrite_file(&mut self) {
        if let Err(error) = self.try_rewrite_file() {
            tracing::error!(%error, "session rewrite failed");
        }
    }

    fn try_rewrite_file(&mut self) -> std::io::Result<()> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        let Some(session_file) = &self.session_file else {
            return Ok(());
        };
        if !self.persist {
            return Ok(());
        }
        let mut content = String::new();
        for (index, entry) in self.file_entries.iter().enumerate() {
            if index > 0 {
                content.push('\n');
            }
            content.push_str(&serialize_entry(entry));
        }
        content.push('\n');
        if let Some(parent) = session_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(session_file, &content)?;
        self.notify_persist_listeners();
        Ok(())
    }

    fn notify_persist_listeners(&self) {
        let Some(session_file) = &self.session_file else {
            return;
        };
        for listener in &self.persist_listeners {
            listener(session_file);
        }
    }

    pub fn on_persist(&mut self, listener: SessionPersistListener) {
        self.persist_listeners.push(listener);
    }

    pub fn is_persisted(&self) -> bool {
        self.persist
    }

    /// Force-write all in-memory entries immediately (pre-model durability).
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the session file rewrite
    /// fails; unpersisted or already-flushed managers succeed without
    /// touching the disk.
    pub fn flush_now(&mut self) -> std::io::Result<()> {
        if !self.persist || self.session_file.is_none() {
            return Ok(());
        }
        if self.flushed && self.session_file.as_ref().is_some_and(|path| path.exists()) {
            return Ok(());
        }
        self.try_rewrite_file()?;
        self.flushed = true;
        Ok(())
    }

    fn persist_entry(&mut self, index: usize) -> std::io::Result<()> {
        if !self.persist || self.session_file.is_none() {
            return Ok(());
        }
        let is_session_state_or_info = matches!(
            self.file_entries[index],
            FileEntry::SessionState { .. } | FileEntry::SessionInfo { .. }
        );
        if !self.has_assistant_entry && !is_session_state_or_info {
            self.flushed = false;
            return Ok(());
        }
        let file_exists = self.session_file.as_ref().is_some_and(|path| path.exists());
        if self.window.is_none() && (!self.flushed || !file_exists) {
            // Recover from the session file disappearing under a live session:
            // append would recreate a headerless stub.
            self.try_rewrite_file()?;
            self.flushed = true;
        } else {
            let entry = serialize_entry(&self.file_entries[index]);
            if let Some(session_file) = &self.session_file {
                let mut line = entry.into_bytes();
                line.push(b'\n');
                super::window::append_cached(session_file, &line, self.append_ownership)?;
            }
            self.notify_persist_listeners();
        }
        Ok(())
    }

    pub(crate) fn append_entry(&mut self, entry: FileEntry) -> std::io::Result<()> {
        let was_assistant = self.has_assistant_entry;
        let was_flushed = self.flushed;
        if matches!(
            entry,
            FileEntry::Message {
                message: AgentMessage::Assistant(_),
                ..
            }
        ) {
            self.has_assistant_entry = true;
        }
        self.file_entries.push(entry);
        let index = self.file_entries.len() - 1;
        if let Err(error) = self.persist_entry(index) {
            self.file_entries.pop();
            self.has_assistant_entry = was_assistant;
            self.flushed = was_flushed;
            return Err(error);
        }
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        Ok(())
    }

    pub(crate) fn next_base(&self) -> EntryBase {
        EntryBase {
            id: Some(if self.window.is_some() {
                uuid::Uuid::new_v4().to_string()
            } else {
                generate_id(&self.by_id)
            }),
            parent_id: self.leaf_id.clone(),
            timestamp: Some(format_iso_now()),
            rest: pa_types::JsonMap::new(),
        }
    }

    /// Append a conversation message; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails; the
    /// entry is not kept in the in-memory index.
    pub fn append_message(&mut self, message: AgentMessage) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Message { message, base })?;
        Ok(id)
    }

    /// Append a conversation message with the TS `_appendEntry`
    /// retained-write contract (the `_agentEventQueue` subscriber arm): the
    /// loop already owns the row in live agent state, so a failed disk write
    /// keeps it in the live session index too — the two stores stay in sync —
    /// and the error surfaces for logging only. [`Self::append_message`]
    /// stays strict for callers that roll back on failure.
    pub fn append_message_retained(
        &mut self,
        message: AgentMessage,
    ) -> (String, Option<std::io::Error>) {
        if matches!(message, AgentMessage::Assistant(_)) {
            self.has_assistant_entry = true;
        }
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.file_entries.push(FileEntry::Message { message, base });
        let index = self.file_entries.len() - 1;
        let write_error = self.persist_entry(index).err();
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        (id, write_error)
    }

    /// Append a thinking-level change; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_thinking_level_change(
        &mut self,
        thinking_level: &str,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ThinkingLevelChange {
            payload: pa_types::session::ThinkingLevelChangeEntry {
                thinking_level: thinking_level.to_string(),
            },
            base,
        })?;
        Ok(id)
    }

    /// Append a service-tier change; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_service_tier_change(
        &mut self,
        service_tier: Option<pa_types::ai::ServiceTier>,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ServiceTierChange {
            payload: pa_types::session::ServiceTierChangeEntry { service_tier },
            base,
        })?;
        Ok(id)
    }

    /// Append a model change; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_model_change(
        &mut self,
        provider: &str,
        model_id: &str,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ModelChange {
            payload: pa_types::session::ModelChangeEntry {
                provider: provider.to_string(),
                model_id: model_id.to_string(),
            },
            base,
        })?;
        Ok(id)
    }

    /// `appendCompaction`: persist the compaction record. The full typed
    /// payload is stored (TS keeps `details`, `fromHook`,
    /// `customInstructions`, `usage`, and `harnessDigest` on the durable
    /// row; later compactions and branch summarization read them back).
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_compaction(
        &mut self,
        payload: pa_types::session::CompactionEntry,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Compaction { payload, base })?;
        Ok(id)
    }

    /// Append a custom entry; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_custom_entry(
        &mut self,
        custom_type: &str,
        data: Option<serde_json::Value>,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Custom {
            payload: pa_types::session::CustomEntry {
                custom_type: custom_type.to_string(),
                data,
                rest: serde_json::Map::default(),
            },
            base,
        })?;
        Ok(id)
    }

    /// Append a custom entry with the TS `_appendEntry` retained-write
    /// contract: a failed disk write keeps the entry in the live index and
    /// surfaces the error for the caller to log or report after the rest of
    /// its TS-choreographed writes (the refine audit arm). [`Self::append_custom_entry`]
    /// stays strict for callers that roll back on failure.
    pub fn append_custom_entry_retained(
        &mut self,
        custom_type: &str,
        data: Option<serde_json::Value>,
    ) -> (String, Option<std::io::Error>) {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.file_entries.push(FileEntry::Custom {
            payload: pa_types::session::CustomEntry {
                custom_type: custom_type.to_string(),
                data,
                rest: serde_json::Map::default(),
            },
            base,
        });
        let index = self.file_entries.len() - 1;
        let write_error = self.persist_entry(index).err();
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        (id, write_error)
    }

    /// Append a custom message entry (compaction/refine notices, prompts).
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_custom_message(
        &mut self,
        custom_type: &str,
        content: pa_types::ai::UserContent,
        display: bool,
        details: Option<serde_json::Value>,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::CustomMessage {
            payload: pa_types::session::CustomMessageEntry {
                custom_type: custom_type.to_string(),
                content,
                details,
                display,
                rest: serde_json::Map::default(),
            },
            base,
        })?;
        Ok(id)
    }

    /// Append a best-effort disclosure row: a failed disk write keeps the
    /// entry indexed (the TS `_unpersistedOutcomes` guarantee — context
    /// rebuilds must not drop the disclosure; the gap-bridged usage walk
    /// tolerates the missing line on reload). The write error surfaces for
    /// logging only.
    pub fn append_custom_message_retained(
        &mut self,
        custom_type: &str,
        content: pa_types::ai::UserContent,
        display: bool,
        details: Option<serde_json::Value>,
    ) -> (String, Option<std::io::Error>) {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.file_entries.push(FileEntry::CustomMessage {
            payload: pa_types::session::CustomMessageEntry {
                custom_type: custom_type.to_string(),
                content,
                details,
                display,
                rest: serde_json::Map::default(),
            },
            base,
        });
        let index = self.file_entries.len() - 1;
        let write_error = self.persist_entry(index).err();
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        (id, write_error)
    }

    /// Fold child usage into the target assistant message and record the
    /// attribution entry.
    ///
    /// # Errors
    ///
    /// Returns an invalid-input error when the target assistant message
    /// entry is missing, or the underlying I/O error when the durable
    /// append fails.
    pub fn append_child_usage_attribution(
        &mut self,
        target_id: &str,
        child_usage: pa_types::ai::Usage,
        aggregate_usage: pa_types::ai::Usage,
        origin: Option<ChildUsageOrigin>,
    ) -> std::io::Result<String> {
        let target_index = self.by_id.get(target_id).copied().filter(|&index| {
            matches!(
                self.file_entries[index],
                FileEntry::Message {
                    message: AgentMessage::Assistant(_),
                    ..
                }
            )
        });
        let target_index = target_index.ok_or_else(|| {
            // TS `appendChildUsageAttribution` throws the same text; the
            // caller treats a failed append as recoverable bookkeeping.
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("Assistant message entry {target_id} not found"),
            )
        })?;
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ChildUsageAttributed {
            payload: pa_types::session::ChildUsageAttributionEntry {
                target_id: target_id.to_string(),
                child_usage,
                aggregate_usage,
                origin,
            },
            base,
        })?;
        // Fold only after the durable append: a failed write must not leave
        // phantom usage for a later rewrite to persist.
        if let FileEntry::Message {
            message: AgentMessage::Assistant(assistant),
            ..
        } = &mut self.file_entries[target_index]
        {
            assistant.usage = aggregate_usage;
        }
        Ok(id)
    }

    /// Append a session-info row (the session name); returns the new entry
    /// id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_session_info(&mut self, name: &str) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::SessionInfo {
            payload: pa_types::session::SessionInfoEntry {
                name: Some(name.trim().to_string()),
            },
            base,
        })?;
        Ok(id)
    }

    /// Move the leaf (used by branch/branchWithSummary).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub(crate) fn set_leaf_id(&mut self, leaf_id: Option<&str>) {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.leaf_id = leaf_id.map(str::to_string);
    }

    /// Apply a label entry to the label index (last label wins).
    pub(crate) fn apply_label_entry(
        &mut self,
        target_id: &str,
        label: Option<&str>,
        timestamp: &str,
    ) {
        if let Some(label) = label {
            self.labels_by_id
                .insert(target_id.to_string(), label.to_string());
            self.label_timestamps_by_id
                .insert(target_id.to_string(), timestamp.to_string());
        } else {
            self.labels_by_id.remove(target_id);
            self.label_timestamps_by_id.remove(target_id);
        }
    }

    /// Append a session-state row; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_session_state(&mut self, status: SessionStateStatus) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::SessionState {
            payload: pa_types::session::SessionStateEntry {
                state: SessionState { status },
            },
            base,
        })?;
        Ok(id)
    }
}

/// Atomic session-file write: private temp + fsync + rename onto the
/// destination (TS `writeFileAtomicSync`; the win32 destination-busy retry
/// rides along in `rename_onto`).
fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let temp = PathBuf::from(format!("{}.tmp{}", path.display(), std::process::id()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        crate::platform::perms::set_private_mode(&mut options);
        let mut file = options.open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    crate::platform::rename_onto(&temp, path)
}

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
    /// The active compacted context without hydrating old message bodies.
    ///
    /// An attached window contributes only its walk-resolved settings
    /// overlay: the transcript comes from `file_entries` (the one-copy
    /// authority since `adopt_window` moves the walk's trees in). The
    /// window's own trees are detached at adoption, so asking the window
    /// for a context would walk an empty window.
    pub fn active_context(&self) -> super::SessionContext {
        let mut context = super::build_session_context(&self.file_entries, self.get_leaf_id());
        if let Some(window) = &self.window {
            if !window.full_history() {
                let settings = window.settings();
                context.thinking_level.clone_from(&settings.thinking_level);
                context.service_tier = settings.service_tier;
                context.model.clone_from(&settings.model);
            }
        }
        context
    }

    /// Capture a historical read request while locked; await it after releasing
    /// the session mutex. Current unpersisted rows are merged into the snapshot.
    ///
    /// # Errors
    ///
    /// The returned future errors when reading the session file fails, or
    /// when the file read panics and the blocking task fails to join. When
    /// the manager holds no windowed store, the retained entries are
    /// returned without touching the disk.
    pub fn history_snapshot(
        &self,
    ) -> impl std::future::Future<Output = anyhow::Result<Vec<FileEntry>>> + Send + 'static {
        let path = self
            .window
            .as_ref()
            .map(|window| window.source_path().to_owned());
        let retained = self.file_entries.clone();
        async move {
            let Some(path) = path else {
                return Ok(retained);
            };
            let mut entries = tokio::task::spawn_blocking(move || {
                std::fs::read_to_string(path).map(|text| super::parse_session_entries(&text))
            })
            .await??;
            let ids: std::collections::HashSet<String> = entries
                .iter()
                .filter_map(|entry| entry.id().map(str::to_owned))
                .collect();
            entries.extend(
                retained
                    .into_iter()
                    .filter(|entry| entry.id().is_some_and(|id| !ids.contains(id))),
            );
            Ok(entries)
        }
    }

    /// Loaded current-context records; not a whole-history view.
    pub fn retained_entries(&self) -> &[FileEntry] {
        &self.file_entries
    }

    pub fn has_thinking_level(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(super::window::WindowedSessionStore::has_thinking_level)
            || self
                .active_branch_entries()
                .iter()
                .any(|entry| matches!(entry, FileEntry::ThinkingLevelChange { .. }))
    }

    pub fn has_service_tier(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(super::window::WindowedSessionStore::has_service_tier)
            || self
                .active_branch_entries()
                .iter()
                .any(|entry| matches!(entry, FileEntry::ServiceTierChange { .. }))
    }

    fn active_branch_entries(&self) -> Vec<&FileEntry> {
        let mut branch = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut id = self.leaf_id.as_deref();
        while let Some(index) = id.and_then(|id| self.by_id.get(id)).copied() {
            // A corrupt file can hold a parent cycle; opening must not hang.
            if !visited.insert(index) {
                break;
            }
            let entry = &self.file_entries[index];
            branch.push(entry);
            id = entry.parent_id();
        }
        branch.reverse();
        branch
    }

    pub fn active_goal_state(&self) -> Option<crate::goals::GoalState> {
        if let Some(window) = &self.window {
            return window.goal_state().cloned();
        }
        self.active_branch_entries().iter().rev().find_map(|entry| {
            let FileEntry::Custom { payload, .. } = entry else {
                return None;
            };
            let data = payload.data.as_ref()?;
            if payload.custom_type != crate::goals::GOAL_STATE_CUSTOM_TYPE
                || !crate::goals::is_persisted_goal_state(data)
            {
                return None;
            }
            serde_json::from_value(data.clone())
                .ok()
                .map(crate::goals::normalize_goal_state)
        })
    }

    /// The branch's newest un-resumed quota park, reachable without
    /// hydration (TS `_restoreQuotaPark`'s scan, newest first): the
    /// loaded active branch entries first, then — for a windowed store —
    /// the window's pre-boundary metadata records.
    pub fn latest_quota_park(
        &self,
    ) -> Option<crate::session_engine::provider_park::PersistedQuotaPark> {
        use crate::session_engine::provider_park::{scan_quota_park_entries, BranchParkScan};
        // The loaded branch is a borrow scan (once per build); the windowed
        // fallback below reads the older metadata records line by line.
        let branch: Vec<FileEntry> = self.active_branch_entries().into_iter().cloned().collect();
        match scan_quota_park_entries(&branch) {
            BranchParkScan::Park(park) => return Some(park),
            // A newer resume entry ends the episode; older records cannot
            // restore a park behind it.
            BranchParkScan::Resumed => return None,
            BranchParkScan::None => {}
        }
        let window = self.window.as_ref()?;
        for line in window.metadata_entries().iter().rev() {
            let Ok(entry) = serde_json::from_str::<FileEntry>(line) else {
                continue;
            };
            match scan_quota_park_entries(std::slice::from_ref(&entry)) {
                BranchParkScan::Park(park) => return Some(park),
                BranchParkScan::Resumed => return None,
                BranchParkScan::None => {}
            }
        }
        None
    }

    /// Newest `git_state` reachable without hydration: the loaded active
    /// branch first, then the window's pre-boundary metadata (newest first).
    pub(crate) fn latest_git_context(&self) -> Option<pa_types::session::GitContext> {
        let on_branch = self.active_branch_entries().iter().rev().find_map(|entry| {
            if let FileEntry::GitState { payload, .. } = entry {
                Some(payload.git.clone())
            } else {
                None
            }
        });
        if on_branch.is_some() {
            return on_branch;
        }
        // metadata_entries is file order; the newest wins.
        self.window
            .as_ref()?
            .metadata_entries()
            .iter()
            .rev()
            .find_map(|line| match serde_json::from_str::<FileEntry>(line) {
                Ok(FileEntry::GitState { payload, .. }) => Some(payload.git),
                _ => None,
            })
    }

    pub fn has_non_bootstrap_entries(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(super::window::WindowedSessionStore::has_non_bootstrap_entries)
            || self.file_entries.iter().any(|entry| {
                !matches!(
                    entry,
                    FileEntry::Header { .. }
                        | FileEntry::ModelChange { .. }
                        | FileEntry::ThinkingLevelChange { .. }
                        | FileEntry::ServiceTierChange { .. }
                )
            })
    }

    pub fn refinement_history(&self) -> Vec<crate::refinement::RefinementResult> {
        let mut history = self.window.as_ref().map_or_else(Vec::new, |window| {
            let entries: Vec<FileEntry> = window
                .metadata_entries()
                .iter()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            crate::session_engine::refine::session_refinement_history(&entries)
        });
        history.extend(crate::session_engine::refine::session_refinement_history(
            &self.file_entries,
        ));
        history
    }

    #[cfg(test)]
    pub fn is_full_history(&self) -> bool {
        self.window.is_none()
    }

    /// Hydrate before historical reads or mutation. Loading uses a blocking
    /// worker; the selected leaf is retained and disk appends are preserved.
    ///
    /// # Errors
    ///
    /// Returns an error when the full-history hydration of the windowed
    /// store fails. A manager without a window is already hydrated and
    /// succeeds without touching the disk.
    pub async fn ensure_full_history(&mut self) -> anyhow::Result<()> {
        let Some(window) = self.window.as_mut() else {
            return Ok(());
        };
        window.ensure_full_history().await?;
        let mut entries = window.entries().to_vec();
        let loaded_ids: std::collections::HashSet<String> = entries
            .iter()
            .filter_map(|entry| entry.id().map(str::to_owned))
            .collect();
        entries.extend(
            self.file_entries
                .iter()
                .filter(|entry| entry.id().is_some_and(|id| !loaded_ids.contains(id)))
                .cloned(),
        );
        let leaf = self.leaf_id.clone();
        self.refresh_has_assistant_entry(&entries);
        self.file_entries = entries;
        self.build_index();
        self.leaf_id = leaf;
        self.window = None;
        Ok(())
    }

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

    /// Session artifact directory (`dirname(sessionDir)/session-artifacts/<id>`,
    /// TS `getSessionArtifactDir`); only persisted sessions have one.
    pub fn get_session_artifact_dir(&self) -> Option<std::path::PathBuf> {
        self.persist
            .then(|| {
                self.session_dir
                    .parent()
                    .map(|root| root.join("session-artifacts"))
            })
            .flatten()
            .map(|root| root.join(&self.session_id))
    }

    pub fn get_cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn get_session_dir(&self) -> &Path {
        &self.session_dir
    }

    pub fn get_session_id(&self) -> &str {
        &self.session_id
    }

    pub fn get_session_file(&self) -> Option<&Path> {
        self.session_file.as_deref()
    }

    /// Entries excluding the session header (TS `getEntries()`).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_entries(&self) -> Vec<FileEntry> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.file_entries
            .iter()
            .filter(|entry| !matches!(entry, FileEntry::Header { .. }))
            .cloned()
            .collect()
    }

    /// All entries including the header (whole-file views).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_all_entries(&self) -> &[FileEntry] {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        &self.file_entries
    }

    pub fn get_leaf_id(&self) -> Option<&str> {
        self.leaf_id.as_deref()
    }

    pub fn get_header(&self) -> Option<&SessionHeader> {
        self.file_entries.iter().find_map(|entry| match entry {
            FileEntry::Header { header } => Some(header),
            _ => None,
        })
    }

    pub fn get_session_name(&self) -> Option<String> {
        if let Some(window) = &self.window {
            return self
                .file_entries
                .iter()
                .rev()
                .find_map(|entry| match entry {
                    FileEntry::SessionInfo { payload, .. } => Some(payload.name.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| {
                    window
                        .metadata_entries()
                        .iter()
                        .rev()
                        .find_map(|raw| match serde_json::from_str::<FileEntry>(raw).ok()? {
                            FileEntry::SessionInfo { payload, .. } => Some(payload.name),
                            _ => None,
                        })
                        .flatten()
                });
        }
        self.file_entries
            .iter()
            .rev()
            .find_map(|entry| match entry {
                FileEntry::SessionInfo { payload, .. } => Some(payload.name.clone()),
                _ => None,
            })
            .flatten()
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

    /// The session tree (branch children + label state) over current entries.
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_tree(&self) -> SessionTree {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        SessionTree::build(&self.file_entries)
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

    /// Look up an entry by id (file position index).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_entry_by_id(&self, id: &str) -> Option<&FileEntry> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.by_id.get(id).map(|&index| &self.file_entries[index])
    }

    /// The active label for a target entry id.
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_label(&self, target_id: &str) -> Option<String> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.labels_by_id.get(target_id).cloned()
    }

    /// The timestamp of the label entry that set the target's active label.
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_label_timestamp(&self, target_id: &str) -> Option<String> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.label_timestamps_by_id.get(target_id).cloned()
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

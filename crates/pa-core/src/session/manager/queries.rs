//! The queries concern (moved with its concern): the derived state +
//! accessor arm - the active context and history snapshot, the branch
//! scans, the window-backed reads, and the getters.

use super::*;

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
}

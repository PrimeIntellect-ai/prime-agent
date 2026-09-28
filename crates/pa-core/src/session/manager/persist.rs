//! The persist concern (moved with its concern): the entry index, the
//! rewrite/flush/notify plumbing, the durable append arm, and the atomic
//! session-file write (TS writeFileAtomicSync).

use super::*;

impl SessionManager {
    pub(super) fn refresh_has_assistant_entry(&mut self, entries: &[FileEntry]) {
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

    pub(super) fn build_index(&mut self) {
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

    pub(super) fn rewrite_file(&mut self) {
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
    pub(super) fn persist_entry(&mut self, index: usize) -> std::io::Result<()> {
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
}

/// Atomic session-file write: private temp + fsync + rename onto the
/// destination (TS `writeFileAtomicSync`; the win32 destination-busy retry
/// rides along in `rename_onto`).
pub(super) fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
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

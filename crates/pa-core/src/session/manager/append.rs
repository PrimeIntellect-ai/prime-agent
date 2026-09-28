//! The append concern (moved with its concern): the append family -
//! messages, retained variants, changes, compactions, customs,
//! attributions, session info/state - and the leaf/label mutators.

use super::*;

impl SessionManager {
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

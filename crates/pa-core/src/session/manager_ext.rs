//! SessionManager part 2: queries, branches, labels, status entries.
//! Port of the tail of core/session-manager.ts (getBranch/getTree/branch*).

use pa_types::session::{
    AgentMessage, AgentStatus, AgentStatusEntry, CustomMessageEntry, FileEntry, GitContext,
    GitStateEntry, LabelEntry, SessionStateStatus,
};

use super::manager::SessionManager;
use super::CONTENT_ENTRY_TYPES;

impl SessionManager {
    /// The active session state (latest normalized `session_state` entry).
    pub fn get_session_state(&self) -> Option<SessionStateStatus> {
        for entry in self.get_entries().iter().rev() {
            if let FileEntry::SessionState { payload, .. } = entry {
                let status = normalize_state(payload.state.status);
                if let Some(status) = status {
                    return Some(status);
                }
            }
        }
        None
    }

    /// True when the session holds user-meaningful content beyond the default
    /// creation prefix (model_change, thinking_level_change, service_tier_change).
    pub fn has_user_content(&self) -> bool {
        let owned_entries = self.get_entries();
        let content_entries: Vec<&FileEntry> = owned_entries
            .iter()
            .filter(|entry| CONTENT_ENTRY_TYPES.contains(&entry_type(entry)))
            .collect();
        let mut start = 0usize;
        if matches!(
            content_entries.get(start),
            Some(FileEntry::ModelChange { .. })
        ) {
            start += 1;
        }
        if matches!(
            content_entries.get(start),
            Some(FileEntry::ThinkingLevelChange { .. })
        ) {
            start += 1;
        }
        if matches!(
            content_entries.get(start),
            Some(FileEntry::ServiceTierChange { .. })
        ) {
            start += 1;
        }
        content_entries.len() > start
    }

    pub fn append_agent_status(
        &mut self,
        summary: &str,
        task_state: Option<pa_types::session::AgentTaskState>,
        based_on_message_count: usize,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::AgentStatus {
            payload: AgentStatusEntry {
                status: AgentStatus {
                    summary: summary.to_string(),
                    task_state,
                    based_on_message_count: based_on_message_count as u64,
                },
            },
            base,
        })?;
        Ok(id)
    }

    pub fn append_git_state(&mut self, git: GitContext) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::GitState {
            payload: GitStateEntry { git },
            base,
        })?;
        Ok(id)
    }

    /// Append git state when it changed on the active branch.
    pub fn record_git_state_if_changed(&mut self) -> Option<String> {
        if !self.is_persisted() {
            return None;
        }
        let git = super::manager::capture_git_context(self.get_cwd())?;
        if let Some(last) = self.active_git_context() {
            if git_contexts_equal(&last, &git) {
                return None;
            }
        }
        self.append_git_state(git).ok()
    }

    fn active_git_context(&self) -> Option<GitContext> {
        if let Some(context) = self.walk_to_root_first_match("git_state") {
            return Some(context);
        }
        match self.get_header() {
            Some(header) => header.git.clone(),
            None => None,
        }
    }

    /// Walk leaf-to-root on the active branch; first matching entry payload.
    fn walk_to_root_first_match(&self, kind: &str) -> Option<GitContext> {
        let mut current = self.get_leaf_id().map(str::to_string);
        while let Some(id) = current {
            let Some(entry) = self.get_entry_by_id(&id) else {
                break;
            };
            if let FileEntry::GitState { payload, .. } = entry {
                return Some(payload.git.clone());
            }
            current = entry.parent_id().map(str::to_string);
        }
        let _ = kind;
        None
    }

    /// Latest agent status on the active branch (leaf-to-root walk).
    pub fn get_latest_agent_status(&self) -> Option<AgentStatus> {
        let mut current = self.get_leaf_id().map(str::to_string);
        while let Some(id) = current {
            let Some(entry) = self.get_entry_by_id(&id) else {
                break;
            };
            if let FileEntry::AgentStatus { payload, .. } = entry {
                return Some(payload.status.clone());
            }
            current = entry.parent_id().map(str::to_string);
        }
        None
    }

    pub fn append_custom_message_entry(
        &mut self,
        custom_type: &str,
        content: pa_types::ai::UserContent,
        display: bool,
        details: Option<serde_json::Value>,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::CustomMessage {
            payload: CustomMessageEntry {
                custom_type: custom_type.to_string(),
                content,
                display,
                details,
                rest: Default::default(),
            },
            base,
        })?;
        Ok(id)
    }

    /// Append a label change for a target entry.
    pub fn append_label_change(
        &mut self,
        target_id: &str,
        label: Option<&str>,
    ) -> std::io::Result<String> {
        assert!(
            self.get_entry_by_id(target_id).is_some(),
            "Entry {target_id} not found"
        );
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        let timestamp = base.timestamp.clone().unwrap_or_default();
        self.append_entry(FileEntry::Label {
            payload: LabelEntry {
                target_id: target_id.to_string(),
                label: label.map(str::to_string),
            },
            base,
        })?;
        self.apply_label_entry(target_id, label, &timestamp);
        Ok(id)
    }

    /// `getFlatTree`: every entry in file order with its active label and
    /// label timestamp (the `get_session_tree` wire shape's source).
    pub fn get_flat_tree(&self) -> Vec<(FileEntry, Option<String>, Option<String>)> {
        self.get_entries()
            .into_iter()
            .map(|entry| {
                let id = entry.id().map(str::to_string);
                let label = id.as_deref().and_then(|id| self.get_label(id));
                let timestamp = id.as_deref().and_then(|id| self.get_label_timestamp(id));
                (entry, label, timestamp)
            })
            .collect()
    }

    /// `getUserMessagesForForking`: user messages with their text, in file
    /// order (TS `AgentSession.getUserMessagesForForking`).
    pub fn get_user_messages_for_forking(&self) -> Vec<(String, String)> {
        self.get_entries()
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::Message {
                    message: AgentMessage::User(user),
                    ..
                } => {
                    let text = user.content.text();
                    let id = entry.id().map(str::to_string)?;
                    (!text.is_empty()).then_some((id, text))
                }
                _ => None,
            })
            .collect()
    }

    /// The ancestor path (file order) ending at `from_id` (default: leaf).
    pub fn get_branch(&self, from_id: Option<&str>) -> Vec<&FileEntry> {
        let start = from_id
            .map(str::to_string)
            .or_else(|| self.get_leaf_id().map(str::to_string));
        let mut path = Vec::new();
        let mut current = start;
        while let Some(id) = current {
            let Some(entry) = self.get_entry_by_id(&id) else {
                break;
            };
            path.push(entry);
            current = entry.parent_id().map(str::to_string);
        }
        path.reverse();
        path
    }

    /// Move the leaf to `branch_from_id` (the session keeps its file).
    pub fn branch(&mut self, branch_from_id: &str) {
        assert!(
            self.get_entry_by_id(branch_from_id).is_some(),
            "Entry {branch_from_id} not found"
        );
        self.set_leaf_id(Some(branch_from_id));
    }

    /// Reset the leaf to the root (next append starts a new root branch).
    pub fn reset_leaf(&mut self) {
        self.set_leaf_id(None);
    }

    /// Branch with a summary message describing what the abandoned branch held.
    pub fn branch_with_summary(
        &mut self,
        branch_from_id: Option<&str>,
        summary: &str,
        details: Option<serde_json::Value>,
        from_hook: Option<bool>,
        usage: Option<pa_types::ai::Usage>,
    ) -> std::io::Result<String> {
        if let Some(branch_from_id) = branch_from_id {
            assert!(
                self.get_entry_by_id(branch_from_id).is_some(),
                "Entry {branch_from_id} not found"
            );
            self.set_leaf_id(Some(branch_from_id));
        } else {
            self.set_leaf_id(None);
        }
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::BranchSummary {
            payload: pa_types::session::BranchSummaryEntry {
                from_id: branch_from_id
                    .map(str::to_string)
                    .unwrap_or_else(|| "root".to_string()),
                summary: summary.to_string(),
                details,
                from_hook,
                usage,
            },
            base,
        })?;
        Ok(id)
    }
}

fn normalize_state(status: SessionStateStatus) -> Option<SessionStateStatus> {
    Some(match status {
        SessionStateStatus::Active | SessionStateStatus::Archived | SessionStateStatus::Crash => {
            status
        }
    })
}

fn entry_type(entry: &FileEntry) -> &'static str {
    match entry {
        FileEntry::Header { .. } => "session",
        FileEntry::Message { .. } => "message",
        FileEntry::ThinkingLevelChange { .. } => "thinking_level_change",
        FileEntry::ServiceTierChange { .. } => "service_tier_change",
        FileEntry::ModelChange { .. } => "model_change",
        FileEntry::Compaction { .. } => "compaction",
        FileEntry::BranchSummary { .. } => "branch_summary",
        FileEntry::Custom { .. } => "custom",
        FileEntry::ChildUsageAttributed { .. } => "child_usage_attributed",
        FileEntry::CustomMessage { .. } => "custom_message",
        FileEntry::Label { .. } => "label",
        FileEntry::SessionInfo { .. } => "session_info",
        FileEntry::SessionState { .. } => "session_state",
        FileEntry::AgentStatus { .. } => "agent_status",
        FileEntry::GitState { .. } => "git_state",
        FileEntry::Unknown { .. } => "unknown",
    }
}

fn git_contexts_equal(left: &GitContext, right: &GitContext) -> bool {
    left.commit == right.commit && left.branch == right.branch && left.repo_url == right.repo_url
}

#[cfg(test)]
mod tests {
    use crate::session::manager::SessionManager;
    use pa_types::session::AgentMessage;

    fn assistant() -> AgentMessage {
        AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![],
            api: "openai-completions".to_string(),
            provider: "openai".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        })
    }

    fn user(text: &str) -> AgentMessage {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: Default::default(),
        })
    }

    #[test]
    fn branch_and_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        let mut manager = SessionManager::persisted(tmp.path(), &dir);
        let a = manager.append_message(user("first")).unwrap();
        let b = manager.append_message(assistant()).unwrap();
        assert_eq!(manager.get_branch(None).len(), 2);
        // Branch from a: the path is just [a].
        manager.branch(&a);
        assert_eq!(manager.get_branch(None).len(), 1);
        // Append after branching creates a sibling of b.
        let summary_id = manager
            .branch_with_summary(Some(&a), "went back", None, None, None)
            .unwrap();
        assert!(manager.get_entry_by_id(&summary_id).is_some());
        // b still exists (sibling branch).
        assert!(manager.get_entry_by_id(&b).is_some());
    }

    #[test]
    fn user_content_detection() {
        let tmp = tempfile::tempdir().unwrap();
        let mut manager = SessionManager::in_memory(tmp.path());
        // Creation prefix only: no user content.
        manager.append_model_change("openai", "m");
        manager.append_thinking_level_change("medium");
        assert!(!manager.has_user_content());
        manager.append_message(user("real content"));
        assert!(manager.has_user_content());
    }

    #[test]
    fn labels_and_status_on_active_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let mut manager = SessionManager::in_memory(tmp.path());
        let a = manager.append_message(user("first")).unwrap();
        let label_entry = manager.append_label_change(&a, Some("checkpoint")).unwrap();
        assert!(manager.get_entry_by_id(&label_entry).is_some());
        assert_eq!(manager.get_label(&a).as_deref(), Some("checkpoint"));
        // Clear the label.
        manager.append_label_change(&a, None);
        assert_eq!(manager.get_label(&a), None);
        // Agent status visible on the active branch.
        let status_id = manager
            .append_agent_status(
                "working",
                Some(pa_types::session::AgentTaskState::NeedsInput),
                3,
            )
            .unwrap();
        assert!(manager.get_entry_by_id(&status_id).is_some());
        let status = manager.get_latest_agent_status().unwrap();
        assert_eq!(status.summary, "working");
        assert_eq!(status.based_on_message_count, 3);
        // Branch away: the status is no longer on the active path.
        manager.branch(&a);
        assert_eq!(manager.get_latest_agent_status(), None);
    }
}

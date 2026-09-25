//! Session-tree operations over the worker's session store.
//!
//! Port of the tree/branch/fork half of `core/session-manager.ts` over the
//! worker's [`SessionFile`]: leaf moves (`branch`/`resetLeaf`), the
//! `branch_summary` and `label` entries, the flat tree the `/tree` view
//! reads, the user-message fork points, and the branched-file creation
//! behind `fork`. Tree queries over typed entries go through
//! `pa_types::session::FileEntry` round-trips so the pa-core helpers
//! (branch-summary collection, context rebuilds) operate on the same
//! wire-identical data the TS product persists.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::session_store::{new_entry_id, session_file_name, SessionEntry, SessionFile};
use pa_types::session::FileEntry;

/// The active label state: latest `label` entry per target (TS
/// `labelsById`/`labelTimestampsById`).
#[derive(Debug, Default)]
pub struct LabelState {
    pub labels: HashMap<String, String>,
    pub timestamps: HashMap<String, String>,
}

impl LabelState {
    /// Scan the entries in file order; the last label entry for a target
    /// wins, and a null label clears it.
    pub fn from_entries(entries: &[SessionEntry]) -> Self {
        let mut state = LabelState::default();
        for entry in entries {
            if entry.type_ == "label" {
                let target = entry.fields.get("targetId").and_then(Value::as_str);
                let (Some(target), Some(label)) =
                    (target, entry.fields.get("label").and_then(Value::as_str))
                else {
                    if let Some(target) = target {
                        state.labels.remove(target);
                        state.timestamps.remove(target);
                    }
                    continue;
                };
                state.labels.insert(target.to_string(), label.to_string());
                state
                    .timestamps
                    .insert(target.to_string(), entry.timestamp.clone());
            }
        }
        state
    }
}

/// The full entry list as typed pa-types entries (wire-identical JSON
/// round-trip; unknown kinds degrade to `FileEntry::Unknown`).
pub fn file_entries(store: &SessionFile) -> Vec<FileEntry> {
    store
        .entries()
        .iter()
        .filter_map(|entry| serde_json::to_value(entry).ok())
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect()
}

/// `get_session_tree` (TS `getFlatTree`): every entry in file order with its
/// active label, the wire `flatNodes` shape.
pub fn flat_tree(store: &SessionFile) -> Vec<Value> {
    let labels = LabelState::from_entries(store.entries());
    store
        .entries()
        .iter()
        .map(|entry| {
            let entry = serde_json::to_value(entry).unwrap_or(Value::Null);
            let mut node = json!({ "entry": entry });
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                if let Some(label) = labels.labels.get(id) {
                    node["label"] = json!(label);
                    node["labelTimestamp"] = json!(labels
                        .timestamps
                        .get(id)
                        .map(String::as_str)
                        .unwrap_or_default());
                }
            }
            node
        })
        .collect()
}

/// `get_user_messages_for_forking`: user messages with their text, in file
/// order (TS `getUserMessagesForForking`).
pub fn user_messages_for_forking(store: &SessionFile) -> Vec<Value> {
    store
        .entries()
        .iter()
        .filter(|entry| entry.type_ == "message")
        .filter_map(|entry| entry.fields.get("message"))
        .filter(|message| message_role(message) == Some("user"))
        .filter_map(|message| {
            let text = message_text(message);
            (!text.is_empty())
                .then_some(json!({ "entryId": entry_id_of(store, message), "text": text }))
        })
        .collect()
}

/// The durable entry id of one message value: messages persist as the only
/// entry kind carrying a `message` field, so the owning entry matches by
/// identity.
fn entry_id_of(store: &SessionFile, message: &Value) -> String {
    store
        .entries()
        .iter()
        .find(|entry| entry.fields.get("message") == Some(message))
        .map(|entry| entry.id.clone())
        .unwrap_or_default()
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

/// Concatenated text of a message's string or text-block content (TS
/// `_extractUserMessageText`).
fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

impl SessionFile {
    /// `branch` (TS `SessionManager.branch`): move the leaf onto an
    /// existing entry; the next append parents from there.
    ///
    /// # Errors
    ///
    /// Returns an error when the target entry does not exist in the
    /// session; a `None` id clears the leaf and never errors.
    pub fn branch_to(&mut self, id: Option<&str>) -> Result<()> {
        match id {
            Some(id) => {
                if self.entry(id).is_none() {
                    return Err(anyhow!("Entry {id} not found"));
                }
                self.leaf_id = Some(id.to_string());
            }
            None => self.leaf_id = None,
        }
        Ok(())
    }

    /// `branchWithSummary`: move the leaf, then append the
    /// `branch_summary` entry describing the abandoned branch. Returns the
    /// summary entry id.
    ///
    /// # Errors
    ///
    /// Returns an error when the branch target does not exist or the
    /// summary entry cannot be persisted.
    pub fn append_branch_summary(
        &mut self,
        from_id: Option<&str>,
        summary: &str,
        details: Option<Value>,
        from_hook: Option<bool>,
        usage: Option<Value>,
        model: Option<(&str, &str)>,
    ) -> Result<String> {
        self.branch_to(from_id)?;
        let mut fields = json!({
            "fromId": from_id.unwrap_or("root"),
            "summary": summary,
            "details": details.unwrap_or(Value::Null),
        });
        if let Some(from_hook) = from_hook {
            fields["fromHook"] = json!(from_hook);
        }
        if let Some(usage) = usage {
            fields["usage"] = usage;
        }
        if let Some((provider, model_id)) = model {
            // The serving model of the summary call (TS #2411's
            // auxiliary routing): the per-model cost fold bills the
            // row's spend on the model that billed it rather than the
            // branch timeline.
            fields["provider"] = json!(provider);
            fields["modelId"] = json!(model_id);
        }
        self.persist_entry("branch_summary", fields)
    }

    /// `appendLabelChange`: persist the `label` entry for a target and
    /// keep the label state consistent (a null label clears it).
    ///
    /// # Errors
    ///
    /// Returns an error when the target entry does not exist or the
    /// label entry cannot be persisted.
    pub fn append_label_change(&mut self, target_id: &str, label: Option<&str>) -> Result<String> {
        if self.entry(target_id).is_none() {
            return Err(anyhow!("Entry {target_id} not found"));
        }
        let mut fields = json!({ "targetId": target_id });
        match label {
            Some(label) => fields["label"] = json!(label),
            None => fields["label"] = Value::Null,
        }
        self.persist_entry("label", fields)
    }

    /// The root-to-leaf path of the (new) current leaf as typed entries.
    pub fn branch_file_entries(&self) -> Vec<FileEntry> {
        self.branch()
            .iter()
            .filter_map(|entry| serde_json::to_value(*entry).ok())
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect()
    }

    /// `createBranchedSession` (TS fork): write a new session file holding
    /// the root-to-`leaf_id` path (label entries dropped from the path,
    /// their targets' labels re-recorded as fresh label entries), with a
    /// new header whose `parentSession` is this file. The caller re-points
    /// the worker at the returned store.
    ///
    /// # Errors
    ///
    /// Returns an error when the leaf entry does not exist, the fork's
    /// lease cannot be acquired, or the forked session file cannot be
    /// written.
    pub fn create_branched_file(&self, leaf_id: &str, session_dir: &Path) -> Result<SessionFile> {
        let path = self
            .branch_path_entries(leaf_id)
            .ok_or_else(|| anyhow!("Entry {leaf_id} not found"))?;
        let path_without_labels: Vec<&SessionEntry> =
            path.iter().filter(|entry| entry.type_ != "label").collect();
        let labels = LabelState::from_entries(self.entries());
        let path_ids: Vec<&str> = path_without_labels
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();

        let mut forked = SessionFile::create(
            &self.header.cwd,
            parent_session_of(self),
            self.header.rlm_depth.unwrap_or(0) as u32,
        );
        forked.header.git =
            pa_core::session::manager::capture_git_context(Path::new(&self.header.cwd));
        // Same directory as the source session, like TS
        // `createUniqueSessionFileTarget(this.getSessionDir())`.
        let file = session_dir.join(session_file_name(forked.session_id()));
        forked.set_path(file);
        if let Some(lease) = &self.lease {
            forked.lease = Some(lease.acquire_target(&forked.path)?);
        }

        let mut used: HashMap<String, ()> = path_without_labels
            .iter()
            .map(|entry| (entry.id.clone(), ()))
            .collect();
        for entry in &path_without_labels {
            forked.adopt_entry((*entry).clone());
        }
        // Re-record the carried labels after the path (TS appends them
        // parented onto the path tail, keeping their original timestamps).
        let mut parent = path_without_labels.last().map(|entry| entry.id.clone());
        for id in &path_ids {
            if let Some(label) = labels.labels.get(*id) {
                let entry = SessionEntry {
                    type_: "label".to_string(),
                    id: new_entry_id(&used),
                    parent_id: parent.clone(),
                    timestamp: labels
                        .timestamps
                        .get(*id)
                        .cloned()
                        .unwrap_or_else(crate::util::now_iso),
                    fields: json!({ "targetId": id, "label": label }),
                };
                used.insert(entry.id.clone(), ());
                parent = Some(entry.id.clone());
                forked.adopt_entry(entry);
            }
        }
        forked.rewrite().context("write forked session file")?;
        Ok(forked)
    }

    /// The root-to-`leaf_id` entry path (None when the leaf is unknown).
    /// The root-to-leaf path, guarded against a corrupt parent cycle
    /// (like `SessionFile::branch` and `build_session_context`).
    fn branch_path_entries(&self, leaf_id: &str) -> Option<Vec<SessionEntry>> {
        let mut path = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut current = self.entry(leaf_id).cloned();
        while let Some(entry) = current {
            if !visited.insert(entry.id.clone()) {
                break;
            }
            current = entry
                .parent_id
                .as_deref()
                .and_then(|id| self.entry(id).cloned());
            path.push(entry);
        }
        path.reverse();
        (!path.is_empty()).then_some(path)
    }

    /// Adopt an entry as-is (used by the in-memory fork variant).
    fn adopt_entry(&mut self, entry: SessionEntry) {
        self.by_id.insert(entry.id.clone(), self.entries.len());
        self.leaf_id = Some(entry.id.clone());
        self.entries.push(entry);
    }

    /// In-memory fork (TS non-persisted `createBranchedSession`): replace
    /// this store's entries with the root-to-`leaf_id` path, carrying the
    /// labels of the kept entries.
    ///
    /// # Errors
    ///
    /// Returns an error when the leaf entry does not exist (a `None` id
    /// clears the session and never errors).
    pub fn replace_with_branch(&mut self, leaf_id: Option<&str>) -> Result<()> {
        let path: Vec<SessionEntry> = match leaf_id {
            Some(leaf_id) => self
                .branch_path_entries(leaf_id)
                .ok_or_else(|| anyhow!("Entry {leaf_id} not found"))?,
            None => Vec::new(),
        };
        let labels = LabelState::from_entries(self.entries());
        let path_without_labels: Vec<SessionEntry> = path
            .into_iter()
            .filter(|entry| entry.type_ != "label")
            .collect();
        let path_ids: Vec<String> = path_without_labels
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        self.entries.clear();
        self.by_id.clear();
        self.leaf_id = None;
        for entry in path_without_labels {
            self.adopt_entry(entry);
        }
        let mut parent = self.leaf_id.clone();
        let mut used: HashMap<String, ()> =
            self.entries.iter().map(|e| (e.id.clone(), ())).collect();
        for id in &path_ids {
            if let Some(label) = labels.labels.get(id) {
                let entry = SessionEntry {
                    type_: "label".to_string(),
                    id: new_entry_id(&used),
                    parent_id: parent.clone(),
                    timestamp: labels
                        .timestamps
                        .get(id)
                        .cloned()
                        .unwrap_or_else(crate::util::now_iso),
                    fields: json!({ "targetId": id, "label": label }),
                };
                used.insert(entry.id.clone(), ());
                parent = Some(entry.id.clone());
                self.adopt_entry(entry);
            }
        }
        Ok(())
    }
}

/// The `parentSession` of a forked header: the source file's path, like TS
/// `persist ? previousSessionFile : undefined` (empty for an in-memory
/// session).
fn parent_session_of(store: &SessionFile) -> Option<&str> {
    (!store.path.as_os_str().is_empty())
        .then(|| store.path.to_str())
        .flatten()
}

/// Extract the plain text of a user-message entry (TS
/// `_extractUserMessageText` over string or text-block content).
pub fn user_entry_text(entry: &SessionEntry) -> Option<String> {
    if entry.type_ != "message" {
        return None;
    }
    let message = entry.fields.get("message")?;
    if message_role(message) != Some("user") {
        return None;
    }
    Some(message_text(message))
}

/// The typed-entry form of one store entry (None when it does not
/// round-trip; unknown kinds still parse as `FileEntry::Unknown`).
pub fn entry_as_file_entry(entry: &SessionEntry) -> Option<FileEntry> {
    serde_json::to_value(entry)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// The serialized wire form of one store entry (`set_session_entry_label`
/// responses and the flat-tree node `entry` field).
pub fn entry_json(entry: &SessionEntry) -> Value {
    serde_json::to_value(entry).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_entry(store: &mut SessionFile, role: &str, text: &str) -> String {
        store.append_message(json!({
            "role": role,
            "content": text,
            "timestamp": 0,
        }))
    }

    fn temp_store() -> (tempfile::TempDir, SessionFile) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SessionFile::create("/w", None, 0);
        store.set_path(dir.path().join("s.jsonl"));
        (dir, store)
    }

    #[test]
    fn flat_tree_carries_labels() {
        let (_dir, mut store) = temp_store();
        let a = message_entry(&mut store, "user", "first");
        message_entry(&mut store, "assistant", "answer");
        store.append_label_change(&a, Some("checkpoint")).unwrap();
        let flat = flat_tree(&store);
        assert_eq!(flat.len(), store.entries().len());
        let labeled = flat
            .iter()
            .find(|node| node.get("label").is_some())
            .expect("labeled node");
        assert_eq!(labeled["label"], json!("checkpoint"));
        assert_eq!(labeled["entry"]["id"], json!(a));
    }

    #[test]
    fn labels_last_write_wins_and_clears() {
        let (_dir, mut store) = temp_store();
        let a = message_entry(&mut store, "user", "first");
        store.append_label_change(&a, Some("one")).unwrap();
        store.append_label_change(&a, Some("two")).unwrap();
        store.append_label_change(&a, None).unwrap();
        let state = LabelState::from_entries(store.entries());
        assert_eq!(state.labels.get(&a), None);
    }

    #[test]
    fn user_messages_for_forking_lists_texted_user_messages() {
        let (_dir, mut store) = temp_store();
        let first = message_entry(&mut store, "user", "first prompt");
        message_entry(&mut store, "assistant", "answer");
        let second = message_entry(&mut store, "user", "second prompt");
        let messages = user_messages_for_forking(&store);
        let ids: Vec<&str> = messages
            .iter()
            .filter_map(|m| m.get("entryId").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec![first.as_str(), second.as_str()]);
        assert_eq!(messages[0]["text"], json!("first prompt"));
    }

    #[test]
    fn branch_to_moves_leaf_and_validates() {
        let (_dir, mut store) = temp_store();
        let a = message_entry(&mut store, "user", "first");
        let b = message_entry(&mut store, "assistant", "answer");
        assert_eq!(store.leaf_id(), Some(b.as_str()));
        store.branch_to(Some(&a)).unwrap();
        assert_eq!(store.leaf_id(), Some(a.as_str()));
        let c = message_entry(&mut store, "user", "second");
        let c_entry = store.entry(&c).unwrap();
        assert_eq!(c_entry.parent_id.as_deref(), Some(a.as_str()));
        assert!(store.branch_to(Some("missing")).is_err());
        store.branch_to(None).unwrap();
        assert_eq!(store.leaf_id(), None);
    }

    #[test]
    fn branch_summary_entry_shape() {
        let (_dir, mut store) = temp_store();
        let a = message_entry(&mut store, "user", "first");
        let summary = store
            .append_branch_summary(
                Some(&a),
                "explored",
                Some(json!({"readFiles": []})),
                None,
                None,
                None,
            )
            .unwrap();
        let entry = store.entry(&summary).unwrap();
        assert_eq!(entry.type_, "branch_summary");
        assert_eq!(entry.parent_id.as_deref(), Some(a.as_str()));
        assert_eq!(entry.fields["fromId"], json!(a));
        assert_eq!(entry.fields["summary"], json!("explored"));
        // The summary is the new leaf.
        assert_eq!(store.leaf_id(), Some(summary.as_str()));
    }

    /// A summary served by an auxiliary model (TS #2411) persists its
    /// serving identity on the entry: the per-model cost fold bills the
    /// row on the model that billed it, not the branch timeline.
    #[test]
    fn branch_summary_entry_records_the_serving_model() {
        let (_dir, mut store) = temp_store();
        let a = message_entry(&mut store, "user", "first");
        let summary = store
            .append_branch_summary(
                Some(&a),
                "aux summary",
                None,
                None,
                Some(json!({
                    "input": 50, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 55,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
                })),
                Some(("anthropic", "aux-opus-4")),
            )
            .unwrap();
        let entry = store.entry(&summary).unwrap();
        assert_eq!(entry.fields["provider"], json!("anthropic"));
        assert_eq!(entry.fields["modelId"], json!("aux-opus-4"));
        assert_eq!(entry.fields["usage"]["totalTokens"], json!(55));
    }

    #[test]
    fn fork_file_keeps_path_and_carries_labels() {
        let (dir, mut store) = temp_store();
        let a = message_entry(&mut store, "user", "first");
        let _b = message_entry(&mut store, "assistant", "answer");
        let c = message_entry(&mut store, "user", "second");
        store.append_label_change(&a, Some("mark")).unwrap();
        // Fork from b: the file keeps [a, b] plus the carried label.
        let b = store.branch()[1].id.clone();
        let forked = store.create_branched_file(&b, dir.path()).unwrap();
        assert_ne!(forked.session_id(), store.session_id());
        assert_eq!(
            forked.header.parent_session.as_deref(),
            Some(store.path.to_str().unwrap())
        );
        let types: Vec<&str> = forked.entries().iter().map(|e| e.type_.as_str()).collect();
        assert_eq!(types, vec!["message", "message", "label"]);
        assert_eq!(forked.entries()[2].fields["targetId"], json!(a));
        // Like the TS `_buildIndex`, the leaf is the last entry, including
        // the carried label entry.
        assert_eq!(forked.leaf_id(), Some(forked.entries()[2].id.as_str()));
        assert!(forked.path.exists());
        let _ = c;
    }

    #[test]
    fn replace_with_branch_swaps_in_memory_entries() {
        let (_dir, mut store) = temp_store();
        let a = message_entry(&mut store, "user", "first");
        let b = message_entry(&mut store, "assistant", "answer");
        let _c = message_entry(&mut store, "user", "second");
        store.replace_with_branch(Some(&b)).unwrap();
        assert_eq!(store.entries().len(), 2);
        assert_eq!(store.leaf_id(), Some(b.as_str()));
        let _ = a;
    }

    #[test]
    fn file_entries_round_trip() {
        let (_dir, mut store) = temp_store();
        let _a = message_entry(&mut store, "user", "first");
        let entries = file_entries(&store);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id().unwrap(), _a);
    }
}

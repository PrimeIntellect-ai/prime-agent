//! The write arm (moved with its concern): the in-memory append family,
//! the atomic full-file rewrite, the durable append-with-rewrite-bootstrap
//! persist paths, and the store lease discipline (the leased append arms
//! and the unleased fallback) that serializes writers onto the file.

use super::{
    Context,
    HashMap,
    PathBuf,
    Result,
    Serialize,
    SessionEntry,
    SessionFile,
    SessionHeader,
    Value,
    Write,
    anyhow,
    fs,
    index,
    json,
    new_entry_id,
    write,
};

impl SessionEntry {
    fn new(
        type_: &str,
        parent_id: Option<String>,
        used: &HashMap<String, ()>,
        fields: Value,
        timestamp: &str,
    ) -> Self {
        SessionEntry {
            type_: type_.to_string(),
            id: new_entry_id(used),
            parent_id,
            timestamp: timestamp.to_string(),
            fields,
        }
    }
}

impl SessionFile {
    /// Persist only the newly appended creation records on a resumed file.
    pub(crate) fn persist_appended(&self, start: usize) -> Result<()> {
        let mut bytes = Vec::new();
        for entry in &self.entries[start..] {
            write_line(&mut bytes, entry)?;
        }
        match &self.lease {
            Some(lease) => lease.append(&self.path, &bytes)?,
            None => pa_core::session::window::append_cached(
                &self.path,
                &bytes,
                pa_core::session::window::AppendOwnership::Unleased,
            )?,
        }
        Ok(())
    }

    pub fn append_entry(&mut self, type_: &str, fields: Value) -> String {
        let parent_id = self.leaf_id.clone();
        let mut entry = SessionEntry::new(
            type_,
            parent_id,
            &self.index_map(),
            fields,
            &crate::util::now_iso(),
        );
        if self.window.is_some() {
            entry.id = uuid::Uuid::new_v4().to_string();
        }
        let id = entry.id.clone();
        self.push_index(entry);
        id
    }

    pub fn append_message(&mut self, message: Value) -> String {
        self.append_entry("message", serde_json::json!({ "message": message }))
    }

    pub fn append_session_state(&mut self, status: &str) -> String {
        self.append_entry(
            "session_state",
            serde_json::json!({ "state": { "status": status } }),
        )
    }

    pub fn append_session_info(&mut self, name: &str) -> String {
        self.append_entry("session_info", serde_json::json!({ "name": name.trim() }))
    }

    pub fn append_model_change(&mut self, provider: &str, model_id: &str) -> String {
        self.append_entry(
            "model_change",
            serde_json::json!({ "provider": provider, "modelId": model_id }),
        )
    }

    pub fn append_thinking_level_change(&mut self, level: &str) -> String {
        self.append_entry(
            "thinking_level_change",
            serde_json::json!({ "thinkingLevel": level }),
        )
    }

    /// Write the full file atomically (header + every entry), like `_rewriteFile`.
    ///
    /// # Errors
    ///
    /// Returns an error when the store only holds a window (the full
    /// history is required), or when the session dir, the temp file, the
    /// write, flush, sync, or the final rename fails; an empty path
    /// answers `Ok(())` without writing.
    pub fn rewrite(&self) -> Result<()> {
        anyhow::ensure!(
            self.window.is_none(),
            "full history required before rewriting session"
        );
        let path = self.path.as_path();
        let Some(path) = (if path.as_os_str().is_empty() {
            None
        } else {
            Some(path)
        }) else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create session dir {}", parent.display()))?;
        }
        let temp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
        {
            let file =
                fs::File::create(&temp).with_context(|| format!("create {}", temp.display()))?;
            let mut writer = std::io::BufWriter::new(file);
            write_line(&mut writer, &session_header_line(&self.header))?;
            for entry in &self.entries {
                write_line(&mut writer, entry)?;
            }
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        pa_core::platform::rename_onto(&temp, path)
            .with_context(|| format!("persist {}", path.display()))?;
        Ok(())
    }

    /// Append one entry line to the file, rewriting first when the file is
    /// missing. The entry joins the in-memory index only after its line
    /// reaches the file: a failed write (or rewrite) leaves the store
    /// exactly as it was, so the next append parents to the last entry
    /// the file holds. `sync_data` past the flush only enforces
    /// durability — when it fails the entry stays indexed (a reload of
    /// the file would load it as the leaf) and the error still surfaces.
    ///
    /// # Errors
    ///
    /// Returns an error when the entry cannot be written: the append (or
    /// the rewriting bootstrap on a missing file) fails, or the
    /// post-write durability sync fails — the entry stays indexed and
    /// the error still surfaces.
    pub fn persist_entry(&mut self, entry_type: &str, fields: Value) -> Result<String> {
        self.persist_entry_at(entry_type, fields, &crate::util::now_iso())
    }

    /// Append one entry stamped with the given time. The interrupted-
    /// compaction replay re-stamps the supervisor's declaration, so the
    /// entry's timestamp is the row's stable identity: a replacement that
    /// already persisted the disclosure but died before the supervisor
    /// consumed the record replays the same declaration, and the create
    /// handler recognizes its own row instead of duplicating it.
    ///
    /// # Errors
    ///
    /// Returns an error when the entry cannot be written: the
    /// window-backed file is missing, the entry cannot be serialized, or
    /// the append, the rewriting bootstrap, or the post-write durability
    /// sync fails.
    pub fn persist_entry_at(
        &mut self,
        entry_type: &str,
        fields: Value,
        timestamp: &str,
    ) -> Result<String> {
        anyhow::ensure!(
            self.window.is_none() || self.path.exists(),
            "window-backed session file is missing"
        );
        let mut entry = SessionEntry::new(
            entry_type,
            self.leaf_id.clone(),
            &self.index_map(),
            fields,
            timestamp,
        );
        // A windowed index lacks the pre-window IDs, so the short minted ID
        // could collide with unloaded history; a UUID cannot (same rule as
        // `append_entry`).
        if self.window.is_some() {
            entry.id = uuid::Uuid::new_v4().to_string();
        }
        let id = entry.id.clone();
        if !self.path.as_os_str().is_empty() && self.path.exists() {
            let mut bytes = Vec::new();
            write_line(&mut bytes, &entry)?;
            match &self.lease {
                Some(lease) => lease.append(&self.path, &bytes)?,
                None => pa_core::session::window::append_cached(
                    &self.path,
                    &bytes,
                    pa_core::session::window::AppendOwnership::Unleased,
                )
                .with_context(|| format!("append to {}", self.path.display()))?,
            }
            // The line is in the file now: index it so the in-memory leaf
            // matches what a reload sees (the write left no index state).
            self.push_index(entry);
        } else {
            // The rewrite path serializes the whole index, so the entry must
            // be indexed first; a failed rewrite rolls the index back. The
            // live attribution fold is DEFERRED until the rewrite succeeds —
            // the rolled-back index must leave the target row untouched.
            let previous_leaf = self.leaf_id.clone();
            self.push_index_inner(entry, false);
            if let Err(error) = self.rewrite() {
                self.by_id.remove(&id);
                self.entries.pop();
                self.leaf_id = previous_leaf;
                return Err(error);
            }
            self.fold_attribution_id(&id);
        }
        Ok(id)
    }

    /// Point the session at a concrete file path (after `create`), preserving entries.
    pub fn set_path(&mut self, path: PathBuf) {
        if self.path != path {
            self.lease = None;
        }
        self.path = path;
    }
}

/// The stored first line: the typed header plus the `session` type tag.
///
/// The tag leads the line (TS `SessionHeader` declares `type` first, so the
/// TS session file's first line starts with `{"type":"session",...}`); the
/// JSON map preserves insertion order (the workspace's `serde_json` runs
/// with `preserve_order`), so the tag is rebuilt into the leading slot
/// instead of appended.
#[must_use]
pub fn session_header_line(header: &SessionHeader) -> Value {
    let value = serde_json::to_value(header).unwrap_or(Value::Null);
    let Some(object) = value.as_object() else {
        return json!({ "type": "session" });
    };
    let mut ordered = serde_json::Map::new();
    ordered.insert("type".to_string(), Value::String("session".to_string()));
    ordered.extend(
        object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    Value::Object(ordered)
}

fn write_line<T: Serialize>(writer: &mut impl Write, value: &T) -> Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    writer.write_all(line.as_bytes())?;
    Ok(())
}

//! Stable child-usage identities and recovery of this writer's uncertain intents.
//! Pending rows are frozen before subsequent live folds can change their payloads.

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Seek, Write};

use pa_types::ai::Usage;
use pa_types::session::{AgentMessage, ChildUsageAttributionEntry, ChildUsageOrigin, FileEntry};

use super::SessionManager;
use crate::session_engine::rlm_usage::{
    attribute_child_usage, child_usage_identity_matches, ChildUsageAppendResult,
};

#[cfg(test)]
#[derive(Clone, Copy)]
pub(super) enum WriteFault {
    Partial(usize),
    Sync,
}

impl SessionManager {
    /// Append one immutable attribution identity once, returning the current aggregate.
    /// An error can leave a provisional indexed intent; retries must reuse its ID.
    ///
    /// # Errors
    ///
    /// Returns missing-target, conflicting-identity, recovery, or durability errors.
    pub fn append_child_usage_once(
        &mut self,
        row_id: &str,
        target_id: &str,
        child_usage: Usage,
        origin: Option<ChildUsageOrigin>,
    ) -> io::Result<ChildUsageAppendResult> {
        self.reconcile_child_usage()?;
        let target_index = self.by_id.get(target_id).copied().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing child usage target")
        })?;
        let aggregate = match &self.file_entries[target_index] {
            FileEntry::Message {
                message: AgentMessage::Assistant(message),
                ..
            } => message.usage,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "child usage target is not an assistant",
                ))
            }
        };
        if let Some(&index) = self.by_id.get(row_id) {
            let FileEntry::ChildUsageAttributed { payload, .. } = &self.file_entries[index] else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "attribution ID belongs to another entry",
                ));
            };
            if !child_usage_identity_matches(payload, target_id, child_usage, origin)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "attribution identity changed on retry",
                ));
            }
            self.sync_child_usage()?;
            return Ok(if self.unconfirmed_child_usage.remove(row_id) {
                ChildUsageAppendResult::Created(aggregate)
            } else {
                ChildUsageAppendResult::Existing(aggregate)
            });
        }
        let mut aggregate = aggregate;
        attribute_child_usage(&mut aggregate, &child_usage);
        let mut base = self.next_base()?;
        base.id = Some(row_id.to_owned());
        let entry = FileEntry::ChildUsageAttributed {
            base,
            payload: ChildUsageAttributionEntry {
                target_id: target_id.to_owned(),
                child_usage,
                aggregate_usage: aggregate,
                origin,
            },
        };
        self.file_entries.push(entry.clone());
        let index = self.file_entries.len() - 1;
        self.by_id.insert(row_id.to_owned(), index);
        self.leaf_id = Some(row_id.to_owned());
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let FileEntry::Message {
            message: AgentMessage::Assistant(message),
            ..
        } = &mut self.file_entries[target_index]
        {
            message.usage = aggregate;
        }
        if self.persist && self.session_file.is_some() {
            let bootstrap = self.window.is_none()
                && (!self.flushed
                    || self
                        .session_file
                        .as_ref()
                        .is_some_and(|path| !path.exists()));
            let intents = if bootstrap {
                self.file_entries.clone()
            } else {
                vec![entry]
            };
            // The queue owns the intended leaf before any write can become ambiguous.
            self.pending_child_usage = Some(intents);
            self.unconfirmed_child_usage.insert(row_id.to_owned());
            // Healthy writes never scan old history; strict reconciliation is an error path.
            let result = if bootstrap {
                self.try_rewrite_file()
            } else {
                self.write_child_usage_rows(std::slice::from_ref(&self.file_entries[index].clone()))
            };
            if let Err(error) = result {
                self.recovered_history_ids.insert(row_id.to_owned());
                return Err(error);
            }
            self.pending_child_usage = None;
            self.unconfirmed_child_usage.remove(row_id);
            self.flushed = true;
            if !bootstrap {
                self.notify_persist_listeners();
            }
        }
        Ok(ChildUsageAppendResult::Created(aggregate))
    }

    pub(super) fn retain_deferred_child_usage_row(&mut self, index: usize) {
        if let Some(pending) = &mut self.pending_child_usage {
            let entry = &self.file_entries[index];
            if !pending.iter().any(|row| row.id() == entry.id()) {
                pending.push(entry.clone());
                if let Some(id) = entry.id() {
                    self.recovered_history_ids.insert(id.to_owned());
                }
            }
        }
    }

    /// Caller-supplied history predating a recovered intent must be reloaded.
    pub(super) fn before_history_replacement(&mut self, entries: &[FileEntry]) -> io::Result<()> {
        self.reconcile_child_usage()?;
        for id in &self.recovered_history_ids {
            let supplied = entries.iter().find(|entry| entry.id() == Some(id.as_str()));
            let owned = self.by_id.get(id).map(|&index| &self.file_entries[index]);
            if supplied.is_none()
                || owned.is_none()
                || serde_json::to_value(supplied)? != serde_json::to_value(owned)?
            {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "child usage recovered; reload owned history before replacing it",
                ));
            }
        }
        self.recovered_history_ids.clear();
        Ok(())
    }

    pub(crate) fn reconcile_child_usage(&mut self) -> io::Result<()> {
        let Some(pending) = self.pending_child_usage.clone() else {
            return Ok(());
        };
        let Some(path) = self.session_file.clone() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "pending attribution has no session path",
            ));
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    && matches!(pending.first(), Some(FileEntry::Header { .. })) =>
            {
                let mut content = String::new();
                for entry in &pending {
                    content.push_str(&serde_json::to_string(entry)?);
                    content.push('\n');
                }
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                super::window::invalidate_cache(&path);
                super::persist::atomic_write(&path, &content)?;
                self.finish_child_usage_recovery();
                self.flushed = true;
                self.notify_persist_listeners();
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let (rows, truncate) = strict_rows(&bytes)?;
        if !matches!(rows.first(), Some(FileEntry::Header { header }) if header.id == self.session_id)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "recovery session identity changed",
            ));
        }
        let by_id: HashMap<&str, (usize, &FileEntry)> = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| row.id().map(|id| (id, (index, row))))
            .collect();
        let mut missing = Vec::new();
        let mut last_confirmed: Option<usize> = None;
        for intended in &pending {
            if matches!(intended, FileEntry::Header { .. }) {
                continue;
            }
            let id = intended
                .id()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "intent missing ID"))?;
            if let Some((disk_index, existing)) = by_id.get(id) {
                if !missing.is_empty() || last_confirmed.is_some_and(|index| index >= *disk_index) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "persisted intent order differs from frozen order",
                    ));
                }
                last_confirmed = Some(*disk_index);
                // Compare the same JSON decoding on both sides, including parent and aggregate.
                let expected: serde_json::Value =
                    serde_json::from_str(&serde_json::to_string(intended)?)?;
                let actual: serde_json::Value = serde_json::to_value(existing)?;
                if actual != expected {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "persisted intent differs from frozen row",
                    ));
                }
            } else {
                missing.push(intended.clone());
            }
        }
        super::window::invalidate_cache(&path);
        if let Some(length) = truncate {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_len(length)?;
        }
        if !missing.is_empty() {
            self.write_child_usage_rows(&missing)?;
        }
        self.sync_child_usage()?;
        let leaf = self.leaf_id.clone();
        let mut complete = rows;
        for entry in missing {
            complete.push(serde_json::from_str(&serde_json::to_string(&entry)?)?);
        }
        crate::session::apply_child_usage_attributions(&mut complete);
        self.refresh_has_assistant_entry(&complete);
        self.file_entries = complete;
        self.build_index();
        self.leaf_id = leaf;
        self.window = None;
        self.finish_child_usage_recovery();
        self.flushed = true;
        self.notify_persist_listeners();
        Ok(())
    }

    fn finish_child_usage_recovery(&mut self) {
        self.pending_child_usage = None;
    }

    fn sync_child_usage(&self) -> io::Result<()> {
        if self.persist {
            if let Some(path) = &self.session_file {
                crate::platform::fsync(&std::fs::OpenOptions::new().write(true).open(path)?)?;
            }
        }
        Ok(())
    }

    fn write_child_usage_rows(&mut self, entries: &[FileEntry]) -> io::Result<()> {
        let path = self
            .session_file
            .as_ref()
            .ok_or_else(|| io::Error::other("missing session path"))?;
        let mut bytes = Vec::new();
        for entry in entries {
            serde_json::to_writer(&mut bytes, entry)?;
            bytes.push(b'\n');
        }
        super::window::invalidate_cache(path);
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .append(true)
            .open(path)?;
        if file.metadata()?.len() > 0 {
            let mut tail = [0u8; 1];
            file.seek(std::io::SeekFrom::End(-1))?;
            file.read_exact(&mut tail)?;
            if tail[0] != b'\n' {
                file.write_all(b"\n")?;
            }
        }
        #[cfg(test)]
        if let Some(WriteFault::Partial(length)) = self.child_usage_write_fault {
            self.child_usage_write_fault = None;
            file.write_all(&bytes[..length.min(bytes.len())])?;
            return Err(io::Error::other("injected backend partial write"));
        }
        file.write_all(&bytes)?;
        file.flush()?;
        #[cfg(test)]
        if matches!(self.child_usage_write_fault.take(), Some(WriteFault::Sync)) {
            return Err(io::Error::other(
                "injected backend sync error after complete write",
            ));
        }
        crate::platform::fsync(&file)
    }
}

/// Read raw lines without a permissive loader: only an incomplete final suffix is healable.
pub(super) fn strict_rows(bytes: &[u8]) -> io::Result<(Vec<FileEntry>, Option<u64>)> {
    let mut rows = Vec::new();
    let mut ids = HashSet::new();
    let mut offset = 0usize;
    let chunks: Vec<&[u8]> = bytes.split_inclusive(|byte| *byte == b'\n').collect();
    for (index, chunk) in chunks.iter().enumerate() {
        let line = chunk.strip_suffix(b"\n").unwrap_or(chunk);
        if line.iter().all(u8::is_ascii_whitespace) {
            offset += chunk.len();
            continue;
        }
        let value: serde_json::Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(error)
                if index + 1 == chunks.len()
                    && !chunk.ends_with(b"\n")
                    && (error.is_eof()
                        || std::str::from_utf8(line).err().is_some_and(|error| {
                            error.error_len().is_none()
                                && serde_json::from_slice::<serde_json::Value>(
                                    &line[..error.valid_up_to()],
                                )
                                .is_err_and(|prefix| prefix.is_eof())
                        })) =>
            {
                return Ok((rows, Some(offset as u64)));
            }
            Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        };
        let known_kind = matches!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some(
                "session"
                    | "message"
                    | "thinking_level_change"
                    | "service_tier_change"
                    | "model_change"
                    | "compaction"
                    | "branch_summary"
                    | "custom"
                    | "child_usage_attributed"
                    | "label"
                    | "session_info"
                    | "session_state"
                    | "git_state"
                    | "custom_message"
            )
        );
        let row: FileEntry = serde_json::from_value(value)?;
        if known_kind && matches!(row, FileEntry::Unknown { .. }) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid known durable record",
            ));
        }
        if rows.is_empty() {
            if !matches!(row, FileEntry::Header { .. }) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "session header missing",
                ));
            }
        } else {
            if matches!(row, FileEntry::Header { .. }) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "repeated session header in recovery transcript",
                ));
            }
            let id = row.id().filter(|id| !id.is_empty()).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "durable row missing ID")
            })?;
            if !ids.insert(id.to_owned()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "duplicate durable ID",
                ));
            }
        }
        rows.push(row);
        offset += chunk.len();
    }
    if rows.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "session header missing",
        ));
    }
    Ok((rows, None))
}

#[cfg(test)]
mod tests;

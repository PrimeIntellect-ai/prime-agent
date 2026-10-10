//! Stable attribution identity and recovery of this store's uncertain append intents.
use super::{SessionEntry, SessionFile};
use anyhow::{ensure, Context, Result};
use pa_core::session_engine::rlm_usage::{
    attribute_child_usage, child_usage_identity_matches, ChildUsageAppendResult,
};
use pa_types::{
    ai::Usage,
    session::{ChildUsageAttributionEntry, ChildUsageOrigin},
};
#[cfg(test)]
use std::io::Write;
use std::{collections::HashMap, fs};

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(super) enum AppendFault {
    AfterWrite,
    PartialWrite,
}

impl SessionFile {
    pub(crate) fn append_child_usage_once(
        &mut self,
        row_id: &str,
        target_id: &str,
        child_usage: Usage,
        origin: Option<ChildUsageOrigin>,
    ) -> Result<ChildUsageAppendResult> {
        ensure!(!row_id.is_empty(), "empty child attribution row ID");
        self.recover_child_usage()?;
        if let Some(entry) = self.entry(row_id) {
            ensure!(
                entry.type_ == "child_usage_attributed",
                "attribution ID collision"
            );
            let payload: ChildUsageAttributionEntry = serde_json::from_value(entry.fields.clone())?;
            ensure!(
                child_usage_identity_matches(&payload, target_id, child_usage, origin)?,
                "attribution ID collision"
            );
            if !self.path.as_os_str().is_empty() {
                pa_core::platform::fsync(&fs::OpenOptions::new().write(true).open(&self.path)?)?;
            }
            let aggregate = self.attribution_target_usage(target_id)?;
            return Ok(if self.child_usage_unconfirmed.remove(row_id) {
                ChildUsageAppendResult::Created(aggregate)
            } else {
                ChildUsageAppendResult::Existing(aggregate)
            });
        }
        let mut aggregate = self.attribution_target_usage(target_id)?;
        attribute_child_usage(&mut aggregate, &child_usage);
        let entry = SessionEntry {
            type_: "child_usage_attributed".to_owned(),
            id: row_id.to_owned(),
            parent_id: self.leaf_id.clone(),
            timestamp: crate::util::now_iso(),
            fields: serde_json::to_value(ChildUsageAttributionEntry {
                target_id: target_id.to_owned(),
                child_usage,
                aggregate_usage: aggregate,
                origin,
            })?,
        };
        if !self.path.as_os_str().is_empty() && !self.path.exists() {
            ensure!(
                self.window.is_none(),
                "window-backed session file is missing"
            );
            self.rewrite()?;
        }
        self.push_index(entry.clone());
        if self.path.as_os_str().is_empty() {
            return Ok(ChildUsageAppendResult::Created(aggregate));
        }
        self.child_usage_pending.push(entry.clone());
        self.child_usage_unconfirmed.insert(row_id.to_owned());
        let mut bytes = serde_json::to_vec(&entry)?;
        bytes.push(b'\n');
        pa_core::session::window::invalidate_cache(&self.path);
        self.append_attribution_bytes(&bytes)?;
        self.child_usage_pending.clear();
        self.child_usage_unconfirmed.remove(row_id);
        if let Some(traces) = &self.trace_upload {
            traces.persisted(&self.path);
        }
        Ok(ChildUsageAppendResult::Created(aggregate))
    }

    fn attribution_target_usage(&self, target_id: &str) -> Result<Usage> {
        let message = self
            .entry(target_id)
            .and_then(|entry| entry.fields.get("message"))
            .context("child attribution target is missing")?;
        ensure!(
            message.get("role").and_then(serde_json::Value::as_str) == Some("assistant"),
            "child attribution target is not an assistant"
        );
        Ok(message
            .get("usage")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default())
    }

    fn append_attribution_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        #[cfg(test)]
        if let Some(fault) = self.child_usage_fault.take() {
            let mut file = fs::OpenOptions::new().append(true).open(&self.path)?;
            match fault {
                AppendFault::AfterWrite => file.write_all(bytes)?,
                AppendFault::PartialWrite => file.write_all(&bytes[..bytes.len() / 2])?,
            }
            file.flush()?;
            return Err(std::io::Error::other("injected attribution durability failure").into());
        }
        match &self.lease {
            Some(lease) => lease.append(&self.path, bytes)?,
            None => pa_core::session::window::append_cached(
                &self.path,
                bytes,
                pa_core::session::window::AppendOwnership::Unleased,
            )?,
        }
        Ok(())
    }

    pub(super) fn recover_child_usage(&mut self) -> Result<()> {
        if self.child_usage_pending.is_empty() {
            return Ok(());
        }
        pa_core::session::window::invalidate_cache(&self.path);
        let raw = fs::read(&self.path)?;
        let mut disk = Vec::<SessionEntry>::new();
        let mut by_id = HashMap::<String, usize>::new();
        let mut offset = 0;
        let mut valid_end = 0;
        let mut header_seen = false;
        for line in raw.split_inclusive(|byte| *byte == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                offset += line.len();
                valid_end = offset;
                continue;
            }
            let terminated = line.ends_with(b"\n");
            let value = match serde_json::from_slice::<serde_json::Value>(line) {
                Ok(value) => value,
                Err(error)
                    if !terminated
                        && (error.is_eof()
                            || std::str::from_utf8(line).err().is_some_and(|utf8| {
                                utf8.error_len().is_none()
                                    && serde_json::from_slice::<serde_json::Value>(
                                        &line[..utf8.valid_up_to()],
                                    )
                                    .is_err_and(|prefix| prefix.is_eof())
                            })) =>
                {
                    break
                }
                Err(error) => return Err(error.into()),
            };
            if header_seen {
                // Validate known schemas too: the normal daemon reader intentionally is lenient.
                let typed: pa_types::session::FileEntry = serde_json::from_value(value.clone())?;
                ensure!(
                    !matches!(typed, pa_types::session::FileEntry::Header { .. }),
                    "repeated session header in recovery transcript"
                );
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
                ensure!(
                    !known_kind || !matches!(typed, pa_types::session::FileEntry::Unknown { .. }),
                    "invalid known record in recovery transcript"
                );
                let entry: SessionEntry = serde_json::from_value(value)?;
                ensure!(
                    !entry.id.is_empty(),
                    "empty record ID in recovery transcript"
                );
                ensure!(
                    !by_id.contains_key(&entry.id),
                    "duplicate ID in recovery transcript"
                );
                by_id.insert(entry.id.clone(), disk.len());
                disk.push(entry);
            } else {
                ensure!(
                    value.get("type").and_then(serde_json::Value::as_str) == Some("session"),
                    "invalid recovery header"
                );
                let header: pa_types::session::SessionHeader = serde_json::from_value(value)?;
                ensure!(
                    header.id == self.header.id,
                    "recovery session identity mismatch"
                );
                header_seen = true;
            }
            offset += line.len();
            valid_end = offset;
        }
        ensure!(header_seen, "missing recovery header");
        let mut missing = Vec::new();
        let mut last_confirmed = None;
        for entry in &self.child_usage_pending {
            if let Some(&index) = by_id.get(&entry.id) {
                ensure!(
                    missing.is_empty() && last_confirmed.is_none_or(|previous| previous < index),
                    "uncertain append order conflict"
                );
                last_confirmed = Some(index);
                ensure!(
                    serde_json::to_value(&disk[index])?
                        == serde_json::from_slice::<serde_json::Value>(&serde_json::to_vec(
                            entry
                        )?)?,
                    "uncertain append ID collision"
                );
            } else {
                missing.push(entry.clone());
            }
        }
        // Only a proven incomplete final JSON suffix is removed. Complete EOF records survive.
        let file = fs::OpenOptions::new().write(true).open(&self.path)?;
        if valid_end != raw.len() {
            file.set_len(valid_end as u64)?;
        }
        drop(file);
        let mut bytes = Vec::new();
        if valid_end > 0 && raw[valid_end - 1] != b'\n' && !missing.is_empty() {
            bytes.push(b'\n');
        }
        for entry in &missing {
            serde_json::to_writer(&mut bytes, entry)?;
            bytes.push(b'\n');
        }
        if !bytes.is_empty() {
            self.append_attribution_bytes(&bytes)?;
        }
        pa_core::platform::fsync(&fs::OpenOptions::new().write(true).open(&self.path)?)?;
        // Recover unloaded valid rows without replacing owned leases, trace state or selected branch.
        {
            let leaf = self.leaf_id.clone();
            for entry in &self.entries {
                if !by_id.contains_key(&entry.id) {
                    by_id.insert(entry.id.clone(), disk.len());
                    disk.push(entry.clone());
                }
            }
            super::fold_child_usage_attributions(&mut disk);
            self.entries = disk;
            self.by_id = by_id;
            self.window = None;
            self.leaf_id = leaf;
            self.hydrate_anthropic_warning_flag();
        }
        self.child_usage_pending.clear();
        if let Some(traces) = &self.trace_upload {
            traces.persisted(&self.path);
        }
        Ok(())
    }
}

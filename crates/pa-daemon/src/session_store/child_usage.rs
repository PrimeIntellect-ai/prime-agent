//! The idempotent child-usage attribution append: one durable row per stable
//! row identity, written through the same persist core as every other row.
use super::{SessionEntry, SessionFile};
use anyhow::{ensure, Context, Result};
use pa_core::session_engine::rlm_usage::{
    attribute_child_usage, child_usage_identity_matches, ChildUsageAppendResult,
};
use pa_types::{
    ai::Usage,
    session::{ChildUsageAttributionEntry, ChildUsageOrigin},
};
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

/// Attribution-local recovery state. One write can remain unresolved; recovered
/// creation acknowledgments are bounded by the attribution rows retained by this
/// store and are removed when their own frozen report retries successfully.
/// There is no fixed global cap: the normal emitter owns one frozen failed report
/// per child and stops at its first failed batch. Dropping that owner prematurely
/// can retain its ID until this store is dropped; terminal ownership is separate.
#[derive(Debug, Clone, Default)]
pub(super) struct ChildUsageRecovery {
    pub(super) pending: Option<UnconfirmedChildRow>,
    pub(super) created: HashSet<String>,
}

#[derive(Debug, Clone)]
pub(super) struct UnconfirmedChildRow {
    path: PathBuf,
    header: serde_json::Value,
    header_wire: serde_json::Value,
    identity: Option<(u64, u64)>,
    start: Option<u64>,
    prefix_end: u64,
    prefix_tail: Vec<u8>,
    entry: SessionEntry,
    bytes: Vec<u8>,
}

fn file_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Creation time is a limited replacement anchor, not a unique Windows
        // file ID. Owned path/header/prefix/row checks and the existing managed
        // single-writer lease remain necessary; noncooperative writers are out
        // of this attribution-local recovery contract.
        (metadata.creation_time(), 0)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        (0, 0)
    }
}

/// Compare complete headers with the actual wire tag included. The frozen
/// original and its one wire decode cover reader float normalization without
/// decoding an already loaded header a second time or ignoring extension fields.
fn header_matches_receipt(header: &super::SessionHeader, receipt: &UnconfirmedChildRow) -> bool {
    let actual = super::session_header_line(header);
    actual == receipt.header || actual == receipt.header_wire
}

/// Recovery observation updates the index; confirmation also owns the final
/// durability proof and acknowledgment bookkeeping within the same lease flight.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ChildUsageRecoveryMode {
    Observe,
    Confirm,
}

impl SessionFile {
    /// Append one attribution row once: the row id is the retry identity, so
    /// a re-delivered report finds its own row instead of billing the child
    /// twice. A fresh id persists through [`Self::persist_entry_at`]'s shared
    /// core, the same write-then-index contract every other row gets.
    ///
    /// # Errors
    ///
    /// Returns an error when the row id already names another row, the
    /// immutable identity changed, the target assistant is missing, or the
    /// durable append or its recovery confirmation fails. A complete owned
    /// row may be indexed after an error so later aggregates include it;
    /// acknowledgment still requires a successful durability confirmation.
    pub(crate) fn append_child_usage_once(
        &mut self,
        row_id: &str,
        target_id: &str,
        child_usage: Usage,
        origin: Option<ChildUsageOrigin>,
    ) -> Result<ChildUsageAppendResult> {
        ensure!(!row_id.is_empty(), "attribution ID must not be empty");
        self.confirm_child_usage_write()?;
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
            let current = self.attribution_target_usage(target_id)?;
            return Ok(if self.child_usage_recovery.created.remove(row_id) {
                ChildUsageAppendResult::Created(current)
            } else {
                ChildUsageAppendResult::Existing(current)
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
        // Capture only this owned row, not the transcript. The EOF anchor and
        // existing file identity distinguish an absent attempt from a partial
        // or foreign change. Bootstrap rewrite has no existing append offset.
        let receipt = if self.path.as_os_str().is_empty() {
            None
        } else {
            let header = super::session_header_line(&self.header);
            let header_wire = serde_json::from_slice(&serde_json::to_vec(&header)?)?;
            let mut receipt = UnconfirmedChildRow {
                path: self.path.clone(),
                header,
                header_wire,
                identity: None,
                start: None,
                prefix_end: 0,
                prefix_tail: Vec::new(),
                bytes: serde_json::to_vec(&entry)?,
                entry: entry.clone(),
            };
            receipt.bytes.push(b'\n');
            match std::fs::File::open(&self.path) {
                Ok(mut file) => {
                    let metadata = file.metadata()?;
                    receipt.identity = Some(file_identity(&metadata));
                    receipt.prefix_end = metadata.len();
                    let tail_len = metadata.len().min(16) as usize;
                    file.seek(SeekFrom::End(-(tail_len as i64)))?;
                    receipt.prefix_tail.resize(tail_len, 0);
                    file.read_exact(&mut receipt.prefix_tail)?;
                    receipt.start = Some(
                        metadata.len()
                            + u64::from(
                                metadata.len() > 0 && receipt.prefix_tail.last() != Some(&b'\n'),
                            ),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            Some(receipt)
        };
        if let Err(error) = self.persist_built_entry(entry) {
            self.child_usage_recovery.pending = receipt;
            // A completed own row must affect the next aggregate before this
            // store lock is released, even though its original caller sees Err.
            if let Err(recovery) = self.recover_child_usage_write(ChildUsageRecoveryMode::Observe) {
                return Err(error.context(format!("attribution remains unresolved: {recovery}")));
            }
            return Err(error);
        }
        Ok(ChildUsageAppendResult::Created(aggregate))
    }

    /// Confirm an unresolved own row before another durable mutation or ACK.
    pub(super) fn confirm_child_usage_write(&mut self) -> Result<()> {
        self.recover_child_usage_write(ChildUsageRecoveryMode::Confirm)
    }

    /// Observe only the frozen owned row; no lenient whole-file scan or truncation.
    fn recover_child_usage_write(&mut self, mode: ChildUsageRecoveryMode) -> Result<()> {
        let Some(receipt) = self.child_usage_recovery.pending.clone() else {
            return Ok(());
        };
        let lease = self.lease.clone();
        let path = self.path.clone();
        let observe = || {
            ensure!(
                self.path == receipt.path && header_matches_receipt(&self.header, &receipt),
                "attribution recovery session changed"
            );
            let mut file = match std::fs::OpenOptions::new()
                .read(true)
                .append(true)
                .open(&receipt.path)
            {
                Ok(file) => file,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && receipt.start.is_none() =>
                {
                    self.child_usage_recovery.pending = None;
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };
            let metadata = file.metadata()?;
            if let Some(identity) = receipt.identity {
                ensure!(
                    file_identity(&metadata) == identity,
                    "attribution recovery file replaced"
                );
            }
            let header_line = super::read_first_line_bounded_from(
                &mut file,
                super::SESSION_LIST_HEADER_READ_MAX_BYTES,
            )
            .context("attribution recovery header unreadable")?;
            let header = super::parse_session_header_line(std::str::from_utf8(&header_line)?)
                .context("attribution recovery header invalid")?;
            ensure!(
                header_matches_receipt(&header, &receipt),
                "attribution recovery header changed"
            );
            let start = if let Some(start) = receipt.start {
                ensure!(
                    metadata.len() >= receipt.prefix_end,
                    "attribution recovery prefix shrank"
                );
                file.seek(SeekFrom::Start(
                    receipt.prefix_end - receipt.prefix_tail.len() as u64,
                ))?;
                let mut tail = vec![0; receipt.prefix_tail.len()];
                file.read_exact(&mut tail)?;
                ensure!(
                    tail == receipt.prefix_tail,
                    "attribution recovery prefix changed"
                );
                if start > receipt.prefix_end && metadata.len() >= start {
                    file.seek(SeekFrom::Start(receipt.prefix_end))?;
                    let mut separator = [0];
                    file.read_exact(&mut separator)?;
                    ensure!(
                        separator == *b"\n",
                        "attribution recovery separator changed"
                    );
                }
                if metadata.len() == receipt.prefix_end || metadata.len() == start {
                    self.child_usage_recovery.pending = None;
                    return Ok(());
                }
                start
            } else {
                // The atomic bootstrap's own row must be its exact last line.
                ensure!(
                    metadata.len() >= receipt.bytes.len() as u64,
                    "attribution bootstrap is incomplete"
                );
                metadata.len() - receipt.bytes.len() as u64
            };
            let expected_end = start + receipt.bytes.len() as u64;
            let mut completed_tail = false;
            if metadata.len() < expected_end {
                // Only an append receipt has a proven row start. Bootstrap remains
                // fail-closed rather than guessing which rewritten bytes are missing.
                ensure!(
                    receipt.start.is_some() && metadata.len() > start,
                    "attribution recovery row is incomplete"
                );
                let present = usize::try_from(metadata.len() - start)?;
                file.seek(SeekFrom::Start(start))?;
                let mut partial = vec![0; present];
                file.read_exact(&mut partial)?;
                ensure!(
                    partial.as_slice() == &receipt.bytes[..present],
                    "attribution recovery owned prefix conflicts"
                );
                ensure!(
                    file.metadata()?.len() == metadata.len()
                        && file_identity(&std::fs::metadata(&receipt.path)?)
                            == file_identity(&file.metadata()?),
                    "attribution recovery tail changed before completion"
                );
                #[cfg(test)]
                if super::child_usage_tests::FAIL_CHILD_TAIL_COMPLETION
                    .with(|fault| fault.replace(false))
                {
                    anyhow::bail!("injected owned tail completion IO error");
                }
                // The append-mode descriptor writes only the missing owned bytes;
                // append_cached would insert a newline into this incomplete row.
                file.write_all(&receipt.bytes[present..])?;
                file.flush()?;
                pa_core::platform::fsync(&file)?;
                ensure!(
                    file.metadata()?.len() == expected_end,
                    "attribution recovery tail changed during completion"
                );
                completed_tail = true;
            }
            file.seek(SeekFrom::Start(start))?;
            let mut actual = vec![0; receipt.bytes.len()];
            file.read_exact(&mut actual)?;
            ensure!(
                actual == receipt.bytes,
                "attribution recovery row conflicts"
            );
            file.seek(SeekFrom::End(-1))?;
            let mut tail = [0];
            file.read_exact(&mut tail)?;
            ensure!(
                tail == *b"\n",
                "attribution recovery file has an incomplete tail"
            );
            if completed_tail {
                ensure!(
                    file_identity(&std::fs::metadata(&receipt.path)?)
                        == file_identity(&file.metadata()?),
                    "attribution recovery file changed after completion"
                );
                // The row is now newline-closed. Empty append invalidates the old
                // window certificate without certifying a suffix as a fresh row.
                // Stay within the same lease fence rather than recursively admitting
                // a second mutation while release may already be draining this one.
                let ownership = if self.lease.is_some() {
                    pa_core::session::window::AppendOwnership::SessionLeaseHeld
                } else {
                    pa_core::session::window::AppendOwnership::Unleased
                };
                pa_core::session::window::append_cached(&receipt.path, &[], ownership)?;
                ensure!(
                    file_identity(&std::fs::metadata(&receipt.path)?)
                        == file_identity(&file.metadata()?),
                    "attribution recovery file changed after completion sync"
                );
            }
            // Loading the exact owned JSON can normalize a cost float. Admit the
            // complete frozen object or its complete wire-decoded object, never a
            // fieldwise mixture or an aggregate-only exception.
            let original = serde_json::to_value(&receipt.entry)?;
            let decoded: SessionEntry = serde_json::from_slice(&receipt.bytes)?;
            let decoded = serde_json::to_value(decoded)?;
            if let Some(existing) = self.entry(&receipt.entry.id) {
                let indexed = serde_json::to_value(existing)?;
                ensure!(
                    indexed == original || indexed == decoded,
                    "attribution recovery indexed row conflicts"
                );
            } else {
                // Normally immediate, before any later row can branch from stale state.
                // Hydration may already have installed it; do not steal its selected leaf.
                if self.leaf_id == receipt.entry.parent_id {
                    self.push_index(receipt.entry.clone());
                } else {
                    // A generic in-memory append may have arrived while recovery
                    // could not read the file. Install the physical ordering first,
                    // then merge its unsaved rows without changing the selected leaf.
                    let mut full = Self::open(&receipt.path)?;
                    ensure!(
                        header_matches_receipt(&full.header, &receipt),
                        "attribution recovery snapshot session changed"
                    );
                    let owned = full
                        .entry(&receipt.entry.id)
                        .context("attribution recovery snapshot lost row")?;
                    let indexed = serde_json::to_value(owned)?;
                    ensure!(
                        indexed == original || indexed == decoded,
                        "attribution recovery snapshot row conflicts"
                    );
                    for entry in &self.entries {
                        if !full.by_id.contains_key(&entry.id) {
                            full.push_index(entry.clone());
                        }
                    }
                    full.leaf_id.clone_from(&self.leaf_id);
                    full.lease.clone_from(&self.lease);
                    full.trace_upload.clone_from(&self.trace_upload);
                    full.child_usage_recovery
                        .clone_from(&self.child_usage_recovery);
                    full.anthropic_warning_shown = self.anthropic_warning_shown;
                    *self = full;
                }
            }
            self.child_usage_recovery.created.insert(receipt.entry.id);
            #[cfg(test)]
            if let Some(hook) =
                super::child_usage_tests::AFTER_CHILD_OBSERVE.with(|hook| hook.borrow_mut().take())
            {
                hook();
            }
            if mode == ChildUsageRecoveryMode::Confirm {
                // This proof and sync belong to the already admitted recovery.
                // Release may be draining it; do not start a second admission.
                #[cfg(test)]
                if super::child_usage_tests::FAIL_CHILD_CONFIRM_SYNC
                    .with(|fault| fault.replace(false))
                {
                    anyhow::bail!("injected attribution confirmation sync failure");
                }
                ensure!(
                    file_identity(&std::fs::metadata(&self.path)?)
                        == file_identity(&file.metadata()?),
                    "attribution confirmation file changed before sync"
                );
                if self.lease.is_some() {
                    pa_core::session::window::append_cached(
                        &self.path,
                        &[],
                        pa_core::session::window::AppendOwnership::SessionLeaseHeld,
                    )?;
                } else {
                    pa_core::platform::fsync(&file)?;
                }
                ensure!(
                    file_identity(&std::fs::metadata(&self.path)?)
                        == file_identity(&file.metadata()?),
                    "attribution confirmation file changed"
                );
                self.child_usage_recovery.pending = None;
                if let Some(traces) = &self.trace_upload {
                    traces.persisted(&self.path);
                }
                // Retain Created until its own report receives acknowledgment.
            }
            Ok(())
        };
        match lease {
            Some(lease) => lease.with_owned_mutation(&path, observe),
            None => observe(),
        }
    }

    /// The target assistant row's current usage: the running aggregate, since
    /// each indexed attribution folds its aggregate back into the row.
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
}

//! Append-only recovery journals (ports of command-recovery-journal.ts and
//! worker-recovery-journal.ts).
//!
//! The command journal makes supervisor mutations exactly-once: a received
//! record is durable before dispatch, a missing result after a crash is
//! reported as uncertain and never replayed. The worker journal records the
//! latest busy/operation state per session so a replacement can mark
//! interrupted work instead of guessing.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;

const COMPACT_AFTER_RECORDS: usize = 4096;

pub(crate) fn validate_journal_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => anyhow::ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "worker journal {} is not a regular, non-symlink file",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("inspect {}", path.display())),
    }
    Ok(())
}

/// The privacy contract a keyed (cloud) journal commit demands of its
/// parent: a real (non-symlink) directory, owner-only mode bits where the
/// platform has them, and ownership by the effective user. The checks ride
/// the platform wall (`pa_core::platform::perms`). Platforms without the
/// owner/mode probes FAIL CLOSED — inherited ACLs alone are not an
/// owner-private proof.
///
/// # Errors
///
/// Returns an error when the parent cannot be inspected or violates the
/// contract, or on platforms where privacy cannot be proven.
pub(crate) fn validate_private_journal_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("worker journal has no parent directory")?;
    let metadata = fs::symlink_metadata(parent)?;
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "worker journal parent {} must be a real private directory",
        parent.display()
    );
    #[cfg(unix)]
    {
        if let Some(mode) = pa_core::platform::perms::file_mode(parent) {
            anyhow::ensure!(
                mode == pa_core::platform::perms::PRIVATE_DIR_MODE,
                "worker journal parent {} must have mode 0700",
                parent.display()
            );
        }
        anyhow::ensure!(
            pa_core::platform::perms::owned_by_effective_user(parent),
            "worker journal parent {} must be owned by the current user",
            parent.display()
        );
        Ok(())
    }
    #[cfg(not(unix))]
    Err(anyhow::anyhow!(
        "owner-private cloud journals need a platform-proven private parent; \
         unsupported on this platform until the ACL check is proven"
    ))
}

/// Establish the journal's parent as the PINNED VERIFIED DIRECTORY
/// HANDLE through ONE strict handle-chained walk over the ORIGINAL
/// absolute parent path — establishment and placement certification
/// unified. ZERO MUTATION until verification: every component is
/// opened no-follow (`openat` + `O_NOFOLLOW` + `O_DIRECTORY`, relative
/// to the previous directory's handle) and checked BEFORE anything is
/// created or changed, so an untrusted path is refused with no side
/// effects — no component created, no mode changed, nowhere. Per
/// component: a symlink answers `ELOOP`/`ENOTDIR` and is rejected
/// outright (a symlink's owner can retarget it at will — no sticky or
/// release exception applies); a missing component is created
/// owner-only (`mkdirat`, 0700) RELATIVE TO THE VERIFIED PARENT — a
/// parent certified non-mutable grants nobody the write rights the
/// creation race would need — and re-opened no-follow; an existing
/// component must be owned by the effective user or root and not be
/// group/other-writable unless the sticky bit pins entry ownership
/// (the POSIX `/tmp` contract). The FINAL component alone is tightened
/// to the private mode through ITS verified handle when loose — the
/// only chmod, reachable only after the whole chain passed. The
/// returned handle is the walk's final directory: the certification
/// binds by construction, and every later leaf operation resolves
/// relative to that inode.
///
/// Deployment note: the strict contract now covers the keyed worker
/// journal and the seam inbox too (they share this establishment) —
/// symlinked placements (an NFS/automount HOME, an agent-dir or
/// `WORKER_RECOVERY_JOURNAL` override resolving through a link) FAIL
/// CLOSED. Callers hand over the original absolute path and
/// canonicalize ONLY legitimate platform symlinks (a temp root
/// resolving through `/var`, for example) at the call site —
/// canonicalization is a caller-side affordance for platform paths,
/// never a way to launder an attacker-controlled path: the walk
/// rejects symlink components in whatever path it receives.
///
/// # Errors
///
/// Returns an error when the path is not a normalized absolute path, a
/// component is a symlink, foreign-owned, or attacker-mutable, the
/// created NAME cannot be made durable (the containing directory sync
/// fails), or the final tighten fails.
#[cfg(unix)]
pub(crate) fn establish_private_journal_parent(path: &Path) -> Result<File> {
    establish_private_journal_parent_inner(path, None)
}

#[cfg(unix)]
fn establish_private_journal_parent_inner(
    path: &Path,
    fail_first_mkdir_sync: Option<&std::sync::atomic::AtomicBool>,
) -> Result<File> {
    use std::path::Component;
    let parent = path.parent().context("journal has no parent directory")?;
    anyhow::ensure!(
        parent.is_absolute(),
        "journal placement {} must be an absolute path",
        parent.display()
    );
    // Syntax first, before ANY directory is opened or created: a
    // malformed path (a relative or `..`-bearing input) is refused
    // with zero mutations.
    for component in parent.components() {
        match component {
            Component::Normal(_) | Component::RootDir => {}
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                anyhow::bail!(
                    "journal placement {} must be a normalized absolute path",
                    parent.display()
                );
            }
        }
    }
    let owner = pa_core::platform::perms::effective_uid()
        .context("the effective-uid probe is required for a private journal parent")?;
    let mut current = pa_core::platform::private_fs::open_dir_no_follow(Path::new("/"))
        .context("open the filesystem root")?;
    for component in parent.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                let next =
                    match pa_core::platform::private_fs::open_dir_no_follow_at(&current, name) {
                        Ok(next) => next,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            // Missing component: created owner-only, relative
                            // to the VERIFIED parent — non-mutable, so no
                            // interloper holds the write rights the creation
                            // race would need.
                            pa_core::platform::private_fs::create_dir_private_at(&current, name)
                                .with_context(|| format!("create ancestor {}", name.display()))?;
                            // The created NAME is not durable until its
                            // VERIFIED containing directory is synced — an
                            // acknowledged append must never lose an
                            // ancestor to a crash. Fail closed on the
                            // sync error.
                            if let Some(fail_first_mkdir_sync) = fail_first_mkdir_sync {
                                if fail_first_mkdir_sync.swap(false, Ordering::SeqCst) {
                                    anyhow::bail!("injected ancestor sync failure after mkdirat");
                                }
                            }
                            current
                                .sync_all()
                                .with_context(|| format!("sync ancestor {}", name.display()))?;
                            pa_core::platform::private_fs::open_dir_no_follow_at(&current, name)
                                .with_context(|| format!("open ancestor {}", name.display()))?
                        }
                        Err(error) => {
                            return Err(error)
                                .with_context(|| format!("open ancestor {}", name.display()));
                        }
                    };
                let metadata = next.metadata()?;
                anyhow::ensure!(
                    metadata.uid() == owner || metadata.uid() == 0,
                    "journal ancestor {} must be owned by the current user or root",
                    name.display()
                );
                let mode = metadata.mode();
                anyhow::ensure!(
                    mode & 0o022 == 0 || mode & 0o1000 != 0,
                    "journal ancestor {} is writable by others; the placement is not durable",
                    name.display()
                );
                current = next;
            }
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                anyhow::bail!(
                    "journal placement {} must be a normalized absolute path",
                    parent.display()
                );
            }
        }
    }
    // The final component alone is tightened — through ITS verified
    // handle, reachable only after the whole chain passed.
    if current.metadata()?.mode() & 0o777 != pa_core::platform::perms::PRIVATE_DIR_MODE {
        current
            .set_permissions(std::fs::Permissions::from_mode(
                pa_core::platform::perms::PRIVATE_DIR_MODE,
            ))
            .with_context(|| format!("tighten {}", parent.display()))?;
    }
    Ok(current)
}

/// The test-only entry of [`establish_private_journal_parent`]: the
/// FIRST created-ancestor directory sync fails deterministically when
/// the caller's OWN flag is set — a per-call injector with no
/// process-global state, so no concurrently running test can consume
/// it or be consumed by it.
///
/// # Errors
///
/// Returns the establishment's error, or the injected sync failure.
#[cfg(all(test, unix))]
pub(crate) fn establish_private_journal_parent_injecting(
    path: &Path,
    fail_first_mkdir_sync: &std::sync::atomic::AtomicBool,
) -> Result<File> {
    establish_private_journal_parent_inner(path, Some(fail_first_mkdir_sync))
}

#[cfg(unix)]
use std::sync::atomic::Ordering;

/// The path-based form of [`establish_private_journal_parent`] for callers
/// that do not pin the handle (the keyed worker journal and the seam
/// inbox keep their own append discipline): identical behavior, the
/// verified handle dropped.
///
/// # Errors
///
/// Returns an error when the parent cannot be created, opened, verified,
/// or tightened.
pub(crate) fn ensure_private_journal_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        drop(establish_private_journal_parent(path)?);
    }
    #[cfg(not(unix))]
    {
        let parent = path
            .parent()
            .context("worker journal has no parent directory")?;
        pa_core::platform::perms::create_dir_all_private(parent)?;
    }
    Ok(())
}

/// Move an existing journal file to a fresh, privately created inode when
/// its mode is not the private file mode: the bytes are copied verbatim
/// into a 0600 temp file (synced) and renamed over the path, so a
/// descriptor another user opened against the old loose mode keeps
/// reading only the pre-swap bytes while every later append lands in the
/// private inode. Files written by this version are 0600 from their first
/// write (every journal open uses the private creation mode); this closes
/// the window for journals written by older versions.
///
/// # Errors
///
/// Returns an error when the file cannot be read, copied, synced, or
/// renamed.
#[cfg(unix)]
pub(crate) fn ensure_private_journal_file(path: &Path) -> Result<()> {
    if pa_core::platform::perms::file_mode(path)
        .is_some_and(|mode| mode != pa_core::platform::perms::PRIVATE_FILE_MODE)
    {
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let temp = path.with_extension(format!("jsonl.private-{}", std::process::id()));
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(true);
        pa_core::platform::perms::set_private_mode(&mut options);
        let mut file = options
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        pa_core::platform::rename_onto(&temp, path)
            .with_context(|| format!("persist {}", path.display()))?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}

/// [`append_record`] relative to the pinned parent handle: the leaf is
/// opened with `O_NOFOLLOW` through `openat`, so neither a swapped
/// ancestor nor a replaced leaf can redirect the append. The parent is
/// synced after every append (the keyed append's belt): a newly created
/// leaf's directory entry is otherwise not crash-durable.
///
/// # Errors
///
/// Returns an error when the private open, the serialization, the write,
/// or the sync fails.
#[cfg(unix)]
pub(crate) fn append_record_at(parent: &File, leaf: &str, record: &Value) -> Result<()> {
    let mut file = pa_core::platform::private_fs::open_append_at(parent, leaf)
        .with_context(|| format!("open journal {leaf}"))?;
    let mut line = serde_json::to_string(record)?;
    line.push('\n');
    file.write_all(line.as_bytes())?;
    file.sync_all()?;
    // The keyed append's belt: a freshly created leaf's NAME is not
    // durable until its directory entry is synced.
    parent.sync_all()?;
    Ok(())
}

/// [`rewrite_records`] relative to the pinned parent handle: the temp is
/// created through `openat` (`O_NOFOLLOW`, owner-only) and renamed with
/// `renameat` — no path resolution anywhere in the swap.
///
/// # Errors
///
/// Returns an error when the temp write, the sync, or the rename fails.
#[cfg(unix)]
pub(crate) fn rewrite_records_at(parent: &File, leaf: &str, records: &[Value]) -> Result<()> {
    let temp = format!("{leaf}.tmp-{}", std::process::id());
    {
        let file = pa_core::platform::private_fs::create_replace_at(parent, &temp)
            .with_context(|| format!("create {temp}"))?;
        let mut writer = BufWriter::new(file);
        for record in records {
            let mut line = serde_json::to_string(record)?;
            line.push('\n');
            writer.write_all(line.as_bytes())?;
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
    }
    pa_core::platform::private_fs::rename_at(parent, &temp, leaf)
        .with_context(|| format!("persist {leaf}"))?;
    // Sync the directory entry so the replacement name survives a crash
    // before the old journal can be forgotten.
    parent.sync_all()?;
    Ok(())
}

/// [`ensure_private_journal_file`] relative to the pinned parent handle:
/// a legacy loose leaf moves to a fresh owner-only inode with the read,
/// the temp write, and the rename all resolved through the handle.
///
/// # Errors
///
/// Returns an error when the leaf cannot be inspected, read, copied,
/// synced, or renamed.
#[cfg(unix)]
pub(crate) fn migrate_private_journal_file_at(parent: &File, leaf: &str) -> Result<()> {
    let mut file = match pa_core::platform::private_fs::open_read_at(parent, leaf) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("open {leaf}")),
    };
    if file.metadata()?.mode() & 0o777 == pa_core::platform::perms::PRIVATE_FILE_MODE {
        return Ok(());
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes)?;
    let temp = format!("{leaf}.private-{}", std::process::id());
    let mut copy = pa_core::platform::private_fs::create_replace_at(parent, &temp)
        .with_context(|| format!("create {temp}"))?;
    copy.write_all(&bytes)?;
    copy.sync_all()?;
    pa_core::platform::private_fs::rename_at(parent, &temp, leaf)
        .with_context(|| format!("persist {leaf}"))?;
    parent.sync_all()?;
    Ok(())
}

pub(crate) fn append_record(path: &Path, record: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    pa_core::platform::perms::set_private_mode(&mut options);
    let mut file = options
        .open(path)
        .with_context(|| format!("open journal {}", path.display()))?;
    let mut line = serde_json::to_string(record)?;
    line.push('\n');
    file.write_all(line.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// Append several records as ONE durable write: one open, all lines in one
/// `write_all`, one `fsync`. The records land together or not at all — a
/// batched checkpoint keeps its all-or-nothing shape (the busy verdict
/// never publishes without the queue snapshot it describes), and the
/// journal's on-disk bytes are exactly what the same records appended one
/// by one would produce.
///
/// # Errors
///
/// Returns an error when the parent directory, the open, a serialization,
/// the write, or the sync fails; a partial write may leave truncated
/// trailing lines, which the loader skips like any crash-truncated record.
pub(crate) fn append_records(path: &Path, records: &[Value]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    pa_core::platform::perms::set_private_mode(&mut options);
    let mut file = options
        .open(path)
        .with_context(|| format!("open journal {}", path.display()))?;
    let mut lines = Vec::new();
    for record in records {
        serde_json::to_writer(&mut lines, record)?;
        lines.push(b'\n');
    }
    file.write_all(&lines)?;
    file.sync_all()?;
    Ok(())
}

/// Both rewrite modes sync the temp file before replacing the journal.
/// They differ only in whether destination-busy rename retries.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Finalize {
    /// Rename through `rename_onto`: the bounded win32 destination-busy
    /// retry (TS `writeFileAtomicSync` -> `renameOntoSync`), with the
    /// temp file synced before the swap (TS `fsync: true`).
    RetryBusy,
    /// Bare rename with the temp file synced before the swap: every
    /// failure surfaces immediately. The Rust-native terminal-compaction
    /// journal (no TS counterpart) keeps its belt.
    Synced,
}

pub(crate) fn rewrite_records(path: &Path, records: &[Value], finalize: Finalize) -> Result<()> {
    let temp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
    {
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(true);
        pa_core::platform::perms::set_private_mode(&mut options);
        let file = options
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        let mut writer = BufWriter::new(file);
        for record in records {
            let mut line = serde_json::to_string(record)?;
            line.push('\n');
            writer.write_all(line.as_bytes())?;
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
    }
    let rename = match finalize {
        Finalize::RetryBusy => pa_core::platform::rename_onto(&temp, path),
        Finalize::Synced => fs::rename(&temp, path),
    };
    rename.with_context(|| format!("persist {}", path.display()))?;
    // The replacement file was synced before rename. Sync the directory as
    // well so the replacement name survives a crash before the old journal
    // can be forgotten. This matters for the worker's durable inbox keys.
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandJournalEntry {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<Value>,
}

/// Port of `CommandRecoveryJournal`.
pub struct CommandRecoveryJournal {
    path: std::path::PathBuf,
    entries: HashMap<String, CommandJournalEntry>,
    record_count: usize,
}

impl CommandRecoveryJournal {
    /// Open the journal at `path` (creating the parent directory as needed)
    /// and load the pending receipts from any existing records.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created; a
    /// missing journal loads as empty, and the record load itself never
    /// errors (lines truncated by a crash are skipped).
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut journal = CommandRecoveryJournal {
            path: path.to_path_buf(),
            entries: HashMap::new(),
            record_count: 0,
        };
        journal.load()?;
        Ok(journal)
    }

    fn key(client_id: &str, command_id: &str) -> String {
        serde_json::json!([client_id, command_id]).to_string()
    }

    #[must_use]
    pub fn lookup(&self, client_id: &str, command_id: &str) -> Option<CommandJournalEntry> {
        self.entries.get(&Self::key(client_id, command_id)).cloned()
    }

    /// Record durable receipt before dispatch. Returns the prior state when the
    /// command was already journaled.
    ///
    /// # Errors
    ///
    /// Returns an error when the receipt record cannot be appended (the
    /// parent directory, the journal open, the serialization, the write,
    /// or the sync fails).
    pub fn begin(
        &mut self,
        client_id: &str,
        command_id: &str,
        command_type: &str,
    ) -> Result<Option<CommandJournalEntry>> {
        if let Some(existing) = self.lookup(client_id, command_id) {
            return Ok(Some(existing));
        }
        let record = serde_json::json!({
            "version": 1,
            "type": "received",
            "key": Self::key(client_id, command_id),
            "clientId": client_id,
            "commandId": command_id,
            "commandType": command_type,
            "recordedAt": crate::util::now_iso(),
        });
        append_record(&self.path, &record)?;
        self.record_count += 1;
        self.entries.insert(
            Self::key(client_id, command_id),
            CommandJournalEntry {
                status: "pending".to_string(),
                response: None,
            },
        );
        Ok(None)
    }

    /// Record the settled command result; a later replay of the command
    /// answers from it.
    ///
    /// # Errors
    ///
    /// Returns an error when no receipt was journaled for the command (a
    /// result cannot be recorded first), when the result record cannot be
    /// appended, or when the post-append compaction fails.
    pub fn record_result(
        &mut self,
        client_id: &str,
        command_id: &str,
        response: &Value,
    ) -> Result<()> {
        let key = Self::key(client_id, command_id);
        if !self.entries.contains_key(&key) {
            return Err(anyhow::anyhow!(
                "Cannot record a result before command receipt: {key}"
            ));
        }
        let record = serde_json::json!({
            "version": 1,
            "type": "result",
            "key": key,
            "response": response,
            "recordedAt": crate::util::now_iso(),
        });
        append_record(&self.path, &record)?;
        self.record_count += 1;
        self.entries.insert(
            key,
            CommandJournalEntry {
                status: "complete".to_string(),
                response: Some(response.clone()),
            },
        );
        if self.record_count >= COMPACT_AFTER_RECORDS {
            self.compact()?;
        }
        Ok(())
    }

    /// Acknowledge the command: the durable receipt is no longer needed.
    /// Acknowledging an unknown command is a no-op.
    ///
    /// # Errors
    ///
    /// Returns an error when the acknowledgment record cannot be appended
    /// or the post-acknowledge compaction fails.
    pub fn acknowledge(&mut self, client_id: &str, command_id: &str) -> Result<()> {
        let key = Self::key(client_id, command_id);
        if !self.entries.contains_key(&key) {
            return Ok(());
        }
        let record = serde_json::json!({
            "version": 1,
            "type": "acknowledged",
            "key": key,
            "recordedAt": crate::util::now_iso(),
        });
        append_record(&self.path, &record)?;
        self.entries.remove(&key);
        if self.entries.is_empty() || self.record_count >= COMPACT_AFTER_RECORDS {
            self.compact()?;
        }
        Ok(())
    }

    fn compact(&mut self) -> Result<()> {
        let mut records = Vec::new();
        for (key, entry) in &self.entries {
            let mut received = serde_json::json!({
                "version": 1,
                "type": "received",
                "key": key,
            });
            if let Some(response) = &entry.response {
                received["response"] = response.clone();
            }
            records.push(received);
        }
        rewrite_records(&self.path, &records, Finalize::RetryBusy)?;
        self.record_count = records.len();
        Ok(())
    }

    fn load(&mut self) -> Result<()> {
        let Ok(content) = fs::read_to_string(&self.path) else {
            return Ok(());
        };
        for line in content.lines() {
            if line.is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                // A crash may leave only the final append truncated.
                continue;
            };
            if record.get("version").and_then(Value::as_u64) != Some(1) {
                continue;
            }
            self.record_count += 1;
            let key = record
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match record.get("type").and_then(Value::as_str) {
                Some("received") => {
                    self.entries.insert(
                        key,
                        CommandJournalEntry {
                            status: "pending".to_string(),
                            response: None,
                        },
                    );
                }
                Some("acknowledged") => {
                    self.entries.remove(&key);
                }
                Some("result") => {
                    if let Some(entry) = self.entries.get_mut(&key) {
                        entry.status = "complete".to_string();
                        entry.response = record.get("response").cloned();
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRecoveryRecord {
    pub active_session_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    pub busy: bool,
    pub operation: String,
    pub recorded_at: String,
}

/// One checkpoint transaction record (the cloud-keyed delivery path's
/// durable commit unit): the queue snapshot, the optional busy verdict,
/// and the optional request-id admission riding ONE NDJSON line, sealed
/// with a digest over their canonical JSON. A torn or partial write
/// leaves one unparsable line the scan drops all-or-nothing; a
/// complete-but-corrupted line fails the digest and drops the same way.
/// One line is the whole transaction — a crash can never leave the
/// message visible without its request-id admission, or the admission
/// without the queue row that made it visible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerCheckpointTransactionRecord {
    pub version: u32,
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<WorkerRecoveryRecord>,
    pub snapshot: WorkerQueueSnapshotRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_admission: Option<CloudInboxAdmissionRecord>,
    pub digest: String,
}

/// The record-type tag of a checkpoint transaction line.
const CHECKPOINT_TRANSACTION_RECORD_TYPE: &str = "queue_checkpoint_transaction";
/// The checkpoint-transaction record version.
const CHECKPOINT_TRANSACTION_VERSION: u32 = 1;

/// The transaction digest: sha256 over the canonical JSON of the
/// carried records, so a corrupted-but-parseable line drops instead of
/// replaying half a transaction.
///
/// # Errors
///
/// Returns an error when the records cannot be canonicalized.
fn checkpoint_transaction_digest(
    verdict: Option<&WorkerRecoveryRecord>,
    snapshot: &WorkerQueueSnapshotRecord,
    cloud_admission: Option<&CloudInboxAdmissionRecord>,
) -> Result<String> {
    let payload = serde_json::json!({
        "verdict": verdict,
        "snapshot": snapshot,
        "cloudAdmission": cloud_admission,
    });
    let canonical = pa_types::daemon::cloud::canonical_json(&payload)
        .map_err(|reason| anyhow::anyhow!("canonical JSON: {reason}"))?;
    Ok(Sha256::digest(canonical.as_bytes())
        .iter()
        .fold(String::new(), |mut key, byte| {
            use std::fmt::Write;
            write!(key, "{byte:02x}").expect("write to String");
            key
        }))
}

/// How the journal scan classified the file's unparsable lines: a torn
/// trailing append (repairable by truncation) or mid-file corruption
/// (fail closed — history is never silently dropped).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JournalCorruption {
    /// Every line parses (or the journal is absent).
    Clean,
    /// The unparsable lines form a contiguous run at the end of the
    /// file — the crash-torn tail of one interrupted append. The
    /// repair drops exactly that run and keeps every valid line.
    TornTail,
    /// An unparsable line sits before a valid one: not an interrupted
    /// append but real corruption. The journal fails closed.
    MidFile,
}

/// One classified journal line: a valid record (legacy or
/// transaction-carried) or unparsable.
#[allow(clippy::large_enum_variant)]
enum ScannedLine {
    /// A legacy busy/operation verdict record.
    Verdict(WorkerRecoveryRecord),
    /// A legacy queue-snapshot record.
    Snapshot(WorkerQueueSnapshotRecord),
    /// A legacy cloud inbox admission record.
    Admission(CloudInboxAdmissionRecord),
    /// One checkpoint transaction: its carried records, digest verified.
    Transaction {
        verdict: Option<WorkerRecoveryRecord>,
        snapshot: WorkerQueueSnapshotRecord,
        admission: Option<CloudInboxAdmissionRecord>,
    },
    /// A valid-JSON line of an unknown record type (a future
    /// subsystem's records): skipped, not corruption.
    UnknownType,
    /// A transaction with a version this reader cannot authenticate.
    /// Never skip it: a future transaction could own an admission key.
    UnsupportedVersion,
    /// An unparsable line: torn, glued, or corrupted.
    Malformed,
}

/// The unified ordered journal scan (the one parser every reader goes
/// through): classifies each line once, decomposes checkpoint
/// transactions into the same structures the legacy lines feed, and
/// reports the corruption verdict. The valid original line strings are
/// retained so the torn-tail repair can rewrite the file byte-for-byte
/// without them.
struct JournalScan {
    lines: Vec<ScannedLine>,
    /// The original text of every line that classified as a known valid
    /// record or an unknown type (preserved for the repair rewrite).
    valid_line_text: Vec<String>,
    corruption: JournalCorruption,
}

fn scan_worker_journal(path: &Path) -> Result<JournalScan> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(JournalScan {
                lines: Vec::new(),
                valid_line_text: Vec::new(),
                corruption: JournalCorruption::Clean,
            });
        }
        Err(error) => {
            return Err(anyhow::anyhow!(
                "read worker journal {}: {error}",
                path.display()
            ))
        }
    };
    // Byte-boundary scan: a crash-torn append can end mid multi-byte
    // UTF-8 character, which a whole-file string read would reject
    // BEFORE the tail classification could repair it. Split at the
    // record delimiter boundaries instead; the undelimited trailing
    // fragment is the interrupted append's tail candidate.
    let (complete_lines, undelimited_tail) = split_ndjson_boundaries(&contents);
    let mut lines = Vec::new();
    let mut valid_line_text = Vec::new();
    let mut malformed_seen = false;
    let mut corruption = JournalCorruption::Clean;
    for line in complete_lines {
        if line.is_empty() {
            continue;
        }
        let text = std::str::from_utf8(line).map_err(|error| {
            anyhow::anyhow!(
                "worker journal {} is corrupted mid-file: {error}",
                path.display()
            )
        })?;
        let classified = classify_journal_line(text);
        if matches!(classified, ScannedLine::UnsupportedVersion) {
            corruption = JournalCorruption::MidFile;
        }
        let is_valid = !matches!(
            classified,
            ScannedLine::Malformed | ScannedLine::UnsupportedVersion
        );
        if !is_valid {
            if malformed_seen {
                // A second unparsable line after a valid one: mid-file
                // corruption (an interrupted append tears only the LAST
                // line, never two with a valid line between them).
                corruption = JournalCorruption::MidFile;
            } else {
                malformed_seen = true;
            }
        } else if malformed_seen {
            // A valid line after an unparsable one: the unparsable line
            // was not the torn tail of an interrupted append.
            corruption = JournalCorruption::MidFile;
            malformed_seen = false;
        } else {
            valid_line_text.push(text.to_string());
        }
        lines.push(classified);
    }
    // The undelimited trailing fragment: a complete record that lost
    // only its delimiter byte is KEPT (the repair rewrite re-delimits
    // it — the record is not lost); anything else is the torn tail.
    if let Some(fragment) = undelimited_tail {
        if !fragment.is_empty() {
            let valid = std::str::from_utf8(fragment)
                .ok()
                .filter(|text| !matches!(classify_journal_line(text), ScannedLine::Malformed));
            match valid {
                Some(text) => {
                    if malformed_seen
                        || matches!(classify_journal_line(text), ScannedLine::UnsupportedVersion)
                    {
                        corruption = JournalCorruption::MidFile;
                    } else {
                        // A valid record on an unterminated boundary:
                        // the file needs the delimiter repair before any
                        // append can glue onto it.
                        valid_line_text.push(text.to_string());
                        lines.push(classify_journal_line(text));
                        corruption = JournalCorruption::TornTail;
                    }
                }
                None => {
                    if malformed_seen {
                        corruption = JournalCorruption::MidFile;
                    } else {
                        malformed_seen = true;
                    }
                }
            }
        }
    }
    if corruption == JournalCorruption::Clean && malformed_seen {
        corruption = JournalCorruption::TornTail;
    }
    Ok(JournalScan {
        lines,
        valid_line_text,
        corruption,
    })
}

/// Split raw journal bytes at NDJSON record boundaries: the complete
/// (newline-terminated) line slices and the trailing fragment after the
/// last delimiter (the interrupted append's tail candidate — None when
/// the file ends on a record boundary).
pub(crate) fn split_ndjson_boundaries(contents: &[u8]) -> (Vec<&[u8]>, Option<&[u8]>) {
    let mut complete = Vec::new();
    let mut start = 0;
    for (index, byte) in contents.iter().enumerate() {
        if *byte == b'\n' {
            complete.push(&contents[start..index]);
            start = index + 1;
        }
    }
    let tail = (start < contents.len()).then_some(&contents[start..]);
    (complete, tail)
}

/// Classify one journal line. A `queue_checkpoint_transaction` line is
/// verified against its digest; a digest mismatch reads as malformed
/// (a corrupted transaction replays as nothing, never as half of one).
/// The dispatch is by the line's JSON `type` tag first, so a record of
/// one type carrying another's field names can never misparse as a
/// different record (and the version-1 snapshot's bare-string lanes
/// keep their legacy tolerance, exactly like the old single-purpose
/// parser).
fn classify_journal_line(line: &str) -> ScannedLine {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return ScannedLine::Malformed;
    };
    let Some(record_type) = record.get("type").and_then(Value::as_str) else {
        // Valid JSON without a type tag: the legacy busy/operation
        // verdict record is a bare field shape — anything else is a
        // foreign record the journal does not own.
        return match serde_json::from_value::<WorkerRecoveryRecord>(record) {
            Ok(verdict) => ScannedLine::Verdict(verdict),
            Err(_) => ScannedLine::UnknownType,
        };
    };
    match record_type {
        CHECKPOINT_TRANSACTION_RECORD_TYPE => {
            let Ok(transaction) =
                serde_json::from_value::<WorkerCheckpointTransactionRecord>(record)
            else {
                return ScannedLine::Malformed;
            };
            if transaction.version != CHECKPOINT_TRANSACTION_VERSION {
                // A future format might carry admission keys we cannot
                // verify. Fail closed instead of skipping its evidence.
                return ScannedLine::UnsupportedVersion;
            }
            if checkpoint_transaction_digest(
                transaction.verdict.as_ref(),
                &transaction.snapshot,
                transaction.cloud_admission.as_ref(),
            )
            .is_ok_and(|digest| digest == transaction.digest)
            {
                return ScannedLine::Transaction {
                    verdict: transaction.verdict,
                    snapshot: transaction.snapshot,
                    admission: transaction.cloud_admission,
                };
            }
            // A transaction of OUR version that fails its own seal
            // replays as nothing: half a transaction is never a
            // transaction.
            ScannedLine::Malformed
        }
        QUEUE_SNAPSHOT_RECORD_TYPE => {
            let version = record.get("version").and_then(Value::as_u64);
            if version != Some(1) && version != Some(u64::from(QUEUE_SNAPSHOT_VERSION)) {
                return ScannedLine::UnknownType;
            }
            let Some(active_session_id) = record.get("active_session_id").and_then(Value::as_str)
            else {
                return ScannedLine::UnknownType;
            };
            ScannedLine::Snapshot(WorkerQueueSnapshotRecord {
                version: QUEUE_SNAPSHOT_VERSION,
                r#type: QUEUE_SNAPSHOT_RECORD_TYPE.to_string(),
                active_session_id: active_session_id.to_string(),
                steering: parse_snapshot_lane(record.get("steering")),
                follow_up: parse_snapshot_lane(record.get("follow_up")),
                recorded_at: record
                    .get("recorded_at")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        }
        CLOUD_INBOX_RECORD_TYPE => {
            match serde_json::from_value::<CloudInboxAdmissionRecord>(record) {
                Ok(admission) if admission.version == CLOUD_INBOX_VERSION => {
                    ScannedLine::Admission(admission)
                }
                _ => ScannedLine::Malformed,
            }
        }
        // Any other type tag: a foreign record the journal does not
        // own — skipped, not corruption.
        _ => ScannedLine::UnknownType,
    }
}

/// The fold of one journal scan: the per-session busy verdicts, the
/// per-session queue snapshots, and the request-id-keyed cloud inbox
/// with its retention-window order.
struct FoldedJournal {
    latest: HashMap<String, WorkerRecoveryRecord>,
    queue_snapshots: HashMap<String, WorkerQueueSnapshotRecord>,
    cloud_inbox: HashMap<String, Value>,
    cloud_inbox_order: std::collections::VecDeque<String>,
}

/// Fold the scanned lines into the journal's in-memory structures, in
/// file order (the cloud inbox order needs it for the retention window).
fn fold_journal_scan(scan: &JournalScan) -> FoldedJournal {
    let mut latest = HashMap::new();
    let mut queue_snapshots = HashMap::new();
    let mut cloud_inbox = HashMap::new();
    let mut cloud_inbox_order = std::collections::VecDeque::new();
    for line in &scan.lines {
        match line {
            ScannedLine::Verdict(record) => {
                latest.insert(record.active_session_id.clone(), record.clone());
            }
            ScannedLine::Snapshot(record) => {
                queue_snapshots.insert(record.active_session_id.clone(), record.clone());
            }
            ScannedLine::Admission(record) => {
                cloud_inbox_order.push_back(record.request_id.clone());
                cloud_inbox.insert(record.request_id.clone(), record.receipt.clone());
            }
            ScannedLine::Transaction {
                verdict,
                snapshot,
                admission,
            } => {
                if let Some(verdict) = verdict {
                    latest.insert(verdict.active_session_id.clone(), verdict.clone());
                }
                queue_snapshots.insert(snapshot.active_session_id.clone(), snapshot.clone());
                if let Some(admission) = admission {
                    cloud_inbox_order.push_back(admission.request_id.clone());
                    cloud_inbox.insert(admission.request_id.clone(), admission.receipt.clone());
                }
            }
            ScannedLine::UnknownType | ScannedLine::UnsupportedVersion | ScannedLine::Malformed => {
            }
        }
    }
    while cloud_inbox_order.len() > CLOUD_INBOX_WINDOW {
        if let Some(oldest) = cloud_inbox_order.pop_front() {
            cloud_inbox.remove(&oldest);
        }
    }
    FoldedJournal {
        latest,
        queue_snapshots,
        cloud_inbox,
        cloud_inbox_order,
    }
}

/// One parked queue row in a worker queue snapshot: the delivery payload a
/// respawned worker needs — the message text, the labeled preview, the
/// injected custom row, the queue key, and the visibility flag — so a
/// restored queued heartbeat still delivers as the `heartbeat_prompt`
/// component (and keeps its `Heartbeat prompt:` row) instead of
/// collapsing into a plain user message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkerQueueItemRecord {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<crate::worker::QueuePriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_message: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_key: Option<String>,
    #[serde(default = "queue_visible_default")]
    pub queue_visible: bool,
    /// The item's turn-execution class ("queued"/"injected"/"direct", see
    /// `worker::TurnPolicy)`: the batch gathering's compatibility gate. A
    /// record written before the field existed restores as "queued" — the
    /// dominant lane class, and the only one a fresh snapshot can batch.
    #[serde(default = "queue_policy_default")]
    pub policy: String,
}

fn queue_visible_default() -> bool {
    true
}

fn queue_policy_default() -> String {
    "queued".to_string()
}

impl WorkerQueueItemRecord {
    /// The record's turn-execution class; an unknown value restores as
    /// the dominant "queued" class.
    pub(crate) fn policy(&self) -> crate::worker::TurnPolicy {
        match self.policy.as_str() {
            "injected" => crate::worker::TurnPolicy::Injected,
            "direct" => crate::worker::TurnPolicy::Direct,
            _ => crate::worker::TurnPolicy::Queued,
        }
    }
}

/// A worker queue snapshot record: the pending steering/follow-up lanes so a
/// respawned worker restores its queues. Lives in the worker recovery journal
/// (TS keeps its session files free of daemon bookkeeping; queue recovery is
/// worker-private state, so it rides the journal next to the busy records).
/// Version 2 lanes carry the full item records; a version-1 lane (written
/// before the item payload existed) is a bare message-text array and
/// restores as a plain row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerQueueSnapshotRecord {
    pub version: u32,
    pub r#type: String,
    pub active_session_id: String,
    pub steering: Vec<WorkerQueueItemRecord>,
    pub follow_up: Vec<WorkerQueueItemRecord>,
    pub recorded_at: String,
}

/// One request-id-keyed cloud inbox admission: the receipt the receiver
/// answered when a cross-boundary agent message became visible in this
/// session's inbox, durably recorded in the SAME flush as the queue
/// snapshot that made it visible (a crash can never split "visible" from
/// "admitted", so an idempotent replay answers this receipt instead of
/// enqueueing a second visible message). The family exchange keys
/// deliveries by the guest request id; the dedupe window matches the
/// request outbox's record cap so every replayable request finds its
/// admission.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudInboxAdmissionRecord {
    pub version: u32,
    pub r#type: String,
    pub request_id: String,
    pub receipt: Value,
    pub recorded_at: String,
}

/// The record-type tag of a cloud inbox admission line.
const CLOUD_INBOX_RECORD_TYPE: &str = "cloud_inbox_admission";
/// The cloud-inbox record version.
const CLOUD_INBOX_VERSION: u32 = 1;
/// The newest cloud inbox admissions retained across compaction, aligned
/// with the family request outbox's record cap (`DEFAULT_OUTBOX_RECORDS`)
/// so the largest replay span always finds its receiver admission.
const CLOUD_INBOX_WINDOW: usize = 50_000;

/// Port of `WorkerRecoveryJournal`: latest busy/operation per active session,
/// plus the latest queue snapshot per session, plus the request-id-keyed
/// cloud inbox admissions (the cross-boundary receiver dedupe).
pub struct WorkerRecoveryJournal {
    path: std::path::PathBuf,
    latest: HashMap<String, WorkerRecoveryRecord>,
    queue_snapshots: HashMap<String, WorkerQueueSnapshotRecord>,
    cloud_inbox: HashMap<String, Value>,
    cloud_inbox_order: std::collections::VecDeque<String>,
    // A failed keyed append might have written complete but UNSYNCED bytes.
    // Never append or compact past them; only a fresh open after a successful
    // sync may replay the file and resolve the pending transaction.
    quarantined: bool,
    // Keep the actual append descriptor alive while this worker is parked.
    pending_sync_fd: Option<File>,
    #[cfg(test)]
    fail_next_cloud_sync: bool,
    #[cfg(test)]
    pub(crate) before_failed_cloud_sync: Option<Box<dyn FnOnce() + Send>>,
}

impl WorkerRecoveryJournal {
    /// Open the worker journal at `path` (creating the parent directory
    /// privately as needed) and load the latest busy records and queue
    /// snapshots.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created, or
    /// when the journal exists but the queue-snapshot pass cannot read it
    /// (a missing journal loads as empty).
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_sync(path, File::sync_all)
    }

    fn open_with_sync(
        path: &Path,
        sync: impl FnOnce(&File) -> std::io::Result<()>,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            pa_core::platform::perms::create_dir_all_private(parent)?;
        }
        validate_journal_file(path)?;
        // A failed append may have left complete bytes in the OS page cache.
        // Sync the journal before trusting ANY bytes on reopen, including a
        // process restart that cannot retain the previous process's fd.
        // A sync failure keeps the worker unopened and unable to reply.
        match File::open(path) {
            Ok(file) => {
                sync(&file).with_context(|| format!("sync {} before replay", path.display()))?;
                validate_journal_file(path)?;
                #[cfg(unix)]
                {
                    File::open(path.parent().context("worker journal has no parent")?)?
                        .sync_all()?;
                    let opened = file.metadata()?;
                    let current = fs::symlink_metadata(path)?;
                    anyhow::ensure!(
                        (opened.dev(), opened.ino()) == (current.dev(), current.ino()),
                        "worker journal {} was replaced during replay sync",
                        path.display()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("open {} before replay", path.display()))
            }
        }
        // The file itself is private from its first write (the creation
        // mode); a journal written by an older version at the umask-default
        // mode moves to a fresh private inode HERE, cutting any descriptor
        // another user opened against the old loose mode.
        #[cfg(unix)]
        ensure_private_journal_file(path)?;
        let scan = scan_worker_journal(path)?;
        let folded = fold_journal_scan(&scan);
        if !folded.cloud_inbox.is_empty() {
            ensure_private_journal_parent(path)?;
            validate_private_journal_parent(path)?;
        }
        // The torn tail of an interrupted append is repaired BEFORE any
        // subsequent append can glue a valid record onto the unparsable
        // fragment (which would strand that record forever): the file is
        // rewritten with exactly its valid lines, byte-for-byte. Mid-file
        // corruption fails closed — the history is never silently
        // dropped.
        match scan.corruption {
            JournalCorruption::Clean => {}
            JournalCorruption::TornTail => {
                repair_journal_tail(path, &scan)?;
            }
            JournalCorruption::MidFile => {
                return Err(anyhow::anyhow!(
                    "worker journal {} is corrupted mid-file; refusing to rewrite history",
                    path.display()
                ));
            }
        }
        Ok(WorkerRecoveryJournal {
            path: path.to_path_buf(),
            latest: folded.latest,
            queue_snapshots: folded.queue_snapshots,
            cloud_inbox: folded.cloud_inbox,
            cloud_inbox_order: folded.cloud_inbox_order,
            quarantined: false,
            pending_sync_fd: None,
            #[cfg(test)]
            fail_next_cloud_sync: false,
            #[cfg(test)]
            before_failed_cloud_sync: None,
        })
    }

    /// The receipt recorded when the cloud inbox admitted `request_id`
    /// (the idempotent duplicate answer), when one exists.
    #[must_use]
    pub fn cloud_inbox_receipt(&self, request_id: &str) -> Option<&Value> {
        self.cloud_inbox.get(request_id)
    }

    #[must_use]
    pub(crate) fn is_quarantined(&self) -> bool {
        self.quarantined || self.pending_sync_fd.is_some()
    }

    #[cfg(test)]
    pub(crate) fn fail_next_cloud_sync(&mut self) {
        self.fail_next_cloud_sync = true;
    }

    fn require_writable(&self) -> Result<()> {
        anyhow::ensure!(
            !self.quarantined,
            "worker journal quarantined after unresolved cloud append"
        );
        Ok(())
    }

    fn append_cloud_transaction(
        &mut self,
        transaction: &WorkerCheckpointTransactionRecord,
    ) -> Result<()> {
        let result = (|| {
            ensure_private_journal_parent(&self.path)?;
            validate_private_journal_parent(&self.path)?;
            validate_journal_file(&self.path)?;
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            pa_core::platform::perms::set_private_mode(&mut options);
            let mut file = options.open(&self.path)?;
            validate_journal_file(&self.path)?;
            #[cfg(unix)]
            {
                let opened = file.metadata()?;
                let current = fs::symlink_metadata(&self.path)?;
                anyhow::ensure!(
                    (opened.dev(), opened.ino()) == (current.dev(), current.ino()),
                    "worker journal {} was replaced before keyed append",
                    self.path.display()
                );
            }
            // Save the descriptor even if write_all or sync fails. Until a
            // fresh process reopens this journal, the same inode must stay
            // reachable; no replacement is allowed while quarantined.
            let mut line = serde_json::to_vec(transaction)?;
            line.push(b'\n');
            if let Err(error) = file.write_all(&line) {
                self.pending_sync_fd = Some(file);
                return Err(error.into());
            }
            #[cfg(test)]
            if std::mem::take(&mut self.fail_next_cloud_sync) {
                if let Some(before_failure) = self.before_failed_cloud_sync.take() {
                    before_failure();
                }
                self.pending_sync_fd = Some(file);
                anyhow::bail!("injected cloud journal fsync failure after complete write");
            }
            if let Err(error) = file.sync_all() {
                self.pending_sync_fd = Some(file);
                return Err(error.into());
            }
            // Even a pre-existing journal path might not have had its
            // directory entry synced before this first keyed admission.
            #[cfg(unix)]
            if let Err(error) =
                File::open(self.path.parent().context("worker journal has no parent")?)?.sync_all()
            {
                self.pending_sync_fd = Some(file);
                return Err(error.into());
            }
            Ok(())
        })();
        if result.is_err() {
            self.quarantined = true;
        }
        result
    }

    /// Read the latest worker record per active session straight from a
    /// journal file.
    ///
    /// # Errors
    ///
    /// Never errors: a missing or unreadable journal reads as an empty
    /// set (the `Result` wrapper keeps the reading seam uniform).
    pub fn read_latest(path: &Path) -> Result<Vec<WorkerRecoveryRecord>> {
        let scan = scan_worker_journal(path)?;
        if scan.corruption == JournalCorruption::MidFile {
            return Err(anyhow::anyhow!(
                "worker journal {} is corrupted mid-file",
                path.display()
            ));
        }
        Ok(fold_journal_scan(&scan).latest.into_values().collect())
    }

    /// Does the journal prove live work at the worker's last exit? A plain
    /// supervisor startup adopts a dead worker only when this holds (a
    /// restart must not mass-revive historical sessions): a latest `busy`
    /// record marks an in-flight turn or an admitted-but-undelivered
    /// prompt/queue lane. An unreadable journal proves nothing —
    /// uncertainty must not revive a session.
    #[must_use]
    pub fn read_interrupted(path: &Path) -> bool {
        Self::read_latest(path).is_ok_and(|records| records.iter().any(|record| record.busy))
    }

    /// The newest `busy` record's `recorded_at`, when the journal proves
    /// live work: the timestamp the boot-revival gate ages the evidence
    /// against (an old busy record is residue of an era that already
    /// ended, not interrupted work this boot must heal). A journal with
    /// no busy record answers `None`.
    #[must_use]
    pub fn latest_busy_recorded_at(path: &Path) -> Option<String> {
        Self::read_latest(path)
            .ok()?
            .iter()
            .filter(|record| record.busy)
            .map(|record| record.recorded_at.clone())
            .max()
    }

    /// Settle every busy session to idle with `operation` (the give-up
    /// belt): a supervisor that gave up on a worker records the verdict
    /// in the same journal a later boot would read as revival evidence —
    /// stale busy evidence must not outlive the give-up that superseded
    /// it, or every boot re-storms the slot the cap already condemned.
    ///
    /// # Errors
    ///
    /// Returns an error when the journal cannot be opened or a settle
    /// record cannot be appended.
    pub fn settle_busy_records(path: &Path, operation: &str) -> Result<()> {
        let mut journal = Self::open(path)?;
        let busy: Vec<WorkerRecoveryRecord> = journal
            .get_latest()
            .into_iter()
            .filter(|record| record.busy)
            .collect();
        for record in busy {
            journal.record(
                &record.active_session_id,
                &record.session_id,
                record.session_file.as_deref(),
                false,
                operation,
            )?;
        }
        Ok(())
    }

    /// Record the latest busy/operation state for an active session; an
    /// unchanged record is skipped.
    ///
    /// # Errors
    ///
    /// Returns an error when the record cannot be serialized or appended,
    /// or when the all-idle compaction fails.
    pub fn record(
        &mut self,
        active_session_id: &str,
        session_id: &str,
        session_file: Option<&str>,
        busy: bool,
        operation: &str,
    ) -> Result<()> {
        self.require_writable()?;
        if let Some(previous) = self.latest.get(active_session_id) {
            if previous.busy == busy
                && previous.operation == operation
                && previous.session_file.as_deref() == session_file
            {
                return Ok(());
            }
        }
        let record = WorkerRecoveryRecord {
            active_session_id: active_session_id.to_string(),
            session_id: session_id.to_string(),
            session_file: session_file.map(str::to_string),
            busy,
            operation: operation.to_string(),
            recorded_at: crate::util::now_iso(),
        };
        append_record(&self.path, &serde_json::to_value(&record)?)?;
        self.latest.insert(active_session_id.to_string(), record);
        // TS parity: the all-idle check includes the just-landed record
        // (TS `record` runs `[...this.latest.values()].every(!busy)`
        // AFTER `set`). Checking before the insert let the session's own
        // busy admission record block its settle's compaction, so a
        // single-session journal never compacted and grew append-only
        // for the session's lifetime; the compaction now fires at every
        // changed-idle record like TS, keeping the file bounded.
        if self.latest.values().all(|entry| !entry.busy) {
            self.compact()?;
        }
        Ok(())
    }

    #[must_use]
    pub fn get_latest(&self) -> Vec<WorkerRecoveryRecord> {
        self.latest.values().cloned().collect()
    }

    /// Persist the pending queue lanes; latest record wins per session.
    ///
    /// # Errors
    ///
    /// Returns an error when the snapshot record cannot be serialized or
    /// appended.
    pub fn record_queue_snapshot(
        &mut self,
        active_session_id: &str,
        steering: &[WorkerQueueItemRecord],
        follow_up: &[WorkerQueueItemRecord],
    ) -> Result<()> {
        self.require_writable()?;
        let record = WorkerQueueSnapshotRecord {
            version: QUEUE_SNAPSHOT_VERSION,
            r#type: QUEUE_SNAPSHOT_RECORD_TYPE.to_string(),
            active_session_id: active_session_id.to_string(),
            steering: steering.to_vec(),
            follow_up: follow_up.to_vec(),
            recorded_at: crate::util::now_iso(),
        };
        append_record(&self.path, &serde_json::to_value(&record)?)?;
        self.queue_snapshots
            .insert(active_session_id.to_string(), record);
        Ok(())
    }

    /// Record the queue snapshot and the busy/operation verdict in ONE
    /// durable append (the queue-checkpoint pair `checkpoint_queue_recovery`
    /// writes): the snapshot line and the verdict line share a single open,
    /// write, and `fsync`, so a checkpoint costs one journal flush instead
    /// of two. The on-disk order matches the sequential form exactly — the
    /// snapshot record first, then the verdict — and the verdict still
    /// never publishes over a snapshot that did not persist (the batch is
    /// all-or-nothing). An unchanged verdict appends the snapshot alone,
    /// like the sequential pair does.
    ///
    /// # Errors
    ///
    /// Returns an error when either record cannot be serialized or the
    /// batched append fails, or when the all-idle compaction fails after a
    /// changed verdict landed.
    #[allow(clippy::too_many_arguments)]
    pub fn record_queue_checkpoint(
        &mut self,
        active_session_id: &str,
        session_id: &str,
        session_file: Option<&str>,
        busy: bool,
        operation: &str,
        steering: &[WorkerQueueItemRecord],
        follow_up: &[WorkerQueueItemRecord],
        cloud_admission: Option<(&str, &Value)>,
    ) -> Result<()> {
        self.require_writable()?;
        let snapshot = WorkerQueueSnapshotRecord {
            version: QUEUE_SNAPSHOT_VERSION,
            r#type: QUEUE_SNAPSHOT_RECORD_TYPE.to_string(),
            active_session_id: active_session_id.to_string(),
            steering: steering.to_vec(),
            follow_up: follow_up.to_vec(),
            recorded_at: crate::util::now_iso(),
        };
        let verdict_unchanged = self.latest.get(active_session_id).is_some_and(|previous| {
            previous.busy == busy
                && previous.operation == operation
                && previous.session_file.as_deref() == session_file
        });
        let record = if verdict_unchanged {
            None
        } else {
            Some(WorkerRecoveryRecord {
                active_session_id: active_session_id.to_string(),
                session_id: session_id.to_string(),
                session_file: session_file.map(str::to_string),
                busy,
                operation: operation.to_string(),
                recorded_at: crate::util::now_iso(),
            })
        };
        let admission = cloud_admission.map(|(request_id, receipt)| CloudInboxAdmissionRecord {
            version: CLOUD_INBOX_VERSION,
            r#type: CLOUD_INBOX_RECORD_TYPE.to_string(),
            request_id: request_id.to_string(),
            receipt: receipt.clone(),
            recorded_at: crate::util::now_iso(),
        });
        // The cloud admission rides ONE digest-sealed transaction line with
        // the queue snapshot and the busy verdict (the commit unit the
        // scan replays all-or-nothing): a crash can never leave the
        // message visible without its request-id admission (a duplicate
        // would re-deliver) or the admission without visibility (the
        // receipt would claim a message that never landed). The unkeyed
        // local path keeps its two-line batch (its pre-existing
        // verdict-ordering tolerance is unchanged).
        if admission.is_some() {
            let transaction = WorkerCheckpointTransactionRecord {
                version: CHECKPOINT_TRANSACTION_VERSION,
                r#type: CHECKPOINT_TRANSACTION_RECORD_TYPE.to_string(),
                verdict: record.clone(),
                snapshot: snapshot.clone(),
                cloud_admission: admission.clone(),
                digest: checkpoint_transaction_digest(
                    record.as_ref(),
                    &snapshot,
                    admission.as_ref(),
                )?,
            };
            self.append_cloud_transaction(&transaction)?;
        } else {
            let mut batch = Vec::with_capacity(2);
            batch.push(serde_json::to_value(&snapshot)?);
            if let Some(record) = &record {
                batch.push(serde_json::to_value(record)?);
            }
            append_records(&self.path, &batch)?;
        }
        if let Some(admission) = admission {
            self.cloud_inbox_order
                .push_back(admission.request_id.clone());
            self.cloud_inbox
                .insert(admission.request_id, admission.receipt);
            while self.cloud_inbox_order.len() > CLOUD_INBOX_WINDOW {
                if let Some(oldest) = self.cloud_inbox_order.pop_front() {
                    self.cloud_inbox.remove(&oldest);
                }
            }
        }
        self.queue_snapshots
            .insert(active_session_id.to_string(), snapshot);
        if let Some(record) = record {
            self.latest.insert(active_session_id.to_string(), record);
            // TS parity (the same post-insert check as `record`): the
            // settle's compaction fires on the all-idle map that includes
            // the just-landed verdict, never blocked by the session's own
            // busy admission record.
            if self.latest.values().all(|entry| !entry.busy) {
                self.compact()?;
            }
        }
        Ok(())
    }

    /// The latest persisted queue rows for `active_session_id`.
    #[must_use]
    pub fn latest_queue_snapshot(
        &self,
        active_session_id: &str,
    ) -> Option<(Vec<WorkerQueueItemRecord>, Vec<WorkerQueueItemRecord>)> {
        self.queue_snapshots
            .get(active_session_id)
            .map(|record| (record.steering.clone(), record.follow_up.clone()))
    }

    /// Read the latest queue snapshot for a session straight from a journal
    /// file (worker restore on a fresh process).
    ///
    /// # Errors
    ///
    /// Returns an error when the journal exists but cannot be read (a
    /// missing journal answers `Ok(None)`).
    pub fn read_queue_snapshot(
        path: &Path,
        active_session_id: &str,
    ) -> Result<Option<(Vec<WorkerQueueItemRecord>, Vec<WorkerQueueItemRecord>)>> {
        let scan = scan_worker_journal(path)?;
        if scan.corruption == JournalCorruption::MidFile {
            return Err(anyhow::anyhow!(
                "worker journal {} is corrupted mid-file",
                path.display()
            ));
        }
        Ok(fold_journal_scan(&scan)
            .queue_snapshots
            .remove(active_session_id)
            .map(|record| (record.steering, record.follow_up)))
    }

    fn compact(&self) -> Result<()> {
        let mut records: Vec<Value> = self
            .latest
            .values()
            .map(serde_json::to_value)
            .collect::<std::result::Result<_, _>>()?;
        let snapshots: Vec<Value> = self
            .queue_snapshots
            .values()
            .map(serde_json::to_value)
            .collect::<std::result::Result<_, _>>()?;
        records.extend(snapshots);
        // The cloud inbox admissions survive compaction (their newest
        // window): a settled journal must never strand a delivered cloud
        // message's dedupe key, or a replayed request would re-deliver a
        // visible message.
        for request_id in &self.cloud_inbox_order {
            if let Some(receipt) = self.cloud_inbox.get(request_id) {
                let admission = CloudInboxAdmissionRecord {
                    version: CLOUD_INBOX_VERSION,
                    r#type: CLOUD_INBOX_RECORD_TYPE.to_string(),
                    request_id: request_id.clone(),
                    receipt: receipt.clone(),
                    recorded_at: crate::util::now_iso(),
                };
                records.push(serde_json::to_value(&admission)?);
            }
        }
        // The compacted replacement must be durable BEFORE it replaces
        // the journal: the file now carries the cloud inbox dedupe keys,
        // so an unsynced rename must never substitute for a synced
        // journal (a crash would lose the keys the appends made
        // durable). TS's bare compact is knowingly deviated from here —
        // the Rust journal's durable-key contract is the reason.
        rewrite_records(&self.path, &records, Finalize::Synced)
    }
}

/// The record-type tag of a queue snapshot line.
const QUEUE_SNAPSHOT_RECORD_TYPE: &str = "queue_snapshot";
/// The current queue-snapshot record version: the lanes carry the full
/// item records.
const QUEUE_SNAPSHOT_VERSION: u32 = 2;

/// The torn-tail repair: rewrite the journal with exactly its valid
/// lines (the original bytes, in order), durably (temp file, fsync,
/// rename), so the next append writes onto a clean record boundary.
///
/// # Errors
/// Returns an error when the rewrite cannot be written or renamed.
fn repair_journal_tail(path: &Path, scan: &JournalScan) -> Result<()> {
    let mut records: Vec<Value> = Vec::with_capacity(scan.valid_line_text.len());
    for line in &scan.valid_line_text {
        // The valid lines are byte-for-byte JSON; re-parse each so the
        // rewrite path stays the one serialization.
        records.push(
            serde_json::from_str::<Value>(line)
                .map_err(|error| anyhow::anyhow!("repair parse: {error}"))?,
        );
    }
    rewrite_records(path, &records, Finalize::Synced)
}

/// One snapshot lane: a version-2 entry is the full item record, while a
/// version-1 entry is the bare message text and restores as a plain row
/// (no preview, no injected custom row — the pre-item payload).
fn parse_snapshot_lane(value: Option<&Value>) -> Vec<WorkerQueueItemRecord> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| match entry {
                    Value::String(message) => Some(WorkerQueueItemRecord {
                        message: message.clone(),
                        priority: None,
                        preview: None,
                        custom_message: None,
                        queue_key: None,
                        queue_visible: true,
                        policy: queue_policy_default(),
                    }),
                    Value::Object(_) => serde_json::from_value(entry.clone()).ok(),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    /// The macOS temp root resolves through /var (a symlink); the strict
    /// no-symlink placement contract requires the ORIGINAL path to be
    /// symlink-free, so the fixtures canonicalize their legitimate temp
    /// roots at the call site (the product keeps no exception).
    fn temp_path_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-daemon-journal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = temp_path_root();
        #[cfg(unix)]
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        dir.join(name)
    }

    #[test]
    fn command_journal_survives_restart_with_uncertainty() {
        let path = temp_path("command-journal.jsonl");
        let mut journal = CommandRecoveryJournal::open(&path).unwrap();
        assert!(journal.begin("client", "c1", "create").unwrap().is_none());
        let response =
            serde_json::json!({"type": "response", "command": "create", "success": true});
        journal.record_result("client", "c1", &response).unwrap();

        let mut reloaded = CommandRecoveryJournal::open(&path).unwrap();
        let entry = reloaded.lookup("client", "c1").unwrap();
        assert_eq!(entry.status, "complete");
        assert_eq!(entry.response, Some(response));

        // Pending (received, no result) is reported but not replayed.
        reloaded.begin("client", "c2", "kill").unwrap();
        let reloaded2 = CommandRecoveryJournal::open(&path).unwrap();
        assert_eq!(reloaded2.lookup("client", "c2").unwrap().status, "pending");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_keeps_latest_per_session() {
        let path = temp_path("worker.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt")
            .unwrap();
        journal.record("s2", "sess2", None, false, "ready").unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), false, "idle")
            .unwrap();
        let latest = WorkerRecoveryJournal::read_latest(&path).unwrap();
        assert_eq!(latest.len(), 2);
        let s1 = latest.iter().find(|r| r.active_session_id == "s1").unwrap();
        assert!(!s1.busy);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_interrupted_evidence_tracks_latest_busy() {
        let path = temp_path("interrupted.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        // Idle sessions prove nothing: no interrupted work to revive.
        journal
            .record("s1", "sess1", None, false, "shutdown")
            .unwrap();
        journal.record("s2", "sess2", None, false, "ready").unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        // One busy session is durable evidence of interrupted work.
        journal
            .record("s2", "sess2", Some("/b.jsonl"), true, "create")
            .unwrap();
        assert!(WorkerRecoveryJournal::read_interrupted(&path));
        // The latest record per session decides: s2 settles back to idle.
        journal
            .record("s2", "sess2", None, false, "shutdown")
            .unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The batched queue checkpoint and the sequential form produce the
    /// same journal: same lines in the same order, same latest records,
    /// same restorable queue snapshots (the `recorded_at` stamps differ only
    /// because the two runs cannot share a clock instant).
    #[test]
    fn worker_journal_batched_checkpoint_matches_sequential_form() {
        let sequential_path = temp_path("sequential.recovery.jsonl");
        let batched_path = temp_path("batched.recovery.jsonl");
        let mut sequential = WorkerRecoveryJournal::open(&sequential_path).unwrap();
        let mut batched = WorkerRecoveryJournal::open(&batched_path).unwrap();
        let item = WorkerQueueItemRecord {
            message: "steer me".to_string(),
            priority: Some(crate::worker::QueuePriority::Human),
            preview: Some("preview".to_string()),
            custom_message: None,
            queue_key: None,
            queue_visible: true,
            policy: queue_policy_default(),
        };
        // Admitted (snapshot + busy verdict), settle (snapshot + idle
        // verdict + compaction), then an unchanged-verdict checkpoint whose
        // snapshot lands alone in both forms.
        sequential
            .record_queue_snapshot("s1", std::slice::from_ref(&item), &[])
            .unwrap();
        sequential
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt_accepted")
            .unwrap();
        sequential.record_queue_snapshot("s1", &[], &[]).unwrap();
        sequential
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        // An unchanged verdict: the snapshot still lands, alone.
        sequential.record_queue_snapshot("s1", &[], &[]).unwrap();
        sequential
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        batched
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                true,
                "prompt_accepted",
                std::slice::from_ref(&item),
                &[],
                None,
            )
            .unwrap();
        batched
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                false,
                "turn_end",
                &[],
                &[],
                None,
            )
            .unwrap();
        batched
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                false,
                "turn_end",
                &[],
                &[],
                None,
            )
            .unwrap();

        let strip_stamps = |path: &std::path::Path| -> Vec<Value> {
            std::fs::read_to_string(path)
                .unwrap()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| {
                    let mut value: Value = serde_json::from_str(line).unwrap();
                    if let Some(object) = value.as_object_mut() {
                        object.remove("recordedAt");
                        object.remove("recorded_at");
                    }
                    value
                })
                .collect()
        };
        assert_eq!(
            strip_stamps(&sequential_path),
            strip_stamps(&batched_path),
            "the batched checkpoint writes the same journal lines as the sequential form"
        );
        let latest_a = sequential.get_latest();
        let latest_b = batched.get_latest();
        assert_eq!(latest_a.len(), latest_b.len());
        assert_eq!(latest_a[0].busy, latest_b[0].busy);
        assert_eq!(latest_a[0].operation, latest_b[0].operation);
        let restored = WorkerRecoveryJournal::read_queue_snapshot(&batched_path, "s1").unwrap();
        assert_eq!(restored, Some((Vec::new(), Vec::new())));
        let _ = fs::remove_dir_all(sequential_path.parent().unwrap());
        let _ = fs::remove_dir_all(batched_path.parent().unwrap());
    }

    /// The busy verdict rides the snapshot's single flush: a checkpoint
    /// whose batched append fails lands NEITHER record (no verdict over an
    /// unpersisted snapshot, and no snapshot without its flush).
    #[test]
    fn worker_journal_batched_checkpoint_is_all_or_nothing() {
        let path = temp_path("allornothing.recovery.jsonl");
        fs::write(&path, "").unwrap();
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal.record("s1", "sess1", None, false, "ready").unwrap();
        // Replace the journal with a directory: every open for append now
        // fails, so the checkpoint cannot land either record.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let result = journal.record_queue_checkpoint(
            "s1",
            "sess1",
            None,
            true,
            "prompt_accepted",
            &[],
            &[],
            None,
        );
        assert!(result.is_err());
        // The in-memory verdict did not advance over the failed append.
        assert!(journal.latest.get("s1").is_some_and(|record| !record.busy));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// TS parity oracle: a single session's settle compacts (the post-
    /// insert all-idle check). The OLD pre-insert check let the session's
    /// own busy admission record block the compaction, so a single-session
    /// journal grew append-only forever; TS compacts at every changed-idle
    /// record and so does the port now.
    #[test]
    fn worker_journal_settle_compacts_single_session() {
        let path = temp_path("settle-compacts.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        // Two busy/idle cycles through the plain `record` path: the first
        // settle compacts to one line, so the second admission starts from
        // a one-line file (two lines mid-flight, one after the settle) —
        // without the settle compaction the file would grow 2 lines per
        // cycle.
        journal
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt_accepted")
            .unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap().lines().count(),
            1,
            "the first settle compacted to the latest record"
        );
        journal
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt_accepted")
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap().lines().count(),
            2,
            "the second admission grows the compacted file"
        );
        journal
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        // The settle compacted: the file holds exactly the latest record.
        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 1, "the settle compacts to the latest record");
        let record: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(record["busy"], false);
        assert_eq!(record["operation"], "turn_end");
        // The compacted journal replays the same latest state.
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        let latest = reopened.get_latest();
        assert_eq!(latest.len(), 1);
        assert!(!latest[0].busy);
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The settle through the batched checkpoint compacts to the same
    /// two lines (idle verdict + latest snapshot) and restores the same
    /// queue lanes a pre-compact append-only history would.
    #[test]
    fn worker_journal_batched_settle_compacts_and_restores() {
        let path = temp_path("batched-settle.recovery.jsonl");
        let item = WorkerQueueItemRecord {
            message: "steer me".to_string(),
            priority: Some(crate::worker::QueuePriority::Human),
            preview: Some("preview".to_string()),
            custom_message: None,
            queue_key: None,
            queue_visible: true,
            policy: queue_policy_default(),
        };
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        // Two turns: each admission batch grows the file; each settle
        // compacts it back — without the compaction the second admission
        // would stack on the first turn's history (6 lines by the end).
        journal
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                true,
                "prompt_accepted",
                std::slice::from_ref(&item),
                &[],
                None,
            )
            .unwrap();
        journal
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                false,
                "turn_end",
                &[],
                &[],
                None,
            )
            .unwrap();
        let after_first_settle = fs::read_to_string(&path).unwrap().lines().count();
        journal
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                true,
                "prompt_accepted",
                std::slice::from_ref(&item),
                &[],
                None,
            )
            .unwrap();
        let after_second_admission = fs::read_to_string(&path).unwrap().lines().count();
        journal
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                false,
                "turn_end",
                &[],
                &[],
                None,
            )
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2, "the settle compacts to verdict + snapshot");
        assert_eq!(after_first_settle, 2, "the first settle compacted");
        assert_eq!(
            after_second_admission, 4,
            "the second admission grew the file"
        );
        let verdict: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(verdict["busy"], false);
        assert_eq!(verdict["operation"], "turn_end");
        let snapshot: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(snapshot["type"], "queue_snapshot");
        // the compact keeps the LATEST snapshot per session: the settle's
        // (empty) lanes, not the admission's parked row.
        assert_eq!(snapshot["steering"].as_array().map(Vec::len), Some(0));
        // The reopened journal restores the settled verdict and the
        // settle's (empty) lanes exactly like the append-only history.
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let restored = reopened.latest_queue_snapshot("s1").unwrap();
        assert_eq!(restored.0, Vec::new());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// An unchanged verdict appends the snapshot alone and never compacts
    /// (TS `record` early-returns before its compaction check): the
    /// compaction belongs to changed-idle records only.
    #[test]
    fn worker_journal_unchanged_verdict_does_not_compact() {
        let path = temp_path("unchanged-nocompact.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record_queue_checkpoint("s1", "sess1", None, true, "prompt_accepted", &[], &[], None)
            .unwrap();
        journal
            .record_queue_checkpoint("s1", "sess1", None, false, "turn_end", &[], &[], None)
            .unwrap();
        let lines_after_settle = fs::read_to_string(&path).unwrap().lines().count();
        // The unchanged settle: the snapshot lands, the verdict does not,
        // and no compaction runs (the map never changed).
        journal
            .record_queue_checkpoint("s1", "sess1", None, false, "turn_end", &[], &[], None)
            .unwrap();
        let lines_after_unchanged = fs::read_to_string(&path).unwrap().lines().count();
        assert_eq!(lines_after_unchanged, lines_after_settle + 1);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_missing_or_unreadable_file_is_not_interrupted() {
        let path = temp_path("missing.recovery.jsonl");
        // No journal: no evidence, so no revival on uncertainty.
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        std::fs::write(&path, "not json").unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
    // -----------------------------------------------------------------------
    // Checkpoint transactions (the cloud-keyed delivery's commit unit)
    // -----------------------------------------------------------------------

    /// One full keyed checkpoint: the transaction line carries the
    /// snapshot, the busy verdict, and the cloud admission together, and
    /// the reopen replays all three (the lane restore and the inbox key
    /// land together or not at all).
    /// Unix-only: the keyed (cloud) admission path fails closed off
    /// unix, so its success verifiers run where the path exists.
    #[cfg(unix)]
    #[test]
    fn checkpoint_transaction_replays_snapshot_and_admission_together() {
        let path = temp_path("transaction.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        let receipt = serde_json::json!({
            "id": "agentmsg_tx1",
            "deliveryStatus": "delivered",
            "deliveryMode": "steer",
        });
        journal
            .record_queue_checkpoint(
                "sess-a",
                "sess-a-file",
                None,
                true,
                "steer_queued",
                &[WorkerQueueItemRecord {
                    message: "cloud note".to_string(),
                    priority: None,
                    preview: None,
                    custom_message: None,
                    queue_key: None,
                    queue_visible: true,
                    policy: "injected".to_string(),
                }],
                &[],
                Some(("msgreq_tx1", &receipt)),
            )
            .unwrap();
        let reloaded = WorkerRecoveryJournal::open(&path).unwrap();
        assert_eq!(
            reloaded.cloud_inbox_receipt("msgreq_tx1"),
            Some(&receipt),
            "the admission replays"
        );
        let (steering, _) = crate::worker::restore_queue_snapshot(&reloaded, "sess-a");
        assert_eq!(
            steering.len(),
            1,
            "the queue row replays with the admission"
        );
        assert_eq!(steering[0].message, "cloud note");
        assert!(
            reloaded
                .latest
                .get("sess-a")
                .is_some_and(|record| record.busy),
            "the busy verdict replays"
        );
        // One transaction line on disk, sealed with its digest.
        let content = fs::read_to_string(&path).unwrap();
        let transaction_lines = content
            .lines()
            .filter(|line| line.contains("queue_checkpoint_transaction"))
            .count();
        assert_eq!(transaction_lines, 1, "one transaction line: {content}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A crash-torn transaction append (the last line truncated mid-JSON)
    /// drops the WHOLE transaction — the queue row never replays without
    /// its request-id admission — and the repair truncates the fragment
    /// so the next append cannot glue onto it.
    /// Unix-only: the keyed (cloud) admission path fails closed off
    /// unix, so its success verifiers run where the path exists.
    #[cfg(unix)]
    #[test]
    fn torn_transaction_tail_drops_all_of_it_and_repairs_the_file() {
        let path = temp_path("torn-transaction.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        let receipt = serde_json::json!({ "id": "agentmsg_tx2", "deliveryStatus": "delivered" });
        journal
            .record_queue_checkpoint(
                "sess-b",
                "sess-b-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_tx2", &receipt)),
            )
            .unwrap();
        // The crash: the final append lands only partially.
        let content = fs::read_to_string(&path).unwrap();
        let torn: String = content.lines().last().unwrap().chars().take(40).collect();
        fs::write(&path, &torn).unwrap();
        // The reload: the torn transaction replays as nothing (no
        // snapshot, no key) and the file is repaired (the fragment gone).
        let reloaded = WorkerRecoveryJournal::open(&path).unwrap();
        assert!(
            reloaded.cloud_inbox_receipt("msgreq_tx2").is_none(),
            "a torn transaction never leaves its admission"
        );
        assert!(
            reloaded.latest_queue_snapshot("sess-b").is_none(),
            "a torn transaction never leaves its queue row"
        );
        let repaired = fs::read_to_string(&path).unwrap();
        assert!(
            !repaired.contains(&torn[..20]),
            "the torn fragment was truncated: {repaired}"
        );
        // The next append writes onto the clean boundary and replays.
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record_queue_checkpoint(
                "sess-b",
                "sess-b-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_tx3", &receipt)),
            )
            .unwrap();
        let reloaded = WorkerRecoveryJournal::open(&path).unwrap();
        assert_eq!(
            reloaded.cloud_inbox_receipt("msgreq_tx3"),
            Some(&receipt),
            "the post-repair append replays cleanly"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Unix-only: the keyed (cloud) admission path fails closed off
    /// unix, so its success verifiers run where the path exists.
    #[cfg(unix)]
    #[test]
    fn failed_replay_sync_refuses_readable_admission_then_compaction_keeps_it() {
        let path = temp_path("replay-sync.jsonl");
        let receipt = serde_json::json!({ "id": "agentmsg_sync", "deliveryStatus": "delivered" });
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal.fail_next_cloud_sync();
        assert!(journal
            .record_queue_checkpoint(
                "sess-a",
                "sess-a-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_sync", &receipt)),
            )
            .is_err());
        assert!(journal.is_quarantined());
        assert!(fs::read_to_string(&path).unwrap().contains("msgreq_sync"));
        assert!(journal
            .record("sess-a", "sess-a-file", None, false, "turn_end")
            .is_err());
        let before = fs::read(&path).unwrap();
        // Even a readable complete line is not admissible if the restart
        // cannot successfully sync the journal before replaying it.
        assert!(WorkerRecoveryJournal::open_with_sync(&path, |_| {
            Err(std::io::Error::other("injected reopen fsync failure"))
        })
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        drop(journal);
        let mut reopened = WorkerRecoveryJournal::open(&path).unwrap();
        assert_eq!(reopened.cloud_inbox_receipt("msgreq_sync"), Some(&receipt));
        // Settling all sessions compacts via synced replacement + parent
        // directory sync. The inbox key survives the atomic replacement.
        reopened
            .record("sess-a", "sess-a-file", None, false, "turn_end")
            .unwrap();
        let settled = WorkerRecoveryJournal::open(&path).unwrap();
        assert_eq!(settled.cloud_inbox_receipt("msgreq_sync"), Some(&receipt));
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 3);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// Unix-only: the keyed (cloud) admission path fails closed off
    /// unix, so its success verifiers run where the path exists.
    #[cfg(unix)]
    #[test]
    fn undelimited_transaction_repairs_before_append_and_unknown_version_fails_closed() {
        let path = temp_path("delimiter-version.jsonl");
        let receipt = serde_json::json!({ "id": "agentmsg_v", "deliveryStatus": "delivered" });
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record_queue_checkpoint(
                "sess-a",
                "sess-a-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_v", &receipt)),
            )
            .unwrap();
        let mut bytes = fs::read(&path).unwrap();
        bytes.pop(); // valid complete transaction without newline
        fs::write(&path, bytes).unwrap();
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        assert_eq!(journal.cloud_inbox_receipt("msgreq_v"), Some(&receipt));
        journal
            .record("sess-a", "sess-a-file", None, false, "turn_end")
            .unwrap();
        assert_eq!(
            WorkerRecoveryJournal::open(&path)
                .unwrap()
                .cloud_inbox_receipt("msgreq_v"),
            Some(&receipt)
        );
        // Compaction has replaced the original transaction. Append another
        // keyed checkpoint to test a future-format transaction.
        journal
            .record_queue_checkpoint(
                "sess-a",
                "sess-a-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_v2", &receipt)),
            )
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let last = content.lines().last().unwrap();
        let mut value: Value = serde_json::from_str(last).unwrap();
        value["version"] = serde_json::json!(CHECKPOINT_TRANSACTION_VERSION + 1);
        let replaced = content.replacen(last, &serde_json::to_string(&value).unwrap(), 1);
        fs::write(&path, &replaced).unwrap();
        assert!(WorkerRecoveryJournal::open(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), replaced);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn cloud_journal_rejects_a_symlink_parent_and_tightens_a_loose_own_one() {
        let path = temp_path("safe.jsonl");
        let linked = path.with_file_name("linked.jsonl");
        fs::write(&path, "").unwrap();
        std::os::unix::fs::symlink(&path, &linked).unwrap();
        assert!(WorkerRecoveryJournal::open(&linked).is_err());
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        // A loose own parent is tightened and the keyed commit lands; a
        // parent owned by anyone else still fails closed — it cannot be
        // tightened, and privacy is never assumed from it.
        let parent = path.parent().unwrap();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
        journal
            .record_queue_checkpoint(
                "sess-a",
                "sess-a-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_private", &serde_json::json!({"id":"receipt"}))),
            )
            .unwrap();
        assert!(!journal.is_quarantined());
        assert_eq!(
            pa_core::platform::perms::file_mode(parent),
            Some(0o700),
            "the loose own parent is tightened"
        );
        let _ = fs::remove_dir_all(parent);
    }

    /// The regression (the #3164 review): a NORMAL journal parent — the
    /// mode `create_dir_all` produces under the usual umask — must not
    /// quarantine the keyed commit. The first keyed checkpoint against a
    /// plain-created parent tightens it to the private mode and lands;
    /// the restart replays the admission from it.
    #[cfg(unix)]
    #[test]
    fn keyed_commit_tightens_a_normal_parent_instead_of_quarantining() {
        let dir = temp_path_root();
        fs::create_dir_all(&dir).unwrap();
        // The umask-independent normal shape: what create_dir_all makes
        // on the usual 022 umask.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.join("recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record_queue_checkpoint(
                "sess-n",
                "sess-n-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some((
                    "msgreq_normal",
                    &serde_json::json!({"id": "receipt-normal"}),
                )),
            )
            .unwrap_or_else(|error| panic!("keyed commit against a normal parent: {error:#}"));
        assert!(!journal.is_quarantined());
        assert_eq!(
            pa_core::platform::perms::file_mode(&dir),
            Some(0o700),
            "the parent is tightened to the private mode"
        );
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        assert_eq!(
            reopened.cloud_inbox_receipt("msgreq_normal"),
            Some(&serde_json::json!({"id": "receipt-normal"}))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The journal FILE is private from its first write (the review's 0644
    /// window): the unkeyed create lands 0600, and a missing parent chain
    /// is created private at open.
    #[cfg(unix)]
    #[test]
    fn unkeyed_first_write_creates_the_journal_privately() {
        let dir = temp_path_root();
        fs::create_dir_all(&dir).unwrap();
        // The umask-independent normal shape: what create_dir_all makes
        // on the usual 022 umask.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.join("recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("sess-p", "sess-p-file", None, true, "prompt_accepted")
            .unwrap();
        assert_eq!(
            pa_core::platform::perms::file_mode(&path),
            Some(0o600),
            "the journal inode is private from its first write"
        );
        // A missing parent chain is created private.
        let nested_path = dir.join("nested").join("recovery.jsonl");
        let mut nested = WorkerRecoveryJournal::open(&nested_path).unwrap();
        nested
            .record("sess-q", "sess-q-file", None, true, "prompt_accepted")
            .unwrap();
        assert_eq!(
            pa_core::platform::perms::file_mode(&dir.join("nested")),
            Some(0o700),
            "the created parent chain is private"
        );
        assert_eq!(
            pa_core::platform::perms::file_mode(&nested_path),
            Some(0o600)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A journal written by an older version (the umask-default 0644
    /// inode) moves to a fresh private inode at open: the bytes are
    /// preserved verbatim, the mode becomes 0600, the inode changes, and
    /// appends after the swap keep landing in the private inode.
    #[cfg(unix)]
    #[test]
    fn legacy_loose_journal_moves_to_a_fresh_private_inode() {
        let dir = temp_path_root();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("sess-l", "sess-l-file", None, true, "prompt_accepted")
            .unwrap();
        // The old version's shape: the same journal at the umask-default
        // 0644, with another user's descriptor conceptually already open.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        let bytes = fs::read(&path).unwrap();

        let reopened = WorkerRecoveryJournal::open(&path).unwrap();

        let after = fs::symlink_metadata(&path).unwrap();
        assert_ne!(
            (after.dev(), after.ino()),
            (before.dev(), before.ino()),
            "the journal moves to a fresh private inode"
        );
        assert_eq!(pa_core::platform::perms::file_mode(&path), Some(0o600));
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "history is preserved byte-for-byte"
        );
        // The private inode keeps serving: an append after the swap
        // survives a reopen.
        let mut journal = reopened;
        journal
            .record("sess-m", "sess-m-file", None, true, "prompt_accepted")
            .unwrap();
        assert!(
            WorkerRecoveryJournal::read_interrupted(&path),
            "the post-swap append lands and replays"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A symlink parent is rejected BEFORE any chmod: the target of a
    /// same-user symlink keeps its mode, and the keyed commit fails
    /// closed instead (the review's redirect scenario).
    #[cfg(unix)]
    #[test]
    fn keyed_commit_on_a_symlinked_parent_rejects_without_touching_the_target() {
        let root = temp_path_root();
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let mut journal = WorkerRecoveryJournal::open(&link.join("recovery.jsonl")).unwrap();
        journal
            .record_queue_checkpoint(
                "sess-s",
                "sess-s-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_link", &serde_json::json!({"id":"receipt"}))),
            )
            .expect_err("the O_NOFOLLOW open refuses the symlinked parent");
        assert!(journal.is_quarantined());
        assert_eq!(
            pa_core::platform::perms::file_mode(&target),
            Some(0o755),
            "the symlink target is never tightened"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// The keyed worker journal inherits the strict establishment: a
    /// keyed commit under a symlinked placement is refused with the
    /// shared target's mode UNTOUCHED (the deployment note — symlinked
    /// HOME/override placements now fail closed for the keyed path
    /// too).
    #[cfg(unix)]
    #[test]
    fn keyed_establish_refuses_a_symlinked_placement_without_mutation() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_path_root();
        let victim = root.join("victim");
        fs::create_dir_all(&victim).unwrap();
        fs::set_permissions(&victim, fs::Permissions::from_mode(0o755)).unwrap();
        let link = root.join("retargetable");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        let mut journal = WorkerRecoveryJournal::open(&link.join("recovery.jsonl")).unwrap();
        journal
            .record_queue_checkpoint(
                "sess-v",
                "sess-v-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_victim", &serde_json::json!({"id":"receipt"}))),
            )
            .expect_err("the keyed establishment refuses the symlinked placement");
        assert!(journal.is_quarantined());
        assert_eq!(
            pa_core::platform::perms::file_mode(&victim),
            Some(0o755),
            "the shared target's mode is never tightened through the rejected placement"
        );
    }

    /// The first-use durability belt (the reviewer's follow-up): the
    /// created ancestor's NAME is synced in its VERIFIED containing
    /// directory immediately after mkdirat, and a sync failure fails the
    /// establishment closed — no acknowledged append can ever rest on a
    /// non-durable ancestor.
    #[cfg(unix)]
    #[test]
    fn a_failed_ancestor_sync_fails_the_establishment_closed() {
        // The injector is test-LOCAL: only this call can consume it, so
        // no concurrently running test is affected.
        let fail_first_mkdir_sync = std::sync::atomic::AtomicBool::new(true);
        let root = temp_path_root();
        let error = establish_private_journal_parent_injecting(
            &root.join("fresh/nested/recovery.jsonl"),
            &fail_first_mkdir_sync,
        )
        .expect_err("the ancestor sync failure fails closed");
        assert!(
            error.to_string().contains("injected ancestor sync"),
            "the injected sync failure refuses the establishment: {error:#}"
        );
    }

    /// A malformed path (a `..`-bearing input) is refused by the syntax
    /// prevalidation BEFORE any directory is opened or created — zero
    /// mutations on malformed paths.
    #[cfg(unix)]
    #[test]
    fn a_malformed_placement_is_refused_before_any_mutation() {
        let root = temp_path_root();
        let malformed = root.join("created-then-up/../escape/recovery.jsonl");
        let error = establish_private_journal_parent(&malformed)
            .expect_err("a ..-bearing placement is refused");
        assert!(
            error.to_string().contains("normalized absolute path"),
            "the syntax prevalidation refuses first: {error:#}"
        );
        assert!(
            !root.join("created-then-up").exists(),
            "no component is created for a malformed path"
        );
    }

    /// Platforms without the owner/mode probes fail closed: keyed journal
    /// privacy is never assumed from inherited ACLs.
    #[cfg(not(unix))]
    #[test]
    fn keyed_journal_privacy_fails_closed_off_unix() {
        let dir = temp_path_root();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("recovery.jsonl");
        assert!(validate_private_journal_parent(&path).is_err());
        assert!(crate::cloud_family::CloudInboxLog::open(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Mid-file corruption (an unparsable line followed by a valid one)
    /// fails closed: the open refuses, the revival evidence reads as
    /// nothing, and the file is left byte-for-byte alone — history is
    /// never silently dropped.
    #[test]
    fn mid_file_corruption_fails_closed_and_preserves_the_file() {
        let path = temp_path("mid-file.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("sess-c", "sess-c-file", None, true, "prompt_accepted")
            .unwrap();
        let valid = fs::read_to_string(&path).unwrap();
        // The corruption: a bad line, then a valid append after it.
        fs::write(&path, format!("{{this is not json\n{valid}")).unwrap();
        let content_before = fs::read_to_string(&path).unwrap();
        assert!(
            WorkerRecoveryJournal::open(&path).is_err(),
            "mid-file corruption fails closed"
        );
        assert!(
            !WorkerRecoveryJournal::read_interrupted(&path),
            "corrupted evidence proves nothing (uncertainty must not revive)"
        );
        assert!(
            WorkerRecoveryJournal::read_latest(&path).is_err(),
            "the read seam fails closed too"
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            content_before,
            "the corrupted file is never rewritten"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A corrupted-but-parseable transaction line (the digest does not
    /// match its records) replays as nothing — half a transaction is
    /// never a transaction.
    /// Unix-only: the keyed (cloud) admission path fails closed off
    /// unix, so its success verifiers run where the path exists.
    #[cfg(unix)]
    #[test]
    fn a_digest_mismatched_transaction_replays_as_nothing() {
        let path = temp_path("bad-digest.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        let receipt = serde_json::json!({ "id": "agentmsg_tx4", "deliveryStatus": "delivered" });
        journal
            .record_queue_checkpoint(
                "sess-d",
                "sess-d-file",
                None,
                true,
                "steer_queued",
                &[],
                &[],
                Some(("msgreq_tx4", &receipt)),
            )
            .unwrap();
        // Corrupt the digest in place (a complete line, a wrong seal).
        let content = fs::read_to_string(&path).unwrap();
        let corrupted = content.replace("\"digest\":\"", "\"digest\":\"deadbeef");
        assert_ne!(corrupted, content, "the digest must be corruptible");
        fs::write(&path, corrupted).unwrap();
        // The scan drops the whole transaction and repairs the tail.
        let reloaded = WorkerRecoveryJournal::open(&path).unwrap();
        assert!(
            reloaded.cloud_inbox_receipt("msgreq_tx4").is_none(),
            "a mismatched seal never replays its admission"
        );
        assert!(
            reloaded.latest_queue_snapshot("sess-d").is_none(),
            "a mismatched seal never replays its queue row"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}

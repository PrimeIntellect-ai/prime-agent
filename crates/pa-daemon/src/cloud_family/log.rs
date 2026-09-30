//! Durable journals for the cloud family exchange.
//!
//! The request log is the guest-side slice of the TS `DurableCloudEventOutbox`
//! (`event-outbox.ts`): every request is fsync'd to NDJSON before the caller
//! may treat it as admitted, a full log stalls honestly, and a reload skips
//! the crash-truncated tail. The result log is the responder-side durable
//! record of one journaled answer per request id (the durable half of TS
//! `markRemoteRequestProcessed`): a duplicate request re-submits the same
//! answer without re-delivering.
//!
//! Cursor generations and ack-trimming stay with the cloud protocol server
//! port; this slice is append + replay with a fixed generation, bounded by
//! the TS record cap, so an unacked full log stalls exactly like TS.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use pa_types::daemon::cloud::{
    canonical_json, CloudFamilyCommand, CloudFamilyEvent, CloudFamilyEventPayload,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::DEFAULT_OUTBOX_RECORDS;
use crate::util::now_iso;

/// Fixed event-log epoch for this slice (TS starts every outbox at
/// generation 1; epochs advance only on a committed trim).
const GENERATION: u64 = 1;
const EVENTS_FILE: &str = "outbox-events.ndjson";

/// Durable guest-side request log for the family exchange: one canonical
/// NDJSON envelope per request event, fsync'd on append before admission is
/// reported. A crash may leave only the final append truncated; the reload
/// repairs it by dropping the partial line.
#[derive(Debug)]
pub struct FamilyRequestLog {
    session_id: String,
    events: Vec<CloudFamilyEvent>,
    max_records: usize,
    max_event_bytes: usize,
    /// The PINNED VERIFIED parent directory handle: every leaf
    /// operation resolves relative to this inode (openat, `O_NOFOLLOW`),
    /// so a writable ancestor cannot redirect a check that already
    /// passed. Off unix the log never opens (the private-parent
    /// validator fails closed).
    parent: File,
}

impl FamilyRequestLog {
    /// Open (or create) the request log under `directory`, loading and
    /// validating the durable events.
    ///
    /// The parent directory carries a strict private-placement
    /// invariant: a missing chain is created private, a pre-existing
    /// parent owned by the effective user is tightened to 0700 through a
    /// verified handle, and a symlink or foreign-owned parent is
    /// rejected — the envelope stores the message body in plaintext, and
    /// a parent writable by others could redirect the appends.
    /// Platforms without the owner/mode probes FAIL CLOSED (keyed-journal
    /// parity) until the platform ACL proof exists. On unix the validated
    /// parent is PINNED as a verified open directory handle and every
    /// leaf operation below resolves relative to that inode (openat,
    /// `O_NOFOLLOW`): a parent or ancestor swapped after this open
    /// cannot redirect anything.
    ///
    /// # Errors
    ///
    /// Returns an error when the directory cannot be established as
    /// owner-private, the log is corrupt (digest, envelope, or sequence
    /// gap), or the repair write of a crash-truncated tail fails.
    pub fn open(directory: &Path, session_id: &str, max_records: usize) -> Result<Self> {
        #[cfg(unix)]
        {
            let events_path = directory.join(EVENTS_FILE);
            let parent = crate::journal::establish_private_journal_parent(&events_path)?;
            crate::journal::validate_private_journal_parent(&events_path)?;
            let mut log = Self {
                session_id: session_id.to_string(),
                events: Vec::new(),
                max_records,
                max_event_bytes: pa_types::daemon::cloud::CLOUD_MAX_MESSAGE_BYTES,
                parent,
            };
            // Private from its first write (the creation mode below); a
            // file left at the umask-default mode by an older build moves
            // to a fresh private inode HERE, through the pinned handle.
            crate::journal::migrate_private_journal_file_at(&log.parent, EVENTS_FILE)?;
            log.load()?;
            Ok(log)
        }
        #[cfg(not(unix))]
        {
            let events_path = directory.join(EVENTS_FILE);
            crate::journal::validate_private_journal_parent(&events_path)?;
            anyhow::bail!("the request outbox requires a platform-proven private parent")
        }
    }

    /// The pinned verified parent handle: every leaf operation resolves
    /// relative to this inode, so a writable ancestor cannot redirect a
    /// check that already passed. Off unix the family logs never open,
    /// so this accessor fails closed too.
    #[cfg(unix)]
    fn pinned_parent(&self) -> Result<&File> {
        Ok(&self.parent)
    }

    /// Off-unix arm of [`FamilyRequestLog::pinned_parent`]: the family
    /// logs require a platform-proven private parent.
    #[cfg(not(unix))]
    fn pinned_parent(&self) -> Result<&File> {
        anyhow::bail!("the request outbox requires a platform-proven private parent")
    }

    /// Append one request durably: the event is built, canonicalized, size
    /// checked, written, and fsync'd before it is returned. Only after this
    /// returns may a caller treat the request as admitted.
    ///
    /// # Errors
    ///
    /// Returns an error when the log is full (the TS stall), the event is
    /// over the frame bound, or the durable append fails.
    pub fn append(&mut self, payload: CloudFamilyEventPayload) -> Result<CloudFamilyEvent> {
        if self.events.len() >= self.max_records {
            return Err(anyhow!(
                "Cloud event outbox reached {} records",
                self.max_records
            ));
        }
        let sequence = self.tail_sequence() + 1;
        let event = CloudFamilyEvent {
            sequence,
            recorded_at: now_iso(),
            payload,
        };
        let envelope = self.envelope(&event)?;
        if envelope.len() >= self.max_event_bytes {
            return Err(anyhow!(
                "Cloud event exceeds {} bytes",
                self.max_event_bytes
            ));
        }
        let mut line = envelope;
        line.push('\n');
        // The pinned openat append: the leaf resolves relative to the
        // verified parent inode with `O_NOFOLLOW` (a replaced or
        // symlinked leaf refuses the append) and is created owner-only.
        // The parent syncs after every append (the keyed append's belt):
        // a newly created leaf's directory entry is otherwise not
        // crash-durable.
        let parent = self.pinned_parent()?;
        let mut file = pa_core::platform::private_fs::open_append_at(parent, EVENTS_FILE)
            .with_context(|| format!("open {EVENTS_FILE}"))?;
        file.write_all(line.as_bytes())?;
        file.sync_all()?;
        parent.sync_all()?;
        self.events.push(event.clone());
        Ok(event)
    }

    /// The sequence of the newest admitted event (0 when empty).
    #[must_use]
    pub fn tail_sequence(&self) -> u64 {
        self.events.last().map_or(0, |event| event.sequence)
    }

    /// Admitted events after `sequence`, oldest first. A `sequence` beyond
    /// the tail is a cursor error, not an empty batch.
    ///
    /// # Errors
    ///
    /// Returns the TS cursor problem string when `sequence` is beyond the
    /// event tail.
    pub fn events_after(&self, sequence: u64) -> Result<Vec<CloudFamilyEvent>, String> {
        if sequence > self.tail_sequence() {
            return Err("Cloud cursor is beyond the event tail".to_string());
        }
        Ok(self
            .events
            .iter()
            .filter(|event| event.sequence > sequence)
            .cloned()
            .collect())
    }

    /// Number of admitted (untrimmed) events.
    #[must_use]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// True when no event has been admitted.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    fn envelope(&self, event: &CloudFamilyEvent) -> Result<String> {
        let event_value = serde_json::to_value(event)?;
        let canonical = canonical_json(&json!({
            "sessionId": self.session_id,
            "generation": GENERATION,
            "event": event_value,
        }))
        .map_err(|reason| anyhow!("canonical JSON: {reason}"))?;
        let hex =
            Sha256::digest(canonical.as_bytes())
                .iter()
                .fold(String::new(), |mut key, byte| {
                    use std::fmt::Write;
                    write!(key, "{byte:02x}").expect("write to String");
                    key
                });
        canonical_json(&json!({
            "eventId": format!("evt_{hex}"),
            "generation": GENERATION,
            "event": event_value,
        }))
        .map_err(|reason| anyhow!("canonical JSON: {reason}"))
    }

    fn load(&mut self) -> Result<()> {
        let parent = self.pinned_parent()?;
        let content = match pa_core::platform::private_fs::open_read_at(parent, EVENTS_FILE) {
            Ok(mut file) => {
                let mut content = String::new();
                file.read_to_string(&mut content)?;
                content
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A fresh outbox: the empty private file keeps the
                // first-append path uniform (read errors other than a
                // missing file propagate — corruption never truncates).
                // The created entry is synced — a fresh leaf's NAME is
                // not durable until its directory entry is.
                drop(pa_core::platform::private_fs::create_replace_at(
                    parent,
                    EVENTS_FILE,
                )?);
                parent.sync_all()?;
                return Ok(());
            }
            Err(error) => {
                return Err(error).with_context(|| format!("read {EVENTS_FILE}"));
            }
        };
        let mut lines: Vec<&str> = content.split('\n').collect();
        let ended = content.ends_with('\n');
        if lines.last() == Some(&"") {
            lines.pop();
        }
        if !ended && !lines.is_empty() {
            // A crash truncated the final append: drop it and repair the
            // file to the last complete record.
            lines.pop();
            self.rewrite(lines.iter().map(|line| (*line).to_string()).collect())?;
        }
        for (index, line) in lines.iter().enumerate() {
            let record: Value = serde_json::from_str(line)
                .map_err(|_| anyhow!("Cloud event outbox record is corrupt"))?;
            let event_value = record
                .get("event")
                .filter(|event| event.is_object())
                .ok_or_else(|| anyhow!("Cloud event outbox record is corrupt"))?;
            if record.get("generation").and_then(Value::as_u64) != Some(GENERATION) {
                return Err(anyhow!("Cloud event outbox record is corrupt"));
            }
            let event: CloudFamilyEvent = serde_json::from_value(event_value.clone())
                .map_err(|_| anyhow!("Cloud event outbox record has an invalid event"))?;
            let expected = self.envelope(&event)?;
            let stored = canonical_json(&record)
                .map_err(|_| anyhow!("Cloud event outbox record is corrupt"))?;
            if expected != stored {
                return Err(anyhow!("Cloud event outbox record digest is corrupt"));
            }
            if event.sequence != (index as u64) + 1 {
                return Err(anyhow!("Cloud event outbox has a sequence gap"));
            }
            self.events.push(event);
        }
        Ok(())
    }

    /// Rewrite the log with the given canonical envelope lines, durably
    /// (temp file, fsync, rename), repairing a truncated tail in place.
    fn rewrite(&mut self, lines: Vec<String>) -> Result<()> {
        let parent = self.pinned_parent()?;
        let temp = format!("{EVENTS_FILE}.tmp-{}", std::process::id());
        {
            let file = pa_core::platform::private_fs::create_replace_at(parent, &temp)
                .with_context(|| format!("create {temp}"))?;
            let mut writer = BufWriter::new(file);
            for line in &lines {
                writer.write_all(line.as_bytes())?;
                writer.write_all(b"\n")?;
            }
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        pa_core::platform::private_fs::rename_at(parent, &temp, EVENTS_FILE)
            .with_context(|| format!("persist {EVENTS_FILE}"))?;
        parent.sync_all()?;
        Ok(())
    }
}

/// One durably-admitted request slot: the request id plus its journaled
/// answer once one exists.
#[derive(Debug)]
struct ResultSlot {
    request_id: String,
    result: Option<CloudFamilyCommand>,
}

/// The responder's two-phase answer journal (the durable half of TS
/// `markRemoteRequestProcessed` plus the crash-gap fix TS does not have):
///
/// 1. `admit` durably records that a request id is being processed —
///    BEFORE any delivery — so a replay after a crash between delivery and
///    the answer record can never re-deliver.
/// 2. `record` durably records the answer for an admitted request.
///
/// A slot that is admitted without an answer is UNCERTAIN: the request may
/// or may not have been delivered before the crash. The substrate never
/// re-delivers an uncertain request; the wiring layer reconciles it (the
/// receiver is idempotent by request id, or an answer is recorded
/// explicitly via [`CloudFamilyResponder::record_answer`]) and only then
/// does a replay re-submit the answer.
///
/// Both phases are append-only NDJSON with fsync; the newest
/// [`DEFAULT_OUTBOX_RECORDS`] request slots survive. The window matches
/// the request outbox's record cap — the largest replay span — so a
/// replayed request always finds its journal state (TS's dedupe was 256
/// ephemeral in-memory ids, crash-blind; the durable window closes that).
#[derive(Debug)]
pub struct FamilyResultLog {
    slots: VecDeque<ResultSlot>,
    max_remembered: usize,
    /// The journal's leaf name inside its parent (the pinned-relative
    /// operations address it; the path stays for messages).
    leaf: String,
    /// The PINNED VERIFIED parent directory handle: every leaf
    /// operation resolves relative to this inode (openat, `O_NOFOLLOW`),
    /// so a writable ancestor cannot redirect a check that already
    /// passed. Off unix the journal never opens (the private-parent
    /// validator fails closed).
    parent: File,
}

/// What `admit` found on disk for one request id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// This call is the first durable admission: proceed.
    First,
    /// The request is already durably admitted: a duplicate, in flight, or
    /// a crash-gap survivor — never re-deliver.
    Already,
}

impl FamilyResultLog {
    /// Open (or create) the journal at `path`, replaying admitted requests
    /// and their answers. A crash-truncated or malformed tail is skipped,
    /// like the recovery journals.
    ///
    /// The parent directory carries the same strict private-placement
    /// invariant as the request log: a missing chain is created private,
    /// a pre-existing own parent is tightened through a verified handle,
    /// and a symlink or foreign-owned parent is rejected. Platforms
    /// without the owner/mode probes FAIL CLOSED (keyed-journal parity)
    /// until the platform ACL proof exists. On unix the validated parent
    /// is PINNED as a verified open directory handle and every leaf
    /// operation resolves relative to that inode (openat, `O_NOFOLLOW`):
    /// a parent or ancestor swapped after this open cannot redirect
    /// anything.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be established
    /// as owner-private.
    pub fn open(path: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            let parent = crate::journal::establish_private_journal_parent(path)?;
            crate::journal::validate_private_journal_parent(path)?;
            let Some(leaf) = path.file_name().and_then(std::ffi::OsStr::to_str) else {
                anyhow::bail!("the family result journal needs a file name");
            };
            let leaf = leaf.to_string();
            // Private from its first write (the creation mode below); a
            // file left at the umask-default mode by an older build moves
            // to a fresh private inode HERE, through the pinned handle.
            crate::journal::migrate_private_journal_file_at(&parent, &leaf)?;
            // A crash-torn trailing append is repaired before any append
            // can glue onto it (which would strand the record forever);
            // mid-file corruption fails closed — the journal's history
            // is never silently dropped.
            let contents = match pa_core::platform::private_fs::open_read_at(&parent, &leaf) {
                Ok(mut file) => {
                    let mut contents = Vec::new();
                    file.read_to_end(&mut contents)?;
                    contents
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => return Err(error).with_context(|| format!("read {leaf}")),
            };
            let (valid_lines, tail) =
                crate::cloud_family::inbox::parse_journal_lines(&contents, path)?;
            match tail {
                crate::cloud_family::inbox::JournalTail::Clean => {}
                crate::cloud_family::inbox::JournalTail::TornTail => {
                    let mut records = Vec::with_capacity(valid_lines.len());
                    for line in &valid_lines {
                        records.push(
                            serde_json::from_str::<Value>(line)
                                .map_err(|error| anyhow!("repair parse: {error}"))?,
                        );
                    }
                    crate::journal::rewrite_records_at(&parent, &leaf, &records)?;
                }
                crate::cloud_family::inbox::JournalTail::MidFile => {
                    return Err(anyhow!(
                        "family result journal {} is corrupted mid-file; refusing to rewrite history",
                        path.display()
                    ));
                }
            }
            let mut log = Self {
                slots: VecDeque::new(),
                // The dedupe window must cover the largest possible replay
                // span — the request outbox's own record cap — so every
                // replayable request finds its journal state.
                max_remembered: DEFAULT_OUTBOX_RECORDS,
                leaf,
                parent,
            };
            log.load_lines(&valid_lines);
            Ok(log)
        }
        #[cfg(not(unix))]
        {
            crate::journal::validate_private_journal_parent(path)?;
            anyhow::bail!("the family result journal requires a platform-proven private parent")
        }
    }

    /// The pinned verified parent handle: every leaf operation resolves
    /// relative to this inode, so a writable ancestor cannot redirect a
    /// check that already passed. Off unix the family logs never open,
    /// so this accessor fails closed too.
    #[cfg(unix)]
    fn pinned_parent(&self) -> Result<&File> {
        Ok(&self.parent)
    }

    /// Off-unix arm of [`FamilyResultLog::pinned_parent`]: the family
    /// logs require a platform-proven private parent.
    #[cfg(not(unix))]
    fn pinned_parent(&self) -> Result<&File> {
        anyhow::bail!("the family result journal requires a platform-proven private parent")
    }

    /// The journaled answer for `request_id`, newest first.
    #[must_use]
    pub fn result(&self, request_id: &str) -> Option<CloudFamilyCommand> {
        self.slots
            .iter()
            .rev()
            .find(|slot| slot.request_id == request_id)
            .and_then(|slot| slot.result.clone())
    }

    /// Durably admit one request id BEFORE delivery. The append is fsync'd
    /// before `First` is returned, so a crash right after this call still
    /// leaves the admission on disk.
    ///
    /// # Errors
    ///
    /// Returns an error when the durable admission append fails.
    pub fn admit(&mut self, request_id: &str) -> Result<Admission> {
        if self.slot(request_id).is_some() {
            return Ok(Admission::Already);
        }
        crate::journal::append_record_at(
            self.pinned_parent()?,
            &self.leaf,
            &json!({"version": 1, "type": "admitted", "requestId": request_id}),
        )?;
        self.push_slot(request_id.to_string(), None);
        Ok(Admission::First)
    }

    /// Durably record the answer for an admitted request. First writer
    /// wins: an id that already has an answer is a no-op. Recording an
    /// answer for a request that was never admitted is a protocol error.
    ///
    /// # Errors
    ///
    /// Returns an error when the request was never admitted or the durable
    /// answer append or the post-append compaction fails.
    pub fn record(&mut self, command: CloudFamilyCommand) -> Result<()> {
        let request_id = command.request_id().to_string();
        if self.slot(&request_id).is_none() {
            return Err(anyhow!(
                "cannot record an answer before admitting {request_id}"
            ));
        }
        if self.result(&request_id).is_some() {
            return Ok(());
        }
        crate::journal::append_record_at(
            self.pinned_parent()?,
            &self.leaf,
            &json!({"version": 1, "type": "result", "requestId": request_id, "command": command}),
        )?;
        if let Some(slot) = self.slot_mut(&request_id) {
            slot.result = Some(command);
        }
        Ok(())
    }

    /// Request ids durably admitted without a journaled answer — the
    /// crash-gap set the wiring layer must reconcile before their events
    /// may be replayed.
    #[must_use]
    pub fn uncertain(&self) -> Vec<String> {
        self.slots
            .iter()
            .filter(|slot| slot.result.is_none())
            .map(|slot| slot.request_id.clone())
            .collect()
    }

    fn slot(&self, request_id: &str) -> Option<usize> {
        self.slots
            .iter()
            .rposition(|slot| slot.request_id == request_id)
    }

    fn slot_mut(&mut self, request_id: &str) -> Option<&mut ResultSlot> {
        let index = self.slot(request_id)?;
        self.slots.get_mut(index)
    }

    fn push_slot(&mut self, request_id: String, result: Option<CloudFamilyCommand>) {
        self.slots.push_back(ResultSlot { request_id, result });
        while self.slots.len() > self.max_remembered {
            self.slots.pop_front();
            self.compact();
        }
    }

    /// Rewrite the journal to the live window, durably (temp file, fsync,
    /// rename). Admits without answers survive compaction as admits, so a
    /// compact can never strand an uncertain request.
    fn compact(&mut self) {
        let records: Vec<Value> = self
            .slots
            .iter()
            .flat_map(|slot| {
                let admitted = json!({"version": 1, "type": "admitted", "requestId": slot.request_id});
                let result = slot.result.as_ref().map(|command| {
                    json!({"version": 1, "type": "result", "requestId": slot.request_id, "command": command})
                });
                std::iter::once(admitted).chain(result)
            })
            .collect();
        let _ = self
            .pinned_parent()
            .and_then(|parent| crate::journal::rewrite_records_at(parent, &self.leaf, &records));
    }

    fn load_lines(&mut self, valid_lines: &[String]) {
        for line in valid_lines {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                // A crash may leave only the final append truncated.
                continue;
            };
            if record.get("version").and_then(Value::as_u64) != Some(1) {
                continue;
            }
            let Some(request_id) = record.get("requestId").and_then(Value::as_str) else {
                continue;
            };
            match record.get("type").and_then(Value::as_str) {
                Some("admitted") => {
                    if self.slot(request_id).is_none() {
                        self.push_slot(request_id.to_string(), None);
                    }
                }
                Some("result") => {
                    let Ok(command) = serde_json::from_value::<CloudFamilyCommand>(
                        record.get("command").cloned().unwrap_or(Value::Null),
                    ) else {
                        continue;
                    };
                    if let Some(slot) = self.slot_mut(request_id) {
                        slot.result.get_or_insert(command);
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;

    /// The macOS temp root resolves through /var (a symlink); the strict
    /// no-symlink placement policy requires the ORIGINAL path to be
    /// symlink-free, so the tests canonicalize their legitimate temp
    /// paths at the call site (the product keeps no exception).
    fn temp_root(dir: &tempfile::TempDir) -> std::path::PathBuf {
        std::fs::canonicalize(dir.path()).unwrap()
    }

    /// The request outbox carries the message body in PLAINTEXT (the TS
    /// envelope), so its inode must be private from the first write — the
    /// umask-default 0644 file was readable through any traversable path
    /// (the review's finding in the #3145 substrate).
    #[cfg(unix)]
    #[test]
    fn request_outbox_is_private_from_its_first_write() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = temp_root(&dir).join("nested-outbox");
        let mut log = FamilyRequestLog::open(&outbox, "sess_priv", 50).unwrap();
        log.append(CloudFamilyEventPayload::AgentMessageRequest {
            request_id: "msgreq_priv".to_string(),
            from_remote_session_id: "remote_child".to_string(),
            target_selector: "sibling".to_string(),
            message: "the plaintext body".to_string(),
        })
        .unwrap();
        let events = outbox.join("outbox-events.ndjson");
        let content = fs::read_to_string(&events).unwrap();
        assert!(
            content.contains("the plaintext body"),
            "the envelope stores the message in plaintext: {content}"
        );
        assert_eq!(
            pa_core::platform::perms::file_mode(&events),
            Some(0o600),
            "the plaintext outbox inode is private from its first write"
        );
        assert_eq!(
            pa_core::platform::perms::file_mode(&outbox),
            Some(0o700),
            "the created outbox directory is private"
        );
    }

    /// A legacy outbox written at the umask-default mode (the base
    /// substrate's shape) migrates to a fresh private inode at open: the
    /// bytes are preserved verbatim, the inode changes, and appends after
    /// the swap replay.
    #[cfg(unix)]
    #[test]
    fn legacy_loose_outbox_migrates_to_a_fresh_private_inode() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let mut log = FamilyRequestLog::open(&temp_root(&dir), "sess_priv", 50).unwrap();
        log.append(CloudFamilyEventPayload::AgentMessageRequest {
            request_id: "msgreq_priv".to_string(),
            from_remote_session_id: "remote_child".to_string(),
            target_selector: "sibling".to_string(),
            message: "the plaintext body".to_string(),
        })
        .unwrap();
        let events = temp_root(&dir).join("outbox-events.ndjson");
        // The old shape: the same file at the umask-default 0644.
        fs::set_permissions(&events, fs::Permissions::from_mode(0o644)).unwrap();
        let before = fs::symlink_metadata(&events).unwrap();
        let bytes = fs::read(&events).unwrap();

        let reopened = FamilyRequestLog::open(&temp_root(&dir), "sess_priv", 50).unwrap();

        let after = fs::symlink_metadata(&events).unwrap();
        assert_ne!(
            (after.dev(), after.ino()),
            (before.dev(), before.ino()),
            "the legacy loose outbox moves to a fresh private inode"
        );
        assert_eq!(pa_core::platform::perms::file_mode(&events), Some(0o600));
        assert_eq!(
            fs::read(&events).unwrap(),
            bytes,
            "history is preserved byte-for-byte"
        );
        assert_eq!(reopened.tail_sequence(), 1, "the migrated record replays");
        // The private inode keeps serving: an append after the swap
        // survives a reopen.
        log.append(CloudFamilyEventPayload::FamilyRosterRequest {
            request_id: "famreq_priv".to_string(),
            from_remote_session_id: "remote_child".to_string(),
        })
        .unwrap();
        assert_eq!(
            FamilyRequestLog::open(&temp_root(&dir), "sess_priv", 50)
                .unwrap()
                .tail_sequence(),
            2,
            "the post-swap append lands and replays"
        );
    }

    /// The result journal's first write is private, and a legacy loose
    /// file migrates to a fresh private inode with its admissions
    /// intact.
    #[cfg(unix)]
    #[test]
    fn result_journal_is_private_and_migrates_a_legacy_loose_file() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let path = temp_root(&dir).join("family-results.jsonl");
        let mut log = FamilyResultLog::open(&path).unwrap();
        log.admit("msgreq_r1").unwrap();
        assert_eq!(
            pa_core::platform::perms::file_mode(&path),
            Some(0o600),
            "the result journal inode is private from its first write"
        );
        // The old shape: the same file at the umask-default 0644.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        let reopened = FamilyResultLog::open(&path).unwrap();
        let after = fs::symlink_metadata(&path).unwrap();
        assert_ne!(
            (after.dev(), after.ino()),
            (before.dev(), before.ino()),
            "the legacy loose result journal moves to a fresh private inode"
        );
        assert_eq!(pa_core::platform::perms::file_mode(&path), Some(0o600));
        assert_eq!(
            reopened.uncertain(),
            vec!["msgreq_r1".to_string()],
            "the migrated admission replays"
        );
    }

    /// The private-placement invariant (the follow-up review): a symlink
    /// parent is rejected BEFORE anything is touched — the target is
    /// never tightened through the link — and a pre-existing loose own
    /// parent is tightened, not left writable by others.
    #[cfg(unix)]
    #[test]
    fn family_logs_enforce_a_private_parent() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        // The symlinked parent: rejected for both logs, and the target's
        // mode is never touched.
        let target = temp_root(&root).join("target");
        fs::create_dir_all(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        let link = temp_root(&root).join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        FamilyRequestLog::open(&link, "sess_priv", 50)
            .expect_err("the O_NOFOLLOW open refuses the symlinked parent");
        FamilyResultLog::open(&link.join("family-results.jsonl"))
            .expect_err("the O_NOFOLLOW open refuses the symlinked parent");
        assert_eq!(
            pa_core::platform::perms::file_mode(&target),
            Some(0o755),
            "the symlink target is never tightened"
        );
        // A pre-existing loose own parent is tightened at open.
        let loose = temp_root(&root).join("loose");
        fs::create_dir_all(&loose).unwrap();
        fs::set_permissions(&loose, fs::Permissions::from_mode(0o755)).unwrap();
        FamilyRequestLog::open(&loose, "sess_priv", 50).unwrap();
        assert_eq!(
            pa_core::platform::perms::file_mode(&loose),
            Some(0o700),
            "the loose own parent is tightened at open"
        );
    }

    /// The append's nofollow discipline: a replaced (symlinked) outbox
    /// path refuses the append instead of writing the plaintext body
    /// through it.
    #[cfg(unix)]
    #[test]
    fn outbox_append_refuses_a_replaced_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = FamilyRequestLog::open(&temp_root(&dir), "sess_priv", 50).unwrap();
        let events = temp_root(&dir).join("outbox-events.ndjson");
        let sink = temp_root(&dir).join("attacker-sink");
        fs::write(&sink, "").unwrap();
        fs::remove_file(&events).unwrap();
        std::os::unix::fs::symlink(&sink, &events).unwrap();
        log.append(CloudFamilyEventPayload::AgentMessageRequest {
            request_id: "msgreq_priv".to_string(),
            from_remote_session_id: "remote_child".to_string(),
            target_selector: "sibling".to_string(),
            message: "the plaintext body".to_string(),
        })
        .expect_err("the O_NOFOLLOW openat refuses the replaced leaf");
        assert_eq!(
            fs::read_to_string(&sink).unwrap(),
            "",
            "no plaintext is written through the replaced path"
        );
    }

    /// The pinned-handle proof (the follow-up review's writable-ancestor
    /// race): a parent replaced AFTER the open — a rename through a
    /// mutable ancestor plants a fresh, perfectly valid private
    /// directory at the old path — cannot redirect anything. The
    /// append lands in the ORIGINAL pinned inode (found under the
    /// moved path), and the decoy at the old path stays empty.
    #[test]
    fn outbox_append_lands_in_the_pinned_parent_despite_a_swapped_path() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let outbox = temp_root(&root).join("outbox");
        let mut log = FamilyRequestLog::open(&outbox, "sess_priv", 50).unwrap();
        fs::rename(&outbox, temp_root(&root).join("moved")).unwrap();
        fs::create_dir_all(&outbox).unwrap();
        fs::set_permissions(&outbox, fs::Permissions::from_mode(0o700)).unwrap();
        log.append(CloudFamilyEventPayload::AgentMessageRequest {
            request_id: "msgreq_priv".to_string(),
            from_remote_session_id: "remote_child".to_string(),
            target_selector: "sibling".to_string(),
            message: "the plaintext body".to_string(),
        })
        .expect("the pinned parent keeps serving the append");
        let moved = fs::read_to_string(temp_root(&root).join("moved").join("outbox-events.ndjson"))
            .unwrap();
        assert!(
            moved.contains("the plaintext body"),
            "the record lives in the pinned (moved) inode: {moved}"
        );
        assert!(
            !outbox.join("outbox-events.ndjson").exists(),
            "the decoy at the swapped path received nothing"
        );
    }

    /// The trusted-namespace placement policy (the follow-up review's
    /// integrity finding): an ancestor that could MOVE the verified
    /// directory between runs makes the placement non-durable, so an
    /// attacker-mutable ancestor (group/other-writable, sticky-less) is
    /// rejected at open — and a sticky ancestor (the POSIX /tmp
    /// contract: only the entry's owner may rename it) is accepted.
    #[test]
    fn family_logs_reject_an_attacker_mutable_ancestor() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        for loose_mode in [0o777, 0o770, 0o702] {
            // The mutable ancestor is INTERMEDIATE: the open tightens the
            // log's own parent, and the placement policy then refuses the
            // chain that could move it between runs.
            let movable = temp_root(&root).join(format!("loose-{loose_mode:o}"));
            fs::create_dir_all(movable.join("outbox")).unwrap();
            fs::set_permissions(&movable, fs::Permissions::from_mode(loose_mode)).unwrap();
            let error = FamilyRequestLog::open(&movable.join("outbox"), "sess_priv", 50)
                .expect_err("an attacker-mutable ancestor fails closed");
            assert!(
                format!("{error:#}").contains("writable by others"),
                "the mutability policy rejects the placement: {error:#}"
            );
        }
    }

    #[test]
    fn family_logs_accept_a_sticky_ancestor() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        // A sticky intermediate (the POSIX /tmp contract: only the entry's
        // owner may rename it) cannot move another user's entries, so the
        // placement stays durable.
        let sticky = temp_root(&root).join("sticky");
        fs::create_dir_all(sticky.join("outbox")).unwrap();
        fs::set_permissions(&sticky, fs::Permissions::from_mode(0o1777)).unwrap();
        let mut log = FamilyRequestLog::open(&sticky.join("outbox"), "sess_priv", 50)
            .expect("the sticky ancestor cannot move another user's entries");
        log.append(CloudFamilyEventPayload::AgentMessageRequest {
            request_id: "msgreq_priv".to_string(),
            from_remote_session_id: "remote_child".to_string(),
            target_selector: "sibling".to_string(),
            message: "the plaintext body".to_string(),
        })
        .unwrap();
        let content =
            fs::read_to_string(sticky.join("outbox").join("outbox-events.ndjson")).unwrap();
        assert!(content.contains("the plaintext body"));
    }

    /// The reviewer's retargeting hole: an INTERMEDIATE symlink component
    /// in the ORIGINAL path (the parent's path RESOLVES through an
    /// attacker-retargetable link — even inside a sticky directory,
    /// where the link is the attacker's own entry) is refused by the
    /// strict original-component walk, even though the pinned handle
    /// holds the resolved real directory.
    #[test]
    fn family_logs_reject_a_symlink_component_in_the_original_path() {
        let root = tempfile::tempdir().unwrap();
        let real = temp_root(&root).join("real-outbox");
        fs::create_dir_all(&real).unwrap();
        let link = temp_root(&root).join("retargetable");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // The pinned handle resolves through the symlink into the real
        // directory — the walk then refuses the symlink component itself.
        FamilyRequestLog::open(&link.join("outbox"), "sess_priv", 50)
            .expect_err("a symlink component in the original path fails closed");
        FamilyResultLog::open(&link.join("outbox").join("family-results.jsonl"))
            .expect_err("a symlink component in the original path fails closed");
    }

    /// The no-mutation-on-untrusted-path invariant (the reviewer's
    /// rejected-path side effect): an attacker symlink component
    /// targeting an OWNED SHARED directory is refused with the victim
    /// untouched — no 0700 tighten through the link, no created outbox
    /// inside it — despite the pinned establishment resolving through
    /// it before the refusal.
    #[test]
    fn a_rejected_symlink_path_leaves_the_shared_target_untouched() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let victim = temp_root(&root).join("victim");
        fs::create_dir_all(&victim).unwrap();
        fs::set_permissions(&victim, fs::Permissions::from_mode(0o755)).unwrap();
        let link = temp_root(&root).join("retargetable");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        FamilyRequestLog::open(&link, "sess_priv", 50)
            .expect_err("the symlink component is refused");
        assert_eq!(
            pa_core::platform::perms::file_mode(&victim),
            Some(0o755),
            "the shared target's mode is never tightened through the rejected path"
        );
        let entries: Vec<_> = fs::read_dir(&victim).unwrap().collect();
        assert!(
            entries.is_empty(),
            "nothing is created inside the target through the rejected path"
        );
    }

    /// The result journal's appends ride the same pinned handle: the
    /// admission lands in the original (moved) inode and the decoy
    /// stays empty.
    #[test]
    fn result_journal_append_lands_in_the_pinned_parent_despite_a_swapped_path() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let parent = temp_root(&root).join("results-dir");
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("family-results.jsonl");
        let mut log = FamilyResultLog::open(&path).unwrap();
        fs::rename(&parent, temp_root(&root).join("moved")).unwrap();
        fs::create_dir_all(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        log.admit("msgreq_swap")
            .expect("the pinned parent keeps serving the admission");
        let moved = fs::read_to_string(temp_root(&root).join("moved").join("family-results.jsonl"))
            .unwrap();
        assert!(
            moved.contains("msgreq_swap"),
            "the admission lives in the pinned (moved) inode: {moved}"
        );
        assert!(
            !parent.join("family-results.jsonl").exists(),
            "the decoy at the swapped path received nothing"
        );
    }

    /// The crash-torn trailing append: the tail is repaired (truncated to
    /// its valid records) before any append can glue onto it, and the
    /// post-repair append replays cleanly.
    #[test]
    fn torn_tail_is_repaired_and_never_glued() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_root(&dir).join("family-results.jsonl");
        let mut log = FamilyResultLog::open(&path).unwrap();
        log.admit("msgreq_t1").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let first_line = content.lines().next().expect("the admitted record");
        // The crash: a torn partial line at the tail.
        std::fs::write(&path, format!("{first_line}\n{{\"torn")).unwrap();
        let reloaded = FamilyResultLog::open(&path).unwrap();
        assert_eq!(reloaded.uncertain(), vec!["msgreq_t1".to_string()]);
        let repaired = std::fs::read_to_string(&path).unwrap();
        assert!(
            !repaired.contains("torn"),
            "the torn fragment was truncated: {repaired}"
        );
        // The next append lands on the clean boundary and replays.
        let mut reloaded = reloaded;
        let command = pa_types::daemon::cloud::CloudFamilyCommand {
            payload: pa_types::daemon::cloud::CloudFamilyCommandPayload::AgentMessageResult {
                request_id: "msgreq_t1".to_string(),
                ok: true,
                receipt: None,
                error: None,
            },
        };
        reloaded.record(command).unwrap();
        let reopened = FamilyResultLog::open(&path).unwrap();
        assert!(
            reopened.uncertain().is_empty(),
            "the answer replays cleanly"
        );
    }

    /// Mid-file corruption fails closed: the journal is never opened and
    /// its history is never silently rewritten.
    #[test]
    fn mid_file_corruption_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_root(&dir).join("family-results.jsonl");
        let mut log = FamilyResultLog::open(&path).unwrap();
        log.admit("msgreq_m1").unwrap();
        drop(log);
        let valid = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{{garbage\n{valid}")).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(
            FamilyResultLog::open(&path).is_err(),
            "mid-file corruption fails closed"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "the corrupted file is never rewritten"
        );
    }
}

/// Platforms without the owner/mode probes fail closed: the family logs
/// never open on inherited ACLs alone (keyed-journal parity).
#[cfg(all(test, not(unix)))]
mod off_unix_tests {
    use super::*;

    #[test]
    fn family_logs_fail_closed_off_unix() {
        let dir = std::env::temp_dir().join(format!("pa-family-off-unix-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            FamilyRequestLog::open(&dir, "sess_off", 10).is_err(),
            "the request outbox fails closed off unix"
        );
        assert!(
            FamilyResultLog::open(&dir.join("family-results.jsonl")).is_err(),
            "the result journal fails closed off unix"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

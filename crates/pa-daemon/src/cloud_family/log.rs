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
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

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
pub struct FamilyRequestLog {
    directory: PathBuf,
    session_id: String,
    events: Vec<CloudFamilyEvent>,
    max_records: usize,
    max_event_bytes: usize,
}

impl FamilyRequestLog {
    /// Open (or create) the request log under `directory`, loading and
    /// validating the durable events.
    ///
    /// # Errors
    ///
    /// Returns an error when the directory cannot be created, the log is
    /// corrupt (digest, envelope, or sequence gap), or the repair write of a
    /// crash-truncated tail fails.
    pub fn open(directory: &Path, session_id: &str, max_records: usize) -> Result<Self> {
        fs::create_dir_all(directory).with_context(|| format!("create {}", directory.display()))?;
        let mut log = Self {
            directory: directory.to_path_buf(),
            session_id: session_id.to_string(),
            events: Vec::new(),
            max_records,
            max_event_bytes: pa_types::daemon::cloud::CLOUD_MAX_MESSAGE_BYTES,
        };
        log.load()?;
        Ok(log)
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
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.events_path())
            .with_context(|| format!("open {}", self.events_path().display()))?;
        file.write_all(line.as_bytes())?;
        file.sync_all()?;
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

    fn events_path(&self) -> PathBuf {
        self.directory.join(EVENTS_FILE)
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
        let path = self.events_path();
        let Ok(content) = fs::read_to_string(&path) else {
            File::create(&path).with_context(|| format!("create {}", path.display()))?;
            return Ok(());
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
            self.rewrite(&lines)?;
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
    fn rewrite(&mut self, lines: &[&str]) -> Result<()> {
        let path = self.events_path();
        let temp = path.with_extension("ndjson.tmp");
        {
            let file = File::create(&temp).with_context(|| format!("create {}", temp.display()))?;
            let mut writer = BufWriter::new(file);
            for line in lines {
                writer.write_all(line.as_bytes())?;
                writer.write_all(b"\n")?;
            }
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        fs::rename(&temp, &path).with_context(|| format!("persist {}", path.display()))?;
        Ok(())
    }
}

/// One durably-admitted request slot: the request id plus its journaled
/// answer once one exists.
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
pub struct FamilyResultLog {
    path: PathBuf,
    slots: VecDeque<ResultSlot>,
    max_remembered: usize,
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
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut log = Self {
            path: path.to_path_buf(),
            slots: VecDeque::new(),
            // The dedupe window must cover the largest possible replay
            // span — the request outbox's own record cap — so every
            // replayable request finds its journal state.
            max_remembered: DEFAULT_OUTBOX_RECORDS,
        };
        log.load();
        Ok(log)
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
        crate::journal::append_record(
            &self.path,
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
        crate::journal::append_record(
            &self.path,
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
        let _ =
            crate::journal::rewrite_records(&self.path, &records, crate::journal::Finalize::Synced);
    }

    fn load(&mut self) {
        let Ok(content) = fs::read_to_string(&self.path) else {
            return;
        };
        for line in content.lines() {
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

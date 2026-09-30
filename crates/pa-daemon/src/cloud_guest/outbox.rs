//! Durable guest event outbox (TS `event-outbox.ts`, the loopback slice).
//!
//! Every event is appended to the durable log (fsync) before it is
//! pushed, acknowledgements advance a persisted cursor, and replay
//! comes from the acknowledged-cursor position, never from a memory
//! window. Retention trimming (the TS generation bump that renumbers a
//! trimmed log) stays with the full protocol server port, so this slice
//! keeps one fixed generation — and that omission is an INTEGRATION
//! BLOCKER, not a mere gap: the record cap is on the whole log, an ack
//! advances the cursor but frees no capacity, and once the 50,000th
//! event is admitted the log is permanently full even under a healthy,
//! acknowledging bridge (every later event drops with `retentionStalled`
//! in the status probe). Trimming is the first blocking item of the
//! resident-store port.
//!
//! Crash contract: the append is one fsynced line, so a crash may leave
//! only the final line truncated; the reload drops it and repairs the
//! file to the last complete record. Envelope digests verify the stored
//! bytes, and a sequence gap is corruption.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use pa_types::daemon::cloud::{
    canonical_json, cloud_event_problem, CloudCommandReceipt, CloudCursor, CloudEvent,
    CloudSessionStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::cloud_guest::DEFAULT_OUTBOX_RECORDS;

/// Durable outbox event cap (TS `DEFAULT_MAX_RECORDS`): a full unacked
/// log stalls honestly.
const META_FILE: &str = "outbox-meta.json";
const EVENTS_FILE: &str = "outbox-events.ndjson";
/// Fixed event-log epoch for this slice (TS starts every outbox at
/// generation 1; epochs advance only on a committed trim).
pub const GENERATION: u64 = 1;

/// One outbox-bound event without its sequence (TS `CloudEventInput`).
/// This slice emits the command lifecycle and the session status; the
/// mirror surfaces (session entries, live frames, roster rows, usage)
/// stay with the resident-store port.
#[derive(Debug, Clone)]
pub enum GuestEventInput {
    CommandAccepted {
        recorded_at: String,
        receipt: CloudCommandReceipt,
    },
    CommandState {
        recorded_at: String,
        receipt: CloudCommandReceipt,
    },
    SessionStatus {
        recorded_at: String,
        status: CloudSessionStatus,
    },
}

impl GuestEventInput {
    /// The composed event with `sequence` assigned (the outbox owns
    /// sequence assignment).
    fn compose(&self, sequence: u64) -> CloudEvent {
        match self {
            Self::CommandAccepted {
                recorded_at,
                receipt,
            } => CloudEvent::CommandAccepted {
                sequence,
                recorded_at: recorded_at.clone(),
                receipt: receipt.clone(),
            },
            Self::CommandState {
                recorded_at,
                receipt,
            } => CloudEvent::CommandState {
                sequence,
                recorded_at: recorded_at.clone(),
                receipt: receipt.clone(),
            },
            Self::SessionStatus {
                recorded_at,
                status,
            } => CloudEvent::SessionStatus {
                sequence,
                recorded_at: recorded_at.clone(),
                status: *status,
            },
        }
    }
}

/// Durable metadata: the acknowledged cursor (TS `OutboxMeta` minus the
/// trim-owned `eventsFile`).
#[derive(Debug, Serialize, Deserialize)]
struct OutboxMeta {
    version: u64,
    session_id: String,
    generation: u64,
    acked_sequence: u64,
}

/// The durable event outbox for one guest session.
pub struct GuestEventOutbox {
    directory: PathBuf,
    session_id: String,
    meta: OutboxMeta,
    events: Vec<CloudEvent>,
    max_records: usize,
    max_event_bytes: usize,
}

impl GuestEventOutbox {
    /// Open (or create) the outbox under `directory`, loading and
    /// validating the durable events and the acknowledged cursor.
    ///
    /// # Errors
    ///
    /// Returns an error when the directory cannot be created, the log is
    /// corrupt (digest, envelope, or sequence gap), or the repair write
    /// of a crash-truncated tail fails.
    pub fn open(directory: &Path, session_id: &str) -> Result<Self> {
        Self::open_with_records(directory, session_id, DEFAULT_OUTBOX_RECORDS)
    }

    /// Same as [`open`](Self::open) with an explicit record cap (the
    /// tests shrink the window; production wiring uses the TS constant).
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`open`](Self::open).
    pub fn open_with_records(
        directory: &Path,
        session_id: &str,
        max_records: usize,
    ) -> Result<Self> {
        fs::create_dir_all(directory).with_context(|| format!("create {}", directory.display()))?;
        let mut outbox = Self {
            directory: directory.to_path_buf(),
            session_id: session_id.to_string(),
            meta: OutboxMeta {
                version: 1,
                session_id: session_id.to_string(),
                generation: GENERATION,
                acked_sequence: 0,
            },
            events: Vec::new(),
            max_records,
            max_event_bytes: pa_types::daemon::cloud::CLOUD_MAX_MESSAGE_BYTES,
        };
        outbox.load_meta()?;
        outbox.load_events()?;
        outbox.validate_sequence()?;
        Ok(outbox)
    }

    /// The event-log generation (fixed for this slice).
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.meta.generation
    }

    /// The durable event tail.
    #[must_use]
    pub fn tail_cursor(&self) -> CloudCursor {
        CloudCursor {
            generation: self.meta.generation,
            sequence: tail_sequence(&self.events),
        }
    }

    /// The acknowledged-cursor position.
    #[must_use]
    #[cfg(test)]
    pub fn acknowledged_cursor(&self) -> CloudCursor {
        CloudCursor {
            generation: self.meta.generation,
            sequence: self.meta.acked_sequence,
        }
    }

    /// Append one event durably: the sequence is assigned, the event is
    /// validated, canonicalized, size checked, written, and fsynced
    /// before it is returned. Only after this returns may a caller treat
    /// the event as admitted.
    ///
    /// # Errors
    ///
    /// Returns an error when the log is full (the TS stall), the event is
    /// invalid or over the frame bound, or the durable append fails.
    pub fn append(&mut self, input: GuestEventInput) -> Result<CloudEvent> {
        if self.events.len() >= self.max_records {
            return Err(anyhow!(
                "Cloud event outbox reached {} records",
                self.max_records
            ));
        }
        let event = input.compose(tail_sequence(&self.events) + 1);
        let assigned = serde_json::to_value(&event).map_err(|error| anyhow!("{error}"))?;
        if let Some(problem) = cloud_event_problem(&assigned, "event") {
            return Err(anyhow!("invalid cloud event: {problem}"));
        }
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

    /// Admitted events after `cursor.sequence`, oldest first, at most
    /// `limit`. A cursor beyond the tail is a cursor error, not an empty
    /// batch.
    ///
    /// # Errors
    ///
    /// Returns the TS cursor problem string when the cursor names the
    /// wrong generation or is beyond the event tail.
    pub fn events_after(
        &self,
        cursor: &CloudCursor,
        limit: usize,
    ) -> Result<Vec<CloudEvent>, String> {
        self.assert_cursor(cursor)?;
        if cursor.sequence > tail_sequence(&self.events) {
            return Err("Cloud cursor is beyond the event tail".to_string());
        }
        Ok(self
            .events
            .iter()
            .filter(|event| event_sequence(event) > cursor.sequence)
            .take(limit)
            .cloned()
            .collect())
    }

    /// Acknowledge durably imported events by advancing the cursor (TS
    /// `ack`). The acknowledgement never moves backwards and never runs
    /// past the tail.
    ///
    /// # Errors
    ///
    /// Returns the TS cursor problem string when the cursor names the
    /// wrong generation, moves backwards, or is beyond the event tail;
    /// returns an error when the metadata rewrite fails.
    pub fn ack(&mut self, cursor: &CloudCursor) -> Result<(), String> {
        self.assert_cursor(cursor)?;
        if cursor.sequence < self.meta.acked_sequence {
            return Err("Cloud acknowledgement cannot move backwards".to_string());
        }
        if cursor.sequence > tail_sequence(&self.events) {
            return Err("Cloud acknowledgement is beyond the event tail".to_string());
        }
        if cursor.sequence == self.meta.acked_sequence {
            return Ok(());
        }
        self.meta.acked_sequence = cursor.sequence;
        self.persist_meta().map_err(|error| error.to_string())
    }

    fn assert_cursor(&self, cursor: &CloudCursor) -> Result<(), String> {
        if cursor.generation != self.meta.generation {
            return Err(format!(
                "Cloud cursor generation {} does not match {}",
                cursor.generation, self.meta.generation
            ));
        }
        Ok(())
    }

    fn events_path(&self) -> PathBuf {
        self.directory.join(EVENTS_FILE)
    }

    fn meta_path(&self) -> PathBuf {
        self.directory.join(META_FILE)
    }

    /// The canonical envelope of one event: `{"eventId","generation",
    /// "event"}` with the TS digest over the session/generation/event
    /// triple.
    fn envelope(&self, event: &CloudEvent) -> Result<String> {
        let event_value = serde_json::to_value(event).map_err(|error| anyhow!("{error}"))?;
        let canonical = canonical_json(&json!({
            "sessionId": self.session_id,
            "generation": self.meta.generation,
            "event": event_value,
        }))
        .map_err(|reason| anyhow!("{reason}"))?;
        let hex: String =
            Sha256::digest(canonical.as_bytes())
                .iter()
                .fold(String::new(), |mut key, byte| {
                    use std::fmt::Write;
                    write!(key, "{byte:02x}").expect("write to String");
                    key
                });
        canonical_json(&json!({
            "eventId": format!("evt_{hex}"),
            "generation": self.meta.generation,
            "event": event_value,
        }))
        .map_err(|reason| anyhow!("{reason}"))
    }

    fn load_meta(&mut self) -> Result<()> {
        let path = self.meta_path();
        if !path.exists() {
            self.persist_meta()?;
            return Ok(());
        }
        let content =
            fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let value: Value = serde_json::from_str(content.trim_end())
            .map_err(|_| anyhow!("Cloud event outbox metadata is corrupt"))?;
        let meta: OutboxMeta = serde_json::from_value(value)
            .map_err(|_| anyhow!("Cloud event outbox metadata is corrupt"))?;
        if meta.version != 1 || meta.session_id != self.session_id || meta.generation != GENERATION
        {
            return Err(anyhow!("Cloud event outbox metadata is corrupt"));
        }
        self.meta = meta;
        Ok(())
    }

    /// Load the durable events: a missing file is a fresh log; a torn
    /// FINAL line (a crash mid-append; the appends always end in a
    /// newline) is dropped and the file repaired to the last complete
    /// record; every complete record must verify its envelope digest
    /// and sequence. Any other read failure or any non-final corruption
    /// refuses the open — truncating or folding away fsynced events
    /// would destroy the durable log an acknowledging bridge relies on.
    ///
    /// # Errors
    ///
    /// Returns an error when the events file cannot be read (anything
    /// but a missing file), the repair write fails, or a complete
    /// record fails its envelope, digest, or sequence check.
    fn load_events(&mut self) -> Result<()> {
        let path = self.events_path();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                File::create(&path).with_context(|| format!("create {}", path.display()))?;
                return Ok(());
            }
            Err(error) => {
                return Err(anyhow!("read {}: {error}", path.display()));
            }
        };
        let torn_tail = !bytes.ends_with(b"\n");
        let complete_prefix_end = if torn_tail {
            bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |last_newline| last_newline + 1)
        } else {
            bytes.len()
        };
        let complete = &bytes[..complete_prefix_end];
        if torn_tail {
            // A crash truncated the final append: rewrite the file to
            // exactly the complete prefix (verbatim bytes) so no later
            // append can glue onto the malformed tail. No fsynced
            // event is lost.
            self.repair_torn_tail(complete)?;
        }
        let content = std::str::from_utf8(complete)
            .map_err(|_| anyhow!("Cloud event outbox record is not valid UTF-8"))?;
        let mut lines: Vec<&str> = content.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        for (index, line) in lines.iter().enumerate() {
            let record: Value = serde_json::from_str(line)
                .map_err(|_| anyhow!("Cloud event outbox record is corrupt"))?;
            let event_value = record
                .get("event")
                .filter(|event| event.is_object())
                .ok_or_else(|| anyhow!("Cloud event outbox record is corrupt"))?;
            if record.get("generation").and_then(Value::as_u64) != Some(self.meta.generation) {
                return Err(anyhow!("Cloud event outbox record is corrupt"));
            }
            let event: CloudEvent = serde_json::from_value(event_value.clone())
                .map_err(|_| anyhow!("Cloud event outbox record has an invalid event"))?;
            let expected = self.envelope(&event)?;
            let stored = canonical_json(&record).map_err(|_| anyhow!("corrupt record"))?;
            if expected != stored {
                return Err(anyhow!("Cloud event outbox record digest is corrupt"));
            }
            if event_sequence(&event) != (index as u64) + 1 {
                return Err(anyhow!("Cloud event outbox has a sequence gap"));
            }
            self.events.push(event);
        }
        Ok(())
    }

    /// Rewrite the event log to exactly the complete prefix (temp
    /// file, fsync, rename): the torn tail is gone BEFORE any new
    /// append can glue onto it. The rewritten bytes are the good
    /// prefix verbatim.
    ///
    /// # Errors
    ///
    /// Returns an error when the temp write, its sync, or the swap
    /// fails.
    fn repair_torn_tail(&self, complete_prefix: &[u8]) -> Result<()> {
        let temp = self
            .events_path()
            .with_extension(format!("ndjson.tmp-{}", std::process::id()));
        {
            let mut file =
                File::create(&temp).with_context(|| format!("create {}", temp.display()))?;
            file.write_all(complete_prefix)?;
            file.sync_all()?;
        }
        pa_core::platform::rename_onto(&temp, &self.events_path())
            .with_context(|| format!("persist {}", self.events_path().display()))?;
        Ok(())
    }

    fn validate_sequence(&self) -> Result<()> {
        if self.meta.acked_sequence > tail_sequence(&self.events) {
            return Err(anyhow!(
                "Cloud event outbox acknowledgement is beyond its tail"
            ));
        }
        Ok(())
    }

    fn persist_meta(&self) -> Result<()> {
        let temp = self.meta_path().with_extension("json.tmp");
        {
            let file = File::create(&temp).with_context(|| format!("create {}", temp.display()))?;
            let mut writer = BufWriter::new(file);
            let canonical = canonical_json(&serde_json::to_value(&self.meta)?)
                .map_err(|reason| anyhow!("{reason}"))?;
            writer.write_all(canonical.as_bytes())?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        pa_core::platform::rename_onto(&temp, &self.meta_path())
            .with_context(|| format!("persist {}", self.meta_path().display()))?;
        Ok(())
    }
}

/// The `sequence` field of one event value.
fn event_sequence(event: &CloudEvent) -> u64 {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("sequence").and_then(Value::as_u64))
        .unwrap_or_default()
}

/// The sequence of the newest admitted event (0 when empty).
fn tail_sequence(events: &[CloudEvent]) -> u64 {
    events.last().map_or(0, event_sequence)
}

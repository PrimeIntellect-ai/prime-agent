//! The outbound request-body capture: while request timing is on, the
//! instrumented payload hook hands each request's final outbound body —
//! after every transform, exactly what the provider sees, the wire shape
//! that answers which request fields the provider actually received — to
//! one bounded background writer that persists it under
//! `<agentDir>/logs/request-payloads/` (one file per request, newest-`keep`
//! ring, owner-only modes, best-effort throughout: a read-only or missing
//! dir never breaks the request it observes).
//!
//! One writer serves the whole process: a single thread with a single
//! bounded queue, armed on the first recorded capture, so the footprint
//! is one thread and at most [`WRITE_QUEUE_CAPACITY`] queued bodies no
//! matter how many sessions are live. [`RequestPayloadCapture::record`]
//! never touches the filesystem and reserves its queue slot before the
//! payload clone: a saturated queue drops the capture at O(1) instead of
//! paying a copy it would reject. The writer owns the serialization, the
//! file writes, and the prune.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Map, Value};

use crate::platform::perms;
use crate::session::manager::format_iso;

#[cfg(test)]
pub(crate) mod tests;

/// Serializes the tests that record through the process's one writer:
/// the queue is a shared bound, so concurrent recording tests would
/// saturate each other's queues and drop each other's expected bodies.
/// A tokio mutex so the async integration tests hold it across awaits
/// (`lock().await`) while the sync unit tests take `blocking_lock()`.
#[cfg(test)]
pub(crate) static WRITER_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The newest-body ring the capture keeps: one file per request, so
/// long-context payloads never grow without bound in an always-on
/// daemon's diagnostics dir.
pub(crate) const REQUEST_PAYLOAD_CAPTURE_KEEP: usize = 64;

/// The one write queue's capacity: a writer that falls behind drops the
/// overflow instead of growing the footprint.
const WRITE_QUEUE_CAPACITY: usize = REQUEST_PAYLOAD_CAPTURE_KEEP;

/// The process-global capture counter: every handed-off body gets its
/// own file name regardless of which session wiring recorded it (the
/// wire sequence numbers restart per wiring, and sessions share the
/// agent dir).
static CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);

/// One queued capture, as the dispatch path hands it off.
struct CaptureJob {
    dir: PathBuf,
    keep: usize,
    payload: Value,
    model: pa_agent::types::Model,
    session_id: Option<String>,
    request_seq: u64,
    now_ms: u128,
    /// The process-unique file-name counter (see [`CAPTURE_SEQ`]).
    capture_seq: u64,
}

/// The process's single capture writer handle: the bounded queue plus the
/// reserve counter of jobs still queued.
struct CaptureWriter {
    sender: SyncSender<CaptureJob>,
    /// Reserved slots: handed-off jobs the writer has not taken yet. The
    /// reservation (`fetch_update`) precedes the payload clone, the
    /// writer's `recv` releases each slot, and a rejected handoff
    /// releases its own — the counter never underflows and never reports
    /// saturation without a full queue behind it.
    queued: Arc<AtomicUsize>,
}

/// The one writer, armed on the first recorded capture. The thread is
/// process-owned and detached by design: it lives until process exit,
/// and an orderly shutdown never waits on it — captures still queued at
/// exit are lost best-effort (a partial temp file ages out with the
/// ring), the same contract as the rotating log.
static CAPTURE_WRITER: OnceLock<Option<CaptureWriter>> = OnceLock::new();

/// The process's capture writer, arming it on first use: one thread, one
/// bounded queue. `None` (cached) when the thread cannot spawn — the
/// capture stays disabled for the process, best-effort by contract.
fn capture_writer() -> Option<&'static CaptureWriter> {
    CAPTURE_WRITER
        .get_or_init(|| {
            let (sender, receiver) = std::sync::mpsc::sync_channel(WRITE_QUEUE_CAPACITY.max(1));
            let queued = Arc::new(AtomicUsize::new(0));
            let writer_queued = Arc::clone(&queued);
            std::thread::Builder::new()
                .name("request-payload-capture".to_string())
                .spawn(move || drain_writer(writer_queued, receiver))
                .map(|_| CaptureWriter { sender, queued })
                .map_err(|error| {
                    tracing::debug!(%error, "payload capture writer thread failed to spawn");
                })
                .ok()
        })
        .as_ref()
}

/// The outbound request-body capture: the capture's configuration — which
/// ring directory each body lands in and how many files it keeps — handed
/// to the process's single writer by the request-timing payload hook.
#[derive(Debug, Clone)]
pub(crate) struct RequestPayloadCapture {
    dir: PathBuf,
    keep: usize,
}

impl RequestPayloadCapture {
    /// The capture under `<agentDir>/logs/request-payloads/`, keeping the
    /// newest [`REQUEST_PAYLOAD_CAPTURE_KEEP`] bodies.
    #[must_use]
    pub(crate) fn new(agent_dir: &Path) -> Self {
        Self {
            dir: agent_dir.join("logs").join("request-payloads"),
            keep: REQUEST_PAYLOAD_CAPTURE_KEEP,
        }
    }

    /// The capture at an explicit directory and ring size (tests).
    #[cfg(test)]
    #[must_use]
    pub(crate) fn at(dir: impl Into<PathBuf>, keep: usize) -> Self {
        Self {
            dir: dir.into(),
            keep,
        }
    }

    /// Hand one request's final outbound body to the writer. Bounded and
    /// non-blocking: the queue slot is reserved BEFORE the payload clone
    /// (a saturated queue drops the capture at O(1)), a reservation whose
    /// handoff the queue rejects is released immediately, and the
    /// dispatch path never touches the filesystem.
    pub(crate) fn record(
        &self,
        payload: &Value,
        model: &pa_agent::types::Model,
        session_id: Option<&str>,
        request_seq: u64,
    ) {
        let Some(writer) = capture_writer() else {
            return;
        };
        // Reserve first: the counter is the bound the writer releases
        // from, so it must never depend on the send's completion (the
        // writer can take the job before any post-send accounting runs).
        let reserved = writer
            .queued
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |queued| {
                (queued < WRITE_QUEUE_CAPACITY).then_some(queued + 1)
            })
            .is_ok();
        if !reserved {
            return;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let job = CaptureJob {
            dir: self.dir.clone(),
            keep: self.keep,
            payload: payload.clone(),
            model: model.clone(),
            session_id: session_id.map(ToString::to_string),
            request_seq,
            now_ms,
            capture_seq: CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed) + 1,
        };
        if writer.sender.try_send(job).is_err() {
            // The queue filled inside the reservation window: the job
            // never queued, so its slot frees for the next handoff.
            writer.queued.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// The writer thread: release the job's queue slot as it is taken, then
/// serialize the capture, write it through a private temp file, rename it
/// into place (a reader never sees a partial body), and prune the ring.
fn drain_writer(queued: Arc<AtomicUsize>, jobs: Receiver<CaptureJob>) {
    while let Ok(job) = jobs.recv() {
        queued.fetch_sub(1, Ordering::Relaxed);
        if let Err(error) = write_capture(&job.dir, job.keep, &job) {
            tracing::debug!(dir = %job.dir.display(), %error, "payload capture write failed");
        }
    }
}

/// The capture file's correlation envelope: the same identity fields the
/// request-timing entries carry, so a capture correlates with its
/// timeline by sequence number; empty or absent fields stay omitted.
fn capture_envelope(job: &CaptureJob) -> Value {
    let mut envelope = Map::new();
    envelope.insert("ts".to_string(), json!(format_iso(job.now_ms as i64)));
    if let Some(session_id) = &job.session_id {
        envelope.insert("sessionId".to_string(), json!(session_id));
    }
    envelope.insert("model".to_string(), json!(job.model.id));
    if !job.model.provider.is_empty() {
        envelope.insert("provider".to_string(), json!(job.model.provider));
    }
    if !job.model.api.is_empty() {
        envelope.insert("api".to_string(), json!(job.model.api));
    }
    envelope.insert("requestSeq".to_string(), json!(job.request_seq));
    if let Some(request_bytes) = super::measure_request_bytes(&job.payload) {
        envelope.insert("requestBytes".to_string(), json!(request_bytes));
    }
    envelope.insert("payload".to_string(), job.payload.clone());
    Value::Object(envelope)
}

/// Persist one capture: owner-only directory and file modes (a shared or
/// permissively created agent dir must not expose the request bodies to
/// other local users), the durable rename through the platform wall, then
/// the ring prune. Best-effort: every failure is the caller's to swallow.
fn write_capture(dir: &Path, keep: usize, job: &CaptureJob) -> std::io::Result<()> {
    use std::io::Write;
    perms::create_dir_all_private(dir)?;
    // The directory can pre-exist with permissive modes (a shared
    // agentDir, a different umask): the restriction re-applies every
    // write, not only at creation.
    perms::restrict_dir(dir)?;
    let bytes = serde_json::to_vec_pretty(&capture_envelope(job))
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))?;
    // The epoch lead keeps lexical order chronological (the prune's
    // eviction order); the process-unique counter makes the name unique
    // across every session wiring sharing the dir.
    let name = format!(
        "{}-{}-{:08}.json",
        job.now_ms,
        std::process::id(),
        job.capture_seq
    );
    let target = dir.join(&name);
    let temp = dir.join(format!("{name}.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    perms::set_private_mode(&mut options);
    {
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.flush()?;
    }
    perms::restrict_file(&temp)?;
    crate::platform::rename_onto(&temp, &target)?;
    prune(dir, keep);
    Ok(())
}

/// Keep only the newest `keep` files: names sort chronologically (the
/// epoch-ms lead), so the oldest leave first. A stale temp file (a
/// crashed write's leftover) counts as one of the ring's files and ages
/// out the same way; a mid-write temp file carries the newest name and
/// never evicts.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            let extension = Path::new(name)
                .extension()
                .map(|ext| ext.to_string_lossy().into_owned());
            extension.is_some_and(|extension| {
                extension.eq_ignore_ascii_case("json") || extension.eq_ignore_ascii_case("tmp")
            })
        })
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(keep);
    for name in &names[..excess] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

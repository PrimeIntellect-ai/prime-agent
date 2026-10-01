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
//! is one thread, at most [`WRITE_QUEUE_CAPACITY`] queued jobs, and at
//! most [`REQUEST_PAYLOAD_BUDGET_BYTES`] retained payload bytes, no
//! matter how many sessions are live. [`RequestPayloadCapture::record`]
//! never touches the filesystem and reserves its queue slot before the
//! payload clone: a saturated queue drops the capture at O(1) instead
//! of paying a copy it would reject; a queue whose retained bytes are
//! over budget walks the payload once (without allocating) to price it,
//! then drops without cloning. The writer owns the serialization, the
//! file writes, and the prune.
//!
//! # The confidentiality boundary
//!
//! The captured bodies are complete request transcripts, so the capture
//! refuses rather than leak: on Unix the ring's directory and files are
//! owner-only through the platform wall (re-applied on every write, even
//! onto a pre-existing permissive directory), and every path component
//! from the agent dir down must be a real directory — a symlinked
//! component would redirect the private-mode writes, so the capture
//! disables itself instead of following it. On Windows the platform
//! wall's restriction helpers are inherited-ACL no-ops: rather than
//! write complete bodies through a possibly permissive inherited ACL,
//! the capture is disabled there (a documented limitation until the
//! platform wall gains a restrictive DACL).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Map, Value};

use crate::platform::perms;
use crate::session::manager::format_iso;

/// The capture's own battery: the capture is Unix-only (the
/// confidentiality boundary is not enforceable elsewhere), so its tests
/// are too.
#[cfg(all(test, unix))]
pub(crate) mod tests;

/// Serializes the tests that record through the process's one writer:
/// the queue is a shared bound, so concurrent recording tests would
/// saturate each other's queues and drop each other's expected bodies.
/// A tokio mutex so the async integration tests hold it across awaits
/// (`lock().await`) while the sync unit tests take `blocking_lock()`.
#[cfg(all(test, unix))]
pub(crate) static WRITER_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The newest-body ring the capture keeps: one file per request, so
/// long-context payloads never grow without bound in an always-on
/// daemon's diagnostics dir.
pub(crate) const REQUEST_PAYLOAD_CAPTURE_KEEP: usize = 64;

/// The one write queue's capacity: a writer that falls behind drops the
/// overflow instead of growing the footprint.
const WRITE_QUEUE_CAPACITY: usize = REQUEST_PAYLOAD_CAPTURE_KEEP;

/// The retained-bytes bound of the queue: handed-off payloads (and the
/// one the writer holds) stay resident until serialized and written, so
/// a stalled writer must not accumulate unbounded memory — a
/// long-context or large-image request can carry tens of MiB, and the
/// queue drops anything that would push the retained bytes past this
/// budget instead of cloning it.
pub(crate) const REQUEST_PAYLOAD_BUDGET_BYTES: u64 = 64 * 1024 * 1024;

/// The process-global capture counter: every handed-off body gets its
/// own file name regardless of which session wiring recorded it (the
/// wire sequence numbers restart per wiring, and sessions share the
/// agent dir).
static CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);

/// One queued capture, as the dispatch path hands it off.
struct CaptureJob {
    root: PathBuf,
    dir: PathBuf,
    keep: usize,
    payload: Value,
    model: pa_agent::types::Model,
    session_id: Option<String>,
    request_seq: u64,
    now_ms: u128,
    /// The process-unique file-name counter (see [`CAPTURE_SEQ`]).
    capture_seq: u64,
    /// The payload's byte estimate (see [`payload_bytes`]): the budget
    /// the writer releases once the body is written.
    estimate: u64,
}

/// The process's single capture writer handle: the bounded queue, the
/// reserve counter of jobs still queued, and the retained-bytes budget.
struct CaptureWriter {
    sender: SyncSender<CaptureJob>,
    /// Reserved slots: handed-off jobs the writer has not taken yet. The
    /// reservation (`fetch_update`) precedes the payload clone, the
    /// writer's `recv` releases each slot, and a rejected handoff
    /// releases its own — the counter never underflows and never reports
    /// saturation without a full queue behind it.
    queued: Arc<AtomicUsize>,
    /// The retained payload bytes: queued jobs plus the writer's in-flight
    /// body. The budget reservation precedes the clone; the writer
    /// releases each body's estimate once its write settles.
    retained: Arc<AtomicU64>,
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
            // The confidentiality boundary is only enforceable where the
            // platform wall can enforce owner-only modes: the wall's
            // Windows arms are inherited-ACL no-ops, so rather than write
            // complete request bodies through a possibly permissive
            // inherited ACL, the capture stays disabled there (see the
            // module doc).
            #[cfg(not(unix))]
            {
                tracing::debug!(
                    "payload capture disabled: owner-only modes are not enforceable on this platform"
                );
                return None;
            }
            #[cfg(unix)]
            {
                let (sender, receiver) = std::sync::mpsc::sync_channel(WRITE_QUEUE_CAPACITY.max(1));
                let queued = Arc::new(AtomicUsize::new(0));
                let retained = Arc::new(AtomicU64::new(0));
                let writer_queued = Arc::clone(&queued);
                let writer_retained = Arc::clone(&retained);
                std::thread::Builder::new()
                    .name("request-payload-capture".to_string())
                    .spawn(move || {
                        let writer_queued = writer_queued;
                        let writer_retained = writer_retained;
                        let receiver = receiver;
                        drain_writer(&writer_queued, &writer_retained, &receiver);
                    })
                    .map(|_| CaptureWriter {
                        sender,
                        queued,
                        retained,
                    })
                    .map_err(|error| {
                        tracing::debug!(%error, "payload capture writer thread failed to spawn");
                    })
                    .ok()
            }
        })
        .as_ref()
}

/// The outbound request-body capture: the capture's configuration — which
/// ring directory each body lands in, how many files it keeps, and the
/// trust root (`agentDir`) whose path components must all be real
/// directories before the capture will write — handed to the process's
/// single writer by the request-timing payload hook.
#[derive(Debug, Clone)]
pub(crate) struct RequestPayloadCapture {
    root: PathBuf,
    dir: PathBuf,
    keep: usize,
}

impl RequestPayloadCapture {
    /// The capture under `<agentDir>/logs/request-payloads/`, keeping the
    /// newest [`REQUEST_PAYLOAD_CAPTURE_KEEP`] bodies. `agent_dir` is the
    /// trust root: every component below it must be a real directory (a
    /// symlinked `logs` or ring dir would redirect the private-mode
    /// writes, and the capture refuses to follow it).
    #[must_use]
    pub(crate) fn new(agent_dir: &Path) -> Self {
        Self::at_rooted(
            agent_dir,
            agent_dir.join("logs").join("request-payloads"),
            REQUEST_PAYLOAD_CAPTURE_KEEP,
        )
    }

    /// The capture at an explicit directory and ring size (tests): the
    /// directory's parent is the trust root.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn at(dir: impl Into<PathBuf>, keep: usize) -> Self {
        let dir: PathBuf = dir.into();
        let root = dir.parent().map_or_else(|| dir.clone(), Path::to_path_buf);
        Self::at_rooted(root, dir, keep)
    }

    /// The capture at an explicit directory under an explicit trust root.
    #[must_use]
    pub(crate) fn at_rooted(
        root: impl Into<PathBuf>,
        dir: impl Into<PathBuf>,
        keep: usize,
    ) -> Self {
        Self {
            root: root.into(),
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
        // Reserve the slot first: the counter is the bound the writer
        // releases from, so it must never depend on the send's
        // completion (the writer can take the job before any post-send
        // accounting runs).
        let reserved = writer
            .queued
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |queued| {
                (queued < WRITE_QUEUE_CAPACITY).then_some(queued + 1)
            })
            .is_ok();
        if !reserved {
            return;
        }
        // Reserve the payload's bytes before cloning it: a stalled
        // writer must not accumulate unbounded resident memory. The
        // estimate walks the value once without allocating; a body that
        // would push the retained bytes past the budget drops here —
        // its slot releases and no copy is made.
        let estimate = payload_bytes(payload);
        let budgeted = writer
            .retained
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |retained| {
                retained
                    .checked_add(estimate)
                    .filter(|total| *total <= REQUEST_PAYLOAD_BUDGET_BYTES)
            })
            .is_ok();
        if !budgeted {
            writer.queued.fetch_sub(1, Ordering::Relaxed);
            return;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let job = CaptureJob {
            root: self.root.clone(),
            dir: self.dir.clone(),
            keep: self.keep,
            payload: payload.clone(),
            model: model.clone(),
            session_id: session_id.map(ToString::to_string),
            request_seq,
            now_ms,
            capture_seq: CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed) + 1,
            estimate,
        };
        if writer.sender.try_send(job).is_err() {
            // The queue filled inside the reservation window: the job
            // never queued, so its slot and its bytes free for the next
            // handoff.
            writer.queued.fetch_sub(1, Ordering::Relaxed);
            writer.retained.fetch_sub(estimate, Ordering::Relaxed);
        }
    }
}

/// The writer thread: release the job's queue slot as it is taken, then
/// serialize the capture, write it through a private temp file, rename it
/// into place (a reader never sees a partial body), and prune the ring.
/// The body's retained bytes release once its write settles (the job's
/// payload is dropped right after).
fn drain_writer(queued: &Arc<AtomicUsize>, retained: &Arc<AtomicU64>, jobs: &Receiver<CaptureJob>) {
    while let Ok(job) = jobs.recv() {
        queued.fetch_sub(1, Ordering::Relaxed);
        let result = write_capture(&job.root, &job.dir, job.keep, &job);
        retained.fetch_sub(job.estimate, Ordering::Relaxed);
        if let Err(error) = result {
            tracing::debug!(dir = %job.dir.display(), %error, "payload capture write failed");
        }
    }
}

/// The payload's byte estimate: an UPPER BOUND on what one accepted
/// capture allocates — the queue's clone, the envelope's re-clone, and
/// the serialized bytes — walked once without allocating. Every node
/// pays its own enum footprint (plus the collection slots), and the
/// total carries the transient-copies multiplier: the budget is an OOM
/// guard, so overcounting is the point.
pub(crate) fn payload_bytes(value: &Value) -> u64 {
    /// One `Value` node's own footprint (the enum's size).
    const NODE: u64 = 32;
    /// The transient full-body copies one accepted capture allocates:
    /// the queued clone, the envelope's clone, and the serialization
    /// buffer.
    const TRANSIENT_COPIES: u64 = 3;
    fn tree(value: &Value) -> u64 {
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => NODE,
            Value::String(text) => NODE + text.len() as u64,
            Value::Array(items) => NODE + items.iter().map(|item| tree(item) + NODE).sum::<u64>(),
            Value::Object(map) => {
                NODE + map
                    .iter()
                    .map(|(key, item)| key.len() as u64 + tree(item) + NODE + 64)
                    .sum::<u64>()
            }
        }
    }
    tree(value).saturating_mul(TRANSIENT_COPIES)
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

/// Persist one capture: refuse any symlinked path component from the
/// trust root down (a redirected private-mode write is a disclosure, not
/// a diagnostic), owner-only directory and file modes (a shared or
/// permissively created agent dir must not expose the request bodies to
/// other local users), the durable rename through the platform wall,
/// then the ring prune. Best-effort: every failure is the caller's to
/// swallow — and a failed write takes its temp file with it.
fn write_capture(root: &Path, dir: &Path, keep: usize, job: &CaptureJob) -> std::io::Result<()> {
    use std::io::Write;
    refuse_symlinked_components(root, dir)?;
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
    // Exclusive creation: a pre-existing path (an attacker's symlink at
    // the predictable name) fails the open instead of being followed.
    options.write(true).create_new(true);
    perms::set_private_mode(&mut options);
    let write = (|| -> std::io::Result<()> {
        {
            let mut file = options.open(&temp)?;
            file.write_all(&bytes)?;
            file.flush()?;
        }
        perms::restrict_file(&temp)?;
        crate::platform::rename_onto(&temp, &target)
    })();
    if write.is_err() {
        // The ring ages crash-leftover temps; a failed write cleans up
        // after itself so repeated failures do not accumulate partial
        // bodies.
        let _ = std::fs::remove_file(&temp);
    }
    write?;
    prune(dir, keep);
    Ok(())
}

/// Refuse any symlinked path component from `root` down to `dir`: the
/// capture's owner-only modes are path-based, so a symlinked `logs` or
/// ring directory would redirect the private writes into an
/// attacker-owned tree. `symlink_metadata` inspects each component
/// without following it; a missing component is fine (the create below
/// makes it, privately), but a symlink ends the capture.
fn refuse_symlinked_components(root: &Path, dir: &Path) -> std::io::Result<()> {
    // Only the components below the trust root are walked: the root
    // itself is the user's configured agent dir (its own symlinks are
    // the user's choice); anything not under it is not the capture's
    // tree and is refused outright. A missing component is fine — the
    // private create below makes it; a symlinked one is not.
    let mut current = root.to_path_buf();
    for component in dir.strip_prefix(root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "{}: the capture directory is not under its trust root",
                dir.display()
            ),
        )
    })? {
        current = current.join(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.is_symlink() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!(
                            "{}: refusing the capture: a symlinked path component redirects private writes",
                            current.display()
                        ),
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        }
    }
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

//! The guest protocol server core (TS `CloudProtocolServer`): the
//! durable session end of the cloud wire.
//!
//! The server owns the durability contract end to end: every event is
//! appended to the outbox (fsync) before it is pushed; every submit is
//! admitted through the command journal (fsync) with the canonical
//! digest, so retries deduplicate and a crash never re-executes
//! uncertain work; hello fences the sandbox generation and requires
//! the bridge token; replay comes from the acknowledged-cursor
//! position, never from a memory window. The transport is the shared
//! [`pa_types::platform::transport`] contract, so the serving loop is
//! identical over a VM-local socket and the loopback test listener.
//!
//! Lock rule: the journal mutex is never held across an outbox append
//! or a client push (both can read the journal again through the
//! snapshot path), so every journal critical section ends before
//! [`Self::append_event`] runs.
//!
//! Fidelity gaps against TS, deliberate and documented: the
//! authenticated-silence reaper (a VM-bridge concern; the loopback
//! never needs it), retention trimming (a full unacked log stalls
//! honestly instead), the brokered-inference surface (this slice has
//! no broker wiring; frames are consumed silently), and the abort
//! queue bypass (claims are strictly sequential here).

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
#[cfg(test)]
use pa_types::daemon::cloud::CloudCommandReceipt;
use pa_types::daemon::cloud::{CloudCommandId, CloudCursor, CloudEvent, CloudSessionStatus};
use tokio::sync::{watch, Notify};

use crate::cloud_guest::dispatch::{GuestDispatchOutcome, GuestSessionSnapshot};
use crate::cloud_guest::journal::{ClaimedCommand, GuestCommandJournal};
use crate::cloud_guest::now_iso;
use crate::cloud_guest::outbox::{GuestEventInput, GuestEventOutbox};

mod clients;
mod submit;

/// One serve loop's claim retry backoff (TS `dispatchLoop`'s 100ms catch
/// arm).
const CLAIM_ERROR_BACKOFF: Duration = Duration::from_millis(100);

/// The guest session's durable command/event state plus its live client
/// table.
pub struct GuestProtocolServer {
    session_id: String,
    generation: u64,
    token: String,
    journal: Mutex<GuestCommandJournal>,
    outbox: Mutex<GuestEventOutbox>,
    status: Mutex<CloudSessionStatus>,
    snapshot_state: Mutex<GuestSessionSnapshot>,
    active_command: Mutex<Option<CloudCommandId>>,
    clients: Mutex<HashMap<String, Arc<clients::ClientHandle>>>,
    work_notify: Notify,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
    status_file: Option<PathBuf>,
    status_file_write: Mutex<()>,
    work_admitted: AtomicBool,
    retention_stalled: AtomicBool,
    stopping: AtomicBool,
}

impl GuestProtocolServer {
    /// Open the durable state for one guest session: the command journal
    /// and the event outbox under `state_dir`, the protocol identity, and
    /// the status-file probe path (TS `CloudProtocolServer`'s
    /// constructor). Restored accepted commands replay; restored running
    /// commands surface uncertain and are never replayed.
    ///
    /// # Errors
    ///
    /// Returns an error when the state directory cannot back the
    /// journal or the outbox.
    pub fn open(
        state_dir: &Path,
        session_id: &str,
        generation: u64,
        token: &str,
        status_file: PathBuf,
        workspace: String,
        model: Option<String>,
    ) -> Result<Self> {
        let journal = GuestCommandJournal::open(&state_dir.join("command-journal.ndjson"))?;
        let outbox = GuestEventOutbox::open(&state_dir.join("event-outbox"), session_id)?;
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Ok(Self {
            session_id: session_id.to_string(),
            generation,
            token: token.to_string(),
            journal: Mutex::new(journal),
            outbox: Mutex::new(outbox),
            status: Mutex::new(CloudSessionStatus::Starting),
            snapshot_state: Mutex::new(GuestSessionSnapshot {
                cwd: workspace,
                model,
            }),
            active_command: Mutex::new(None),
            clients: Mutex::new(HashMap::new()),
            work_notify: Notify::new(),
            shutdown_tx,
            shutdown_rx,
            status_file: Some(status_file),
            status_file_write: Mutex::new(()),
            work_admitted: AtomicBool::new(false),
            retention_stalled: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        })
    }

    /// The pre-allocated cloud session id this server hosts.
    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The sandbox generation that fences stale attachments.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The bridge-token comparison target.
    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Terminal receipts restored without a settle record; surfaced
    /// honestly (TS `listUncertainCommands`).
    #[must_use]
    #[cfg(test)]
    pub fn list_uncertain(&self) -> Vec<CloudCommandReceipt> {
        self.journal_lock().list_uncertain()
    }

    /// Ids of admitted commands the dispatcher has not claimed yet.
    #[must_use]
    #[cfg(test)]
    pub fn list_pending_command_ids(&self) -> Vec<CloudCommandId> {
        self.journal_lock()
            .list_pending()
            .into_iter()
            .map(|receipt| receipt.command_id)
            .collect()
    }

    /// Host assertion that one uncertain command never started: makes
    /// it dispatchable again (TS `requeue`). Nothing else ever moves an
    /// uncertain command — not the restore, not the claim loop.
    ///
    /// # Errors
    ///
    /// Returns the TS error when the command is unknown or not
    /// uncertain, or the durable transition fails.
    #[cfg(test)]
    pub fn requeue_command(&self, command_id: &str) -> anyhow::Result<()> {
        self.journal_lock().requeue(command_id)?;
        self.notify_work();
        Ok(())
    }

    /// Serve connections until a release command stops the daemon (or
    /// [`begin_shutdown`] is called): the accept task plus the claim
    /// loop, sharing the executor seam.
    ///
    /// # Errors
    ///
    /// Returns the transport's accept error once the accept loop gives
    /// up.
    pub async fn serve(
        self: &Arc<Self>,
        listener: Box<dyn pa_types::platform::transport::TransportListener>,
        executor: Arc<dyn crate::cloud_guest::dispatch::GuestExecutor>,
    ) -> Result<()> {
        let accept = {
            let server = Arc::clone(self);
            let mut shutdown = self.shutdown_rx.clone();
            tokio::spawn(async move {
                let listener = listener;
                loop {
                    let accepted = tokio::select! {
                        accepted = listener.accept() => Some(accepted),
                        changed = shutdown.changed() => {
                            if changed.is_ok() {
                                None
                            } else {
                                continue;
                            }
                        }
                    };
                    let Some(accepted) = accepted else {
                        break;
                    };
                    match accepted {
                        Ok(stream) => server.accept_connection(stream),
                        Err(error) => {
                            server.record_dispatch_error(&format!("accept error: {error}"));
                            break;
                        }
                    }
                }
            })
        };
        crate::cloud_guest::dispatch::dispatch_loop(Arc::clone(self), executor).await;
        self.stopping.store(true, Ordering::SeqCst);
        self.shutdown_tx.send_replace(true);
        accept.abort();
        self.close_all_clients();
        Ok(())
    }

    /// Stop serving outside a release command (the harness's kill).
    #[cfg(test)]
    pub fn begin_shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.shutdown_tx.send_replace(true);
        self.work_notify.notify_one();
    }

    /// True once release or shutdown stopped the serving loop.
    #[must_use]
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst) || *self.shutdown_rx.borrow()
    }

    /// Wake the claim loop (a new admission or a restore replay).
    pub fn notify_work(&self) {
        self.work_notify.notify_one();
    }

    /// Wait for the next admission or the shutdown (the TS loop's 20ms
    /// poll, without the poll).
    pub async fn wait_for_work(&self) {
        let mut shutdown = self.shutdown_rx.clone();
        tokio::select! {
            () = self.work_notify.notified() => {}
            changed = shutdown.changed() => {
                let _ = changed;
            }
        }
    }

    /// Claim the oldest dispatchable command and begin it: the journal
    /// fsyncs the running transition before the request leaves it, the
    /// running command-state event lands in the outbox, and the session
    /// turns busy. A journal error reports, backs off, and re-arms the
    /// claim (TS `dispatchLoop`'s catch arm).
    pub async fn claim_and_begin(&self) -> Option<ClaimedCommand> {
        let claimed = self
            .journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .claim_next_pending();
        match claimed {
            Ok(Some(claimed)) => {
                let receipt = claimed.receipt.clone();
                *self
                    .active_command
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some(claimed.receipt.command_id.clone());
                self.append_event(GuestEventInput::CommandState {
                    recorded_at: now_iso(),
                    receipt,
                });
                self.set_status(CloudSessionStatus::Busy);
                Some(claimed)
            }
            Ok(None) => None,
            Err(error) => {
                self.record_dispatch_error(&format!("claim failed: {error:#}"));
                tokio::time::sleep(CLAIM_ERROR_BACKOFF).await;
                self.notify_work();
                None
            }
        }
    }

    /// Settle one executed command: the journal transition fsyncs, the
    /// terminal command-state event lands in the outbox, and a release
    /// walks the stopping/stopped transition and stops the server (TS
    /// `settleCommand` + `release`). A settle that cannot journal stays
    /// visible through the honest uncertain path after a restore.
    pub async fn settle(&self, command_id: &str, outcome: &GuestDispatchOutcome, release: bool) {
        let receipt = {
            let mut journal = self
                .journal
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let settled = match outcome {
                GuestDispatchOutcome::Completed { result } => {
                    journal.complete(command_id, result.as_deref())
                }
                GuestDispatchOutcome::Failed { error } => {
                    journal.fail(command_id, error.as_deref())
                }
                GuestDispatchOutcome::Cancelled => journal.cancel(command_id),
            };
            settled.and_then(|()| {
                journal
                    .receipt(command_id)
                    .ok_or_else(|| anyhow::anyhow!("receipt vanished"))
            })
        };
        match receipt {
            Ok(receipt) => {
                self.append_event(GuestEventInput::CommandState {
                    recorded_at: now_iso(),
                    receipt,
                });
            }
            Err(error) => {
                self.record_dispatch_error(&format!("settling {command_id} failed: {error}"));
            }
        }
        *self
            .active_command
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        if release {
            self.set_status(CloudSessionStatus::Stopping);
            self.set_status(CloudSessionStatus::Stopped);
            self.stopping.store(true, Ordering::SeqCst);
            self.shutdown_tx.send_replace(true);
        } else {
            self.set_status(CloudSessionStatus::Idle);
        }
    }

    /// Refresh the session-facing snapshot from the executor.
    pub fn refresh_snapshot(&self, snapshot: GuestSessionSnapshot) {
        *self
            .snapshot_state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
    }

    /// The live session status.
    #[must_use]
    pub fn status(&self) -> CloudSessionStatus {
        *self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Transition the session status and mirror it into the durable
    /// outbox (TS `setStatus`).
    pub fn set_status(&self, status: CloudSessionStatus) {
        let changed = {
            let mut current = self
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *current == status {
                false
            } else {
                *current = status;
                true
            }
        };
        if changed {
            self.append_event(GuestEventInput::SessionStatus {
                recorded_at: now_iso(),
                status,
            });
            self.persist_status_file();
        }
    }

    /// Mark that work was admitted (drives `idleAfterWork` in the
    /// status probe, TS `workAdmitted`).
    pub fn mark_work_admitted(&self) {
        self.work_admitted.store(true, Ordering::SeqCst);
    }

    /// Append one event to the durable log and push it to subscribed
    /// clients (TS `appendEvent`). The append fsyncs before the push, so
    /// a push failure never loses the event. A full unacked log stalls
    /// honestly: the event is reported lost through the dispatch error
    /// channel, and the stall clears on the next successful append.
    pub fn append_event(&self, input: GuestEventInput) -> Option<CloudEvent> {
        let appended = self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .append(input);
        let event = match appended {
            Ok(event) => {
                if self.retention_stalled.swap(false, Ordering::SeqCst) {
                    self.persist_status_file();
                }
                Some(event)
            }
            Err(error) => {
                if !self.retention_stalled.swap(true, Ordering::SeqCst) {
                    self.record_dispatch_error(&format!("cloud event append: {error:#}"));
                    self.persist_status_file();
                }
                None
            }
        };
        self.push_due_events();
        event
    }

    /// The durable event tail (TS `tailCursor`).
    #[must_use]
    pub fn tail_cursor(&self) -> CloudCursor {
        self.outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tail_cursor()
    }

    /// Record a non-fatal dispatch/delivery error for honest
    /// diagnostics (TS `onDispatchError`).
    pub fn record_dispatch_error(&self, message: &str) {
        eprintln!("cloud guest: {message}");
    }

    /// The event-log generation of the outbox (TS `currentGeneration`).
    #[must_use]
    pub fn event_generation(&self) -> u64 {
        self.outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .generation()
    }

    /// The journal under its mutex (poison-tolerant: a panicked holder
    /// must not wedge the durable protocol surface).
    pub(super) fn journal_lock(&self) -> std::sync::MutexGuard<'_, GuestCommandJournal> {
        self.journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The outbox under its mutex (poison-tolerant, like
    /// [`Self::journal_lock`]).
    pub(super) fn outbox_lock(&self) -> std::sync::MutexGuard<'_, GuestEventOutbox> {
        self.outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Write the bridge status probe (TS `persistStatusFile`): the
    /// semantic payload, the 0600 temp file, and the rename.
    fn persist_status_file(&self) {
        let Some(path) = self.status_file.clone() else {
            return;
        };
        // One writer at a time: the dispatch loop's status transitions
        // and a connection task's retention-stall edge can otherwise
        // interleave open-truncate-write pairs on the same temp file and
        // rename a torn probe into place.
        let _one_writer = self
            .status_file_write
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let status = self.status();
        let idle_after_work =
            self.work_admitted.load(Ordering::SeqCst) && status == CloudSessionStatus::Idle;
        let payload = format!(
            "{{\"status\":\"{}\",\"idleAfterWork\":{},\"retentionStalled\":{},\"updatedAt\":\"{}\"}}\n",
            status_str(status),
            idle_after_work,
            self.retention_stalled.load(Ordering::SeqCst),
            now_iso()
        );
        let result = (|| -> std::io::Result<()> {
            let temp = path.with_extension("json.tmp");
            let mut options = std::fs::OpenOptions::new();
            options.create(true).write(true).truncate(true);
            pa_core::platform::perms::set_private_mode(&mut options);
            let mut file = options.open(&temp)?;
            file.write_all(payload.as_bytes())?;
            file.sync_all()?;
            pa_core::platform::rename_onto(&temp, &path)
        })();
        if let Err(error) = result {
            self.record_dispatch_error(&format!("status file: {error}"));
        }
    }
}

fn status_str(status: CloudSessionStatus) -> &'static str {
    match status {
        CloudSessionStatus::Starting => "starting",
        CloudSessionStatus::Idle => "idle",
        CloudSessionStatus::Busy => "busy",
        CloudSessionStatus::Stopping => "stopping",
        CloudSessionStatus::Stopped => "stopped",
        CloudSessionStatus::Failed => "failed",
    }
}

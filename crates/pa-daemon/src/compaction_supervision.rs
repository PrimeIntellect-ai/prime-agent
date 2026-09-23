//! The supervisor's compaction-abort supervision: the abort token for
//! workers that cannot answer their own abort command.
//!
//! The worker's abort slot ([`crate::compaction::CompactionManager::abort`])
//! and the engine's `auto_compaction_abort` answer an `abort_compaction`
//! only while the worker's command plane is alive. When a worker wedges
//! mid-compaction — the runtime running the summarizer stops answering —
//! the routed abort rides the same dead channel and dies on the 30s route
//! timeout, leaving every attached loader hung with no `compaction_end`
//! ever.
//!
//! This module lifts the abort to the supervisor plane. The token arms on
//! the `compaction_start` frame the supervisor already forwards and clears
//! on the matching end; the supervisor's `abort_compaction` arm acknowledges
//! immediately without a worker round-trip (the TS daemon-mode
//! `abortCompaction` is in-process and always instant — the worker split
//! must not regress that) and still forwards best-effort so a healthy
//! worker aborts its own run. When no end lands within the grace window,
//! the supervisor declares the run terminal: the durable record goes to
//! its own journal (the terminal state survives supervisor restarts and
//! feeds the replacement-worker create replay), and the synthetic
//! `compaction_end` broadcast clears every attached loader.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// How long the supervisor waits for the worker's own `compaction_end`
/// after an abort before declaring the run terminal. A healthy worker
/// lands the abort race in well under a second; the grace only bounds the
/// wedged case.
pub(crate) const ABORT_GRACE_MS: u64 = 10_000;

/// How long the best-effort abort forward waits for the worker. The reply
/// never gates the client acknowledgment; this only retires the pending
/// request when the worker is merely slow rather than wedged.
pub(crate) const ABORT_FORWARD_TIMEOUT_MS: u64 = 5_000;

/// The supervisor's view of one resident session's in-flight compaction:
/// the worker's own abort slot mirrored at the plane that stays answerable
/// when the worker does not. Armed by the forwarded `compaction_start`,
/// cleared by the forwarded `compaction_end`, aborted by the
/// `abort_compaction` supervisor arm.
#[derive(Debug, Default)]
pub(crate) struct CompactionSupervision {
    state: Mutex<Option<InFlightCompaction>>,
    /// The monotonic abort-epoch source: every armed run takes a fresh
    /// epoch, so a watch task never matches a run it did not observe
    /// (slot clears must not recycle epochs).
    next_epoch: std::sync::atomic::AtomicU64,
}

/// One armed run: the wire identity of the session (as the
/// `compaction_start` frame carried it, so a synthetic end routes to the
/// same attached clients), the run's reason, and the abort bookkeeping.
#[derive(Debug, Clone, PartialEq, Eq)]
struct InFlightCompaction {
    active_session_id: String,
    reason: String,
    /// The abort counter at the moment the arm was taken: a watch task
    /// declares terminal only for the abort it observed.
    abort_epoch: u64,
    abort_requested_at_epoch: Option<u64>,
    /// The supervisor already declared this run terminal (the synthetic
    /// end went out); a late real end must not redeclare.
    terminal: bool,
}

/// The terminal declaration returned to the watch task: everything the
/// synthetic `compaction_end` and the journal record need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalCompaction {
    pub(crate) active_session_id: String,
    pub(crate) reason: String,
}

impl CompactionSupervision {
    /// A `compaction_start` frame flowed through: arm the slot. A stale
    /// slot from a run that never settled is replaced — the new run owns
    /// the newest abort, like the worker's own slot replacement.
    pub(crate) fn arm(&self, active_session_id: &str, reason: &str) {
        let epoch = self
            .next_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut state = self.state.lock().expect("compaction supervision lock");
        *state = Some(InFlightCompaction {
            active_session_id: active_session_id.to_string(),
            reason: reason.to_string(),
            abort_epoch: epoch,
            abort_requested_at_epoch: None,
            terminal: false,
        });
    }

    /// Arm the fallback run of an abort that found no observed run and no
    /// answering worker (the empty-slot wedge: a supervisor restart or a
    /// dropped run while the client still holds a loader). A live run that
    /// armed during the probe wait is never stomped — the abort lands on
    /// it instead; a terminal leftover yields no fallback (that run was
    /// already declared). The fallback's reason is `manual` — the abort is
    /// user-initiated and a manual record replays no durable row — and the
    /// abort is already requested. Returns the epoch to watch, or `None`.
    pub(crate) fn arm_aborted_fallback(&self, active_session_id: &str) -> Option<u64> {
        let mut state = self.state.lock().expect("compaction supervision lock");
        match state.as_mut() {
            Some(run) if run.terminal => None,
            Some(run) => {
                let epoch = run.abort_epoch;
                run.abort_requested_at_epoch = Some(epoch);
                Some(epoch)
            }
            None => {
                let epoch = self
                    .next_epoch
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                *state = Some(InFlightCompaction {
                    active_session_id: active_session_id.to_string(),
                    reason: "manual".to_string(),
                    abort_epoch: epoch,
                    abort_requested_at_epoch: Some(epoch),
                    terminal: false,
                });
                Some(epoch)
            }
        }
    }

    /// A `compaction_end` frame flowed through: the run settled on its
    /// own (real abort, skip, failure, or success) — the supervisor has
    /// nothing terminal to declare.
    pub(crate) fn observe_end(&self) {
        *self.state.lock().expect("compaction supervision lock") = None;
    }

    /// The worker connection ended: a run without an abort request dies
    /// with the worker and rides the normal recovery flow; a run with a
    /// pending abort is declared terminal immediately — the worker can
    /// never land its own end now, and the declaration must be durable
    /// before the relaunch replays the create.
    pub(crate) fn observe_worker_gone(&self) -> Option<TerminalCompaction> {
        let mut state = self.state.lock().expect("compaction supervision lock");
        let declared = match state.as_mut() {
            Some(run) if run.abort_requested_at_epoch.is_some() && !run.terminal => {
                run.terminal = true;
                Some(TerminalCompaction {
                    active_session_id: run.active_session_id.clone(),
                    reason: run.reason.clone(),
                })
            }
            _ => None,
        };
        *state = None;
        declared
    }

    /// An `abort_compaction` landed at the supervisor: mark the armed run
    /// and return the epoch the watch task declares against. No armed run
    /// means nothing to supervise — the TS abort is a silent no-op then.
    pub(crate) fn request_abort(&self) -> Option<u64> {
        let mut state = self.state.lock().expect("compaction supervision lock");
        let run = state.as_mut()?;
        if run.terminal {
            return None;
        }
        let epoch = run.abort_epoch;
        run.abort_requested_at_epoch = Some(epoch);
        Some(epoch)
    }

    /// Declare the run terminal when the abort this watch task observed
    /// never resolved: still armed, still abort-requested at that epoch.
    /// Returns the declaration for the synthetic end and the journal, or
    /// `None` when the run settled (or a newer run/abort owns the slot).
    pub(crate) fn declare_terminal_if_unresolved(&self, epoch: u64) -> Option<TerminalCompaction> {
        let mut state = self.state.lock().expect("compaction supervision lock");
        let run = state.as_mut()?;
        if run.terminal || run.abort_requested_at_epoch != Some(epoch) {
            return None;
        }
        run.terminal = true;
        Some(TerminalCompaction {
            active_session_id: run.active_session_id.clone(),
            reason: run.reason.clone(),
        })
    }
}

/// One persisted terminal compaction: the supervisor's durable record of a
/// run it declared aborted (its own journal, never the worker's session
/// file — the worker owns that surface and a wedged worker cannot append).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCompactionRecord {
    pub(crate) version: u32,
    pub(crate) r#type: String,
    pub(crate) active_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) session_file: Option<String>,
    pub(crate) reason: String,
    pub(crate) declared_at: String,
}

/// The terminal-compaction journal: one append-only JSONL next to the
/// worker descriptors, latest record per session. Declared records feed
/// the replacement-worker create replay until they are consumed; a
/// `compaction_end` that did land clears them.
pub(crate) struct TerminalCompactionJournal {
    path: PathBuf,
    latest: HashMap<String, TerminalCompactionRecord>,
}

const TERMINAL_COMPACTION_RECORD_TYPE: &str = "terminal_compaction";

impl TerminalCompactionJournal {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(TerminalCompactionJournal {
            latest: Self::load(path),
            path: path.to_path_buf(),
        })
    }

    fn load(path: &Path) -> HashMap<String, TerminalCompactionRecord> {
        let Ok(content) = std::fs::read_to_string(path) else {
            return HashMap::new();
        };
        let mut latest = HashMap::new();
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<TerminalCompactionRecord>(line) else {
                continue;
            };
            latest.insert(record.active_session_id.clone(), record);
        }
        latest
    }

    /// Record the terminal declaration (durable before the synthetic end
    /// goes out, so a supervisor crash between the two still leaves the
    /// state on disk).
    pub(crate) fn declare(&mut self, record: TerminalCompactionRecord) -> Result<()> {
        crate::journal::append_record(&self.path, &serde_json::to_value(&record)?)?;
        self.latest.insert(record.active_session_id.clone(), record);
        Ok(())
    }

    /// Drop a session's record and rewrite the journal. The in-memory row
    /// goes only after the rewrite landed, so a failed rewrite stays
    /// retryable and memory never diverges from disk.
    fn remove(&mut self, active_session_id: &str) -> Result<()> {
        if !self.latest.contains_key(active_session_id) {
            return Ok(());
        }
        let records = self
            .latest
            .values()
            .filter(|record| record.active_session_id != active_session_id)
            .map(serde_json::to_value)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        crate::journal::rewrite_records(&self.path, &records, crate::journal::Finalize::Bare)?;
        self.latest.remove(active_session_id);
        Ok(())
    }

    /// The run settled after all (`compaction_end` landed): drop the
    /// record so a later replacement never replays a stale abort.
    pub(crate) fn clear(&mut self, active_session_id: &str) -> Result<()> {
        self.remove(active_session_id)
    }

    /// The unconsumed declaration for a session, if one is pending: the
    /// replacement worker's create replay carries it so the rebuilt
    /// transcript discloses the abort.
    pub(crate) fn pending(&self, active_session_id: &str) -> Option<&TerminalCompactionRecord> {
        self.latest.get(active_session_id)
    }

    /// The create replay carried the record: it is consumed and never
    /// replays again (the journal stays bounded by live declarations).
    pub(crate) fn consume(&mut self, active_session_id: &str) -> Result<()> {
        self.remove(active_session_id)
    }
}

/// The grace window as a `Duration` (the watch task's sleep).
pub(crate) fn abort_grace() -> Duration {
    Duration::from_millis(ABORT_GRACE_MS)
}

impl crate::supervisor::Supervisor {
    /// The `abort_compaction` supervisor arm (this lane's wedged-compaction
    /// fix). The acknowledgment is immediate — the TS daemon-mode
    /// `abortCompaction` is an in-process call that always replies success,
    /// and the supervisor/worker split must not regress that into the
    /// worker's 30s route timeout when the worker is the thing that
    /// wedged. The abort still forwards best-effort so a healthy worker
    /// aborts its own run and emits the real `compaction_end`; a run that
    /// stays armed past the grace window gets the supervisor's terminal
    /// declaration instead. An abort with no observed run probes the
    /// forward: an answering worker is the TS silent no-op, an unanswering
    /// one gets a fallback run so the client's loader still resolves.
    pub(crate) async fn handle_abort_compaction(
        self: &Arc<Self>,
        command: &pa_types::daemon::DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<serde_json::Value>, bool) {
        let selector = match crate::protocol::command_active_session_id(command) {
            Some(selector) => selector.to_string(),
            None => {
                return (
                    vec![crate::protocol::response_line(
                        &crate::protocol::response_failure(
                            Some(command_id),
                            type_name,
                            &format!("Supervisor cannot route daemon command: {type_name}"),
                            None,
                        ),
                    )],
                    false,
                )
            }
        };
        // No restore wait here: a routed command may queue behind an
        // in-flight restore pass for up to its full window, but the abort's
        // contract is the immediate acknowledgment. An unknown or
        // still-restoring session fails fast — the client's local recovery
        // clears the loader on the failure.
        let resident = match self.registry.resolve(&selector).await {
            Ok(resident) => resident,
            Err(_) => {
                let message = self
                    .restore_failure_for(&selector)
                    .unwrap_or_else(|| format!("Unknown active session: {selector}"));
                return (
                    vec![crate::protocol::response_line(
                        &crate::protocol::response_failure(
                            Some(command_id),
                            type_name,
                            &message,
                            None,
                        ),
                    )],
                    false,
                );
            }
        };
        // The supervisor-visible token takes the abort even when the
        // worker cannot answer; the best-effort forward below is what a
        // healthy worker still sees. TS `abortCompaction` always replies
        // success — wedged or idle alike.
        let watch_epoch = resident.compaction.request_abort();
        let forward = self.forward_abort_compaction(&resident, command, client_id);
        let supervisor = Arc::clone(self);
        let resident = Arc::clone(&resident);
        tokio::spawn(async move {
            let epoch = match watch_epoch {
                Some(epoch) => {
                    // The armed path never gates on the forward: it runs
                    // concurrently and the real `compaction_end` it may
                    // produce clears the token through the reader hook.
                    tokio::spawn(forward);
                    epoch
                }
                None => {
                    // No observed run. A worker that answers the forward is
                    // the TS silent no-op; one that does not (wedged, or a
                    // token lost to a supervisor restart) gets the fallback
                    // run, so the abort still resolves the client's loader.
                    // A real run that armed during the probe wait takes the
                    // abort instead of being stomped.
                    if matches!(forward.await, Some(Ok(_))) {
                        return;
                    }
                    let active_session_id = resident
                        .descriptor
                        .lock()
                        .await
                        .root_active_session_id
                        .clone();
                    match resident.compaction.arm_aborted_fallback(&active_session_id) {
                        Some(epoch) => epoch,
                        None => return,
                    }
                }
            };
            supervisor
                .watch_unresolved_compaction_abort(resident, epoch)
                .await;
        });
        (
            vec![crate::protocol::response_line(
                &crate::protocol::response_success(Some(command_id), type_name, None),
            )],
            false,
        )
    }

    /// Forward the abort to the worker without gating the acknowledgment:
    /// a healthy worker aborts its run and emits the real `compaction_end`
    /// (which clears the token through the forwarded-events hook); a
    /// wedged worker never answers and the bounded timeout retires the
    /// pending request. The returned future settles with the forward's
    /// outcome (`None` when the command never serialized).
    fn forward_abort_compaction(
        self: &Arc<Self>,
        resident: &Arc<crate::registry::ResidentWorker>,
        command: &pa_types::daemon::DaemonCommand,
        client_id: &str,
    ) -> impl std::future::Future<Output = Option<Result<pa_types::daemon::DaemonResponse>>> + Send
    {
        let payload = crate::supervisor::client_command_payload(command, client_id)
            .ok()
            .map(|(_type_name, payload)| payload);
        let supervisor = Arc::clone(self);
        let resident = Arc::clone(resident);
        async move {
            let payload = payload?;
            Some(
                supervisor
                    .route_command(
                        &resident,
                        "abort_compaction",
                        payload,
                        ABORT_FORWARD_TIMEOUT_MS,
                    )
                    .await
                    .and_then(|response| {
                        if response.success {
                            Ok(response)
                        } else {
                            Err(anyhow::anyhow!(
                                "abort_compaction forward failed: {}",
                                response.error.unwrap_or_default()
                            ))
                        }
                    }),
            )
        }
    }

    /// The grace-window watch over an abort the token still holds armed:
    /// when the worker never lands its own `compaction_end`, declare the
    /// run terminal. One declaration per abort epoch.
    async fn watch_unresolved_compaction_abort(
        self: &Arc<Self>,
        resident: Arc<crate::registry::ResidentWorker>,
        epoch: u64,
    ) {
        tokio::time::sleep(abort_grace()).await;
        self.declare_compaction_terminal(&resident, || {
            resident.compaction.declare_terminal_if_unresolved(epoch)
        })
        .await;
    }

    /// Land one terminal declaration: the durable record in the
    /// supervisor's journal (before the broadcast, so a supervisor crash
    /// between the two still leaves the state on disk for the
    /// replacement), the adoption count, and the synthetic aborted
    /// `compaction_end` broadcast that clears every attached loader.
    ///
    /// `take` claims the token's declaration and runs UNDER the journal
    /// lock, so a real `compaction_end` landing concurrently either
    /// empties the token first (nothing is taken, nothing written) or
    /// clears the just-written record right after — a stale record can
    /// never survive a run that actually settled.
    pub(crate) async fn declare_compaction_terminal(
        self: &Arc<Self>,
        resident: &Arc<crate::registry::ResidentWorker>,
        take: impl FnOnce() -> Option<TerminalCompaction>,
    ) {
        let session_file = resident.descriptor.lock().await.session_file.clone();
        let declared = crate::util::now_iso();
        let terminal = {
            let mut journal = self
                .compaction_journal
                .lock()
                .expect("compaction journal lock");
            let Some(terminal) = take() else {
                return;
            };
            let record = TerminalCompactionRecord {
                version: 1,
                r#type: TERMINAL_COMPACTION_RECORD_TYPE.to_string(),
                active_session_id: terminal.active_session_id.clone(),
                session_file,
                reason: terminal.reason.clone(),
                declared_at: declared.clone(),
            };
            if let Err(error) = journal.declare(record) {
                self.log_line(&format!(
                    "terminal compaction journal declare failed for {}: {error:#}",
                    terminal.active_session_id
                ));
            }
            terminal
        };
        self.note_compaction_abort_declared();
        // The synthetic `compaction_end`: an abort carries `aborted: true`
        // with no error message, and the `errorSeverity` mirrors the end
        // the worker itself would have landed for this run — the manual
        // arm carries `"error"` (TS `compact()`'s abort shape), the auto
        // arms carry none (TS `_endCompactionUnsuccessfully`'s cancelled
        // shape). The event routes to the session's attached clients like
        // the worker's own frames.
        let error_severity = (terminal.reason == "manual").then_some("error");
        let event = crate::compaction::compaction_end_unsuccessful(
            &terminal.reason,
            true,
            None,
            error_severity,
            None,
        );
        let frame = serde_json::to_value(pa_types::daemon::DaemonOutbound::SessionEvent {
            active_session_id: terminal.active_session_id.clone(),
            event,
            meta: None,
            rest: Default::default(),
        })
        .unwrap_or_default();
        let _ = self.events.send((
            crate::supervisor::ClientRouting::AttachedSession {
                active_session_id: terminal.active_session_id.clone(),
            },
            frame,
        ));
        self.log_line(&format!(
            "declared terminal aborted compaction for {} (reason {}, declared {declared})",
            terminal.active_session_id, terminal.reason
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supervision_with_run(reason: &str) -> CompactionSupervision {
        let supervision = CompactionSupervision::default();
        supervision.arm("session-a", reason);
        supervision
    }

    /// The token lifecycle: arm on start, clear on end, nothing terminal.
    #[test]
    fn armed_run_settles_on_its_own_end() {
        let supervision = supervision_with_run("manual");
        let epoch = supervision.request_abort().expect("armed run");
        supervision.observe_end();
        assert_eq!(supervision.declare_terminal_if_unresolved(epoch), None);
    }

    /// The wedged case: armed, aborted, no end within the grace — the
    /// declaration carries the wire identity and reason.
    #[test]
    fn unresolved_abort_declares_terminal() {
        let supervision = supervision_with_run("threshold");
        let epoch = supervision.request_abort().expect("armed run");
        assert_eq!(
            supervision.declare_terminal_if_unresolved(epoch),
            Some(TerminalCompaction {
                active_session_id: "session-a".to_string(),
                reason: "threshold".to_string(),
            })
        );
        // Terminal is one-shot: a late second watch must not redeclare.
        assert_eq!(supervision.declare_terminal_if_unresolved(epoch), None);
    }

    /// A second run after the first abort owns a fresh epoch: the first
    /// watch task never declares the newer run terminal.
    #[test]
    fn a_newer_run_escapes_an_older_watch() {
        let supervision = supervision_with_run("manual");
        let first = supervision.request_abort().expect("armed run");
        supervision.arm("session-a", "threshold");
        let second = supervision.request_abort().expect("re-armed run");
        assert_ne!(first, second);
        assert_eq!(supervision.declare_terminal_if_unresolved(first), None);
        assert_eq!(
            supervision
                .declare_terminal_if_unresolved(second)
                .map(|declared| declared.reason),
            Some("threshold".to_string())
        );
    }

    /// An abort with no armed run is the TS silent no-op.
    #[test]
    fn abort_without_a_run_supervises_nothing() {
        let supervision = CompactionSupervision::default();
        assert_eq!(supervision.request_abort(), None);
    }

    /// A worker death without an abort takes the run with it (the normal
    /// recovery flow owns the surface); an abort-requested run is
    /// declared terminal on the spot, once — the late watch task finds
    /// nothing left to declare.
    #[test]
    fn worker_gone_declares_only_aborted_runs() {
        let plain = supervision_with_run("manual");
        assert_eq!(plain.observe_worker_gone(), None);
        assert_eq!(plain.request_abort(), None, "the slot cleared");

        let aborted = supervision_with_run("manual");
        let epoch = aborted.request_abort().expect("armed run");
        assert_eq!(
            aborted
                .observe_worker_gone()
                .map(|declared| declared.active_session_id),
            Some("session-a".to_string())
        );
        assert_eq!(
            aborted.declare_terminal_if_unresolved(epoch),
            None,
            "the watch never redeclares a worker-gone declaration"
        );
    }

    /// The fallback arm (an abort with no observed run and no answering
    /// worker): armed, already abort-requested, reason `manual`.
    #[test]
    fn fallback_arm_is_abort_requested_manual() {
        let supervision = CompactionSupervision::default();
        let epoch = supervision
            .arm_aborted_fallback("session-a")
            .expect("empty slot arms");
        assert_eq!(
            supervision.declare_terminal_if_unresolved(epoch),
            Some(TerminalCompaction {
                active_session_id: "session-a".to_string(),
                reason: "manual".to_string(),
            })
        );
    }

    /// The fallback never stomps a run that armed during the probe wait:
    /// the abort lands on the live run (its epoch, its reason), and a
    /// terminal leftover yields no fallback at all.
    #[test]
    fn fallback_arm_respects_a_live_run() {
        let supervision = supervision_with_run("threshold");
        let epoch = supervision
            .arm_aborted_fallback("session-a")
            .expect("live run takes the abort");
        assert_eq!(
            supervision
                .declare_terminal_if_unresolved(epoch)
                .map(|declared| declared.reason),
            Some("threshold".to_string())
        );
        assert_eq!(
            supervision.arm_aborted_fallback("session-a"),
            None,
            "a terminal leftover arms nothing"
        );
    }

    /// Epochs never recycle across slot clears: a watch from a settled
    /// run cannot match a later run that reused the slot.
    #[test]
    fn epochs_stay_monotonic_across_clears() {
        let supervision = supervision_with_run("manual");
        let first = supervision.request_abort().expect("armed run");
        supervision.observe_end();
        supervision.arm("session-a", "manual");
        let second = supervision.request_abort().expect("re-armed run");
        assert_ne!(first, second);
        assert_eq!(supervision.declare_terminal_if_unresolved(first), None);
    }

    /// The journal round-trip: declare persists, pending reads it back
    /// after a reopen (a supervisor restart), consumption removes it, and
    /// a settled end clears it.
    #[test]
    fn journal_survives_restart_until_consumed_or_cleared() {
        let dir = std::env::temp_dir().join(format!("pa-comp-sup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("compaction-supervision.jsonl");
        {
            let mut journal = TerminalCompactionJournal::open(&path).unwrap();
            journal
                .declare(TerminalCompactionRecord {
                    version: 1,
                    r#type: TERMINAL_COMPACTION_RECORD_TYPE.to_string(),
                    active_session_id: "session-a".to_string(),
                    session_file: Some("/sessions/a.jsonl".to_string()),
                    reason: "threshold".to_string(),
                    declared_at: "2026-09-23T00:00:00Z".to_string(),
                })
                .unwrap();
            let pending = journal.pending("session-a").expect("declared record");
            assert_eq!(pending.reason, "threshold");
        }
        // A supervisor restart: the record is still pending.
        {
            let mut journal = TerminalCompactionJournal::open(&path).unwrap();
            assert!(journal.pending("session-a").is_some());
            journal.consume("session-a").unwrap();
            assert_eq!(journal.pending("session-a"), None, "consumed");
        }
        {
            let journal = TerminalCompactionJournal::open(&path).unwrap();
            assert_eq!(journal.pending("session-a"), None);
        }
        // A settled end clears even a pending record.
        {
            let mut journal = TerminalCompactionJournal::open(&path).unwrap();
            journal
                .declare(TerminalCompactionRecord {
                    version: 1,
                    r#type: TERMINAL_COMPACTION_RECORD_TYPE.to_string(),
                    active_session_id: "session-b".to_string(),
                    session_file: None,
                    reason: "manual".to_string(),
                    declared_at: "2026-09-23T00:00:01Z".to_string(),
                })
                .unwrap();
            journal.clear("session-b").unwrap();
            let reopened = TerminalCompactionJournal::open(&path).unwrap();
            assert_eq!(reopened.pending("session-b"), None);
        }
    }
}

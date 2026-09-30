//! The root-identity follow (the fork-isolation seam, operator bug #5): a
//! whole-session replacement (`new_session`/`switch_session`/`import_jsonl`/
//! `fork`) moves the worker onto a NEW durable session under its UNCHANGED
//! active session id, and the supervisor-side identity follows the roster
//! when it does (the port of TS `syncRootDescriptorFromRosterEntry` onto
//! the Rust roster writes).
//!
//! The follow is what detaches a forked session. Without it every
//! supervisor-side selector keeps addressing the superseded session file
//! even though the worker serves the moved-to one: the create-reuse seam
//! answers a re-open of the ORIGINAL file with the fork's worker (so a
//! message sent in the original lands in the fork), a prompt by the
//! original's durable id resolves the fork worker, and a crash of the
//! fork worker rebinds its stale address onto whatever worker later takes
//! the original file. The follow re-binds the resident descriptor (the
//! durable id, the session file, and the durable create command the
//! respawn paths replay), the persisted worker record, and the
//! stale-active-id binding table onto the session the worker actually
//! serves — exactly when the roster first sees it.
//!
//! The transition is ONE per-worker critical section: the roster write,
//! the descriptor move, the durable persist, and the binding record all
//! run under the resident's descriptor lock — the same lock every
//! identity reader takes (the registry's labels and file matches, the
//! create-reuse classification, the wake, the stale-id rebind). Two
//! properties follow: a routing reader can never observe a half-applied
//! swap (the move, its persist, and its binding land together or the
//! reader waits), and an older follow can never overwrite a newer one
//! (each accepted roster row carries its own follow inside the same
//! guard, so the persists apply in accept order — the last accepted
//! row's identity is always the one that stays).

use std::sync::Arc;

use pa_types::daemon::DaemonWorkerDescriptor;
use serde_json::Value;
use tokio::sync::MutexGuard;

use crate::registry::ResidentWorker;

use super::Supervisor;

/// The reconciliation retry's backoff cadence: 250ms base doubling to a
/// 5s cap, the registration loop's own shape (a slow-but-alive worker's
/// boot pull times out; the retry converges on its answer).
const RECONCILIATION_BACKOFF_MS: u64 = 250;
const RECONCILIATION_BACKOFF_MAX_MS: u64 = 5_000;

impl Supervisor {
    /// The quarantine's retry path: a slow-but-alive worker's boot
    /// reconciliation pull can time out, and no roster push is guaranteed
    /// while it idles — re-run the reconciliation on a backoff until the
    /// live word lands (an accepted roster write clears the quarantine
    /// wherever it arrives: the pull below, the worker's own delta, or a
    /// refresh) or the worker leaves the registry (the supervisor's own
    /// death verdict — only then may the persisted identity serve, via
    /// the lazy re-open).
    pub(crate) fn spawn_identity_reconciliation_retry(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) {
        let supervisor = Arc::clone(self);
        let resident = Arc::clone(resident);
        tokio::spawn(async move {
            let mut backoff_ms = RECONCILIATION_BACKOFF_MS;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(RECONCILIATION_BACKOFF_MAX_MS);
                if !resident.identity_quarantined() {
                    // The live word already landed elsewhere (the
                    // worker's own roster push or a concurrent pull).
                    return;
                }
                if supervisor.registry.get(&resident.worker_id).await.is_none() {
                    // The death verdict: the persisted identity serves the
                    // lazy re-open, never this quarantined resident.
                    return;
                }
                if supervisor.refresh_roster_entry(&resident).await {
                    // The pull landed: the roster write carried the
                    // identity follow and cleared the quarantine.
                    return;
                }
            }
        });
    }

    /// Follow the roster's root row for one worker's address, under the
    /// resident's descriptor guard the caller holds across the whole
    /// transition: when the row names a different durable session than
    /// the descriptor, the descriptor, the persisted record, the durable
    /// create command, and the binding table all move onto it — the same
    /// identity trio the create path writes, re-derived from the worker's
    /// live summary. Idempotent: a row matching the persisted descriptor
    /// moves nothing, so the registration/adoption/create refresh pulls
    /// stay no-ops.
    pub(crate) fn sync_root_identity_from_roster(
        &self,
        resident: &Arc<ResidentWorker>,
        descriptor: &mut MutexGuard<'_, DaemonWorkerDescriptor>,
    ) {
        let summary = {
            let roster = self.roster.lock().unwrap();
            roster
                .by_active_session_id(&resident.worker_id)
                .map(|entry| entry.summary.clone())
        };
        let Some(summary) = summary else {
            // The roster holds no root row for this worker's address: the
            // registration/adoption seeding has not landed it yet, and
            // the next write triggers the follow.
            return;
        };
        let (session_id, session_file) = match (
            summary.get("sessionId").and_then(Value::as_str),
            summary.get("sessionFile").and_then(Value::as_str),
        ) {
            (Some(session_id), Some(session_file))
                if !session_id.is_empty() && !session_file.is_empty() =>
            {
                (session_id.to_string(), session_file.to_string())
            }
            // A row without a durable identity (an in-memory `no_session`
            // session) names no file to follow: its worker never had one.
            _ => return,
        };
        if descriptor.root_session_id.as_deref() == Some(session_id.as_str())
            && descriptor.session_file.as_deref() == Some(session_file.as_str())
            && !resident.identity_persist_pending()
        {
            return;
        }
        descriptor.root_session_id = Some(session_id.clone());
        descriptor.session_file = Some(session_file.clone());
        // The durable create command must reopen the moved-to session on
        // relaunch, or a respawned worker would replay the superseded
        // session instead of the one it serves. A path-backed follow is a
        // persisted replay by construction: the worker's create refuses
        // the `noSession`+`sessionPath` combination, so a worker that
        // started `noSession` and then switched onto a real file must
        // drop the in-memory flag with the path (TS leaves it, but its
        // relaunch never replays that contradiction).
        descriptor.create_command.session_path = Some(session_file.clone());
        descriptor.create_command.no_session = None;
        // The durable record is the restart edge: a failed persist leaves
        // the LIVE routing correct (the descriptor above already moved)
        // while the persisted identity lags — retry once here, then keep
        // the transition marked pending so the next roster write (any
        // delta or refresh pull) repairs it from the live state. A
        // restart in that window re-runs the reconciliation itself: the
        // boot paths pull the live state BEFORE the routing opens, so the
        // adoption/registration re-binds and re-persists the moved-to
        // identity before a single client route can resolve it.
        // One in-transition retry: a transient write failure (a scan, an
        // fs flush) heals without waiting for the next roster write.
        let persisted = crate::descriptor::persist_worker(&resident.descriptor_path, descriptor)
            .or_else(|error| {
                let retry =
                    crate::descriptor::persist_worker(&resident.descriptor_path, descriptor);
                match retry {
                    Ok(()) => Ok(()),
                    Err(_retry_failed) => Err(error),
                }
            });
        match persisted {
            Ok(()) => resident.clear_identity_persist_pending(),
            Err(error) => {
                resident.mark_identity_persist_pending();
                self.log_line(&format!(
                    "session identity move for {} did not persist (repairing on the next roster write): {error:#}",
                    resident.worker_id
                ));
                self.note_daemon_event("root_identity_persist_failed", None);
            }
        }
        // The binding table learns the moved-to identity here: the
        // worker's address now carries the fork's durable session, and
        // the address's crash-window rebind resolves the fork's file —
        // never the original another worker may have re-opened. Recorded
        // under the same guard as the move: a stale-id rebind never
        // resolves a binding that outlived its descriptor.
        self.record_session_binding(
            &resident.worker_id,
            Some(session_id.as_str()),
            Some(session_file.as_str()),
        );
        self.log_line(&format!(
            "session identity moved: worker {} now serves session {session_id} (file {session_file})",
            resident.worker_id
        ));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pa_types::daemon::DaemonWorkerDescriptor;
    use serde_json::json;

    use crate::registry::ResidentWorker;
    use crate::supervisor::Supervisor;
    use crate::supervisor_roster::WorkerRosterDelta;

    /// A supervisor with one registered resident whose address matches its
    /// roster row (`w-a`), carrying a persisted root identity the deltas can
    /// move.
    async fn supervisor_with_movable_worker(dir: &std::path::Path) -> Arc<Supervisor> {
        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.join("daemon.sock"),
                agent_dir: dir.join("agent"),
            })
            .expect("supervisor"),
        );
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version": 2,
            "workerId": "w-a",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "token-a",
            "rootActiveSessionId": "w-a",
            "rootSessionId": "s0",
            "sessionFile": dir.join("s0.jsonl").to_string_lossy(),
            "createdAt": "2026-09-30T00:00:00Z",
            "updatedAt": "2026-09-30T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": { "sessionPath": dir.join("s0.jsonl").to_string_lossy() },
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        let resident = ResidentWorker::new("w-a".to_string(), descriptor, dir.join("w-a.json"));
        supervisor.registry.insert(resident).await;
        supervisor
    }

    /// One root-slot swap summary: the worker `w-a` now serves `session`
    /// out of `file`.
    fn swap_summary(dir: &std::path::Path, session: &str, file: &str) -> serde_json::Value {
        json!({
            "id": "w-a",
            "lifecycle": "live",
            "activity": "idle",
            "isSessionActive": false,
            "activeSessionId": "w-a",
            "sessionId": session,
            "sessionFile": dir.join(file).to_string_lossy(),
            "sessionName": "movable",
            "cwd": dir.to_string_lossy(),
            "rlmDepth": 0,
            "runtimeKind": "top-level",
            "messageCount": 1,
            "attachedClients": 0,
            "thinkingLevel": "default",
            "workerState": "ready",
        })
    }

    /// Drive one accepted roster delta for the worker (a sequenced
    /// generation, the real handler path).
    async fn drive_delta(supervisor: &Arc<Supervisor>, summary: serde_json::Value, sequence: u64) {
        let response = supervisor
            .handle_worker_roster_delta(
                "d",
                "worker_roster_delta",
                WorkerRosterDelta {
                    worker_token: "token-a".to_string(),
                    summary,
                    removed: Vec::new(),
                    sequence: Some(sequence),
                    worker_instance_id: Some("i1".to_string()),
                },
            )
            .await;
        assert!(response.success, "the delta applied: {response:?}");
    }

    /// The full identity state for the worker's address, as a triple of
    /// (the live descriptor's root session id, its session file, the
    /// persisted record's root session id) plus the binding table's
    /// session id — every identity reader funnels through the same values.
    async fn identity_state(
        supervisor: &Arc<Supervisor>,
    ) -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        let resident = supervisor.registry.get("w-a").await.expect("resident");
        let (root_session_id, session_file) = {
            let descriptor = resident.descriptor.lock().await;
            (
                descriptor.root_session_id.clone(),
                descriptor.session_file.clone(),
            )
        };
        let persisted: Option<String> = std::fs::read_to_string(&resident.descriptor_path)
            .ok()
            .and_then(|content| serde_json::from_str::<DaemonWorkerDescriptor>(&content).ok())
            .and_then(|record| record.root_session_id);
        let binding = supervisor
            .session_bindings
            .binding_for("w-a")
            .and_then(|binding| binding.session_id.clone());
        (root_session_id, session_file, persisted, binding)
    }

    /// The expected (descriptor id, file, record id, binding id) for one
    /// moved-to session.
    fn expect_state(
        dir: &std::path::Path,
        session: &str,
        file: &str,
    ) -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        let file = dir.join(file).to_string_lossy().to_string();
        (
            Some(session.to_string()),
            Some(file),
            Some(session.to_string()),
            Some(session.to_string()),
        )
    }

    /// FINDING 1's pin: successive root-slot swaps (the A → B → A chain a
    /// fork/switch sequence produces) land the identity on the FINAL row —
    /// an older follow never persists over a newer one — and a CONCURRENT
    /// burst of swaps converges on whatever row the roster accepted last,
    /// with the descriptor, the persisted record, and the binding all
    /// naming the same session.
    #[tokio::test]
    async fn successive_swaps_land_the_identity_on_the_final_row() {
        let dir = std::env::temp_dir().join(format!("pa-root-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let supervisor = supervisor_with_movable_worker(&dir).await;

        // A → B: each accepted row moves the whole triple.
        drive_delta(&supervisor, swap_summary(&dir, "sA", "a.jsonl"), 1).await;
        assert_eq!(
            identity_state(&supervisor).await,
            expect_state(&dir, "sA", "a.jsonl"),
            "the first swap moved the descriptor, the record, and the binding"
        );
        drive_delta(&supervisor, swap_summary(&dir, "sB", "b.jsonl"), 2).await;
        assert_eq!(
            identity_state(&supervisor).await,
            expect_state(&dir, "sB", "b.jsonl"),
            "the second swap moved the whole triple"
        );

        // The A → B → A chain: the final row wins, and no older follow can
        // overwrite it afterwards.
        drive_delta(&supervisor, swap_summary(&dir, "sA", "a.jsonl"), 3).await;
        assert_eq!(
            identity_state(&supervisor).await,
            expect_state(&dir, "sA", "a.jsonl"),
            "the return swap landed on the final row"
        );

        // A CONCURRENT burst of three swaps (F1, F2, F1 again): whatever
        // arrival order the accept gate admits, the live descriptor, the
        // persisted record, and the binding must name the identity of the
        // roster's final accepted row — the permanent-overwrite class
        // leaves a triple that disagrees with the roster.
        let burst = tokio::join!(
            drive_delta(&supervisor, swap_summary(&dir, "sF1", "f1.jsonl"), 4),
            drive_delta(&supervisor, swap_summary(&dir, "sF2", "f2.jsonl"), 5),
            drive_delta(&supervisor, swap_summary(&dir, "sF1", "f1.jsonl"), 6),
        );
        let _ = burst;
        let (roster_session, roster_file) = {
            let roster = supervisor.roster.lock().unwrap();
            let entry = roster
                .by_active_session_id("w-a")
                .expect("the worker's root row");
            (
                entry.summary["sessionId"].as_str().unwrap().to_string(),
                entry.summary["sessionFile"].as_str().unwrap().to_string(),
            )
        };
        let (root_session_id, session_file, persisted, binding) = identity_state(&supervisor).await;
        assert_eq!(
            root_session_id.as_deref(),
            Some(roster_session.as_str()),
            "the descriptor names the roster's final row: {root_session_id:?} vs {roster_session}"
        );
        assert_eq!(session_file.as_deref(), Some(roster_file.as_str()));
        assert_eq!(persisted.as_deref(), Some(roster_session.as_str()));
        assert_eq!(binding.as_deref(), Some(roster_session.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FINDING 3's pin: a failed durable-record write leaves the LIVE
    /// routing on the moved identity and marks the transition unresolved;
    /// the next roster write repairs the record from the live state. The
    /// restart edge is covered by the boot reconciliation (the e2e restart
    /// pin): the boot paths pull the live state before the routing opens,
    /// so the stale persisted record never serves.
    #[tokio::test]
    async fn a_failed_identity_persist_is_repaired_by_the_next_roster_write() {
        let dir = std::env::temp_dir().join(format!("pa-root-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let supervisor = supervisor_with_movable_worker(&dir).await;
        let resident = supervisor.registry.get("w-a").await.expect("resident");

        // The record path cannot take a file: the atomic write's rename
        // onto a directory fails deterministically.
        std::fs::remove_file(&resident.descriptor_path).ok();
        std::fs::create_dir_all(&resident.descriptor_path).unwrap();

        drive_delta(&supervisor, swap_summary(&dir, "sA", "a.jsonl"), 1).await;
        assert_eq!(
            resident.descriptor.lock().await.root_session_id.as_deref(),
            Some("sA"),
            "the live descriptor moved even though the record write failed"
        );
        assert!(
            resident.identity_persist_pending(),
            "the unresolved persist is marked for repair"
        );
        assert!(
            supervisor
                .session_bindings
                .binding_for("w-a")
                .is_some_and(|binding| binding.session_id.as_deref() == Some("sA")),
            "the binding follows the live identity (the routing is correct while the record lags)"
        );

        // The repair: the next write re-runs the transition's persist from
        // the live state — even a NO-CHANGE row (the identity already
        // moved in memory; the pending marker is what forces the retry).
        std::fs::remove_dir_all(&resident.descriptor_path).unwrap();
        drive_delta(&supervisor, swap_summary(&dir, "sA", "a.jsonl"), 2).await;
        assert!(
            !resident.identity_persist_pending(),
            "the repair cleared the marker"
        );
        let record: DaemonWorkerDescriptor = serde_json::from_str(
            &std::fs::read_to_string(&resident.descriptor_path).expect("the repaired record"),
        )
        .expect("the record parses");
        assert_eq!(record.root_session_id.as_deref(), Some("sA"));
        assert_eq!(
            record.session_file.as_deref(),
            Some(dir.join("a.jsonl").to_string_lossy().to_string().as_str())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FINDING 4's pin: a `noSession` worker that moved onto a persisted
    /// file must drop the in-memory flag with the path — the durable
    /// create command the relaunch replays never carries the
    /// `noSession`+`sessionPath` combination the worker's create refuses.
    #[tokio::test]
    async fn a_path_backed_replacement_clears_the_no_session_replay_flag() {
        let dir = std::env::temp_dir().join(format!("pa-root-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.join("daemon.sock"),
                agent_dir: dir.join("agent"),
            })
            .expect("supervisor"),
        );
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version": 2,
            "workerId": "w-a",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "token-a",
            "rootActiveSessionId": "w-a",
            "createdAt": "2026-09-30T00:00:00Z",
            "updatedAt": "2026-09-30T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": { "noSession": true },
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        supervisor
            .registry
            .insert(ResidentWorker::new(
                "w-a".to_string(),
                descriptor,
                dir.join("w-a.json"),
            ))
            .await;

        drive_delta(&supervisor, swap_summary(&dir, "sA", "a.jsonl"), 1).await;
        let resident = supervisor.registry.get("w-a").await.expect("resident");
        let (session_path, no_session) = {
            let descriptor = resident.descriptor.lock().await;
            (
                descriptor.create_command.session_path.clone(),
                descriptor.create_command.no_session,
            )
        };
        assert_eq!(
            session_path.as_deref(),
            Some(dir.join("a.jsonl").to_string_lossy().to_string().as_str())
        );
        assert_eq!(
            no_session, None,
            "the replay command drops the in-memory flag with the path"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    /// The boot-reconciliation quarantine pin (the final review finding): a
    /// resident whose boot reconciliation pull failed — a timeout is not
    /// proof the worker is dead — never serves ANY identity route on the
    /// unreconciled persisted record: the selector resolution, the stale
    /// file-stem selector, and the by-file reuse all refuse. The worker's
    /// own roster push (the live word, no command channel needed) carries
    /// the identity follow, reconciles the identity, and opens the
    /// routing — on the reconciled identity, never the persisted one.
    #[tokio::test]
    async fn a_quarantined_resident_never_serves_until_the_live_word_lands() {
        let dir = std::env::temp_dir().join(format!("pa-root-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let supervisor = supervisor_with_movable_worker(&dir).await;
        let resident = supervisor.registry.get("w-a").await.expect("resident");
        let stale_file = dir.join("s0.jsonl").to_string_lossy().to_string();

        // The boot outcome: the reconciliation pull refused (the resident
        // has no worker channel), the quarantine fenced it.
        assert!(
            !supervisor.refresh_roster_entry(&resident).await,
            "the pull refuses on the channel-less resident"
        );
        resident.mark_identity_quarantined();
        assert!(resident.identity_quarantined());

        // THE FENCES: the address, the stale file stem, and the by-file
        // reuse all refuse — the failure reads as the unknown session,
        // never the stale identity.
        assert!(
            supervisor.registry.resolve("w-a").await.is_err(),
            "the quarantined address never resolves"
        );
        assert!(
            supervisor.registry.resolve("s0").await.is_err(),
            "the stale persisted file stem never resolves"
        );
        assert!(
            supervisor
                .registry
                .find_by_session_file(&stale_file)
                .await
                .is_none(),
            "the stale persisted file never reuses the quarantined worker"
        );

        // THE LIVE WORD: the worker's own roster push (the delta path —
        // no command channel involved) carries the identity follow.
        drive_delta(&supervisor, swap_summary(&dir, "sA", "a.jsonl"), 1).await;
        assert!(
            !resident.identity_quarantined(),
            "the accepted roster write cleared the quarantine"
        );

        // THE ROUTING OPENS on the reconciled identity.
        let resolved = supervisor
            .registry
            .resolve("w-a")
            .await
            .expect("the address resolves once reconciled");
        let (root_session_id, session_file) = {
            let descriptor = resolved.descriptor.lock().await;
            (
                descriptor.root_session_id.clone(),
                descriptor.session_file.clone(),
            )
        };
        assert_eq!(root_session_id.as_deref(), Some("sA"));
        assert_eq!(
            session_file.as_deref(),
            Some(dir.join("a.jsonl").to_string_lossy().to_string().as_str())
        );
        let reconciled_file = dir.join("a.jsonl").to_string_lossy().to_string();
        assert!(
            supervisor
                .registry
                .find_by_session_file(&reconciled_file)
                .await
                .is_some(),
            "the reconciled file reuses the worker"
        );
        assert!(
            supervisor.registry.resolve("s0").await.is_err(),
            "the superseded persisted stem stays unresolvable"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

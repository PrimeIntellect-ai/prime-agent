//! The boot-revival ownership gate: whether a dead worker's descriptor
//! may be relaunched at a supervisor boot. #2584's busy-evidence filter
//! answered "did the journal prove live work?"; this gate answers "is that
//! proof still a genuine interruption THIS boot must heal?" — a stopped
//! or already-condemned session must never come back as an active worker
//! through the daemon's own automatic paths (the zombie-resurrection
//! fix): a client reopen is the only legitimate way back.
//!
//! Four vetoes, in check order:
//!
//! 1. The give-up verdict. A descriptor the supervisor marked `failed`
//!    (the 6-consecutive-failure cap) carries durable intent: this
//!    supervisor already tried and gave up on reviving it. A later boot
//!    re-runs that verdict, never the relaunch — otherwise every boot
//!    re-storms the same dead slots (the 12:00→17:07 recurrence on the
//!    rust-agent box).
//! 2. The stop lifecycle's archived belt (#2592). A session whose durable
//!    state is `archived` was stopped on purpose; the belt is the stop's
//!    durable half. No automatic path may flip it back to `active` —
//!    revival would erase the stop and re-register a dead session as a
//!    live worker.
//! 3. A live session lease. The runtime lease is the one ownership record
//!    every daemon sharing the agent dir can read; a live holder (this
//!    daemon's own surviving process, or another daemon's worker — the
//!    two-daemons-one-store fleet) owns the session file. Spawning a
//!    rival worker over it would either fail on the lease (the 6-strike
//!    storm) or, without leases enabled, double-serve the file.
//! 4. Stale busy evidence. A `busy` recovery record is interrupted-work
//!    proof only while it is recent: the crash window is minutes, not
//!    hours. A record older than
//!    [`REVIVAL_BUSY_EVIDENCE_MAX_AGE_MS`] is residue of an era that
//!    already ended, and a timestamp dated beyond
//!    [`REVIVAL_CLOCK_SKEW_MS`] into the future is not freshness proof
//!    either (clock rollback must not zero the age) — uncertainty
//!    never revives. The stale evidence that caused the boot storms was
//!    five-hour-old journals (a prior crash/restore whose workers went
//!    on to die or be stopped). Update-kept roster rows are exempt: the
//!    roster is this update's own point-in-time intent, so its busy
//!    journals are not the evidence being trusted.

use std::path::Path;

use pa_types::daemon::{DaemonWorkerDescriptor, DaemonWorkerLifecycle};

/// How long a `busy` recovery record still proves interrupted live work.
/// Genuine interruption is minutes old (a crash-restart or the update
/// window); the stale evidence that caused the boot storms was hours old.
/// Beyond the bound the session stays down and reopens through the next
/// client create — the same recovery TS gives every dead worker.
pub(crate) const REVIVAL_BUSY_EVIDENCE_MAX_AGE_MS: u64 = 30 * 60 * 1000;

/// Freshness tolerates only this much wall-clock skew between the
/// journal's writer and the boot reading it (two daemons on one shared
/// agent dir can disagree slightly). A timestamp further in the
/// future is not freshness proof: a clock rollback or a far-future
/// stamp must not zero the age through `saturating_sub` — uncertainty
/// never revives.
pub(crate) const REVIVAL_CLOCK_SKEW_MS: u64 = 60 * 1000;

/// One veto against relaunching a dead descriptor, with the park's log
/// reason (the adoption telemetry stays counts-only; the reason lives in
/// the daemon log).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RevivalVeto {
    /// The supervisor already gave up on this worker (`lifecycle: failed`):
    /// the give-up verdict is durable — a later boot re-runs it, never the
    /// relaunch.
    GaveUp,
    /// The session's durable state is `archived`: the stop lifecycle's belt
    /// (#2592) is durable stop intent — no automatic path may flip it back
    /// active.
    SessionArchived,
    /// A live lease holds the session file: another worker process (this
    /// daemon's or another daemon's, on a shared agent dir) owns the
    /// session — one owning daemon, one owning worker.
    LiveLeaseHeld { pid: u32 },
    /// The newest `busy` record predates the freshness bound: the evidence
    /// of interrupted work is residue of an era that already ended, not a
    /// crash this boot must heal.
    StaleBusyEvidence { recorded_at: String },
}

impl RevivalVeto {
    pub(crate) fn log_reason(&self) -> String {
        match self {
            RevivalVeto::GaveUp => {
                "was failed at the last give-up; not revived (reopens on the next client open)"
                    .to_string()
            }
            RevivalVeto::SessionArchived => {
                "its session is archived (stopped); not revived (reopens on the next client open)"
                    .to_string()
            }
            RevivalVeto::LiveLeaseHeld { pid } => format!(
                "a live worker (pid {pid}) holds its session lease; not revived (one owning daemon)"
            ),
            RevivalVeto::StaleBusyEvidence { recorded_at } => format!(
                "its busy evidence is stale (recorded {recorded_at}); not revived (reopens on the next client open)"
            ),
        }
    }
}

/// Whether a boot may relaunch one dead descriptor. `kept_by_update` is
/// the update roster's kept set (its rows revive on the update's own
/// intent, exempt from the freshness bound); `busy_recorded_at` is the
/// newest `busy` record's timestamp when the journal proves live work
/// (a kept row may carry `None` — its revival does not rest on the
/// journal).
pub(crate) fn revival_veto(
    agent_dir: &Path,
    descriptor: &DaemonWorkerDescriptor,
    kept_by_update: bool,
    busy_recorded_at: Option<&str>,
) -> Option<RevivalVeto> {
    if matches!(descriptor.lifecycle, DaemonWorkerLifecycle::Failed) {
        return Some(RevivalVeto::GaveUp);
    }
    let session_file = descriptor.session_file.as_deref().map(Path::new);
    if let Some(file) = session_file {
        if session_is_archived(file) {
            return Some(RevivalVeto::SessionArchived);
        }
        if let Some(owner) = crate::lease::live_lease_owner(agent_dir, file) {
            return Some(RevivalVeto::LiveLeaseHeld { pid: owner.pid });
        }
    }
    if !kept_by_update {
        // The busy-evidence path: the journal's proof must be fresh. A
        // missing timestamp cannot prove freshness — uncertainty must not
        // revive a session (the same philosophy as `read_interrupted`).
        let recorded_at = busy_recorded_at?;
        let now = crate::util::now_ms();
        let fresh = crate::util::iso_to_unix_ms(recorded_at).is_some_and(|at| {
            at <= now.saturating_add(REVIVAL_CLOCK_SKEW_MS)
                && now.saturating_sub(at) <= REVIVAL_BUSY_EVIDENCE_MAX_AGE_MS
        });
        if !fresh {
            return Some(RevivalVeto::StaleBusyEvidence {
                recorded_at: recorded_at.to_string(),
            });
        }
    }
    None
}

/// The session file's durable state is the archived belt (#2592's stop
/// lifecycle): a state that cannot be read does not prove a stop, so it
/// does not veto (a missing or unreadable file leaves the belt unknown —
/// the create replay's own load decides there).
fn session_is_archived(session_file: &Path) -> bool {
    crate::session_store::read_session_info(session_file)
        .and_then(|info| info.state)
        .is_some_and(|state| state == "archived")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::{iso_from_unix_ms, now_ms};

    fn descriptor(session_file: Option<&Path>) -> DaemonWorkerDescriptor {
        DaemonWorkerDescriptor {
            version: 2,
            worker_id: "w1".to_string(),
            pid: 4_194_303,
            process_start_id: None,
            socket_path: "/nonexistent/w1.sock".to_string(),
            recovery_journal_path: String::new(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/s.sock".to_string(),
            authentication_token: "token".to_string(),
            worker_instance_id: None,
            root_active_session_id: "w1".to_string(),
            owner_client_id: None,
            root_session_id: None,
            session_file: session_file.map(|p| p.to_string_lossy().to_string()),
            session_dir: None,
            telemetry_disabled: None,
            created_at: String::new(),
            updated_at: String::new(),
            lifecycle: DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Map::default(),
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        }
    }

    fn session_file(state: Option<&str>) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-revival-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = crate::session_store::SessionFile::create("/work", None, 0);
        session.append_message(serde_json::json!({
            "role": "user", "content": "hi", "timestamp": 1u64
        }));
        if let Some(state) = state {
            let _ = session.append_session_state(state);
        }
        let path = dir.join(format!("{}.jsonl", session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        path
    }

    fn agent_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-revival-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fresh_busy_evidence_passes_the_gate() {
        let file = session_file(Some("active"));
        let recorded_at = iso_from_unix_ms(now_ms() - 1_000);
        let agent_dir = agent_dir();
        assert!(revival_veto(
            &agent_dir,
            &descriptor(Some(&file)),
            false,
            Some(&recorded_at)
        )
        .is_none());
    }

    #[test]
    fn stale_busy_evidence_vetoes_the_revival() {
        let file = session_file(Some("active"));
        // The captured storm shape: a busy record written five hours
        // before the boot (the 12:00-era restore era read at 17:07).
        let recorded_at = iso_from_unix_ms(now_ms() - 5 * 60 * 60 * 1000);
        let agent_dir = agent_dir();
        let veto = revival_veto(
            &agent_dir,
            &descriptor(Some(&file)),
            false,
            Some(&recorded_at),
        )
        .expect("stale busy evidence must veto");
        assert!(matches!(veto, RevivalVeto::StaleBusyEvidence { .. }));
    }

    #[test]
    fn an_unparsable_evidence_timestamp_vetoes_the_revival() {
        let file = session_file(Some("active"));
        let agent_dir = agent_dir();
        let veto = revival_veto(&agent_dir, &descriptor(Some(&file)), false, Some("when?"))
            .expect("uncertainty must not revive");
        assert!(matches!(veto, RevivalVeto::StaleBusyEvidence { .. }));
    }

    #[test]
    fn a_future_dated_evidence_timestamp_vetoes_the_revival() {
        let file = session_file(Some("active"));
        // A far-future stamp (clock rollback or a bad write) must not
        // zero the age through saturating_sub: uncertainty never revives.
        let recorded_at = iso_from_unix_ms(now_ms() + 2 * 60 * 60 * 1000);
        let agent_dir = agent_dir();
        let veto = revival_veto(
            &agent_dir,
            &descriptor(Some(&file)),
            false,
            Some(&recorded_at),
        )
        .expect("a future stamp is not freshness proof");
        assert!(matches!(veto, RevivalVeto::StaleBusyEvidence { .. }));
    }

    #[test]
    fn evidence_within_the_clock_skew_bound_still_passes() {
        let file = session_file(Some("active"));
        // Two daemons on one store can disagree slightly; a stamp within
        // the skew bound is still the fresh proof it claims to be.
        let recorded_at = iso_from_unix_ms(now_ms() + 30 * 1000);
        let agent_dir = agent_dir();
        assert!(
            revival_veto(
                &agent_dir,
                &descriptor(Some(&file)),
                false,
                Some(&recorded_at)
            )
            .is_none(),
            "a small skew is tolerated"
        );
    }

    #[test]
    fn a_kept_update_row_skips_the_freshness_bound() {
        let file = session_file(Some("active"));
        let agent_dir = agent_dir();
        assert!(
            revival_veto(&agent_dir, &descriptor(Some(&file)), true, None).is_none(),
            "the roster's kept set is the update's own point-in-time intent"
        );
    }

    #[test]
    fn the_give_up_verdict_vetoes_even_fresh_busy_evidence() {
        let file = session_file(Some("active"));
        let recorded_at = iso_from_unix_ms(now_ms());
        let agent_dir = agent_dir();
        let mut descriptor = descriptor(Some(&file));
        descriptor.lifecycle = DaemonWorkerLifecycle::Failed;
        let veto = revival_veto(&agent_dir, &descriptor, false, Some(&recorded_at))
            .expect("failed lifecycle must veto");
        assert!(matches!(veto, RevivalVeto::GaveUp));
    }

    #[test]
    fn the_archived_belt_vetoes_even_fresh_busy_evidence() {
        // The captured zombie shape: a stopped session (archived at
        // 15:57) whose journal still holds a busy record.
        let file = session_file(Some("archived"));
        let recorded_at = iso_from_unix_ms(now_ms());
        let agent_dir = agent_dir();
        let veto = revival_veto(
            &agent_dir,
            &descriptor(Some(&file)),
            false,
            Some(&recorded_at),
        )
        .expect("an archived session must not revive");
        assert!(matches!(veto, RevivalVeto::SessionArchived));
    }

    #[test]
    fn the_archived_belt_vetoes_a_kept_update_row() {
        // A stop that landed during the update window is durable intent:
        // the roster's kept set cannot override it.
        let file = session_file(Some("archived"));
        let agent_dir = agent_dir();
        let veto = revival_veto(&agent_dir, &descriptor(Some(&file)), true, None)
            .expect("the belt must veto");
        assert!(matches!(veto, RevivalVeto::SessionArchived));
    }

    #[test]
    fn a_live_foreign_lease_vetoes_the_revival() {
        let file = session_file(Some("active"));
        let recorded_at = iso_from_unix_ms(now_ms());
        let agent_dir = agent_dir();
        // A live lease written the way another daemon's worker writes it
        // (this test process holds it): the file is owned elsewhere.
        std::env::set_var(crate::lease::SESSION_LEASES_ENABLED_ENV, "1");
        let lease = crate::lease::acquire_runtime_session_lease(&file, &agent_dir);
        std::env::remove_var(crate::lease::SESSION_LEASES_ENABLED_ENV);
        let _lease = lease.expect("the test process acquires the lease");
        let veto = revival_veto(
            &agent_dir,
            &descriptor(Some(&file)),
            false,
            Some(&recorded_at),
        )
        .expect("a live lease must veto");
        assert!(matches!(veto, RevivalVeto::LiveLeaseHeld { .. }));
    }

    #[test]
    fn a_released_lease_does_not_veto() {
        let file = session_file(Some("active"));
        let recorded_at = iso_from_unix_ms(now_ms());
        let agent_dir = agent_dir();
        // A lease whose owner is long dead is stale ownership, not a live
        // one: the gate must not park genuinely interrupted work behind a
        // dead holder's record.
        std::env::set_var(crate::lease::SESSION_LEASES_ENABLED_ENV, "1");
        let lease = crate::lease::acquire_runtime_session_lease(&file, &agent_dir);
        std::env::remove_var(crate::lease::SESSION_LEASES_ENABLED_ENV);
        drop(lease.expect("the test process acquires the lease"));
        assert!(revival_veto(
            &agent_dir,
            &descriptor(Some(&file)),
            false,
            Some(&recorded_at)
        )
        .is_none());
    }
}

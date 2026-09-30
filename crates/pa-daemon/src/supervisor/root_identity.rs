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
//! The roster is the sequence-gated source of truth: the sync derives the
//! identity from the roster's CURRENT row for the worker's address rather
//! than from any one delta payload, so racing syncs read the same latest
//! state and converge (a delayed older delta never regresses the
//! descriptor — the roster's stale-delta gate already dropped its row).

use std::sync::Arc;

use serde_json::Value;

use crate::registry::ResidentWorker;

use super::Supervisor;

impl Supervisor {
    /// Follow the roster's root row for one worker's address: when the row
    /// names a different durable session than the resident descriptor, the
    /// descriptor, the persisted record, the durable create command, and
    /// the binding table all move onto it — the same identity trio the
    /// create path writes, re-derived from the worker's live summary.
    /// Idempotent: a row matching the descriptor moves nothing, so the
    /// registration/adoption/create refresh pulls stay no-ops.
    pub(crate) async fn sync_root_identity_from_roster(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) {
        let summary = {
            let roster = self.roster.lock().unwrap();
            roster
                .by_active_session_id(&resident.worker_id)
                .map(|entry| entry.summary.clone())
        };
        let Some(summary) = summary else {
            // The roster holds no root row for this worker's address: the
            // registration/adoption seeding has not landed it yet, and the
            // next write triggers the follow.
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
        {
            let mut descriptor = resident.descriptor.lock().await;
            if descriptor.root_session_id.as_deref() == Some(session_id.as_str())
                && descriptor.session_file.as_deref() == Some(session_file.as_str())
            {
                return;
            }
            descriptor.root_session_id = Some(session_id.clone());
            descriptor.session_file = Some(session_file.clone());
            // The durable create command must reopen the moved-to session
            // on relaunch, or a respawned worker would replay the
            // superseded session instead of the one it serves.
            descriptor.create_command.session_path = Some(session_file.clone());
            if let Err(error) =
                crate::descriptor::persist_worker(&resident.descriptor_path, &descriptor)
            {
                // The live routing is already re-bound (the descriptor is
                // the supervisor's own memory); a failed persist degrades
                // only the restart edge — surface it so the respawn
                // replaying the superseded session is diagnosable.
                self.log_line(&format!(
                    "session identity move for {} did not persist: {error:#}",
                    resident.worker_id
                ));
            }
        }
        // The binding table learns the moved-to identity here: the
        // worker's address now carries the fork's durable session, and the
        // address's crash-window rebind resolves the fork's file — never
        // the original another worker may have re-opened.
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

//! The supervisor's operator-note surface: the daemon-event and session-channel
//! notes, the rotating log line, and the spawn-ledger assembly.
use super::*;

impl Supervisor {
    /// Emit the `daemon event` adoption signal for a session-archive sweep
    /// (best-effort, non-blocking; no-op when the daemon is opted out).
    pub(crate) fn note_sessions_archived(&self, count: usize) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_sessions_archived(client, count);
        }
    }

    /// Emit the parent-death child close's `daemon event` (schema v1,
    /// kind `worker_children_closed`): a count only, never session
    /// payload. Zero closes never emit (no children died with the
    /// worker).
    pub(crate) fn note_children_closed(&self, count: usize) {
        if count == 0 {
            return;
        }
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_worker_children_closed(client, count);
        }
    }

    /// Emit the live-catalog warm-up settle's `daemon event` (schema v1,
    /// kind `catalog_refresh`): the served model count, primitives only.
    pub(super) fn note_catalog_refresh(&self, count: usize) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_catalog_refresh(client, count);
        }
    }

    /// Emit the deleted-child usage capture's `daemon event` (schema v1,
    /// kind `deleted_child_usage_captured`): source + count, primitives
    /// only.
    pub(crate) fn note_deleted_child_usage_captured(&self, source: &str, count: usize) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_deleted_child_usage_captured(
                client, source, count,
            );
        }
    }

    /// Emit a `daemon event` (best-effort, non-blocking; no-op when the
    /// daemon is opted out).
    pub(crate) fn note_daemon_event(&self, kind: &str, exit_reason: Option<&str>) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_daemon_event(client, kind, exit_reason);
        }
    }

    /// Publish one session event to the session's attached connections
    /// (the send-time delivery pass — TS `handleWorkerFrame`'s fan-out
    /// evaluates the attached set in the same pass that writes). A full
    /// queue drops the frame and the stall-cycle transition lands in the
    /// daemon log (finding 4a visibility).
    pub(crate) fn publish_session_event(&self, active_session_id: &str, payload: Arc<Value>) {
        let outcome = self.session_subscribers.publish(active_session_id, payload);
        if !outcome.lagged.is_empty() {
            self.log_line(&format!(
                "clients {} lagged on the session event queue: frames dropped (session {active_session_id})",
                outcome.lagged.join(", ")
            ));
        }
    }

    /// The abort supervision's declaration event (`daemon event` schema v1,
    /// kind `compaction_abort_declared`): one count, never session payload.
    pub(crate) fn note_compaction_abort_declared(&self) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_compaction_abort_declared(client);
        }
    }

    pub(crate) fn log_line(&self, message: &str) {
        self.log.append(&format!("[{}] {message}", util::now_iso()));
    }

    /// The spawn ledger for one sessions dir (TS `rlmSpawnLedgerFor`): the
    /// default dir's ledger is memoized; any other dir constructs a fresh
    /// instance (its seeding no-ops when its ledger file exists).
    pub(crate) async fn rlm_spawn_ledger_for(
        self: &Arc<Self>,
        session_dir: Option<&str>,
    ) -> Result<std::sync::Arc<crate::rlm_ledger::RlmSpawnLedger>> {
        let default_dir = paths::sessions_dir(&self.options.agent_dir)?;
        let requested = match session_dir {
            Some(dir) => paths::expand_tilde(dir)?,
            None => default_dir.clone(),
        };
        if requested != default_dir {
            let log = paths::RotatingLog::new(paths::daemon_log_path(
                &self.options.socket_path,
                &self.options.agent_dir,
            ));
            return Ok(std::sync::Arc::new(crate::rlm_ledger::RlmSpawnLedger::new(
                &self.options.agent_dir,
                &requested,
                move |message| {
                    log.append(&format!("[{}] {message}", util::now_iso()));
                },
            )));
        }
        let mut cached = self.rlm_ledger.lock().await;
        if let Some(ledger) = cached.as_ref() {
            return Ok(std::sync::Arc::clone(ledger));
        }
        let log = paths::RotatingLog::new(paths::daemon_log_path(
            &self.options.socket_path,
            &self.options.agent_dir,
        ));
        let ledger = std::sync::Arc::new(crate::rlm_ledger::RlmSpawnLedger::new(
            &self.options.agent_dir,
            &requested,
            move |message| {
                log.append(&format!("[{}] {message}", util::now_iso()));
            },
        ));
        *cached = Some(std::sync::Arc::clone(&ledger));
        Ok(ledger)
    }
}

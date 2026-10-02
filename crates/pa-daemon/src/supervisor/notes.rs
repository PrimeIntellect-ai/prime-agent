//! The supervisor's operator-note surface: the daemon-event and session-channel
//! notes, the rotating log line, and the spawn-ledger assembly.
use super::{paths, util, Arc, Result, Supervisor, Value};

/// How long the frequent supervision events accumulate before their one
/// `daemon event` summary.
const DAEMON_EVENT_SUMMARY_WINDOW: std::time::Duration = std::time::Duration::from_secs(3600);

/// The supervision counters of the current summary window.
pub(crate) struct DaemonEventCounts {
    window_started: std::time::Instant,
    counts: std::collections::BTreeMap<String, u64>,
    saved_sessions_usage_rows_max: u64,
}

impl Default for DaemonEventCounts {
    fn default() -> Self {
        Self {
            window_started: std::time::Instant::now(),
            counts: std::collections::BTreeMap::new(),
            saved_sessions_usage_rows_max: 0,
        }
    }
}

fn send_daemon_event_summary(client: &pa_telemetry::TelemetryClient, counts: &DaemonEventCounts) {
    pa_core::session_engine::telemetry::track_daemon_event_summary(
        client,
        counts.window_started.elapsed().as_millis() as u64,
        &counts.counts,
        counts.saved_sessions_usage_rows_max,
    );
}

impl Supervisor {
    /// The daemon's live recording gate: the same env-then-settings
    /// resolution the client's delivery pass and the session seams apply,
    /// asked per event, so a `/telemetry` flip lands without a restart.
    /// Daemon events count and fire only while it is on — an opt-out
    /// window's events never ride a later summary or incident after a
    /// re-enable.
    fn telemetry_recording_on(&self) -> bool {
        let cwd = std::env::current_dir().unwrap_or_default();
        let switch = pa_core::session_engine::telemetry::telemetry_enabled_switch(
            &cwd,
            &self.options.agent_dir,
        );
        (switch.enabled)()
    }

    /// Emit the `daemon event` adoption signal for a session-archive sweep
    /// (best-effort, non-blocking; no-op when the daemon is opted out).
    pub(crate) fn note_sessions_archived(&self, count: usize) {
        if !self.telemetry_recording_on() {
            return;
        }
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
        if !self.telemetry_recording_on() {
            return;
        }
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_worker_children_closed(client, count);
        }
    }

    /// Emit the live-catalog warm-up settle's `daemon event` (schema v1,
    /// kind `catalog_refresh`): the served model count, primitives only.
    pub(super) fn note_catalog_refresh(&self, count: usize) {
        if !self.telemetry_recording_on() {
            return;
        }
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_catalog_refresh(client, count);
        }
    }

    /// Emit the deleted-child usage capture's `daemon event` (schema v1,
    /// kind `deleted_child_usage_captured`): source + count, primitives
    /// only.
    pub(crate) fn note_deleted_child_usage_captured(&self, source: &str, count: usize) {
        if !self.telemetry_recording_on() {
            return;
        }
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_deleted_child_usage_captured(
                client, source, count,
            );
        }
    }

    /// Count a frequent supervision event (attach/detach, worker exits and
    /// restarts, overloads, refusals) into the window's `daemon event`
    /// summary (best-effort; no-op when the daemon is opted out).
    pub(crate) fn note_daemon_event(&self, kind: &str, exit_reason: Option<&str>) {
        let key = match (kind, exit_reason) {
            ("worker_exited", Some("normal")) => "worker_exited_normal_count".to_string(),
            ("worker_exited", _) => "worker_exited_crash_count".to_string(),
            (kind, _) => format!("{kind}_count"),
        };
        self.count_daemon_event(|counts| *counts.counts.entry(key).or_default() += 1);
    }

    /// Count one served saved-session listing and its usage-bearing rows.
    pub(crate) fn note_saved_sessions_listed(&self, rows_with_usage: usize) {
        self.count_daemon_event(|counts| {
            *counts
                .counts
                .entry("saved_sessions_list_count".to_string())
                .or_default() += 1;
            counts.saved_sessions_usage_rows_max = counts
                .saved_sessions_usage_rows_max
                .max(rows_with_usage as u64);
        });
    }

    /// Apply one count; once the window is an hour old, send the summary
    /// and start a new window.
    fn count_daemon_event(&self, update: impl FnOnce(&mut DaemonEventCounts)) {
        if !self.telemetry_recording_on() {
            // Count only while telemetry is on, so an opt-out window's
            // events never ride the next summary after a re-enable.
            return;
        }
        let Some(client) = self.telemetry.lock().unwrap().clone() else {
            return;
        };
        let mut counts = self
            .daemon_event_counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        update(&mut counts);
        if counts.window_started.elapsed() >= DAEMON_EVENT_SUMMARY_WINDOW {
            send_daemon_event_summary(&client, &std::mem::take(&mut *counts));
        }
    }

    /// The daemon's exit: send the current window's partial summary and
    /// drain the telemetry client, so the last window's counts and any
    /// queued event are not lost when the process ends.
    pub(super) async fn flush_telemetry_on_exit(&self) {
        let Some(client) = self.telemetry.lock().unwrap().take() else {
            return;
        };
        let counts = std::mem::take(
            &mut *self
                .daemon_event_counts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        if !counts.counts.is_empty() {
            send_daemon_event_summary(&client, &counts);
        }
        let _ = client.shutdown().await;
    }

    /// Publish one session event to the session's attached connections
    /// (the send-time delivery pass — TS `handleWorkerFrame`'s fan-out
    /// evaluates the attached set in the same pass that writes). A full
    /// queue drops the frame and the stall-cycle transition lands in the
    /// daemon log (finding 4a visibility).
    pub(crate) fn publish_session_event(&self, active_session_id: &str, payload: &Arc<Value>) {
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
        if !self.telemetry_recording_on() {
            return;
        }
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

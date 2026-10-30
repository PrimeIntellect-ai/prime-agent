//! The daemon's agent-inbox seams: the settings gate (`agentInbox.*`), the
//! engine's per-session store slot the worker's notice sink and reminder
//! read, and the periodic unread-reminder task. The store itself, its
//! journal, and the `rlm.inbox.*` host requests live in pa-core
//! (`session_engine::inbox`).

use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::Notify;

use pa_core::session_engine::inbox::SessionInbox;

use crate::agent_engine::AgentSessionEngine;
use crate::journal::WorkerRecoveryJournal;
use crate::worker::SessionCore;

/// The poll period while the reminder is disabled (`reminderIntervalMs`
/// of `0`): a later settings flip still arms it.
const INBOX_REMINDER_DISABLED_POLL_MS: u64 = 60_000;

impl AgentSessionEngine {
    /// The current session's inbox store, set at every session build.
    ///
    /// # Panics
    ///
    /// Panics when the inbox slot lock is poisoned.
    pub(crate) fn set_inbox(&self, inbox: Arc<SessionInbox>) {
        *self
            .inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(inbox);
    }

    /// The current session's inbox store, when a session is built.
    ///
    /// # Panics
    ///
    /// Panics when the inbox slot lock is poisoned.
    pub(crate) fn inbox(&self) -> Option<Arc<SessionInbox>> {
        self.inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// `agentInbox.enabled` (default on): the kill switch that restores
/// direct notice-row steering.
pub(crate) fn inbox_enabled(cwd: &Path, agent_dir: &Path) -> bool {
    pa_core::settings::SettingsManager::create(cwd, agent_dir).get_agent_inbox_enabled()
}

/// `agentInbox.reminderIntervalMs` (default 10 minutes, `0` disables).
pub(crate) fn reminder_interval_ms(cwd: &Path, agent_dir: &Path) -> u64 {
    pa_core::settings::SettingsManager::create(cwd, agent_dir)
        .get_agent_inbox_reminder_interval_ms()
}

/// The periodic unread reminder: while the session's inbox stays
/// non-empty, one steering row repeats the waiting count every
/// `reminderIntervalMs`; the interval re-reads each cycle, and an empty
/// inbox skips the cycle (the period resets when it drains).
pub(crate) fn spawn_inbox_reminder(
    engine: Weak<AgentSessionEngine>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
    recovery: &Arc<Mutex<Option<WorkerRecoveryJournal>>>,
    agent_dir: &std::path::PathBuf,
) {
    let core = Arc::clone(core);
    let work_notify = Arc::clone(work_notify);
    let recovery = Arc::clone(recovery);
    let agent_dir = agent_dir.clone();
    tokio::spawn(async move {
        loop {
            let interval_ms = match engine.upgrade() {
                Some(engine) => reminder_interval_ms(&engine.cwd(), &agent_dir),
                None => return,
            };
            let wait_ms = if interval_ms == 0 {
                INBOX_REMINDER_DISABLED_POLL_MS
            } else {
                interval_ms
            };
            tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
            let Some(engine) = engine.upgrade() else {
                return;
            };
            if engine.session_is_closed() {
                return;
            }
            let Some(inbox) = engine.inbox() else {
                continue;
            };
            let closed = {
                let engine = std::sync::Arc::clone(&engine);
                move || engine.session_is_closed()
            };
            crate::worker::admit_inbox_reminder(&recovery, &core, &work_notify, &inbox, closed);
        }
    });
}

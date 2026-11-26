//! The daemon's agent-inbox routing: the settings gate (`agentInbox.*`),
//! the engine's per-session store slot, the [`InboxRouter`] every notice
//! source goes through, and the periodic unread-reminder task. The store
//! itself, its journal, and the `rlm.inbox.*` host requests live in
//! pa-core (`session_engine::inbox`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use pa_core::session_engine::inbox::{InboxNotice, SessionInbox};
use pa_types::inbox_notice::{INBOX_CLASS_AGENT_MESSAGE, INBOX_CLASS_HEARTBEAT};

use crate::agent_engine::AgentSessionEngine;
use crate::journal::WorkerRecoveryJournal;
use crate::worker::{
    admit_inbox_reminder, announce_waiting_inbox, checkpoint_queue_recovery,
    clear_withdrawn_progress_note, refresh_inbox_wake_rows, store_and_announce, wake_delay,
    EventPump, Lane, QueueCheckpoint, SessionCore,
};

/// The poll period while the reminder is disabled (`reminderIntervalMs`
/// of `0`): a later settings flip still arms it.
const INBOX_REMINDER_DISABLED_POLL_MS: u64 = 60_000;

impl AgentSessionEngine {
    /// The inbox store for the current session file, opened and
    /// published on first use (see [`Self::open_inbox_at`]). Runs when a
    /// session opens (create, replacement), so notices route into the
    /// inbox before the first build, and at every build of an open session.
    pub(crate) fn open_inbox(&self) -> Arc<SessionInbox> {
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        self.open_inbox_at(session_file.as_deref())
    }

    /// The inbox store for one session file (`None`: an in-memory
    /// session), opened and published unless the store already opened for
    /// the same session dir is published (kept even when its journal could
    /// not be read).
    ///
    /// # Panics
    ///
    /// Panics when the inbox slot lock is poisoned.
    pub(crate) fn open_inbox_at(&self, session_file: Option<&Path>) -> Arc<SessionInbox> {
        let dir = session_file
            .and_then(pa_core::session_engine::harness_digest::session_artifact_dir_for_log);
        let mut slot = self
            .inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((_, open)) = slot.as_ref().filter(|(open_dir, _)| *open_dir == dir) {
            return Arc::clone(open);
        }
        let inbox = Arc::new(SessionInbox::open(dir.as_deref()));
        if let Some(hook) = self.inbox_read_hook() {
            inbox.set_read_hook(hook);
        }
        *slot = Some((dir, Arc::clone(&inbox)));
        inbox
    }

    /// Install the worker's post-drain seam for the inbox (the wake-row
    /// refresh): every opened store gets it, and the kernel's read
    /// handler runs it after each drain.
    ///
    /// # Panics
    ///
    /// Panics when the read-hook slot lock is poisoned.
    pub(crate) fn set_inbox_read_hook(&self, hook: pa_core::session_engine::inbox::InboxReadHook) {
        *self
            .inbox_read_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook);
    }

    /// The installed post-drain seam, when the worker set one.
    ///
    /// # Panics
    ///
    /// Panics when the read-hook slot lock is poisoned.
    pub(crate) fn inbox_read_hook(&self) -> Option<pa_core::session_engine::inbox::InboxReadHook> {
        self.inbox_read_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The current session's inbox store, once a session opened.
    ///
    /// # Panics
    ///
    /// Panics when the inbox slot lock is poisoned.
    pub(crate) fn inbox(&self) -> Option<Arc<SessionInbox>> {
        self.inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|(_, inbox)| Arc::clone(inbox))
    }
}

/// The one place that decides, for every machine notice (bash and
/// factory notices, agent messages, child exits, heartbeat fires),
/// whether it lands in the session's inbox or is delivered directly, and
/// that keeps the inbox wake rows in step with the store.
///
/// Every inbox step runs inside one `SessionCore` critical section with
/// the store looked up under it. A session's store is only swapped while
/// the session is closed, and a closed session's notice is stored without
/// a wake row, so a row never announces another session's store.
#[derive(Clone)]
pub(crate) struct InboxRouter {
    engine: Weak<AgentSessionEngine>,
    core: Arc<Mutex<SessionCore>>,
    recovery: Arc<Mutex<Option<WorkerRecoveryJournal>>>,
    work_notify: Arc<crate::worker::WorkNotify>,
    events: Arc<EventPump>,
    agent_dir: PathBuf,
}

impl InboxRouter {
    pub(crate) fn new(
        engine: &Arc<AgentSessionEngine>,
        core: &Arc<Mutex<SessionCore>>,
        recovery: &Arc<Mutex<Option<WorkerRecoveryJournal>>>,
        work_notify: &Arc<crate::worker::WorkNotify>,
        events: &Arc<EventPump>,
        agent_dir: &Path,
    ) -> Self {
        Self {
            engine: Arc::downgrade(engine),
            core: Arc::clone(core),
            recovery: Arc::clone(recovery),
            work_notify: Arc::clone(work_notify),
            events: Arc::clone(events),
            agent_dir: agent_dir.to_path_buf(),
        }
    }

    /// The engine while notices route to the inbox (`agentInbox.enabled`).
    fn routing_engine(&self) -> Option<Arc<AgentSessionEngine>> {
        let engine = self.engine.upgrade()?;
        inbox_enabled(&engine.cwd(), &self.agent_dir).then_some(engine)
    }

    /// Route one notice into the inbox: it is stored, and the queued
    /// arrival row announces it (a closing session only stores it; the
    /// next session open announces it). Returns whether the announcement
    /// waits behind a running turn, or `None` when the caller delivers
    /// the notice directly (`agentInbox.enabled` is off).
    pub(crate) fn route(&self, notice: InboxNotice, lane: Lane) -> Option<bool> {
        // Read before the lock: the settings lookup touches the disk.
        let wake_delay = wake_delay(&notice, self.engine.upgrade().as_deref());
        self.admission(|core, inbox, closed| {
            (
                store_and_announce(core, inbox, closed, notice, lane, wake_delay),
                true,
            )
        })
    }

    /// Store one notice in the session's inbox without announcing it: an
    /// orphaned worker (its supervisor is lost) starts no turn, and the
    /// session's next open announces what waits. Runs whatever
    /// `agentInbox.enabled` says, so the notice is never dropped. Returns
    /// whether the notice was stored.
    pub(crate) fn store_unannounced(&self, notice: InboxNotice) -> bool {
        let Some(engine) = self.engine.upgrade() else {
            return false;
        };
        let _core = self.core.lock().unwrap();
        let Some(inbox) = engine.inbox() else {
            return false;
        };
        inbox.push(notice, pa_core::autonomous::now_millis());
        true
    }

    /// Run one inbox admission: `f` gets the locked core, the session's
    /// store, and whether the session is closing, and answers its result
    /// and whether it queued or changed a row (which checkpoints the
    /// queue and wakes the turn runner on an open session). `None` when
    /// notices do not route to the inbox (`agentInbox.enabled` off, no
    /// session open).
    pub(crate) fn admission<R>(
        &self,
        f: impl FnOnce(&mut SessionCore, &SessionInbox, bool) -> (R, bool),
    ) -> Option<R> {
        let engine = self.routing_engine()?;
        let (result, admitted, closed) = {
            let mut core = self.core.lock().unwrap();
            let inbox = engine.inbox()?;
            let closed = engine.session_is_closed();
            let (result, admitted) = f(&mut core, &inbox, closed);
            (result, admitted, closed)
        };
        if admitted && !closed {
            self.publish(QueueCheckpoint::Admitted {
                operation: "steer_queued",
            });
        }
        Some(result)
    }

    /// Remove messages from the store and refresh the wake rows over what
    /// is left: `remove` runs inside the core critical section and
    /// answers whether it removed anything. Runs whatever
    /// `agentInbox.enabled` says, so rows queued before a flip still
    /// follow the store.
    pub(crate) fn withdraw(&self, remove: impl FnOnce(&mut SessionCore, &SessionInbox) -> bool) {
        let Some(engine) = self.engine.upgrade() else {
            return;
        };
        let changed = {
            let mut core = self.core.lock().unwrap();
            let Some(inbox) = engine.inbox() else {
                return;
            };
            let changed = remove(&mut core, &inbox) && refresh_inbox_wake_rows(&mut core, &inbox);
            // The idle-session progress note clears only once the lanes it
            // reported on are final.
            clear_withdrawn_progress_note(&core, engine.as_ref());
            changed
        };
        if changed {
            self.publish(QueueCheckpoint::Settle {
                operation: "queue_mutated",
            });
        }
    }

    /// The post-read refresh: `rlm.inbox.read` drained messages, so the
    /// wake rows that promised them retract or re-render.
    pub(crate) fn refresh_after_read(&self) {
        self.withdraw(|_, _| true);
    }

    /// Announce the messages already waiting when a session opens (a
    /// wake, a resume, a replacement): one arrival row covers every
    /// waiting message no queued row announces yet.
    pub(crate) fn announce_waiting(&self) {
        self.admission(|core, inbox, _| ((), announce_waiting_inbox(core, inbox)));
    }

    /// One reminder cycle: queue the unread reminder while the session is
    /// open and its inbox holds messages.
    pub(crate) fn remind(&self) {
        self.admission(|core, inbox, closed| ((), !closed && admit_inbox_reminder(core, inbox)));
    }

    /// The queue checkpoint, the turn runner's wake, and the queue strip
    /// refresh after a row changed.
    fn publish(&self, checkpoint: QueueCheckpoint) {
        checkpoint_queue_recovery(&self.recovery, &self.core, checkpoint);
        self.work_notify.notify_one();
        let _ = crate::worker::emit_action_update_fresh(&self.core, &self.events);
    }
}

/// Move the waiting agent messages and heartbeat fires from the outgoing
/// session's inbox into the successor's (a new session or a fork continues
/// the conversation, and the session's scheduled jobs rebind onto it, so a
/// fire follows its job and the job's pause or delete withdraws it). Bash,
/// child, and factory notices stay with their session: they are about that
/// session's own work. The successor's
/// copies are written first and the outgoing records removed after (only
/// once the copies are durable), so a crash leaves a message in both
/// inboxes, never in neither. Each copy keeps its arrival time and carries
/// `meta.movedFrom` (`<session id>/<inbox id>`), so a repeated move after
/// such a crash never adds a second copy.
pub(crate) fn move_waiting_messages(from: &SessionInbox, to: &SessionInbox, from_session: &str) {
    let already_moved: Vec<String> = to
        .waiting_messages()
        .into_iter()
        .filter_map(|message| {
            message
                .meta
                .get("movedFrom")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let mut moved = std::collections::BTreeSet::new();
    for (class, message) in from.waiting_messages().into_iter().filter_map(|message| {
        let class = [INBOX_CLASS_AGENT_MESSAGE, INBOX_CLASS_HEARTBEAT]
            .into_iter()
            .find(|class| *class == message.class)?;
        Some((class, message))
    }) {
        let origin = format!("{from_session}/{}", message.id);
        if !already_moved.contains(&origin) {
            let mut meta = message.meta;
            if !meta.is_object() {
                meta = serde_json::json!({});
            }
            meta["movedFrom"] = serde_json::json!(origin);
            to.push(
                InboxNotice {
                    class,
                    sender: message.sender,
                    text: message.text,
                    meta,
                },
                message.arrived_at_ms,
            );
        }
        moved.insert(message.id);
    }
    // A memory-only successor (its journal write failed) keeps the
    // outgoing records: a crash must not lose what it cannot persist.
    if to.persistence_error().is_none() {
        from.withdraw_ids(&moved);
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
/// `reminderIntervalMs`. The interval re-reads each cycle (also after
/// the wait, so a flip to `0` never admits); a `0` interval, an empty
/// inbox, a closed session, or `agentInbox.enabled: false` skips the
/// cycle.
pub(crate) fn spawn_inbox_reminder(router: InboxRouter) {
    tokio::spawn(async move {
        loop {
            let interval_ms = match router.engine.upgrade() {
                Some(engine) => reminder_interval_ms(&engine.cwd(), &router.agent_dir),
                None => return,
            };
            let wait_ms = if interval_ms == 0 {
                INBOX_REMINDER_DISABLED_POLL_MS
            } else {
                interval_ms
            };
            tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
            if interval_ms == 0 {
                continue;
            }
            let Some(engine) = router.engine.upgrade() else {
                return;
            };
            if reminder_interval_ms(&engine.cwd(), &router.agent_dir) == 0 {
                continue;
            }
            router.remind();
        }
    });
}

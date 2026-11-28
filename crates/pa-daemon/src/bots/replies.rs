//! Bot → owner delivery and the pause policy, in the Mac supervisor.
//!
//! After an owner → bot send, the supervisor follows the bot: it reads the
//! bot session's state over the link until the session settles, then
//! delivers the settled run's final answer and each new guest outbox line
//! to the owner, once. The owner receives them through the `send_message`
//! route, like a local child's message. The bot ledger records every delivery before it starts, so a
//! restart never delivers twice: an interrupted delivery is never retried.
//! A bot with no new work for [`PAUSE_GRACE`] and no attached TUI is paused.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use pa_types::daemon::{DaemonCommand, DaemonWorkerCommand};
use serde_json::{json, Map, Value};

use super::guest::GuestClient;
use super::ledger::{BotLedger, DeliveryState};
use super::platform::PlatformError;
use super::registry::BotRegistry;
use super::remote_parent::{RemoteParentEntry, READ_PAGE_LINES};
use super::{manager_for, BotManager, BotRecord, BotStatus};
use pa_core::session_engine::agent_messaging::DEFAULT_AGENT_MESSAGE_MAX_CHARS;

use crate::backpressure::RouteAdmission;
use crate::messaging::{WakeOutcome, WORKER_REQUEST_TIMEOUT_MS};
use crate::supervisor::Supervisor;

/// How long a settled, idle bot stays running before it is paused.
pub const PAUSE_GRACE: Duration = Duration::from_secs(120);
/// How often the grace wait looks for a new send.
const GRACE_CHECK: Duration = Duration::from_secs(1);
/// Pause steps that may fail (an unreachable guest) before the bot is
/// paused without the idle check.
const PAUSE_STEP_ATTEMPTS: u32 = 3;
/// Sync attempts per follow, and the wait between them.
const SYNC_ATTEMPTS: u32 = 3;
const SYNC_RETRY: Duration = Duration::from_secs(10);
/// How often a sync re-reads a busy bot session.
const SETTLE_POLL: Duration = Duration::from_secs(2);
/// The transcript rows one sync reads from the end of the bot session.
const TAIL_ROWS: u64 = 400;

/// One settled run after the last delivered row: the id of its last row
/// (the next run starts after it), the text of its last assistant row with
/// text (empty when it has none), and the timestamp (guest clock, ms) of
/// its first row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SettledAnswer {
    pub row_id: String,
    pub answer: String,
    pub started_at: Option<u64>,
}

impl SettledAnswer {
    /// Whether the bot messaged its owner during this run.
    fn replied(&self, outbox_times: &[u64]) -> bool {
        self.started_at
            .is_some_and(|started_at| outbox_times.iter().any(|at| *at >= started_at))
    }
}

/// A row's timestamp: epoch ms on message rows, the entry's ISO time on
/// custom rows.
fn row_timestamp(row: &Value) -> Option<u64> {
    let timestamp = &row["message"]["timestamp"];
    timestamp
        .as_u64()
        .or_else(|| timestamp.as_str().and_then(crate::util::iso_to_unix_ms))
}

/// The settled run after the last delivered row: one per settled run,
/// however many owner messages the run answered. `Err` names the newest
/// row when the last delivered row is outside the page: what
/// came after it may or may not have been delivered, so nothing is.
pub(crate) fn settled_answer(
    rows: &[Value],
    last_delivered: Option<&str>,
) -> std::result::Result<Option<SettledAnswer>, String> {
    let start = match last_delivered {
        None => 0,
        Some(id) => {
            let Some(position) = rows.iter().position(|row| row["id"].as_str() == Some(id)) else {
                let newest = rows.iter().rev().find_map(|row| row["id"].as_str());
                return newest.map_or(Ok(None), |id| Err(id.to_string()));
            };
            position + 1
        }
    };
    let run = &rows[start.min(rows.len())..];
    let Some(row_id) = run.iter().rev().find_map(|row| row["id"].as_str()) else {
        return Ok(None);
    };
    let answer = run
        .iter()
        .rev()
        .filter(|row| row["message"]["role"] == "assistant")
        .map(|row| crate::types::message_text(&row["message"]))
        .find(|answer| !answer.trim().is_empty())
        .unwrap_or_default();
    Ok(Some(SettledAnswer {
        row_id: row_id.to_string(),
        answer,
        started_at: run.first().and_then(row_timestamp),
    }))
}

/// Whether the guest session runs turn work: a turn, compaction, a shell,
/// tools, children, or queued input. The delivery lane reads it: a
/// settled turn's answer is deliverable once this is false, even while
/// background kernel work or a factory run outlives the turn.
fn guest_turn_busy_flags(state: &Value) -> bool {
    let flag = |name: &str| state[name].as_bool().unwrap_or(false);
    [
        "isStreaming",
        "isCompacting",
        "isBashRunning",
        "isRunningTools",
        "hasRunningSubagents",
        "hasRunningRlmChildren",
    ]
    .into_iter()
    .any(flag)
        || state["sessionActions"]["queuedCount"]
            .as_u64()
            .is_some_and(|count| count > 0)
}

/// Whether the guest session holds off the idle pause: turn work, or
/// background kernel work or an active factory run that outlives the
/// settled turn. Only the pause verdict reads it — never the delivery
/// lane, whose answers must not wait on work the turn already ended
/// with.
fn guest_pause_busy_flags(state: &Value) -> bool {
    let flag = |name: &str| state[name].as_bool().unwrap_or(false);
    guest_turn_busy_flags(state) || ["hasBackgroundKernelWork"].into_iter().any(flag)
}

/// The guest session's live state over the link.
async fn guest_state<G: GuestCommands>(guest: &mut G, session: &str) -> Result<Value> {
    guest
        .command(&DaemonCommand::GetState {
            id: None,
            active_session_id: session.to_string(),
            rest: Map::default(),
        })
        .await
}

/// Whether the guest session runs turn work (the delivery lane's
/// settle gate).
async fn guest_turn_busy<G: GuestCommands>(guest: &mut G, session: &str) -> Result<bool> {
    Ok(guest_turn_busy_flags(&guest_state(guest, session).await?))
}

/// Whether the guest session holds off the idle pause (the pause
/// verdict's gate).
async fn guest_pause_busy<G: GuestCommands>(guest: &mut G, session: &str) -> Result<bool> {
    Ok(guest_pause_busy_flags(&guest_state(guest, session).await?))
}

/// The guest daemon commands a sync needs; [`GuestClient`] over the link.
pub(crate) trait GuestCommands: Send {
    fn command(
        &mut self,
        command: &DaemonCommand,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
}

impl GuestCommands for GuestClient {
    async fn command(&mut self, command: &DaemonCommand) -> Result<Value> {
        Ok(GuestClient::command(self, command).await?)
    }
}

/// Room kept in each part for its `[bot answer part i/n]` line.
const PART_HEADER_CHARS: usize = 40;

/// A turn answer as agent messages: whole when it fits one, else split into
/// numbered parts that each fit. The parts' bodies join to the full answer.
fn answer_parts(answer: &str) -> Vec<String> {
    let answer = answer.trim();
    if answer.chars().count() <= DEFAULT_AGENT_MESSAGE_MAX_CHARS {
        return vec![answer.to_string()];
    }
    let chars: Vec<char> = answer.chars().collect();
    let chunks: Vec<String> = chars
        .chunks(DEFAULT_AGENT_MESSAGE_MAX_CHARS - PART_HEADER_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect();
    let count = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| format!("[bot answer part {}/{count}]\n{chunk}", index + 1))
        .collect()
}

enum Delivery {
    Turn(String),
    /// An outbox line's sequence number and write time.
    OutboxLine(u64, u64),
}

/// Wait until the guest session's turn work settles (background work and
/// factory runs never delay delivery), then deliver the settled run's
/// answer and each new outbox line once: `sending` (fsynced), deliver, then
/// `sent`. A run in which the bot messaged its owner has those messages as
/// its answer; its own final answer is not delivered. Write times of
/// delivered lines stay in the ledger, so a run that settles after its
/// message was delivered is still attributed. A delivery that fails is
/// `uncertain`; neither it nor one a crash interrupted is retried. A run
/// with no answer text delivers what `no_answer` gives, read once the run
/// settled (the error of an expired owner login). Returns the number of settled runs with an
/// answer (0 or 1).
pub(crate) async fn sync_deliveries<G, D, F>(
    guest: &mut G,
    ledger: &BotLedger,
    session: &str,
    no_answer: impl FnOnce() -> Option<String> + Send,
    mut deliver: D,
) -> Result<usize>
where
    G: GuestCommands,
    D: FnMut(String) -> F + Send,
    F: std::future::Future<Output = Result<()>> + Send,
{
    let marks = ledger.delivery_marks()?;
    let mut outbox_times = marks.outbox_times;
    let last_turn = marks.delivered_turn.map(|mark| mark.key);
    let last_seq = marks.remote_parent.map_or(0, |mark| mark.key);
    // Follow the bot session until it settles, like a local child's watcher.
    // A page read while a new run started is read again once that run
    // settles, so a mid-run step is never taken for an answer.
    let page = loop {
        if guest_turn_busy(guest, session).await? {
            tokio::time::sleep(SETTLE_POLL).await;
            continue;
        }
        let page = guest
            .command(&DaemonCommand::GetSessionMessages {
                id: None,
                active_session_id: session.to_string(),
                start: -i64::try_from(TAIL_ROWS)?,
                limit: TAIL_ROWS,
                roles: ["user", "assistant", "custom"].map(str::to_string).to_vec(),
                session_file: None,
                rest: Map::default(),
            })
            .await?;
        if !guest_turn_busy(guest, session).await? {
            break page;
        }
    };
    let rows = page["messages"].as_array().cloned().unwrap_or_default();
    // The guest answers one page of outbox lines per read, so a backlog
    // never outgrows one link frame.
    let mut messages: Vec<RemoteParentEntry> = Vec::new();
    let mut after_seq = last_seq;
    loop {
        let outbox = guest
            .command(&DaemonCommand::ReadRemoteParent {
                id: None,
                after_seq,
                rest: Map::default(),
            })
            .await?;
        let page: Vec<RemoteParentEntry> = serde_json::from_value(outbox["entries"].clone())?;
        let Some(last) = page.last() else {
            break;
        };
        after_seq = last.seq;
        let full = page.len() >= READ_PAGE_LINES;
        messages.extend(page);
        if !full {
            break;
        }
    }
    outbox_times.extend(messages.iter().map(|message| message.at_ms));
    let mut deliveries = Vec::new();
    let mut settled = 0;
    match settled_answer(&rows, last_turn.as_deref()) {
        // A run in which the bot messaged its owner already answered, like
        // a local child that replied: its answer is recorded, not delivered.
        // A run without answer text still moves the cursor to its last row.
        Ok(Some(run)) => {
            settled = 1;
            let answer = if run.replied(&outbox_times) {
                None
            } else if run.answer.trim().is_empty() {
                no_answer().map(|text| vec![text])
            } else {
                Some(answer_parts(&run.answer))
            };
            deliveries.push((Delivery::Turn(run.row_id), answer));
        }
        Ok(None) => {}
        Err(newest) => {
            eprintln!("pa-daemon: bots: the last delivered answer left the transcript window; skipping it");
            ledger.mark_turn(&newest, DeliveryState::Uncertain)?;
        }
    }
    deliveries.extend(messages.into_iter().map(|entry| {
        (
            Delivery::OutboxLine(entry.seq, entry.at_ms),
            Some(vec![entry.message]),
        )
    }));
    for (delivery, parts) in deliveries {
        let mark = |state| match &delivery {
            Delivery::Turn(turn_id) => ledger.mark_turn(turn_id, state),
            Delivery::OutboxLine(seq, _) => ledger.mark_remote_parent(*seq, state),
        };
        let Some(parts) = parts else {
            mark(DeliveryState::Replied)?;
            continue;
        };
        match &delivery {
            Delivery::OutboxLine(seq, at_ms) => ledger.begin_remote_parent(*seq, *at_ms)?,
            Delivery::Turn(_) => mark(DeliveryState::Sending)?,
        }
        // A part that fails leaves the turn `uncertain`: no part is resent.
        let mut outcome = Ok(());
        for part in parts {
            outcome = deliver(part).await;
            if outcome.is_err() {
                break;
            }
        }
        mark(if outcome.is_ok() {
            DeliveryState::Sent
        } else {
            DeliveryState::Uncertain
        })?;
        outcome?;
    }
    Ok(settled)
}

/// One bot's follower. A single task per bot syncs, waits out the grace,
/// and runs the pause step, so two syncs of one bot never overlap.
#[derive(Default)]
struct Follow {
    running: bool,
    /// A send arrived while the follower ran: sync again before any pause.
    again: bool,
    /// The idle time before the pause step; the longest a caller asked for.
    grace: Duration,
    /// Unix milliseconds when the running grace wait ends.
    pause_at: Option<i64>,
}

fn follows() -> &'static Mutex<HashMap<String, Follow>> {
    static FOLLOWS: OnceLock<Mutex<HashMap<String, Follow>>> = OnceLock::new();
    FOLLOWS.get_or_init(Mutex::default)
}

/// Whether a send arrived since the last check; clears the flag.
fn take_again(bot_id: &str) -> bool {
    follows()
        .lock()
        .unwrap()
        .get_mut(bot_id)
        .is_some_and(|follow| std::mem::take(&mut follow.again))
}

/// When the bot's running grace wait ends (Unix ms); `None` outside the wait.
#[must_use]
pub(crate) fn pause_at(bot_id: &str) -> Option<i64> {
    follows()
        .lock()
        .unwrap()
        .get(bot_id)
        .and_then(|follow| follow.pause_at)
}

fn set_pause_at(bot_id: &str, pause_at: Option<i64>) {
    if let Some(follow) = follows().lock().unwrap().get_mut(bot_id) {
        follow.pause_at = pause_at;
    }
}

/// Wait out the grace; returns early with `true` when a send arrives.
async fn wait_grace(bot_id: &str, grace: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + grace;
    let grace_ms = i64::try_from(grace.as_millis()).unwrap_or(i64::MAX);
    set_pause_at(
        bot_id,
        Some(super::manager::now_ms().saturating_add(grace_ms)),
    );
    let sent = loop {
        if take_again(bot_id) {
            break true;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break false;
        }
        tokio::time::sleep(GRACE_CHECK.min(deadline - now)).await;
    };
    set_pause_at(bot_id, None);
    sent
}

impl Supervisor {
    /// Follow one bot after an owner → bot send: deliver its settled answer
    /// and outbox lines, then pause it after [`PAUSE_GRACE`] with no new work.
    pub fn follow_bot(self: &Arc<Self>, bot_id: &str) {
        self.follow_bot_then_pause(bot_id, PAUSE_GRACE);
    }

    /// Note a send to the bot before it starts: a running follower then
    /// syncs again and waits the full grace instead of pausing.
    pub(crate) fn touch_bot(bot_id: &str) {
        if let Some(follow) = follows().lock().unwrap().get_mut(bot_id) {
            if follow.running {
                follow.again = true;
                follow.grace = follow.grace.max(PAUSE_GRACE);
            }
        }
    }

    /// Boot reconcile: catch up every running bot, then pause the idle ones.
    pub async fn reconcile_bots_on_boot(self: &Arc<Self>) {
        // No registry: no bot was ever spawned here, so skip the credential read.
        if !BotRegistry::path_in(&self.options.agent_dir).exists() {
            return;
        }
        let manager = match manager_for(&self.options.agent_dir) {
            Ok(manager) => manager,
            Err(error) => {
                eprintln!("pa-daemon: bots: boot reconcile skipped: {error:#}");
                return;
            }
        };
        if let Err(error) = manager.reconcile_on_boot().await {
            eprintln!("pa-daemon: bots: boot reconcile failed: {error:#}");
            return;
        }
        for record in manager.list() {
            if record.status == BotStatus::Running {
                self.follow_bot_then_pause(&record.bot_id, Duration::ZERO);
            }
        }
    }

    fn follow_bot_then_pause(self: &Arc<Self>, bot_id: &str, grace: Duration) {
        {
            let mut follows = follows().lock().unwrap();
            let follow = follows.entry(bot_id.to_string()).or_default();
            if follow.running {
                follow.again = true;
                follow.grace = follow.grace.max(grace);
                return;
            }
            *follow = Follow {
                running: true,
                again: false,
                grace,
                pause_at: None,
            };
        }
        let this = Arc::clone(self);
        let bot_id = bot_id.to_string();
        tokio::spawn(async move {
            loop {
                this.sync_with_retries(&bot_id).await;
                if take_again(&bot_id) {
                    continue;
                }
                let grace = follows()
                    .lock()
                    .unwrap()
                    .get(&bot_id)
                    .map_or(PAUSE_GRACE, |follow| follow.grace);
                // A send during the grace syncs at once, not after the grace.
                if wait_grace(&bot_id, grace).await {
                    continue;
                }
                let mut failed_pause_steps = 0;
                let round_again = loop {
                    match this.pause_step(&bot_id).await {
                        Ok(again) => break again,
                        // The next settled turn tries the pause again.
                        Err(error) if this.storage_full(&bot_id, &error) => break false,
                        // An unreachable guest is tried again soon; after that
                        // the bot is paused anyway, so it does not run unwatched.
                        Err(error) if failed_pause_steps + 1 < PAUSE_STEP_ATTEMPTS => {
                            failed_pause_steps += 1;
                            eprintln!(
                                "pa-daemon: bots: {bot_id}: pause after settle failed: {error:#}"
                            );
                            tokio::time::sleep(SYNC_RETRY).await;
                        }
                        Err(error) => {
                            eprintln!(
                                "pa-daemon: bots: {bot_id}: pause after settle failed; pausing anyway: {error:#}"
                            );
                            // An attached TUI or a failed pause keeps watching.
                            break this.pause_unwatched(&bot_id).await.unwrap_or_else(|error| {
                                if this.storage_full(&bot_id, &error) {
                                    return false;
                                }
                                eprintln!("pa-daemon: bots: {bot_id}: pause failed: {error:#}");
                                true
                            });
                        }
                    }
                };
                if round_again {
                    // Later rounds wait the full grace (a boot catch-up starts at zero).
                    if let Some(follow) = follows().lock().unwrap().get_mut(&bot_id) {
                        follow.grace = follow.grace.max(PAUSE_GRACE);
                    }
                    continue;
                }
                let mut follows = follows().lock().unwrap();
                let follow = follows.entry(bot_id.clone()).or_default();
                if std::mem::take(&mut follow.again) {
                    continue;
                }
                follow.running = false;
                return;
            }
        });
    }

    /// Whether `error` is a pause refused because the team's checkpoint
    /// storage is full. The bot then stays running, with one warning.
    fn storage_full(&self, bot_id: &str, error: &anyhow::Error) -> bool {
        if !matches!(
            error.downcast_ref::<PlatformError>(),
            Some(PlatformError::CheckpointQuota(_))
        ) {
            return false;
        }
        let name = manager_for(&self.options.agent_dir)
            .ok()
            .and_then(|manager| manager.get(bot_id))
            .map_or_else(|| bot_id.to_string(), |record| record.name);
        eprintln!(
            "pa-daemon: bots: bot {name} stays running: the team's checkpoint storage is full; delete old checkpoints to allow pause"
        );
        true
    }

    /// A failed sync (a dropped link) is tried again before the pause step,
    /// so a settled answer is not left behind.
    async fn sync_with_retries(self: &Arc<Self>, bot_id: &str) {
        for attempt in 1..=SYNC_ATTEMPTS {
            match self.sync_bot(bot_id).await {
                Ok(()) => return,
                Err(error) => {
                    eprintln!(
                        "pa-daemon: bots: {bot_id}: reply sync failed (attempt {attempt}): {error:#}"
                    );
                    tokio::time::sleep(SYNC_RETRY).await;
                }
            }
        }
    }

    /// Wait for the bot session to settle, then deliver what is new.
    async fn sync_bot(self: &Arc<Self>, bot_id: &str) -> Result<()> {
        let manager = manager_for(&self.options.agent_dir)?;
        let record = manager
            .get(bot_id)
            .ok_or_else(|| anyhow!("unknown bot {bot_id}"))?;
        let ledger = BotLedger::new(&self.options.agent_dir, bot_id);
        let mut client = GuestClient::connect(&manager, &record).await?;
        let record = &record;
        // A turn that failed on an expired login ends with that error. The
        // refresher keeps the login state current while the bot runs.
        manager.refresh_logins(record).await;
        let settled = sync_deliveries(
            &mut client,
            &ledger,
            &record.guest_session_id,
            || manager.login_expired(record),
            |text| async move { self.deliver_to_owner(record, &text).await },
        )
        .await?;
        if settled > 0 {
            manager.record_turn(bot_id)?;
        }
        // The guest session's live model and thinking, as the record's:
        // the /bots row shows them, and the next create provisions the
        // model's provider key (a `set_model` in the guest otherwise
        // leaves the record at the spawn model).
        match client
            .command(&DaemonCommand::GetState {
                id: None,
                active_session_id: record.guest_session_id.clone(),
                rest: Map::default(),
            })
            .await
        {
            Ok(state) => {
                if let Err(error) = manager.adopt_guest_model(bot_id, &state) {
                    eprintln!("pa-daemon: bots: {bot_id}: the model sync failed: {error:#}");
                }
            }
            Err(error) => {
                eprintln!("pa-daemon: bots: {bot_id}: the model read failed: {error}");
            }
        }
        // The bot's children land in this registry, so the /bots tree and
        // the delete cascade know them; a child the bot deleted itself goes
        // again. A bot without children answers an empty list.
        if let Err(error) = self.sync_child_bots(&manager, record, &mut client).await {
            eprintln!("pa-daemon: bots: {bot_id}: child bot sync failed: {error:#}");
        }
        Ok(())
    }

    /// Pull the bot's children (its own daemon's `list_bots` rows) into
    /// this registry.
    async fn sync_child_bots(
        self: &Arc<Self>,
        manager: &BotManager,
        record: &BotRecord,
        client: &mut GuestClient,
    ) -> Result<()> {
        let reply = client
            .command(&DaemonCommand::ListBots {
                id: None,
                owner_session_id: None,
                rest: Map::default(),
            })
            .await
            .map_err(|error| anyhow!("the bot did not list its children: {error}"))?;
        // A guest without a registry answers an empty, marked list: that is
        // not "the children are gone", so the merged records stay.
        if reply.get("registry").and_then(Value::as_bool) == Some(false) {
            return Ok(());
        }
        let rows = reply
            .get("bots")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        manager.merge_children(&record.bot_id, &rows).await
    }

    /// Route one bot message into the owner session, waking it by its
    /// durable id when no worker holds it.
    async fn deliver_to_owner(self: &Arc<Self>, record: &BotRecord, text: &str) -> Result<()> {
        let owner = record.owner_session_id.as_str();
        let target = match self.registry.resolve(owner).await {
            Ok(resident) => resident,
            Err(error) => match self.wake_saved_target(&error, owner, None).await {
                WakeOutcome::Woken(resident) => resident,
                WakeOutcome::Unknown => bail!("the owner session {owner} no longer exists"),
                WakeOutcome::Failed(error) => bail!(error),
            },
        };
        let delivery = DaemonWorkerCommand::WorkerDeliverMessage {
            id: None,
            target_active_session_id: target.worker_id.clone(),
            message: text.to_string(),
            sender: json!({
                "activeSessionId": record.bot_id,
                "sessionId": record.bot_id,
                "sessionName": record.name,
                "runtimeKind": "bot",
                "parentSessionId": owner,
                "clientId": "agent",
            }),
            delivery_mode: Some(json!("follow_up")),
            rest: Map::default(),
        };
        let response = self
            .route_command_typed(
                &target,
                "worker_deliver_message",
                serde_json::to_value(&delivery)?,
                WORKER_REQUEST_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await?;
        if !response.success {
            bail!(response
                .error
                .unwrap_or_else(|| "delivery failed".to_string()));
        }
        Ok(())
    }

    /// Pause a running bot whose guest did not answer. Returns whether the
    /// follower must keep watching: a TUI is attached, or a send arrived
    /// during the pause (the bot is then resumed).
    async fn pause_unwatched(self: &Arc<Self>, bot_id: &str) -> Result<bool> {
        let manager = manager_for(&self.options.agent_dir)?;
        let running = manager
            .get(bot_id)
            .is_some_and(|record| record.status == BotStatus::Running);
        let sent = follows()
            .lock()
            .unwrap()
            .get(bot_id)
            .is_some_and(|follow| follow.again);
        if !running || sent {
            return Ok(false);
        }
        if manager.attached(bot_id) {
            return Ok(true);
        }
        manager.pause(bot_id).await?;
        // A send that started during the pause finds the bot paused.
        if take_again(bot_id) {
            manager.ensure_running(bot_id).await?;
            return Ok(true);
        }
        Ok(false)
    }

    /// The pause step after the grace. Turns the guest ran on its own
    /// (heartbeats, cron) are delivered first. The bot is paused when no
    /// send arrived, no TUI is attached, and the guest session is idle with
    /// an empty queue. Returns whether the follower must go round again: a
    /// busy guest, an attached TUI, or a send during the pause.
    async fn pause_step(self: &Arc<Self>, bot_id: &str) -> Result<bool> {
        let manager = manager_for(&self.options.agent_dir)?;
        let Some(record) = manager.get(bot_id) else {
            return Ok(false);
        };
        if record.status != BotStatus::Running {
            return Ok(false);
        }
        if manager.attached(bot_id) {
            return Ok(true);
        }
        // A failed catch-up does not keep an idle bot running: what it did
        // not deliver stays after the last mark for the next follow.
        if let Err(error) = self.sync_bot(bot_id).await {
            eprintln!("pa-daemon: bots: {bot_id}: catch-up before the pause failed: {error:#}");
        }
        let mut client = GuestClient::connect(&manager, &record).await?;
        let quiet = || {
            !follows()
                .lock()
                .unwrap()
                .get(bot_id)
                .is_some_and(|follow| follow.again)
                && !manager.attached(bot_id)
        };
        match pause_verdict(&mut client, &record.guest_session_id, quiet).await? {
            PauseVerdict::Pause => {
                drop(client);
                manager.pause(bot_id).await?;
                // A send that started during the pause finds the bot paused.
                if take_again(bot_id) {
                    manager.ensure_running(bot_id).await?;
                    return Ok(true);
                }
                Ok(false)
            }
            PauseVerdict::FollowAgain | PauseVerdict::Keep => Ok(true),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PauseVerdict {
    Pause,
    /// The guest runs a turn or holds queued input: follow it again.
    FollowAgain,
    /// A send arrived or a TUI attached during the grace period.
    Keep,
}

/// The decision at the end of the grace period after a settled turn.
/// `quiet` answers whether no send arrived and no TUI is attached.
/// Background kernel work and factory runs hold the pause here even
/// though the turn's answer was already delivered.
pub(crate) async fn pause_verdict<G: GuestCommands>(
    guest: &mut G,
    session: &str,
    quiet: impl Fn() -> bool,
) -> Result<PauseVerdict> {
    if !quiet() {
        return Ok(PauseVerdict::Keep);
    }
    Ok(if guest_pause_busy(guest, session).await? {
        PauseVerdict::FollowAgain
    } else if quiet() {
        PauseVerdict::Pause
    } else {
        PauseVerdict::Keep
    })
}

#[cfg(test)]
#[path = "replies_tests.rs"]
mod tests;

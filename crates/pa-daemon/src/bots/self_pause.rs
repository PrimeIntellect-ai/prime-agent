//! The guest daemon's idle self-pause for bots.
//!
//! A bot sandbox bills while it runs. The owner's daemon pauses a bot
//! soon after a settled turn, but with the owner's machine offline
//! nothing does, so the bot would run and bill until the machine
//! returns. The guest daemon closes that gap: after
//! [`SelfPauseConfig::idle_minutes`] minutes with no running turn, no
//! session-attached client, and no client command — the owner's link is
//! the only source of those — it asks the always-on relay to pause its
//! own sandbox. The relay holds the platform key; the guest never does
//! (its pause request carries [`GUEST_API_KEY_PLACEHOLDER`], which the
//! sandbox's header rule for the relay host replaces with the bot's
//! per-bot token outside the sandbox). A resume — by the owner's
//! daemon, or by the relay on a wake — continues the daemon where it
//! froze, sessions intact, and the timer re-arms: the bootstrap that
//! follows every wake rewrites the configuration file this reads.
//!
//! The pause call is one `POST {pauseUrl}` with the bot's sandbox id;
//! the owner's daemon builds the URL from the `bots.relay.url` setting
//! and registers the bot's token with the relay.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use pa_core::cron::{is_heartbeat_cron_job, parse_iso_millis, JobStatus};
use serde_json::Value;

use super::credentials::GUEST_API_KEY_PLACEHOLDER;
use crate::supervisor::Supervisor;

/// The env var naming the self-pause configuration file; only the bot
/// bootstrap sets it (the guest daemon arms self-pause only then).
pub const SELF_PAUSE_ENV: &str = "PRIME_AGENT_BOT_SELF_PAUSE";
/// The idle minutes a file without the field falls back to.
pub const DEFAULT_IDLE_MINUTES: u64 = 10;
/// How often the idle state is re-checked.
const TICK_MS: u64 = 30_000;
const TICK: Duration = Duration::from_millis(TICK_MS);
/// The largest gap between ticks treated as normal scheduling. A larger
/// gap means the VM was frozen or the runtime was starved; the idle
/// window starts over so a due heartbeat can fire first.
const RESUME_JUMP_MS: u64 = 45_000;
/// The oldest overdue heartbeat that still holds off a self-pause. A due
/// job older than this is dormant (no live scheduler) or stuck; an idle
/// sandbox must not keep billing for it.
pub(crate) const HEARTBEAT_GUARD_MAX_OVERDUE_MS: u64 = 5 * 60 * 1000;
/// The pause request's deadline.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The self-pause configuration, rewritten by the bot bootstrap at every
/// wake (a fresh sandbox id after a restore, a fresh setting).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelfPauseConfig {
    pub bot_id: String,
    pub sandbox_id: String,
    /// The relay base URL for the wake-up mirror; empty leaves the local
    /// scheduler as the only wake source.
    pub relay_url: String,
    /// The full pause endpoint; empty turns the feature off.
    pub pause_url: String,
    pub idle_minutes: u64,
}

impl SelfPauseConfig {
    /// The configuration in `path`.
    pub(crate) fn load_from(path: &Path) -> Option<Self> {
        let file = std::fs::read_to_string(path).ok()?;
        let value: Value = serde_json::from_str(&file).ok()?;
        Some(Self {
            bot_id: value.get("botId")?.as_str()?.to_string(),
            sandbox_id: value.get("sandboxId")?.as_str()?.to_string(),
            relay_url: value
                .get("relayUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            pause_url: value
                .get("pauseUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            idle_minutes: value
                .get("idleMinutes")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_IDLE_MINUTES),
        })
    }

    /// Whether the self-pause is on: a pause endpoint and a nonzero
    /// idle window.
    fn enabled(&self) -> bool {
        !self.pause_url.is_empty() && self.idle_minutes > 0
    }
}

/// Inbound client lines so far: the owner's commands, a TUI attach, and
/// any local client all arrive as client lines, so any of them holds
/// off the self-pause.
static CLIENT_LINES: AtomicU64 = AtomicU64::new(0);

/// Note inbound client activity (one read line of one connection).
pub(crate) fn note_client_activity() {
    CLIENT_LINES.fetch_add(1, Ordering::Relaxed);
}

/// The self-pause loop: one check per [`TICK`]; every pause attempt
/// re-arms the full idle window. `busy` answers whether anything holds
/// off the pause, `lines` counts the inbound client lines so far, `wall`
/// reads the wall clock in epoch milliseconds, `before_pause` reports
/// whether the relay accepted the current wake-up set, and `request`
/// performs the pause.
pub(crate) async fn self_pause_loop<F, S>(
    config_path: PathBuf,
    mut busy: impl FnMut() -> bool,
    mut lines: impl FnMut() -> u64,
    mut wall: impl FnMut() -> u64,
    mut before_pause: impl FnMut() -> S,
    request: impl Fn(SelfPauseConfig) -> F,
) where
    F: std::future::Future<Output = Result<()>>,
    S: std::future::Future<Output = bool>,
{
    let mut idle_since = tokio::time::Instant::now();
    let mut lines_at_start = lines();
    let mut last_wall = wall();
    loop {
        tokio::time::sleep(TICK).await;
        let now_wall = wall();
        let wall_delta = now_wall.saturating_sub(last_wall);
        last_wall = now_wall;
        if wall_delta > RESUME_JUMP_MS {
            // A long gap between ticks is a frozen VM or a starved runtime,
            // not idle time. Start a fresh window: the relay may have just
            // resumed this sandbox for a due heartbeat that has not run yet.
            idle_since = tokio::time::Instant::now();
            lines_at_start = lines();
            continue;
        }
        let Some(config) = SelfPauseConfig::load_from(&config_path) else {
            continue;
        };
        if !config.enabled() {
            continue;
        }
        let lines_now = lines();
        if busy() || lines_now != lines_at_start {
            lines_at_start = lines_now;
            idle_since = tokio::time::Instant::now();
            continue;
        }
        let window = Duration::from_secs(config.idle_minutes.saturating_mul(60));
        if idle_since.elapsed() < window {
            continue;
        }
        // A heartbeat fire can land just before this pause. Mirror the
        // current next run times first, so a frozen VM never leaves a
        // stale schedule on the relay.
        let synced = before_pause().await;
        let lines_after_sync = lines();
        if !synced {
            // The relay never accepted the current schedule. A pause could
            // miss a heartbeat that only the relay would wake, so re-arm
            // the whole window and retry the sync later.
            lines_at_start = lines_after_sync;
            idle_since = tokio::time::Instant::now();
            continue;
        }
        if busy() || lines_after_sync != lines_now {
            // The sync can give a due heartbeat or a fresh turn time to
            // start, or a client command can arrive and finish during it:
            // never pause over either.
            lines_at_start = lines_after_sync;
            idle_since = tokio::time::Instant::now();
            continue;
        }
        if let Err(error) = request(config).await {
            eprintln!("pa-daemon: bots: self-pause request failed: {error:#}");
        }
        // The pause lands asynchronously; if it never does, the next
        // attempt is a full window away, never a tight retry loop.
        idle_since = tokio::time::Instant::now();
    }
}

/// Whether any active heartbeat is due within the next tick. A relay wake
/// must not be undone by a self-pause before the local scheduler starts
/// the due turn.
pub(crate) fn heartbeat_due_soon(agent_dir: &Path, now_ms: u64) -> bool {
    let horizon = now_ms.saturating_add(TICK_MS);
    let floor = now_ms.saturating_sub(HEARTBEAT_GUARD_MAX_OVERDUE_MS);
    crate::update_roster::scan_all_scheduled_jobs(agent_dir)
        .into_iter()
        .filter(|job| is_heartbeat_cron_job(job) && job.status == JobStatus::Active)
        .any(|job| {
            job.next_run_at
                .as_deref()
                .and_then(parse_iso_millis)
                .is_some_and(|next| (floor..=horizon).contains(&next))
        })
}

/// Ask the relay to pause this sandbox. The `Authorization` header holds
/// the placeholder; the sandbox's header rule for the relay host
/// replaces it with the per-bot token outside the sandbox.
async fn request_pause(config: &SelfPauseConfig) -> Result<()> {
    let client = pa_ai::utils::tls::http_client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| anyhow!("the self-pause client could not be built: {error}"))?;
    let body = serde_json::to_vec(&serde_json::json!({
        "sandboxId": config.sandbox_id,
    }))?;
    let response = client
        .post(&config.pause_url)
        .header(
            "Authorization",
            format!("Bearer {GUEST_API_KEY_PLACEHOLDER}"),
        )
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await?;
    let status = response.status();
    if status.is_success() {
        eprintln!(
            "pa-daemon: bots: bot {} asked the relay to pause sandbox {}",
            config.bot_id, config.sandbox_id
        );
        Ok(())
    } else {
        Err(anyhow!("the relay answered {status}"))
    }
}

/// Whether a roster row's summary says its session runs anything.
fn summary_busy(summary: &Value) -> bool {
    let flag = |name: &str| summary.get(name).and_then(Value::as_bool) == Some(true);
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
}

impl Supervisor {
    /// Arm the guest-side self-pause when this daemon runs inside a bot
    /// sandbox (the bootstrap sets [`SELF_PAUSE_ENV`]); a no-op
    /// everywhere else.
    pub(crate) fn spawn_self_pause(self: &Arc<Self>) {
        let Some(path) = std::env::var_os(SELF_PAUSE_ENV) else {
            return;
        };
        let path = PathBuf::from(path);
        // The relay wake-up mirror reads the same bootstrap-owned file. A
        // missing relay URL in that file leaves the local timers alone.
        let sync = match crate::bots::wakeup_sync::WakeupSync::new(
            path.clone(),
            self.options.agent_dir.clone(),
        ) {
            Ok(sync) => Some(Arc::new(sync)),
            Err(error) => {
                eprintln!("pa-daemon: bots: the relay wake-up sync could not be built: {error:#}");
                None
            }
        };
        if let Some(sync) = &sync {
            sync.spawn_loop();
        }
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            let busy = move || supervisor.self_pause_active();
            let lines = || CLIENT_LINES.load(Ordering::Relaxed);
            let wall = crate::util::now_ms;
            let before_pause = {
                let sync = sync.clone();
                move || {
                    let sync = sync.clone();
                    async move {
                        let Some(sync) = sync else {
                            // The mirror could not be built, so a pause
                            // could miss a heartbeat.
                            return false;
                        };
                        match sync.sync(true).await {
                            Ok(_) => true,
                            Err(error) => {
                                eprintln!(
                                    "pa-daemon: bots: the pre-pause relay sync failed: {error:#}"
                                );
                                false
                            }
                        }
                    }
                }
            };
            let request = |config: SelfPauseConfig| async move { request_pause(&config).await };
            self_pause_loop(path, busy, lines, wall, before_pause, request).await;
        });
    }

    /// Whether anything holds off the self-pause: a session running a
    /// turn, tools, bash, compaction, or subagents, or a client
    /// attached to a session (the owner's TUI).
    fn self_pause_active(&self) -> bool {
        let busy = self
            .roster
            .lock()
            .unwrap()
            .entries()
            .iter()
            .any(|entry| summary_busy(&entry.summary));
        busy || self.session_subscribers.any_attached()
            || heartbeat_due_soon(&self.options.agent_dir, crate::util::now_ms())
    }
}

#[cfg(test)]
#[path = "self_pause_tests.rs"]
mod tests;

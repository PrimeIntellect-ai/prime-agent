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
use serde_json::Value;

use super::credentials::GUEST_API_KEY_PLACEHOLDER;
use crate::supervisor::Supervisor;

/// The env var naming the self-pause configuration file; only the bot
/// bootstrap sets it (the guest daemon arms self-pause only then).
pub const SELF_PAUSE_ENV: &str = "PRIME_AGENT_BOT_SELF_PAUSE";
/// The idle minutes a file without the field falls back to.
pub const DEFAULT_IDLE_MINUTES: u64 = 10;
/// How often the idle state is re-checked.
const TICK: Duration = Duration::from_secs(30);
/// The pause request's deadline.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The self-pause configuration, rewritten by the bot bootstrap at every
/// wake (a fresh sandbox id after a restore, a fresh setting).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelfPauseConfig {
    pub bot_id: String,
    pub sandbox_id: String,
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
/// off the pause, `lines` counts the inbound client lines so far, and
/// `request` performs the pause.
pub(crate) async fn self_pause_loop<F>(
    config_path: PathBuf,
    mut busy: impl FnMut() -> bool,
    mut lines: impl FnMut() -> u64,
    request: impl Fn(SelfPauseConfig) -> F,
) where
    F: std::future::Future<Output = Result<()>>,
{
    let mut idle_since = tokio::time::Instant::now();
    let mut lines_at_start = lines();
    loop {
        tokio::time::sleep(TICK).await;
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
        if let Err(error) = request(config).await {
            eprintln!("pa-daemon: bots: self-pause request failed: {error:#}");
        }
        // The pause lands asynchronously; if it never does, the next
        // attempt is a full window away, never a tight retry loop.
        idle_since = tokio::time::Instant::now();
    }
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
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            let busy = move || supervisor.self_pause_active();
            let lines = || CLIENT_LINES.load(Ordering::Relaxed);
            let request = |config: SelfPauseConfig| async move { request_pause(&config).await };
            self_pause_loop(PathBuf::from(path), busy, lines, request).await;
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
    }
}

#[cfg(test)]
#[path = "self_pause_tests.rs"]
mod tests;

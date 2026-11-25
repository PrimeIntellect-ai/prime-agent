//! The guest daemon's relay wake-up mirror for `rlm_heartbeat` jobs.
//!
//! A paused bot's sandbox freezes, so its local scheduler cannot fire. When
//! the bootstrap gives the guest a relay URL, the daemon mirrors the whole
//! `rlm_heartbeat` schedule set to the relay. The relay resumes the sandbox
//! when one is due; the local scheduler remains the only firing path, so
//! this mirror never delivers a prompt and cannot double-fire.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_core::cron::{parse_iso_millis, JobStatus, ScheduleKind};
use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};

use super::credentials::GUEST_API_KEY_PLACEHOLDER;
use super::self_pause::SelfPauseConfig;

/// How often the mirror re-reads the schedule set when no change wakes it.
const POLL: Duration = Duration::from_secs(10);
/// The boot mirror waits briefly for the first session artifacts.
const BOOT_DELAY: Duration = Duration::from_secs(3);
/// The mirror request's deadline.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Wakes the mirror after a heartbeat mutation or fire.
static WAKEUP_SYNC_NOTIFY: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Wake the guest's mirror (a no-op outside a bot guest).
pub(crate) fn notify() {
    WAKEUP_SYNC_NOTIFY.notify_one();
}

/// The guest's relay wake-up mirror.
pub(crate) struct WakeupSync {
    config_path: PathBuf,
    agent_dir: PathBuf,
    client: reqwest::Client,
    /// The last payload the relay accepted. A failed send leaves it
    /// untouched, so the next poll (or pre-pause sync) retries.
    last_sent: Mutex<Option<String>>,
}

impl WakeupSync {
    /// Build the mirror for one guest daemon.
    pub(crate) fn new(config_path: PathBuf, agent_dir: PathBuf) -> Result<Self> {
        let client = pa_ai::utils::tls::http_client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| anyhow!("the relay wake-up client could not be built: {error}"))?;
        Ok(Self {
            config_path,
            agent_dir,
            client,
            last_sent: Mutex::new(None),
        })
    }

    /// Mirror the current set to the relay. `Ok(false)` means there is no
    /// relay configured, or the accepted payload is unchanged; `force`
    /// sends even when unchanged (the pre-pause checkpoint).
    pub(crate) async fn sync(&self, force: bool) -> Result<bool> {
        let Some(config) = SelfPauseConfig::load_from(&self.config_path) else {
            return Ok(false);
        };
        if config.relay_url.trim().is_empty()
            || config.bot_id.is_empty()
            || config.sandbox_id.is_empty()
        {
            return Ok(false);
        }
        let agent_dir = self.agent_dir.clone();
        let wakeups = tokio::task::spawn_blocking(move || wakeup_set(&agent_dir))
            .await
            .context("the relay wake-up scan task failed")?;
        let body = serde_json::to_string(&json!({
            "sandboxId": config.sandbox_id,
            "wakeups": wakeups,
        }))?;
        let mut last_sent = self.last_sent.lock().await;
        if !force && last_sent.as_deref() == Some(body.as_str()) {
            return Ok(false);
        }
        let endpoint = format!(
            "{}/api/bots/{}/wakeups",
            config.relay_url.trim_end_matches('/'),
            config.bot_id
        );
        let response = self
            .client
            .put(&endpoint)
            .header(
                "Authorization",
                format!("Bearer {GUEST_API_KEY_PLACEHOLDER}"),
            )
            .header("Content-Type", "application/json")
            .body(body.clone())
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(anyhow!("the relay answered {status}"));
        }
        *last_sent = Some(body);
        Ok(true)
    }

    /// Wake the mirror after the boot delay, then on changes and a poll.
    pub(crate) fn spawn_loop(self: &Arc<Self>) {
        let sync = Arc::clone(self);
        tokio::spawn(sync.run_loop(BOOT_DELAY, POLL));
    }

    /// The loop body, with injectable timings for tests.
    pub(crate) async fn run_loop(self: Arc<Self>, boot_delay: Duration, poll: Duration) {
        tokio::time::sleep(boot_delay).await;
        loop {
            if let Err(error) = self.sync(false).await {
                eprintln!("pa-daemon: bots: the relay wake-up sync failed: {error:#}");
            }
            tokio::select! {
                () = tokio::time::sleep(poll) => {}
                () = WAKEUP_SYNC_NOTIFY.notified() => {}
            }
        }
    }
}

/// The whole `rlm_heartbeat` set to mirror: every active job in every
/// session artifact partition. Paused, cancelled, and non-RLM jobs stay
/// local. `nextRunAt` is unix seconds, rounded up so the relay never wakes
/// the sandbox before the native due time.
pub(crate) fn wakeup_set(agent_dir: &Path) -> Vec<Value> {
    let mut wakeups: Vec<Value> = crate::update_roster::scan_scheduled_jobs(agent_dir)
        .into_iter()
        .filter(|job| job.source.as_deref() == Some("rlm_heartbeat"))
        .filter(|job| job.status == JobStatus::Active)
        .filter_map(|job| {
            let next = job.next_run_at.as_deref().and_then(parse_iso_millis)?;
            let mut entry = json!({
                "id": job.id,
                "nextRunAt": next.div_ceil(1000),
            });
            if job.schedule.kind == ScheduleKind::Cron {
                entry["cron"] = json!(job.schedule.expression);
            }
            Some(entry)
        })
        .collect();
    wakeups.sort_by(|left, right| {
        left["nextRunAt"]
            .as_u64()
            .cmp(&right["nextRunAt"].as_u64())
            .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
    });
    wakeups
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use pa_core::cron::store::{
        AgentCronJobStore, CreateAgentCronJobInput, RlmHeartbeatStatusUpdate, RlmHeartbeatUpdate,
    };
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn add_rlm(
        store: &AgentCronJobStore,
        live: &str,
        session: &str,
        now: u64,
        schedule: &str,
    ) -> pa_core::cron::AgentCronJob {
        store
            .create_rlm_heartbeat(&CreateAgentCronJobInput {
                active_session_id: live.to_string(),
                session_id: session.to_string(),
                session_file: format!("/w/{session}.jsonl"),
                cwd: "/w".to_string(),
                prompt: "check".to_string(),
                schedule_text: schedule.to_string(),
                now: Some(now),
                ..Default::default()
            })
            .expect("rlm heartbeat")
    }

    fn add_plain(
        store: &AgentCronJobStore,
        live: &str,
        session: &str,
        now: u64,
    ) -> pa_core::cron::AgentCronJob {
        store
            .create(&CreateAgentCronJobInput {
                active_session_id: live.to_string(),
                session_id: session.to_string(),
                session_file: format!("/w/{session}.jsonl"),
                cwd: "/w".to_string(),
                prompt: "plain".to_string(),
                schedule_text: "every 10m".to_string(),
                now: Some(now),
                ..Default::default()
            })
            .expect("plain job")
    }

    fn artifact(root: &Path, session: &str) -> PathBuf {
        root.join("session-artifacts").join(session)
    }

    #[test]
    fn the_wakeup_set_is_daemon_wide_and_filters_local_jobs() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let now = 1_700_000_000_000;
        let store = AgentCronJobStore::for_session_artifacts();
        let main = artifact(root, "main");
        let child = main.join("child");
        std::fs::create_dir_all(&child).unwrap();
        store.register_session_artifact("main", &main);
        store.register_session_artifact("child", &child);

        let interval = add_rlm(&store, "live-main", "main", now, "every 10m");
        let cron = add_rlm(&store, "live-main", "main", now, "*/15 * * * *");
        add_plain(&store, "live-main", "main", now);
        let paused = add_rlm(&store, "live-main", "main", now, "every 10m");
        store
            .update_rlm_heartbeat(
                "live-main",
                &paused.id,
                &RlmHeartbeatUpdate {
                    status: Some(RlmHeartbeatStatusUpdate::Pause),
                    now: Some(now + 1),
                    ..Default::default()
                },
            )
            .unwrap();
        let subagent = add_rlm(&store, "live-child", "child", now, "every 5m");

        let set = wakeup_set(root);
        assert_eq!(set.len(), 3);
        let ids: BTreeSet<&str> = set
            .iter()
            .filter_map(|entry| entry["id"].as_str())
            .collect();
        assert!(ids.contains(interval.id.as_str()));
        assert!(ids.contains(cron.id.as_str()));
        assert!(ids.contains(subagent.id.as_str()));
        assert!(!ids.contains(paused.id.as_str()));

        let cron_entry = set
            .iter()
            .find(|entry| entry["id"] == json!(cron.id))
            .expect("cron entry");
        assert_eq!(cron_entry["cron"], json!("*/15 * * * *"));
        let interval_entry = set
            .iter()
            .find(|entry| entry["id"] == json!(interval.id))
            .expect("interval entry");
        assert!(interval_entry.get("cron").is_none());
        let expected = now + 10 * 60 * 1000;
        assert_eq!(interval_entry["nextRunAt"], json!(expected.div_ceil(1000)));
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = socket.read(&mut chunk).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("Content-Length: "))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or_default();
                if buffer.len() >= header_end + 4 + length {
                    break;
                }
            }
        }
        buffer
    }

    async fn one_shot_relay() -> (std::net::SocketAddr, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
            request
        });
        (address, server)
    }

    fn write_config(
        dir: &Path,
        address: std::net::SocketAddr,
        bot: &str,
        sandbox: &str,
    ) -> PathBuf {
        let path = dir.join("bot-self-pause.json");
        std::fs::write(
            &path,
            json!({
                "botId": bot,
                "sandboxId": sandbox,
                "relayUrl": format!("http://{address}"),
                "pauseUrl": "",
                "idleMinutes": 10,
            })
            .to_string(),
        )
        .unwrap();
        path
    }

    #[tokio::test]
    async fn the_mirror_puts_the_full_set_with_the_guest_token() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let now = crate::util::now_ms();
        let store = AgentCronJobStore::for_session_artifacts();
        let main = artifact(root, "main");
        let child = main.join("child");
        std::fs::create_dir_all(&child).unwrap();
        store.register_session_artifact("main", &main);
        store.register_session_artifact("child", &child);
        let first = add_rlm(&store, "live-main", "main", now, "every 10m");
        let second = add_rlm(&store, "live-child", "child", now, "every 5m");

        let (address, server) = one_shot_relay().await;
        let config = write_config(root, address, "bot-1", "sbx-1");
        let sync = WakeupSync::new(config, root.to_path_buf()).unwrap();
        assert!(sync.sync(true).await.unwrap());

        let request = server.await.unwrap();
        let request = String::from_utf8(request).unwrap();
        assert!(
            request.starts_with("PUT /api/bots/bot-1/wakeups "),
            "{request}"
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer injected-by-platform"));
        let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
        let body: Value = serde_json::from_str(body.trim_end()).unwrap();
        assert_eq!(body["sandboxId"], json!("sbx-1"));
        let ids: BTreeSet<&str> = body["wakeups"]
            .as_array()
            .expect("wakeups")
            .iter()
            .filter_map(|entry| entry["id"].as_str())
            .collect();
        assert!(ids.contains(first.id.as_str()));
        assert!(ids.contains(second.id.as_str()));
    }

    #[tokio::test]
    async fn the_boot_loop_mirrors_without_a_change() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let now = crate::util::now_ms();
        let store = AgentCronJobStore::for_session_artifacts();
        let main = artifact(root, "main");
        std::fs::create_dir_all(&main).unwrap();
        store.register_session_artifact("main", &main);
        add_rlm(&store, "live-main", "main", now, "every 10m");

        let (address, server) = one_shot_relay().await;
        let config = write_config(root, address, "bot-1", "sbx-1");
        let sync = Arc::new(WakeupSync::new(config, root.to_path_buf()).unwrap());
        let loop_task = tokio::spawn(
            Arc::clone(&sync).run_loop(Duration::from_millis(10), Duration::from_secs(3600)),
        );
        let request = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("the boot mirror sent")
            .unwrap();
        loop_task.abort();
        let request = String::from_utf8(request).unwrap();
        assert!(
            request.starts_with("PUT /api/bots/bot-1/wakeups "),
            "{request}"
        );
    }

    #[tokio::test]
    async fn an_unchanged_set_is_not_sent_twice() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let now = crate::util::now_ms();
        let store = AgentCronJobStore::for_session_artifacts();
        let main = artifact(root, "main");
        std::fs::create_dir_all(&main).unwrap();
        store.register_session_artifact("main", &main);
        add_rlm(&store, "live-main", "main", now, "every 10m");

        let (address, server) = one_shot_relay().await;
        let config = write_config(root, address, "bot-1", "sbx-1");
        let sync = WakeupSync::new(config, root.to_path_buf()).unwrap();
        assert!(sync.sync(false).await.unwrap());
        let request = server.await.unwrap();
        assert!(!request.is_empty());
        assert!(!sync.sync(false).await.unwrap(), "unchanged set skipped");
    }
}

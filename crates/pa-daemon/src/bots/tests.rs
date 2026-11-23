//! Fake-platform tests of the bot lifecycle (after prime-orbs `test_dispatcher.py`).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use futures::FutureExt;

use super::platform::{
    BotCreate, BotPlatform, BotSandbox, ExecOutput, PlatformError, PlatformResult,
};
use super::version::{self, GUEST_VERSION_SCRIPT, INSTALL_SCRIPT};
use super::{bot_label, owner_label, BotManager, BotSpec, BotStatus, BOT_LABEL};

#[derive(Default)]
pub(crate) struct FakeState {
    pub sandboxes: BTreeMap<String, BotSandbox>,
    /// Checkpoint id -> the guest version it holds.
    pub checkpoints: BTreeMap<String, String>,
    pub guest_versions: HashMap<String, String>,
    pub keys: HashMap<String, String>,
    pub next: u32,
    pub creates: Vec<BotCreate>,
    pub installs: usize,
    /// The next create commits, then answers with a transport error.
    pub lose_next_create_reply: bool,
    pub refuse_pause: bool,
    /// New pause checkpoints stay pending (not durable).
    pub pause_checkpoints_pending: bool,
    /// Checkpoints that exist but are not durable yet.
    pub pending_checkpoints: std::collections::HashSet<String>,
    pub unpublished: bool,
}

/// An in-memory Prime account: sandboxes are running as soon as they exist.
#[derive(Default)]
pub(crate) struct FakePlatform {
    pub state: Mutex<FakeState>,
}

impl FakePlatform {
    pub fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().unwrap()
    }

    pub fn live(&self) -> Vec<BotSandbox> {
        self.state()
            .sandboxes
            .values()
            .filter(|sandbox| !sandbox.status.is_terminal())
            .cloned()
            .collect()
    }

    pub fn add_sandbox(&self, name: &str, labels: Vec<String>) -> String {
        let mut state = self.state();
        let id = state.new_id("sbx");
        let created_at = format!("2026-11-23T00:00:{:02}Z", state.next);
        state.sandboxes.insert(
            id.clone(),
            BotSandbox {
                id: id.clone(),
                name: name.to_string(),
                status: BotStatus::Running,
                labels,
                created_at,
                error_message: None,
            },
        );
        id
    }
}

impl FakeState {
    fn new_id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}-{}", self.next)
    }

    fn sandbox(&mut self, id: &str) -> PlatformResult<&mut BotSandbox> {
        self.sandboxes
            .get_mut(id)
            .ok_or_else(|| PlatformError::NotFound(id.to_string()))
    }
}

impl BotPlatform for FakePlatform {
    fn create<'a>(&'a self, request: &'a BotCreate) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        async move {
            let existing = self.state().keys.get(&request.idempotency_key).cloned();
            if let Some(id) = existing {
                return Ok(self.state().sandboxes[&id].clone());
            }
            let id = self.add_sandbox(&request.name, request.labels.clone());
            let mut state = self.state();
            state.creates.push(request.clone());
            state
                .keys
                .insert(request.idempotency_key.clone(), id.clone());
            if let Some(checkpoint) = &request.checkpoint_id {
                let version = state.checkpoints[checkpoint].clone();
                state.guest_versions.insert(id.clone(), version);
            }
            if std::mem::take(&mut state.lose_next_create_reply) {
                return Err(PlatformError::Transient("connection reset".into()));
            }
            Ok(state.sandboxes[&id].clone())
        }
        .boxed()
    }

    fn get<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        async move { self.state().sandbox(sandbox_id).cloned() }.boxed()
    }

    fn list<'a>(&'a self, label: &'a str) -> BoxFuture<'a, PlatformResult<Vec<BotSandbox>>> {
        async move {
            Ok(self
                .state()
                .sandboxes
                .values()
                .filter(|sandbox| sandbox.labels.iter().any(|have| have == label))
                .cloned()
                .collect())
        }
        .boxed()
    }

    fn delete<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            if let Ok(sandbox) = self.state().sandbox(sandbox_id) {
                sandbox.status = BotStatus::Stopped;
            }
            Ok(())
        }
        .boxed()
    }

    fn pause<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<Option<String>>> {
        async move {
            let mut state = self.state();
            if state.refuse_pause {
                return Err(PlatformError::Other("VM cannot be paused".into()));
            }
            state.sandbox(sandbox_id)?.status = BotStatus::Paused;
            let checkpoint = state.new_id("ckpt");
            let version = state
                .guest_versions
                .get(sandbox_id)
                .cloned()
                .unwrap_or_default();
            state.checkpoints.insert(checkpoint.clone(), version);
            if state.pause_checkpoints_pending {
                state.pending_checkpoints.insert(checkpoint.clone());
            }
            Ok(Some(checkpoint))
        }
        .boxed()
    }

    fn resume<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        async move {
            let mut state = self.state();
            let sandbox = state.sandbox(sandbox_id)?;
            sandbox.status = BotStatus::Running;
            Ok(sandbox.clone())
        }
        .boxed()
    }

    fn checkpoint<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<String>> {
        async move {
            let mut state = self.state();
            state.sandbox(sandbox_id)?;
            let checkpoint = state.new_id("ckpt");
            let version = state
                .guest_versions
                .get(sandbox_id)
                .cloned()
                .unwrap_or_default();
            state.checkpoints.insert(checkpoint.clone(), version);
            Ok(checkpoint)
        }
        .boxed()
    }

    fn wait_checkpoint<'a>(&'a self, checkpoint_id: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            self.state().pending_checkpoints.remove(checkpoint_id);
            Ok(())
        }
        .boxed()
    }

    fn checkpoint_durable<'a>(
        &'a self,
        checkpoint_id: &'a str,
    ) -> BoxFuture<'a, PlatformResult<bool>> {
        async move {
            let state = self.state();
            Ok(state.checkpoints.contains_key(checkpoint_id)
                && !state.pending_checkpoints.contains(checkpoint_id))
        }
        .boxed()
    }

    fn delete_checkpoint<'a>(
        &'a self,
        checkpoint_id: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            self.state().checkpoints.remove(checkpoint_id);
            Ok(())
        }
        .boxed()
    }

    fn exec<'a>(
        &'a self,
        sandbox_id: &'a str,
        script: &'a str,
        env: &'a BTreeMap<String, String>,
        _stdin: Option<&'a [u8]>,
    ) -> BoxFuture<'a, PlatformResult<ExecOutput>> {
        async move {
            let mut state = self.state();
            if state.sandbox(sandbox_id)?.status != BotStatus::Running {
                return Err(PlatformError::Transient("gateway not ready".into()));
            }
            let mut output = ExecOutput::default();
            if script == GUEST_VERSION_SCRIPT {
                output.stdout = state
                    .guest_versions
                    .get(sandbox_id)
                    .cloned()
                    .unwrap_or_default();
            } else if script == INSTALL_SCRIPT {
                state.installs += 1;
                if state.unpublished {
                    output.exit_code = version::UNPUBLISHED_EXIT_CODE;
                } else {
                    state
                        .guest_versions
                        .insert(sandbox_id.to_string(), env["PA_VERSION"].clone());
                }
            } else {
                assert!(env.contains_key("BOT_CLIENT"), "unexpected guest script");
                let file = env
                    .get("BOT_SESSION_FILE")
                    .cloned()
                    .unwrap_or_else(|| format!("/root/{sandbox_id}.jsonl"));
                output.stdout = serde_json::json!({
                    "activeSessionId": format!("guest-{sandbox_id}"),
                    "sessionFile": file,
                })
                .to_string();
            }
            Ok(output)
        }
        .boxed()
    }
}

fn setup() -> (tempfile::TempDir, Arc<FakePlatform>, BotManager) {
    let dir = tempfile::tempdir().unwrap();
    let platform = Arc::new(FakePlatform::default());
    let manager =
        BotManager::new(dir.path(), Arc::clone(&platform) as Arc<dyn BotPlatform>).unwrap();
    (dir, platform, manager)
}

fn spec(bot_id: &str) -> BotSpec {
    BotSpec {
        bot_id: bot_id.to_string(),
        name: "helper".to_string(),
        owner_session_id: "owner-1".to_string(),
        model: Some("prime-inference/model-a".to_string()),
        thinking: None,
        prompt: "hello".to_string(),
    }
}

#[tokio::test(start_paused = true)]
async fn spawn_pause_resume_delete() {
    let (dir, platform, manager) = setup();

    let spawned = manager.spawn(&spec("bot-a")).await.unwrap();
    assert_eq!(spawned.status, BotStatus::Running);
    assert_eq!(spawned.version, version::local_version());
    let sandbox_id = spawned.sandbox_id.clone().unwrap();
    assert_eq!(spawned.guest_session_id, format!("guest-{sandbox_id}"));
    assert_eq!(platform.state().installs, 1);
    let labels = &platform.live()[0].labels;
    assert!(labels.contains(&bot_label("bot-a")) && labels.contains(&owner_label("owner-1")));

    let paused = manager.pause("bot-a").await.unwrap();
    assert_eq!(paused.status, BotStatus::Paused);
    let checkpoint = paused.checkpoint_id.clone().unwrap();

    // Same version: resume reuses the sandbox and the guest session, no reinstall.
    let resumed = manager.ensure_running("bot-a").await.unwrap();
    assert_eq!(resumed.sandbox_id.as_deref(), Some(sandbox_id.as_str()));
    assert_eq!(resumed.guest_session_file, spawned.guest_session_file);
    assert_eq!(platform.state().installs, 1);

    // The Mac upgraded while the bot slept: resume installs the Mac's version.
    manager.pause("bot-a").await.unwrap();
    assert!(
        !platform.state().checkpoints.contains_key(&checkpoint),
        "superseded checkpoint deleted"
    );
    platform
        .state()
        .guest_versions
        .insert(sandbox_id.clone(), "0.0.1".into());
    let upgraded = manager.ensure_running("bot-a").await.unwrap();
    assert_eq!(platform.state().installs, 2);
    assert_eq!(
        platform.state().guest_versions[&sandbox_id],
        version::local_version()
    );
    assert_eq!(upgraded.version, version::local_version());

    manager.delete("bot-a").await.unwrap();
    assert!(platform.live().is_empty());
    assert!(platform.state().checkpoints.is_empty());
    assert!(manager.list().is_empty());
    let reloaded = BotManager::new(dir.path(), platform as Arc<dyn BotPlatform>).unwrap();
    assert!(reloaded.list().is_empty());
    // Deleting again is a no-op.
    manager.delete("bot-a").await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn create_retry_reuses_the_idempotency_key() {
    let (_dir, platform, manager) = setup();
    platform.state().lose_next_create_reply = true;

    let spawned = manager.spawn(&spec("bot-a")).await.unwrap();

    let live = platform.live();
    assert_eq!(
        live.len(),
        1,
        "the retried create returned the first sandbox"
    );
    assert_eq!(spawned.sandbox_id.as_deref(), Some(live[0].id.as_str()));
    assert_eq!(platform.state().keys.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn duplicates_are_deleted_and_lost_records_rebuilt() {
    let (dir, platform, manager) = setup();
    let labels = vec![
        BOT_LABEL.to_string(),
        bot_label("bot-a"),
        owner_label("owner-1"),
    ];
    let older = platform.add_sandbox("helper", labels.clone());
    let newer = platform.add_sandbox("helper", labels);

    manager.reconcile_on_boot().await.unwrap();

    let live: Vec<String> = platform
        .live()
        .into_iter()
        .map(|sandbox| sandbox.id)
        .collect();
    assert_eq!(live, vec![newer.clone()]);
    assert_ne!(older, newer);
    let record = manager.get("bot-a").unwrap();
    assert_eq!(record.sandbox_id.as_deref(), Some(newer.as_str()));
    assert_eq!(record.owner_session_id, "owner-1");
    assert_eq!(record.name, "helper");

    // A sandbox that vanished while the Mac was away leaves a stopped record.
    platform.state().sandboxes.get_mut(&newer).unwrap().status = BotStatus::Stopped;
    let reloaded =
        BotManager::new(dir.path(), Arc::clone(&platform) as Arc<dyn BotPlatform>).unwrap();
    reloaded.reconcile_on_boot().await.unwrap();
    let record = reloaded.get("bot-a").unwrap();
    assert_eq!(record.status, BotStatus::Stopped);
    assert_eq!(record.sandbox_id, None);
}

#[tokio::test(start_paused = true)]
async fn refused_pause_checkpoints_and_restores() {
    let (_dir, platform, manager) = setup();
    let spawned = manager.spawn(&spec("bot-a")).await.unwrap();
    platform.state().refuse_pause = true;

    let stopped = manager.pause("bot-a").await.unwrap();
    assert_eq!(stopped.status, BotStatus::Stopped);
    assert!(platform.live().is_empty());
    let checkpoint = stopped.checkpoint_id.clone().unwrap();
    assert_eq!(
        stopped.generation,
        spawned.generation + 1,
        "the next cold boot gets a new key"
    );

    let restored = manager.ensure_running("bot-a").await.unwrap();
    assert_ne!(restored.sandbox_id, spawned.sandbox_id);
    let creates = platform.state().creates.clone();
    assert_eq!(
        creates.last().unwrap().checkpoint_id.as_deref(),
        Some(checkpoint.as_str())
    );
    // The restored disk holds the session file; the guest reopens it, and the version matches.
    assert_eq!(restored.guest_session_file, spawned.guest_session_file);
    assert_eq!(platform.state().installs, 1);
}

#[tokio::test(start_paused = true)]
async fn restore_falls_back_to_the_newest_durable_checkpoint() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    let durable = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    platform.state().pause_checkpoints_pending = true;

    let paused = manager.pause("bot-a").await.unwrap();
    assert_eq!(paused.older_checkpoint_ids, vec![durable.clone()]);
    assert!(
        platform.state().checkpoints.contains_key(&durable),
        "kept until a newer one is durable"
    );

    // The paused sandbox is lost while its newest checkpoint still uploads.
    let sandbox_id = paused.sandbox_id.unwrap();
    platform
        .state()
        .sandboxes
        .get_mut(&sandbox_id)
        .unwrap()
        .status = BotStatus::Stopped;
    manager.ensure_running("bot-a").await.unwrap();
    let creates = platform.state().creates.clone();
    assert_eq!(
        creates.last().unwrap().checkpoint_id.as_deref(),
        Some(durable.as_str())
    );
}

#[tokio::test(start_paused = true)]
async fn unpublished_version_fails_spawn_and_cleans_up() {
    let (_dir, platform, manager) = setup();
    platform.state().unpublished = true;

    assert!(manager.spawn(&spec("bot-a")).await.is_err());

    assert!(platform.live().is_empty());
    assert!(manager.list().is_empty());
}

#[test]
fn attach_guard_counts_attaches() {
    let (_dir, _platform, manager) = setup();
    let first = manager.attach_guard("bot-a");
    let second = manager.attach_guard("bot-a");
    drop(first);
    assert!(manager.attached("bot-a"));
    drop(second);
    assert!(!manager.attached("bot-a"));
}

/// Live: one real sandbox through spawn, pause, resume, and delete.
/// Run with `PRIME_API_KEY` (and `PRIME_TEAM_ID`) set:
/// `cargo test -p pa-daemon --lib bots::tests::live -- --ignored`.
#[tokio::test]
#[ignore = "creates a real Prime sandbox"]
async fn live_spawn_pause_resume_delete() {
    let client = pa_sandbox::PrimeSandboxClient::new(
        &std::env::var("PRIME_API_KEY").expect("PRIME_API_KEY"),
        pa_sandbox::ClientOptions {
            base_url: pa_sandbox::DEFAULT_BASE_URL.to_string(),
            team_id: std::env::var("PRIME_TEAM_ID").ok(),
            request_timeout: None,
            allow_insecure_localhost: false,
        },
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let manager = BotManager::new(
        dir.path(),
        Arc::new(super::platform::PrimePlatform::new(client)),
    )
    .unwrap();
    let bot_id = format!("live-{}", uuid::Uuid::new_v4());

    let run = async {
        let spawned = manager.spawn(&spec(&bot_id)).await?;
        let paused = manager.pause(&bot_id).await?;
        let resumed = manager.ensure_running(&bot_id).await?;
        anyhow::Ok((spawned, paused, resumed))
    }
    .await;
    manager.delete(&bot_id).await.unwrap();
    let (spawned, paused, resumed) = run.unwrap();

    assert!(!spawned.guest_session_id.is_empty());
    assert_eq!(spawned.version, version::local_version());
    assert!(matches!(
        paused.status,
        BotStatus::Paused | BotStatus::Stopped
    ));
    assert_eq!(resumed.status, BotStatus::Running);
    assert_eq!(resumed.guest_session_file, spawned.guest_session_file);
    eprintln!("live: spawned={spawned:?}\npaused={paused:?}\nresumed={resumed:?}");
}

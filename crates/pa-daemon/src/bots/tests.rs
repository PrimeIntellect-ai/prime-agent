//! Fake-platform tests of the bot lifecycle (after prime-orbs `test_dispatcher.py`).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use futures::FutureExt;

use pa_core::settings::BotGitIdentity;
use pa_sandbox::CommandSpec;
use tokio::io::AsyncWriteExt;

use super::exec_stream::ExecStreamHalves;
use super::platform::{
    BotCreate, BotPlatform, BotSandbox, ExecOutput, GuestCredentials, PlatformError, PlatformResult,
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
    /// The next credential provisioning fails with a transport error.
    pub fail_next_credentials: bool,
    pub refuse_pause: bool,
    /// Pauses answer that the team's checkpoint storage is full.
    pub checkpoint_storage_full: bool,
    pub pauses: usize,
    /// New pause checkpoints stay pending (not durable).
    pub pause_checkpoints_pending: bool,
    /// Checkpoints that exist but are not durable yet.
    pub pending_checkpoints: std::collections::HashSet<String>,
    /// The exit code of the next guest installs (0 = they succeed).
    pub install_exit_code: i32,
    /// The guest lacks the installer's tools (node, gh): the version probe
    /// reports nothing until an install succeeds.
    pub guest_tools_missing: bool,
    /// A relay that ends with this before its hello (exit code and stderr).
    pub relay_end: Option<String>,
    /// The version a linked guest says hello with; `None` = this build's.
    pub guest_app_version: Option<String>,
    /// The guest ends of open links: (its stdout, its stdin).
    pub links: Vec<(tokio::io::DuplexStream, tokio::io::DuplexStream)>,
    /// Every guest command: its script and environment.
    pub execs: Vec<(String, BTreeMap<String, String>)>,
    /// API-key rule hosts each credentials request returns.
    pub key_hosts: usize,
    /// Platform secrets by name, and how many puts ran.
    pub secrets: BTreeMap<String, String>,
    pub secret_puts: usize,
    /// Each network rules update: the sandbox and its rule hosts.
    pub rule_updates: Vec<(String, Vec<String>)>,
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
            state.pauses += 1;
            if state.checkpoint_storage_full {
                return Err(PlatformError::CheckpointQuota("HTTP 429".into()));
            }
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
            state.execs.push((script.to_string(), env.clone()));
            let mut output = ExecOutput::default();
            if script == GUEST_VERSION_SCRIPT {
                output.stdout = state
                    .guest_versions
                    .get(sandbox_id)
                    .cloned()
                    .unwrap_or_default();
                // The probe also requires the installer's tools on PATH.
                if state.guest_tools_missing {
                    output.stdout.clear();
                }
            } else if script == INSTALL_SCRIPT {
                state.installs += 1;
                output.exit_code = state.install_exit_code;
                if output.exit_code == 0 {
                    state
                        .guest_versions
                        .insert(sandbox_id.to_string(), env["PA_VERSION"].clone());
                    state.guest_tools_missing = false;
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

    fn open_stream<'a>(
        &'a self,
        sandbox_id: &'a str,
        command: &'a CommandSpec,
    ) -> BoxFuture<'a, PlatformResult<ExecStreamHalves>> {
        async move {
            assert_eq!(command.args[1], super::link::RELAY_SCRIPT);
            let version = {
                let mut state = self.state();
                if state.sandbox(sandbox_id)?.status != BotStatus::Running {
                    return Err(PlatformError::Transient("gateway not ready".into()));
                }
                state
                    .guest_app_version
                    .clone()
                    .unwrap_or_else(|| crate::protocol::app_version().to_string())
            };
            let (read, mut guest_stdout) = tokio::io::duplex(4096);
            let (guest_stdin, write) = tokio::io::duplex(4096);
            let (ended_send, ended) = tokio::sync::oneshot::channel();
            if let Some(end) = self.state().relay_end.clone() {
                let _ = ended_send.send(end);
                return Ok(ExecStreamHalves { read, write, ended });
            }
            let hello = serde_json::json!({ "type": "daemon_hello", "appVersion": version });
            guest_stdout
                .write_all(format!("{hello}\n").as_bytes())
                .await
                .unwrap();
            self.state().links.push((guest_stdout, guest_stdin));
            Ok(ExecStreamHalves { read, write, ended })
        }
        .boxed()
    }

    fn credentials<'a>(
        &'a self,
        _provider: Option<&'a str>,
        github: bool,
        _reserved_hosts: usize,
    ) -> BoxFuture<'a, PlatformResult<GuestCredentials>> {
        async move {
            let mut state = self.state();
            if std::mem::take(&mut state.fail_next_credentials) {
                return Err(PlatformError::Transient("connection reset".into()));
            }
            let mut network_rules: BTreeMap<String, pa_sandbox::HeaderRule> = (0..state.key_hosts)
                .map(|n| {
                    let rule = pa_sandbox::HeaderRule {
                        headers: BTreeMap::new(),
                    };
                    (format!("key{n}.example.com"), rule)
                })
                .collect();
            if github {
                network_rules.insert(
                    "api.github.com".to_string(),
                    pa_sandbox::HeaderRule {
                        headers: BTreeMap::from([(
                            "Authorization".to_string(),
                            "Bearer ${prime.secrets.PRIME_AGENT_GITHUB_OWNER}".to_string(),
                        )]),
                    },
                );
            }
            Ok(GuestCredentials {
                network_rules,
                auth_json: None,
                mcp_servers: None,
                mcp_connections: None,
            })
        }
        .boxed()
    }

    fn owner(&self) -> &'static str {
        "OWNER"
    }

    fn put_secret<'a>(
        &'a self,
        name: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            let mut state = self.state();
            state.secret_puts += 1;
            state.secrets.insert(name.to_string(), value.to_string());
            Ok(())
        }
        .boxed()
    }

    fn set_network_rules<'a>(
        &'a self,
        sandbox_id: &'a str,
        rules: &'a BTreeMap<String, pa_sandbox::HeaderRule>,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            self.state()
                .rule_updates
                .push((sandbox_id.to_string(), rules.keys().cloned().collect()));
            Ok(())
        }
        .boxed()
    }
}

pub(crate) fn setup() -> (tempfile::TempDir, Arc<FakePlatform>, BotManager) {
    let dir = tempfile::tempdir().unwrap();
    let platform = Arc::new(FakePlatform::default());
    let manager =
        BotManager::new(dir.path(), Arc::clone(&platform) as Arc<dyn BotPlatform>).unwrap();
    (dir, platform, manager)
}

/// Write one saved session file under the agent dir's sessions root and
/// return its durable session id, as boot reconcile proves an owner.
fn saved_session(dir: &Path, name: &str) -> String {
    let sessions = crate::paths::sessions_dir(dir).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    let mut session = crate::session_store::SessionFile::create("/work", None, 0);
    session.append_session_info(name);
    session.append_message(&serde_json::json!({
        "role": "user", "content": "hi", "timestamp": 1u64
    }));
    let path = sessions.join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path);
    session.rewrite().unwrap();
    session.session_id().to_string()
}

pub(crate) fn spec(bot_id: &str) -> BotSpec {
    BotSpec {
        bot_id: bot_id.to_string(),
        name: "helper".to_string(),
        owner_session_id: "owner-1".to_string(),
        model: Some("prime-inference/model-a".to_string()),
        thinking: None,
        prompt: "hello".to_string(),
        github: false,
        git_identity: None,
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

/// A GitHub bot gets the header rules, the label, and a placeholder token
/// on every new sandbox. The stored token reaches no guest command, no
/// create request, and no registry record.
#[tokio::test(start_paused = true)]
async fn a_github_bot_gets_rules_and_a_placeholder_only() {
    let (dir, platform, manager) = setup();
    let token = "ghp_never_in_the_guest";
    super::github::store_token(dir.path(), token).unwrap();
    let github = BotSpec {
        github: true,
        git_identity: Some(BotGitIdentity {
            name: "Ada".to_string(),
            email: "ada@example.com".to_string(),
        }),
        ..spec("bot-gh")
    };
    let spawned = manager.spawn(&github).await.unwrap();
    assert!(spawned.github);
    manager.spawn(&spec("bot-plain")).await.unwrap();
    // The sandbox is lost: the new one gets the same rules.
    platform
        .delete(spawned.sandbox_id.as_deref().unwrap())
        .await
        .unwrap();
    manager.ensure_running("bot-gh").await.unwrap();

    let state = platform.state();
    let github_label = super::GITHUB_LABEL.to_string();
    let creates: Vec<(bool, bool)> = state
        .creates
        .iter()
        .map(|create| {
            (
                create.labels.contains(&github_label),
                create.network_rules.contains_key("api.github.com"),
            )
        })
        .collect();
    assert_eq!(creates, [(true, true), (false, false), (true, true)]);
    let bootstraps: Vec<&BTreeMap<String, String>> = state
        .execs
        .iter()
        .filter(|(_, env)| env.contains_key("BOT_CLIENT"))
        .map(|(_, env)| env)
        .collect();
    let gh_token: Vec<Option<&str>> = bootstraps
        .iter()
        .map(|env| env.get("GH_TOKEN").map(String::as_str))
        .collect();
    let placeholder = Some(super::credentials::GUEST_API_KEY_PLACEHOLDER);
    assert_eq!(gh_token, [placeholder, None, placeholder]);
    assert_eq!(bootstraps[0]["BOT_GIT_NAME"], "Ada");
    assert_eq!(bootstraps[0]["BOT_GIT_EMAIL"], "ada@example.com");
    let guest_inputs = format!("{:?} {:?}", state.execs, state.creates);
    assert!(!guest_inputs.contains(token));
    let registry =
        std::fs::read_to_string(super::registry::BotRegistry::path_in(dir.path())).unwrap();
    assert!(registry.contains("\"github\": true") || registry.contains("\"github\":true"));
    assert!(!registry.contains(token));
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
async fn credential_provisioning_retries_a_transport_error() {
    let (_dir, platform, manager) = setup();
    platform.state().fail_next_credentials = true;

    manager.spawn(&spec("bot-a")).await.unwrap();

    assert_eq!(platform.live().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn duplicates_are_deleted_and_lost_records_rebuilt() {
    let (dir, platform, manager) = setup();
    let owner = saved_session(dir.path(), "owner");
    let labels = vec![
        BOT_LABEL.to_string(),
        bot_label("bot-a"),
        owner_label(&owner),
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
    assert_eq!(record.owner_session_id, owner);
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

/// A labeled bot of another agent dir on the same team: its owner label
/// names a session this agent dir never held. Boot reconcile must leave it
/// alone: no adoption, no pause, no delete. The supervisor's post-reconcile
/// pause loop only walks the registry, so a bot never adopted is never
/// paused either.
#[tokio::test(start_paused = true)]
async fn boot_reconcile_leaves_a_foreign_bot_alone() {
    let (dir, platform, manager) = setup();
    let _owner = saved_session(dir.path(), "owner");
    let foreign = platform.add_sandbox(
        "chief-of-staff",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-foreign"),
            owner_label("session-of-another-agent-dir"),
        ],
    );

    manager.reconcile_on_boot().await.unwrap();

    assert!(
        manager.get("bot-foreign").is_none(),
        "a foreign bot is never adopted"
    );
    assert!(manager.list().is_empty());
    assert_eq!(platform.state().pauses, 0, "never paused");
    assert_eq!(
        platform.state().sandboxes[&foreign].status,
        BotStatus::Running
    );
    assert_eq!(platform.live().len(), 1, "its sandbox is left alive");
}

/// An older bot without an owner label is not adopted either: with no
/// owner to prove, the safe default leaves it alone.
#[tokio::test(start_paused = true)]
async fn boot_reconcile_skips_a_bot_without_an_owner_label() {
    let (dir, platform, manager) = setup();
    let _owner = saved_session(dir.path(), "owner");
    let unlabeled =
        platform.add_sandbox("helper", vec![BOT_LABEL.to_string(), bot_label("bot-old")]);

    manager.reconcile_on_boot().await.unwrap();

    assert!(manager.get("bot-old").is_none());
    assert_eq!(
        platform.state().sandboxes[&unlabeled].status,
        BotStatus::Running
    );
    assert_eq!(platform.live().len(), 1, "its sandbox is left alive");
}

/// A lost record is still rebuilt when the owner is an RLM child of this
/// agent dir: the spawn ledger proves the owner.
#[tokio::test(start_paused = true)]
async fn a_bot_of_a_spawn_ledger_child_is_adopted() {
    let (dir, platform, manager) = setup();
    let sessions = crate::paths::sessions_dir(dir.path()).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    crate::rlm_ledger::RlmSpawnLedger::new(dir.path(), &sessions, |_| {})
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "child-1".to_string(),
            parent: sessions.join("parent.jsonl").to_string_lossy().into(),
            child: sessions.join("child-1.jsonl").to_string_lossy().into(),
            depth: 1,
            name: "worker".to_string(),
            factory: None,
            decision_child: false,
        })
        .unwrap();
    platform.add_sandbox(
        "helper",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-child"),
            owner_label("child-1"),
        ],
    );

    manager.reconcile_on_boot().await.unwrap();

    assert_eq!(
        manager.get("bot-child").unwrap().owner_session_id,
        "child-1"
    );
}

#[tokio::test(start_paused = true)]
async fn errored_sandboxes_are_deleted() {
    let (_dir, platform, manager) = setup();
    let status = |id: &str| platform.state().sandboxes[id].status;
    let set_error = |id: &str| {
        platform.state().sandboxes.get_mut(id).unwrap().status = BotStatus::Error;
    };
    let spawned = manager.spawn(&spec("bot-a")).await.unwrap();
    let first = spawned.sandbox_id.unwrap();
    set_error(&first);

    manager.ensure_running("bot-a").await.unwrap();
    assert_eq!(status(&first), BotStatus::Stopped);

    // An errored sandbox the record does not track goes with the bot too.
    let untracked = platform.add_sandbox("helper", vec![bot_label("bot-a")]);
    set_error(&untracked);
    manager.delete("bot-a").await.unwrap();
    assert_eq!(status(&untracked), BotStatus::Stopped);
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
async fn a_failed_install_fails_spawn_and_cleans_up() {
    for exit_code in [version::UNPUBLISHED_EXIT_CODE, version::NO_GUEST_EXIT_CODE] {
        let (_dir, platform, manager) = setup();
        platform.state().install_exit_code = exit_code;

        let error = manager.spawn(&spec("bot-a")).await.expect_err("refused");

        assert_eq!(
            error.to_string(),
            version::install_failure(exit_code, version::local_version()).unwrap()
        );
        assert!(platform.live().is_empty());
        assert!(manager.list().is_empty());
    }
}

/// A local tarball that appears only after the manager was created is
/// used: the release source is resolved at install time, not cached.
#[tokio::test(start_paused = true)]
async fn a_tarball_placed_after_manager_creation_is_used() {
    let (dir, platform, manager) = setup();
    let bytes = b"not really a tarball".to_vec();
    let tarball = dir.path().join("bot.tar.gz");
    std::fs::write(&tarball, &bytes).unwrap();
    let _env = crate::test_support::KernelEnvOverride::apply(&[(
        version::TARBALL_OVERRIDE_ENV,
        Some(tarball.display().to_string()),
    )]);

    manager.spawn(&spec("bot-tarball")).await.unwrap();

    assert_eq!(platform.state().installs, 1);
    let (_, install) = platform
        .state()
        .execs
        .iter()
        .find(|(script, _)| script.as_str() == INSTALL_SCRIPT)
        .cloned()
        .expect("an install ran");
    assert_eq!(install["PA_TARBALL_BYTES"], bytes.len().to_string());
    assert_eq!(install["PA_TARBALL_SHA256"], super::sha256_hex(&bytes));
}

#[tokio::test(start_paused = true)]
async fn a_full_checkpoint_storage_keeps_the_bot_running() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    platform.state().checkpoint_storage_full = true;

    let error = manager.pause("bot-a").await.expect_err("refused");

    assert!(matches!(
        error.downcast_ref::<PlatformError>(),
        Some(PlatformError::CheckpointQuota(_))
    ));
    assert_eq!(platform.state().pauses, 1);
    assert_eq!(platform.live().len(), 1);
    assert_eq!(manager.get("bot-a").unwrap().status, BotStatus::Running);
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

/// The bootstrap environment of the last guest command that ran it.
fn last_bootstrap_env(platform: &FakePlatform) -> BTreeMap<String, String> {
    platform
        .state()
        .execs
        .iter()
        .rev()
        .find(|(_, env)| env.contains_key("BOT_CLIENT"))
        .map(|(_, env)| env.clone())
        .expect("a bootstrap ran")
}

/// A bot whose guest has this build's prime-agent but lost the
/// installer's tools (a half-failed install) gets the installer rerun on
/// its next wake: the version probe reports nothing while a tool is
/// missing, so the bot never boots without Node.js or `gh`.
#[tokio::test(start_paused = true)]
async fn a_missing_guest_tool_reruns_the_installer() {
    let (dir, platform, manager) = setup();
    // The bot's sandbox survived a lost registry: labels rebuild the
    // record; the guest runs the right prime-agent, but no node.
    let owner = saved_session(dir.path(), "owner");
    let sandbox = platform.add_sandbox(
        "helper",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-a"),
            owner_label(&owner),
        ],
    );
    platform
        .state()
        .guest_versions
        .insert(sandbox.clone(), version::local_version().to_string());
    platform.state().guest_tools_missing = true;

    manager.reconcile_on_boot().await.unwrap();
    let running = manager.ensure_running("bot-a").await.unwrap();

    assert_eq!(running.status, BotStatus::Running);
    assert_eq!(running.sandbox_id.as_deref(), Some(sandbox.as_str()));
    // The probe saw the missing tool, so the idempotent installer ran.
    assert_eq!(platform.state().installs, 1);
    assert!(!platform.state().guest_tools_missing);
}

/// A record rebuilt from labels carries no git author: the bootstrap falls
/// back to the owner's (`bots.gitIdentity`), so a cold boot still commits
/// as the owner, and the recovered identity lands on the record.
#[tokio::test(start_paused = true)]
async fn a_rebuilt_record_keeps_the_git_author() {
    let (dir, platform, manager) = setup();
    std::fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({
            "bots": { "gitIdentity": { "name": "Ada", "email": "ada@example.com" } }
        })
        .to_string(),
    )
    .unwrap();
    let owner = saved_session(dir.path(), "owner");
    platform.add_sandbox(
        "helper",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-a"),
            owner_label(&owner),
        ],
    );

    manager.reconcile_on_boot().await.unwrap();
    assert_eq!(manager.get("bot-a").unwrap().git_identity, None);

    manager.ensure_running("bot-a").await.unwrap();

    let env = last_bootstrap_env(&platform);
    assert_eq!(env["BOT_GIT_NAME"], "Ada");
    assert_eq!(env["BOT_GIT_EMAIL"], "ada@example.com");
    assert_eq!(
        manager.get("bot-a").unwrap().git_identity,
        Some(BotGitIdentity {
            name: "Ada".to_string(),
            email: "ada@example.com".to_string(),
        })
    );
}

/// The owner's `factory.enabled` rides the bootstrap environment into the
/// guest's settings: `false` without the setting, `true` with it.
#[tokio::test(start_paused = true)]
async fn the_bootstrap_carries_the_owner_factory_setting() {
    let (dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    assert_eq!(
        last_bootstrap_env(&platform)["BOT_FACTORY_ENABLED"],
        "false"
    );

    std::fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({ "factory": { "enabled": true } }).to_string(),
    )
    .unwrap();
    manager.spawn(&spec("bot-b")).await.unwrap();
    assert_eq!(last_bootstrap_env(&platform)["BOT_FACTORY_ENABLED"], "true");
}

/// The bootstrap's settings write waits for the guest settings lock: a
/// write that lands while the script waits survives the merge (the script
/// reads under the lock, then atomically replaces), instead of being
/// overwritten by the script's stale snapshot. The MCP-connection record
/// write takes the same lock for its own file.
#[tokio::test]
async fn the_bootstrap_settings_write_waits_for_the_guest_lock() {
    let home = tempfile::tempdir().unwrap();
    let agent = home.path().join(".prime").join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    let settings = agent.join("settings.json");
    std::fs::write(&settings, r#"{"existing": "kept"}"#).unwrap();
    // The guest daemon holds the settings lock.
    let lock = agent.join("settings.json.lock");
    std::fs::create_dir(&lock).unwrap();
    let mut script = std::process::Command::new("python3")
        .arg("-c")
        .arg(super::manager::GUEST_SETTINGS_PY)
        .env("HOME", home.path())
        .env("BOT_FACTORY_ENABLED", "true")
        .env_remove("BOT_MCP_SERVERS")
        .env(
            "BOT_MCP_CONNECTIONS",
            r#"{"linear-2": {"url": "https://x"}}"#,
        )
        .spawn()
        .expect("python3");
    // While the script waits, the daemon writes new settings.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(
        !std::fs::read_to_string(&settings)
            .unwrap()
            .contains("factory"),
        "the locked write must not have landed yet"
    );
    std::fs::write(
        &settings,
        r#"{"existing": "kept", "writer": "guest-daemon"}"#,
    )
    .unwrap();
    std::fs::remove_dir(&lock).unwrap();
    assert!(script.wait().expect("python3 exits").success());
    let merged: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(merged["writer"], "guest-daemon");
    assert_eq!(merged["existing"], "kept");
    assert_eq!(merged["factory"]["enabled"], true);
    let connections: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(agent.join("mcp-connections.json")).unwrap())
            .unwrap();
    assert_eq!(connections["connections"]["linear-2"]["url"], "https://x");
}

/// What [`live_ask`] returns for a turn that ended without an answer.
const NO_ANSWER: &str = "<no answer>";

/// Send `task` to a live bot and wait up to 3 minutes for its reply.
async fn live_ask(
    manager: &BotManager,
    agent_dir: &std::path::Path,
    bot: &super::BotRecord,
    msg_id: &str,
    task: &str,
) -> anyhow::Result<String> {
    let ledger = super::ledger::BotLedger::new(agent_dir, &bot.bot_id);
    let mut guest = super::guest::GuestClient::connect(manager, bot).await?;
    super::send::send_message(
        &ledger,
        &mut guest,
        &bot.guest_session_id,
        msg_id,
        task,
        None,
    )
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut reply = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
    while reply.is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::timeout_at(
            deadline,
            super::replies::sync_deliveries(
                &mut guest,
                &ledger,
                &bot.guest_session_id,
                || Some(NO_ANSWER.to_string()),
                |text| {
                    reply = text;
                    async { anyhow::Ok(()) }
                },
            ),
        )
        .await??;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Ok(reply)
}

/// Live: a GitHub bot on this build clones a private repository, commits
/// as the owner, pushes a branch, opens and closes a draft PR, and deletes
/// the branch; the token is nowhere in the guest. Needs what the live test
/// above needs, plus `PRIME_AGENT_LIVE_GITHUB_TOKEN` (a token that can push
/// to the repository) and `PRIME_AGENT_LIVE_GITHUB_REPO` (`owner/name`):
/// `cargo test -p pa-daemon --lib bots::tests::github_live -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "creates a real Prime sandbox and a GitHub branch"]
async fn github_live_push_and_draft_pr() {
    let token = std::env::var("PRIME_AGENT_LIVE_GITHUB_TOKEN").expect("a GitHub token");
    let repo = std::env::var("PRIME_AGENT_LIVE_GITHUB_REPO").expect("owner/name");
    let api_key = std::env::var("PRIME_API_KEY").expect("PRIME_API_KEY");
    let new_client = || {
        pa_sandbox::PrimeSandboxClient::new(
            &api_key,
            pa_sandbox::ClientOptions {
                base_url: pa_sandbox::DEFAULT_BASE_URL.to_string(),
                team_id: std::env::var("PRIME_TEAM_ID").ok(),
                request_timeout: None,
                allow_insecure_localhost: false,
            },
        )
        .unwrap()
    };
    let client = new_client();
    let dir = tempfile::tempdir().unwrap();
    super::github::store_token(dir.path(), &token).unwrap();
    // A per-run owner: the test's GitHub secrets never touch the secret
    // namespace real bots on this account use.
    let owner = format!(
        "{}-LIVE-{}",
        super::github::owner_fingerprint(&api_key),
        uuid::Uuid::new_v4().simple().to_string()[..12].to_ascii_uppercase()
    );
    let platform = Arc::new(super::platform::PrimePlatform::new(
        client,
        dir.path(),
        owner.clone(),
    ));
    let manager =
        BotManager::new(dir.path(), Arc::clone(&platform) as Arc<dyn BotPlatform>).unwrap();
    let bot_id = format!("live-gh-{}", uuid::Uuid::new_v4());
    let spec = BotSpec {
        model: Some("prime-inference/anthropic/claude-haiku-4.5".to_string()),
        github: true,
        git_identity: Some(BotGitIdentity {
            name: "Prime Agent Live".to_string(),
            email: "live@example.com".to_string(),
        }),
        ..spec(&bot_id)
    };
    let branch = format!("bot-live-{}", &bot_id[8..16]);
    let script = r#"set -euo pipefail
cd "$(mktemp -d)"
[ -f "$HOME/.prime-agent-ca.pem" ] && export SSL_CERT_FILE="$HOME/.prime-agent-ca.pem"
git clone -q "https://github.com/$REPO" repo && cd repo
git checkout -q -b "$BRANCH"
git commit -q --allow-empty -m "bot live test"
git log -1 --format='AUTHOR=%an <%ae>'
git push -q origin "$BRANCH"
url="$(gh pr create -R "$REPO" --draft --head "$BRANCH" --title "bot live test" --body "Closed by the test.")"
echo "PR=$url"
gh pr close -R "$REPO" "$url" --delete-branch
echo CLOSED
cat "$HOME/.gitconfig" "$HOME/.prime-agent-git-credential"
"#;
    let run = async {
        let bot = manager.spawn(&spec).await?;
        let env = BTreeMap::from([
            ("REPO".to_string(), repo.clone()),
            ("BRANCH".to_string(), branch.clone()),
            (
                "GH_TOKEN".to_string(),
                super::credentials::GUEST_API_KEY_PLACEHOLDER.to_string(),
            ),
        ]);
        let output = platform
            .exec(bot.sandbox_id.as_deref().unwrap(), script, &env, None)
            .await?;
        anyhow::Ok((bot, output))
    }
    .await;
    manager.delete(&bot_id).await.unwrap();
    let [token_secret, basic_secret] = super::github::secret_names(&owner);
    for secret in new_client().list_secrets().await.unwrap() {
        if secret.name == token_secret || secret.name == basic_secret {
            new_client().delete_secret(&secret.id).await.unwrap();
        }
    }
    let (bot, output) = run.unwrap();
    eprintln!(
        "live github: exit={} stdout={}\nstderr={}",
        output.exit_code, output.stdout, output.stderr
    );
    assert!(bot.github);
    assert_eq!(output.exit_code, 0);
    assert!(output
        .stdout
        .contains("AUTHOR=Prime Agent Live <live@example.com>"));
    assert!(output.stdout.contains("PR=https://github.com/"));
    assert!(output.stdout.contains("CLOSED"));
    assert!(!output.stdout.contains(&token) && !output.stderr.contains(&token));
}

/// A [`super::platform::PrimePlatform`] whose Prime Inference rule names a
/// throwaway secret, so a live test can change the secret's value without
/// touching the secrets other bots use.
struct ThrowawaySecret {
    inner: Arc<super::platform::PrimePlatform>,
    secret: String,
}

impl BotPlatform for ThrowawaySecret {
    fn create<'a>(&'a self, request: &'a BotCreate) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        self.inner.create(request)
    }
    fn get<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        self.inner.get(sandbox_id)
    }
    fn list<'a>(&'a self, label: &'a str) -> BoxFuture<'a, PlatformResult<Vec<BotSandbox>>> {
        self.inner.list(label)
    }
    fn delete<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.delete(sandbox_id)
    }
    fn pause<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<Option<String>>> {
        self.inner.pause(sandbox_id)
    }
    fn resume<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        self.inner.resume(sandbox_id)
    }
    fn checkpoint<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<String>> {
        self.inner.checkpoint(sandbox_id)
    }
    fn wait_checkpoint<'a>(&'a self, checkpoint_id: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.wait_checkpoint(checkpoint_id)
    }
    fn checkpoint_durable<'a>(
        &'a self,
        checkpoint_id: &'a str,
    ) -> BoxFuture<'a, PlatformResult<bool>> {
        self.inner.checkpoint_durable(checkpoint_id)
    }
    fn delete_checkpoint<'a>(
        &'a self,
        checkpoint_id: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.delete_checkpoint(checkpoint_id)
    }
    fn exec<'a>(
        &'a self,
        sandbox_id: &'a str,
        script: &'a str,
        env: &'a BTreeMap<String, String>,
        stdin: Option<&'a [u8]>,
    ) -> BoxFuture<'a, PlatformResult<ExecOutput>> {
        self.inner.exec(sandbox_id, script, env, stdin)
    }
    fn open_stream<'a>(
        &'a self,
        sandbox_id: &'a str,
        command: &'a CommandSpec,
    ) -> BoxFuture<'a, PlatformResult<ExecStreamHalves>> {
        self.inner.open_stream(sandbox_id, command)
    }
    fn credentials<'a>(
        &'a self,
        provider: Option<&'a str>,
        github: bool,
        reserved_hosts: usize,
    ) -> BoxFuture<'a, PlatformResult<GuestCredentials>> {
        async move {
            let mut credentials = self
                .inner
                .credentials(provider, github, reserved_hosts)
                .await?;
            let rule = credentials
                .network_rules
                .get_mut("api.pinference.ai")
                .expect("a Prime Inference rule");
            rule.headers.insert(
                "Authorization".to_string(),
                format!("Bearer ${{prime.secrets.{}}}", self.secret),
            );
            Ok(credentials)
        }
        .boxed()
    }
    fn owner(&self) -> &str {
        self.inner.owner()
    }
    fn put_secret<'a>(
        &'a self,
        name: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.put_secret(name, value)
    }
    fn set_network_rules<'a>(
        &'a self,
        sandbox_id: &'a str,
        rules: &'a BTreeMap<String, pa_sandbox::HeaderRule>,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.set_network_rules(sandbox_id, rules)
    }
}

/// Ask a live bot for `pong` until it answers (`want_answer`) or a turn
/// fails (not `want_answer`); the platform applies a secret update within
/// 60 s.
async fn ask_until(
    manager: &BotManager,
    agent_dir: &std::path::Path,
    bot: &super::BotRecord,
    asked: &mut u32,
    want_answer: bool,
) -> anyhow::Result<String> {
    let task = "Reply with the single word pong and nothing else.";
    for _ in 0..12 {
        *asked += 1;
        let reply = live_ask(manager, agent_dir, bot, &format!("m{asked}"), task).await?;
        eprintln!("live update: reply {asked}: {reply:?}");
        if reply.to_lowercase().contains("pong") == want_answer {
            return Ok(reply);
        }
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
    anyhow::bail!("the bot never switched to answered={want_answer}")
}

/// Live: a secret update reaches a running bot without a restart. A bot on
/// Prime Inference whose rule names a throwaway secret answers; the secret
/// is set to a bad key, so a turn fails; the good key is put back through
/// the same update path, and the same bot answers again. Needs what the
/// live test below needs:
/// `cargo test -p pa-daemon --lib bots::tests::live_secret_update -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "creates a real Prime sandbox and a Prime secret"]
async fn live_secret_update_reaches_a_running_bot() {
    let api_key = std::env::var("PRIME_API_KEY").expect("PRIME_API_KEY");
    let new_client = || {
        pa_sandbox::PrimeSandboxClient::new(
            &api_key,
            pa_sandbox::ClientOptions {
                base_url: pa_sandbox::DEFAULT_BASE_URL.to_string(),
                team_id: std::env::var("PRIME_TEAM_ID").ok(),
                request_timeout: None,
                allow_insecure_localhost: false,
            },
        )
        .unwrap()
    };
    let dir = tempfile::tempdir().unwrap();
    let secret = format!(
        "PRIME_AGENT_LIVE_UPDATE_{}",
        uuid::Uuid::new_v4().simple().to_string()[..12].to_ascii_uppercase()
    );
    let platform = Arc::new(ThrowawaySecret {
        inner: Arc::new(super::platform::PrimePlatform::new(
            new_client(),
            dir.path(),
            "LIVE".to_string(),
        )),
        secret: secret.clone(),
    });
    let manager =
        BotManager::new(dir.path(), Arc::clone(&platform) as Arc<dyn BotPlatform>).unwrap();
    let bot_id = format!("live-upd-{}", uuid::Uuid::new_v4());
    let spec = BotSpec {
        model: Some("prime-inference/anthropic/claude-haiku-4.5".to_string()),
        ..spec(&bot_id)
    };
    let started = std::time::Instant::now();
    let step = |name: &str| {
        eprintln!("live update: {name} at {}s", started.elapsed().as_secs());
    };
    let mut asked = 0;
    let run = async {
        platform.put_secret(&secret, &api_key).await?;
        let bot = manager.spawn(&spec).await?;
        step("spawned");
        let first = ask_until(&manager, dir.path(), &bot, &mut asked, true).await?;
        step("first answer");
        platform.put_secret(&secret, "bad-key").await?;
        step("secret set to a bad key");
        let failed = ask_until(&manager, dir.path(), &bot, &mut asked, false).await?;
        step("turn failed");
        platform.put_secret(&secret, &api_key).await?;
        step("good key put back");
        let again = ask_until(&manager, dir.path(), &bot, &mut asked, true).await?;
        step("answer again");
        let same = manager.get(&bot_id).unwrap();
        anyhow::Ok((bot, first, failed, again, same))
    }
    .await;
    manager.delete(&bot_id).await.unwrap();
    let client = new_client();
    for listed in client.list_secrets().await.unwrap() {
        if listed.name == secret {
            client.delete_secret(&listed.id).await.unwrap();
        }
    }
    step("deleted");
    let (bot, first, failed, again, same) = run.unwrap();
    assert!(first.to_lowercase().contains("pong"));
    assert!(!failed.to_lowercase().contains("pong"));
    assert!(again.to_lowercase().contains("pong"));
    // No restart: the same sandbox and guest session served every turn.
    assert_eq!(same.sandbox_id, bot.sandbox_id);
    assert_eq!(same.guest_session_id, bot.guest_session_id);
}

/// Live: one real bot on this build through spawn, a task and its reply,
/// pause, a second task that resumes it in the same session, a third that
/// runs node, npm, and `uv pip install` in its shell, and delete.
/// Run in a linux-x64 checkout after `make bot-tarball`, with
/// `PRIME_API_KEY` (and `PRIME_TEAM_ID`) set and
/// `PRIME_AGENT_BOT_TARBALL=target/release/prime-agent-<version>-linux-x64.tar.gz`:
/// `cargo test -p pa-daemon --lib bots::tests::live -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "creates a real Prime sandbox"]
async fn live_spawn_reply_pause_resume_delete() {
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
    assert!(
        matches!(
            version::ReleaseSource::resolve(),
            version::ReleaseSource::LocalTarball(_)
        ),
        "set {} to a tarball of this build",
        version::TARBALL_OVERRIDE_ENV
    );
    let dir = tempfile::tempdir().unwrap();
    let platform = Arc::new(super::platform::PrimePlatform::new(
        client,
        dir.path(),
        "LIVE".to_string(),
    ));
    let manager =
        BotManager::new(dir.path(), Arc::clone(&platform) as Arc<dyn BotPlatform>).unwrap();
    let bot_id = format!("live-{}", uuid::Uuid::new_v4());
    let spec = BotSpec {
        model: Some("prime-inference/anthropic/claude-haiku-4.5".to_string()),
        ..spec(&bot_id)
    };
    let started = std::time::Instant::now();
    let step = |name: &str| eprintln!("live: {name} at {}s", started.elapsed().as_secs());

    let run = async {
        let spawned = manager.spawn(&spec).await?;
        step("spawned");
        let task = "Reply with the single word pong and nothing else.";
        let first = live_ask(&manager, dir.path(), &spawned, "m1", task).await?;
        step("first reply");
        let paused = manager.pause(&bot_id).await?;
        step("paused");
        let resumed = manager.ensure_running(&bot_id).await?;
        step("resumed");
        let task = "Repeat the word you replied with before, in capital letters only.";
        let second = live_ask(&manager, dir.path(), &resumed, "m2", task).await?;
        step("second reply");
        let task = "Run each shell command with bash() and await it: `node --version`, \
                    `npm --version`, `uv pip install six`. Reply with one line only: \
                    NODE=<node output> NPM=<npm output> UV=<uv pip exit code>";
        let tools = live_ask(&manager, dir.path(), &resumed, "m3", task).await?;
        step("tools reply");
        anyhow::Ok((spawned, first, paused, resumed, second, tools))
    }
    .await;
    manager.delete(&bot_id).await.unwrap();
    step("deleted");
    let (spawned, first, paused, resumed, second, tools) = run.unwrap();
    let left = platform.list(&bot_label(&bot_id)).await.unwrap();

    eprintln!("live: spawned={spawned:?}\npaused={paused:?}");
    eprintln!("live: first={first:?} second={second:?} tools={tools:?} left={left:?}");
    assert_eq!(spawned.version, version::local_version());
    assert!(first.to_lowercase().contains("pong"), "first: {first:?}");
    assert!(matches!(
        paused.status,
        BotStatus::Paused | BotStatus::Stopped
    ));
    assert!(paused.checkpoint_id.is_some());
    assert_eq!(resumed.guest_session_file, spawned.guest_session_file);
    assert!(second.contains("PONG"), "second: {second:?}");
    assert!(tools.contains("NODE=v22.23.5"), "tools: {tools:?}");
    assert!(tools.contains("UV=0"), "tools: {tools:?}");
    assert!(left.iter().all(|sandbox| sandbox.status.is_terminal()));
    let checkpoint = paused.checkpoint_id.as_deref().unwrap();
    assert!(!platform.checkpoint_durable(checkpoint).await.unwrap());
}
#[tokio::test]
async fn a_rules_refresh_reaches_running_and_paused_bots_only() {
    let (_dir, platform, manager) = setup();
    let running = manager.spawn(&spec("bot-a")).await.unwrap();
    let paused = manager.spawn(&spec("bot-b")).await.unwrap();
    manager.pause("bot-b").await.unwrap();
    manager.spawn(&spec("bot-c")).await.unwrap();
    manager.delete("bot-c").await.unwrap();

    assert!(manager.refresh_network_rules().await.is_empty());
    let mut updated: Vec<String> = platform
        .state()
        .rule_updates
        .iter()
        .map(|(sandbox, _)| sandbox.clone())
        .collect();
    updated.sort();
    let mut expected = vec![running.sandbox_id.unwrap(), paused.sandbox_id.unwrap()];
    expected.sort();
    assert_eq!(updated, expected);
}

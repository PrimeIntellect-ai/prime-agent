//! Fake-platform tests of the bot lifecycle (after prime-orbs `test_dispatcher.py`).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use futures::FutureExt;

use pa_core::settings::BotGitIdentity;
use pa_sandbox::CommandSpec;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::exec_stream::ExecStreamHalves;
use super::manager::ALLOW_SPAWNS_SCRIPT;
use super::platform::{
    BotCheckpoint, BotCreate, BotPlatform, BotSandbox, ExecOutput, GuestCredentials, PlatformError,
    PlatformResult,
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
    pub credential_calls: usize,
    pub refuse_pause: bool,
    /// Pauses answer that the team's checkpoint storage is full.
    pub checkpoint_storage_full: bool,
    pub pauses: usize,
    /// New pause checkpoints stay pending (not durable).
    pub pause_checkpoints_pending: bool,
    /// Checkpoints that exist but are not durable yet.
    pub pending_checkpoints: std::collections::HashSet<String>,
    /// Each checkpoint's sandbox and creation stamp, as the platform's
    /// checkpoint list reports them.
    pub checkpoint_origins: HashMap<String, (String, String)>,
    /// The checkpoint list fails with a transport error.
    pub fail_checkpoint_list: bool,
    /// A create restoring this checkpoint fails without a retry.
    pub fail_create_from: Option<String>,
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
    /// Every transfer-endpoint upload: sandbox, guest path, byte count.
    pub uploads: Vec<(String, String, usize)>,
    /// The transfer endpoint fails (the install falls back to the exec stream).
    pub upload_fails: bool,
    /// API-key rule hosts each credentials request returns.
    pub key_hosts: usize,
    /// Platform secrets by name, and how many puts ran.
    pub secrets: BTreeMap<String, String>,
    pub secret_puts: usize,
    /// Each network rules update: the sandbox and its rule hosts.
    pub rule_updates: Vec<(String, Vec<String>)>,
    /// The platform secrets at each resume.
    pub secrets_at_resume: Vec<BTreeMap<String, String>>,
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

    /// A checkpoint an outside caller (the relay's self-pause) freezes on
    /// the sandbox: on the platform, never in this daemon's registry.
    pub fn external_checkpoint(&self, sandbox_id: &str, durable: bool) -> String {
        let mut state = self.state();
        let id = state.new_id("ckpt");
        let version = state
            .guest_versions
            .get(sandbox_id)
            .cloned()
            .unwrap_or_default();
        state.checkpoints.insert(id.clone(), version);
        let origin = (sandbox_id.to_string(), state.stamp());
        state.checkpoint_origins.insert(id.clone(), origin);
        if !durable {
            state.pending_checkpoints.insert(id.clone());
        }
        id
    }

    /// [`Self::external_checkpoint`] with an explicit creation stamp.
    pub fn external_checkpoint_at(
        &self,
        sandbox_id: &str,
        durable: bool,
        created_at: &str,
    ) -> String {
        let mut state = self.state();
        let id = state.new_id("ckpt");
        let version = state
            .guest_versions
            .get(sandbox_id)
            .cloned()
            .unwrap_or_default();
        state.checkpoints.insert(id.clone(), version);
        let origin = (sandbox_id.to_string(), created_at.to_string());
        state.checkpoint_origins.insert(id.clone(), origin);
        if !durable {
            state.pending_checkpoints.insert(id.clone());
        }
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

    /// A creation stamp for the record `new_id` just numbered; later
    /// stamps compare greater, like the platform's `created_at`.
    fn stamp(&self) -> String {
        format!("2026-11-23T00:{:02}:{:02}Z", self.next / 60, self.next % 60)
    }
}

impl BotPlatform for FakePlatform {
    fn create<'a>(&'a self, request: &'a BotCreate) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        async move {
            let existing = self.state().keys.get(&request.idempotency_key).cloned();
            if let Some(id) = existing {
                return Ok(self.state().sandboxes[&id].clone());
            }
            if let Some(checkpoint) = &self.state().fail_create_from {
                if request.checkpoint_id.as_deref() == Some(checkpoint.as_str()) {
                    return Err(PlatformError::Other("the restore was refused".into()));
                }
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
            let origin = (sandbox_id.to_string(), state.stamp());
            state.checkpoint_origins.insert(checkpoint.clone(), origin);
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
            let secrets = state.secrets.clone();
            state.secrets_at_resume.push(secrets);
            let sandbox = state.sandbox(sandbox_id)?;
            sandbox.status = BotStatus::Running;
            Ok(sandbox.clone())
        }
        .boxed()
    }

    fn list_checkpoints<'a>(
        &'a self,
        label: &'a str,
    ) -> BoxFuture<'a, PlatformResult<Vec<BotCheckpoint>>> {
        async move {
            let state = self.state();
            if state.fail_checkpoint_list {
                return Err(PlatformError::Transient("checkpoint list is down".into()));
            }
            let mut listed: Vec<BotCheckpoint> = state
                .checkpoint_origins
                .iter()
                .filter(|(id, (sandbox_id, _))| {
                    state.checkpoints.contains_key(*id)
                        && state
                            .sandboxes
                            .get(sandbox_id)
                            .is_some_and(|sandbox| sandbox.labels.iter().any(|have| have == label))
                })
                .map(|(id, (_, created_at))| BotCheckpoint {
                    id: id.clone(),
                    durable: !state.pending_checkpoints.contains(id),
                    created_at: created_at.clone(),
                })
                .collect();
            listed.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            Ok(listed)
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
            let origin = (sandbox_id.to_string(), state.stamp());
            state.checkpoint_origins.insert(checkpoint.clone(), origin);
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
            let mut state = self.state();
            state.checkpoints.remove(checkpoint_id);
            state.checkpoint_origins.remove(checkpoint_id);
            state.pending_checkpoints.remove(checkpoint_id);
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
            } else if script == ALLOW_SPAWNS_SCRIPT {
                // The nested-spawn settings write: it succeeds.
            } else if script == version::TARBALL_CHECK_SCRIPT {
                // The guest's tarball copy is present.
            } else if script == version::TARBALL_RESTORE_SCRIPT {
                state.installs += 1;
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

    fn upload<'a>(
        &'a self,
        sandbox_id: &'a str,
        path: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            let mut state = self.state();
            state
                .uploads
                .push((sandbox_id.to_string(), path.to_string(), bytes.len()));
            if state.upload_fails {
                return Err(PlatformError::Transient("upload refused".into()));
            }
            Ok(())
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
            state.credential_calls += 1;
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
        _description: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            let mut state = self.state();
            state.secret_puts += 1;
            state.secrets.insert(name.to_string(), value.to_string());
            Ok(())
        }
        .boxed()
    }

    fn delete_secret<'a>(&'a self, name: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            self.state().secrets.remove(name);
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
        bots: false,
    }
}

/// A relay-configured spawn: the bot's sandbox gets a header rule for
/// the relay host only (never the Prime API host), the platform secret
/// holds its pause token, the bootstrap carries the self-pause
/// configuration, and the relay registration carries the sandbox id.
#[tokio::test]
async fn a_relay_configured_spawn_arms_the_guest_self_pause() {
    let (dir, platform, manager) = setup();
    // The stub relay: it answers the registration and records it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let relay = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        // Read until the full request (headers plus the content length)
        // arrived, then answer.
        loop {
            let read = socket.read(&mut chunk).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = find_header_end(&buffer) {
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
        let _ = socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await;
        buffer
    });
    std::fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({
            "bots": {
                "relay": {
                    "url": format!("http://{address}"),
                    "token": "relay-owner-token",
                },
                "selfPauseMinutes": 3,
            }
        })
        .to_string(),
    )
    .unwrap();

    let spawned = manager.spawn(&spec("bot-relay")).await.unwrap();
    let sandbox_id = spawned.sandbox_id.clone().unwrap();
    let bot_id = spawned.bot_id.clone();
    let token = spawned.pause_token.clone().unwrap();

    // The rule set: the relay's host only, and never the Prime API host.
    // (A clone: a borrow of the fake's state would hold its lock for the
    // rest of the test and deadlock the reads below.)
    let create = platform.state().creates[0].clone();
    let host = address.ip().to_string();
    assert!(create.network_rules.contains_key(&host), "relay rule host");
    assert!(
        !create.network_rules.contains_key("api.primeintellect.ai"),
        "no Prime API rule"
    );
    let rule = &create.network_rules[&host];
    let value = rule.headers["Authorization"].clone();
    assert!(value.starts_with("Bearer ${prime.secrets.PRIME_AGENT_BOT_PAUSE_"));
    assert!(value.ends_with('}'));

    // The platform secret holds the pause token, keyed by the bot id.
    let name = format!(
        "PRIME_AGENT_BOT_PAUSE_{}",
        super::credentials::key_fingerprint(&bot_id)
    );
    assert_eq!(platform.state().secrets[&name], token);

    // The bootstrap env arms the guest's self-pause.
    let bootstrap = platform
        .state()
        .execs
        .iter()
        .find(|(script, _)| script.contains("prime-agent --mode daemon"))
        .map(|(_, env)| env.clone())
        .expect("the bootstrap ran");
    assert_eq!(
        bootstrap.get("PRIME_AGENT_BOT_ID").map(String::as_str),
        Some(bot_id.as_str())
    );
    assert_eq!(
        bootstrap
            .get("PRIME_AGENT_BOT_SANDBOX_ID")
            .map(String::as_str),
        Some(sandbox_id.as_str())
    );
    assert_eq!(
        bootstrap
            .get("PRIME_AGENT_BOT_SELF_PAUSE")
            .map(String::as_str),
        Some(super::GUEST_SELF_PAUSE_FILE)
    );
    assert_eq!(
        bootstrap.get("BOT_RELAY_URL").map(String::as_str),
        Some(format!("http://{address}").as_str())
    );
    assert_eq!(
        bootstrap.get("BOT_SELF_PAUSE_URL").map(String::as_str),
        Some(format!("http://{address}/api/bots/{bot_id}/pause").as_str())
    );
    assert_eq!(
        bootstrap.get("BOT_SELF_PAUSE_MINUTES").map(String::as_str),
        Some("3")
    );
    let bootstrap_script = platform
        .state()
        .execs
        .iter()
        .find(|(script, _)| script.contains("PRIME_AGENT_BOT_SELF_PAUSE"))
        .map(|(script, _)| script.clone())
        .expect("the self-pause writer ran");
    assert!(
        bootstrap_script.contains("\"relayUrl\""),
        "the guest configuration carries the relay URL"
    );

    // The registration reached the relay with the sandbox id and token.
    let registered = tokio::time::timeout(std::time::Duration::from_secs(5), relay)
        .await
        .unwrap()
        .unwrap();
    let request = String::from_utf8(registered).unwrap();
    assert!(
        request.starts_with(&format!("PUT /api/bots/{bot_id} ")),
        "the relay registration path: {request}"
    );
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer relay-owner-token"));
    let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(body.trim_end()).unwrap();
    assert_eq!(body["sandboxId"], serde_json::json!(sandbox_id));
    assert_eq!(body["pauseToken"], serde_json::json!(token));
}

/// A relay that records every request and answers 200 until aborted.
async fn relay_recorder() -> (
    std::net::SocketAddr,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let request = read_request(&mut socket).await;
            recorded
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request).to_string());
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await;
        }
    });
    (address, requests, task)
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
        if let Some(header_end) = find_header_end(&buffer) {
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

/// Deleting a bot drops its relay registration and wake-up schedules, so a
/// paused bot can never fire after the owner deleted it.
#[tokio::test]
async fn deleting_a_bot_clears_its_relay_wakeups() {
    let (dir, _platform, manager) = setup();
    let (address, requests, relay) = relay_recorder().await;
    std::fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({
            "bots": {
                "relay": {
                    "url": format!("http://{address}"),
                    "token": "relay-owner-token",
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let spawned = manager.spawn(&spec("bot-relay-delete")).await.unwrap();
    let bot_id = spawned.bot_id.clone();

    // Wait for the wake-time registration.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while requests.lock().unwrap().is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let first = requests
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("the registration arrived");
    assert!(
        first.starts_with(&format!("PUT /api/bots/{bot_id} ")),
        "the registration ran first: {first}"
    );

    manager.delete(&bot_id).await.unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while requests.lock().unwrap().len() < 2 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let rows = requests.lock().unwrap().clone();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(
        rows[1].starts_with(&format!("DELETE /api/bots/{bot_id} ")),
        "the delete path: {}",
        rows[1]
    );
    assert!(rows[1]
        .to_ascii_lowercase()
        .contains("authorization: bearer relay-owner-token"));
    relay.abort();
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// A bot the guest paused by itself: the daemon's own pause is a no-op
/// (no second platform pause), and a wake resumes it.
#[tokio::test(start_paused = true)]
async fn a_bot_paused_by_the_guest_needs_no_second_pause() {
    let (_dir, platform, manager) = setup();
    let spawned = manager.spawn(&spec("bot-guest-paused")).await.unwrap();
    let sandbox_id = spawned.sandbox_id.clone().unwrap();
    // The guest paused it while the owner was offline.
    platform
        .state()
        .sandboxes
        .get_mut(&sandbox_id)
        .unwrap()
        .status = BotStatus::Paused;
    let pause_calls_before = platform.state().pauses;

    let paused = manager.pause("bot-guest-paused").await.unwrap();
    assert_eq!(paused.status, BotStatus::Paused);
    assert_eq!(
        platform.state().pauses,
        pause_calls_before,
        "the daemon did not pause an already-paused sandbox"
    );

    let resumed = manager.ensure_running("bot-guest-paused").await.unwrap();
    assert_eq!(resumed.status, BotStatus::Running);
    assert_eq!(resumed.sandbox_id.as_deref(), Some(sandbox_id.as_str()));
}

/// A relay whose host another bot rule already uses: the spawn fails
/// loud instead of arming a bot whose pause token cannot ride its host.
#[tokio::test]
async fn a_relay_host_already_in_use_fails_the_spawn() {
    let (dir, platform, manager) = setup();
    // The fake's key rules name `key<n>.example.com` hosts.
    platform.state().key_hosts = 1;
    std::fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({
            "bots": {
                "relay": { "url": "http://key0.example.com", "token": "t" },
                "selfPauseMinutes": 3,
            }
        })
        .to_string(),
    )
    .unwrap();
    let error = manager.spawn(&spec("bot-collide")).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("already carries another bot rule"),
        "{error:#}"
    );
    assert!(platform.state().sandboxes.is_empty(), "nothing leaked");
}

/// A relay configured after the spawn: the next wake pushes the
/// sandbox's rules, so the bot's pause token rides them. The push marks
/// the record, so a later wake does not push again.
#[tokio::test(start_paused = true)]
async fn a_relay_added_after_the_spawn_reaches_the_existing_sandbox() {
    let (dir, platform, manager) = setup();
    let spawned = manager.spawn(&spec("bot-late-relay")).await.unwrap();
    let sandbox_id = spawned.sandbox_id.clone().unwrap();
    assert!(spawned.pause_rule_host.is_none());
    assert!(platform.state().rule_updates.is_empty());

    std::fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({
            "bots": {
                "relay": { "url": "https://relay.example", "token": "t" },
                "selfPauseMinutes": 3,
            }
        })
        .to_string(),
    )
    .unwrap();
    let woken = manager.ensure_running("bot-late-relay").await.unwrap();
    assert_eq!(woken.pause_rule_host.as_deref(), Some("relay.example"));
    let token = woken.pause_token.unwrap();

    // The wake pushed the sandbox's rules, and the relay's host rides them.
    let updates = platform.state().rule_updates.clone();
    assert_eq!(updates.len(), 1, "one rules push");
    assert_eq!(updates[0].0, sandbox_id);
    assert!(
        updates[0].1.contains(&"relay.example".to_string()),
        "the pushed hosts: {:?}",
        updates[0].1
    );
    // The pushed token is the one the record now carries.
    let name = format!(
        "PRIME_AGENT_BOT_PAUSE_{}",
        super::credentials::key_fingerprint("bot-late-relay")
    );
    assert_eq!(platform.state().secrets[&name], token);

    // The marker the push left stops the next wake from pushing again.
    let again = manager.ensure_running("bot-late-relay").await.unwrap();
    assert_eq!(again.pause_rule_host.as_deref(), Some("relay.example"));
    assert_eq!(platform.state().rule_updates.len(), 1, "no second push");
}

/// A wake whose relay rules push fails stays best effort: the bot
/// remains usable, and the stale marker retries the push later.
#[tokio::test(start_paused = true)]
async fn a_failed_relay_rules_push_does_not_block_the_wake() {
    let (dir, platform, manager) = setup();
    let spawned = manager.spawn(&spec("bot-push-fail")).await.unwrap();
    assert!(spawned.pause_rule_host.is_none());
    // The relay host now collides with a key rule, so the push fails.
    platform.state().key_hosts = 1;
    std::fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({
            "bots": {
                "relay": { "url": "http://key0.example.com" },
                "selfPauseMinutes": 3,
            }
        })
        .to_string(),
    )
    .unwrap();
    let woken = manager.ensure_running("bot-push-fail").await.unwrap();
    assert_eq!(woken.status, BotStatus::Running);
    assert!(woken.pause_rule_host.is_none(), "the marker stays stale");
    assert!(
        platform.state().rule_updates.is_empty(),
        "nothing was pushed"
    );
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
/// on every new sandbox.
#[tokio::test(start_paused = true)]
async fn a_github_bot_gets_rules_and_a_placeholder_only() {
    let (dir, platform, manager) = setup();
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
    let registry =
        std::fs::read_to_string(super::registry::BotRegistry::path_in(dir.path())).unwrap();
    assert!(registry.contains("\"github\": true") || registry.contains("\"github\":true"));
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

/// A resume provisions no credentials: the guest keeps the auth its
/// create's bootstrap wrote.
#[tokio::test(start_paused = true)]
async fn a_resume_provisions_no_credentials() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    manager.pause("bot-a").await.unwrap();
    let before = platform.state().credential_calls;

    let resumed = manager.ensure_running("bot-a").await.unwrap();

    assert_eq!(resumed.status, BotStatus::Running);
    assert_eq!(platform.state().credential_calls, before);
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
async fn a_restore_prefers_an_external_checkpoint_over_the_stale_record() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    // The daemon's own pause freezes and records the older checkpoint.
    manager.pause("bot-a").await.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // Outside this daemon, the relay pauses the sandbox: the platform
    // freezes a newer durable checkpoint the registry never records.
    let external = platform.external_checkpoint(&sandbox_id, true);
    // The paused sandbox ends: only a restore can bring the bot back.
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
        Some(external.as_str()),
        "the restore must not roll back to the stale checkpoint"
    );
    assert_eq!(
        manager.get("bot-a").unwrap().checkpoint_id.as_deref(),
        Some(external.as_str()),
        "the record now holds the platform's newest"
    );
}

#[tokio::test(start_paused = true)]
async fn a_restore_skips_a_newer_incomplete_checkpoint() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    manager.pause("bot-a").await.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // An outside pause freezes a durable checkpoint, then a later one
    // that never finishes uploading.
    let external = platform.external_checkpoint(&sandbox_id, true);
    let incomplete = platform.external_checkpoint(&sandbox_id, false);
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
        Some(external.as_str()),
        "the newest durable one wins, not the incomplete one"
    );
    assert!(
        platform.state().checkpoints.contains_key(&incomplete),
        "the incomplete one is kept for the next wake"
    );
}

#[tokio::test(start_paused = true)]
async fn a_failed_checkpoint_list_falls_back_to_the_recorded_checkpoints() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    let stale = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // A newer external checkpoint exists, but the checkpoint list is down.
    platform.external_checkpoint(&sandbox_id, true);
    platform.state().fail_checkpoint_list = true;
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
        Some(stale.as_str()),
        "a failed list falls back to the recorded checkpoint"
    );
}

#[tokio::test(start_paused = true)]
async fn a_pending_head_survives_a_promotion_of_an_older_durable_checkpoint() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    let durable = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    // The daemon's next pause freezes a checkpoint that never finishes
    // uploading: the record's head is pending, the older one durable.
    platform.state().pause_checkpoints_pending = true;
    let pending = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // The paused sandbox ends: the wake restores from the older durable
    // checkpoint, and the pending head must survive that promotion.
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
        Some(durable.as_str()),
        "only the durable one restores"
    );
    assert!(
        platform.state().checkpoints.contains_key(&pending),
        "the newest snapshot is kept until it is durable or superseded"
    );
    assert_eq!(
        manager.get("bot-a").unwrap().checkpoint_id.as_deref(),
        Some(pending.as_str()),
        "the pending head is not demoted where prune would delete it"
    );
}

#[tokio::test(start_paused = true)]
async fn a_failed_winner_restore_falls_back_and_keeps_the_winner() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    let durable = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // An outside pause freezes a newer durable checkpoint, and its
    // restore is then refused: the wake falls back to the older one.
    let external = platform.external_checkpoint(&sandbox_id, true);
    platform.state().fail_create_from = Some(external.clone());
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
        Some(durable.as_str()),
        "the fallback restores the older durable checkpoint"
    );
    assert!(
        platform.state().checkpoints.contains_key(&external),
        "the refused winner is kept for the next wake"
    );
    let record = manager.get("bot-a").unwrap();
    assert!(
        record.older_checkpoint_ids.contains(&durable),
        "the restored fallback stays recorded"
    );
}

#[tokio::test(start_paused = true)]
async fn a_successful_restore_prunes_what_it_supersedes() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    let durable = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // An outside pause freezes a newer durable checkpoint; the wake
    // restores from it, and what it supersedes must then be deleted: a
    // bot paused only by its guest never prunes on its own.
    let external = platform.external_checkpoint(&sandbox_id, true);
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
        Some(external.as_str())
    );
    assert!(
        !platform.state().checkpoints.contains_key(&durable),
        "the superseded checkpoint stops billing"
    );
    let record = manager.get("bot-a").unwrap();
    assert!(
        !record.older_checkpoint_ids.contains(&durable),
        "the record drops what was pruned"
    );
}

/// Checkpoints an outside pause froze belong to the bot too: the next
/// durable pause prunes the older ones, and a delete removes the rest.
#[tokio::test(start_paused = true)]
async fn outside_checkpoints_are_pruned_and_deleted_with_the_bot() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    let outside = platform.external_checkpoint(&sandbox_id, true);

    manager.pause("bot-a").await.unwrap();
    assert!(
        !platform.state().checkpoints.contains_key(&outside),
        "the newer durable pause supersedes it"
    );

    let later = platform.external_checkpoint(&sandbox_id, true);
    manager.delete("bot-a").await.unwrap();
    assert!(
        !platform.state().checkpoints.contains_key(&later),
        "the delete removes it"
    );
    assert!(platform.state().checkpoints.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_promotion_orders_checkpoints_chronologically() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    let durable = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // An outside pause freezes a checkpoint half a second later, stamped
    // with fractional seconds: a plain string comparison calls the older
    // whole-second stamp newer ('Z' sorts after '.').
    let stamp = platform
        .state()
        .checkpoint_origins
        .get(&durable)
        .unwrap()
        .1
        .clone();
    let fractional = format!("{}.500Z", stamp.trim_end_matches('Z'));
    let external = platform.external_checkpoint_at(&sandbox_id, true, &fractional);
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
        Some(external.as_str()),
        "the chronologically newer checkpoint wins"
    );
}

#[tokio::test(start_paused = true)]
async fn a_pending_head_still_records_an_unrecorded_durable_checkpoint() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    manager.pause("bot-a").await.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // An outside pause freezes a durable checkpoint; then the daemon's own
    // pause freezes a newer one that never finishes uploading.
    let external = platform.external_checkpoint(&sandbox_id, true);
    platform.state().pause_checkpoints_pending = true;
    let pending = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
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
        Some(external.as_str()),
        "the unrecorded durable checkpoint is restored, not skipped"
    );
    let record = manager.get("bot-a").unwrap();
    assert_eq!(
        record.checkpoint_id.as_deref(),
        Some(pending.as_str()),
        "the pending head keeps its place"
    );
    assert!(
        record.older_checkpoint_ids.contains(&external),
        "the winner joins the older list behind the pending head"
    );
    assert!(
        platform.state().checkpoints.contains_key(&pending),
        "the pending head is not deleted"
    );
}

#[tokio::test(start_paused = true)]
async fn a_pending_snapshot_keeps_its_place_when_a_winner_is_recorded() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    manager.pause("bot-a").await.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    let sandbox_id = manager.get("bot-a").unwrap().sandbox_id.unwrap();
    // An outside pause freezes a durable checkpoint, then two local
    // pauses freeze pending ones on both sides of it in time: the older
    // list is [durable, pending] when the winner is recorded.
    let external = platform.external_checkpoint(&sandbox_id, true);
    platform.state().pause_checkpoints_pending = true;
    let pending = manager.pause("bot-a").await.unwrap().checkpoint_id.unwrap();
    manager.ensure_running("bot-a").await.unwrap();
    manager.pause("bot-a").await.unwrap();
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
        Some(external.as_str()),
        "the newest durable one restores"
    );
    assert!(
        platform.state().checkpoints.contains_key(&pending),
        "the time-newer pending snapshot survives the prune"
    );
    let record = manager.get("bot-a").unwrap();
    let older = &record.older_checkpoint_ids;
    let external_at = older
        .iter()
        .position(|id| id == &external)
        .expect("the winner is recorded");
    let pending_at = older
        .iter()
        .position(|id| id == &pending)
        .expect("the pending snapshot stays recorded");
    assert!(
        external_at < pending_at,
        "the winner sits before the time-newer pending snapshot"
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
/// used, and it rides the gateway transfer endpoint. A guest whose gateway
/// refuses that endpoint still gets the build through the exec stream.
/// One test, one environment override: the tarball variable is global.
#[tokio::test(start_paused = true)]
async fn a_local_tarball_rides_the_upload_endpoint_or_the_exec_stream() {
    let (dir, platform, manager) = setup();
    let bytes = b"not really a tarball".to_vec();
    let tarball = dir.path().join("bot.tar.gz");
    std::fs::write(&tarball, &bytes).unwrap();
    let _env = crate::test_support::KernelEnvOverride::apply(&[(
        version::TARBALL_OVERRIDE_ENV,
        Some(tarball.display().to_string()),
    )]);

    let spawned = manager.spawn(&spec("bot-tarball")).await.unwrap();

    let sandbox_id = spawned.sandbox_id.clone().unwrap();
    assert_eq!(platform.state().installs, 1);
    assert_eq!(
        platform.state().uploads,
        [(
            sandbox_id,
            version::Install::UPLOAD_PATH.to_string(),
            bytes.len(),
        )]
    );
    let (_, install) = platform
        .state()
        .execs
        .iter()
        .find(|(script, _)| script.as_str() == INSTALL_SCRIPT)
        .cloned()
        .expect("an install ran");
    assert_eq!(install["PA_TARBALL_BYTES"], bytes.len().to_string());
    assert_eq!(install["PA_TARBALL_SHA256"], super::sha256_hex(&bytes));
    assert_eq!(install["PA_TARBALL_PATH"], version::Install::UPLOAD_PATH);

    // The guest gateway refuses the transfer endpoint: the next install
    // falls back to the exec stream.
    platform.state().upload_fails = true;
    manager.spawn(&spec("bot-upload-fallback")).await.unwrap();

    let state = platform.state();
    assert_eq!(state.uploads.len(), 2, "the fast path was tried twice");
    let (_, install) = state
        .execs
        .iter()
        .rev()
        .find(|(script, _)| script.as_str() == INSTALL_SCRIPT)
        .cloned()
        .expect("an install ran");
    assert!(!install.contains_key("PA_TARBALL_PATH"));
    assert_eq!(install["PA_TARBALL_BYTES"], bytes.len().to_string());
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
    // While the script waits, the daemon writes new settings. The sleep is
    // only the opportunistic mid-check: the merge assertions below are the
    // deterministic contract, and they hold whichever side of the sleep the
    // script started on.
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
    let exited = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(move || script.wait()),
    )
    .await
    .expect("python3 exits within the timeout")
    .expect("the wait task joins");
    assert!(exited.expect("python3 exits").success());
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
    task: &str,
) -> anyhow::Result<String> {
    let ledger = super::ledger::BotLedger::new(agent_dir, &bot.bot_id);
    let mut guest = super::guest::GuestClient::connect(manager, bot).await?;
    super::send::send_message(&mut guest, &bot.guest_session_id, task, None)
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
    let task = format!(
        "Run this script with one bash() call and await it, then reply with its output \
         lines only:\n\nset -euo pipefail\ncd \"$(mktemp -d)\"\n\
         git clone -q https://github.com/{repo} repo && cd repo\n\
         git checkout -q -b {branch}\n\
         git commit -q --allow-empty -m \"bot live test\"\n\
         git log -1 --format='AUTHOR=%an <%ae>'\n\
         git push -q origin {branch}\n\
         url=\"$(gh pr create -R {repo} --draft --head {branch} --title \"bot live test\" \
         --body \"Closed by the test.\")\"\n\
         echo \"PR=$url\"\n\
         gh pr close -R {repo} \"$url\" --delete-branch\n\
         echo CLOSED"
    );
    let run = async {
        let bot = manager.spawn(&spec).await?;
        let reply = live_ask(&manager, dir.path(), &bot, &task).await?;
        let guest_files = platform
            .exec(
                bot.sandbox_id.as_deref().unwrap(),
                r#"cat "$HOME/.gitconfig" "$HOME/.prime-agent-git-credential""#,
                &BTreeMap::new(),
                None,
            )
            .await?;
        anyhow::Ok((bot, reply, guest_files))
    }
    .await;
    manager.delete(&bot_id).await.unwrap();
    let [token_secret, basic_secret] = super::github::secret_names(&owner);
    for secret in new_client().list_secrets().await.unwrap() {
        if secret.name == token_secret || secret.name == basic_secret {
            new_client().delete_secret(&secret.id).await.unwrap();
        }
    }
    let (bot, reply, guest_files) = run.unwrap();
    eprintln!(
        "live github: reply={reply}\nguest files={}",
        guest_files.stdout
    );
    assert!(bot.github);
    assert!(reply.contains("AUTHOR=Prime Agent Live <live@example.com>"));
    assert!(reply.contains("PR=https://github.com/"));
    assert!(reply.contains("CLOSED"));
    assert!(!reply.contains(&token) && !guest_files.stdout.contains(&token));
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
    fn list_checkpoints<'a>(
        &'a self,
        label: &'a str,
    ) -> BoxFuture<'a, PlatformResult<Vec<BotCheckpoint>>> {
        self.inner.list_checkpoints(label)
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
    fn upload<'a>(
        &'a self,
        sandbox_id: &'a str,
        path: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.upload(sandbox_id, path, bytes)
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
        description: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.put_secret(name, value, description)
    }
    fn delete_secret<'a>(&'a self, name: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        self.inner.delete_secret(name)
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
        let reply = live_ask(manager, agent_dir, bot, task).await?;
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
        platform.put_secret(&secret, &api_key, "test").await?;
        let bot = manager.spawn(&spec).await?;
        step("spawned");
        let first = ask_until(&manager, dir.path(), &bot, &mut asked, true).await?;
        step("first answer");
        platform.put_secret(&secret, "bad-key", "test").await?;
        step("secret set to a bad key");
        let failed = ask_until(&manager, dir.path(), &bot, &mut asked, false).await?;
        step("turn failed");
        platform.put_secret(&secret, &api_key, "test").await?;
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
        let first = live_ask(&manager, dir.path(), &spawned, task).await?;
        step("first reply");
        let paused = manager.pause(&bot_id).await?;
        step("paused");
        let resumed = manager.ensure_running(&bot_id).await?;
        step("resumed");
        let task = "Repeat the word you replied with before, in capital letters only.";
        let second = live_ask(&manager, dir.path(), &resumed, task).await?;
        step("second reply");
        let task = "Run each shell command with bash() and await it: `node --version`, \
                    `npm --version`, `uv pip install six`. Reply with one line only: \
                    NODE=<node output> NPM=<npm output> UV=<uv pip exit code>";
        let tools = live_ask(&manager, dir.path(), &resumed, task).await?;
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

/// Send `task` to a live bot and wait up to 9 minutes for its reply: the
/// nested chain (a child provisioning inside the bot's turn) takes longer
/// than [`live_ask`]'s budget.
async fn live_ask_long(
    manager: &BotManager,
    dir: &std::path::Path,
    bot: &super::BotRecord,
    task: &str,
) -> anyhow::Result<String> {
    let ledger = super::ledger::BotLedger::new(dir, &bot.bot_id);
    let mut guest = super::guest::GuestClient::connect(manager, bot).await?;
    super::send::send_message(&mut guest, &bot.guest_session_id, task, None)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut reply = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(540);
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
    anyhow::Ok(reply)
}

/// Live: a bot spawned with `bots=True` spawns one child bot through the
/// injected sandbox key, the child's answer routes back through the bot,
/// and deleting the bot deletes the child. Run like
/// [`live_spawn_reply_pause_resume_delete`].
#[tokio::test]
#[ignore = "creates two real Prime sandboxes"]
async fn live_a_bot_spawns_a_bot_and_delete_cascades() {
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
    let bot_id = format!("live-nested-{}", uuid::Uuid::new_v4());
    let spec = BotSpec {
        model: Some("prime-inference/anthropic/claude-haiku-4.5".to_string()),
        bots: true,
        ..spec(&bot_id)
    };
    let started = std::time::Instant::now();
    let step = |name: &str| eprintln!("live nested: {name} at {}s", started.elapsed().as_secs());

    let run = async {
        let parent = manager.spawn(&spec).await?;
        step("parent spawned");
        let task = "Reply with the single word pong and nothing else.";
        let first = live_ask_long(&manager, dir.path(), &parent, task).await?;
        step("parent first reply");
        // An error, not a panic: the cleanup delete below still runs.
        anyhow::ensure!(first.to_lowercase().contains("pong"), "first: {first:?}");
        let task = "Start one sandbox bot: await rlm.spawn('Reply with the single word ping \
                    and nothing else.', name='child', target='sandbox'). Wait for the child's \
                    final answer, then reply with exactly that word in capital letters and \
                    nothing else.";
        let second = live_ask_long(&manager, dir.path(), &parent, task).await?;
        step("parent second reply");
        // The child lived: its sandbox carries the parent label, and the
        // guest created it directly (this daemon has no record of it).
        let children = platform.list(&super::parent_label(&parent.bot_id)).await?;
        step("child listed");
        anyhow::Ok((parent, second, children))
    }
    .await;
    manager.delete(&bot_id).await.unwrap();
    step("parent deleted");
    let (parent, second, children) = run.unwrap();

    eprintln!(
        "live nested: parent={:?} second={second:?} children={children:?}",
        parent.bot_id
    );
    assert!(second.contains("PING"), "second: {second:?}");
    assert!(
        children.iter().any(|sandbox| !sandbox.status.is_terminal()),
        "the child sandbox was live: {children:?}"
    );
    // The cascade removed the child with its parent.
    let left = platform
        .list(&super::parent_label(&parent.bot_id))
        .await
        .unwrap();
    assert!(
        left.iter().all(|sandbox| sandbox.status.is_terminal()),
        "{left:?}"
    );
    let mine = platform.list(&bot_label(&parent.bot_id)).await.unwrap();
    assert!(mine.iter().all(|sandbox| sandbox.status.is_terminal()));
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

/// A nested context in `agent_dir`, with the sandbox API rule and one other.
fn nested_context(dir: &std::path::Path, bot_id: &str, owner: &str) {
    let context = super::nested::NestedContext {
        bot_id: bot_id.to_string(),
        owner_session_id: owner.to_string(),
        depth: 1,
        max_bots: 10,
        network_rules: BTreeMap::from([
            (
                super::credentials::sandbox_api_host(),
                pa_sandbox::HeaderRule {
                    headers: BTreeMap::new(),
                },
            ),
            (
                "api.example.com".to_string(),
                pa_sandbox::HeaderRule {
                    headers: BTreeMap::new(),
                },
            ),
            // The Prime Inference model host, so a prime-inference child
            // passes the provider-rule check.
            (
                "api.pinference.ai".to_string(),
                pa_sandbox::HeaderRule {
                    headers: BTreeMap::new(),
                },
            ),
        ]),
    };
    let path = super::nested::NestedContext::path_in(dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string(&context).unwrap()).unwrap();
}

/// The guest's own auth.json, with the Prime Inference placeholder record.
fn guest_auth(dir: &std::path::Path) {
    let path = dir.join("auth.json");
    if path.exists() {
        return;
    }
    std::fs::write(
        path,
        serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "injected-by-platform",
                "primeTeam": { "teamId": "team-1", "name": "Team One" },
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// The Mac path: a `bots=True` bot gets the platform secret, the sandbox
/// API rule, the forced Prime Inference guest record, and the nested
/// context in its bootstrap.
#[tokio::test(start_paused = true)]
async fn a_bot_that_spawns_bots_gets_the_sandbox_api_rule_and_context() {
    let (dir, platform, manager) = setup();
    guest_auth(dir.path());
    let mut bot = spec("bot-a");
    bot.bots = true;
    let spawned = manager.spawn(&bot).await.unwrap();

    // The owner's sandbox key became a platform secret, and the sandbox's
    // rules inject it on the sandbox API host.
    let state = platform.state();
    let secrets: Vec<&String> = state
        .secrets
        .keys()
        .filter(|name| name.starts_with("PRIME_AGENT_BOTS_KEY_"))
        .collect();
    // Print the secret NAMES only: formatting the map would put the values in
    // a failing test's log (CodeQL alert 337, "cleartext logging of sensitive information").
    assert_eq!(
        secrets.len(),
        1,
        "expected one sandbox key secret, got {:?}",
        state.secrets.keys().collect::<Vec<_>>()
    );
    let created = state.creates.clone();
    drop(state);
    // The spawns label survives a registry rebuild.
    assert!(created
        .last()
        .expect("a create ran")
        .labels
        .contains(&super::BOTS_LABEL.to_string()));
    let rules = &created.last().unwrap().network_rules;
    let api_rule = rules
        .get(&super::credentials::sandbox_api_host())
        .expect("the sandbox API rule");
    let authorization = api_rule.headers["Authorization"].clone();
    assert!(
        authorization.starts_with("Bearer ${prime.secrets.PRIME_AGENT_BOTS_KEY_"),
        "{authorization}"
    );

    // The bootstrap carried the nested context, with the rules including
    // the sandbox API one and the owner's session id.
    let state = platform.state();
    let bootstrap = state
        .execs
        .iter()
        .find(|(_, env)| env.contains_key("BOT_NESTED_JSON"))
        .expect("the bootstrap carried the nested context");
    let context: super::nested::NestedContext =
        serde_json::from_str(&bootstrap.1["BOT_NESTED_JSON"]).unwrap();
    assert_eq!(context.bot_id, "bot-a");
    assert_eq!(context.owner_session_id, "owner-1");
    assert_eq!(context.depth, 1);
    assert!(context
        .network_rules
        .contains_key(&super::credentials::sandbox_api_host()));
    assert!(spawned.bots);
    drop(state);

    // The guest auth the bootstrap writes carries the Prime Inference
    // placeholder record, so the guest daemon builds a sandbox client.
    let auth = platform
        .state()
        .execs
        .iter()
        .find(|(_, env)| env.contains_key("BOT_AUTH_JSON"))
        .map(|(_, env)| env["BOT_AUTH_JSON"].clone())
        .expect("the bootstrap carried the guest auth");
    let auth: serde_json::Value = serde_json::from_str(&auth).unwrap();
    assert_eq!(auth["prime-inference"]["key"], "injected-by-platform");
}

/// The guest path: inside a bot, a child's sandbox carries the owner label
/// of the Mac owner, the parent label, and the rules minus the sandbox API
/// one (a child cannot call the platform).
#[tokio::test(start_paused = true)]
async fn a_bot_inside_a_bot_labels_and_credentials_its_children() {
    let (dir, platform, manager) = setup();
    nested_context(dir.path(), "bot-a", "owner-9");
    guest_auth(dir.path());
    let spawned = manager.spawn(&spec("bot-c")).await.unwrap();

    let labels = &platform.live()[0].labels;
    assert!(labels.contains(&bot_label("bot-c")));
    assert!(labels.contains(&owner_label("owner-9")));
    assert!(labels.contains(&super::parent_label("bot-a")));
    assert_eq!(spawned.parent_bot_id.as_deref(), Some("bot-a"));
    assert!(!spawned.bots);

    let created = platform.state().creates.clone();
    let rules = &created.last().unwrap().network_rules;
    assert!(
        rules.contains_key("api.example.com"),
        "the child keeps the other rules"
    );
    assert!(
        !rules.contains_key(&super::credentials::sandbox_api_host()),
        "the child does not get the sandbox API rule"
    );
    // No platform secret is provisioned from inside a bot.
    assert_eq!(platform.state().secret_puts, 0);
}

/// The child's model must run on one of the injected providers.
#[tokio::test(start_paused = true)]
async fn a_bot_refuses_a_child_on_a_provider_it_has_no_key_for() {
    let (dir, _platform, manager) = setup();
    nested_context(dir.path(), "bot-a", "owner-9");
    guest_auth(dir.path());
    let mut bot = spec("bot-c");
    bot.model = Some("anthropic/model-x".to_string());
    let refused = manager.spawn(&bot).await.expect_err("refused");
    assert!(
        refused.to_string().contains("no anthropic credentials"),
        "{refused}"
    );
}

/// Children count toward the owner's bot list: the registry's records plus
/// the owner label's sandboxes.
#[tokio::test(start_paused = true)]
async fn children_count_toward_the_owners_bot_list() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    manager.spawn(&spec("bot-b")).await.unwrap();
    assert_eq!(manager.owner_bot_ids("owner-1").await.unwrap().len(), 2);

    // A child the Mac never learned, named only by its labels.
    platform.add_sandbox(
        "child",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-c"),
            owner_label("owner-1"),
            super::parent_label("bot-a"),
        ],
    );
    assert_eq!(manager.owner_bot_ids("owner-1").await.unwrap().len(), 3);

    // A terminated sandbox is a deleted bot: it stops counting.
    let gone = platform.add_sandbox(
        "gone",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-g"),
            owner_label("owner-1"),
        ],
    );
    platform.state().sandboxes.get_mut(&gone).unwrap().status = BotStatus::Stopped;
    assert_eq!(manager.owner_bot_ids("owner-1").await.unwrap().len(), 3);

    // A merged child counts through its parent even with no live sandbox:
    // a stopped child with a checkpoint still holds a cap slot.
    manager
        .merge_children(
            "bot-a",
            &[serde_json::json!({
                "botId": "bot-child", "name": "child", "ownerSessionId": "guest-session",
                "parentBotId": "bot-a", "checkpointId": "ckpt-1", "status": "stopped",
                "createdAt": 1_i64, "statusSince": 1_i64, "closedRunningMs": 0_i64,
            })],
        )
        .await
        .unwrap();
    assert_eq!(manager.owner_bot_ids("owner-1").await.unwrap().len(), 4);
}

/// The follower merge: a bot's `list_bots` rows upsert as its children,
/// and a child that vanished from the rows is deleted.
#[tokio::test(start_paused = true)]
async fn merged_child_rows_upsert_and_vanished_children_go() {
    let (_dir, platform, manager) = setup();
    let spawn_a = manager.spawn(&spec("bot-a")).await.unwrap();
    let spawn_a_sandbox = spawn_a.sandbox_id.clone();
    let row = serde_json::json!({
        "botId": "bot-c",
        "name": "helper",
        "ownerSessionId": "guest-session",
        "sandboxId": "sbx-9",
        "status": "running",
        "createdAt": 1_i64,
        "lastTurnAt": 2_i64,
        "guestSessionId": "guest-sbx-9",
        "statusSince": 1_i64,
        "closedRunningMs": 1000_i64,
        "github": false,
    });
    manager.merge_children("bot-a", &[row]).await.unwrap();
    let merged = manager.get("bot-c").expect("the child merged");
    assert_eq!(merged.parent_bot_id.as_deref(), Some("bot-a"));
    assert_eq!(merged.owner_session_id, "guest-session");
    assert_eq!(merged.status, BotStatus::Running);

    // A row that never provisioned (no sandbox, no checkpoint) is skipped.
    let phantom = serde_json::json!({
        "botId": "bot-d", "name": "phantom", "ownerSessionId": "guest-session",
        "status": "creating", "createdAt": 1_i64,
    });
    manager.merge_children("bot-a", &[phantom]).await.unwrap();
    assert!(manager.get("bot-d").is_none(), "a phantom does not merge");

    // A row cannot claim another parent, and cannot overwrite a bot this
    // daemon owns outright: both are left alone.
    let foreign = serde_json::json!({
        "botId": "bot-e", "name": "foreign", "ownerSessionId": "guest-session",
        "parentBotId": "bot-other", "sandboxId": "sbx-e", "status": "running",
        "createdAt": 1_i64,
    });
    let hijack = serde_json::json!({
        "botId": "bot-a", "name": "hijack", "ownerSessionId": "guest-session",
        "parentBotId": "bot-a", "sandboxId": "sbx-evil", "status": "running",
        "createdAt": 1_i64,
    });
    manager
        .merge_children("bot-a", &[foreign, hijack])
        .await
        .unwrap();
    assert!(
        manager.get("bot-e").is_none(),
        "a foreign-parent row does not merge"
    );
    assert_eq!(
        manager.get("bot-a").unwrap().sandbox_id.as_deref(),
        spawn_a_sandbox.as_deref(),
        "an owned bot's record is not overwritten"
    );

    // The row gone: the child is deleted again.
    manager.merge_children("bot-a", &[]).await.unwrap();
    assert!(manager.get("bot-c").is_none());
    assert!(manager.get("bot-a").is_some(), "the parent stays");

    // A vanished row with a LIVE sandbox is not a deletion: an older guest
    // snapshot must not delete a child that still runs.
    let child_sandbox = platform.add_sandbox(
        "live-child",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-live"),
            owner_label("owner-1"),
            super::parent_label("bot-a"),
        ],
    );
    manager
        .merge_children(
            "bot-a",
            &[serde_json::json!({
                "botId": "bot-live", "name": "live", "ownerSessionId": "guest-session",
                "parentBotId": "bot-a", "sandboxId": child_sandbox, "status": "running",
                "createdAt": 1_i64, "statusSince": 1_i64, "closedRunningMs": 0_i64,
            })],
        )
        .await
        .unwrap();
    manager.merge_children("bot-a", &[]).await.unwrap();
    assert!(
        manager.get("bot-live").is_some(),
        "a live child survives a stale snapshot"
    );
    assert!(
        platform
            .state()
            .sandboxes
            .get(&child_sandbox)
            .is_some_and(|sandbox| !sandbox.status.is_terminal()),
        "its sandbox was not deleted"
    );
}

/// Deleting a bot deletes its descendants first: the registry's children
/// and the ones only the parent label names.
#[tokio::test(start_paused = true)]
async fn deleting_a_bot_deletes_its_children_first() {
    let (_dir, platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    // A child only the parent label names (no registry record).
    let child = platform.add_sandbox(
        "child",
        vec![
            BOT_LABEL.to_string(),
            bot_label("bot-c"),
            owner_label("owner-1"),
            super::parent_label("bot-a"),
        ],
    );
    manager.delete("bot-a").await.unwrap();
    assert!(
        platform.state().sandboxes[&child].status.is_terminal(),
        "the child sandbox went"
    );
    assert_eq!(platform.live().len(), 0, "nothing is left");
    assert!(manager.get("bot-a").is_none());
}

/// `allow_spawns` on a running bot: the merged policy keeps the plan's
/// rules and adds the sandbox API one, the guest gets the context, and
/// the record carries the flag.
#[tokio::test(start_paused = true)]
async fn allow_spawns_gives_a_running_bot_the_rule_and_context() {
    let (dir, platform, manager) = setup();
    guest_auth(dir.path());
    platform.state().key_hosts = 1;
    manager.spawn(&spec("bot-a")).await.unwrap();

    let record = manager.allow_spawns("bot-a").await.unwrap();
    assert!(record.bots);
    assert!(manager.get("bot-a").unwrap().bots);

    // The durable spawns marker records the flag for a registry rebuild.
    let marker = std::fs::read_to_string(dir.path().join("bots/spawns.json")).unwrap();
    assert!(marker.contains("\"bot-a\""), "{marker}");

    // The policy replacement kept the plan's rule and added the sandbox
    // API one.
    let updates = platform.state().rule_updates.clone();
    let (_, hosts) = updates.last().expect("the policy was replaced");
    assert!(hosts.contains(&"key0.example.com".to_string()), "{hosts:?}");
    assert!(
        hosts.contains(&super::credentials::sandbox_api_host()),
        "{hosts:?}"
    );

    // The guest write carried the nested context.
    let execs = platform.state().execs.clone();
    assert!(
        execs
            .iter()
            .any(|(script, env)| script == ALLOW_SPAWNS_SCRIPT
                && env.contains_key("BOT_NESTED_JSON")
                && env.contains_key("BOT_PRIME_RECORD")),
        "the nested settings were written into the guest"
    );

    // A paused bot is refused.
    manager.pause("bot-a").await.unwrap();
    let refused = manager.allow_spawns("bot-a").await.expect_err("refused");
    assert!(
        refused.to_string().contains("only a running bot"),
        "{refused}"
    );
}

/// A /secrets refresh rewrites a bots=True bot's guest nested context, so a
/// revoked secret leaves the children's inherited rules at the same moment
/// it leaves the sandbox policy.
#[tokio::test(start_paused = true)]
async fn a_secrets_refresh_rewrites_a_spawning_bots_nested_context() {
    let (dir, platform, manager) = setup();
    guest_auth(dir.path());
    platform.state().key_hosts = 1;
    let mut bot = spec("bot-a");
    bot.bots = true;
    manager.spawn(&bot).await.unwrap();

    let before: usize = platform
        .state()
        .execs
        .iter()
        .filter(|(script, _)| script == ALLOW_SPAWNS_SCRIPT)
        .count();
    manager.refresh_network_rules().await;

    let execs = platform.state().execs.clone();
    let after: usize = execs
        .iter()
        .filter(|(script, _)| script == ALLOW_SPAWNS_SCRIPT)
        .count();
    assert!(after > before, "the refresh rewrote the nested context");
    let rewrite = execs
        .iter()
        .find(|(script, _)| script == ALLOW_SPAWNS_SCRIPT)
        .expect("the nested write ran");
    assert!(rewrite.1.contains_key("BOT_NESTED_JSON"));
}

/// Run the bootstrap's guest client (`BOT_CLIENT` `create`) against a fake
/// guest daemon socket and return the create command it sent. The reply
/// names a session file, like the guest daemon's create does.
#[cfg(unix)]
fn run_bot_client(
    home: &std::path::Path,
    session_file: Option<&std::path::Path>,
) -> serde_json::Value {
    use std::io::{BufRead, BufReader, Write};
    let socket = home.join("daemon.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let reply_home = home.to_path_buf();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        writer
            .write_all(
                b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
            )
            .unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let envelope: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        let id = envelope["id"].as_str().unwrap().to_string();
        let reply = serde_json::json!({
            "type": "response",
            "id": id,
            "success": true,
            "data": {
                "activeSessionId": "s1",
                "sessionFile": format!("{}/s1.jsonl", reply_home.display()),
            },
        });
        writer
            .write_all((reply.to_string() + "\n").as_bytes())
            .unwrap();
        envelope
    });
    let mut command = std::process::Command::new("python3");
    command
        .arg("-c")
        .arg(super::manager::BOT_CLIENT)
        .arg("create")
        .env("HOME", home)
        .env("PRIME_AGENT_DAEMON_SOCKET", &socket)
        .env("BOT_NAME", "bot-a")
        .env(
            "BOT_CONFIG",
            r#"{"cwd": "/root", "provider": "prime-inference", "model": "model-a", "thinking": "high"}"#,
        );
    match session_file {
        Some(file) => command.env("BOT_SESSION_FILE", file),
        None => command.env_remove("BOT_SESSION_FILE"),
    };
    let status = command.status().expect("python3");
    assert!(status.success(), "the guest client create failed");
    server.join().expect("the fake guest daemon answered")
}

/// A reopened bot session keeps its own model: the create the bootstrap
/// sends must not carry the spawn-time model, provider, or thinking,
/// because an explicit create flag overrides the model the session file
/// pins (every `set_model` lands there). Otherwise a cold restore or an
/// upgrade reverts a bot to its spawn model.
#[cfg(unix)]
#[test]
fn a_reopened_bot_session_keeps_its_own_model() {
    let home = tempfile::tempdir().unwrap();
    let session = home.path().join("s1.jsonl");
    std::fs::write(&session, r#"{"role": "user"}"#).unwrap();
    let envelope = run_bot_client(home.path(), Some(&session));
    let command = &envelope["command"];
    assert_eq!(
        command["sessionPath"].as_str(),
        Some(session.to_str().unwrap()),
        "the session was reopened"
    );
    for key in ["provider", "model", "thinking"] {
        assert!(
            command["config"].get(key).is_none(),
            "the reopened create must not carry {key}"
        );
    }
}

/// The guest's marker file names the session when the record lost it (a
/// registry rebuilt from labels): that reopen keeps the session's model
/// too, not the spawn-time one.
#[cfg(unix)]
#[test]
fn a_marker_named_session_also_keeps_its_model() {
    let home = tempfile::tempdir().unwrap();
    let session = home.path().join("s1.jsonl");
    std::fs::write(&session, r#"{"role": "user"}"#).unwrap();
    std::fs::write(
        home.path().join(".prime-agent-bot-session"),
        session.to_str().unwrap(),
    )
    .unwrap();
    let envelope = run_bot_client(home.path(), None);
    let command = &envelope["command"];
    assert_eq!(
        command["sessionPath"].as_str(),
        Some(session.to_str().unwrap()),
        "the marker-named session was reopened"
    );
    assert!(
        command["config"].get("model").is_none(),
        "the reopened create must not carry the model"
    );
}

/// A bot session that does not exist yet still gets the spawn model: the
/// create carries it, so a fresh sandbox boots the model the owner chose.
#[cfg(unix)]
#[test]
fn a_new_bot_session_gets_the_spawn_model() {
    let home = tempfile::tempdir().unwrap();
    let envelope = run_bot_client(home.path(), None);
    let command = &envelope["command"];
    assert!(
        command.get("sessionPath").is_none(),
        "no session was reopened"
    );
    assert_eq!(command["config"]["model"], "model-a");
    assert_eq!(command["config"]["provider"], "prime-inference");
    assert_eq!(command["config"]["thinking"], "high");
}

/// The follow sync adopts the guest session's live model and thinking
/// into the record: the /bots row shows them, and the next create
/// provisions the model's provider key. A summary without a model leaves
/// the record alone.
#[tokio::test(start_paused = true)]
async fn the_follow_sync_adopts_the_guests_model() {
    let (dir, _platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    assert_eq!(
        manager.get("bot-a").unwrap().model.as_deref(),
        Some("prime-inference/model-a")
    );

    // The guest's `get_state` summary after a `set_model`.
    manager
        .adopt_guest_model(
            "bot-a",
            &serde_json::json!({
                "model": { "id": "model-b", "provider": "openai" },
                "thinkingLevel": "high",
            }),
        )
        .unwrap();
    let record = manager.get("bot-a").unwrap();
    assert_eq!(record.model.as_deref(), Some("openai/model-b"));
    assert_eq!(record.thinking.as_deref(), Some("high"));
    assert_eq!(
        super::registry::BotRegistry::load(dir.path())
            .unwrap()
            .get("bot-a")
            .unwrap()
            .model
            .as_deref(),
        Some("openai/model-b"),
        "the file on disk carries the model"
    );

    // An unchanged summary writes nothing new; a "default" (unset) level
    // keeps the record's thinking; one without a model keeps the model.
    manager
        .adopt_guest_model(
            "bot-a",
            &serde_json::json!({
                "model": { "id": "model-b", "provider": "openai" },
                "thinkingLevel": "default",
            }),
        )
        .unwrap();
    let record = manager.get("bot-a").unwrap();
    assert_eq!(record.model.as_deref(), Some("openai/model-b"));
    assert_eq!(
        record.thinking.as_deref(),
        Some("high"),
        "a default level keeps the record's thinking"
    );
    manager
        .adopt_guest_model("bot-a", &serde_json::json!({ "model": null }))
        .unwrap();
    assert_eq!(
        manager.get("bot-a").unwrap().model.as_deref(),
        Some("openai/model-b"),
        "a summary without a model leaves the record alone"
    );
}

/// Spawning a bot that already exists returns the stored record, with
/// the status stamps the registry adds.
#[tokio::test(start_paused = true)]
async fn a_respawn_returns_the_stored_record() {
    let (_dir, _platform, manager) = setup();
    manager.spawn(&spec("bot-a")).await.unwrap();
    manager.pause("bot-a").await.unwrap();
    // The resume's status stamp must differ from the pause's.
    std::thread::sleep(std::time::Duration::from_millis(5));

    let respawned = manager.spawn(&spec("bot-a")).await.unwrap();

    assert_eq!(respawned.status, BotStatus::Running);
    assert_eq!(respawned, manager.get("bot-a").unwrap());
}

//! Tailnet remote-agent mesh (port of TS #2516 `remote-mesh.ts`).
//!
//! Converts remote-daemon session snapshots into roster, list, and peer
//! shapes, marks unreachable peers offline, and defines the
//! cross-machine delivery seam. The supervisor refreshes this state on
//! demand when a roster consumer queries it - there is no background
//! loop; a scan runs at most once per TTL when a consumer asks, and
//! concurrent consumers coalesce onto the in-flight scan.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_types::daemon::agent_roster::AgentRosterEntry;
use serde_json::{json, Map, Value};

/// Session facts a remote daemon publishes over the mesh (TS
/// `RemoteAgentSessionSummary`; the discovery source's snapshot shape).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RemoteAgentSessionSummary {
    pub id: String,
    pub session_id: String,
    pub active_session_id: Option<String>,
    pub session_name: Option<String>,
    pub lifecycle: String,
    pub activity: String,
    pub is_streaming: bool,
    pub is_running_tools: Option<bool>,
    pub is_compacting: Option<bool>,
    pub cwd: String,
    /// Display-only model identity; remote summaries never carry a full
    /// model object.
    pub model: Option<RemoteModel>,
    pub message_count: u64,
    pub attached_clients: u64,
    pub rlm_depth: Option<u64>,
    pub runtime_kind: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub last_activity_at: Option<String>,
    pub first_message: Option<String>,
    pub summary: Option<String>,
}

/// The display-only model identity a remote row carries (TS
/// `RemoteAgentSessionSummary["model"]`).
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteModel {
    pub provider: String,
    pub model_id: String,
}

/// One tailnet peer as reported by an on-demand mesh scan (TS
/// `RemoteAgentHost`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RemoteAgentHost {
    /// `MagicDNS` hostname, e.g. "milk.tailnet.ts.net"; the agents-view
    /// label source.
    pub tailnet_host: String,
    /// The peer is present in `tailscale status`.
    pub online: bool,
    /// A prime-agent daemon answered on the mesh port.
    pub daemon: bool,
    /// The daemon answered but this machine holds no valid token for its
    /// roster.
    pub locked: Option<bool>,
    pub error: Option<String>,
    /// Mesh port that answered (cross-machine message targeting).
    pub port: Option<u16>,
    /// Short machine name, display fallback only.
    pub hostname: Option<String>,
    pub sessions: Vec<RemoteAgentSessionSummary>,
}

impl RemoteAgentHost {
    /// A host answers with a usable roster only when online, unlocked, and
    /// daemon-backed (TS `isRemoteHostUsable`).
    fn usable(&self) -> bool {
        self.online && self.daemon && self.locked != Some(true)
    }
}

/// On-demand discovery seam; the discovery layer backs it with the
/// tailnet scan (TS `RemoteAgentMeshSource`).
pub trait RemoteAgentMeshSource: Send + Sync {
    fn list_remote_agents(
        &self,
    ) -> futures::future::BoxFuture<'_, anyhow::Result<Vec<RemoteAgentHost>>>;
}

/// One resolved cross-machine send target (TS `RemoteAgentMessageTarget`).
#[derive(Debug, Clone)]
pub struct RemoteAgentMessageTarget {
    pub host: Arc<RemoteAgentHost>,
    /// Whether the peer was reachable at the last scan.
    pub offline: bool,
    pub session_id: String,
    pub active_session_id: Option<String>,
    pub summary: Value,
}

/// Cross-machine delivery seam (TS `RemoteAgentMessageTransport`); the
/// transport layer implements it over the daemon's TCP wire.
pub trait RemoteAgentMessageTransport: Send + Sync {
    fn send_agent_message(
        &self,
        delivery: RemoteAgentMessageDelivery,
    ) -> futures::future::BoxFuture<'_, anyhow::Result<Value>>;
}

/// The delivery the transport seam receives (TS
/// `RemoteAgentMessageDelivery`).
#[derive(Debug, Clone)]
pub struct RemoteAgentMessageDelivery {
    pub host: Arc<RemoteAgentHost>,
    pub offline: bool,
    pub target: RemoteDeliveryTarget,
    pub message: String,
    pub sender: Option<Value>,
}

/// The remote row's addressing facts (TS
/// `RemoteAgentMessageDelivery["target"]`).
#[derive(Debug, Clone)]
pub struct RemoteDeliveryTarget {
    pub id: String,
    pub session_id: String,
    pub active_session_id: Option<String>,
    pub session_name: Option<String>,
}

/// The optional discovery-source seam.
pub type MeshSource = Option<Arc<dyn RemoteAgentMeshSource>>;
/// The optional cross-machine delivery seam.
pub type MeshTransport = Option<Arc<dyn RemoteAgentMessageTransport>>;
/// The roster-change callback (changed, removed ids).
pub type MeshRosterChange = Arc<dyn Fn(&[String], &[String]) + Send + Sync>;
/// The scan-failure callback.
pub type MeshScanError = Arc<dyn Fn(&anyhow::Error) + Send + Sync>;
/// The time source (ms since epoch).
pub type MeshNow = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The supervisor's mesh configuration (TS `RemoteAgentMeshOptions`):
/// the discovery source, the delivery transport, and the TTL bounds.
#[derive(Clone, Default)]
pub struct RemoteAgentMeshOptions {
    pub source: MeshSource,
    pub transport: MeshTransport,
    /// Minimum age before a scan may run again; roster queries share one
    /// scan (TS `refreshTtlMs`, default 30s).
    pub refresh_ttl: Option<Duration>,
    /// How long an unreachable peer's rows stay visible before being
    /// forgotten (TS `offlineTtlMs`, default 24h).
    pub offline_ttl: Option<Duration>,
    /// Roster change callback (changed, removed agent ids).
    pub on_roster_change: Option<MeshRosterChange>,
    /// Scan failure callback.
    pub on_scan_error: Option<MeshScanError>,
    /// Time source (ms since epoch) for tests.
    pub now: Option<MeshNow>,
}

impl std::fmt::Debug for RemoteAgentMeshOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteAgentMeshOptions")
            .field("source", &self.source.is_some())
            .field("transport", &self.transport.is_some())
            .field("refresh_ttl", &self.refresh_ttl)
            .field("offline_ttl", &self.offline_ttl)
            .finish_non_exhaustive()
    }
}

impl RemoteAgentMeshOptions {
    /// Build the options from a source and a transport.
    #[must_use]
    pub fn new(source: MeshSource, transport: MeshTransport) -> Self {
        RemoteAgentMeshOptions {
            source,
            transport,
            ..RemoteAgentMeshOptions::default()
        }
    }
}

/// Minimum scan age default (TS `DEFAULT_REMOTE_MESH_REFRESH_TTL_MS`).
const DEFAULT_REFRESH_TTL: Duration = Duration::from_secs(30);
/// Offline rows are kept so unreachable peers read "offline" instead of
/// vanishing, but a peer that stays gone is eventually forgotten: mesh
/// state must stay bounded when a tailnet churns through transient
/// devices (TS `DEFAULT_REMOTE_MESH_OFFLINE_TTL_MS`).
const DEFAULT_OFFLINE_TTL: Duration = Duration::from_hours(24);

/// A peer publishes its own session ids, so one id is only unique inside
/// one daemon. Roster ids and send checks namespace a remote row's ids
/// with its host; a row with no host is local and keeps the bare id (TS
/// `agentMeshIdentity`).
#[must_use]
pub fn agent_mesh_identity(tailnet_host: Option<&str>, session_id: &str) -> String {
    match tailnet_host.filter(|host| !host.is_empty()) {
        Some(host) => format!("remote:{host}#{session_id}"),
        None => session_id.to_string(),
    }
}

/// One host's cached state (TS `RemoteAgentMeshHostState`).
struct RemoteAgentMeshHostState {
    host: Arc<RemoteAgentHost>,
    offline: bool,
    /// Last scan that served a usable roster from this host; drives
    /// offline expiry.
    last_seen_at: u64,
    sessions: HashMap<String, RemoteAgentSessionSummary>,
}

struct MeshInner {
    hosts: HashMap<String, RemoteAgentMeshHostState>,
    entries: HashMap<String, AgentRosterEntry>,
    /// `None` until the first scan, so an epoch-0 clock cannot fake
    /// freshness (TS `lastScanAt`).
    last_scan_at: Option<u64>,
    /// Advances once per completed scan; concurrent refresh callers read
    /// it before and after their gate wait to report whether a scan
    /// completed for their call.
    scan_epoch: u64,
}

/// Supervisor-side cache of the last tailnet mesh scan (TS
/// `RemoteAgentMeshState`). The mesh never keeps a background loop:
/// [`RemoteAgentMeshState::refresh_if_stale`] runs at most once per TTL
/// when a roster consumer asks, coalescing concurrent queries onto the
/// single in-flight scan. Hosts that drop from a scan keep their last
/// known sessions, marked offline, so the agents view reads "offline"
/// instead of losing rows.
/// The shared mesh state (the scan task is detached: a caller that drops
/// its bounded wait never cancels the in-flight scan - TS
/// `refreshAwaiting`'s contract that a slow scan "completes in the
/// background as a roster push").
struct MeshShared {
    source: MeshSource,
    transport: MeshTransport,
    refresh_ttl: Duration,
    offline_ttl: Duration,
    on_roster_change: Option<MeshRosterChange>,
    on_scan_error: Option<MeshScanError>,
    now: MeshNow,
    inner: Mutex<MeshInner>,
    /// The single in-flight scan (detached): the scan task takes this
    /// gate, so a caller that arrives mid-scan joins its completion
    /// instead of starting a second one, and a caller that drops its
    /// wait releases only the wait - the scan keeps running.
    scan_gate: Arc<tokio::sync::Mutex<()>>,
    /// Broadcasts each completed scan's epoch: joiners of an in-flight
    /// scan wait on it (the task itself is not cancellable).
    scan_done: tokio::sync::broadcast::Sender<u64>,
}

pub struct RemoteAgentMeshState {
    shared: std::sync::Arc<MeshShared>,
}

impl RemoteAgentMeshState {
    /// Build the mesh state from the options.
    #[must_use]
    pub fn new(options: RemoteAgentMeshOptions) -> Self {
        let (scan_done, _) = tokio::sync::broadcast::channel(8);
        RemoteAgentMeshState {
            shared: std::sync::Arc::new(MeshShared {
                source: options.source,
                transport: options.transport,
                refresh_ttl: options.refresh_ttl.unwrap_or(DEFAULT_REFRESH_TTL),
                offline_ttl: options.offline_ttl.unwrap_or(DEFAULT_OFFLINE_TTL),
                on_roster_change: options.on_roster_change,
                on_scan_error: options.on_scan_error,
                now: options.now.unwrap_or_else(|| Arc::new(crate::util::now_ms)),
                inner: Mutex::new(MeshInner {
                    hosts: HashMap::new(),
                    entries: HashMap::new(),
                    last_scan_at: None,
                    scan_epoch: 0,
                }),
                scan_gate: Arc::new(tokio::sync::Mutex::new(())),
                scan_done,
            }),
        }
    }

    /// Whether a discovery source is configured (TS `enabled()`).
    #[must_use]
    pub fn enabled(&self) -> bool {
        self.shared.source.is_some()
    }

    fn now_ms(&self) -> u64 {
        (self.shared.now)()
    }

    fn ttl_fresh(&self, inner: &MeshInner) -> bool {
        match inner.last_scan_at {
            Some(last) => {
                self.now_ms().saturating_sub(last) < self.shared.refresh_ttl.as_millis() as u64
            }
            None => false,
        }
    }

    /// On-demand refresh bounded by the TTL (TS `refreshIfStale`).
    /// Concurrent callers share one scan: a caller that arrives inside
    /// the TTL returns without another, and a caller that arrives
    /// mid-scan joins the in-flight scan's completion (the scan itself is
    /// detached, so joining cannot cancel it). Returns whether a scan
    /// completed for this call.
    pub async fn refresh_if_stale(&self) -> bool {
        let Some(source) = self.shared.source.clone() else {
            return false;
        };
        let epoch_before = {
            let inner = self.shared.inner.lock().unwrap();
            if self.ttl_fresh(&inner) {
                return false;
            }
            inner.scan_epoch
        };
        // Become the scanner, or join the in-flight one. The gate is the
        // coalescing seam: a non-blocking take makes this caller spawn the
        // (detached) scan task; a held gate means one is already running
        // and this caller only waits for it.
        if let Ok(gate) = Arc::clone(&self.shared.scan_gate).try_lock_owned() {
            let shared = std::sync::Arc::clone(&self.shared);
            // The scan task is detached on purpose: a caller that
            // drops its bounded wait cancels only the WAIT - the scan
            // runs to completion and publishes (TS's
            // background-completion contract).
            tokio::spawn(async move {
                let _gate = gate;
                // Double-check the TTL inside the gate: a rival's scan
                // may have completed while this caller was spawned.
                let fresh = shared
                    .inner
                    .lock()
                    .is_ok_and(|inner| Self::ttl_fresh_shared(&shared, &inner));
                if !fresh {
                    Self::run_scan_shared(&shared, &source).await;
                }
            });
        }
        // Wait for the scan this call belongs to (its own, or the one it
        // joined): the epoch advances when the task completes.
        self.wait_for_scan(epoch_before).await
    }

    fn ttl_fresh_shared(shared: &MeshShared, inner: &MeshInner) -> bool {
        match inner.last_scan_at {
            Some(last) => {
                (shared.now)().saturating_sub(last) < shared.refresh_ttl.as_millis() as u64
            }
            None => false,
        }
    }

    /// Wait until the scan named by `epoch_before` completes: the epoch
    /// advance (published on the completion channel) ends the wait.
    async fn wait_for_scan(&self, epoch_before: u64) -> bool {
        let mut completions = self.shared.scan_done.subscribe();
        loop {
            {
                let inner = self.shared.inner.lock().unwrap();
                if inner.scan_epoch != epoch_before {
                    return true;
                }
            }
            match completions.recv().await {
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
            }
        }
    }

    /// On-demand refresh with a bounded wait (TS `refreshAwaiting`):
    /// callers answer with whatever the scan produced inside the budget,
    /// and a scan that outruns it KEEPS RUNNING - it lands as a roster
    /// push when it completes (the caller's dropped wait cancels nothing;
    /// the scan task is detached). The wait never starts a second scan.
    /// The wait timer is the select's sleep arm: it is dropped when the
    /// refresh settles first, so frequent polling retains no timer per
    /// request (the TS review round that cleared the race timer).
    pub async fn refresh_awaiting(&self, wait: Duration) {
        if !self.enabled() {
            return;
        }
        let refresh = self.refresh_if_stale();
        tokio::pin!(refresh);
        tokio::select! {
            _ = &mut refresh => {}
            () = tokio::time::sleep(wait) => {}
        }
    }

    /// Run one scan and publish its completion (the caller holds the scan
    /// gate).
    async fn run_scan_shared(shared: &MeshShared, source: &Arc<dyn RemoteAgentMeshSource>) -> bool {
        let hosts = match source.list_remote_agents().await {
            Ok(hosts) => hosts,
            Err(error) => {
                if let Some(on_scan_error) = &shared.on_scan_error {
                    on_scan_error(&error);
                }
                let mut inner = shared.inner.lock().unwrap();
                inner.last_scan_at = Some((shared.now)());
                let epoch = inner.scan_epoch + 1;
                inner.scan_epoch = epoch;
                let _ = shared.scan_done.send(epoch);
                return false;
            }
        };
        let mut inner = shared.inner.lock().unwrap();
        inner.last_scan_at = Some((shared.now)());
        let epoch = inner.scan_epoch + 1;
        inner.scan_epoch = epoch;
        shared.apply_scan(&mut inner, &hosts);
        let _ = shared.scan_done.send(epoch);
        true
    }
}

impl MeshShared {
    /// Apply one scan's hosts (TS `applyScan`): one row per host (a
    /// malformed duplicate never wins over a usable one), usable hosts
    /// replace their roster wholesale, dropped hosts keep their last known
    /// rows marked offline until the offline TTL forgets them, and a
    /// brand-new host's sessions seed its state.
    fn apply_scan(self: &MeshShared, inner: &mut MeshInner, hosts: &[RemoteAgentHost]) {
        let mut scanned: HashMap<String, RemoteAgentHost> = HashMap::new();
        for host in hosts {
            if host.tailnet_host.is_empty() {
                continue;
            }
            match scanned.get(&host.tailnet_host) {
                Some(previous) if previous.usable() || !host.usable() => {}
                _ => {
                    scanned.insert(host.tailnet_host.clone(), host.clone());
                }
            }
        }
        let now = (self.now)();
        let mut forget: Vec<String> = Vec::new();
        for (tailnet_host, state) in &mut inner.hosts {
            match scanned.get(tailnet_host) {
                Some(host) if host.usable() => {
                    state.host = Arc::new(host.clone());
                    state.offline = false;
                    state.last_seen_at = now;
                    state.sessions = merge_remote_sessions(&host.sessions);
                }
                _ => {
                    // Peer dropped, went daemon-less, or locked: keep the
                    // last known rows, marked offline, until the offline
                    // TTL forgets a long-gone peer.
                    state.offline = true;
                    if now.saturating_sub(state.last_seen_at) > self.offline_ttl.as_millis() as u64
                    {
                        forget.push(tailnet_host.clone());
                    }
                }
            }
        }
        for tailnet_host in forget {
            inner.hosts.remove(&tailnet_host);
        }
        for host in scanned.values() {
            if !host.usable() || inner.hosts.contains_key(&host.tailnet_host) {
                continue;
            }
            let sessions = merge_remote_sessions(&host.sessions);
            if sessions.is_empty() {
                continue;
            }
            inner.hosts.insert(
                host.tailnet_host.clone(),
                RemoteAgentMeshHostState {
                    host: Arc::new(host.clone()),
                    offline: false,
                    last_seen_at: now,
                    sessions,
                },
            );
        }
        self.publish_entries(inner);
    }

    /// Rebuild the roster entries and report the changed/removed ids (TS
    /// `publishEntries`). Entry objects are rebuilt each scan; they are
    /// compared structurally (JSON equality - the entries are small), so
    /// an identical roster row is not marked changed on every scan (the
    /// TS review round that stopped the roster churn).
    fn publish_entries(self: &MeshShared, inner: &mut MeshInner) {
        let mut entries = HashMap::new();
        for state in inner.hosts.values() {
            for session in state.sessions.values() {
                let agent_id =
                    agent_mesh_identity(Some(&state.host.tailnet_host), &session.session_id);
                entries.insert(agent_id, remote_agent_roster_entry(state, session));
            }
        }
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        for (agent_id, entry) in &entries {
            match inner.entries.get(agent_id) {
                Some(previous) => {
                    if previous != entry {
                        changed.push(agent_id.clone());
                    }
                }
                None => changed.push(agent_id.clone()),
            }
        }
        for agent_id in inner.entries.keys() {
            if !entries.contains_key(agent_id) {
                removed.push(agent_id.clone());
            }
        }
        inner.entries = entries;
        if !changed.is_empty() || !removed.is_empty() {
            if let Some(on_roster_change) = &self.on_roster_change {
                on_roster_change(&changed, &removed);
            }
        }
    }
}

impl RemoteAgentMeshState {
    /// The roster projection pushed to subscribed clients (TS
    /// `entriesForClients`). Remote mesh rows have no worker, so
    /// visibility is unconditional.
    pub fn entries_for_clients(&self) -> Vec<AgentRosterEntry> {
        self.shared
            .inner
            .lock()
            .unwrap()
            .entries
            .values()
            .cloned()
            .collect()
    }

    /// One entry by roster id (TS `entryById`).
    #[must_use]
    pub fn entry_by_id(&self, agent_id: &str) -> Option<AgentRosterEntry> {
        self.shared
            .inner
            .lock()
            .unwrap()
            .entries
            .get(agent_id)
            .cloned()
    }

    /// `list` response rows (TS `sessionSummaries`): the roster summaries.
    pub fn session_summaries(&self) -> Vec<Value> {
        self.shared
            .inner
            .lock()
            .unwrap()
            .entries
            .values()
            .map(|entry| entry.summary.clone())
            .collect()
    }

    /// Depth-0 peer rows for `list_agent_peers` (TS `peerSummaries`): the
    /// agent-message peer shape, with `remoteHost` so the worker-side
    /// family view labels them.
    pub fn peer_summaries(&self) -> Vec<Value> {
        self.shared
            .inner
            .lock()
            .unwrap()
            .entries
            .values()
            .map(|entry| {
                let summary = &entry.summary;
                let mut peer = json!({
                    "activeSessionId": summary
                        .get("activeSessionId")
                        .and_then(Value::as_str)
                        .or_else(|| summary.get("id").and_then(Value::as_str))
                        .unwrap_or_default(),
                    "sessionId": summary
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    "runtimeKind": summary
                        .get("runtimeKind")
                        .and_then(Value::as_str)
                        .unwrap_or("top-level"),
                    "cwd": summary.get("cwd").and_then(Value::as_str).unwrap_or_default(),
                    "isStreaming": summary
                        .get("isStreaming")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    "unfinishedActionCount": summary
                        .get("unfinishedActionCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    "rlmDepth": 0,
                    "status": status_of_entry(entry),
                });
                if let Some(name) = summary.get("sessionName").and_then(Value::as_str) {
                    peer["sessionName"] = json!(name);
                }
                if let Some(host) = summary.get("remoteHost").and_then(Value::as_str) {
                    peer["remoteHost"] = json!(host);
                }
                peer
            })
            .collect()
    }

    /// Resolve send targets by session id, active id, or name (TS
    /// `findMessageTargets`). Local rows always take precedence: this
    /// lookup is only consulted after local resolution fails, so remote
    /// rows never shadow or crowd local ones. Session names are unique
    /// per daemon, not per tailnet: callers must treat a two-match
    /// result as ambiguous exactly like the local path. Selector
    /// handling mirrors the local live-session path: an exact id or name
    /// wins, and the 12-character id a session table prints resolves by
    /// suffix, so a copied table id reaches a remote row the same way.
    #[must_use]
    pub fn find_message_targets(&self, selector: &str) -> Vec<RemoteAgentMessageTarget> {
        let inner = self.shared.inner.lock().unwrap();
        let rows: Vec<Value> = inner
            .entries
            .values()
            .map(|entry| entry.summary.clone())
            .collect();
        let exact: Vec<&Value> = rows
            .iter()
            .filter(|summary| {
                (summary.get("activeSessionId").and_then(Value::as_str) == Some(selector))
                    || (summary.get("sessionId").and_then(Value::as_str) == Some(selector))
                    || (summary.get("sessionName").and_then(Value::as_str) == Some(selector))
            })
            .collect();
        let matches: Vec<&Value> = if exact.is_empty() {
            rows.iter()
                .filter(|summary| {
                    let active = summary
                        .get("activeSessionId")
                        .or_else(|| summary.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let session = summary
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    matches_session_id_suffix(active, selector)
                        || matches_session_id_suffix(session, selector)
                })
                .collect()
        } else {
            exact
        };
        let mut targets = Vec::new();
        for summary in matches {
            let host_name = summary
                .get("remoteHost")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(state) = inner.hosts.get(host_name) else {
                continue;
            };
            targets.push(RemoteAgentMessageTarget {
                host: Arc::clone(&state.host),
                offline: state.offline,
                session_id: summary
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                active_session_id: summary
                    .get("activeSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                summary: summary.clone(),
            });
        }
        targets
    }

    /// Deliver through the cross-machine seam (TS `sendAgentMessage`);
    /// offline peers and missing transports fail loudly.
    ///
    /// # Errors
    ///
    /// Returns an error when no transport is configured (remote messaging
    /// unavailable) or the target's peer is offline - the loud failures
    /// the TS contract requires.
    pub async fn send_agent_message(
        &self,
        target: &RemoteAgentMessageTarget,
        message: &str,
        sender: Option<Value>,
    ) -> anyhow::Result<Value> {
        let Some(transport) = &self.shared.transport else {
            return Err(anyhow::anyhow!(
                "Cannot message the remote agent on {}: remote agent messaging is not available on this daemon",
                target.host.tailnet_host
            ));
        };
        if target.offline {
            return Err(anyhow::anyhow!(
                "Remote agent on {} is offline",
                target.host.tailnet_host
            ));
        }
        let session_name = target
            .summary
            .get("sessionName")
            .and_then(Value::as_str)
            .map(str::to_string);
        transport
            .send_agent_message(RemoteAgentMessageDelivery {
                host: Arc::clone(&target.host),
                offline: target.offline,
                target: RemoteDeliveryTarget {
                    id: target
                        .summary
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    session_id: target.session_id.clone(),
                    active_session_id: target.active_session_id.clone(),
                    session_name,
                },
                message: message.to_string(),
                sender,
            })
            .await
    }
}

/// The remote rows the agents view surfaces are depth-0 (TS
/// `isSurfaceRemoteSession`): their children have no locally resident
/// parents to nest under.
fn is_surface_remote_session(session: &RemoteAgentSessionSummary) -> bool {
    session.rlm_depth.unwrap_or(0) == 0
}

/// A usable scan fully replaces the host's roster; stale sessions must
/// not linger as ghosts. A row without a session id cannot be addressed;
/// a malformed peer never poisons the roster (TS `mergeRemoteSessions`).
fn merge_remote_sessions(
    sessions: &[RemoteAgentSessionSummary],
) -> HashMap<String, RemoteAgentSessionSummary> {
    let mut merged = HashMap::new();
    for session in sessions {
        if session.session_id.is_empty() || !is_surface_remote_session(session) {
            continue;
        }
        // Defensive dedupe: one row per session id per host.
        merged
            .entry(session.session_id.clone())
            .or_insert_with(|| session.clone());
    }
    merged
}

/// The roster summary of one remote session (TS `remoteSessionSummary`).
fn remote_session_summary(
    host: &RemoteAgentHost,
    session: &RemoteAgentSessionSummary,
    offline: bool,
) -> Value {
    let streaming = session.is_streaming;
    let is_session_active = streaming || session.activity == "working";
    // The remote daemon does not publish residency; "working" is the
    // closest truth. A remote session that is streaming or working but
    // publishes no active session id still classifies as running: its
    // own session id stands in as the residency identifier (the TS
    // review round that kept working remote rows out of the inactive
    // section).
    let residency_id = session.active_session_id.clone().or_else(|| {
        (streaming || session.activity == "working").then(|| session.session_id.clone())
    });
    let mut summary = json!({
        "id": session.id,
        "lifecycle": session.lifecycle,
        "activity": session.activity,
        "isSessionActive": is_session_active,
        "sessionId": session.session_id,
        "cwd": session.cwd,
        "isStreaming": streaming,
        "isCompacting": session.is_compacting.unwrap_or(false),
        "attachedClients": session.attached_clients,
        "messageCount": session.message_count,
        "rlmDepth": session.rlm_depth.unwrap_or(0),
        // Remote rows never carry local runtime identity; display
        // surfaces read remoteHost instead. The CLI table's structural
        // guard expects `sessionActions` on every summary row, so the
        // remote projection carries the neutral form (TS #2516
        // `sessionSummaryFromRosterEntry` fills the same neutral shape).
        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
        "remoteHost": host.tailnet_host,
        "rosterStatus": if offline {
            json!("inactive")
        } else {
            json!(classify_remote_status(residency_id.as_deref(), &session.activity, is_session_active))
        },
    });
    if let Some(active) = session.active_session_id.clone() {
        summary["activeSessionId"] = json!(active);
    }
    if let Some(name) = session.session_name.clone() {
        summary["sessionName"] = json!(name);
    }
    if let Some(model) = &session.model {
        summary["remoteModel"] = json!({ "provider": model.provider, "modelId": model.model_id });
    }
    if let Some(running_tools) = session.is_running_tools {
        summary["isRunningTools"] = json!(running_tools);
    }
    if let Some(kind) = &session.runtime_kind {
        summary["runtimeKind"] = json!(kind);
    }
    if let Some(created) = &session.created {
        summary["created"] = json!(created);
    }
    if let Some(modified) = &session.modified {
        summary["modified"] = json!(modified);
    }
    if let Some(last_activity) = &session.last_activity_at {
        summary["lastActivityAt"] = json!(last_activity);
    }
    if let Some(first_message) = &session.first_message {
        summary["firstMessage"] = json!(first_message);
    }
    if let Some(text) = &session.summary {
        summary["summary"] = json!(text);
    }
    if offline {
        summary["remoteOffline"] = json!(true);
    }
    summary
}

/// The roster classification of a remote session: running when resident
/// (an active id or the working/streaming fallback), idle when idle,
/// inactive otherwise (the shared `classifySessionRosterStatus` formula).
fn classify_remote_status(
    residency_id: Option<&str>,
    activity: &str,
    session_active: bool,
) -> &'static str {
    match (residency_id.is_some(), activity) {
        (true, "working") => "running",
        (true, "idle") if session_active => "running",
        (true, "idle") => "idle",
        _ => "inactive",
    }
}

/// The roster entry of one remote session (TS `remoteAgentRosterEntry`):
/// the agent id is host-scoped, and an unreachable peer reads "offline"
/// through the status label - the one channel the Activity column
/// renders, so an unreachable peer reads "offline" exactly like a
/// recovering worker.
fn remote_agent_roster_entry(
    state: &RemoteAgentMeshHostState,
    session: &RemoteAgentSessionSummary,
) -> AgentRosterEntry {
    let summary = remote_session_summary(&state.host, session, state.offline);
    let status = status_of_summary(&summary);
    AgentRosterEntry {
        agent_id: agent_mesh_identity(Some(&state.host.tailnet_host), &session.session_id),
        queued_child: None,
        seeded_cwd: None,
        summary,
        status,
        status_label: state.offline.then(|| "offline".to_string()),
        last_heard_from_at: None,
        worker_id: None,
        rest: Map::new(),
    }
}

/// The entry status from its summary (running/idle/inactive).
fn status_of_entry(entry: &AgentRosterEntry) -> pa_types::daemon::agent_roster::AgentRosterStatus {
    status_of_summary(&entry.summary)
}

fn status_of_summary(summary: &Value) -> pa_types::daemon::agent_roster::AgentRosterStatus {
    summary
        .get("rosterStatus")
        .and_then(Value::as_str)
        .and_then(|status| match status {
            "running" => Some(pa_types::daemon::agent_roster::AgentRosterStatus::Running),
            "idle" => Some(pa_types::daemon::agent_roster::AgentRosterStatus::Idle),
            "inactive" => Some(pa_types::daemon::agent_roster::AgentRosterStatus::Inactive),
            _ => None,
        })
        .unwrap_or(pa_types::daemon::agent_roster::AgentRosterStatus::Inactive)
}

/// `matchesSessionIdSuffix` (the shared id-suffix matcher, mirrored from
/// the CLI's session display ids): hex-suffix matching for short
/// selectors, so the 12-character id the session table prints resolves a
/// remote row the same way it resolves a local one.
fn matches_session_id_suffix(candidate: &str, suffix: &str) -> bool {
    let normalize = |id: &str| id.replace('-', "").to_lowercase();
    let normalized_candidate = normalize(candidate);
    let normalized_suffix = normalize(suffix);
    is_hex(&normalized_candidate)
        && is_hex(&normalized_suffix)
        && !normalized_suffix.is_empty()
        && normalized_candidate.ends_with(&normalized_suffix)
}

fn is_hex(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, name: Option<&str>) -> RemoteAgentSessionSummary {
        RemoteAgentSessionSummary {
            id: id.to_string(),
            session_id: id.to_string(),
            active_session_id: Some(format!("active-{id}")),
            session_name: name.map(str::to_string),
            lifecycle: "live".to_string(),
            activity: "idle".to_string(),
            is_streaming: false,
            is_running_tools: None,
            is_compacting: None,
            cwd: "/tmp".to_string(),
            model: Some(RemoteModel {
                provider: "test".to_string(),
                model_id: "model-x".to_string(),
            }),
            message_count: 3,
            attached_clients: 0,
            rlm_depth: Some(0),
            runtime_kind: Some("top-level".to_string()),
            created: None,
            modified: None,
            last_activity_at: None,
            first_message: None,
            summary: None,
        }
    }

    fn host(name: &str, sessions: Vec<RemoteAgentSessionSummary>) -> RemoteAgentHost {
        RemoteAgentHost {
            tailnet_host: name.to_string(),
            online: true,
            daemon: true,
            locked: None,
            error: None,
            port: Some(4700),
            hostname: None,
            sessions,
        }
    }

    /// A fake discovery source: the hosts it will report, and latches for
    /// how many scans ran.
    struct FakeSource {
        hosts: std::sync::Mutex<Vec<RemoteAgentHost>>,
        scans: std::sync::atomic::AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
    }

    impl FakeSource {
        fn new(hosts: Vec<RemoteAgentHost>) -> Arc<Self> {
            Arc::new(FakeSource {
                hosts: std::sync::Mutex::new(hosts),
                scans: std::sync::atomic::AtomicUsize::new(0),
                fail: std::sync::atomic::AtomicBool::new(false),
            })
        }
    }

    impl RemoteAgentMeshSource for FakeSource {
        fn list_remote_agents(
            &self,
        ) -> futures::future::BoxFuture<'_, anyhow::Result<Vec<RemoteAgentHost>>> {
            Box::pin(async {
                if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                    anyhow::bail!("scan failed");
                }
                self.scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(self.hosts.lock().unwrap().clone())
            })
        }
    }

    /// A fake transport: the receipts it delivers, latched per delivery.
    struct FakeTransport {
        deliveries: std::sync::Mutex<Vec<String>>,
    }

    impl FakeTransport {
        fn new() -> Arc<Self> {
            Arc::new(FakeTransport {
                deliveries: std::sync::Mutex::new(Vec::new()),
            })
        }
    }

    impl RemoteAgentMessageTransport for FakeTransport {
        fn send_agent_message(
            &self,
            delivery: RemoteAgentMessageDelivery,
        ) -> futures::future::BoxFuture<'_, anyhow::Result<Value>> {
            Box::pin(async move {
                self.deliveries.lock().unwrap().push(format!(
                    "{}:{}",
                    delivery.host.tailnet_host, delivery.target.session_id
                ));
                Ok(serde_json::json!({ "delivered": true }))
            })
        }
    }

    fn mesh_with(
        source: Option<Arc<dyn RemoteAgentMeshSource>>,
        transport: Option<Arc<dyn RemoteAgentMessageTransport>>,
    ) -> RemoteAgentMeshState {
        RemoteAgentMeshState::new(RemoteAgentMeshOptions::new(source, transport))
    }

    /// The roster-change callback latches changed/removed ids.
    #[derive(Default)]
    struct RosterLatch {
        changed: std::sync::Mutex<Vec<String>>,
        removed: std::sync::Mutex<Vec<String>>,
    }

    fn mesh_options_latched(
        source: Arc<dyn RemoteAgentMeshSource>,
        latch: &Arc<RosterLatch>,
    ) -> RemoteAgentMeshOptions {
        let latch = Arc::clone(latch);
        RemoteAgentMeshOptions {
            on_roster_change: Some(Arc::new(move |changed, removed| {
                latch
                    .changed
                    .lock()
                    .unwrap()
                    .extend(changed.iter().cloned());
                latch
                    .removed
                    .lock()
                    .unwrap()
                    .extend(removed.iter().cloned());
            })),
            ..RemoteAgentMeshOptions::new(Some(source), None)
        }
    }

    /// The host-scoped identity (TS `agentMeshIdentity`): a remote row's
    /// roster id carries its host namespace; a local row keeps the bare
    /// id.
    #[test]
    fn agent_mesh_identity_namespaces_by_host() {
        assert_eq!(
            agent_mesh_identity(Some("milk.tailnet.ts.net"), "sess-1"),
            "remote:milk.tailnet.ts.net#sess-1"
        );
        assert_eq!(agent_mesh_identity(None, "sess-1"), "sess-1");
        assert_eq!(agent_mesh_identity(Some(""), "sess-1"), "sess-1");
    }

    /// A scan seeds the entries (one usable host, two sessions), the
    /// summaries carry `remoteHost`, and the roster ids are
    /// host-scoped (TS `publishEntries`/`entriesForClients`).
    #[tokio::test]
    async fn scan_seeds_host_scoped_entries() {
        let source = FakeSource::new(vec![host(
            "milk.tailnet.ts.net",
            vec![session("s1", Some("worker")), session("s2", None)],
        )]);
        let mesh = mesh_with(Some(source), None);
        assert!(mesh.refresh_if_stale().await);
        let entries = mesh.entries_for_clients();
        assert_eq!(entries.len(), 2);
        let ids: Vec<&str> = entries
            .iter()
            .map(|entry| entry.agent_id.as_str())
            .collect();
        assert!(ids.contains(&"remote:milk.tailnet.ts.net#s1"), "{ids:?}");
        assert!(ids.contains(&"remote:milk.tailnet.ts.net#s2"), "{ids:?}");
        for entry in &entries {
            assert_eq!(entry.summary["remoteHost"], "milk.tailnet.ts.net");
            assert!(entry.summary["sessionActions"].is_object());
        }
    }

    /// A remote session that is working or streaming but publishes no
    /// active session id still classifies as running (the TS review fix:
    /// the fallback residency identifier keeps working rows out of the
    /// inactive section).
    #[tokio::test]
    async fn working_remote_row_without_active_id_classifies_running() {
        let mut working = session("w1", None);
        working.activity = "working".to_string();
        working.active_session_id = None;
        let source = FakeSource::new(vec![host("milk.tailnet.ts.net", vec![working])]);
        let mesh = mesh_with(Some(source), None);
        mesh.refresh_if_stale().await;
        let entries = mesh.entries_for_clients();
        assert_eq!(entries[0].summary["rosterStatus"], "running");
        assert_eq!(
            entries[0].status,
            pa_types::daemon::agent_roster::AgentRosterStatus::Running
        );
    }

    /// The refresh TTL (TS `refreshIfStale`): a second refresh inside the
    /// TTL does not run another scan; after the TTL it does.
    #[tokio::test]
    async fn refresh_if_stale_respects_the_ttl() {
        let source = FakeSource::new(vec![host("milk.tailnet.ts.net", vec![session("s1", None)])]);
        let scans = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counting = CountingSource {
            inner: Arc::clone(&source),
            scans: Arc::clone(&scans),
        };
        let mesh = RemoteAgentMeshState::new(RemoteAgentMeshOptions {
            refresh_ttl: Some(Duration::from_millis(100)),
            ..RemoteAgentMeshOptions::new(Some(Arc::new(counting)), None)
        });
        assert!(mesh.refresh_if_stale().await);
        assert!(!mesh.refresh_if_stale().await, "inside the TTL: no scan");
        assert_eq!(scans.load(std::sync::atomic::Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(mesh.refresh_if_stale().await, "past the TTL: a scan runs");
        assert_eq!(scans.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// Concurrent refreshes coalesce onto the one in-flight scan (TS's
    /// single-scan guarantee).
    #[tokio::test]
    async fn concurrent_refreshes_coalesce_onto_one_scan() {
        let source = FakeSource::new(vec![host("milk.tailnet.ts.net", vec![session("s1", None)])]);
        let mesh = mesh_with(Some(source.clone()), None);
        let (a, b) = tokio::join!(mesh.refresh_if_stale(), mesh.refresh_if_stale());
        assert!(a || b, "at least one scan completed");
        assert_eq!(
            source.scans.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "both callers shared one scan"
        );
    }

    /// A peer that drops from a scan keeps its rows, marked offline with
    /// the `offline` status label, until the offline TTL forgets it (TS
    /// `applyScan` + the running-status fix's context).
    #[tokio::test]
    async fn dropped_peer_keeps_its_rows_offline_until_the_ttl() {
        let source = FakeSource::new(vec![host(
            "milk.tailnet.ts.net",
            vec![session("s1", Some("worker"))],
        )]);
        let mesh = RemoteAgentMeshState::new(RemoteAgentMeshOptions {
            refresh_ttl: Some(Duration::ZERO),
            offline_ttl: Some(Duration::from_millis(100)),
            ..RemoteAgentMeshOptions::new(Some(source.clone()), None)
        });
        mesh.refresh_if_stale().await;
        // The peer drops from the next scan.
        *source.hosts.lock().unwrap() = Vec::new();
        mesh.refresh_if_stale().await;
        let entries = mesh.entries_for_clients();
        assert_eq!(entries.len(), 1, "the offline row survives the drop");
        assert_eq!(entries[0].status_label.as_deref(), Some("offline"));
        assert_eq!(entries[0].summary["remoteOffline"], true);
        // Past the offline TTL the long-gone peer is forgotten.
        tokio::time::sleep(Duration::from_millis(150)).await;
        mesh.refresh_if_stale().await;
        assert!(
            mesh.entries_for_clients().is_empty(),
            "the offline TTL forgets a long-gone peer"
        );
    }

    /// The roster-churn fix (TS's review round): an identical scan
    /// publishes nothing - entry objects are rebuilt each scan, but the
    /// comparison is structural, so an unchanged row is not marked
    /// changed.
    #[tokio::test]
    async fn identical_scan_publishes_nothing() {
        let source = FakeSource::new(vec![host("milk.tailnet.ts.net", vec![session("s1", None)])]);
        let latch = Arc::new(RosterLatch::default());
        let mesh = RemoteAgentMeshState::new(RemoteAgentMeshOptions {
            refresh_ttl: Some(Duration::ZERO),
            ..mesh_options_latched(source.clone(), &latch)
        });
        mesh.refresh_if_stale().await;
        mesh.refresh_if_stale().await;
        mesh.refresh_if_stale().await;
        assert_eq!(
            latch.changed.lock().unwrap().len(),
            1,
            "identical rows broadcast nothing after the first scan"
        );
        assert!(latch.removed.lock().unwrap().is_empty());
    }

    /// A changed row publishes its id; a removed row publishes its id in
    /// the removed batch (TS `publishEntries`).
    #[tokio::test]
    async fn changed_and_removed_rows_publish_their_ids() {
        let source = FakeSource::new(vec![
            host("a.tailnet.ts.net", vec![session("s1", None)]),
            host("b.tailnet.ts.net", vec![session("s2", None)]),
        ]);
        let latch = Arc::new(RosterLatch::default());
        let mesh = RemoteAgentMeshState::new(RemoteAgentMeshOptions {
            refresh_ttl: Some(Duration::ZERO),
            ..mesh_options_latched(source.clone(), &latch)
        });
        mesh.refresh_if_stale().await;
        assert_eq!(latch.changed.lock().unwrap().len(), 2);
        // b's host drops from the scan: its row transitions to offline (a
        // publish-worthy change, TS's offline retention), and a's row
        // renamed. A dropped peer's rows are REMOVED only when the
        // offline TTL forgets it.
        *source.hosts.lock().unwrap() = vec![host(
            "a.tailnet.ts.net",
            vec![session("s1", Some("renamed"))],
        )];
        mesh.refresh_if_stale().await;
        let changed = latch.changed.lock().unwrap().clone();
        assert_eq!(changed.len(), 4, "{changed:?}");
        assert!(
            changed.iter().any(|id| id == "remote:a.tailnet.ts.net#s1"),
            "{changed:?}"
        );
        assert!(
            changed.iter().any(|id| id == "remote:b.tailnet.ts.net#s2"),
            "the offline transition publishes the row: {changed:?}"
        );
        assert!(
            latch.removed.lock().unwrap().is_empty(),
            "a dropped peer keeps its rows until the offline TTL"
        );
    }

    /// `find_message_targets` mirrors the local selector: an exact id,
    /// active id, or name wins, and only then does the 12-character
    /// printed id resolve by suffix (TS #2516's review fix: the table's
    /// printed id must reach an unnamed remote row).
    #[tokio::test]
    async fn find_message_targets_exact_then_suffix() {
        let mut uuid_like = session("01a0cba2-1111-2222-3333-abcdef123456", None);
        uuid_like.session_id = "01a0cba2-1111-2222-3333-abcdef123456".to_string();
        uuid_like.active_session_id = None;
        let source = FakeSource::new(vec![host("milk.tailnet.ts.net", vec![uuid_like])]);
        let mesh = mesh_with(Some(source), None);
        mesh.refresh_if_stale().await;
        // The 12-character suffix the session table prints resolves.
        let targets = mesh.find_message_targets("abcdef123456");
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].session_id,
            "01a0cba2-1111-2222-3333-abcdef123456"
        );
        // A non-matching selector finds nothing.
        assert!(mesh.find_message_targets("nope").is_empty());
    }

    /// Name matching: two hosts owning the same name return two targets
    /// (names are unique per daemon, not per tailnet - callers treat a
    /// two-match result as ambiguous like the local path).
    #[tokio::test]
    async fn find_message_targets_names_can_be_ambiguous() {
        let source = FakeSource::new(vec![
            host("a.tailnet.ts.net", vec![session("s1", Some("worker"))]),
            host("b.tailnet.ts.net", vec![session("s2", Some("worker"))]),
        ]);
        let mesh = mesh_with(Some(source), None);
        mesh.refresh_if_stale().await;
        assert_eq!(mesh.find_message_targets("worker").len(), 2);
    }

    /// Delivery fails loudly: an offline target refuses with the offline
    /// error, and a missing transport refuses with the unavailable error
    /// (TS `sendAgentMessage`).
    #[tokio::test]
    async fn delivery_fails_loudly_for_offline_and_missing_transport() {
        let source = FakeSource::new(vec![host("milk.tailnet.ts.net", vec![session("s1", None)])]);
        let mesh = mesh_with(Some(source), None);
        mesh.refresh_if_stale().await;
        let mut targets = mesh.find_message_targets("s1");
        assert_eq!(targets.len(), 1);
        let target = targets.pop().unwrap();
        let error = mesh
            .send_agent_message(&target, "hi", None)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("remote agent messaging is not available"),
            "{error}"
        );

        // An offline target with a transport still installed refuses.
        let transport = FakeTransport::new();
        let mesh = RemoteAgentMeshState::new(RemoteAgentMeshOptions {
            ..RemoteAgentMeshOptions::new(Some(FakeSource::new(vec![])), Some(transport))
        });
        let offline_target = RemoteAgentMessageTarget {
            host: Arc::new(RemoteAgentHost {
                tailnet_host: "ghost.tailnet.ts.net".to_string(),
                ..RemoteAgentHost::default()
            }),
            offline: true,
            session_id: "s1".to_string(),
            active_session_id: None,
            summary: serde_json::json!({}),
        };
        let error = mesh
            .send_agent_message(&offline_target, "hi", None)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "Remote agent on ghost.tailnet.ts.net is offline");
    }

    /// A usable delivery reaches the transport with the remote row's
    /// addressing facts (TS `RemoteAgentMessageDelivery`).
    #[tokio::test]
    async fn delivery_reaches_the_transport() {
        let source = FakeSource::new(vec![host(
            "milk.tailnet.ts.net",
            vec![session("s1", Some("worker"))],
        )]);
        let transport = FakeTransport::new();
        let mesh = mesh_with(
            Some(source),
            Some(Arc::clone(&transport) as Arc<dyn RemoteAgentMessageTransport>),
        );
        mesh.refresh_if_stale().await;
        let mut targets = mesh.find_message_targets("worker");
        let target = targets.pop().unwrap();
        let receipt = mesh
            .send_agent_message(&target, "hi", Some(serde_json::json!({ "clientId": "c1" })))
            .await
            .unwrap();
        assert_eq!(receipt["delivered"], true);
        assert_eq!(
            transport.deliveries.lock().unwrap()[0],
            "milk.tailnet.ts.net:s1"
        );
    }

    /// `refresh_awaiting` bounds the wait: a slow scan cannot hold the
    /// caller past the budget (TS `refreshAwaiting`), and the wait never
    /// starts a second scan.
    #[tokio::test(start_paused = true)]
    async fn refresh_awaiting_bounds_the_wait() {
        struct SlowSource;
        impl RemoteAgentMeshSource for SlowSource {
            fn list_remote_agents(
                &self,
            ) -> futures::future::BoxFuture<'_, anyhow::Result<Vec<RemoteAgentHost>>> {
                Box::pin(async {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok(vec![host("milk.tailnet.ts.net", vec![session("s1", None)])])
                })
            }
        }
        let mesh = mesh_with(Some(Arc::new(SlowSource)), None);
        // The budget returns long before the 60s scan completes.
        tokio::time::timeout(Duration::from_secs(1), async {
            mesh.refresh_awaiting(Duration::from_millis(500)).await;
        })
        .await
        .expect("the bounded wait must return inside its budget");
    }

    /// A scan failure reports through the error callback and does not
    /// clear the existing rows (the last-known roster stays served).
    #[tokio::test]
    async fn scan_failure_keeps_last_known_rows() {
        let source = FakeSource::new(vec![host("milk.tailnet.ts.net", vec![session("s1", None)])]);
        let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let error_sink = Arc::clone(&errors);
        let mesh = RemoteAgentMeshState::new(RemoteAgentMeshOptions {
            refresh_ttl: Some(Duration::ZERO),
            on_scan_error: Some(Arc::new(move |error| {
                error_sink.lock().unwrap().push(error.to_string());
            })),
            ..RemoteAgentMeshOptions::new(Some(source.clone()), None)
        });
        mesh.refresh_if_stale().await;
        assert_eq!(mesh.entries_for_clients().len(), 1);
        source.fail.store(true, std::sync::atomic::Ordering::SeqCst);
        mesh.refresh_if_stale().await;
        assert_eq!(
            mesh.entries_for_clients().len(),
            1,
            "the scan failure keeps the last rows"
        );
        assert!(!errors.lock().unwrap().is_empty());
    }

    /// Peer summaries carry `remoteHost` and depth 0 (TS
    /// `peerSummaries`), and a subagent row never surfaces (depth-0
    /// remote rows only).
    #[tokio::test]
    async fn peer_summaries_carry_the_host_and_depth_zero() {
        let mut child = session("c1", None);
        child.rlm_depth = Some(1);
        let source = FakeSource::new(vec![host(
            "milk.tailnet.ts.net",
            vec![session("s1", None), child],
        )]);
        let mesh = mesh_with(Some(source), None);
        mesh.refresh_if_stale().await;
        let peers = mesh.peer_summaries();
        assert_eq!(peers.len(), 1, "depth-0 rows only");
        assert_eq!(peers[0]["remoteHost"], "milk.tailnet.ts.net");
        assert_eq!(peers[0]["rlmDepth"], 0);
    }

    /// A counting source wrapper for the TTL test (counts scans).
    struct CountingSource {
        inner: Arc<FakeSource>,
        scans: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl RemoteAgentMeshSource for CountingSource {
        fn list_remote_agents(
            &self,
        ) -> futures::future::BoxFuture<'_, anyhow::Result<Vec<RemoteAgentHost>>> {
            let scans = Arc::clone(&self.scans);
            let inner = Arc::clone(&self.inner);
            Box::pin(async move {
                scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                inner.list_remote_agents().await
            })
        }
    }
    /// The bounded wait cancels nothing (TS `refreshAwaiting`'s contract,
    /// the Bugbot round: "a scan that outruns [the budget] completes in
    /// the background as a roster push"): a slow first scan outlives its
    /// caller's budget, still applies, publishes, and marks the TTL
    /// fresh - the next caller NEVER rescans.
    #[tokio::test(start_paused = true)]
    async fn a_scan_that_outruns_the_budget_still_completes_in_the_background() {
        struct SlowSource {
            scans: std::sync::Arc<std::sync::atomic::AtomicUsize>,
            gate: tokio::sync::Mutex<()>,
        }
        impl RemoteAgentMeshSource for SlowSource {
            fn list_remote_agents(
                &self,
            ) -> futures::future::BoxFuture<'_, anyhow::Result<Vec<RemoteAgentHost>>> {
                Box::pin(async {
                    self.scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _gate = self.gate.lock().await;
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok(vec![host("milk.tailnet.ts.net", vec![session("s1", None)])])
                })
            }
        }
        let scans = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let source = Arc::new(SlowSource {
            scans: Arc::clone(&scans),
            gate: tokio::sync::Mutex::new(()),
        });
        let mesh = mesh_with(Some(source as Arc<dyn RemoteAgentMeshSource>), None);
        // The budget expires long before the 60s scan completes.
        mesh.refresh_awaiting(Duration::from_millis(500)).await;
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the slow scan is running (detached)"
        );
        assert!(
            mesh.entries_for_clients().is_empty(),
            "the budget returned before the scan applied"
        );
        // The background scan completes: the entries publish and the TTL
        // marks the scan fresh, so the next caller does NOT rescan.
        tokio::time::sleep(Duration::from_secs(70)).await;
        assert_eq!(
            mesh.entries_for_clients().len(),
            1,
            "the background scan applied"
        );
        let completed = mesh.refresh_if_stale().await;
        assert!(
            !completed,
            "the completed background scan made the TTL fresh"
        );
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the background completion is the ONE scan; no second scan runs"
        );
    }
}

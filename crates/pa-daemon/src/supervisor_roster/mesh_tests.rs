//! The supervisor's tailnet-mesh integration (TS #2516's review rounds,
//! each accepted finding pinned): the send fallback's saved-local
//! precedence and fail-closed catalog semantics, the reachable-only
//! ambiguity, the list opt-in, the peers refresh, the roster snapshot,
//! and the structural name-check isolation.
use std::sync::{Arc, Mutex};

use pa_types::daemon::DaemonCommand;
use serde_json::{json, Map, Value};

use crate::remote_mesh::{
    RemoteAgentHost, RemoteAgentMeshOptions, RemoteAgentMeshSource, RemoteAgentMessageDelivery,
    RemoteAgentMessageTransport, RemoteAgentSessionSummary,
};
use crate::supervisor::{Supervisor, SupervisorOptions};

use super::*;

fn remote_session(id: &str, name: Option<&str>) -> RemoteAgentSessionSummary {
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
        model: None,
        message_count: 1,
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

fn remote_host(name: &str, sessions: Vec<RemoteAgentSessionSummary>) -> RemoteAgentHost {
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

/// A fake discovery source with mutable hosts and a scan counter.
#[derive(Default)]
struct Source {
    hosts: Mutex<Vec<RemoteAgentHost>>,
    scans: std::sync::atomic::AtomicUsize,
}

impl RemoteAgentMeshSource for Source {
    fn list_remote_agents(
        &self,
    ) -> futures::future::BoxFuture<'_, anyhow::Result<Vec<RemoteAgentHost>>> {
        Box::pin(async {
            self.scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.hosts.lock().unwrap().clone())
        })
    }
}

/// A fake transport latching every delivery.
#[derive(Default)]
struct Transport {
    deliveries: Mutex<Vec<String>>,
}

impl RemoteAgentMessageTransport for Transport {
    fn send_agent_message(
        &self,
        delivery: RemoteAgentMessageDelivery,
    ) -> futures::future::BoxFuture<'_, anyhow::Result<Value>> {
        Box::pin(async move {
            self.deliveries.lock().unwrap().push(format!(
                "{}:{}",
                delivery.host.tailnet_host, delivery.target.session_id
            ));
            Ok(json!({ "delivered": true }))
        })
    }
}

fn mesh_supervisor(
    dir: &std::path::Path,
    source: Arc<Source>,
    transport: Arc<Transport>,
) -> Arc<Supervisor> {
    Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir: dir.join("agent"),
            tcp_port: None,
            tcp_bind_host: None,
            remote_agent_mesh: Some(RemoteAgentMeshOptions {
                // Tests drive stepwise scans; the TTL window itself is
                // pinned by the mesh unit tests.
                refresh_ttl: Some(std::time::Duration::ZERO),
                ..RemoteAgentMeshOptions::new(
                    Some(source as Arc<dyn RemoteAgentMeshSource>),
                    Some(transport as Arc<dyn RemoteAgentMessageTransport>),
                )
            }),
        })
        .expect("supervisor"),
    )
}

fn set_hosts(source: &Arc<Source>, hosts: Vec<RemoteAgentHost>) {
    *source.hosts.lock().unwrap() = hosts;
}

/// A registered-resident stub with the given worker token.
fn resident(worker_id: &str, token: &str) -> Arc<crate::registry::ResidentWorker> {
    use pa_types::daemon::{
        DaemonWorkerDescriptor, DaemonWorkerLifecycle, DurableDaemonCreateCommand,
    };
    crate::registry::ResidentWorker::new(
        worker_id.to_string(),
        DaemonWorkerDescriptor {
            version: 2,
            worker_id: worker_id.to_string(),
            pid: 1,
            process_start_id: None,
            socket_path: "/w.sock".to_string(),
            recovery_journal_path: "/w.jsonl".to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/s.sock".to_string(),
            authentication_token: token.to_string(),
            worker_instance_id: None,
            root_active_session_id: worker_id.to_string(),
            owner_client_id: None,
            root_session_id: None,
            session_file: None,
            session_dir: None,
            telemetry_disabled: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            lifecycle: DaemonWorkerLifecycle::Ready,
            create_command: DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Map::default(),
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        },
        std::path::PathBuf::from("/d.json"),
    )
}

fn send_command(target: &str) -> DaemonCommand {
    DaemonCommand::SendMessage {
        id: Some("m1".to_string()),
        target_active_session_id: target.to_string(),
        message: "hello".to_string(),
        from_active_session_id: None,
        agent_origin: None,
        delivery_mode: None,
        rest: Map::default(),
    }
}

/// A cold-cache send delivers to a remote sibling after the confirmed
/// local miss (TS #2516's cold-cache refresh fix: the send path
/// refreshes the mesh itself, never depending on an unrelated
/// `list` to warm the cache).
#[tokio::test]
async fn cold_cache_send_delivers_after_the_local_miss() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("r1", Some("worker"))],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    let response = supervisor
        .handle_send_message("m1", "cli-1", &send_command("worker"))
        .await;
    assert!(response.success, "{response:?}");
    assert_eq!(response.command, "send_message");
    assert_eq!(
        transport.deliveries.lock().unwrap()[0],
        "milk.tailnet.ts.net:r1"
    );
    assert!(
        source.scans.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "the send path refreshed the mesh itself"
    );
}

/// Saved-local precedence (TS #2516's review fix): a saved local
/// session sharing the remote sibling's name wakes (the local
/// worker resolution here) instead of the remote match intercepting
/// the message.
#[tokio::test]
async fn saved_local_wins_over_the_remote_match() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("r1", Some("worker"))],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    // A saved session named "worker", hosted by a registered resident:
    // the wake resolves the local file BEFORE the mesh is consulted.
    let sessions = crate::paths::sessions_dir(&supervisor.options.agent_dir).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    session.append_session_info("worker");
    let file = sessions.join(format!("{}.jsonl", session.session_id()));
    session.set_path(file.clone());
    session.rewrite().unwrap();
    let resident = resident("worker-host", "worker-host-token");
    {
        let mut descriptor = resident.descriptor.lock().await;
        descriptor.session_file = Some(file.to_string_lossy().to_string());
    }
    supervisor.registry.insert(resident).await;
    let response = supervisor
        .handle_send_message("m1", "cli-1", &send_command("worker"))
        .await;
    // The LOCAL resident serves the wake: the route fails with the
    // not-connected error (no live worker), proving the local target
    // won - a remote delivery would have answered success.
    assert!(!response.success, "{response:?}");
    assert_eq!(
        response.error.as_deref(),
        Some("Session worker is not connected"),
        "the saved local, not the remote match, received the send"
    );
    assert!(
        transport.deliveries.lock().unwrap().is_empty(),
        "no remote delivery may run while a local row matches"
    );
}

/// Two reachable remote matches stay ambiguous exactly like the local
/// path (TS #2516's review fix), but only after the saved-local wake
/// has missed - a saved local sharing the name wins first.
#[tokio::test]
async fn two_remote_matches_are_ambiguous_after_the_catalog_miss() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![
            remote_host(
                "a.tailnet.ts.net",
                vec![remote_session("r1", Some("worker"))],
            ),
            remote_host(
                "b.tailnet.ts.net",
                vec![remote_session("r2", Some("worker"))],
            ),
        ],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    let response = supervisor
        .handle_send_message("m1", "cli-1", &send_command("worker"))
        .await;
    assert!(!response.success, "{response:?}");
    assert_eq!(
        response.error.as_deref(),
        Some("Ambiguous active session: worker"),
        "two reachable remote matches are ambiguous like the local path"
    );
    assert!(transport.deliveries.lock().unwrap().is_empty());
}

/// The catalog's own failures fail closed (TS #2516's review fix):
/// an ambiguous saved selector's error outranks the mesh - no remote
/// delivery may run on a catalog outage or ambiguity.
#[tokio::test]
async fn catalog_ambiguity_fails_closed_before_the_mesh() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("r1", Some("twin"))],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    // Two saved sessions named "twin": the catalog's ambiguity error.
    let sessions = crate::paths::sessions_dir(&supervisor.options.agent_dir).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    for _ in 0..2 {
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        session.append_session_info("twin");
        session.set_path(sessions.join(format!("{}.jsonl", session.session_id())));
        session.rewrite().unwrap();
    }
    let response = supervisor
        .handle_send_message("m1", "cli-1", &send_command("twin"))
        .await;
    assert!(!response.success, "{response:?}");
    assert_eq!(
        response.error.as_deref(),
        Some("Ambiguous session selector \"twin\""),
        "the catalog's own error fails closed; the mesh is never consulted"
    );
    assert!(transport.deliveries.lock().unwrap().is_empty());
}

/// A ghost (offline retained) row must not veto a reachable sibling
/// that owns the same name (TS #2516's offline-ambiguity fix):
/// ambiguity is decided over reachable matches only, and the target
/// is the first reachable one.
#[tokio::test]
async fn ghost_row_does_not_veto_a_reachable_peer() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    // Host b drops from the scan later; both peers own "worker".
    set_hosts(
        &source,
        vec![
            remote_host(
                "a.tailnet.ts.net",
                vec![remote_session("r-live", Some("worker"))],
            ),
            remote_host(
                "b.tailnet.ts.net",
                vec![remote_session("r-ghost", Some("worker"))],
            ),
        ],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    supervisor.refresh_remote_mesh(Duration::ZERO).await;
    // b drops: its rows stay as ghosts (offline) while a stays usable.
    set_hosts(
        &source,
        vec![remote_host(
            "a.tailnet.ts.net",
            vec![remote_session("r-live", Some("worker"))],
        )],
    );
    supervisor
        .remote_mesh
        .as_ref()
        .unwrap()
        .refresh_awaiting(Duration::ZERO)
        .await;
    let response = supervisor
        .handle_send_message("m1", "cli-1", &send_command("worker"))
        .await;
    assert!(response.success, "{response:?}");
    assert_eq!(
        transport.deliveries.lock().unwrap()[0],
        "a.tailnet.ts.net:r-live",
        "the reachable peer receives the send, not the ghost"
    );
}

/// An all-offline selector fails loudly with the offline refusal (TS
/// #2516: an unreachable peer reads "offline" and the send names it).
#[tokio::test]
async fn all_offline_selector_fails_loudly() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "ghost.tailnet.ts.net",
            vec![remote_session("r1", Some("worker"))],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    supervisor.refresh_remote_mesh(Duration::ZERO).await;
    // The peer drops: its row stays as an offline ghost.
    set_hosts(&source, vec![]);
    supervisor
        .remote_mesh
        .as_ref()
        .unwrap()
        .refresh_awaiting(Duration::ZERO)
        .await;
    let response = supervisor
        .handle_send_message("m1", "cli-1", &send_command("worker"))
        .await;
    assert!(!response.success, "{response:?}");
    assert_eq!(
        response.error.as_deref(),
        Some("Remote agent on ghost.tailnet.ts.net is offline")
    );
    assert!(transport.deliveries.lock().unwrap().is_empty());
}

/// The self-send guard is host-scoped (TS #2516's review fix): a
/// peer publishing the same active id as the local sender is another
/// agent - the ids only collide inside one host.
#[tokio::test]
async fn self_send_guard_is_host_scoped() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("shared-id", None)],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    // The remote target's active id equals the local source's: with
    // host-scoped identities they are different agents, so the send
    // resolves (no "cannot target the sending session" refusal).
    let source_summary = json!({
        "activeSessionId": "active-shared-id",
        "sessionId": "local-sess",
        "runtimeKind": "top-level",
    });
    let target = supervisor
        .resolve_remote_send_target("active-shared-id", Some(&source_summary))
        .await
        .expect("the resolution must not refuse")
        .expect("the target must resolve");
    assert_eq!(target.session_id, "shared-id");
}

/// `list` is a local-residency response by default (TS #2516's review
/// fix: stale-daemon replacement and update-restart recovery must
/// never mistake a tailnet peer for a local session); the
/// `includeRemoteMesh` opt-in merges the mesh rows and drives the
/// refresh itself.
#[tokio::test]
async fn list_merges_remote_rows_only_behind_the_opt_in() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("r1", Some("worker"))],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    let plain = supervisor
        .handle_list("l1".into(), "list".into(), Some(true), None, None, false)
        .await;
    let sessions = plain.data.unwrap()["sessions"].as_array().unwrap().clone();
    assert!(
        sessions.is_empty(),
        "the default list serves local residency only"
    );
    assert_eq!(
        source.scans.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a plain list must not even scan the tailnet"
    );
    let merged = supervisor
        .handle_list("l2".into(), "list".into(), Some(true), None, None, true)
        .await;
    let sessions = merged.data.unwrap()["sessions"].as_array().unwrap().clone();
    assert_eq!(sessions.len(), 1, "the opt-in merges the remote row");
    assert_eq!(sessions[0]["remoteHost"], "milk.tailnet.ts.net");
    assert!(
        source.scans.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "the opt-in drives the refresh"
    );
    // Exactly once, not duplicated by the file-based merge arms.
    let merged_again = supervisor
        .handle_list("l3".into(), "list".into(), Some(true), None, None, true)
        .await;
    let again = merged_again.data.unwrap()["sessions"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(again.len(), 1, "the remote row appears once, not twice");
}

/// `list_agent_peers` refreshes the mesh itself on a budget that fits
/// the worker's request window (TS #2516's review fix), and the
/// remote peers join the local sibling lists with `remoteHost`.
#[tokio::test]
async fn list_agent_peers_refreshes_and_appends_remote_peers() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("r1", Some("worker"))],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    // The peers budget stays strictly below the shared worker request
    // timeout (the race the TS review round fixed).
    assert!(
        REMOTE_MESH_PEERS_REFRESH_WAIT.as_millis()
            < u128::from(crate::protocol::AGENT_PEER_LIST_REQUEST_TIMEOUT_MS),
        "the peers refresh must fit the worker's request window"
    );
    let requester = resident("peer-me", "peer-me-token");
    supervisor.registry.insert(requester).await;
    let command = DaemonCommand::ListAgentPeers {
        id: Some("p1".to_string()),
        worker_token: "peer-me-token".to_string(),
        rest: Map::default(),
    };
    let (lines, _) = supervisor
        .handle_list_agent_peers(&command, "p1", "list_agent_peers")
        .await;
    let peers = lines[0]["data"]["peers"].as_array().unwrap().clone();
    assert!(
        peers
            .iter()
            .any(|peer| peer["remoteHost"] == "milk.tailnet.ts.net"),
        "the remote peer joins the sibling list"
    );
    assert!(
        source.scans.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "the peers path refreshed the mesh itself"
    );
}

/// The roster snapshot includes the remote mesh rows (TS #2516's
/// `roster_subscribe` arm), and the mesh rows never enter the local
/// roster store - the structural isolation that keeps remote rows
/// out of the supervisor's local name-availability checks.
#[tokio::test]
async fn roster_snapshot_includes_remote_rows_and_the_store_stays_local() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("r1", Some("worker"))],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    supervisor.refresh_remote_mesh(Duration::ZERO).await;
    let response = supervisor
        .handle_roster_subscribe("rs1", "roster_subscribe")
        .await;
    let roster = response.data.unwrap()["roster"].as_array().unwrap().clone();
    assert!(
        roster
            .iter()
            .any(|entry| entry["agentId"] == "remote:milk.tailnet.ts.net#r1"),
        "the snapshot includes the host-scoped remote row"
    );
    // The structural name-check isolation (TS #2516's review fix: a
    // remote row can never make a local name look taken): the mesh
    // rows stay out of the supervisor's local roster store, which is
    // what the family name checks read.
    assert!(
        supervisor.roster.lock().unwrap().entries().is_empty(),
        "mesh rows never enter the local roster store"
    );
}

/// The mesh roster pushes ride the content-diff guard: an identical
/// remote row publishes nothing on the second push (the TS
/// roster-churn fix, inherited from the worker-row machinery).
#[tokio::test]
async fn mesh_roster_pushes_dedupe_identical_rows() {
    let source = Arc::new(Source::default());
    let transport = Arc::new(Transport::default());
    set_hosts(
        &source,
        vec![remote_host(
            "milk.tailnet.ts.net",
            vec![remote_session("r1", None)],
        )],
    );
    // The temp dir stays alive for the supervisor's agent dir.
    let dir = tempfile::TempDir::new().unwrap();
    let supervisor = mesh_supervisor(dir.path(), Arc::clone(&source), Arc::clone(&transport));
    supervisor.refresh_remote_mesh(Duration::ZERO).await;
    let entries = supervisor.remote_roster_entries();
    assert_eq!(entries.len(), 1);
    let mut events = supervisor.events.subscribe();
    let ids: Vec<String> = entries.iter().map(|entry| entry.agent_id.clone()).collect();
    supervisor.push_mesh_roster_update(&ids, Vec::new());
    let first = drain_roster_pushes(&mut events);
    assert_eq!(first.len(), 1, "the first push broadcasts");
    supervisor.push_mesh_roster_update(&ids, Vec::new());
    let second = drain_roster_pushes(&mut events);
    assert!(
        second.is_empty(),
        "an identical remote row broadcasts nothing"
    );
}

/// Drain the queued roster pushes from the broadcast ring.
type RosterEvent = (ClientRouting, Arc<Value>);

fn drain_roster_pushes(events: &mut tokio::sync::broadcast::Receiver<RosterEvent>) -> Vec<Value> {
    let mut pushes = Vec::new();
    while let Ok((_, payload)) = events.try_recv() {
        pushes.push((*payload).clone());
    }
    pushes
}

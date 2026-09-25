//! MCP catalog e2e: the `/mcp` view's daemon surface serves the RESOLVED
//! service catalog (the discovery rows the interactive view renders), the
//! paste flow installs a token service end-to-end through the real daemon,
//! and the disconnect removes it. The disk-cache path feeds the catalog (the
//! fetch lane writes its `mcp-service-catalog.v2.json` snapshot envelope; the
//! daemon reads the validated cache), and the pinned-definition hint gates on
//! that snapshot being in hand, with the linear/notion compiled fallback
//! covered by the pa-core verifiers.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The kernel Python with prime-agent-runtime installed; skipped (with a
/// note) on machines without a live install (the same gate as the
/// product-path e2e).
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {explicit:?} not found"
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(
        std::env::var("HOME")
            .map(|home| format!("{home}/.prime/agent/kernel-venv/bin/python"))
            .unwrap_or_else(|_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string()),
    );
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live MCP catalog e2e");
    None
}

/// The daemon e2e tests each supervise a daemon + a session worker;
/// serializing them keeps the harness out of parallel-spawn resource races.
static DAEMON_E2E: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        // The fetch lane is live in the supervisor now (startup + hourly
        // refreshes of this very cache file): PI_OFFLINE keeps those off
        // the network so a live fetch can never race the cache state this
        // test arranges on disk (the same posture as the model-catalog
        // e2e; the daemon serves the arranged cache directly).
        .env("PI_OFFLINE", "1")
        // The tests own catalog availability through the agent dir alone;
        // a stray package dir's bundled snapshot must never leak in.
        .env_remove("PI_PACKAGE_DIR")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    Daemon {
        child,
        socket: socket.to_path_buf(),
    }
}

fn wait_socket_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).is_ok() {
            return;
        }
        assert!(Instant::now() < deadline, "supervisor socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: Value) {
        self.send(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_mins(2);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse response line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(4);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    /// Graceful supervisor stop: the supervisor routes `shutdown` to its
    /// resident worker (no orphaned workers race the next daemon in the
    /// suite), then exits. The `Drop` SIGKILL stays as the safety net.
    fn shutdown_daemon(&mut self) {
        self.send_command("shutdown", json!({ "type": "shutdown" }));
        let _ = self.read_response("shutdown");
    }
}

/// TS parity (byte-exact, the daemon wire renders it on the card): the
/// pinned-definition hint, gated on a provable catalog snapshot.
const PINNED_FROM_RECORD_HINT: &str =
    "This service's catalog source is unavailable; its connection keeps the pinned definition.";

/// The REAL shipped catalog payload projected to the v2 client contract (the
/// same fixture the pa-core parity tests parse).
const REAL_CATALOG: &str = include_str!("../../pa-core/tests/fixtures/mcp/plugins-catalog.v2.json");

/// One extra pasteable service whose endpoint cannot resolve (the reserved
/// `invalid` TLD): the install's verification fails closed with the network
/// category instead of touching any real endpoint.
fn seeded_catalog_document() -> Value {
    let mut catalog: Value = serde_json::from_str(REAL_CATALOG).expect("fixture catalog parses");
    catalog["entries"]
        .as_array_mut()
        .expect("entries array")
        .push(json!({
            "server": "paste-fixture", "service": "paste-fixture",
            "label": "Paste Fixture", "url": "https://paste-fixture.invalid/mcp",
            "aliases": [],
            "transport": { "type": "http", "url": "https://paste-fixture.invalid/mcp" },
            "auth": { "strategy": "api_key", "clientRegistration": "unknown" },
            "setup": {
                "status": "requires-setup",
                "reason": "paste a fixture token",
                "fields": [
                    { "id": "FIXTURE_PAT_TOKEN", "label": "FIXTURE_PAT_TOKEN",
                      "required": true, "kind": "bearer-token",
                      "credentialSet": "fixture-pat" }
                ]
            },
            "verification": { "status": "unverified" },
            "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
        }));
    catalog
}

/// The fetch lane's disk form: the catalog document wrapped in the snapshot
/// envelope `{url, scope, fetchedAt, payload}` the cache reader validates
/// (a bare catalog document at the cache path never serves — proven by the
/// pa-core remote-source tests).
fn snapshot_envelope(payload: Value) -> String {
    serde_json::to_string(&json!({
        "url": pa_models::fetch::MCP_SERVICE_CATALOG_URL,
        "scope": pa_models::cache::PUBLIC_SCOPE,
        "fetchedAt": 1_790_082_036_135_u64,
        "payload": payload,
    }))
    .expect("serialize snapshot")
}

#[test]
fn catalog_surfaces_and_paste_installs_through_the_daemon() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _serial = DAEMON_E2E.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let sessions_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    // The validated disk cache: the fetch lane's snapshot envelope, read by
    // the daemon's catalog resolution (fail-closed parsing is covered in
    // pa-core).
    std::fs::write(
        agent_dir.join("mcp-service-catalog.v2.json"),
        snapshot_envelope(seeded_catalog_document()),
    )
    .expect("write disk cache");

    let socket = dir.path().join("mcp.sock");
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();

    // The resolved catalog surfaces: 69 service cards (the real 68 plus the
    // paste fixture), linear/notion reserved, the fixture row pasteable.
    client.send_command(
        "m1",
        json!({ "type": "get_mcp_connections", "activeSessionId": session_id }),
    );
    let roster = client.read_response("m1");
    assert_eq!(
        roster["success"], true,
        "get_mcp_connections failed: {roster}"
    );
    let services = roster["data"]["services"]
        .as_array()
        .unwrap_or_else(|| panic!("services array: {roster}"));
    assert_eq!(
        services.len(),
        69,
        "the resolved catalog surfaces: {services:?}"
    );
    let linear = services
        .iter()
        .find(|service| service["serviceId"] == "linear")
        .expect("linear discovery row");
    assert_eq!(linear["connectionStatus"], "not_connected");
    assert_eq!(
        linear["connectable"], true,
        "the metadata-reviewed OAuth builtin is connectable"
    );
    let paste = services
        .iter()
        .find(|service| service["serviceId"] == "paste-fixture")
        .expect("paste fixture row");
    assert_eq!(paste["connectionStatus"], "setup_required");
    assert_eq!(
        paste["pasteToken"], true,
        "the paste marker drives the paste panel"
    );
    let github = services
        .iter()
        .find(|service| service["serviceId"] == "github")
        .expect("github discovery row");
    assert_eq!(
        github["pasteToken"], true,
        "github is pasteable (alias pair)"
    );

    // The paste flow installs end-to-end: the credential is stored bound to
    // the service endpoint and a record is persisted; verification against
    // the unreachable endpoint fails closed with the network category.
    client.send_command(
        "p1",
        json!({
            "type": "set_mcp_static_token",
            "activeSessionId": session_id,
            "server": "paste-fixture",
            "token": "fixture-pasted-token",
        }),
    );
    let installed = client.read_response("p1");
    assert_eq!(
        installed["success"], true,
        "set_mcp_static_token failed: {installed}"
    );
    assert_eq!(
        installed["data"]["endpoint"],
        "https://paste-fixture.invalid/mcp"
    );
    assert_eq!(
        installed["data"]["verified"], false,
        "the unreachable endpoint never verifies"
    );
    assert!(
        installed["data"]["error"]
            .as_str()
            .is_some_and(|error| error != "credential-changed"),
        "a fixed network category, not a guard discard: {installed}"
    );
    // The credential: typed, bound to the endpoint (read from the auth file
    // the daemon and the kernel share).
    let auth: Value = serde_json::from_str(
        &std::fs::read_to_string(agent_dir.join("auth.json")).expect("auth.json"),
    )
    .expect("auth json");
    assert_eq!(auth["mcp:paste-fixture"]["type"], "mcp_static_token");
    assert_eq!(auth["mcp:paste-fixture"]["bearer"], "fixture-pasted-token");
    assert_eq!(
        auth["mcp:paste-fixture"]["endpoint"],
        "https://paste-fixture.invalid/mcp"
    );
    // The connection record: the durable endpoint pin.
    let records: Value = serde_json::from_str(
        &std::fs::read_to_string(agent_dir.join("mcp-connections.json"))
            .expect("mcp-connections.json"),
    )
    .expect("records json");
    let record = &records["connections"]["paste-fixture"];
    assert_eq!(record["serviceId"], "paste-fixture");
    assert_eq!(record["endpoint"], "https://paste-fixture.invalid/mcp");

    // The roster reflects the install: the service row now carries the
    // account (pending verification), and the connections roster lists it.
    client.send_command(
        "m2",
        json!({ "type": "get_mcp_connections", "activeSessionId": session_id }),
    );
    let roster = client.read_response("m2");
    let services = roster["data"]["services"]
        .as_array()
        .unwrap_or_else(|| panic!("services array: {roster}"));
    let paste = services
        .iter()
        .find(|service| service["serviceId"] == "paste-fixture")
        .expect("paste fixture row after install");
    assert_eq!(paste["connectionStatus"], "pending", "pending: {paste}");
    assert_eq!(
        paste["connectionIds"],
        json!(["paste-fixture"]),
        "the account id joins the view"
    );
    let connections = roster["data"]["connections"]
        .as_array()
        .expect("connections");
    assert!(
        connections
            .iter()
            .any(|connection| connection["server"] == "paste-fixture"),
        "the roster lists the installed connection: {connections:?}"
    );

    // The disconnect: the credential and the record leave together.
    client.send_command(
        "r1",
        json!({
            "type": "remove_mcp_connection",
            "activeSessionId": session_id,
            "server": "paste-fixture",
        }),
    );
    let removed = client.read_response("r1");
    assert_eq!(
        removed["success"], true,
        "remove_mcp_connection failed: {removed}"
    );
    let auth: Value = serde_json::from_str(
        &std::fs::read_to_string(agent_dir.join("auth.json")).expect("auth.json"),
    )
    .expect("auth json");
    assert!(
        auth.get("mcp:paste-fixture").is_none(),
        "the credential is gone: {auth}"
    );
    client.send_command(
        "m3",
        json!({ "type": "get_mcp_connections", "activeSessionId": session_id }),
    );
    let roster = client.read_response("m3");
    let services = roster["data"]["services"]
        .as_array()
        .unwrap_or_else(|| panic!("services array: {roster}"));
    let paste = services
        .iter()
        .find(|service| service["serviceId"] == "paste-fixture")
        .expect("paste fixture row after removal");
    assert_eq!(
        paste["connectionStatus"], "setup_required",
        "back to discovery: {paste}"
    );
    assert_eq!(
        paste["connectionIds"],
        json!([]),
        "no account after the disconnect"
    );
    client.shutdown_daemon();
}

/// The pinned-definition hint gating through the real daemon (Kevin's
/// dogfood report, TS parity): a connection record whose service left the
/// catalog shows the catalog-source hint ONLY when a validated snapshot is
/// in hand to prove that. With the cache gone and no packaged bundle (a
/// dev install, a cold box before the first fetch) the pinned row stays
/// manageable and is never one-click connectable, but no
/// source-unavailable claim: TS always has its catalog, so it never claims
/// absence it cannot prove.
#[test]
fn pinned_hint_needs_a_snapshot_to_claim_the_source_unavailable() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _serial = DAEMON_E2E.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // A fetched catalog that does NOT define the service, plus the durable
    // record the pin is built from.
    let cache = json!({
        "version": 2,
        "counts": {},
        "entries": [{
            "server": "cache-only", "service": "cache-only", "label": "Cache Only",
            "url": "https://cache-only.example/mcp", "aliases": [],
            "transport": { "type": "http", "url": "https://cache-only.example/mcp" },
            "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
            "setup": { "status": "ready" },
            "verification": { "status": "unverified" },
            "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
        }]
    });
    std::fs::write(
        agent_dir.join("mcp-service-catalog.v2.json"),
        snapshot_envelope(cache),
    )
    .expect("write disk cache");
    let record = json!({
        "version": 1,
        "connections": {
            "vanished-service": {
                "connectionId": "vanished-service",
                "serviceId": "vanished-service",
                "endpoint": "https://vanished.example/mcp",
                "label": "Vanished",
                "status": "pending",
                "createdAt": 1u64,
                "updatedAt": 1u64,
            }
        }
    });
    std::fs::write(agent_dir.join("mcp-connections.json"), record.to_string())
        .expect("write records");
    let cache_path = agent_dir.join("mcp-service-catalog.v2.json");

    // Cache present: the snapshot proves the service is gone — the hint
    // shows, byte-exact.
    {
        let socket = dir.path().join("cache-present.sock");
        let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
        wait_socket_ready(&socket);
        let (mut client, _hello) = Client::connect(&socket);
        let view = pinned_service_view(&mut client, dir.path(), "present");
        assert_eq!(
            view["connectionStatus"], "not_connected",
            "the pinned card: {view}"
        );
        assert_eq!(
            view["connectable"], false,
            "a pin is never one-click connectable: {view}"
        );
        assert_eq!(
            view["setupHint"].as_str(),
            Some(PINNED_FROM_RECORD_HINT),
            "the proven-vanished row carries the byte-exact TS hint: {view}"
        );
        client.shutdown_daemon();
    }

    // Cache absent (and no packaged bundle): the row stays, the claim does
    // not — the ordinary account hint is all the card says.
    std::fs::remove_file(&cache_path).expect("remove the cache");
    let socket = dir.path().join("cache-absent.sock");
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);
    let view = pinned_service_view(&mut client, dir.path(), "absent");
    client.shutdown_daemon();
    assert_eq!(
        view["connectionStatus"], "not_connected",
        "the pinned row stays manageable: {view}"
    );
    assert_eq!(
        view["connectable"], false,
        "still never one-click connectable: {view}"
    );
    assert_ne!(
        view["setupHint"].as_str(),
        Some(PINNED_FROM_RECORD_HINT),
        "no snapshot in hand means no source-unavailable claim: {view}"
    );
}

/// One pinned card off the daemon's `/mcp` roster: create a session, read
/// the service catalog, find the pinned row.
fn pinned_service_view(client: &mut Client, dir: &std::path::Path, id: &str) -> Value {
    client.send_command(
        &format!("c-{id}"),
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": dir.join("sessions").to_string_lossy(),
            },
        }),
    );
    let created = client.read_response(&format!("c-{id}"));
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    client.send_command(
        &format!("m-{id}"),
        json!({ "type": "get_mcp_connections", "activeSessionId": session_id }),
    );
    let roster = client.read_response(&format!("m-{id}"));
    assert_eq!(roster["success"], true, "get_mcp_connections: {roster}");
    roster["data"]["services"]
        .as_array()
        .unwrap_or_else(|| panic!("services array: {roster}"))
        .iter()
        .find(|service| service["serviceId"] == "vanished-service")
        .expect("pinned discovery row")
        .clone()
}

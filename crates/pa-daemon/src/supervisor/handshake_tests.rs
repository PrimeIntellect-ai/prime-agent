//! The worker-handshake boundary oracles (the launch-storm wedge class,
//! 2026-09-28): the handshake owns its channel privately until the auth
//! answer installs it for routing — the TS `pendingClient`/`worker.client`
//! boundary. Split from `tests.rs` at the file-size advisory (the worker
//! test mass precedent: one family per module).

use super::*;

/// A worker socket the test drives by hand: it stands in for the real
/// worker process on the far side of `connect_worker`'s connection, so
/// the oracles can hold the handshake at exact points and read exactly
/// what the supervisor put on the wire.
struct FakeWorkerSocket {
    // The listener is held (never used again) so the bound socket path
    // stays owned by the test for the connection's whole lifetime; the
    // listener itself is never read after the accept.
    #[allow(dead_code)]
    listener: Box<dyn pa_types::platform::transport::TransportListener>,
    read_half: Box<dyn pa_types::platform::transport::AsyncReadHalf>,
    write_half: Box<dyn pa_types::platform::transport::AsyncWriteHalf>,
}

async fn bind_fake_worker(
    socket_path: &Path,
) -> Box<dyn pa_types::platform::transport::TransportListener> {
    pa_types::platform::transport::bind_transport(socket_path)
        .await
        .expect("bind fake worker socket")
}

/// Accept the connection `connect_worker` dials (its probe already
/// succeeded), once the connect task is in flight.
async fn accept_fake_worker(
    listener: Box<dyn pa_types::platform::transport::TransportListener>,
) -> FakeWorkerSocket {
    let stream = listener.accept().await.expect("accept fake worker");
    let (read_half, write_half) = stream.split();
    FakeWorkerSocket {
        listener,
        read_half,
        write_half,
    }
}

/// Read the next private frame the supervisor sent (its header carries the
/// request id the test's answer must echo).
async fn read_supervisor_frame(socket: &mut FakeWorkerSocket) -> crate::framing::PrivateFrame {
    let mut reader = PrivateFrameReader::new(&mut socket.read_half, DEFAULT_PRIVATE_FRAME_LIMITS);
    reader
        .read_frame()
        .await
        .expect("the supervisor's frame")
        .expect("the connection stays open")
}

/// Answer one request the way the real worker does: the response frame
/// with the line-serialized [`DaemonResponse`] as its payload.
async fn answer_supervisor_frame(socket: &mut FakeWorkerSocket, request_id: &str, command: &str) {
    let payload = crate::protocol::response_line_bytes(&DaemonResponse {
        id: None,
        command: command.to_string(),
        success: true,
        data: Some(json!({ "capabilities": ["agent_roster"] })),
        error: None,
        error_info: None,
    });
    write_frame(
        &mut socket.write_half,
        &json!({
            "kind": "outbound",
            "requestId": request_id,
            "outboundType": "response",
        }),
        &payload,
        DEFAULT_PRIVATE_FRAME_LIMITS,
    )
    .await
    .expect("write the auth answer");
}

/// The handshake owns its channel privately until the auth answer proves
/// the connection (the TS `pendingClient` boundary): while the handshake
/// is in flight the resident has NO installed command channel — a
/// supervisor route that fires in that window fails fast with the
/// retryable not-connected error instead of racing the handshake onto the
/// unauthenticated connection.
#[tokio::test]
async fn handshake_channel_stays_private_until_auth_answers() {
    let dir = std::env::temp_dir().join(format!("pa-handshake-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket_path = dir.join("worker.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-handshake",
        "pid": 4242,
        "socketPath": socket_path.to_string_lossy(),
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "handshake-token",
        "rootActiveSessionId": "none",
        "createdAt": "2026-09-23T00:00:00Z",
        "updatedAt": "2026-09-23T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new(
        "w-handshake".to_string(),
        descriptor,
        dir.join("w-handshake.json"),
    );
    supervisor.registry.insert(Arc::clone(&resident)).await;

    let listener = bind_fake_worker(&socket_path).await;
    let connect = {
        let supervisor = Arc::clone(&supervisor);
        let resident = Arc::clone(&resident);
        tokio::spawn(async move {
            supervisor
                .connect_worker(&resident, worker_connect_deadline())
                .await
        })
    };
    let mut fake = accept_fake_worker(listener).await;
    // The handshake's auth frame is the FIRST thing on the wire.
    let frame = read_supervisor_frame(&mut fake).await;
    assert_eq!(frame.header.get("commandType"), Some(&json!("worker_auth")));

    // MID-HANDSHAKE (served-path): the resident has no routable channel.
    assert!(
        resident.cmd_tx.lock().await.is_none(),
        "the handshake channel is private until the auth answers"
    );

    // The auth answer installs the channel (the worker.client boundary).
    let request_id = frame
        .header
        .get("requestId")
        .and_then(Value::as_str)
        .expect("request id")
        .to_string();
    answer_supervisor_frame(&mut fake, &request_id, "worker_auth").await;
    connect
        .await
        .expect("the connect task lives")
        .expect("the handshake completes");
    assert!(
        resident.cmd_tx.lock().await.is_some(),
        "the answered handshake installs the channel for routing"
    );
}

/// The launch-storm wedge oracle (2026-09-28): a registration that lands
/// mid-handshake must not kill the launch. Pre-fix, the registration
/// path's roster refresh routed `get_state` onto the same unauthenticated
/// connection the launch's `worker_auth` was handshakeing on; the worker
/// answered the refresh as the failed unauthenticated FIRST command and
/// closed the connection, stranding the handshake for the whole connect
/// budget — a fully-healthy worker failing its launch "did not come up in
/// time" (a warm ~12.5% rate on the four-launch e2e storm). Served-path:
/// the wire carries EXACTLY the auth frame (no route rides the private
/// channel), the registration itself succeeds, and the launch completes.
#[tokio::test]
async fn a_mid_handshake_registration_cannot_kill_the_handshake() {
    let dir = std::env::temp_dir().join(format!("pa-wedge-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket_path = dir.join("worker.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-wedge",
        "pid": 4242,
        "socketPath": socket_path.to_string_lossy(),
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "wedge-token",
        "rootActiveSessionId": "none",
        "createdAt": "2026-09-23T00:00:00Z",
        "updatedAt": "2026-09-23T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new("w-wedge".to_string(), descriptor, dir.join("w-wedge.json"));
    supervisor.registry.insert(Arc::clone(&resident)).await;

    let listener = bind_fake_worker(&socket_path).await;
    let connect = {
        let supervisor = Arc::clone(&supervisor);
        let resident = Arc::clone(&resident);
        tokio::spawn(async move {
            supervisor
                .connect_worker(&resident, worker_connect_deadline())
                .await
        })
    };
    let mut fake = accept_fake_worker(listener).await;
    let frame = read_supervisor_frame(&mut fake).await;
    assert_eq!(frame.header.get("commandType"), Some(&json!("worker_auth")));
    let request_id = frame
        .header
        .get("requestId")
        .and_then(Value::as_str)
        .expect("request id")
        .to_string();

    // The registration lands while the handshake is still in flight — the
    // exact interleave that wedged the launch pre-fix.
    let command = DaemonCommand::WorkerRegister {
        id: None,
        active_session_id: "w-wedge".to_string(),
        session_id: None,
        socket_path: socket_path.to_string_lossy().to_string(),
        worker_instance_id: String::new(),
        token: "wedge-token".to_string(),
        pid: 4242,
        rest: Map::default(),
    };
    let response = supervisor
        .handle_worker_register("r1", "worker_register", &command)
        .await;
    assert!(
        response.success,
        "the mid-handshake registration itself succeeds: {response:?}"
    );
    assert!(
        resident.cmd_tx.lock().await.is_none(),
        "the registration installs no channel of its own"
    );

    // SERVED-PATH: the wire carries exactly the handshake — the
    // registration's roster refresh found no channel and skipped, so no
    // `get_state` raced the auth frame.
    let raced =
        tokio::time::timeout(Duration::from_millis(100), read_supervisor_frame(&mut fake)).await;
    assert!(
        raced.is_err(),
        "no route may ride the private handshake channel"
    );

    // The launch completes: the handshake answers and installs.
    answer_supervisor_frame(&mut fake, &request_id, "worker_auth").await;
    connect
        .await
        .expect("the connect task lives")
        .expect("the handshake survives the mid-flight registration");
    assert!(
        resident.cmd_tx.lock().await.is_some(),
        "the answered handshake installs the channel for routing"
    );
}

/// The install guard's TOCTOU pin (the Macroscope HIGH finding on the
/// first PR head): a stale connect that passed its epoch check before a
/// newer connection installed must never overwrite the newer channel —
/// the recheck happens under the channel lock, so the stale install is
/// dropped and the newer channel stays routable.
#[tokio::test]
async fn a_stale_epoch_never_overwrites_the_installed_channel() {
    let dir = std::env::temp_dir().join(format!("pa-install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-install",
        "pid": 0,
        "socketPath": "/tmp/none.sock",
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "install-token",
        "rootActiveSessionId": "none",
        "createdAt": "2026-09-23T00:00:00Z",
        "updatedAt": "2026-09-23T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new(
        "w-install".to_string(),
        descriptor,
        dir.join("w-install.json"),
    );
    let (newer_tx, mut newer_rx) =
        mpsc::channel::<WorkerRequest>(crate::backpressure::WORKER_INFLIGHT_CAPACITY);
    let (stale_tx, _stale_rx) =
        mpsc::channel::<WorkerRequest>(crate::backpressure::WORKER_INFLIGHT_CAPACITY);

    // The stale epoch is a real issued one: the superseded connect went
    // live first, before the newer connection superseded it (an epoch-0
    // oracle would also pass a guard that only rejects the never-issued
    // epoch, leaving the live stale interleaving unexercised).
    let stale_epoch = resident.note_connection_live();
    // The newer connection installs first; the stale connect's epoch is
    // now superseded.
    let newer_epoch = resident.note_connection_live();
    resident
        .install_command_channel(newer_epoch, newer_tx)
        .await;
    assert!(
        resident.cmd_tx.lock().await.is_some(),
        "the newer connection installs"
    );

    // The stale connect installs last (the TOCTOU window: its pre-lock
    // epoch check passed before the newer install) — under the lock the
    // recheck drops it, and the newer channel stays the routable one.
    resident
        .install_command_channel(stale_epoch, stale_tx)
        .await;
    let routed = {
        let cmd_tx = resident.cmd_tx.lock().await;
        cmd_tx
            .as_ref()
            .expect("the channel stays installed")
            .clone()
    };
    routed
        .send(WorkerRequest {
            request_id: "r1".to_string(),
            command_type: "get_state".to_string(),
            payload: json!({}),
        })
        .await
        .expect("the newer channel routes");
    let frame = tokio::time::timeout(Duration::from_secs(2), newer_rx.recv())
        .await
        .expect("the newer channel answers")
        .expect("the channel stays open");
    assert_eq!(frame.command_type, "get_state");
}

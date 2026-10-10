//! The worker-connection boundary oracles: the handshake owns its channel
//! privately until the auth answer installs it for routing — the TS
//! `pendingClient`/`worker.client` boundary — and a lost connection fails
//! its in-flight routes (one family per module).

use super::*;

/// A worker socket the test drives by hand: it stands in for the real worker on the
/// far side of `connect_worker`, so the oracles hold the handshake at exact points.
struct FakeWorkerSocket {
    // The listener is held so the bound socket path stays owned by the
    // test for the connection's whole lifetime.
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

/// A tombstoned stop's entire silent-peer authentication uses the strict
/// one-second budget, closes both transport halves, and drops its pending slot.
#[tokio::test]
async fn silent_peer_stop_auth_closes_socket_without_leaving_pending() {
    run_silent_peer_auth(false).await;
}

#[tokio::test]
async fn cancelled_auth_closes_socket_without_leaving_pending() {
    run_silent_peer_auth(true).await;
}

async fn run_silent_peer_auth(cancel_connect: bool) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = dir.path().join("worker.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir,
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
        "version": 2, "workerId": "w-silent", "pid": 4242,
        "socketPath": socket_path.to_string_lossy(),
        "recoveryJournalPath": "/tmp/none.jsonl", "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "silent-token", "rootActiveSessionId": "none",
        "createdAt": "2026-09-23T00:00:00Z", "updatedAt": "2026-09-23T00:00:00Z",
        "lifecycle": "ready", "createCommand": {}, "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new(
        "w-silent".to_string(),
        descriptor,
        dir.path().join("w-silent.json"),
    );
    let listener = bind_fake_worker(&socket_path).await;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(150);
    let connect = {
        let supervisor = Arc::clone(&supervisor);
        let resident = Arc::clone(&resident);
        tokio::spawn(async move {
            supervisor
                .connect_worker_for_stop(&resident, deadline)
                .await
        })
    };
    let mut fake = accept_fake_worker(listener).await;
    let frame = read_supervisor_frame(&mut fake).await;
    assert_eq!(frame.header.get("commandType"), Some(&json!("worker_auth")));
    if cancel_connect {
        connect.abort();
        assert!(connect.await.is_err(), "connect future must be cancelled");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !resident.pending.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled auth pending cleanup");
    } else {
        let result = tokio::time::timeout(Duration::from_secs(1), connect)
            .await
            .expect("strict deadline")
            .expect("join");
        assert!(result.is_err(), "silent peer must time out");
    }
    assert!(
        resident.pending.lock().await.is_empty(),
        "auth pending slot must be cleared"
    );
    let mut reader = PrivateFrameReader::new(&mut fake.read_half, DEFAULT_PRIVATE_FRAME_LIMITS);
    let closed = tokio::time::timeout(Duration::from_secs(1), reader.read_frame())
        .await
        .expect("peer must close promptly")
        .expect("clean EOF");
    assert!(closed.is_none(), "failed auth must close the socket");
}

/// A registration that lands mid-handshake must not kill the launch:
/// the registration's roster refresh routes onto its own authenticated
/// channel once the handshake installs it, while the handshake's
/// `worker_auth` keeps the unauthenticated connection to itself until
/// the answer arrives. Served-path:
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

    // The registration lands while the handshake is still in flight.
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

    // SERVED-PATH: the wire carries exactly the handshake — the refresh found no channel,
    // so no `get_state` raced the auth frame.
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

/// The install guard's TOCTOU pin: a stale connect that passed its
/// epoch check before a newer connection installed must never
/// overwrite the newer channel — the recheck happens under the channel
/// lock, so the stale install is dropped and the newer channel stays
/// routable.
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

    // The stale epoch is a real issued one (an epoch-0 oracle would pass a guard that
    // only rejects the never-issued epoch, leaving the live stale interleaving unexercised).
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

    // The stale connect installs last (the TOCTOU window: its pre-lock check passed
    // before the newer install) — under the lock the recheck drops it.
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

/// A lost worker connection fails its in-flight routes right away (TS
/// `notifyClosed` -> `rejectAll`): the reader drains the connection's reply
/// slots when the socket ends, so a route waiting on the worker's answer
/// cannot outlive the connection it was sent on.
#[tokio::test]
async fn a_lost_worker_connection_fails_its_in_flight_route() {
    let dir = std::env::temp_dir().join(format!("pa-lost-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket_path = dir.join("worker.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir,
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-lost",
        "pid": 4242,
        "socketPath": socket_path.to_string_lossy(),
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "lost-token",
        "rootActiveSessionId": "none",
        "createdAt": "2026-09-23T00:00:00Z",
        "updatedAt": "2026-09-23T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new("w-lost".to_string(), descriptor, dir.join("w-lost.json"));
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
    answer_supervisor_frame(&mut fake, &request_id, "worker_auth").await;
    connect
        .await
        .expect("the connect task lives")
        .expect("the handshake completes");

    // A turn-long route in flight on the live connection.
    let route = {
        let supervisor = Arc::clone(&supervisor);
        let resident = Arc::clone(&resident);
        tokio::spawn(async move {
            supervisor
                .route_command_typed(
                    &resident,
                    "prompt_and_wait",
                    json!({ "activeSessionId": "w-lost", "message": "go" }),
                    super::routing::WORKER_REQUEST_TIMEOUT_MS,
                    RouteAdmission::ClientRequest,
                )
                .await
        })
    };
    let frame = read_supervisor_frame(&mut fake).await;
    assert_eq!(
        frame.header.get("commandType"),
        Some(&json!("prompt_and_wait"))
    );
    drop(fake);
    let error = tokio::time::timeout(Duration::from_secs(5), route)
        .await
        .expect("the lost connection fails the in-flight route")
        .expect("the route task lives")
        .expect_err("the drained route fails");
    assert_eq!(error.to_string(), super::routing::WORKER_SOCKET_CLOSED);
}

/// A delayed authenticated answer cannot replace the native identity of a
/// newer connection or worker incarnation, even when the numeric PID is equal.
#[tokio::test]
async fn superseded_auth_never_overwrites_native_worker_identity() {
    for replace_instance in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("worker.sock");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir,
            })
            .unwrap(),
        );
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version":2, "workerId":"w-native", "pid":4242,
            "workerInstanceId":"original", "socketPath":socket_path.to_string_lossy(),
            "recoveryJournalPath":"/tmp/none.jsonl", "supervisorSocketPath":"/tmp/none.sock",
            "authenticationToken":"native-token", "rootActiveSessionId":"none",
            "createdAt":"2026-09-23T00:00:00Z", "updatedAt":"2026-09-23T00:00:00Z",
            "lifecycle":"ready", "createCommand":{}, "consecutiveFailures":0
        }))
        .unwrap();
        let resident = ResidentWorker::new(
            "w-native".to_string(),
            descriptor,
            dir.path().join("worker.json"),
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
        let frame = read_supervisor_frame(&mut fake).await;
        let request_id = frame
            .header
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap();
        let replacement =
            json!({"version":1,"workerInstanceId":"replacement","identity":[0,0,0,0,0,4242,0,8]});
        if replace_instance {
            let mut descriptor = resident.descriptor.lock().await;
            descriptor.worker_instance_id = Some("replacement".to_string());
            descriptor
                .rest
                .insert(crate::native_signal::KEY.to_string(), replacement.clone());
        } else {
            resident.note_connection_live();
        }
        let payload = crate::protocol::response_line_bytes(&DaemonResponse {
            id: None,
            command: "worker_auth".to_string(),
            success: true,
            data: Some(json!({"capabilities":[], "nativeSignalIdentity":{
                "version":1,"workerInstanceId":"original","identity":[0,0,0,0,0,4242,0,7]
            }})),
            error: None,
            error_info: None,
        });
        write_frame(
            &mut fake.write_half,
            &json!({"kind":"outbound","requestId":request_id,"outboundType":"response"}),
            &payload,
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .await
        .unwrap();
        let error = connect
            .await
            .unwrap()
            .expect_err("superseded auth must be rejected");
        assert!(error.to_string().contains("superseded"), "{error:#}");
        let descriptor = resident.descriptor.lock().await;
        assert_eq!(
            descriptor.rest.get(crate::native_signal::KEY),
            if replace_instance {
                Some(&replacement)
            } else {
                None
            }
        );
        assert!(resident.cmd_tx.lock().await.is_none());
    }
}

fn registration_adoption_fixture(
    persisted_pid: u64,
) -> (tempfile::TempDir, Arc<Supervisor>, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let socket_path = dir.path().join("worker.sock");
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        })
        .unwrap(),
    );
    let descriptor_path = supervisor.descriptor_dir.join("w-register.json");
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
        "version":2,"workerId":"w-register","pid":persisted_pid,
        "workerInstanceId":"planned","plannedLaunchInstanceId":"planned",
        "socketPath":socket_path.to_string_lossy(),
        "recoveryJournalPath":dir.path().join("journal.jsonl").to_string_lossy(),
        "supervisorSocketPath":supervisor.options.socket_path.to_string_lossy(),
        "authenticationToken":"register-token","rootActiveSessionId":"w-register",
        "createdAt":"now","updatedAt":"now","lifecycle":"starting",
        "createCommand":{},"consecutiveFailures":0,
        "nativeSignalIdentity":{"version":1,"workerInstanceId":"previous",
            "identity":[0,0,0,0,0,4242,0,7]}
    }))
    .unwrap();
    crate::descriptor::persist_worker(&descriptor_path, &descriptor).unwrap();
    (dir, supervisor, socket_path, descriptor_path)
}

fn adoption_registration(socket_path: &Path, token: &str, instance: &str) -> DaemonCommand {
    let pid = std::process::id();
    let mut rest = Map::default();
    rest.insert(
        crate::native_signal::KEY.to_string(),
        json!({
            "version":1,"workerInstanceId":instance,"identity":[0,0,0,0,0,pid,0,8]
        }),
    );
    DaemonCommand::WorkerRegister {
        id: None,
        active_session_id: "w-register".to_string(),
        session_id: None,
        socket_path: socket_path.to_string_lossy().to_string(),
        worker_instance_id: instance.to_string(),
        token: token.to_string(),
        pid: u64::from(pid),
        rest,
    }
}

/// A prelaunch record can contain the new incarnation with its old or
/// unassigned PID. Auth must bind to the registering live incarnation.
#[tokio::test]
async fn registration_adoption_authenticates_the_live_pid_before_persisting_authority() {
    for (persisted_pid, legacy_uuid_mismatch) in [(4242, false), (0, false), (4242, true)] {
        let (_dir, supervisor, socket_path, descriptor_path) =
            registration_adoption_fixture(persisted_pid);
        if legacy_uuid_mismatch {
            // Historical spawn generated a different env UUID; its durable
            // descriptor had no planned-launch provenance or native carrier.
            let mut descriptor: DaemonWorkerDescriptor =
                serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
            descriptor.worker_instance_id = Some("historical-disk-uuid".to_string());
            descriptor.rest.remove("plannedLaunchInstanceId");
            descriptor.rest.remove(crate::native_signal::KEY);
            crate::descriptor::persist_worker(&descriptor_path, &descriptor).unwrap();
        }
        let listener = bind_fake_worker(&socket_path).await;
        let command = adoption_registration(&socket_path, "register-token", "planned");
        let native = match &command {
            DaemonCommand::WorkerRegister { rest, .. } => rest[crate::native_signal::KEY].clone(),
            _ => unreachable!("registration fixture"),
        };
        let fake_peer =
            async {
                let mut fake = accept_fake_worker(listener).await;
                let auth = read_supervisor_frame(&mut fake).await;
                assert_eq!(auth.header.get("commandType"), Some(&json!("worker_auth")));
                // Temporary pre-auth binding must not publish process-stop authority.
                let pending: DaemonWorkerDescriptor =
                    serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
                assert_eq!(pending.pid, u64::from(std::process::id()));
                assert_eq!(pending.worker_instance_id.as_deref(), Some("planned"));
                assert!(!pending.rest.contains_key(crate::native_signal::KEY));
                let request_id = auth.header["requestId"].as_str().unwrap();
                let payload = crate::protocol::response_line_bytes(&DaemonResponse {
                    id: None,
                    command: "worker_auth".to_string(),
                    success: true,
                    data: Some(json!({"capabilities":[],"nativeSignalIdentity":native})),
                    error: None,
                    error_info: None,
                });
                write_frame(
                    &mut fake.write_half,
                    &json!({"kind":"outbound","requestId":request_id,"outboundType":"response"}),
                    &payload,
                    DEFAULT_PRIVATE_FRAME_LIMITS,
                )
                .await
                .unwrap();
                for _ in 0..2 {
                    let state = read_supervisor_frame(&mut fake).await;
                    assert_eq!(state.header.get("commandType"), Some(&json!("get_state")));
                    let request_id = state.header["requestId"].as_str().unwrap();
                    let payload = crate::protocol::response_line_bytes(&DaemonResponse {
                        id: None,
                        command: "get_state".to_string(),
                        success: true,
                        data: Some(json!({"activeSessionId":"w-register","agentId":"w-register"})),
                        error: None,
                        error_info: None,
                    });
                    write_frame(&mut fake.write_half,
                    &json!({"kind":"outbound","requestId":request_id,"outboundType":"response"}),
                    &payload, DEFAULT_PRIVATE_FRAME_LIMITS).await.unwrap();
                }
                fake
            };
        let (response, _fake) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(
                supervisor.handle_worker_register("registration", "worker_register", &command),
                fake_peer
            )
        })
        .await
        .expect("registration and its authenticated state pulls complete");
        assert!(
            response.success,
            "live registration must adopt: {response:?}"
        );
        let resident = supervisor.registry.get("w-register").await.unwrap();
        let descriptor = resident.descriptor.lock().await;
        assert_eq!(descriptor.pid, u64::from(std::process::id()));
        assert_eq!(descriptor.worker_instance_id.as_deref(), Some("planned"));
        assert_eq!(
            descriptor.rest.get(crate::native_signal::KEY),
            Some(&native)
        );
        let persisted: DaemonWorkerDescriptor =
            serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
        assert_eq!(persisted.pid, descriptor.pid);
        assert_eq!(persisted.rest.get(crate::native_signal::KEY), Some(&native));
        assert!(resident.cmd_tx.lock().await.is_some());
    }
}

#[tokio::test]
async fn registration_adoption_refuses_wrong_token_or_instance_before_dialing() {
    for (token, instance) in [("wrong-token", "planned"), ("register-token", "unexpected")] {
        let (_dir, supervisor, socket_path, descriptor_path) = registration_adoption_fixture(4242);
        let listener = bind_fake_worker(&socket_path).await;
        let before = std::fs::read(&descriptor_path).unwrap();
        let command = adoption_registration(&socket_path, token, instance);
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            supervisor.handle_worker_register("registration", "worker_register", &command),
        )
        .await
        .expect("invalid registration must refuse before auth");
        assert!(!response.success, "invalid registration was accepted");
        assert_eq!(std::fs::read(&descriptor_path).unwrap(), before);
        assert!(supervisor.registry.get("w-register").await.is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "invalid registration must never dial the worker"
        );
    }
}

/// Planning a launch publishes a roster generation even though registration
/// later sees the same descriptor instance; failed writes publish neither.
#[tokio::test]
async fn planned_launch_and_registration_fence_predecessor_roster_frames() {
    let (dir, supervisor, socket_path, _) = registration_adoption_fixture(4242);
    let blocked = dir.path().join("blocked");
    std::fs::write(&blocked, b"not a directory").unwrap();
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
        "version":2,"workerId":"w-register","pid":4242,
        "workerInstanceId":"previous","socketPath":socket_path.to_string_lossy(),
        "recoveryJournalPath":dir.path().join("journal.jsonl").to_string_lossy(),
        "supervisorSocketPath":supervisor.options.socket_path.to_string_lossy(),
        "authenticationToken":"register-token","rootActiveSessionId":"w-register",
        "createdAt":"now","updatedAt":"now","lifecycle":"ready",
        "createCommand":{},"consecutiveFailures":0
    }))
    .unwrap();
    let resident = ResidentWorker::new(
        "w-register".to_string(),
        descriptor,
        blocked.join("worker.json"),
    );
    supervisor.registry.insert(Arc::clone(&resident)).await;
    supervisor
        .roster
        .lock()
        .unwrap()
        .note_worker_generation("w-register", "previous");
    assert!(supervisor
        .prepare_worker_spawn(&resident, "planned", TempSync::Synced)
        .await
        .is_err());
    {
        let mut roster = supervisor.roster.lock().unwrap();
        assert!(roster.accept_roster_pull("w-register", "previous", Some(9)));
        assert!(!roster.accept_delta_sequence("w-register", "planned", 10));
    }
    std::fs::remove_file(&blocked).unwrap();
    std::fs::create_dir(&blocked).unwrap();
    supervisor
        .prepare_worker_spawn(&resident, "planned", TempSync::Synced)
        .await
        .unwrap();
    {
        let mut roster = supervisor.roster.lock().unwrap();
        assert!(!roster.accept_delta_sequence("w-register", "previous", 10));
        assert!(!roster.accept_roster_pull("w-register", "previous", Some(10)));
        assert!(roster.accept_delta_sequence("w-register", "planned", 7));
    }
    // The real registration handler must preserve the planned generation's
    // watermark even though it now matches the prepublished descriptor.
    let command = DaemonCommand::WorkerRegister {
        id: None,
        active_session_id: "w-register".to_string(),
        session_id: None,
        socket_path: socket_path.to_string_lossy().to_string(),
        worker_instance_id: "planned".to_string(),
        token: "register-token".to_string(),
        pid: 4243,
        rest: Map::default(),
    };
    let response = supervisor
        .handle_worker_register("register", "worker_register", &command)
        .await;
    assert!(
        response.success,
        "planned registration failed: {response:?}"
    );
    {
        let mut roster = supervisor.roster.lock().unwrap();
        assert!(!roster.accept_roster_pull("w-register", "planned", Some(6)));
        assert!(!roster.accept_delta_sequence("w-register", "previous", 100));
        assert!(roster.accept_roster_pull("w-register", "planned", Some(8)));
    }
}

/// A queued predecessor registration cannot undo the incarnation already
/// published by a planned launch, even when it still knows the worker token.
#[tokio::test]
async fn known_resident_registration_keeps_planned_identity_and_roster_watermark() {
    let (_dir, supervisor, socket_path, descriptor_path) = registration_adoption_fixture(4242);
    let planned = adoption_registration(&socket_path, "register-token", "planned");
    let native = match &planned {
        DaemonCommand::WorkerRegister { rest, .. } => rest[crate::native_signal::KEY].clone(),
        _ => unreachable!("registration fixture"),
    };
    let mut descriptor: DaemonWorkerDescriptor =
        serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
    descriptor.pid = u64::from(std::process::id());
    descriptor.process_start_id = crate::protocol::process_start_id(std::process::id());
    descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
    descriptor
        .rest
        .insert(crate::native_signal::KEY.to_string(), native.clone());
    crate::descriptor::persist_worker(&descriptor_path, &descriptor).unwrap();
    let before = descriptor.clone();
    let before_bytes = std::fs::read(&descriptor_path).unwrap();
    let resident = ResidentWorker::new(
        "w-register".to_string(),
        descriptor,
        descriptor_path.clone(),
    );
    supervisor.registry.insert(Arc::clone(&resident)).await;
    {
        let mut roster = supervisor.roster.lock().unwrap();
        roster.note_worker_generation("w-register", "planned");
        assert!(roster.accept_delta_sequence("w-register", "planned", 7));
    }

    let mut predecessor = adoption_registration(&socket_path, "register-token", "previous");
    match &mut predecessor {
        DaemonCommand::WorkerRegister { pid, rest, .. } => {
            *pid = 4242;
            rest.insert(
                crate::native_signal::KEY.to_string(),
                json!({
                    "version":1,"workerInstanceId":"previous","identity":[0,0,0,0,0,4242,0,7]
                }),
            );
        }
        _ => unreachable!("registration fixture"),
    }
    let refused = supervisor
        .handle_worker_register("predecessor", "worker_register", &predecessor)
        .await;
    assert!(!refused.success, "queued predecessor must be refused");
    assert_eq!(*resident.descriptor.lock().await, before);
    assert_eq!(std::fs::read(&descriptor_path).unwrap(), before_bytes);
    assert!(resident.cmd_tx.lock().await.is_none());
    {
        let mut roster = supervisor.roster.lock().unwrap();
        assert!(!roster.accept_delta_sequence("w-register", "previous", 100));
        assert!(!roster.accept_delta_sequence("w-register", "planned", 7));
        assert!(roster.accept_roster_pull("w-register", "planned", Some(7)));
    }

    for _ in 0..2 {
        let accepted = supervisor
            .handle_worker_register("planned", "worker_register", &planned)
            .await;
        assert!(
            accepted.success,
            "planned registration failed: {accepted:?}"
        );
        assert_eq!(*resident.descriptor.lock().await, before);
        assert_eq!(std::fs::read(&descriptor_path).unwrap(), before_bytes);
        assert_eq!(
            resident
                .descriptor
                .lock()
                .await
                .rest
                .get(crate::native_signal::KEY),
            Some(&native)
        );
        assert!(resident.cmd_tx.lock().await.is_none());
        let mut roster = supervisor.roster.lock().unwrap();
        assert!(!roster.accept_delta_sequence("w-register", "previous", 100));
        assert!(!roster.accept_delta_sequence("w-register", "planned", 7));
        assert!(roster.accept_roster_pull("w-register", "planned", Some(7)));
    }
}

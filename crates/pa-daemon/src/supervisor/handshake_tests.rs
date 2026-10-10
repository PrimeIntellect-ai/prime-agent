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

#[tokio::test]
async fn self_registered_replacement_keeps_its_authenticated_channel_ready() {
    run_self_registered_replacement(true).await;
}

#[tokio::test]
async fn self_registered_replacement_without_created_session_stays_closed() {
    run_self_registered_replacement(false).await;
}

async fn run_self_registered_replacement(created_session: bool) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = dir.path().join("replacement.sock");
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
        "version": 2,
        "workerId": "w-adopt-replacement",
        "pid": std::process::id(),
        "socketPath": socket_path.to_string_lossy(),
        "recoveryJournalPath": dir.path().join("worker.recovery.jsonl").to_string_lossy(),
        "supervisorSocketPath": dir.path().join("daemon.sock").to_string_lossy(),
        "authenticationToken": "replacement-token",
        "workerInstanceId": "old-instance",
        "rootActiveSessionId": "w-adopt-replacement",
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    crate::descriptor::persist_worker(
        &supervisor.descriptor_dir.join("w-adopt-replacement.json"),
        &descriptor,
    )
    .expect("persist predecessor descriptor");
    let listener = bind_fake_worker(&socket_path).await;
    let command = DaemonCommand::WorkerRegister {
        id: None,
        active_session_id: "w-adopt-replacement".into(),
        session_id: Some("session-1".into()),
        socket_path: socket_path.to_string_lossy().to_string(),
        worker_instance_id: "new-instance".into(),
        token: "replacement-token".into(),
        pid: u64::from(std::process::id()),
        rest: Map::default(),
    };
    let registration = {
        let supervisor = Arc::clone(&supervisor);
        tokio::spawn(async move {
            supervisor
                .handle_worker_register("register-1", "worker_register", &command)
                .await
        })
    };
    let mut fake = accept_fake_worker(listener).await;
    for expected in ["worker_auth", "get_state", "get_state"] {
        let frame = read_supervisor_frame(&mut fake).await;
        assert_eq!(frame.header["commandType"], json!(expected));
        let request_id = frame.header["requestId"].as_str().expect("request id");
        if expected == "worker_auth" {
            answer_supervisor_frame(&mut fake, request_id, expected).await;
        } else {
            let summary = if created_session {
                json!({
                    "id": "w-adopt-replacement",
                    "activeSessionId": "w-adopt-replacement",
                    "sessionId": "session-1",
                    "sessionFile": dir.path().join("session-1.jsonl").to_string_lossy(),
                    "workerInstanceId": "new-instance",
                    "lifecycle": "live",
                    "workerState": "ready",
                })
            } else {
                json!({
                    "id": "w-adopt-replacement",
                    "activeSessionId": "w-adopt-replacement",
                    "workerInstanceId": "new-instance",
                    "workerState": "ready",
                })
            };
            let response = DaemonResponse {
                id: None,
                command: expected.into(),
                success: true,
                data: Some(summary),
                error: None,
                error_info: None,
            };
            write_frame(
                &mut fake.write_half,
                &json!({
                    "kind": "outbound",
                    "requestId": request_id,
                    "outboundType": "response",
                }),
                &crate::protocol::response_line_bytes(&response),
                DEFAULT_PRIVATE_FRAME_LIMITS,
            )
            .await
            .expect("answer live state");
        }
    }
    let response = registration.await.expect("registration task");
    assert_eq!(response.success, created_session, "registration proof: {response:?}");
    let resident = supervisor
        .registry
        .get("w-adopt-replacement")
        .await
        .expect("adopted resident");
    assert_eq!(resident.route_state().session_ready, created_session);
    assert_eq!(
        resident.descriptor.lock().await.worker_instance_id.as_deref(),
        Some("new-instance")
    );
    if !created_session {
        assert_eq!(resident.registration_handoff().as_deref(), Some("new-instance"));
        return;
    }
    let routed = {
        let supervisor = Arc::clone(&supervisor);
        let resident = Arc::clone(&resident);
        tokio::spawn(async move {
            supervisor
                .route_command_ready_typed(
                    &resident,
                    "get_state",
                    json!({}),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::ClientRequest,
                )
                .await
        })
    };
    let frame = read_supervisor_frame(&mut fake).await;
    assert_eq!(frame.header["commandType"], json!("get_state"));
    let request_id = frame.header["requestId"].as_str().expect("request id");
    answer_supervisor_frame(&mut fake, request_id, "get_state").await;
    assert!(routed.await.expect("route task").expect("ready route").success);
}

#[tokio::test]
async fn known_resident_replacement_reopens_only_on_authenticated_channel() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = dir.path().join("replacement.sock");
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
        "version": 2,
        "workerId": "w-known-replacement",
        "pid": 4242,
        "socketPath": socket_path.to_string_lossy(),
        "recoveryJournalPath": dir.path().join("worker.recovery.jsonl").to_string_lossy(),
        "supervisorSocketPath": dir.path().join("daemon.sock").to_string_lossy(),
        "authenticationToken": "replacement-token",
        "workerInstanceId": "old-instance",
        "rootActiveSessionId": "w-known-replacement",
        "rootSessionId": "session-1",
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new(
        "w-known-replacement".into(),
        descriptor,
        dir.path().join("w-known-replacement.json"),
    );
    let (old_tx, mut old_rx) = mpsc::channel::<WorkerRequest>(1);
    *resident.cmd_tx.lock().await = Some(old_tx);
    resident.note_connection_live();
    resident.note_session_ready();
    supervisor.registry.insert(Arc::clone(&resident)).await;
    let listener = bind_fake_worker(&socket_path).await;
    let command = DaemonCommand::WorkerRegister {
        id: None,
        active_session_id: "w-known-replacement".into(),
        session_id: Some("session-1".into()),
        socket_path: socket_path.to_string_lossy().to_string(),
        worker_instance_id: "new-instance".into(),
        token: "replacement-token".into(),
        pid: 4242,
        rest: Map::default(),
    };
    let retry_command = command.clone();
    let registration = {
        let supervisor = Arc::clone(&supervisor);
        tokio::spawn(async move {
            supervisor
                .handle_worker_register("register-1", "worker_register", &command)
                .await
        })
    };
    let mut fake = accept_fake_worker(listener).await;
    let auth = read_supervisor_frame(&mut fake).await;
    assert_eq!(auth.header["commandType"], json!("worker_auth"));
    assert!(!resident.route_state().session_ready);
    assert!(old_rx.try_recv().is_err());
    // First auth fails. The held generation must remain fenced and the
    // worker's retry must reauthenticate even though its ID is unchanged.
    write_frame(
        &mut fake.write_half,
        &json!({
            "kind": "outbound",
            "requestId": auth.header["requestId"],
            "outboundType": "response",
        }),
        &crate::protocol::response_line_bytes(&DaemonResponse {
            id: None,
            command: "worker_auth".into(),
            success: false,
            data: None,
            error: Some("refused once".into()),
            error_info: None,
        }),
        DEFAULT_PRIVATE_FRAME_LIMITS,
    )
    .await
    .expect("reject first auth");
    assert!(!registration.await.expect("first registration task").success);
    assert!(!resident.route_state().session_ready);
    assert_eq!(resident.registration_handoff().as_deref(), Some("new-instance"));
    let retry = {
        let supervisor = Arc::clone(&supervisor);
        tokio::spawn(async move {
            supervisor
                .handle_worker_register("register-2", "worker_register", &retry_command)
                .await
        })
    };
    let stream = fake.listener.accept().await.expect("retry worker connection");
    let (read_half, write_half) = stream.split();
    fake.read_half = read_half;
    fake.write_half = write_half;
    let auth = read_supervisor_frame(&mut fake).await;
    assert_eq!(auth.header["commandType"], json!("worker_auth"));
    answer_supervisor_frame(
        &mut fake,
        auth.header["requestId"].as_str().expect("retry auth id"),
        "worker_auth",
    )
    .await;
    let state = read_supervisor_frame(&mut fake).await;
    assert_eq!(state.header["commandType"], json!("get_state"));
    let response = DaemonResponse {
        id: None,
        command: "get_state".into(),
        success: true,
        data: Some(json!({
            "id": "w-known-replacement",
            "activeSessionId": "w-known-replacement",
            "sessionId": "session-1",
            "sessionFile": dir.path().join("session-1.jsonl").to_string_lossy(),
            "workerInstanceId": "new-instance",
            "lifecycle": "live",
            "workerState": "ready",
        })),
        error: None,
        error_info: None,
    };
    write_frame(
        &mut fake.write_half,
        &json!({
            "kind": "outbound",
            "requestId": state.header["requestId"],
            "outboundType": "response",
        }),
        &crate::protocol::response_line_bytes(&response),
        DEFAULT_PRIVATE_FRAME_LIMITS,
    )
    .await
    .expect("answer live state");
    let registered = retry.await.expect("retry registration task");
    assert!(registered.success, "registration succeeds: {registered:?}");
    assert!(resident.route_state().session_ready);
    assert!(resident.registration_handoff().is_none());
    let routed = {
        let supervisor = Arc::clone(&supervisor);
        let resident = Arc::clone(&resident);
        tokio::spawn(async move {
            supervisor
                .route_command_ready_typed(
                    &resident,
                    "get_state",
                    json!({}),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::ClientRequest,
                )
                .await
        })
    };
    let frame = read_supervisor_frame(&mut fake).await;
    assert_eq!(frame.header["commandType"], json!("get_state"));
    assert!(old_rx.try_recv().is_err());
    answer_supervisor_frame(
        &mut fake,
        frame.header["requestId"].as_str().expect("route id"),
        "get_state",
    )
    .await;
    assert!(routed.await.expect("route task").expect("ready route").success);
}

#[tokio::test]
async fn session_created_registration_during_replay_preserves_the_create_reply() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
        "version": 2,
        "workerId": "w-replay-register",
        "pid": 4242,
        "socketPath": dir.path().join("worker.sock").to_string_lossy(),
        "recoveryJournalPath": dir.path().join("worker.recovery.jsonl").to_string_lossy(),
        "supervisorSocketPath": dir.path().join("daemon.sock").to_string_lossy(),
        "authenticationToken": "replay-token",
        "workerInstanceId": "replay-instance",
        "rootActiveSessionId": "w-replay-register",
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new(
        "w-replay-register".into(),
        descriptor,
        dir.path().join("w-replay-register.json"),
    );
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<WorkerRequest>(1);
    *resident.cmd_tx.lock().await = Some(cmd_tx);
    resident.note_connection_live();
    // Session readiness remains closed until the in-flight create replies.
    let (create_reply, _create_waiter) = tokio::sync::oneshot::channel();
    resident
        .pending
        .lock()
        .await
        .insert("create-in-flight".into(), create_reply);
    supervisor.registry.insert(Arc::clone(&resident)).await;
    let command = DaemonCommand::WorkerRegister {
        id: None,
        active_session_id: "w-replay-register".into(),
        session_id: Some("session-1".into()),
        socket_path: dir.path().join("worker.sock").to_string_lossy().to_string(),
        worker_instance_id: "replay-instance".into(),
        token: "replay-token".into(),
        pid: 4242,
        rest: Map::default(),
    };
    let registration = {
        let supervisor = Arc::clone(&supervisor);
        tokio::spawn(async move {
            supervisor
                .handle_worker_register("register-1", "worker_register", &command)
                .await
        })
    };
    let request = cmd_rx.recv().await.expect("existing channel handles state pull");
    assert_eq!(request.command_type, "get_state");
    assert!(resident.pending.lock().await.contains_key("create-in-flight"));
    let reply = resident
        .pending
        .lock()
        .await
        .remove(&request.request_id)
        .expect("state pull reply slot");
    assert!(reply
        .send(WorkerReply::Typed(crate::protocol::response_success(
            None,
            "get_state",
            Some(json!({
                "id": "w-replay-register",
                "activeSessionId": "w-replay-register",
                "sessionId": "session-1",
                "workerInstanceId": "replay-instance",
                "lifecycle": "live",
                "workerState": "ready",
            })),
        )))
        .is_ok());
    assert!(registration.await.expect("registration task").success);
    assert!(resident.pending.lock().await.contains_key("create-in-flight"));
    assert!(!resident.route_state().session_ready);
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

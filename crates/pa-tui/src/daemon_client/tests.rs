use super::*;
use serde_json::json;
use tokio::net::UnixListener;

/// Minimal scripted supervisor used by client tests: hello on connect,
/// canned responses keyed by command type.
async fn spawn_mock_daemon(listener: UnixListener) {
    let (stream, _) = listener.accept().await.expect("accept");
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let hello = json!({
        "type": "daemon_hello",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "clientId": "srv",
        "serverCapabilities": [],
    });
    let mut line = serde_json::to_string(&hello).unwrap();
    line.push('\n');
    writer.write_all(line.as_bytes()).await.unwrap();
    let mut seen = String::new();
    loop {
        seen.clear();
        match reader.read_line(&mut seen).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let envelope: Value = serde_json::from_str(seen.trim()).unwrap();
        let id = envelope["id"].as_str().unwrap().to_string();
        let command_type = envelope["command"]["type"].as_str().unwrap();
        if command_type == "prompt" {
            // Stream an event before the response, like the real worker.
            let event = json!({
                "type": "session_event",
                "activeSessionId": "s1",
                "event": { "type": "turn_end" },
            });
            let mut payload = serde_json::to_string(&event).unwrap();
            payload.push('\n');
            writer.write_all(payload.as_bytes()).await.unwrap();
        }
        let response = json!({
            "type": "response",
            "id": id,
            "command": command_type,
            "success": true,
            "data": { "ok": true },
        });
        let mut payload = serde_json::to_string(&response).unwrap();
        payload.push('\n');
        writer.write_all(payload.as_bytes()).await.unwrap();
    }
}

fn empty_prompt_input() -> pa_types::daemon::PromptInput {
    pa_types::daemon::PromptInput {
        content: None,
        images: None,
        streaming_behavior: None,
        queue_if_busy: None,
        expand_prompt_templates: None,
        source: None,
        agent_message_id: None,
        custom_message: None,
        queue_key: None,
        prefix_messages: None,
        admission_id: None,
        rlm_notice_nonce: None,
    }
}

#[tokio::test]
async fn handshake_and_request_round_trip() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("d.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move { spawn_mock_daemon(listener).await });

    let (client, mut events) = DaemonClient::connect(&socket).await.unwrap();
    assert_eq!(client.protocol().version, 7);
    let data = client
        .request_ok(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        })
        .await
        .unwrap();
    assert_eq!(data["ok"], true);

    // A session event frames arrives out of band, ahead of its response.
    client
        .request_ok(DaemonCommand::Prompt {
            id: None,
            active_session_id: "s1".to_string(),
            message: "hi".to_string(),
            input: empty_prompt_input(),
            rest: Map::default(),
        })
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            event,
            DaemonClientEvent::SessionEvent { ref event, .. } if event["type"] == "turn_end"
        ),
        "unexpected event: {event:?}"
    );
    client.close();
}

#[tokio::test]
async fn request_timeout_reports_socket() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("d.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    // A daemon that sends hello but never answers commands.
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut writer = stream;
        let mut hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "clientId": "srv",
            "serverCapabilities": [],
        })
        .to_string();
        hello.push('\n');
        writer.write_all(hello.as_bytes()).await.unwrap();
        std::future::pending::<()>().await;
    });
    let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
    let error = client
        .request_with_timeout(
            DaemonCommand::List {
                id: None,
                all: None,
                cwd: None,
                session_dir: None,
                include_client_owned: None,
                rest: Map::default(),
            },
            100,
        )
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("Timed out after"),
        "unexpected error: {error}"
    );
    assert!(error
        .to_string()
        .contains(socket.display().to_string().as_str()));
    // A transport failure is never a rejection.
    assert!(!is_daemon_rejection(&error));
}

#[tokio::test]
async fn a_request_after_the_reader_died_refuses_instead_of_riding_the_budget() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("d.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    // A daemon that greets, then drops the socket: the client's reader
    // task ends and its close-time failure pass runs.
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut writer = stream;
        let mut hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "clientId": "srv",
            "serverCapabilities": [],
        })
        .to_string();
        hello.push('\n');
        writer.write_all(hello.as_bytes()).await.unwrap();
        drop(writer);
    });
    let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
    // Observable readiness: wait for the reader's death watch before
    // sending (the failure pass has run by then, so the request would
    // register after it — the exact race the refusal closes).
    let mut reader_dead = client.reader_dead();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !*reader_dead.borrow_and_update() {
            reader_dead
                .changed()
                .await
                .expect("the death watch stays live");
        }
    })
    .await
    .expect("the reader death watch fires when the socket closes");
    // A request budget far beyond the refusal bound: without the
    // refusal the send would ride it out and this await would outlive
    // the one-second failure bound.
    let error = tokio::time::timeout(
        Duration::from_secs(1),
        client.request_with_timeout(
            DaemonCommand::List {
                id: None,
                all: None,
                cwd: None,
                session_dir: None,
                include_client_owned: None,
                rest: Map::default(),
            },
            30_000,
        ),
    )
    .await
    .expect("a dead reader refuses the send instead of riding the budget")
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("the daemon connection is closed"),
        "unexpected error: {error}"
    );
    assert!(error
        .to_string()
        .contains(socket.display().to_string().as_str()));
    // The refusal is a transport failure: transient for the submit
    // path (the pane stays mounted for the reconnect driver), never
    // a daemon rejection.
    assert!(is_daemon_unreachable(&error));
    assert!(!is_daemon_rejection(&error));
}

#[test]
fn failed_response_is_a_typed_rejection() {
    let response = DaemonResponse {
        id: None,
        command: "prompt".to_string(),
        success: false,
        data: None,
        error: Some("Prompt cannot be empty".to_string()),
        error_info: None,
    };
    let error = response_data_or_error("prompt", response).unwrap_err();
    assert!(is_daemon_rejection(&error));
    let rejection = error
        .downcast_ref::<RequestRejected>()
        .expect("typed rejection");
    assert_eq!(rejection.command, "prompt");
    assert_eq!(rejection.message, "Prompt cannot be empty");
    // The rendered message is byte-identical to the pre-typed string.
    assert_eq!(
        rejection.to_string(),
        "the daemon rejected the prompt request: Prompt cannot be empty"
    );
}

#[test]
fn model_catalog_changed_parses_to_the_refresh_event() {
    // The worker's broadcast frame parses into the refresh event:
    // unknown payloads stay None, this one never drops silently.
    let value = json!({"type": "model_catalog_changed"});
    assert!(matches!(
        client_event_from_value(&value),
        Some(DaemonClientEvent::ModelCatalogChanged)
    ));
}

/// The cross-view layout handoff's live-sequence tracker keys the
/// stash on the LATEST sequence the worker reported, so the
/// session-event frame's `meta.sequence` must ride the parsed event
/// (`view::handoff`): a turn during the run advances the tracker past
/// the run's own attach value, and the post-turn sojourn re-entry
/// matches the value the next attach reports.
#[test]
fn session_event_parses_the_meta_sequence_for_the_handoff_tracker() {
    let with_sequence = json!({
        "type": "session_event",
        "activeSessionId": "sess-1",
        "event": { "type": "message_end" },
        "meta": {
            "id": "sess-1:41",
            "sequence": 41,
            "cursor": { "generation": "g-1", "sequence": 41 }
        }
    });
    match client_event_from_value(&with_sequence) {
        Some(DaemonClientEvent::SessionEvent { meta_sequence, .. }) => {
            assert_eq!(meta_sequence, 41);
        }
        other => panic!("the frame must parse as a session event: {other:?}"),
    }
    // The cursor's sequence is the fallback shape; a frame without
    // either collapses to zero (the tracker's monotonic max ignores
    // it - an unkeyed event never lowers the tracked sequence).
    let cursor_only = json!({
        "type": "session_event",
        "activeSessionId": "sess-1",
        "event": { "type": "message_end" },
        "meta": { "cursor": { "generation": "g-1", "sequence": 12 } }
    });
    match client_event_from_value(&cursor_only) {
        Some(DaemonClientEvent::SessionEvent { meta_sequence, .. }) => {
            assert_eq!(meta_sequence, 12);
        }
        other => panic!("the frame must parse as a session event: {other:?}"),
    }
    let no_meta = json!({
        "type": "session_event",
        "activeSessionId": "sess-1",
        "event": { "type": "message_end" }
    });
    match client_event_from_value(&no_meta) {
        Some(DaemonClientEvent::SessionEvent { meta_sequence, .. }) => {
            assert_eq!(meta_sequence, 0);
        }
        other => panic!("the frame must parse as a session event: {other:?}"),
    }
}

#[test]
fn plain_errors_are_not_rejections() {
    let error = anyhow!("the daemon connection is closed");
    assert!(!is_daemon_rejection(&error));
}

/// TS #2391 `update_restarting` wire round-trip (the
/// daemon-errors.test.ts mirror): the typed info survives the wire
/// to a `RequestRejected`, and the exact-message fallback recognizes
/// the older daemon's plain-string rejection. An unrelated refusal
/// never classifies as the update-restart transient state.
#[test]
fn update_restarting_rejection_round_trips_the_wire() {
    let line = serde_json::from_str::<DaemonResponse>(
        r#"{"type":"response","command":"create","success":false,"error":"Daemon is preparing an update restart","errorInfo":{"code":"update_restarting"}}"#,
    )
    .expect("typed refusal parses");
    let error = response_data_or_error("create", line).unwrap_err();
    assert!(is_update_restarting_rejection(&error));
    let rejection = error
        .downcast_ref::<RequestRejected>()
        .expect("typed rejection");
    assert_eq!(
        rejection.error_info,
        Some(pa_types::daemon::DaemonErrorInfo::UpdateRestarting)
    );
    // The legacy daemon: the same plain string with no errorInfo.
    let legacy = serde_json::from_str::<DaemonResponse>(
        r#"{"type":"response","command":"create","success":false,"error":"Daemon is preparing an update restart"}"#,
    )
    .expect("legacy refusal parses");
    let error = response_data_or_error("create", legacy).unwrap_err();
    assert!(is_update_restarting_rejection(&error));
    // An unrelated refusal is not the update-restart state.
    let other = serde_json::from_str::<DaemonResponse>(
        r#"{"type":"response","command":"create","success":false,"error":"Unknown active session: active-gap"}"#,
    )
    .expect("unrelated refusal parses");
    let error = response_data_or_error("create", other).unwrap_err();
    assert!(!is_update_restarting_rejection(&error));
}

/// The session-addressed lanes' kernel-not-running refusal (the
/// `/factory off` guard's definitive-zero class): the exact wire string
/// classifies through the plain-message predicate, and no other refusal
/// does — the guard's zero read must not fire on an unknown-command or
/// initializing refusal, which stay unreadable and fail closed.
#[test]
fn kernel_not_running_refusal_round_trips_the_wire() {
    let line = serde_json::from_str::<DaemonResponse>(
        r#"{"type":"response","command":"factory_activity","success":false,"error":"Kernel is not running"}"#,
    )
    .expect("refusal parses");
    let error = response_data_or_error("factory_activity", line).unwrap_err();
    assert!(is_kernel_not_running(&error));
    // A refusal that merely embeds the phrase is not the class.
    let wrapped = serde_json::from_str::<DaemonResponse>(
        r#"{"type":"response","command":"factory_activity","success":false,"error":"the session reports: Kernel is not running for this lane"}"#,
    )
    .expect("unrelated refusal parses");
    let error = response_data_or_error("factory_activity", wrapped).unwrap_err();
    assert!(!is_kernel_not_running(&error));
    // The adjacent unreadable classes never classify as the zero read.
    for message in [
        "Session is still initializing",
        "Unknown worker command: factory_activity",
    ] {
        let unrelated = serde_json::from_str::<DaemonResponse>(&format!(
            r#"{{"type":"response","command":"factory_activity","success":false,"error":"{message}"}}"#
        ))
        .expect("unrelated refusal parses");
        let error = response_data_or_error("factory_activity", unrelated).unwrap_err();
        assert!(!is_kernel_not_running(&error), "{message}");
    }
    // A transport failure is not a refusal at all.
    let plain = anyhow!("the daemon connection is closed");
    assert!(!is_kernel_not_running(&plain));
}

#[test]
fn fail_pending_resolves_a_transport_failure_not_a_refusal() {
    // The reader task's dead-connection failure must stay on the
    // transport half of the pending channel: a closed socket can never
    // masquerade as a daemon refusal and keep the UI alive.
    let shared = Shared::default();
    let (tx, rx) = oneshot::channel();
    shared
        .pending
        .lock()
        .unwrap()
        .insert("daemon_1".to_string(), tx);
    shared.fail_pending("daemon_", "the daemon connection closed");
    let error = rx.blocking_recv().unwrap().unwrap_err();
    assert!(!is_daemon_rejection(&error));
    assert_eq!(error.to_string(), "the daemon connection closed");
}

/// A scripted worker socket for the direct-link tests: hello frame,
/// `peer_auth` acceptance, one attach response, then one streamed event.
async fn spawn_mock_worker(listener: tokio::net::UnixListener) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (stream, _) = listener.accept().await.expect("worker accept");
    let (mut reader, mut writer) = stream.into_split();
    let hello = pa_types::daemon::framing::encode_private_frame(
        &serde_json::json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
        br#"{"type":"daemon_hello","protocol":{"name":"prime-agent.daemon","version":7}}"#,
        pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
    )
    .unwrap();
    writer.write_all(&hello).await.unwrap();

    let mut pending = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut attached = false;
    loop {
        let read = reader.read(&mut chunk).await.expect("worker read");
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..read]);
        let mut decoder = pa_types::daemon::framing::PrivateFrameDecoder::new(
            pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        );
        let frames = decoder.push(&pending).expect("decode frames");
        pending.clear();
        for frame in frames {
            let command_type = frame.header["commandType"].as_str().unwrap_or_default();
            let request_id = frame.header["requestId"].as_str().unwrap_or_default();
            let (success, data) = match command_type {
                "peer_auth" => (
                    true,
                    Some(serde_json::json!({
                        "workerInstanceId": "inst-1",
                        "activeSessionId": "s1",
                        "purpose": "session_client",
                    })),
                ),
                "attach" => {
                    attached = true;
                    (
                        true,
                        Some(serde_json::json!({
                            "activeSessionId": "s1",
                            "snapshot": { "messages": [], "summary": {} },
                        })),
                    )
                }
                "get_state" => (
                    true,
                    Some(serde_json::json!({ "id": "s1", "activity": "idle" })),
                ),
                _ => (false, None),
            };
            let response = serde_json::json!({
                "id": request_id,
                "type": "response",
                "command": command_type,
                "success": success,
                "data": data,
            });
            let frame = pa_types::daemon::framing::encode_private_frame(
                &serde_json::json!({
                    "kind": "outbound",
                    "requestId": request_id,
                    "outboundType": "response",
                }),
                &serde_json::to_vec(&response).unwrap(),
                pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
            )
            .unwrap();
            writer.write_all(&frame).await.unwrap();
        }
        if attached {
            // Stream one event, then wait for the client to close.
            let event = serde_json::json!({
                "type": "session_event",
                "activeSessionId": "s1",
                "event": { "type": "turn_end" },
            });
            let frame = pa_types::daemon::framing::encode_private_frame(
                &serde_json::json!({
                    "kind": "outbound",
                    "outboundType": "session_event",
                    "activeSessionId": "s1",
                }),
                &serde_json::to_vec(&event).unwrap(),
                pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
            )
            .unwrap();
            writer.write_all(&frame).await.unwrap();
            attached = false;
        }
    }
}

#[tokio::test]
async fn direct_upgrade_routes_attach_and_streams_events() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("d.sock");
    let worker_socket = dir.path().join("w.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let worker_listener = tokio::net::UnixListener::bind(&worker_socket).unwrap();
    tokio::spawn(async move { spawn_mock_worker(worker_listener).await });

    // Scripted supervisor: advertises direct_peer_transport, answers the
    // ticket request with a ticket for the mock worker socket.
    let ticket_socket = worker_socket.clone();
    let supervisor = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("supervisor accept");
        let (reader, mut writer) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();
        let hello = serde_json::json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": ["direct_peer_transport"],
        });
        writer
            .write_all(format!("{hello}\n").as_bytes())
            .await
            .unwrap();
        loop {
            line.clear();
            if reader.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            let envelope: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
            let id = envelope["id"].as_str().unwrap().to_string();
            let command_type = envelope["command"]["type"].as_str().unwrap();
            let response = if command_type == "get_direct_worker_transport" {
                let identity = pa_types::platform::socket_identity(&ticket_socket).unwrap();
                serde_json::json!({
                    "type": "response",
                    "id": id,
                    "command": command_type,
                    "success": true,
                    "data": {
                        "purpose": "session_client",
                        "socketPath": ticket_socket.to_string_lossy(),
                        "socketIdentity": { "dev": identity.dev, "ino": identity.ino },
                        "workerInstanceId": "inst-1",
                        "activeSessionId": "s1",
                        "grantId": "g1",
                        "token": "t",
                        "expiresAt": "2999-01-01T00:00:00.000Z",
                    },
                })
            } else {
                serde_json::json!({
                    "type": "response",
                    "id": id,
                    "command": command_type,
                    "success": true,
                    "data": { "ok": true },
                })
            };
            writer
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
    });

    let (client, mut events) = DaemonClient::connect(&socket).await.unwrap();
    assert!(
        crate::direct_transport::supervisor_supports_direct(client.hello()),
        "capability advertised"
    );
    assert!(client.upgrade_direct("s1").await.unwrap());
    assert_eq!(client.direct_session_id().as_deref(), Some("s1"));

    // The attach travels over the direct link and its event streams
    // from the worker socket through the same event channel.
    let data = client
        .request_ok(DaemonCommand::Attach {
            id: None,
            active_session_id: "s1".to_string(),
            client_id: None,
            capabilities: None,
            resume_cursor: None,
            telemetry_disabled: None,
            recovery_config: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        })
        .await
        .unwrap();
    assert_eq!(data["activeSessionId"], "s1");
    // The link survives across requests: a second session-plane request
    // still routes over the direct socket.
    let state = client
        .request_ok(DaemonCommand::GetState {
            id: None,
            active_session_id: "s1".to_string(),
            rest: Map::default(),
        })
        .await
        .unwrap();
    assert_eq!(state["id"], "s1");
    let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            event,
            DaemonClientEvent::SessionEvent { ref event, .. } if event["type"] == "turn_end"
        ),
        "unexpected event: {event:?}"
    );
    client.close();
    let _ = supervisor.await;
}

#[tokio::test]
async fn dead_connection_fails_pending_requests_immediately() {
    // The supervisor dies after the handshake while a request is in
    // flight: the reader task must fail the pending request at once
    // (the exit-hang class: the abort was accepted, but the client
    // then waited out the full request timeout on a dead socket).
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("d.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let handle = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut writer = stream;
        let mut hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "clientId": "srv",
            "serverCapabilities": [],
        })
        .to_string();
        hello.push('\n');
        writer.write_all(hello.as_bytes()).await.unwrap();
        // Hold the accept open until the request is in flight, then
        // close the socket (the supervisor process dies).
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(writer);
    });
    let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
    // The default timeout is 30s; the failure must land in well under a
    // second because the socket died, not because a timer fired.
    let started = std::time::Instant::now();
    let error = client
        .request_ok(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        })
        .await
        .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(
        error.to_string().contains("the daemon connection closed"),
        "unexpected error: {error}"
    );
    // The dead-connection failure is transport, never a daemon
    // refusal: the interactive loop must still exit on it.
    assert!(!is_daemon_rejection(&error));
    client.close();
    let _ = handle.await;
}

#[tokio::test]
async fn without_capability_upgrade_is_a_no_op() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("d.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move { spawn_mock_daemon(listener).await });
    let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
    assert!(!crate::direct_transport::supervisor_supports_direct(
        client.hello()
    ));
    assert!(!client.upgrade_direct("s1").await.unwrap());
    assert_eq!(client.direct_session_id(), None);
    client.close();
}

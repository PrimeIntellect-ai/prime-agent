//! Command-session verifiers: the real reqwest transport against a
//! scripted loopback HTTP server speaking the Connect protocol — the
//! exact Start/Connect/SendInput/SendSignal/Update wire (URL, headers,
//! envelope, hand-built golden proto bytes), the event stream contract,
//! end-of-stream error mapping, 401 refresh, unary retries, the
//! create-or-attach re-Start with byte-identical bodies, mid-stream
//! reattach, and the release path (no signal, no reattach). Frames are
//! hand-built from the documented proto shapes, independently of the
//! crate's encoder. No network leaves loopback; no real Sandbox
//! credentials are involved.
//
// Test-only allows: frame builders cast length prefixes to the proto
// fixed-width wire types on purpose.
#![allow(clippy::cast_possible_truncation)]

mod common;

use std::collections::BTreeMap;
use std::time::Duration;

use common::{
    connect_stream_head, http_chunk, http_chunk_end, json_response, proto_response, raw_response,
    MockServer, ScriptedResponse,
};
use pa_sandbox::gateway::GatewayAuth;
use pa_sandbox::proto::encode_connect_frame;
use pa_sandbox::transport::ReqwestSandboxTransport;
use pa_sandbox::{
    CommandSessionClient, CommandSessionError, CommandSessionErrorCode, CommandSessionEvent,
    CommandSessionOptions, ControlOptions, EndEvent, GatewayAuthSource, InputChannel,
    SendInputOptions, SendSignalOptions, StartOptions, StartRequest, StreamOptions, VmSignal,
};

const UUID: &str = "0198c0de-9a1b-4d3e-8f2a-5c6b7d8e9f01";
const TOKEN: &str = "gw-token-1";

// Hand-built frames from the documented proto shapes, three nesting
// levels each: StartResponse { event { <oneof member> { ... } } }.
fn start_frame(pid: u32) -> Vec<u8> {
    // StartEvent { pid (field 1, varint) }
    let mut start_event = vec![0x08];
    let mut value = u64::from(pid);
    let mut pid_bytes = Vec::new();
    while value >= 0x80 {
        pid_bytes.push((value as u8) | 0x80);
        value >>= 7;
    }
    pid_bytes.push(value as u8);
    start_event.extend_from_slice(&pid_bytes);
    // CommandSessionEvent { start (field 1) }
    let mut event = vec![0x0a, start_event.len() as u8];
    event.extend_from_slice(&start_event);
    // StartResponse { event (field 1) }
    let mut envelope = vec![0x0a, event.len() as u8];
    envelope.extend_from_slice(&event);
    encode_connect_frame(&envelope, 0)
}

fn stdout_frame(bytes: &[u8]) -> Vec<u8> {
    // DataEvent { stdout (field 1) = bytes }
    let mut data_event = vec![0x0a, bytes.len() as u8];
    data_event.extend_from_slice(bytes);
    // CommandSessionEvent { data (field 2) }
    let mut event = vec![0x12, data_event.len() as u8];
    event.extend_from_slice(&data_event);
    // StartResponse { event (field 1) }
    let mut envelope = vec![0x0a, event.len() as u8];
    envelope.extend_from_slice(&event);
    encode_connect_frame(&envelope, 0)
}

fn end_frame() -> Vec<u8> {
    // EndEvent { exit_code = -1 (sint32 zigzag 1), exited = true }
    let end_event = [0x08, 0x01, 0x10, 0x01];
    // CommandSessionEvent { end (field 3) }
    let mut event = vec![0x1a, end_event.len() as u8];
    event.extend_from_slice(&end_event);
    // StartResponse { event (field 1) }
    let mut envelope = vec![0x0a, event.len() as u8];
    envelope.extend_from_slice(&event);
    encode_connect_frame(&envelope, 0)
}

fn keepalive_frame() -> Vec<u8> {
    // CommandSessionEvent { keepalive (field 4, empty) }
    let event = [0x22, 0x00];
    let mut envelope = vec![0x0a, event.len() as u8];
    envelope.extend_from_slice(&event);
    encode_connect_frame(&envelope, 0)
}

fn eos_frame() -> Vec<u8> {
    encode_connect_frame(b"{}", 0x02)
}

fn eos_error_frame(code: &str, message: &str) -> Vec<u8> {
    let body = format!(r#"{{"error":{{"code":"{code}","message":"{message}"}}}}"#);
    encode_connect_frame(body.as_bytes(), 0x02)
}

/// A complete chunked connect+proto stream: head, one chunk per frame,
/// terminating chunk. The connection stays reusable.
fn connect_stream(frames: Vec<Vec<u8>>) -> ScriptedResponse {
    let mut stream = Vec::new();
    for frame in frames {
        stream.push((http_chunk(&frame), Duration::from_millis(5)));
    }
    stream.push((http_chunk_end(), Duration::ZERO));
    ScriptedResponse {
        head_delay: Duration::ZERO,
        raw: connect_stream_head(200, "OK"),
        stream,
        close: false,
        hold: false,
    }
}

fn auth(gateway_url: String, token: &str) -> GatewayAuth {
    GatewayAuth {
        sandbox_id: "sb-1".to_string(),
        gateway_url,
        user_namespace: "ns_user1".to_string(),
        job_id: "job_abc".to_string(),
        token: token.to_string(),
        expires_at: "2026-09-16T01:00:00Z".to_string(),
    }
}

fn client_for(
    auth: GatewayAuth,
) -> CommandSessionClient<ReqwestSandboxTransport, StaticAuthSource> {
    CommandSessionClient::with_transport(
        ReqwestSandboxTransport::new(),
        StaticAuthSource { auth },
        CommandSessionOptions {
            max_event_frame_bytes: None,
            keepalive_interval_seconds: Some(90),
            allow_insecure_localhost: true,
            unary_retry_base_delay: Some(Duration::from_millis(1)),
        },
    )
    .unwrap()
}

#[derive(Debug)]
struct StaticAuthSource {
    auth: GatewayAuth,
}

#[allow(clippy::unused_async_trait_impl)]
impl GatewayAuthSource for StaticAuthSource {
    async fn get_auth(&self) -> Result<GatewayAuth, CommandSessionError> {
        Ok(self.auth.clone())
    }
}

/// An auth source that hands out one token, then a refreshed one.
#[derive(Debug)]
struct ToggleAuthSource {
    primary: GatewayAuth,
    refreshed: GatewayAuth,
}

#[allow(clippy::unused_async_trait_impl)]
impl GatewayAuthSource for ToggleAuthSource {
    async fn get_auth(&self) -> Result<GatewayAuth, CommandSessionError> {
        Ok(self.primary.clone())
    }

    async fn refresh_auth(&self) -> Result<GatewayAuth, CommandSessionError> {
        Ok(self.refreshed.clone())
    }
}

fn start_request() -> StartRequest {
    StartRequest {
        command: pa_sandbox::CommandSpec {
            cmd: "sleep".to_string(),
            args: vec!["100".to_string()],
            envs: BTreeMap::default(),
            cwd: None,
        },
        pty: None,
        stdin: false,
        session_uuid: UUID.to_string(),
    }
}

/// The hand-built golden Start wire: envelope header + the documented
/// proto encoding of [`start_request`].
fn golden_start_body() -> Vec<u8> {
    // CommandSpec: cmd (1) = "sleep", args (2) = ["100"].
    let spec = [
        0x0a, 0x05, b's', b'l', b'e', b'e', b'p', 0x12, 0x03, b'1', b'0', b'0',
    ];
    // StartRequest: command (1) = spec, stdin (4) = false,
    // session_uuid (5) = UUID.
    let mut proto = vec![0x0a, spec.len() as u8];
    proto.extend_from_slice(&spec);
    proto.extend_from_slice(&[0x20, 0x00, 0x2a, 36]);
    proto.extend_from_slice(UUID.as_bytes());
    encode_connect_frame(&proto, 0)
}

/// Split a recorded raw request into head and body bytes.
fn request_body(recorded: &[u8]) -> &[u8] {
    let at = recorded
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("request head terminator");
    &recorded[at + 4..]
}

#[tokio::test]
async fn start_speaks_the_exact_connect_wire_and_streams_events() {
    let server = MockServer::start(Vec::new()).await;
    server.push(connect_stream(vec![
        start_frame(4242),
        keepalive_frame(),
        stdout_frame(b"hi"),
        end_frame(),
    ]));
    let client = client_for(auth(server.url(""), TOKEN));
    let mut stream = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(0),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: Some(120_000),
            },
        )
        .await
        .unwrap();
    assert_eq!(stream.pid(), 4242);
    let recorded = server.recorded_requests();
    assert_eq!(recorded.len(), 1);
    let request = &recorded[0];
    assert!(
        request.starts_with("POST /ns_user1/job_abc/command_session.CommandSession/Start HTTP/1.1"),
        "{request}"
    );
    for header in [
        "authorization: Bearer gw-token-1",
        "content-type: application/connect+proto",
        "connect-protocol-version: 1",
        "keepalive-ping-interval: 90",
        "connect-timeout-ms: 120000",
    ] {
        assert!(request.contains(header), "{request} lacks {header}");
    }
    assert_eq!(
        request_body(&server.recorded_request_bytes()[0]),
        golden_start_body(),
        "the Start wire body must match the documented proto shape"
    );
    // Events stream in order; keepalives are not yielded.
    match stream.next_event().await.unwrap().unwrap() {
        CommandSessionEvent::Data { channel, data } => {
            assert_eq!(channel, pa_sandbox::OutputChannel::Stdout);
            assert_eq!(data, b"hi");
        }
        other => panic!("expected stdout data, got {other:?}"),
    }
    match stream.next_event().await.unwrap().unwrap() {
        CommandSessionEvent::End(end) => {
            assert_eq!(
                end,
                EndEvent {
                    exit_code: Some(-1),
                    exited: true,
                    status: None,
                    error: None,
                }
            );
        }
        other => panic!("expected end, got {other:?}"),
    }
    assert!(stream.next_event().await.is_none(), "stream ends after end");
}

#[tokio::test]
async fn release_detaches_without_signaling_or_reattaching() {
    // The stream stays open (no end event, no terminating chunk): only
    // release can end the attachment, and no signal is ever sent.
    let server = MockServer::start(Vec::new()).await;
    server.push(ScriptedResponse {
        head_delay: Duration::ZERO,
        raw: connect_stream_head(200, "OK"),
        stream: vec![(http_chunk(&start_frame(77)), Duration::from_millis(5))],
        close: false,
        hold: true,
    });
    let client = client_for(auth(server.url(""), TOKEN));
    let mut stream = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(5),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(stream.pid(), 77);
    assert!(!stream.is_released());
    // Release must complete promptly even though the server never ends
    // the body.
    tokio::time::timeout(Duration::from_secs(2), stream.release())
        .await
        .expect("release completes while the body stays open");
    assert_eq!(
        server.request_count(),
        1,
        "release never reattaches and never signals"
    );
}

#[tokio::test]
async fn start_reissues_identical_bytes_after_a_fault_before_the_start_event() {
    // A 503 before the start event is a recoverable fault: the pump
    // re-issues Start with byte-identical request bytes (the
    // create-or-attach contract), then succeeds.
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(json_response(
        503,
        "Service Unavailable",
        r#"{"error":"upstream"}"#,
    ));
    server.push(connect_stream(vec![start_frame(9), end_frame()]));
    let client = client_for(auth(server.url(""), TOKEN));
    let mut stream = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(2),
                    reconnect_base_delay: Some(Duration::from_millis(1)),
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(stream.pid(), 9);
    let requests = server.recorded_requests();
    assert_eq!(requests.len(), 2, "{requests:?}");
    for request in &requests {
        assert!(
            request.starts_with(
                "POST /ns_user1/job_abc/command_session.CommandSession/Start HTTP/1.1"
            ),
            "{request}"
        );
    }
    let bodies = server.recorded_request_bytes();
    assert_eq!(
        request_body(&bodies[0]),
        request_body(&bodies[1]),
        "the re-Start must be byte-identical (create-or-attach)"
    );
    assert_eq!(
        request_body(&bodies[0]),
        golden_start_body(),
        "both Start bodies match the documented proto shape"
    );
    match stream.next_event().await.unwrap().unwrap() {
        CommandSessionEvent::End(_) => {}
        other => panic!("expected end, got {other:?}"),
    }
    assert!(stream.next_event().await.is_none());
}

#[tokio::test]
async fn a_fault_after_the_start_event_reattaches_with_connect() {
    // Clean end-of-stream without an end event after the start event is
    // recoverable: the pump reattaches through Connect (never Start).
    let server = MockServer::start(Vec::new()).await;
    server.push(connect_stream(vec![start_frame(11), eos_frame()]));
    server.push(connect_stream(vec![start_frame(11), end_frame()]));
    let client = client_for(auth(server.url(""), TOKEN));
    let mut stream = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(2),
                    reconnect_base_delay: Some(Duration::from_millis(1)),
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(stream.pid(), 11);
    // The end event only arrives through the reattach: consuming it waits
    // for the reconnect to happen before asserting on the wire.
    match stream.next_event().await.unwrap().unwrap() {
        CommandSessionEvent::End(_) => {}
        other => panic!("expected end, got {other:?}"),
    }
    assert!(stream.next_event().await.is_none());
    let requests = server.recorded_requests();
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert!(
        requests[0].contains("/command_session.CommandSession/Start"),
        "{}",
        requests[0]
    );
    assert!(
        requests[1].contains("/command_session.CommandSession/Connect"),
        "{}",
        requests[1]
    );
}

#[tokio::test]
async fn a_truncated_body_mid_frame_is_a_recoverable_fault() {
    // content-length framing ends the body cleanly inside a partial
    // frame: a mid-frame network fault, recoverable, reattached with a
    // byte-identical Start (no start event had arrived yet).
    let server = MockServer::start(Vec::new()).await;
    let partial = [0x0a, 0x10]; // truncated envelope head
    server.push(ScriptedResponse::raw(raw_response(
        200,
        "OK",
        "application/connect+proto",
        &partial,
    )));
    server.push(connect_stream(vec![start_frame(12), end_frame()]));
    let client = client_for(auth(server.url(""), TOKEN));
    let mut stream = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(2),
                    reconnect_base_delay: Some(Duration::from_millis(1)),
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(stream.pid(), 12);
    let requests = server.recorded_request_bytes();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        request_body(&requests[0]),
        request_body(&requests[1]),
        "reattach before the start event re-Starts byte-identically"
    );
    match stream.next_event().await.unwrap().unwrap() {
        CommandSessionEvent::End(_) => {}
        other => panic!("expected end, got {other:?}"),
    }
}

#[tokio::test]
async fn connect_attaches_by_uuid_and_replays_retained_events() {
    let server = MockServer::start(Vec::new()).await;
    server.push(connect_stream(vec![start_frame(31), end_frame()]));
    let client = client_for(auth(server.url(""), TOKEN));
    let mut stream = client
        .connect(
            UUID,
            StreamOptions {
                max_reconnects: Some(0),
                reconnect_base_delay: None,
                max_pending_events: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(stream.pid(), 31);
    let request = &server.recorded_requests()[0];
    assert!(
        request
            .starts_with("POST /ns_user1/job_abc/command_session.CommandSession/Connect HTTP/1.1"),
        "{request}"
    );
    match stream.next_event().await.unwrap().unwrap() {
        CommandSessionEvent::End(_) => {}
        other => panic!("expected the replayed end event, got {other:?}"),
    }
    assert!(stream.next_event().await.is_none());
}

#[tokio::test]
async fn end_of_stream_error_frames_map_to_connect_codes() {
    let server = MockServer::start(Vec::new()).await;
    server.push(connect_stream(vec![eos_error_frame(
        "not_found",
        "no session 7",
    )]));
    let client = client_for(auth(server.url(""), TOKEN));
    let error = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(0),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CommandSessionErrorCode::NotFound);
    assert!(error.to_string().contains("no session 7"), "{error}");
}

#[tokio::test]
async fn compressed_frames_are_refused() {
    let server = MockServer::start(Vec::new()).await;
    server.push(connect_stream(vec![encode_connect_frame(&[], 0x01)]));
    let client = client_for(auth(server.url(""), TOKEN));
    let error = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(0),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CommandSessionErrorCode::InvalidResponse);
    assert!(error.to_string().contains("compressed frames"), "{error}");
}

#[tokio::test]
async fn oversize_frames_abort_the_stream() {
    let server = MockServer::start(Vec::new()).await;
    server.push(connect_stream(vec![encode_connect_frame(&[7u8; 40], 0)]));
    let client = CommandSessionClient::with_transport(
        ReqwestSandboxTransport::new(),
        StaticAuthSource {
            auth: auth(server.url(""), TOKEN),
        },
        CommandSessionOptions {
            max_event_frame_bytes: Some(32),
            keepalive_interval_seconds: Some(90),
            allow_insecure_localhost: true,
            unary_retry_base_delay: Some(Duration::from_millis(1)),
        },
    )
    .unwrap();
    let error = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(0),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CommandSessionErrorCode::TooLarge);
}

#[tokio::test]
async fn send_input_speaks_the_unary_wire() {
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(proto_response(200, "OK", b""));
    let client = client_for(auth(server.url(""), TOKEN));
    client
        .send_input(
            UUID,
            InputChannel::Stdin,
            b"zz",
            SendInputOptions {
                control: ControlOptions {
                    connect_timeout_ms: Some(Duration::from_millis(1234)),
                },
                input_uuid: Some(UUID.to_string()),
            },
        )
        .await
        .unwrap();
    let requests = server.recorded_request_bytes();
    assert_eq!(requests.len(), 1);
    let request = String::from_utf8_lossy(&requests[0]).into_owned();
    assert!(
        request.starts_with(
            "POST /ns_user1/job_abc/command_session.CommandSession/SendInput HTTP/1.1"
        ),
        "{request}"
    );
    for header in [
        "authorization: Bearer gw-token-1",
        "content-type: application/proto",
        "connect-protocol-version: 1",
        "connect-timeout-ms: 1234",
    ] {
        assert!(request.contains(header), "{request} lacks {header}");
    }
    // Selector (session_uuid field 3), input oneof stdin (field 1),
    // input_uuid (field 3) — hand-built golden bytes.
    let mut expected = vec![0x0a, 38, 0x1a, 36];
    expected.extend_from_slice(UUID.as_bytes());
    expected.extend_from_slice(&[0x12, 0x04, 0x0a, 0x02, b'z', b'z']);
    expected.extend_from_slice(&[0x1a, 36]);
    expected.extend_from_slice(UUID.as_bytes());
    assert_eq!(request_body(&requests[0]), expected.as_slice());
}

#[tokio::test]
async fn send_signal_speaks_the_unary_wire() {
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(proto_response(200, "OK", b""));
    let client = client_for(auth(server.url(""), TOKEN));
    client
        .send_signal(
            UUID,
            VmSignal::Terminate,
            SendSignalOptions {
                control: ControlOptions::default(),
                signal_uuid: Some(UUID.to_string()),
            },
        )
        .await
        .unwrap();
    let requests = server.recorded_request_bytes();
    let mut expected = vec![0x0a, 38, 0x1a, 36];
    expected.extend_from_slice(UUID.as_bytes());
    expected.extend_from_slice(&[0x10, 15, 0x1a, 36]);
    expected.extend_from_slice(UUID.as_bytes());
    assert_eq!(request_body(&requests[0]), expected.as_slice());
    assert!(String::from_utf8_lossy(&requests[0])
        .contains("/command_session.CommandSession/SendSignal"));
}

#[tokio::test]
async fn resize_speaks_the_update_wire() {
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(proto_response(200, "OK", b""));
    let client = client_for(auth(server.url(""), TOKEN));
    client
        .resize(
            UUID,
            pa_sandbox::PtySize {
                cols: 100,
                rows: 30,
            },
            ControlOptions::default(),
        )
        .await
        .unwrap();
    let requests = server.recorded_request_bytes();
    let mut expected = vec![0x0a, 38, 0x1a, 36];
    expected.extend_from_slice(UUID.as_bytes());
    expected.extend_from_slice(&[0x12, 0x06, 0x0a, 0x04, 0x08, 100, 0x10, 30]);
    assert_eq!(request_body(&requests[0]), expected.as_slice());
    assert!(
        String::from_utf8_lossy(&requests[0]).contains("/command_session.CommandSession/Update")
    );
}

#[tokio::test]
async fn a_401_refreshes_the_gateway_token_exactly_once() {
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(json_response(
        401,
        "Unauthorized",
        r#"{"code":"unauthenticated","message":"expired"}"#,
    ));
    server.push_raw(proto_response(200, "OK", b""));
    let client = CommandSessionClient::with_transport(
        ReqwestSandboxTransport::new(),
        ToggleAuthSource {
            primary: auth(server.url(""), "gw-token-1"),
            refreshed: auth(server.url(""), "gw-token-2"),
        },
        CommandSessionOptions {
            max_event_frame_bytes: None,
            keepalive_interval_seconds: Some(90),
            allow_insecure_localhost: true,
            unary_retry_base_delay: Some(Duration::from_millis(1)),
        },
    )
    .unwrap();
    client
        .send_input(
            UUID,
            InputChannel::Stdin,
            b"zz",
            SendInputOptions::default(),
        )
        .await
        .unwrap();
    let requests = server.recorded_requests();
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert!(
        requests[0].contains("authorization: Bearer gw-token-1"),
        "{}",
        requests[0]
    );
    assert!(
        requests[1].contains("authorization: Bearer gw-token-2"),
        "{}",
        requests[1]
    );
}

#[tokio::test]
async fn unary_retries_transient_faults_with_identical_bytes() {
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(json_response(
        503,
        "Service Unavailable",
        r#"{"error":"upstream"}"#,
    ));
    server.push_raw(proto_response(200, "OK", b""));
    let client = client_for(auth(server.url(""), TOKEN));
    client
        .send_input(
            UUID,
            InputChannel::Stdin,
            b"zz",
            SendInputOptions::default(),
        )
        .await
        .unwrap();
    let bodies = server.recorded_request_bytes();
    assert_eq!(bodies.len(), 2);
    assert_eq!(
        request_body(&bodies[0]),
        request_body(&bodies[1]),
        "retries resend byte-identical requests"
    );
}

#[tokio::test]
async fn a_non_2xx_open_maps_gateway_error_bodies_and_never_leaks_the_token() {
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(json_response(
        502,
        "Bad Gateway",
        r#"{"error":"sandbox_not_found","message":"gone with token gw-token-1"}"#,
    ));
    let client = client_for(auth(server.url(""), TOKEN));
    let error = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(0),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CommandSessionErrorCode::SandboxNotFound);
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("gw-token-1"), "{rendered}");
}

#[tokio::test]
async fn stream_errors_do_not_reconnect_when_the_budget_is_spent() {
    // An end-of-stream not_found is definitive: with a nonzero budget the
    // pump still faults immediately instead of burning it.
    let server = MockServer::start(Vec::new()).await;
    server.push(connect_stream(vec![eos_error_frame(
        "not_found",
        "no session 7",
    )]));
    let client = client_for(auth(server.url(""), TOKEN));
    let error = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(5),
                    reconnect_base_delay: Some(Duration::from_millis(1)),
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CommandSessionErrorCode::NotFound);
    assert_eq!(
        server.request_count(),
        1,
        "no reattach on a definitive answer"
    );
}

#[tokio::test]
async fn end_of_stream_error_messages_never_carry_the_token() {
    // A valid 200 connect+proto stream whose end-of-stream frame echoes
    // the gateway token inside error.message: the typed fault must not
    // disclose it through Display or Debug.
    let server = MockServer::start(Vec::new()).await;
    let message = format!("no session 7 (auth Bearer {TOKEN} failed)");
    let body = format!(
        r#"{{"error":{{"code":"not_found","message":{}}}}}"#,
        serde_json::to_string(&message).unwrap()
    );
    server.push(connect_stream(vec![encode_connect_frame(
        body.as_bytes(),
        0x02,
    )]));
    let client = client_for(auth(server.url(""), TOKEN));
    let error = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(0),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CommandSessionErrorCode::NotFound);
    let rendered = format!("{error:?}");
    assert!(!rendered.contains(TOKEN), "{rendered}");
    assert!(error.to_string().contains("[redacted]"), "{rendered}");
    assert!(error.to_string().contains("no session 7"), "{rendered}");
}

#[tokio::test]
async fn a_zero_connect_timeout_disables_the_local_open_deadline() {
    // `Connect-Timeout-Ms: 0` is the explicit no-deadline form: the header
    // is still sent, but a slow response head must not trip a local
    // zero-duration timeout (TS converts 0 to undefined for its own
    // deadline).
    let server = MockServer::start(Vec::new()).await;
    let stream = vec![
        (http_chunk(&start_frame(21)), Duration::from_millis(5)),
        (http_chunk(&end_frame()), Duration::from_millis(5)),
        (http_chunk_end(), Duration::ZERO),
    ];
    server.push(ScriptedResponse {
        head_delay: Duration::from_millis(400),
        raw: connect_stream_head(200, "OK"),
        stream,
        close: false,
        hold: false,
    });
    let client = client_for(auth(server.url(""), TOKEN));
    let mut process = client
        .start(
            &start_request(),
            StartOptions {
                stream: StreamOptions {
                    max_reconnects: Some(0),
                    reconnect_base_delay: None,
                    max_pending_events: None,
                },
                connect_timeout_ms: Some(0),
            },
        )
        .await
        .expect("a slow head survives the explicit no-deadline open");
    assert_eq!(process.pid(), 21);
    match process.next_event().await.unwrap().unwrap() {
        CommandSessionEvent::End(_) => {}
        other => panic!("expected end, got {other:?}"),
    }
    // The header still carries the explicit zero for sandboxd.
    assert!(
        server.recorded_requests()[0].contains("connect-timeout-ms: 0"),
        "{}",
        server.recorded_requests()[0]
    );
}

#[tokio::test]
async fn a_zero_unary_control_timeout_is_rejected_before_sending() {
    // TS parity: an explicitly supplied control-RPC deadline must be
    // positive; zero is rejected locally, nothing is sent.
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(proto_response(200, "OK", b""));
    let client = client_for(auth(server.url(""), TOKEN));
    let error = client
        .send_input(
            UUID,
            InputChannel::Stdin,
            b"zz",
            SendInputOptions {
                control: ControlOptions {
                    connect_timeout_ms: Some(Duration::ZERO),
                },
                input_uuid: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CommandSessionErrorCode::InvalidRequest);
    assert_eq!(server.request_count(), 0, "nothing was sent");
}

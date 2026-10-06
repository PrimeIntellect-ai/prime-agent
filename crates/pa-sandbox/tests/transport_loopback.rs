//! Real-transport verifiers: the reqwest production transport against a
//! scripted loopback HTTP server — header fidelity, status mapping,
//! deadline abort, connection failure, and the bounded response read.

mod common;

use std::time::{Duration, Instant};

use common::{json_response, oversized_stream, redirect_response, text_response, MockServer};
use pa_sandbox::transport::{
    ReqwestSandboxTransport, SandboxTransport, TransportRequest, MAX_JSON_BODY_BYTES,
};
use pa_sandbox::types::Method;
use pa_sandbox::{ClientOptions, PrimeSandboxClient, SandboxErrorCode};
use serde_json::json;

fn request(method: Method, url: String, body: Option<String>) -> TransportRequest {
    TransportRequest {
        method,
        headers: vec![
            ("Authorization".to_string(), "Bearer test-key".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        url,
        body: body.map(String::into_bytes),
        max_response_bytes: None,
        timeout: Some(Duration::from_secs(2)),
    }
}

fn loopback_client(server: &MockServer) -> PrimeSandboxClient {
    PrimeSandboxClient::new(
        "test-key",
        ClientOptions {
            base_url: server.url(""),
            team_id: None,
            request_timeout: Some(Duration::from_secs(2)),
            allow_insecure_localhost: true,
        },
    )
    .unwrap()
}

#[tokio::test]
async fn platform_headers_and_method_reach_the_wire() {
    let body = json!({"detail": "created"});
    let server = MockServer::start(vec![json_response(200, "OK", &body.to_string())]).await;
    let client = loopback_client(&server);
    client.delete_sandbox("sb-9").await.unwrap();
    let recorded = &server.recorded_requests()[0];
    assert!(recorded.contains("DELETE /api/v1/sandbox/sb-9 HTTP/1.1"));
    assert!(recorded.contains("authorization: Bearer test-key"));
    assert!(recorded.contains("content-type: application/json"));
}

#[tokio::test]
async fn status_and_body_map_through_the_real_transport() {
    let server = MockServer::start(vec![json_response(
        403,
        "Forbidden",
        "{\"detail\":\"denied\",\"api_key\":\"test-key\"}",
    )])
    .await;
    let client = loopback_client(&server);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
    assert_eq!(error.status(), Some(403));
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("test-key"));
    assert!(error.details().unwrap().contains("[redacted]"));
}

#[tokio::test]
async fn a_non_json_success_body_is_an_invalid_response() {
    let server = MockServer::start(vec![text_response(200, "OK", "not json")]).await;
    let client = loopback_client(&server);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidResponse);
}

#[tokio::test]
async fn unresponsive_servers_lose_the_deadline_race() {
    // Bind a listener that accepts and hangs: the transport's per-request
    // deadline must fire even though reqwest never resolves.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((_socket, _)) = listener.accept().await else {
                return;
            };
            tokio::time::sleep(Duration::from_hours(1)).await;
        }
    });
    let transport = ReqwestSandboxTransport::new();
    let started = Instant::now();
    let error = transport
        .execute(request(
            Method::Get,
            format!("http://127.0.0.1:{port}/api/v1/sandbox/sb-1"),
            None,
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5), "hard abort");
    let rendered = error.to_string();
    assert!(rendered.contains("Request timed out after"));
}

#[tokio::test]
async fn refused_connections_are_network_errors() {
    // Bind then drop the listener to get a reliably-refused port.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let transport = ReqwestSandboxTransport::new();
    let error = transport
        .execute(request(
            Method::Get,
            format!("http://127.0.0.1:{port}/api/v1/sandbox/sb-1"),
            None,
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Network);
}

#[tokio::test]
async fn streamed_bodies_past_the_cap_fail_mid_read() {
    // One 1 MiB chunk with a 1024-byte cap proves the streaming limit.
    let server = MockServer::start(vec![oversized_stream()]).await;
    let transport = ReqwestSandboxTransport::with_max_response_bytes(1024);
    let error = transport
        .execute(request(
            Method::Get,
            server.url("/api/v1/sandbox/sb-1"),
            None,
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::TooLarge);
    // The cap is per-request now (TS applies per-call caps), so the
    // message names the bound, not the JSON body.
    assert_eq!(
        error.to_string(),
        "Sandbox response exceeds the 1024 byte limit"
    );
}

#[tokio::test]
async fn redirects_are_refused_and_the_key_never_hops() {
    // The redirect target is a live recording server: if the transport
    // followed the 3xx, the request (with the Bearer key) would land there.
    let target = MockServer::start(vec![text_response(200, "OK", "leaked")]).await;
    let server = MockServer::start(vec![redirect_response(
        301,
        "Moved Permanently",
        &target.url("/api/v1/sandbox/sb-1"),
    )])
    .await;
    let client = loopback_client(&server);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
    assert_eq!(error.status(), Some(301));
    let rendered = error.to_string();
    assert!(rendered.contains("refused a redirect"));
    assert_eq!(
        server.request_count(),
        1,
        "exactly one request to the platform"
    );
    assert_eq!(
        target.request_count(),
        0,
        "the redirect target saw nothing - no redirected key"
    );
}

#[tokio::test]
async fn the_production_cap_is_32_mib() {
    assert_eq!(MAX_JSON_BODY_BYTES, 32 * 1024 * 1024);
}

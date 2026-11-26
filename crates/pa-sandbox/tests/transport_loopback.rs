//! Real-transport verifiers: the reqwest production transport against a
//! scripted loopback HTTP server — header fidelity, deadline abort, and
//! refused redirects.

mod common;

use std::time::{Duration, Instant};

use common::{json_response, redirect_response, MockServer, ScriptedResponse};
use pa_sandbox::transport::{ReqwestSandboxTransport, SandboxTransport, TransportRequest};
use pa_sandbox::types::Method;
use pa_sandbox::{
    ClientOptions, GatewayOptions, PrimeSandboxClient, SandboxErrorCode, UploadRequest,
};
use serde_json::json;

fn request(method: Method, url: String) -> TransportRequest {
    TransportRequest {
        method,
        headers: vec![
            ("Authorization".to_string(), "Bearer test-key".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        url,
        body: None,
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
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5), "hard abort");
}

#[tokio::test]
async fn the_upload_deadline_override_wins_the_race() {
    // The bot install rides one multipart upload whose deadline comes from
    // `GatewayOptions`, not the client default. The platform auth hands
    // out loopback gateway credentials, the upload's reply stalls, and the
    // per-request override must abort the call.
    let server = MockServer::start(Vec::new()).await;
    let credentials = serde_json::json!({
        "gateway_url": server.url(""),
        "user_ns": "ns_user1",
        "job_id": "job_abc",
        "token": "gw-token-1",
        "expires_at": "2026-09-16T01:00:00Z",
    });
    server.push_raw(json_response(200, "OK", &credentials.to_string()));
    server.push(ScriptedResponse {
        head_delay: Duration::from_secs(8),
        raw: Vec::new(),
        stream: Vec::new(),
        close: false,
        hold: false,
    });
    let client = loopback_client(&server);
    let started = Instant::now();
    let error = client
        .upload_file(
            "sb-1",
            UploadRequest {
                path: "/root/.prime-agent-install.tar.gz".to_string(),
                filename: "bot-tarball.tar.gz".to_string(),
                content: vec![0_u8; 1024],
            },
            &GatewayOptions {
                request_timeout: Some(Duration::from_millis(250)),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5), "hard abort");
}

#[tokio::test]
async fn redirects_are_refused_and_the_key_never_hops() {
    // The redirect target is a live recording server: if the transport
    // followed the 3xx, the request (with the Bearer key) would land there.
    let target = MockServer::start(vec![json_response(200, "OK", "{}")]).await;
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
    assert_eq!(
        server.recorded_requests().len(),
        1,
        "exactly one request to the platform"
    );
    assert_eq!(
        target.recorded_requests().len(),
        0,
        "the redirect target saw nothing - no redirected key"
    );
}

//! Gateway verifiers: the real reqwest transport against a scripted
//! loopback HTTP server — the auth wire, the exact exec/upload/download
//! request shapes, status mapping, redirect refusal (the gateway token
//! never hops), and secret redaction. No network leaves loopback; no
//! real Prime credentials are involved.
//
// Test-only allows: the scripted transport returns without awaiting
// (the trait seam).
#![allow(clippy::unused_async_trait_impl)]

mod common;

use std::time::Duration;

use common::{json_response, raw_response, redirect_response, text_response, MockServer};
use pa_sandbox::transport::TransportResponse;
use pa_sandbox::{
    ClientOptions, ExecRequest, GatewayAuth, GatewayOptions, PrimeSandboxClient, SandboxErrorCode,
    UploadRequest, MAX_TRANSFER_BYTES,
};
use serde_json::json;

const API_KEY: &str = "test-key";
const SANDBOX_ID: &str = "sb-1";
const GATEWAY_TOKEN: &str = "gateway-token-xyz";

fn platform_client(server: &MockServer) -> PrimeSandboxClient {
    PrimeSandboxClient::new(
        API_KEY,
        ClientOptions {
            base_url: server.url(""),
            team_id: None,
            request_timeout: Some(Duration::from_secs(2)),
            allow_insecure_localhost: true,
        },
    )
    .unwrap()
}

/// Start a server, then push the auth script whose `gateway_url` points
/// back at the same server (gateway calls loop back too).
async fn auth_server() -> MockServer {
    let server = MockServer::start(Vec::new()).await;
    let body = json!({
        "gateway_url": server.url(""),
        "user_ns": "ns_user1",
        "job_id": "job_abc",
        "token": GATEWAY_TOKEN,
        "expires_at": "2026-09-16T01:00:00Z",
    });
    server.push_raw(json_response(200, "OK", &body.to_string()));
    server
}

fn provided_auth(server: &MockServer) -> GatewayAuth {
    GatewayAuth {
        sandbox_id: SANDBOX_ID.to_string(),
        gateway_url: server.url(""),
        user_namespace: "ns_user1".to_string(),
        job_id: "job_abc".to_string(),
        token: GATEWAY_TOKEN.to_string(),
        expires_at: "2026-09-16T01:00:00Z".to_string(),
    }
}

fn gateway_options(server: &MockServer) -> GatewayOptions {
    GatewayOptions {
        auth: Some(provided_auth(server)),
        request_timeout: Some(Duration::from_secs(2)),
    }
}

#[tokio::test]
async fn auth_posts_to_the_platform_and_parses_credentials() {
    let server = auth_server().await;
    let client = platform_client(&server);
    let auth = client
        .get_sandbox_auth(SANDBOX_ID, &GatewayOptions::default())
        .await
        .unwrap();
    assert_eq!(auth.sandbox_id, SANDBOX_ID);
    assert_eq!(auth.user_namespace, "ns_user1");
    assert_eq!(auth.job_id, "job_abc");
    assert_eq!(auth.token, GATEWAY_TOKEN);
    assert_eq!(auth.expires_at, "2026-09-16T01:00:00Z");
    let recorded = &server.recorded_requests()[0];
    assert!(
        recorded.starts_with("POST /api/v1/sandbox/sb-1/auth HTTP/1.1"),
        "{recorded}"
    );
    assert!(
        recorded.contains("authorization: Bearer test-key"),
        "{recorded}"
    );
    assert!(
        recorded.contains("content-type: application/json"),
        "{recorded}"
    );
}

#[tokio::test]
async fn exec_fetches_auth_then_posts_the_snake_case_body() {
    let server = auth_server().await;
    server.push_raw(json_response(
        200,
        "OK",
        r#"{"stdout":"ok","stderr":"","exit_code":0}"#,
    ));
    let client = platform_client(&server);
    let result = client
        .exec_container_command(
            SANDBOX_ID,
            ExecRequest {
                command: "uname -a".to_string(),
                working_dir: Some("/workspace".to_string()),
                env: Some([("A".to_string(), "b".to_string())].into()),
                timeout_seconds: Some(60),
                user: Some("nobody".to_string()),
            },
            &GatewayOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.stdout, "ok");
    assert_eq!(result.exit_code, 0);
    let requests = server.recorded_requests();
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert!(
        requests[0].starts_with("POST /api/v1/sandbox/sb-1/auth HTTP/1.1"),
        "{}",
        requests[0]
    );
    let exec = &requests[1];
    assert!(
        exec.starts_with("POST /ns_user1/job_abc/exec HTTP/1.1"),
        "{exec}"
    );
    // The gateway call carries the sandbox-bound token, not the API key.
    assert!(
        exec.contains(&format!("authorization: Bearer {GATEWAY_TOKEN}")),
        "{exec}"
    );
    assert!(
        exec.contains(r#"{"command":"uname -a","sandbox_id":"sb-1","timeout":60,"working_dir":"/workspace","env":{"A":"b"},"user":"nobody"}"#),
        "{exec}"
    );
}

#[tokio::test]
async fn upload_posts_the_undici_multipart_form() {
    let server = auth_server().await;
    server.push_raw(json_response(
        200,
        "OK",
        r#"{"success":true,"path":"/tmp/x.tar","size":4,"timestamp":"2026-09-16T00:00:00Z"}"#,
    ));
    let client = platform_client(&server);
    let result = client
        .upload_file(
            SANDBOX_ID,
            UploadRequest {
                path: "/tmp/x.tar".to_string(),
                filename: "x.tar".to_string(),
                content: vec![1, 2, 3, 4],
            },
            &GatewayOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.size, 4);
    let requests = server.recorded_request_bytes();
    let upload = String::from_utf8_lossy(&requests[1]).into_owned();
    assert!(
        upload.starts_with(
            "POST /ns_user1/job_abc/upload?path=%2Ftmp%2Fx.tar&sandbox_id=sb-1 HTTP/1.1"
        ),
        "{upload}"
    );
    assert!(
        upload.contains(&format!("authorization: Bearer {GATEWAY_TOKEN}")),
        "{upload}"
    );
    // Recover the boundary from the content-type and assert the exact
    // multipart body the TS FormData emits: one file part, no per-part
    // content type, boundary-closed.
    let boundary = upload
        .split("content-type: multipart/form-data; boundary=")
        .nth(1)
        .and_then(|rest| rest.split("\r\n").next())
        .unwrap_or_default()
        .to_string();
    assert_eq!(boundary.len(), 32, "uuid-simple boundary, {upload}");
    let expected_body = format!(
        "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"file\"; filename=\"x.tar\"\r\n\
         \r\n\
         \x01\x02\x03\x04\r\n\
         --{boundary}--\r\n"
    );
    let body_start = upload.find("\r\n\r\n").map(|at| at + 4).unwrap_or_default();
    assert_eq!(&upload[body_start..], expected_body, "{upload}");
}

#[tokio::test]
async fn download_returns_raw_bytes() {
    let server = auth_server().await;
    server.push_raw(raw_response(
        200,
        "OK",
        "application/octet-stream",
        &[9, 8, 7, 6],
    ));
    let client = platform_client(&server);
    let bytes = client
        .download_file(SANDBOX_ID, "/out/result.tar", &GatewayOptions::default())
        .await
        .unwrap();
    assert_eq!(bytes, vec![9, 8, 7, 6]);
    let recorded = &server.recorded_requests()[1];
    assert!(
        recorded.starts_with(
            "GET /ns_user1/job_abc/download?path=%2Fout%2Fresult.tar&sandbox_id=sb-1 HTTP/1.1"
        ),
        "{recorded}"
    );
    assert!(
        recorded.contains(&format!("authorization: Bearer {GATEWAY_TOKEN}")),
        "{recorded}"
    );
}

#[tokio::test]
async fn download_stops_before_reading_an_oversized_declaration() {
    let server = auth_server().await;
    let lie = format!(
        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n",
        MAX_TRANSFER_BYTES + 1
    );
    server.push_raw(lie.into_bytes());
    let client = platform_client(&server);
    let error = client
        .download_file(SANDBOX_ID, "/x", &GatewayOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::TooLarge);
    assert!(error.to_string().contains("declares"), "{}", error);
}

#[tokio::test]
async fn upload_rejects_oversized_content_before_fetching() {
    let server = auth_server().await;
    server.push_raw(json_response(
        200,
        "OK",
        r#"{"success":true,"path":"/x","size":1,"timestamp":"2026-09-16T00:00:00Z"}"#,
    ));
    let client = platform_client(&server);
    let error = client
        .upload_file(
            SANDBOX_ID,
            UploadRequest {
                path: "/x".to_string(),
                filename: "x".to_string(),
                content: vec![0u8; MAX_TRANSFER_BYTES + 1],
            },
            &GatewayOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::TooLarge);
    assert_eq!(server.request_count(), 0, "nothing was sent");
}

#[tokio::test]
async fn gateway_redirects_are_refused_and_the_token_never_hops() {
    // The redirect target is a live recording server: if the transport
    // followed the 3xx, the request (with the gateway token) would land
    // there.
    let target = MockServer::start(Vec::new()).await;
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(redirect_response(
        301,
        "Moved Permanently",
        &target.url("/ns_user1/job_abc/exec"),
    ));
    let client = platform_client(&server);
    let error = client
        .exec_container_command(
            SANDBOX_ID,
            ExecRequest {
                command: "ls".to_string(),
                working_dir: None,
                env: None,
                timeout_seconds: None,
                user: None,
            },
            &gateway_options(&server),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
    assert_eq!(error.status(), Some(301));
    assert!(
        error.to_string().contains("refused a redirect"),
        "{}",
        error
    );
    assert_eq!(
        target.request_count(),
        0,
        "the redirect target saw nothing - no redirected token"
    );
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn platform_auth_redirects_are_refused_and_the_key_never_hops() {
    let target = MockServer::start(Vec::new()).await;
    let server = MockServer::start(Vec::new()).await;
    server.push_raw(redirect_response(
        307,
        "Temporary Redirect",
        &target.url("/api/v1/sandbox/sb-1/auth"),
    ));
    let client = platform_client(&server);
    let error = client
        .get_sandbox_auth(SANDBOX_ID, &GatewayOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
    assert_eq!(error.status(), Some(307));
    assert_eq!(
        target.request_count(),
        0,
        "the redirect target saw nothing - no redirected key"
    );
}

#[tokio::test]
async fn gateway_errors_map_the_typed_codes() {
    for (status, body, code) in [
        (
            408,
            r#"{"detail":"server busy"}"#,
            SandboxErrorCode::RequestTimeout,
        ),
        (409, r#"{"detail":"conflict"}"#, SandboxErrorCode::Conflict),
        (
            502,
            r#"{"error":"sandbox_not_found"}"#,
            SandboxErrorCode::SandboxNotFound,
        ),
        (
            502,
            r#"{"detail":"other upstream"}"#,
            SandboxErrorCode::Http,
        ),
        (500, r#"{"detail":"boom"}"#, SandboxErrorCode::Http),
    ] {
        let server = MockServer::start(Vec::new()).await;
        server.push_raw(json_response(status, "Bad", body));
        let client = platform_client(&server);
        let error = client
            .exec_container_command(
                SANDBOX_ID,
                ExecRequest {
                    command: "ls".to_string(),
                    working_dir: None,
                    env: None,
                    timeout_seconds: None,
                    user: None,
                },
                &gateway_options(&server),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), code, "HTTP {status} should map to {code:?}");
        assert_eq!(error.status(), Some(status));
    }
}

#[tokio::test]
async fn error_details_never_carry_the_gateway_token() {
    // The token echoed under an ordinary key or in plain text is the leak
    // shape (a "token"-named key would be masked by key-scrubbing alone).
    for body in [
        r#"{"detail":"denied: Bearer gateway-token-xyz"}"#,
        "upstream rejected Bearer gateway-token-xyz",
    ] {
        // Exec: a 403 body echoing the sandbox-bound token.
        let server = MockServer::start(Vec::new()).await;
        server.push_raw(text_response(403, "Forbidden", body));
        let client = platform_client(&server);
        let error = client
            .exec_container_command(
                SANDBOX_ID,
                ExecRequest {
                    command: "ls".to_string(),
                    working_dir: None,
                    env: None,
                    timeout_seconds: None,
                    user: None,
                },
                &gateway_options(&server),
            )
            .await
            .unwrap_err();
        let rendered = format!("{error:?}");
        assert!(!rendered.contains(GATEWAY_TOKEN), "{rendered}");
        assert!(
            error.details().unwrap().contains("[redacted]"),
            "{rendered}"
        );
        // Upload: the same echo on the multipart path.
        let server = MockServer::start(Vec::new()).await;
        server.push_raw(text_response(403, "Forbidden", body));
        let client = platform_client(&server);
        let error = client
            .upload_file(
                SANDBOX_ID,
                UploadRequest {
                    path: "/x".to_string(),
                    filename: "x".to_string(),
                    content: vec![1, 2, 3],
                },
                &gateway_options(&server),
            )
            .await
            .unwrap_err();
        let rendered = format!("{error:?}");
        assert!(!rendered.contains(GATEWAY_TOKEN), "{rendered}");
        assert!(
            error.details().unwrap().contains("[redacted]"),
            "{rendered}"
        );
    }
}

#[tokio::test]
async fn provided_auth_for_another_sandbox_is_rejected() {
    let server = MockServer::start(Vec::new()).await;
    let client = platform_client(&server);
    let other_sandbox = GatewayOptions {
        auth: Some(GatewayAuth {
            sandbox_id: "sb-other".to_string(),
            gateway_url: server.url(""),
            user_namespace: "ns_user1".to_string(),
            job_id: "job_abc".to_string(),
            token: GATEWAY_TOKEN.to_string(),
            expires_at: "2026-09-16T01:00:00Z".to_string(),
        }),
        request_timeout: Some(Duration::from_secs(2)),
    };
    let error = client
        .exec_container_command(
            SANDBOX_ID,
            ExecRequest {
                command: "ls".to_string(),
                working_dir: None,
                env: None,
                timeout_seconds: None,
                user: None,
            },
            &other_sandbox,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);
    assert_eq!(server.request_count(), 0, "nothing was sent");
}

#[tokio::test]
async fn non_https_gateway_origins_are_rejected_at_auth_parse() {
    let server = MockServer::start(Vec::new()).await;
    let body = json!({
        "gateway_url": "http://sandbox-gw.example.com",
        "user_ns": "ns_user1",
        "job_id": "job_abc",
        "token": "t",
        "expires_at": "2026-09-16T01:00:00Z",
    });
    server.push_raw(json_response(200, "OK", &body.to_string()));
    let client = platform_client(&server);
    let error = client
        .get_sandbox_auth(SANDBOX_ID, &GatewayOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidResponse);
    // A loopback http gateway passes the explicit opt-in.
    let server = MockServer::start(Vec::new()).await;
    let body = json!({
        "gateway_url": "http://[::1]:9393",
        "user_ns": "ns_user1",
        "job_id": "job_abc",
        "token": "t",
        "expires_at": "2026-09-16T01:00:00Z",
    });
    server.push_raw(json_response(200, "OK", &body.to_string()));
    let client = platform_client(&server);
    let auth = client
        .get_sandbox_auth(SANDBOX_ID, &GatewayOptions::default())
        .await
        .unwrap();
    assert_eq!(auth.gateway_url, "http://[::1]:9393");
}

#[tokio::test]
async fn unsafe_auth_segments_are_rejected() {
    for (user_ns, job_id) in [("a/b", "job_abc"), ("ns_user1", "b c")] {
        let server = MockServer::start(Vec::new()).await;
        let body = json!({
            "gateway_url": server.url(""),
            "user_ns": user_ns,
            "job_id": job_id,
            "token": "t",
            "expires_at": "2026-09-16T01:00:00Z",
        });
        server.push_raw(json_response(200, "OK", &body.to_string()));
        let client = platform_client(&server);
        let error = client
            .get_sandbox_auth(SANDBOX_ID, &GatewayOptions::default())
            .await
            .unwrap_err();
        assert_eq!(
            error.code(),
            SandboxErrorCode::InvalidResponse,
            "{user_ns}/{job_id}"
        );
    }
}

/// An in-process scripted transport for the deadline verifier.
mod scripted {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use pa_sandbox::error::SandboxError;
    use pa_sandbox::transport::{
        ResponseChunks, SandboxTransport, StreamedResponse, TransportRequest, TransportResponse,
    };

    pub struct ScriptedTransport {
        pub responses: Mutex<VecDeque<TransportResponse>>,
        pub requests: Mutex<Vec<TransportRequest>>,
    }

    impl ScriptedTransport {
        pub fn new(responses: Vec<TransportResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }

        pub fn recorded(&self) -> Vec<TransportRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    // The scripted transport satisfies the RPITIT seam without awaiting.
    #[allow(clippy::unused_async_trait_impl)]
    impl SandboxTransport for &ScriptedTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> Result<TransportResponse, SandboxError> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| SandboxError::network("no scripted reply"))
        }

        async fn execute_streaming(
            &self,
            request: TransportRequest,
        ) -> Result<StreamedResponse, SandboxError> {
            let response = SandboxTransport::execute(self, request).await?;
            Ok(StreamedResponse {
                status: response.status,
                headers: Vec::new(),
                body: ResponseChunks::Queued(std::iter::once(response.body).collect()),
            })
        }
    }
}

#[tokio::test]
async fn exec_deadlines_cover_the_command_budget_plus_transport() {
    // The request must outlive the command (TS scaledExecTimeoutMs):
    // timeoutSeconds * 1000 + requestTimeoutMs.
    let response = TransportResponse {
        status: 200,
        body: br#"{"stdout":"","stderr":"","exit_code":0}"#.to_vec(),
    };
    let transport = scripted::ScriptedTransport::new(vec![response]);
    let client = PrimeSandboxClient::with_transport(
        &transport,
        API_KEY,
        ClientOptions {
            base_url: "https://api.example.com".to_string(),
            team_id: None,
            request_timeout: Some(Duration::from_millis(5_000)),
            allow_insecure_localhost: false,
        },
    )
    .unwrap();
    client
        .exec_container_command(
            SANDBOX_ID,
            ExecRequest {
                command: "ls".to_string(),
                working_dir: None,
                env: None,
                timeout_seconds: Some(60),
                user: None,
            },
            &GatewayOptions {
                auth: Some(GatewayAuth {
                    sandbox_id: SANDBOX_ID.to_string(),
                    gateway_url: "https://gw.example.com".to_string(),
                    user_namespace: "ns".to_string(),
                    job_id: "job".to_string(),
                    token: "tok".to_string(),
                    expires_at: "2026-09-16T01:00:00Z".to_string(),
                }),
                request_timeout: None,
            },
        )
        .await
        .unwrap();
    let recorded = transport.recorded();
    assert_eq!(recorded[0].timeout, Some(Duration::from_secs(65)));
}

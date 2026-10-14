//! Lifecycle verifiers over a scripted in-process transport: wire shapes
//! (URLs, headers, `snake_case` create body with `vm: true`, idempotency
//! key reuse across retries, team scoping), status mapping, delete 404
//! tolerance, wait semantics, and retry discipline. The transport trait
//! is the injection seam; the real reqwest transport has its own suite
//! (`tests/transport_loopback.rs`).

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use pa_sandbox::transport::{SandboxTransport, TransportRequest, TransportResponse};
use pa_sandbox::{
    ClientOptions, PrimeSandboxClient, Sandbox, SandboxErrorCode, SandboxStatus, VmCreateRequest,
    WaitOptions,
};
use serde_json::json;

/// One scripted reply: an HTTP response or a transport failure.
#[derive(Debug)]
enum Reply {
    Response(TransportResponse),
    Failure(pa_sandbox::SandboxError),
}

/// An in-process transport recording every request and answering from a
/// queue of scripted replies; when the queue drains the last reply
/// repeats (the TS `fetchRecorder` rule).
#[derive(Default, Debug)]
struct ScriptedTransport {
    replies: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<TransportRequest>>,
}

impl ScriptedTransport {
    fn new(replies: Vec<Reply>) -> Self {
        Self {
            replies: Mutex::new(replies.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn recorded(&self) -> Vec<TransportRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl SandboxTransport for &ScriptedTransport {
    #[allow(clippy::unused_async_trait_impl)] // This scripted test transport completes immediately.
    async fn execute(
        &self,
        request: TransportRequest,
    ) -> Result<TransportResponse, pa_sandbox::SandboxError> {
        self.requests.lock().unwrap().push(request);
        let mut replies = self.replies.lock().unwrap();
        let outcome = match replies.front() {
            Some(Reply::Response(response)) => Ok(response.clone()),
            Some(Reply::Failure(error)) => Err(clone_error(error)),
            None => Err(pa_sandbox::SandboxError::network("no scripted reply")),
        };
        // Consume the served reply unless it is the last: the last reply
        // repeats (the TS `fetchRecorder` rule).
        if replies.len() > 1 {
            replies.pop_front();
        }
        outcome
    }
}

/// Errors are re-delivered verbatim (the queue only stores the script).
fn clone_error(error: &pa_sandbox::SandboxError) -> pa_sandbox::SandboxError {
    pa_sandbox::SandboxError::network(error.to_string())
}

#[allow(clippy::needless_pass_by_value)] // Test fixtures own their one-shot JSON bodies.
fn ok(body: serde_json::Value) -> Reply {
    Reply::Response(TransportResponse {
        status: 200,
        body: body.to_string().into_bytes(),
    })
}

#[allow(clippy::needless_pass_by_value)] // Test fixtures own their one-shot JSON bodies.
fn status_reply(status: u16, body: serde_json::Value) -> Reply {
    Reply::Response(TransportResponse {
        status,
        body: body.to_string().into_bytes(),
    })
}

fn network_failure() -> Reply {
    Reply::Failure(pa_sandbox::SandboxError::network("connection reset"))
}

/// The reference wire record: the full TS-verified field set.
fn sandbox_wire(status: &str) -> serde_json::Value {
    json!({
        "id": "sb-1",
        "name": "agent",
        "dockerImage": "prime/primeintellect/prime-agent-frpc:0.9.7",
        "startCommand": null,
        "cpuCores": 4.0,
        "memoryGB": 16.0,
        "diskSizeGB": 50.0,
        "diskMountPath": "/workspace",
        "gpuCount": 0,
        "gpuType": null,
        "vm": true,
        "network_allowlist": null,
        "network_denylist": null,
        "status": status,
        "timeoutMinutes": 120,
        "idleTimeoutMinutes": null,
        "terminationReason": null,
        "environmentVars": null,
        "secrets": null,
        "labels": ["cloud"],
        "createdAt": "2026-09-29T00:00:00Z",
        "updatedAt": "2026-09-29T00:01:00Z",
        "startedAt": "2026-09-29T00:01:00Z",
        "terminatedAt": null,
        "exitCode": null,
        "errorType": null,
        "errorMessage": null,
        "userId": "user-1",
        "teamId": "team-1",
        "kubernetesJobId": null,
        "region": null,
        "registryCredentialsId": null,
        "pendingImageBuildId": null,
    })
}

fn create_request() -> VmCreateRequest {
    VmCreateRequest {
        name: "agent".to_string(),
        docker_image: "prime/primeintellect/prime-agent-frpc:0.9.7".to_string(),
        cpu_cores: 4.0,
        memory_gb: 16.0,
        disk_size_gb: 50.0,
        gpu_count: 0,
        gpu_type: None,
        start_command: None,
        network_allowlist: None,
        network_denylist: None,
        timeout_minutes: 120,
        idle_timeout_minutes: None,
        environment_vars: None,
        secrets: None,
        labels: vec!["cloud".to_string()],
        idempotency_key: None,
    }
}

fn test_client(transport: &ScriptedTransport) -> PrimeSandboxClient<&ScriptedTransport> {
    PrimeSandboxClient::with_transport(
        transport,
        "test-key",
        ClientOptions {
            base_url: "https://api.test".to_string(),
            team_id: None,
            request_timeout: None,
            allow_insecure_localhost: false,
        },
    )
    .unwrap()
}

#[tokio::test]
async fn create_sends_the_vm_wire_contract() {
    let transport = ScriptedTransport::new(vec![ok(sandbox_wire("RUNNING"))]);
    let client = test_client(&transport);
    let sandbox = client.create_vm_sandbox(create_request()).await.unwrap();
    assert_eq!(sandbox.id, "sb-1");
    assert_eq!(sandbox.status, SandboxStatus::Running);
    assert!(sandbox.vm);

    let recorded = transport.recorded();
    assert_eq!(
        recorded.len(),
        1,
        "a successful create sends exactly one request"
    );
    let request = &recorded[0];
    assert_eq!(request.url, "https://api.test/api/v1/sandbox");
    assert_eq!(request.method.as_str(), "POST");
    assert_eq!(
        request.headers,
        vec![
            ("Authorization".to_string(), "Bearer test-key".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ]
    );
    let mut body: serde_json::Value =
        serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["idempotency_key"].as_str().unwrap().len(), 32);
    body["idempotency_key"] = json!("the-key");
    // The TS field order, snake_case, `vm` forced true, key present.
    assert_eq!(
        body.to_string(),
        "{\"name\":\"agent\",\"docker_image\":\"prime/primeintellect/prime-agent-frpc:0.9.7\",\"cpu_cores\":4.0,\"memory_gb\":16.0,\"disk_size_gb\":50.0,\"gpu_count\":0,\"vm\":true,\"timeout_minutes\":120,\"labels\":[\"cloud\"],\"idempotency_key\":\"the-key\"}"
    );
}

#[tokio::test]
async fn create_reuses_the_idempotency_key_across_transient_retries() {
    let transport = ScriptedTransport::new(vec![
        network_failure(),
        network_failure(),
        ok(sandbox_wire("PENDING")),
    ]);
    let client = test_client(&transport);
    let sandbox = client.create_vm_sandbox(create_request()).await.unwrap();
    assert_eq!(sandbox.status, SandboxStatus::Pending);

    let recorded = transport.recorded();
    assert_eq!(recorded.len(), 3, "two transient failures retry");
    let keys: Vec<String> = recorded
        .iter()
        .map(|request| {
            let body: serde_json::Value =
                serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
            body["idempotency_key"].as_str().unwrap().to_string()
        })
        .collect();
    assert_eq!(keys.len(), 3);
    assert_eq!(keys[0], keys[1]);
    assert_eq!(keys[1], keys[2], "the same server-side key is reused");
    assert_eq!(keys[0].len(), 32, "a fresh key is a simple uuid v4");
}

#[tokio::test]
async fn create_honors_a_caller_idempotency_key() {
    let transport = ScriptedTransport::new(vec![ok(sandbox_wire("PENDING"))]);
    let client = test_client(&transport);
    let request = VmCreateRequest {
        idempotency_key: Some("caller-key-1".to_string()),
        ..create_request()
    };
    client.create_vm_sandbox(request).await.unwrap();
    let body: serde_json::Value =
        serde_json::from_str(transport.recorded()[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(body["idempotency_key"], "caller-key-1");
}

#[tokio::test]
async fn create_stops_retrying_after_three_transient_failures() {
    let transport = ScriptedTransport::new(vec![
        network_failure(),
        network_failure(),
        network_failure(),
    ]);
    let client = test_client(&transport);
    let error = client
        .create_vm_sandbox(create_request())
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Network);
    assert_eq!(
        transport.recorded().len(),
        3,
        "the retry budget is three attempts"
    );
}

#[tokio::test]
async fn create_does_not_retry_http_errors() {
    let transport = ScriptedTransport::new(vec![status_reply(
        400,
        json!({"detail": "image not found"}),
    )]);
    let client = test_client(&transport);
    let error = client
        .create_vm_sandbox(create_request())
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
    assert_eq!(error.status(), Some(400));
    assert_eq!(error.details().unwrap(), "{\"detail\":\"image not found\"}");
    assert_eq!(transport.recorded().len(), 1, "a 400 is not retried");
}

#[tokio::test]
async fn create_appends_the_team_id_when_set() {
    let transport = ScriptedTransport::new(vec![ok(sandbox_wire("PENDING"))]);
    let client = PrimeSandboxClient::with_transport(
        &transport,
        "test-key",
        ClientOptions {
            base_url: "https://api.test/api/v1/".to_string(),
            team_id: Some("team-77".to_string()),
            request_timeout: None,
            allow_insecure_localhost: false,
        },
    )
    .unwrap();
    client.create_vm_sandbox(create_request()).await.unwrap();
    let request = &transport.recorded()[0];
    // A trailing /api/v1 in the base URL normalizes away.
    assert_eq!(request.url, "https://api.test/api/v1/sandbox");
    let body: serde_json::Value = serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["team_id"], "team-77");
}

#[tokio::test]
async fn get_fetches_the_record_and_maps_statuses() {
    let transport = ScriptedTransport::new(vec![ok(sandbox_wire("PROVISIONING"))]);
    let client = test_client(&transport);
    let sandbox = client.get_sandbox("sb-1").await.unwrap();
    assert_eq!(sandbox.status, SandboxStatus::Provisioning);
    let request = &transport.recorded()[0];
    assert_eq!(request.url, "https://api.test/api/v1/sandbox/sb-1");
    assert_eq!(request.method.as_str(), "GET");
    assert!(request.body.is_none());

    let transport = ScriptedTransport::new(vec![status_reply(408, json!({}))]);
    let client = test_client(&transport);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::RequestTimeout);
    assert_eq!(error.status(), Some(408));

    let transport = ScriptedTransport::new(vec![status_reply(409, json!({}))]);
    let client = test_client(&transport);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Conflict);

    let transport = ScriptedTransport::new(vec![status_reply(
        502,
        json!({"error": "sandbox_not_found"}),
    )]);
    let client = test_client(&transport);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::SandboxNotFound);

    // A 502 without the sandbox_not_found body stays a generic HTTP error.
    let transport = ScriptedTransport::new(vec![status_reply(502, json!({"error": "boom"}))]);
    let client = test_client(&transport);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
}

#[tokio::test]
async fn get_rejects_malformed_success_bodies() {
    let transport = ScriptedTransport::new(vec![
        ok(json!("just a string")),
        ok(json!({"id": "sb-1"})),
        Reply::Response(TransportResponse {
            status: 200,
            body: b"not json".to_vec(),
        }),
    ]);
    let client = test_client(&transport);
    for _ in 0..3 {
        let error = client.get_sandbox("sb-1").await.unwrap_err();
        assert_eq!(error.code(), SandboxErrorCode::InvalidResponse);
    }
}

#[tokio::test]
async fn delete_is_idempotent_and_tolerates_404() {
    let transport = ScriptedTransport::new(vec![
        ok(json!({"detail": "deleted"})),
        status_reply(404, json!({"detail": "not found"})),
        ok(json!(null)),
    ]);
    let client = test_client(&transport);
    client.delete_sandbox("sb-1").await.unwrap();
    client.delete_sandbox("sb-1").await.unwrap();
    let error = client.delete_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidResponse);

    let recorded = transport.recorded();
    assert_eq!(recorded.len(), 3, "every delete sends one request");
    assert_eq!(recorded[0].url, "https://api.test/api/v1/sandbox/sb-1");
    assert_eq!(recorded[0].method.as_str(), "DELETE");
}

#[tokio::test]
async fn delete_surfaces_other_errors() {
    let transport = ScriptedTransport::new(vec![status_reply(500, json!({"detail": "boom"}))]);
    let client = test_client(&transport);
    let error = client.delete_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
    assert_eq!(error.status(), Some(500));
}

#[tokio::test]
async fn wait_polls_until_running() {
    let transport = ScriptedTransport::new(vec![
        ok(sandbox_wire("PENDING")),
        ok(sandbox_wire("PROVISIONING")),
        ok(sandbox_wire("RUNNING")),
    ]);
    let client = test_client(&transport);
    let sandbox = client
        .wait_for_running(
            "sb-1",
            WaitOptions {
                timeout: Duration::from_secs(5),
                poll_interval: Duration::from_millis(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(sandbox.status, SandboxStatus::Running);
    assert_eq!(transport.recorded().len(), 3);
}

#[tokio::test]
async fn wait_fails_fast_on_terminal_status() {
    let mut wire = sandbox_wire("ERROR");
    wire["errorType"] = json!("ImagePullFailure");
    wire["errorMessage"] = json!("image pull failed");
    let transport = ScriptedTransport::new(vec![ok(sandbox_wire("PENDING")), ok(wire)]);
    let client = test_client(&transport);
    let error = client
        .wait_for_running(
            "sb-1",
            WaitOptions {
                timeout: Duration::from_secs(5),
                poll_interval: Duration::from_millis(1),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::TerminalStatus);
    let rendered = error.to_string();
    assert!(rendered.contains("terminal status ERROR"));
    assert_eq!(
        error.details().unwrap(),
        "ImagePullFailure: image pull failed"
    );
}

#[tokio::test]
async fn wait_fails_with_timeout_when_the_budget_is_exhausted() {
    // The last reply repeats: the sandbox stays PENDING forever.
    let transport = ScriptedTransport::new(vec![ok(sandbox_wire("PENDING"))]);
    let client = test_client(&transport);
    let error = client
        .wait_for_running(
            "sb-1",
            WaitOptions {
                timeout: Duration::from_millis(10),
                poll_interval: Duration::from_millis(2),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Timeout);
    assert_eq!(error.details().unwrap(), "last status PENDING");
}

#[tokio::test]
async fn wait_rejects_bad_ids_and_options() {
    let transport = ScriptedTransport::default();
    let client = test_client(&transport);
    let error = client
        .wait_for_running("bad id!", WaitOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);
    let error = client
        .wait_for_running(
            "sb-1",
            WaitOptions {
                timeout: Duration::ZERO,
                poll_interval: Duration::ZERO,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);
}

#[tokio::test]
async fn redirects_surface_as_refused_not_followed() {
    let transport = ScriptedTransport::new(vec![status_reply(302, json!({}))]);
    let client = test_client(&transport);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::Http);
    assert_eq!(error.status(), Some(302));
    let rendered = error.to_string();
    assert!(rendered.contains("refused a redirect"));
    assert_eq!(
        transport.recorded().len(),
        1,
        "no follow-up request is made"
    );
}

#[tokio::test]
async fn error_details_never_leak_the_api_key() {
    let transport = ScriptedTransport::new(vec![status_reply(
        403,
        json!({"detail": "bad key test-key", "api_key": "test-key"}),
    )]);
    let client = test_client(&transport);
    let error = client.get_sandbox("sb-1").await.unwrap_err();
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("test-key"));
    assert!(error.details().unwrap().contains("[redacted]"));
}

#[tokio::test]
async fn invalid_requests_send_nothing() {
    let transport = ScriptedTransport::default();
    let client = test_client(&transport);
    let mut request = create_request();
    request.cpu_cores = 100.0;
    let error = client.create_vm_sandbox(request).await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);
    let error = client.get_sandbox("bad id!").await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);
    assert_eq!(
        transport.recorded().len(),
        0,
        "no wire traffic on local rejects"
    );
}

#[tokio::test]
async fn construction_validates_the_configuration() {
    let transport = ScriptedTransport::default();
    let options = ClientOptions {
        base_url: "https://api.test".to_string(),
        team_id: None,
        request_timeout: None,
        allow_insecure_localhost: false,
    };
    let error = PrimeSandboxClient::with_transport(&transport, "", options.clone()).unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);

    let error = PrimeSandboxClient::with_transport(
        &transport,
        "key",
        ClientOptions {
            base_url: "http://api.test".to_string(),
            ..options.clone()
        },
    )
    .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);

    let error = PrimeSandboxClient::with_transport(
        &transport,
        "key",
        ClientOptions {
            base_url: "https://api.test".to_string(),
            request_timeout: Some(Duration::ZERO),
            ..options
        },
    )
    .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidRequest);
}

#[tokio::test]
#[allow(clippy::float_cmp)] // Exact integer-valued JSON numbers must match the reference profile.
async fn sandbox_records_match_the_reference_profile() {
    let transport = ScriptedTransport::new(vec![ok(sandbox_wire("RUNNING"))]);
    let client = test_client(&transport);
    let sandbox: Sandbox = client.get_sandbox("sb-1").await.unwrap();
    assert_eq!(
        sandbox.docker_image,
        "prime/primeintellect/prime-agent-frpc:0.9.7"
    );
    assert_eq!(sandbox.cpu_cores, 4.0);
    assert_eq!(sandbox.memory_gb, 16.0);
    assert_eq!(sandbox.disk_size_gb, 50.0);
    assert_eq!(sandbox.gpu_count, 0);
    assert_eq!(sandbox.timeout_minutes, 120);
    assert_eq!(sandbox.labels, vec!["cloud".to_string()]);
    assert_eq!(sandbox.team_id.as_deref(), Some("team-1"));
}

//! Lifecycle verifiers over a scripted in-process transport: create
//! idempotency, list by label, pause and resume, checkpoint wait, and
//! delete 404 tolerance. The real reqwest transport has its own suite
//! (`tests/transport_loopback.rs`).
//
// Test-only allows: scripted replies return without awaiting (the trait
// seam), and resource fields compare exactly (the repo's
// `cfg_attr(test, ...)` float posture).
#![allow(
    clippy::unused_async_trait_impl,
    clippy::float_cmp,
    clippy::needless_pass_by_value
)]

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use pa_sandbox::transport::{
    ResponseChunks, SandboxTransport, StreamedResponse, TransportRequest, TransportResponse,
};
use pa_sandbox::{
    ClientOptions, PrimeSandboxClient, SandboxError, SandboxErrorCode, SandboxStatus,
    VmCreateRequest, NO_TIMEOUT_MINUTES,
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
/// repeats.
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

// The scripted transport satisfies the RPITIT seam without awaiting.
#[allow(clippy::unused_async_trait_impl)]
impl SandboxTransport for &ScriptedTransport {
    async fn execute_streaming(
        &self,
        request: TransportRequest,
    ) -> Result<StreamedResponse, pa_sandbox::SandboxError> {
        let response = SandboxTransport::execute(self, request).await?;
        Ok(StreamedResponse {
            status: response.status,
            headers: Vec::new(),
            body: ResponseChunks::Queued(std::iter::once(response.body).collect()),
        })
    }

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
        // The last reply repeats.
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
    sandbox_with_id("sb-1", status)
}

fn sandbox_with_id(id: &str, status: &str) -> serde_json::Value {
    json!({
        "id": id,
        "name": "agent",
        "dockerImage": "prime-agent:test",
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
        docker_image: "prime-agent:test".to_string(),
        cpu_cores: 4.0,
        memory_gb: 16.0,
        disk_size_gb: 50.0,
        gpu_count: 0,
        gpu_type: None,
        start_command: None,
        network_allowlist: None,
        network_denylist: None,
        timeout_minutes: NO_TIMEOUT_MINUTES,
        idle_timeout_minutes: None,
        environment_vars: None,
        secrets: None,
        network_rules: None,
        labels: vec!["prime-agent-bot".to_string()],
        idempotency_key: None,
        checkpoint_id: None,
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

fn body_of(request: &TransportRequest) -> serde_json::Value {
    serde_json::from_slice(request.body.as_deref().unwrap()).unwrap()
}

#[tokio::test]
async fn create_reuses_the_idempotency_key_across_transient_retries() {
    let transport = ScriptedTransport::new(vec![
        network_failure(),
        network_failure(),
        ok(sandbox_wire("PENDING")),
    ]);
    let client = test_client(&transport);
    let sandbox = client.create_vm_sandbox(&create_request()).await.unwrap();
    assert_eq!(sandbox.status, SandboxStatus::Pending);

    let bodies: Vec<_> = transport.recorded().iter().map(body_of).collect();
    assert_eq!(bodies.len(), 3, "two transient failures retry");
    assert!(bodies
        .iter()
        .all(|body| body["idempotency_key"] == bodies[0]["idempotency_key"]));
    assert_eq!(bodies[0]["vm"], json!(true));
    assert_eq!(bodies[0]["timeout_minutes"], json!(-1), "no lifetime cap");

    // A caller key goes to the wire as given; an HTTP error is not retried.
    let transport = ScriptedTransport::new(vec![status_reply(500, json!({}))]);
    let client = test_client(&transport);
    let mut request = create_request();
    request.idempotency_key = Some("bot-1-gen-0".to_string());
    client.create_vm_sandbox(&request).await.unwrap_err();
    let recorded = transport.recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        body_of(&recorded[0])["idempotency_key"],
        json!("bot-1-gen-0")
    );
}

#[tokio::test]
async fn list_by_label_follows_every_page() {
    let transport = ScriptedTransport::new(vec![
        ok(json!({
            "sandboxes": [sandbox_with_id("sb-1", "RUNNING")],
            "total": null, "page": 1, "per_page": 1, "has_next": true, "next_cursor": null,
        })),
        ok(json!({
            "sandboxes": [sandbox_with_id("sb-2", "PAUSED")],
            "total": null, "page": 2, "per_page": 1, "has_next": false, "next_cursor": null,
        })),
    ]);
    let client = test_client(&transport);
    let labels = vec![
        "prime-agent-bot".to_string(),
        "prime-agent-bot:b1".to_string(),
    ];
    let sandboxes = client.list_sandboxes(&labels).await.unwrap();
    let ids: Vec<_> = sandboxes
        .iter()
        .map(|sandbox| sandbox.id.as_str())
        .collect();
    assert_eq!(ids, ["sb-1", "sb-2"]);
    assert_eq!(sandboxes[1].status, SandboxStatus::Paused);

    let urls: Vec<_> = transport.recorded().into_iter().map(|r| r.url).collect();
    let query = "https://api.test/api/v1/sandbox?per_page=100&is_active=true&labels=prime-agent-bot&labels=prime-agent-bot%3Ab1";
    assert_eq!(urls, [format!("{query}&page=1"), format!("{query}&page=2")]);
}

#[tokio::test]
async fn list_by_label_rejects_a_repeated_cursor() {
    let page = json!({
        "sandboxes": [sandbox_with_id("sb-1", "RUNNING")],
        "total": null, "page": 1, "per_page": 1, "has_next": true, "next_cursor": "c1",
    });
    let transport = ScriptedTransport::new(vec![ok(page.clone()), ok(page)]);
    let client = test_client(&transport);
    let error = client.list_sandboxes(&[]).await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidResponse);
    assert_eq!(transport.recorded().len(), 2);
}

#[tokio::test]
async fn pause_returns_the_checkpoint_and_resume_answers_the_record() {
    let mut paused = sandbox_wire("RUNNING");
    paused["checkpoint_id"] = json!("ckpt-1");
    let transport = ScriptedTransport::new(vec![ok(paused), ok(sandbox_wire("PAUSED"))]);
    let client = test_client(&transport);
    let pause = client.pause_sandbox("sb-1").await.unwrap();
    assert_eq!(pause.checkpoint_id.as_deref(), Some("ckpt-1"));
    assert_eq!(pause.sandbox.id, "sb-1");
    let resumed = client.resume_sandbox("sb-1").await.unwrap();
    assert_eq!(resumed.status, SandboxStatus::Paused);

    let recorded = transport.recorded();
    assert_eq!(recorded[0].method.as_str(), "POST");
    assert_eq!(
        recorded[0].url,
        "https://api.test/api/v1/sandbox/sb-1/pause"
    );
    assert_eq!(
        recorded[1].url,
        "https://api.test/api/v1/sandbox/sb-1/resume"
    );
}

#[tokio::test]
async fn a_network_rules_update_replaces_the_whole_policy() {
    let transport = ScriptedTransport::new(vec![ok(json!({ "generation": 2, "applied": false }))]);
    let client = test_client(&transport);
    let rules = std::collections::BTreeMap::from([(
        "api.example.com".to_string(),
        pa_sandbox::HeaderRule {
            headers: std::collections::BTreeMap::from([(
                "Authorization".to_string(),
                "Bearer ${prime.secrets.EXAMPLE}".to_string(),
            )]),
        },
    )]);
    client.set_network_rules("sb-1", &rules).await.unwrap();

    let recorded = transport.recorded();
    assert_eq!(recorded[0].method.as_str(), "PUT");
    assert_eq!(
        recorded[0].url,
        "https://api.test/api/v1/sandbox/sb-1/egress-policy"
    );
    let body: serde_json::Value =
        serde_json::from_slice(recorded[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(
        body,
        json!({
            "denylist": [],
            "rules": { "api.example.com": { "headers": { "Authorization": "Bearer ${prime.secrets.EXAMPLE}" } } },
        })
    );
}

fn checkpoint_wire(state: &str) -> serde_json::Value {
    checkpoint_with_id("ckpt-1", state, "2026-09-29T00:00:00Z")
}

fn checkpoint_with_id(id: &str, state: &str, created_at: &str) -> serde_json::Value {
    json!({
        "id": id,
        "sandbox_id": "sb-1",
        "state": state,
        "depth": 0,
        "docker_image": "prime-agent:test",
        "created_at": created_at,
        "updated_at": created_at,
    })
}

#[tokio::test]
async fn checkpoint_list_by_label_follows_every_page() {
    let transport = ScriptedTransport::new(vec![
        ok(json!({
            "checkpoints": [checkpoint_with_id("ckpt-1", "DURABLE", "2026-09-29T00:00:00Z")],
            "next_cursor": "c1",
        })),
        ok(json!({
            "checkpoints": [checkpoint_with_id("ckpt-2", "PENDING", "2026-09-29T00:01:00Z")],
            "next_cursor": null,
        })),
    ]);
    let client = test_client(&transport);
    let labels = vec!["prime-agent-bot:b1".to_string()];
    let checkpoints = client.list_checkpoints(&labels).await.unwrap();
    let ids: Vec<_> = checkpoints.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["ckpt-1", "ckpt-2"], "the platform lists oldest first");
    assert!(checkpoints[0].is_durable());
    assert!(!checkpoints[1].is_durable());

    let urls: Vec<_> = transport.recorded().into_iter().map(|r| r.url).collect();
    assert_eq!(
        urls,
        [
            "https://api.test/api/v1/sandbox/checkpoints?limit=500&labels=prime-agent-bot%3Ab1",
            "https://api.test/api/v1/sandbox/checkpoints?limit=500&labels=prime-agent-bot%3Ab1&cursor=c1",
        ]
    );
}

#[tokio::test]
async fn checkpoint_list_rejects_a_repeated_cursor_and_a_malformed_body() {
    let page = json!({
        "checkpoints": [checkpoint_with_id("ckpt-1", "DURABLE", "2026-09-29T00:00:00Z")],
        "next_cursor": "c1",
    });
    let transport = ScriptedTransport::new(vec![ok(page.clone()), ok(page)]);
    let client = test_client(&transport);
    let error = client.list_checkpoints(&[]).await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidResponse);
    assert_eq!(transport.recorded().len(), 2);

    let transport = ScriptedTransport::new(vec![ok(json!({"checkpoints": [json!("nope")]}))]);
    let client = test_client(&transport);
    let error = client.list_checkpoints(&[]).await.unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::InvalidResponse);
}

#[tokio::test]
async fn wait_for_checkpoint_polls_until_durable() {
    let transport = ScriptedTransport::new(vec![
        ok(checkpoint_wire("PENDING")),
        ok(checkpoint_wire("FROZEN")),
        ok(checkpoint_wire("DURABLE")),
    ]);
    let client = test_client(&transport);
    let checkpoint = client
        .wait_for_checkpoint("ckpt-1", Duration::from_secs(5), Duration::from_millis(1))
        .await
        .unwrap();
    assert!(checkpoint.is_durable());
    assert_eq!(transport.recorded().len(), 3);
}

#[tokio::test]
async fn wait_for_checkpoint_reports_the_redacted_terminal_error() {
    let mut failed = checkpoint_wire("FAILED");
    failed["error"] = json!("upload rejected for test-key");
    let transport = ScriptedTransport::new(vec![ok(failed)]);
    let client = test_client(&transport);
    let error = client
        .wait_for_checkpoint("ckpt-1", Duration::from_secs(5), Duration::from_millis(1))
        .await
        .unwrap_err();
    assert_eq!(error.code(), SandboxErrorCode::TerminalStatus);
    assert_eq!(
        error.details(),
        Some(SandboxError::redact_secrets("upload rejected for test-key", &["test-key"]).as_str())
    );
}

#[tokio::test]
async fn delete_treats_404_as_success() {
    let transport = ScriptedTransport::new(vec![
        status_reply(404, json!({"detail": "not found"})),
        status_reply(404, json!({"detail": "not found"})),
        status_reply(500, json!({"detail": "boom"})),
    ]);
    let client = test_client(&transport);
    client.delete_sandbox("sb-1").await.unwrap();
    client.delete_checkpoint("ckpt-1").await.unwrap();
    assert_eq!(
        client.delete_sandbox("sb-1").await.unwrap_err().status(),
        Some(500)
    );
}

//! The sandbox record parser: the strict `GET /api/v1/sandbox/{id}`
//! response contract. Port of `parsePrimeSandbox` in
//! `prime-sandbox-client.ts` (TS branch `feat/direct-cloud-sandbox`):
//! `camelCase` aliases with `snake_case` egress lists kept verbatim (the
//! platform's `SandboxResponse` shape, verified in the TS client against
//! the SDK and backend). A malformed body is a typed `invalid_response`
//! error, never a silent default.

use crate::error::SandboxError;
use crate::types::{Sandbox, SandboxStatus};
use serde::Deserialize;

/// The raw wire form of a sandbox record: `camelCase` aliases with the
/// `snake_case` egress lists kept verbatim (the platform's
/// `SandboxResponse` shape, verified in the TS client against the SDK and
/// backend).
#[derive(Debug, Deserialize)]
struct RawSandbox {
    id: String,
    name: String,
    #[serde(rename = "dockerImage")]
    docker_image: String,
    status: String,
    #[serde(rename = "cpuCores")]
    cpu_cores: f64,
    #[serde(rename = "memoryGB")]
    memory_gb: f64,
    #[serde(rename = "diskSizeGB")]
    disk_size_gb: f64,
    #[serde(rename = "gpuCount")]
    gpu_count: i64,
    #[serde(rename = "gpuType")]
    gpu_type: Option<String>,
    vm: bool,
    #[serde(rename = "network_allowlist")]
    network_allowlist: Option<Vec<String>>,
    #[serde(rename = "network_denylist")]
    network_denylist: Option<Vec<String>>,
    #[serde(rename = "timeoutMinutes")]
    timeout_minutes: i64,
    #[serde(rename = "idleTimeoutMinutes")]
    idle_timeout_minutes: Option<i64>,
    #[serde(rename = "terminationReason")]
    termination_reason: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "startedAt")]
    started_at: Option<String>,
    #[serde(rename = "terminatedAt")]
    terminated_at: Option<String>,
    #[serde(rename = "exitCode")]
    exit_code: Option<i64>,
    #[serde(rename = "errorType")]
    error_type: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
    #[serde(rename = "userId")]
    user_id: Option<String>,
    #[serde(rename = "teamId")]
    team_id: Option<String>,
    region: Option<String>,
}

fn require_non_empty(value: &str, field: &str) -> Result<(), SandboxError> {
    if value.is_empty() {
        return Err(SandboxError::invalid_response(format!(
            "Sandbox response field {field} must be a non-empty string"
        )));
    }
    Ok(())
}

/// Strictly validate a sandbox record (the `GET /sandbox/{id}` and create
/// response body): a JSON object with typed fields, a known status, and
/// non-empty required strings. A malformed body is a typed
/// `invalid_response` error, never a silent default (TS
/// `parsePrimeSandbox`).
pub(crate) fn parse_sandbox(value: serde_json::Value) -> Result<Sandbox, SandboxError> {
    let raw: RawSandbox = serde_json::from_value(value)
        .map_err(|_| SandboxError::invalid_response("Sandbox response record is malformed"))?;
    let status = SandboxStatus::from_wire(&raw.status)
        .ok_or_else(|| SandboxError::invalid_response("Sandbox response has unknown status"))?;
    for (field, value) in [
        ("id", raw.id.as_str()),
        ("name", raw.name.as_str()),
        ("dockerImage", raw.docker_image.as_str()),
        ("createdAt", raw.created_at.as_str()),
        ("updatedAt", raw.updated_at.as_str()),
    ] {
        require_non_empty(value, field)?;
    }
    let gpu_count = u32::try_from(raw.gpu_count).map_err(|_| {
        SandboxError::invalid_response(
            "Sandbox response field gpuCount must be a non-negative integer",
        )
    })?;
    Ok(Sandbox {
        id: raw.id,
        name: raw.name,
        docker_image: raw.docker_image,
        status,
        cpu_cores: raw.cpu_cores,
        memory_gb: raw.memory_gb,
        disk_size_gb: raw.disk_size_gb,
        gpu_count,
        gpu_type: raw.gpu_type,
        vm: raw.vm,
        network_allowlist: raw.network_allowlist,
        network_denylist: raw.network_denylist,
        timeout_minutes: raw.timeout_minutes,
        idle_timeout_minutes: raw.idle_timeout_minutes,
        termination_reason: raw.termination_reason,
        labels: raw.labels,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        started_at: raw.started_at,
        terminated_at: raw.terminated_at,
        exit_code: raw.exit_code,
        error_type: raw.error_type,
        error_message: raw.error_message,
        user_id: raw.user_id,
        team_id: raw.team_id,
        region: raw.region,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox_wire() -> serde_json::Value {
        serde_json::json!({
            "id": "sb-1",
            "name": "agent",
            "dockerImage": "prime/primeintellect/prime-agent-frpc:0.9.7",
            "status": "RUNNING",
            "cpuCores": 4.0,
            "memoryGB": 16.0,
            "diskSizeGB": 50.0,
            "diskMountPath": "/workspace",
            "gpuCount": 0,
            "vm": true,
            "network_allowlist": ["example.com"],
            "network_denylist": null,
            "timeoutMinutes": 120,
            "idleTimeoutMinutes": null,
            "terminationReason": null,
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
            "region": "us",
        })
    }

    #[test]
    #[allow(clippy::float_cmp)] // These exact integer-valued JSON numbers must round-trip unchanged.
    fn sandbox_records_parse_strictly() {
        let sandbox = parse_sandbox(sandbox_wire()).unwrap();
        assert_eq!(sandbox.id, "sb-1");
        assert_eq!(sandbox.status, SandboxStatus::Running);
        assert_eq!(sandbox.cpu_cores, 4.0);
        assert_eq!(sandbox.memory_gb, 16.0);
        assert_eq!(sandbox.disk_size_gb, 50.0);
        assert!(sandbox.vm);
        assert_eq!(
            sandbox.network_allowlist.as_deref(),
            Some(["example.com".to_string()].as_slice())
        );
        assert_eq!(sandbox.timeout_minutes, 120);
        assert_eq!(sandbox.labels, vec!["cloud".to_string()]);
        assert_eq!(sandbox.idle_timeout_minutes, None);
        assert_eq!(sandbox.terminated_at, None);
        assert_eq!(sandbox.exit_code, None);
        assert_eq!(sandbox.team_id.as_deref(), Some("team-1"));
    }

    #[test]
    fn sandbox_records_reject_malformed_bodies() {
        for broken in [
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::json!({"id": "sb-1"}),
            serde_json::Value::String("nope".to_string()),
        ] {
            assert!(parse_sandbox(broken).is_err());
        }
        let mut wire = sandbox_wire();
        wire["status"] = serde_json::json!("STARTING_LATER");
        assert!(parse_sandbox(wire).is_err());
        let mut wire = sandbox_wire();
        wire["id"] = serde_json::json!("");
        assert!(parse_sandbox(wire).is_err());
        let mut wire = sandbox_wire();
        wire["memoryGB"] = serde_json::json!("sixteen");
        assert!(parse_sandbox(wire).is_err());
        let mut wire = sandbox_wire();
        wire["vm"] = serde_json::json!("yes");
        assert!(parse_sandbox(wire).is_err());
    }

    #[test]
    fn malformed_record_error_never_echoes_untrusted_values() {
        let secret = "sk-synthetic-private-key";
        let mut wire = sandbox_wire();
        wire["cpuCores"] = serde_json::json!(format!("Bearer {secret}\r\n"));
        let rendered = parse_sandbox(wire).unwrap_err().to_string();
        assert_eq!(rendered, "Sandbox response record is malformed");
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains('\r'));
        assert!(!rendered.contains('\n'));
    }

    #[test]
    fn unknown_status_error_never_echoes_untrusted_body() {
        let secret = "sk-synthetic-private-key";
        let mut wire = sandbox_wire();
        wire["status"] = serde_json::json!(format!("INVALID\r\n{secret}{}", "x".repeat(2048)));
        let rendered = parse_sandbox(wire).unwrap_err().to_string();
        assert_eq!(rendered, "Sandbox response has unknown status");
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains('\r'));
        assert!(!rendered.contains('\n'));
    }

    #[test]
    fn unknown_response_fields_are_ignored_like_the_ts_parser() {
        let mut wire = sandbox_wire();
        wire["futureField"] = serde_json::json!({"x": 1});
        assert!(parse_sandbox(wire).is_ok());
    }
}

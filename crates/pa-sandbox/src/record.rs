//! The strict record parsers: sandbox (`camelCase` with `snake_case`
//! egress lists, the platform's `SandboxResponse` shape), paused sandbox,
//! sandbox list page, and checkpoint. A malformed body is a typed
//! `invalid_response` error, never a silent default.

use crate::error::SandboxError;
use crate::types::{PausedSandbox, Sandbox, SandboxStatus};
use serde::Deserialize;

/// The raw wire form of a sandbox record.
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
/// non-empty required strings.
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

/// The pause response: a sandbox record plus the checkpoint id the pause
/// froze (`checkpointId`, or `checkpoint_id`).
pub(crate) fn parse_paused(value: serde_json::Value) -> Result<PausedSandbox, SandboxError> {
    let checkpoint_id = match value
        .get("checkpointId")
        .or_else(|| value.get("checkpoint_id"))
    {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(id)) if !id.is_empty() => Some(id.clone()),
        Some(_) => {
            return Err(SandboxError::invalid_response(
                "Pause response field checkpointId must be a non-empty string",
            ))
        }
    };
    Ok(PausedSandbox {
        sandbox: parse_sandbox(value)?,
        checkpoint_id,
    })
}

/// One page of `GET /api/v1/sandbox`.
pub(crate) struct SandboxPage {
    pub(crate) sandboxes: Vec<Sandbox>,
    pub(crate) page: u64,
    pub(crate) has_next: bool,
    pub(crate) next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct RawPage {
    sandboxes: Vec<serde_json::Value>,
    page: u64,
    #[serde(alias = "hasNext")]
    has_next: bool,
    #[serde(default)]
    next_cursor: Option<String>,
}

pub(crate) fn parse_sandbox_page(value: serde_json::Value) -> Result<SandboxPage, SandboxError> {
    let raw: RawPage = serde_json::from_value(value)
        .map_err(|_| SandboxError::invalid_response("Sandbox list response is malformed"))?;
    Ok(SandboxPage {
        sandboxes: raw
            .sandboxes
            .into_iter()
            .map(parse_sandbox)
            .collect::<Result<_, _>>()?,
        page: raw.page,
        has_next: raw.has_next,
        next_cursor: raw.next_cursor.filter(|cursor| !cursor.is_empty()),
    })
}

/// One page of `GET /api/v1/sandbox/checkpoints`.
pub(crate) struct CheckpointPage {
    pub(crate) checkpoints: Vec<crate::types::SandboxCheckpoint>,
    pub(crate) next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct RawCheckpointPage {
    checkpoints: Vec<serde_json::Value>,
    #[serde(default)]
    next_cursor: Option<String>,
}

pub(crate) fn parse_checkpoint_page(
    value: serde_json::Value,
) -> Result<CheckpointPage, SandboxError> {
    let raw: RawCheckpointPage = serde_json::from_value(value)
        .map_err(|_| SandboxError::invalid_response("Checkpoint list response is malformed"))?;
    Ok(CheckpointPage {
        checkpoints: raw
            .checkpoints
            .into_iter()
            .map(parse_checkpoint)
            .collect::<Result<_, _>>()?,
        next_cursor: raw.next_cursor.filter(|cursor| !cursor.is_empty()),
    })
}

/// The checkpoint response record (validated non-empty where the
/// platform guarantees it).
pub(crate) fn parse_checkpoint(
    value: serde_json::Value,
) -> Result<crate::types::SandboxCheckpoint, SandboxError> {
    let checkpoint: crate::types::SandboxCheckpoint = serde_json::from_value(value)
        .map_err(|_| SandboxError::invalid_response("Checkpoint response record is malformed"))?;
    for (field, non_empty) in [
        ("id", !checkpoint.id.is_empty()),
        ("sandboxId", !checkpoint.sandbox_id.is_empty()),
        ("state", !checkpoint.state.is_empty()),
        ("createdAt", !checkpoint.created_at.is_empty()),
        ("updatedAt", !checkpoint.updated_at.is_empty()),
    ] {
        if !non_empty {
            return Err(SandboxError::invalid_response(format!(
                "Checkpoint response has empty {field}"
            )));
        }
    }
    Ok(checkpoint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox_wire() -> serde_json::Value {
        serde_json::json!({
            "id": "sb-1",
            "name": "agent",
            "dockerImage": "prime-agent:test",
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
}

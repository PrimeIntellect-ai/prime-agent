//! Wire-contract helpers: base-URL safety, id and create-request
//! validation, and the create body (`snake_case`, as the `prime_sandboxes`
//! SDK sends it). Egress entries and header rules are validated by the
//! platform.

use std::collections::BTreeMap;

use crate::error::SandboxError;
use crate::types::{VmCreateRequest, NO_TIMEOUT_MINUTES};

/// URL path segments derived from platform data: 1-128 characters of
/// letters, digits, dots, underscores, or dashes, starting with a letter
/// or digit.
const SEGMENT_PATTERN_MAX: usize = 128;

/// The loopback hosts allowed with plain `http://` when the client opts in
/// (both IPv6 literal spellings).
pub(crate) const LOCAL_HOSTNAMES: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/// The create-name length cap in bytes.
const MAX_NAME_BYTES: usize = 100;

/// The label length cap in bytes.
const MAX_LABEL_BYTES: usize = 256;

/// Env/secret key pattern: `[A-Za-z_][A-Za-z0-9_]*`.
pub(crate) fn is_env_var_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A platform URL path segment.
pub(crate) fn is_url_segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    match bytes.first() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let body_ok = bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    body_ok && bytes.len() <= SEGMENT_PATTERN_MAX
}

/// Validate an env/secrets record: shell-identifier keys, NUL-free values
///.
fn validate_env_record(record: &BTreeMap<String, String>, field: &str) -> Result<(), SandboxError> {
    for (key, value) in record {
        if !is_env_var_key(key) {
            return Err(SandboxError::invalid_request(format!(
                "{field} key {key:?} is not a valid env var name"
            )));
        }
        if value.contains('\0') {
            return Err(SandboxError::invalid_request(format!(
                "{field} values must be NUL-free strings"
            )));
        }
    }
    Ok(())
}

/// Validate and normalize the platform base URL (origin plus optional
/// `/api/v1` prefix). A trailing `/api/v1` is accepted and stripped; https
/// is required except for loopback hosts when
/// `allow_insecure_localhost` opts in.
pub(crate) fn normalize_base_url(
    value: &str,
    allow_insecure_localhost: bool,
) -> Result<String, SandboxError> {
    let invalid =
        || SandboxError::invalid_request("Prime sandbox base URL must be an https URL with a host");
    let value = value.trim();
    let parsed = url::Url::parse(value).map_err(|_| invalid())?;
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(invalid());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(invalid());
    }
    let scheme_ok = parsed.scheme() == "https"
        || (parsed.scheme() == "http"
            && allow_insecure_localhost
            && LOCAL_HOSTNAMES.contains(&parsed.host_str().unwrap_or_default()));
    if !scheme_ok || parsed.host_str().is_none() {
        return Err(invalid());
    }
    // Trim trailing slashes from the input, then strip the exact
    // `/api/v1` suffix (repeatedly): the documented `.../api/v1` form must
    // normalize, not be rejected.
    let mut trimmed = value.trim_end_matches('/');
    while let Some(stripped) = trimmed.strip_suffix("/api/v1") {
        trimmed = stripped.trim_end_matches('/');
    }
    if trimmed.is_empty() {
        return Err(invalid());
    }
    Ok(trimmed.to_string())
}

/// Validate a sandbox id before it is interpolated into a URL path.
pub(crate) fn assert_sandbox_id(value: &str) -> Result<(), SandboxError> {
    if !is_url_segment(value) {
        return Err(SandboxError::invalid_request(
            "Sandbox id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
        ));
    }
    Ok(())
}

/// Validate a create idempotency key against the shared segment pattern.
fn validate_idempotency_key(value: &str) -> Result<(), SandboxError> {
    if !is_url_segment(value) {
        return Err(SandboxError::invalid_request(
            "idempotencyKey must be 1-128 characters of letters, digits, dots, underscores, or dashes, starting with a letter or digit",
        ));
    }
    Ok(())
}

/// The image, restore source, and resource checks of a create request.
fn validate_source_and_resources(request: &VmCreateRequest) -> Result<(), SandboxError> {
    let restore = request
        .checkpoint_id
        .as_deref()
        .is_some_and(|checkpoint_id| !checkpoint_id.is_empty());
    if restore {
        if !request.docker_image.is_empty() {
            return Err(SandboxError::invalid_request(
                "dockerImage must be left unset when restoring a checkpoint (the checkpoint carries the image)",
            ));
        }
        if request.disk_size_gb > 0.0 {
            return Err(SandboxError::invalid_request(
                "diskSizeGb must be left unset when restoring a checkpoint (the checkpoint carries the disk)",
            ));
        }
    } else if request.docker_image.is_empty()
        || request.docker_image.chars().any(char::is_whitespace)
    {
        return Err(SandboxError::invalid_request(
            "dockerImage must be a non-empty whitespace-free string",
        ));
    }
    let resource_checks: &[(&str, f64, f64, f64)] = if restore {
        // A restore carries the checkpoint's disk size; only the
        // compute resources stay caller-selectable.
        &[
            ("cpuCores", request.cpu_cores, 0.1, 16.0),
            ("memoryGb", request.memory_gb, 0.1, 64.0),
        ]
    } else {
        &[
            ("cpuCores", request.cpu_cores, 0.1, 16.0),
            ("memoryGb", request.memory_gb, 0.1, 64.0),
            ("diskSizeGb", request.disk_size_gb, 0.1, 1000.0),
        ]
    };
    for (field, value, min, max) in resource_checks {
        if !value.is_finite() || value < min || value > max {
            return Err(SandboxError::invalid_request(format!(
                "{field} must be a finite number from {min} to {max}"
            )));
        }
    }
    Ok(())
}

/// Validate a create request locally; nothing is sent when this fails.
pub(crate) fn validate_create_request(request: &VmCreateRequest) -> Result<(), SandboxError> {
    if request.name.trim().is_empty() || request.name.len() > MAX_NAME_BYTES {
        return Err(SandboxError::invalid_request(
            "Sandbox name must be a non-empty string of at most 100 characters",
        ));
    }
    validate_source_and_resources(request)?;
    let uncapped = request.timeout_minutes == NO_TIMEOUT_MINUTES;
    if !uncapped && !(1..=1440).contains(&request.timeout_minutes) {
        return Err(SandboxError::invalid_request(
            "timeoutMinutes must be an integer from 1 to 1440, or -1 for no cap",
        ));
    }
    if let Some(idle) = request.idle_timeout_minutes {
        if idle < 1 {
            return Err(SandboxError::invalid_request(
                "idleTimeoutMinutes must be a positive integer",
            ));
        }
        if !uncapped && idle > request.timeout_minutes {
            return Err(SandboxError::invalid_request(
                "idleTimeoutMinutes must not exceed timeoutMinutes",
            ));
        }
    }
    if request.gpu_count > 8 {
        return Err(SandboxError::invalid_request(
            "gpuCount must be an integer from 0 to 8",
        ));
    }
    let gpu_type = request
        .gpu_type
        .as_deref()
        .filter(|gpu_type| !gpu_type.is_empty());
    if (request.gpu_count > 0) != gpu_type.is_some() {
        return Err(SandboxError::invalid_request(
            "gpuType is required when gpuCount is greater than 0, and forbidden otherwise",
        ));
    }
    if let Some(start) = request.start_command.as_ref() {
        if start.executable.is_empty()
            || start.executable.contains('\0')
            || start.args.iter().any(|arg| arg.contains('\0'))
        {
            return Err(SandboxError::invalid_request(
                "startCommand needs a non-empty executable and NUL-free strings",
            ));
        }
    }
    if request.network_allowlist.is_some() && request.network_denylist.is_some() {
        return Err(SandboxError::invalid_request(
            "networkAllowlist and networkDenylist are mutually exclusive",
        ));
    }
    if let Some(vars) = request.environment_vars.as_ref() {
        validate_env_record(vars, "environmentVars")?;
    }
    if let Some(secrets) = request.secrets.as_ref() {
        validate_env_record(secrets, "secrets")?;
    }
    for label in &request.labels {
        if label.is_empty() || label.len() > MAX_LABEL_BYTES || label.contains('\0') {
            return Err(SandboxError::invalid_request(
                "labels must be non-empty strings of at most 256 characters",
            ));
        }
    }
    if let Some(key) = request.idempotency_key.as_deref() {
        validate_idempotency_key(key)?;
    }
    Ok(())
}

/// A `BTreeMap<String, String>` as an infallible JSON object.
fn string_map(map: &BTreeMap<String, String>) -> serde_json::Value {
    serde_json::Value::Object(
        map.iter()
            .map(|(key, value)| (key.clone(), serde_json::Value::String(value.clone())))
            .collect::<serde_json::Map<String, serde_json::Value>>(),
    )
}

/// Build the create request body in a stable field order (`snake_case`, `vm`
/// forced true, `idempotency_key` always present; `serde_json`
/// preserve-order keeps the sequence stable on the wire).
pub(crate) fn build_create_body(
    request: &VmCreateRequest,
    idempotency_key: &str,
    team_id: Option<&str>,
) -> serde_json::Value {
    let gpu_type = request
        .gpu_type
        .as_deref()
        .filter(|gpu_type| !gpu_type.is_empty());
    let mut body = serde_json::Map::new();
    body.insert("name".into(), request.name.clone().into());
    if request
        .checkpoint_id
        .as_deref()
        .is_some_and(|checkpoint_id| !checkpoint_id.is_empty())
    {
        body.insert(
            "checkpoint_id".into(),
            request.checkpoint_id.clone().unwrap_or_default().into(),
        );
    } else {
        body.insert("docker_image".into(), request.docker_image.clone().into());
    }
    body.insert("cpu_cores".into(), request.cpu_cores.into());
    body.insert("memory_gb".into(), request.memory_gb.into());
    if request.checkpoint_id.as_deref().is_none_or(str::is_empty) {
        body.insert("disk_size_gb".into(), request.disk_size_gb.into());
    }
    body.insert("gpu_count".into(), u64::from(request.gpu_count).into());
    body.insert("vm".into(), true.into());
    body.insert("timeout_minutes".into(), request.timeout_minutes.into());
    body.insert(
        "labels".into(),
        serde_json::Value::Array(
            request
                .labels
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    body.insert("idempotency_key".into(), idempotency_key.into());
    if let Some(start) = request.start_command.as_ref() {
        body.insert(
            "start_command".into(),
            serde_json::json!({
                "executable": start.executable,
                "args": start.args,
            }),
        );
    }
    if let Some(gpu_type) = gpu_type {
        body.insert("gpu_type".into(), gpu_type.into());
    }
    if let Some(entries) = request.network_allowlist.as_ref() {
        body.insert("network_allowlist".into(), entries.clone().into());
    }
    if let Some(entries) = request.network_denylist.as_ref() {
        body.insert("network_denylist".into(), entries.clone().into());
    }
    if let Some(rules) = request.network_rules.as_ref() {
        body.insert(
            "network_rules".into(),
            serde_json::Value::Object(
                rules
                    .iter()
                    .map(|(host, rule)| {
                        (
                            host.clone(),
                            serde_json::json!({ "headers": string_map(&rule.headers) }),
                        )
                    })
                    .collect(),
            ),
        );
    }
    if let Some(idle) = request.idle_timeout_minutes {
        body.insert("idle_timeout_minutes".into(), idle.into());
    }
    if let Some(vars) = request.environment_vars.as_ref() {
        body.insert("environment_vars".into(), string_map(vars));
    }
    if let Some(secrets) = request.secrets.as_ref() {
        body.insert("secrets".into(), string_map(secrets));
    }
    if let Some(team_id) = team_id {
        body.insert("team_id".into(), team_id.into());
    }
    serde_json::Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_normalize_and_reject_unsafe_origins() {
        for good in [
            "https://api.example.com/",
            "https://api.example.com/api/v1/",
        ] {
            assert_eq!(
                normalize_base_url(good, false).unwrap(),
                "https://api.example.com"
            );
        }
        for bad in [
            "http://api.example.com",
            "https://user:pass@api.example.com",
            "https://api.example.com?x=1",
            "not a url",
        ] {
            assert!(normalize_base_url(bad, false).is_err(), "{bad}");
        }
        assert!(normalize_base_url("http://127.0.0.1:99", true).is_ok());
        assert!(normalize_base_url("http://10.0.0.1", true).is_err());
    }
}

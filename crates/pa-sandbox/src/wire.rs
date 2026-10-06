//! Wire-contract helpers: base-URL safety, request validation, the create
//! body, and the strict sandbox-response parser. Port of the validation
//! and `parsePrimeSandbox` half of `prime-sandbox-client.ts` (TS branch
//! `feat/direct-cloud-sandbox`), cross-checked against the
//! `prime_sandboxes` SDK (`CreateSandboxRequest` sends `snake_case`; the
//! `Sandbox` response aliases `camelCase` with `snake_case` egress lists).

use std::collections::BTreeMap;

use crate::error::SandboxError;
use crate::types::VmCreateRequest;

/// URL path segments derived from platform data: 1-128 characters of
/// letters, digits, dots, underscores, or dashes, starting with a letter
/// or digit (TS `URL_SEGMENT_PATTERN`).
const SEGMENT_PATTERN_MAX: usize = 128;

/// The egress policy entry cap (TS `MAX_EGRESS_POLICY_ENTRIES`).
const MAX_EGRESS_POLICY_ENTRIES: usize = 256;

/// The loopback hosts allowed with plain `http://` when the client opts in
/// (TS `LOCAL_HOSTNAMES`; both IPv6 literal spellings).
pub(crate) const LOCAL_HOSTNAMES: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/// The create-name length cap in bytes (TS counts UTF-16 units; bytes are
/// at least as strict for non-ASCII, which only tightens acceptance).
const MAX_NAME_BYTES: usize = 100;

/// The label length cap in bytes (TS `labels` bound).
const MAX_LABEL_BYTES: usize = 256;

/// Env/secret key pattern (TS `ENV_VAR_KEY_PATTERN`): `[A-Za-z_][A-Za-z0-9_]*`.
pub(crate) fn is_env_var_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A platform URL path segment (TS `URL_SEGMENT_PATTERN`).
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

/// True for an exact IPv4 address such as `1.2.3.4` (TS `isIpv4Address`).
fn is_ipv4_address(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            part.parse::<u16>().is_ok_and(|octet| octet <= 255)
        })
}

/// True for an IPv4 CIDR such as `10.0.0.0/8` (TS `isIpv4Cidr`).
fn is_ipv4_cidr(value: &str) -> bool {
    let Some((address, prefix)) = value.split_once('/') else {
        return false;
    };
    if prefix.len() > 2 || !prefix.bytes().all(|b| b.is_ascii_digit()) || prefix.is_empty() {
        return false;
    }
    prefix.parse::<u8>().is_ok_and(|prefix| prefix <= 32) && is_ipv4_address(address)
}

/// A canonical RFC 1123 hostname label: letters, digits, or hyphens, no
/// leading or trailing hyphen, at most 63 bytes.
fn is_hostname_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return false;
    }
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

/// The total-domain cap the platform enforces (RFC 1123): 253 bytes.
const MAX_DOMAIN_BYTES: usize = 253;

/// Hostname or leftmost-label wildcard such as `example.com` or
/// `*.example.com` (TS `isHostnameEntry`, hardened to the platform's
/// canonical contract): RFC 1123 labels, at most 253 bytes total. The TS
/// reference only checks labels for non-emptiness, which lets malformed
/// entries (`a_b`, `-bad`, over-length domains) reach the API and fail
/// with a server-side 422; the platform rejects them, so the client fails
/// fast locally instead.
fn is_hostname_entry(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix("*.") {
        return is_hostname_entry(rest);
    }
    if value.contains('/') {
        return false;
    }
    let domain = value.trim_end_matches('.');
    !domain.is_empty()
        && !domain.contains('*')
        && domain.len() <= MAX_DOMAIN_BYTES
        && domain.split('.').all(is_hostname_label)
}

/// Mirror the platform egress entry contract: an exact hostname, a
/// leftmost `*.` wildcard, an IPv4 address, or an IPv4 CIDR. Schemes,
/// credentials, ports, query strings, bare `*`, IPv6, and wildcards in
/// other positions are rejected (TS `validateEgressEntry`).
fn validate_egress_list(entries: &[String], field: &str) -> Result<(), SandboxError> {
    if entries.len() > MAX_EGRESS_POLICY_ENTRIES {
        return Err(SandboxError::invalid_request(format!(
            "{field} supports at most {MAX_EGRESS_POLICY_ENTRIES} entries"
        )));
    }
    for entry in entries {
        if entry.is_empty() || entry.contains('\0') || entry.chars().any(char::is_whitespace) {
            return Err(SandboxError::invalid_request(format!(
                "{field} entries must be non-empty whitespace-free strings"
            )));
        }
        if is_ipv4_address(entry) || is_ipv4_cidr(entry) {
            continue;
        }
        for (forbidden, reason) in [
            ("://", "schemes are not supported"),
            ("@", "credentials are not supported"),
            (":", "ports and IPv6 are not supported"),
            ("?", "query strings are not supported"),
        ] {
            if entry.contains(forbidden) {
                return Err(SandboxError::invalid_request(format!(
                    "{field} entry rejected: {reason}"
                )));
            }
        }
        if !is_hostname_entry(entry) {
            return Err(SandboxError::invalid_request(format!(
                "{field} entry is not a valid egress rule"
            )));
        }
    }
    Ok(())
}

/// Validate an env/secrets record: shell-identifier keys, NUL-free values
/// (TS `validateEnvRecord`).
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
/// `allow_insecure_localhost` opts in (TS `normalizeBaseUrl`).
pub(crate) fn normalize_base_url(
    value: &str,
    allow_insecure_localhost: bool,
) -> Result<String, SandboxError> {
    let invalid =
        || SandboxError::invalid_request("Prime sandbox base URL must be an https URL with a host");
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

/// Validate a sandbox id before it is interpolated into a URL path (TS
/// `assertSandboxId`).
pub(crate) fn assert_sandbox_id(value: &str) -> Result<(), SandboxError> {
    if !is_url_segment(value) {
        return Err(SandboxError::invalid_request(
            "Sandbox id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
        ));
    }
    Ok(())
}

/// Validate a create idempotency key against the shared segment pattern
/// (TS `IDEMPOTENCY_KEY_PATTERN`).
fn validate_idempotency_key(value: &str) -> Result<(), SandboxError> {
    if !is_url_segment(value) {
        return Err(SandboxError::invalid_request(
            "idempotencyKey must be 1-128 characters of letters, digits, dots, underscores, or dashes, starting with a letter or digit",
        ));
    }
    Ok(())
}

/// Validate a create request locally, exactly mirroring the TS
/// `createVmSandbox` guards; nothing is sent when this fails.
#[allow(clippy::too_many_lines)] // Keep the complete create-request contract in one validation function.
pub(crate) fn validate_create_request(request: &VmCreateRequest) -> Result<(), SandboxError> {
    if request.name.trim().is_empty() || request.name.len() > MAX_NAME_BYTES {
        return Err(SandboxError::invalid_request(
            "Sandbox name must be a non-empty string of at most 100 characters",
        ));
    }
    if request.docker_image.is_empty() || request.docker_image.chars().any(char::is_whitespace) {
        return Err(SandboxError::invalid_request(
            "dockerImage must be a non-empty whitespace-free string",
        ));
    }
    for (field, value, min, max) in [
        ("cpuCores", request.cpu_cores, 0.1, 16.0),
        ("memoryGb", request.memory_gb, 0.1, 64.0),
        ("diskSizeGb", request.disk_size_gb, 0.1, 1000.0),
    ] {
        if !value.is_finite() || value < min || value > max {
            return Err(SandboxError::invalid_request(format!(
                "{field} must be a finite number from {min} to {max}"
            )));
        }
    }
    if request.timeout_minutes < 1 || request.timeout_minutes > 1440 {
        return Err(SandboxError::invalid_request(
            "timeoutMinutes must be an integer from 1 to 1440",
        ));
    }
    if let Some(idle) = request.idle_timeout_minutes {
        if idle < 1 {
            return Err(SandboxError::invalid_request(
                "idleTimeoutMinutes must be a positive integer",
            ));
        }
        if idle > request.timeout_minutes {
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
    match (request.gpu_count, gpu_type) {
        (0, None) | (1.., Some(_)) => {}
        (0, Some(_)) => {
            return Err(SandboxError::invalid_request(
                "gpuType requires gpuCount greater than 0",
            ));
        }
        (1.., None) => {
            return Err(SandboxError::invalid_request(
                "gpuType is required when gpuCount is greater than 0",
            ));
        }
    }
    if let Some(start) = request.start_command.as_ref() {
        if start.executable.is_empty() {
            return Err(SandboxError::invalid_request(
                "startCommand.executable must be a non-empty string",
            ));
        }
        if start.executable.contains('\0') {
            return Err(SandboxError::invalid_request(
                "startCommand.executable must not contain NUL bytes",
            ));
        }
        if start.args.iter().any(|arg| arg.contains('\0')) {
            return Err(SandboxError::invalid_request(
                "startCommand.args must be an array of NUL-free strings",
            ));
        }
    }
    if request.network_allowlist.is_some() && request.network_denylist.is_some() {
        return Err(SandboxError::invalid_request(
            "networkAllowlist and networkDenylist are mutually exclusive",
        ));
    }
    if let Some(entries) = request.network_allowlist.as_deref() {
        validate_egress_list(entries, "networkAllowlist")?;
    }
    if let Some(entries) = request.network_denylist.as_deref() {
        validate_egress_list(entries, "networkDenylist")?;
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

/// Build the create request body in the TS field order (`snake_case`, `vm`
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
    body.insert("docker_image".into(), request.docker_image.clone().into());
    body.insert("cpu_cores".into(), request.cpu_cores.into());
    body.insert("memory_gb".into(), request.memory_gb.into());
    body.insert("disk_size_gb".into(), request.disk_size_gb.into());
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
    fn base_urls_normalize_the_api_v1_suffix() {
        assert_eq!(
            normalize_base_url("https://api.example.com", false).unwrap(),
            "https://api.example.com"
        );
        assert_eq!(
            normalize_base_url("https://api.example.com/", false).unwrap(),
            "https://api.example.com"
        );
        assert_eq!(
            normalize_base_url("https://api.example.com/api/v1", false).unwrap(),
            "https://api.example.com"
        );
        assert_eq!(
            normalize_base_url("https://api.example.com/api/v1/", false).unwrap(),
            "https://api.example.com"
        );
    }

    #[test]
    fn base_urls_reject_non_https_and_credentials() {
        for bad in [
            "http://api.example.com",
            "https://user:pass@api.example.com",
            "https://api.example.com?x=1",
            "https://api.example.com#frag",
            "ftp://api.example.com",
            "not a url",
            "",
        ] {
            assert!(
                normalize_base_url(bad, false).is_err(),
                "{bad} must be rejected"
            );
        }
        // Loopback http is allowed only with the opt-in.
        assert!(normalize_base_url("http://127.0.0.1:99", false).is_err());
        assert!(normalize_base_url("http://127.0.0.1:99", true).is_ok());
        assert!(normalize_base_url("http://localhost:99", true).is_ok());
        assert!(normalize_base_url("http://10.0.0.1", true).is_err());
    }

    #[test]
    fn sandbox_ids_follow_the_segment_pattern() {
        assert_sandbox_id("sb-123_abc.X").unwrap();
        assert!(assert_sandbox_id("-bad").is_err());
        assert!(assert_sandbox_id("").is_err());
        assert!(assert_sandbox_id("has space").is_err());
        assert!(assert_sandbox_id(&"a".repeat(129)).is_err());
    }

    #[test]
    fn egress_lists_accept_the_platform_entry_forms() {
        validate_egress_list(
            &[
                "example.com".to_string(),
                "*.example.com".to_string(),
                "1.2.3.4".to_string(),
                "10.0.0.0/8".to_string(),
            ],
            "networkAllowlist",
        )
        .unwrap();
    }

    #[test]
    fn egress_lists_reject_the_forbidden_forms() {
        for entry in [
            "",
            "a b",
            "*://x",
            "a:80",
            "user@example.com",
            "example.com?x=1",
            "*.x.*.y",
            "10.0.0.0/33",
            "2001:db8::1",
            "*",
        ] {
            assert!(
                validate_egress_list(&[entry.to_string()], "networkAllowlist").is_err(),
                "{entry:?} must be rejected"
            );
        }
    }

    #[test]
    fn egress_hostname_entries_follow_the_platform_canonical_contract() {
        // The reviewer's three platform-422 cases (the TS reference
        // accepted them by checking only label non-emptiness).
        for entry in [
            "a_b.example.com".to_string(),      // underscore in a label
            "-bad.example.com".to_string(),     // leading hyphen
            format!("{}.com", "a".repeat(250)), // >253-byte domain
        ] {
            assert!(
                validate_egress_list(std::slice::from_ref(&entry), "networkAllowlist").is_err(),
                "{entry:?} must be rejected"
            );
        }
        // Canonical edges that stay valid.
        for entry in [
            "example.com".to_string(),
            "*.example.com".to_string(),
            "localhost".to_string(),
            "a-b.example.com".to_string(),
            "example.com.".to_string(),
            // exactly 253 bytes: 63 + 63 + 61 labels plus ".com"
            format!(
                "{}.{}.{}.com",
                "a".repeat(63),
                "b".repeat(63),
                "c".repeat(61)
            ),
        ] {
            assert!(
                validate_egress_list(std::slice::from_ref(&entry), "networkAllowlist").is_ok(),
                "{entry:?} must be accepted"
            );
        }
        // A 64-byte label and a trailing hyphen are also invalid.
        assert!(validate_egress_list(
            &[format!("{}.example.com", "a".repeat(64))],
            "networkAllowlist"
        )
        .is_err());
        assert!(
            validate_egress_list(&["bad-.example.com".to_string()], "networkAllowlist").is_err()
        );
        // The wildcard applies to the hostname rules underneath it.
        assert!(
            validate_egress_list(&["*.a_b.example.com".to_string()], "networkAllowlist").is_err()
        );
    }

    #[test]
    fn env_records_validate_keys_and_values() {
        let mut record = BTreeMap::new();
        record.insert("APP_ENV".to_string(), "staging".to_string());
        record.insert("_under_score".to_string(), "ok".to_string());
        validate_env_record(&record, "environmentVars").unwrap();
        record.insert("9BAD".to_string(), "x".to_string());
        assert!(validate_env_record(&record, "environmentVars").is_err());
    }

    fn valid_request() -> VmCreateRequest {
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
            labels: Vec::new(),
            idempotency_key: None,
        }
    }

    #[test]
    fn create_request_debug_omits_secrets_and_environment_values() {
        let key = "sk-synthetic-private-key";
        let mut request = valid_request();
        request.secrets = Some(BTreeMap::from([(
            "SECRET_TOKEN".to_string(),
            key.to_string(),
        )]));
        request.environment_vars = Some(BTreeMap::from([("APP_KEY".to_string(), key.to_string())]));
        let rendered = format!("{request:?}");
        assert!(!rendered.contains(key));
        assert!(rendered.contains(r#"name: "agent""#));
        assert!(rendered.contains(r#"environment_vars: Some("[redacted]")"#));
        assert!(rendered.contains(r#"secrets: Some("[redacted]")"#));
    }

    #[test]
    fn rejected_egress_values_never_echo_credentials() {
        let secret = "sk-synthetic-private-key";
        for entry in [
            format!("{secret}@example.com"),
            format!("{secret}.invalid_host"),
        ] {
            let error = validate_egress_list(&[entry], "networkAllowlist").unwrap_err();
            assert!(!error.to_string().contains(secret));
            assert!(error.to_string().contains("networkAllowlist"));
        }
    }

    #[test]
    fn create_validation_accepts_the_reference_profile() {
        validate_create_request(&valid_request()).unwrap();
    }

    #[test]
    fn create_validation_rejects_each_contract_break() {
        let mut request = valid_request();
        request.name = "   ".to_string();
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.name = "x".repeat(101);
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.docker_image = "has space".to_string();
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.cpu_cores = 16.1;
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.memory_gb = 0.05;
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.disk_size_gb = 1001.0;
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.timeout_minutes = 0;
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.timeout_minutes = 1441;
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.idle_timeout_minutes = Some(121);
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.gpu_count = 9;
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.gpu_count = 1;
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.gpu_count = 0;
        request.gpu_type = Some("h100".to_string());
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.gpu_count = 2;
        request.gpu_type = Some(String::new());
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.network_allowlist = Some(Vec::new());
        request.network_denylist = Some(Vec::new());
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.labels = vec![String::new()];
        assert!(validate_create_request(&request).is_err());
        let mut request = valid_request();
        request.idempotency_key = Some("-bad".to_string());
        assert!(validate_create_request(&request).is_err());
    }

    #[test]
    fn create_body_keeps_the_ts_field_order() {
        let mut request = valid_request();
        request.gpu_count = 2;
        request.gpu_type = Some("h100".to_string());
        request.idle_timeout_minutes = Some(15);
        request.labels = vec!["cloud".to_string()];
        let body = build_create_body(&request, "idem-key", Some("team-1"));
        let text = body.to_string();
        let expected = "{\"name\":\"agent\",\"docker_image\":\"prime/primeintellect/prime-agent-frpc:0.9.7\",\"cpu_cores\":4.0,\"memory_gb\":16.0,\"disk_size_gb\":50.0,\"gpu_count\":2,\"vm\":true,\"timeout_minutes\":120,\"labels\":[\"cloud\"],\"idempotency_key\":\"idem-key\",\"gpu_type\":\"h100\",\"idle_timeout_minutes\":15,\"team_id\":\"team-1\"}";
        assert_eq!(text, expected);
    }
}

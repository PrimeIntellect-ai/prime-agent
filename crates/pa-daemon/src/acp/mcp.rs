//! ACP MCP server admission: the wire-shape validation port of the TS
//! `resolveAcpMcpServers` (modes/acp/acp-mcp.ts) plus the tool-name
//! derivation checks from `acpMcpToolNames` (core/tools/acp-mcp.ts).
//!
//! Transport-level contract: validation failures are ACP `invalid params`
//! errors with a `reason` payload; admission failures (tool-name
//! conflicts, ownership fencing) are internal errors carrying the raw
//! message, exactly like the TS in-process connection.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use pa_core::mcp::AcpMcpServerConfig;

/// Wire shape of one `session/new` `mcpServers` entry (ACP SDK
/// `McpServer` union: stdio by `command`, http by `type`).
#[derive(Debug)]
enum WireServer {
    Stdio {
        name: String,
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    Http {
        name: String,
        url: String,
        headers: Vec<(String, String)>,
    },
    Unsupported {
        name: String,
        kind: String,
    },
}

/// TS `SERVER_NAME_PATTERN`: admission allows up to 64 characters.
const SERVER_NAME_PATTERN_MAX: usize = 64;

/// TS `acpMcpToolNames` pattern: tool names stay within providers'
/// 64-char tool-name limits (`mcp_list_tools_<name>`).
const TOOL_NAME_PATTERN_MAX: usize = 48;

/// TS `/^[A-Za-z0-9][A-Za-z0-9_-]{0, max-1}$/`: one leading alphanumeric,
/// then up to `max - 1` more of alphanumerics, `_`, or `-`.
fn server_name_matches_pattern(name: &str, max: usize) -> bool {
    let mut chars = name.chars();
    let first = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest: String = chars.collect();
    first
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && rest.chars().count() < max
}

/// Node `validateHeaderName`: an RFC 7230 token.
fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            matches!(
                c,
                '!' | '#' | '$' | '%' | '&' | '\'' | '*' | '+' | '.' | '^' | '_' | '`' | '|' | '~'
            ) || c.is_ascii_alphanumeric()
                || c == '-'
        })
}

/// Node `validateHeaderValue`: printable + HTAB, no NUL/CR/LF.
fn valid_header_value(value: &str) -> bool {
    value
        .chars()
        .all(|c| c == '\t' || (' '..='~').contains(&c) || c as u32 >= 0x80)
}

/// TS `entries()`: name/value pairs into a map with duplicate detection.
/// Header identity is case-insensitive; environment identity is exact.
fn entries(
    server: &str,
    label: &str,
    values: &[(String, String)],
) -> Result<Vec<(String, String)>, String> {
    let mut result = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (name, value) in values {
        if name.is_empty() {
            return Err(format!("MCP server {server} has an empty {label} name"));
        }
        let identity = if label == "header" {
            name.to_lowercase()
        } else {
            name.clone()
        };
        if seen.contains(&identity) {
            return Err(format!("MCP server {server} has duplicate {label} {name}"));
        }
        if label == "header" {
            if !valid_header_name(name) || !valid_header_value(value) {
                return Err(format!("MCP server {server} has an invalid HTTP header"));
            }
        } else if name.contains('=') || name.contains('\0') || value.contains('\0') {
            return Err(format!(
                "MCP server {server} has an invalid environment entry"
            ));
        }
        seen.insert(identity);
        result.push((name.clone(), value.clone()));
    }
    Ok(result)
}

/// The SDK zod entry filter (`vecSkipError(zMcpServer)`): entries that
/// do not match the `McpServer` union are silently DROPPED before the
/// handler sees them. Required fields are strict; unknown keys (including
/// `type` on stdio entries) are stripped by the schema.
fn parse_wire(server: &Value) -> Option<WireServer> {
    let object = server.as_object()?;
    let name = object.get("name")?.as_str()?.to_string();
    let server_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // Union order matters: http matches before stdio, so an entry with
    // url+headers AND command parses as http.
    if server_type == "http" || server_type == "sse" {
        let url = object.get("url")?.as_str()?.to_string();
        let headers = pair_list(object, "headers")?;
        if server_type == "http" {
            return Some(WireServer::Http { name, url, headers });
        }
        return Some(WireServer::Unsupported {
            name,
            kind: "sse".to_string(),
        });
    }
    if server_type == "acp" {
        object.get("serverId").and_then(Value::as_str)?;
        return Some(WireServer::Unsupported {
            name,
            kind: "acp".to_string(),
        });
    }
    let command = object.get("command")?.as_str()?.to_string();
    let args = string_list(object, "args")?;
    let env = pair_list(object, "env")?;
    Some(WireServer::Stdio {
        name,
        command,
        args,
        env,
    })
}

fn string_list(object: &serde_json::Map<String, Value>, key: &str) -> Option<Vec<String>> {
    let list = object.get(key)?.as_array()?;
    list.iter()
        .map(|item| Some(item.as_str()?.to_string()))
        .collect()
}

/// z.array(zHttpHeader)/z.array(zEnvVariable): a single invalid item fails
/// the whole entry (unlike the top-level vecSkipError).
fn pair_list(object: &serde_json::Map<String, Value>, key: &str) -> Option<Vec<(String, String)>> {
    let list = object.get(key)?.as_array()?;
    list.iter()
        .map(|entry| {
            let name = entry.get("name")?.as_str()?.to_string();
            let value = entry.get("value")?.as_str()?.to_string();
            Some((name, value))
        })
        .collect()
}

/// Validate an http(s) URL without embedded credentials (TS `new URL`
/// parsing plus the protocol/username/password checks).
fn validate_http_url(server: &str, url: &str) -> Result<(), String> {
    let parsed = parse_url(url).ok_or(format!("MCP server {server} has an invalid HTTP URL"))?;
    if (parsed.scheme != "http" && parsed.scheme != "https")
        || !parsed.username.is_empty()
        || parsed.password.is_some()
    {
        return Err(format!(
            "MCP server {server} must use an HTTP(S) URL without embedded credentials"
        ));
    }
    Ok(())
}

struct ParsedUrl {
    scheme: String,
    username: String,
    password: Option<String>,
}

/// Minimal URL split for the admission checks: scheme, credentials, rest.
/// Handles exactly what the TS checks read — `url.protocol`,
/// `url.username`, and `url.password`.
fn parse_url(url: &str) -> Option<ParsedUrl> {
    let (scheme, rest) = url.split_once(':')?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    let rest = rest.trim_start_matches("//");
    let (authority, _) = rest.split_once(['/', '?', '#']).unwrap_or((rest, ""));
    let (credentials, _) = authority.rsplit_once('@').unwrap_or(("", authority));
    let (username, password) = credentials.split_once(':').unwrap_or((credentials, ""));
    Some(ParsedUrl {
        scheme: scheme.to_lowercase(),
        username: username.to_string(),
        password: (!password.is_empty()).then(|| password.to_string()),
    })
}

/// Resolve the wire `mcpServers` array into session server configs,
/// porting the TS validation exactly (error text included). The session
/// cwd is attached to every stdio server.
pub fn resolve_acp_mcp_servers(
    servers: &[Value],
    cwd: &Path,
) -> Result<Vec<AcpMcpServerConfig>, String> {
    let mut names: HashSet<String> = HashSet::new();
    let mut resolved = Vec::new();
    for server in servers {
        // Schema-invalid entries are dropped before validation (SDK
        // `vecSkipError`): admission never reports them.
        let Some(parsed) = parse_wire(server) else {
            continue;
        };
        let name = match &parsed {
            WireServer::Stdio { name, .. }
            | WireServer::Http { name, .. }
            | WireServer::Unsupported { name, .. } => name.clone(),
        };
        if !server_name_matches_pattern(&name, SERVER_NAME_PATTERN_MAX) {
            return Err(
                "MCP server names must start with an alphanumeric character and contain at most 64 alphanumeric, underscore, or hyphen characters"
                    .to_string(),
            );
        }
        if names.contains(&name) {
            return Err(format!("duplicate MCP server name: {name}"));
        }
        names.insert(name.clone());
        match parsed {
            WireServer::Unsupported { name, kind } => {
                return Err(format!(
                    "MCP server {name} uses unsupported {kind} transport"
                ));
            }
            WireServer::Stdio {
                name,
                command,
                args,
                env,
            } => {
                if command.is_empty() {
                    return Err(format!("MCP server {name} has no stdio command"));
                }
                if command.contains('\0') || args.iter().any(|arg| arg.contains('\0')) {
                    return Err(format!("MCP server {name} has an invalid stdio command"));
                }
                let env = entries(&name, "environment", &env)?;
                resolved.push(AcpMcpServerConfig::Stdio {
                    name,
                    command,
                    args,
                    cwd: cwd.display().to_string(),
                    env: env.into_iter().collect(),
                });
            }
            WireServer::Http { name, url, headers } => {
                validate_http_url(&name, &url)?;
                let headers = entries(&name, "header", &headers)?;
                resolved.push(AcpMcpServerConfig::Http {
                    name,
                    url: normalize_url(&url),
                    headers: headers.into_iter().collect(),
                });
            }
        }
    }
    Ok(resolved)
}

/// TS `new URL(url).toString()` lowercases the scheme; admission echoes
/// nothing back on the wire, so the port mirrors just that normalization.
fn normalize_url(url: &str) -> String {
    match url.split_once(':') {
        Some((scheme, rest)) if !scheme.is_empty() => format!("{}:{}", scheme.to_lowercase(), rest),
        _ => url.to_string(),
    }
}

/// The tool names an ACP MCP server adds (TS `acpMcpToolNames`):
/// `mcp_list_tools_<name>` and `mcp_call_<name>` per server. Names that
/// pass admission but overflow the tool-name limit fail here.
pub fn acp_mcp_tool_names(servers: &[AcpMcpServerConfig]) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for server in servers {
        if !server_name_matches_pattern(server.name(), TOOL_NAME_PATTERN_MAX) {
            return Err(format!("Invalid ACP MCP server name: {}", server.name()));
        }
        if seen.contains(server.name()) {
            return Err(format!("Duplicate ACP MCP server: {}", server.name()));
        }
        seen.insert(server.name().to_string());
        names.push(format!("mcp_list_tools_{}", server.name()));
        names.push(format!("mcp_call_{}", server.name()));
    }
    Ok(names)
}

/// Admit one session's `mcpServers` through the full TS pipeline:
/// zod entry dropping, `resolveAcpMcpServers` validation, tool-name
/// derivation, owner-scoped replace with cleanup on failure. Returns the
/// queued JSON-RPC error response on rejection.
pub async fn admit_session_servers(
    servers: &[Value],
    mode: &super::AcpModeState,
) -> std::result::Result<(), Value> {
    let resolved = match resolve_acp_mcp_servers(servers, &mode.actual_cwd) {
        Ok(resolved) => resolved,
        Err(reason) => {
            return Err(jsonrpc_invalid_params(&reason));
        }
    };
    if let Err(details) = acp_mcp_tool_names(&resolved) {
        return Err(super::internal_error_value(&details));
    }
    // A second admission first clears the previous session's servers, even
    // when the new list is empty.
    let previous_names = std::mem::take(&mut *mode.mcp_server_names.lock().await);
    if previous_names.is_empty() && resolved.is_empty() {
        return Ok(());
    }
    // The manager guard must not cross an await: scope it tightly.
    let failure = {
        let manager = mode.mcp.lock().unwrap();
        manager
            .replace_acp_servers(&resolved, &mode.mcp_owner_id)
            .err()
            .map(|error| {
                // The daemon may have applied the configuration before its
                // acknowledgement was lost: always attempt owner-scoped
                // cleanup before rejecting admission.
                if manager.can_release_acp_servers(&mode.mcp_owner_id) {
                    let _ = manager.replace_acp_servers(&[], &mode.mcp_owner_id);
                }
                error.to_string()
            })
    };
    if let Some(failure) = failure {
        return Err(super::internal_error_value(&failure));
    }
    if !resolved.is_empty() {
        *mode.mcp_server_names.lock().await = resolved
            .iter()
            .map(AcpMcpServerConfig::name)
            .map(str::to_string)
            .collect();
    }
    Ok(())
}

/// Release the admitted servers on `session/close` or a failed admission
/// tail (TS `clearAcpMcpServers`): owner-fenced replace-with-empty.
pub async fn release_session_servers(mode: &super::AcpModeState) {
    let names = std::mem::take(&mut *mode.mcp_server_names.lock().await);
    if names.is_empty() {
        return;
    }
    let manager = mode.mcp.lock().unwrap();
    if manager.can_release_acp_servers(&mode.mcp_owner_id) {
        let _ = manager.replace_acp_servers(&[], &mode.mcp_owner_id);
    }
}

fn jsonrpc_invalid_params(reason: &str) -> Value {
    super::jsonrpc::error_response(
        Value::Null,
        super::jsonrpc::INVALID_PARAMS,
        "Invalid params",
        Some(serde_json::json!({ "reason": reason })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stdio(name: &str) -> Value {
        json!({ "name": name, "type": "stdio", "command": "cat", "args": [], "env": [] })
    }

    fn http(name: &str, url: &str, headers: Value) -> Value {
        json!({ "name": name, "type": "http", "url": url, "headers": headers })
    }

    #[test]
    fn admits_stdio_with_cwd_and_env() {
        let servers = resolve_acp_mcp_servers(
            &[json!({ "name": "demo", "type": "stdio", "command": "cat", "args": ["-u"], "env": [{"name": "A", "value": "1"}] })],
            Path::new("/tmp/session"),
        )
        .unwrap();
        assert_eq!(servers.len(), 1);
        let AcpMcpServerConfig::Stdio {
            name,
            command,
            args,
            cwd,
            env,
        } = &servers[0]
        else {
            panic!("expected stdio config");
        };
        assert_eq!(name, "demo");
        assert_eq!(command, "cat");
        assert_eq!(args, &["-u".to_string()]);
        assert_eq!(cwd, "/tmp/session");
        assert_eq!(env.get("A").map(String::as_str), Some("1"));
    }

    #[test]
    fn drops_schema_invalid_entries_like_the_sdk() {
        // Missing required env (SDK z.array(zEnvVariable)): entry dropped,
        // admission succeeds with an empty list — the live TS behavior.
        let servers = resolve_acp_mcp_servers(
            &[json!({ "name": "-bad", "type": "stdio", "command": "cat", "args": [] })],
            Path::new("/tmp"),
        )
        .unwrap();
        assert!(servers.is_empty());
        // An invalid env item fails the whole entry.
        let servers = resolve_acp_mcp_servers(
            &[json!({ "name": "b", "type": "stdio", "command": "cat", "args": [], "env": [{"name": 1, "value": "x"}] })],
            Path::new("/tmp"),
        )
        .unwrap();
        assert!(servers.is_empty());
        // http without headers: dropped.
        let servers = resolve_acp_mcp_servers(
            &[json!({ "name": "c", "type": "http", "url": "https://user:pw@x.invalid" })],
            Path::new("/tmp"),
        )
        .unwrap();
        assert!(servers.is_empty());
        // http with command/args/env still parses as http (union order).
        let servers = resolve_acp_mcp_servers(
            &[json!({ "name": "h2", "type": "http", "url": "https://x.invalid", "headers": [], "command": "cat", "args": [], "env": [] })],
            Path::new("/tmp"),
        )
        .unwrap();
        assert!(matches!(
            servers.first(),
            Some(AcpMcpServerConfig::Http { .. })
        ));
    }

    #[test]
    fn rejects_invalid_names_and_duplicates() {
        let err = resolve_acp_mcp_servers(&[stdio("-bad")], Path::new("/tmp")).unwrap_err();
        assert!(err.contains("must start with an alphanumeric"));
        let err = resolve_acp_mcp_servers(
            &[stdio("dup"), http("dup", "https://x.invalid", json!([]))],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "duplicate MCP server name: dup");
    }

    #[test]
    fn rejects_stdio_shape_problems() {
        let err = resolve_acp_mcp_servers(
            &[json!({ "name": "n", "type": "stdio", "command": "", "args": [], "env": [] })],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server n has no stdio command");
        let err = resolve_acp_mcp_servers(
            &[json!({ "name": "n", "type": "stdio", "command": "cat\u{0}", "args": [], "env": [] })],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server n has an invalid stdio command");
    }

    #[test]
    fn rejects_environment_shape_problems() {
        let entry = |env: Value| json!({ "name": "e", "type": "stdio", "command": "cat", "args": [], "env": env });
        let err = resolve_acp_mcp_servers(
            &[entry(json!([{"name": "", "value": "1"}]))],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server e has an empty environment name");
        let err = resolve_acp_mcp_servers(
            &[entry(
                json!([{"name": "A", "value": "1"}, {"name": "A", "value": "2"}]),
            )],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server e has duplicate environment A");
        let err = resolve_acp_mcp_servers(
            &[entry(json!([{"name": "A=B", "value": "1"}]))],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server e has an invalid environment entry");
    }

    #[test]
    fn rejects_http_shape_problems() {
        let err = resolve_acp_mcp_servers(
            &[json!({ "name": "s", "type": "sse", "url": "https://x.invalid", "headers": [] })],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server s uses unsupported sse transport");
        let err = resolve_acp_mcp_servers(
            &[json!({ "name": "a2", "type": "acp", "serverId": "x" })],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server a2 uses unsupported acp transport");
        let err = resolve_acp_mcp_servers(
            &[http("c", "https://user:pw@x.invalid", json!([]))],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(
            err,
            "MCP server c must use an HTTP(S) URL without embedded credentials"
        );
        let err = resolve_acp_mcp_servers(&[http("h", "not a url", json!([]))], Path::new("/tmp"))
            .unwrap_err();
        assert_eq!(err, "MCP server h has an invalid HTTP URL");
    }

    #[test]
    fn header_identity_is_case_insensitive() {
        let err = resolve_acp_mcp_servers(
            &[http(
                "hdr",
                "https://x.invalid",
                json!([{"name": "X-A", "value": "1"}, {"name": "x-a", "value": "2"}]),
            )],
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert_eq!(err, "MCP server hdr has duplicate header x-a");
    }

    #[test]
    fn tool_names_follow_the_tighter_limit() {
        let long = "a".repeat(51);
        let servers = resolve_acp_mcp_servers(&[stdio(&long)], Path::new("/tmp")).unwrap();
        let err = acp_mcp_tool_names(&servers).unwrap_err();
        assert_eq!(err, format!("Invalid ACP MCP server name: {long}"));
        let servers = resolve_acp_mcp_servers(&[stdio("demo")], Path::new("/tmp")).unwrap();
        assert_eq!(
            acp_mcp_tool_names(&servers).unwrap(),
            vec![
                "mcp_list_tools_demo".to_string(),
                "mcp_call_demo".to_string()
            ]
        );
    }
}

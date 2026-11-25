//! Request assembly for the Codex Responses provider: URL resolution,
//! headers (SSE and WebSocket), JWT account-id extraction, and request ids.

use base64::Engine as _;
use serde_json::Value;

use crate::utils_inner::diagnostics::now_ms;

use crate::providers::openai_codex_responses::websocket::OPENAI_BETA_RESPONSES_WEBSOCKETS;

pub const DEFAULT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
pub const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";

pub fn resolve_codex_url(base_url: &str) -> String {
    let raw = if base_url.trim().is_empty() {
        DEFAULT_CODEX_BASE_URL
    } else {
        base_url.trim()
    };
    let normalized = raw.trim_end_matches('/');
    if normalized.ends_with("/codex/responses") {
        normalized.to_string()
    } else if normalized.ends_with("/codex") {
        format!("{normalized}/responses")
    } else {
        format!("{normalized}/codex/responses")
    }
}

pub fn resolve_codex_websocket_url(base_url: &str) -> String {
    resolve_codex_url(base_url)
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1)
}

/// Decode the JWT payload and read the `chatgpt_account_id` claim.
pub fn extract_account_id(token: &str) -> Result<String, String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("Invalid token".to_string());
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Invalid token".to_string())?;
    let payload: Value =
        serde_json::from_slice(&payload).map_err(|_| "Invalid token".to_string())?;
    let account_id = payload
        .get(JWT_CLAIM_PATH)
        .and_then(|claims| claims.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "No account ID in token".to_string())?;
    Ok(account_id.to_string())
}

pub fn create_codex_request_id() -> String {
    format!(
        "codex_{}_{}",
        now_ms(),
        crate::utils_inner::hash::short_hash(&format!("{}", std::process::id()))
            .chars()
            .take(8)
            .collect::<String>()
    )
}

pub fn build_sse_headers(
    model_headers: Option<&std::collections::BTreeMap<String, String>>,
    additional_headers: Option<&std::collections::HashMap<String, String>>,
    account_id: &str,
    token: &str,
    session_id: Option<&str>,
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in model_headers.iter().flat_map(|headers| headers.iter()) {
        set_header(&mut headers, name, value);
    }
    for (name, value) in additional_headers.iter().flat_map(|headers| headers.iter()) {
        set_header(&mut headers, name, value);
    }
    set_header(&mut headers, "Authorization", &format!("Bearer {token}"));
    set_header(&mut headers, "chatgpt-account-id", account_id);
    set_header(&mut headers, "originator", "pi");
    set_header(&mut headers, "User-Agent", &platform_user_agent());
    set_header(&mut headers, "OpenAI-Beta", "responses=experimental");
    set_header(&mut headers, "accept", "text/event-stream");
    set_header(&mut headers, "content-type", "application/json");
    if let Some(session_id) = session_id {
        set_header(&mut headers, "session_id", session_id);
        set_header(&mut headers, "x-client-request-id", session_id);
    }
    headers
}

pub fn build_websocket_headers(
    model_headers: Option<&std::collections::BTreeMap<String, String>>,
    additional_headers: Option<&std::collections::HashMap<String, String>>,
    account_id: &str,
    token: &str,
    request_id: &str,
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in model_headers.iter().flat_map(|headers| headers.iter()) {
        set_header(&mut headers, name, value);
    }
    for (name, value) in additional_headers.iter().flat_map(|headers| headers.iter()) {
        set_header(&mut headers, name, value);
    }
    set_header(&mut headers, "Authorization", &format!("Bearer {token}"));
    set_header(&mut headers, "chatgpt-account-id", account_id);
    set_header(&mut headers, "originator", "pi");
    set_header(&mut headers, "User-Agent", &platform_user_agent());
    // The WebSocket handshake drops the SSE beta header (matches the TS `delete
    // wsHeaders["OpenAI-Beta"]`).
    set_header(
        &mut headers,
        "OpenAI-Beta",
        OPENAI_BETA_RESPONSES_WEBSOCKETS,
    );
    set_header(&mut headers, "x-client-request-id", request_id);
    set_header(&mut headers, "session_id", request_id);
    headers
}

/// Case-insensitive header set (mirrors the `Headers` semantics in the TS).
fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
    headers.push((name.to_string(), value.to_string()));
}

/// The `User-Agent` builder: `pi (<platform> <release>; <arch>)`.
fn platform_user_agent() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    format!("pi ({os}; {arch})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_codex_urls() {
        assert_eq!(
            resolve_codex_url(""),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_url("https://example.com"),
            "https://example.com/codex/responses"
        );
        assert_eq!(
            resolve_codex_url("https://example.com/codex/"),
            "https://example.com/codex/responses"
        );
        assert_eq!(
            resolve_codex_url("https://example.com/codex/responses"),
            "https://example.com/codex/responses"
        );
        assert_eq!(
            [
                resolve_codex_websocket_url("https://example.com/codex"),
                resolve_codex_websocket_url("http://example.com/codex"),
                resolve_codex_websocket_url("https://example.com"),
            ],
            [
                "wss://example.com/codex/responses",
                "ws://example.com/codex/responses",
                "wss://example.com/codex/responses",
            ]
            .map(str::to_string)
        );
    }

    /// The one account-id check behind login, refresh and streaming: a token that is no JWT, or
    /// that has no `chatgpt_account_id` claim, is rejected.
    #[test]
    fn a_token_without_the_account_id_is_rejected() {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("{}");
        assert!(extract_account_id(&format!("header.{payload}.signature")).is_err());
        assert!(extract_account_id("not-a-jwt").is_err());
    }

    #[test]
    fn builds_expected_headers() {
        let find = |headers: &[(String, String)], name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap_or_default()
        };
        let headers = build_sse_headers(None, None, "acct", "tok", Some("sess-1"));
        let get = |name: &str| find(&headers, name);
        assert_eq!(get("Authorization"), "Bearer tok");
        assert_eq!(get("chatgpt-account-id"), "acct");
        assert_eq!(get("originator"), "pi");
        assert_eq!(get("OpenAI-Beta"), "responses=experimental");
        assert_eq!(get("accept"), "text/event-stream");
        assert_eq!(get("content-type"), "application/json");
        assert_eq!(get("session_id"), "sess-1");
        assert_eq!(get("x-client-request-id"), "sess-1");

        // The websocket handshake swaps the beta flag and sends no `accept`.
        let websocket = build_websocket_headers(None, None, "acct", "tok", "req-1");
        assert_eq!(
            find(&websocket, "OpenAI-Beta"),
            OPENAI_BETA_RESPONSES_WEBSOCKETS
        );
        assert_eq!(find(&websocket, "session_id"), "req-1");
        assert!(!websocket
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("accept")));
    }
}

//! MCP connection verification: a real streamable-HTTP handshake (initialize ->
//! tools/list) against the connection's endpoint. Health check only — the Python
//! generic runtime performs all real execution; error reporting uses fixed, safe
//! categories.

use std::time::Duration;

/// Fixed failure categories; safe to persist and show.
pub const PROBE_ERROR_TIMEOUT: &str = "verification-timeout";
pub const PROBE_ERROR_UNAUTHORIZED: &str = "http-unauthorized";
pub const PROBE_ERROR_NETWORK: &str = "network-unreachable";
pub const PROBE_ERROR_SERVER_REJECTED: &str = "server-rejected-handshake";
pub const PROBE_ERROR_HTTP: &str = "http-error";
pub const PROBE_ERROR_INVALID_RESPONSE: &str = "invalid-response";

/// One probe outcome: `Ok(tool_count)` on a completed handshake, or a fixed
/// failure category.
pub type ProbeOutcome = Result<usize, &'static str>;

/// The per-request timeout (TS default).
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// A probe only verifies the handshake and counts the first tools page; its
/// response must not grow without bound before the parser sees it.
const MAX_PROBE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// The verification probe seam: hosts inject a fake in tests; the product path uses
/// [`ReqwestMcpProbe`]..
pub trait McpEndpointProbeImpl: Send + Sync {
    fn probe_dyn(
        &self,
        url: &str,
        token: &str,
    ) -> futures::future::BoxFuture<'static, ProbeOutcome>;
}

/// The dyn-compatible object form the manager holds.
#[derive(Clone)]
pub struct McpEndpointProbe(std::sync::Arc<dyn McpEndpointProbeImpl>);

impl std::fmt::Debug for McpEndpointProbe {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("McpEndpointProbe").finish()
    }
}

impl McpEndpointProbe {
    pub fn new(probe: std::sync::Arc<dyn McpEndpointProbeImpl>) -> Self {
        Self(probe)
    }

    /// Verify one endpoint with the bearer `token` (empty = no Authorization header).
    /// A completed initialize + tools/list returns the first page's tool count.
    pub async fn probe(&self, url: &str, token: &str) -> ProbeOutcome {
        self.0.probe_dyn(url, token).await
    }
}

/// The real handshake probe.
pub struct ReqwestMcpProbe {
    client: reqwest::Client,
    timeout: Duration,
}

impl Default for ReqwestMcpProbe {
    fn default() -> Self {
        Self {
            client: pa_ai::utils::tls::http_client_builder()
                // No redirects: a redirecting endpoint must not receive the token.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
        }
    }
}

impl McpEndpointProbeImpl for ReqwestMcpProbe {
    fn probe_dyn(
        &self,
        url: &str,
        token: &str,
    ) -> futures::future::BoxFuture<'static, ProbeOutcome> {
        let client = self.client.clone();
        let timeout = self.timeout;
        let url = url.to_string();
        let token = token.to_string();
        Box::pin(async move { probe_endpoint(&client, &url, &token, timeout).await })
    }
}

/// One JSON-RPC request body for the handshake.
fn rpc(method: &str, id: i64, params: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params.clone() })
}

fn auth_headers(token: &str) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    if !token.is_empty() {
        // The bearer is a literal value from the credential store.
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
    }
    headers
}

async fn post_json_rpc(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    session_id: Option<&str>,
    body: serde_json::Value,
    timeout: Duration,
) -> Result<(u16, Option<String>, Option<serde_json::Value>), &'static str> {
    let mut request = client
        .post(url)
        .timeout(timeout)
        .headers(auth_headers(token))
        .json(&body);
    if let Some(session) = session_id {
        match reqwest::header::HeaderValue::from_str(session) {
            Ok(value) => {
                request = request.header("mcp-session-id", value);
            }
            Err(_) => return Err(PROBE_ERROR_INVALID_RESPONSE),
        }
    }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            PROBE_ERROR_TIMEOUT
        } else {
            PROBE_ERROR_NETWORK
        }
    })?;
    let status = response.status().as_u16();
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROBE_RESPONSE_BYTES as u64)
    {
        return Err(PROBE_ERROR_INVALID_RESPONSE);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| PROBE_ERROR_INVALID_RESPONSE)?
    {
        if chunk.len() > MAX_PROBE_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(PROBE_ERROR_INVALID_RESPONSE);
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload = parse_rpc_response(status, &content_type, &bytes)?;
    Ok((status, session_id, payload))
}

/// Accept both single-JSON and SSE-framed streamable responses; only the
/// JSON payload of `data:` lines is considered.
fn parse_rpc_response(
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<Option<serde_json::Value>, &'static str> {
    let is_sse = content_type.contains("text/event-stream");
    let value = if is_sse {
        let text = std::str::from_utf8(body).map_err(|_| PROBE_ERROR_INVALID_RESPONSE)?;
        let mut parsed = None;
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                    parsed = Some(value);
                }
            }
        }
        parsed
    } else {
        serde_json::from_slice::<serde_json::Value>(body).ok()
    };
    let _ = status;
    Ok(value)
}

/// The full handshake: initialize, the initialized notification, tools/list. Each step's session id
/// feeds the next request; a rejected initialize maps to the fixed categories.
async fn probe_endpoint(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    timeout: Duration,
) -> ProbeOutcome {
    let initialize = rpc(
        "initialize",
        1,
        &serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "prime-agent", "version": "mcp-verify" }
        }),
    );
    let (status, session_id, value) =
        post_json_rpc(client, url, token, None, initialize, timeout).await?;
    if status == 401 || status == 403 {
        return Err(PROBE_ERROR_UNAUTHORIZED);
    }
    if status >= 500 {
        return Err(PROBE_ERROR_HTTP);
    }
    if !(200..300).contains(&status) {
        return Err(PROBE_ERROR_HTTP);
    }
    let Some(response) = value else {
        return Err(PROBE_ERROR_INVALID_RESPONSE);
    };
    if response.get("error").is_some() {
        return Err(PROBE_ERROR_SERVER_REJECTED);
    }
    let initialized = serde_json::json!({
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {}
    });
    let (status, _, _) = post_json_rpc(
        client,
        url,
        token,
        session_id.as_deref(),
        initialized,
        timeout,
    )
    .await?;
    if status == 401 || status == 403 {
        return Err(PROBE_ERROR_UNAUTHORIZED);
    }
    let list = rpc("tools/list", 2, &serde_json::json!({ "cursor": null }));
    let (status, _, value) =
        post_json_rpc(client, url, token, session_id.as_deref(), list, timeout).await?;
    if status == 401 || status == 403 {
        return Err(PROBE_ERROR_UNAUTHORIZED);
    }
    if !(200..300).contains(&status) {
        return Err(PROBE_ERROR_HTTP);
    }
    let Some(response) = value else {
        return Err(PROBE_ERROR_INVALID_RESPONSE);
    };
    if response.get("error").is_some() {
        return Err(PROBE_ERROR_SERVER_REJECTED);
    }
    let tool_count = response
        .pointer("/result/tools")
        .and_then(|tools| tools.as_array())
        .map_or(0, std::vec::Vec::len);
    Ok(tool_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn probe_rejects_oversized_responses_before_the_peer_finishes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for chunked in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                let mut buffer = [0u8; 4096];
                while !head.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let read = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(read, 0);
                    head.extend_from_slice(&buffer[..read]);
                }
                let body = vec![b'x'; 8 * 1024 * 1024 + 1];
                let framing = if chunked {
                    "Transfer-Encoding: chunked".to_string()
                } else {
                    format!("Content-Length: {}", body.len())
                };
                socket
                    .write_all(format!("HTTP/1.1 200 OK\r\n{framing}\r\n\r\n").as_bytes())
                    .await
                    .unwrap();
                if chunked {
                    let _ = socket
                        .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                        .await;
                }
                let _ = socket.write_all(&body).await;
                if chunked {
                    let _ = socket.write_all(b"\r\n").await;
                }
                let _ = close_rx.await;
            });
            let client = reqwest::Client::new();
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                post_json_rpc(
                    &client,
                    &format!("http://{addr}/mcp"),
                    "",
                    None,
                    rpc("initialize", 1, &serde_json::json!({})),
                    Duration::from_secs(15),
                ),
            )
            .await;
            let _ = close_tx.send(());
            server.await.unwrap();
            let error = result
                .expect("probe should not wait for EOF")
                .expect_err("probe should refuse oversized metadata");
            assert_eq!(error, PROBE_ERROR_INVALID_RESPONSE);
        }
    }
}

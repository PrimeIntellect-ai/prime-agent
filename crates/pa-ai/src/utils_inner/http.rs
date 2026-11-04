//! Minimal async HTTP client plumbing for providers: one streaming HTTP request through a shared
//! `reqwest` client (TS SDKs run `maxRetries: 0`). Aborts surface as [`ProviderError::Aborted`];
//! HTTP failures as [`ProviderError::Http`]; request-send failures as
//! [`ProviderError::Connection`].

use std::sync::OnceLock;

use tokio_util::sync::CancellationToken;

use crate::utils::stream_failure::{
    ConnectionErrorKind, ConnectionErrorProfile, ProviderConnectionError, ProviderError,
    ProviderHttpError,
};

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static H2_ALPN_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Error bodies are diagnostics, not streamed model output. One MiB leaves ample room for normal
/// provider JSON errors while bounding an untrusted peer's in-memory error payload.
pub(crate) const MAX_ERROR_BODY_BYTES: usize = 1024 * 1024;

/// Total time allowed to collect an error diagnostic after its response headers arrive. A total
/// deadline also stops peers that drip bytes slowly enough to stay below the size budget.
pub(crate) const ERROR_BODY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Append the largest UTF-8 prefix that fits in the shared error-body budget. The boolean also
/// handles a final multi-byte character that cannot fit in the remaining byte budget.
pub(crate) fn append_bounded_error_text(out: &mut String, chunk: &str) -> bool {
    let remaining = MAX_ERROR_BODY_BYTES.saturating_sub(out.len());
    let mut end = remaining.min(chunk.len());
    while !chunk.is_char_boundary(end) {
        end -= 1;
    }
    out.push_str(&chunk[..end]);
    chunk.len() >= remaining
}

/// Decode one body chunk without replacing a UTF-8 character split across chunks.
fn decode_text_chunk(utf8_tail: &mut Vec<u8>, bytes: &[u8]) -> String {
    utf8_tail.extend_from_slice(bytes);
    match std::str::from_utf8(utf8_tail) {
        Ok(text) => {
            let text = text.to_string();
            utf8_tail.clear();
            text
        }
        Err(error) if error.error_len().is_none() => {
            let valid_up_to = error.valid_up_to();
            let text = String::from_utf8_lossy(&utf8_tail[..valid_up_to]).to_string();
            utf8_tail.drain(..valid_up_to);
            text
        }
        Err(_) => {
            let text = String::from_utf8_lossy(utf8_tail).to_string();
            utf8_tail.clear();
            text
        }
    }
}

/// The HTTP/1.1 client every provider shares, pinned with `http1_only()` so that enabling the
/// reqwest `http2` feature (bedrock) cannot change the transport of any other provider.
fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        crate::utils_inner::tls::http_client_builder()
            .http1_only()
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .expect("reqwest client")
    })
}

/// The TLS-ALPN client for bedrock https endpoints: HTTP/2 preferred (ALPN-negotiated), like the TS
/// default transport; cleartext bedrock endpoints go through `providers/bedrock/h2.rs` instead.
fn h2_alpn_client() -> &'static reqwest::Client {
    H2_ALPN_CLIENT.get_or_init(|| {
        crate::utils_inner::tls::http_client_builder()
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .expect("reqwest h2 client")
    })
}

/// The wire transport a request is issued with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// HTTP/1.1 (the default; all providers but bedrock https).
    Http1,
    /// HTTP/2 preferred over TLS ALPN (bedrock https endpoints).
    H2Alpn,
}

/// An opened HTTP response: status, headers, and the byte stream.
pub struct HttpResponse {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    body: reqwest::Response,
    signal: Option<CancellationToken>,
    /// Trailing bytes of a UTF-8 sequence split across body chunks, held until the rest arrives.
    utf8_tail: Vec<u8>,
    /// The request's connection-error profile: body-read failures on the AWS http2 profile surface
    /// the TS bedrock transport's mid-stream texts.
    pub(crate) connection: ConnectionErrorProfile,
}

impl HttpResponse {
    /// Read the next text chunk from the body (None at end of stream). A UTF-8 sequence split
    /// across body chunks is held until it completes; a sequence still incomplete at end of
    /// stream yields one U+FFFD.
    pub async fn next_text(&mut self) -> Result<Option<String>, ProviderError> {
        loop {
            if self
                .signal
                .as_ref()
                .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
            {
                return Err(ProviderError::Aborted);
            }
            let signal = self.signal.clone();
            let chunk = match signal {
                Some(signal) => {
                    let next = self.body.chunk();
                    tokio::select! {
                        () = signal.cancelled() => return Err(ProviderError::Aborted),
                        result = next => result,
                    }
                }
                None => self.body.chunk().await,
            };
            let text = match chunk {
                Ok(Some(bytes)) => decode_text_chunk(&mut self.utf8_tail, &bytes),
                Ok(None) if self.utf8_tail.is_empty() => return Ok(None),
                Ok(None) => {
                    let text = String::from_utf8_lossy(&self.utf8_tail).to_string();
                    self.utf8_tail.clear();
                    text
                }
                Err(error) => return Err(self.body_error(&error)),
            };
            if !text.is_empty() {
                return Ok(Some(text));
            }
        }
    }

    /// Read the next raw byte chunk from the body (None at end of stream).
    pub async fn next_bytes(&mut self) -> Result<Option<Vec<u8>>, ProviderError> {
        if self
            .signal
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(ProviderError::Aborted);
        }
        let signal = self.signal.clone();
        let chunk = match signal {
            Some(signal) => {
                let next = self.body.chunk();
                tokio::select! {
                    () = signal.cancelled() => return Err(ProviderError::Aborted),
                    result = next => result,
                }
            }
            None => self.body.chunk().await,
        };
        match chunk {
            Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
            Ok(None) => Ok(None),
            Err(error) => Err(self.body_error(&error)),
        }
    }

    /// Classify a body-read failure: the AWS bedrock http2 profile surfaces the TS transport's
    /// mid-stream texts (the AWS SDK appends its deserialization hint); every other provider keeps
    /// the generic body-read error.
    fn body_error(&self, error: &reqwest::Error) -> ProviderError {
        if let ConnectionErrorProfile::AwsHttp2 { .. } = self.connection {
            let failure = crate::utils_inner::h2_classify::classify_reqwest_error(error);
            return ProviderError::Connection(ProviderConnectionError {
                kind: ConnectionErrorKind::H2MidStream(failure),
                profile: self.connection.clone(),
                cause: error.to_string(),
            });
        }
        ProviderError::Http(ProviderHttpError {
            message: format!("Failed to read provider response body: {error}"),
            status: Some(self.status),
            body: None,
            headers: self.headers.clone(),
            request_id: None,
            sdk_name: None,
            retry_after_ms: None,
            provider_error_type: None,
        })
    }

    /// Read the entire body as text (for error responses and small payloads).
    pub async fn read_all_text(&mut self) -> Result<String, ProviderError> {
        let mut out = String::new();
        while let Some(chunk) = self.next_text().await? {
            out.push_str(&chunk);
        }
        Ok(out)
    }

    /// Read an error diagnostic until its size or time budget is exhausted, retaining any prefix
    /// already received when the peer stalls.
    pub async fn read_error_text(&mut self) -> Result<String, ProviderError> {
        let mut out = String::new();
        let mut raw_bytes = self.utf8_tail.len();
        let deadline = tokio::time::Instant::now() + ERROR_BODY_READ_TIMEOUT;
        while raw_bytes < MAX_ERROR_BODY_BYTES && out.len() < MAX_ERROR_BODY_BYTES {
            let next = match tokio::time::timeout_at(deadline, self.next_bytes()).await {
                Ok(result) => result?,
                Err(_) => break,
            };
            let Some(bytes) = next else {
                if !self.utf8_tail.is_empty() {
                    let text = String::from_utf8_lossy(&self.utf8_tail).to_string();
                    self.utf8_tail.clear();
                    append_bounded_error_text(&mut out, &text);
                }
                break;
            };
            let take = (MAX_ERROR_BODY_BYTES - raw_bytes).min(bytes.len());
            raw_bytes += take;
            let text = decode_text_chunk(&mut self.utf8_tail, &bytes[..take]);
            if !text.is_empty() && append_bounded_error_text(&mut out, &text) {
                break;
            }
        }
        Ok(out)
    }
}

pub struct RequestOptions {
    pub method: reqwest::Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub signal: Option<CancellationToken>,
    pub timeout_ms: Option<u64>,
    /// The provider family's connection-error shape (fixed texts, names, and error codes the TS
    /// binary surfaces per SDK); the openai/anthropic `Sdk` default covers the Stainless-generated
    /// SDK family.
    pub connection: ConnectionErrorProfile,
    /// The wire transport (HTTP/1.1 by default; bedrock https requests use ALPN-negotiated HTTP/2).
    pub transport: Transport,
}

impl RequestOptions {
    /// Request options with the openai/anthropic `Sdk` connection profile.
    pub fn new(method: reqwest::Method, url: String) -> Self {
        Self {
            method,
            url,
            headers: Vec::new(),
            body: None,
            signal: None,
            timeout_ms: None,
            connection: ConnectionErrorProfile::Sdk,
            transport: Transport::Http1,
        }
    }
}

/// Issue a request and return the response with a streaming body. No retries: retry ownership lives
/// with the caller (agent layer), matching the TS `maxRetries: 0` client configuration.
pub async fn send(request: RequestOptions) -> Result<HttpResponse, ProviderError> {
    let signal = request.signal.clone();
    if signal
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ProviderError::Aborted);
    }

    let client = match request.transport {
        Transport::Http1 => client(),
        Transport::H2Alpn => h2_alpn_client(),
    };
    let mut builder = client.request(request.method, &request.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    // A JSON request body carries `content-type: application/json` —
    // strict OpenAI-compatible frontends (self-hosted vLLM) validate the
    // media type and 400 a label-less body. A caller-supplied label
    // (bedrock's signed set, mistral's, a user's `model.headers`/
    // options override) always wins.
    if request.body.is_some()
        && !request
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    {
        builder = builder.header("content-type", "application/json");
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let timeout_ms = request.timeout_ms;
    let send_future = async move {
        match timeout_ms {
            Some(timeout_ms) => {
                tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), builder.send())
                    .await
                    .map_err(|_| timeout_ms)
            }
            None => Ok(builder.send().await),
        }
    };
    let response = match &signal {
        Some(signal) => {
            tokio::select! {
                () = signal.cancelled() => return Err(ProviderError::Aborted),
                result = send_future => result,
            }
        }
        None => send_future.await,
    }
    .map_err(|timeout_ms| {
        ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::Timeout,
            profile: request.connection.clone(),
            cause: format!("request exceeded the {timeout_ms}ms timeout"),
        })
    })?;

    // The TS SDKs surface request-send failures as their fixed connection error texts: the
    // openai/anthropic SDK family throws `APIConnectionError` ("Connection error.") /
    // `APIConnectionTimeoutError` ("Request timed out.") for every fetch failure; providers whose
    // SDK appends the raw cause (mistral) or surfaces undici's raw text (codex, bedrock, google:
    // "fetch failed") rewrite it at their catch site.
    let response = response.map_err(|error| {
        let kind = if error.is_timeout() {
            ConnectionErrorKind::Timeout
        } else if error.is_connect() {
            ConnectionErrorKind::Connect
        } else if matches!(request.connection, ConnectionErrorProfile::AwsHttp2 { .. }) {
            // Pre-response http2 failure on the bedrock https transport: the h2 failure detail (no
            // deserialization hint — no response yet).
            ConnectionErrorKind::H2Request(crate::utils_inner::h2_classify::classify_reqwest_error(
                &error,
            ))
        } else {
            // The peer closed or reset after the connection was established but before the response
            // arrived (only distinguishable from refused connects on the AWS handler surfaces).
            ConnectionErrorKind::Reset
        };
        ProviderError::Connection(ProviderConnectionError {
            kind,
            profile: request.connection.clone(),
            cause: error.to_string(),
        })
    })?;

    let status = response.status().as_u16();
    let mut headers = std::collections::HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), value.to_string());
        }
    }

    Ok(HttpResponse {
        status,
        headers,
        body: response,
        signal,
        utf8_tail: Vec::new(),
        connection: request.connection,
    })
}

/// JSON POST helper used by non-streaming calls (OAuth token refresh, catalogs).
#[allow(dead_code)] // token refresh/catalog fetches for upcoming providers
pub async fn post_json(
    url: &str,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
    signal: Option<CancellationToken>,
) -> Result<(u16, serde_json::Value), ProviderError> {
    let mut response = send(RequestOptions {
        headers,
        body: Some(body.to_string()),
        signal,
        timeout_ms: Some(30_000),
        ..RequestOptions::new(reqwest::Method::POST, url.to_string())
    })
    .await?;
    let status = response.status;
    let text = if status >= 400 {
        response.read_error_text().await?
    } else {
        response.read_all_text().await?
    };
    let parsed = if text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text)
            .map_err(|error| ProviderError::Message(format!("Invalid JSON response: {error}")))?
    };
    Ok((status, parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A provider can advertise an arbitrarily large error body and keep the connection open.
    /// Both content-length and chunked diagnostics must finish after the bounded prefix.
    #[tokio::test]
    async fn error_text_stops_at_the_diagnostic_budget_without_waiting_for_eof() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for chunked in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (close_tx, close_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 4096];
                let mut head = String::new();
                loop {
                    let read = socket.read(&mut request).await.unwrap();
                    if read == 0 {
                        return;
                    }
                    head.push_str(&String::from_utf8_lossy(&request[..read]));
                    if head.contains("\r\n\r\n") {
                        break;
                    }
                }
                let framing = if chunked {
                    "Transfer-Encoding: chunked".to_string()
                } else {
                    format!("Content-Length: {}", MAX_ERROR_BODY_BYTES * 2)
                };
                let head = format!(
                    "HTTP/1.1 500 Internal Server Error\r\n{framing}\r\nConnection: close\r\n\r\n"
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                let body = vec![b'x'; MAX_ERROR_BODY_BYTES + 1024];
                if chunked {
                    socket
                        .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                        .await
                        .unwrap();
                }
                socket.write_all(&body).await.unwrap();
                if chunked {
                    socket.write_all(b"\r\n").await.unwrap();
                }
                close_rx.await.unwrap();
            });

            let mut response = send(RequestOptions::new(
                reqwest::Method::GET,
                format!("http://{addr}/"),
            ))
            .await
            .unwrap();
            let body = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                response.read_error_text(),
            )
            .await
            .expect("error diagnostic must not wait for the rest of the body")
            .unwrap();
            assert_eq!(body, "x".repeat(MAX_ERROR_BODY_BYTES));
            close_tx.send(()).unwrap();
            server.await.unwrap();
        }
    }

    /// A trailing UTF-8 lead byte is held by text decoding, but it still uses
    /// the last byte of the raw error-body budget.
    #[tokio::test]
    async fn error_text_stops_at_raw_limit_with_incomplete_utf8() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (close_tx, close_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let mut head = String::new();
            loop {
                let read = socket.read(&mut request).await.unwrap();
                if read == 0 {
                    return;
                }
                head.push_str(&String::from_utf8_lossy(&request[..read]));
                if head.contains("\r\n\r\n") {
                    break;
                }
            }
            let header = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_ERROR_BODY_BYTES + 1
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket
                .write_all(&vec![b'x'; MAX_ERROR_BODY_BYTES - 1])
                .await
                .unwrap();
            socket.write_all(&[0xE4]).await.unwrap();
            close_rx.await.unwrap();
        });

        let mut response = send(RequestOptions::new(
            reqwest::Method::GET,
            format!("http://{addr}/"),
        ))
        .await
        .unwrap();
        let body = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            response.read_error_text(),
        )
        .await
        .expect("raw byte limit must end the diagnostic before the deadline")
        .unwrap();
        assert_eq!(body, "x".repeat(MAX_ERROR_BODY_BYTES - 1));
        close_tx.send(()).unwrap();
        server.await.unwrap();
    }

    /// A peer that stalls below the byte cap must not hold an error diagnostic indefinitely.
    #[tokio::test(start_paused = true)]
    async fn error_text_returns_its_partial_body_after_the_deadline() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (close_tx, close_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let mut head = String::new();
            loop {
                let read = socket.read(&mut request).await.unwrap();
                if read == 0 {
                    return;
                }
                head.push_str(&String::from_utf8_lossy(&request[..read]));
                if head.contains("\r\n\r\n") {
                    break;
                }
            }
            socket
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 20\r\nConnection: close\r\n\r\nshort")
                .await
                .unwrap();
            close_rx.await.unwrap();
        });

        let mut response = send(RequestOptions::new(
            reqwest::Method::GET,
            format!("http://{addr}/"),
        ))
        .await
        .unwrap();
        let read = tokio::spawn(async move { response.read_error_text().await });
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_secs(31)).await;
        let body = tokio::time::timeout(std::time::Duration::from_secs(1), read)
            .await
            .expect("error diagnostic must finish after its deadline")
            .unwrap()
            .unwrap();
        assert_eq!(body, "short");
        close_tx.send(()).unwrap();
        server.await.unwrap();
    }

    /// Serve one plain-text body split across two writes. The second write is held until `hold`
    /// fires, so the chunk boundary lands where the caller put it.
    async fn serve_split_body(
        first: Vec<u8>,
        second: Vec<u8>,
        hold: tokio::sync::oneshot::Receiver<()>,
    ) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = String::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    return;
                }
                head.push_str(&String::from_utf8_lossy(&buffer[..read]));
                if head.contains("\r\n\r\n") {
                    break;
                }
            }
            let content_length = first.len() + second.len();
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(&first).await.unwrap();
            hold.await.unwrap();
            socket.write_all(&second).await.unwrap();
        });
        addr
    }

    #[tokio::test]
    async fn configured_timeout_applies_when_request_has_a_cancel_signal() {
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            let _ = accepted_tx.send(());
            let _ = release_rx.await;
        });

        let mut request = RequestOptions::new(reqwest::Method::GET, format!("http://{addr}/"));
        request.signal = Some(CancellationToken::new());
        request.timeout_ms = Some(200);
        let mut send_task = tokio::spawn(send(request));
        tokio::time::timeout(std::time::Duration::from_secs(2), accepted_rx)
            .await
            .unwrap()
            .unwrap();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), &mut send_task).await;
        if outcome.is_err() {
            send_task.abort();
        }
        drop(release_tx);
        server.await.unwrap();
        assert!(
            outcome.is_ok(),
            "provider request ignored its configured 200ms timeout"
        );
        assert!(matches!(
            outcome,
            Ok(Ok(Err(ProviderError::Connection(
                ProviderConnectionError {
                    kind: ConnectionErrorKind::Timeout,
                    ..
                }
            ))))
        ));
    }

    /// A multi-byte character split across two body chunks decodes once, whole: the first chunk
    /// ends inside 你, and the server sends the rest only after that chunk was read.
    #[tokio::test]
    async fn next_text_rejoins_a_multi_byte_character_split_across_body_chunks() {
        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel();
        let addr = serve_split_body(b"hi \xE4".to_vec(), b"\xBD\xA0!".to_vec(), hold_rx).await;
        let mut response = send(RequestOptions::new(
            reqwest::Method::GET,
            format!("http://{addr}/"),
        ))
        .await
        .unwrap();
        let mut text = String::new();
        if let Some(chunk) = response.next_text().await.unwrap() {
            text.push_str(&chunk);
            let _ = hold_tx.send(());
        }
        while let Some(chunk) = response.next_text().await.unwrap() {
            text.push_str(&chunk);
        }
        assert_eq!(text, "hi 你!");
    }

    /// A body that ends inside a multi-byte character yields the valid text plus exactly one
    /// U+FFFD at end of stream.
    #[tokio::test]
    async fn next_text_ends_a_torn_body_with_one_replacement_character() {
        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel();
        let addr = serve_split_body(b"cut \xE4".to_vec(), b"\xBD".to_vec(), hold_rx).await;
        let mut response = send(RequestOptions::new(
            reqwest::Method::GET,
            format!("http://{addr}/"),
        ))
        .await
        .unwrap();
        let mut text = String::new();
        if let Some(chunk) = response.next_text().await.unwrap() {
            text.push_str(&chunk);
            let _ = hold_tx.send(());
        }
        while let Some(chunk) = response.next_text().await.unwrap() {
            text.push_str(&chunk);
        }
        assert_eq!(text, "cut \u{FFFD}");
    }
}

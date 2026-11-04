//! The HTTP transport concern: the response and error records, the injectable
//! `TraceHttp` trait + the reqwest transport, the URI-component encoding, the
//! Retry-After parse, and the retry backoff.

use super::*;
use std::future::Future;
use std::pin::Pin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceHttpResponse {
    pub status: u16,
    pub body: String,
    pub retry_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceHttpError {
    TimedOut { timeout_ms: u64 },
    Cancelled,
    Transport(String),
}

impl TraceHttpError {
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            TraceHttpError::TimedOut { timeout_ms } => {
                format!("Trace upload timed out after {timeout_ms}ms")
            }
            TraceHttpError::Cancelled => "Trace upload cancelled".to_string(),
            TraceHttpError::Transport(message) => message.clone(),
        }
    }
}

/// The upload's injectable HTTP transport.
pub trait TraceHttp: Send + Sync {
    fn put<'a>(
        &'a self,
        url: &'a str,
        headers: Vec<(String, String)>,
        body: String,
        timeout_ms: u64,
        cancel: Option<&'a TraceUploadCancel>,
    ) -> Pin<Box<dyn Future<Output = Result<TraceHttpResponse, TraceHttpError>> + Send + 'a>>;
}

/// The production transport (reqwest, the catalog fetch's shape).
pub struct ReqwestTraceHttp;

const MAX_TRACE_RESPONSE_BYTES: usize = 1024 * 1024;

impl TraceHttp for ReqwestTraceHttp {
    fn put<'a>(
        &'a self,
        url: &'a str,
        headers: Vec<(String, String)>,
        body: String,
        timeout_ms: u64,
        cancel: Option<&'a TraceUploadCancel>,
    ) -> Pin<Box<dyn Future<Output = Result<TraceHttpResponse, TraceHttpError>> + Send + 'a>> {
        Box::pin(async move {
            let client = pa_ai::utils::tls::http_client_builder()
                .timeout(std::time::Duration::from_millis(timeout_ms))
                .build()
                .map_err(|error| TraceHttpError::Transport(error.to_string()))?;
            let mut request = client.put(url).body(body);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            let send = async {
                let mut response = request.send().await.map_err(|error| {
                    if error.is_timeout() {
                        TraceHttpError::TimedOut { timeout_ms }
                    } else {
                        TraceHttpError::Transport(error.to_string())
                    }
                })?;
                let status = response.status().as_u16();
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|error| TraceHttpError::Transport(error.to_string()))?
                {
                    if chunk.len() > MAX_TRACE_RESPONSE_BYTES - bytes.len() {
                        return Err(TraceHttpError::Transport(format!(
                            "Trace upload response exceeds {MAX_TRACE_RESPONSE_BYTES} bytes"
                        )));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                // Reqwest's text() uses this lossy UTF-8 decoding without its
                // charset feature, which is disabled throughout this workspace.
                let body = String::from_utf8_lossy(&bytes).into_owned();
                Ok(TraceHttpResponse {
                    status,
                    body,
                    retry_after,
                })
            };
            match cancel {
                Some(cancel) => {
                    tokio::select! {
                        result = send => result,
                        () = cancel.wait() => Err(TraceHttpError::Cancelled),
                    }
                }
                None => send.await,
            }
        })
    }
}

/// TS `encodeURIComponent`: every byte outside the JS unreserved set
/// escapes.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            other => {
                let _ = write!(out, "%{other:02X}");
            }
        }
    }
    out
}

/// The error body's `error.message`, `detail`, or `message`, the raw
/// text, or the status phrase.
pub fn read_response_message(status: u16, body: &str) -> String {
    if body.trim().is_empty() {
        return reqwest::StatusCode::from_u16(status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or("Unknown error")
            .to_string();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(body) {
        if let Some(message) = parsed
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return message.to_string();
        }
        for field in ["detail", "message"] {
            if let Some(message) = parsed
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return message.to_string();
            }
        }
    }
    body.trim().to_string()
}

/// The `Retry-After` seconds, or an HTTP date, clamped to `cap_ms`.
#[must_use]
pub fn retry_after_delay(retry_after: Option<&str>, cap_ms: u64) -> Option<u64> {
    let value = retry_after?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        if seconds.is_finite() && seconds >= 0.0 {
            let capped = (seconds * 1000.0).ceil().min(cap_ms as f64);
            return Some(capped as u64);
        }
    }
    let retry_at = parse_http_date(value)?;
    let delta = retry_at.saturating_sub(now_ms());
    Some(delta.min(cap_ms))
}

/// RFC 1123 (HTTP-date) parsing for `Retry-After`:
/// `Sun, 06 Nov 1994 08:49:37 GMT`.
fn parse_http_date(value: &str) -> Option<u64> {
    let rest = value
        .split_once(',')
        .map_or(value.trim(), |(_, rest)| rest.trim());
    let parts: Vec<&str> = rest.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let day: u32 = parts[0].parse().ok()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| parts[1].starts_with(name))? as u32
        + 1;
    let year: i64 = parts[2].parse().ok()?;
    let time: Vec<&str> = parts[3].split(':').collect();
    if time.len() != 3 {
        return None;
    }
    let (hour, minute, second): (u64, u64, u64) = (
        time[0].parse().ok()?,
        time[1].parse().ok()?,
        time[2].parse().ok()?,
    );
    // Civil-date conversion: days from 1970-01-01 (Howard Hinnant's
    // days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from((month + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    if days < 0 {
        return None;
    }
    Some((days as u64) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000)
}

pub(super) fn trace_upload_retry_delay(retry_index: u32) -> u64 {
    let exponential = (TRACE_UPLOAD_RETRY_BASE_DELAY_MS * (1_u64 << retry_index.min(16)))
        .min(TRACE_UPLOAD_RETRY_MAX_DELAY_MS) as f64;
    let jitter_multiplier =
        1.0 - TRACE_UPLOAD_RETRY_JITTER + rand_fraction() * TRACE_UPLOAD_RETRY_JITTER * 2.0;
    (exponential * jitter_multiplier).round().max(0.0) as u64
}

/// TS `Math.random()` (the only randomness the engine uses).
fn rand_fraction() -> f64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    u64::from_le_bytes(bytes) as f64 / u64::MAX as f64
}

pub(super) fn is_retriable_transport_error(error: &TraceHttpError) -> bool {
    matches!(
        error,
        TraceHttpError::TimedOut { .. } | TraceHttpError::Transport(_)
    )
}

/// The retriable HTTP statuses; 429 is deliberately absent — the caller
/// reschedules instead.
pub(super) const RETRIABLE_HTTP_STATUSES: [u16; 6] = [408, 425, 500, 502, 503, 504];

#[cfg(test)]
mod transport_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Clone, Copy)]
    enum ResponseFraming {
        ContentLength,
        Chunked,
    }

    async fn oversized_stalled_trace_response(
        framing: ResponseFraming,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/trace", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let body = vec![b'x'; 1024 * 1024 + 1];
            let headers = match framing {
                ResponseFraming::ContentLength => format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len() + 1
                ),
                ResponseFraming::Chunked => {
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                        .to_string()
                }
            };
            socket.write_all(headers.as_bytes()).await.unwrap();
            if matches!(framing, ResponseFraming::Chunked) {
                socket
                    .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
            }
            socket.write_all(&body).await.unwrap();
            if matches!(framing, ResponseFraming::Chunked) {
                socket.write_all(b"\r\n").await.unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
        (url, server)
    }

    #[tokio::test]
    async fn trace_http_rejects_oversized_length_response_before_peer_finishes() {
        let (url, server) = oversized_stalled_trace_response(ResponseFraming::ContentLength).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            ReqwestTraceHttp.put(
                &url,
                Vec::new(),
                "{}".to_string(),
                30_000,
                /*cancel*/ None,
            ),
        )
        .await
        .expect("oversized trace response should fail before the peer closes");
        server.abort();
        assert!(matches!(
            result,
            Err(TraceHttpError::Transport(message)) if message.contains("exceeds 1048576 bytes")
        ));
    }

    #[tokio::test]
    async fn trace_http_rejects_oversized_chunked_response_before_peer_finishes() {
        let (url, server) = oversized_stalled_trace_response(ResponseFraming::Chunked).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            ReqwestTraceHttp.put(
                &url,
                Vec::new(),
                "{}".to_string(),
                30_000,
                /*cancel*/ None,
            ),
        )
        .await
        .expect("oversized trace response should fail before the peer closes");
        server.abort();
        assert!(matches!(
            result,
            Err(TraceHttpError::Transport(message)) if message.contains("exceeds 1048576 bytes")
        ));
    }

    #[tokio::test]
    async fn trace_http_preserves_small_body_status_and_retry_after() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/trace", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let body = "{\"message\":\"later\"}";
            let headers = format!(
                "HTTP/1.1 429 Too Many Requests\r\nContent-Length: {}\r\nRetry-After: 2\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        });
        let response = ReqwestTraceHttp
            .put(
                &url,
                Vec::new(),
                "{}".to_string(),
                30_000,
                /*cancel*/ None,
            )
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(
            response,
            TraceHttpResponse {
                status: 429,
                retry_after: Some("2".to_string()),
                body: "{\"message\":\"later\"}".to_string(),
            }
        );
    }
}

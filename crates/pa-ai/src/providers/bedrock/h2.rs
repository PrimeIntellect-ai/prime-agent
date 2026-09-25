//! The bedrock default transport: h2c prior-knowledge HTTP/2 over cleartext.
//!
//! The TS bedrock client (bun) runs the AWS SDK's `NodeHttp2Handler`: HTTP/2
//! with prior knowledge over cleartext (`http2.connect`, no upgrade), an
//! isolated session per event-stream request, no transport retries
//! (`maxAttempts: 1`), and no transport timeout. The TS-visible failure
//! surface is bun's node:http2 error text (`Protocol error`,
//! `The pending stream has been canceled`, ...), pinned byte-for-byte by the
//! provider-error probe. This module drives the same protocol directly on
//! the `h2` crate — one connection per request — so the failure classes the
//! TS surfaces (stream reset, session GOAWAY, socket failure, protocol
//! violations) classify into the same texts (see `utils_inner::h2_classify`).

use std::future::Future;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use crate::utils_inner::h2_classify::classify_h2_error;
use crate::utils_inner::stream_failure::{
    ConnectionErrorKind, ConnectionErrorProfile, H2Failure, ProviderConnectionError, ProviderError,
};

/// The bedrock wire transport, mirroring the TS request-handler selection:
/// the AWS SDK's `NodeHttp2Handler` by default; `NodeHttpHandler` (http1) when
/// `AWS_BEDROCK_FORCE_HTTP1=1` or a proxy environment is configured.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BedrockTransport {
    /// The node http1 handler (`AWS_BEDROCK_FORCE_HTTP1=1`, proxy env).
    Http1Handler,
    /// h2c prior-knowledge HTTP/2 (cleartext endpoints; TS default).
    H2Cleartext,
    /// HTTP/2 preferred over TLS ALPN (https endpoints; TS default).
    H2TlsAlpn,
}

/// Port of the TS request-handler selection: `NodeHttp2Handler` (http2) by
/// default; the http1 `NodeHttpHandler` for `AWS_BEDROCK_FORCE_HTTP1=1` or any
/// configured proxy environment (the product's own proxy path).
pub(crate) fn select_transport(
    scheme: &str,
    force_http1: bool,
    proxy_configured: bool,
) -> BedrockTransport {
    if force_http1 || proxy_configured {
        return BedrockTransport::Http1Handler;
    }
    if scheme.eq_ignore_ascii_case("https") {
        BedrockTransport::H2TlsAlpn
    } else {
        BedrockTransport::H2Cleartext
    }
}

pub(crate) struct H2RequestOptions {
    /// The full request URL (scheme + authority + path).
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub signal: Option<CancellationToken>,
    pub timeout_ms: Option<u64>,
    /// The AWS http2 connection-error profile for the failures.
    pub connection: ConnectionErrorProfile,
}

/// An opened http2 response: status, headers, and the body stream. Mirrors
/// `utils_inner::http::HttpResponse` for the bedrock read loop.
pub(crate) struct H2Response {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    body: h2::RecvStream,
    observer: crate::providers::bedrock::goaway::GoAwayObserver,
    signal: Option<CancellationToken>,
    connection: ConnectionErrorProfile,
}

impl H2Response {
    /// Read the next raw byte chunk from the body (None at end of stream).
    pub(crate) async fn next_bytes(&mut self) -> Result<Option<Vec<u8>>, ProviderError> {
        if self
            .signal
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(ProviderError::Aborted);
        }
        let chunk = match &self.signal {
            Some(signal) => {
                let next = futures::StreamExt::next(&mut self.body);
                tokio::select! {
                    _ = signal.cancelled() => return Err(ProviderError::Aborted),
                    chunk = next => chunk,
                }
            }
            None => futures::StreamExt::next(&mut self.body).await,
        };
        match chunk {
            Some(Ok(bytes)) => {
                // h2 flow control: the connection window must be released or
                // long event streams stall once the default window drains.
                let _ = self.body.flow_control().release_capacity(bytes.len());
                Ok(Some(bytes.to_vec()))
            }
            Some(Err(error)) => Err(self.body_error(error)),
            None => Ok(None),
        }
    }

    /// Read the entire body as text (for error responses).
    pub(crate) async fn read_all_text(&mut self) -> Result<String, ProviderError> {
        let mut out = String::new();
        while let Some(chunk) = self.next_bytes().await? {
            out.push_str(&String::from_utf8_lossy(&chunk));
        }
        Ok(out)
    }

    /// Classify a mid-body h2 failure into the TS transport's failure texts.
    fn body_error(&self, error: h2::Error) -> ProviderError {
        // A peer GOAWAY does not fail streams at or below its last-stream-id;
        // the stream only dies when the socket then closes — and a reset can
        // clobber the h2 crate's pending GOAWAY error before it is observed.
        // The wire observer (see `goaway`) keeps the session error the TS
        // transport reports.
        let failure = self.observer.classify_mid_body(&error);
        ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::H2MidStream(failure),
            profile: self.connection.clone(),
            cause: error.to_string(),
        })
    }
}

/// Race a phase against the abort signal.
async fn select_cancel(
    future: impl Future<Output = Result<H2Response, ProviderError>>,
    signal: Option<CancellationToken>,
) -> Result<H2Response, ProviderError> {
    match signal {
        Some(signal) => {
            tokio::select! {
                _ = signal.cancelled() => Err(ProviderError::Aborted),
                result = future => result,
            }
        }
        None => future.await,
    }
}

/// A pre-response transport failure: the h2 failure detail, no
/// deserialization hint (the AWS SDK has no response to deserialize yet).
fn h2_request_error(error: h2::Error, connection: &ConnectionErrorProfile) -> ProviderError {
    ProviderError::Connection(ProviderConnectionError {
        kind: ConnectionErrorKind::H2Request(classify_h2_error(&error)),
        profile: connection.clone(),
        cause: error.to_string(),
    })
}

/// A TCP connect failure: refused connects surface the TS stream-cancel
/// text with the node-style cause embedded; other connect failures surface
/// the bare stream-cancel text.
fn connect_error(error: std::io::Error, connection: &ConnectionErrorProfile) -> ProviderError {
    let kind = if error.kind() == std::io::ErrorKind::ConnectionRefused {
        ConnectionErrorKind::Connect
    } else {
        ConnectionErrorKind::H2Request(H2Failure::Canceled)
    };
    ProviderError::Connection(ProviderConnectionError {
        kind,
        profile: connection.clone(),
        cause: error.to_string(),
    })
}

/// The transport-timeout error, matching the reqwest path's shape.
fn timeout_error(connection: &ConnectionErrorProfile, timeout_ms: u64) -> ProviderError {
    ProviderError::Connection(ProviderConnectionError {
        kind: ConnectionErrorKind::Timeout,
        profile: connection.clone(),
        cause: format!("request exceeded the {timeout_ms}ms timeout"),
    })
}

/// Issue one h2c prior-knowledge request: connect, handshake, send the
/// request, and resolve once the response HEADERS arrive. The body is read
/// through the returned [`H2Response`].
pub(crate) async fn send_h2(options: H2RequestOptions) -> Result<H2Response, ProviderError> {
    let H2RequestOptions {
        url,
        headers,
        body,
        signal,
        timeout_ms,
        connection,
    } = options;

    if signal
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ProviderError::Aborted);
    }

    let outer_signal = signal.clone();
    let outer_connection = connection.clone();
    let request_future = async {
        let url = url::Url::parse(&url).map_err(|error| {
            ProviderError::Message(format!("Invalid Bedrock endpoint: {url} ({error})"))
        })?;
        let host = url.host_str().ok_or_else(|| {
            ProviderError::Message(format!("Invalid Bedrock endpoint host: {url}"))
        })?;
        // Bracket IPv6 literals for the connect authority.
        let connect_host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        let port = url.port_or_known_default().unwrap_or(80);
        let authority = format!("{connect_host}:{port}");

        // Connect: one connection per request, like the TS isolated
        // event-stream sessions.
        let tcp = tokio::net::TcpStream::connect(&authority)
            .await
            .map_err(|error| connect_error(error, &connection))?;
        let _ = tcp.set_nodelay(true);
        let (read_half, write_half) = tcp.into_split();
        let (tracked_read, observer) =
            crate::providers::bedrock::goaway::TrackedReadHalf::new(read_half);
        let io = crate::providers::bedrock::goaway::TrackedStream::new(tracked_read, write_half);

        // Handshake sends the h2 connection preface; the peer's answer is
        // validated by the codec when frames are read (an HTTP/1.1 answer
        // fails the first frame decode).
        let (mut send_request, connection_drive) = h2::client::handshake(io)
            .await
            .map_err(|error| h2_request_error(error, &connection))?;
        // Drive the protocol: nothing progresses unless the connection task
        // is polled; it ends when both request handles drop (the abort and
        // error paths reset the stream on release).
        tokio::spawn(async move {
            let _ = connection_drive.await;
        });

        futures::future::poll_fn(|cx| send_request.poll_ready(cx))
            .await
            .map_err(|error| h2_request_error(error, &connection))?;

        let request = http::Request::builder()
            .method(http::Method::POST)
            .uri(url.as_str())
            .body(())
            .map_err(|error| ProviderError::Message(format!("Invalid Bedrock request: {error}")))?;
        let mut request = request;
        for (name, value) in &headers {
            request.headers_mut().insert(
                http::HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
                    ProviderError::Message(format!("Invalid Bedrock header {name}: {error}"))
                })?,
                http::HeaderValue::from_str(value).map_err(|error| {
                    ProviderError::Message(format!(
                        "Invalid Bedrock header value for {name}: {error}"
                    ))
                })?,
            );
        }

        let (response, mut send_stream) = send_request
            .send_request(request, false)
            .map_err(|error| h2_request_error(error, &connection))?;
        send_stream
            .send_data(Bytes::from(body), true)
            .map_err(|error| h2_request_error(error, &connection))?;
        let response = response
            .await
            .map_err(|error| h2_request_error(error, &connection))?;

        let status = response.status().as_u16();
        let mut response_headers = std::collections::HashMap::new();
        for (name, value) in response.headers() {
            if let Ok(value) = value.to_str() {
                response_headers.insert(name.as_str().to_ascii_lowercase(), value.to_string());
            }
        }

        Ok(H2Response {
            status,
            headers: response_headers,
            body: response.into_body(),
            observer,
            signal,
            connection,
        })
    };

    let response = match timeout_ms {
        Some(timeout_ms) => tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            select_cancel(request_future, outer_signal),
        )
        .await
        .map_err(|_| timeout_error(&outer_connection, timeout_ms))??,
        None => select_cancel(request_future, outer_signal).await?,
    };
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aws_http2_profile() -> ConnectionErrorProfile {
        ConnectionErrorProfile::AwsHttp2 {
            host: "127.0.0.1".to_string(),
            port: 1,
        }
    }

    #[test]
    fn transport_selection_matches_ts() {
        // Default: http2 (cleartext h2c / TLS ALPN).
        assert_eq!(
            select_transport("http", false, false),
            BedrockTransport::H2Cleartext
        );
        assert_eq!(
            select_transport("https", false, false),
            BedrockTransport::H2TlsAlpn
        );
        // FORCE_HTTP1 and the proxy environment select the http1 handler,
        // like the TS request-handler switch.
        assert_eq!(
            select_transport("http", true, false),
            BedrockTransport::Http1Handler
        );
        assert_eq!(
            select_transport("https", false, true),
            BedrockTransport::Http1Handler
        );
    }

    #[test]
    fn connect_error_text() {
        let refused = connect_error(
            std::io::Error::from(std::io::ErrorKind::ConnectionRefused),
            &aws_http2_profile(),
        );
        assert_eq!(
            refused.to_string(),
            "The pending stream has been canceled (caused by: connect ECONNREFUSED 127.0.0.1:1)"
        );
        // Other connect failures (unreachable, DNS) surface the bare
        // stream-cancel text.
        let other = connect_error(
            std::io::Error::from(std::io::ErrorKind::HostUnreachable),
            &aws_http2_profile(),
        );
        assert_eq!(other.to_string(), "The pending stream has been canceled");
    }

    #[test]
    fn timeout_error_text() {
        let error = timeout_error(&aws_http2_profile(), 5_000);
        assert_eq!(error.to_string(), "Request timed out.");
    }
}

/// Raw-socket h2 mock for the transport tests: one connection, one scripted
/// response. Frames are written/parsed by hand (the probe drives the TS
/// binary through the same wire sequences).
#[cfg(test)]
mod h2_wire_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

    fn frame(ftype: u8, flags: u8, stream_id: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(9 + payload.len());
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes()[1..]);
        out.push(ftype);
        out.push(flags);
        out.extend_from_slice(&stream_id.to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// HPACK: indexed `:status` 200 (0x88) + literal content-type (name 31).
    fn response_headers() -> Vec<u8> {
        let content_type = b"application/vnd.amazon.eventstream";
        let mut block = vec![0x88, 0x0f, 0x10, content_type.len() as u8];
        block.extend_from_slice(content_type);
        block
    }

    enum MockAction {
        /// Respond 200 + partial eventstream bytes, then `RST_STREAM`.
        RstStream,
        /// Respond 200 + partial bytes, then `GOAWAY(PROTOCOL_ERROR)`, then close.
        GoAway,
        /// Respond 200 + partial bytes, then close the socket (FIN).
        Close,
    }

    async fn read_client_preface(socket: &mut tokio::net::TcpStream) {
        let mut preface = vec![0u8; PREFACE.len()];
        socket.read_exact(&mut preface).await.unwrap();
        assert_eq!(&preface[..], PREFACE);
        // drain frames until the request HEADERS arrive (END_HEADERS)
        loop {
            let mut header = [0u8; 9];
            socket.read_exact(&mut header).await.unwrap();
            let length = (u32::from_be_bytes([0, header[0], header[1], header[2]])) as usize;
            let ftype = header[3];
            let flags = header[4];
            let mut payload = vec![0u8; length];
            if length > 0 {
                socket.read_exact(&mut payload).await.unwrap();
            }
            if ftype == 0x4 && flags & 0x1 == 0 {
                socket.write_all(&frame(0x4, 0x1, 0, &[])).await.unwrap();
            }
            if ftype == 0x1 && flags & 0x4 != 0 {
                return;
            }
        }
    }

    async fn spawn_h2_mock(action: MockAction) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_client_preface(&mut socket).await;
            socket
                .write_all(&frame(0x1, 0x4, 1, &response_headers()))
                .await
                .unwrap();
            socket
                .write_all(&frame(0x0, 0x0, 1, &[0u8; 16]))
                .await
                .unwrap();
            match action {
                MockAction::RstStream => {
                    socket
                        .write_all(&frame(0x3, 0x0, 1, &2u32.to_be_bytes()))
                        .await
                        .unwrap();
                }
                MockAction::GoAway => {
                    let mut payload = Vec::new();
                    payload.extend_from_slice(&1u32.to_be_bytes());
                    payload.extend_from_slice(&1u32.to_be_bytes());
                    socket
                        .write_all(&frame(0x7, 0x0, 0, &payload))
                        .await
                        .unwrap();
                }
                MockAction::Close => {}
            }
            socket.shutdown().await.ok();
            socket.shutdown().await.ok();
            let _ = socket.flush().await;
            // hold the socket a moment so the failure reaches the client
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        });
        let addr = addr.port();
        format!("127.0.0.1:{addr}")
    }

    fn options(url: String) -> H2RequestOptions {
        let parsed = url::Url::parse(&url).unwrap();
        let host = parsed.host_str().unwrap().to_string();
        let port = parsed.port_or_known_default().unwrap_or(80);
        H2RequestOptions {
            url,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: b"{}".to_vec(),
            signal: None,
            timeout_ms: None,
            connection: ConnectionErrorProfile::AwsHttp2 { host, port },
        }
    }

    async fn mid_stream_error(action: MockAction) -> String {
        let url = format!(
            "http://{}/model/m/converse-stream",
            spawn_h2_mock(action).await
        );
        let mut response = send_h2(options(url)).await.unwrap();
        assert_eq!(response.status, 200);
        // First chunk: the partial eventstream bytes.
        assert!(matches!(response.next_bytes().await, Ok(Some(_))));
        match response.next_bytes().await {
            Ok(None) => panic!("mid-stream failure did not surface"),
            Ok(Some(_)) => panic!("expected the transport failure"),
            Err(error) => error.to_string(),
        }
    }

    /// `RST_STREAM` mid-body: the nghttp2 code name + the AWS SDK
    /// deserialization hint (TS-binary verified).
    #[tokio::test]
    async fn rst_stream_mid_body_text() {
        let error = mid_stream_error(MockAction::RstStream).await;
        assert_eq!(
            error,
            "Stream closed with error code NGHTTP2_INTERNAL_ERROR\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
        );
    }

    /// GOAWAY mid-body: the numeric session code + the deserialization hint.
    #[tokio::test]
    async fn goaway_mid_body_text() {
        let error = mid_stream_error(MockAction::GoAway).await;
        assert_eq!(
            error,
            "Session closed with error code 1\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
        );
    }

    /// A clean close mid-body: the canceled pending stream + the hint.
    #[tokio::test]
    async fn tcp_close_mid_body_text() {
        let error = mid_stream_error(MockAction::Close).await;
        assert_eq!(
            error,
            "The pending stream has been canceled\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
        );
    }

    /// An HTTP/1.1 answer at a prior-knowledge h2 endpoint: the pre-response
    /// protocol error, no deserialization hint.
    #[tokio::test]
    async fn http1_answer_is_protocol_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_http1 = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 24];
            socket.read_exact(&mut buf).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
        });
        let url = format!("http://{addr_http1}/model/m/converse-stream");
        let error = match send_h2(options(url.clone())).await {
            Ok(_) => panic!("expected the http1 answer to fail the h2 preface"),
            Err(error) => error.to_string(),
        };
        assert_eq!(error, "Protocol error");
    }

    /// A refused connect: the canceled pending stream with the node-style
    /// connect cause embedded.
    #[tokio::test]
    async fn refused_connect_text() {
        // Port 1 is never served (the probe's dead port).
        let url = "http://127.0.0.1:1/model/m/converse-stream".to_string();
        let error = match send_h2(options(url)).await {
            Ok(_) => panic!("expected the dead port to fail"),
            Err(error) => error.to_string(),
        };
        assert_eq!(
            error,
            "The pending stream has been canceled (caused by: connect ECONNREFUSED 127.0.0.1:1)"
        );
    }
}

//! Shared helpers for the integration verifiers: a scripted local HTTP
//! server that records every request (head and body, as raw bytes) and
//! answers from a queue of scripted responses — complete raw responses,
//! incrementally streamed bodies (the Connect frame tests), and
//! mid-connection closes (the reattach tests). Nothing leaves loopback.
//! (Adapted from `pa-models` `tests/common`; the byte-aware recording
//! and the streaming scripts serve the gateway and command-session
//! suites' wire verifiers.)

// Different test binaries consume different subsets of the helpers.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

type RequestLog = Arc<Mutex<Vec<Vec<u8>>>>;

/// One scripted reply on a connection.
#[derive(Debug, Clone)]
pub struct ScriptedResponse {
    /// Pause after reading the request and before writing anything back
    /// (a slow server head, for deadline semantics).
    pub head_delay: Duration,
    /// The complete response bytes written as soon as the request is read
    /// (status line, headers, and any immediately-sent body).
    pub raw: Vec<u8>,
    /// Incremental writes after `raw`, each followed by a flush and a
    /// sleep (proves mid-body consumption).
    pub stream: Vec<(Vec<u8>, Duration)>,
    /// Close the connection after the writes (mid-frame EOF tests).
    pub close: bool,
    /// Hold the connection open after the writes until the peer closes
    /// (a live streaming body the peer is still reading).
    pub hold: bool,
}

impl ScriptedResponse {
    /// A complete raw response; the connection stays reusable
    /// (keep-alive).
    #[must_use]
    pub fn raw(bytes: Vec<u8>) -> Self {
        Self {
            head_delay: Duration::ZERO,
            raw: bytes,
            stream: Vec::new(),
            close: false,
            hold: false,
        }
    }

    /// A complete response whose body streams incrementally; the
    /// connection holds open afterwards (the peer keeps the body open).
    #[must_use]
    pub fn streaming(raw: Vec<u8>, stream: Vec<(Vec<u8>, Duration)>) -> Self {
        Self {
            head_delay: Duration::ZERO,
            raw,
            stream,
            close: false,
            hold: true,
        }
    }
}

pub struct MockServer {
    port: u16,
    requests: RequestLog,
    queue: ResponseQueue,
}

impl MockServer {
    /// Start a server answering with `responses` in order; the last
    /// response repeats when the queue drains.
    pub async fn start(responses: Vec<Vec<u8>>) -> Self {
        Self::start_scripts(responses.into_iter().map(ScriptedResponse::raw).collect()).await
    }

    /// Start a server answering with `scripts` in order (raw, streamed,
    /// or closing); the last script repeats when the queue drains.
    pub async fn start_scripts(scripts: Vec<ScriptedResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let port = listener.local_addr().unwrap().port();
        let requests: RequestLog = Arc::new(Mutex::new(Vec::new()));
        let responses: ResponseQueue = Arc::new(Mutex::new(VecDeque::from(scripts)));
        let _handle = tokio::spawn(run(listener, Arc::clone(&requests), Arc::clone(&responses)));
        Self {
            port,
            requests,
            queue: responses,
        }
    }

    /// The loopback URL for a request path.
    #[must_use]
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// Append a scripted reply to the queue (scripts that need this
    /// server's own URL — e.g. a gateway auth response pointing back at
    /// the mock — are pushed after `start`).
    pub fn push(&self, script: ScriptedResponse) {
        self.queue.lock().unwrap().push_back(script);
    }

    /// Append a complete raw reply to the queue.
    pub fn push_raw(&self, bytes: Vec<u8>) {
        self.queue
            .lock()
            .unwrap()
            .push_back(ScriptedResponse::raw(bytes));
    }

    /// Every recorded request (head and body) so far, as lossy text.
    #[must_use]
    pub fn recorded_requests(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .collect()
    }

    /// Every recorded request as raw bytes (head and body), for
    /// byte-exact wire assertions on proto and multipart bodies.
    #[must_use]
    pub fn recorded_request_bytes(&self) -> Vec<Vec<u8>> {
        self.requests.lock().unwrap().clone()
    }

    /// How many requests the server has seen.
    #[must_use]
    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

type ResponseQueue = Arc<Mutex<VecDeque<ScriptedResponse>>>;

async fn run(listener: TcpListener, requests: RequestLog, responses: ResponseQueue) {
    loop {
        let Ok((socket, _)) = listener.accept().await else {
            return;
        };
        let requests = Arc::clone(&requests);
        let responses = Arc::clone(&responses);
        tokio::spawn(async move {
            let mut socket = socket;
            // One connection may carry several requests (keep-alive);
            // each is answered from the shared queue in arrival order.
            loop {
                let Some((request, head_end)) = read_request(&mut socket).await else {
                    return;
                };
                requests.lock().unwrap().push(request);
                let script = responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                    ScriptedResponse::raw(
                        b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec(),
                    )
                });
                if !script.head_delay.is_zero() {
                    tokio::time::sleep(script.head_delay).await;
                }
                if socket.write_all(&script.raw).await.is_err() {
                    return;
                }
                for (bytes, delay) in &script.stream {
                    if socket.write_all(bytes).await.is_err() {
                        return;
                    }
                    let _ = socket.flush().await;
                    tokio::time::sleep(*delay).await;
                }
                let _ = socket.flush().await;
                if script.close {
                    return;
                }
                if script.hold {
                    // The peer owns the body (a live stream): wait for its
                    // close, then end the connection.
                    let mut sink = [0u8; 1024];
                    loop {
                        match socket.read(&mut sink).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => {}
                        }
                    }
                }
                let _ = head_end;
            }
        });
    }
}

/// Read one full request (head plus any declared body); returns the raw
/// bytes.
async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<(Vec<u8>, usize)> {
    let mut buffer = Vec::with_capacity(8_192);
    let mut read = [0u8; 8_192];
    loop {
        let Ok(n) = socket.read(&mut read).await else {
            return None;
        };
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&read[..n]);
        let Some(head_end) = find_head_end(&buffer) else {
            continue;
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]);
        let content_length = head
            .lines()
            .find_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if buffer.len() >= head_end + 4 + content_length {
            return Some((buffer, head_end));
        }
    }
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// A JSON response builder.
pub fn json_response(status: u16, reason: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// A response with a non-JSON body.
pub fn text_response(status: u16, reason: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// A raw response with explicit headers and an exact content-length
/// body (binary downloads, proto and connect+proto bodies).
pub fn raw_response(status: u16, reason: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

/// A unary proto response (content type `application/proto`).
pub fn proto_response(status: u16, reason: &str, body: &[u8]) -> Vec<u8> {
    raw_response(status, reason, "application/proto", body)
}

/// A redirect response (the transport must refuse it, not follow it).
pub fn redirect_response(status: u16, reason: &str, location: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\nlocation: {location}\r\ncontent-length: 0\r\n\r\n")
        .into_bytes()
}

/// One HTTP chunk of a chunked body.
pub fn http_chunk(data: &[u8]) -> Vec<u8> {
    let mut chunk = format!("{:x}\r\n", data.len()).into_bytes();
    chunk.extend_from_slice(data);
    chunk.extend_from_slice(b"\r\n");
    chunk
}

/// The terminating chunk of a chunked body.
pub fn http_chunk_end() -> Vec<u8> {
    b"0\r\n\r\n".to_vec()
}

/// A chunked 200 whose streamed body exceeds a small transport cap.
pub fn oversized_stream() -> Vec<u8> {
    let mut response = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n".to_vec();
    let chunk = format!("{:x}\r\n", 1024 * 1024);
    response.extend_from_slice(chunk.as_bytes());
    response.extend_from_slice(&vec![b'a'; 1024 * 1024]);
    response.extend_from_slice(b"\r\n");
    response
}

/// A Connect streaming response head (chunked transfer encoding, the
/// connect+proto media type).
pub fn connect_stream_head(status: u16, reason: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\ncontent-type: application/connect+proto\r\ntransfer-encoding: chunked\r\n\r\n")
        .into_bytes()
}

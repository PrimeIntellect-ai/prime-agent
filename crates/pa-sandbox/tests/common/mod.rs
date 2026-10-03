//! Shared helpers for the integration verifiers: a scripted local HTTP
//! server that records every request (head and body) and answers from a
//! queue of raw responses. Nothing leaves loopback. (Adapted from
//! `pa-models` `tests/common`; the body-aware recording serves the
//! sandbox suite's POST/DELETE verifiers.)

// Different test binaries consume different subsets of the helpers.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

type RequestLog = Arc<Mutex<Vec<String>>>;

pub struct MockServer {
    port: u16,
    requests: RequestLog,
    _handle: tokio::task::JoinHandle<()>,
}

impl MockServer {
    /// Start a server answering with `responses` in order; the last
    /// response repeats when the queue drains.
    pub async fn start(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let port = listener.local_addr().unwrap().port();
        let requests: RequestLog = Arc::new(Mutex::new(Vec::new()));
        let responses: ResponseQueue = Arc::new(Mutex::new(VecDeque::from(responses)));
        let handle = tokio::spawn(run(listener, Arc::clone(&requests), responses));
        Self {
            port,
            requests,
            _handle: handle,
        }
    }

    /// The loopback URL for a request path.
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// Every recorded request (head and body) so far, as text.
    pub fn recorded_requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    /// How many requests the server has seen.
    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

type ResponseQueue = Arc<Mutex<VecDeque<Vec<u8>>>>;

async fn run(listener: TcpListener, requests: RequestLog, responses: ResponseQueue) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let requests = Arc::clone(&requests);
        let responses = Arc::clone(&responses);
        tokio::spawn(async move {
            let mut buffer = Vec::with_capacity(8_192);
            let mut read = [0u8; 8_192];
            // Read the head, then any declared body, before answering.
            loop {
                let Ok(n) = socket.read(&mut read).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                buffer.extend_from_slice(&read[..n]);
                let Some(head_end) = find_head_end(&buffer) else {
                    continue;
                };
                let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
                let content_length = head
                    .lines()
                    .find_map(|line| line.split_once(':'))
                    .filter(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buffer.len() >= head_end + 4 + content_length {
                    requests
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&buffer).to_string());
                    break;
                }
            }
            let response =
                responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                    b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec()
                });
            let _ = socket.write_all(&response).await;
            let _ = socket.flush().await;
        });
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

/// A redirect response (the transport must refuse it, not follow it).
pub fn redirect_response(status: u16, reason: &str, location: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\nlocation: {location}\r\ncontent-length: 0\r\n\r\n")
        .into_bytes()
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

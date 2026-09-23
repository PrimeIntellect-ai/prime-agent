//! A scripted loopback HTTP server (the pa-models `tests/common` pattern):
//! answers from a queue of raw responses and records every request head
//! (headers included). Nothing leaves loopback.

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

    /// The URL for a request path.
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// Every recorded request head so far.
    pub fn recorded_requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
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
            let mut buffer = [0u8; 8_192];
            let mut read = 0usize;
            loop {
                let Ok(n) = socket.read(&mut buffer[read..]).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                read += n;
                if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if read == buffer.len() {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
            requests.lock().unwrap().push(head);
            let response =
                responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                    b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec()
                });
            let _ = socket.write_all(&response).await;
            let _ = socket.flush().await;
        });
    }
}

/// Convenience builders for raw HTTP responses.
pub fn ok_json(body: String, etag: Option<&str>) -> Vec<u8> {
    let etag = etag
        .map(|etag| format!("etag: {etag}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{etag}\r\n{body}",
        body.len()
    )
    .into_bytes()
}

pub fn status(status: u16, reason: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\n\r\n").into_bytes()
}

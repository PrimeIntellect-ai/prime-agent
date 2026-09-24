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
        Self::start_scripted(responses.into_iter().map(Scripted::Response).collect()).await
    }

    /// Start a server answering with `scripts` in order (raw, delayed, or
    /// held connections); the queue draining answers 500.
    pub async fn start_scripted(scripts: Vec<Scripted>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let port = listener.local_addr().unwrap().port();
        let requests: RequestLog = Arc::new(Mutex::new(Vec::new()));
        let responses: ResponseQueue = Arc::new(Mutex::new(VecDeque::from(scripts)));
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

type ResponseQueue = Arc<Mutex<VecDeque<Scripted>>>;

/// One scripted server behavior: raw bytes, raw bytes after a delay (a
/// slow catalog fetch), or a held connection that never answers (a fetch
/// that never settles).
pub enum Scripted {
    Response(Vec<u8>),
    Delayed(Vec<u8>, std::time::Duration),
    Hang,
}

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
            let scripted = responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                Scripted::Response(b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec())
            });
            match scripted {
                Scripted::Response(response) => {
                    let _ = socket.write_all(&response).await;
                    let _ = socket.flush().await;
                }
                Scripted::Delayed(response, delay) => {
                    tokio::time::sleep(delay).await;
                    let _ = socket.write_all(&response).await;
                    let _ = socket.flush().await;
                }
                // A held connection: the request records, the fetch never
                // settles (the caller's bounded wait must return first).
                Scripted::Hang => {
                    tokio::time::sleep(std::time::Duration::from_hours(1)).await;
                    let _ = socket.write_all(&[]).await;
                }
            }
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

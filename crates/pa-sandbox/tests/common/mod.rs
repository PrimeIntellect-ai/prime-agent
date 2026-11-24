//! A scripted loopback HTTP server for the transport verifiers: it records
//! every request and answers from a queue of raw responses. Nothing leaves
//! loopback.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

type RequestLog = Arc<Mutex<Vec<String>>>;
type ResponseQueue = Arc<Mutex<VecDeque<Vec<u8>>>>;

pub struct MockServer {
    port: u16,
    requests: RequestLog,
}

impl MockServer {
    /// Start a server answering with `responses` in order.
    pub async fn start(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let port = listener.local_addr().unwrap().port();
        let requests: RequestLog = Arc::new(Mutex::new(Vec::new()));
        let queue: ResponseQueue = Arc::new(Mutex::new(VecDeque::from(responses)));
        tokio::spawn(run(listener, Arc::clone(&requests), queue));
        Self { port, requests }
    }

    /// The loopback URL for a request path.
    #[must_use]
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// Every recorded request (head and body) so far, as lossy text.
    #[must_use]
    pub fn recorded_requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

async fn run(listener: TcpListener, requests: RequestLog, responses: ResponseQueue) {
    while let Ok((mut socket, _)) = listener.accept().await {
        let requests = Arc::clone(&requests);
        let responses = Arc::clone(&responses);
        tokio::spawn(async move {
            // One connection may carry several requests (keep-alive).
            while let Some(request) = read_request(&mut socket).await {
                requests.lock().unwrap().push(request);
                let response = responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                    b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec()
                });
                if socket.write_all(&response).await.is_err() {
                    return;
                }
            }
        });
    }
}

/// Read one full request (head plus any declared body).
async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(8_192);
    let mut read = [0u8; 8_192];
    loop {
        let n = socket.read(&mut read).await.ok().filter(|n| *n > 0)?;
        buffer.extend_from_slice(&read[..n]);
        let Some(head_end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]);
        let content_length = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if buffer.len() >= head_end + 4 + content_length {
            return Some(String::from_utf8_lossy(&buffer).into_owned());
        }
    }
}

/// A JSON response.
pub fn json_response(status: u16, reason: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// A redirect response (the transport must refuse it, not follow it).
pub fn redirect_response(status: u16, reason: &str, location: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\nlocation: {location}\r\ncontent-length: 0\r\n\r\n")
        .into_bytes()
}

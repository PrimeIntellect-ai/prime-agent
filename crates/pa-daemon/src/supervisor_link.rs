//! Worker -> supervisor link for cross-worker requests. Each command uses
//! an independent JSONL socket so a long-running supervisor request cannot
//! serialize roster and message admission behind its response.
//! Requests are retried only when a write fails before the command is sent.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_types::platform::transport::{connect_transport, AsyncReadHalf, AsyncWriteHalf};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::protocol::{current_protocol_info, DaemonResponse};

/// Sentinel for command-level timeouts.
#[derive(Debug, thiserror::Error)]
#[error("supervisor link request timed out")]
struct LinkTimeout;

/// Marker for write-phase failures: the command never reached the
/// supervisor, so a transparent reconnect-and-retry is safe. The TS link
/// gets the same property from its close listener (teardown before the
/// next request reconnects); this link discovers death lazily instead.
#[derive(Debug, thiserror::Error)]
#[error("supervisor link write failed before the request was sent")]
struct LinkWriteFailed;

/// One request/response exchange over the supervisor client socket.
struct LinkClient {
    reader: BufReader<Box<dyn AsyncReadHalf>>,
    writer: Box<dyn AsyncWriteHalf>,
    next_id: u64,
}

impl LinkClient {
    /// Send one command envelope and read the line that answers its id.
    /// Broadcast lines on the client socket are skipped; ids keep them
    /// apart from the response this request waits for. A write failure is
    /// tagged [`LinkWriteFailed`] (the command was not sent); everything
    /// after the write is uncertain and surfaces as a plain error.
    async fn request(&mut self, command: Value, timeout: Duration) -> Result<DaemonResponse> {
        let id = format!("link-{}", self.next_id);
        self.next_id += 1;
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": current_protocol_info(),
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).context("serialize link command")?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .await
            .map_err(|error| anyhow::Error::new(LinkWriteFailed).context(error))?;
        self.writer
            .flush()
            .await
            .map_err(|error| anyhow::Error::new(LinkWriteFailed).context(error))?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let mut line = String::new();
            let read = tokio::time::timeout_at(deadline, self.reader.read_line(&mut line))
                .await
                .map_err(|_| LinkTimeout)?
                .context("supervisor link closed")?;
            if read == 0 {
                return Err(anyhow!("supervisor link closed"));
            }
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(line.trim())
                .with_context(|| format!("invalid link response: {line}"))?;
            if value.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                return serde_json::from_value(value)
                    .map_err(|error| anyhow!("invalid link response: {error}"));
            }
        }
    }
}

/// Supervisor connection endpoint for a daemon worker. Each request uses its
/// own socket so a long-poll or slow worker cannot block a roster or message
/// admission request behind the connection's read lock.
pub struct SupervisorLink {
    socket_path: PathBuf,
}

impl SupervisorLink {
    pub fn new(socket_path: PathBuf) -> Self {
        Self { socket_path }
    }

    /// The supervisor socket this link dials.
    pub fn socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    /// Send one request over an independent connection. Once a command is
    /// written it is never retried; only a failed write can reconnect once.
    pub async fn request(&self, command: Value, timeout: Duration) -> Result<DaemonResponse> {
        // Include connect and the supervisor hello in the caller's deadline:
        // a socket that accepts but never greets must not stall this request.
        let deadline = tokio::time::Instant::now() + timeout;
        tokio::time::timeout_at(deadline, async {
            let mut client = self.connect().await?;
            match client.request(command.clone(), timeout).await {
                Err(error) if error.downcast_ref::<LinkWriteFailed>().is_some() => {
                    self.connect().await?.request(command, timeout).await
                }
                outcome => outcome,
            }
        })
        .await
        .map_err(|_| LinkTimeout)?
    }

    /// Consume the supervisor hello and hand back a live client.
    async fn connect(&self) -> Result<LinkClient> {
        let stream = connect_transport(&self.socket_path)
            .await
            .with_context(|| format!("connect supervisor {}", self.socket_path.display()))?;
        let (reader, writer) = stream.split();
        let mut client = LinkClient {
            reader: BufReader::new(reader),
            writer,
            next_id: 0,
        };
        let mut line = String::new();
        client
            .reader
            .read_line(&mut line)
            .await
            .context("read supervisor hello")?;
        let hello: Value = serde_json::from_str(line.trim())
            .with_context(|| format!("invalid supervisor hello: {line}"))?;
        if hello.get("type").and_then(Value::as_str) != Some("daemon_hello") {
            return Err(anyhow!("supervisor link handshake failed"));
        }
        Ok(client)
    }

    /// Send a request and require a successful response; returns its data.
    pub async fn request_success(&self, command: Value, timeout: Duration) -> Result<Value> {
        let response = self.request(command, timeout).await?;
        if !response.success {
            return Err(anyhow!(
                "{}",
                response
                    .error
                    .unwrap_or_else(|| "request failed".to_string())
            ));
        }
        Ok(response.data.unwrap_or(Value::Null))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::protocol::{response_line, response_success};

    #[tokio::test]
    async fn long_request_does_not_block_roster_or_message_on_the_same_link() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut started_tx = Some(started_tx);
            for _ in 0..3 {
                let (stream, _) = listener.accept().await.unwrap();
                let tx = started_tx.take();
                tokio::spawn(async move {
                    let (reader, mut writer) = stream.into_split();
                    writer.write_all(b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n").await.unwrap();
                    let mut reader = BufReader::new(reader);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let kind = request["command"]["type"].as_str().unwrap();
                    if kind == "wait_for_idle" {
                        if let Some(tx) = tx {
                            let _ = tx.send(());
                        }
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    let response = response_line(&response_success(
                        request["id"].as_str(),
                        kind,
                        Some(json!({ "accepted": true })),
                    ));
                    writer
                        .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                        .await
                        .unwrap();
                    writer.write_all(b"\n").await.unwrap();
                });
            }
        });
        let link = std::sync::Arc::new(SupervisorLink::new(socket));
        let waiting = {
            let link = std::sync::Arc::clone(&link);
            tokio::spawn(async move {
                link.request_success(json!({ "type": "wait_for_idle" }), Duration::from_secs(1))
                    .await
            })
        };
        started_rx.await.unwrap();
        for kind in ["list_agent_peers", "send_message"] {
            let response = tokio::time::timeout(
                Duration::from_millis(100),
                link.request_success(json!({ "type": kind }), Duration::from_secs(1)),
            )
            .await
            .expect("request queued behind idle wait")
            .unwrap();
            assert_eq!(response["accepted"], true);
        }
        waiting.await.unwrap().unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unanswered_supervisor_hello_respects_request_deadline() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        let link = SupervisorLink::new(socket);
        let started = tokio::time::Instant::now();
        let result = link
            .request(
                json!({ "type": "list_agent_peers" }),
                Duration::from_millis(20),
            )
            .await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_millis(100));
        server.await.unwrap();
    }

    /// The link round-trips one command against a JSONL echo server: hello
    /// handshake, id-matched response, reconnect after a dead connection.
    #[tokio::test]
    async fn link_round_trips_against_an_echo_server() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            writer
                .write_all(
                    b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                )
                .await
                .unwrap();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 {
                    return;
                }
                let value: Value = serde_json::from_str(line.trim()).unwrap();
                let id = value["id"].clone();
                let command = value["command"].clone();
                let response = response_line(&response_success(
                    Some(id.as_str().unwrap_or_default()),
                    "echo",
                    Some(json!({ "echo": command })),
                ));
                writer
                    .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                    .await
                    .unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
        });
        let link = SupervisorLink::new(socket);
        let data = link
            .request_success(json!({ "type": "list" }), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(data["echo"]["type"], "list", "echo mismatch: {data}");
        // Drop the link first: its socket is the server loop's stop signal.
        drop(link);
        server.await.unwrap();
    }
}

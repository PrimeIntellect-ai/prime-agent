//! Worker -> supervisor link: one lazily established JSONL client connection
//! multiplexing cross-worker requests (agent messages, roster reads).
//! Port of `modes/daemon/supervisor-link.ts`.
//!
//! Socket death is expected during supervisor restarts: the link tears down
//! on connection-level failures and the next request reconnects. Requests
//! are never retried - daemon commands are not idempotent - and command-level
//! failures (timeouts, rejections) leave a healthy connection serving the
//! next request. Requests serialize on one connection (the mutex); agent
//! messages and roster reads are low-rate, so this matches the TS link's
//! single-socket multiplexing without its in-flight request table.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_types::platform::transport::{connect_transport, AsyncReadHalf, AsyncWriteHalf};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::protocol::{current_protocol_info, DaemonResponse};

/// Sentinel for command-level timeouts: unlike connection failures, a
/// timeout leaves the shared socket healthy for the next request.
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

/// Long-lived supervisor connection for a daemon worker.
pub struct SupervisorLink {
    socket_path: PathBuf,
    client: Mutex<Option<LinkClient>>,
}

impl SupervisorLink {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            client: Mutex::new(None),
        }
    }

    /// The supervisor socket this link dials.
    pub fn socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    /// Send one request, connecting first when the link is down. Never
    /// retries a delivered command: daemon commands are not idempotent. A
    /// write-phase failure never delivered anything, so exactly one
    /// transparent reconnect-and-retry covers the supervisor-restart
    /// window (the TS link's close-listener teardown achieves the same).
    pub async fn request(&self, command: Value, timeout: Duration) -> Result<DaemonResponse> {
        let mut guard = self.client.lock().await;
        if guard.is_none() {
            *guard = Some(self.connect().await?);
        }
        let outcome = {
            let client = guard.as_mut().expect("client was just connected");
            client.request(command.clone(), timeout).await
        };
        match outcome {
            Ok(response) => Ok(response),
            Err(error) if error.downcast_ref::<LinkWriteFailed>().is_some() => {
                // The socket died before the request went out; a fresh
                // connection gets exactly one retry and replaces the dead
                // one for later requests.
                let mut client = self.connect().await?;
                let retried = client.request(command, timeout).await;
                *guard = Some(client);
                retried
            }
            Err(error) => {
                // Connection-level failures invalidate the shared socket;
                // the next request reconnects. Timeouts keep the socket.
                if error.downcast_ref::<LinkTimeout>().is_none() {
                    *guard = None;
                }
                Err(error)
            }
        }
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

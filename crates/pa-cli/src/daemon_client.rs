//! Daemon socket client for the CLI's daemon-backed public commands
//! (`list`, `stop`, `rename`, `send`, `schedule`).
//!
//! Port of `modes/daemon/daemon-client.ts` restricted to the one-shot request
//! shape these commands use: connect, read the `daemon_hello` greeting, send
//! one `command` envelope per request, and match responses by request id.
//! Reconnect/recovery machinery is TUI-oriented and stays out of the CLI.
//!
//! The client never spawns a daemon: the TS CLI only auto-starts one for the
//! internal `daemon start`/`open` commands, which are not reachable from the
//! public command surface. When no daemon answers the socket, the exact TS
//! connect error is surfaced to the user.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use pa_types::daemon::{
    DaemonCommand, DaemonProtocolInfo, DaemonResponse, DAEMON_PROTOCOL_VERSION,
};
use pa_types::platform::transport::{connect_blocking, BlockingTransportStream};
use serde_json::json;

use crate::config;

/// Default response timeout, mirroring `DEFAULT_DAEMON_REQUEST_TIMEOUT_MS`.
const REQUEST_TIMEOUT_MS: u64 = 30_000;
/// Greeting timeout, mirroring the TS `waitForHello` default.
const HELLO_TIMEOUT_MS: u64 = 3_000;
/// Read poll granularity for deadline-driven reads.
const READ_POLL: Duration = Duration::from_millis(50);

/// A client connection to one daemon socket.
#[derive(Debug)]
pub(crate) struct DaemonClient {
    socket_path: PathBuf,
    reader: BufReader<Box<dyn BlockingTransportStream>>,
    writer: Box<dyn BlockingTransportStream>,
    hello: Option<serde_json::Value>,
    daemon_closing_reason: Option<String>,
    request_id: u64,
    protocol_client_id: String,
}

impl DaemonClient {
    /// Connect to the daemon socket, ready for the hello handshake.
    pub(crate) fn connect(socket_path: &Path) -> Result<Self> {
        Self::connect_raw(socket_path).map_err(|error| {
            anyhow!(
                "Failed to connect to the Prime Agent daemon: {}. {}",
                node_connect_error(&error, socket_path),
                endpoint_details(socket_path)
            )
        })
    }

    /// [`Self::connect`] without the user-facing error decoration: discovery
    /// probes expect unreachable sockets and classify them instead of
    /// surfacing the connect error.
    pub(crate) fn connect_probe(socket_path: &Path) -> Result<Self> {
        Self::connect_raw(socket_path).map_err(|error| anyhow!("connect: {error}"))
    }

    fn connect_raw(socket_path: &Path) -> std::io::Result<Self> {
        let stream = connect_blocking(socket_path)?;
        let writer = stream.try_clone_box()?;
        Ok(DaemonClient {
            socket_path: socket_path.to_path_buf(),
            reader: BufReader::new(stream),
            writer,
            hello: None,
            daemon_closing_reason: None,
            request_id: 0,
            protocol_client_id: format!("daemon-client:{}", uuid::Uuid::new_v4()),
        })
    }

    /// Send one command envelope and wait for its response with the default
    /// timeout.
    ///
    /// Errors carry the exact TS client message text, including the socket and
    /// daemon-log path the TS product prints so users can self-diagnose.
    pub(crate) fn request(&mut self, command: DaemonCommand) -> Result<DaemonResponse> {
        self.request_with_timeout(command, REQUEST_TIMEOUT_MS)
    }

    /// [`Self::request`] with an explicit response deadline (daemon
    /// discovery probes use the TS probe timeouts, not the CLI default).
    pub(crate) fn request_with_timeout(
        &mut self,
        command: DaemonCommand,
        timeout_ms: u64,
    ) -> Result<DaemonResponse> {
        let command_type = command_type_name(&command).to_string();
        let operation = Operation::Command(&command_type);
        let hello = self.wait_for_hello(HELLO_TIMEOUT_MS)?;
        let protocol = daemon_protocol(&hello)?;
        if protocol.version < DAEMON_PROTOCOL_VERSION {
            return Err(anyhow!(
                "The running Prime Agent daemon does not support {command_type}."
            ));
        }
        self.request_id += 1;
        let id = format!("daemon_{}", self.request_id);
        // The envelope and the command body both carry the request id, like
        // the TS client's `{ ...command, id }` (the daemon matches responses
        // by the envelope id; the body id is wire parity).
        let mut command_value = serde_json::to_value(command)?;
        if !command_value.is_object() {
            return Err(anyhow!("invalid daemon command"));
        }
        command_value["id"] = serde_json::Value::String(id.clone());
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": protocol,
            "clientId": self.protocol_client_id,
            "command": command_value,
        });
        let mut line = serde_json::to_string(&envelope)?;
        line.push('\n');
        self.writer.write_all(line.as_bytes())?;
        self.writer.flush()?;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let line = self.read_line(deadline, timeout_ms, operation)?;
            let value: serde_json::Value = match serde_json::from_str(line.trim()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            match value.get("type").and_then(serde_json::Value::as_str) {
                Some("daemon_hello") => self.hello = Some(value),
                Some("daemon_closing") => {
                    self.daemon_closing_reason = value
                        .get("reason")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string);
                }
                Some("response")
                    if value.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()) =>
                {
                    return serde_json::from_value(value)
                        .map_err(|error| anyhow!("invalid daemon response: {error}"));
                }
                _ => {}
            }
        }
    }

    /// Wait for the greeting, reusing an already-observed hello. Public to
    /// the crate for discovery probes with their own deadline.
    pub(crate) fn wait_for_hello(&mut self, timeout_ms: u64) -> Result<serde_json::Value> {
        if let Some(hello) = &self.hello {
            return Ok(hello.clone());
        }
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let line = self.read_line(deadline, timeout_ms, Operation::Handshake)?;
            let value: serde_json::Value = match serde_json::from_str(line.trim()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if value.get("type").and_then(serde_json::Value::as_str) == Some("daemon_hello") {
                self.hello = Some(value.clone());
                return Ok(value);
            }
        }
    }

    /// One line with a hard deadline. `operation` names the wait in the
    /// timeout error message.
    fn read_line(
        &mut self,
        deadline: Instant,
        timeout_ms: u64,
        operation: Operation<'_>,
    ) -> Result<String> {
        loop {
            self.reader
                .get_mut()
                .set_read_timeout(READ_POLL)
                .map_err(|error| anyhow!("daemon socket error: {error}"))?;
            let mut line = String::new();
            let read = self.reader.read_line(&mut line);
            match read {
                Ok(0) => {
                    let reason = self
                        .daemon_closing_reason
                        .as_deref()
                        .map(|reason| format!(" Reason: {reason}."))
                        .unwrap_or_default();
                    return Err(anyhow!(
                        "Connection to the Prime Agent daemon closed.{reason} {}",
                        endpoint_details(&self.socket_path)
                    ));
                }
                Ok(_) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    return Ok(line);
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut =>
                {
                    if Instant::now() >= deadline {
                        return Err(anyhow!(
                            "Timed out after {timeout_ms}ms {}. {}",
                            operation.wait_description(),
                            endpoint_details(&self.socket_path)
                        ));
                    }
                }
                Err(error) => {
                    return Err(anyhow!("daemon socket error: {error}"));
                }
            }
        }
    }
}

/// The operation a read is waiting on; shapes the timeout error text.
#[derive(Clone, Copy)]
enum Operation<'a> {
    Handshake,
    Command(&'a str),
}

impl Operation<'_> {
    fn wait_description(&self) -> String {
        match self {
            Operation::Handshake => "waiting for the Prime Agent daemon handshake".to_string(),
            Operation::Command(command_type) => {
                format!("waiting for the Prime Agent daemon response to \"{command_type}\"")
            }
        }
    }
}

/// Command type tag on the wire, mirroring `DaemonCommand["type"]`.
fn command_type_name(command: &DaemonCommand) -> &str {
    pa_daemon::protocol::command_type_name(command)
}

/// The protocol identity advertised in the hello.
fn daemon_protocol(hello: &serde_json::Value) -> Result<DaemonProtocolInfo> {
    hello
        .get("protocol")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(|| anyhow!("invalid daemon hello"))
}

/// `Socket: <path>. Daemon log: <log path>.`, mirroring
/// `daemonEndpointDetails` in daemon-client.ts.
fn endpoint_details(socket_path: &Path) -> String {
    let log = pa_daemon::paths::daemon_log_path(socket_path, &config::get_agent_dir());
    format!(
        "Socket: {}. Daemon log: {}.",
        socket_path.display(),
        log.display()
    )
}

/// Node's `connect` error message for the same failure, so the printed error
/// matches the TS product (`connect ENOENT <path>` and friends).
fn node_connect_error(error: &std::io::Error, socket_path: &Path) -> String {
    let path = socket_path.display().to_string();
    match error.kind() {
        std::io::ErrorKind::NotFound => format!("connect ENOENT {path}"),
        std::io::ErrorKind::ConnectionRefused => format!("connect ECONNREFUSED {path}"),
        std::io::ErrorKind::PermissionDenied => format!("connect EACCES {path}"),
        _ => error.to_string(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn list_command(id: &str) -> DaemonCommand {
        DaemonCommand::List {
            id: Some(id.to_string()),
            all: Some(false),
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: serde_json::Map::new(),
        }
    }

    /// A minimal scripted daemon for protocol-level client tests: hello, one
    /// response line, matching the response id from the request envelope.
    #[test]
    fn request_matches_response_by_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            writer.write_all(b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7},\"serverCapabilities\":[]}\n").unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
            let id = request["id"].as_str().unwrap();
            let response = format!(
                "{{\"id\":\"{id}\",\"type\":\"response\",\"command\":\"list\",\"success\":true,\"data\":{{\"sessions\":[]}}}}\n"
            );
            writer.write_all(response.as_bytes()).unwrap();
        });
        let mut client = DaemonClient::connect(&socket).unwrap();
        let response = client.request(list_command("daemon_1")).unwrap();
        assert!(response.success);
        assert!(server.join().is_ok());
    }

    #[test]
    fn connect_error_matches_node_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("missing.sock");
        let error = DaemonClient::connect(&socket).unwrap_err();
        let text = error.to_string();
        assert!(
            text.starts_with("Failed to connect to the Prime Agent daemon: connect ENOENT "),
            "{text}"
        );
        assert!(text.contains("Socket: "), "{text}");
        assert!(text.contains("Daemon log: "), "{text}");
    }

    #[test]
    fn socket_close_reports_daemon_closing_reason() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            writer
                .write_all(b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n")
                .unwrap();
            writer
                .write_all(b"{\"type\":\"daemon_closing\",\"reason\":\"shutdown\"}\n")
                .unwrap();
            writer.flush().unwrap();
            // Drain the client request so the close is a clean EOF, not a reset.
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            drop(writer);
            drop(reader);
        });
        let mut client = DaemonClient::connect(&socket).unwrap();
        let error = client.request(list_command("daemon_1")).unwrap_err();
        let text = error.to_string();
        assert!(
            text.starts_with("Connection to the Prime Agent daemon closed. Reason: shutdown."),
            "{text}"
        );
        assert!(text.contains("Socket: "), "{text}");
        server.join().unwrap();
    }
}

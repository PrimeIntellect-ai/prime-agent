//! Worker -> supervisor self-registration link.
//!
//! Each session worker registers itself with the supervisor on boot and
//! re-registers whenever the supervisor connection returns. A supervisor
//! restart must not lose sessions: workers keep running and serving their
//! own clients, and the supervisor's roster is rebuilt from their
//! re-registrations. The registration connection doubles as the worker's
//! liveness watch on the supervisor socket - when it drops, this loop
//! reconnects with exponential backoff and re-presents the same identity.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::protocol::current_protocol_info;
use crate::worker::WorkerConfig;
use pa_types::platform::transport::{
    connect_transport, AsyncReadHalf, AsyncWriteHalf, TransportStream,
};

/// Backoff between failed registration attempts, mirroring the supervisor's
/// worker-restart backoff: 250ms base, doubling, capped at 30s. Resets after
/// one successful registration.
const BASE_BACKOFF_MS: u64 = 250;
const MAX_BACKOFF_MS: u64 = 30_000;
const CONNECT_TIMEOUT_MS: u64 = 1_000;
const RESPONSE_TIMEOUT_MS: u64 = 10_000;

/// Runtime signals into the registration loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationSignal {
    /// The worker's session was created; re-register so the supervisor's
    /// roster entry carries the persisted session id.
    SessionCreated { session_id: String },
}

/// Handle for the worker runtime to notify the registration loop.
#[derive(Clone)]
pub struct RegistrationHandle {
    session_id: Arc<std::sync::Mutex<Option<String>>>,
    tx: mpsc::UnboundedSender<RegistrationSignal>,
}

impl RegistrationHandle {
    /// Record the persisted session id and trigger a re-registration.
    ///
    /// # Panics
    ///
    /// Panics when the session-id mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn notify_session_created(&self, session_id: String) {
        *self.session_id.lock().unwrap() = Some(session_id.clone());
        let _ = self
            .tx
            .send(RegistrationSignal::SessionCreated { session_id });
    }
}

/// The registration identity a worker presents: its supervisor-issued
/// bootstrap identity (active session id, token) plus where its own socket
/// lives. Stable across supervisor restarts.
#[derive(Debug, Clone)]
struct Identity {
    active_session_id: String,
    socket_path: String,
    worker_instance_id: String,
    token: String,
}

/// Start the registration loop for a worker spawned under a supervisor.
/// Returns `None` when the worker has no supervisor socket (a standalone
/// worker run directly by a test or user); such a worker has nobody to
/// register with.
pub fn start(config: &WorkerConfig) -> Option<RegistrationHandle> {
    if config.supervisor_socket_path.as_os_str().is_empty() {
        return None;
    }
    let identity = Identity {
        active_session_id: config.active_session_id.clone(),
        socket_path: config.socket_path.to_string_lossy().to_string(),
        worker_instance_id: config.worker_instance_id.clone(),
        token: config.token.clone(),
    };
    let session_id = Arc::new(std::sync::Mutex::new(None));
    let (tx, rx) = mpsc::unbounded_channel();
    let task = RegistrationTask {
        supervisor_socket_path: PathBuf::from(&config.supervisor_socket_path),
        identity,
        session_id: Arc::clone(&session_id),
        signals: rx,
    };
    tokio::spawn(async move {
        task.run().await;
    });
    Some(RegistrationHandle { session_id, tx })
}

struct RegistrationTask {
    supervisor_socket_path: PathBuf,
    identity: Identity,
    session_id: Arc<std::sync::Mutex<Option<String>>>,
    signals: mpsc::UnboundedReceiver<RegistrationSignal>,
}

fn current_session_id(session_id: &Arc<std::sync::Mutex<Option<String>>>) -> Option<String> {
    session_id.lock().unwrap().clone()
}

impl RegistrationTask {
    /// Register, hold the connection open as the liveness watch, and repeat
    /// with backoff for as long as the worker lives.
    async fn run(mut self) {
        let mut backoff = BASE_BACKOFF_MS;
        loop {
            let attempt = self.connect_and_register().await;
            match attempt {
                Ok((reader, writer)) => {
                    backoff = BASE_BACKOFF_MS;
                    if let Err(error) = self.hold_connection(reader, writer).await {
                        debug_log(&format!("registration connection lost: {error:#}"));
                    }
                    // Immediately retry: the supervisor may just have closed
                    // for a restart, and the first reconnect is cheap.
                }
                Err(error) => {
                    debug_log(&format!(
                        "registration failed: {error:#}; retrying in {backoff}ms"
                    ));
                }
            }
            tokio::time::sleep(Duration::from_millis(backoff)).await;
            backoff = (backoff * 2).min(MAX_BACKOFF_MS);
        }
    }

    /// Connect to the supervisor, consume its hello, and send one
    /// `worker_register` envelope. Returns the open connection on success.
    async fn connect_and_register(
        &self,
    ) -> Result<(BufReader<Box<dyn AsyncReadHalf>>, Box<dyn AsyncWriteHalf>)> {
        let connect = connect_transport(&self.supervisor_socket_path);
        let stream = tokio::time::timeout(Duration::from_millis(CONNECT_TIMEOUT_MS), connect)
            .await
            .map_err(|_| anyhow!("registration connect timed out"))??;
        let stream: Box<dyn TransportStream> = stream;
        let (read_half, mut write_half) = stream.split();
        let mut reader = BufReader::new(read_half);
        // The supervisor writes daemon_hello before reading any command.
        let hello = read_line(&mut reader).await.context("read daemon hello")?;
        if hello.get("type").and_then(Value::as_str) != Some("daemon_hello") {
            bail!("unexpected first line from supervisor");
        }
        let session_id = current_session_id(&self.session_id);
        self.send_register(&mut reader, &mut write_half, session_id.as_deref())
            .await?;
        Ok((reader, write_half))
    }

    /// Send one registration envelope and await its response.
    async fn send_register(
        &self,
        reader: &mut BufReader<Box<dyn AsyncReadHalf>>,
        writer: &mut Box<dyn AsyncWriteHalf>,
        session_id: Option<&str>,
    ) -> Result<()> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let command = DaemonCommand::WorkerRegister {
            id: Some(request_id.clone()),
            active_session_id: self.identity.active_session_id.clone(),
            session_id: session_id.map(str::to_string),
            socket_path: self.identity.socket_path.clone(),
            worker_instance_id: self.identity.worker_instance_id.clone(),
            token: self.identity.token.clone(),
            pid: std::process::id() as u64,
            rest: Map::default(),
        };
        let envelope = json!({
            "type": "command",
            "id": request_id,
            "protocol": current_protocol_info(),
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope)?;
        line.push('\n');
        writer
            .write_all(line.as_bytes())
            .await
            .context("write registration")?;
        writer.flush().await?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(RESPONSE_TIMEOUT_MS);
        loop {
            let response = tokio::time::timeout_at(deadline, read_line(reader)).await;
            let response = match response {
                Ok(response) => response?,
                Err(_) => bail!("registration response timed out"),
            };
            if response.get("id").and_then(Value::as_str) != Some(request_id.as_str()) {
                // A broadcast line; keep reading for our response.
                continue;
            }
            if response.get("success").and_then(Value::as_bool) != Some(true) {
                bail!(
                    "registration rejected: {}",
                    response
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                );
            }
            return Ok(());
        }
    }

    /// Hold the registration connection open as the liveness watch: the
    /// connection's death is what triggers re-registration. Ends when the
    /// supervisor closes the socket or the runtime signals a session-id
    /// update (re-registered in place on the same connection).
    async fn hold_connection(
        &mut self,
        mut reader: BufReader<Box<dyn AsyncReadHalf>>,
        mut writer: Box<dyn AsyncWriteHalf>,
    ) -> Result<()> {
        loop {
            let mut watch_line = String::new();
            let read = reader.read_line(&mut watch_line);
            tokio::select! {
                read = read => match read {
                    Ok(0) => bail!("supervisor closed the registration connection"),
                    Ok(_) => {
                        // Broadcast lines (daemon_closing, session events);
                        // registration only watches for connection death.
                    }
                    Err(error) => bail!("registration connection error: {error}"),
                },
                signal = self.signals.recv() => match signal {
                    None => {
                        // The worker runtime went away; nothing to watch for.
                        return Ok(());
                    }
                    Some(RegistrationSignal::SessionCreated { session_id }) => {
                        *self.session_id.lock().unwrap() = Some(session_id);
                        let session_id = current_session_id(&self.session_id);
                        self.send_register(&mut reader, &mut writer, session_id.as_deref())
                            .await?;
                    }
                },
            }
        }
    }
}

/// Read one JSONL line from the supervisor connection.
async fn read_line(reader: &mut BufReader<Box<dyn AsyncReadHalf>>) -> Result<Value> {
    let mut line = String::new();
    let read = reader.read_line(&mut line).await?;
    if read == 0 {
        bail!("connection closed by supervisor");
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        bail!("empty line from supervisor");
    }
    serde_json::from_str(trimmed).context("invalid supervisor line")
}

fn debug_log(message: &str) {
    if std::env::var("PA_DAEMON_DEBUG").is_ok() {
        eprintln!("[worker {} registration] {message}", std::process::id());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION};
    use pa_types::platform::transport::{bind_transport, TransportStream};

    fn test_config(dir: &std::path::Path, supervisor_socket: &std::path::Path) -> WorkerConfig {
        WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: supervisor_socket.to_path_buf(),
            token: "bootstrap-token".to_string(),
            worker_instance_id: "instance-1".to_string(),
            active_session_id: "abc123def456".to_string(),
            agent_dir: dir.to_path_buf(),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: None,
        }
    }

    /// Fake supervisor connection: write hello, read the registration
    /// envelope, respond success, and return the parsed command.
    async fn fake_supervisor_handshake(
        stream: Box<dyn TransportStream>,
    ) -> anyhow::Result<(
        Value,
        BufReader<Box<dyn AsyncReadHalf>>,
        Box<dyn AsyncWriteHalf>,
    )> {
        let stream: Box<dyn TransportStream> = stream;
        let (read_half, mut write_half) = stream.split();
        let mut reader = BufReader::new(read_half);
        write_half
            .write_all(
                b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
            )
            .await?;
        write_half.flush().await?;
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let envelope: Value = serde_json::from_str(line.trim())?;
        assert_eq!(
            envelope["protocol"],
            json!({"name": DAEMON_PROTOCOL_NAME, "version": DAEMON_PROTOCOL_VERSION})
        );
        let request_id = envelope["id"].as_str().unwrap_or_default().to_string();
        let response = json!({
            "id": request_id,
            "type": "response",
            "command": "worker_register",
            "success": true,
        });
        write_half
            .write_all(format!("{response}\n").as_bytes())
            .await?;
        write_half.flush().await?;
        Ok((envelope["command"].clone(), reader, write_half))
    }

    #[tokio::test]
    async fn worker_registers_then_re_registers_with_same_identity() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor_socket = dir.path().join("supervisor.sock");
        // No listener yet: the first attempts must fail and retry with
        // backoff until the supervisor appears.
        let config = test_config(dir.path(), &supervisor_socket);
        let handle = start(&config).expect("registration starts");

        // Let at least one failed attempt land (backoff path coverage).
        tokio::time::sleep(Duration::from_millis(300)).await;

        let listener = bind_transport(&supervisor_socket).await.expect("bind");
        // First registration: full identity, no session id yet.
        let stream = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("registration within bounded window")
            .expect("accept");
        let (command, mut reader, mut fake_writer) =
            fake_supervisor_handshake(stream).await.expect("handshake");
        assert_eq!(command["type"], "worker_register");
        assert_eq!(command["activeSessionId"], "abc123def456");
        assert_eq!(
            command["socketPath"],
            dir.path().join("worker.sock").to_string_lossy().to_string()
        );
        assert_eq!(command["workerInstanceId"], "instance-1");
        assert_eq!(command["token"], "bootstrap-token");
        assert!(command["sessionId"].is_null());
        assert!(command["pid"].as_u64().unwrap_or_default() > 0);

        // The session is created while connected: re-register in place with
        // the persisted session id on the same connection.
        handle.notify_session_created("session-uuid-1".to_string());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .expect("re-registration within bounded window")
            .expect("read re-register");
        let envelope: Value = serde_json::from_str(line.trim()).expect("parse re-register");
        assert_eq!(envelope["command"]["sessionId"], "session-uuid-1");
        let request_id = envelope["id"].as_str().unwrap_or_default().to_string();
        let response = json!({
            "id": request_id,
            "type": "response",
            "command": "worker_register",
            "success": true,
        });
        fake_writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .expect("respond");
        fake_writer.flush().await.expect("flush");

        // Supervisor dies: the worker must re-register with the SAME
        // identity (plus the session id) within a bounded window.
        drop(reader);
        drop(fake_writer);
        let stream2 = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .expect("re-registration after supervisor restart")
            .expect("accept");
        let (command2, reader2, writer2) = fake_supervisor_handshake(stream2)
            .await
            .expect("handshake 2");
        assert_eq!(command2["activeSessionId"], "abc123def456");
        assert_eq!(command2["token"], "bootstrap-token");
        assert_eq!(
            command2["socketPath"],
            dir.path().join("worker.sock").to_string_lossy().to_string()
        );
        assert_eq!(command2["workerInstanceId"], "instance-1");
        assert_eq!(command2["sessionId"], "session-uuid-1");
        drop(reader2);
        drop(writer2);
    }
}

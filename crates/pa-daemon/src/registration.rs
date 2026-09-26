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
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::protocol::current_protocol_info;
use crate::worker::WorkerConfig;
use pa_types::platform::transport::{
    connect_transport, AsyncReadHalf, AsyncWriteHalf, TransportStream,
};

/// The supervisor's definitive rejection of a registration (`Supervisor::
/// adopt_registered_worker`'s unknown-worker error, the TS string): the
/// supervisor has no descriptor for this worker, so no daemon will ever
/// adopt or route to the process again. The registration loop treats it as
/// terminal instead of retrying forever — the worker retires (the graceful
/// self-exit `crate::supervisor_lost` documents as the refused-registration
/// self-heal) so it stops holding its session lease against every future
/// resume while staying invisible to the roster.
pub(crate) const UNKNOWN_SESSION_WORKER_PREFIX: &str = "Unknown session worker";

/// Whether a registration failure is the definitive unknown-worker
/// rejection (no supervisor owns this identity) rather than a transient
/// one (a shut-down supervisor, an unreachable socket) the loop must
/// outlive with backoff.
fn is_definitive_rejection(message: &str) -> bool {
    message.contains(UNKNOWN_SESSION_WORKER_PREFIX)
}

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
    /// Set when the supervisor definitively rejected this worker's
    /// identity: the worker runtime watches it to retire (the graceful
    /// self-exit releasing the session lease) instead of serving on with
    /// no daemon able to reach it.
    retired: Arc<tokio::sync::Notify>,
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

    /// Resolve once the supervisor definitively rejected this worker's
    /// identity (the unknown-worker verdict): no supervisor can ever adopt
    /// or route to this process again, so the worker must retire.
    pub async fn retired(&self) {
        self.retired.notified().await;
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
    let retired = Arc::new(tokio::sync::Notify::new());
    let (tx, rx) = mpsc::unbounded_channel();
    let task = RegistrationTask {
        supervisor_socket_path: PathBuf::from(&config.supervisor_socket_path),
        identity,
        session_id: Arc::clone(&session_id),
        retired: Arc::clone(&retired),
        signals: rx,
    };
    tokio::spawn(async move {
        task.run().await;
    });
    Some(RegistrationHandle {
        session_id,
        tx,
        retired,
    })
}

struct RegistrationTask {
    supervisor_socket_path: PathBuf,
    identity: Identity,
    session_id: Arc<std::sync::Mutex<Option<String>>>,
    /// Shared with the handle: set once the supervisor's rejection of this
    /// identity is definitive, so the worker runtime can retire.
    retired: Arc<tokio::sync::Notify>,
    signals: mpsc::UnboundedReceiver<RegistrationSignal>,
}

fn current_session_id(session_id: &Arc<std::sync::Mutex<Option<String>>>) -> Option<String> {
    session_id.lock().unwrap().clone()
}

impl RegistrationTask {
    /// Register, hold the connection open as the liveness watch, and repeat
    /// with backoff for as long as the worker lives. The one terminal exit:
    /// the supervisor's definitive unknown-worker rejection — on the initial
    /// registration or the in-place `SessionCreated` re-registration — its
    /// descriptor for this identity is gone, so no daemon will ever adopt
    /// the process again, and a worker that kept retrying would hold its
    /// session lease forever while staying invisible to every roster (the
    /// refused-registration self-heal retires it instead).
    async fn run(mut self) {
        let mut backoff = BASE_BACKOFF_MS;
        loop {
            let attempt = self.connect_and_register().await;
            match attempt {
                Ok((reader, writer)) => {
                    backoff = BASE_BACKOFF_MS;
                    if let Err(error) = self.hold_connection(reader, writer).await {
                        // The in-place `SessionCreated` re-registration runs
                        // on this connection, so its refusal carries the
                        // same terminal verdict as the initial one: retire
                        // instead of retrying against a supervisor that
                        // holds no descriptor for this identity (a worker
                        // that kept retrying would hold its session lease
                        // forever while staying invisible to every roster).
                        let message = format!("{error:#}");
                        if is_definitive_rejection(&message) {
                            debug_log(&format!(
                                "registration refused for good: {message}; retiring"
                            ));
                            self.retired.notify_one();
                            return;
                        }
                        debug_log(&format!("registration connection lost: {message}"));
                    }
                    // Immediately retry: the supervisor may just have closed
                    // for a restart, and the first reconnect is cheap.
                }
                Err(error) => {
                    let message = format!("{error:#}");
                    if is_definitive_rejection(&message) {
                        debug_log(&format!(
                            "registration refused for good: {message}; retiring"
                        ));
                        self.retired.notify_one();
                        return;
                    }
                    debug_log(&format!(
                        "registration failed: {message}; retrying in {backoff}ms"
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

    /// Only the supervisor's unknown-worker verdict is definitive: the
    /// transient failures (a shutting-down supervisor, an unreachable
    /// socket, a timed-out response) stay retryable, and the loop's own
    /// "registration rejected" wrap still exposes the verdict inside it.
    #[test]
    fn only_the_unknown_worker_verdict_is_definitive() {
        assert!(is_definitive_rejection(
            "registration rejected: Unknown session worker: abc123def456"
        ));
        assert!(is_definitive_rejection("Unknown session worker: w"));
        assert!(!is_definitive_rejection(
            "registration rejected: Supervisor is shutting down"
        ));
        assert!(!is_definitive_rejection(
            "registration rejected: Session worker authentication failed"
        ));
        assert!(!is_definitive_rejection("registration connect timed out"));
        assert!(!is_definitive_rejection("read daemon hello"));
    }

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

    /// A definitive rejection on the HELD connection retires too: the
    /// in-place `SessionCreated` re-registration can carry the unknown-
    /// worker verdict (the supervisor lost this identity between the
    /// initial registration and the session's creation), and the terminal
    /// handling does not depend on which attempt the refusal rides —
    /// retiring there as well keeps the refused worker from retrying
    /// forever against a supervisor that will never adopt it.
    #[tokio::test]
    async fn a_definitive_rejection_on_the_held_connection_retires() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor_socket = dir.path().join("supervisor.sock");
        let config = test_config(dir.path(), &supervisor_socket);
        let handle = start(&config).expect("registration starts");

        let listener = bind_transport(&supervisor_socket).await.expect("bind");
        let stream = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("registration within bounded window")
            .expect("accept");
        let (command, mut reader, mut fake_writer) =
            fake_supervisor_handshake(stream).await.expect("handshake");
        assert_eq!(command["type"], "worker_register");

        // The session is created while connected: the in-place
        // re-registration is refused for good.
        handle.notify_session_created("session-uuid-1".to_string());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .expect("re-registration within bounded window")
            .expect("read re-register");
        let envelope: Value = serde_json::from_str(line.trim()).expect("parse re-register");
        let request_id = envelope["id"].as_str().unwrap_or_default().to_string();
        let response = json!({
            "id": request_id,
            "type": "response",
            "command": "worker_register",
            "success": false,
            "error": "Unknown session worker: abc123def456",
        });
        fake_writer
            .write_all(
                format!(
                    "{response}
"
                )
                .as_bytes(),
            )
            .await
            .expect("refuse");
        fake_writer.flush().await.expect("flush");
        tokio::time::timeout(Duration::from_secs(5), handle.retired())
            .await
            .expect("the definitive rejection on the held connection retires the worker");
        // No further registration attempt: the loop ended.
        tokio::time::sleep(Duration::from_millis(750)).await;
        let late = tokio::time::timeout(Duration::from_millis(750), listener.accept()).await;
        assert!(late.is_err(), "a retired registration never retries");
    }

    /// The definitive rejection retires the worker: a supervisor that
    /// answers `worker_register` with the unknown-worker error ends the
    /// retry loop (the `retired` signal resolves) and no further
    /// registration arrives — a transient rejection (a shutting-down
    /// supervisor) keeps the loop retrying instead.
    #[tokio::test]
    async fn a_definitive_rejection_retires_and_a_transient_one_retries() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor_socket = dir.path().join("supervisor.sock");
        let config = test_config(dir.path(), &supervisor_socket);
        let handle = start(&config).expect("registration starts");
        let listener = bind_transport(&supervisor_socket).await.expect("bind");

        // The supervisor refuses the identity for good: the loop must
        // resolve the retirement signal and stop registering.
        let stream = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("first registration within bounded window")
            .expect("accept");
        let (reader, mut writer) = stream.split();
        let mut reader = BufReader::new(reader);
        writer
            .write_all(
                b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
            )
            .await
            .expect("hello");
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("register");
        let envelope: Value = serde_json::from_str(line.trim()).expect("envelope");
        let request_id = envelope["id"].as_str().unwrap_or_default().to_string();
        let response = json!({
            "id": request_id,
            "type": "response",
            "command": "worker_register",
            "success": false,
            "error": "Unknown session worker: abc123def456",
        });
        writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .expect("refuse");
        tokio::time::timeout(Duration::from_secs(5), handle.retired())
            .await
            .expect("the definitive rejection retires the worker");
        // No further registration attempt: the loop ended.
        tokio::time::sleep(Duration::from_millis(750)).await;
        let late = tokio::time::timeout(Duration::from_millis(750), listener.accept()).await;
        assert!(late.is_err(), "a retired registration never retries");

        // A transient refusal keeps the loop alive: the next attempt
        // arrives within the backoff cadence.
        let config = test_config(dir.path(), &supervisor_socket);
        let handle = start(&config).expect("registration starts");
        let stream = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("transient registration within bounded window")
            .expect("accept");
        let (reader, mut writer) = stream.split();
        let mut reader = BufReader::new(reader);
        writer
            .write_all(
                b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
            )
            .await
            .expect("hello");
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("register");
        let envelope: Value = serde_json::from_str(line.trim()).expect("envelope");
        let request_id = envelope["id"].as_str().unwrap_or_default().to_string();
        let response = json!({
            "id": request_id,
            "type": "response",
            "command": "worker_register",
            "success": false,
            "error": "Supervisor is shutting down",
        });
        writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .expect("refuse");
        let retry = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .expect("a transient refusal retries")
            .expect("accept");
        drop(retry);
        drop(handle);
    }
}

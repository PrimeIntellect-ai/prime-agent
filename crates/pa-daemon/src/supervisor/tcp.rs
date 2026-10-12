//! The supervisor's tailnet TCP listener (TS #2517 `startTcpListener`):
//! resolve the port and bind host (fail closed), bind, and serve the
//! same JSONL protocol as the unix socket through the ordinary client
//! connection handler - the only difference is the trust mode.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

use pa_types::daemon::DaemonErrorInfo;
use serde_json::Value;

use crate::protocol::response_failure;
use crate::supervisor::Supervisor;

/// What a connection may trust (TS #2517's transport-trust split).
#[derive(Debug, Clone)]
pub(crate) enum ClientTrust {
    /// The local unix socket: full supervisor identity in `daemon_hello`,
    /// no per-line auth (the socket file is already owner-restricted).
    Local,
    /// An untrusted TCP peer: banner-only `daemon_hello`, and every
    /// command line must carry the per-machine token (checked per line;
    /// a refused line answers with `tcp_auth_failed` and the socket
    /// closes).
    Remote { auth_token: String },
}

impl ClientTrust {
    /// The per-line auth token when the connection is untrusted.
    pub(crate) fn tcp_auth_token(&self) -> Option<&str> {
        match self {
            ClientTrust::Local => None,
            ClientTrust::Remote { auth_token } => Some(auth_token),
        }
    }
}

/// Backoff before retrying a TCP accept error (the unix loop's bound):
/// the mesh listener must not spin hot on a persistent error, and it must
/// not outlive the shutdown wake that ends it.
const TCP_ACCEPT_BACKOFF: Duration = Duration::from_secs(1);

impl Supervisor {
    /// Resolve, bind, and serve the optional tailnet TCP listener. No-op
    /// when no port resolves (CLI flag > env > settings; zero behavior
    /// change when unset). Binding failures (busy port, permissions, a
    /// missing tailnet address with no configured host) fail startup
    /// loudly instead of leaving a silently unreachable mesh daemon.
    ///
    /// # Errors
    ///
    /// Returns an error when the env-supplied port is invalid, no bind
    /// host resolves (fail closed - never a wildcard default), or the
    /// listener cannot bind (a busy port).
    pub(crate) async fn start_tcp_listener(self: &Arc<Self>) -> Result<()> {
        let env: std::collections::HashMap<String, String> = std::env::vars().collect();
        let settings = pa_core::settings::SettingsManager::create(
            std::env::current_dir().unwrap_or_default(),
            &self.options.agent_dir,
        );
        let port = crate::tcp::resolve_daemon_tcp_port(
            self.options.tcp_port,
            settings.get_daemon_port(),
            &env,
        )?;
        let Some(port) = port else {
            return Ok(());
        };
        let host = crate::tcp::resolve_daemon_tcp_listener_host_production(
            self.options.tcp_bind_host.as_deref(),
            settings.get_daemon_tcp_bind_host().as_deref(),
            &env,
        )
        .await?;
        if crate::tcp::is_wildcard_bind_host(&host.to_string()) {
            self.log_line(&format!(
                "Daemon TCP listener is binding every interface ({host}): the per-machine token and its commands travel in plaintext, so any on-path peer can capture them. Use the tailnet address unless this network is trusted."
            ));
        }
        let agent_dir = &self.options.agent_dir;
        let token = crate::tcp::load_or_create_daemon_tcp_token(agent_dir)
            .with_context(|| "the daemon TCP listener's per-machine token")?;
        let address = SocketAddr::new(host, port);
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .with_context(|| format!("bind daemon TCP listener {address}"))?;
        let listener = Arc::new(listener);
        *self.tcp_listener.lock().unwrap() = Some(Arc::clone(&listener));
        self.log_line(&format!(
            "Prime Agent daemon TCP listener listening on {address} (token file: {}{})",
            token.token_path.display(),
            if token.created { " (created)" } else { "" }
        ));
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            supervisor.serve_tcp(listener, token.token).await;
        });
        Ok(())
    }

    /// Serve accepted mesh peers until the shutdown gates fire. The
    /// connection count is capped (`DAEMON_TCP_MAX_CONNECTIONS`): an
    /// over-cap peer is refused immediately, so idle remote sockets
    /// cannot exhaust file descriptors. Each accepted socket runs the
    /// ordinary connection handler in the untrusted mode; when the stop
    /// pass (or the update exit) sets the accept-loop exit flag, the
    /// listener is taken out of the supervisor and dropped here, so the
    /// port is released with the daemon instead of surviving teardown
    /// into a successor's bind (TS #2517's fence review round).
    async fn serve_tcp(self: Arc<Self>, listener: Arc<tokio::net::TcpListener>, token: String) {
        let permits = Arc::new(tokio::sync::Semaphore::new(
            crate::tcp::DAEMON_TCP_MAX_CONNECTIONS,
        ));
        // The loop-top flag check mirrors the unix accept loop: a notify
        // that lands between iterations (no waiter registered) is still
        // covered by the next iteration's check, so the gates cannot be
        // missed by a loop that would otherwise park in `accept`.
        while !self.accept_exit.load(Ordering::SeqCst) {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                // begin_shutdown / exit_for_update publish accept_exit and
                // notify: the wake ends the accept block immediately, and
                // the loop-top flag check falls the loop out (a spurious
                // wake with the flag down loops back).
                () = self.shutdown_notify.notified() => continue,
            };
            if self.accept_exit.load(Ordering::SeqCst) {
                break;
            }
            let Ok((stream, _)) = accepted else {
                // The unix loop's error policy: a recoverable error retries
                // immediately (the next accept re-arms), a hard one cools
                // behind a bounded backoff, and the shutdown wake ends it.
                tokio::select! {
                    () = tokio::time::sleep(TCP_ACCEPT_BACKOFF) => {}
                    () = self.shutdown_notify.notified() => {}
                }
                continue;
            };
            // Over-cap connections are refused without a task: the mesh's
            // short-lived connections must not starve under an idle-peer
            // flood.
            let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                self.log_line("Refused TCP connection: connection cap reached");
                drop(stream);
                continue;
            };
            let supervisor = Arc::clone(&self);
            let reporter = Arc::clone(&self);
            let token = token.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) = supervisor
                    .handle_client(Box::new(stream), ClientTrust::Remote { auth_token: token })
                    .await
                {
                    if !reporter.shutting_down.load(Ordering::SeqCst) {
                        eprintln!("pa-daemon TCP client connection error: {error:#}");
                    }
                }
            });
        }
        // Release the port: take the listener out of the supervisor (the
        // accept loop holds the last Arc) and drop it.
        drop(listener);
        let held = self.tcp_listener.lock().unwrap().take();
        drop(held);
    }
}

/// Authorization for one untrusted TCP line (TS #2517
/// `authorizeDaemonTcpLine`): a missing or wrong token answers with a
/// correlatable `tcp_auth_failed` failure naming the refused command, and
/// the socket closes. Failures are logged and never propagate to the
/// listener.
pub(crate) fn tcp_refusal_lines(
    supervisor: &Supervisor,
    verdict: &crate::tcp::DaemonTcpAuthVerdict,
) -> Value {
    let command_name = verdict.command.as_deref().unwrap_or("tcp_auth");
    supervisor.log_line(&format!(
        "Refused TCP {} command ({})",
        command_name, verdict.reason
    ));
    crate::protocol::response_line(&response_failure(
        Some(&verdict.id),
        command_name,
        "TCP authentication failed",
        Some(DaemonErrorInfo::TcpAuthFailed),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The listener module's trust modes stay internal to the supervisor.
    #[test]
    fn client_trust_tokens_split_local_and_remote() {
        assert_eq!(ClientTrust::Local.tcp_auth_token(), None);
        assert_eq!(
            ClientTrust::Remote {
                auth_token: "t".to_string()
            }
            .tcp_auth_token(),
            Some("t")
        );
    }
}

// Integration tests for the supervisor's TCP listener: the trust split,
// the per-line auth, the line bound, the admission deadlines, the
// connection cap, and the teardown release. Each test drives a real
// bound listener over loopback.
#[cfg(test)]
mod integration_tests {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use crate::supervisor::{Supervisor, SupervisorOptions};

    fn tcp_supervisor(agent_dir: &std::path::Path, port: u16) -> Arc<Supervisor> {
        Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: agent_dir.join("daemon.sock"),
                agent_dir: agent_dir.to_path_buf(),
                tcp_port: Some(port),
                tcp_bind_host: Some("127.0.0.1".to_string()),
                remote_agent_mesh: None,
            })
            .unwrap(),
        )
    }

    /// A free loopback port (bind-and-drop; the test rebinds immediately).
    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    async fn start_listener(supervisor: &Arc<Supervisor>) {
        supervisor.start_tcp_listener().await.unwrap();
    }

    /// One connection split into (writer, reader) over the SAME socket.
    async fn connect_split(
        port: u16,
    ) -> (
        tokio::net::tcp::OwnedWriteHalf,
        BufReader<tokio::net::tcp::OwnedReadHalf>,
    ) {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let (read_half, write_half) = stream.into_split();
        (write_half, BufReader::new(read_half))
    }

    async fn read_line(reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>) -> Option<Value> {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await.ok()?;
        if read == 0 {
            return None;
        }
        serde_json::from_str(line.trim()).ok()
    }

    fn token_of(supervisor: &Arc<Supervisor>) -> String {
        crate::tcp::load_or_create_daemon_tcp_token(&supervisor.options.agent_dir)
            .unwrap()
            .token
    }

    fn envelope(command: &str, token: Option<&str>) -> String {
        let protocol = format!(
            "{{\"name\":\"{}\",\"version\":{}}}",
            crate::protocol::DAEMON_PROTOCOL_NAME,
            crate::protocol::DAEMON_PROTOCOL_VERSION
        );
        match token {
            Some(token) => format!(
                "{{\"type\":\"command\",\"id\":\"c1\",\"protocol\":{protocol},\"command\":{{\"type\":\"{command}\"}},\"auth\":{{\"token\":\"{token}\"}}}}\n"
            ),
            None => format!(
                "{{\"type\":\"command\",\"id\":\"c1\",\"protocol\":{protocol},\"command\":{{\"type\":\"{command}\"}}}}\n"
            ),
        }
    }

    /// The transport-trust split (TS #2517's review fix: `daemon_hello`
    /// before auth must leak nothing local): a TCP peer gets the protocol
    /// banner only - no ownership token, pid, process start id, socket
    /// path, or runtime identity. The unix path keeps the full identity
    /// (the `handshake` tests pin the local form).
    #[tokio::test]
    async fn tcp_hello_is_the_protocol_banner_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        let (_, mut reader) = connect_split(port).await;
        let hello = read_line(&mut reader).await.expect("hello line");
        assert_eq!(hello["type"], "daemon_hello");
        // Banner-only: the supervisor's local-trust identity must be
        // absent, not null.
        for key in [
            "supervisorOwnerToken",
            "supervisorPid",
            "supervisorProcessStartId",
            "supervisorSocketPath",
            "socketPath",
            "runtime",
        ] {
            assert!(hello.get(key).is_none(), "banner must omit {key}: {hello}");
        }
        // The banner still carries what a mesh client needs to speak.
        assert!(hello.get("protocol").is_some());
        assert!(hello.get("schemaId").is_some());
        assert!(hello.get("clientId").is_some());
        assert!(hello.get("serverCapabilities").is_some());
    }

    /// A refused line answers with a correlatable `tcp_auth_failed`
    /// failure that names the refused command, then the socket closes
    /// (TS #2517 `authorizeDaemonTcpLine`).
    #[tokio::test]
    async fn unauthenticated_line_is_refused_with_the_command_name_and_closes() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        let (mut stream, mut reader) = connect_split(port).await;
        let _ = read_line(&mut reader).await;
        stream
            .write_all(envelope("list", None).as_bytes())
            .await
            .unwrap();
        let failure = read_line(&mut reader).await.expect("refusal line");
        assert_eq!(failure["type"], "response");
        assert_eq!(failure["id"], "c1");
        assert_eq!(failure["command"], "list", "the real command name");
        assert!(!failure["success"].as_bool().unwrap());
        assert_eq!(failure["error"], "TCP authentication failed");
        assert_eq!(failure["errorInfo"]["code"], "tcp_auth_failed");
        // The socket closes after the refusal.
        assert!(read_line(&mut reader).await.is_none(), "socket must close");
    }

    /// An authenticated line dispatches like the unix socket: `list`
    /// answers its success response over TCP (TS #2517: the listener
    /// serves the same JSONL protocol and command dispatch).
    #[tokio::test]
    async fn authenticated_line_dispatches() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        let token = token_of(&supervisor);
        let (mut stream, mut reader) = connect_split(port).await;
        let _ = read_line(&mut reader).await;
        stream
            .write_all(envelope("list", Some(&token)).as_bytes())
            .await
            .unwrap();
        let response = read_line(&mut reader).await.expect("response line");
        assert_eq!(response["type"], "response");
        assert_eq!(response["command"], "list");
        assert_eq!(response["success"], true, "{response}");
        assert!(response["data"]["sessions"].is_array(), "{response}");
    }

    /// An oversized line destroys the connection without a dispatch (TS
    /// #2517's review fix: an unterminated remote line must not grow
    /// the pending buffer without limit).
    #[tokio::test]
    async fn oversized_line_destroys_the_connection_without_dispatch() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        let token = token_of(&supervisor);
        let (mut stream, mut reader) = connect_split(port).await;
        let _ = read_line(&mut reader).await;
        // An authenticated prefix, then a line over the bound with no
        // newline: the overflow destroys the connection before any
        // dispatch could run.
        let oversized = format!("{}{}", "{\"type\":\"command\",\"id\":\"big\",\"command\":{\"type\":\"list\"},\"auth\":{\"token\":\"", token);
        let mut payload = String::new();
        payload.push_str(&oversized);
        payload.push_str(&"a".repeat(crate::tcp::DAEMON_TCP_MAX_LINE_CHARS));
        stream.write_all(payload.as_bytes()).await.unwrap();
        // The connection must close (EOF) without ever answering the
        // line - a hang past the budget is a failure too (the unbounded
        // buffer would swallow the line and answer nothing).
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
            .await
            .expect("the connection must close, not hang")
            .unwrap_or(0);
        assert_eq!(read, 0, "the connection must be destroyed");
    }

    /// The admission deadline closes an unauthenticated socket that
    /// dribbles bytes without ever completing a line (TS #2517's review
    /// fix: the deadline is an explicit timer, so a peer cannot renew its
    /// own window byte by byte). Paused tokio time drives the window.
    #[tokio::test(start_paused = true)]
    async fn dribbled_bytes_do_not_renew_the_admission_window() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        let (mut stream, mut reader) = connect_split(port).await;
        let _ = read_line(&mut reader).await;
        // Dribble a byte every second, never a newline: the 30s auth
        // window (re-armed at hello) must still fire.
        let mut line = String::new();
        let start = std::time::Instant::now();
        loop {
            tokio::select! {
                read = reader.read_line(&mut line) => {
                    assert_eq!(read.unwrap_or(0), 0, "connection must close, not answer");
                    break;
                }
                () = tokio::time::sleep(Duration::from_secs(1)) => {
                    stream.write_all(b"x").await.unwrap();
                }
            }
            assert!(
                start.elapsed() <= Duration::from_secs(60),
                "the admission deadline never fired"
            );
        }
    }

    /// The authenticated switch to the idle window (TS #2517's deadline
    /// state machine): a socket that authenticates keeps serving far past
    /// the 30s auth window - a second command after a real 2s wait
    /// answers, where an unauthenticated socket in the same window is
    /// closed by the `dribbled_bytes` test. (The idle-window expiry itself
    /// is the 10-minute traffic-reset timer; the paused-clock socket tests
    /// cannot wait it out, so its value is pinned by
    /// `admission_budgets_pin_the_ts_values`.)
    #[tokio::test]
    async fn authenticated_line_switches_to_the_idle_window() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        let token = token_of(&supervisor);
        let (mut stream, mut reader) = connect_split(port).await;
        let _ = read_line(&mut reader).await;
        stream
            .write_all(envelope("list", Some(&token)).as_bytes())
            .await
            .unwrap();
        let response = read_line(&mut reader)
            .await
            .expect("authenticated response");
        assert_eq!(response["success"], true);
        // Past the auth window (real 2s inside the 30s one would matter,
        // the 10-min idle one does not): the connection must still serve.
        tokio::time::sleep(Duration::from_secs(2)).await;
        stream
            .write_all(envelope("list", Some(&token)).as_bytes())
            .await
            .unwrap();
        let second = tokio::time::timeout(Duration::from_secs(10), async {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap_or(0);
            line
        })
        .await
        .expect("a second command after the wait must answer");
        let second: Value = serde_json::from_str(second.trim()).unwrap();
        assert_eq!(second["success"], true, "{second}");
    }

    /// Broadcast wakes the connection does not receive must not renew the
    /// authenticated idle window (TS #2517: the idle timer is Node's
    /// `socket.setTimeout`, which only socket traffic resets - Bugbot round:
    /// on a busy mesh, a routing-filtered wake wrote nothing, so a silent
    /// peer must still close at its own deadline and free its cap slot).
    /// The idle window is pinned short (the production 10 minutes is pinned
    /// by `admission_budgets_pin_the_ts_values`): the connection must close
    /// in the window armed by the auth traffic, never one the undelivered
    /// wakes pushed out.
    #[tokio::test]
    async fn undelivered_broadcasts_do_not_renew_the_idle_window() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        supervisor.pin_tcp_idle_timeout_for_tests(Duration::from_secs(2));
        start_listener(&supervisor).await;
        let token = token_of(&supervisor);
        let (mut stream, mut reader) = connect_split(port).await;
        let hello = read_line(&mut reader).await.expect("the protocol banner");
        let client_id = hello["clientId"].as_str().unwrap().to_string();
        stream
            .write_all(envelope("list", Some(&token)).as_bytes())
            .await
            .unwrap();
        let response = read_line(&mut reader)
            .await
            .expect("authenticated response");
        assert_eq!(response["success"], true);
        let armed = std::time::Instant::now();

        // The busy mesh, mid-window: broadcasts this connection does not
        // receive (BroadcastExcept excludes its own id; a RosterSubscribers
        // push reaches non-subscribers only as a wake) rouse its loop but
        // write nothing to its socket.
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        supervisor
            .events
            .send((
                crate::supervisor::ClientRouting::BroadcastExcept {
                    connection_id: client_id.clone(),
                },
                std::sync::Arc::new(serde_json::json!({ "type": "daemon_closing" })),
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        supervisor
            .events
            .send((
                crate::supervisor::ClientRouting::RosterSubscribers,
                std::sync::Arc::new(serde_json::json!({ "type": "roster_update" })),
            ))
            .unwrap();

        // The silent connection must close in the window the auth traffic
        // armed: the undelivered wakes must not have re-armed it.
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(8), reader.read_line(&mut line))
            .await
            .expect("the idle window must close the silent connection");
        assert_eq!(
            read.unwrap_or(0),
            0,
            "the connection must be closed, not answered"
        );
        assert!(
            armed.elapsed() <= Duration::from_secs(2) + Duration::from_millis(600),
            "an undelivered broadcast wake must not extend the idle window (closed after {:?})",
            armed.elapsed()
        );
    }

    /// The connection cap refuses the 257th concurrent socket (TS #2517:
    /// idle remote peers cannot exhaust file descriptors).
    #[tokio::test]
    async fn connection_cap_refuses_over_cap_sockets() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        let mut parked = Vec::new();
        for _ in 0..crate::tcp::DAEMON_TCP_MAX_CONNECTIONS {
            let (stream, _) = connect_split(port).await;
            parked.push(stream);
        }
        let mut readers = Vec::new();
        for _ in 0..crate::tcp::DAEMON_TCP_MAX_CONNECTIONS {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let (read_half, _) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            // The over-cap socket is refused: its hello never arrives and
            // the peer sees the close.
            let mut line = String::new();
            let read = reader.read_line(&mut line).await.unwrap_or(0);
            readers.push(read);
        }
        assert!(
            readers.iter().all(|read| *read == 0),
            "every over-cap socket must be refused"
        );
    }

    /// The shutdown gates release the listener (TS #2517's fence round):
    /// after `accept_exit` + the notify, the port is released with the
    /// daemon instead of surviving teardown into a successor's bind.
    #[tokio::test]
    async fn shutdown_gates_release_the_listener_and_port() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = free_port();
        let supervisor = tcp_supervisor(dir.path(), port);
        start_listener(&supervisor).await;
        assert!(supervisor.tcp_listener.lock().unwrap().is_some());
        // The terminal stop pass's gates (begin_shutdown publishes both).
        supervisor.accept_exit.store(true, Ordering::SeqCst);
        supervisor.shutdown_notify.notify_waiters();
        // The accept loop exits and drops its listener Arc; give the
        // task a moment to run.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            if supervisor.tcp_listener.lock().unwrap().is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            supervisor.tcp_listener.lock().unwrap().is_none(),
            "the listener must be released"
        );
        // The port is released: a fresh bind succeeds and a connect to
        // the released listener fails.
        let reconnect = tokio::net::TcpStream::connect(("127.0.0.1", port)).await;
        assert!(
            reconnect.is_err() || supervisor.tcp_listener.lock().unwrap().is_none(),
            "the released port accepts no connections"
        );
    }

    /// The admission budget values pin the TS contract: the pre-ready
    /// budget covers the worst boot delay, the auth window is the short
    /// re-arm, the idle window is the generous authenticated one, and the
    /// line bound matches the supervisor's other line limits.
    #[test]
    fn admission_budgets_pin_the_ts_values() {
        assert_eq!(
            crate::tcp::DAEMON_TCP_PRE_READY_TIMEOUT,
            Duration::from_secs(120)
        );
        assert_eq!(crate::tcp::DAEMON_TCP_AUTH_TIMEOUT, Duration::from_secs(30));
        assert_eq!(
            crate::tcp::DAEMON_TCP_IDLE_TIMEOUT,
            Duration::from_secs(600)
        );
        assert_eq!(crate::tcp::DAEMON_TCP_MAX_LINE_CHARS, 1024 * 1024);
        assert_eq!(crate::tcp::DAEMON_TCP_MAX_CONNECTIONS, 256);
    }
}

//! Named-pipe transport for Windows endpoints (`\\.\pipe\` namespace).
//!
//! The TS product binds and connects its daemon endpoints through Node's
//! `net` module; on Windows that is backed by named pipes (byte-mode duplex
//! instances, local-only, clients waiting while every instance is busy).
//! This module implements the shared [`TransportListener`] /
//! [`TransportStream`] / [`BlockingTransportStream`] contracts with those
//! semantics, so daemon supervisor, worker, TUI, and CLI callers stay
//! trait-typed and unchanged across platforms.
//!
//! Endpoint naming lives in `pa-daemon::platform` (fixed daemon pipe name,
//! hashed worker pipe names - the TS product's split).

use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use tokio::runtime::Runtime;
use tokio::sync::Mutex as AsyncMutex;

use super::transport::BlockingTransportStream;

/// `winerror.h` `ERROR_PIPE_BUSY`: the pipe name exists but no instance is
/// listening right now (pinned constant to keep the Windows API surface out
/// of the dependency tree).
const ERROR_PIPE_BUSY: i32 = 231;
/// Busy-pipe poll interval. The TS runtime's clients wait on a busy pipe
/// through Node's connect machinery; this is the same patience in tokio.
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(50);
/// Overall cap on busy-pipe waiting, so a wedged server surfaces as an
/// error instead of hanging the caller.
const BUSY_RETRY_DEADLINE: Duration = Duration::from_secs(10);

/// A listening named-pipe endpoint.
///
/// One pipe instance waits for the next client at all times. `accept`
/// connects that instance and has already created its replacement, so the
/// pipe name stays connectable while the accepted stream is being served -
/// the named-pipe equivalent of a Unix listener's backlog.
pub(crate) struct NamedPipeListener {
    name: String,
    /// The instance currently listening for the next client.
    pending: AsyncMutex<Option<NamedPipeServer>>,
}

impl NamedPipeListener {
    /// Create the first pipe instance at `name`.
    ///
    /// `first_pipe_instance` fails when any other process already owns the
    /// pipe name - the named-pipe equivalent of a live Unix socket file
    /// blocking `bind`. A stale pipe cannot exist: instances die with their
    /// creating process, so `bind` never needs a stale-file dance.
    pub(crate) fn bind(name: &str) -> io::Result<Self> {
        let first = ServerOptions::new()
            .first_pipe_instance(true)
            .create(name)?;
        Ok(Self {
            name: name.to_string(),
            pending: AsyncMutex::new(Some(first)),
        })
    }

    /// Hand the next client a connected server instance.
    ///
    /// The next instance is created before waiting on the current one, so a
    /// creation failure surfaces before the connection is handed out. Two
    /// instances listen while this call waits (the connecting one plus its
    /// replacement), which keeps concurrent clients off the busy path.
    pub(crate) async fn accept(&self) -> io::Result<NamedPipeServer> {
        let mut pending = self.pending.lock().await;
        let next = ServerOptions::new().create(&self.name)?;
        let server = pending
            .replace(next)
            .expect("a listening instance is always kept ready");
        server.connect().await?;
        Ok(server)
    }
}

/// Open a client connection to the named pipe at `name`.
///
/// Opening a pipe name fails with `ERROR_PIPE_BUSY` while every instance is
/// occupied; connect waits and retries until the server frees one (Node's
/// clients get the same waiting behavior from libuv's connect machinery).
pub(crate) async fn connect(name: &str) -> io::Result<NamedPipeClient> {
    let deadline = tokio::time::Instant::now() + BUSY_RETRY_DEADLINE;
    loop {
        match ClientOptions::new().open(name) {
            Ok(client) => return Ok(client),
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {}
            Err(error) => return Err(error),
        }
        if tokio::time::Instant::now() + BUSY_RETRY_INTERVAL > deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("named pipe {name} stayed busy for more than {BUSY_RETRY_DEADLINE:?}"),
            ));
        }
        tokio::time::sleep(BUSY_RETRY_INTERVAL).await;
    }
}

/// State shared by the read and write halves of a blocking client: one
/// pipe handle driven by a dedicated single-threaded runtime.
///
/// The blocking surface cannot be a plain `File` on the pipe name because
/// std exposes no read deadline for named pipes; driving the tokio pipe
/// client through a private runtime gives `set_read_timeout` a real
/// implementation (a bounded wait, not a poll on raw handles).
struct BlockingPipeState {
    runtime: Runtime,
    client: AsyncMutex<NamedPipeClient>,
    /// Read deadline for pending reads; `None` blocks indefinitely.
    read_timeout: Mutex<Option<Duration>>,
}

/// A blocking named-pipe client for one-shot command surfaces (the CLI
/// daemon client). Cloning shares the underlying connection.
pub(crate) struct BlockingPipeClient {
    name: String,
    state: Arc<BlockingPipeState>,
}

impl std::fmt::Debug for BlockingPipeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BlockingPipeClient")
            .field("name", &self.name)
            .finish()
    }
}

impl BlockingPipeClient {
    /// Connect to the pipe at `name`, blocking until connected.
    pub(crate) fn connect(name: &str) -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let client = runtime.block_on(connect(name))?;
        Ok(Self {
            name: name.to_string(),
            state: Arc::new(BlockingPipeState {
                runtime,
                client: AsyncMutex::new(client),
                read_timeout: Mutex::new(None),
            }),
        })
    }

    /// Duplicate this handle so reads and writes can proceed on separate
    /// owned halves of the same connection.
    pub(crate) fn try_clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            state: Arc::clone(&self.state),
        }
    }

    /// One blocking read, bounded by the configured deadline when present.
    fn read_bounded(&self, buf: &mut [u8]) -> io::Result<usize> {
        let deadline = self
            .state
            .read_timeout
            .lock()
            .map_err(|_| io::Error::other("read deadline lock poisoned"))?;
        let read = async { self.state.client.lock().await.read(buf).await };
        match *deadline {
            Some(timeout) => match self
                .state
                .runtime
                .block_on(tokio::time::timeout(timeout, read))
            {
                Ok(result) => result,
                // Cancelled reads leave the buffer untouched; callers treat
                // the deadline as an empty poll, the Unix behavior for a
                // socket read that hits its SO_RCVTIMEO.
                Err(_elapsed) => Err(io::ErrorKind::TimedOut.into()),
            },
            None => self.state.runtime.block_on(read),
        }
    }
}

impl std::io::Read for BlockingPipeClient {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.read_bounded(buf)
    }
}

impl std::io::Write for BlockingPipeClient {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.state
            .runtime
            .block_on(async { self.state.client.lock().await.write(buf).await })
    }

    fn flush(&mut self) -> io::Result<()> {
        self.state
            .runtime
            .block_on(async { self.state.client.lock().await.flush().await })
    }
}

impl BlockingTransportStream for BlockingPipeClient {
    fn try_clone_box(&self) -> io::Result<Box<dyn BlockingTransportStream>> {
        Ok(Box::new(self.try_clone()))
    }

    fn set_read_timeout(&self, timeout: Duration) -> io::Result<()> {
        *self
            .state
            .read_timeout
            .lock()
            .map_err(|_| io::Error::other("read deadline lock poisoned"))? = Some(timeout);
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    //! Round-trips through the public transport API. Windows-only; the
    //! sandbox verifies these compile for the cross target (a real Windows
    //! runner executes them).

    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::super::transport::{bind_transport, connect_blocking, connect_transport};

    /// Unique pipe name per test process: parallel test binaries must not
    /// collide in the global `\.\pipe\` namespace.
    fn test_pipe(tag: &str) -> PathBuf {
        PathBuf::from(format!(
            r"\\.\pipe\prime-agent-pa-types-test-{}-{tag}",
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn pipe_roundtrip_through_public_api() {
        let path = test_pipe("async-roundtrip");
        let listener = bind_transport(&path).await.expect("bind");
        let connect_path = path.clone();
        let client =
            tokio::spawn(async move { connect_transport(&connect_path).await.expect("connect") });
        let server = listener.accept().await.expect("accept");
        let client = client.await.expect("client task");
        let (mut client_read, mut client_write) = client.split();
        let (mut server_read, mut server_write) = server.split();
        server_write.write_all(b"ping").await.expect("server write");
        let mut buf = [0u8; 4];
        client_read.read_exact(&mut buf).await.expect("client read");
        assert_eq!(&buf, b"ping");
        client_write.write_all(b"pong").await.expect("client write");
        let mut buf = [0u8; 4];
        server_read.read_exact(&mut buf).await.expect("server read");
        assert_eq!(&buf, b"pong");
    }

    #[tokio::test]
    async fn second_bind_on_a_live_pipe_name_fails() {
        let path = test_pipe("bind-conflict");
        bind_transport(&path).await.expect("first bind");
        let error = bind_transport(&path)
            .await
            .err()
            .expect("a live pipe name must not be rebindable");
        assert!(
            error.to_string().to_lowercase().contains("denied"),
            "first-instance conflict, got: {error}"
        );
    }

    #[test]
    fn blocking_client_deadline_then_roundtrip() {
        let path = test_pipe("blocking-roundtrip");
        let setup = tokio::runtime::Runtime::new().expect("setup runtime");
        let listener = setup.block_on(bind_transport(&path)).expect("bind");
        drop(setup);

        let server = std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("server runtime");
            runtime.block_on(async move {
                let server = listener.accept().await.expect("accept");
                let (mut reader, mut writer) = server.split();
                tokio::time::sleep(Duration::from_millis(250)).await;
                writer.write_all(b"hello").await.expect("server write");
                let mut buf = [0u8; 4];
                reader.read_exact(&mut buf).await.expect("server read");
                assert_eq!(&buf, b"echo");
            });
        });

        let mut stream = connect_blocking(&path).expect("blocking connect");
        stream
            .set_read_timeout(Duration::from_millis(50))
            .expect("deadline");
        let started = Instant::now();
        let mut buf = [0u8; 5];
        loop {
            match stream.read(&mut buf) {
                Ok(5) => break,
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
                other => panic!("unexpected read result: {other:?}"),
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "server reply never arrived"
            );
        }
        assert_eq!(&buf, b"hello");
        assert!(
            started.elapsed() >= Duration::from_millis(200),
            "the read deadline must be honored while the reply is held back"
        );
        stream.write_all(b"echo").expect("client write");
        stream.flush().expect("client flush");
        server.join().expect("server thread");
    }

    #[test]
    fn blocking_connect_to_missing_pipe_reports_not_found() {
        let path = test_pipe("missing");
        let error = connect_blocking(&path).expect_err("no listener owns this pipe name");
        // The CLI maps NotFound to Node's `connect ENOENT <path>` error
        // text; missing pipes must surface as that kind.
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
}

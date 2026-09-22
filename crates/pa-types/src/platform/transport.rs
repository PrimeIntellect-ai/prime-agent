//! Transport contract for daemon sockets and streams.
//!
//! The daemon redesign defines its transport as a trait from day one
//! (MISSION.md, Windows-readiness): AF_UNIX sockets today, named pipes
//! (`\\.\pipe\...`) on Windows later. Callers bind/connect through these
//! traits and never name a concrete socket type, so a future platform swap
//! (tokio named-pipe listener) is an implementation change only.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use anyhow::Result;

/// A full-duplex stream between a client and a daemon endpoint.
///
/// `split` consumes the boxed stream into its owned halves; concrete socket
/// types implement this, and callers hold only the erased halves.
pub trait TransportStream: Send + Sync {
    fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>);
}

/// Owned read half of a [`TransportStream`]; blanket-implemented.
pub trait AsyncReadHalf: tokio::io::AsyncRead + Unpin + Send {}
impl<T> AsyncReadHalf for T where T: tokio::io::AsyncRead + Unpin + Send {}

/// Owned write half of a [`TransportStream`]; blanket-implemented.
pub trait AsyncWriteHalf: tokio::io::AsyncWrite + Unpin + Send {}
impl<T> AsyncWriteHalf for T where T: tokio::io::AsyncWrite + Unpin + Send {}

#[cfg(unix)]
impl TransportStream for tokio::net::UnixStream {
    fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
        let (reader, writer) = tokio::net::UnixStream::into_split(*self);
        (Box::new(reader), Box::new(writer))
    }
}

/// Future returned by [`TransportListener::accept`].
pub type AcceptFuture<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Box<dyn TransportStream>>> + Send + 'a>>;

/// A bound transport endpoint that hands out connected streams.
pub trait TransportListener: Send + Sync {
    /// Future-boxed so the trait stays dyn-compatible (RPITIT methods are not);
    /// the future borrows the listener for the duration of the accept.
    fn accept(&self) -> AcceptFuture<'_>;
}

#[cfg(unix)]
impl TransportListener for tokio::net::UnixListener {
    fn accept(&self) -> AcceptFuture<'_> {
        Box::pin(async move {
            let (stream, _address) = self.accept().await?;
            Ok(Box::new(stream) as Box<dyn TransportStream>)
        })
    }
}

/// AF_UNIX `sun_path` capacity: 108 bytes including the terminating NUL.
#[cfg(unix)]
const MAX_SUN_PATH: usize = 107;

/// A kernel-valid AF_UNIX address for `bind`/`connect`.
///
/// Paths within the limit pass through unchanged. A longer path is re-anchored
/// through an `O_PATH` descriptor on its parent directory
/// (`/proc/self/fd/<fd>/<file name>`): the socket file still lands at the
/// original (deep) location while the address handed to the kernel stays
/// short. The TS runtime's socket layer performs this rewrite transparently
/// (the installed product survives deep `TMPDIR` socket paths), so daemon
/// and worker endpoints on long paths behave identically here. Linux only;
/// other platforms surface the natural path-length error.
#[cfg(unix)]
pub struct UnixSocketAddress {
    address: std::path::PathBuf,
    /// Holds the directory descriptor open for the address lifetime; the
    /// re-anchored `/proc/self/fd` path is valid only while this lives.
    _dir: Option<std::fs::File>,
}

#[cfg(unix)]
impl UnixSocketAddress {
    /// The effective address to hand to `bind`/`connect`.
    fn effective(&self) -> &Path {
        &self.address
    }

    /// Resolve `path` into a kernel-valid AF_UNIX address, or fail with the
    /// original path in the message.
    fn new(path: &Path) -> Result<Self> {
        if path.as_os_str().len() <= MAX_SUN_PATH {
            return Ok(Self {
                address: path.to_path_buf(),
                _dir: None,
            });
        }
        #[cfg(target_os = "linux")]
        {
            let (address, dir) = Self::through_dir_fd(path)?;
            Ok(Self {
                address,
                _dir: Some(dir),
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            anyhow::bail!(
                "AF_UNIX socket path exceeds the {MAX_SUN_PATH}-byte limit: {}",
                path.display()
            )
        }
    }

    /// Re-anchor a too-long path through `/proc/self/fd/<dir fd>/<file name>`.
    #[cfg(target_os = "linux")]
    fn through_dir_fd(path: &Path) -> Result<(std::path::PathBuf, std::fs::File)> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        // `O_PATH` (Linux `asm-generic`): an fd that references the directory
        // without read/write access; only `/proc/self/fd` traversal uses it.
        const O_PATH: i32 = 0o200000;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("socket path has no file name: {}", path.display()))?;
        let parent = path.parent().ok_or_else(|| {
            anyhow::anyhow!("socket path has no parent directory: {}", path.display())
        })?;
        let dir = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(O_PATH)
            .open(parent)
            .with_context(|| format!("open socket directory {}", parent.display()))?;
        let address = std::path::PathBuf::from(format!(
            "/proc/self/fd/{}/{}",
            dir.as_raw_fd(),
            name.to_string_lossy()
        ));
        if address.as_os_str().len() > MAX_SUN_PATH {
            anyhow::bail!(
                "AF_UNIX socket path exceeds the {MAX_SUN_PATH}-byte limit: {}",
                path.display()
            );
        }
        Ok((address, dir))
    }
}

/// Bind a listening endpoint at `path` (a socket file on Unix).
#[cfg(unix)]
pub async fn bind_transport(path: &Path) -> Result<Box<dyn TransportListener>> {
    let address = UnixSocketAddress::new(path)?;
    let listener = tokio::net::UnixListener::bind(address.effective())?;
    Ok(Box::new(listener))
}

/// Connect to the endpoint at `path` asynchronously.
#[cfg(unix)]
pub async fn connect_transport(path: &Path) -> Result<Box<dyn TransportStream>> {
    let address = UnixSocketAddress::new(path)?;
    let stream = tokio::net::UnixStream::connect(address.effective()).await?;
    Ok(Box::new(stream))
}

#[cfg(windows)]
impl TransportListener for super::windows_pipe::NamedPipeListener {
    fn accept(&self) -> AcceptFuture<'_> {
        Box::pin(async move {
            let server = self.accept().await?;
            Ok(Box::new(server) as Box<dyn TransportStream>)
        })
    }
}

#[cfg(windows)]
impl TransportStream for tokio::net::windows::named_pipe::NamedPipeServer {
    fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
        let (reader, writer) = tokio::io::split(*self);
        (Box::new(reader), Box::new(writer))
    }
}

#[cfg(windows)]
impl TransportStream for tokio::net::windows::named_pipe::NamedPipeClient {
    fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
        let (reader, writer) = tokio::io::split(*self);
        (Box::new(reader), Box::new(writer))
    }
}

/// The pipe name handed to `CreateNamedPipe`/`CreateFile`: the `\.\pipe\`
/// names from `pa-daemon::platform` pass through unchanged (they must be
/// UTF-8 for the Windows APIs).
#[cfg(windows)]
fn pipe_name(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .with_context(|| format!("pipe name is not UTF-8: {}", path.display()))
}

/// Bind a listening endpoint at `path` (a named pipe on Windows).
#[cfg(windows)]
pub async fn bind_transport(path: &Path) -> Result<Box<dyn TransportListener>> {
    let name = pipe_name(path)?;
    let listener = super::windows_pipe::NamedPipeListener::bind(&name)?;
    Ok(Box::new(listener))
}

/// Connect to the endpoint at `path` asynchronously.
#[cfg(windows)]
pub async fn connect_transport(path: &Path) -> Result<Box<dyn TransportStream>> {
    let name = pipe_name(path)?;
    let client = super::windows_pipe::connect(&name).await?;
    Ok(Box::new(client))
}

/// A blocking full-duplex stream, for the CLI's one-shot command client.
pub trait BlockingTransportStream:
    std::fmt::Debug + std::io::Read + std::io::Write + Send + Sync
{
    /// Duplicate the underlying handle so reads and writes can proceed on
    /// separate owned halves.
    fn try_clone_box(&self) -> std::io::Result<Box<dyn BlockingTransportStream>>;
    /// Deadline a pending read (poll granularity for deadline-driven waits).
    fn set_read_timeout(&self, timeout: std::time::Duration) -> std::io::Result<()>;
}

#[cfg(unix)]
impl BlockingTransportStream for std::os::unix::net::UnixStream {
    fn try_clone_box(&self) -> std::io::Result<Box<dyn BlockingTransportStream>> {
        Ok(Box::new(self.try_clone()?))
    }

    fn set_read_timeout(&self, timeout: std::time::Duration) -> std::io::Result<()> {
        std::os::unix::net::UnixStream::set_read_timeout(self, Some(timeout))
    }
}

/// Connect to the endpoint at `path`, blocking until connected.
#[cfg(unix)]
pub fn connect_blocking(path: &Path) -> std::io::Result<Box<dyn BlockingTransportStream>> {
    let address = UnixSocketAddress::new(path).map_err(std::io::Error::other)?;
    let stream = std::os::unix::net::UnixStream::connect(address.effective())?;
    Ok(Box::new(stream))
}

/// Connect to the endpoint at `path`, blocking until connected.
#[cfg(windows)]
pub fn connect_blocking(path: &Path) -> std::io::Result<Box<dyn BlockingTransportStream>> {
    let name = pipe_name(path).map_err(std::io::Error::other)?;
    let client = super::windows_pipe::BlockingPipeClient::connect(&name)?;
    Ok(Box::new(client))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::FileTypeExt;

    /// A directory whose full path length is exactly `target` bytes.
    ///
    /// The ambient `TMPDIR` can already be deep (this very harness keeps long
    /// temp paths), so the base falls back to `/tmp` when needed to stay short.
    fn dir_of_exact_len(tag: &str, target: usize) -> std::path::PathBuf {
        let tag = format!("pa-transport-sun-path-{tag}");
        let base = std::env::temp_dir().join(&tag);
        let base = if base.as_os_str().len() + 21 <= target {
            base
        } else {
            std::path::Path::new("/tmp").join(&tag)
        };
        let mut dir = base;
        // Keep at least one byte of room for a file name after the separator.
        while dir.as_os_str().len() + 22 <= target {
            dir = dir.join("d".repeat(20));
        }
        // Pad one final component: appending adds a separator plus the name.
        let pad = target
            .checked_sub(dir.as_os_str().len() + 1)
            .expect("base must leave room for a file name");
        dir = dir.join("d".repeat(pad));
        assert_eq!(dir.as_os_str().len(), target);
        std::fs::create_dir_all(&dir).expect("create deep dir");
        dir
    }

    #[tokio::test]
    async fn over_limit_paths_bind_connect_and_land_in_place() {
        let dir = dir_of_exact_len("roundtrip", 120);
        let socket = dir.join("worker-test.sock");
        let _ = std::fs::remove_file(&socket);
        assert!(socket.as_os_str().len() > MAX_SUN_PATH);

        bind_transport(&socket)
            .await
            .expect("bind through the limit");
        assert!(std::fs::symlink_metadata(&socket)
            .expect("socket file at the original deep path")
            .file_type()
            .is_socket());
        // A second bind on the live socket must fail (address in use), not
        // silently re-anchor somewhere else.
        assert!(bind_transport(&socket).await.is_err());
        std::fs::remove_file(&socket).expect("cleanup for rebind");

        let listener =
            tokio::net::UnixListener::bind(UnixSocketAddress::new(&socket).unwrap().effective())
                .expect("rebind address");
        let connect_path = socket.clone();
        let connect = tokio::spawn(async move {
            connect_transport(&connect_path)
                .await
                .expect("connect through the limit")
        });
        let (server, _) = listener.accept().await.expect("accept");
        let client = connect.await.expect("client task");
        // Round-trip one write to prove the pair is the same socket.
        use tokio::io::AsyncReadExt;
        let (mut reader, _writer) = client.split();
        server.writable().await.expect("server writable");
        server.try_write(b"ping").expect("server write");
        let mut buf = [0u8; 4];
        reader.read_exact(&mut buf).await.expect("client read");
        assert_eq!(&buf, b"ping");
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn paths_at_the_limit_bind_directly() {
        let dir = dir_of_exact_len("boundary", 96);
        let name = "x".repeat(MAX_SUN_PATH - dir.as_os_str().len() - 1);
        let socket = dir.join(name);
        assert_eq!(socket.as_os_str().len(), MAX_SUN_PATH);
        bind_transport(&socket)
            .await
            .expect("bind at exactly the limit");
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn over_limit_paths_without_a_short_name_error_clearly() {
        let dir = dir_of_exact_len("toolong", 120);
        let socket = dir.join("n".repeat(120));
        assert!(socket.as_os_str().len() > MAX_SUN_PATH);
        let error = bind_transport(&socket)
            .await
            .err()
            .expect("no short address exists");
        assert!(error.to_string().contains("exceeds"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

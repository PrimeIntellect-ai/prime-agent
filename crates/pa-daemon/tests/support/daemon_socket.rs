//! The readiness wait shared by the e2e tests that spawn a daemon or a
//! session worker. Test files pull it in with `#[path]`, so the pa-cli
//! tests use this same file.

use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

/// Block until something accepts connections on `socket`. The socket file
/// alone does not mean ready: it appears at `bind`, a moment before
/// `listen`, and a connect in between is refused.
pub fn wait_until_listening(socket: &Path, within: Duration) {
    let deadline = Instant::now() + within;
    while UnixStream::connect(socket).is_err() {
        assert!(
            Instant::now() < deadline,
            "nothing listens on {}",
            socket.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

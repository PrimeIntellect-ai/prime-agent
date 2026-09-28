//! The worker-launch phase trace: env-gated microsecond phase marks on
//! the launch path (fork, probe, connect, auth, create) and the worker
//! boot path. The launch budget surfaces probe exhaustion and the auth
//! timeout as the same "did not come up in time" error, so a wedged
//! launch needs phase evidence to say WHICH budget leg fired. Gated on
//! `PA_DAEMON_LAUNCH_TRACE` so production runs pay one atomic read and
//! nothing else.

use std::sync::OnceLock;
use std::time::SystemTime;

static ENABLED: OnceLock<bool> = OnceLock::new();

/// Whether the launch trace is on for this process.
pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| std::env::var("PA_DAEMON_LAUNCH_TRACE").is_ok())
}

/// One phase mark: `[launch-trace <unix-µs> <pid> worker=<key>] <event>`.
/// The key correlates the supervisor and worker sides of one launch (the
/// worker binds the same socket path the supervisor probes).
pub fn mark(key: &str, event: &str) {
    if enabled() {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_micros())
            .unwrap_or_default();
        eprintln!("[launch-trace {now} {} {key}] {event}", std::process::id());
    }
}

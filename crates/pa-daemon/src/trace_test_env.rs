//! Test-only: the trace uploader resolves credentials from process env
//! (`PRIME_AGENT_TRACES_API_KEY`, then `PRIME_API_KEY`), so daemon tests
//! that install consent-enabled controllers must clear both and serialize
//! with each other while the values stay stable.

use std::sync::MutexGuard;

pub(crate) struct TraceEnv {
    // Held for the guard's lifetime; the lock's value is never read.
    #[allow(dead_code)]
    lock: MutexGuard<'static, ()>,
    saved: [(&'static str, Option<std::ffi::OsString>); 2],
}

pub(crate) fn lock_env() -> TraceEnv {
    let lock = env_lock();
    let saved = [
        (
            "PRIME_AGENT_TRACES_API_KEY",
            std::env::var_os("PRIME_AGENT_TRACES_API_KEY"),
        ),
        ("PRIME_API_KEY", std::env::var_os("PRIME_API_KEY")),
    ];
    std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    std::env::remove_var("PRIME_API_KEY");
    TraceEnv { lock, saved }
}

impl Drop for TraceEnv {
    fn drop(&mut self) {
        for (name, value) in &self.saved {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

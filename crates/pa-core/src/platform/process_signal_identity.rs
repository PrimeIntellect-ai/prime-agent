//! Instance-bound macOS signals using the worker's own kernel audit token.

use std::io;

use serde::{Deserialize, Serialize};

use super::process::Signal;

/// A macOS process instance's kernel audit token, captured by that process.
/// Persist it before publishing the worker descriptor; a token obtained from
/// an unrelated current PID cannot authenticate a legacy worker descriptor.
/// The kernel checks both PID and PID version when delivering a signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "[u32; 8]", into = "[u32; 8]")]
pub struct NativeSignalIdentity([u32; 8]);

impl TryFrom<[u32; 8]> for NativeSignalIdentity {
    type Error = &'static str;

    fn try_from(token: [u32; 8]) -> Result<Self, Self::Error> {
        if token[5] == 0 || token[5] > i32::MAX.unsigned_abs() {
            return Err("native signal identity has an invalid process id");
        }
        Ok(Self(token))
    }
}

impl From<NativeSignalIdentity> for [u32; 8] {
    fn from(identity: NativeSignalIdentity) -> Self {
        identity.0
    }
}

impl NativeSignalIdentity {
    /// The positive process ID carried by this token.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.0[5]
    }

    /// Whether a descriptor's PID agrees with its persisted native identity.
    #[must_use]
    pub fn matches_pid(&self, pid: u32) -> bool {
        self.pid() == pid
    }

    /// Capture this process's own kernel identity; other platforms return `None`.
    ///
    /// # Errors
    /// Returns a failed Mach query or an invalid kernel response on macOS.
    pub fn capture_current() -> io::Result<Option<Self>> {
        #[cfg(target_os = "macos")]
        {
            // mach/task_info.h: TASK_AUDIT_TOKEN=15, eight natural_t words.
            const TASK_AUDIT_TOKEN: libc::task_flavor_t = 15;
            let mut token = [0u32; 8];
            let mut count: libc::mach_msg_type_number_t = 8;
            // SAFETY: task_info writes at most the supplied eight words to
            // this live buffer; the count pointer is also live and writable.
            // libc deprecates Mach bindings in favor of an additional crate;
            // retain its existing binding rather than add a dependency here.
            #[allow(deprecated)]
            let result = unsafe {
                libc::task_info(
                    libc::mach_task_self(),
                    TASK_AUDIT_TOKEN,
                    token.as_mut_ptr().cast::<libc::integer_t>(),
                    &raw mut count,
                )
            };
            if result != 0 {
                // Mach return codes are not POSIX errno values.
                return Err(io::Error::other(format!(
                    "task_info(TASK_AUDIT_TOKEN) failed with Mach status {result}"
                )));
            }
            if count != 8 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "task_info returned an incomplete audit token",
                ));
            }
            let identity = Self::try_from(token)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if !identity.matches_pid(std::process::id()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "task_info audit token does not name this process",
                ));
            }
            Ok(Some(identity))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(None)
        }
    }

    /// Signal only the process instance named by this persisted token.
    /// Missing platform support never falls back to a numeric-PID signal.
    ///
    /// # Errors
    /// Returns `Unsupported` when the native symbol is unavailable, or the
    /// OS error for a refused signal (including a stale process instance).
    pub fn signal(&self, signal: Signal) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        {
            // SDK libproc.h: int proc_signal_with_audittoken(audit_token_t *, int).
            // audit_token_t is a C struct containing uint32_t val[8].
            #[repr(C)]
            struct AuditToken {
                val: [u32; 8],
            }
            type SignalWithToken =
                unsafe extern "C" fn(*mut AuditToken, libc::c_int) -> libc::c_int;
            // SAFETY: the NUL-terminated SDK symbol name is valid; lookup
            // does not execute the function or signal any process.
            let symbol =
                unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"proc_signal_with_audittoken".as_ptr()) };
            if symbol.is_null() {
                return Err(io::ErrorKind::Unsupported.into());
            }
            // SAFETY: libproc's SDK declares the resolved function with
            // exactly this C signature. The pointer is never cached beyond
            // its loaded system library's lifetime.
            let send: SignalWithToken = unsafe { std::mem::transmute(symbol) };
            let signum = match signal {
                Signal::Term => libc::SIGTERM,
                Signal::Kill => libc::SIGKILL,
            };
            let mut token = AuditToken { val: self.0 };
            // SAFETY: the token has the SDK's C layout and lives through
            // the call. The kernel authorizes and resolves PID+version.
            let status = unsafe { send(&raw mut token, signum) };
            if status == 0 {
                Ok(())
            } else {
                // libproc returns the errno value, not -1 with errno set.
                Err(io::Error::from_raw_os_error(status))
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = signal;
            Err(io::ErrorKind::Unsupported.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_native_identity_round_trips_and_binds_pid_and_version() {
        let token = [1, 2, 3, 4, 5, 42, 6, 7];
        let identity = NativeSignalIdentity::try_from(token).unwrap();
        let encoded = serde_json::to_string(&identity).unwrap();
        assert_eq!(
            serde_json::from_str::<NativeSignalIdentity>(&encoded).unwrap(),
            identity
        );
        assert!(identity.matches_pid(42));
        assert!(!identity.matches_pid(43));
        let mut replacement = token;
        replacement[7] += 1;
        assert_ne!(
            NativeSignalIdentity::try_from(replacement).unwrap(),
            identity
        );
        assert_eq!(identity.0[7], token[7]);
    }

    #[test]
    fn deserialization_rejects_invalid_process_ids_and_incomplete_tokens() {
        for pid in [0, u32::MAX] {
            let mut token = [0u32; 8];
            token[5] = pid;
            let encoded = serde_json::to_string(&token).unwrap();
            assert!(serde_json::from_str::<NativeSignalIdentity>(&encoded).is_err());
        }
        assert!(serde_json::from_str::<NativeSignalIdentity>("[1,2,3]").is_err());
    }

    #[cfg(target_os = "macos")]
    mod native {
        use super::*;
        use std::io::{BufRead, Write};
        use std::process::{Child, Command, Stdio};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::{Duration, Instant};

        const FIXTURE_ENV: &str = "PA_NATIVE_SIGNAL_CHILD_FIXTURE";
        const TERM_MARKER_ENV: &str = "PA_NATIVE_SIGNAL_TERM_MARKER";
        const READY_PREFIX: &str = "PA_NATIVE_SIGNAL_READY:";
        static TERM_OBSERVED: AtomicBool = AtomicBool::new(false);

        struct ReapChild(Child, tempfile::TempDir);

        impl Drop for ReapChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        extern "C" fn record_term(_signal: libc::c_int) {
            // AtomicBool is lock-free on macOS; no allocation, IO, or lock
            // can interrupt the fixture's ordinary control flow here.
            TERM_OBSERVED.store(true, Ordering::Relaxed);
        }

        #[test]
        fn native_signal_child_fixture() {
            if std::env::var_os(FIXTURE_ENV).is_none() {
                return;
            }
            let marker = std::env::var_os(TERM_MARKER_ENV).expect("isolated TERM marker");
            // SAFETY: the C handler only stores to a lock-free atomic. This
            // isolated child belongs to the parent test's reaping guard.
            assert_ne!(
                unsafe {
                    libc::signal(
                        libc::SIGTERM,
                        record_term as *const () as libc::sighandler_t,
                    )
                },
                libc::SIG_ERR
            );
            let identity = NativeSignalIdentity::capture_current()
                .expect("capture child token")
                .expect("macOS token");
            println!(
                "{READY_PREFIX}{}",
                serde_json::to_string(&identity).unwrap()
            );
            std::io::stdout().flush().expect("publish readiness");
            loop {
                if TERM_OBSERVED.swap(false, Ordering::Relaxed) {
                    // IO stays outside the signal handler, and stdout is no
                    // longer used after the readiness reader has finished.
                    std::fs::write(&marker, b"TERM").expect("record observed TERM");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn spawn_fixture() -> (ReapChild, NativeSignalIdentity) {
            let directory = tempfile::tempdir().expect("isolated fixture directory");
            let child = Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "platform::process_signal_identity::tests::native::native_signal_child_fixture",
                    "--nocapture",
                    "--quiet",
                ])
                .env(FIXTURE_ENV, "1")
                .env(TERM_MARKER_ENV, directory.path().join("term-delivered"))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .spawn()
                .expect("spawn isolated native-signal fixture");
            let mut guard = ReapChild(child, directory);
            let output = guard.0.stdout.take().expect("child stdout");
            let (sender, receiver) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                for line in std::io::BufReader::new(output).lines() {
                    let line = line.expect("read fixture stdout");
                    if let Some((_, encoded)) = line.split_once(READY_PREFIX) {
                        let _ = sender.send(
                            serde_json::from_str::<NativeSignalIdentity>(encoded)
                                .expect("decode child's own identity"),
                        );
                        return;
                    }
                }
            });
            let identity = receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("fixture must publish observable readiness");
            reader.join().expect("readiness reader");
            assert!(identity.matches_pid(guard.0.id()));
            (guard, identity)
        }

        #[test]
        fn stale_pid_version_never_signals_the_live_child() {
            let (mut child, identity) = spawn_fixture();
            let mut stale = identity;
            stale.0[7] = stale.0[7].wrapping_add(1);
            for signal in [Signal::Term, Signal::Kill] {
                assert_eq!(
                    stale
                        .signal(signal)
                        .expect_err("stale signal must fail")
                        .raw_os_error(),
                    Some(libc::ESRCH),
                    "stale {signal:?} must reject the replaced process instance"
                );
                assert!(child.0.try_wait().expect("probe child").is_none());
            }
        }

        #[test]
        fn bound_signals_deliver_term_then_kill_to_the_fixture() {
            let (mut child, identity) = spawn_fixture();
            identity.signal(Signal::Term).expect("bound TERM");
            let marker = child.1.path().join("term-delivered");
            let deadline = Instant::now() + Duration::from_secs(10);
            while !marker.exists() {
                assert!(child.0.try_wait().expect("TERM-catching child").is_none());
                assert!(Instant::now() < deadline, "fixture must observe bound TERM");
                std::thread::sleep(Duration::from_millis(10));
            }
            identity.signal(Signal::Kill).expect("bound KILL");
            let deadline = Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.0.try_wait().expect("probe fixture exit") {
                    break status;
                }
                assert!(
                    Instant::now() < deadline,
                    "bound KILL must stop the fixture"
                );
                std::thread::sleep(Duration::from_millis(10));
            };
            assert_eq!(
                crate::platform::process::termination_signal(&status),
                Some(9)
            );
        }
    }
}

//! The pty harness: one product child (the real release binary) on a raw pty
//! in its own session with NO controlling tty — vendored crossterm opens
//! `/dev/tty` first in `window_size()` and falls back to the stdio pty
//! slave, the same discipline the repo's pty e2es use.

use std::io::Read;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::poll::{poll, PollFd, PollFlags};
use nix::pty::{openpty, Winsize};

/// The kitty-probe pair: the capability query the product's vendored
/// crossterm emits, and the flags+DA1 answer a kitty terminal gives. The
/// bench answers identically every run so the probe path is deterministic.
pub(crate) const KITTY_QUERY: &[u8] = b"\x1b[?u";
pub(crate) const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";

/// The idle poll slice between empty reads (poll(2) drives the wakeups).
const IDLE_POLL: Duration = Duration::from_millis(25);

/// One product child on a pty, plus the collected master stream and the
/// decoded screen (a vt100 model): byte needles cover literal paints; the
/// screen model covers content that only exists as cell diffs (the agents
/// view's heading counts).
pub(crate) struct PtyChild {
    pub(crate) child: Child,
    master: std::fs::File,
    pub(crate) output: Vec<u8>,
    screen: vt100::Parser,
    /// The kitty probe is answered exactly once (the answer goes to the
    /// child's stdin, so it never shows up in the read stream — a
    /// stream-search for it would re-send forever).
    kitty_answered: bool,
    /// Set only after the exited child's final PTY bytes have drained.
    exited: Option<std::process::ExitStatus>,
}

impl PtyChild {
    /// Spawn `binary` with the pty slave as stdio, its own session, and no
    /// controlling terminal: `setsid` in the pre-exec hook (the child is
    /// never a process-group leader, so it always succeeds).
    ///
    /// # Errors
    ///
    /// Propagates pty and spawn failures.
    pub(crate) fn spawn(
        binary: &std::path::Path,
        args: &[std::ffi::OsString],
        env: &[(String, String)],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<Self> {
        let pty = openpty(
            Some(&Winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )?;
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key, value)))
            .stdin(slave_as_stdio(&pty.slave))
            .stdout(slave_as_stdio(&pty.slave))
            .stderr(slave_as_stdio(&pty.slave));
        pa_core::platform::process::set_new_session(&mut command);
        let fd = pty.master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK))?;
        let child = command.spawn()?;
        drop(pty.slave);
        Ok(Self {
            child,
            master: pty.master.into(),
            output: Vec::new(),
            screen: vt100::Parser::new(rows, cols, 0),
            kitty_answered: false,
            exited: None,
        })
    }

    /// Write to the child's input (the pty master's write end).
    ///
    /// # Errors
    ///
    /// Propagates write failures.
    pub(crate) fn write(&mut self, payload: &[u8]) -> anyhow::Result<()> {
        use std::io::Write;
        self.master.write_all(payload)?;
        Ok(())
    }

    /// The current stream mark (needles wait from here).
    pub(crate) fn mark(&self) -> usize {
        self.output.len()
    }

    pub(crate) fn output_from(&self, mark: usize) -> &[u8] {
        &self.output[mark..]
    }

    /// Drain until `needle` appears in the stream collected since `mark`,
    /// bounded by `deadline`. Returns the Instant the needle was seen.
    ///
    /// # Errors
    ///
    /// Errors when the deadline passes (with the stream tail attached) or
    /// the child exits with a failure code.
    pub(crate) fn wait_from(
        &mut self,
        mark: usize,
        needle: &[u8],
        what: &str,
        deadline: Instant,
    ) -> anyhow::Result<Instant> {
        // Search only the bytes that arrived since the last check (plus the
        // needle overlap, never reaching before the mark): a fresh
        // full-stream scan per read is quadratic, and the harness must
        // never out-CPU the product it measures.
        let mut scanned = mark;
        loop {
            let from = scanned
                .saturating_sub(needle.len().saturating_sub(1))
                .max(mark);
            if find(&self.output[from..], needle).is_some() {
                return Ok(Instant::now());
            }
            scanned = self.output.len();
            if let Some(status) = self.exited {
                anyhow::bail!(
                    "child exited with {status} before {what}; pty tail:\n{}",
                    String::from_utf8_lossy(&self.output[self.output.len().saturating_sub(4000)..])
                );
            }
            if Instant::now() >= deadline {
                let tail =
                    &self.output_from(mark)[self.output_from(mark).len().saturating_sub(4000)..];
                anyhow::bail!(
                    "timeout waiting for {what} (needle {:?}); pty tail since mark:\n{}",
                    String::from_utf8_lossy(needle),
                    String::from_utf8_lossy(tail),
                );
            }
            self.pump(Some(deadline))?;
        }
    }

    /// One poll(2) slice on the master: reads whatever is ready, appends to
    /// the stream, and answers the kitty probe once it appears.
    fn pump(&mut self, deadline: Option<Instant>) -> anyhow::Result<()> {
        let timeout = match deadline {
            Some(end) => {
                let remaining = end.saturating_duration_since(Instant::now());
                remaining.min(IDLE_POLL)
            }
            None => IDLE_POLL,
        };
        let millis = timeout.as_millis().min(u16::MAX as u128) as u16;
        let mut poller = [PollFd::new(self.master.as_fd(), PollFlags::POLLIN)];
        let ready = poll(&mut poller, millis)?;
        // After exit, keep reading any buffered final paints before reporting
        // the status. A poll timeout alone must not hide an already dead UI.
        let status = self.child.try_wait()?;
        if ready == 0 && status.is_none() {
            return Ok(());
        }
        let mut buffer = [0u8; 8192];
        let read = self.master.read(&mut buffer);
        match read {
            Ok(0) => self.exited = status,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == Some(nix::errno::Errno::EIO as i32) =>
            {
                self.exited = status;
            }
            Err(error) => return Err(error.into()),
            Ok(n) => {
                let chunk = &buffer[..n];
                self.receive(chunk)?;
            }
        }
        Ok(())
    }

    /// Include the previous read's overlap when a terminal query is split.
    fn receive(&mut self, chunk: &[u8]) -> anyhow::Result<()> {
        let from = self.output.len().saturating_sub(KITTY_QUERY.len() - 1);
        self.output.extend_from_slice(chunk);
        self.screen.process(chunk);
        if !self.kitty_answered && find(&self.output[from..], KITTY_QUERY).is_some() {
            self.write(KITTY_ANSWER)?;
            self.kitty_answered = true;
        }
        Ok(())
    }

    /// Wait until the decoded screen contains `needle`, bounded by
    /// `deadline`. Content needles the byte stream cannot see (cell-diffed
    /// counters, repainted rows) live here.
    ///
    /// # Errors
    ///
    /// Errors when the deadline passes (with the decoded screen attached).
    pub(crate) fn wait_screen_contains(
        &mut self,
        needle: &str,
        what: &str,
        deadline: Instant,
    ) -> anyhow::Result<Instant> {
        self.wait_screen(what, deadline, |screen| screen.contains(needle))
    }

    /// Wait until `settled` accepts the decoded screen text, bounded by
    /// `deadline`.
    ///
    /// # Errors
    ///
    /// Errors when the child exits first or the deadline passes (with the
    /// decoded screen attached).
    pub(crate) fn wait_screen(
        &mut self,
        what: &str,
        deadline: Instant,
        settled: impl Fn(&str) -> bool,
    ) -> anyhow::Result<Instant> {
        loop {
            if settled(&self.screen_text()) {
                return Ok(Instant::now());
            }
            if let Some(status) = self.exited {
                anyhow::bail!(
                    "child exited with {status} before {what}; pty tail:\n{}",
                    String::from_utf8_lossy(&self.output[self.output.len().saturating_sub(4000)..])
                );
            }
            if Instant::now() >= deadline {
                anyhow::bail!(
                    "timeout waiting for {what}; screen:\n{}",
                    self.screen_text(),
                );
            }
            self.pump(Some(deadline))?;
        }
    }

    /// The decoded screen's text (rows joined; trailing blanks trimmed).
    fn screen_text(&mut self) -> String {
        self.screen.screen().contents().trim_end().to_string()
    }

    /// The child's pid (teardown signals this pid only).
    pub(crate) fn pid(&self) -> i32 {
        self.child.id() as i32
    }

    /// Stop the child: SIGTERM, a short grace, then SIGKILL; reap it.
    pub(crate) fn finish(&mut self) {
        // Drop also cleans up failures before Launch has been constructed.
        // Avoid signalling an already-reaped child if finish ran earlier.
        if self.child.try_wait().is_ok_and(|status| status.is_some()) {
            return;
        }
        let _ = pa_core::platform::process::kill_pid(
            self.pid(),
            pa_core::platform::process::Signal::Term,
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().is_ok_and(|status| status.is_some()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = pa_core::platform::process::kill_pid(
            self.pid(),
            pa_core::platform::process::Signal::Kill,
        );
        let _ = self.child.wait();
    }
}

impl Drop for PtyChild {
    fn drop(&mut self) {
        self.finish();
    }
}

fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kitty_queries_are_answered_at_every_read_boundary_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        for split in 1..KITTY_QUERY.len() {
            let mut child = PtyChild::spawn(
                std::path::Path::new("/bin/cat"),
                &[],
                &[],
                dir.path(),
                120,
                36,
            )
            .expect("spawn mock terminal peer");
            child.receive(&KITTY_QUERY[..split]).expect("first chunk");
            assert!(!child.kitty_answered);
            child.receive(&KITTY_QUERY[split..]).expect("second chunk");
            assert!(child.kitty_answered, "unanswered query split at {split}");
            // A repeated probe must not write another answer, even if the
            // master is now closed: answer write failures propagate.
            let closed = std::fs::File::open("/dev/null").expect("read-only master");
            child.master = closed;
            child.receive(KITTY_QUERY).expect("already answered");
        }
    }

    #[test]
    fn exited_children_fail_missing_needles_without_waiting_for_liveness_timeout() {
        let directory = tempfile::tempdir().expect("mock directory");
        let mut child = PtyChild::spawn(
            std::path::Path::new("/bin/sh"),
            &["-c".into(), "printf 'fatal mock diagnostic'; exit 7".into()],
            &[],
            directory.path(),
            120,
            36,
        )
        .expect("spawn exiting mock");
        let started = Instant::now();
        let error = child
            .wait_from(
                0,
                b"missing",
                "first paint",
                started + Duration::from_secs(10),
            )
            .expect_err("exited child has no paint");
        let message = error.to_string();
        assert!(message.contains("exit status: 7"), "{message}");
        assert!(message.contains("fatal mock diagnostic"), "{message}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(child
            .wait_screen_contains("missing", "ready", started + Duration::from_secs(10))
            .expect_err("screen wait also sees exit")
            .to_string()
            .contains("exit status: 7"));
    }

    #[test]
    fn final_output_is_drained_before_reporting_child_exit() {
        let directory = tempfile::tempdir().expect("mock directory");
        let mut child = PtyChild::spawn(
            std::path::Path::new("/bin/sh"),
            &[
                "-c".into(),
                "printf '%20000s' x; printf 'last paint'; exit 0".into(),
            ],
            &[],
            directory.path(),
            120,
            36,
        )
        .expect("spawn final paint mock");
        child
            .wait_from(
                0,
                b"last paint",
                "final paint",
                Instant::now() + Duration::from_secs(5),
            )
            .expect("final bytes survive child exit");
        assert!(child.output.len() > 8192, "exercise more than one PTY read");
        child
            .wait_screen_contains(
                "last paint",
                "final screen",
                Instant::now() + Duration::from_secs(5),
            )
            .expect("final screen survives child exit");
    }

    #[test]
    fn an_initial_paint_timeout_reaps_the_owned_child() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut child = PtyChild::spawn(
            std::path::Path::new("/bin/cat"),
            &[],
            &[],
            dir.path(),
            120,
            36,
        )
        .expect("spawn the mock, never the product");
        let pid = nix::unistd::Pid::from_raw(child.pid());
        assert!(child
            .wait_from(0, b"missing first paint", "first paint", Instant::now())
            .is_err());
        drop(child);
        assert_eq!(
            nix::sys::signal::kill(pid, None),
            Err(nix::errno::Errno::ESRCH)
        );
    }
}

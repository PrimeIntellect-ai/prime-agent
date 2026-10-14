//! The pty harness: one product child (the real release binary) on a raw pty
//! in its own session with NO controlling tty — vendored crossterm opens
//! `/dev/tty` first in `window_size()` and falls back to the stdio pty
//! slave, the same discipline the repo's pty e2es use.

use std::io::Read;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
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
        // SAFETY: the pre-exec hook runs post-fork, pre-exec, in the child
        // only; it cannot disturb this process.
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setsid()?;
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop(pty.slave);
        let fd = pty.master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK))?;
        Ok(Self {
            child,
            master: pty.master.into(),
            output: Vec::new(),
            screen: vt100::Parser::new(rows, cols, 0),
            kitty_answered: false,
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
        // needle overlap): a fresh full-stream scan per read is quadratic,
        // and the harness must never out-CPU the product it measures.
        let mut scanned = mark;
        loop {
            let from = scanned.saturating_sub(needle.len().saturating_sub(1));
            if find(&self.output[from..], needle).is_some() {
                return Ok(Instant::now());
            }
            scanned = self.output.len();
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
        if ready == 0 {
            return Ok(());
        }
        let mut buffer = [0u8; 8192];
        let read = self.master.read(&mut buffer);
        match read {
            Ok(0) | Err(_) => {}
            Ok(n) => {
                let chunk = &buffer[..n];
                self.output.extend_from_slice(chunk);
                self.screen.process(chunk);
                if !self.kitty_answered && find(chunk, KITTY_QUERY).is_some() {
                    self.write(KITTY_ANSWER)?;
                    self.kitty_answered = true;
                }
            }
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
        loop {
            if self.screen_text().contains(needle) {
                return Ok(Instant::now());
            }
            if Instant::now() >= deadline {
                anyhow::bail!(
                    "timeout waiting for {what} (screen needle {needle:?}); screen:\n{}",
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
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(self.pid()),
            nix::sys::signal::Signal::SIGTERM,
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().is_ok_and(|status| status.is_some()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
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

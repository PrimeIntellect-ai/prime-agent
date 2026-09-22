//! Process-group suspend/resume (TS `handleCtrlZ` and its `SIGCONT`
//! resume handler).
//!
//! The `app.suspend` action (default ctrl+z) hands the terminal to the
//! shell: SIGINT is ignored for the suspended window, the TUI stops (SGR
//! mouse tracking off, alternate screen left and flushed into native
//! scrollback, raw mode off), and the whole process group is stopped with
//! SIGTSTP. Execution continues where the signal stopped it once the user
//! foregrounds the process again (SIGCONT), and the resume re-applies
//! every terminal mode a suspend cycle can lose: raw mode, the alternate
//! screen, and SGR mouse tracking (TS `ui.start()` + `applyFullscreen(true)`
//! inside the one-shot `SIGCONT` handler).
//!
//! The signal and terminal operations sit behind two small traits so the
//! cycle's sequencing — the part that is easy to get wrong — is verified
//! by unit tests without stopping the test process.

use anyhow::Result;

/// Whether this platform can suspend to the background at all. TS gates
/// `handleCtrlZ` on win32 and shows a status message instead.
pub(crate) fn supported() -> bool {
    cfg!(unix)
}

/// The signal operations of one suspend cycle.
pub(crate) trait SuspendSignals {
    /// Ignore SIGINT for the suspended window: a Ctrl+C at the shell
    /// prompt must not kill the backgrounded process (TS installs a
    /// no-op `SIGINT` listener for the window).
    fn ignore_sigint(&mut self) -> Result<()>;
    /// Restore default SIGINT handling on resume, before the terminal is
    /// taken back (TS removes the listener first inside the `SIGCONT`
    /// handler).
    fn restore_sigint(&mut self) -> Result<()>;
    /// Stop the process group (TS `process.kill(0, "SIGTSTP")`). With the
    /// default SIGTSTP disposition the whole process stops; execution
    /// continues after SIGCONT.
    fn stop_process_group(&mut self) -> Result<()>;
}

/// The terminal handoff of one suspend cycle: `stop` hands the terminal
/// to the shell, `resume` takes it back after SIGCONT and re-applies the
/// terminal modes (raw mode, alternate screen, SGR mouse tracking).
pub(crate) trait SuspendTerminal {
    fn stop(&mut self) -> Result<()>;
    fn resume(&mut self) -> Result<()>;
}

/// Drive one suspend cycle (TS `handleCtrlZ`). The sequence: SIGINT is
/// ignored, the terminal is handed over, and the process group stops.
/// SIGCONT resumes execution inside this function, where SIGINT is
/// restored and the terminal is taken back with every mode re-applied.
/// A failure at any point restores SIGINT (TS's cleanup catch) and
/// propagates without resuming.
pub(crate) fn suspend_cycle<S, T>(signals: &mut S, terminal: &mut T) -> Result<()>
where
    S: SuspendSignals,
    T: SuspendTerminal,
{
    signals.ignore_sigint()?;
    let outcome = terminal.stop().and_then(|()| signals.stop_process_group());
    // The SIGTSTP stops the process between the stop and this line, so
    // the restore and the resume below are the SIGCONT continuation.
    let _ = signals.restore_sigint();
    outcome?;
    terminal.resume()
}

/// The production signals: a real SIGINT disposition swap and a
/// process-group-wide SIGTSTP, through the pa-types platform wall (the
/// shared platform contracts; pa-tui opts into the workspace
/// `unsafe_code` forbid).
pub(crate) struct ProcessSignals;

impl SuspendSignals for ProcessSignals {
    fn ignore_sigint(&mut self) -> Result<()> {
        pa_types::platform::process::ignore_sigint_for_suspend()
    }

    fn restore_sigint(&mut self) -> Result<()> {
        pa_types::platform::process::restore_default_sigint()
    }

    fn stop_process_group(&mut self) -> Result<()> {
        pa_types::platform::process::stop_own_process_group()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::MutexGuard;

    /// The mouse-tracking seam is process-global state, so the tests that
    /// drive it serialize through the seam's own lock (shared with the
    /// `mouse_tracking` tests).
    fn seam_lock() -> MutexGuard<'static, ()> {
        match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// One cycle's time-ordered operation log, shared by the signals and
    /// terminal sides so the full sequence is assertable; optionally fails
    /// at the named point so the cleanup path is observable. The signals
    /// side can probe the mouse seam at the SIGTSTP point (the
    /// "terminal lost" midpoint, between stop and resume).
    #[derive(Default)]
    struct Recording {
        calls: Vec<&'static str>,
        fail_at: Option<&'static str>,
        probe_at_stop: Option<bool>,
    }

    type Shared = Rc<RefCell<Recording>>;

    struct Cycle {
        log: Shared,
    }

    impl Cycle {
        fn shared() -> Shared {
            Rc::new(RefCell::new(Recording::default()))
        }

        fn from(log: &Shared) -> Cycle {
            Cycle {
                log: Rc::clone(log),
            }
        }

        fn record(&mut self, name: &'static str) -> Result<()> {
            let mut log = self.log.borrow_mut();
            log.calls.push(name);
            if log.fail_at == Some(name) {
                bail!("{name} failed");
            }
            Ok(())
        }
    }

    impl SuspendSignals for Cycle {
        fn ignore_sigint(&mut self) -> Result<()> {
            self.record("ignore_sigint")
        }

        fn restore_sigint(&mut self) -> Result<()> {
            self.record("restore_sigint")
        }

        fn stop_process_group(&mut self) -> Result<()> {
            // The real cycle stops here until SIGCONT; the recording
            // captures what the terminal looks like at that point.
            let mut log = self.log.borrow_mut();
            log.probe_at_stop = Some(crate::mouse_tracking::active());
            log.calls.push("stop_process_group");
            if log.fail_at == Some("stop_process_group") {
                bail!("stop_process_group failed");
            }
            Ok(())
        }
    }

    impl SuspendTerminal for Cycle {
        fn stop(&mut self) -> Result<()> {
            self.record("terminal_stop")
        }

        fn resume(&mut self) -> Result<()> {
            self.record("terminal_resume")
        }
    }

    /// The happy-path sequence: SIGINT is ignored before the terminal
    /// handoff, the process group stops after it, SIGINT is restored
    /// before the resume takes the terminal back — the SIGCONT
    /// continuation order (TS removeListener -> ui.start ->
    /// applyFullscreen).
    #[test]
    fn cycle_ignores_sigint_stops_then_resumes() {
        let log = Cycle::shared();
        let mut signals = Cycle::from(&log);
        let mut terminal = Cycle::from(&log);
        suspend_cycle(&mut signals, &mut terminal).expect("cycle");
        assert_eq!(
            log.borrow().calls,
            vec![
                "ignore_sigint",
                "terminal_stop",
                "stop_process_group",
                "restore_sigint",
                "terminal_resume",
            ]
        );
    }

    /// A failed terminal handoff restores SIGINT (TS's cleanup catch) and
    /// never stops the process group or resumes.
    #[test]
    fn a_failed_handoff_restores_sigint_without_stopping() {
        let log = Cycle::shared();
        log.borrow_mut().fail_at = Some("terminal_stop");
        let mut signals = Cycle::from(&log);
        let mut terminal = Cycle::from(&log);
        let error = suspend_cycle(&mut signals, &mut terminal).expect_err("failed stop");
        assert_eq!(
            log.borrow().calls,
            vec!["ignore_sigint", "terminal_stop", "restore_sigint"],
            "SIGINT was restored on the failure path"
        );
        assert!(
            !error.to_string().contains("resume"),
            "the failure is the stop's, not a later resume's: {error}"
        );
    }

    /// A failed SIGTSTP (the suspend could not stop the process group)
    /// still restores SIGINT and does not resume a stopped TUI.
    #[test]
    fn a_failed_stop_signal_restores_sigint_without_resuming() {
        let log = Cycle::shared();
        log.borrow_mut().fail_at = Some("stop_process_group");
        let mut signals = Cycle::from(&log);
        let mut terminal = Cycle::from(&log);
        suspend_cycle(&mut signals, &mut terminal).expect_err("failed SIGTSTP");
        assert_eq!(
            log.borrow().calls,
            vec![
                "ignore_sigint",
                "terminal_stop",
                "stop_process_group",
                "restore_sigint",
            ]
        );
    }

    /// The suspend -> resume cycle re-applies SGR mouse tracking through
    /// the real seam: the handoff releases it, the stopped window observes
    /// it off, and the resume re-enables it (TS `applyFullscreen(true)` on
    /// SIGCONT re-enters fullscreen and re-applies tracking). A real
    /// SIGTSTP/SIGCONT pair cannot run inside `cargo test` (it would stop
    /// the test process itself), so the cycle runs with the signal point
    /// recorded and the seam real.
    #[test]
    fn a_suspend_cycle_releases_and_re_applies_mouse_tracking() {
        let _guard = seam_lock();
        let mut out = std::io::stdout();
        let was_active = crate::mouse_tracking::active();
        if !was_active {
            crate::mouse_tracking::enable(&mut out).expect("enable");
        }

        struct SeamTerminal {
            out: std::io::Stdout,
        }

        impl SuspendTerminal for SeamTerminal {
            fn stop(&mut self) -> Result<()> {
                crate::mouse_tracking::disable(&mut self.out)
            }

            fn resume(&mut self) -> Result<()> {
                crate::mouse_tracking::enable(&mut self.out)
            }
        }

        let log = Cycle::shared();
        let mut signals = Cycle::from(&log);
        let mut terminal = SeamTerminal {
            out: std::io::stdout(),
        };
        suspend_cycle(&mut signals, &mut terminal).expect("cycle");
        assert_eq!(
            log.borrow().probe_at_stop,
            Some(false),
            "tracking was released while the process group stopped"
        );
        assert!(
            crate::mouse_tracking::active(),
            "the resume re-applied mouse tracking"
        );

        // Restore the entry state so other tests observe a clean seam.
        if !was_active {
            crate::mouse_tracking::disable(&mut out).expect("disable");
        }
    }
}

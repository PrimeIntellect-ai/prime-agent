//! The one process-exit terminal restore: every route that ends the TUI
//! surface funnels through here. The contract is the whole-terminal
//! invariant set, in one place:
//!
//! 1. the kitty probe stands down first;
//! 2. in-flight key releases drain before the modes come off;
//! 3. mouse tracking, bracketed paste, and the keyboard modes release;
//! 4. synchronized output and SGR reset — a crash between a frame's
//!    sync brackets or inside a styled write must not hand the shell a
//!    terminal holding pending updates or a dangling color;
//! 5. the alternate screen is left (`?1049l`), the cursor shows;
//! 6. the kitty stack drains its stale levels AFTER the alt-screen
//!    leave ([`crate::enhanced_keys::pop_stale_levels`]) — a
//!    mode-counting relay (herdr's pane emulator) discards the
//!    keyboard-protocol writes made while the pane's alt screen is up,
//!    so the pair's pop needs a post-leave drain to land on the relay
//!    (the bare pops are clamped no-ops at spec depth zero);
//! 7. raw mode ends, and the tty is *verified* cooked — crossterm's
//!    `disable_raw_mode` restores its first-saved "original" and
//!    swallows errors, so a poisoned start (a killed previous run left
//!    the tty raw and crossterm adopted that state as the baseline)
//!    would silently restore raw ([`pa_types::platform::terminal`]'s
//!    `stty sane` reconstruction repairs it);
//! 8. a pending Ctrl+S output stop lifts FIRST — the stop is runtime
//!    state, not termios, and it HOLDS writes: the lift (the IXON-toggle,
//!    [`pa_types::platform::terminal::restart_output`]) must precede the
//!    restore's own output writes or the restore itself would hang on a
//!    stopped tty, and the shell would keep the frozen prompt the
//!    restore owed it.
//!
//! The parity exit keeps the TS byte order and ends through
//! [`terminal_release_tail`]; the best-effort exits run the whole sequence
//! without the flush. Divergences from TS (sync-output release, SGR reset,
//! cooked-tty verification) are hardening, documented per sequence.

use std::io::{IsTerminal, Stdout, Write};

/// Synchronized-output release (mode 2026 off): the frame paint brackets
/// its row diff in begin/end pairs, so an exit landing between them must
/// release the pending-update hold.
const SYNC_OUTPUT_OFF: &[u8] = b"\x1b[?2026l";
/// The SGR reset: a styled write cut short by a crash would otherwise
/// color everything the shell prints after the exit.
const SGR_RESET: &[u8] = b"\x1b[0m";

/// Test observation for the restore attempts (the unwind guard and the
/// error-path wiring assert it; headless pipes gate the writes off).
#[cfg(test)]
pub(crate) static RESTORE_ATTEMPTS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Serializes the tests that read [`RESTORE_ATTEMPTS`]: the counter is
/// process-global and the test threads run in parallel.
#[cfg(test)]
pub(crate) static TEST_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The one best-effort exit restore: the full sequence above, with no
/// inline flush. Idempotent — every mode release is gated on its own
/// process-global flag. A no-op off a terminal.
pub(crate) fn restore_terminal() {
    #[cfg(test)]
    RESTORE_ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // The output-stop lift runs FIRST: a tty still holding a Ctrl+S stop
    // holds every WRITE below, so the restore itself would hang before
    // reaching the lift. The lift is termios writes only — it flows.
    pa_types::platform::terminal::restart_output();
    let mut out = std::io::stdout();
    crate::enhanced_keys::release_for_exit();
    // The exit drain below reads the tty through crossterm's global
    // event-reader lock: a parked surface reader would hold it indefinitely
    // and starve the drain. A no-op when no reader is alive.
    crate::input::request_reader_stop();
    if out.is_terminal() {
        crate::enhanced_keys::drain_for_exit(&mut out);
        let _ = crate::mouse_tracking::disable(&mut out);
        let _ = crate::enhanced_keys::disable(&mut out);
        // The unconditional leave: the restore must not trust the ownership flag
        // — a desynced flag would keep the alt buffer up past the process death.
        crate::altscreen::force_leave(&mut out);
        // The stale-level drain: bare kitty pops AFTER the alt-screen
        // leave, where a mode-counting relay keeps them — the drain's
        // own pop above, written inside the alt screen, does not (see
        // enhanced_keys::pop_stale_levels).
        crate::enhanced_keys::pop_stale_levels(&mut out);
        let _ = out.write_all(SYNC_OUTPUT_OFF);
        let _ = out.write_all(SGR_RESET);
        let _ = crossterm::execute!(out, crossterm::cursor::Show);
    }
    // The raw-mode release and the cooked verification run regardless of a
    // redirected stdout: raw mode lives on the controlling tty, not stdout.
    let _ = crossterm::terminal::disable_raw_mode();
    let _ = report_cooked_repair();
    let _ = out.flush();
    // The console codepages hand back LAST, after the restore's own ANSI
    // writes: this funnel is the one every ABNORMAL exit rides (the unwind
    // guard's drop, the error paths, the process::exit sites), and a
    // crashed TUI must not leave the shell at 65001 + VT (a no-op when
    // nothing was prepared; the normal interactive exit uses the release
    // tail and the CLI's own exit funnel restores instead).
    pa_types::platform::console_restore();
}

/// The shared exit tail: synchronized output off, SGR reset, cursor
/// show, raw mode off, then the cooked-tty verification and repair.
///
/// Each completed write reports exit-path progress: on a slow terminal
/// these writes block behind the flush draining the pty, and the exit
/// guard's watchdog must read that as movement, not a stalled shutdown.
pub(crate) fn terminal_release_tail(out: &mut Stdout) {
    pa_types::platform::terminal::restart_output();
    // The stale-level drain: bare kitty pops AFTER the alt-screen leave
    // (this tail runs past `flush_to_main_screen`'s `?1049l`), where a
    // mode-counting relay keeps them — the teardown's own pop, written
    // inside the alt screen, never lands on the relay's stack (see
    // enhanced_keys::pop_stale_levels).
    crate::enhanced_keys::pop_stale_levels(out);
    let _ = out.write_all(SYNC_OUTPUT_OFF);
    let _ = out.write_all(SGR_RESET);
    let _ = crossterm::execute!(out, crossterm::cursor::Show);
    crate::exit_guard::note_exit_progress();
    let _ = crossterm::terminal::disable_raw_mode();
    let _ = report_cooked_repair();
    let _ = out.flush();
    crate::exit_guard::note_exit_progress();
}

/// The repair notice goes through a fallible write: `eprintln!` panics
/// when stderr is gone, and a panic inside the unwind guard's restore
/// would abort the process mid-restore.
fn report_cooked_repair() -> std::io::Result<()> {
    if pa_types::platform::terminal::ensure_cooked_tty()
        == pa_types::platform::terminal::TtyCooked::Repaired
    {
        use std::io::Write;
        writeln!(
            std::io::stderr(),
            "Prime Agent: repaired a raw terminal left by a previous run."
        )
    } else {
        Ok(())
    }
}

/// Fire the exit restore when a TUI surface unwinds: a panic between the
/// surface mount and its deliberate teardown must still hand the terminal
/// back whole when the process dies on the unwind.
///
/// A `std::panic::set_hook` cannot carry this contract: tokio catches
/// task-level panics (the process lives on), and the codebase's
/// `catch_unwind` sites re-raise rather than swallow, so the unwind
/// crosses this drop exactly when the surface frame is actually dying.
pub(crate) struct SurfaceRestore;

impl SurfaceRestore {
    /// Arm the guard for one surface: place it next to the surface's
    /// mount; it acts only while a panic unwinds through its scope.
    pub(crate) fn armed() -> Self {
        SurfaceRestore
    }
}

impl Drop for SurfaceRestore {
    fn drop(&mut self) {
        // `std::thread::panicking()` is true exactly while the unwind is
        // crossing this drop: a normal return stays silent, and a panic tokio
        // caught never crosses the surface frame.
        if std::thread::panicking() {
            restore_terminal();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempts() -> usize {
        RESTORE_ATTEMPTS.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn the_unwind_guard_fires_only_while_unwinding() {
        let _state = TEST_STATE_LOCK.lock();
        let before = attempts();
        {
            // A normal scope — no unwind — must stay silent: a live
            // surface restoring on its own would corrupt the running UI.
            let _guard = SurfaceRestore::armed();
        }
        assert_eq!(attempts(), before, "a normal drop never restores");
        let result = std::panic::catch_unwind(|| {
            let _guard = SurfaceRestore::armed();
            panic!("surface panic");
        });
        assert!(result.is_err(), "the probe panic must unwind");
        assert_eq!(
            attempts(),
            before + 1,
            "the unwind guard fired the one exit restore"
        );
    }
}

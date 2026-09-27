//! The one process-exit terminal restore.
//!
//! Every route that ends the TUI surface funnels through this module: the
//! deliberate teardown tails (`Renderer::finish`'s parity exit in
//! `interactive.rs`/`agents_view.rs`), the config selector and the replay
//! surface exits, the force-quit watchdog, the fatal error return, and a
//! panic unwind. The contract is the whole-terminal invariant set, in one
//! place:
//!
//! 1. the kitty probe stands down first ([`crate::enhanced_keys::release_for_exit`])
//!    — an answer landing after the pop would re-arm CSI-u reporting on
//!    the parent shell (the "escape codes while typing" leak);
//! 2. in-flight key releases drain before the modes come off (TS
//!    `drainInput` before `stop`);
//! 3. mouse tracking, bracketed paste, and the keyboard modes release;
//! 4. synchronized output and SGR reset — a crash between a frame's
//!    sync brackets or inside a styled write must not hand the shell a
//!    terminal holding pending updates or a dangling color;
//! 5. the alternate screen is left (`?1049l`), the cursor shows;
//! 6. raw mode ends, and the tty is *verified* cooked — crossterm's
//!    `disable_raw_mode` restores its first-saved "original" and
//!    swallows errors, so a poisoned start (a killed previous run left
//!    the tty raw and crossterm adopted that state as the baseline)
//!    would silently restore raw ([`pa_types::platform::terminal`]'s
//!    `stty sane` reconstruction repairs it).
//!
//! The parity exit (the normal quit) keeps the TS byte order for its
//! visible exit frame — the inline transcript flush after the
//! alt-screen leave (`TUI.stop` -> `exitFullscreen`) — and ends through
//! the same tail here ([`terminal_release_tail`]); the best-effort exits
//! (force quit, panic, error) run the whole sequence without the flush.
//! Divergences from the TS stop set are hardening, documented per
//! sequence: the synchronized-output release and SGR reset (TS emits
//! neither) and the cooked-tty verification (TS restores its captured
//! `wasRaw` — the poisoned state).

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
/// process-global and the test threads run in parallel, so a reader must
/// hold this lock across its read window (the unwind-guard test's
/// `catch_unwind` and the interactive error-path test's run both take it).
#[cfg(test)]
pub(crate) static TEST_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The one best-effort exit restore: the full sequence above, with no
/// inline flush. Idempotent — every mode release is gated on its own
/// process-global flag, so a restore after a deliberate teardown only
/// re-emits the two unconditional bytes (`?2026l`, SGR reset) and the
/// cursor show. A no-op off a terminal (headless harness pipes).
pub(crate) fn restore_terminal() {
    #[cfg(test)]
    RESTORE_ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut out = std::io::stdout();
    crate::enhanced_keys::release_for_exit();
    if out.is_terminal() {
        crate::enhanced_keys::drain_for_exit(&mut out);
        let _ = crate::mouse_tracking::disable(&mut out);
        let _ = crate::enhanced_keys::disable(&mut out);
        // The unconditional leave: the restore is the last line of defense,
        // so it must not trust the ownership flag (a surface that mounted the
        // screen outside the module — a partial restore, a desynced flag —
        // would otherwise keep the alt buffer up past the process death).
        crate::altscreen::force_leave(&mut out);
        let _ = out.write_all(SYNC_OUTPUT_OFF);
        let _ = out.write_all(SGR_RESET);
        let _ = crossterm::execute!(out, crossterm::cursor::Show);
    }
    // The raw-mode release and the cooked verification run regardless of a
    // redirected stdout (`prime-agent >capture`): raw mode lives on the
    // controlling tty, not on stdout — skipping the termios restoration
    // there would hand the shell a raw tty with no repair.
    let _ = crossterm::terminal::disable_raw_mode();
    let _ = report_cooked_repair();
    let _ = out.flush();
}

/// The shared exit tail: synchronized output off, SGR reset, cursor show,
/// raw mode off, then the cooked-tty verification and repair. The parity
/// teardown (`Renderer::finish`) runs its TS byte order for the visible
/// exit frame — the drain, the mode releases, the alt-screen leave with
/// the inline flush — and ends through here, so every exit path lands in
/// the same terminal state.
pub(crate) fn terminal_release_tail(out: &mut Stdout) {
    let _ = out.write_all(SYNC_OUTPUT_OFF);
    let _ = out.write_all(SGR_RESET);
    let _ = crossterm::execute!(out, crossterm::cursor::Show);
    let _ = crossterm::terminal::disable_raw_mode();
    let _ = report_cooked_repair();
    let _ = out.flush();
}

/// The repair notice goes through a fallible write: `eprintln!` panics
/// when stderr is gone, and a panic inside the unwind guard's restore
/// would abort the process mid-restore — exactly when the terminal is
/// half-handed-back.
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
/// task-level panics (the process lives on with a restored-but-live UI —
/// a cooked tty under a running surface is its own corruption), and the
/// codebase's `catch_unwind` sites (the fullscreen image-fallback guard)
/// re-raise rather than swallow, so the unwind crosses this drop exactly
/// when the surface frame is actually dying.
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
        // crossing this drop: a normal return stays silent, and a panic
        // tokio caught (the process lives on) never crosses the surface
        // frame, so the guard never fires for it.
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

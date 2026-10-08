//! Process-wide alternate-screen ownership.
//!
//! The alternate screen is handed between in-process TUI surfaces: a view switch adopts the
//! screen instead of leaving and re-entering it. The screen is entered once at the first surface
//! and left once at the real exit; a view switch is a full repaint of the same buffer.

use anyhow::Result;
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};
use std::io::stdout;
use std::sync::atomic::{AtomicBool, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Enter the alternate screen unless the previous surface already did and handed it off (no
/// sequence is written when the screen is already active).
///
/// # Errors
///
/// Returns `Err` when writing the enter sequence to stdout fails.
pub fn enter() -> Result<()> {
    if !ACTIVE.swap(true, Ordering::SeqCst) {
        crossterm::execute!(stdout(), EnterAlternateScreen)?;
    }
    Ok(())
}

/// Arm the interactive surface's first-draw mount: the alt-screen enter, the queued clear, and
/// the cursor hide ride the FIRST draw's single flush — a direct open paints nothing until its
/// first frame is ready, so the shell stays visible through the attach.
pub(crate) fn arm_first_draw_mount() {
    MOUNT_ARMED.store(true, Ordering::SeqCst);
}

/// Queue the alternate-screen enter for the caller's flush: the enter, the clear, and the frame
/// must land in ONE flush — an enter that flushes alone switches to the blank alternate buffer
/// ahead of the frame that fills it.
///
/// # Errors
///
/// Returns `Err` when writing the enter sequence to the caller's buffer fails.
pub(crate) fn enter_queued(out: &mut std::io::Stdout) -> anyhow::Result<()> {
    if !ACTIVE.swap(true, Ordering::SeqCst) {
        crossterm::queue!(out, EnterAlternateScreen)?;
    }
    Ok(())
}

/// Take the armed mount (the first draw after the setup owns it).
pub(crate) fn take_first_draw_mount() -> bool {
    MOUNT_ARMED.swap(false, Ordering::SeqCst)
}

/// Whether the first-draw mount is still pending: the alternate screen is armed but not
/// yet entered, so a per-screen mode (the kitty keyboard flags — Ghostty keeps the stack
/// per screen and a fresh alternate screen starts empty) must queue for the mount instead
/// of arming the primary screen's state.
pub(crate) fn mount_pending() -> bool {
    MOUNT_ARMED.load(Ordering::SeqCst) && !ACTIVE.load(Ordering::SeqCst)
}

/// The mount states for unit tests of the kitty-push deferral (see
/// [`crate::enhanced_keys`]); the caller restores both before releasing the test lock.
#[cfg(test)]
pub(crate) fn set_for_tests(active: bool, armed: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
    MOUNT_ARMED.store(armed, Ordering::SeqCst);
}

static MOUNT_ARMED: AtomicBool = AtomicBool::new(false);

/// Leave the alternate screen. A no-op when the screen is not active, so a teardown that runs
/// after another surface already left it cannot emit a stray restore.
///
/// # Errors
///
/// Returns `Err` when writing the alternate-screen leave sequence to stdout fails.
pub fn leave() -> Result<()> {
    if ACTIVE.swap(false, Ordering::SeqCst) {
        crossterm::execute!(stdout(), LeaveAlternateScreen)?;
    }
    Ok(())
}

/// Whether the process owns the alternate screen (the preserve-handoff state an incoming surface
/// inherits: a run entering on an active alt screen owns its release).
pub(crate) fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Leave the alternate screen unconditionally (the exit restore's last-line-of-defense):
/// surfaces that mounted the screen outside the ownership module must not keep the alt buffer up
/// after the process dies — `?1049l` on a primary-screen terminal is a no-op.
pub(crate) fn force_leave(out: &mut std::io::Stdout) {
    ACTIVE.store(false, Ordering::SeqCst);
    let _ = crossterm::execute!(out, LeaveAlternateScreen);
}

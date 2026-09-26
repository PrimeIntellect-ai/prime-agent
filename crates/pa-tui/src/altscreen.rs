//! Process-wide alternate-screen ownership.
//!
//! The TS `ProcessTerminal` hands the alternate screen between in-process
//! TUI surfaces (`pendingAltScreenHandoff`): a view switch adopts the screen
//! instead of leaving and re-entering it, so the primary screen (with the
//! pre-app terminal content) never flashes between the agents view and a
//! chat session. The screen is entered once at the first surface and left
//! once at the real exit; a view switch is a full repaint
//! (`Clear(ClearType::All)`) of the same buffer by the adopting surface.

use anyhow::Result;
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};
use std::io::stdout;
use std::sync::atomic::{AtomicBool, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Enter the alternate screen unless the previous surface already did and
/// handed it off (no sequence is written when the screen is already active).
///
/// # Errors
///
/// Returns `Err` when writing the alternate-screen enter sequence to
/// stdout fails.
pub fn enter() -> Result<()> {
    if !ACTIVE.swap(true, Ordering::SeqCst) {
        crossterm::execute!(stdout(), EnterAlternateScreen)?;
    }
    Ok(())
}

/// Arm the interactive surface's first-draw mount: the alt-screen
/// enter (a fresh process), the queued clear, and the cursor hide ride
/// the FIRST draw's single flush instead of the setup's — a direct open
/// paints nothing until its first frame is ready, so the shell (or the
/// handed-off surface) stays visible through the attach, and no mid-gap
/// stdout flush (the kitty probe, a mode enable) can carry the queued
/// clear out early over it.
pub(crate) fn arm_first_draw_mount() {
    MOUNT_ARMED.store(true, Ordering::SeqCst);
}

/// Queue the alternate-screen enter for the caller's flush (the armed
/// first-draw mount): the enter, the clear, and the frame must land in
/// ONE flush — an enter that flushes on its own switches to the blank
/// alternate buffer ahead of the frame that fills it.
///
/// # Errors
///
/// Returns `Err` when writing the alternate-screen enter sequence to
/// the caller's buffer fails.
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

static MOUNT_ARMED: AtomicBool = AtomicBool::new(false);

/// Leave the alternate screen. A no-op when the screen is not active, so a
/// teardown that runs after another surface already left it cannot emit a
/// stray restore.
///
/// # Errors
///
/// Returns `Err` when writing the alternate-screen leave sequence to
/// stdout fails.
pub fn leave() -> Result<()> {
    if ACTIVE.swap(false, Ordering::SeqCst) {
        crossterm::execute!(stdout(), LeaveAlternateScreen)?;
    }
    Ok(())
}

/// Whether the process owns the alternate screen (the preserve-handoff
/// state an incoming surface inherits: a run entering on an active alt
/// screen owns its release even when it fails before mounting).
pub(crate) fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Leave the alternate screen unconditionally (the exit restore's
/// last-line-of-defense): surfaces that mounted the screen outside the
/// ownership module (or a flag desynced by a partial restore) must not
/// keep the alt buffer up after the process dies — a `?1049l` on a
/// primary-screen terminal is a no-op, so the unconditional write costs
/// nothing when the screen is already left.
pub(crate) fn force_leave(out: &mut std::io::Stdout) {
    ACTIVE.store(false, Ordering::SeqCst);
    let _ = crossterm::execute!(out, LeaveAlternateScreen);
}

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

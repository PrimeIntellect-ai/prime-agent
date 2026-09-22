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
pub fn enter() -> Result<()> {
    if !ACTIVE.swap(true, Ordering::SeqCst) {
        crossterm::execute!(stdout(), EnterAlternateScreen)?;
    }
    Ok(())
}

/// Leave the alternate screen. A no-op when the screen is not active, so a
/// teardown that runs after another surface already left it cannot emit a
/// stray restore.
pub fn leave() -> Result<()> {
    if ACTIVE.swap(false, Ordering::SeqCst) {
        crossterm::execute!(stdout(), LeaveAlternateScreen)?;
    }
    Ok(())
}

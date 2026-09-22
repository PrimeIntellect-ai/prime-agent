//! Process-wide SGR mouse tracking state (TS `Terminal.setMouseTracking`).
//!
//! The interactive session surface enables button-event tracking (`?1002`)
//! with SGR encoding (`?1006`) while it owns the terminal and disables both
//! on exit, mirroring the TS enable/disable byte order. Motion tracking is
//! deliberately never enabled: native drag-selection keeps working for
//! terminals without an in-app selection surface.
//!
//! Tracking is enabled blind — probing is not viable (tmux never answers
//! DECRQM) and unsupporting terminals ignore the mode-sets.

use anyhow::Result;
use std::io::{IsTerminal, Stdout, Write};
use std::sync::atomic::{AtomicBool, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether mouse reports are currently expected from the terminal.
pub(crate) fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Enable SGR mouse tracking (the sequence is written only when the mode is
/// not already active). A non-terminal stdout (the headless harness) only
/// records the state: no reports ever arrive on a pipe.
pub(crate) fn enable(out: &mut Stdout) -> Result<()> {
    if !ACTIVE.swap(true, Ordering::SeqCst) && out.is_terminal() {
        write_enable(out)?;
    }
    Ok(())
}

/// Disable SGR mouse tracking (a no-op when the mode is not active, so a
/// teardown that runs after another surface already disabled it cannot
/// emit a stray reset).
pub(crate) fn disable(out: &mut Stdout) -> Result<()> {
    if ACTIVE.swap(false, Ordering::SeqCst) && out.is_terminal() {
        write_disable(out)?;
    }
    Ok(())
}

fn write_enable(out: &mut Stdout) -> Result<()> {
    out.write_all(b"\x1b[?1002h\x1b[?1006h")?;
    out.flush()?;
    Ok(())
}

fn write_disable(out: &mut Stdout) -> Result<()> {
    out.write_all(b"\x1b[?1006l\x1b[?1002l")?;
    out.flush()?;
    Ok(())
}

/// The tracking flag is process-global state, so every test that
/// toggles it serializes through one lock (the suspend-cycle tests share
/// it; the headless e2e binaries hold their own locks, one per process).
#[cfg(test)]
pub(crate) static STATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrips_without_a_terminal() {
        // stdout under `cargo test` is not a terminal (or is, depending on
        // the harness); the sequence write is gated on `is_terminal`, so
        // the round-trip asserts state only.
        let _lock = match STATE_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut out = std::io::stdout();
        let was_active = active();
        if was_active {
            disable(&mut out).expect("disable");
        }
        assert!(!active());
        enable(&mut out).expect("enable");
        assert!(active());
        disable(&mut out).expect("disable");
        assert!(!active());
        // Restore the entry state so concurrent tests observe a clean flag.
        if was_active {
            enable(&mut out).expect("re-enable");
        }
    }
}

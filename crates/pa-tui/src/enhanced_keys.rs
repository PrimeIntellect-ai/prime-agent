//! Terminal enhanced-key input modes (TS `ProcessTerminal` start/stop).
//!
//! The TS terminal enables bracketed paste (`?2004`) at every start so a
//! multi-line paste arrives as one bracketed chunk instead of per-line
//! keystrokes (each `Enter` inside the chunk would otherwise submit its
//! line), queries the kitty keyboard protocol and enables it
//! (`\x1b[>7u`: disambiguate escape codes, report event types, report
//! alternate keys) when the terminal answers, and falls back to xterm
//! modifyOtherKeys mode 2 (`\x1b[>4;2m`) when no kitty answer arrives in
//! the fallback window. Teardown pops the kitty flags, resets
//! modifyOtherKeys, and disables bracketed paste in the same byte order.
//!
//! The kitty query runs on a probe thread that holds no UI state: it
//! blocks inside crossterm's terminal support check until the terminal
//! answers (or its 2s budget lapses) while the fallback timer fires on
//! the TS schedule. crossterm parks the response in its internal event
//! queue, so the app reader never sees protocol bytes as key input.
//! A late answer still upgrades to kitty — the TS response handler
//! stays installed after the fallback fires too.
//!
//! DIVERGENCE FROM TS (the shift-modified printable bug class): this port
//! never arms modifyOtherKeys mode 2 and instead resets it
//! (`\x1b[>4;0m`) at every surface start. TS parses the resulting
//! `CSI 27;<mods>;<key>~` sequences itself (keys.ts
//! `parseModifyOtherKeysSequence`), but crossterm 0.28 has no case for
//! them and drops the whole pending input buffer on the parse error
//! (`Parser::advance` clears on `Err`) — a terminal in mode 2 (a sticky
//! mode any other pane or process may have armed) makes shift-modified
//! printables like `shift+=` vanish entirely. The reset returns such
//! terminals to legacy encodings (shift+= arrives as the produced `+`),
//! and the kitty path covers the enhanced-reporting surface crossterm
//! can parse (kitty CSI-u with shifted alternates resolves to the
//! produced character in crossterm's own parser).

use anyhow::Result;
use std::io::{IsTerminal, Stdout, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// Bracketed paste on (`?2004h`): the terminal wraps pastes in
/// `ESC[200~ ... ESC[201~`, so a multi-line paste arrives as one chunk.
const ENABLE_BRACKETED_PASTE: &[u8] = b"\x1b[?2004h";
/// Bracketed paste off (`?2004l`), written at teardown.
const DISABLE_BRACKETED_PASTE: &[u8] = b"\x1b[?2004l";
/// Kitty keyboard protocol, flags `1|2|4` (TS `ProcessTerminal` writes the
/// same set after the query answer).
const ENABLE_KITTY_FLAGS: &[u8] = b"\x1b[>7u";
/// Pop the kitty flags stack at teardown (TS writes the bare pop).
const POP_KITTY_FLAGS: &[u8] = b"\x1b[<u";
/// Reset xterm modifyOtherKeys (TS writes the reset at teardown; this port
/// also writes it at every start — see the module docs for why the mode-2
/// fallback is never armed here).
const MODIFY_OTHER_KEYS_RESET: &[u8] = b"\x1b[>4;0m";
/// TS `keyboardProtocolFallbackTimer`: the window the kitty answer gets
/// before the modifyOtherKeys fallback fires.
const KITTY_QUERY_FALLBACK: Duration = Duration::from_millis(150);

static BRACKETED_PASTE_ACTIVE: AtomicBool = AtomicBool::new(false);
static KITTY_ACTIVE: AtomicBool = AtomicBool::new(false);
static QUERY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Enable the enhanced-key modes for a surface start (TS
/// `ProcessTerminal.start`): bracketed paste unconditionally, the kitty
/// protocol behind a query, and a defensive modifyOtherKeys reset (the
/// module docs: the mode-2 fallback is never armed here, and the reset
/// clears a mode another pane or process left armed). A non-terminal
/// stdout (the headless harness) records no state and probes nothing.
pub(crate) fn enable(out: &mut Stdout) -> Result<()> {
    if !out.is_terminal() {
        return Ok(());
    }
    if !BRACKETED_PASTE_ACTIVE.swap(true, Ordering::SeqCst) {
        write_all(out, ENABLE_BRACKETED_PASTE)?;
    }
    write_all(out, MODIFY_OTHER_KEYS_RESET)?;
    if !KITTY_ACTIVE.load(Ordering::SeqCst) && !QUERY_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        spawn_kitty_probe();
    }
    Ok(())
}

/// Disable the enhanced-key modes for a surface teardown or suspend (TS
/// `ProcessTerminal.stop`): bracketed paste off, then the kitty pop, then
/// the modifyOtherKeys reset — the TS write order.
pub(crate) fn disable(out: &mut Stdout) -> Result<()> {
    if !out.is_terminal() {
        return Ok(());
    }
    if BRACKETED_PASTE_ACTIVE.swap(false, Ordering::SeqCst) {
        write_all(out, DISABLE_BRACKETED_PASTE)?;
    }
    if KITTY_ACTIVE.swap(false, Ordering::SeqCst) {
        write_all(out, POP_KITTY_FLAGS)?;
    }
    write_all(out, MODIFY_OTHER_KEYS_RESET)?;
    Ok(())
}

/// Drain in-flight input before the teardown restores the terminal (TS
/// `drainInput(1000, 50)`): a kitty key release that lands after raw mode
/// is off would leak its escape sequence into the parent shell over slow
/// SSH. The kitty flags and modifyOtherKeys reset first so the terminal
/// stops generating new release sequences while the drain runs; input is
/// then consumed until the idle window closes or the hard cap.
pub(crate) fn drain(out: &mut Stdout) {
    disable_keyboard_modes(out);
    if !enhanced_keys_active() {
        return;
    }
    let start = std::time::Instant::now();
    let mut last_input = start;
    while start.elapsed() < DRAIN_MAX && last_input.elapsed() < DRAIN_IDLE {
        match crossterm::event::poll(DRAIN_IDLE.min(DRAIN_MAX - start.elapsed())) {
            Ok(true) => {
                let _ = crossterm::event::read();
                last_input = std::time::Instant::now();
            }
            Ok(false) => break,
            Err(_) => break,
        }
    }
}

/// TS `drainInput` defaults.
const DRAIN_MAX: Duration = Duration::from_millis(1000);
const DRAIN_IDLE: Duration = Duration::from_millis(50);

/// The established modes once the probe settles: `(kitty, modify_other_keys)`.
/// `None` while the probe is still running (or never started — the headless
/// harness), so adoption telemetry can observe the outcome once. The second
/// flag is always `false` in this port (the mode-2 fallback is never armed —
/// see the module docs); it stays in the tuple so the telemetry schema keeps
/// the TS event shape.
pub(crate) fn settle_state() -> Option<(bool, bool)> {
    if QUERY_IN_FLIGHT.load(Ordering::SeqCst) {
        None
    } else {
        // Settled (or no probe ever ran — the headless harness): only
        // kitty can be active beyond the paste markers.
        Some((KITTY_ACTIVE.load(Ordering::SeqCst), false))
    }
}

fn enhanced_keys_active() -> bool {
    BRACKETED_PASTE_ACTIVE.load(Ordering::SeqCst) || KITTY_ACTIVE.load(Ordering::SeqCst)
}

/// Disable the keyboard-protocol modes (both `drain` variants disable
/// them first); bracketed paste stays on — TS `drainInput` leaves it to
/// `stop`.
fn disable_keyboard_modes(out: &mut Stdout) {
    if KITTY_ACTIVE.swap(false, Ordering::SeqCst) {
        let _ = write_all(out, POP_KITTY_FLAGS);
    }
    let _ = write_all(out, MODIFY_OTHER_KEYS_RESET);
}

fn write_all(out: &mut Stdout, sequence: &[u8]) -> Result<()> {
    out.write_all(sequence)?;
    out.flush()?;
    Ok(())
}

/// Enable the kitty protocol (TS writes `\x1b[>7u` when the query answer
/// arrives). Skipped when the surface that started the probe is already
/// gone — a stray enable would leave the flags pushed over the next
/// surface's own setup.
fn enable_kitty(out: &mut Stdout) {
    if !KITTY_ACTIVE.swap(true, Ordering::SeqCst) {
        let _ = write_all(out, ENABLE_KITTY_FLAGS);
    }
}

/// The probe thread: hold the query open for the TS fallback window,
/// then settle. An answer inside the window enables kitty; no answer
/// settles with no enhanced modes (this port never arms the
/// modifyOtherKeys fallback — see the module docs), and a late answer
/// still upgrades (the TS response handler stays installed after the
/// fallback fires too).
fn spawn_kitty_probe() {
    let probe = std::thread::Builder::new()
        .name("tui-kitty-probe".to_string())
        .spawn(|| {
            let (answer_tx, answer_rx) = mpsc::channel();
            // crossterm's support check sends the query and blocks on the
            // answer for its own 2s budget; it reads the tty through the
            // shared internal reader, so the bytes it skips (user keys
            // typed during the window) stay queued for the app reader.
            let reader = std::thread::Builder::new()
                .name("tui-kitty-probe-read".to_string())
                .spawn(move || {
                    let _ = answer_tx.send(crossterm::terminal::supports_keyboard_enhancement());
                });
            match answer_rx.recv_timeout(KITTY_QUERY_FALLBACK) {
                Ok(Ok(true)) => {
                    enable_kitty(&mut std::io::stdout());
                    QUERY_IN_FLIGHT.store(false, Ordering::SeqCst);
                }
                Ok(_) => {
                    // No kitty: settle with no enhanced modes (TS would arm
                    // modifyOtherKeys mode 2 here; crossterm cannot parse
                    // its sequences — see the module docs).
                    QUERY_IN_FLIGHT.store(false, Ordering::SeqCst);
                }
                Err(_) => {
                    // Keep waiting for the answer past the window: the
                    // detached reader settles the upgrade when it lands.
                    std::thread::Builder::new()
                        .name("tui-kitty-probe-late".to_string())
                        .spawn(move || {
                            let answer = answer_rx.recv().unwrap_or(Err(std::io::Error::other(
                                "the kitty probe reader exited",
                            )));
                            if matches!(answer, Ok(true))
                                && BRACKETED_PASTE_ACTIVE.load(Ordering::SeqCst)
                            {
                                enable_kitty(&mut std::io::stdout());
                            }
                            QUERY_IN_FLIGHT.store(false, Ordering::SeqCst);
                        })
                        .ok();
                }
            }
            if let Ok(handle) = reader {
                let _ = handle.join();
            }
        });
    if probe.is_err() {
        // Out of thread resources: no probe, no modes — plain key input.
        QUERY_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The state flags are process-global, so every test serializes
    /// through one lock (the mouse-tracking module's pattern).
    static STATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn reset_state() {
        BRACKETED_PASTE_ACTIVE.store(false, Ordering::SeqCst);
        KITTY_ACTIVE.store(false, Ordering::SeqCst);
        QUERY_IN_FLIGHT.store(false, Ordering::SeqCst);
    }

    #[test]
    fn enable_disable_roundtrip_on_pipes_touches_no_state() {
        let _lock = STATE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_state();
        // stdout under `cargo test` is not a terminal: the harness keeps
        // plain pipes, so enable/disable record no state and probe nothing.
        let mut out = std::io::stdout();
        let plain = out.is_terminal();
        enable(&mut out).expect("enable");
        if !plain {
            assert!(!enhanced_keys_active());
            assert_eq!(settle_state(), Some((false, false)));
        }
        disable(&mut out).expect("disable");
        assert!(!enhanced_keys_active());
    }

    #[test]
    fn settle_state_reports_the_established_modes() {
        let _lock = STATE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_state();
        KITTY_ACTIVE.store(true, Ordering::SeqCst);
        assert_eq!(settle_state(), Some((true, false)));
        KITTY_ACTIVE.store(false, Ordering::SeqCst);
        // The modifyOtherKeys fallback is never armed in this port, so the
        // second flag is always false (the tuple keeps the TS event shape).
        assert_eq!(settle_state(), Some((false, false)));
        QUERY_IN_FLIGHT.store(true, Ordering::SeqCst);
        assert_eq!(settle_state(), None);
    }
}

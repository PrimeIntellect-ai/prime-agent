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
//! modifyOtherKeys, and disables bracketed paste in the same byte
//! order; the exit tail (`exit_restore`) then drains the stack's stale
//! levels — bare pops after the alt-screen leave, clamped no-ops at
//! spec depth zero (see `STALE_LEVEL_DRAIN`).
//!
//! The kitty query runs on a probe thread that holds no UI state: it
//! blocks inside crossterm's terminal support check until the terminal
//! answers (or its patched 250ms budget lapses) while the fallback timer
//! fires on the TS schedule. The check holds its window in 10ms poll
//! slices (the vendored crossterm patch), so the app reader interleaves
//! and early typing delivers at its own cadence while the probe listens.
//! Crossterm parks user keys in its internal event queue, so early
//! typing is preserved; the app reader never sees protocol bytes as key
//! input. An answer after the 150ms fallback but within the 250ms query
//! window still upgrades to kitty. Replies arriving after that window are
//! filtered by crossterm, and the terminal stays in legacy mode.
//!
//! The query runs ONCE per process (the first terminal surface), never
//! again on a later start or resume: the terminal's kitty capability
//! cannot change across a stop/continue of the same process, so the
//! probe resolves once and every later start re-applies the resolved
//! state — the observable TS contract (kitty terminals keep CSI-u
//! parsing after a resume; non-kitty terminals never gain it) — and the
//! check's implicit raw-mode bracket can race the app's own suspend
//! bracket, so a re-query at every start carries bracket risk for no
//! capability gain. The first-mount window is the one accepted cost: on
//! silent terminals the probe parks the process-global event-reader
//! lock for its window, but in 10ms slices (the vendored crossterm
//! patch), so input typed during it delivers within a slice instead of
//! waiting for the settle.
//!
//! THE VERDICT TIME (characterized 2026-09-29; the timed contract is
//! locked by `kitty_verdict_time_e2e`): the probe concludes at the
//! FIRST reply, and only the reply classes pay differently. A kitty
//! terminal concludes at its flags reply. A DA1-answering non-kitty
//! terminal — the common non-kitty class; tmux and screen answer DA1
//! locally in microseconds and never answer the flags query —
//! concludes AT THE DA1 ARRIVAL (crossterm's flags filter matches the
//! primary-device-attributes reply; a flags reply arriving after the
//! DA1 can never upgrade: the check has returned and the once-per-
//! process probe never re-examines parked replies). Only a fully-silent
//! pty (no DA1 ever — CI harnesses) waits the 250ms deadline. The
//! deadline stays 250ms because it is also the LATE-KITTY catch window:
//! a kitty terminal over a slow hop answers its flags at RTT (this
//! fleet's own single public hop measures 24-29ms; the intercontinental
//! SSH classes ride 80-250ms), so a shorter window would silently drop
//! the enhancement for exactly the remote-SSH deployment this product
//! primarily serves, while buying nothing a user rides (the silent
//! class's only window cost is a mode transition raced inside the first
//! 250ms — measured: the raced suspend's teardown waits to ~250ms on a
//! silent pty and lands at its dispatch on every answered class).
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
//!
//! Every mode-flag transition is serialized (a module-wide lock pairs each
//! flag write with its escape write), and the force-quit exit path marks
//! the terminal released first: a probe answer that lands around the
//! process exit can never push the kitty flags back on after the exit
//! restore popped them.

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
/// Pop one level of the kitty flags stack (the bare form TS writes at
/// teardown).
const POP_KITTY_FLAGS: &[u8] = b"\x1b[<u";
/// The stale-level drain (the crashed-run and relay-accounting
/// hardening): a bounded run of bare pops. At the mount it runs BEFORE
/// the push: a killed session never runs its teardown, so its pushed
/// level stays on the terminal's stack; every later session in that
/// terminal pushes once more and pops once — the stale level survives
/// every exit and the shell keeps receiving CSI-u escapes for plain
/// keys (the reported leak). At the teardown it runs in the exit tail,
/// AFTER the alternate screen is left ([`pop_stale_levels`]): a
/// mode-counting relay — herdr's pane emulator re-encodes every
/// keystroke from its own count of the push/pop pairs in the pane
/// output, never resets the count on foreground-program exit, and
/// discards the pair's writes that land while the pane's alternate
/// screen is up — leaves the pane's stack one level deep after a plain
/// exit, and the leftover level turns every later Ctrl+C/Ctrl+D in the
/// pane's shell into a kitty CSI-u keypress no shell understands (the
/// live report, herdr 0.9.3: every exit left the pane one pop short;
/// pops written after the alt-screen leave survive, and one manual pop
/// repaired the pane). Pops against an empty stack are ignored (kitty
/// spec), so the drain is free on a clean terminal. The count covers a
/// killed-session pile-up (one wedge plus a couple of kill retries)
/// and the relay's miscount with margin; deeper stacks still self-heal
/// one level per session run.
const STALE_LEVEL_DRAIN: usize = 3;
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
/// The terminal answered the kitty query once (the resolved capability).
/// The answer outlives any one surface: a suspend pops the flags but the
/// capability stays, so the next start re-applies them without asking
/// again — the once-per-process contract (see the module docs).
static KITTY_SUPPORTED: AtomicBool = AtomicBool::new(false);
/// The kitty query was sent at least once this process. The probe
/// machinery never runs again after the first query (see the module
/// docs); this is the latch that keeps every later start from re-arming
/// it.
static KITTY_PROBED: AtomicBool = AtomicBool::new(false);
/// Serializes every mode-flag read-modify-write with its escape write:
/// the flag and the terminal must move as one unit, or a probe thread
/// enabling kitty can interleave with a teardown disabling it (the flags
/// then read released while the terminal still has the mode armed, or a
/// push lands after the exit restore's pop). The force-quit watchdog (a
/// plain thread, no runtime) holds this too, so its restore cannot
/// interleave with a probe's enable.
static MODE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// The process is exiting and the terminal is being released for the last
/// time (the force-quit restore): any in-flight kitty probe must stand
/// down instead of pushing the flags back on after the restore popped
/// them — a terminal left in kitty mode spews CSI-u sequences into the
/// parent shell on every key press.
static EXIT_RELEASE: AtomicBool = AtomicBool::new(false);

fn lock_modes() -> std::sync::MutexGuard<'static, ()> {
    MODE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether the kitty probe's answer window is open. The input reader
/// keys its bounded poll cadence on this: the probe's slices and the
/// reader share crossterm's process-global event-reader lock, and the
/// reader's indefinite park would hold it — starving the probe's
/// slices for the window's whole duration (the window is bounded and
/// once per process, so the cadence there is the startup cost it
/// already was).
pub(crate) fn query_in_flight() -> bool {
    QUERY_IN_FLIGHT.load(Ordering::SeqCst)
}

/// Mark the terminal released for process exit (the force-quit restore
/// calls this before writing the restore sequences): the kitty probe's
/// answer paths check it before enabling, so no push can land after the
/// final pop.
pub(crate) fn release_for_exit() {
    EXIT_RELEASE.store(true, Ordering::SeqCst);
}

/// What one `enable` does about the kitty protocol, decided from the
/// process-global resolution state. Pure so the unit tests lock every
/// transition without a terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KittyAction {
    /// First terminal surface of the process: run the query.
    Probe,
    /// The terminal answered kitty once (the capability survived a
    /// suspend's flag pop): push the flags back.
    PushFlags,
    /// Settled no-kitty, already active, or a probe still in flight (its
    /// answer upgrades late): nothing to do.
    None,
}

fn kitty_action(
    kitty_supported: bool,
    kitty_probed: bool,
    kitty_active: bool,
    query_in_flight: bool,
) -> KittyAction {
    if kitty_active || query_in_flight {
        return KittyAction::None;
    }
    if kitty_supported {
        return KittyAction::PushFlags;
    }
    if kitty_probed {
        return KittyAction::None;
    }
    KittyAction::Probe
}

/// Direct-terminal hints are useful only without a transport that can
/// forward environment variables while changing or filtering escape replies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyboardCapability {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Default)]
struct TerminalEnvironment<'a> {
    term: Option<&'a str>,
    term_program: Option<&'a str>,
    kitty_window_id: Option<&'a str>,
    ghostty_resources_dir: Option<&'a str>,
    wezterm_pane: Option<&'a str>,
    tmux: Option<&'a str>,
    sty: Option<&'a str>,
    zellij: Option<&'a str>,
    ssh_connection: Option<&'a str>,
    ssh_tty: Option<&'a str>,
}

fn keyboard_capability(env: &TerminalEnvironment<'_>) -> KeyboardCapability {
    let term = env.term.unwrap_or_default();
    if env.tmux.is_some()
        || env.sty.is_some()
        || env.zellij.is_some()
        || env.ssh_connection.is_some()
        || env.ssh_tty.is_some()
        || term.starts_with("tmux")
        || term.starts_with("screen")
    {
        return KeyboardCapability::Unknown;
    }
    if matches!(term, "dumb" | "linux") {
        return KeyboardCapability::Unsupported;
    }
    if env.kitty_window_id.is_some()
        || env.ghostty_resources_dir.is_some()
        || env.wezterm_pane.is_some()
        || matches!(env.term_program, Some("kitty" | "ghostty" | "WezTerm"))
    {
        return KeyboardCapability::Supported;
    }
    KeyboardCapability::Unknown
}

fn local_keyboard_capability() -> KeyboardCapability {
    let term = std::env::var("TERM").ok();
    let term_program = std::env::var("TERM_PROGRAM").ok();
    let kitty_window_id = std::env::var("KITTY_WINDOW_ID").ok();
    let ghostty_resources_dir = std::env::var("GHOSTTY_RESOURCES_DIR").ok();
    let wezterm_pane = std::env::var("WEZTERM_PANE").ok();
    let tmux = std::env::var("TMUX").ok();
    let sty = std::env::var("STY").ok();
    let zellij = std::env::var("ZELLIJ").ok();
    let ssh_connection = std::env::var("SSH_CONNECTION").ok();
    let ssh_tty = std::env::var("SSH_TTY").ok();
    keyboard_capability(&TerminalEnvironment {
        term: term.as_deref(),
        term_program: term_program.as_deref(),
        kitty_window_id: kitty_window_id.as_deref(),
        ghostty_resources_dir: ghostty_resources_dir.as_deref(),
        wezterm_pane: wezterm_pane.as_deref(),
        tmux: tmux.as_deref(),
        sty: sty.as_deref(),
        zellij: zellij.as_deref(),
        ssh_connection: ssh_connection.as_deref(),
        ssh_tty: ssh_tty.as_deref(),
    })
}

/// Record the terminal's kitty capability (a probe answered). The
/// resolution outlives the surface it arrived on: a later start pushes
/// the flags back from the memory instead of re-querying (the
/// once-per-process contract).
fn record_kitty_supported() {
    KITTY_SUPPORTED.store(true, Ordering::SeqCst);
}

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
    let _modes = lock_modes();
    // A new surface mount re-arms probing: the exit standdown covers only
    // the dying surface's window — a surface that returns control without
    // ending the process (the replay run_app is a library call) must not
    // poison every later surface's keyboard protocol.
    EXIT_RELEASE.store(false, Ordering::SeqCst);
    if !BRACKETED_PASTE_ACTIVE.swap(true, Ordering::SeqCst) {
        write_all(out, ENABLE_BRACKETED_PASTE)?;
    }
    write_all(out, MODIFY_OTHER_KEYS_RESET)?;
    match kitty_action(
        KITTY_SUPPORTED.load(Ordering::SeqCst),
        KITTY_PROBED.load(Ordering::SeqCst),
        KITTY_ACTIVE.load(Ordering::SeqCst),
        QUERY_IN_FLIGHT.load(Ordering::SeqCst),
    ) {
        KittyAction::Probe => {
            // Known direct terminals need no query. Ambiguous terminals use
            // the bounded crossterm reader so typeahead stays in its queue.
            match local_keyboard_capability() {
                KeyboardCapability::Supported => {
                    KITTY_PROBED.store(true, Ordering::SeqCst);
                    record_kitty_supported();
                    if !KITTY_ACTIVE.swap(true, Ordering::SeqCst) {
                        // The stale-level drain: clear the levels a
                        // killed session (or a miscounting relay) left
                        // before this process's own push (see
                        // STALE_LEVEL_DRAIN).
                        for _ in 0..STALE_LEVEL_DRAIN {
                            write_all(out, POP_KITTY_FLAGS)?;
                        }
                        write_all(out, ENABLE_KITTY_FLAGS)?;
                    }
                }
                KeyboardCapability::Unsupported => {
                    KITTY_PROBED.store(true, Ordering::SeqCst);
                }
                KeyboardCapability::Unknown => {
                    if !QUERY_IN_FLIGHT.swap(true, Ordering::SeqCst) {
                        KITTY_PROBED.store(true, Ordering::SeqCst);
                        spawn_kitty_probe();
                    }
                }
            }
        }
        KittyAction::PushFlags => {
            if !KITTY_ACTIVE.swap(true, Ordering::SeqCst) {
                // The stale-level drain (see STALE_LEVEL_DRAIN): a
                // suspend's pop and resume's re-push stay balanced; a
                // stale level from a killed session levels out here.
                for _ in 0..STALE_LEVEL_DRAIN {
                    write_all(out, POP_KITTY_FLAGS)?;
                }
                write_all(out, ENABLE_KITTY_FLAGS)?;
            }
        }
        KittyAction::None => {}
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
    let _modes = lock_modes();
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
    drain_bounded(out, DRAIN_MAX);
}

/// The force-quit variant: the exit is observed inside the 2s contract
/// window (the watchdog fires 500ms inside it), so the drain cap shrinks
/// to what that budget allows; the idle window is unchanged.
pub(crate) fn drain_for_exit(out: &mut Stdout) {
    drain_bounded(out, EXIT_DRAIN_MAX);
}

/// The in-process handoff variant (an exit that hands the pane to another
/// surface of this process — the agents view, a `/resume` chain). The
/// idle window's guarded leak is a release that lands AFTER raw mode is
/// off; a handoff keeps raw mode on (the adopting surface's reader takes
/// over the same tty), and every surface's dispatch drops key-release
/// events (`input::filter_enhanced_key_events`, TS tui.ts), so a release
/// that outruns the drain is consumed-and-ignored by the next reader, not
/// leaked anywhere. The fixed idle window buys nothing observable on
/// this path, so the drain consumes what the terminal has already
/// written — zero-timeout polls, no wait — and returns as soon as the
/// buffer is observed empty. Only when input IS flowing (the observed
/// case) does it fall through to the bounded drain, so a burst around a
/// handoff is coalesced exactly like the exit drain's idle window
/// ([`DRAIN_IDLE`] silence, [`DRAIN_MAX`] cap).
pub(crate) fn drain_for_handoff(out: &mut Stdout) {
    disable_keyboard_modes(out);
    if !enhanced_keys_active() {
        return;
    }
    let start = std::time::Instant::now();
    let mut observed_input = false;
    while start.elapsed() < DRAIN_MAX {
        match crossterm::event::poll(Duration::ZERO) {
            Ok(true) => {
                let _ = crossterm::event::read();
                observed_input = true;
            }
            Ok(false) | Err(_) => break,
        }
    }
    if observed_input {
        // The hard cap spans the whole handoff drain: the zero-timeout loop
        // may have consumed most of DRAIN_MAX under continuous input, so
        // the bounded phase runs on what remains, never a fresh budget.
        drain_until_idle(DRAIN_MAX.saturating_sub(start.elapsed()));
    }
}

fn drain_bounded(out: &mut Stdout, max: Duration) {
    disable_keyboard_modes(out);
    if !enhanced_keys_active() {
        return;
    }
    drain_until_idle(max);
}

/// The consume loop both bounded drains share: eat input until the idle
/// window (`DRAIN_IDLE` of silence after the last event) closes or the
/// hard cap lapses.
fn drain_until_idle(max: Duration) {
    let start = std::time::Instant::now();
    let mut last_input = start;
    while start.elapsed() < max && last_input.elapsed() < DRAIN_IDLE {
        match crossterm::event::poll(DRAIN_IDLE.min(max.saturating_sub(start.elapsed()))) {
            Ok(true) => {
                let _ = crossterm::event::read();
                last_input = std::time::Instant::now();
            }
            Ok(false) | Err(_) => break,
        }
    }
}

/// TS `drainInput` defaults.
const DRAIN_MAX: Duration = Duration::from_secs(1);
const DRAIN_IDLE: Duration = Duration::from_millis(50);
/// The force-quit drain cap: the exit must be observed within 2s of the
/// second Ctrl+C, 1.5s of which elapses before the watchdog fires.
const EXIT_DRAIN_MAX: Duration = Duration::from_millis(400);

/// Whether the kitty keyboard protocol is active (the probe answered).
/// The key-id layer and the input reader use this to switch the TS
/// mode-aware semantics: the LF mapping (`\n` is shift+enter under kitty,
/// enter in legacy mode) and the kitty-printable dedup only apply while
/// kitty events can actually arrive.
pub(crate) fn kitty_active() -> bool {
    KITTY_ACTIVE.load(Ordering::SeqCst)
}

/// Flip the kitty flag for unit tests of other modules (the id layer's
/// mode-aware mappings and the reader's dedup read [`kitty_active`]);
/// each test serializes through its own lock the way this module's state
/// tests do.
#[cfg(test)]
pub(crate) fn set_kitty_active_for_tests(active: bool) {
    KITTY_ACTIVE.store(active, Ordering::SeqCst);
}

/// The lock every test that flips the process-global enhanced-keys state
/// holds (this module's state tests and the mode-aware mapping tests in
/// `keys`/`input`).
#[cfg(test)]
pub(crate) static TEST_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    let _modes = lock_modes();
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
    // The capability is the durable truth: a later start re-applies the
    // flags from it even when this push stands down for the exit.
    record_kitty_supported();
    let _modes = lock_modes();
    // The exit release ran: the flags are popped (or never pushed), and a
    // probe answer arriving around the exit must not push them back on —
    // the process is about to terminate with the terminal in its final
    // state.
    if EXIT_RELEASE.load(Ordering::SeqCst) {
        return;
    }
    if !KITTY_ACTIVE.swap(true, Ordering::SeqCst) {
        // The stale-level drain (see STALE_LEVEL_DRAIN): the probe
        // answer's push drains the stale levels too.
        for _ in 0..STALE_LEVEL_DRAIN {
            let _ = write_all(out, POP_KITTY_FLAGS);
        }
        let _ = write_all(out, ENABLE_KITTY_FLAGS);
    }
}

/// The exit tail's stale-level drain: [`STALE_LEVEL_DRAIN`] bare pops,
/// written after the alternate screen is left. A mode-counting relay
/// that tracks the keyboard protocol from the pane output discards the
/// pair's writes made while the pane's alt screen is up (herdr), so
/// the teardown's own pop — written inside the alt screen, where TS
/// writes it — never lands on the relay's stack, and the pane's shell
/// inherits the leftover level as dead Ctrl+C/Ctrl+D keys. The tail's
/// position is after the alt-screen leave on every exit route, where
/// the relay's accounting keeps the writes; the bare pops are clamped
/// no-ops at spec depth zero, so a clean terminal sees nothing change.
pub(crate) fn pop_stale_levels(out: &mut Stdout) {
    if !out.is_terminal() {
        return;
    }
    let _modes = lock_modes();
    for _ in 0..STALE_LEVEL_DRAIN {
        let _ = write_all(out, POP_KITTY_FLAGS);
    }
}

/// The probe thread: hold the query open for the TS fallback window,
/// then settle. An answer within crossterm's patched 250ms query window
/// enables kitty; no answer settles with no enhanced modes (this port
/// never arms the modifyOtherKeys fallback — see the module docs).
fn spawn_kitty_probe() {
    let probe = std::thread::Builder::new()
        .name("tui-kitty-probe".to_string())
        .spawn(|| {
            let (answer_tx, answer_rx) = mpsc::channel();
            // crossterm's support check sends the query and blocks on the
            // answer for at most 250ms (the vendored crossterm patch). It
            // reads the tty through the shared internal reader, so the
            // skipped user keys stay queued for the app reader.
            let reader = std::thread::Builder::new()
                .name("tui-kitty-probe-read".to_string())
                .spawn(move || {
                    // A dying process must not start the support check: with
                    // the app's raw-mode bracket already off (the exit
                    // restore's window) crossterm brackets raw mode itself —
                    // re-arming raw on a handed-back terminal and stealing
                    // the raw-mode save slot. The exit paths set the
                    // standdown before they restore, so settle with no
                    // answer instead of running the check.
                    //
                    // The same standdown holds for the SUSPEND window: the
                    // check's bracket only runs when the app's raw mode is
                    // off, and a suspend cycle that raced the probe's
                    // thread start (early typing is delivered inside the
                    // probe window) leaves exactly that state — the check
                    // would re-arm raw on the terminal the shell now owns
                    // while the process group stops (the probe-bracket
                    // race the module docs warn about). Settle no-kitty
                    // instead; the capability stays unresolved for this
                    // run, never poisoned.
                    //
                    // The check is bracket-free by construction: the
                    // probe takes `supports_keyboard_enhancement_checked_raw`
                    // (the vendored facade's raw-read path), so NOTHING in
                    // this thread can re-arm raw mode, whatever races the
                    // guard's read. The mode lock serializes the guard
                    // with the suspend's mode releases (the same
                    // serialization every mode transition takes); the
                    // once-per-process cost is a suspend racing the first
                    // mount's probe window stalling behind the check's
                    // 250ms bound before its teardown starts.
                    let modes = lock_modes();
                    let raw_bracket_on =
                        crossterm::terminal::is_raw_mode_enabled().unwrap_or(false);
                    if EXIT_RELEASE.load(Ordering::SeqCst) || !raw_bracket_on {
                        let _ = answer_tx.send(Ok(false));
                        return;
                    }
                    let _ = answer_tx
                        .send(crossterm::terminal::supports_keyboard_enhancement_checked_raw());
                    // The guard releases at this scope's end; the answer
                    // path's `enable_kitty` takes the lock after it.
                    drop(modes);
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
                            if let Ok(true) = answer {
                                // The capability outlives the surface the
                                // answer arrived on: record it even when the
                                // push stands down (a suspended surface has
                                // paste off — its resume re-applies the
                                // flags from the memory).
                                record_kitty_supported();
                                if BRACKETED_PASTE_ACTIVE.load(Ordering::SeqCst) {
                                    enable_kitty(&mut std::io::stdout());
                                }
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
    fn lock_state() -> std::sync::MutexGuard<'static, ()> {
        TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn reset_state() {
        BRACKETED_PASTE_ACTIVE.store(false, Ordering::SeqCst);
        KITTY_ACTIVE.store(false, Ordering::SeqCst);
        QUERY_IN_FLIGHT.store(false, Ordering::SeqCst);
        KITTY_SUPPORTED.store(false, Ordering::SeqCst);
        KITTY_PROBED.store(false, Ordering::SeqCst);
        EXIT_RELEASE.store(false, Ordering::SeqCst);
    }

    /// The first terminal mount queries kitty; a settled-no answer never
    /// re-queries on a later start. This locks the once-per-process
    /// contract: pre-fix, every start (including every SIGCONT resume)
    /// re-armed the probe, whose 2s crossterm support check starved the
    /// app reader for its whole budget on terminals that never answer
    /// the query.
    #[test]
    fn the_query_runs_once_and_a_settled_no_never_re_queries() {
        let _lock = lock_state();
        reset_state();
        // First mount: probe.
        assert_eq!(kitty_action(false, false, false, false), KittyAction::Probe);
        // In flight: nothing (the late answer upgrades on its own).
        assert_eq!(kitty_action(false, true, false, true), KittyAction::None);
        // Settled no-kitty: nothing, forever — the second start and every
        // later resume must not run the query again.
        assert_eq!(kitty_action(false, true, false, false), KittyAction::None);
    }

    #[test]
    fn only_direct_terminal_markers_skip_the_probe() {
        for env in [
            TerminalEnvironment {
                kitty_window_id: Some("42"),
                ..Default::default()
            },
            TerminalEnvironment {
                ghostty_resources_dir: Some("/ghostty"),
                ..Default::default()
            },
            TerminalEnvironment {
                wezterm_pane: Some("3"),
                ..Default::default()
            },
            TerminalEnvironment {
                term_program: Some("ghostty"),
                ..Default::default()
            },
        ] {
            assert_eq!(keyboard_capability(&env), KeyboardCapability::Supported);
        }
        for env in [
            TerminalEnvironment {
                term: Some("dumb"),
                ..Default::default()
            },
            TerminalEnvironment {
                term: Some("linux"),
                ..Default::default()
            },
        ] {
            assert_eq!(keyboard_capability(&env), KeyboardCapability::Unsupported);
        }
        for env in [
            TerminalEnvironment::default(),
            TerminalEnvironment {
                term: Some("xterm-ghostty"),
                ..Default::default()
            },
            TerminalEnvironment {
                term_program: Some("vscode"),
                ..Default::default()
            },
            TerminalEnvironment {
                term: Some("tmux-256color"),
                ghostty_resources_dir: Some("/ghostty"),
                ..Default::default()
            },
            TerminalEnvironment {
                tmux: Some("/tmp/tmux"),
                kitty_window_id: Some("42"),
                ..Default::default()
            },
            TerminalEnvironment {
                ssh_connection: Some("remote"),
                wezterm_pane: Some("3"),
                ..Default::default()
            },
            TerminalEnvironment {
                zellij: Some("0"),
                ghostty_resources_dir: Some("/ghostty"),
                ..Default::default()
            },
        ] {
            assert_eq!(keyboard_capability(&env), KeyboardCapability::Unknown);
        }
    }

    /// A suspend/resume cycle on a kitty-capable terminal re-applies the
    /// flags from the recorded capability instead of re-querying: the
    /// disable popped them, the resume pushes them back.
    #[test]
    fn a_resume_re_applies_the_flags_from_the_recorded_capability() {
        let _lock = lock_state();
        reset_state();
        record_kitty_supported();
        // The probe's answer arm through enable_kitty (the flags push):
        // active now, so a second enable without a disable does nothing.
        assert_eq!(kitty_action(true, true, true, false), KittyAction::None);
        // The suspend pops the flags; the resume pushes them back.
        assert_eq!(
            kitty_action(true, true, false, false),
            KittyAction::PushFlags
        );
    }

    /// The flag-level suspend/resume cycle with a settled-no probe: the
    /// resume's enable must not probe again — the exact transition the
    /// e2e's no-query-after-SIGCONT assertion locks from the outside.
    #[test]
    fn a_suspend_resume_cycle_after_a_settled_no_probe_does_not_probe() {
        let _lock = lock_state();
        reset_state();
        // First mount probed and settled no.
        KITTY_PROBED.store(true, Ordering::SeqCst);
        // The suspend cycle: disable pops (nothing active), resume must
        // stay on the settled answer.
        assert_eq!(kitty_action(false, true, false, false), KittyAction::None);
        // And the in-flight window before the first settle: the suspend
        // could only be driven by input the reader cannot deliver while
        // the probe holds the event-reader lock, so this state is the
        // only other one a resume can observe.
        assert_eq!(kitty_action(false, true, false, true), KittyAction::None);
    }

    #[test]
    fn enable_disable_roundtrip_on_pipes_touches_no_state() {
        let _lock = lock_state();
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
    fn release_for_exit_stands_a_late_probe_answer_down() {
        let _lock = lock_state();
        reset_state();
        // The force-quit restore ran (release_for_exit) and a kitty probe
        // answer arrives afterwards: the push must not happen — the exit
        // already popped the flags, and the terminal must keep the
        // post-restore state for the parent shell.
        release_for_exit();
        enable_kitty(&mut std::io::stdout());
        assert!(!KITTY_ACTIVE.load(Ordering::SeqCst));
    }

    #[test]
    fn settle_state_reports_the_established_modes() {
        let _lock = lock_state();
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

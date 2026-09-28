//! The terminal-state differential: a recording mock terminal over a
//! real pty asserts that EVERY terminal mode the TUI arms comes back
//! off on EVERY exit route.
//!
//! The operator's directive (2026-09-28, the kitty-exit-leak sweep):
//! "if the kitty protocol is leaking to my shell, check if OTHER things
//! are leaking too." The confirmed kitty leak has its own lane; this
//! harness is the systematic net for everything else. The mock terminal
//! (the harness itself, over the pty master) records every
//! mode-affecting byte the child writes, answers the kitty capability
//! query like a kitty terminal would, drives one exit route, and then
//! asserts THE MODE DELTA IS EMPTY: the terminal state the child hands
//! back equals the state it received. A leak — any mode left armed,
//! any kitty flag pushed and not popped, an SGR left dangling, a
//! termios bit left raw — fails the route.
//!
//! The tracked state, per the inventory (handoffs/TERMINAL-LEAK-AUDIT.md):
//! - DEC private modes (`ESC[?NNNh/l`): bracketed paste 2004, mouse
//!   1000/1002/1003/1006, cursor visibility 25, alt screen 47/1047/1049,
//!   synchronized output 2026, wrap 7, focus reporting 1004, flow control
//!   33 — every mode number the stream writes, known or not: an unknown
//!   mode behaves exactly like a known one (set without reset = leak);
//! - the kitty keyboard protocol: `>Nu` pushes, `<u` pops, `=Nu` sets
//!   (the flags stack depth), plus `>4;Nm` modifyOtherKeys;
//! - SGR: the attribute state at exit must be empty (a dangling color
//!   would paint the shell's own output after the exit);
//! - OSC 8 hyperlinks: every open closed (a dangling open makes the
//!   shell's output a live link); one-shot OSC 52 clipboard writes and
//!   OSC 133 shell-integration markers are counted, not owed;
//! - writes the product does not own today — DECKPAM/DECKPNM
//!   (`ESC=`/`ESC>`), DECSCUSR cursor shapes, margin sets, OSC 0/2 title
//!   sets — any appearance is a finding, so the net catches a future
//!   surface arming one without its restore;
//! - the pty's termios (raw mode lives there, not in the byte stream):
//!   the whole flag set and control characters must return equal.
//!
//! The exit routes parameterize the table (the kitty-exit-leak lane's
//! enumeration): the parity exit (`/exit` and the Ctrl+C pair), the
//! detach handoff to the agents view, the agents-view returns (a fresh
//! entry and the roster-failure error route behind a preserved
//! handoff), the picker exits (the config selector's close, its
//! remapped exit, and the toggle error), the force-quit watchdog from a
//! wedged loop, the panic unwind (the replay surface's panic driver),
//! the error returns, the suspend cycle's mid-run release (the shell
//! gets the terminal while the process is stopped), and the pre-mount
//! daemon refusal (which must restore NOTHING — nothing was armed).
#![cfg(unix)]

use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;
use serde_json::{json, Value};

use pa_tui::agents_view::{AgentsViewOptions, AgentsViewUiMode};
use pa_tui::config_selector::{
    run_config_selector, ConfigSelector, ConfigSelectorOptions, SelectorRow,
};
use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

/// The kitty flags push (`1|2|4`, the TS `ProcessTerminal` set): the arm
/// proof every mounted surface must show.
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// The probe's capability query (`supports_keyboard_enhancement` sends
/// the flags query followed by the primary-device-attributes query).
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The harness's answer: flags `1|2|4` supported, then the primary
/// device attributes (what a kitty terminal replies with).
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The alt-screen leave: every route that ends the process writes it.
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";

/// The child-mode env: which surface this re-executed binary runs.
const CHILD_MODE_ENV: &str = "PA_DIFF_CHILD_MODE";
/// The mock-supervisor socket for the chat/view surfaces.
const CHILD_SOCKET_ENV: &str = "PA_DIFF_CHILD_SOCKET";
/// The replay fixture path (the replay child mode).
const CHILD_FIXTURE_ENV: &str = "PA_DIFF_CHILD_FIXTURE";
/// Replay child flags: `panic` (panic after the first paint).
const CHILD_REPLAY_FLAGS_ENV: &str = "PA_DIFF_CHILD_REPLAY_FLAGS";
/// Selector child flags: comma-separated `fail-toggle` and `remap-exit`.
const CHILD_SELECTOR_FLAGS_ENV: &str = "PA_DIFF_CHILD_SELECTOR_FLAGS";
/// TERM the children run with: a terminal that answers the kitty query
/// but takes no capability shortcut.
const CHILD_TERM: &str = "xterm-256color";

// ---------------------------------------------------------------------------
// The recording mock terminal's mode ledger
// ---------------------------------------------------------------------------

/// DEC private modes whose VT default is ON: the deviation is the `l`
/// write (25 = the cursor visible by default, 7 = autowrap on by
/// default). The differential is against the DEFAULT, so a mode left at
/// its default is clean however many times it flipped.
const DEFAULT_ON_MODES: [u32; 2] = [7, 25];

/// One DEC private mode's tally: how often the stream wrote it, and
/// whether it stands DEVIATING from its default at the end of the
/// scanned range (that is the leak: an `h`-armed mode never reset, or a
/// default-on mode never restored).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ModeTally {
    sets: usize,
    resets: usize,
    armed: bool,
}

/// The terminal-state ledger: the mock terminal's answer to "what did
/// the child change?". Fed a complete byte range (the whole stream, or
/// the range up to a mark for a mid-run snapshot), it models every
/// mode-affecting write so [`ModeLedger::assert_delta_empty`] can state
/// the differential: nothing the child armed is still armed.
#[derive(Debug, Default)]
struct ModeLedger {
    /// Every DEC private mode (`ESC[?NNNh`/`l`) the stream wrote.
    dec_modes: BTreeMap<u32, ModeTally>,
    /// The kitty keyboard protocol's flags stack (a push deepens it, a
    /// pop shallows it; the process must hand back depth zero).
    kitty_depth: usize,
    kitty_pushes: usize,
    kitty_pops: usize,
    /// The last kitty stack write was a push (a re-arm after the final
    /// pop — the exact leak shape the exit release guards).
    kitty_re_armed: bool,
    /// Absolute kitty sets (`ESC[=Nu`): the flags value left behind.
    kitty_sets: Vec<u32>,
    /// modifyOtherKeys (`ESC[>4;Nm`): the value left behind (zero is the
    /// reset; a nonzero value arms xterm encoding a shell would leak).
    modify_other_keys: u32,
    /// Other `ESC[>Nm` modify-form writes (cursor keys and friends): the
    /// product owns none, so any appearance is recorded as a finding.
    modify_forms: BTreeMap<String, u32>,
    /// The live SGR attribute state (fg/bg/colors/weight): must be empty
    /// at the end of the range.
    sgr_active: Vec<String>,
    /// The stream's last SGR write was a reset (the "SGR ends at reset"
    /// contract of the exit tail).
    sgr_ended_reset: bool,
    /// OSC 8 hyperlink opens minus closes (a dangling open wraps the
    /// shell's own output in the link).
    hyperlink_depth: usize,
    /// One-shot, state-free writes the ledger counts for the report.
    osc_52_writes: usize,
    osc_133_markers: usize,
    osc_1337_images: usize,
    /// Writes the product does not own: each is a finding.
    findings: Vec<String>,
}

impl ModeLedger {
    /// Scan a complete byte range (the child's output up to a mark).
    fn scan(&mut self, bytes: &[u8]) {
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] != 0x1b {
                at += 1;
                continue;
            }
            let Some(next) = bytes.get(at + 1) else {
                break;
            };
            match next {
                b'[' => at += self.scan_csi(&bytes[at..]),
                b']' => at += self.scan_osc(&bytes[at..]),
                b'=' => {
                    self.findings.push(
                        "DECKPAM written (keypad application mode): the product \
                         owns no restore for it"
                            .to_string(),
                    );
                    at += 2;
                }
                b'>' => {
                    self.findings.push(
                        "DECKPNM written (keypad numeric mode): the product \
                         owns no restore for it"
                            .to_string(),
                    );
                    at += 2;
                }
                b'_' => at += self.skip_dcs(&bytes[at..]),
                b'(' | b')' => {
                    // A charset designation to US ASCII (`ESC(B`/`ESC)B`) is
                    // the terminal's DEFAULT state — benign (a test runner's
                    // own reporter writes it). Any other charset left
                    // designated would repaint the shell's output in it.
                    let designated = bytes.get(at + 2).copied();
                    if designated != Some(b'B') {
                        self.findings.push(format!(
                            "charset designation {:?} written: the product \
                             owns no restore for it",
                            designated.map(|b| b as char)
                        ));
                    }
                    at += 3;
                }
                _ => at += 1,
            }
        }
    }

    /// One CSI sequence: `ESC[`, an optional private prefix
    /// (`? < = > !`), parameters, intermediates, then the final byte.
    /// Returns the bytes consumed.
    fn scan_csi(&mut self, bytes: &[u8]) -> usize {
        let mut at = 2;
        let prefix = bytes
            .get(at)
            .filter(|b| matches!(**b, b'?' | b'<' | b'=' | b'>' | b'!'))
            .copied();
        if prefix.is_some() {
            at += 1;
        }
        let params_start = at;
        while at < bytes.len() && matches!(bytes[at], b'0'..=b'9' | b';' | b':') {
            at += 1;
        }
        // Intermediates (0x20-0x2F) ride between the parameters and the
        // final byte — DECSCUSR (`ESC[2 SP q`) is the shape that uses one.
        while at < bytes.len() && (0x20..=0x2f).contains(&bytes[at]) {
            at += 1;
        }
        let Some(final_byte) = bytes.get(at).copied() else {
            // An unterminated tail: the range was cut mid-sequence (the
            // suspend snapshot's mark landed inside a paint). Nothing
            // state-affecting can hide in an unterminated sequence.
            return bytes.len();
        };
        let params = &bytes[params_start..at];
        at += 1;
        self.classify_csi(prefix, params, final_byte);
        at
    }

    fn classify_csi(&mut self, prefix: Option<u8>, params: &[u8], final_byte: u8) {
        match final_byte {
            b'h' | b'l' => {
                if prefix != Some(b'?') {
                    self.findings.push(format!(
                        "non-private mode {:?} wrote {:?}: unknown mode family, \
                         no restore is known",
                        String::from_utf8_lossy(params),
                        final_byte as char
                    ));
                    return;
                }
                let on = final_byte == b'h';
                for number in split_mode_params(params) {
                    let default_on = DEFAULT_ON_MODES.contains(&number);
                    let tally = self.dec_modes.entry(number).or_default();
                    if on {
                        tally.sets += 1;
                    } else {
                        tally.resets += 1;
                    }
                    tally.armed = on != default_on;
                }
            }
            b'm' => {
                if prefix == Some(b'>') {
                    self.classify_modify_other_keys(params);
                } else if prefix.is_none() {
                    self.classify_sgr(params);
                } else {
                    self.findings.push(format!(
                        "SGR write with private prefix {:?}: unknown family",
                        prefix.map(|b| b as char)
                    ));
                }
            }
            b'u' => match prefix {
                Some(b'>') => {
                    self.kitty_depth += 1;
                    self.kitty_pushes += 1;
                    self.kitty_re_armed = true;
                }
                Some(b'<') => {
                    self.kitty_pops += 1;
                    if self.kitty_depth > 0 {
                        self.kitty_depth -= 1;
                    }
                    self.kitty_re_armed = false;
                }
                Some(b'=') => {
                    let value = first_param(params).unwrap_or(0);
                    self.kitty_sets.push(value);
                    self.kitty_re_armed = value != 0;
                }
                Some(b'?') => {
                    // The capability query (`ESC[?u`): a question, not a
                    // mode write.
                }
                other => {
                    self.findings
                        .push(format!("kitty protocol form with unknown prefix {other:?}"));
                }
            },
            b'q' if !params.is_empty() => {
                let shape = first_param(params);
                self.findings.push(format!(
                    "DECSCUSR cursor-shape write (shape {shape:?}): the \
                     product arms no cursor-shape restore"
                ));
            }
            b'r' if !params.is_empty() => {
                self.findings.push(format!(
                    "DECSTBM margin write ({:?}): the product arms no margin \
                     restore",
                    String::from_utf8_lossy(params)
                ));
            }
            _ => {
                // Cursor positioning, clears, and device queries (`ESC[c`
                // DA1, `ESC[6n` DSR): no mode state to leak.
            }
        }
    }

    /// `ESC[>4;Nm`: modifyOtherKeys. The product only ever resets it (0);
    /// any other value left behind changes the shell's own key encodings.
    fn classify_modify_other_keys(&mut self, params: &[u8]) {
        let text = String::from_utf8_lossy(params).to_string();
        let mut parts = text.split(';');
        let resource = parts.next().unwrap_or_default().to_string();
        let value: u32 = parts.next().unwrap_or_default().parse().unwrap_or(0);
        match resource.as_str() {
            "4" => self.modify_other_keys = value,
            other => {
                *self.modify_forms.entry(other.to_string()).or_default() = value;
            }
        }
    }

    /// A plain SGR write: maintain the live attribute set.
    fn classify_sgr(&mut self, params: &[u8]) {
        let text = String::from_utf8_lossy(params);
        let mut parts = text.split(';').map(|part| {
            part.split(':')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string()
        });
        let first = parts.next().unwrap_or_default();
        if first.is_empty() {
            self.sgr_active.clear();
            self.sgr_ended_reset = true;
            return;
        }
        for part in std::iter::once(first).chain(parts) {
            let Ok(code) = part.parse::<u16>() else {
                continue;
            };
            let remove = |attrs: &mut Vec<String>, name: &str| {
                attrs.retain(|attr| attr != name);
            };
            match code {
                0 => {
                    self.sgr_active.clear();
                    self.sgr_ended_reset = true;
                }
                1 => push_unique(&mut self.sgr_active, "bold"),
                2 => push_unique(&mut self.sgr_active, "dim"),
                3 => push_unique(&mut self.sgr_active, "italic"),
                4 => push_unique(&mut self.sgr_active, "underline"),
                5 | 6 => push_unique(&mut self.sgr_active, "blink"),
                7 => push_unique(&mut self.sgr_active, "reverse"),
                8 => push_unique(&mut self.sgr_active, "conceal"),
                9 => push_unique(&mut self.sgr_active, "strike"),
                21 => push_unique(&mut self.sgr_active, "double-underline"),
                22 => {
                    remove(&mut self.sgr_active, "bold");
                    remove(&mut self.sgr_active, "dim");
                }
                23 => remove(&mut self.sgr_active, "italic"),
                24 => {
                    remove(&mut self.sgr_active, "underline");
                    remove(&mut self.sgr_active, "double-underline");
                }
                25 => remove(&mut self.sgr_active, "blink"),
                27 => remove(&mut self.sgr_active, "reverse"),
                28 => remove(&mut self.sgr_active, "conceal"),
                29 => remove(&mut self.sgr_active, "strike"),
                30..=38 | 90..=97 => push_unique(&mut self.sgr_active, "fg"),
                39 => remove(&mut self.sgr_active, "fg"),
                40..=48 | 100..=107 => push_unique(&mut self.sgr_active, "bg"),
                49 => remove(&mut self.sgr_active, "bg"),
                58 => push_unique(&mut self.sgr_active, "underline-color"),
                59 => remove(&mut self.sgr_active, "underline-color"),
                _ => {}
            }
        }
        self.sgr_ended_reset = self.sgr_active.is_empty();
    }

    /// One OSC sequence (`ESC]` to BEL or ST): the hyperlink state and
    /// the one-shot writes. Returns the bytes consumed.
    fn scan_osc(&mut self, bytes: &[u8]) -> usize {
        let mut at = 2;
        while at < bytes.len() {
            match bytes[at] {
                0x07 => {
                    self.classify_osc(&bytes[2..at]);
                    return at + 1;
                }
                0x1b if bytes.get(at + 1) == Some(&0x5c) => {
                    self.classify_osc(&bytes[2..at]);
                    return at + 2;
                }
                0x1b => {
                    // A raw ESC inside an OSC (no ST): the sequence was
                    // cut short — treat the OSC as unterminated content.
                    self.classify_osc(&bytes[2..at]);
                    return at;
                }
                _ => at += 1,
            }
        }
        self.classify_osc(&bytes[2..]);
        bytes.len()
    }

    fn classify_osc(&mut self, payload: &[u8]) {
        let text = String::from_utf8_lossy(payload);
        if text.starts_with("8;") {
            // `ESC]8;id;URL ST` opens (a URL present), `ESC]8;; ST` closes.
            let url = text.split(';').nth(2).unwrap_or_default();
            if url.trim().is_empty() {
                if self.hyperlink_depth > 0 {
                    self.hyperlink_depth -= 1;
                } else {
                    self.findings
                        .push("OSC 8 hyperlink close without an open".to_string());
                }
            } else {
                self.hyperlink_depth += 1;
            }
        } else if text.starts_with("52;") {
            self.osc_52_writes += 1;
        } else if text.starts_with("133;") {
            self.osc_133_markers += 1;
        } else if text.starts_with("1337;") {
            self.osc_1337_images += 1;
        } else if text.starts_with("0;") || text.starts_with("2;") {
            self.findings.push(format!(
                "window-title OSC write ({text:?}): the product owns no title \
                 restore"
            ));
        }
    }

    /// A DCS sequence (kitty graphics, `ESC_G ... ESC\`): image payload,
    /// no mode state. Returns the bytes consumed.
    fn skip_dcs(&mut self, bytes: &[u8]) -> usize {
        let mut at = 2;
        while at < bytes.len() {
            if bytes[at] == 0x1b && bytes.get(at + 1) == Some(&0x5c) {
                return at + 2;
            }
            at += 1;
        }
        bytes.len()
    }

    /// The differential's findings: every armed mode disarmed, the
    /// kitty stack popped, modifyOtherKeys reset, SGR empty, hyperlinks
    /// closed, no forbidden writes. The unit tests drive this directly
    /// with synthetic streams — the net's proof it catches a leak.
    fn leaks(&self) -> Vec<String> {
        let mut leaks: Vec<String> = Vec::new();
        for (number, tally) in &self.dec_modes {
            if tally.armed {
                let default_on = DEFAULT_ON_MODES.contains(number);
                leaks.push(format!(
                    "DEC private mode ?{number} left deviating from its \
                     default ({} on-write(s), {} off-write(s); the default \
                     is {})",
                    tally.sets,
                    tally.resets,
                    if default_on { "on" } else { "off" }
                ));
            }
        }
        if self.kitty_depth != 0 {
            leaks.push(format!(
                "kitty flags stack left at depth {} ({} push(es), {} pop(s))",
                self.kitty_depth, self.kitty_pushes, self.kitty_pops
            ));
        }
        if self.kitty_re_armed {
            leaks.push(
                "the stream's last kitty stack write is a push (re-armed after \
                 the final pop)"
                    .to_string(),
            );
        }
        for value in &self.kitty_sets {
            if *value != 0 {
                leaks.push(format!(
                    "kitty flags left set absolutely to {value} (ESC[=Nu)"
                ));
            }
        }
        if self.modify_other_keys != 0 {
            leaks.push(format!(
                "modifyOtherKeys left at mode {} (0 is the reset)",
                self.modify_other_keys
            ));
        }
        for (resource, value) in &self.modify_forms {
            if *value != 0 {
                leaks.push(format!(
                    "modify resource >{resource};{value} written: the product \
                     owns no restore for it"
                ));
            }
        }
        if !self.sgr_active.is_empty() {
            leaks.push(format!(
                "SGR attributes left active: [{}] (the shell's own output \
                 would paint with them)",
                self.sgr_active.join(", ")
            ));
        }
        if self.hyperlink_depth != 0 {
            leaks.push(format!(
                "OSC 8 hyperlink left open (depth {}): the shell's own output \
                 becomes the link's label",
                self.hyperlink_depth
            ));
        }
        leaks.extend(self.findings.iter().cloned());
        leaks
    }

    /// The differential itself (the route assertions): the findings
    /// must be empty. `context` names the route in the failure message.
    fn assert_delta_empty(&self, context: &str) {
        let leaks = self.leaks();
        assert!(
            leaks.is_empty(),
            "{context}: the terminal-state differential leaked: {}",
            leaks.join("; ")
        );
    }
}

fn push_unique(attrs: &mut Vec<String>, name: &str) {
    if !attrs.iter().any(|attr| attr == name) {
        attrs.push(name.to_string());
    }
}

/// The `;`-separated mode numbers of a DEC private mode write
/// (`ESC[?1002h`, `ESC[?1002;1006h`).
fn split_mode_params(params: &[u8]) -> Vec<u32> {
    String::from_utf8_lossy(params)
        .split(';')
        .filter_map(|part| part.split(':').next().and_then(|p| p.trim().parse().ok()))
        .collect()
}

fn first_param(params: &[u8]) -> Option<u32> {
    String::from_utf8_lossy(params)
        .split(';')
        .next()
        .and_then(|part| part.split(':').next())
        .and_then(|part| part.trim().parse().ok())
}

// ---------------------------------------------------------------------------
// The ledger's negative controls: synthetic streams prove the net catches
// every leak class before the product ever regresses into one.
// ---------------------------------------------------------------------------

/// Scan a synthetic stream and return the findings.
fn findings_of(stream: &[u8]) -> Vec<String> {
    let mut ledger = ModeLedger::default();
    ledger.scan(stream);
    ledger.leaks()
}

#[test]
fn the_ledger_passes_the_balanced_restore() {
    // The exact write set of a whole mount/exit session: every mode
    // armed, every mode restored, the kitty push popped, the SGR reset.
    let stream = concat!(
        "\x1b[?1049h\x1b[?2004h\x1b[>4;0m\x1b[?u\x1b[c\x1b[>7u", // mount + probe
        "\x1b[?1002h\x1b[?1003h\x1b[?1006h",                     // mouse
        "\x1b[?2026h\x1b[38;5;1mrow\x1b[0m\x1b[?25l\x1b[?2026l", // one frame
        "\x1b[<u\x1b[>4;0m\x1b[?2004l",                          // drain
        "\x1b[?1006l\x1b[?1003l\x1b[?1002l",                     // mouse off
        "\x1b[?1049l\x1b[?2026l\x1b[0m\x1b[?25h",                // the tail
    );
    assert!(
        findings_of(stream.as_bytes()).is_empty(),
        "the balanced session leaked"
    );
}

#[test]
fn the_ledger_catches_a_leaked_mouse_mode() {
    // The mouse enable with NO disable: the classic leak.
    let stream = b"\x1b[?1002h\x1b[?1003h\x1b[?1006h";
    let findings = findings_of(stream);
    assert!(
        findings.iter().any(|f| f.contains("?1002")),
        "the leaked mouse mode went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_an_unknown_leaked_mode() {
    // Focus reporting (?1004): a mode the product never writes — the
    // net must catch it anyway the day a future surface arms it.
    let findings = findings_of(b"\x1b[?1004h");
    assert!(
        findings.iter().any(|f| f.contains("?1004")),
        "the unknown leaked mode went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_a_default_on_mode_left_off() {
    // Cursor visibility: the default is ON (`?25h`); a session that
    // hides (`?25l`) and never shows again leaves it deviating.
    let findings = findings_of(b"\x1b[?25l");
    assert!(
        findings.iter().any(|f| f.contains("?25")),
        "the hidden cursor went unnoticed: {findings:?}"
    );
    // The balanced pair is clean.
    assert!(
        findings_of(b"\x1b[?25l\x1b[?25h").is_empty(),
        "the shown-back cursor leaked"
    );
}

#[test]
fn the_ledger_catches_a_kitty_re_arm_after_the_pop() {
    // A push after the final pop: the exact "answer lands around the
    // exit" leak shape the exit release guards.
    let stream = b"\x1b[>7u\x1b[<u\x1b[>7u";
    let findings = findings_of(stream);
    assert!(
        findings.iter().any(|f| f.contains("kitty")),
        "the re-armed kitty stack went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_a_dangling_sgr() {
    // A styled write with no reset: the shell's own output would paint
    // in the dangling color.
    let findings = findings_of(b"\x1b[38;5;1mred");
    assert!(
        findings.iter().any(|f| f.contains("SGR")),
        "the dangling SGR went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_a_dangling_hyperlink() {
    // An OSC 8 open with no close: the shell's output becomes the link.
    let findings = findings_of(b"\x1b]8;;https://example.com\x1b\\link");
    assert!(
        findings.iter().any(|f| f.contains("hyperlink")),
        "the dangling hyperlink went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_forbidden_writes() {
    // Keypad mode, a cursor shape, and a title set: writes the product
    // owns no restore for.
    let findings = findings_of(b"\x1b=\x1b[2 q\x1b]0;title\x07");
    assert!(
        findings.iter().any(|f| f.contains("DECKPAM")),
        "the keypad write went unnoticed: {findings:?}"
    );
    assert!(
        findings.iter().any(|f| f.contains("DECSCUSR")),
        "the cursor shape went unnoticed: {findings:?}"
    );
    assert!(
        findings.iter().any(|f| f.contains("window-title")),
        "the title write went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_an_absolute_kitty_set_left_on() {
    // `ESC[=Nu` (an absolute set, not a stack push) left nonzero.
    let findings = findings_of(b"\x1b[=5u");
    assert!(
        findings.iter().any(|f| f.contains("absolutely")),
        "the absolute kitty set went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_modify_other_keys_left_armed() {
    // modifyOtherKeys mode 2 (xterm encoding) left armed.
    let findings = findings_of(b"\x1b[>4;2m");
    assert!(
        findings.iter().any(|f| f.contains("modifyOtherKeys")),
        "the modifyOtherKeys arm went unnoticed: {findings:?}"
    );
}

// ---------------------------------------------------------------------------
// The pty harness
// ---------------------------------------------------------------------------

/// One pty-backed product child: a mock-supervisor socket it attaches
/// to (when the surface needs one), a raw pty whose master the harness
/// reads non-blockingly, and a termios snapshot taken before the child
/// spawns (the raw-mode differential rides on it).
struct DifferentialHarness {
    child: Child,
    master: PtyReader,
    /// The mock-supervisor listener the harness owns (a route may shut
    /// it down to refuse later connections).
    listener: Option<std::os::unix::net::UnixListener>,
    _server: Option<std::thread::JoinHandle<()>>,
    /// The mock socket's path (the refusal determinism polls it).
    socket_path: PathBuf,
    /// The pty's termios before the child spawned.
    before: Termios,
}

impl DifferentialHarness {
    /// Spawn a child (this binary re-executed in a child mode) on a
    /// fresh pty against a mock supervisor that answers every daemon
    /// request except the ones a route stalls.
    fn start(spec: ChildSpec) -> DifferentialHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind mock socket");
        let server = std::thread::spawn({
            let listener = listener.try_clone().expect("clone mock listener");
            let stall = spec.stall;
            move || MockSupervisor::serve(listener, stall)
        });

        let pty = openpty(
            Some(&Winsize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .expect("open pty");
        let before = Termios::capture(pty.master.as_raw_fd());
        let child = spawn_child(&spec, &socket, &pty.slave);
        // The child needs the socket and the temp dir for its lifetime;
        // the whole tree dies with the child at teardown.
        std::mem::forget(dir);
        DifferentialHarness {
            child,
            master: PtyReader::new(pty.master),
            listener: Some(listener),
            _server: Some(server),
            socket_path: socket,
            before,
        }
    }

    fn mark(&self) -> usize {
        self.master.mark()
    }

    fn write(&mut self, payload: &[u8]) {
        self.master.write(payload);
    }

    /// A write that tolerates the child being gone (the late-answer
    /// route's answer can race the process death — when the child is
    /// already out, there is no terminal left to re-arm).
    fn try_write(&mut self, payload: &[u8]) {
        self.master.try_write(payload);
    }

    fn wait_from_start(&mut self, needle: &[u8], what: &str) {
        self.master.wait_from(0, needle, what);
    }

    fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        self.master.wait_from(mark, needle, what);
    }

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    fn wait_child_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().ok().flatten() {
                return status.code();
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Answer the kitty query like a kitty terminal: wait for the query
    /// and require the flags push before anything else.
    fn answer_kitty_query(&mut self) {
        self.wait_from_start(KITTY_QUERY, "the kitty capability query");
        self.write(KITTY_ANSWER);
        self.wait_from_start(KITTY_FLAGS_PUSH, "the kitty flags push");
    }

    /// Refuse every later daemon connection (the roster-failure route:
    /// the agents view's connect behind the chat handoff fails).
    /// Shutting the listener's socket down fails the serve thread's
    /// pending accept; the thread then drops its listener, and once no
    /// live descriptor remains every later connect gets ECONNREFUSED.
    /// Already-served connections (the chat's) stay alive on their own
    /// threads. The refusal is polled to determinism: the route proceeds
    /// only once the socket truly refuses.
    fn refuse_later_connections(&mut self) {
        if let Some(listener) = self.listener.take() {
            // SAFETY: `shutdown` only invalidates the listening socket's
            // accept queue — the harness owns it and serves nothing on it.
            unsafe {
                libc::shutdown(listener.as_raw_fd(), libc::SHUT_RDWR);
            }
            drop(listener);
            let socket = self.socket_path.clone();
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if std::os::unix::net::UnixStream::connect(&socket).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("the harness could not refuse later connections in time");
        }
    }

    /// The whole-route assertion: the child exited, the byte stream is
    /// drained, and the terminal state it leaves equals the state it
    /// received — the mode ledger is empty AND the pty's termios is
    /// byte-equal to the pre-spawn snapshot.
    fn assert_terminal_state_restored(&mut self, context: &str) {
        self.drain_until_quiet(10);
        let stream = self.output();
        // Failure triage: keep the recorded tape next to the run.
        std::fs::write(
            std::env::temp_dir().join("terminal-state-differential-stream.bin"),
            &stream,
        )
        .ok();
        let mut ledger = ModeLedger::default();
        ledger.scan(&stream);
        ledger.assert_delta_empty(context);
        let after = Termios::capture(self.master.file.as_raw_fd());
        assert!(
            self.before.delta_is_empty(&after),
            "{context}: the pty's termios changed: before {:?} after {:?}",
            self.before.describe(),
            after.describe()
        );
    }
}

impl Drop for DifferentialHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child: it owns the
        // controlling terminal of its own session and outlives the
        // harness.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The pty harnesses serialize: each drives process-group signals and a
/// raw pty; concurrent byte-level waits flake on the shared sandbox CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn harness_lock() -> std::sync::MutexGuard<'static, ()> {
    match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Non-blocking reader over the pty master, collecting the raw byte
/// stream the child writes (the recording mock terminal's tape).
struct PtyReader {
    file: std::fs::File,
    output: Vec<u8>,
}

impl PtyReader {
    fn new(master: OwnedFd) -> PtyReader {
        let fd = master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK)).expect("pty master non-blocking");
        PtyReader {
            file: master.into(),
            output: Vec::new(),
        }
    }

    fn mark(&self) -> usize {
        self.output.len()
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// A write that tolerates the child being gone: a closed pty master
    /// fails with EIO, and the route that injects an answer around the
    /// exit treats "the child died first" as no answer, not a failure.
    fn try_write(&mut self, payload: &[u8]) {
        let _ = self.file.write_all(payload);
        let _ = self.file.flush();
    }

    /// Drain the master until it goes quiet for `quiet_polls` consecutive
    /// polls: a settle window keeps every later byte.
    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        let mut quiet = 0;
        while quiet < quiet_polls {
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => quiet += 1,
                Ok(n) => {
                    self.output.extend_from_slice(&buffer[..n]);
                    quiet = 0;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Drain the master until the needle appears in the output collected
    /// since the given mark, bounded by a generous harness deadline.
    fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if find_subsequence(&self.output[mark..], needle).is_some() {
                return;
            }
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => {}
                Ok(n) => self.output.extend_from_slice(&buffer[..n]),
            }
            if Instant::now() > deadline {
                let text = String::from_utf8_lossy(&self.output[mark..]);
                panic!(
                    "timeout waiting for {what} (needle {needle:?}); pty tail \
                     since mark:\n{text}"
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------
// The termios differential
// ---------------------------------------------------------------------------

/// The pty's line-discipline state (raw mode lives here — the escape
/// stream cannot show it). Captured via the master fd: a pty pair shares
/// one termios, so the master reads the slave's line discipline.
struct Termios {
    iflag: libc::tcflag_t,
    oflag: libc::tcflag_t,
    cflag: libc::tcflag_t,
    lflag: libc::tcflag_t,
    line: libc::cc_t,
    cc: [libc::cc_t; libc::NCCS],
}

impl Termios {
    fn capture(fd: std::os::fd::RawFd) -> Termios {
        let mut raw: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: `tcgetattr` only reads the line discipline into `raw`.
        let rc = unsafe { libc::tcgetattr(fd, &mut raw) };
        assert!(rc == 0, "the harness could not read the pty's termios");
        Termios {
            iflag: raw.c_iflag,
            oflag: raw.c_oflag,
            cflag: raw.c_cflag,
            lflag: raw.c_lflag,
            line: raw.c_line,
            cc: raw.c_cc,
        }
    }

    fn delta_is_empty(&self, other: &Termios) -> bool {
        self.iflag == other.iflag
            && self.oflag == other.oflag
            && self.cflag == other.cflag
            && self.lflag == other.lflag
            && self.line == other.line
            && self.cc == other.cc
    }

    fn describe(&self) -> String {
        format!(
            "iflag={:#x} oflag={:#x} cflag={:#x} lflag={:#x}",
            self.iflag, self.oflag, self.cflag, self.lflag
        )
    }
}

// ---------------------------------------------------------------------------
// The mock supervisor
// ---------------------------------------------------------------------------

/// One attached session behind a mock supervisor socket (the frame
/// contract the kitty-release e2e harness serves): `daemon_hello`, a
/// `create` + `attach` pair with a small transcript, and a catch-all
/// for everything else. The stalled command types (`list`) are answered
/// by silence — the bounded request hangs, the loop wedges, and the
/// force-quit watchdog has its case.
struct MockSupervisor;

impl MockSupervisor {
    /// One listener, every connection served on its own thread: the
    /// accept loop must never block inside a connection (a shutdown of
    /// the listener fails the pending accept instantly — the
    /// roster-failure route's refusal is deterministic), and a served
    /// connection (the chat's) stays alive while the loop moves on.
    fn serve(listener: std::os::unix::net::UnixListener, stall: &'static [&'static str]) {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    std::thread::spawn(move || Self::serve_connection(stream, stall));
                }
                Err(_) => return,
            }
        }
    }

    fn serve_connection(stream: std::os::unix::net::UnixStream, stall: &'static [&'static str]) {
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = std::io::BufReader::new(stream);
        write_json(
            &mut writer,
            &json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "serverCapabilities": [],
                "clientId": "mock",
            }),
        );
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let id = envelope.get("id").and_then(Value::as_str).unwrap_or("");
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if stall.contains(&command_type.as_str()) {
                // Answered by silence: the caller's bounded request hangs
                // (the force-quit route's wedge).
                continue;
            }
            match command_type.as_str() {
                "create" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "create",
                            "success": true,
                            "data": {
                                "activeSessionId": "s1",
                                "id": "s1",
                                "sessionId": "sess-1",
                                "sessionFile": "/tmp/sess-1.jsonl",
                            },
                        }),
                    );
                }
                "attach" => {
                    write_json(&mut writer, &attach_data(id));
                }
                _ => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": command_type,
                            "success": true,
                            "data": {},
                        }),
                    );
                }
            }
        }
    }
}

fn write_json(writer: &mut std::os::unix::net::UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The attach snapshot: a small transcript whose last row carries a URL,
/// so the paint (and the exit flush) exercise the OSC 8 hyperlink pairs
/// the ledger balances.
fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..4)
        .map(|index| {
            let text = if index == 3 {
                "row 3 https://example.com/diff".to_string()
            } else {
                format!("row {index}")
            };
            json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{ "type": "text", "text": text }],
            })
        })
        .collect();
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "s1",
            "snapshot": {
                "activeSessionId": "s1",
                "summary": { "id": "s1", "cwd": "/tmp" },
                "state": {
                    "activeSessionId": "s1",
                    "cwd": "/tmp",
                    "sessionId": "sess-1",
                    "sessionName": "terminal state differential",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}

// ---------------------------------------------------------------------------
// The child modes (this binary re-executed as the product under test)
// ---------------------------------------------------------------------------

/// One child route's spawn spec: the surface mode, the daemon commands
/// the mock answers by silence (the force-quit wedge), and the extra
/// env the mode reads (the replay fixture, the selector flags).
struct ChildSpec {
    mode: &'static str,
    stall: &'static [&'static str],
    env: Vec<(&'static str, String)>,
}

impl ChildSpec {
    fn new(mode: &'static str) -> ChildSpec {
        ChildSpec {
            mode,
            stall: &[],
            env: Vec::new(),
        }
    }

    fn stall(mut self, stall: &'static [&'static str]) -> ChildSpec {
        self.stall = stall;
        self
    }

    fn env(mut self, key: &'static str, value: impl Into<String>) -> ChildSpec {
        self.env.push((key, value.into()));
        self
    }
}

/// A child of this very binary, re-executed with the pty slave as its
/// terminal — and its CONTROLLING terminal (`setsid` + `TIOCSCTTY`):
/// crossterm's raw-mode and event reads go through `/dev/tty`, which
/// must be the pty regardless of the runner's own session.
fn spawn_child(spec: &ChildSpec, socket: &Path, slave: &OwnedFd) -> Child {
    // Runs between fork and exec in the child: become a session leader
    // and claim the pty slave as the controlling terminal.
    fn claim_controlling_tty(fd: i32) -> std::io::Result<()> {
        nix::unistd::setsid()?;
        let rc = unsafe { libc::ioctl(fd, libc::TIOCSCTTY as libc::c_ulong, 0) };
        if rc < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    let slave_fd = slave.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .arg("--exact")
        .arg(child_mode_test_name(spec.mode))
        .env(CHILD_MODE_ENV, spec.mode)
        .env(CHILD_SOCKET_ENV, socket);
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    command
        .env("TERM", CHILD_TERM)
        .env_remove("TMUX")
        .env_remove("STY")
        .env_remove("ZELLIJ")
        .env_remove("SSH_CONNECTION")
        .env_remove("SSH_TTY")
        .env_remove("KITTY_WINDOW_ID")
        .env_remove("GHOSTTY_RESOURCES_DIR")
        .env_remove("WEZTERM_PANE")
        .env_remove("TERM_PROGRAM")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    // SAFETY: the pre_exec hook is the supported std seam for
    // session/terminal setup; it runs post-fork pre-exec in the child
    // only and cannot allocate.
    unsafe {
        command.pre_exec(move || claim_controlling_tty(slave_fd));
    }
    command.spawn().expect("spawn pty child")
}

fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

fn child_mode_test_name(mode: &str) -> &'static str {
    match mode {
        "chat" => "diff_chat_child_mode",
        "view" => "diff_view_child_mode",
        "selector" => "diff_selector_child_mode",
        "replay" => "diff_replay_child_mode",
        other => panic!("unknown child mode {other}"),
    }
}

/// Silence the child-mode run's own epilogue: libtest prints its result
/// lines AFTER the surface fn returns, and its reporter writes SGR
/// colors and `ESC(B` charset designations on the same pty the
/// differential audits. The PRODUCT's bytes are done by then; the
/// reporter's are noise — redirect stdout and stderr to /dev/null so
/// the recorded tape ends at the surface's own restore.
fn quiet_child_epilogue() {
    let null = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/null")
        .expect("/dev/null");
    // SAFETY: dup2 only swaps this process's fd 1/2 after the surface
    // work is done; the pty slave behind them stays owned by the
    // harness's master.
    unsafe {
        libc::dup2(null.as_raw_fd(), 1);
        libc::dup2(null.as_raw_fd(), 2);
    }
}

fn child_options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: true,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

fn view_options(socket: PathBuf, anchor: Option<String>) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: anchor,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    }
}

/// The chat child: the real interactive surface against the harness's
/// mock supervisor, then — when the exit came through agents-back — the
/// agents view anchored on the session just left (the CLI composition's
/// `return_to_agents_view` arm). A roster-link failure on that second
/// surface returns quietly: the route's essence is the restore the
/// error path owes, not the child's exit code.
#[test]
fn diff_chat_child_mode() {
    let Some(socket) = std::env::var(CHILD_SOCKET_ENV).ok() else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let outcome = runtime
        .block_on(run_interactive(options.clone(), UiMode::Terminal))
        .expect("the chat surface ran");
    if outcome.return_to_agents_view {
        let anchor = (!outcome.session_id.is_empty()).then(|| outcome.session_id.clone());
        let view_options = view_options(options.socket_path, anchor);
        let view = runtime.block_on(pa_tui::agents_view::run_agents_view(
            view_options,
            AgentsViewUiMode::Terminal,
            None,
        ));
        if let Ok(view) = view {
            if let Some(link) = view.link {
                link.close();
            }
        }
    }
    quiet_child_epilogue();
}

/// The agents-view child: a fresh view run (the `prime-agent` roster
/// surface). A roster-link failure returns quietly (the error-route
/// restore still ran); a normal run closes the carried link.
#[test]
fn diff_view_child_mode() {
    let Some(socket) = std::env::var(CHILD_SOCKET_ENV).ok() else {
        return;
    };
    let options = view_options(PathBuf::from(socket), None);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let view = runtime.block_on(pa_tui::agents_view::run_agents_view(
        options,
        AgentsViewUiMode::Terminal,
        None,
    ));
    if let Ok(view) = view {
        if let Some(link) = view.link {
            link.close();
        }
    }
    quiet_child_epilogue();
}

/// The picker child: the config-selector surface over a fixed row set
/// (the CLI `config` command's picker without the package resolution).
/// The route's flags arm the two variants: a failing `on_toggle` (the
/// error route) and a remapped `app.clear` binding (the exit route).
#[test]
fn diff_selector_child_mode() {
    if std::env::var(CHILD_MODE_ENV).ok().as_deref() != Some("selector") {
        return;
    }
    let flags = std::env::var(CHILD_SELECTOR_FLAGS_ENV).unwrap_or_default();
    let fail_toggle = flags.split(',').any(|flag| flag == "fail-toggle");
    let remap_exit = flags.split(',').any(|flag| flag == "remap-exit");

    let rows = vec![
        SelectorRow::Group("Resources".to_string()),
        SelectorRow::Item {
            key: "0".to_string(),
            label: "kernel".to_string(),
            checked: true,
            type_label: "tool".to_string(),
            path: "pa-core/kernel".to_string(),
        },
    ];
    let selector = ConfigSelector::new(rows);
    let theme = pa_tui::app::load_theme("prime");
    let keybindings = if remap_exit {
        let mut bindings = pa_tui::keybindings::KeybindingsConfig::new();
        bindings.insert("app.clear".to_string(), vec!["ctrl+q".to_string()]);
        pa_tui::keybindings::KeybindingsManager::with_user_bindings(bindings)
    } else {
        pa_tui::keybindings::KeybindingsManager::new()
    };
    let options = ConfigSelectorOptions::new(theme, keybindings);
    let mut on_toggle = move |_key: &str, _enabled: bool| -> anyhow::Result<()> {
        if fail_toggle {
            anyhow::bail!("the toggle persistence failed (the error route)");
        }
        Ok(())
    };
    let _ = run_config_selector(selector, options, &mut on_toggle);
    quiet_child_epilogue();
}

/// The replay child: the replay surface (`pa-tui-replay`'s live mode)
/// over a fixture the harness wrote. The `panic` flag runs the
/// exit-restore verifier's panic driver (a real unwind on a live
/// surface).
#[test]
fn diff_replay_child_mode() {
    let Some(fixture) = std::env::var(CHILD_FIXTURE_ENV).ok() else {
        return;
    };
    let flags = std::env::var(CHILD_REPLAY_FLAGS_ENV).unwrap_or_default();
    let panic_after_frame = flags.split(',').any(|flag| flag == "panic");
    let stream =
        pa_tui::session::JsonlSessionStream::from_path(Path::new(&fixture)).expect("fixture");
    let options = pa_tui::app::AppOptions {
        theme: "prime".to_string(),
        panic_after_frame,
        ..Default::default()
    };
    let _ = pa_tui::app::run_app(Box::new(stream), options, Box::new(|_text| {}));
    quiet_child_epilogue();
}

/// The fixture session the replay child runs: a small transcript with a
/// URL row (the OSC 8 hyperlink pairs).
fn write_replay_fixture() -> String {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let path = dir.path().join("fixture.jsonl");
    let fixture = concat!(
        r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"replay row 0"}],"timestamp":1}}"#,
        "\n",
        r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"replay row 1 https://example.com/replay"}],"api":"faux:1","provider":"faux","model":"faux-1","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}"#,
        "\n",
    );
    std::fs::write(&path, fixture).expect("write fixture");
    // The child reads the file across the process boundary: keep the
    // directory for the child's lifetime (the harness tears the whole
    // tree down with the child).
    std::mem::forget(dir);
    path.display().to_string()
}

// ---------------------------------------------------------------------------
// The exit-route table (the parameterized differential)
// ---------------------------------------------------------------------------

/// Route: the parity exit through the `/exit` slash command. The normal
/// quit: the drain, the mode releases, the alt-screen leave with the
/// inline transcript flush, and the shared release tail.
#[test]
fn parity_exit_through_slash_command_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    let mark = harness.mark();
    harness.write(b"/exit\r");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the parity exit"
    );

    harness.assert_terminal_state_restored("the parity exit (/exit)");
}

/// Route: the parity exit through the Ctrl+C pair (the operator's
/// gesture): the first press arms the exit hint, the second exits, and
/// the same teardown tail runs.
#[test]
fn parity_exit_through_the_ctrl_c_pair_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    let mark = harness.mark();
    harness.write(b"\x03");
    harness.drain_until_quiet(4);
    harness.write(b"\x03");
    harness.wait_from(mark, ALT_SCREEN_LEAVE, "the ctrl+c pair exited the surface");
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the ctrl+c pair"
    );

    harness.assert_terminal_state_restored("the parity exit (the ctrl+c pair)");
}

/// Route: the detach handoff to the agents view — the pane hands to a
/// second surface of the same process (the alt screen and raw mode stay
/// by design), and the VIEW's exit then releases everything. The
/// differential runs over the whole chain: the process exits with the
/// terminal it launched with.
#[test]
fn the_detach_handoff_then_the_view_exit_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // The handoff: the LEFT press (the kitty lane's same gesture).
    let mark = harness.mark();
    harness.write(b"\x1b[D");
    harness.wait_from(
        mark,
        b"Search sessions",
        "the agents view mounts behind the handoff",
    );
    // The view's exit: Esc with an empty query.
    harness.write(b"\x1b[27u");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the view's exit released the terminal",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the view exit"
    );

    harness.assert_terminal_state_restored("the detach handoff (chat -> view -> exit)");
}

/// Route: the force-quit watchdog from a wedged loop. The mock stalls
/// the `/list` request (answered by silence); the loop wedges in its
/// 10s bound; the Ctrl+C pair arms the 1.5s watchdog; the watchdog
/// fires the one best-effort restore and `exit(0)`s the process — the
/// terminal must come back whole from the watchdog's own byte order.
#[test]
fn the_force_quit_watchdog_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat").stall(&["list"]));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // Wedge the loop in the stalled request, then arm the watchdog.
    harness.write(b"/list\r");
    harness.drain_until_quiet(4);
    harness.write(b"\x03");
    harness.write(b"\x03");
    harness.wait_from_start(
        ALT_SCREEN_LEAVE,
        "the force-quit restore left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the watchdog force-quit exited the process cleanly"
    );

    harness.assert_terminal_state_restored("the force-quit watchdog");
}

/// Route: the agents view's fresh entry (the `prime-agent` roster
/// surface on its own process), exited through Esc.
#[test]
fn the_agents_view_fresh_exit_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("view"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"Search sessions", "the agents view mounts");

    let mark = harness.mark();
    harness.write(b"\x1b[27u");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the view's exit released the terminal",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the view exit"
    );

    harness.assert_terminal_state_restored("the agents view's fresh exit");
}

/// Route: the agents-view error return behind a preserved handoff — the
/// roster link fails while the pane is already in TUI state (the chat's
/// teardown preserved the screen), so the surface's own release must
/// hand the terminal back before the error escapes (TS
/// `returnToAgentsView`'s `finally`).
#[test]
fn the_agents_view_roster_failure_behind_a_handoff_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // Refuse every later connection: the handoff's view connect fails.
    harness.refuse_later_connections();

    let mark = harness.mark();
    harness.write(b"\x1b[D");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the failed handoff released the terminal",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(30));
    assert_eq!(exit, Some(0), "the child exited after the roster failure");

    harness.assert_terminal_state_restored("the agents view's roster failure behind a handoff");
}

/// Route: the picker's close (Esc) — the config selector's picker exit
/// through the close arm (restore, then a clean return).
#[test]
fn the_config_selector_esc_close_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("selector"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"Resource Configuration", "the selector mounts");

    let mark = harness.mark();
    harness.write(b"\x1b");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the selector's close left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the child exited cleanly through the close");

    harness.assert_terminal_state_restored("the config selector's Esc close");
}

/// Route: the picker's exit action (a remapped `app.clear` rides
/// ctrl+q): the selector's own exit arm runs the restore and exits the
/// process from inside the surface loop.
#[test]
fn the_config_selector_remapped_exit_action_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(
        ChildSpec::new("selector").env(CHILD_SELECTOR_FLAGS_ENV, "remap-exit"),
    );
    harness.answer_kitty_query();
    harness.wait_from_start(b"Resource Configuration", "the selector mounts");

    let mark = harness.mark();
    harness.write(b"\x11");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the selector's exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the exit action"
    );

    harness.assert_terminal_state_restored("the config selector's remapped exit action");
}

/// Route: the picker's error return — the toggle's persistence fails,
/// the surface loop unwinds through the one error restore, and the
/// error escapes to the caller with the terminal whole.
#[test]
fn the_config_selector_toggle_error_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(
        ChildSpec::new("selector").env(CHILD_SELECTOR_FLAGS_ENV, "fail-toggle"),
    );
    harness.answer_kitty_query();
    harness.wait_from_start(b"Resource Configuration", "the selector mounts");

    let mark = harness.mark();
    harness.write(b" ");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the error return left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the child exited after the toggle error");

    harness.assert_terminal_state_restored("the config selector's toggle error");
}

/// Route: the replay surface's clean exit (ctrl+c): the replay mount's
/// modes (raw, alt screen, enhanced keys) release through the replay
/// loop's own exit restore.
#[test]
fn the_replay_surface_clean_exit_restores_every_mode() {
    let _lock = harness_lock();
    let fixture = write_replay_fixture();
    let mut harness =
        DifferentialHarness::start(ChildSpec::new("replay").env(CHILD_FIXTURE_ENV, fixture));
    harness.answer_kitty_query();
    harness.wait_from_start(b"replay row 0", "the replay surface mounted");

    let mark = harness.mark();
    harness.write(b"\x03");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the replay exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the replay child exited cleanly");

    harness.assert_terminal_state_restored("the replay surface's clean exit");
}

/// Route: the panic unwind. The replay surface's panic driver (`--panic-
/// exit`'s port) panics mid-loop after the first paint; the unwind
/// crosses the surface's unwind guard, the one exit restore runs, and
/// the process dies with the terminal whole — the exact contract the
/// guard exists for.
#[test]
fn the_panic_unwind_restores_every_mode() {
    let _lock = harness_lock();
    let fixture = write_replay_fixture();
    let mut harness = DifferentialHarness::start(
        ChildSpec::new("replay")
            .env(CHILD_FIXTURE_ENV, fixture)
            .env(CHILD_REPLAY_FLAGS_ENV, "panic"),
    );
    // The panic fires at the FIRST draw — before the kitty probe's
    // support check can even write its query, the exit release stands
    // the probe down (`release_for_exit`'s contract: no query, no
    // answer, no push). The route does not answer or require the
    // query; the ledger's kitty assertions prove the protocol clean
    // either way (a push that raced in ahead of the panic is popped by
    // the drain; one that lands after is refused by the standdown).
    harness.wait_from_start(b"replay row 0", "the replay surface mounted");

    harness.wait_from_start(
        ALT_SCREEN_LEAVE,
        "the unwind guard's restore left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(101),
        "the panic child died with the unwind's exit code (got {exit:?})"
    );

    harness.assert_terminal_state_restored("the panic unwind");
}

/// Route: the pre-mount daemon refusal. The child's daemon connect
/// fails (the harness never starts a supervisor for it), the run errors
/// BEFORE any terminal state is armed, and the error path must restore
/// NOTHING — the caller's terminal (the harness's pty) must be exactly
/// as it was, with zero mode writes in the stream.
#[test]
fn the_pre_mount_daemon_refusal_arms_nothing() {
    let _lock = harness_lock();
    // A socket path nothing listens on: the connect retries its three
    // attempts and surfaces the error before any mount.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("dead.sock");
    let pty = openpty(
        Some(&Winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }),
        None,
    )
    .expect("open pty");
    let before = Termios::capture(pty.master.as_raw_fd());
    let mut child = spawn_child(&ChildSpec::new("chat"), &socket, &pty.slave);
    let mut reader = PtyReader::new(pty.master);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let mut buffer = [0u8; 8192];
        match reader.file.read(&mut buffer) {
            Ok(0) | Err(_) => {}
            Ok(n) => reader.output.extend_from_slice(&buffer[..n]),
        }
        if child.try_wait().ok().flatten().is_some() || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let status = child.try_wait().ok().flatten();
    assert!(
        status.is_some(),
        "the refused child exited within the budget"
    );

    // Nothing armed: the stream carries no mode writes at all (the
    // error path must not tear down a terminal it never owned).
    let mut ledger = ModeLedger::default();
    ledger.scan(&reader.output);
    assert!(
        ledger.dec_modes.is_empty() && ledger.kitty_pushes == 0 && ledger.kitty_sets.is_empty(),
        "the pre-mount failure wrote terminal modes it never owned"
    );
    ledger.assert_delta_empty("the pre-mount daemon refusal");
    let after = Termios::capture(reader.file.as_raw_fd());
    assert!(
        before.delta_is_empty(&after),
        "the pre-mount failure changed the pty's termios: {} -> {}",
        before.describe(),
        after.describe()
    );
    let _ = child.kill();
    let _ = child.wait();
}

/// Whether this runner is attached to a controlling-terminal session
/// (the suspend cycle's stop/continue needs one; the other routes run
/// under any runner).
fn sigtstp_session_runner() -> bool {
    // SAFETY: tcgetpgrp only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    foreground >= 0
}

/// Whether this environment's SIGTSTP actually stops a process: some
/// sandboxes (the fleet's supervision wrapper) neutralize job-control
/// stops — a group `kill -TSTP` returns success and the process keeps
/// running. The suspend route needs a real stop; a probe child decides
/// whether the route runs or skips loudly, the same contract the
/// cursor-visibility e2e's session gate holds.
fn sigtstp_stops_processes() -> bool {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("kill -TSTP 0; sleep 5")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the stop-capability probe spawns");
    let deadline = Instant::now() + Duration::from_millis(1_500);
    let stops = loop {
        match waitpid(
            Pid::from_raw(child.id() as i32),
            Some(WaitPidFlag::WNOHANG | WaitPidFlag::WUNTRACED),
        ) {
            Ok(WaitStatus::Stopped(..)) => break true,
            Ok(WaitStatus::Exited(..) | WaitStatus::Signaled(..)) => break false,
            _ if Instant::now() > deadline => break false,
            _ => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    if !stops {
        eprintln!(
            "skipping the suspend differential: this environment's SIGTSTP \
             does not stop a process (the fleet's suspend e2e gate holds the \
             same contract)"
        );
    }
    stops
}

/// Poll the child until SIGTSTP's default disposition stops it.
fn wait_for_stopped(pid: u32, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match waitpid(
            Pid::from_raw(pid as i32),
            Some(WaitPidFlag::WNOHANG | WaitPidFlag::WUNTRACED),
        ) {
            Ok(WaitStatus::Stopped(_, _)) => return,
            Ok(WaitStatus::Exited(..)) => panic!("{what}: the child exited instead"),
            _ if Instant::now() > deadline => panic!("timeout waiting for SIGTSTP: {what}"),
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Route: the suspend cycle (ctrl+z). The shell gets the terminal
/// MID-PROCESS — the release tail runs and the process group stops — so
/// the differential asserts twice: the ledger at the stop point (the
/// state the shell sees) must be empty, and the resumed session's
/// final exit must land in the same empty state. The resume's re-arm
/// (mouse, kitty, raw, alt screen) rides the same balance as the mount.
#[test]
fn the_suspend_cycle_hands_a_whole_terminal_to_the_shell_and_back() {
    if !sigtstp_session_runner() || !sigtstp_stops_processes() {
        return;
    }
    match nix::unistd::setsid() {
        Ok(_) => {}
        Err(error) => panic!("the harness could not start a fresh session: {error}"),
    }
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");
    let child_id = harness.child.id();

    // The suspend: the release tail leaves the alt screen and shows
    // the cursor for the shell, then SIGTSTP stops the group.
    let mark = harness.mark();
    harness.write(b"\x1a");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the suspend release left the alt screen",
    );
    wait_for_stopped(child_id, "the suspend cycle stopped the group");

    // The mid-process differential: the shell's terminal equals the
    // pre-launch state while the process is stopped.
    harness.drain_until_quiet(4);
    let stopped = harness.output();
    let mut ledger = ModeLedger::default();
    ledger.scan(&stopped);
    ledger.assert_delta_empty("the suspend cycle's stop point");
    let at_stop = Termios::capture(harness.master.file.as_raw_fd());
    assert!(
        harness.before.delta_is_empty(&at_stop),
        "the suspend left the pty's termios changed: {} -> {}",
        harness.before.describe(),
        at_stop.describe()
    );

    // The resume re-arms the surface (SIGCONT), then the parity exit.
    kill(Pid::from_raw(child_id as i32), Signal::SIGCONT).expect("SIGCONT");
    let resume_mark = harness.mark();
    harness.wait_from(
        resume_mark,
        b"\x1b[?1002h",
        "the resume re-armed mouse tracking",
    );
    harness.drain_until_quiet(6);
    let mark = harness.mark();
    harness.write(b"/exit\r");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the resumed session exited through the parity exit",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly after the suspend cycle"
    );

    harness.assert_terminal_state_restored("the suspend cycle's final exit");
}

/// Route: the late kitty answer. The probe's query goes unanswered
/// through the mount (the support check settles no inside its window);
/// the exit starts (`release_for_exit` first, then the drain); the
/// answer bytes land INSIDE the exit window. The contract this route
/// nets at the stream level: whatever path takes the answer — the
/// probe standing down at the exit release, or the settled-no window
/// already closed — the stream must carry NO kitty flags push after
/// the exit began: the shell keeps a legacy-encoding terminal, not
/// CSI-u soup. The kitty-exit-leak lane owns the mode's own fix and
/// the standdown's unit test; this route is the differential's net
/// over the same window for every OTHER mode too.
#[test]
fn the_late_kitty_answer_inside_the_exit_window_is_stood_down() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // The exit: `/exit`, then the answer rides the drain window (the
    // write lands right after the drain's modifyOtherKeys reset — the
    // first teardown byte after the probe standdown).
    let mark = harness.mark();
    harness.write(b"/exit\r");
    harness.wait_from(mark, b"\x1b[>4;0m", "the exit's first teardown byte");
    harness.try_write(KITTY_ANSWER);
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the parity exit"
    );

    // The late answer must not have re-armed the kitty flags: the
    // stream carries no flags push at all (the answer was stood down).
    let stream = harness.output();
    assert!(
        find_subsequence(&stream, KITTY_FLAGS_PUSH).is_none(),
        "the late answer pushed the kitty flags after the exit standdown"
    );
    harness.assert_terminal_state_restored("the late kitty answer inside the exit window");
}

// large_futures: stack-resident futures on hot paths by design.
// too_many_lines: style gate. Casts: 64-bit targets; narrowing sits at
// bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::too_many_lines
)]

//! The mode ledger: the recording mock terminal's state machine over the
//! child's whole byte stream — nothing the child armed may still be armed
//! at the end of the scanned range.

use std::collections::BTreeMap;

/// DEC private modes whose VT default is ON (25 = cursor visible, 7 =
/// autowrap): a mode left at its default is clean however often it flipped.
const DEFAULT_ON_MODES: [u32; 2] = [7, 25];

/// One DEC private mode's tally: how often the stream wrote it, and whether
/// it stands DEVIATING from its default at the end of the range (the leak).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ModeTally {
    sets: usize,
    resets: usize,
    armed: bool,
}

/// The terminal-state ledger: the mock terminal's answer to "what did the
/// child change?". Fed a complete byte range (whole stream, or up to a mark
/// for a mid-run snapshot), it models every mode-affecting write so
/// [`ModeLedger::assert_delta_empty`] can state the differential.
#[derive(Debug, Default)]
pub(crate) struct ModeLedger {
    /// Every DEC private mode (`ESC[?NNNh`/`l`) the stream wrote.
    pub(crate) dec_modes: BTreeMap<u32, ModeTally>,
    /// The kitty flags stack (push deepens, pop shallows; the process must hand back depth zero).
    kitty_depth: usize,
    pub(crate) kitty_pushes: usize,
    kitty_pops: usize,
    /// The last kitty stack write was a push (the re-arm-after-pop leak).
    kitty_re_armed: bool,
    /// Absolute kitty sets (`ESC[=Nu`): the flags value left behind.
    pub(crate) kitty_sets: Vec<u32>,
    /// modifyOtherKeys (`ESC[>4;Nm`): the value left behind (0 is the reset;
    /// nonzero arms xterm encoding a shell would leak).
    modify_other_keys: u32,
    /// Other `ESC[>Nm` modify forms (cursor keys and friends): the product
    /// owns none, so any appearance is a finding.
    modify_forms: BTreeMap<String, u32>,
    /// The live SGR attribute state (fg/bg/colors/weight): empty at exit.
    sgr_active: Vec<String>,
    /// The last SGR write was a reset (the "SGR ends at reset" contract).
    sgr_ended_reset: bool,
    /// OSC 8 hyperlink opens minus closes (a dangling open wraps the shell's output in the link).
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
    pub(crate) fn scan(&mut self, bytes: &[u8]) {
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
                b'_' => at += Self::skip_dcs(&bytes[at..]),
                b'(' | b')' => {
                    // US ASCII is the terminal's DEFAULT (a runner's own
                    // reporter writes it); any other charset would repaint the shell's output.
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

    /// One CSI sequence: `ESC[`, an optional private prefix (`? < = > !`),
    /// parameters, intermediates, then the final byte.
    pub(crate) fn scan_csi(&mut self, bytes: &[u8]) -> usize {
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
            // suspend snapshot's mark landed inside a paint); nothing
            // state-affecting can hide in it.
            return bytes.len();
        };
        let params = &bytes[params_start..at];
        at += 1;
        self.classify_csi(prefix, params, final_byte);
        at
    }

    pub(crate) fn classify_csi(&mut self, prefix: Option<u8>, params: &[u8], final_byte: u8) {
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
                    // The capability query (`ESC[?u`): a question, not a mode write.
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
                // Cursor positioning, clears, device queries (`ESC[c` DA1,
                // `ESC[6n` DSR): no mode state to leak.
            }
        }
    }

    /// `ESC[>4;Nm`: the product only ever resets it (0); any other value
    /// left behind changes the shell's own key encodings.
    pub(crate) fn classify_modify_other_keys(&mut self, params: &[u8]) {
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

    /// A plain SGR write: maintain the live attribute set. The
    /// extended-color forms consume their own sub-parameters (a `38;5;N`
    /// or `38;2;R;G;B` walk is ONE attribute), so the cursor advances past what each form owns.
    pub(crate) fn classify_sgr(&mut self, params: &[u8]) {
        let text = String::from_utf8_lossy(params);
        let parts: Vec<Option<u16>> = text
            .split(';')
            .map(|part| {
                part.split(':')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .parse::<u16>()
                    .ok()
            })
            .collect();
        if parts.is_empty() {
            self.sgr_active.clear();
            self.sgr_ended_reset = true;
            return;
        }
        let remove = |attrs: &mut Vec<String>, name: &str| {
            attrs.retain(|attr| attr != name);
        };
        let mut cursor = 0;
        while cursor < parts.len() {
            let code = parts[cursor].unwrap_or_default();
            cursor += 1;
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
                38 | 48 | 58 => {
                    // The extended-color form: `N;5;<idx>` or `N;2;<r>;<g>;<b>`;
                    // the consumed params belong to the form, not standalone codes.
                    let kind = match code {
                        38 => "fg",
                        48 => "bg",
                        _ => "underline-color",
                    };
                    push_unique(&mut self.sgr_active, kind);
                    match parts.get(cursor) {
                        Some(Some(5)) => cursor += 2,
                        Some(Some(2)) => cursor += 4,
                        _ => {}
                    }
                }
                39 => remove(&mut self.sgr_active, "fg"),
                49 => remove(&mut self.sgr_active, "bg"),
                59 => remove(&mut self.sgr_active, "underline-color"),
                30..=37 | 90..=97 => push_unique(&mut self.sgr_active, "fg"),
                40..=47 | 100..=107 => push_unique(&mut self.sgr_active, "bg"),
                _ => {}
            }
        }
        self.sgr_ended_reset = self.sgr_active.is_empty();
    }

    /// One OSC sequence (`ESC]` to BEL or ST): the hyperlink state and the one-shot writes.
    pub(crate) fn scan_osc(&mut self, bytes: &[u8]) -> usize {
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
                    // A raw ESC inside an OSC (no ST): treat the OSC as unterminated content.
                    self.classify_osc(&bytes[2..at]);
                    return at;
                }
                _ => at += 1,
            }
        }
        self.classify_osc(&bytes[2..]);
        bytes.len()
    }

    pub(crate) fn classify_osc(&mut self, payload: &[u8]) {
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

    /// A DCS sequence (kitty graphics, `ESC_G ... ESC\`): image payload, no mode state.
    pub(crate) fn skip_dcs(bytes: &[u8]) -> usize {
        let mut at = 2;
        while at < bytes.len() {
            if bytes[at] == 0x1b && bytes.get(at + 1) == Some(&0x5c) {
                return at + 2;
            }
            at += 1;
        }
        bytes.len()
    }

    /// The differential's findings: every armed mode disarmed, the kitty
    /// stack popped, modifyOtherKeys reset, SGR empty, hyperlinks closed.
    pub(crate) fn leaks(&self) -> Vec<String> {
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

    /// The differential itself: the findings must be empty (`context` names
    /// the route in the failure).
    pub(crate) fn assert_delta_empty(&self, context: &str) {
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

/// The `;`-separated mode numbers of a DEC private mode write.
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

/// Scan a synthetic stream and return the findings.
fn findings_of(stream: &[u8]) -> Vec<String> {
    let mut ledger = ModeLedger::default();
    ledger.scan(stream);
    ledger.leaks()
}

#[test]
fn the_ledger_passes_the_balanced_restore() {
    // The exact write set of a whole mount/exit session: every mode armed
    // and restored, the push popped, the SGR reset.
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
    let stream = b"\x1b[?1002h\x1b[?1003h\x1b[?1006h";
    let findings = findings_of(stream);
    assert!(
        findings.iter().any(|f| f.contains("?1002")),
        "the leaked mouse mode went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_an_unknown_leaked_mode() {
    // A mode the product never writes: the net must catch it anyway.
    let findings = findings_of(b"\x1b[?1004h");
    assert!(
        findings.iter().any(|f| f.contains("?1004")),
        "the unknown leaked mode went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_a_default_on_mode_left_off() {
    // Cursor visibility's default is ON: hide and never show again = deviating.
    let findings = findings_of(b"\x1b[?25l");
    assert!(
        findings.iter().any(|f| f.contains("?25")),
        "the hidden cursor went unnoticed: {findings:?}"
    );
    assert!(
        findings_of(b"\x1b[?25l\x1b[?25h").is_empty(),
        "the shown-back cursor leaked"
    );
}

#[test]
fn the_ledger_catches_a_kitty_re_arm_after_the_pop() {
    // A push after the final pop: the re-arm leak shape.
    let stream = b"\x1b[>7u\x1b[<u\x1b[>7u";
    let findings = findings_of(stream);
    assert!(
        findings.iter().any(|f| f.contains("kitty")),
        "the re-armed kitty stack went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_a_dangling_sgr() {
    // A styled write with no reset: the shell paints in the color.
    let findings = findings_of(b"\x1b[38;5;1mred");
    assert!(
        findings.iter().any(|f| f.contains("SGR")),
        "the dangling SGR went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_a_dangling_hyperlink() {
    let findings = findings_of(b"\x1b]8;;https://example.com\x1b\\link");
    assert!(
        findings.iter().any(|f| f.contains("hyperlink")),
        "the dangling hyperlink went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_forbidden_writes() {
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
    let findings = findings_of(b"\x1b[=5u");
    assert!(
        findings.iter().any(|f| f.contains("absolutely")),
        "the absolute kitty set went unnoticed: {findings:?}"
    );
}

/// The extended-color forms are one attribute, not a code walk: `38;5;N`
/// arms no phantom blink (5) or bold (1), and a zero channel inside
/// `38;2;R;G;B` is a color component, never a reset.
#[test]
fn the_ledger_reads_extended_color_forms_as_one_attribute() {
    // The balanced pair: the extended color sets fg, the 39 clears it.
    assert!(findings_of(b"\x1b[38;5;13mrow\x1b[39m").is_empty());
    assert!(findings_of(b"\x1b[38;2;0;0;0mrow\x1b[39m").is_empty());
    let findings = findings_of(b"\x1b[38;5;13mrow");
    assert!(
        findings.iter().any(|f| f.contains("SGR")),
        "the dangling extended color went unnoticed: {findings:?}"
    );
    let findings = findings_of(b"\x1b[38;2;0;0;0mrow");
    assert!(
        findings.iter().any(|f| f.contains("SGR")),
        "the dangling RGB color went unnoticed: {findings:?}"
    );
}

#[test]
fn the_ledger_catches_modify_other_keys_left_armed() {
    let findings = findings_of(b"\x1b[>4;2m");
    assert!(
        findings.iter().any(|f| f.contains("modifyOtherKeys")),
        "the modifyOtherKeys arm went unnoticed: {findings:?}"
    );
}

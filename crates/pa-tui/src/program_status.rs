//! OSC 7501 (Program Status Protocol) reports: the terminal's live
//! record of what this program is doing.
//! <https://www.superlogical.com/rex/docs/build/program-status>

use std::io::Write;

/// The app key every report repeats (each report replaces its record).
const APP: &str = "prime-agent";

/// The statuses the TUI reports. The protocol also defines `blocked` and
/// `clear`; the TUI reports no blocked state and owns the clear itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Working,
    Idle,
    Done,
    Error,
}

impl Status {
    /// The report sequence: `OSC 7501 ; state=<s>:app=prime-agent ST`.
    fn sequence(self) -> String {
        let word = match self {
            Status::Working => "working",
            Status::Idle => "idle",
            Status::Done => "done",
            Status::Error => "error",
        };
        format!("\x1b]7501;state={word}:app={APP}\x1b\\")
    }
}

/// The clear sequence: removes the root record (no id: every record).
const CLEAR: &str = "\x1b]7501;state=clear\x1b\\";

/// The report the terminal last received from this process, taken by the
/// exit clear.
static LAST: std::sync::Mutex<Option<Status>> = std::sync::Mutex::new(None);

/// Write the report when it differs from the last one written.
pub(crate) fn report(status: Status) {
    let Ok(mut last) = LAST.lock() else {
        return;
    };
    if *last == Some(status) {
        return;
    }
    let mut out = std::io::stdout();
    if out
        .write_all(status.sequence().as_bytes())
        .and_then(|()| out.flush())
        .is_ok()
    {
        *last = Some(status);
    }
}

/// The exit clear: at most one write per process, only when a report was
/// written, so runs that never reported keep byte-identical exits.
pub(crate) fn clear_if_reported() {
    let Ok(mut last) = LAST.lock() else {
        return;
    };
    if last.take().is_none() {
        return;
    }
    let mut out = std::io::stdout();
    let _ = out.write_all(CLEAR.as_bytes());
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_report_fits_the_protocol_grammar() {
        let reports = [
            (Status::Working.sequence(), "working", Some(APP)),
            (Status::Idle.sequence(), "idle", Some(APP)),
            (Status::Done.sequence(), "done", Some(APP)),
            (Status::Error.sequence(), "error", Some(APP)),
            (CLEAR.to_string(), "clear", None),
        ];
        for (sequence, state, app) in reports {
            let body = sequence
                .strip_prefix("\x1b]7501;")
                .and_then(|body| body.strip_suffix("\x1b\\"))
                .expect("the sequence is OSC 7501 ending in ST");
            let mut seen_state = None;
            let mut seen_app = None;
            for pair in body.split(':') {
                let (key, value) = pair.split_once('=').expect("pair carries =");
                assert!(
                    !key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase()),
                    "key {key:?} is not [a-z]+"
                );
                assert!(
                    value
                        .chars()
                        .all(|byte| byte.is_ascii_alphanumeric() || "_.,+/=-".contains(byte)),
                    "value {value:?} leaves the allowed set"
                );
                match key {
                    "state" => seen_state = Some(value),
                    "app" => seen_app = Some(value),
                    _ => {}
                }
            }
            assert_eq!(seen_state, Some(state), "the state pair");
            assert_eq!(seen_app, app, "the app pair");
        }
    }
}

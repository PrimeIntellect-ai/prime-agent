//! OSC 7501 (Program Status Protocol) reports: the terminal's record of
//! what this program is doing.
//! <https://www.superlogical.com/rex/docs/build/program-status>
//!
//! Reports are written only once the terminal answered the protocol's
//! feature detection (the query rides the terminal probe, see
//! `enhanced_keys`); until then, and on terminals that did not answer,
//! nothing is written. The program never clears its record: on exit the
//! terminal drops `working` itself and keeps `done`/`error` for the user
//! (the protocol's "Lifetime").

use std::io::Write;

/// The app key every report repeats (each report replaces its record).
const APP: &str = "prime-agent";

/// The states a detection reply without `states=` accepts (fixed by the
/// protocol's "Feature detection").
const BASE_STATES: [&str; 5] = ["idle", "working", "done", "blocked", "error"];

/// The statuses the TUI reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Working,
    Idle,
    Done,
    Error,
}

impl Status {
    fn word(self) -> &'static str {
        match self {
            Status::Working => "working",
            Status::Idle => "idle",
            Status::Done => "done",
            Status::Error => "error",
        }
    }
}

/// The terminal's answer to the feature detection.
#[derive(Debug)]
enum Support {
    Pending,
    Unsupported,
    /// The states the terminal accepts.
    Supported(Vec<String>),
}

#[derive(Debug)]
struct Reporter {
    support: Support,
    /// The status the surface currently reports.
    current: Option<Status>,
    /// The state word the terminal last received.
    written: Option<&'static str>,
}

impl Reporter {
    /// The state word owed to the terminal: the current status, or `idle`
    /// when the terminal does not accept it (the protocol's fallback to a
    /// listed state), unless the terminal already has it.
    fn owed(&self) -> Option<&'static str> {
        let Support::Supported(states) = &self.support else {
            return None;
        };
        let accepted = |word: &&str| states.iter().any(|state| state == word);
        let word = [self.current?.word(), Status::Idle.word()]
            .into_iter()
            .find(accepted)?;
        (self.written != Some(word)).then_some(word)
    }

    fn flush(&mut self) {
        let Some(word) = self.owed() else {
            return;
        };
        let mut out = std::io::stdout();
        if out
            .write_all(format!("\x1b]7501;state={word}:app={APP}\x1b\\").as_bytes())
            .and_then(|()| out.flush())
            .is_ok()
        {
            self.written = Some(word);
        }
    }
}

static REPORTER: std::sync::Mutex<Reporter> = std::sync::Mutex::new(Reporter {
    support: Support::Pending,
    current: None,
    written: None,
});

fn reporter() -> std::sync::MutexGuard<'static, Reporter> {
    REPORTER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Report the surface's status.
pub(crate) fn report(status: Status) {
    let mut reporter = reporter();
    reporter.current = Some(status);
    reporter.flush();
}

/// Record the feature detection's outcome (`None`: unsupported) and send
/// the current status to a supporting terminal.
pub(crate) fn detected(reply: Option<crossterm::terminal::ProgramStatusSupport>) {
    let mut reporter = reporter();
    reporter.support = match reply {
        Some(reply) => Support::Supported(
            reply
                .states
                .unwrap_or_else(|| BASE_STATES.map(str::to_string).to_vec()),
        ),
        None => Support::Unsupported,
    };
    reporter.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reporter(support: Support, current: Status) -> Reporter {
        Reporter {
            support,
            current: Some(current),
            written: None,
        }
    }

    fn supported(states: &[&str]) -> Support {
        Support::Supported(states.iter().map(ToString::to_string).collect())
    }

    #[test]
    fn only_a_supporting_terminal_is_owed_a_report() {
        assert_eq!(reporter(Support::Pending, Status::Working).owed(), None);
        assert_eq!(reporter(Support::Unsupported, Status::Working).owed(), None);
        let mut supporting = reporter(supported(&BASE_STATES), Status::Working);
        assert_eq!(supporting.owed(), Some("working"));
        supporting.written = Some("working");
        assert_eq!(supporting.owed(), None, "an unchanged status is not resent");
    }

    #[test]
    fn an_unaccepted_state_falls_back_to_idle_or_nothing() {
        let without_done = supported(&["idle", "working", "blocked", "error"]);
        assert_eq!(reporter(without_done, Status::Done).owed(), Some("idle"));
        assert_eq!(reporter(supported(&["working"]), Status::Done).owed(), None);
    }
}

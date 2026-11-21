//! Selectors: the rule that picks the value of one input.
//!
//! A selector is the `from` reference of an input: `"<state>.<port>"`. It
//! names one source state and one output port of that state. A source
//! state can settle more than one time. The selector always picks the
//! latest settle. A reference that does not name exactly one state and
//! one port is an error.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{Map, Value};

/// One source state and one of its output ports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selector {
    pub state: String,
    pub port: String,
}

impl Selector {
    /// Read a `from` reference.
    ///
    /// # Errors
    ///
    /// Returns [`SelectorError::Ambiguous`] when the reference has more
    /// than one `.`, because then more than one state and port pair can
    /// match it. Returns [`SelectorError::Malformed`] when the reference
    /// has no `.` or an empty state or port.
    pub fn parse(reference: &str) -> Result<Self, SelectorError> {
        let Some((state, port)) = reference.split_once('.') else {
            return Err(SelectorError::Malformed(reference.to_string()));
        };
        if port.contains('.') {
            return Err(SelectorError::Ambiguous(reference.to_string()));
        }
        if state.is_empty() || port.is_empty() {
            return Err(SelectorError::Malformed(reference.to_string()));
        }
        Ok(Self {
            state: state.to_string(),
            port: port.to_string(),
        })
    }

    /// Pick the value of the port from the latest settle. `settles` holds
    /// the settled entries of the source state, oldest first.
    #[must_use]
    pub fn select<'a>(&self, settles: &'a [Settle]) -> Selection<'a> {
        let Some(latest) = settles.last() else {
            return Selection::NotSettled;
        };
        match latest {
            Settle::Failed => Selection::Unavailable(Unavailable::Failed),
            Settle::Done {
                outputs,
                output_errors,
            } => {
                if let Some(error) = output_errors.get(&self.port) {
                    return Selection::Unavailable(Unavailable::CaptureFailed(error.clone()));
                }
                outputs.get(&self.port).map_or(
                    Selection::Unavailable(Unavailable::NoValue),
                    Selection::Value,
                )
            }
        }
    }
}

impl fmt::Display for Selector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.state, self.port)
    }
}

/// A `from` reference that does not name one state and one port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorError {
    Ambiguous(String),
    Malformed(String),
}

impl fmt::Display for SelectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ambiguous(reference) => write!(
                f,
                "{reference:?} is ambiguous: use one \".\" between the state and the port"
            ),
            Self::Malformed(reference) => {
                write!(f, "{reference:?} must have the form \"<state>.<port>\"")
            }
        }
    }
}

/// One settled entry of a source state, as the executor recorded it.
#[derive(Debug, Clone, PartialEq)]
pub enum Settle {
    /// The entry failed. It has no outputs.
    Failed,
    /// The entry finished. `outputs` holds each captured port.
    /// `output_errors` holds the reason for each port that the executor
    /// could not capture.
    Done {
        outputs: Map<String, Value>,
        output_errors: BTreeMap<String, String>,
    },
}

/// The result of [`Selector::select`].
#[derive(Debug, Clone, PartialEq)]
pub enum Selection<'a> {
    /// The source state has no settle.
    NotSettled,
    Value(&'a Value),
    /// The source state settled, but the latest settle has no value for
    /// the port.
    Unavailable(Unavailable),
}

/// Why a settled source has no value for a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unavailable {
    /// The latest settle failed.
    Failed,
    /// The executor could not capture the port. The text tells why.
    CaptureFailed(String),
    /// The latest settle did not capture the port.
    NoValue,
}

impl fmt::Display for Unavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed => f.write_str("the latest settle failed"),
            Self::CaptureFailed(error) => f.write_str(error),
            Self::NoValue => f.write_str("the latest settle captured no value"),
        }
    }
}

#[cfg(test)]
mod tests;

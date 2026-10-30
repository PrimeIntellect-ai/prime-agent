//! The user-configurable status line (the `statusLine` setting): the
//! settings-level successor of the TS `ctx.ui.setFooter` extension hook.

use serde::{Deserialize, Serialize};

/// `statusLine` settings: `command` runs through the shell with a JSON
/// session payload on stdin; its stdout (ANSI-stripped) renders as the TUI
/// footer rows above the activity dock. Unset renders the built-in chrome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLineSpec {
    /// The shell command line, run as `sh -c <command>`.
    pub command: String,
    /// Leading-space padding for each rendered row; unset reads as 0.
    pub padding: Option<u64>,
}

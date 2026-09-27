//! The staged-activation update flow (spec §4): the `prime-agent update`
//! command's coordinator machinery. The invoking CLI plans, downloads, and
//! stages the candidate (states `Acquire`..`Staged`), then spawns the
//! detached coordinator - the NEW binary running from its release dir -
//! which adopts the status file and owns the FSM to a terminal state (spec
//! §3: only the status file couples them).

pub mod coordinator;
pub mod intent;
pub mod phases;
pub mod plan;
pub mod report;
pub mod status;
pub mod successor;
pub mod swap;
pub mod update_command;

use std::path::PathBuf;

use anyhow::{anyhow, Result};

/// This process's install root (the coordinator runs the NEW binary from
/// its release dir, the invoking CLI the old one - both derive the root
/// from `current_exe`).
///
/// # Errors
/// Returns an error when this process's executable path cannot be resolved
/// or the binary does not run from a managed install root.
pub fn activation_root() -> Result<PathBuf> {
    pa_core::update::install::install_root_of(&std::env::current_exe()?)
        .ok_or_else(|| anyhow!("the current binary does not run from a managed install root"))
}

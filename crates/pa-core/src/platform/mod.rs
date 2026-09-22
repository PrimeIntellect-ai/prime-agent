//! pa-core platform wall: every OS-specific behavior behind small traits in
//! cfg-gated modules (MISSION.md, Windows-readiness).
//!
//! Unix and Windows implementations live behind the same signatures (see
//! docs/windows-readiness.md for the plan and per-module dispositions).
//! Call sites in the session engine never branch on `cfg` themselves.

pub mod browser;
pub mod lock_dir;
pub mod perms;
pub mod process;
pub mod shell;

pub use lock_dir::LockDir;
pub use perms::{
    file_mode, is_executable, is_readable_writable, restrict_dir, restrict_file, set_private_mode,
};
// The detached-child registry lives in pa-types (the interactive client
// depends on pa-types alone); re-exported so pa-core spawn sites reach it
// through the platform wall.
pub use pa_types::platform::detached_children::{
    track_detached_child_pid, untrack_detached_child_pid,
};
pub use process::{
    kill_pid, kill_process_group_or_pid, pid_exists, set_new_process_group, set_no_window,
    termination_signal, Signal,
};
// The rename-onto-destination primitive (bounded win32 destination-busy
// retry, TS `renameOntoSync`) lives in pa-telemetry - the bottom crate every
// persist owner (pa-telemetry install id, pa-core, pa-daemon) already
// depends on. Re-exported so the platform wall stays the engine's single
// platform entry.
pub use pa_telemetry::rename_onto;
pub use shell::{get_shell_config, resolve_kernel_bash_shell, ShellConfig};

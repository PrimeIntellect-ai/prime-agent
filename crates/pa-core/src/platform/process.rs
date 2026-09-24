//! Process control: signals, process groups, detached spawns.
//!
//! Unix: libc `kill` / `process_group(0)`. Windows: TerminateProcess for
//! single-pid signals (the libuv/Node win32 mapping), the absolute-System32
//! `taskkill /F /T` for tree kills (the TS `killProcessTree` /
//! `killOrphanProcess` precedent), and the Node `detached: true` /
//! `windowsHide` creation-flag pair for spawns. Signatures that report
//! outcomes return `bool` where callers treat "unproven" conservatively (a
//! kill that could not be proven reports false, matching the TS
//! `killOrphanProcess` contract).

use std::process::Command;

/// Termination signal for [`kill_pid`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// Graceful stop (SIGTERM).
    Term,
    /// Forcible stop (SIGKILL).
    Kill,
}

/// Put the spawned child into its own process group so later group-scoped
/// kills reach all of its descendants (TS: `detached: true` on POSIX).
#[cfg(unix)]
pub fn set_new_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

/// Windows: the libuv mapping of Node `detached: true` on win32 -
/// `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`, plus `CREATE_NO_WINDOW`
/// because every non-interactive spawn in the product is window-hidden
/// (TS `spawnHidden`; console children of a windowless parent would flash
/// a fresh console). Tree kills need none of it (`taskkill /T` walks the
/// parent-child tree); the flags buy signal-group isolation and the
/// detached-survives-parent behavior.
#[cfg(windows)]
pub fn set_new_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// `winbase.h`: new process group (no ctrl+c broadcast from the parent).
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    /// `winbase.h`: detached console, survives the parent's console close.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    /// `winbase.h` `CREATE_NO_WINDOW` (TS `windowsHide`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
pub fn set_new_process_group(_command: &mut Command) {
    // No detached-group mechanism on this platform; group-scoped kills are
    // unavailable and callers fall back to single-pid kills.
}

/// Hide the console window of a non-interactive spawn (TS `windowsHide` /
/// `spawnHidden`): the child gets no window instead of a fresh console.
/// Only one of [`set_new_process_group`] and [`set_no_window`] may be
/// applied to a command - creation flags replace each other, and the
/// detached variant already includes the hidden window.
#[cfg(windows)]
pub fn set_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// `winbase.h` `CREATE_NO_WINDOW` (TS `windowsHide`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Unix: every product console surface owns its own window behavior
/// (`windowsHide` has no meaning without windows).
#[cfg(not(windows))]
pub fn set_no_window(_command: &mut Command) {}

/// Signal a single pid. Returns true only when the signal was delivered,
/// proving the pid was alive at signal time.
#[cfg(unix)]
pub fn kill_pid(pid: i32, signal: Signal) -> bool {
    if pid <= 0 {
        return false;
    }
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    unsafe { libc::kill(pid, sig) == 0 }
}

/// Windows: `OpenProcess(PROCESS_TERMINATE)` + `TerminateProcess` on the
/// single pid - the libuv mapping behind Node's `process.kill(pid, sig)`
/// on win32 (every signal terminates; the `Term`/`Kill` distinction
/// collapses there). Descendants are NOT killed: teardown paths that need
/// tree kills use [`kill_process_group_or_pid`], like the TS callers.
#[cfg(windows)]
pub fn kill_pid(pid: i32, signal: Signal) -> bool {
    if pid <= 0 {
        return false;
    }
    let _ = signal;
    win32::terminate_process(pid as u32)
}

#[cfg(not(any(unix, windows)))]
pub fn kill_pid(_pid: i32, _signal: Signal) -> bool {
    // No signaling mechanism; the kill stays unproven, the conservative
    // answer callers act on.
    false
}

/// Kill a process and all its children: the process group first (bash()
/// children run detached in a new group), then the bare pid as fallback.
/// Returns true when either signal was delivered (TS `killProcessTree`).
#[cfg(unix)]
pub fn kill_process_group_or_pid(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) == 0 {
            return true;
        }
    }
    unsafe { libc::kill(pid, libc::SIGKILL) == 0 }
}

/// Windows: `taskkill /F /T /PID <pid>` from the absolute System32 path -
/// the hardened TS tree-kill (`killOrphanProcess`; a bare `taskkill` name
/// could resolve a planted CWD executable). The tree is walked via the
/// parent-child relationship, so the detached-group flags of
/// [`set_new_process_group`] are irrelevant here. True only when taskkill
/// exited 0, the same proof TS's `result.status === 0` requires.
#[cfg(windows)]
pub fn kill_process_group_or_pid(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from("C:\\Windows"));
    let taskkill = std::path::Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe");
    let mut command = Command::new(&taskkill);
    command
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    set_no_window(&mut command);
    command.status().is_ok_and(|status| status.success())
}

#[cfg(not(any(unix, windows)))]
pub fn kill_process_group_or_pid(_pid: i32) -> bool {
    // No tree-kill mechanism; the kill stays unproven, the conservative
    // answer callers act on.
    false
}

/// Cheap `kill(pid, 0)` existence probe; counts zombies as existing.
#[cfg(unix)]
pub fn pid_exists(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// The kernel-held process handle (`pidfd_open`): pins the exact process
/// behind the pid, so a signal through it ([`pidfd_signal`]) reaches that
/// process even if the numeric pid is recycled afterwards. `None` when
/// the platform or kernel has no pidfd, or the process is already gone
/// (the caller treats an unobtainable handle as never-signal: a missed
/// stop is recoverable, a wrong one is not).
#[cfg(all(unix, any(target_arch = "x86_64", target_arch = "aarch64")))]
pub fn open_pidfd(pid: u32) -> Option<i32> {
    // `SYS_pidfd_open`/`SYS_pidfd_send_signal` share their numbers across
    // x86_64 and aarch64 (the platforms this workspace ships).
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    (fd >= 0).then_some(fd as i32)
}

#[cfg(all(unix, not(any(target_arch = "x86_64", target_arch = "aarch64"))))]
pub fn open_pidfd(_pid: u32) -> Option<i32> {
    None
}

#[cfg(not(unix))]
pub fn open_pidfd(_pid: u32) -> Option<i32> {
    None
}

/// Signal through the kernel-held handle (`pidfd_send_signal`): the
/// signal reaches the pinned process and nothing else. The handle
/// CLOSES on drop by the caller (`close(fd)` via [`close_pidfd`]).
#[cfg(all(unix, any(target_arch = "x86_64", target_arch = "aarch64")))]
pub fn pidfd_signal(fd: i32, signal: Signal) -> bool {
    let signum = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd,
            signum,
            std::ptr::null::<u8>(),
            0,
        ) == 0
    }
}

#[cfg(all(unix, not(any(target_arch = "x86_64", target_arch = "aarch64"))))]
pub fn pidfd_signal(_fd: i32, _signal: Signal) -> bool {
    false
}

#[cfg(not(unix))]
pub fn pidfd_signal(_fd: i32, _signal: Signal) -> bool {
    false
}

/// Release a kernel-held handle obtained from [`open_pidfd`].
pub fn close_pidfd(fd: i32) {
    #[cfg(unix)]
    unsafe {
        libc::close(fd);
    }
    #[cfg(not(unix))]
    let _ = fd;
}

/// Windows: the shared handle probe (win32 has no unreaped-zombie state,
/// so existing and running are the same predicate - Node's `kill(pid, 0)`
/// checks the same `STILL_ACTIVE` exit code). A query that fails outright
/// reads as gone.
#[cfg(windows)]
pub fn pid_exists(pid: u32) -> bool {
    pa_types::platform::process::is_process_alive(pid).unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
pub fn pid_exists(_pid: u32) -> bool {
    false
}

/// The signal number that terminated a child, when it was signaled
/// (`ExitStatus::signal` on Unix; None elsewhere).
#[cfg(unix)]
pub fn termination_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
pub fn termination_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    // Windows terminations surface as exit codes, not signals.
    None
}

/// The kernel32 termination surface for [`kill_pid`], hand-declared (repo
/// policy: pinned constants and externs, no windows-sys dependency - same
/// policy as the pa-types named-pipe transport and identity probes).
#[cfg(windows)]
mod win32 {
    #![allow(non_snake_case)]

    use std::ffi::c_void;

    /// `winnt.h`: the right to terminate the process.
    const PROCESS_TERMINATE: u32 = 0x0001;

    type Handle = *mut c_void;

    extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: usize) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn TerminateProcess(handle: Handle, exit_code: u32) -> i32;
    }

    /// Terminate exactly the pid; false when it could not be proven
    /// terminated (gone already, access denied, or invalid).
    pub(crate) fn terminate_process(pid: u32) -> bool {
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid as usize) };
        if handle.is_null() {
            return false;
        }
        let terminated = unsafe { TerminateProcess(handle, 1) != 0 };
        unsafe { CloseHandle(handle) };
        terminated
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// Existence probe on this very process; pid 0 never names a process.
    #[test]
    fn pid_exists_for_self_but_not_zero() {
        assert!(pid_exists(std::process::id()));
        assert!(!pid_exists(0));
        assert!(!pid_exists(u32::MAX));
    }

    /// No kill ever proves delivery for an out-of-range pid.
    #[test]
    fn out_of_range_pids_never_prove_kills() {
        assert!(!kill_pid(-1, Signal::Kill));
        assert!(!kill_pid(0, Signal::Term));
        assert!(!kill_process_group_or_pid(-1));
    }
}

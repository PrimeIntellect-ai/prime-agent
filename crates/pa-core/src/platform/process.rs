//! Process control: signals, process groups, detached spawns.
//!
//! Unix: libc `kill` / `process_group(0)`. Windows: `TerminateProcess` for
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

/// Start the spawned child in a new session with no controlling terminal
/// (`setsid`): the child cannot open `/dev/tty`, and job-control signals
/// from the parent's terminal never reach it. A new process group alone
/// is not enough: the group can still open the terminal, and a background
/// read then stops it with SIGTTIN.
#[cfg(unix)]
pub fn set_new_session(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the hook runs in the forked child before exec and only calls
    // setsid(2), which is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            nix::unistd::setsid()
                .map(drop)
                .map_err(std::io::Error::from)
        });
    }
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

/// Raise the soft open-file limit to the hard limit and return the
/// resulting soft limit (Node raises it the same way at startup). macOS
/// refuses a soft limit above `kern.maxfilesperproc`, `RLIM_INFINITY`
/// included, so the target is capped there.
///
/// # Errors
///
/// The OS error of a failed `getrlimit`, `sysctlbyname` or `setrlimit`.
#[cfg(unix)]
pub fn raise_open_file_limit() -> std::io::Result<Option<u64>> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(not(target_os = "macos"))]
    let target = limit.rlim_max;
    #[cfg(target_os = "macos")]
    let target = {
        let mut per_process: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        let read = unsafe {
            libc::sysctlbyname(
                c"kern.maxfilesperproc".as_ptr(),
                (&raw mut per_process).cast(),
                &raw mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if read != 0 {
            return Err(std::io::Error::last_os_error());
        }
        limit.rlim_max.min(per_process.unsigned_abs().into())
    };
    if limit.rlim_cur < target {
        limit.rlim_cur = target;
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const limit) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(Some(limit.rlim_cur))
}

/// No per-process descriptor limit to raise.
///
/// # Errors
///
/// Never: the not-unix arm has no descriptor limit to raise.
#[cfg(not(unix))]
pub fn raise_open_file_limit() -> std::io::Result<Option<u64>> {
    Ok(None)
}

/// Signal a single pid. Returns true only when the signal was delivered,
/// proving the pid was alive at signal time.
#[cfg(unix)]
#[must_use]
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
#[must_use]
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

/// Kill a process and all its children: the process group first (`bash()`
/// children run detached in a new group), then the bare pid as fallback.
/// Returns true when either signal was delivered (TS `killProcessTree`).
#[cfg(unix)]
#[must_use]
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
#[must_use]
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

/// Relay a signal to the process group led by `pid` (the leader's own pid is
/// its pgid): the reference ladder's stop for teardown paths whose direct
/// child may already be reaped - a launcher (`sh -c`, a container client)
/// can exit first and leave descendants alive in its group, so the group is
/// signalled whether or not the leader is still around (TS
/// `signalProcessGroupIfHeld`). Group-only, no bare-pid fallback: by the
/// time teardown reaches here the leader is reaped, and a signal to its
/// recycled pid would hit an innocent process - the group signal carries the
/// reference's inherent, bounded pid-reuse TOCTOU and nothing wider.
#[cfg(unix)]
#[must_use]
pub fn signal_process_group(pid: i32, signal: Signal) -> bool {
    if pid <= 0 {
        return false;
    }
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    unsafe { libc::kill(-pid, sig) == 0 }
}

/// Windows (and bare-metal) have no signalable process groups: the TS
/// reference's `processGroupExists` is false on win32, so its leader-exit
/// relays are no-ops there; tree teardown goes through
/// [`kill_process_group_or_pid`] instead.
#[cfg(not(unix))]
#[must_use]
pub fn signal_process_group(_pid: i32, _signal: Signal) -> bool {
    false
}

/// Cheap `kill(-pid, 0)` group-membership probe: true while any process
/// still holds the pgid led by `pid`, so teardown can tell a drained
/// group from one that ignored its stop (TS `processGroupExists`; EPERM
/// counts as existing - the group is there, just not signalable).
/// Windows (and bare-metal) have no signalable groups, so no group ever
/// exists to probe there and callers take their enforcement arm.
#[cfg(unix)]
#[must_use]
pub fn process_group_exists(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 performs the permission and existence checks
    // without sending anything.
    if unsafe { libc::kill(-pid, 0) } == 0 {
        return true;
    }
    // EPERM: the group has a member this process may not signal.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
#[must_use]
pub fn process_group_exists(_pid: i32) -> bool {
    false
}

/// Kill every member of the process group led by `pid`: the enforced stop
/// for teardown after the leader has exited and been reaped (the close
/// ladder's leader-exit arms). No bare-pid fallback - the reaped leader no
/// longer anchors its pid, so a fallback could signal an innocent recycled
/// pid; the group signal keeps the reference's inherent, bounded
/// group-reuse TOCTOU and nothing wider (the group's live members hold the
/// pgid at signal time). The caller must still own the leader's `Child`:
/// on Windows the handle keeps the reaped leader's pid reserved against
/// reuse and resolvable for the tree walk, exactly while a live member
/// anchors the pgid on POSIX.
#[cfg(unix)]
#[must_use]
pub fn kill_process_group(pid: i32) -> bool {
    signal_process_group(pid, Signal::Kill)
}

/// The same enforced stop on Windows: no signalable groups, so the
/// hardened `taskkill /F /T` tree kill reaches the dead leader's
/// descendants through the parent-child snapshot instead (the TS
/// reference's own win32 answer for a stop that must reach a tree). The
/// walk is link-based: a descendant keeps naming the exited leader as its
/// parent, so the tree stays walkable after the reaped leader itself is
/// gone from the snapshot - provided the caller still owns the leader's
/// `Child` handle, which keeps the pid reserved (a Windows pid recycles
/// only after its last handle closes), so the walk can neither miss the
/// tree nor reach an unrelated recycled one. Best-effort by contract:
/// false only means the stop is unproven, the answer callers treat
/// conservatively.
#[cfg(not(unix))]
#[must_use]
pub fn kill_process_group(pid: i32) -> bool {
    kill_process_group_or_pid(pid)
}

/// Cheap `kill(pid, 0)` existence probe; counts zombies as existing.
#[cfg(unix)]
#[must_use]
pub fn pid_exists(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// The kernel-held process handle (`pidfd_open`): pins the exact process
/// behind the pid, so a signal through it ([`pidfd_signal`]) reaches that
/// process even if the numeric pid is recycled afterwards. The caller
/// treats an unobtainable handle as never-signal: a missed stop is
/// recoverable, a wrong one is not.
///
/// # Errors
///
/// Returns the open failure verbatim: `ESRCH` names a process that is
/// already gone, `Unsupported` a platform with no pidfd arm.
#[cfg(all(
    unix,
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
pub fn open_pidfd(pid: u32) -> std::io::Result<i32> {
    // `SYS_pidfd_open`/`SYS_pidfd_send_signal` share their numbers across
    // x86_64 and aarch64 (the platforms this workspace ships) — Linux only:
    // pidfd is a Linux syscall family, and the macOS libc crate carries no
    // `SYS_pidfd_*` constants for the same cfg to compile against.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(fd as i32)
    }
}

/// No pidfd arm on this platform or kernel: the handle is unobtainable.
///
/// # Errors
///
/// Always `Unsupported`.
#[cfg(all(
    unix,
    not(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))
))]
pub fn open_pidfd(_pid: u32) -> std::io::Result<i32> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// No pidfd arm on this platform or kernel: the handle is unobtainable.
///
/// # Errors
///
/// Always `Unsupported`.
#[cfg(not(unix))]
pub fn open_pidfd(_pid: u32) -> std::io::Result<i32> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// Signal through the kernel-held handle (`pidfd_send_signal`): the
/// signal reaches the pinned process and nothing else. The handle
/// CLOSES on drop by the caller (`close(fd)` via [`close_pidfd`]).
#[cfg(all(
    unix,
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
#[must_use]
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

#[cfg(all(
    unix,
    not(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))
))]
#[must_use]
pub fn pidfd_signal(_fd: i32, _signal: Signal) -> bool {
    false
}

#[cfg(not(unix))]
#[must_use]
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

/// Resolve once the process behind `pid` has exited, parked on the kernel's
/// exit notification (Linux pidfd readability, macOS kqueue
/// `EVFILT_PROC`/`NOTE_EXIT`), with no timer. A pid that names no process
/// (already exited and reaped) resolves at once. The kernel handle pins
/// the process instance, so a pid recycled after registration is never
/// mistaken for it.
///
/// # Errors
///
/// The OS error when the watch cannot register (no pidfd, descriptor
/// exhaustion, an unsupported platform); the caller owns its fallback.
#[cfg(target_os = "linux")]
pub async fn wait_for_exit(pid: u32) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use tokio::io::{unix::AsyncFd, Interest};

    let fd = match open_pidfd(pid) {
        Ok(fd) => fd,
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(()),
        Err(error) => return Err(error),
    };
    // SAFETY: `open_pidfd` returned a fresh descriptor this call owns
    // (and closes on drop, on every path).
    let fd = AsyncFd::with_interest(unsafe { OwnedFd::from_raw_fd(fd) }, Interest::READABLE)?;
    // Every wake is confirmed by a zero-timeout poll (AsyncFd readiness
    // can be spurious).
    loop {
        let mut ready = fd.readable().await?;
        if let Ok(result) = ready.try_io(|fd| {
            let mut probe = libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: polls one descriptor this call owns, without
            // blocking.
            match unsafe { libc::poll(&raw mut probe, 1, 0) } {
                1 => Ok(()),
                0 => Err(std::io::ErrorKind::WouldBlock.into()),
                _ => Err(std::io::Error::last_os_error()),
            }
        }) {
            return result;
        }
    }
}

/// macOS: kqueue `EVFILT_PROC`/`NOTE_EXIT` on a pollable kqueue.
///
/// # Errors
///
/// The OS error when the watch cannot register; the caller owns its
/// fallback.
#[cfg(target_os = "macos")]
pub async fn wait_for_exit(pid: u32) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use tokio::io::{unix::AsyncFd, Interest};

    // SAFETY: `kqueue()` takes no arguments.
    let kq = unsafe { libc::kqueue() };
    if kq < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a fresh descriptor this call owns (and closes on drop, on
    // every path).
    let kq = unsafe { OwnedFd::from_raw_fd(kq) };
    // The block drops the `kevent` value (its `udata` raw pointer is
    // `!Send`) before the first `.await`.
    {
        let change = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: registers one change and reads no events; `change`
        // outlives the call. With no event space, an attach failure comes
        // back as -1/errno (kevent(2)), not an `EV_ERROR` event.
        if unsafe {
            libc::kevent(
                kq.as_raw_fd(),
                &raw const change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            // `ESRCH` means the pid names no attachable process (reaped,
            // or already past its exit ref-drain - XNU runs the drain
            // before the exit knote fires): the exit already happened.
            // Every other errno (EMFILE, ENOMEM, ...) is a watch that
            // could not register; the caller falls back.
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ESRCH) => Ok(()),
                _ => Err(error),
            };
        }
    }
    let kq = AsyncFd::with_interest(kq, Interest::READABLE)?;
    // Only the exit knote is registered, so a drained event is the exit.
    loop {
        let mut ready = kq.readable().await?;
        if let Ok(result) = ready.try_io(|kq| {
            let zero = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            let mut event = libc::kevent {
                ident: 0,
                filter: 0,
                flags: 0,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            // SAFETY: drains one event with a zero timeout; `event` and
            // `zero` outlive the call.
            match unsafe {
                libc::kevent(
                    kq.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &raw mut event,
                    1,
                    &raw const zero,
                )
            } {
                1 => Ok(()),
                0 => Err(std::io::ErrorKind::WouldBlock.into()),
                _ => Err(std::io::Error::last_os_error()),
            }
        }) {
            return result;
        }
    }
}

/// No kernel exit watch on this platform: the caller takes its own
/// liveness-poll fallback.
///
/// # Errors
///
/// Always `Unsupported`.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::unused_async)] // one awaitable signature across the kernel-watch arms
pub async fn wait_for_exit(_pid: u32) -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// Windows: the shared handle probe (win32 has no unreaped-zombie state,
/// so existing and running are the same predicate - Node's `kill(pid, 0)`
/// checks the same `STILL_ACTIVE` exit code). A query that fails outright
/// reads as gone.
#[cfg(windows)]
#[must_use]
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
#[must_use]
pub fn termination_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
#[must_use]
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
        assert!(!kill_process_group(-1));
        assert!(!kill_process_group(0));
        assert!(!process_group_exists(-1));
        assert!(!process_group_exists(0));
    }
}

/// The kernel-watch arms' shared exit contract: a pid that names no live
/// process resolves at once, so a worker that died before its watch
/// registered still reports an exit. Both kernel-watch platforms only
/// (the other targets take the caller's fallback by design).
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod exit_wait_tests {
    use super::*;

    #[tokio::test]
    async fn wait_for_exit_resolves_at_once_for_a_reaped_pid() {
        let mut child = std::process::Command::new("sleep")
            .arg("600")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        child.kill().expect("kill sleep");
        child.wait().expect("reap sleep");
        assert!(
            wait_for_exit(pid).await.is_ok(),
            "a reaped pid resolves at once"
        );
    }
}

/// The group probe the teardown ladders drain on (TS `processGroupExists`)
/// and the enforced group-only kill they escalate to.
#[cfg(all(test, unix))]
mod process_group_tests {
    use super::*;

    #[test]
    fn process_group_exists_while_a_member_runs_and_not_after_it_drains() {
        let mut command = std::process::Command::new("sleep");
        command.arg("600");
        set_new_process_group(&mut command);
        let mut child = command.spawn().expect("spawn sleep");
        let pid = child.id() as i32;
        assert!(process_group_exists(pid), "the group holds its live leader");
        child.kill().expect("kill sleep");
        child.wait().expect("reap sleep");
        // The leader was the group's only member: reaped, nothing holds
        // the pgid and the enforced kill proves no delivery.
        assert!(
            !process_group_exists(pid),
            "a drained group names no members"
        );
        assert!(
            !kill_process_group(pid),
            "the enforced kill on a drained group is a proven no-op"
        );
    }
}

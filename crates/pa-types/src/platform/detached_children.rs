//! Tracked detached children: the registry shutdown signals kill (TS
//! `utils/shell.ts`).
//!
//! Detached children run in their own process groups, so the parent's death
//! never reaches them - the product tracks their pids at spawn and kills the
//! whole group on its own shutdown signals (TS `killTrackedDetachedChildren`,
//! called from the interactive client's SIGTERM handler and the
//! session-hosting process's SIGINT/SIGTERM/SIGHUP handlers). The registry
//! lives in pa-types because pa-tui (the interactive client) depends on
//! pa-types alone; pa-core re-exports [`kill_process_group_or_pid`], the
//! single tree-kill primitive both the tracking spawn sites and the
//! registry use.

use std::sync::Mutex;

/// The tracked detached child pids (TS `trackedDetachedChildPids`). One
/// registry per process: every surface that spawns detached children
/// registers them, every shutdown signal drains the set.
static TRACKED_DETACHED_CHILDREN: Mutex<Vec<i32>> = Mutex::new(Vec::new());

/// Track one detached child (TS `trackDetachedChildPid`): called right
/// after the spawn, dropped by [`untrack_detached_child_pid`] once the
/// child settles.
pub fn track_detached_child_pid(pid: i32) {
    if pid <= 0 {
        return;
    }
    if let Ok(mut tracked) = TRACKED_DETACHED_CHILDREN.lock() {
        if !tracked.contains(&pid) {
            tracked.push(pid);
        }
    }
}

/// Stop tracking one detached child (TS `untrackDetachedChildPid`): the
/// child settled on its own, so the shutdown kill must not race a
/// recycled pid.
pub fn untrack_detached_child_pid(pid: i32) {
    if let Ok(mut tracked) = TRACKED_DETACHED_CHILDREN.lock() {
        tracked.retain(|tracked| *tracked != pid);
    }
}

/// Kill every tracked detached child and clear the registry (TS
/// `killTrackedDetachedChildren`): each child's whole process group dies,
/// so no grandchild survives either.
pub fn kill_tracked_detached_children() {
    let pids: Vec<i32> = match TRACKED_DETACHED_CHILDREN.lock() {
        Ok(mut tracked) => std::mem::take(&mut *tracked),
        Err(poisoned) => std::mem::take(&mut poisoned.into_inner()),
    };
    for pid in pids {
        kill_process_group_or_pid(pid);
    }
}

/// Kill a process and all its children: the process group first (bash
/// children run detached in a new group), then the bare pid as fallback.
/// Returns true when either signal was delivered (TS `killProcessTree`).
#[cfg(unix)]
pub fn kill_process_group_or_pid(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: delivers SIGKILL to the child's process group, then to the
    // bare pid - exactly the two `process.kill` calls the TS tree-kill
    // makes.
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
/// parent-child relationship, so the detached-group flags are irrelevant
/// here. True only when taskkill exited 0, the same proof TS's
/// `result.status === 0` requires.
#[cfg(windows)]
pub fn kill_process_group_or_pid(pid: i32) -> bool {
    use std::os::windows::process::CommandExt;
    if pid <= 0 {
        return false;
    }
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from("C:\\Windows"));
    let taskkill = std::path::Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe");
    let mut command = std::process::Command::new(&taskkill);
    command
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    /// `winbase.h` `CREATE_NO_WINDOW` (TS `windowsHide`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
    command.status().is_ok_and(|status| status.success())
}

#[cfg(not(any(unix, windows)))]
pub fn kill_process_group_or_pid(_pid: i32) -> bool {
    // No tree-kill mechanism; the kill stays unproven, the conservative
    // answer callers act on.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_pids_are_never_tracked() {
        track_detached_child_pid(0);
        track_detached_child_pid(-5);
        kill_tracked_detached_children();
        assert!(!kill_process_group_or_pid(0));
        assert!(!kill_process_group_or_pid(-1));
    }

    #[test]
    fn untrack_removes_only_the_settled_child() {
        track_detached_child_pid(std::process::id() as i32 + 1);
        track_detached_child_pid(std::process::id() as i32 + 2);
        untrack_detached_child_pid(std::process::id() as i32 + 1);
        if let Ok(tracked) = TRACKED_DETACHED_CHILDREN.lock() {
            assert_eq!(*tracked, vec![std::process::id() as i32 + 2]);
        }
        // The drain clears the registry: a second drain kills nothing.
        kill_tracked_detached_children();
        if let Ok(tracked) = TRACKED_DETACHED_CHILDREN.lock() {
            assert!(tracked.is_empty());
        }
    }

    #[test]
    fn duplicate_tracks_collapse() {
        track_detached_child_pid(std::process::id() as i32 + 3);
        track_detached_child_pid(std::process::id() as i32 + 3);
        if let Ok(tracked) = TRACKED_DETACHED_CHILDREN.lock() {
            assert_eq!(tracked.len(), 1);
        }
        kill_tracked_detached_children();
    }

    /// The shutdown kill reaches the tracked child's whole process group:
    /// a spawned `sleep` (its own group, like a detached bash child) dies
    /// when the registry drains, and the drain clears the set.
    #[cfg(unix)]
    #[test]
    fn killing_the_registry_kills_the_tracked_child() {
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id() as i32;
        track_detached_child_pid(pid);
        kill_tracked_detached_children();
        // The kill is asynchronous; poll the child to its death (a plain
        // wait reaps it without hanging if the kill missed).
        for _ in 0..100 {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let exited = child.try_wait().expect("waitable").is_some();
        assert!(
            exited,
            "the registry drain must kill the tracked child process group"
        );
        if let Ok(tracked) = TRACKED_DETACHED_CHILDREN.lock() {
            assert!(tracked.is_empty());
        }
    }
}

//! Enable VT processing before the TUI's raw ANSI mode writes, restoring
//! only the bit this module added on exit. Redirected stdout is untouched.
//! Rust std provides console-aware Unicode I/O;
//! changing console-wide codepages is unnecessary and affects other users
//! of the attached console. Pipes retain their ordinary byte I/O.
//! The FFI uses pinned Win32 constants without a windows-sys dependency.

/// The original output mode, used to restore only the VT bit we added.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct OriginalConsole {
    output_mode: u32,
}

#[cfg(windows)]
static ORIGINAL: std::sync::OnceLock<OriginalConsole> = std::sync::OnceLock::new();

/// The kernel32 console surface, as a hand-declared extern wall (repo
/// policy: pinned constants and externs, no windows-sys dependency -
/// same policy as the named-pipe transport and the process wall).
#[cfg(windows)]
mod winapi {
    // The Win32 header names stay verbatim: the pinned-constants wall mirrors them.
    #![allow(non_snake_case)]

    use std::ffi::c_void;

    /// `winbase.h` `STD_OUTPUT_HANDLE`: the console output handle.
    const STD_OUTPUT_HANDLE: i32 = -11;
    /// `wincon.h` `ENABLE_VIRTUAL_TERMINAL_PROCESSING`: the console's VT
    /// parsing bit (0x4).
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;

    type Handle = *mut c_void;

    extern "system" {
        fn GetStdHandle(which: i32) -> Handle;
        fn GetConsoleMode(handle: Handle, mode: *mut u32) -> i32;
        fn SetConsoleMode(handle: Handle, mode: u32) -> i32;
        #[cfg(test)]
        fn GetConsoleOutputCP() -> u32;
        #[cfg(test)]
        fn GetConsoleCP() -> u32;
    }

    /// The process's console output handle, null when none.
    pub(crate) fn stdout_handle() -> Handle {
        unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }
    }

    /// The output handle's console mode; `None` when the handle is not a
    /// console (a redirect/pipe) - the console gate.
    pub(crate) fn output_mode(handle: Handle) -> Option<u32> {
        let mut mode = 0;
        let ok = unsafe { GetConsoleMode(handle, std::ptr::from_mut(&mut mode)) };
        (ok != 0).then_some(mode)
    }

    pub(crate) fn set_output_mode(handle: Handle, mode: u32) -> bool {
        unsafe { SetConsoleMode(handle, mode) != 0 }
    }

    #[cfg(test)]
    pub(crate) fn output_codepage() -> u32 {
        unsafe { GetConsoleOutputCP() }
    }

    #[cfg(test)]
    pub(crate) fn input_codepage() -> u32 {
        unsafe { GetConsoleCP() }
    }

    pub(crate) const fn enable_vt() -> u32 {
        ENABLE_VIRTUAL_TERMINAL_PROCESSING
    }
}

/// Enable VT on attached stdout without changing console codepages.
/// Idempotent; a no-op for redirected stdout and non-Windows hosts.
pub fn init() {
    #[cfg(windows)]
    {
        let handle = winapi::stdout_handle();
        let Some(original_mode) = winapi::output_mode(handle) else {
            return;
        };
        let _ = ORIGINAL.set(OriginalConsole {
            output_mode: original_mode,
        });
        let _ = winapi::set_output_mode(handle, original_mode | winapi::enable_vt());
    }
}

/// Restore only the VT bit added by [`init`], preserving other mode bits.
/// Best-effort; a no-op when no console was prepared.
pub fn restore() {
    #[cfg(windows)]
    {
        let Some(original) = ORIGINAL.get() else {
            return;
        };
        let handle = winapi::stdout_handle();
        let Some(current) = winapi::output_mode(handle) else {
            return;
        };
        if current & winapi::enable_vt() != 0 && original.output_mode & winapi::enable_vt() == 0 {
            // Only the VT bit [`init`] added comes off: raw mode (an
            // input-handle state) and any other bit the exit funnel's own
            // restores own stay untouched.
            let _ = winapi::set_output_mode(handle, current & !winapi::enable_vt());
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// The restore rides a drop guard: a failed assert below must still
    /// hand the console's session state back (the review rule for tests
    /// that touch shared state).
    struct ConsoleRestoreOnPanic;
    impl Drop for ConsoleRestoreOnPanic {
        fn drop(&mut self) {
            restore();
        }
    }

    /// Check VT setup/restore and that both console codepages stay intact.
    /// CI may redirect stdout, in which case init must remain a no-op.
    #[test]
    fn init_preserves_codepages_and_restores_vt() {
        let handle = winapi::stdout_handle();
        let Some(original_mode) = winapi::output_mode(handle) else {
            // A redirected (non-console) stdout: the gate keeps the
            // codepages untouched - a CI `tee` or a piped run must never
            // flip the host console.
            let before = (winapi::output_codepage(), winapi::input_codepage());
            init();
            assert_eq!(
                (winapi::output_codepage(), winapi::input_codepage()),
                before,
                "a non-console stdout must not be prepared"
            );
            return;
        };
        let original_output_cp = winapi::output_codepage();
        let original_input_cp = winapi::input_codepage();

        let _console_restore = ConsoleRestoreOnPanic;

        init();
        assert_eq!(winapi::output_codepage(), original_output_cp);
        assert_eq!(winapi::input_codepage(), original_input_cp);
        let mode = winapi::output_mode(handle).expect("the console mode");
        assert_ne!(
            mode & winapi::enable_vt(),
            0,
            "the VT bit rides the output mode: {mode:#x}"
        );

        restore();
        assert_eq!(
            winapi::output_codepage(),
            original_output_cp,
            "the output codepage stays unchanged"
        );
        assert_eq!(
            winapi::input_codepage(),
            original_input_cp,
            "the input codepage stays unchanged"
        );
        let back = winapi::output_mode(handle).expect("the console mode");
        assert_eq!(
            back & winapi::enable_vt(),
            original_mode & winapi::enable_vt(),
            "the restore hands back the original mode's VT state"
        );
    }
}

#[cfg(all(test, not(windows)))]
mod portable_tests {
    use super::*;

    /// The non-Windows contract the call sites rely on: both fns are
    /// total no-ops (the TUI mount and the exit funnel call them
    /// unconditionally).
    #[test]
    fn the_no_windows_arms_are_no_ops() {
        init();
        restore();
    }
}

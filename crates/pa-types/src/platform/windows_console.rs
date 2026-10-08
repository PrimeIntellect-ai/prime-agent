//! The Windows console preparation (the operator's 2026-10-08 broken-icons
//! report): the TUI emits fully-correct UTF-8 and writes it through Rust
//! std's `Stdout` -> `WriteFile`, and a Windows console (conhost) decodes
//! those bytes with the console's OUTPUT CODEPAGE - a legacy OEM/ANSI
//! codepage (437/1252/...) unless someone set 65001, so every multi-byte
//! glyph (`◆ ● ◐ ◷ ▸ ✉ ╰ ─ │ ·`) decodes as multi-character mojibake
//! even with VT processing on. Node-based TUIs (claude/codex) look fine on
//! the same box because libuv's tty write path converts to UTF-16 and
//! calls `WriteConsoleW`, bypassing the codepage; Rust std has no console
//! write path, so this process must set the codepage itself (the `chcp
//! 65001` the interactive shells do by hand).
//!
//! [`init`] prepares the attached console: both codepages to UTF-8 (65001)
//! plus `ENABLE_VIRTUAL_TERMINAL_PROCESSING` on the output handle (VT
//! parsing, the TUI's crossterm backend and its raw `write_all` mode-sets
//! both ride it), recording the originals for [`restore`]. The console
//! gate keeps redirected/pipe runs (headless tests, CI, `tee`) untouched:
//! a handle that is not a console answers the mode query with an error
//! and `init` is a no-op. Call sites never branch on `cfg`: both fns are
//! no-ops on non-Windows hosts.
//!
//! The FFI is the hand-declared wall the named-pipe transport and the
//! process-identity module already use (pinned constants, no windows-sys
//! dependency).

/// The recorded original console state, restored by [`restore`]: the
/// codepage flip is CONSOLE-SESSION state (it outlives the process when
/// not restored), so the composition root's exit funnel hands it back.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct OriginalConsole {
    output_cp: u32,
    input_cp: u32,
    output_mode: u32,
}

#[cfg(windows)]
static ORIGINAL: std::sync::OnceLock<OriginalConsole> = std::sync::OnceLock::new();

/// The kernel32 console surface, as a hand-declared extern wall (repo
/// policy: pinned constants and externs, no windows-sys dependency -
/// same policy as the named-pipe transport and the process wall).
#[cfg(windows)]
mod winapi {
    #![allow(non_snake_case)]

    use std::ffi::c_void;

    /// `winbase.h` `STD_OUTPUT_HANDLE`: the console output handle.
    const STD_OUTPUT_HANDLE: i32 = -11;
    /// `wincon.h` `ENABLE_VIRTUAL_TERMINAL_PROCESSING`: the console's VT
    /// parsing bit (0x4).
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
    /// `winnls.h` `CP_UTF8`: the UTF-8 console codepage.
    const CP_UTF8: u32 = 65001;

    type Handle = *mut c_void;

    extern "system" {
        fn GetStdHandle(which: i32) -> Handle;
        fn GetConsoleMode(handle: Handle, mode: *mut u32) -> i32;
        fn SetConsoleMode(handle: Handle, mode: u32) -> i32;
        fn GetConsoleOutputCP() -> u32;
        fn SetConsoleOutputCP(codepage: u32) -> i32;
        fn GetConsoleCP() -> u32;
        fn SetConsoleCP(codepage: u32) -> i32;
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

    pub(crate) fn output_codepage() -> u32 {
        unsafe { GetConsoleOutputCP() }
    }

    pub(crate) fn set_output_codepage(codepage: u32) -> bool {
        unsafe { SetConsoleOutputCP(codepage) != 0 }
    }

    pub(crate) fn input_codepage() -> u32 {
        unsafe { GetConsoleCP() }
    }

    pub(crate) fn set_input_codepage(codepage: u32) -> bool {
        unsafe { SetConsoleCP(codepage) != 0 }
    }

    pub(crate) const fn cp_utf8() -> u32 {
        CP_UTF8
    }

    pub(crate) const fn enable_vt() -> u32 {
        ENABLE_VIRTUAL_TERMINAL_PROCESSING
    }
}

/// Prepare the attached console for UTF-8 + VT output (the TUI mount and
/// the CLI's terminal-mode output). Idempotent (the first call records
/// the originals; later calls re-apply the same values); a no-op when
/// stdout is not a console (pipes, redirects, headless runs) and on
/// non-Windows hosts. Returns whether a live console was prepared.
pub fn init() -> bool {
    #[cfg(windows)]
    {
        let handle = winapi::stdout_handle();
        let Some(original_mode) = winapi::output_mode(handle) else {
            return false;
        };
        let _ = ORIGINAL.set(OriginalConsole {
            output_cp: winapi::output_codepage(),
            input_cp: winapi::input_codepage(),
            output_mode: original_mode,
        });
        // Best-effort, each flip independently: a failed setter leaves
        // the originals recorded, and the restore only hands back what
        // differs from the recorded state.
        let _ = winapi::set_output_codepage(winapi::cp_utf8());
        let _ = winapi::set_input_codepage(winapi::cp_utf8());
        let _ = winapi::set_output_mode(handle, original_mode | winapi::enable_vt());
        true
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Restore the recorded console state at the process exit funnel (the
/// codepage is console-session state: the interactive shell the process
/// hands back must not inherit 65001 if it was not the shell's own). A
/// no-op when [`init`] never prepared a console; best-effort on every
/// failure path.
pub fn restore() {
    #[cfg(windows)]
    {
        let Some(original) = ORIGINAL.get() else {
            return;
        };
        if original.output_cp != winapi::cp_utf8() {
            let _ = winapi::set_output_codepage(original.output_cp);
        }
        if original.input_cp != winapi::cp_utf8() {
            let _ = winapi::set_input_codepage(original.input_cp);
        }
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

    /// The mechanism the operator's report pins (2026-10-08): after
    /// `init`, the attached console decodes the TUI's UTF-8 output as
    /// UTF-8 and parses its VT sequences - the codepages read 65001 and
    /// the output mode carries the VT bit - and `restore` hands the
    /// console back. Runs on the windows runner (the runtime-triage
    /// battery); the cross gate type-checks it. The console is
    /// process-global state, so the test keeps its own originals instead
    /// of trusting the module's.
    #[test]
    fn init_flips_the_console_to_utf8_and_vt_and_restore_hands_it_back() {
        let handle = winapi::stdout_handle();
        let Some(original_mode) = winapi::output_mode(handle) else {
            assert!(!init(), "a non-console stdout must not be prepared");
            return;
        };
        let original_output_cp = winapi::output_codepage();
        let original_input_cp = winapi::input_codepage();

        assert!(init(), "a live console is prepared");
        assert_eq!(winapi::output_codepage(), winapi::cp_utf8());
        assert_eq!(winapi::input_codepage(), winapi::cp_utf8());
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
            "the output codepage returns to the shell's"
        );
        assert_eq!(
            winapi::input_codepage(),
            original_input_cp,
            "the input codepage returns to the shell's"
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
    /// unconditionally), and `init` answers false - nothing was prepared.
    #[test]
    fn the_no_windows_arms_are_no_ops() {
        assert!(!init());
        restore();
    }
}

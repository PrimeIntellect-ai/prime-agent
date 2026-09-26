//! Terminal clipboard writes (TS `utils/clipboard.ts` `copyToClipboard`):
//! the platform clipboard tools first (they hold selection ownership), then
//! the OSC 52 escape for remote sessions or when no tool copied. The OSC 52
//! payload cap and the final error text are TS-verbatim; the TS native
//! `clipboard-rs` addon (skipped on Linux by TS itself) has no Rust
//! counterpart, so the tool chain plus OSC 52 is the full port.

use std::io::Write;
use std::process::{Command, Stdio};

/// The OSC 52 payload channel: stdout in the terminal, a captured buffer in
/// headless verification runs.
pub(crate) enum OscSink {
    Stdout,
    Buffer(Vec<u8>),
}

impl OscSink {
    fn write_sequence(&mut self, sequence: &str) {
        match self {
            OscSink::Stdout => {
                let mut out = std::io::stdout();
                // The sequence is zero-width; a write failure (closed pipe)
                // must not fail the copy attempt chain.
                let _ = out.write_all(sequence.as_bytes());
                let _ = out.flush();
            }
            OscSink::Buffer(buffer) => buffer.extend_from_slice(sequence.as_bytes()),
        }
    }
}

/// TS `isRemoteSession`: any SSH or mosh transport means the local tools
/// would target the wrong machine, so OSC 52 carries the copy home.
fn is_remote_session(env: &Env) -> bool {
    env.has("SSH_CONNECTION") || env.has("SSH_CLIENT") || env.has("MOSH_CONNECTION")
}

/// TS `isWaylandSession`.
fn is_wayland_session(env: &Env) -> bool {
    env.has("WAYLAND_DISPLAY") || env.value("XDG_SESSION_TYPE").as_deref() == Some("wayland")
}

/// The environment the copy chain reads (the process environment in the
/// product, a scripted table in tests).
struct Env {
    values: std::collections::BTreeMap<String, Option<String>>,
}

impl Env {
    fn process() -> Self {
        let keys = [
            "SSH_CONNECTION",
            "SSH_CLIENT",
            "MOSH_CONNECTION",
            "TERMUX_VERSION",
            "WAYLAND_DISPLAY",
            "XDG_SESSION_TYPE",
            "DISPLAY",
        ];
        Env {
            values: keys
                .iter()
                .map(|key| ((*key).to_string(), std::env::var(key).ok()))
                .collect(),
        }
    }

    #[cfg(test)]
    fn scripted<const N: usize>(pairs: [(&'static str, Option<&'static str>); N]) -> Self {
        Env {
            values: pairs
                .into_iter()
                .map(|(key, value)| (key.to_string(), value.map(str::to_string)))
                .collect(),
        }
    }

    fn has(&self, key: &str) -> bool {
        self.values.get(key).is_some_and(Option::is_some)
    }

    fn value(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned().flatten()
    }
}

/// TS `execSyncHidden`'s helper deadline: a tool that wedges — `wl-copy`
/// waiting on a compositor that never focuses — dies at the deadline
/// instead of hanging the input loop that copied.
const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(5_000);

/// Run `program` with `text` on its stdin (the pipe write plus process
/// wait are quick enough that a synchronous call matches the TS
/// behavior).
fn pipe_to(program: &str, args: &[&str], text: &str) -> bool {
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let wrote = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(text.as_bytes()).is_ok());
    let deadline = std::time::Instant::now() + HELPER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success() && wrote,
            Ok(None) => {}
            Err(_) => return false,
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// The Linux tool chain (TS order): Termux, then Wayland (`wl-copy` when it
/// exists), then the X11 pair (`xclip` with `xsel` fallback).
fn copy_on_linux(text: &str, env: &Env) -> bool {
    if env.has("TERMUX_VERSION") && pipe_to("termux-clipboard-set", &[], text) {
        return true;
    }
    let has_wayland = env.has("WAYLAND_DISPLAY");
    let has_x11 = env.has("DISPLAY");
    if is_wayland_session(env) && has_wayland {
        // TS verifies the tool exists before relying on the async spawn.
        let wl_copy_exists = Command::new("which")
            .arg("wl-copy")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if wl_copy_exists && pipe_to("wl-copy", &[], text) {
            return true;
        }
        if has_x11 {
            return copy_to_x11(text);
        }
        return false;
    }
    if has_x11 {
        return copy_to_x11(text);
    }
    false
}

/// TS `copyToX11Clipboard`: `xclip -selection clipboard`, falling back to
/// `xsel --clipboard --input`.
fn copy_to_x11(text: &str) -> bool {
    pipe_to("xclip", &["-selection", "clipboard"], text)
        || pipe_to("xsel", &["--clipboard", "--input"], text)
}

/// Copy `text` to the user's clipboard (TS `copyToClipboard`): platform
/// tools, then OSC 52 for remote sessions or when no tool copied. Errors
/// resolve with the TS wording.
pub(crate) fn copy_to_clipboard(text: &str, sink: &mut OscSink) -> Result<(), String> {
    copy_with_env(text, sink, &Env::process())
}

fn copy_with_env(text: &str, sink: &mut OscSink, env: &Env) -> Result<(), String> {
    let mut copied = false;
    if !copied {
        copied = match std::env::consts::OS {
            "macos" => pipe_to("pbcopy", &[], text),
            "windows" => pipe_to("clip", &[], text),
            _ => copy_on_linux(text, env),
        };
    }
    let remote = is_remote_session(env);
    if copied && !remote {
        return Ok(());
    }
    if remote || !copied {
        if let Some(sequence) = crate::osc52::sequence(text) {
            sink.write_sequence(&sequence);
            copied = true;
        }
    }
    if copied {
        Ok(())
    } else {
        Err("Failed to copy to clipboard".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_env() -> Env {
        Env::scripted([
            ("SSH_CONNECTION", None),
            ("SSH_CLIENT", None),
            ("MOSH_CONNECTION", None),
            ("TERMUX_VERSION", None),
            ("WAYLAND_DISPLAY", None),
            ("XDG_SESSION_TYPE", None),
            ("DISPLAY", None),
        ])
    }

    #[test]
    fn a_refused_osc52_payload_fails_the_copy_with_the_ts_wording() {
        let mut sink = OscSink::Buffer(Vec::new());
        let big = "a".repeat(200_001);
        let result = copy_with_env(&big, &mut sink, &plain_env());
        assert_eq!(result, Err("Failed to copy to clipboard".to_string()));
        assert!(matches!(sink, OscSink::Buffer(buffer) if buffer.is_empty()));
    }

    #[test]
    fn a_small_text_without_tools_emits_osc52() {
        let mut sink = OscSink::Buffer(Vec::new());
        copy_with_env("parity text", &mut sink, &plain_env()).expect("copy succeeds via OSC 52");
        match sink {
            OscSink::Buffer(buffer) => {
                let bytes = String::from_utf8(buffer).expect("utf8");
                assert_eq!(bytes, "\x1b]52;c;cGFyaXR5IHRleHQ=\x07");
            }
            OscSink::Stdout => panic!("the buffer sink captured nothing"),
        }
    }

    #[test]
    fn a_remote_session_emits_osc52_even_after_a_tool_copy() {
        let mut sink = OscSink::Buffer(Vec::new());
        let env = Env::scripted([
            ("SSH_CONNECTION", Some("1.2.3.4")),
            ("SSH_CLIENT", None),
            ("MOSH_CONNECTION", None),
            ("TERMUX_VERSION", None),
            ("WAYLAND_DISPLAY", None),
            ("XDG_SESSION_TYPE", None),
            ("DISPLAY", None),
        ]);
        copy_with_env("remote text", &mut sink, &env).expect("copy succeeds via OSC 52");
        match sink {
            OscSink::Buffer(buffer) => {
                let bytes = String::from_utf8(buffer).expect("utf8");
                assert_eq!(bytes, "\x1b]52;c;cmVtb3RlIHRleHQ=\x07");
            }
            OscSink::Stdout => panic!("the buffer sink captured nothing"),
        }
    }
}

//! Terminal clipboard requests. Local clipboard tools confirm delivery;
//! tmux buffer forwarding and OSC 52 cannot confirm receipt by the user's
//! terminal. All user-facing copy paths share this chain and its size cap.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The OSC 52 payload channel: stdout in the terminal, a captured buffer in
/// headless verification runs.
pub(crate) enum OscSink {
    Stdout,
    Buffer(Vec<u8>),
}

impl OscSink {
    fn write_sequence(&mut self, sequence: &str) -> std::io::Result<()> {
        match self {
            OscSink::Stdout => {
                let mut out = std::io::stdout();
                out.write_all(sequence.as_bytes())?;
                out.flush()
            }
            OscSink::Buffer(buffer) => {
                buffer.extend_from_slice(sequence.as_bytes());
                Ok(())
            }
        }
    }
}

/// tmux with `external` or `off` discards application-origin OSC 52.
/// A tmux-owned buffer can still be forwarded with `external` when an
/// attached client advertises the Ms clipboard capability.
pub(crate) fn tmux_blocks_osc52() -> bool {
    if std::env::var_os("TMUX").is_none() {
        return false;
    }
    tmux_output(&["show", "-s", "set-clipboard"])
        .is_some_and(|output| tmux_clipboard_setting_blocks(output.as_bytes()))
}

fn tmux_clipboard_setting_blocks(output: &[u8]) -> bool {
    matches!(
        String::from_utf8_lossy(output).trim(),
        "set-clipboard external" | "set-clipboard off"
    )
}

pub(crate) const TMUX_CLIPBOARD_BLOCKED: &str =
    "tmux cannot forward this copy to a clipboard. Check its attached client's Ms capability and each outer tmux hop.";
pub(crate) const CLIPBOARD_REQUESTED: &str =
    "Clipboard request sent; paste in the local terminal to verify delivery";
/// The oversized remote fallback's report: the helper wrote the machine
/// the TUI runs on, not the user's local clipboard.
const OVERSIZED_REMOTE_COPIED: &str =
    "Payload too large for terminal forwarding; copied to the remote machine's clipboard instead";

fn tmux_output(args: &[&str]) -> Option<String> {
    let mut child = Command::new("tmux")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    probe_output(&mut child)
}

/// One bounded probe's output, or `None` when the child fails or misses
/// the deadline: the pipe drains from its own thread for the whole life
/// of the child (the `pipe_to` writer-thread shape), so a probe writing
/// past the pipe buffer still exits.
fn probe_output(child: &mut std::process::Child) -> Option<String> {
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        stdout
            .and_then(|mut pipe| pipe.read_to_string(&mut output).ok())
            .map(|_| output)
    });
    let deadline = std::time::Instant::now() + HELPER_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(PIPE_POLL),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    }?;
    // The child exited, so its pipe reaches EOF and the reader ends.
    let output = reader.join().ok().flatten()?;
    status.success().then_some(output)
}

/// Ask tmux to originate the clipboard write. `external` allows tmux's own
/// writes, unlike the application OSC 52 path. No terminal protocol confirms
/// that an outer tmux or terminal actually received the request.
pub(crate) fn copy_via_tmux(text: &str) -> bool {
    let Ok(pane) = std::env::var("TMUX_PANE") else {
        return false;
    };
    // `set-clipboard` is a server option on every tmux since 2.6; tmux
    // before 3.0 picks the probe's option tree from the flags alone, so
    // without `-s` the session tree rejects the name and forwarding is
    // silently skipped.
    if tmux_output(&["show-options", "-s", "-gv", "set-clipboard"])
        .is_none_or(|value| value.trim() == "off")
    {
        return false;
    }
    let Some(window) = tmux_output(&["display-message", "-p", "-t", &pane, "#{window_id}"]) else {
        return false;
    };
    let Some(clients) = tmux_output(&[
        "list-clients",
        "-F",
        "#{client_activity} #{window_id} #{client_name}",
    ]) else {
        return false;
    };
    let Some(client) = pane_client(&clients, window.trim()) else {
        return false;
    };
    let client = client.as_str();
    let Some(terminal) = tmux_output(&["show-messages", "-T", "-t", client]) else {
        return false;
    };
    if !terminal.lines().any(|line| {
        line.split_once("Ms: (string) ")
            .is_some_and(|(_, capability)| !capability.trim().is_empty())
    }) {
        return false;
    }
    pipe_to("tmux", &["load-buffer", "-w", "-t", client, "-"], text)
}

/// The client a pane's copy is forwarded to: the most recently active
/// client whose current window IS the pane's window. The typist types
/// through that client, so it receives the copy; a busier client on
/// another window must not — its user's clipboard would take the
/// payload, and a sign-in link can ride a copy. Clients sharing the
/// window (a mirrored session) fall back to activity, which can only
/// misdeliver to someone already viewing the pane.
fn pane_client(clients: &str, pane_window: &str) -> Option<String> {
    clients
        .lines()
        .filter_map(|line| {
            let (activity, rest) = line.split_once(' ')?;
            let (window, client) = rest.split_once(' ')?;
            (window == pane_window).then_some((activity.parse::<u64>().ok()?, client))
        })
        .max_by_key(|(activity, _)| *activity)
        .map(|(_, client)| client.to_string())
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
/// The bounded wait's poll cadence.
const PIPE_POLL: Duration = Duration::from_millis(20);

/// Run `program` with `text` on its stdin (TS `execSyncHidden`'s
/// deadline): a helper that does not finish inside the cap is killed
/// and reported as a failed copy.
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
    // The whole payload reaches the helper (TS `execSyncHidden` writes
    // the entire input under its 5s cap, with no size prefilter: `/copy`
    // and the selection copy carry arbitrary chat text, not just URLs
    // and keys). The write rides its own thread so a helper that never
    // reads a payload larger than the pipe buffer cannot hang the input
    // loop: the deadline below kills the child, the closed pipe fails
    // the blocked write, and the detached writer ends on its own.
    let write_result = {
        let stdin = child.stdin.take();
        let payload = text.as_bytes().to_vec();
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        std::thread::spawn(move || {
            let _ = tx.send(stdin.is_some_and(|mut stdin| stdin.write_all(&payload).is_ok()));
        });
        rx
    };
    // The bounded wait (std carries no `Child::wait_timeout`): poll the
    // exit until the deadline, then kill the hung helper and reap it.
    let deadline = std::time::Instant::now() + HELPER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // The helper read the payload before exiting; a helper
                // that closed its stdin without reading fails the write
                // promptly, and a wedged reader loses the rest of the
                // deadline instead of hanging the caller.
                let wrote = write_result
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .unwrap_or(false);
                return status.success() && wrote;
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(PIPE_POLL),
            Err(_) => return false,
        }
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
            // No inherited fds: a probe must never hold the terminal the
            // TUI owns (the fd-set audit's rule — no child holds
            // /dev/tty).
            .stdin(Stdio::null())
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

/// Copy text using a local platform tool or request delivery via the terminal.
/// A terminal request has no acknowledgement from the local clipboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CopyOutcome {
    Confirmed,
    Requested,
}

/// A platform helper's success: a local session's helper wrote the user's
/// own clipboard, while a remote session's helper wrote the machine the
/// TUI runs on — the user's local terminal cannot paste from it, and the
/// payload is too large for OSC 52 — so the copy reports where the text
/// landed instead of confirming delivery.
fn helper_outcome(remote: bool) -> Result<CopyOutcome, String> {
    if remote {
        Err(OVERSIZED_REMOTE_COPIED.to_string())
    } else {
        Ok(CopyOutcome::Confirmed)
    }
}

pub(crate) fn copy_to_clipboard(text: &str, sink: &mut OscSink) -> Result<CopyOutcome, String> {
    copy_with_env(text, sink, &Env::process())
}

/// The containing tmux's rejected-application-OSC 52 explanation, only
/// while the payload could ride OSC 52 at all: an oversized payload never
/// reaches the terminal channel, so it must not blame tmux's client
/// capability or the outer hops — the plain failure wording covers it.
fn tmux_clipboard_blocked(carriable: bool, blocks: impl FnOnce() -> bool) -> Option<String> {
    (carriable && blocks()).then(|| TMUX_CLIPBOARD_BLOCKED.to_string())
}

fn copy_with_env(text: &str, sink: &mut OscSink, env: &Env) -> Result<CopyOutcome, String> {
    let remote = is_remote_session(env);
    // The cap gate is a length check, not the encoding: the local
    // helpers below take the raw payload, and only an OSC 52 write
    // needs the encoded sequence.
    let carriable = crate::osc52::carries(text);
    // Remote tools target the wrong machine and can stall the input loop
    // before terminal forwarding. Keep them for payloads too large for OSC 52.
    let copied = if matches!(sink, OscSink::Buffer(_)) || (remote && carriable) {
        false
    } else {
        match std::env::consts::OS {
            "macos" => pipe_to("pbcopy", &[], text),
            "windows" => pipe_to("clip", &[], text),
            _ => copy_on_linux(text, env),
        }
    };
    if copied {
        return helper_outcome(remote);
    }
    if matches!(sink, OscSink::Stdout) && std::env::var_os("TMUX").is_some() {
        // The containing tmux originates this copy even with its default
        // `set-clipboard external`; raw application OSC 52 is rejected there.
        if carriable && copy_via_tmux(text) {
            return Ok(CopyOutcome::Requested);
        }
        if let Some(error) = tmux_clipboard_blocked(carriable, tmux_blocks_osc52) {
            return Err(error);
        }
    }
    if let Some(sequence) = crate::osc52::sequence(text) {
        sink.write_sequence(&sequence)
            .map_err(|error| format!("Failed to write clipboard request: {error}"))?;
        return Ok(CopyOutcome::Requested);
    }
    Err("Failed to copy to clipboard".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmux_application_clipboard_policy() {
        assert!(tmux_clipboard_setting_blocks(b"set-clipboard external\n"));
        assert!(tmux_clipboard_setting_blocks(b"set-clipboard off\n"));
        assert!(!tmux_clipboard_setting_blocks(b"set-clipboard on\n"));
    }

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
        assert_eq!(
            copy_with_env("parity text", &mut sink, &plain_env()),
            Ok(CopyOutcome::Requested)
        );
        match sink {
            OscSink::Buffer(buffer) => {
                let bytes = String::from_utf8(buffer).expect("utf8");
                assert_eq!(bytes, "\x1b]52;c;cGFyaXR5IHRleHQ=\x07");
            }
            OscSink::Stdout => panic!("the buffer sink captured nothing"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_probe_that_fills_the_pipe_still_drains_and_exits() {
        use std::process::{Command, Stdio};
        // The payload overruns any platform's pipe buffer: the drain runs
        // while the child is alive, or the child blocks on its write and
        // the probe misses the deadline.
        let mut child = Command::new("sh")
            .args(["-c", "head -c 262144 /dev/zero | tr '\\0' x"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sh spawns");
        let output = probe_output(&mut child).expect("the probe drains the full pipe");
        assert_eq!(output.len(), 262_144);
    }

    #[test]
    fn the_pane_window_client_wins_over_a_busier_client_elsewhere() {
        // The busier client sits on another window: its user must not
        // receive the copy; the client viewing the pane's window does.
        let clients = "1780000000 @2 /dev/pts/2\n1770000000 @1 /dev/pts/1\n";
        assert_eq!(pane_client(clients, "@1").as_deref(), Some("/dev/pts/1"));
        // No client views the pane's window: forwarding must not guess.
        assert_eq!(pane_client(clients, "@3"), None);
    }

    #[test]
    fn an_oversized_payload_never_blames_tmux_capability() {
        assert_eq!(
            tmux_clipboard_blocked(false, || true),
            None,
            "an oversized payload cannot ride the terminal channel at all"
        );
        assert_eq!(
            tmux_clipboard_blocked(true, || true),
            Some(TMUX_CLIPBOARD_BLOCKED.to_string())
        );
        assert_eq!(tmux_clipboard_blocked(true, || false), None);
    }

    #[test]
    fn a_remote_helper_success_never_confirms_local_delivery() {
        assert_eq!(
            helper_outcome(true),
            Err(OVERSIZED_REMOTE_COPIED.to_string())
        );
        assert_eq!(helper_outcome(false), Ok(CopyOutcome::Confirmed));
    }

    #[test]
    fn a_remote_oversized_payload_falls_through_without_a_confirmed_copy() {
        // The helper fallback writes the remote machine's clipboard, which
        // can never confirm the user's local delivery; with no helper to
        // run (the headless sink's shape) the copy simply fails.
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
        let big = "a".repeat(200_001);
        assert_eq!(
            copy_with_env(&big, &mut sink, &env),
            Err("Failed to copy to clipboard".to_string())
        );
        assert!(matches!(sink, OscSink::Buffer(buffer) if buffer.is_empty()));
    }

    #[test]
    fn a_remote_session_emits_osc52_without_local_tools() {
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

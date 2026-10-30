//! The user-configurable status line (the `statusLine` setting): a shell
//! command whose stdout renders as dim footer rows above the activity dock
//! — the Rust successor of the TS `ctx.ui.setFooter` extension hook. The
//! command receives a JSON session payload on stdin; ANSI escapes in its
//! stdout are stripped; a command that fails, times out, or prints nothing
//! renders nothing, and the previous output stays (the built-in chrome
//! never loses its rows).

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_types::status_line::StatusLineSpec;

use crate::ansi::strip_ansi;
use crate::chrome::ChromeState;

/// How often the command re-runs while the view is idle.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(30);
/// A command that outlives this is killed: the footer never blocks the UI.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
/// The stdout cap: a status line is a footer, not a page.
const MAX_OUTPUT_BYTES: usize = 16 * 1024;
/// The rendered-line cap (multi-line status lines are supported).
const MAX_LINES: usize = 4;
/// How long the drain wait covers after the shell exits: a grandchild that
/// keeps the pipe open must not wedge the run (the drain thread ends at
/// pipe close, holding nothing the driver needs).
const OUTPUT_GRACE: Duration = Duration::from_millis(500);

/// The thread-safe result slot the render loop reads: `None` until the
/// first successful run.
#[derive(Default)]
pub(crate) struct SharedOutput(Mutex<Option<Vec<String>>>);

impl SharedOutput {
    /// A copy of the latest output (the slot is never cleared).
    fn snapshot(&self) -> Option<Vec<String>> {
        self.0.lock().expect("status line output poisoned").clone()
    }

    fn store(&self, lines: Vec<String>) {
        *self.0.lock().expect("status line output poisoned") = Some(lines);
    }
}

/// The JSON payload written to the command's stdin. `version` is the
/// running product version; `context.percent` is a 0-100 scale.
#[must_use]
pub fn payload(chrome: &ChromeState) -> Value {
    json!({
        "version": chrome.version,
        "session": {
            "name": chrome.chat_name,
            "depth": chrome.tray_depth,
        },
        "cwd": chrome.cwd,
        "model": {
            "id": chrome.model_id,
            "provider": chrome.model_provider,
            "thinking": chrome.thinking_suffix,
        },
        "serviceTier": chrome.service_tier,
        "context": chrome.context.map(|context| {
            json!({
                "tokens": context.tokens,
                "window": context.context_window,
                "percent": context.percent(),
            })
        }),
        "costUsd": chrome.cost_usd,
        "speed": chrome.speed_text,
    })
}

/// Run the command once, bounded: its stripped, capped output lines on
/// success; `Err` (spawn failure, non-zero exit, timeout) keeps whatever
/// output the previous successful run left.
///
/// # Errors
///
/// Returns `Err` on spawn failure, a non-zero exit, a timeout kill, an
/// stdout that stays open past the grace window, or empty output.
pub fn run_command(
    command: &str,
    payload: &Value,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("spawn: {error}"))?;
    // The payload on stdin, then closed: a reading command (cat) gets EOF.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.to_string().as_bytes());
        let _ = stdin.flush();
    }
    // The reader drains stdout to EOF, keeping the first MAX_OUTPUT_BYTES: a writer past the cap
    // must not meet a closed read end, or SIGPIPE turns its success exit into a failure and
    // discards the output already read.
    let stdout = child.stdout.take().map(|pipe| {
        let (tx, rx) = std::sync::mpsc::channel();
        let drain = std::thread::spawn(move || {
            use std::io::Read;
            let mut kept: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 8192];
            let mut source = pipe;
            loop {
                match source.read(&mut chunk) {
                    // EOF and read errors both end the drain (a writer error past the cap is
                    // not a status line failure: the kept prefix is still the output).
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if kept.len() < MAX_OUTPUT_BYTES {
                            let room = MAX_OUTPUT_BYTES - kept.len();
                            kept.extend_from_slice(&chunk[..n.min(room)]);
                        }
                        // Past the cap: the read itself is the drain.
                    }
                }
            }
            let _ = tx.send(kept);
        });
        (drain, rx)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("timeout".to_string());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    };
    // The pipe can outlive the shell (a backgrounded grandchild keeps the write end): wait for
    // the drain with a grace window instead of joining unbounded — a wedge there would freeze
    // the status line for the life of the surface.
    let bytes = match stdout {
        Some((_, rx)) => match rx.recv_timeout(OUTPUT_GRACE) {
            Ok(bytes) => bytes,
            Err(_) => return Err("stdout stayed open".to_string()),
        },
        None => Vec::new(),
    };
    if !status.success() {
        return Err(format!("exit {status}"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<String> = text
        .lines()
        .map(|line| strip_ansi(line).trim_end().to_string())
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
        .collect();
    if lines.is_empty() {
        return Err("empty output".to_string());
    }
    Ok(lines)
}

/// The driver held by the view: schedules re-runs and hands the latest
/// output to the chrome for rendering.
pub struct StatusLine {
    spec: StatusLineSpec,
    output: Arc<SharedOutput>,
    /// Set by the worker after a store the chrome has not copied yet; the
    /// run loop reads it through `frame_wake` to repaint.
    fresh: Arc<AtomicBool>,
    in_flight: Arc<AtomicBool>,
    next_refresh_at: Instant,
}

impl StatusLine {
    /// The first run is due immediately: the footer does not wait out the
    /// first interval after attach.
    #[must_use]
    pub fn new(spec: StatusLineSpec, now: Instant) -> Self {
        Self {
            spec,
            output: Arc::default(),
            fresh: Arc::new(AtomicBool::new(false)),
            in_flight: Arc::new(AtomicBool::new(false)),
            next_refresh_at: now,
        }
    }

    /// Force the next draw to re-run: a turn end, a model change, and a
    /// session rebuild all land here.
    pub fn force(&mut self, now: Instant) {
        self.next_refresh_at = now;
    }

    /// The frame-wake instant for the run loop: now when the worker stored
    /// output the chrome has not copied yet, otherwise the next scheduled
    /// re-run.
    #[must_use]
    pub fn frame_wake(&self) -> Instant {
        if self.fresh.load(Ordering::Acquire) {
            Instant::now()
        } else {
            self.next_refresh_at
        }
    }

    /// Copy the latest output into the chrome; spawn a re-run when due and
    /// no run is in flight.
    pub fn refresh_due(&mut self, now: Instant, chrome: &mut ChromeState) {
        // Cleared before the snapshot: a store that lands after the clear
        // keeps the flag up and repaints on the next pass.
        self.fresh.store(false, Ordering::Release);
        chrome.status_line = self.output.snapshot().unwrap_or_default();
        chrome.status_line_padding = self.spec.padding.unwrap_or(0);
        if self.in_flight.load(Ordering::Acquire) || now < self.next_refresh_at {
            return;
        }
        let payload = payload(chrome);
        let command = self.spec.command.clone();
        self.in_flight.store(true, Ordering::Release);
        self.next_refresh_at = now + REFRESH_INTERVAL;
        let output = Arc::clone(&self.output);
        let fresh = Arc::clone(&self.fresh);
        let in_flight = Arc::clone(&self.in_flight);
        std::thread::spawn(move || {
            if let Ok(lines) = run_command(&command, &payload, COMMAND_TIMEOUT) {
                output.store(lines);
                fresh.store(true, Ordering::Release);
            }
            in_flight.store(false, Ordering::Release);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chrome::ContextUsage;

    /// Poll a condition until it holds or the budget runs out: the tests
    /// wait for the spawned runs' observable effect (the counter file),
    /// not a fixed sleep.
    fn wait_for(budget: Duration, probe: impl Fn() -> bool) {
        let deadline = Instant::now() + budget;
        while !probe() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn chrome() -> ChromeState {
        ChromeState {
            version: "9.9.9".to_string(),
            chat_name: "sess".to_string(),
            cwd: "/tmp/proj".to_string(),
            model_id: Some("slow".to_string()),
            model_provider: Some("llama-cpp-strix".to_string()),
            cost_usd: Some(0.25),
            context: Some(ContextUsage {
                tokens: 1_000,
                context_window: 200_000,
            }),
            ..ChromeState::default()
        }
    }

    #[test]
    fn the_payload_carries_the_session_facts() {
        let value = payload(&chrome());
        assert_eq!(value["version"], "9.9.9");
        assert_eq!(value["session"]["name"], "sess");
        assert_eq!(value["cwd"], "/tmp/proj");
        assert_eq!(value["model"]["id"], "slow");
        assert_eq!(value["model"]["provider"], "llama-cpp-strix");
        assert_eq!(value["context"]["tokens"], 1_000);
        assert_eq!(value["context"]["window"], 200_000);
        assert_eq!(value["context"]["percent"], 0.5);
        assert_eq!(value["costUsd"], 0.25);
        assert!(value["serviceTier"].is_null());
    }

    #[test]
    fn the_command_sees_the_payload_on_stdin() {
        let lines =
            run_command("cat", &json!({ "a": 1 }), Duration::from_secs(2)).expect("cat exits zero");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"a\":1"));
    }

    #[test]
    fn ansi_escapes_are_stripped_and_blank_lines_dropped() {
        let command = r"printf 'one
[1;32mtwo[0m

three
'";
        let lines = run_command(command, &json!({}), Duration::from_secs(2)).expect("printf");
        assert_eq!(
            lines,
            vec!["one".to_string(), "two".to_string(), "three".to_string(),]
        );
    }

    #[test]
    fn a_slow_command_times_out_and_is_killed() {
        let started = Instant::now();
        let error = run_command("sleep 5", &json!({}), Duration::from_millis(200))
            .expect_err("the deadline wins");
        assert_eq!(error, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_backgrounded_grandchild_cannot_wedge_the_run() {
        // sh exits at once; the grandchild holds the pipe open. The drain wait is bounded by
        // the grace window, so the run fails fast instead of freezing the status line.
        let started = Instant::now();
        let error =
            run_command("sleep 30 &", &json!({}), Duration::from_secs(2)).expect_err("grace wins");
        assert_eq!(error, "stdout stayed open");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_failing_exit_is_an_error_not_output() {
        let error = run_command("echo x; exit 3", &json!({}), Duration::from_secs(2))
            .expect_err("exit 3 is a failure");
        assert!(error.starts_with("exit "));
    }

    #[test]
    fn an_over_cap_writer_renders_the_truncated_prefix() {
        // 200 KiB outlives the pipe buffer: with a read end that closed at 16 KiB the writer
        // would SIGPIPE and the run would fail; the drain keeps the capped prefix instead.
        let lines = run_command(
            "yes line | head -c 200000",
            &json!({}),
            Duration::from_secs(5),
        )
        .expect("the writer is not killed");
        assert_eq!(lines.len(), MAX_LINES);
        assert!(lines.iter().all(|line| line == "line"));
    }

    #[test]
    fn output_is_capped_at_four_rows() {
        let lines = run_command(
            r"printf 'a
b
c
d
e
f
'",
            &json!({}),
            Duration::from_secs(2),
        )
        .expect("printf");
        assert_eq!(
            lines,
            vec![
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
                "d".to_string()
            ]
        );
    }

    #[test]
    fn the_driver_reruns_only_when_forced_and_feeds_the_chrome() {
        let dir = tempfile::tempdir().expect("temp dir");
        let count = dir.path().join("count");
        let command = format!("printf x >> {count}; printf ok", count = count.display());
        let spec = StatusLineSpec {
            command,
            padding: None,
        };
        let mut driver = StatusLine::new(spec, Instant::now());
        let mut chrome = ChromeState::default();
        driver.refresh_due(Instant::now(), &mut chrome); // run 1
        wait_for(Duration::from_secs(2), || {
            driver.frame_wake() <= Instant::now()
        });
        // Not due yet: the next pass copies without re-running.
        driver.refresh_due(Instant::now(), &mut chrome);
        assert_eq!(
            std::fs::read_to_string(&count).map_or(0, |text| text.len()),
            1
        );
        assert_eq!(chrome.status_line, vec!["ok".to_string()]);
        driver.force(Instant::now());
        driver.refresh_due(Instant::now(), &mut chrome); // due again: run 2
        wait_for(Duration::from_secs(2), || {
            std::fs::read_to_string(&count).map_or(0, |text| text.len()) == 2
        });
    }
}

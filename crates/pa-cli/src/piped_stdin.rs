//! Piped-stdin read for the initial prompt, ported from
//! `utils/piped-stdin.ts`: read a piped (non-terminal) stdin without ever
//! hanging a non-interactive boot.
//!
//! Daemon workers, agent harnesses, and CI runners spawn this CLI with a
//! stdin pipe they never write to and never close; an unbounded read would
//! hang boot forever, so the read gives up after an idle window. A live
//! producer resets the window on every chunk; a producer that already
//! wrote delivers its buffered bytes the moment the listener attaches.

use std::io::IsTerminal as _;
use std::io::Read as _;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

/// Env override for the no-input window of a non-interactive stdin read,
/// in milliseconds. `0` skips the read entirely; values above the cap are
/// clamped (TS `PI_STDIN_TIMEOUT_MS`).
pub const STDIN_IDLE_TIMEOUT_MS_ENV: &str = "PI_STDIN_TIMEOUT_MS";

const DEFAULT_STDIN_IDLE_TIMEOUT_MS: u64 = 250;
const MAX_STDIN_IDLE_TIMEOUT_MS: u64 = 30_000;

/// TS `resolveStdinIdleTimeoutMs`: absent, empty, or non-numeric/negative
/// values fall back to the default; `0` opts out; the cap clamps.
pub fn resolve_stdin_idle_timeout_ms(raw: Option<&str>) -> u64 {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return DEFAULT_STDIN_IDLE_TIMEOUT_MS;
    };
    match raw.parse::<u64>() {
        Ok(0) => 0,
        Ok(value) => value.min(MAX_STDIN_IDLE_TIMEOUT_MS),
        Err(_) => DEFAULT_STDIN_IDLE_TIMEOUT_MS,
    }
}

/// Read all content from a piped stdin without ever hanging the boot
/// (TS `readPipedStdin`): TTY stdin reads nothing, an empty read is
/// `None`, and a non-TTY stdin that stays silent past the idle window
/// gives up with the TS stderr notice (the reader thread parks on the
/// stream; nothing else reads stdin in the modes that reach here).
pub fn read_piped_stdin(idle_timeout_ms: u64) -> Option<String> {
    if idle_timeout_ms == 0 || std::io::stdin().is_terminal() {
        return None;
    }
    let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buffer = [0u8; 8192];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (data, idle_expired) = collect_from(&receiver, idle_timeout_ms);
    if idle_expired {
        eprintln!(
            "stdin did not close within {idle_timeout_ms}ms; continuing without waiting for more piped input"
        );
    }
    // Node decodes the stream as UTF-8 while reading (lossy on invalid
    // sequences) and returns `data.trim() || undefined`.
    let data = String::from_utf8_lossy(&data);
    let trimmed = data.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Drain chunks until EOF or the idle window lapses: the collected bytes
/// and whether the window (not EOF) ended the read. A live producer
/// resets the window on every chunk (TS `scheduleIdleTimeout` re-arms on
/// each `data` event); only silence expires it.
fn collect_from(receiver: &Receiver<Vec<u8>>, idle_timeout_ms: u64) -> (Vec<u8>, bool) {
    let idle_window = Duration::from_millis(idle_timeout_ms);
    let mut data = Vec::new();
    loop {
        match receiver.recv_timeout(idle_window) {
            Ok(chunk) => data.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout) => return (data, true),
            Err(RecvTimeoutError::Disconnected) => return (data, false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_resolves_from_the_env_like_ts() {
        assert_eq!(resolve_stdin_idle_timeout_ms(None), 250);
        assert_eq!(resolve_stdin_idle_timeout_ms(Some("")), 250);
        assert_eq!(resolve_stdin_idle_timeout_ms(Some("junk")), 250);
        assert_eq!(resolve_stdin_idle_timeout_ms(Some("-5")), 250);
        assert_eq!(resolve_stdin_idle_timeout_ms(Some("0")), 0);
        assert_eq!(resolve_stdin_idle_timeout_ms(Some("1200")), 1200);
        assert_eq!(resolve_stdin_idle_timeout_ms(Some("999999")), 30_000);
    }

    #[test]
    fn collect_drains_until_eof() {
        let (sender, receiver) = std::sync::mpsc::channel();
        for chunk in [b"one ".to_vec(), b"two".to_vec()] {
            sender.send(chunk).expect("send");
        }
        drop(sender);
        let (data, idle_expired) = collect_from(&receiver, 5000);
        assert_eq!(data, b"one two");
        assert!(!idle_expired);
    }

    #[test]
    fn collect_gives_up_after_the_idle_window() {
        let (sender, receiver) = std::sync::mpsc::channel();
        sender.send(b"first".to_vec()).expect("send");
        // The producer stays open but silent: the window expires.
        let (data, idle_expired) = collect_from(&receiver, 30);
        assert_eq!(data, b"first");
        assert!(idle_expired);
    }

    #[test]
    fn a_live_producer_resets_the_window() {
        let (sender, receiver) = std::sync::mpsc::channel();
        let producer = std::thread::spawn(move || {
            for tick in 0..4 {
                std::thread::sleep(Duration::from_millis(20));
                if sender.send(vec![b'0' + tick as u8]).is_err() {
                    return;
                }
            }
        });
        // Chunks every 20ms keep the 60ms window alive across the run.
        let (data, idle_expired) = collect_from(&receiver, 60);
        assert!(!idle_expired);
        assert_eq!(data, b"0123");
        producer.join().expect("producer finished");
    }
}

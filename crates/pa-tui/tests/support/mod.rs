//! Shared plumbing for the pa-tui headless integration tests: each test binary includes it with
//! `mod support;` and serves its scenario-specific daemon answers on top of it.

// Every test binary compiles this module but uses only the helpers its scenarios need.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::{json, Value};

/// Write one newline-delimited JSON frame to the client.
pub fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// Write one `session_event` frame for the attached session `s1`.
pub fn write_session_event(writer: &mut UnixStream, event: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": event,
        }),
    );
}

/// Answer `id` with a successful `command` response carrying `data` (the agents-view wire shape).
pub fn respond(writer: &mut UnixStream, id: &str, command: &str, data: &Value) {
    write_json(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": true,
            "data": data,
        }),
    );
}

/// Answer `id` with a failed `command` response carrying `error`.
pub fn respond_failure(writer: &mut UnixStream, id: &str, command: &str, error: &str) {
    write_json(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": false,
            "error": error,
        }),
    );
}

/// One request line from a client socket with a read timeout: `None` on EOF or once 90 read
/// timeouts pass without a line (the bounded quiet window that ends a serve loop).
pub fn read_line(reader: &mut BufReader<UnixStream>) -> Option<String> {
    const QUIET_WINDOW_MS: u32 = 90;
    let mut quiet_windows: u32 = 0;
    let mut line = String::new();
    loop {
        match reader.read_line(&mut line) {
            Ok(0) => return None,
            Ok(_) if line.trim().is_empty() => {
                line.clear();
            }
            Ok(_) => return Some(line),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                quiet_windows += 1;
                if quiet_windows >= QUIET_WINDOW_MS {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
                line.clear();
            }
            Err(_) => return None,
        }
    }
}

//! Compaction phase tracing (debug seam, off by default): one line per
//! phase boundary, so a post-summary stall can be attributed to its phase.
//! `PA_COMPACTION_TRACE=1` (or `stderr`) writes stderr; `=<path>` appends
//! one JSON line per boundary to a regular file (a FIFO would block).

use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

/// Where the trace lines go (resolved once from `PA_COMPACTION_TRACE`).
enum Sink {
    Off,
    Stderr,
    File(std::sync::Mutex<std::fs::File>),
}

static SINK: OnceLock<Sink> = OnceLock::new();
static START: OnceLock<Instant> = OnceLock::new();

fn sink() -> &'static Sink {
    SINK.get_or_init(|| match std::env::var("PA_COMPACTION_TRACE") {
        Err(_) => Sink::Off,
        Ok(value) if value == "1" || value == "stderr" => Sink::Stderr,
        Ok(path) => std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_or(Sink::Off, |file| Sink::File(std::sync::Mutex::new(file))),
    })
}

/// One phase boundary: `phase` names it (dotted `surface.stage[.what]`);
/// `detail` carries phase-specific numbers.
pub fn trace(phase: &str, detail: &serde_json::Value) {
    let sink = sink();
    if matches!(sink, Sink::Off) {
        return;
    }
    let elapsed = START.get_or_init(Instant::now).elapsed().as_micros();
    let line = serde_json::json!({
        "phase": phase,
        "elapsedMicros": elapsed,
        "detail": detail.clone(),
    });
    match sink {
        Sink::Stderr => {
            let _ = writeln!(std::io::stderr(), "compaction-trace: {line}");
        }
        Sink::File(file) => {
            let mut file = file
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let _ = writeln!(file, "compaction-trace: {line}");
        }
        Sink::Off => {}
    }
}

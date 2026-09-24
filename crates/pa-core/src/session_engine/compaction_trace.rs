//! Compaction phase tracing (debug seam, off by default): one line per
//! phase boundary of the compaction pipeline, so a post-summary stall
//! (the compacted text rendered but the compaction indicator keeps
//! spinning) can be attributed to the phase that owns the extra time.
//!
//! `PA_COMPACTION_TRACE=1` (or `stderr`) writes stderr;
//! `PA_COMPACTION_TRACE=<path>` appends one JSON line per boundary. The
//! first trace line of the process starts the elapsed clock, so
//! `elapsedMicros` on every line reads as time since the run began.

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
            .map(|file| Sink::File(std::sync::Mutex::new(file)))
            .unwrap_or(Sink::Off),
    })
}

/// Whether the trace is on (callers skip building detail values).
pub fn enabled() -> bool {
    !matches!(sink(), Sink::Off)
}

/// One phase boundary. `phase` names the boundary (dotted
/// `surface.stage[.what]`); `detail` carries phase-specific numbers
/// (counts, byte sizes, entry ids).
pub fn trace(phase: &str, detail: serde_json::Value) {
    let sink = sink();
    if matches!(sink, Sink::Off) {
        return;
    }
    let elapsed = START.get_or_init(Instant::now).elapsed().as_micros();
    let line = serde_json::json!({
        "phase": phase,
        "elapsedMicros": elapsed,
        "detail": detail,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The sink resolves once per process from the env; the test cannot
    /// flip it after another test resolved it, so it only proves the
    /// resolved default (off) for a fresh process.
    #[test]
    fn unset_env_means_off() {
        if std::env::var("PA_COMPACTION_TRACE").is_ok() {
            return;
        }
        assert!(!enabled());
    }
}

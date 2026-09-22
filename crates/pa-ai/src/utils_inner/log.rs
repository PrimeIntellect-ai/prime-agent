//! Minimal structured logger shared by pa-ai and its consumers.
//! Ported from `packages/ai/src/log.ts`: entries go to an injectable sink; the
//! library never writes files and logging must never throw into the caller.

use std::sync::RwLock;

use serde::{Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // full TS log surface
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl Serialize for LogLevel {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl LogLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub ts: String,
    pub level: LogLevel,
    pub component: String,
    pub msg: String,
    #[serde(flatten)]
    pub fields: serde_json::Value,
}

pub type LogSink = std::sync::Arc<dyn Fn(&LogEntry) + Send + Sync>;

static SINK: RwLock<Option<LogSink>> = RwLock::new(None);

/// Install the process-wide log sink. Pass None to restore the default.
#[allow(dead_code)] // logging surface for consumers once exposed
pub fn set_log_sink(next: Option<LogSink>) {
    *SINK.write().unwrap() = next;
}

fn emit(level: LogLevel, component: &str, msg: &str, fields: serde_json::Value) {
    let entry = LogEntry {
        ts: iso_timestamp(),
        level,
        component: component.to_string(),
        msg: msg.to_string(),
        fields,
    };
    let sink = SINK.read().unwrap().clone();
    if let Some(sink) = sink {
        sink(&entry);
    }
}

fn iso_timestamp() -> String {
    // RFC3339 UTC timestamp without external date deps.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days-to-civil conversion (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[derive(Clone)]
pub struct Logger {
    component: String,
}

#[allow(dead_code)] // full TS log surface
impl Logger {
    pub fn debug(&self, msg: &str, fields: serde_json::Value) {
        emit(LogLevel::Debug, &self.component, msg, fields);
    }
    pub fn info(&self, msg: &str, fields: serde_json::Value) {
        emit(LogLevel::Info, &self.component, msg, fields);
    }
    pub fn warn(&self, msg: &str, fields: serde_json::Value) {
        emit(LogLevel::Warn, &self.component, msg, fields);
    }
    pub fn error(&self, msg: &str, fields: serde_json::Value) {
        emit(LogLevel::Error, &self.component, msg, fields);
    }
}

pub fn get_logger(component: &str) -> Logger {
    Logger {
        component: component.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_rfc3339() {
        let ts = iso_timestamp();
        assert_eq!(ts.len(), 24);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
    }

    #[test]
    fn sink_receives_entries() {
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_handle = received.clone();
        set_log_sink(Some(std::sync::Arc::new(move |entry: &LogEntry| {
            sink_handle.lock().unwrap().push(entry.level);
        })));
        get_logger("test").error("boom", serde_json::json!({}));
        set_log_sink(None);
        assert_eq!(*received.lock().unwrap(), vec![LogLevel::Error]);
    }
}

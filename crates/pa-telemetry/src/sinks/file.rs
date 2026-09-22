//! Local JSONL mirror sink: everything emitted, written where the user can
//! read it. One JSON object per line at `<agentDir>/telemetry.jsonl`, rotated
//! to `.1` at the size cap.

use std::path::{Path, PathBuf};

use std::future::Future;
use std::pin::Pin;

use anyhow::{Context, Result};
use serde_json::json;

use crate::event::TelemetryEvent;
use crate::sink::{SinkOutcome, TelemetrySink};

/// Default rotation cap: 5 MiB.
pub const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const FILE_NAME: &str = "telemetry.jsonl";

/// Appends each event as one JSONL line: `{"name", "timestamp",
/// "distinct_id", "properties"}`. This is the transparency mirror: it shows
/// exactly what telemetry would leave the machine, with no content beyond the
/// primitive property schema.
#[derive(Debug, Clone)]
pub struct FileSink {
    path: PathBuf,
    max_bytes: u64,
}

impl FileSink {
    /// Mirror at `<agentDir>/telemetry.jsonl` with the default 5 MiB cap.
    pub fn new(agent_dir: &Path) -> Self {
        Self {
            path: agent_dir.join(FILE_NAME),
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }

    /// Mirror at an explicit path (tests) with the default cap.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }

    /// Current mirror file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn write_batch(&self, install_id: &str, events: Vec<TelemetryEvent>) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        self.rotate_if_needed().await?;
        let mut payload = String::new();
        for event in &events {
            let mut value = event.to_value();
            value["distinct_id"] = json!(install_id);
            payload.push_str(&value.to_string());
            payload.push('\n');
        }
        self.append(&payload).await
    }

    async fn rotate_if_needed(&self) -> Result<()> {
        let size = match tokio::fs::metadata(&self.path).await {
            Ok(meta) => meta.len(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err).with_context(|| format!("stat {}", self.path.display())),
        };
        if size < self.max_bytes {
            return Ok(());
        }
        let rotated = self.path.with_extension("jsonl.1");
        tokio::fs::rename(&self.path, &rotated)
            .await
            .with_context(|| format!("rotate {} -> {}", self.path.display(), rotated.display()))?;
        tracing::info!(from = %self.path.display(), to = %rotated.display(), "telemetry mirror rotated");
        Ok(())
    }

    async fn append(&self, payload: &str) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).append(true);
        let mut file = options
            .open(&self.path)
            .await
            .with_context(|| format!("open {}", self.path.display()))?;
        file.write_all(payload.as_bytes()).await?;
        file.flush().await?;
        self.set_private().await
    }

    /// 0600 on unix; on other platforms the agent dir ACLs apply.
    async fn set_private(&self) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            tokio::fs::set_permissions(&self.path, perms)
                .await
                .with_context(|| format!("chmod 600 {}", self.path.display()))?;
        }
        #[cfg(not(unix))]
        {
            let _ = &self.path;
        }
        Ok(())
    }
}

impl TelemetrySink for FileSink {
    fn send_batch<'a>(
        &'a self,
        install_id: &'a str,
        events: Vec<TelemetryEvent>,
    ) -> Pin<Box<dyn Future<Output = SinkOutcome> + Send + '_>> {
        Box::pin(async move {
            if let Err(err) = self.write_batch(install_id, events).await {
                tracing::warn!(path = %self.path.display(), error = %err, "telemetry mirror write failed");
                return SinkOutcome::Dropped;
            }
            SinkOutcome::Sent
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::properties::Properties;

    fn event(name: &str) -> TelemetryEvent {
        let mut properties = Properties::new();
        properties.set("k", serde_json::Value::from("v"));
        TelemetryEvent::new(name, properties)
    }

    #[tokio::test]
    async fn writes_jsonl_lines() {
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::new(dir.path());
        let outcome = sink
            .send_batch(
                "install-1",
                vec![event("agent started"), event("tool executed")],
            )
            .await;
        assert_eq!(outcome, SinkOutcome::Sent);
        let content = tokio::fs::read_to_string(sink.path()).await.unwrap();
        let lines: Vec<&str> = content.trim_end().split('\n').collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["name"], "agent started");
        assert_eq!(first["distinct_id"], "install-1");
        assert_eq!(first["properties"]["k"], "v");
        assert!(first["timestamp"].as_str().unwrap().ends_with('Z'));
    }

    #[tokio::test]
    async fn empty_batch_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::new(dir.path());
        let outcome = sink.send_batch("install-1", vec![]).await;
        assert_eq!(outcome, SinkOutcome::Sent);
        assert!(!sink.path().exists());
    }

    #[tokio::test]
    async fn rotates_at_cap() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = FileSink::at(dir.path().join(FILE_NAME));
        sink.max_bytes = 200;
        // First batch fills past the cap; the NEXT batch rotates first.
        let big = (0..10).map(|i| event(&format!("event {i}"))).collect();
        sink.send_batch("install-1", big).await;
        assert!(sink.path().exists());
        sink.send_batch("install-1", vec![event("after cap")]).await;
        assert!(dir.path().join("telemetry.jsonl.1").exists());
        let current = tokio::fs::read_to_string(sink.path()).await.unwrap();
        assert!(current.contains("after cap"));
        let rotated = tokio::fs::read_to_string(dir.path().join("telemetry.jsonl.1"))
            .await
            .unwrap();
        assert!(rotated.contains("event 0"));
        assert!(!rotated.contains("after cap"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mirror_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::new(dir.path());
        sink.send_batch("install-1", vec![event("agent started")])
            .await;
        let mode = tokio::fs::metadata(sink.path())
            .await
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

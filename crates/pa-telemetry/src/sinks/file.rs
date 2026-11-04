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
/// "distinct_id", "properties"}`. The transparency mirror: shows exactly
/// what telemetry would leave the machine.
#[derive(Debug, Clone)]
pub struct FileSink {
    path: PathBuf,
    max_bytes: u64,
}

impl FileSink {
    /// Mirror at `<agentDir>/telemetry.jsonl` with the default 5 MiB cap.
    #[must_use]
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
    #[must_use]
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
        self.rotate_existing().await
    }

    async fn rotate_existing(&self) -> Result<()> {
        // A mirror left with loose legacy permissions must not carry those
        // permissions into the retained rotation.
        // The current mirror may have been rotated by another sink since the
        // size check. Do not create an empty replacement that could overwrite
        // the retained rotation.
        let file = match tokio::fs::OpenOptions::new()
            .append(true)
            .open(&self.path)
            .await
        {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err).with_context(|| format!("open {}", self.path.display())),
        };
        #[cfg(unix)]
        self.make_private(&file).await?;
        drop(file);
        let rotated = self.path.with_extension("jsonl.1");
        match tokio::fs::rename(&self.path, &rotated).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => {
                return Err(err).with_context(|| {
                    format!("rotate {} -> {}", self.path.display(), rotated.display())
                });
            }
        }
        tracing::info!(from = %self.path.display(), to = %rotated.display(), "telemetry mirror rotated");
        Ok(())
    }

    async fn append(&self, payload: &str) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let mut file = self.open_private().await?;
        file.write_all(payload.as_bytes()).await?;
        file.flush().await?;
        Ok(())
    }

    /// Tighten an existing mirror before appending and create a new one
    /// privately from the start, even under a permissive umask.
    async fn open_private(&self) -> Result<tokio::fs::File> {
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options
            .open(&self.path)
            .await
            .with_context(|| format!("open {}", self.path.display()))?;
        #[cfg(unix)]
        self.make_private(&file).await?;
        Ok(file)
    }

    #[cfg(unix)]
    async fn make_private(&self, file: &tokio::fs::File) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        file.set_permissions(perms)
            .await
            .with_context(|| format!("chmod 600 {}", self.path.display()))?;
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
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let mut sink = FileSink::at(dir.path().join(FILE_NAME));
        sink.max_bytes = 200;
        // First batch fills past the cap; the NEXT batch rotates first.
        let big = (0..10).map(|i| event(&format!("event {i}"))).collect();
        sink.send_batch("install-1", big).await;
        assert!(sink.path().exists());
        #[cfg(unix)]
        std::fs::set_permissions(sink.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        sink.send_batch("install-1", vec![event("after cap")]).await;
        assert!(dir.path().join("telemetry.jsonl.1").exists());
        #[cfg(unix)]
        {
            let mode = std::fs::metadata(dir.path().join("telemetry.jsonl.1"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "rotated mirror remains private");
        }
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
    async fn mirror_is_private_before_writing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::new(dir.path());
        let file = sink.open_private().await.unwrap();
        let mode = file.metadata().await.unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "new mirror is private before writing");
        drop(file);

        std::fs::set_permissions(sink.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let file = sink.open_private().await.unwrap();
        let mode = file.metadata().await.unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "existing mirror is tightened before writing"
        );
        drop(file);

        sink.send_batch("install-1", vec![event("agent started")])
            .await;
        let mode = tokio::fs::metadata(sink.path())
            .await
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[tokio::test]
    async fn concurrent_rotation_does_not_replace_retained_history() {
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::new(dir.path());
        let rotated = sink.path().with_extension("jsonl.1");
        tokio::fs::write(sink.path(), "retained history\n")
            .await
            .unwrap();

        // Another sink rotates the current mirror after this sink has checked
        // its size, just before it opens the current path for rotation.
        tokio::fs::rename(sink.path(), &rotated).await.unwrap();
        sink.rotate_existing().await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(&rotated).await.unwrap(),
            "retained history\n"
        );
        assert!(!sink.path().exists());

        sink.send_batch("install-1", vec![event("new event")]).await;
        assert_eq!(
            tokio::fs::read_to_string(&rotated).await.unwrap(),
            "retained history\n"
        );
    }
}

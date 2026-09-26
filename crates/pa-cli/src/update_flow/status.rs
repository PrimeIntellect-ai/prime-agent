//! The coordinator status file (spec §7 `status.json`): every state writes
//! `{update_id, state, epoch, updated_at}` before acting, atomically
//! (tmp + rename, 0600), with a 5 s heartbeat so a tailed coordinator can
//! distinguish "working" from "hung" (TS `DaemonUpdateRestartStatusWriter`
//! parity; the `epoch` is the spec's monotonic counter that keeps a dying
//! predecessor's late writes from regressing state).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{
    UpdateId, UpdateProcessIdentity, UpdateState, UpdateStatus, UpdateStatusCounts,
    UPDATE_STATUS_FORMAT_VERSION,
};
use serde_json::json;
use tokio::sync::Mutex;

/// The status heartbeat interval (TS `COORDINATOR_STATUS_HEARTBEAT_MS`).
pub const STATUS_HEARTBEAT_MS: u64 = 5_000;

/// The telemetry outcome names for terminal states (`complete`, `skipped`,
/// `aborted`, `failed`; a rollback that ends serving is `complete` on the old
/// version with the rollback noted in the status message).
pub const UPDATE_TELEMETRY_STATE_NAMES: &[(UpdateState, &str)] = &[
    (UpdateState::Complete, "complete"),
    (UpdateState::Skipped, "skipped"),
    (UpdateState::Aborted, "aborted"),
    (UpdateState::Failed, "failed"),
];

/// Reads and writes one status file.
pub struct StatusWriter {
    path: PathBuf,
    status: UpdateStatus,
}

impl StatusWriter {
    /// A fresh coordinator status at `Acquire` (epoch starts at 1), with
    /// the initial record on disk before the caller proceeds (TS
    /// `DaemonUpdateRestartStatusWriter` persists in its constructor, so
    /// a joining process that tails this path never races the first write).
    ///
    /// # Errors
    /// Returns an error when the initial status record cannot be persisted.
    pub fn new(path: &Path, update_id: &UpdateId, socket_path: &str) -> Result<Self> {
        let writer = Self::fresh(path, update_id, socket_path);
        writer
            .persist()
            .context("write the initial coordinator status")?;
        Ok(writer)
    }

    /// The in-memory `Acquire` record without a disk write (the adoption
    /// path rewrites the epoch before its single persisting write).
    fn fresh(path: &Path, update_id: &UpdateId, socket_path: &str) -> Self {
        let now = crate::util_time::now_iso8601();
        let identity = coordinator_identity();
        Self {
            path: path.to_path_buf(),
            status: UpdateStatus {
                version: UPDATE_STATUS_FORMAT_VERSION,
                update_id: update_id.clone(),
                socket_path: socket_path.to_string(),
                state: UpdateState::Acquire,
                epoch: 1,
                coordinator: Some(identity),
                predecessor: None,
                successor: None,
                counts: UpdateStatusCounts::default(),
                failures: Vec::new(),
                message: None,
                started_at: now.clone(),
                updated_at: now.clone(),
                heartbeat_at: Some(now),
                rest: serde_json::Map::default(),
            },
        }
    }

    /// Adopt the status file of an earlier writer (the CLI staged through
    /// `Staged`): the epoch continues above the recorded one, so this
    /// process's writes can never be regressed by the predecessor's.
    ///
    /// # Errors
    /// Returns an error when the adopted status record cannot be persisted.
    pub fn adopt(path: &Path, update_id: &UpdateId, socket_path: &str) -> Result<Self> {
        let mut writer = Self::fresh(path, update_id, socket_path);
        if let Some(existing) = read_status(path) {
            writer.status.epoch = existing.epoch + 1;
            writer.status.started_at = existing.started_at;
        }
        writer
            .persist()
            .context("write the adopted coordinator status")?;
        Ok(writer)
    }

    /// Move to `state` (a driver bug to move illegally — pa-types owns the
    /// table) and persist before acting.
    ///
    /// # Errors
    /// Returns an error when the status record cannot be written to disk.
    pub fn set_state(&mut self, state: UpdateState) -> Result<()> {
        debug_assert!(
            pa_types::daemon::update_flow::update_transition_allowed(self.status.state, state),
            "illegal coordinator transition {:?} -> {:?}",
            self.status.state,
            state
        );
        self.status.state = state;
        self.touch();
        self.persist()
    }

    /// Record the coordinator's status message and persist.
    ///
    /// # Errors
    /// Returns an error when the status record cannot be written to disk.
    pub fn set_message(&mut self, message: Option<String>) -> Result<()> {
        self.status.message = message;
        self.touch();
        self.persist()
    }

    /// Record the predecessor identity and persist.
    ///
    /// # Errors
    /// Returns an error when the status record cannot be written to disk.
    pub fn set_predecessor(&mut self, identity: UpdateProcessIdentity) -> Result<()> {
        self.status.predecessor = Some(identity);
        self.touch();
        self.persist()
    }

    /// Record the successor identity and persist.
    ///
    /// # Errors
    /// Returns an error when the status record cannot be written to disk.
    pub fn set_successor(&mut self, identity: UpdateProcessIdentity) -> Result<()> {
        self.status.successor = Some(identity);
        self.touch();
        self.persist()
    }

    /// Record the session counts and persist.
    ///
    /// # Errors
    /// Returns an error when the status record cannot be written to disk.
    pub fn set_counts(&mut self, counts: UpdateStatusCounts) -> Result<()> {
        self.status.counts = counts;
        self.touch();
        self.persist()
    }

    /// Record the failure list and persist.
    ///
    /// # Errors
    /// Returns an error when the status record cannot be written to disk.
    pub fn set_failures(
        &mut self,
        failures: Vec<pa_types::daemon::update_flow::UpdateStatusFailure>,
    ) -> Result<()> {
        self.status.failures = failures;
        self.touch();
        self.persist()
    }

    pub fn state(&self) -> UpdateState {
        self.status.state
    }

    pub fn current(&self) -> &UpdateStatus {
        &self.status
    }

    /// Refresh `updated_at`/`heartbeat_at` (every mutation and the heartbeat).
    fn touch(&mut self) {
        let now = crate::util_time::now_iso8601();
        self.status.updated_at.clone_from(&now);
        self.status.heartbeat_at = Some(now);
        self.status.epoch += 1;
    }

    /// The atomic status write: temp file in the same directory, `rename`
    /// over the old file. The parent directory is (re)created on every
    /// write: the successor supervisor's boot sweep (spec §6 step 1) deletes
    /// this socket's scratch dir — including a live coordinator's status
    /// file — before the coordinator's `Restoring`/`Complete` writes land,
    /// and the writer must recreate the dir it was handed.
    fn persist(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        let content = serde_json::to_string_pretty(&json!(self.status))? + "\n";
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)
                .with_context(|| format!("create {}", temporary.display()))?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
        }
        #[cfg(not(unix))]
        std::fs::write(&temporary, content)
            .with_context(|| format!("write {}", temporary.display()))?;
        std::fs::rename(&temporary, &self.path)
            .with_context(|| format!("finalize {}", self.path.display()))?;
        Ok(())
    }
}

/// This coordinator process's identity (the TS `getProcessStartId` contract).
pub fn coordinator_identity() -> UpdateProcessIdentity {
    let pid = std::process::id();
    UpdateProcessIdentity {
        pid: pid as u64,
        process_start_id: pa_daemon::lease::get_process_start_id(pid),
        supervisor_generation: None,
        supervisor_owner_token: None,
        rest: serde_json::Map::default(),
    }
}

/// Parse a status file; `None` when absent or unparseable (the tailed
/// coordinator decides what a missing status means — a not-yet-started
/// coordinator or a corrupt write both surface as "keep waiting" while the
/// holder lives).
pub fn read_status(path: &Path) -> Option<UpdateStatus> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// The status heartbeat task handle: `stop()` waits for one final beat.
pub struct StatusHeartbeat {
    task: tokio::task::JoinHandle<()>,
}

impl StatusHeartbeat {
    /// Heartbeat `writer` every [`STATUS_HEARTBEAT_MS`] until stopped.
    /// A failed write never kills the FSM: the next phase write retries,
    /// and the tailing side treats a stale heartbeat as a liveness signal
    /// (TS parity).
    pub fn start(writer: Arc<Mutex<StatusWriter>>) -> Self {
        let task = tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(std::time::Duration::from_millis(STATUS_HEARTBEAT_MS));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let mut writer = writer.lock().await;
                let now = crate::util_time::now_iso8601();
                writer.status.updated_at.clone_from(&now);
                writer.status.heartbeat_at = Some(now);
                writer.status.epoch += 1;
                let _ = writer.persist();
            }
        });
        Self { task }
    }

    pub fn stop(self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update_id() -> UpdateId {
        UpdateId::from("u1".to_string())
    }

    #[tokio::test]
    async fn writes_and_receives_the_ts_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let mut writer = StatusWriter::new(&path, &update_id(), "/tmp/s.sock").unwrap();
        assert_eq!(read_status(&path).unwrap().state, UpdateState::Acquire);
        writer.set_state(UpdateState::Planning).unwrap();
        writer.set_message(Some("planned".into())).unwrap();
        let read = read_status(&path).expect("status parses back");
        assert_eq!(read.state, UpdateState::Planning);
        assert_eq!(read.message.as_deref(), Some("planned"));
        assert_eq!(read.version, 1);
        assert_eq!(read.update_id, update_id());
        assert!(read.epoch > 1, "the epoch advances per write");
        assert!(read.coordinator.is_some());
    }

    #[tokio::test]
    async fn adoption_continues_the_epoch_above_the_predecessor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let predecessor_epoch = {
            // The predecessor drives the spec's legal path to `Staged`
            // (`Acquire -> Planning -> Downloading -> Staged`): the
            // coordinator's `set_state` asserts the transition table.
            let mut writer = StatusWriter::new(&path, &update_id(), "/tmp/s.sock").unwrap();
            writer.set_state(UpdateState::Planning).unwrap();
            writer.set_state(UpdateState::Downloading).unwrap();
            writer.set_state(UpdateState::Staged).unwrap();
            writer.current().epoch
        };
        let successor = StatusWriter::adopt(&path, &update_id(), "/tmp/s.sock").unwrap();
        assert!(successor.current().epoch > predecessor_epoch);
        assert_eq!(
            successor.current().started_at,
            read_status(&path).unwrap().started_at
        );
        // The adopted status file still parses with the TS schema.
        let read = read_status(&path).unwrap();
        assert_eq!(read.state, UpdateState::Acquire);
        assert!(read.epoch > predecessor_epoch);
    }

    #[tokio::test]
    async fn missing_or_corrupt_status_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_status(&dir.path().join("absent.json")).is_none());
        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "{ not json").unwrap();
        assert!(read_status(&corrupt).is_none());
    }

    #[tokio::test]
    async fn heartbeat_touches_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let writer = Arc::new(Mutex::new(
            StatusWriter::new(&path, &update_id(), "/tmp/s.sock").unwrap(),
        ));
        let before = read_status(&path).unwrap().epoch;
        let heartbeat = StatusHeartbeat::start(Arc::clone(&writer));
        tokio::time::sleep(std::time::Duration::from_millis(STATUS_HEARTBEAT_MS + 200)).await;
        heartbeat.stop();
        let after = read_status(&path).unwrap().epoch;
        assert!(after > before, "the heartbeat beat at least once");
    }
}

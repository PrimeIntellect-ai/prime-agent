//! The coordinator intent lock (spec §4 `Acquire`): `intent.json` under the
//! per-socket update directory holds `{update_id, pid, process_start_id,
//! heartbeat_at}` plus the `status_path` (the record a joining process
//! tails). A live holder means `Join`; a recorded identity that is no
//! longer alive is the only legal cross-process steal - a dead coordinator
//! owns nothing.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{
    socket_update_dir, update_intent_path, update_status_path, UpdateId, UpdateIntent,
};

/// What `Acquire` found.
pub enum AcquireOutcome {
    /// This process holds the lock.
    Acquired,
    /// A live coordinator holds it; relay its status file to terminal.
    Join { status_path: PathBuf },
}

/// The per-socket update directory for one daemon socket path.
pub fn socket_update_directory(agent_dir: &Path, socket_path: &str) -> PathBuf {
    let hash = pa_daemon::paths::hash_key(socket_path, 64);
    socket_update_dir(agent_dir, &hash)
}

/// Contend for the coordinator lock (spec §4): create the socket dir, write
/// the intent record with this process's identity. An existing record with
/// a live identity is a `Join`; a dead or unparseable record is overwritten.
///
/// # Errors
/// Returns an error when the socket directory cannot be created, when the
/// intent record cannot be written, or when the confirming re-read cannot
/// parse the persisted record.
pub fn acquire(
    agent_dir: &Path,
    socket_path: &str,
    update_id: &UpdateId,
    status_path: &Path,
) -> Result<AcquireOutcome> {
    let socket_dir = socket_update_directory(agent_dir, socket_path);
    std::fs::create_dir_all(&socket_dir)
        .with_context(|| format!("create {}", socket_dir.display()))?;
    let intent_path = update_intent_path(&socket_dir);
    if let Some(existing) = read_intent(&intent_path) {
        if is_intent_holder_alive(&existing) {
            let join_path = existing
                .rest
                .get("status_path")
                .and_then(serde_json::Value::as_str)
                .map_or_else(|| default_status_path(&socket_dir), PathBuf::from);
            return Ok(AcquireOutcome::Join {
                status_path: join_path,
            });
        }
    }
    let intent = intent_record(update_id, std::process::id() as u64, status_path);
    write_atomically(&intent_path, &intent)?;
    // Another coordinator may have stolen between the read and the write:
    // re-read and let the winner be whoever's record is on disk.
    let persisted = read_intent(&intent_path).context("reread the intent lock")?;
    if persisted.update_id != *update_id {
        let join_path = persisted
            .rest
            .get("status_path")
            .and_then(serde_json::Value::as_str)
            .map_or_else(|| default_status_path(&socket_dir), PathBuf::from);
        return Ok(AcquireOutcome::Join {
            status_path: join_path,
        });
    }
    Ok(AcquireOutcome::Acquired)
}

/// Hand the lock to the spawned coordinator: rewrite the intent record with
/// the child's identity (it is alive by construction; if it dies, the next
/// `Acquire` steals the dead record).
///
/// # Errors
/// Returns an error when the intent record cannot be rewritten.
pub fn hand_over(
    agent_dir: &Path,
    socket_path: &str,
    update_id: &UpdateId,
    coordinator_pid: u64,
    status_path: &Path,
) -> Result<()> {
    let socket_dir = socket_update_directory(agent_dir, socket_path);
    let intent_path = update_intent_path(&socket_dir);
    let intent = intent_record(update_id, coordinator_pid, status_path);
    write_atomically(&intent_path, &intent)
}

/// Release the lock at a terminal state (the coordinator owns it then; the
/// removal is idempotent for the boot sweep).
///
/// # Errors
/// Returns an error when the intent record cannot be removed.
pub fn release(agent_dir: &Path, socket_path: &str) -> Result<()> {
    let socket_dir = socket_update_directory(agent_dir, socket_path);
    let intent_path = update_intent_path(&socket_dir);
    if intent_path.exists() {
        std::fs::remove_file(&intent_path)
            .with_context(|| format!("remove {}", intent_path.display()))?;
    }
    Ok(())
}

/// The status path this socket's coordinator writes (spec §7: one
/// `status.json` per socket directory; the intent record carries it so a
/// joining process can tail it).
pub fn status_path_for(agent_dir: &Path, socket_path: &str) -> PathBuf {
    update_status_path(&socket_update_directory(agent_dir, socket_path))
}

fn default_status_path(socket_dir: &Path) -> PathBuf {
    update_status_path(socket_dir)
}

/// One intent record: the holder's identity plus the `status_path` a
/// joining process tails (the spec's intent schema with the status coupling
/// in the `rest` map).
fn intent_record(update_id: &UpdateId, pid: u64, status_path: &Path) -> UpdateIntent {
    let mut rest = serde_json::Map::new();
    rest.insert(
        "status_path".to_string(),
        serde_json::json!(status_path.display().to_string()),
    );
    UpdateIntent {
        update_id: update_id.clone(),
        pid,
        process_start_id: pa_daemon::lease::get_process_start_id(pid as u32),
        heartbeat_at: crate::util_time::now_iso8601(),
        rest,
    }
}

fn read_intent(path: &Path) -> Option<UpdateIntent> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn is_intent_holder_alive(intent: &UpdateIntent) -> bool {
    let Ok(alive) = pa_daemon::lease::is_process_alive(intent.pid as u32) else {
        return false;
    };
    if !alive {
        return false;
    }
    match &intent.process_start_id {
        None => true,
        Some(expected) => {
            matches!(
                pa_daemon::lease::get_process_start_id(intent.pid as u32),
                Some(observed) if &observed == expected
            )
        }
    }
}

fn write_atomically(path: &Path, intent: &UpdateIntent) -> Result<()> {
    let temporary = path.with_extension("tmp");
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
        file.write_all(serde_json::to_string_pretty(intent)?.as_bytes())?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    std::fs::write(&temporary, serde_json::to_string_pretty(intent)?)?;
    std::fs::rename(&temporary, path).with_context(|| format!("finalize {}", path.display()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn acquire_then_join_then_stale_steal() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path();
        let update_id = UpdateId::from("u1".to_string());
        let status = status_path_for(agent_dir, "/tmp/s.sock");

        // First acquisition wins.
        match acquire(agent_dir, "/tmp/s.sock", &update_id, &status).unwrap() {
            AcquireOutcome::Acquired => {}
            AcquireOutcome::Join { .. } => panic!("an empty socket dir must acquire"),
        }
        // A second acquisition with this process still alive joins: the
        // holder is this very process.
        let joined = acquire(
            agent_dir,
            "/tmp/s.sock",
            &UpdateId::from("u2".to_string()),
            &status,
        );
        match joined.unwrap() {
            AcquireOutcome::Join { status_path } => assert_eq!(status_path, status),
            AcquireOutcome::Acquired => panic!("a live holder must be joined, not stolen"),
        }
        // Release, then a fresh acquisition wins again.
        release(agent_dir, "/tmp/s.sock").unwrap();
        match acquire(agent_dir, "/tmp/s.sock", &update_id, &status).unwrap() {
            AcquireOutcome::Acquired => {}
            AcquireOutcome::Join { .. } => panic!("a released lock must be acquirable"),
        }
    }

    #[test]
    fn a_dead_holder_is_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path();
        let socket_dir = socket_update_directory(agent_dir, "/tmp/s.sock");
        std::fs::create_dir_all(&socket_dir).unwrap();
        // A record of a process that cannot exist (pid recycling cannot
        // produce this start id): the steal is the documented one.
        let dead = UpdateIntent {
            update_id: UpdateId::from("dead".to_string()),
            pid: 4_000_000,
            process_start_id: pa_daemon::lease::get_process_start_id(1),
            heartbeat_at: "t".to_string(),
            rest: Default::default(),
        };
        write_atomically(&update_intent_path(&socket_dir), &dead).unwrap();
        let update_id = UpdateId::from("u1".to_string());
        let status = status_path_for(agent_dir, "/tmp/s.sock");
        match acquire(agent_dir, "/tmp/s.sock", &update_id, &status).unwrap() {
            AcquireOutcome::Acquired => {}
            AcquireOutcome::Join { .. } => panic!("a dead holder must be stolen"),
        }
    }
}

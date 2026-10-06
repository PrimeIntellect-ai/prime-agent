//! Pseudonymous installation identity.
//!
//! Parity with the TS product's `getOrCreateTelemetryInstallationId`: a
//! `<agentDir>/telemetry.json` state file `{ "version": 1, "installationId":
//! <uuid> }`, created exclusively and mode 0600 on first use, validated on
//! load, atomically replaced when the stored state is invalid. The exclusive
//! create publishes a fully-written candidate (unique temp file + hard
//! link), so concurrent creators converge on one id and never observe a
//! half-written winner. Durability matches the TS product at both sites:
//! neither the fresh create nor the invalid-state replacement fsyncs, so a
//! crash may lose the state file — it is re-created on the next boot and a
//! torn file is invalid state, replaced atomically.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "telemetry.json";
const STATE_VERSION: u64 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct State {
    version: u64,
    #[serde(rename = "installationId")]
    installation_id: String,
}

/// Load the installation id from `<agentDir>/telemetry.json`, creating it on
/// first use; concurrent callers converge on one id.
///
/// # Errors
///
/// Returns an error when a filesystem step fails: creating `agent_dir`,
/// reading an existing state file (a missing file is not an error),
/// publishing the candidate state (exclusive create, write, hard link),
/// or atomically replacing invalid state (temp file + rename).
pub fn install_id(agent_dir: &Path) -> Result<String> {
    let path = agent_dir.join(STATE_FILE);
    if let Some(existing) = read_install_id(&path)? {
        return Ok(existing);
    }

    // Either the file is absent or it holds invalid state: create a fresh id.
    std::fs::create_dir_all(agent_dir)
        .with_context(|| format!("create {}", agent_dir.display()))?;
    let installation_id = uuid::Uuid::new_v4().to_string();
    let state = State {
        version: STATE_VERSION,
        installation_id: installation_id.clone(),
    };
    let payload = serde_json::to_vec_pretty(&state)?;

    match publish_exclusive(&path, &payload)? {
        // Return the id the state file stores now: on the no-hard-link
        // fallback a concurrent repairer may have replaced a partial state,
        // so every caller converges on the durable id.
        Publish::Won => Ok(read_install_id(&path)?.unwrap_or(installation_id)),
        Publish::Lost => {
            // Lost a create race: prefer the winner's id; the winner's
            // publish is atomic, so a miss here means the state was already
            // invalid before the race.
            if let Some(existing) = read_install_id(&path)? {
                Ok(existing)
            } else {
                replace_invalid_state(&path, &payload)?;
                // A concurrent repair may have landed its rename after ours;
                // converge on the durable id.
                Ok(read_install_id(&path)?.unwrap_or(installation_id))
            }
        }
    }
}

/// The stored installation id, read-only: `None` when `telemetry.json` is
/// absent, unreadable, or invalid (status surfaces must not create one).
#[must_use]
pub fn existing_install_id(agent_dir: &Path) -> Option<String> {
    read_install_id(&agent_dir.join(STATE_FILE)).ok().flatten()
}

/// Valid stored id, or `None` when the file is absent or holds invalid state.
fn read_install_id(path: &Path) -> Result<Option<String>> {
    // The state is opened non-blocking (unix O_NONBLOCK): a special
    // file swapped onto the path (a FIFO) would block a plain read
    // forever, and no caller — including the `/telemetry` confirmation
    // after a saved opt-out — may hang on the telemetry state. A
    // non-blocking FIFO with no writer reads empty and parses to no id.
    let mut file = match open_state_nonblocking(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("open {}", path.display())),
    };
    let mut bytes = Vec::new();
    match std::io::Read::read_to_end(&mut file, &mut bytes) {
        Ok(_) => {}
        // A non-blocking empty read (EAGAIN on a writer-less FIFO) is
        // no id, not an error.
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("read {}", path.display())),
    }
    let state: Option<State> = serde_json::from_slice(&bytes).ok();
    let valid = state
        .filter(|s| s.version == STATE_VERSION && is_uuid(&s.installation_id))
        .map(|s| s.installation_id);
    Ok(valid)
}

/// Open the state file read-only, non-blocking on unix (`O_NONBLOCK`):
/// whatever now sits on the path — a regular state file or a swapped-in
/// special file — opens and reads without ever parking the caller.
#[cfg(unix)]
fn open_state_nonblocking(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(
            rustix::fs::OFlags::NONBLOCK
                .bits()
                .try_into()
                .expect("O_NONBLOCK fits the open flags"),
        )
        .open(path)
}

#[cfg(not(unix))]
fn open_state_nonblocking(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().read(true).open(path)
}

/// Outcome of trying to publish a candidate state file exclusively.
enum Publish {
    Won,
    Lost,
}

/// Publish the candidate state exclusively so exactly one concurrent caller
/// wins and its state appears at `path` fully written. The candidate is
/// written to a unique sibling temp file and hard-linked into place: `link`
/// is an atomic exclusive create, so a loser can never observe the winner's
/// file mid-write. Filesystems without hard links fall back to the
/// open+write exclusive create (unsynced, the TS posture), where losers
/// re-read after `AlreadyExists`.
fn publish_exclusive(path: &Path, payload: &[u8]) -> Result<Publish> {
    let tmp = unique_sibling(path);
    let linked = create_exclusive(&tmp, payload).and_then(|()| std::fs::hard_link(&tmp, path));
    match linked {
        Ok(()) => {
            remove_quietly(&tmp);
            Ok(Publish::Won)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            remove_quietly(&tmp);
            Ok(Publish::Lost)
        }
        Err(_) => {
            remove_quietly(&tmp);
            match create_exclusive(path, payload) {
                Ok(()) => Ok(Publish::Won),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(Publish::Lost),
                Err(err) => Err(err).with_context(|| format!("create {}", path.display())),
            }
        }
    }
}

/// Atomically replace invalid state (unique temp file + rename through
/// `rename_onto`, so the win32 destination-busy retry applies like TS
/// `writeTelemetryStateAtomically`).
fn replace_invalid_state(path: &Path, payload: &[u8]) -> Result<()> {
    let tmp = unique_sibling(path);
    if let Err(err) = create_exclusive(&tmp, payload) {
        remove_quietly(&tmp);
        return Err(err).with_context(|| format!("create {}", tmp.display()));
    }
    let renamed = crate::rename_onto(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()));
    if renamed.is_err() {
        remove_quietly(&tmp);
    }
    renamed
}

/// Unique sibling of `path`: same directory (the hard link and rename stay
/// on one filesystem), unique per call, so concurrent replacers never share
/// a temp file.
fn unique_sibling(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    path.with_file_name(name)
}

/// Best-effort temp cleanup: a stale candidate must never fail the caller.
fn remove_quietly(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Exclusive create with 0600 permissions on unix (Windows has no portable
/// mode; the agent dir ACLs apply).
///
/// No temp-file fsync: the TS product fsyncs NEITHER install-id site — the
/// fresh create is `writeFileSync` with flag `wx` (Node never fsyncs it) and
/// the invalid-state replacement is `writeFileAtomicSync` WITHOUT the
/// `fsync` option, so the port's `sync_all` here was added durability the
/// product does not have. The crash class is unchanged: a lost create just
/// re-creates next boot (`read_install_id` fails), and a torn or empty
/// durable file is invalid state, replaced atomically.
fn create_exclusive(path: &Path, payload: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(payload)
}

/// TS parity validation: hex uuid whose version nibble is 1-8 and variant
/// nibble is 8/9/a/b (case-insensitive).
fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let positions: [usize; 4] = [8, 13, 18, 23];
    if positions.iter().any(|&p| bytes[p] != b'-') {
        return false;
    }
    let hex_at = |i: usize| -> bool { bytes[i].is_ascii_hexdigit() };
    if (0..36)
        .filter(|&i| !positions.contains(&i))
        .any(|i| !hex_at(i))
    {
        return false;
    }
    let version = value.as_bytes()[14];
    if !version.is_ascii_hexdigit() || version == b'0' || version == b'9' {
        return false;
    }
    let variant = value.as_bytes()[19].to_ascii_lowercase();
    matches!(variant, b'8' | b'9' | b'a' | b'b')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A special file on the state path (a FIFO) is the blocking-read
    /// hazard: the id read must come back empty (no id) instead of
    /// parking the caller — the `/telemetry` confirmation after a saved
    /// opt-out may never hang on the telemetry state.
    #[test]
    #[cfg(unix)]
    fn a_fifo_on_the_state_path_reads_as_no_id() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        // A FIFO with no writer: a plain read would block forever.
        let fifo = agent_dir.join(STATE_FILE);
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo");
        assert!(status.success(), "mkfifo created the fifo");
        assert_eq!(existing_install_id(&agent_dir), None);
    }

    #[test]
    fn uuid_validation() {
        assert!(is_uuid("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        assert!(is_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_uuid("550E8400-E29B-11D4-A716-446655440000"));
        assert!(!is_uuid("550e8400-e29b-01d4-a716-446655440000")); // version 0
        assert!(!is_uuid("550e8400-e29b-91d4-a716-446655440000")); // version 9
        assert!(!is_uuid("550e8400-e29b-41d4-c716-446655440000")); // variant c
        assert!(!is_uuid("550e8400e29b41d4a716446655440000")); // no dashes
        assert!(!is_uuid(""));
        assert!(!is_uuid("not-a-uuid-at-all-not-a-uuid-aaaaaaaaaa"));
    }

    #[test]
    fn creates_and_rereads() {
        let dir = tempfile::tempdir().unwrap();
        let first = install_id(dir.path()).unwrap();
        let second = install_id(dir.path()).unwrap();
        assert_eq!(first, second);
        let path = dir.path().join(STATE_FILE);
        let state: State = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(state.version, 1);
        assert_eq!(state.installation_id, first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "created state must stay private");
        }
        // No candidate temps may survive a clean create.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, [STATE_FILE]);
    }

    #[test]
    fn replaces_invalid_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        let bad = State {
            version: STATE_VERSION,
            installation_id: "garbage".into(),
        };
        std::fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        let id = install_id(dir.path()).unwrap();
        let state: State = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(state.installation_id, id);
        assert!(is_uuid(&id));
    }

    #[test]
    fn rejects_wrong_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        let future = State {
            version: 2,
            installation_id: "550e8400-e29b-41d4-a716-446655440000".into(),
        };
        std::fs::write(&path, serde_json::to_vec(&future).unwrap()).unwrap();
        let id = install_id(dir.path()).unwrap();
        assert_ne!(id, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn concurrent_create_converges() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let ids: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let ids = &ids;
                let path = path.clone();
                scope.spawn(move || {
                    let id = install_id(&path).unwrap();
                    ids.lock().unwrap().push(id);
                });
            }
        });
        let ids = ids.into_inner().unwrap();
        assert!(ids.iter().all(|id| id == &ids[0]));
    }

    #[test]
    fn concurrent_create_stress_converges() {
        const ROUNDS: usize = 64;
        const THREADS: usize = 16;
        for round in 0..ROUNDS {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_path_buf();
            let start = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
            let ids: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
            std::thread::scope(|scope| {
                for _ in 0..THREADS {
                    let ids = &ids;
                    let path = path.clone();
                    let start = start.clone();
                    scope.spawn(move || {
                        start.wait();
                        let id = install_id(&path).unwrap();
                        ids.lock().unwrap().push(id);
                    });
                }
            });
            let ids = ids.into_inner().unwrap();
            assert_eq!(ids.len(), THREADS, "every caller must return an id");
            let distinct: std::collections::HashSet<&String> = ids.iter().collect();
            assert_eq!(
                distinct.len(),
                1,
                "round {round} diverged across {THREADS} callers: {ids:?}"
            );
            let state: State =
                serde_json::from_slice(&std::fs::read(path.join(STATE_FILE)).unwrap()).unwrap();
            assert_eq!(state.installation_id, ids[0], "durable state must match");
        }
    }
}

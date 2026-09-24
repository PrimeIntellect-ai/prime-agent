//! Pseudonymous installation identity.
//!
//! Parity with the TS product's `getOrCreateTelemetryInstallationId`: a
//! `<agentDir>/telemetry.json` state file `{ "version": 1, "installationId":
//! <uuid> }`, created exclusively and mode 0600 on first use, validated on
//! load, atomically replaced when the stored state is invalid.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

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
/// first use. Concurrent callers on the same directory converge on one id:
/// the create is exclusive and losers re-read the winner's state.
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

    match create_exclusive(&path, &payload) {
        Ok(()) => Ok(installation_id),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            // Lost a create race: prefer the winner's id if it is valid,
            // otherwise replace the invalid state atomically.
            if let Some(existing) = read_install_id(&path)? {
                Ok(existing)
            } else {
                replace_invalid_state(&path, &payload)?;
                Ok(installation_id)
            }
        }
        Err(err) => Err(err).with_context(|| format!("create {}", path.display())),
    }
}

/// Valid stored id, or `None` when the file is absent or holds invalid state.
fn read_install_id(path: &Path) -> Result<Option<String>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("read {}", path.display())),
    };
    let state: Option<State> = serde_json::from_slice(&bytes).ok();
    let valid = state
        .filter(|s| s.version == STATE_VERSION && is_uuid(&s.installation_id))
        .map(|s| s.installation_id);
    Ok(valid)
}

/// Atomically replace invalid state (temp file + rename, both sides of the
/// rename land on the same filesystem inside the agent dir). The rename goes
/// through `rename_onto` so the win32 destination-busy retry applies, like
/// the TS `writeTelemetryStateAtomically` (`writeFileAtomicSync`).
fn replace_invalid_state(path: &Path, payload: &[u8]) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, payload).with_context(|| format!("write {}", tmp.display()))?;
    set_file_private(&tmp)?;
    crate::rename_onto(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))
}

/// Exclusive create with 0600 permissions on unix (Windows has no portable
/// mode; the agent dir ACLs apply).
fn create_exclusive(path: &Path, payload: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(payload)?;
    file.sync_all()
}

fn set_file_private(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms)
            .with_context(|| format!("chmod 600 {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
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
        let state: State =
            serde_json::from_slice(&std::fs::read(dir.path().join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(state.version, 1);
        assert_eq!(state.installation_id, first);
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
}

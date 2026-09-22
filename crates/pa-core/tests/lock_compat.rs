//! Lock-artifact compatibility through the production call sites: the auth
//! and settings backends must leave exactly the lock artifacts the TS
//! product's `proper-lockfile` convention defines - an empty DIRECTORY at
//! `{file}.lock` that a holder removes on release, a crashed holder leaves
//! stale, and a contender judges for staleness before reclaiming. A regular
//! FILE at the lock path is a pre-compat Rust artifact; this side heals it
//! instead of dying on it (`ENOTDIR`, the TS failure mode).
#![cfg(unix)]

use std::path::Path;
use std::time::Duration;

use pa_core::auth::{AuthStorageBackend, FileAuthStorageBackend};
use pa_core::settings::{FileSettingsStorage, SettingsScope, SettingsStorage};

/// Every staleness threshold in play is far below this.
const STALE: Duration = Duration::from_secs(10);

fn lock_path(file: &Path) -> std::path::PathBuf {
    pa_core::platform::LockDir::path_for(file)
}

/// Set a path's mtime far in the past, the way a crashed holder's artifact
/// looks after a while.
fn age(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("path to cstring");
    let ancient = libc::timespec {
        tv_sec: 1_000_000_000,
        tv_nsec: 0,
    };
    let times = [ancient, ancient];
    let result = unsafe { libc::utimensat(-1, c_path.as_ptr(), times.as_ptr(), 0) };
    assert_eq!(result, 0, "aging {}", path.display());
}

/// Hold a pre-compat flock on the artifact FILE the way the legacy Rust
/// builds did.
struct Flock {
    file: std::fs::File,
}

impl Flock {
    fn hold(path: &Path) -> Self {
        use std::os::unix::io::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open legacy lock file");
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(result, 0, "taking the legacy flock");
        Flock { file }
    }
}

impl Drop for Flock {
    fn drop(&mut self) {
        use std::os::unix::io::AsRawFd;
        unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[test]
fn settings_write_leaves_no_lock_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let storage = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
    storage
        .with_lock(SettingsScope::Global, &mut |current| {
            assert_eq!(current, None);
            Some(r#"{ "defaultProvider": "prime-inference" }"#.to_string())
        })
        .unwrap();
    let settings = dir.path().join("agent").join("settings.json");
    assert!(settings.is_file());
    assert!(
        !lock_path(&settings).exists(),
        "a released write leaves no lock artifact"
    );
}

#[test]
fn settings_write_reclaims_a_crashed_holders_lock_directory() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("agent").join("settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let lock = lock_path(&settings);
    std::fs::create_dir(&lock).unwrap();
    age(&lock);
    let storage = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
    storage
        .with_lock(SettingsScope::Global, &mut |current| {
            assert_eq!(current, None);
            Some("{}".to_string())
        })
        .unwrap();
    assert!(settings.is_file(), "the stale lock did not block the write");
    assert!(!lock.exists(), "the write released its own lock");
}

#[test]
fn settings_write_reports_contention_on_a_live_lock_directory() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("agent").join("settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let guard = pa_core::platform::LockDir::acquire(&settings, STALE).unwrap();
    let storage = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
    let error = storage
        .with_lock(SettingsScope::Global, &mut |_| Some("{}".to_string()))
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Failed to acquire settings lock"),
        "contention surfaces as a lock error: {error}"
    );
    // The failed write left no artifact and no changes, and the contender
    // left the live lock alone.
    assert!(!settings.exists());
    assert!(lock_path(&settings).exists(), "the live lock is intact");
    drop(guard);
}

#[test]
fn auth_write_heals_a_pre_compat_lock_file_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let auth = dir.path().join("auth.json");
    let lock = lock_path(&auth);
    std::fs::write(&lock, "pre-compat flock artifact").unwrap();
    age(&lock);
    let backend = FileAuthStorageBackend::new(&auth);
    backend
        .with_lock(&mut |current| {
            assert_eq!(current.as_deref(), Some("{}"));
            Ok((
                (),
                Some(r#"{ "prime": { "type": "api_key", "key": "sk" } }"#.to_string()),
            ))
        })
        .unwrap();
    assert!(
        auth.is_file(),
        "the healed artifact did not block the write"
    );
    assert!(!lock.exists(), "the write released its own lock");
}

#[test]
fn auth_write_waits_on_a_live_legacy_flock_holder() {
    // A live pre-compat Rust build still holds the flock on the artifact
    // FILE: reclaiming it mid-write would corrupt that process's write, so
    // the heal must treat a held flock as contention, not as garbage.
    let dir = tempfile::tempdir().unwrap();
    let auth = dir.path().join("auth.json");
    let lock = lock_path(&auth);
    std::fs::write(&auth, "{}").unwrap();
    std::fs::write(&lock, "pre-compat flock artifact").unwrap();
    let flock = Flock::hold(&lock);
    let backend = FileAuthStorageBackend::new(&auth);
    let error = backend
        .with_lock(&mut |_| Ok(((), Some("{}".to_string()))))
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Failed to acquire auth storage lock"),
        "a live legacy flock holder must look like contention: {error}"
    );
    assert!(
        lock.is_file(),
        "the failed acquisition must not clobber the live legacy lock"
    );
    drop(flock);
    backend
        .with_lock(&mut |current| {
            assert_eq!(current.as_deref(), Some("{}"));
            Ok((
                (),
                Some(r#"{ "prime": { "type": "api_key", "key": "sk" } }"#.to_string()),
            ))
        })
        .unwrap();
    assert!(!lock.exists(), "the write healed the artifact and released");
}

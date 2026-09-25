//! Settings storage: global (agentDir/settings.json) + project
//! (cwd/<config-dir>/settings.json) files with lock-retry and atomic writes.
//! Port of `FileSettingsStorage` / `InMemorySettingsStorage`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Result};

/// The TS `CONFIG_DIR_NAME` (pkg.piConfig.configDir fallback).
pub const CONFIG_DIR_NAME: &str = ".prime/agent";

/// Scope of a settings document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsScope {
    Global,
    Project,
}

/// Read/modify/write under a per-file advisory lock. `update` returns the next
/// document or `None` to leave the file unchanged (TS `withLock`).
pub trait SettingsStorage: Send + Sync {
    /// # Errors
    ///
    /// Returns an error when the storage fails to lock, read, or write the
    /// scope's settings file.
    fn with_lock(
        &self,
        scope: SettingsScope,
        update: &mut dyn FnMut(Option<String>) -> Option<String>,
    ) -> Result<()>;
}

/// File-backed storage with proper-lockfile directory locks (`{file}.lock`
/// empty directory), retrying briefly on contention like the TS
/// `acquireLockSyncWithRetry` (10 x 20ms).
pub struct FileSettingsStorage {
    global_path: PathBuf,
    project_path: PathBuf,
}

use crate::platform::lock_dir::LockDir as LockGuard;

/// Staleness for the sync settings lock (TS proper-lockfile default: 10s).
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10);

impl FileSettingsStorage {
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        let agent_dir: PathBuf = agent_dir.into();
        FileSettingsStorage {
            global_path: agent_dir.join("settings.json"),
            project_path: cwd.into().join(CONFIG_DIR_NAME).join("settings.json"),
        }
    }

    fn path(&self, scope: SettingsScope) -> &Path {
        match scope {
            SettingsScope::Global => &self.global_path,
            SettingsScope::Project => &self.project_path,
        }
    }

    fn acquire_lock(&self, path: &Path) -> Result<LockGuard> {
        let max_attempts = 10;
        let mut last_error: Option<std::io::Error> = None;
        for _ in 1..=max_attempts {
            match LockGuard::acquire(path, STALE_AFTER) {
                Ok(guard) => return Ok(guard),
                // Only lock contention retries; open failures fail fast.
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if last_error.is_none() {
                        last_error = Some(error);
                    }
                }
                Err(error) => return Err(error.into()),
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Err(anyhow!(
            "Failed to acquire settings lock: {}",
            last_error.map_or_else(|| "busy".into(), |e| e.to_string())
        ))
    }
}

impl SettingsStorage for FileSettingsStorage {
    fn with_lock(
        &self,
        scope: SettingsScope,
        update: &mut dyn FnMut(Option<String>) -> Option<String>,
    ) -> Result<()> {
        let path = self.path(scope);
        let file_exists = path.exists();
        let mut held: Option<LockGuard> = None;
        if file_exists {
            held = Some(self.acquire_lock(path)?);
        }
        let current = if file_exists {
            Some(fs::read_to_string(path)?)
        } else {
            None
        };
        let mut next = update(current);
        if next.is_some() {
            if let Some(dir) = path.parent() {
                if !dir.exists() {
                    fs::create_dir_all(dir)?;
                }
            }
            if held.is_none() {
                held = Some(self.acquire_lock(path)?);
                // A racing first writer may have landed since the unlocked read.
                if path.exists() {
                    next = update(Some(fs::read_to_string(path)?));
                }
            }
            if let Some(content) = next {
                atomic_write(path, &content)?;
            }
        }
        drop(held);
        Ok(())
    }
}

/// Atomic write: temp file + rename, private mode like `writeFileAtomicSync`
/// (its win32-only destination-busy retry rides along in `rename_onto`).
pub fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let temp = PathBuf::from(format!("{}.tmp{}", path.display(), std::process::id()));
    {
        let mut options = fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        crate::platform::perms::set_private_mode(&mut options);
        let mut file = options.open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    crate::platform::rename_onto(&temp, path)?;
    Ok(())
}

/// In-memory storage (tests, embedded hosts).
#[derive(Default)]
pub struct InMemorySettingsStorage {
    global: Mutex<Option<String>>,
    project: Mutex<Option<String>>,
}

impl SettingsStorage for InMemorySettingsStorage {
    fn with_lock(
        &self,
        scope: SettingsScope,
        update: &mut dyn FnMut(Option<String>) -> Option<String>,
    ) -> Result<()> {
        let slot = match scope {
            SettingsScope::Global => &self.global,
            SettingsScope::Project => &self.project,
        };
        let mut guard = slot.lock().unwrap();
        if let Some(next) = update(guard.clone()) {
            *guard = Some(next);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_round_trip() {
        let storage = InMemorySettingsStorage::default();
        storage
            .with_lock(SettingsScope::Global, &mut |current| {
                assert_eq!(current, None);
                Some(r#"{ "theme": "prime" }"#.to_string())
            })
            .unwrap();
        storage
            .with_lock(SettingsScope::Global, &mut |current| {
                assert!(current.unwrap().contains("prime"));
                None
            })
            .unwrap();
    }

    #[test]
    fn file_storage_read_modify_write() {
        let dir = tempfile::tempdir().unwrap();
        let storage = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
        storage
            .with_lock(SettingsScope::Global, &mut |current| {
                assert_eq!(current, None);
                Some(r#"{ "defaultProvider": "prime-inference" }"#.to_string())
            })
            .unwrap();
        let path = dir.path().join("agent").join("settings.json");
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("prime-inference"));
        // Owner-only mode is a Unix guarantee; Windows inherits ACLs.
        #[cfg(unix)]
        assert_eq!(crate::platform::perms::file_mode(&path), Some(0o600));
    }

    /// A relative agent dir (a relative `PRIME_AGENT_CODING_AGENT_DIR`)
    /// locks and loads: the lock probe's `utimensat` resolves relative lock
    /// paths against `AT_FDCWD`, and the settings document under it is
    /// read back under the same lock.
    #[test]
    #[cfg(unix)]
    fn relative_agent_dir_locks_and_loads() {
        let cwd = tempfile::tempdir().unwrap();
        let previous = std::env::current_dir().unwrap();
        std::env::set_current_dir(cwd.path()).unwrap();
        let relative = std::path::PathBuf::from("relative-agent");
        let storage = FileSettingsStorage::new(cwd.path(), relative.clone());
        let written = storage.with_lock(SettingsScope::Global, &mut |current| {
            assert_eq!(current, None);
            Some(r#"{ "theme": "prime" }"#.to_string())
        });
        let read = storage.with_lock(SettingsScope::Global, &mut |current| {
            assert!(current.unwrap().contains("prime"));
            None
        });
        std::env::set_current_dir(previous).unwrap();
        written.unwrap();
        read.unwrap();
        // Assert through the temp cwd: the relative path itself only
        // resolves from inside the chdir window.
        assert!(cwd.path().join(&relative).join("settings.json").exists());
    }
}

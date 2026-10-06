//! Settings storage: global (agentDir/settings.json) + project
//! (cwd/<config-dir>/settings.json) files with lock-retry and atomic writes.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::{anyhow, Result};

pub const CONFIG_DIR_NAME: &str = ".prime/agent";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsScope {
    Global,
    Project,
}

/// Read/modify/write under a per-file advisory lock. `update` returns the next
/// document or `None` to leave the file unchanged.
pub trait SettingsStorage: Send + Sync {
    /// The scope's current content, exactly what [`Self::with_lock`]'s read
    /// arm would deliver, without a write-back channel. Implementations may
    /// serve a process-cached copy validated against the file as it stands.
    /// Writers must still go through [`Self::with_lock`].
    ///
    /// # Errors
    ///
    /// Returns an error when the storage fails to lock or read the scope's
    /// settings file. An absent file is `Ok(None)`, not an error.
    fn read(&self, scope: SettingsScope) -> Result<Option<String>> {
        let mut content = None;
        self.with_lock(scope, &mut |current| {
            content = current;
            None
        })?;
        Ok(content)
    }

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
/// empty directory), retrying briefly on contention like the TS `acquireLockSyncWithRetry`.
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

    fn acquire_lock(path: &Path) -> Result<LockGuard> {
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

/// Same-process serialization for one settings document: the TS lock is
/// single-threaded; the Rust engine is threaded, and two racing worker threads
/// would pay the full retry sleep against each other. The mutex is a leaf; a
/// poisoned mutex is recovered — the file protocol is the correctness mechanism.
fn process_lock(path: &Path) -> MutexGuard<'static, ()> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();
    let registry = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock = {
        let mut registry = registry.lock().expect("settings process-lock registry");
        *registry
            .entry(path.to_path_buf())
            .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
    };
    lock.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The stat identity a cached read is validated against: device, inode, mtime
/// (nanoseconds), and length — every known writer changes one, so a match means
/// the cached content is byte-identical to a locked read right now.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    mtime_sec: i64,
    mtime_nsec: i64,
    len: u64,
}

// The fallible non-Unix twin pins the Option shape across
// platforms - unwrapping only this arm would split the contract.
#[allow(clippy::unnecessary_wraps)]
#[cfg(unix)]
fn stat_identity(metadata: &fs::Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(FileIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mtime_sec: metadata.mtime(),
        mtime_nsec: metadata.mtime_nsec(),
        len: metadata.len(),
    })
}

#[cfg(windows)]
fn stat_identity(metadata: &fs::Metadata) -> Option<FileIdentity> {
    let modified = metadata.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(FileIdentity {
        dev: 0,
        ino: 0,
        mtime_sec: since.as_secs() as i64,
        mtime_nsec: i64::from(since.subsec_nanos()),
        len: metadata.len(),
    })
}

#[cfg(not(any(unix, windows)))]
fn stat_identity(_metadata: &fs::Metadata) -> Option<FileIdentity> {
    None
}

/// One validated document read held in the process-wide read-through cache.
struct CachedRead {
    identity: FileIdentity,
    content: String,
}

/// Validated content per settings document, process-wide: the read-through cache
/// for [`FileSettingsStorage::read`]; a stale stat identity simply misses and re-reads.
static READ_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedRead>>> = OnceLock::new();

fn read_cache() -> &'static Mutex<HashMap<PathBuf, CachedRead>> {
    READ_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl SettingsStorage for FileSettingsStorage {
    /// The consolidated read arm: on a cache hit, one `stat` and the cached content;
    /// on a miss, the full locked cycle, byte-identical to `with_lock`'s read arm, which
    /// also populates the cache. The same-process mutex still orders in-process writers.
    fn read(&self, scope: SettingsScope) -> Result<Option<String>> {
        let path = self.path(scope);
        let _process_guard = process_lock(path);
        let now_identity = fs::metadata(path)
            .ok()
            .and_then(|metadata| stat_identity(&metadata));
        // No file: `with_lock`'s read arm delivers `None` without a lock
        // protocol, and so does this.
        let Some(identity) = now_identity else {
            return Ok(None);
        };
        {
            let cache = read_cache()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(entry) = cache.get(path) {
                if entry.identity == identity {
                    return Ok(Some(entry.content.clone()));
                }
            }
        }
        let guard = Self::acquire_lock(path)?;
        let content = fs::read_to_string(path)?;
        drop(guard);
        read_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                path.to_path_buf(),
                CachedRead {
                    identity,
                    content: content.clone(),
                },
            );
        Ok(Some(content))
    }

    fn with_lock(
        &self,
        scope: SettingsScope,
        update: &mut dyn FnMut(Option<String>) -> Option<String>,
    ) -> Result<()> {
        let path = self.path(scope);
        let _process_guard = process_lock(path);
        let file_exists = path.exists();
        let mut held: Option<LockGuard> = None;
        if file_exists {
            held = Some(Self::acquire_lock(path)?);
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
                held = Some(Self::acquire_lock(path)?);
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

/// The TS `WriteFileAtomicOptions` for [`atomic_write_with`]: `fsync` is
/// the durability opt-in and defaults to OFF.
#[derive(Debug, Default, Clone, Copy)]
pub struct AtomicWriteOptions {
    pub fsync: bool,
}

// Test-only served-path counter: how many times this thread took the
// opt-in fsync branch of `atomic_write_with`.
#[cfg(test)]
thread_local! {
    static OPT_IN_FSYNC: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The per-thread count of opt-in fsync branches taken by [`atomic_write_with`] (test-only).
#[cfg(test)]
pub(crate) fn opt_in_fsync_calls() -> usize {
    OPT_IN_FSYNC.with(std::cell::Cell::get)
}

/// Atomic write: temp file + rename, private mode like `writeFileAtomicSync`.
/// TS default durability: NO fsync (opt-in) — a hard crash leaves either the
/// previous file or the new file. Sites needing the pre-rename fsync opt in
/// through [`atomic_write_with`]; the audit is per call site, never blanket.
pub fn atomic_write(path: &Path, content: &str) -> Result<()> {
    atomic_write_with(path, content, AtomicWriteOptions::default())
}

/// [`atomic_write`] with explicit [`AtomicWriteOptions`]: the TS
/// `writeFileAtomicSync(path, data, options)` shape.
pub fn atomic_write_with(path: &Path, content: &str, options: AtomicWriteOptions) -> Result<()> {
    let temp = PathBuf::from(format!("{}.tmp{}", path.display(), std::process::id()));
    {
        let mut open = fs::OpenOptions::new();
        open.create(true).write(true).truncate(true);
        crate::platform::perms::set_private_mode(&mut open);
        let mut file = open.open(&temp)?;
        file.write_all(content.as_bytes())?;
        if options.fsync {
            #[cfg(test)]
            OPT_IN_FSYNC.with(|count| count.set(count.get() + 1));
            file.sync_all()?;
        }
    }
    crate::platform::rename_onto(&temp, path)?;
    Ok(())
}

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

    #[test]
    fn atomic_write_default_skips_fsync_and_opt_in_takes_exactly_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");

        let before = opt_in_fsync_calls();
        atomic_write(&path, "default bytes\n").unwrap();
        assert_eq!(
            opt_in_fsync_calls(),
            before,
            "TS-default write must not sync"
        );

        atomic_write_with(&path, "durable bytes\n", AtomicWriteOptions { fsync: true }).unwrap();
        assert_eq!(
            opt_in_fsync_calls(),
            before + 1,
            "the opt-in must sync once"
        );

        assert_eq!(fs::read_to_string(&path).unwrap(), "durable bytes\n");
        #[cfg(unix)]
        assert_eq!(crate::platform::perms::file_mode(&path), Some(0o600));
        let names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["state.json".to_string()]);
    }

    #[test]
    fn settings_write_takes_the_ts_default_no_sync() {
        let dir = tempfile::tempdir().unwrap();
        let storage = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
        let document = "{ \"defaultProvider\": \"prime-inference\" }";
        let before = opt_in_fsync_calls();
        storage
            .with_lock(SettingsScope::Global, &mut |_| Some(document.to_string()))
            .unwrap();
        assert_eq!(opt_in_fsync_calls(), before);
        let path = dir.path().join("agent").join("settings.json");
        assert_eq!(fs::read_to_string(&path).unwrap(), document);
    }

    #[test]
    fn read_arm_serves_content_and_survives_writes() {
        let dir = tempfile::tempdir().unwrap();
        let storage = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
        let global = dir.path().join("agent").join("settings.json");
        assert_eq!(storage.read(SettingsScope::Global).unwrap(), None);
        assert!(!global.exists());
        storage
            .with_lock(SettingsScope::Global, &mut |current| {
                assert_eq!(current, None);
                Some(r#"{ "theme": "prime" }"#.to_string())
            })
            .unwrap();
        assert_eq!(
            storage.read(SettingsScope::Global).unwrap().as_deref(),
            Some(r#"{ "theme": "prime" }"#)
        );
        let other = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
        assert_eq!(
            other.read(SettingsScope::Global).unwrap().as_deref(),
            Some(r#"{ "theme": "prime" }"#)
        );
        std::fs::write(&global, r#"{ "theme": "dark" }"#).unwrap();
        assert_eq!(
            storage.read(SettingsScope::Global).unwrap().as_deref(),
            Some(r#"{ "theme": "dark" }"#)
        );
        let tmp = global.with_extension("json.tmp-ext");
        std::fs::write(&tmp, r#"{ "theme": "ink" }"#).unwrap();
        std::fs::rename(&tmp, &global).unwrap();
        assert_eq!(
            storage.read(SettingsScope::Global).unwrap().as_deref(),
            Some(r#"{ "theme": "ink" }"#)
        );
    }

    #[test]
    fn read_arm_error_matches_with_lock_read() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(agent.join("settings.json")).unwrap();
        let storage = FileSettingsStorage::new(dir.path().join("cwd"), &agent);
        assert!(storage.read(SettingsScope::Global).is_err());
    }

    #[test]
    fn read_arm_default_is_with_lock_read() {
        let storage = InMemorySettingsStorage::default();
        storage
            .with_lock(SettingsScope::Global, &mut |current| {
                let _ = current;
                Some(r#"{ "theme": "prime" }"#.to_string())
            })
            .unwrap();
        assert_eq!(
            storage.read(SettingsScope::Global).unwrap().as_deref(),
            Some(r#"{ "theme": "prime" }"#)
        );
        assert_eq!(storage.read(SettingsScope::Project).unwrap(), None);
    }

    /// A relative agent dir (a relative `PRIME_AGENT_CODING_AGENT_DIR`) locks and
    /// loads: the lock probe's `utimensat` resolves relative lock paths against `AT_FDCWD`.
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

//! Auth storage backends: locked JSON file (0o600, atomic writes) and
//! in-memory (tests, embedded hosts). Port of the auth-storage backends.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::Result;

use super::types::AuthStorageData;

/// Locked read/modify/write over the auth document. `update` returns
/// `(result, next)`; `next: Some` writes it back atomically.
pub trait AuthStorageBackend: Send + Sync {
    /// The document's current content, exactly what [`Self::with_lock`]'s
    /// read arm would deliver, without a write-back channel. Implementations
    /// may serve a process-cached copy validated against the file as it
    /// stands; `FileAuthStorageBackend` does (the TS product keeps one
    /// `AuthStorage` per session and reads its in-memory snapshot, so its
    /// per-turn path takes no lock at all, while this port rebuilds the
    /// storage per call and would otherwise pay the full lock cycle each
    /// time). Writers must still go through [`Self::with_lock`], whose
    /// read-modify-write file protocol is untouched.
    ///
    /// # Errors
    ///
    /// Returns an error when preparing or locking the document fails, as
    /// `with_lock` would. An unreadable document is `Ok(None)`, not an
    /// error, matching `with_lock`'s best-effort read.
    fn read(&self) -> Result<Option<String>> {
        let mut content = None;
        self.with_lock(&mut |current| {
            content = current;
            Ok(((), None))
        })?;
        Ok(content)
    }

    /// # Errors
    ///
    /// Returns an error when the backend fails to acquire its lock, when
    /// the `update` callback fails, or when preparing or writing the auth
    /// document fails. Reading the current document is best-effort: an
    /// unreadable file reaches the callback as `None`, not an error.
    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> Result<((), Option<String>)>,
    ) -> Result<()>;
}

use crate::platform::lock_dir::LockDir as LockGuard;

/// Staleness for the sync auth lock (TS proper-lockfile default: 10s).
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10);

pub struct FileAuthStorageBackend {
    auth_path: PathBuf,
}

impl FileAuthStorageBackend {
    pub fn new(auth_path: impl Into<PathBuf>) -> Self {
        FileAuthStorageBackend {
            auth_path: auth_path.into(),
        }
    }

    fn ensure_parent_dir(&self) -> Result<()> {
        if let Some(dir) = self.auth_path.parent() {
            if !dir.exists() {
                fs::create_dir_all(dir)?;
                crate::platform::perms::restrict_dir(dir)?;
            }
        }
        Ok(())
    }

    /// Exclusive create: a racing initializer must never replace saved
    /// credentials.
    fn ensure_file_exists(&self) -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        crate::platform::perms::set_private_mode(&mut options);
        match options.open(&self.auth_path) {
            Ok(mut file) => {
                // The TS initializer writes exactly "{}".
                use std::io::Write;
                let _ = file.write_all(b"{}");
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    /// TS `acquireLockSyncWithRetry`: 10 attempts, 20ms apart, retrying only
    /// contention (ELOCKED); other errors fail fast.
    fn acquire_lock(&self) -> Result<LockGuard> {
        let mut last_error: Option<std::io::Error> = None;
        for _ in 1..=10 {
            match LockGuard::acquire(&self.auth_path, STALE_AFTER) {
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
        Err(anyhow::anyhow!(
            "Failed to acquire auth storage lock: {}",
            last_error.map_or_else(|| "busy".into(), |e| e.to_string())
        ))
    }
}

/// Same-process serialization for one auth document.
///
/// The TS product runs its synchronous auth lock on a single thread, so two
/// `acquireLockSyncWithRetry` calls in one process can never contend: the
/// 10x20ms retry only ever fires against another process. The Rust engine
/// is threaded, and two threads racing the same document pay the full TS
/// retry sleep against each other (a fresh session's first turn resolves
/// its model while a concurrent read holds the lock). A process-local
/// mutex keyed by the document path serializes same-process callers for
/// the microseconds the small read/modify/write holds; the file protocol
/// and its retry semantics are untouched, so a foreign holder (another
/// process) still surfaces `WouldBlock` and still takes the 10x20ms
/// retry. Each path's mutex is created once and lives for the process
/// (a handful of documents per process, a `Mutex<()>` each).
///
/// The mutex is a leaf: the locked section performs only the document's
/// own filesystem operations and the caller's `update` callback, and no
/// callback re-enters `with_lock`. Poisoning cannot wedge later reads: the
/// file protocol is the correctness mechanism, so a poisoned mutex is
/// recovered instead of propagated.
fn process_lock(path: &Path) -> MutexGuard<'static, ()> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();
    let registry = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock = {
        let mut registry = registry.lock().expect("auth process-lock registry");
        *registry
            .entry(path.to_path_buf())
            .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
    };
    lock.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The stat identity a cached read is validated against: device, inode,
/// mtime (nanoseconds), and length. Every writer the protocol knows either
/// replaces the document by atomic rename (a new inode) or rewrites it in
/// place (a new mtime), so a matching identity means the cached content is
/// byte-identical to what a locked read would return right now.
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
        mtime_nsec: since.subsec_nanos() as i64,
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

/// Validated content per auth document, process-wide: the read-through
/// cache for [`FileAuthStorageBackend::read`]. Entries live for the process
/// (a handful of small documents per process, mirroring the process-lock
/// registry's lifetime policy); a stat identity that no longer matches
/// simply misses and re-reads, so entries never outlive their file.
static READ_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedRead>>> = OnceLock::new();

/// The process-wide read-through cache, created on first use.
fn read_cache() -> &'static Mutex<HashMap<PathBuf, CachedRead>> {
    READ_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl AuthStorageBackend for FileAuthStorageBackend {
    /// The consolidated read arm: on a cache hit, one `stat` and the
    /// cached content (no lock protocol at all — the TS session's own
    /// per-turn reads take no lock either); on a miss, the full locked
    /// protocol cycle, byte-identical to `with_lock`'s read arm, which
    /// also populates the cache. The same-process mutex still orders
    /// this against in-process writers (see [`process_lock`]), and an
    /// external write changes the stat identity, so the next read
    /// misses and re-reads fresh.
    fn read(&self) -> Result<Option<String>> {
        let _process_guard = process_lock(&self.auth_path);
        let now_identity = fs::metadata(&self.auth_path)
            .ok()
            .and_then(|metadata| stat_identity(&metadata));
        if let Some(identity) = now_identity {
            let cache = read_cache()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(entry) = cache.get(&self.auth_path) {
                if entry.identity == identity {
                    return Ok(Some(entry.content.clone()));
                }
            }
        }
        // Miss: the full protocol read — the lock protocol is unchanged.
        self.ensure_parent_dir()?;
        self.ensure_file_exists()?;
        // A read can arrive before the document's initializer created it
        // (the up-front stat was then `None`), so the identity that pairs
        // with this read is the document as it now stands.
        let now_identity = fs::metadata(&self.auth_path)
            .ok()
            .and_then(|metadata| stat_identity(&metadata));
        let guard = self.acquire_lock()?;
        let content = fs::read_to_string(&self.auth_path).ok();
        drop(guard);
        if let (Some(identity), Some(content)) = (now_identity, content.as_deref()) {
            read_cache()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(
                    self.auth_path.clone(),
                    CachedRead {
                        identity,
                        content: content.to_string(),
                    },
                );
        }
        Ok(content)
    }

    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> Result<((), Option<String>)>,
    ) -> Result<()> {
        let _process_guard = process_lock(&self.auth_path);
        self.ensure_parent_dir()?;
        self.ensure_file_exists()?;
        let guard = self.acquire_lock()?;
        let current = fs::read_to_string(&self.auth_path).ok();
        let ((), next) = update(current)?;
        if let Some(next) = next {
            super::super::settings::storage::atomic_write(&self.auth_path, &next)?;
        }
        drop(guard);
        Ok(())
    }
}

#[derive(Default)]
pub struct InMemoryAuthStorageBackend {
    value: Mutex<Option<String>>,
}

impl AuthStorageBackend for InMemoryAuthStorageBackend {
    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> Result<((), Option<String>)>,
    ) -> Result<()> {
        let mut guard = self.value.lock().unwrap();
        let ((), next) = update(guard.clone())?;
        if let Some(next) = next {
            *guard = Some(next);
        }
        Ok(())
    }
}

/// Parse an auth document; invalid JSON or a non-object root is a load error
/// (the TS throws too).
///
/// # Errors
///
/// Returns an error when the content is not valid JSON or its root is not a
/// JSON object. Empty content parses as the default, empty document.
pub fn parse_storage_data(content: Option<&str>) -> Result<AuthStorageData> {
    let content = content.filter(|content| !content.is_empty());
    let Some(content) = content else {
        return Ok(AuthStorageData::default());
    };
    let value: serde_json::Value = serde_json::from_str(content)?;
    let serde_json::Value::Object(map) = value else {
        anyhow::bail!("Invalid auth storage: expected a JSON object");
    };
    Ok(AuthStorageData(map))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_backend_round_trip_and_modes() {
        let dir = tempfile::tempdir().unwrap();
        let backend = FileAuthStorageBackend::new(dir.path().join("auth.json"));
        backend
            .with_lock(&mut |current| {
                // The exclusive-create initializer writes exactly "{}".
                assert_eq!(current.as_deref(), Some("{}"));
                Ok((
                    (),
                    Some(
                        r#"{ "prime-inference": { "type": "api_key", "key": "sk" } }"#.to_string(),
                    ),
                ))
            })
            .unwrap();
        let path = dir.path().join("auth.json");
        // Owner-only mode is a Unix guarantee; Windows inherits ACLs.
        #[cfg(unix)]
        assert_eq!(crate::platform::perms::file_mode(&path), Some(0o600));
        let data = parse_storage_data(Some(&fs::read_to_string(&path).unwrap())).unwrap();
        assert!(data.credential("prime-inference").is_some());
    }

    /// Per-call-site served-path oracle (auth-storage.ts:206/:250 pass only
    /// `{ mode: 0o600 }`): the auth save goes through the real `with_lock`
    /// writer and takes NO fsync branch, landing the exact document bytes.
    #[test]
    fn auth_write_takes_the_ts_default_no_sync() {
        let dir = tempfile::tempdir().unwrap();
        let backend = FileAuthStorageBackend::new(dir.path().join("auth.json"));
        let document = r#"{ "prime-inference": { "type": "api_key", "key": "sk" } }"#;
        let before = crate::settings::storage::opt_in_fsync_calls();
        backend
            .with_lock(&mut |_| Ok(((), Some(document.to_string()))))
            .unwrap();
        assert_eq!(
            crate::settings::storage::opt_in_fsync_calls(),
            before,
            "the TS-default auth write must not sync"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("auth.json")).unwrap(),
            document
        );
    }

    #[test]
    fn parse_rejects_non_object() {
        assert!(parse_storage_data(Some("[1,2]")).is_err());
        assert_eq!(
            parse_storage_data(None).unwrap().keys(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn read_creates_the_document_like_with_lock() {
        let dir = tempfile::tempdir().unwrap();
        let backend = FileAuthStorageBackend::new(dir.path().join("auth.json"));
        // A fresh agent dir: the miss path runs the full protocol, so the
        // exclusive-create initializer writes exactly "{}" exactly as
        // `with_lock` would.
        assert_eq!(backend.read().unwrap().as_deref(), Some("{}"));
        assert!(dir.path().join("auth.json").is_file());
    }

    #[test]
    fn read_hits_do_not_run_the_lock_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let backend = FileAuthStorageBackend::new(&path);
        backend.read().unwrap();
        // A second instance on the same path: the first read populated the
        // process-wide cache, so this read is a hit and serves the cached
        // copy without touching the lock protocol.
        let backend2 = FileAuthStorageBackend::new(&path);
        assert_eq!(backend2.read().unwrap().as_deref(), Some("{}"));
        assert!(
            !crate::platform::lock_dir::LockDir::path_for(&path).exists(),
            "a read hit leaves no lock artifact"
        );
    }

    #[test]
    fn read_sees_external_atomic_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let backend = FileAuthStorageBackend::new(&path);
        backend.read().unwrap();
        // An external atomic write (the protocol every writer uses): the
        // temp file renames over the document, changing the inode, so the
        // next read must miss and return the new content.
        let temp = dir.path().join("external.tmp");
        fs::write(&temp, r#"{ "written": "externally" }"#).unwrap();
        fs::rename(&temp, &path).unwrap();
        assert_eq!(
            backend.read().unwrap().as_deref(),
            Some(r#"{ "written": "externally" }"#)
        );
    }

    #[test]
    fn read_sees_external_in_place_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let backend = FileAuthStorageBackend::new(&path);
        backend.read().unwrap();
        // An in-place external write keeps the inode but changes the
        // mtime (and here the size too): the identity must not match.
        fs::write(&path, r#"{ "rewritten": "in place" }"#).unwrap();
        assert_eq!(
            backend.read().unwrap().as_deref(),
            Some(r#"{ "rewritten": "in place" }"#)
        );
    }

    #[test]
    fn read_hits_serve_the_validated_copy_under_a_foreign_holder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let backend = FileAuthStorageBackend::new(&path);
        assert_eq!(backend.read().unwrap().as_deref(), Some("{}"));
        // A foreign lock directory (another process mid-write) would make
        // `with_lock` retry 10x and fail; a validated hit serves the
        // cached copy — the document has not changed, so locking for a
        // pure read serves nothing the TS session's in-memory read would.
        fs::create_dir(crate::platform::lock_dir::LockDir::path_for(&path)).unwrap();
        assert_eq!(backend.read().unwrap().as_deref(), Some("{}"));
        fs::remove_dir(crate::platform::lock_dir::LockDir::path_for(&path)).unwrap();
    }

    #[test]
    fn read_sees_this_process_with_lock_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let backend = FileAuthStorageBackend::new(&path);
        backend.read().unwrap();
        // A write through the unchanged `with_lock` protocol, then a read:
        // the atomic rename changes the inode, so the read misses and
        // serves what was written.
        backend
            .with_lock(&mut |current| {
                assert_eq!(current.as_deref(), Some("{}"));
                Ok(((), Some(r#"{ "written": "locally" }"#.to_string())))
            })
            .unwrap();
        assert_eq!(
            backend.read().unwrap().as_deref(),
            Some(r#"{ "written": "locally" }"#)
        );
    }
}

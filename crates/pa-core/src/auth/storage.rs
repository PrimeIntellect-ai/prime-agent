//! Auth storage backends: locked JSON file (0o600, atomic writes) and
//! in-memory (tests, embedded hosts).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::Result;

use super::types::AuthStorageData;

/// Locked read/modify/write over the auth document. `update` returns
/// `(result, next)`; `next: Some` writes it back atomically.
pub trait AuthStorageBackend: Send + Sync {
    /// The document's current content, exactly what [`Self::with_lock`]'s read
    /// arm would deliver, without a write-back channel. Writers must still go
    /// through [`Self::with_lock`].
    ///
    /// # Errors
    ///
    /// Returns an error when preparing or locking the document fails.
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
    /// Returns an error when the backend fails to lock, the document read
    /// fails, the `update` callback fails, or writing the document fails; a
    /// file that is genuinely absent reaches the callback as `None`.
    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> Result<((), Option<String>)>,
    ) -> Result<()>;

    /// The cross-process refresh single-flight for one provider: a lock
    /// held across the OAuth re-check, token fetch, and credential write
    /// so concurrent processes (the daemon runs one worker per session)
    /// never spend the same single-use refresh token. The lock is
    /// process-released ([`RefreshLock`]): the kernel drops the hold when
    /// the holder process dies, so crash recovery needs no stale-reclaim
    /// step (no observe-then-remove race can admit two holders) and a
    /// live holder never loses it. One lock per provider — a stalled
    /// refresh of one provider's token (held up to its fetch's HTTP
    /// deadline) must not block another provider's. `Ok(None)` on
    /// single-process backends; the process-local flight gate serializes
    /// those.
    ///
    /// # Errors
    ///
    /// Returns the lock-acquisition error when the lock cannot be taken
    /// within the backend's fixed acquisition budget (150 attempts at
    /// 100 ms).
    fn refresh_lock(&self, provider: &str) -> Result<Option<RefreshLock>> {
        let _ = provider;
        Ok(None)
    }
}

/// The cross-process refresh lock's guard: the OS file lock on the
/// provider's dedicated lock file. Released by the guard's drop (the
/// open file description closes) or by the kernel when the holder
/// process dies — never by a stale-reclaim step, which is why the
/// refresh single-flight cannot lose exclusivity to a racing reclaimer.
/// The lock file itself is never removed: an unlinked lock file lets a
/// later opener lock a second inode while a waiter still holds the
/// first, breaking exclusivity.
pub struct RefreshLock(std::fs::File);

impl Drop for RefreshLock {
    fn drop(&mut self) {
        // Explicit release; the kernel also drops the hold when the open
        // file description closes or the holder process dies.
        let _ = crate::platform::unlock_file(&self.0);
    }
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
/// TS's synchronous auth lock runs on one thread, so same-process calls never
/// contend; the threaded Rust engine would pay the 10x20ms retry against itself.
/// The file protocol is the correctness mechanism.
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

/// The stat identity a cached read is validated against: every writer renames the document in
/// place, so a matching identity means the cached content is byte-identical to a locked read now.
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

/// Validated content per auth document: the read-through cache for
/// [`FileAuthStorageBackend::read`]. A stat identity that no longer matches simply misses.
static READ_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedRead>>> = OnceLock::new();

fn read_cache() -> &'static Mutex<HashMap<PathBuf, CachedRead>> {
    READ_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl AuthStorageBackend for FileAuthStorageBackend {
    /// On a hit, one `stat` and the cached content; on a miss, the full
    /// locked protocol cycle, which also populates the cache.
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
        self.ensure_parent_dir()?;
        self.ensure_file_exists()?;
        // A read can arrive before the initializer created the document,
        // so re-stat for the identity that pairs with this read.
        let now_identity = fs::metadata(&self.auth_path)
            .ok()
            .and_then(|metadata| stat_identity(&metadata));
        let guard = self.acquire_lock()?;
        // TS `withLock` reads through `readFileSync` and propagates its
        // failures (auth-storage.ts:203): an unreadable document is an
        // ERROR, never an empty store — a failed read is not a logout.
        // Only a file that is genuinely absent reads as `None`.
        let content = if self.auth_path.exists() {
            Some(fs::read_to_string(&self.auth_path)?)
        } else {
            None
        };
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
        // The TS read arm: `readFileSync` failures propagate
        // (auth-storage.ts:246), only a genuinely absent file reads as
        // `None`.
        let current = if self.auth_path.exists() {
            Some(fs::read_to_string(&self.auth_path)?)
        } else {
            None
        };
        let ((), next) = update(current)?;
        if let Some(next) = next {
            super::super::settings::storage::atomic_write_with(
                &self.auth_path,
                &next,
                super::super::settings::storage::AtomicWriteOptions { fsync: true },
            )?;
        }
        drop(guard);
        Ok(())
    }

    /// The refresh single-flight's lock: a dedicated process-released
    /// file lock beside the document, not the document lock itself — a
    /// fetch under the document lock would stall every same-process auth
    /// read and write for the fetch's whole span, and the document lock's
    /// protocol (a `proper-lockfile`-compatible directory) must stay
    /// TS-interop on the wire. The lock file is
    /// `auth.json.refresh.<hash>.lock`, one per provider (`mcp:*` ids
    /// carry path-hostile characters; a hashed key keeps the name flat),
    /// and it is never removed — the guard's release is the OS lock, and
    /// an unlinked lock file would let a later opener lock a second inode
    /// under a waiting holder. A waiting peer covers one holder's whole
    /// fetch plus the write: 150 attempts at 100ms; a peer that cannot
    /// take the lock serves the stored credential instead.
    fn refresh_lock(&self, provider: &str) -> Result<Option<RefreshLock>> {
        let mut refresh_file = self.auth_path.as_os_str().to_os_string();
        refresh_file.push(".refresh.");
        // The per-provider lock-file key: a short FNV-1a hash, stable and
        // dependency-free, keeping one lock file per provider id
        // (`mcp:*` ids carry path-hostile characters).
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in provider.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        refresh_file.push(format!("{hash:016x}"));
        refresh_file.push(".lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            // The lock file holds no content — the OS lock rides the open
            // file description — so an existing file is never truncated.
            .truncate(false)
            .open(std::path::Path::new(&refresh_file))?;
        // Contention (WouldBlock) waits out the budget below; any other
        // error surfaces immediately as the lock-acquisition failure.
        for attempt in 1..=150 {
            match crate::platform::try_lock_exclusive(&file) {
                Ok(()) => return Ok(Some(RefreshLock(file))),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }
            if attempt < 150 {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        Err(anyhow::anyhow!(
            "Failed to acquire the {provider} refresh lock: locked by a live holder"
        ))
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
/// Returns an error when the content is not valid JSON or its root is not a JSON object.
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

    /// The auth save goes through the real `with_lock` writer and takes exactly one fsync branch
    /// landing the exact document bytes.
    #[test]
    fn auth_write_takes_exactly_one_fsync() {
        let dir = tempfile::tempdir().unwrap();
        let backend = FileAuthStorageBackend::new(dir.path().join("auth.json"));
        let document = r#"{ "prime-inference": { "type": "api_key", "key": "sk" } }"#;
        let before = crate::settings::storage::opt_in_fsync_calls();
        backend
            .with_lock(&mut |_| Ok(((), Some(document.to_string()))))
            .unwrap();
        assert_eq!(
            crate::settings::storage::opt_in_fsync_calls(),
            before + 1,
            "the auth write must flush the temp file before the rename"
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
        assert_eq!(backend.read().unwrap().as_deref(), Some("{}"));
        assert!(dir.path().join("auth.json").is_file());
    }

    #[test]
    fn read_hits_do_not_run_the_lock_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let backend = FileAuthStorageBackend::new(&path);
        backend.read().unwrap();
        // The first read populated the process-wide cache, so this
        // second instance's read is a hit.
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
        // The rename changes the inode, so the next read must miss.
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
        // Keeps the inode but changes the mtime: the identity must not match.
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
        // A foreign lock directory would make `with_lock` retry 10x and
        // fail; a validated hit serves the cached copy instead.
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

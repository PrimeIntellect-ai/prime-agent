//! Settings storage: global (agentDir/settings.json) + project
//! (cwd/<config-dir>/settings.json) files with lock-retry and atomic writes.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::{anyhow, bail, Result};

#[cfg(any(unix, windows))]
use std::path::Component;

#[cfg(unix)]
use crate::platform::fs::open_readable_directory_at;
#[cfg(any(unix, windows))]
use crate::platform::fs::{
    self as platform_fs, open_regular_file_at, open_search_absolute_directory,
    open_search_directory_at, DirectoryCreation,
};

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
    project_root: PathBuf,
}

use crate::platform::lock_dir::LockDir as LockGuard;

/// Staleness for the sync settings lock (TS proper-lockfile default: 10s).
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(unix)]
fn is_multiply_linked(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() > 1
}

#[cfg(unix)]
fn same_inode(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

impl FileSettingsStorage {
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        let agent_dir: PathBuf = agent_dir.into();
        let project_root: PathBuf = cwd.into();
        FileSettingsStorage {
            global_path: agent_dir.join("settings.json"),
            project_path: project_root.join(CONFIG_DIR_NAME).join("settings.json"),
            project_root,
        }
    }

    fn path(&self, scope: SettingsScope) -> &Path {
        match scope {
            SettingsScope::Global => &self.global_path,
            SettingsScope::Project => &self.project_path,
        }
    }

    /// Resolve a path through its closest existing ancestor, preserving
    /// missing descendants (including a deleted project working directory).
    fn resolve_with_missing(path: &Path) -> Result<PathBuf> {
        let mut candidate = if path.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            path.to_path_buf()
        };
        let mut missing = Vec::new();
        let mut symlink_hops = 0;
        loop {
            match fs::symlink_metadata(&candidate) {
                Ok(metadata) => match fs::canonicalize(&candidate) {
                    Ok(mut resolved) => {
                        for component in missing.iter().rev() {
                            resolved.push(component);
                        }
                        return Ok(resolved);
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::NotFound
                            && metadata.file_type().is_symlink() =>
                    {
                        symlink_hops += 1;
                        if symlink_hops > 40 {
                            bail!("Project settings path has too many symbolic links");
                        }
                        let target = fs::read_link(&candidate)?;
                        candidate = if target.is_absolute() {
                            target
                        } else {
                            candidate
                                .parent()
                                .filter(|parent| !parent.as_os_str().is_empty())
                                .unwrap_or_else(|| Path::new("."))
                                .join(target)
                        };
                    }
                    Err(error) => return Err(error.into()),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing.push(
                        candidate
                            .file_name()
                            .ok_or_else(|| anyhow!("Project settings path has no file name"))?
                            .to_os_string(),
                    );
                    candidate = candidate
                        .parent()
                        .filter(|parent| !parent.as_os_str().is_empty())
                        .unwrap_or_else(|| Path::new("."))
                        .to_path_buf();
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    /// A shared settings file may be linked inside the project, but must not
    /// resolve outside it.
    fn project_path_within_root(&self, path: &Path) -> Result<PathBuf> {
        let root = Self::resolve_with_missing(&self.project_root)?;
        let resolved = Self::resolve_with_missing(path)?;
        if !resolved.starts_with(&root) {
            bail!("Project settings path escapes the project root");
        }
        Ok(resolved)
    }

    fn scoped_lock_path(&self, scope: SettingsScope) -> Result<PathBuf> {
        let path = self.path(scope);
        match scope {
            SettingsScope::Global => Ok(path.to_path_buf()),
            SettingsScope::Project => self.project_path_within_root(path),
        }
    }

    fn check_locked_project_path(&self, path: &Path, locked_path: &Path) -> Result<()> {
        if self.project_path_within_root(path)? != locked_path {
            bail!("Project settings path changed while locked");
        }
        Ok(())
    }

    /// Hold the resolved target directory under the same project root that
    /// passed containment validation. A missing directory is created later,
    /// only if the update actually writes a document.
    #[cfg(any(unix, windows))]
    fn project_parent_anchor(
        &self,
        locked_path: &Path,
        creation: DirectoryCreation,
    ) -> Result<Option<fs::File>> {
        let root_path = Self::resolve_with_missing(&self.project_root)?;
        let parent_path = locked_path
            .parent()
            .ok_or_else(|| anyhow!("Project settings path has no parent"))?;
        let relative = parent_path
            .strip_prefix(&root_path)
            .map_err(|_| anyhow!("Project settings path escapes the project root"))?;
        #[cfg(all(test, windows))]
        project_anchor_step(ProjectAnchorStep::Open);
        let root = match open_search_absolute_directory(&root_path, creation) {
            Ok(root) => root,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && creation == DirectoryCreation::ExistingOnly =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        #[cfg(all(test, windows))]
        project_anchor_step(ProjectAnchorStep::Check);
        self.check_locked_project_path(&self.project_path, locked_path)?;
        if Self::resolve_with_missing(&self.project_root)? != root_path {
            bail!("Project root changed while opening settings directory");
        }
        #[cfg(unix)]
        if !same_inode(&root.metadata()?, &fs::metadata(&self.project_root)?) {
            bail!("Project root changed while opening settings directory");
        }
        #[cfg(windows)]
        if !platform_fs::same_directory_at_path(&root, &self.project_root)? {
            bail!("Project root changed while opening settings directory");
        }
        let mut dir = root;
        for component in relative.components() {
            match component {
                Component::CurDir => {}
                Component::Normal(name) => {
                    dir = match open_search_directory_at(&dir, name, creation) {
                        Ok(dir) => dir,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::NotFound
                                && creation == DirectoryCreation::ExistingOnly =>
                        {
                            return Ok(None);
                        }
                        Err(error) => return Err(error.into()),
                    };
                }
                Component::RootDir | Component::ParentDir | Component::Prefix(_) => {
                    bail!("Project settings directory is not beneath its project root");
                }
            }
        }
        #[cfg(windows)]
        if !platform_fs::same_directory_at_path(&dir, parent_path)? {
            bail!("Project settings directory changed while opening");
        }
        self.check_locked_project_path(&self.project_path, locked_path)?;
        #[cfg(unix)]
        if !same_inode(&dir.metadata()?, &fs::metadata(parent_path)?) {
            bail!("Project settings directory changed while opening");
        }
        Ok(Some(dir))
    }

    fn read_file(&self, scope: SettingsScope, path: &Path, locked_path: &Path) -> Result<String> {
        if scope == SettingsScope::Global {
            return Ok(fs::read_to_string(path)?);
        }
        #[cfg(any(unix, windows))]
        let mut file = {
            // The locked path is the resolved in-project target, including for
            // an intentional in-project settings symlink. Hold its parent and
            // open only its final regular basename from that directory.
            let parent = self
                .project_parent_anchor(locked_path, DirectoryCreation::ExistingOnly)?
                .ok_or_else(|| anyhow!("Project settings directory is missing"))?;
            let name = locked_path
                .file_name()
                .ok_or_else(|| anyhow!("Project settings path has no file name"))?;
            #[cfg(test)]
            project_read_step(ProjectReadStep::Open);
            open_regular_file_at(&parent, name)?
        };
        #[cfg(not(any(unix, windows)))]
        let mut file = fs::File::open(path)?;
        let opened = file.metadata()?;
        #[cfg(windows)]
        if !opened.is_file() {
            bail!("Project settings target is not a regular file");
        }
        #[cfg(unix)]
        if is_multiply_linked(&opened) {
            bail!("Project settings file has multiple hard links");
        }
        #[cfg(windows)]
        if crate::platform::fs::has_multiple_hard_links(&file)? {
            bail!("Project settings file has multiple hard links");
        }
        #[cfg(all(test, any(unix, windows)))]
        // Preserve the pre-fix path-check interleavings in the race test.
        project_read_step(ProjectReadStep::Restore);
        #[cfg(not(any(unix, windows)))]
        self.check_locked_project_path(path, locked_path)?;
        #[cfg(all(test, any(unix, windows)))]
        project_read_step(ProjectReadStep::Repoint);
        #[cfg(not(any(unix, windows)))]
        {
            let checked = fs::metadata(locked_path)?;
            if stat_identity(&opened).is_none() || stat_identity(&opened) != stat_identity(&checked)
            {
                bail!("Project settings path changed while reading");
            }
        }
        let mut content = String::new();
        file.read_to_string(&mut content)?;
        Ok(content)
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
        let locked_path = self.scoped_lock_path(scope)?;
        let _process_guard = process_lock(&locked_path);
        if scope == SettingsScope::Project {
            self.check_locked_project_path(path, &locked_path)?;
        }
        let now_metadata = fs::metadata(path).ok();
        #[cfg(windows)]
        let now_metadata = if scope == SettingsScope::Project && now_metadata.is_some() {
            let file = fs::File::open(path)?;
            if crate::platform::fs::has_multiple_hard_links(&file)? {
                bail!("Project settings file has multiple hard links");
            }
            Some(file.metadata()?)
        } else {
            now_metadata
        };
        #[cfg(unix)]
        if scope == SettingsScope::Project && now_metadata.as_ref().is_some_and(is_multiply_linked)
        {
            bail!("Project settings file has multiple hard links");
        }
        let now_identity = now_metadata.as_ref().and_then(stat_identity);
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
        let guard = Self::acquire_lock(&locked_path)?;
        let content = self.read_file(scope, path, &locked_path)?;
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
        let locked_path = self.scoped_lock_path(scope)?;
        let _process_guard = process_lock(&locked_path);
        if scope == SettingsScope::Project {
            self.check_locked_project_path(path, &locked_path)?;
        }
        #[cfg(any(unix, windows))]
        let mut project_parent = if scope == SettingsScope::Project {
            self.project_parent_anchor(&locked_path, DirectoryCreation::ExistingOnly)?
        } else {
            None
        };
        #[cfg(all(test, windows))]
        if scope == SettingsScope::Project {
            BEFORE_PROJECT_LOCK.with(|hook| {
                if let Some(callback) = hook.borrow_mut().take() {
                    callback();
                }
            });
        }
        let file_exists = path.exists();
        let mut held: Option<LockGuard> = None;
        if file_exists {
            held = Some(Self::acquire_lock(&locked_path)?);
        }
        let current = if file_exists {
            Some(self.read_file(scope, path, &locked_path)?)
        } else {
            None
        };
        let mut next = update(current);
        if next.is_some() {
            let write_dir = if scope == SettingsScope::Project {
                locked_path.parent()
            } else {
                path.parent()
            };
            #[cfg(any(unix, windows))]
            let create_by_path = scope == SettingsScope::Global;
            #[cfg(not(any(unix, windows)))]
            let create_by_path = true;
            if create_by_path {
                if let Some(dir) = write_dir {
                    if !dir.exists() {
                        fs::create_dir_all(dir)?;
                    }
                }
            }
            if scope == SettingsScope::Project {
                self.check_locked_project_path(path, &locked_path)?;
            }
            #[cfg(any(unix, windows))]
            if scope == SettingsScope::Project && project_parent.is_none() {
                project_parent = Some(
                    self.project_parent_anchor(&locked_path, DirectoryCreation::CreateMissing)?
                        .ok_or_else(|| anyhow!("Project settings directory is missing"))?,
                );
            }
            if held.is_none() {
                held = Some(Self::acquire_lock(&locked_path)?);
                // A racing first writer may have landed since the unlocked read.
                if path.exists() {
                    next = update(Some(self.read_file(scope, path, &locked_path)?));
                }
            }
            if let Some(content) = next {
                if scope == SettingsScope::Project {
                    self.check_locked_project_path(path, &locked_path)?;
                    #[cfg(unix)]
                    {
                        let parent = project_parent
                            .as_ref()
                            .ok_or_else(|| anyhow!("Project settings directory is missing"))?;
                        let parent_path = locked_path
                            .parent()
                            .ok_or_else(|| anyhow!("Project settings path has no parent"))?;
                        if !same_inode(&parent.metadata()?, &fs::metadata(parent_path)?) {
                            bail!("Project settings directory changed while locked");
                        }
                    }
                }
                #[cfg(all(test, any(unix, windows)))]
                if scope == SettingsScope::Project {
                    BEFORE_PROJECT_WRITE.with(|hook| {
                        if let Some(callback) = hook.borrow_mut().take() {
                            callback();
                        }
                    });
                }
                #[cfg(any(unix, windows))]
                if scope == SettingsScope::Project {
                    let parent = project_parent
                        .as_ref()
                        .ok_or_else(|| anyhow!("Project settings directory is missing"))?;
                    let name = locked_path
                        .file_name()
                        .ok_or_else(|| anyhow!("Project settings path has no file name"))?;
                    // Unix reads need only search permission. Reopen for fsync
                    // before writing so missing read permission fails before
                    // replacing the document.
                    #[cfg(unix)]
                    let readable_parent = open_readable_directory_at(parent)?;
                    #[cfg(test)]
                    OPT_IN_FSYNC.with(|count| count.set(count.get() + 1));
                    #[cfg(unix)]
                    platform_fs::atomic_write_private_at(&readable_parent, name, &content)?;
                    #[cfg(windows)]
                    platform_fs::atomic_write_private_at(parent, name, &content)?;
                } else {
                    atomic_write_with(&locked_path, &content, AtomicWriteOptions { fsync: true })?;
                }
                #[cfg(not(any(unix, windows)))]
                atomic_write_with(&locked_path, &content, AtomicWriteOptions { fsync: true })?;
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
    #[cfg(any(unix, windows))]
    static BEFORE_PROJECT_WRITE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    #[cfg(windows)]
    static BEFORE_PROJECT_LOCK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    #[cfg(any(unix, windows))]
    static PROJECT_READ_STEP: std::cell::RefCell<Option<ProjectReadHook>> = const { std::cell::RefCell::new(None) };
    #[cfg(windows)]
    static PROJECT_ANCHOR_STEP: std::cell::RefCell<Option<ProjectAnchorHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, any(unix, windows)))]
type ProjectReadHook = Box<dyn FnMut(ProjectReadStep)>;

#[cfg(all(test, any(unix, windows)))]
#[derive(Clone, Copy)]
enum ProjectReadStep {
    Open,
    Restore,
    Repoint,
}

#[cfg(all(test, any(unix, windows)))]
fn project_read_step(step: ProjectReadStep) {
    PROJECT_READ_STEP.with(|hook| {
        if let Some(callback) = hook.borrow_mut().as_mut() {
            callback(step);
        }
    });
}

#[cfg(all(test, windows))]
type ProjectAnchorHook = Box<dyn FnMut(ProjectAnchorStep)>;

#[cfg(all(test, windows))]
#[derive(Clone, Copy)]
enum ProjectAnchorStep {
    Open,
    Check,
}

#[cfg(all(test, windows))]
fn project_anchor_step(step: ProjectAnchorStep) {
    PROJECT_ANCHOR_STEP.with(|hook| {
        if let Some(callback) = hook.borrow_mut().as_mut() {
            callback(step);
        }
    });
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
    if options.fsync {
        crate::platform::fs::sync_directory(path.parent().unwrap_or_else(|| Path::new(".")))?;
    }
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
    fn missing_project_root_has_no_project_settings() {
        let root = tempfile::tempdir().unwrap();
        let missing_project = root.path().join("deleted-project");
        let storage = FileSettingsStorage::new(&missing_project, root.path().join("agent"));

        assert_eq!(storage.read(SettingsScope::Project).unwrap(), None);
        storage
            .with_lock(SettingsScope::Project, &mut |_| Some("{}".into()))
            .unwrap();
        assert_eq!(
            fs::read_to_string(missing_project.join(".prime/agent/settings.json")).unwrap(),
            "{}"
        );
    }

    #[test]
    fn missing_single_component_relative_path_resolves_through_dot() {
        let project = PathBuf::from(format!("missing-project-{}", uuid::Uuid::new_v4().simple()));
        let resolved = FileSettingsStorage::resolve_with_missing(&project).unwrap();

        assert!(resolved.is_absolute());
        assert_eq!(resolved.file_name(), project.file_name());
    }

    #[test]
    #[cfg(unix)]
    fn dangling_in_project_settings_link_reads_absent_and_updates_shared_target() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        fs::create_dir_all(&settings_dir).unwrap();
        let settings = settings_dir.join("settings.json");
        let target = project.join("shared/settings.json");
        symlink("../../shared/settings.json", &settings).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        assert_eq!(storage.read(SettingsScope::Project).unwrap(), None);
        storage
            .with_lock(SettingsScope::Project, &mut |current| {
                assert_eq!(current, None);
                Some(r#"{"theme":"prime"}"#.to_string())
            })
            .unwrap();
        assert!(fs::symlink_metadata(&settings)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(target).unwrap(), r#"{"theme":"prime"}"#);

        // A missing target outside the project stays forbidden.
        fs::remove_file(&settings).unwrap();
        let outside = root.path().join("outside/settings.json");
        symlink(&outside, &settings).unwrap();
        assert!(storage.read(SettingsScope::Project).is_err());
        assert!(storage
            .with_lock(SettingsScope::Project, &mut |_| {
                Some(r#"{"theme":"unsafe"}"#.to_string())
            })
            .is_err());
        assert!(!outside.exists());
    }

    #[test]
    #[cfg(unix)]
    fn searchable_project_root_allows_settings_write() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        fs::create_dir_all(&settings_dir).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        fs::set_permissions(&project, fs::Permissions::from_mode(0o111)).unwrap();

        let result = storage.with_lock(SettingsScope::Project, &mut |_| Some("{}".into()));
        fs::set_permissions(&project, fs::Permissions::from_mode(0o700)).unwrap();

        result.unwrap();
        assert_eq!(
            fs::read_to_string(settings_dir.join("settings.json")).unwrap(),
            "{}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn searchable_settings_directory_allows_read_before_a_failed_write() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        fs::create_dir_all(&settings_dir).unwrap();
        let settings = settings_dir.join("settings.json");
        fs::write(&settings, "original").unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        // Search and create are allowed, but opening this directory for fsync
        // must fail before a write can replace the existing document.
        fs::set_permissions(&settings_dir, fs::Permissions::from_mode(0o311)).unwrap();

        let read = storage.read(SettingsScope::Project);
        let mut update_called = false;
        let write = storage.with_lock(SettingsScope::Project, &mut |current| {
            update_called = true;
            assert_eq!(current.as_deref(), Some("original"));
            Some("replacement".into())
        });
        fs::set_permissions(&settings_dir, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(read.unwrap(), Some("original".into()));
        assert!(update_called);
        assert!(write.is_err());
        assert_eq!(fs::read_to_string(settings).unwrap(), "original");
    }

    #[test]
    #[cfg(unix)]
    fn missing_parent_creation_stays_under_the_validated_project_root() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let external = root.path().join("external");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&external).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        let result = storage.with_lock(SettingsScope::Project, &mut |current| {
            assert_eq!(current, None);
            fs::rename(&project, &moved).unwrap();
            symlink(&external, &project).unwrap();
            Some("{}".into())
        });

        assert!(result.is_err());
        assert!(!external.join(".prime").exists());
    }

    #[test]
    #[cfg(unix)]
    fn project_settings_read_stays_on_the_validated_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        let moved = project.join(".prime/agent-moved");
        let external = root.path().join("external");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(settings_dir.join("settings.json"), "project settings").unwrap();
        fs::write(external.join("settings.json"), "outside secret").unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        let target = settings_dir.clone();
        let moved_for_swap = moved.clone();
        let outside = external.clone();
        PROJECT_READ_STEP.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |step| match step {
                ProjectReadStep::Open | ProjectReadStep::Repoint => {
                    fs::rename(&target, &moved_for_swap).unwrap();
                    symlink(&outside, &target).unwrap();
                }
                ProjectReadStep::Restore => {
                    fs::remove_file(&target).unwrap();
                    fs::rename(&moved_for_swap, &target).unwrap();
                }
            }));
        });
        let result = storage.read(SettingsScope::Project);
        PROJECT_READ_STEP.with(|hook| *hook.borrow_mut() = None);
        if fs::symlink_metadata(&settings_dir)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            fs::remove_file(&settings_dir).unwrap();
            fs::rename(&moved, &settings_dir).unwrap();
        }

        assert_eq!(result.unwrap().as_deref(), Some("project settings"));
        assert_eq!(
            fs::read_to_string(settings_dir.join("settings.json")).unwrap(),
            "project settings"
        );
        assert_eq!(
            fs::read_to_string(external.join("settings.json")).unwrap(),
            "outside secret"
        );
    }

    #[test]
    #[cfg(unix)]
    fn project_settings_write_is_bound_to_the_validated_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        let moved = project.join(".prime/agent-moved");
        let settings = settings_dir.join("settings.json");
        let external = root.path().join("external");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(&settings, r#"{"theme":"old"}"#).unwrap();
        fs::write(external.join("settings.json"), "outside untouched").unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        BEFORE_PROJECT_WRITE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&settings_dir, &moved).unwrap();
                symlink(&external, &settings_dir).unwrap();
            }));
        });
        storage
            .with_lock(SettingsScope::Project, &mut |current| {
                assert_eq!(current.as_deref(), Some(r#"{"theme":"old"}"#));
                Some(r#"{"theme":"new"}"#.to_string())
            })
            .unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("external/settings.json")).unwrap(),
            "outside untouched"
        );
        assert_eq!(
            fs::read_to_string(project.join(".prime/agent-moved/settings.json")).unwrap(),
            r#"{"theme":"new"}"#
        );
    }

    #[test]
    #[cfg(unix)]
    fn project_settings_write_is_bound_across_a_regular_directory_swap() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        let moved = project.join(".prime/agent-moved");
        let external = root.path().join("external");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(settings_dir.join("settings.json"), r#"{"theme":"old"}"#).unwrap();
        fs::write(external.join("settings.json"), "outside untouched").unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        let external_for_swap = external.clone();

        BEFORE_PROJECT_WRITE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&settings_dir, &moved).unwrap();
                fs::rename(&external_for_swap, &settings_dir).unwrap();
            }));
        });
        storage
            .with_lock(SettingsScope::Project, &mut |current| {
                assert_eq!(current.as_deref(), Some(r#"{"theme":"old"}"#));
                Some(r#"{"theme":"new"}"#.to_string())
            })
            .unwrap();

        fs::rename(project.join(".prime/agent"), &external).unwrap();
        assert_eq!(
            fs::read_to_string(external.join("settings.json")).unwrap(),
            "outside untouched"
        );
        assert_eq!(
            fs::read_to_string(project.join(".prime/agent-moved/settings.json")).unwrap(),
            r#"{"theme":"new"}"#
        );
    }

    #[test]
    #[cfg(windows)]
    fn project_settings_rejects_a_parent_swap_before_locking() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        let moved = project.join(".prime/agent-moved");
        let external = root.path().join("external");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(settings_dir.join("settings.json"), "project old").unwrap();
        fs::write(external.join("settings.json"), "outside old").unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        let settings_for_hook = settings_dir.clone();
        let moved_for_hook = moved.clone();
        let external_for_hook = external.clone();
        BEFORE_PROJECT_LOCK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&settings_for_hook, &moved_for_hook).unwrap();
                fs::rename(&external_for_hook, &settings_for_hook).unwrap();
            }));
        });

        let result = storage.with_lock(SettingsScope::Project, &mut |_| Some("new".into()));
        BEFORE_PROJECT_LOCK.with(|hook| *hook.borrow_mut() = None);
        fs::rename(&settings_dir, &external).unwrap();
        fs::rename(&moved, &settings_dir).unwrap();

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(settings_dir.join("settings.json")).unwrap(),
            "project old"
        );
        assert_eq!(
            fs::read_to_string(external.join("settings.json")).unwrap(),
            "outside old"
        );
    }

    #[test]
    #[cfg(windows)]
    fn project_settings_write_is_bound_across_a_windows_directory_swap() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        let moved = project.join(".prime/agent-moved");
        let external = root.path().join("external");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(settings_dir.join("settings.json"), "project old").unwrap();
        fs::write(external.join("settings.json"), "outside untouched").unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        let external_for_swap = external.clone();
        let moved_for_swap = moved.clone();

        BEFORE_PROJECT_WRITE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&settings_dir, &moved_for_swap).unwrap();
                fs::rename(&external_for_swap, &settings_dir).unwrap();
            }));
        });
        let result = storage.with_lock(SettingsScope::Project, &mut |current| {
            assert_eq!(current.as_deref(), Some("project old"));
            Some("project new".to_string())
        });
        BEFORE_PROJECT_WRITE.with(|hook| *hook.borrow_mut() = None);
        result.unwrap();

        fs::rename(project.join(".prime/agent"), &external).unwrap();
        assert_eq!(
            fs::read_to_string(external.join("settings.json")).unwrap(),
            "outside untouched"
        );
        assert_eq!(
            fs::read_to_string(moved.join("settings.json")).unwrap(),
            "project new"
        );
    }

    #[test]
    #[cfg(windows)]
    fn project_settings_read_ignores_a_swapped_link_with_matching_metadata() {
        use std::os::windows::fs::symlink_file;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings = project.join(".prime/agent/settings.json");
        let shared = project.join("shared/settings.json");
        let outside = root.path().join("outside.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::create_dir_all(shared.parent().unwrap()).unwrap();
        fs::write(&shared, "inside secret").unwrap();
        fs::write(&outside, "outside data!").unwrap();
        let modified = fs::metadata(&shared).unwrap().modified().unwrap();
        fs::File::options()
            .write(true)
            .open(&outside)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            fs::metadata(&shared).unwrap().len(),
            fs::metadata(&outside).unwrap().len()
        );
        symlink_file(&shared, &settings).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        let settings_for_swap = settings.clone();
        let shared_for_swap = shared.clone();

        PROJECT_READ_STEP.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |step| match step {
                ProjectReadStep::Open => {
                    fs::remove_file(&settings_for_swap).unwrap();
                    symlink_file(&outside, &settings_for_swap).unwrap();
                }
                ProjectReadStep::Restore => {
                    fs::remove_file(&settings_for_swap).unwrap();
                    symlink_file(&shared_for_swap, &settings_for_swap).unwrap();
                }
                ProjectReadStep::Repoint => {}
            }));
        });
        let read = storage.read(SettingsScope::Project);
        PROJECT_READ_STEP.with(|hook| *hook.borrow_mut() = None);

        assert_eq!(read.unwrap().as_deref(), Some("inside secret"));
        assert_eq!(fs::read_to_string(&shared).unwrap(), "inside secret");
        assert!(fs::symlink_metadata(&settings)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    #[cfg(windows)]
    fn project_settings_rejects_a_swapped_root_during_anchor_open() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let external = root.path().join("external");
        fs::create_dir_all(project.join(".prime/agent")).unwrap();
        fs::create_dir_all(external.join(".prime/agent")).unwrap();
        fs::write(project.join(".prime/agent/settings.json"), "project old").unwrap();
        fs::write(
            external.join(".prime/agent/settings.json"),
            "outside untouched",
        )
        .unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        let project_for_swap = project.clone();
        let moved_for_swap = moved;
        let external_for_swap = external.clone();

        PROJECT_ANCHOR_STEP.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |step| match step {
                ProjectAnchorStep::Open => {
                    fs::rename(&project_for_swap, &moved_for_swap).unwrap();
                    fs::rename(&external_for_swap, &project_for_swap).unwrap();
                }
                ProjectAnchorStep::Check => {
                    fs::rename(&project_for_swap, &external_for_swap).unwrap();
                    fs::rename(&moved_for_swap, &project_for_swap).unwrap();
                }
            }));
        });
        let result = storage.with_lock(SettingsScope::Project, &mut |_| Some("project new".into()));
        PROJECT_ANCHOR_STEP.with(|hook| *hook.borrow_mut() = None);

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(external.join(".prime/agent/settings.json")).unwrap(),
            "outside untouched"
        );
        assert_eq!(
            fs::read_to_string(project.join(".prime/agent/settings.json")).unwrap(),
            "project old"
        );
    }

    #[test]
    #[cfg(windows)]
    fn missing_windows_project_parent_cannot_create_outside_the_root() {
        use std::os::windows::fs::symlink_dir;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let external = root.path().join("external");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&external).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        let result = storage.with_lock(SettingsScope::Project, &mut |current| {
            assert_eq!(current, None);
            fs::rename(&project, &moved).unwrap();
            symlink_dir(&external, &project).unwrap();
            Some("{}".into())
        });

        assert!(result.is_err());
        assert!(!external.join(".prime").exists());
    }

    #[test]
    #[cfg(windows)]
    fn linked_windows_project_root_and_settings_keep_their_targets() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let linked_root = root.path().join("linked-project");
        let settings = project.join(".prime/agent/settings.json");
        let shared = project.join("shared/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::create_dir_all(shared.parent().unwrap()).unwrap();
        fs::write(&shared, "project old").unwrap();
        symlink_file(&shared, &settings).unwrap();
        symlink_dir(&project, &linked_root).unwrap();
        let storage = FileSettingsStorage::new(&linked_root, root.path().join("agent"));

        let before = opt_in_fsync_calls();
        storage
            .with_lock(SettingsScope::Project, &mut |current| {
                assert_eq!(current.as_deref(), Some("project old"));
                Some("project new".into())
            })
            .unwrap();

        assert_eq!(fs::read_to_string(&shared).unwrap(), "project new");
        assert_eq!(
            storage.read(SettingsScope::Project).unwrap().as_deref(),
            Some("project new")
        );
        assert!(fs::symlink_metadata(&settings)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(&linked_root)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(opt_in_fsync_calls(), before + 1);
    }

    #[test]
    #[cfg(unix)]
    fn linked_project_root_and_shared_settings_keep_their_links() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let linked_root = root.path().join("linked-project");
        let settings_dir = project.join(".prime/agent");
        let settings = settings_dir.join("settings.json");
        let shared = project.join("shared/settings.json");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::create_dir_all(shared.parent().unwrap()).unwrap();
        fs::write(&shared, r#"{"theme":"old"}"#).unwrap();
        symlink("../../shared/settings.json", &settings).unwrap();
        symlink(&project, &linked_root).unwrap();
        let storage = FileSettingsStorage::new(&linked_root, root.path().join("agent"));

        let before = opt_in_fsync_calls();
        storage
            .with_lock(SettingsScope::Project, &mut |current| {
                assert_eq!(current.as_deref(), Some(r#"{"theme":"old"}"#));
                Some(r#"{"theme":"new"}"#.to_string())
            })
            .unwrap();

        assert_eq!(fs::read_to_string(shared).unwrap(), r#"{"theme":"new"}"#);
        assert!(fs::symlink_metadata(settings)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(linked_root)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(opt_in_fsync_calls(), before + 1);
    }

    #[test]
    #[cfg(unix)]
    fn in_project_hard_linked_settings_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings_dir = project.join(".prime/agent");
        let shared = project.join("shared-settings.json");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(&shared, "original").unwrap();
        fs::hard_link(&shared, settings_dir.join("settings.json")).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        assert!(storage.read(SettingsScope::Project).is_err());
        assert!(storage
            .with_lock(SettingsScope::Project, &mut |_| Some("replacement".into()))
            .is_err());
        assert_eq!(fs::read_to_string(&shared).unwrap(), "original");
    }

    #[test]
    #[cfg(windows)]
    fn project_settings_rejects_a_new_hard_link_after_cached_read() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings = project.join(".prime/agent/settings.json");
        let external = root.path().join("auth.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "{}").unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        assert_eq!(
            storage.read(SettingsScope::Project).unwrap().as_deref(),
            Some("{}")
        );
        fs::hard_link(&settings, &external).unwrap();

        assert!(storage.read(SettingsScope::Project).is_err());
        assert!(storage
            .with_lock(SettingsScope::Project, &mut |_| Some("replacement".into()))
            .is_err());
        assert_eq!(fs::read_to_string(external).unwrap(), "{}");
    }

    #[test]
    #[cfg(unix)]
    fn project_settings_rejects_an_external_directory_link() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let external = root.path().join("external");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(external.join("agent")).unwrap();
        fs::write(external.join("agent/settings.json"), r#"{"theme":"prime"}"#).unwrap();
        symlink(&external, project.join(".prime")).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));

        assert!(storage.read(SettingsScope::Project).is_err());
        assert!(storage
            .with_lock(SettingsScope::Project, &mut |_| Some("{}".into()))
            .is_err());
        assert_eq!(
            fs::read_to_string(external.join("agent/settings.json")).unwrap(),
            r#"{"theme":"prime"}"#
        );
    }

    #[test]
    #[cfg(unix)]
    fn linked_project_settings_use_the_target_lock() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let settings = project.join(".prime/agent/settings.json");
        let shared = project.join(".prime/shared.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&shared, r#"{"theme":"prime"}"#).unwrap();
        symlink("../shared.json", &settings).unwrap();
        let storage = FileSettingsStorage::new(&project, root.path().join("agent"));
        let _target_guard = LockGuard::acquire(&shared, STALE_AFTER).unwrap();

        assert!(storage.read(SettingsScope::Project).is_err());
        assert!(storage
            .with_lock(SettingsScope::Project, &mut |_| Some(
                r#"{"theme":"dark"}"#.into()
            ))
            .is_err());
        assert_eq!(fs::read_to_string(&shared).unwrap(), r#"{"theme":"prime"}"#);
    }

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
    fn settings_write_takes_exactly_one_fsync() {
        let dir = tempfile::tempdir().unwrap();
        let storage = FileSettingsStorage::new(dir.path().join("cwd"), dir.path().join("agent"));
        let document = "{ \"defaultProvider\": \"prime-inference\" }";
        let before = opt_in_fsync_calls();
        storage
            .with_lock(SettingsScope::Global, &mut |_| Some(document.to_string()))
            .unwrap();
        assert_eq!(
            opt_in_fsync_calls(),
            before + 1,
            "the settings write must flush the temp file before the rename"
        );
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

//! Auth storage backends: locked JSON file (0o600, atomic writes) and
//! in-memory (tests, embedded hosts). Port of the auth-storage backends.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;

use super::types::AuthStorageData;

/// Locked read/modify/write over the auth document. `update` returns
/// `(result, next)`; `next: Some` writes it back atomically.
pub trait AuthStorageBackend: Send + Sync {
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
            last_error
                .map(|e| e.to_string())
                .unwrap_or_else(|| "busy".into())
        ))
    }
}

impl AuthStorageBackend for FileAuthStorageBackend {
    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> Result<((), Option<String>)>,
    ) -> Result<()> {
        self.ensure_parent_dir()?;
        self.ensure_file_exists()?;
        let guard = self.acquire_lock()?;
        let current = fs::read_to_string(&self.auth_path).ok();
        let (_, next) = update(current)?;
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
        let (_, next) = update(guard.clone())?;
        if let Some(next) = next {
            *guard = Some(next);
        }
        Ok(())
    }
}

/// Parse an auth document; invalid JSON or a non-object root is a load error
/// (the TS throws too).
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

    #[test]
    fn parse_rejects_non_object() {
        assert!(parse_storage_data(Some("[1,2]")).is_err());
        assert_eq!(
            parse_storage_data(None).unwrap().keys(),
            Vec::<String>::new()
        );
    }
}

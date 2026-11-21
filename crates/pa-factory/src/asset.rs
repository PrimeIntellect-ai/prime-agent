//! Machine assets: files in the `assets/` tree of a machine directory.
//!
//! A state reads an asset as a text input, the same way it reads a port:
//! `inputs = { rubric = "assets/rubric.md" }`. [`resolve`] keeps each path
//! that a machine names inside its directory. The loader uses it for
//! prompts, rubrics, and nodes too. An [`AssetCache`] reads each asset on
//! its first use and keeps the text for the rest of the run.

use std::collections::btree_map::Entry;
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};

/// The prefix of an asset reference.
const ASSETS_PREFIX: &str = "assets/";

/// An `assets/<relative path>` reference. [`resolve`] checks that it
/// stays inside the machine directory.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct AssetPath(String);

impl AssetPath {
    /// The asset that `reference` names, or `None` when the reference
    /// does not start with `assets/`. A state id cannot contain `/`, so an
    /// asset reference is never a `<state>.<port>` reference.
    #[must_use]
    pub fn parse(reference: &str) -> Option<Self> {
        reference
            .starts_with(ASSETS_PREFIX)
            .then(|| Self(reference.to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AssetPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A path that does not give a readable file inside the machine directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetError {
    /// The path is absolute or has a `.` or `..` part.
    Outside {
        path: String,
        dir: PathBuf,
    },
    /// The path goes through a symlink to `target`, outside `dir`.
    Escapes {
        path: String,
        target: PathBuf,
        dir: PathBuf,
    },
    Missing {
        path: String,
        dir: PathBuf,
    },
    /// The path is not a file, is not UTF-8, or the read failed.
    Unreadable {
        path: String,
        reason: String,
    },
}

impl fmt::Display for AssetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Outside { path, dir } => write!(
                f,
                "{path:?} must be a relative path inside the machine directory {}",
                dir.display()
            ),
            Self::Escapes { path, target, dir } => write!(
                f,
                "{path:?} escapes the machine directory {}: it resolves to {}",
                dir.display(),
                target.display()
            ),
            Self::Missing { path, dir } => write!(
                f,
                "{path:?} does not exist in the machine directory {}",
                dir.display()
            ),
            Self::Unreadable { path, reason } => write!(f, "cannot read {path}: {reason}"),
        }
    }
}

impl std::error::Error for AssetError {}

/// The real path of `relative` inside `dir`.
///
/// The path must be relative with only normal parts, and its real path
/// (after each symlink) must stay under the real path of `dir`.
///
/// # Errors
///
/// [`AssetError::Outside`] for an absolute path or a `.` or `..` part,
/// [`AssetError::Missing`] when nothing is at the path, and
/// [`AssetError::Escapes`] when a symlink leaves the directory.
pub(crate) fn resolve(dir: &Path, relative: &str) -> Result<PathBuf, AssetError> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AssetError::Outside {
            path: relative.to_string(),
            dir: dir.to_path_buf(),
        });
    }
    let real = |path: &Path| {
        path.canonicalize().map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => AssetError::Missing {
                path: relative.to_string(),
                dir: dir.to_path_buf(),
            },
            _ => AssetError::Unreadable {
                path: relative.to_string(),
                reason: error.to_string(),
            },
        })
    };
    let dir_real = real(dir)?;
    let target = real(&dir.join(path))?;
    if target.starts_with(&dir_real) {
        Ok(target)
    } else {
        Err(AssetError::Escapes {
            path: relative.to_string(),
            target,
            dir: dir.to_path_buf(),
        })
    }
}

/// Check that `asset` is a file inside `dir`. Reads nothing.
pub(crate) fn check(dir: &Path, asset: &AssetPath) -> Result<PathBuf, AssetError> {
    let target = resolve(dir, asset.as_str())?;
    if target.is_file() {
        Ok(target)
    } else {
        Err(AssetError::Unreadable {
            path: asset.to_string(),
            reason: "not a file".to_string(),
        })
    }
}

/// The assets of one run. Each asset is read on its first use, and later
/// uses get the same text, also when the file changes during the run.
#[derive(Debug)]
pub struct AssetCache {
    dir: PathBuf,
    loaded: BTreeMap<AssetPath, String>,
}

impl AssetCache {
    /// An empty cache for the machine directory `dir`.
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            loaded: BTreeMap::new(),
        }
    }

    /// Check that `asset` is a file inside the machine directory. This
    /// does not read the file.
    ///
    /// # Errors
    ///
    /// Returns the [`AssetError`] of the path.
    pub fn check(&self, asset: &AssetPath) -> Result<(), AssetError> {
        check(&self.dir, asset).map(drop)
    }

    /// The text of `asset`: read from the machine directory on its first
    /// use, then from the cache.
    ///
    /// # Errors
    ///
    /// Returns the [`AssetError`] of the path, or
    /// [`AssetError::Unreadable`] when the read fails.
    pub fn load(&mut self, asset: &AssetPath) -> Result<&str, AssetError> {
        match self.loaded.entry(asset.clone()) {
            Entry::Occupied(entry) => Ok(entry.into_mut()),
            Entry::Vacant(entry) => {
                let target = check(&self.dir, asset)?;
                let text =
                    std::fs::read_to_string(target).map_err(|error| AssetError::Unreadable {
                        path: asset.to_string(),
                        reason: error.to_string(),
                    })?;
                Ok(entry.insert(text))
            }
        }
    }
}

#[cfg(test)]
mod tests;

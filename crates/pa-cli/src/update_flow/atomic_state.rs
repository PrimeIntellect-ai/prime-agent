//! Private same-directory staging for updater state records.

use std::io::Write as _;
use std::path::Path;

use anyhow::{Context, Result};

/// Replace a state record after its complete bytes have been made durable.
/// A random, exclusive temporary file prevents another local process from
/// planting the predictable staging path before the write.
pub(super) fn replace(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("stage {}", path.display()))?;
    pa_core::platform::perms::restrict_open_file(staged.as_file())
        .with_context(|| format!("restrict staging file for {}", path.display()))?;
    staged.write_all(contents)?;
    staged.as_file().sync_all()?;
    staged
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("finalize {}", path.display()))?;
    Ok(())
}

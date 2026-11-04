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
    // Clear Windows' temporary-file attribute before the platform rename;
    // the rename helper retries destination-busy failures there.
    let temporary = staged
        .into_temp_path()
        .keep()
        .map_err(|error| error.error)
        .with_context(|| format!("prepare staging file for {}", path.display()))?;
    let renamed = pa_core::platform::rename_onto(&temporary, path);
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    renamed.with_context(|| format!("finalize {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_finalization_leaves_no_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("status.json");
        std::fs::create_dir(&destination).unwrap();

        replace(&destination, b"new status\n").expect_err("cannot replace a directory");
        let entries = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec![destination]);
    }
}

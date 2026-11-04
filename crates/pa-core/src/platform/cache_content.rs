//! Bounded, exact-content checks for process-local document caches.

use std::io::Read;
use std::path::Path;

#[cfg(not(unix))]
use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;

/// Reuse a cached document only when the current regular file has its exact bytes.
/// Read one byte beyond the cached length so growth cannot appear identical.
pub(crate) fn matches(path: &Path, cached: &[u8]) -> bool {
    #[cfg(unix)]
    let opened = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(libc::O_NONBLOCK);
        options.open(path)
    };
    #[cfg(not(unix))]
    let opened = File::open(path);

    let Ok(file) = opened else {
        return false;
    };
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return false;
    }
    let Some(limit) = u64::try_from(cached.len())
        .ok()
        .and_then(|length| length.checked_add(1))
    else {
        return false;
    };
    let mut reader = file.take(limit);
    let mut offset = 0;
    let mut chunk = [0_u8; 8192];
    loop {
        let Ok(count) = reader.read(&mut chunk) else {
            return false;
        };
        if count == 0 {
            return offset == cached.len();
        }
        if cached.get(offset..offset.saturating_add(count)) != Some(&chunk[..count]) {
            return false;
        }
        offset += count;
    }
}

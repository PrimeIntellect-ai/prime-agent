//! File permission policy.
//!
//! Unix: owner-only mode bits (0o600 files, 0o700 dirs). Windows: NTFS ACLs
//! govern access - new files inherit ACLs from their parent directory, so the
//! restriction helpers are documented no-ops there; an explicit ACL lane is
//! tracked in docs/windows-readiness.md.

use std::fs::OpenOptions;
use std::path::Path;

/// Owner-only file mode (Unix).
pub const PRIVATE_FILE_MODE: u32 = 0o600;
/// Owner-only directory mode (Unix).
pub const PRIVATE_DIR_MODE: u32 = 0o700;

/// Make a file owner-readable/writable only (`chmod 0o600`). Best-effort:
/// callers decide whether a failure is fatal.
#[cfg(unix)]
pub fn restrict_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))
}

#[cfg(not(unix))]
pub fn restrict_file(_path: &Path) -> std::io::Result<()> {
    // Windows: inherited ACLs apply; see the ACL note above.
    Ok(())
}

/// Make a directory owner-accessible only (`chmod 0o700`).
#[cfg(unix)]
pub fn restrict_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
}

#[cfg(not(unix))]
pub fn restrict_dir(_path: &Path) -> std::io::Result<()> {
    // Windows: inherited ACLs apply; see the ACL note above.
    Ok(())
}

/// Set the private mode on files created through these options.
#[cfg(unix)]
pub fn set_private_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(PRIVATE_FILE_MODE);
}

#[cfg(not(unix))]
pub fn set_private_mode(_options: &mut OpenOptions) {
    // Windows: inherited ACLs apply; see the ACL note above.
}

/// The file's mode bits (`mode & 0o777`); None where mode bits do not exist.
#[cfg(unix)]
pub fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .ok()
        .map(|m| m.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
pub fn file_mode(_path: &Path) -> Option<u32> {
    None
}

/// True when the path is an executable file (any execute bit on Unix).
#[cfg(unix)]
pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
pub fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// True when the current process may read and write the file (access(2)
/// semantics: real/effective uid checks, not just the file mode).
#[cfg(unix)]
pub fn is_readable_writable(path: &Path) -> bool {
    nix::unistd::access(
        path,
        nix::unistd::AccessFlags::R_OK | nix::unistd::AccessFlags::W_OK,
    )
    .is_ok()
}

#[cfg(not(unix))]
pub fn is_readable_writable(path: &Path) -> bool {
    // Windows: a create-open probe is the equivalent permission test.
    OpenOptions::new().read(true).write(true).open(path).is_ok()
}

/// True when the current user may read the file, mirroring Node
/// `fs.access(path, R_OK)` error-code semantics used by the edit preview.
#[cfg(unix)]
pub fn is_readable(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = std::fs::metadata(path)?;
    // Root on Linux can read files regardless of permission bits; mirror
    // access(2)'s effective-uid check via the permission bits plus euid.
    let mode = metadata.permissions().mode();
    let readable = (mode & 0o004) != 0
        || ((mode & 0o040) != 0 && metadata.uid() == nix::unistd::Uid::effective().as_raw())
        || ((mode & 0o400) != 0 && metadata.uid() == nix::unistd::Uid::effective().as_raw());
    if readable {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(13))
    }
}

#[cfg(not(unix))]
pub fn is_readable(path: &Path) -> Result<(), std::io::Error> {
    // Windows: a read open probe is the equivalent permission test.
    std::fs::File::open(path).map(|_| ())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// The probes a Windows runner must verify: the restriction helpers
    /// are no-ops (inherited ACLs) that never break access, and the
    /// readability checks are open probes.
    #[test]
    fn restriction_is_a_no_op_and_probes_match_open_semantics() {
        let dir = std::env::temp_dir().join(format!("pa-perms-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("probe.txt");
        std::fs::write(&file, "x").expect("write");
        assert!(restrict_file(&file).is_ok());
        assert!(restrict_dir(&dir).is_ok());
        assert!(is_readable_writable(&file));
        assert!(is_readable(&file).is_ok());
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }
}

//! File permission policy. Unix: owner-only mode bits (0o600 files, 0o700
//! dirs). Windows: NTFS ACLs govern access - new files inherit ACLs from
//! their parent directory, so the restriction helpers are no-ops there.

use std::fs::OpenOptions;
use std::path::Path;

/// Owner-only file mode (Unix).
pub const PRIVATE_FILE_MODE: u32 = 0o600;
/// Owner-only directory mode (Unix).
pub const PRIVATE_DIR_MODE: u32 = 0o700;

/// Make a file owner-readable/writable only (`chmod 0o600`). Best-effort:
/// callers decide whether a failure is fatal.
///
/// # Errors
///
/// Returns the underlying I/O error when the permission change fails.
#[cfg(unix)]
pub fn restrict_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))
}

/// Windows arm of [`restrict_file`]: inherited ACLs carry the access
/// decision, so the restriction is a no-op.
///
/// # Errors
///
/// Does not error.
#[cfg(not(unix))]
pub fn restrict_file(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Make a directory owner-accessible only (`chmod 0o700`).
///
/// # Errors
///
/// Returns the underlying I/O error when the permission change fails.
#[cfg(unix)]
pub fn restrict_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
}

/// Windows arm of [`restrict_dir`]: inherited ACLs carry the access
/// decision, so the restriction is a no-op.
///
/// # Errors
///
/// Does not error.
#[cfg(not(unix))]
pub fn restrict_dir(_path: &Path) -> std::io::Result<()> {
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
#[must_use]
pub fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .ok()
        .map(|m| m.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
#[must_use]
pub fn file_mode(_path: &Path) -> Option<u32> {
    None
}

/// True when the path is an executable file (any execute bit on Unix).
#[cfg(unix)]
#[must_use]
pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
#[must_use]
pub fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Set the private mode on an already-open file (`fchmod`): exact bits despite
/// the umask; tightens a pre-existing loose file.
///
/// # Errors
///
/// The underlying I/O error when the permission bits cannot be set.
#[cfg(unix)]
pub fn restrict_open_file(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))
}

/// Windows arm of [`restrict_open_file`]: inherited ACLs carry the
/// access decision, so the restriction is a no-op.
///
/// # Errors
///
/// Does not error.
#[cfg(not(unix))]
pub fn restrict_open_file(_file: &std::fs::File) -> std::io::Result<()> {
    Ok(())
}

/// Create directories recursively with the private dir mode on platforms with
/// mode bits; existing directories are left untouched (mkdir semantics).
///
/// # Errors
///
/// Returns the underlying I/O error when a directory cannot be created.
#[cfg(unix)]
pub fn create_dir_all_private(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .mode(PRIVATE_DIR_MODE)
        .recursive(true)
        .create(path)
}

/// Windows arm of [`create_dir_all_private`]: inherited ACLs carry the
/// access decision, so the directories are plain recursive creates.
///
/// # Errors
///
/// Returns the underlying I/O error when a directory cannot be created.
#[cfg(not(unix))]
pub fn create_dir_all_private(path: &Path) -> std::io::Result<()> {
    // Windows: inherited ACLs apply; see the ACL note above.
    std::fs::create_dir_all(path)
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn restriction_is_a_no_op() {
        let dir = std::env::temp_dir().join(format!("pa-perms-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("probe.txt");
        std::fs::write(&file, "x").expect("write");
        assert!(restrict_file(&file).is_ok());
        assert!(restrict_dir(&dir).is_ok());
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }
}

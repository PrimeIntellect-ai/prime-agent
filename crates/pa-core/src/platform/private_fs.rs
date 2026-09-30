//! Handle-pinned private file operations (unix): every leaf operation
//! resolves relative to a VERIFIED OPEN DIRECTORY HANDLE with
//! `O_NOFOLLOW` — pathname resolution never re-traverses the ancestor
//! chain, so an attacker-writable ancestor cannot redirect an operation
//! after its checks passed. Files created through these primitives are
//! owner-only (`0o600`) from their first write.
//!
//! Off unix there are no mode bits or uid-style probes for this
//! discipline, so every primitive answers `Unsupported` — callers fail
//! closed upstream (the private-parent validator).

use std::fs::File;
use std::io;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd};

/// Open a directory for pinned-relative operations, refusing a symlink
/// (`O_NOFOLLOW` + `O_DIRECTORY`): the ONE pathname resolution this
/// discipline keeps, run once and then verified against the path by the
/// caller before anything is written.
///
/// # Errors
///
/// Returns the open error (a symlinked path answers `ELOOP`, a
/// non-directory `ENOTDIR`).
#[cfg(unix)]
pub fn open_dir_no_follow(path: &Path) -> io::Result<File> {
    let oflag = nix::fcntl::OFlag::O_RDONLY
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC;
    let fd = nix::fcntl::open(path, oflag, nix::sys::stat::Mode::empty())?;
    // SAFETY: nix returned a newly-owned raw descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Open `leaf` inside the pinned directory for appending, creating it
/// owner-only when missing and refusing a symlink (`O_NOFOLLOW`): the
/// resolution is relative to the pinned inode, never the path.
///
/// # Errors
///
/// Returns the open error (a symlinked leaf answers `ELOOP`).
#[cfg(unix)]
pub fn open_append_at(parent: &File, leaf: &str) -> io::Result<File> {
    open_at(
        parent,
        leaf,
        nix::fcntl::OFlag::O_WRONLY
            | nix::fcntl::OFlag::O_APPEND
            | nix::fcntl::OFlag::O_CREAT
            | nix::fcntl::OFlag::O_NOFOLLOW
            | nix::fcntl::OFlag::O_CLOEXEC,
    )
}

/// Open `leaf` inside the pinned directory for reading, refusing a
/// symlink (`O_NOFOLLOW`).
///
/// # Errors
///
/// Returns the open error (a missing leaf answers `NotFound`, a
/// symlinked leaf `ELOOP`).
#[cfg(unix)]
pub fn open_read_at(parent: &File, leaf: &str) -> io::Result<File> {
    open_at(
        parent,
        leaf,
        nix::fcntl::OFlag::O_RDONLY | nix::fcntl::OFlag::O_NOFOLLOW | nix::fcntl::OFlag::O_CLOEXEC,
    )
}

/// Create or truncate `leaf` inside the pinned directory, owner-only,
/// refusing a symlink (`O_NOFOLLOW`) — the rewrite temp.
///
/// # Errors
///
/// Returns the open error (a symlinked leaf answers `ELOOP`).
#[cfg(unix)]
pub fn create_replace_at(parent: &File, leaf: &str) -> io::Result<File> {
    open_at(
        parent,
        leaf,
        nix::fcntl::OFlag::O_WRONLY
            | nix::fcntl::OFlag::O_CREAT
            | nix::fcntl::OFlag::O_TRUNC
            | nix::fcntl::OFlag::O_NOFOLLOW
            | nix::fcntl::OFlag::O_CLOEXEC,
    )
}

/// Rename `from` to `to` inside the pinned directory (`renameat`): the
/// migration and rewrite swaps never re-resolve a path.
///
/// # Errors
///
/// Returns the rename error.
#[cfg(unix)]
pub fn rename_at(parent: &File, from: &str, to: &str) -> io::Result<()> {
    nix::fcntl::renameat(Some(parent.as_raw_fd()), from, Some(parent.as_raw_fd()), to)?;
    Ok(())
}

#[cfg(unix)]
fn open_at(parent: &File, leaf: &str, oflag: nix::fcntl::OFlag) -> io::Result<File> {
    // 0o600: owner-only for every file created through these primitives.
    let mode = nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR;
    let fd = nix::fcntl::openat(Some(parent.as_raw_fd()), leaf, oflag, mode)?;
    // SAFETY: nix returned a newly-owned raw descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Open `name` inside the pinned directory as a directory for further
/// pinned-relative operations, refusing a symlink (`O_NOFOLLOW` +
/// `O_DIRECTORY`): the trusted-namespace walk resolves one ORIGINAL
/// component at a time, never re-traversing a path.
///
/// # Errors
///
/// Returns the open error (a symlink component answers `ELOOP`/
/// `ENOTDIR`).
#[cfg(unix)]
pub fn open_dir_no_follow_at(parent: &File, name: &std::ffi::OsStr) -> io::Result<File> {
    let oflag = nix::fcntl::OFlag::O_RDONLY
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC;
    let fd = nix::fcntl::openat(
        Some(parent.as_raw_fd()),
        name,
        oflag,
        nix::sys::stat::Mode::empty(),
    )?;
    // SAFETY: nix returned a newly-owned raw descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Windows arm of [`open_dir_no_follow`]: no mode bits or uid-style
/// probes for this discipline — callers fail closed upstream.
#[cfg(not(unix))]
pub fn open_dir_no_follow(_path: &Path) -> io::Result<File> {
    Err(unsupported())
}

/// Windows arm of [`open_dir_no_follow_at`]: see the module note.
#[cfg(not(unix))]
pub fn open_dir_no_follow_at(_parent: &File, _name: &std::ffi::OsStr) -> io::Result<File> {
    Err(unsupported())
}

/// Create `name` inside the pinned directory, owner-only (`0o700`),
/// without resolving a path (`mkdirat`): the trusted-namespace walk
/// creates a missing component ONLY inside a verified non-mutable
/// parent, so no attacker-controlled resolution is involved.
///
/// # Errors
///
/// Returns the mkdir error (an existing component answers
/// `AlreadyExists`).
#[cfg(unix)]
pub fn create_dir_private_at(parent: &File, name: &std::ffi::OsStr) -> io::Result<()> {
    nix::sys::stat::mkdirat(
        Some(parent.as_raw_fd()),
        name,
        nix::sys::stat::Mode::S_IRWXU,
    )?;
    Ok(())
}

/// Windows arm of [`create_dir_private_at`]: see the module note.
#[cfg(not(unix))]
pub fn create_dir_private_at(_parent: &File, _name: &std::ffi::OsStr) -> io::Result<()> {
    Err(unsupported())
}

/// Windows arm of [`open_append_at`]: see the module note.
#[cfg(not(unix))]
pub fn open_append_at(_parent: &File, _leaf: &str) -> io::Result<File> {
    Err(unsupported())
}

/// Windows arm of [`open_read_at`]: see the module note.
#[cfg(not(unix))]
pub fn open_read_at(_parent: &File, _leaf: &str) -> io::Result<File> {
    Err(unsupported())
}

/// Windows arm of [`create_replace_at`]: see the module note.
#[cfg(not(unix))]
pub fn create_replace_at(_parent: &File, _leaf: &str) -> io::Result<File> {
    Err(unsupported())
}

/// Windows arm of [`rename_at`]: see the module note.
#[cfg(not(unix))]
pub fn rename_at(_parent: &File, _from: &str, _to: &str) -> io::Result<()> {
    Err(unsupported())
}

#[cfg(not(unix))]
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "handle-pinned private file operations require unix mode bits",
    )
}

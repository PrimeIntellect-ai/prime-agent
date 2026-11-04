//! Plain-fsync durability for append-only row writes.

use std::fs::File;
use std::io;
use std::path::Path;

#[cfg(unix)]
use std::ffi::{CString, OsStr};
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::path::Component;

/// Whether a directory walk may create a missing component under its held parent.
#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DirectoryCreation {
    ExistingOnly,
    CreateMissing,
}

/// Ask Windows for the link count of the file handle that settings will read.
/// The stable `MetadataExt` API does not expose `nNumberOfLinks`.
#[cfg(windows)]
pub(crate) fn has_multiple_hard_links(file: &File) -> io::Result<bool> {
    use std::ffi::c_void;
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;

    // All fields are required for the Win32 BY_HANDLE_FILE_INFORMATION layout.
    #[allow(dead_code)]
    #[repr(C)]
    struct ByHandleFileInformation {
        attributes: u32,
        creation_time: [u32; 2],
        last_access_time: [u32; 2],
        last_write_time: [u32; 2],
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "GetFileInformationByHandle"]
        fn get_file_information_by_handle(
            file: *mut c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    if unsafe { get_file_information_by_handle(file.as_raw_handle(), information.as_mut_ptr()) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let count = unsafe { information.assume_init() }.number_of_links;
    if count == 0 {
        return Err(io::Error::other("Windows file link count is unavailable"));
    }
    Ok(count > 1)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const SEARCH_DIRECTORY_FLAG: libc::c_int = libc::O_PATH;
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos",
    target_os = "aix"
))]
const SEARCH_DIRECTORY_FLAG: libc::c_int = libc::O_SEARCH;
#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "solaris",
        target_os = "illumos",
        target_os = "aix"
    ))
))]
const SEARCH_DIRECTORY_FLAG: libc::c_int = libc::O_RDONLY;

/// Open one directory beneath a held parent without following a swapped link.
#[cfg(unix)]
pub(crate) fn open_search_directory_at(
    parent: &File,
    name: &OsStr,
    creation: DirectoryCreation,
) -> io::Result<File> {
    let name = CString::new(name.as_bytes())?;
    let flags = SEARCH_DIRECTORY_FLAG | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::NotFound || creation == DirectoryCreation::ExistingOnly {
            return Err(error);
        }
        // A competing creator is fine; reopening with O_NOFOLLOW still rejects
        // a link planted in place of the new directory.
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o777) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // openat returned an owned descriptor; File closes it on every path.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Walk a canonical absolute path using search-only directory descriptors.
#[cfg(unix)]
pub(crate) fn open_search_absolute_directory(
    path: &Path,
    creation: DirectoryCreation,
) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Project settings directory is not absolute",
        ));
    }
    let root = CString::new("/").expect("root path contains no NUL");
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            SEARCH_DIRECTORY_FLAG | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut dir = unsafe { File::from_raw_fd(fd) };
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => dir = open_search_directory_at(&dir, name, creation)?,
            Component::ParentDir | Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Project settings directory is not canonical",
                ));
            }
        }
    }
    Ok(dir)
}

/// Reopen the held final directory for fsync; search-only handles cannot sync.
#[cfg(unix)]
pub(crate) fn open_readable_directory_at(parent: &File) -> io::Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Open a regular file relative to a held directory without following a new link.
#[cfg(unix)]
pub(crate) fn open_regular_file_at(parent: &File, name: &OsStr) -> io::Result<File> {
    let name = CString::new(name.as_bytes())?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Project settings target is not a regular file",
        ));
    }
    Ok(file)
}

/// Write, rename, and sync a private settings file beneath one held directory.
#[cfg(unix)]
pub(crate) fn atomic_write_private_at(
    parent: &File,
    name: &OsStr,
    content: &str,
) -> io::Result<()> {
    let target = CString::new(name.as_bytes())?;
    let mut temp_name = name.to_os_string();
    temp_name.push(format!(
        ".tmp{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let temp = CString::new(temp_name.as_bytes())?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let write_result = (|| -> io::Result<()> {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temp.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        parent.sync_all()?;
        Ok(())
    })();
    if write_result.is_err() {
        // O_EXCL makes this temp name belong to this invocation.
        let _ = unsafe { libc::unlinkat(parent.as_raw_fd(), temp.as_ptr(), 0) };
    }
    write_result
}

/// Sync an existing regular file; Windows requires a writable flush handle.
pub(crate) fn sync_file(path: &Path) -> io::Result<()> {
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    options.write(true);
    options.open(path)?.sync_all()
}

/// fsync a directory so a completed rename survives a crash on POSIX.
///
/// # Errors
///
/// Returns an error when the directory cannot be opened or synced.
#[cfg(unix)]
pub fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

/// Directory fsync is not exposed by the standard library on this platform.
///
/// # Errors
///
/// This implementation never fails.
#[cfg(not(unix))]
pub fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Flush one file's written bytes with a plain `fsync(2)`; std's
/// `sync_data`/`sync_all` take the `F_FULLFSYNC` barrier on Apple.
///
/// # Errors
///
/// Returns the OS error when the sync fails.
#[cfg(unix)]
pub fn fsync(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    nix::unistd::fsync(file.as_raw_fd()).map_err(io::Error::from)
}

/// # Errors
///
/// Returns the underlying I/O error when the sync fails.
#[cfg(not(unix))]
pub fn fsync(file: &File) -> io::Result<()> {
    file.sync_data()
}

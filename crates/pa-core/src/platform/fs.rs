//! Plain-fsync durability for append-only row writes.

use std::fs::File;
use std::io;
use std::path::Path;

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
        fn get_file_information_by_handle(file: *mut c_void, information: *mut c_void) -> i32;
    }

    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    if unsafe {
        get_file_information_by_handle(file.as_raw_handle(), information.as_mut_ptr().cast())
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let count = unsafe { information.assume_init() }.number_of_links;
    if count == 0 {
        return Err(io::Error::other("Windows file link count is unavailable"));
    }
    Ok(count > 1)
}

#[cfg(windows)]
#[path = "fs/windows.rs"]
mod windows;
#[cfg(windows)]
pub(crate) use windows::{
    atomic_write_private_at, open_regular_file_at, open_search_absolute_directory,
    open_search_directory_at, same_directory_at_path, DirectoryCreation,
};

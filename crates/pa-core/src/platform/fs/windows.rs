//! Handle-relative Windows filesystem operations for project settings.
//!
//! A validated parent handle remains bound to the same directory if another
//! process renames an ancestor. All child creation and the final rename use
//! that handle, so a later path swap cannot redirect the settings document.

use std::ffi::{c_void, OsStr};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::mem::{size_of, MaybeUninit};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf};
use std::ptr;
use std::thread;
use std::time::Duration;

#[cfg(test)]
use std::cell::RefCell;

/// Whether a directory walk may create a missing component under its held parent.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DirectoryCreation {
    ExistingOnly,
    CreateMissing,
}

const FILE_SHARE_ALL: u32 = 0x0000_0007;
const FILE_SHARE_READ_WRITE: u32 = 0x0000_0003;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const FILE_TRAVERSE: u32 = 0x0000_0020;
const FILE_READ_DATA: u32 = 0x0000_0001;
const GENERIC_WRITE: u32 = 0x4000_0000;
const DELETE: u32 = 0x0001_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x0000_4000;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
const FILE_CREATE: u32 = 2;
const FILE_OPEN: u32 = 1;
const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
const FILE_RENAME_INFORMATION_CLASS: i32 = 10;
const FILE_DISPOSITION_INFO_CLASS: u32 = 4;
const FILE_ID_INFO_CLASS: i32 = 18;

#[cfg(test)]
type SettingsRaceHook = Box<dyn FnOnce(&OsStr)>;

#[cfg(test)]
thread_local! {
    static BEFORE_MISSING_DIRECTORY_CREATE: RefCell<Option<SettingsRaceHook>> = const { RefCell::new(None) };
    static BEFORE_TEMP_RENAME: RefCell<Option<SettingsRaceHook>> = const { RefCell::new(None) };
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: *mut c_void,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[repr(C)]
struct IoStatusBlock {
    status: usize,
    information: usize,
}

#[repr(C)]
struct RenameInfo {
    replace_if_exists: u8,
    root_directory: *mut c_void,
    file_name_length: u32,
    file_name: [u16; 1],
}

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

#[repr(C)]
struct FileIdInfo {
    volume_serial_number: u64,
    file_id: [u8; 16],
}

#[derive(PartialEq, Eq)]
enum DirectoryId {
    Extended { volume: u64, id: [u8; 16] },
    Legacy { volume: u32, index: u64 },
}

#[link(name = "ntdll")]
unsafe extern "system" {
    #[link_name = "NtCreateFile"]
    fn nt_create_file(
        file_handle: *mut *mut c_void,
        desired_access: u32,
        object_attributes: *mut ObjectAttributes,
        io_status_block: *mut IoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut c_void,
        ea_length: u32,
    ) -> i32;

    #[link_name = "NtSetInformationFile"]
    fn nt_set_information_file(
        file_handle: *mut c_void,
        io_status_block: *mut IoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: i32,
    ) -> i32;

    #[link_name = "RtlNtStatusToDosError"]
    fn rtl_nt_status_to_dos_error(status: i32) -> u32;
}

fn directory_identity(file: &File) -> io::Result<DirectoryId> {
    let mut extended = MaybeUninit::<FileIdInfo>::uninit();
    if unsafe {
        get_file_information_by_handle_ex(
            file.as_raw_handle(),
            FILE_ID_INFO_CLASS,
            extended.as_mut_ptr().cast::<c_void>(),
            u32::try_from(size_of::<FileIdInfo>()).expect("fixed Win32 structure"),
        )
    } != 0
    {
        let extended = unsafe { extended.assume_init() };
        if extended.file_id != [0; 16] && extended.file_id != [u8::MAX; 16] {
            return Ok(DirectoryId::Extended {
                volume: extended.volume_serial_number,
                id: extended.file_id,
            });
        }
    }

    // The 64-bit index is not unique on ReFS. Only use it where Windows
    // documents the legacy identity as stable, as the lock-dir helper does.
    let mut filesystem = [0_u16; 64];
    if unsafe {
        get_volume_information_by_handle(
            file.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            filesystem.as_mut_ptr(),
            u32::try_from(filesystem.len()).expect("bounded filesystem name buffer"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let end = filesystem
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(filesystem.len());
    let name = String::from_utf16(&filesystem[..end])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid filesystem name"))?;
    if !["NTFS", "FAT", "FAT32", "exFAT"]
        .iter()
        .any(|supported| name.eq_ignore_ascii_case(supported))
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "filesystem does not provide a stable project settings identity",
        ));
    }
    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    if unsafe { get_file_information_by_handle(file.as_raw_handle(), information.as_mut_ptr()) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    let index =
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
    if index == 0 || index == u64::MAX {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "filesystem returned no stable project settings file index",
        ));
    }
    Ok(DirectoryId::Legacy {
        volume: information.volume_serial_number,
        index,
    })
}

pub(crate) fn same_directory_at_path(file: &File, path: &Path) -> io::Result<bool> {
    let mut options = OpenOptions::new();
    options
        .access_mode(FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    let current = options.open(path)?;
    Ok(current.metadata()?.is_dir() && directory_identity(file)? == directory_identity(&current)?)
}

#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "GetFileInformationByHandleEx"]
    fn get_file_information_by_handle_ex(
        file: *mut c_void,
        information_class: i32,
        information: *mut c_void,
        information_size: u32,
    ) -> i32;

    #[link_name = "GetFileInformationByHandle"]
    fn get_file_information_by_handle(
        file: *mut c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;

    #[link_name = "GetVolumeInformationByHandleW"]
    fn get_volume_information_by_handle(
        file: *mut c_void,
        volume_name: *mut u16,
        volume_name_size: u32,
        volume_serial: *mut u32,
        maximum_component_length: *mut u32,
        filesystem_flags: *mut u32,
        filesystem_name: *mut u16,
        filesystem_name_size: u32,
    ) -> i32;

    #[link_name = "SetFileInformationByHandle"]
    fn set_file_information_by_handle(
        file: *mut c_void,
        information_class: u32,
        information: *mut c_void,
        information_size: u32,
    ) -> i32;
}

fn single_component(name: &OsStr) -> io::Result<Vec<u16>> {
    let wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty()
        || wide.iter().any(|&unit| {
            matches!(unit, 0 | 47 | 58 | 92) // NUL, slash, colon, backslash
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Project settings path component is invalid",
        ));
    }
    Ok(wide)
}

fn nt_error(status: i32) -> io::Error {
    // Keep the kinds used by the anchored create/open race deterministic even
    // if a filesystem driver returns an NTSTATUS without a DOS mapping.
    match status as u32 {
        0xC000_0034 | 0xC000_003A => io::ErrorKind::NotFound.into(),
        0xC000_0035 => io::ErrorKind::AlreadyExists.into(),
        _ => {
            let code = unsafe { rtl_nt_status_to_dos_error(status) };
            io::Error::from_raw_os_error(i32::try_from(code).unwrap_or(i32::MAX))
        }
    }
}

fn open_relative(
    parent: &File,
    name: &OsStr,
    desired_access: u32,
    disposition: u32,
    options: u32,
    share_mode: u32,
) -> io::Result<File> {
    let mut wide = single_component(name)?;
    let length = u16::try_from(wide.len().saturating_mul(size_of::<u16>())).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "Project settings name is long")
    })?;
    let mut unicode = UnicodeString {
        length,
        maximum_length: length,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: u32::try_from(size_of::<ObjectAttributes>()).expect("fixed Win32 structure"),
        root_directory: parent.as_raw_handle(),
        object_name: &raw mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: ptr::null_mut(),
        security_quality_of_service: ptr::null_mut(),
    };
    let mut io_status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle = ptr::null_mut();
    let status = unsafe {
        nt_create_file(
            &raw mut handle,
            desired_access,
            &raw mut attributes,
            &raw mut io_status,
            ptr::null_mut(),
            FILE_ATTRIBUTE_NORMAL,
            share_mode,
            disposition,
            options | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        if !handle.is_null() {
            drop(unsafe { File::from_raw_handle(handle) });
        }
        return Err(nt_error(status));
    }
    if handle.is_null() {
        return Err(io::Error::other(
            "NtCreateFile returned no project settings handle",
        ));
    }
    // NtCreateFile returned an owned Win32 handle. File closes it on all paths.
    Ok(unsafe { File::from_raw_handle(handle) })
}

pub(crate) fn open_regular_file_at(parent: &File, name: &OsStr) -> io::Result<File> {
    let file = open_relative(
        parent,
        name,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
        FILE_SHARE_ALL,
    )?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Project settings target is not a regular file",
        ));
    }
    Ok(file)
}

fn checked_directory(file: File) -> io::Result<File> {
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Project settings directory is a reparse point or not a directory",
        ));
    }
    Ok(file)
}

pub(crate) fn open_search_directory_at(
    parent: &File,
    name: &OsStr,
    creation: DirectoryCreation,
) -> io::Result<File> {
    // The open observes the child object itself. A raced junction/symlink is
    // rejected after opening its handle, never followed into its target.
    let opened = open_relative(
        parent,
        name,
        FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
        FILE_OPEN,
        FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
        FILE_SHARE_ALL,
    );
    match opened {
        Ok(file) => checked_directory(file),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                && creation == DirectoryCreation::CreateMissing =>
        {
            #[cfg(test)]
            BEFORE_MISSING_DIRECTORY_CREATE.with(|hook| {
                if let Some(callback) = hook.borrow_mut().take() {
                    callback(name);
                }
            });
            match open_relative(
                parent,
                name,
                FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
                FILE_SHARE_ALL,
            ) {
                Ok(file) => checked_directory(file),
                // Another creator may win; reopen without following its result.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let file = open_relative(
                        parent,
                        name,
                        FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
                        FILE_OPEN,
                        FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
                        FILE_SHARE_ALL,
                    )?;
                    checked_directory(file)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn open_search_absolute_directory(
    path: &Path,
    creation: DirectoryCreation,
) -> io::Result<File> {
    let mut components = path.components();
    let (Some(Component::Prefix(prefix)), Some(Component::RootDir)) =
        (components.next(), components.next())
    else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Project settings directory is not absolute",
        ));
    };
    let mut volume_root = PathBuf::from(prefix.as_os_str());
    volume_root.push("\\");
    let mut options = OpenOptions::new();
    options
        .access_mode(FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let mut dir = checked_directory(options.open(volume_root)?)?;
    for component in components {
        match component {
            Component::Normal(name) => dir = open_search_directory_at(&dir, name, creation)?,
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Project settings directory is not canonical",
                ));
            }
        }
    }
    Ok(dir)
}

fn rename_in_same_directory(file: &File, name: &OsStr) -> io::Result<()> {
    let wide = single_component(name)?;
    let name_bytes = wide
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Settings name is long"))?;
    let used_bytes = size_of::<RenameInfo>()
        .checked_add(name_bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Settings name is long"))?;
    let used_bytes_u32 = u32::try_from(used_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Settings name is long"))?;
    let mut storage = vec![0usize; used_bytes.div_ceil(size_of::<usize>())];
    let information = storage.as_mut_ptr().cast::<RenameInfo>();
    unsafe {
        (*information).replace_if_exists = 1;
        // Native FileRenameInformation treats a NULL root and simple name as
        // a rename within this temp's held directory. SMB also requires a
        // NULL root; Win32 FileRenameInfo interprets the name differently.
        (*information).root_directory = ptr::null_mut();
        (*information).file_name_length = u32::try_from(name_bytes).expect("bounded above");
        ptr::copy_nonoverlapping(
            wide.as_ptr(),
            ptr::addr_of_mut!((*information).file_name).cast::<u16>(),
            wide.len(),
        );
    }
    for attempt in 1..=5 {
        let mut io_status = IoStatusBlock {
            status: 0,
            information: 0,
        };
        let status = unsafe {
            nt_set_information_file(
                file.as_raw_handle(),
                &raw mut io_status,
                storage.as_mut_ptr().cast::<c_void>(),
                used_bytes_u32,
                FILE_RENAME_INFORMATION_CLASS,
            )
        };
        if status == 0 {
            return Ok(());
        }
        let error = nt_error(status);
        let busy = matches!(error.raw_os_error(), Some(32 | 33))
            || error.kind() == io::ErrorKind::PermissionDenied;
        if !busy || attempt == 5 {
            return Err(error);
        }
        // Match the existing bounded Windows rename retry in pa-telemetry.
        thread::sleep(Duration::from_millis(10 * attempt));
    }
    unreachable!("the fifth rename attempt returns")
}

fn delete_on_close(file: &File) {
    let mut disposition = 1u8;
    let _ = unsafe {
        set_file_information_by_handle(
            file.as_raw_handle(),
            FILE_DISPOSITION_INFO_CLASS,
            (&raw mut disposition).cast::<c_void>(),
            1,
        )
    };
}

pub(crate) fn atomic_write_private_at(
    parent: &File,
    name: &OsStr,
    content: &str,
) -> io::Result<()> {
    let mut temp_name = name.to_os_string();
    temp_name.push(format!(
        ".tmp{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut temp = open_relative(
        parent,
        &temp_name,
        GENERIC_WRITE | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE,
        // Keep the temp in its held parent until this handle renames it.
        // Other processes may still read/write, but cannot move or delete it.
        FILE_SHARE_READ_WRITE,
    )?;
    let result = (|| {
        temp.write_all(content.as_bytes())?;
        temp.sync_all()?;
        #[cfg(test)]
        BEFORE_TEMP_RENAME.with(|hook| {
            if let Some(callback) = hook.borrow_mut().take() {
                callback(&temp_name);
            }
        });
        rename_in_same_directory(&temp, name)
    })();
    if result.is_err() {
        delete_on_close(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::os::windows::fs::symlink_dir;
    use std::rc::Rc;

    #[test]
    fn missing_directory_create_does_not_follow_a_planted_link() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let child = project.join("agent");
        let outside = root.path().join("outside-created");
        std::fs::create_dir(&project).unwrap();
        let parent =
            open_search_absolute_directory(&project, DirectoryCreation::ExistingOnly).unwrap();
        let child_for_hook = child.clone();
        let outside_for_hook = outside.clone();
        BEFORE_MISSING_DIRECTORY_CREATE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |_| {
                symlink_dir(&outside_for_hook, &child_for_hook).unwrap();
            }));
        });

        let opened = open_search_directory_at(
            &parent,
            OsStr::new("agent"),
            DirectoryCreation::CreateMissing,
        );
        BEFORE_MISSING_DIRECTORY_CREATE.with(|hook| *hook.borrow_mut() = None);

        assert!(opened.is_err());
        assert!(!outside.exists());
    }

    #[test]
    fn temp_cannot_move_before_same_directory_rename() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let outside = root.path().join("outside");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(project.join("settings.json"), "old").unwrap();
        let parent =
            open_search_absolute_directory(&project, DirectoryCreation::ExistingOnly).unwrap();
        let move_succeeded = Rc::new(Cell::new(false));
        let moved_for_hook = Rc::clone(&move_succeeded);
        let project_for_hook = project.clone();
        let outside_for_hook = outside.clone();
        BEFORE_TEMP_RENAME.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |temp_name| {
                moved_for_hook.set(
                    std::fs::rename(
                        project_for_hook.join(temp_name),
                        outside_for_hook.join(temp_name),
                    )
                    .is_ok(),
                );
            }));
        });

        let result = atomic_write_private_at(&parent, OsStr::new("settings.json"), "new");
        BEFORE_TEMP_RENAME.with(|hook| *hook.borrow_mut() = None);

        result.unwrap();
        assert!(!move_succeeded.get());
        assert_eq!(
            std::fs::read_to_string(project.join("settings.json")).unwrap(),
            "new"
        );
        assert!(!outside.join("settings.json").exists());
    }
}

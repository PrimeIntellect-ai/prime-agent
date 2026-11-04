//! Windows managed log operations relative to a held directory handle.

use std::ffi::{c_void, OsStr};
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path};
use std::ptr;

use super::DirectoryMode;

const FILE_SHARE_ALL: u32 = 0x7;
const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;
const FILE_READ_DATA: u32 = 0x1;
const FILE_APPEND_DATA: u32 = 0x4;
const FILE_TRAVERSE: u32 = 0x20;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const DELETE: u32 = 0x0001_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_DIRECTORY_FILE: u32 = 0x1;
const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x4000;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_OPEN_IF: u32 = 3;
const OBJ_CASE_INSENSITIVE: u32 = 0x40;
const FILE_RENAME_INFORMATION_CLASS: i32 = 10;
const FILE_DISPOSITION_INFO_CLASS: u32 = 4;
const FILE_STANDARD_INFO_CLASS: i32 = 1;
const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 9;
const NAME_SURROGATE_REPARSE_TAG: u32 = 0x2000_0000;

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
struct FileAttributeTagInfo {
    file_attributes: u32,
    reparse_tag: u32,
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
struct FileStandardInfo {
    allocation_size: i64,
    end_of_file: i64,
    number_of_links: u32,
    delete_pending: u8,
    directory: u8,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    #[link_name = "NtCreateFile"]
    fn nt_create_file(
        file_handle: *mut *mut c_void,
        desired_access: u32,
        object_attributes: *const c_void,
        io_status_block: *mut c_void,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *const c_void,
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

#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "GetFileInformationByHandle"]
    fn get_file_information_by_handle(file: *mut c_void, information: *mut c_void) -> i32;

    #[link_name = "GetFileInformationByHandleEx"]
    fn get_file_information_by_handle_ex(
        file: *mut c_void,
        information_class: i32,
        information: *mut c_void,
        information_size: u32,
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
        || name == OsStr::new(".")
        || name == OsStr::new("..")
        || wide.iter().any(|&unit| matches!(unit, 0 | 47 | 58 | 92))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed log name is not a single path component",
        ));
    }
    Ok(wide)
}

fn nt_error(status: i32) -> io::Error {
    match status.cast_unsigned() {
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
) -> io::Result<File> {
    let mut wide = single_component(name)?;
    let name_length = u16::try_from(wide.len().saturating_mul(size_of::<u16>()))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "managed log name is too long"))?;
    let mut unicode = UnicodeString {
        length: name_length,
        maximum_length: name_length,
        buffer: wide.as_mut_ptr(),
    };
    let attributes = ObjectAttributes {
        length: u32::try_from(size_of::<ObjectAttributes>()).expect("fixed Windows structure"),
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
            (&raw const attributes).cast(),
            (&raw mut io_status).cast(),
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_ALL,
            disposition,
            options | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if status < 0 {
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            // SAFETY: the native call may return an owned handle on failure.
            drop(unsafe { File::from_raw_handle(handle) });
        }
        return Err(nt_error(status));
    }
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::other(
            "NtCreateFile returned no managed log handle",
        ));
    }
    // SAFETY: NtCreateFile returned one owned handle, transferred to File.
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn reject_name_surrogate(file: &File) -> io::Result<()> {
    // Normal files work on every supported filesystem without a tag query.
    // For reparse points, inspect the actual opened object, not its pathname.
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(());
    }
    let mut info = MaybeUninit::<FileAttributeTagInfo>::uninit();
    if unsafe {
        get_file_information_by_handle_ex(
            file.as_raw_handle(),
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            info.as_mut_ptr().cast(),
            u32::try_from(size_of::<FileAttributeTagInfo>()).expect("fixed Windows structure"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 || info.reparse_tag == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed log reparse tag could not be verified",
        ));
    }
    // Cloud Files placeholders are not name surrogates. Symlinks and junctions are.
    if info.reparse_tag & NAME_SURROGATE_REPARSE_TAG != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed log path is a link or junction",
        ));
    }
    Ok(())
}

fn reject_multiple_hard_links(file: &File) -> io::Result<()> {
    let mut info = MaybeUninit::<ByHandleFileInformation>::uninit();
    let legacy_ok =
        unsafe { get_file_information_by_handle(file.as_raw_handle(), info.as_mut_ptr().cast()) };
    let mut links = if legacy_ok == 0 {
        0
    } else {
        unsafe { info.assume_init() }.number_of_links
    };
    if links == 0 {
        // Some network filesystems omit this field from the legacy query.
        // Ask the same handle through the newer information class before
        // deciding whether the object has exactly one name.
        let mut standard = MaybeUninit::<FileStandardInfo>::uninit();
        if unsafe {
            get_file_information_by_handle_ex(
                file.as_raw_handle(),
                FILE_STANDARD_INFO_CLASS,
                standard.as_mut_ptr().cast(),
                u32::try_from(size_of::<FileStandardInfo>()).expect("fixed Windows structure"),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        links = unsafe { standard.assume_init() }.number_of_links;
    }
    if links != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed log does not have a verified single link",
        ));
    }
    Ok(())
}

fn checked_directory(file: File) -> io::Result<File> {
    reject_name_surrogate(&file)?;
    if !file.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed log path is not a directory",
        ));
    }
    Ok(file)
}

fn open_directory_at(parent: &File, name: &OsStr) -> io::Result<File> {
    let access = FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE;
    let opened = open_relative(
        parent,
        name,
        access,
        FILE_OPEN,
        FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
    );
    match opened {
        Ok(file) => checked_directory(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let created = open_relative(
                parent,
                name,
                access,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            );
            match created {
                Ok(file) => checked_directory(file),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    checked_directory(open_relative(
                        parent,
                        name,
                        access,
                        FILE_OPEN,
                        FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
                    )?)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

pub(super) fn open_managed_directory(
    path: &Path,
    trusted_root: &Path,
    mode: DirectoryMode,
) -> io::Result<File> {
    mode.create(trusted_root)?;
    let mut options = OpenOptions::new();
    options
        .access_mode(FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    // An explicitly configured root may be linked. Follow and pin it once.
    let mut dir = checked_directory(options.open(trusted_root)?)?;
    let relative = match path.strip_prefix(trusted_root) {
        Ok(relative) => relative,
        Err(_) if trusted_root == Path::new(".") && path.is_relative() => path,
        Err(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "managed log directory is outside its trusted root",
            ));
        }
    };
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "managed log directory has a non-normal component",
            ));
        };
        dir = open_directory_at(&dir, name)?;
    }
    Ok(dir)
}

pub(super) fn open_file(dir: &File, name: &OsStr, append: bool) -> io::Result<File> {
    let access = if append {
        FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE
    } else {
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE
    };
    let disposition = if append { FILE_OPEN_IF } else { FILE_OPEN };
    let file = open_relative(
        dir,
        name,
        access,
        disposition,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
    )?;
    reject_name_surrogate(&file)?;
    reject_multiple_hard_links(&file)?;
    Ok(file)
}

pub(super) fn rename(dir: &File, from: &OsStr, to: &OsStr) -> io::Result<()> {
    let source = open_relative(
        dir,
        from,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
    )?;
    reject_name_surrogate(&source)?;
    reject_multiple_hard_links(&source)?;
    let wide = single_component(to)?;
    let name_bytes = wide.len().checked_mul(size_of::<u16>()).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "managed log name is too long")
    })?;
    let used_bytes = size_of::<RenameInfo>()
        .checked_add(name_bytes)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "managed log name is too long")
        })?;
    let used_bytes_u32 = u32::try_from(used_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "managed log name is too long"))?;
    let mut storage = vec![0usize; used_bytes.div_ceil(size_of::<usize>())];
    let information = storage.as_mut_ptr().cast::<RenameInfo>();
    unsafe {
        (*information).replace_if_exists = 1;
        // A simple name and null root rename beside the held source.
        // SMB also requires a null root for this native information class.
        (*information).root_directory = ptr::null_mut();
        (*information).file_name_length = u32::try_from(name_bytes).expect("bounded above");
        ptr::copy_nonoverlapping(
            wide.as_ptr(),
            ptr::addr_of_mut!((*information).file_name).cast::<u16>(),
            wide.len(),
        );
    }
    let mut io_status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let status = unsafe {
        nt_set_information_file(
            source.as_raw_handle(),
            &raw mut io_status,
            storage.as_mut_ptr().cast(),
            used_bytes_u32,
            FILE_RENAME_INFORMATION_CLASS,
        )
    };
    if status < 0 {
        return Err(nt_error(status));
    }
    Ok(())
}

pub(super) fn remove(dir: &File, name: &OsStr) -> io::Result<()> {
    let file = open_relative(
        dir,
        name,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
    )?;
    reject_name_surrogate(&file)?;
    let mut disposition = 1u8;
    if unsafe {
        set_file_information_by_handle(
            file.as_raw_handle(),
            FILE_DISPOSITION_INFO_CLASS,
            (&raw mut disposition).cast(),
            1,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

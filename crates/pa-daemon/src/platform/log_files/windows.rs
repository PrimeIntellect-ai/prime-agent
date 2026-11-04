//! Windows diagnostic logs opened relative to held agent and logs directories.
//! The configured agent root may be a link; managed children may not be name
//! surrogates. Cloud Files placeholders have non-surrogate tags and remain usable.

use super::{DirectoryCreation, OpenMode};
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::mem::{align_of, offset_of, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::ptr;

type Handle = *mut c_void;

// Values from WinNT.h / winternl.h. They are kept here instead of adding a
// Windows SDK crate dependency to a platform-private diagnostic path.
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const FILE_READ_DATA: u32 = 0x0001;
const FILE_LIST_DIRECTORY: u32 = 0x0001;
const FILE_WRITE_DATA: u32 = 0x0002;
const FILE_APPEND_DATA: u32 = 0x0004;
const FILE_TRAVERSE: u32 = 0x0020;
const FILE_READ_ATTRIBUTES: u32 = 0x0080;
const DELETE: u32 = 0x0001_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_SHARE_ALL: u32 = 0x0007;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0080;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const OBJ_CASE_INSENSITIVE: u32 = 0x0040;
const FILE_DIRECTORY_FILE: u32 = 0x0001;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0040;
const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x4000;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0020;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_OPEN_IF: u32 = 3;
const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 9;
const FILE_STANDARD_INFO_CLASS: i32 = 1;
const FILE_ID_BOTH_DIR_INFO_CLASS: i32 = 10;
const FILE_RENAME_INFORMATION_CLASS: i32 = 10;
const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
const ERROR_NO_MORE_FILES: i32 = 18;
// IsReparseTagNameSurrogate: a surrogate represents another named entity.
// Cloud Files tags do not set this bit, so their placeholders remain allowed.
const NAME_SURROGATE_BIT: u32 = 0x2000_0000;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: Handle,
    object_name: *const UnicodeString,
    attributes: u32,
    security_descriptor: *const c_void,
    security_quality_of_service: *const c_void,
}

#[repr(C)]
#[derive(Default)]
struct IoStatusBlock {
    status_or_pointer: usize,
    information: usize,
}

#[repr(C)]
#[derive(Default)]
struct FileAttributeTagInfo {
    file_attributes: u32,
    reparse_tag: u32,
}

#[repr(C)]
#[derive(Default)]
// Every field is required for the Win32 ABI even when only one is read.
#[allow(dead_code)]
struct FileTime {
    low: u32,
    high: u32,
}

#[repr(C)]
#[derive(Default)]
// Every field is required for the Win32 ABI even when only one is read.
#[allow(dead_code)]
struct ByHandleFileInformation {
    file_attributes: u32,
    creation_time: FileTime,
    last_access_time: FileTime,
    last_write_time: FileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[repr(C)]
#[derive(Default)]
// Windows returns these fields from FileStandardInfo on filesystems whose
// legacy GetFileInformationByHandle link count is unavailable.
#[allow(dead_code)]
struct FileStandardInfo {
    allocation_size: i64,
    end_of_file: i64,
    number_of_links: u32,
    delete_pending: u8,
    directory: u8,
}

#[repr(C)]
// Directory enumeration reads selected fields from this fixed Win32 header.
#[allow(dead_code)]
struct FileIdBothDirInfo {
    next_entry_offset: u32,
    file_index: u32,
    creation_time: i64,
    last_access_time: i64,
    last_write_time: i64,
    change_time: i64,
    end_of_file: i64,
    allocation_size: i64,
    file_attributes: u32,
    file_name_length: u32,
    ea_size: u32,
    short_name_length: i8,
    short_name: [u16; 12],
    file_id: i64,
    file_name: [u16; 1],
}

#[repr(C)]
struct FileRenameInfo {
    replace_if_exists: u8,
    root_directory: Handle,
    file_name_length: u32,
    file_name: [u16; 1],
}

#[repr(C)]
struct FileDispositionInfo {
    delete_file: u8,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandleEx(
        file: Handle,
        info_class: i32,
        info: *mut c_void,
        info_size: u32,
    ) -> i32;
    fn GetFileInformationByHandle(file: Handle, info: *mut ByHandleFileInformation) -> i32;
    fn SetFileInformationByHandle(
        file: Handle,
        info_class: i32,
        info: *const c_void,
        info_size: u32,
    ) -> i32;
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file: *mut Handle,
        desired_access: u32,
        object_attributes: *const ObjectAttributes,
        io_status: *mut IoStatusBlock,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn NtSetInformationFile(
        file: Handle,
        io_status: *mut IoStatusBlock,
        info: *mut c_void,
        info_size: u32,
        info_class: i32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

pub(super) struct AnchoredDir {
    fd: File,
}

impl AnchoredDir {
    pub(super) fn open(path: &Path, creation: DirectoryCreation) -> io::Result<Self> {
        let root = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let name = path.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "diagnostic log directory has no name",
            )
        })?;
        if creation == DirectoryCreation::CreateMissing {
            fs::create_dir_all(root)?;
        }
        // The configured root can deliberately be a junction or symlink.
        let root_access = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
        let root_fd = open_root(root, root_access)?;
        let existing = open_log_directory(&root_fd, name, FILE_OPEN, FILE_OPEN_FOR_BACKUP_INTENT);
        let fd = match existing {
            Ok(file) => file,
            Err(error)
                if creation == DirectoryCreation::CreateMissing
                    && error.kind() == io::ErrorKind::NotFound =>
            {
                match open_log_directory(&root_fd, name, FILE_CREATE, FILE_DIRECTORY_FILE) {
                    Ok(file) => file,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        open_log_directory(&root_fd, name, FILE_OPEN, FILE_OPEN_FOR_BACKUP_INTENT)?
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) => return Err(error),
        };
        Ok(Self { fd })
    }

    pub(super) fn open_file(&self, name: &OsStr, mode: OpenMode) -> io::Result<File> {
        let (access, disposition) = match mode {
            OpenMode::Read => (FILE_READ_DATA, FILE_OPEN),
            OpenMode::Append => (FILE_APPEND_DATA, FILE_OPEN_IF),
            OpenMode::Write => (FILE_WRITE_DATA, FILE_OPEN_IF),
        };
        let file = open_relative(
            &self.fd,
            name,
            access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            disposition,
            FILE_NON_DIRECTORY_FILE,
        )?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "diagnostic log is not a regular file",
            ));
        }
        let mut info = ByHandleFileInformation::default();
        // SAFETY: info is a correctly laid out writable output structure and
        // the File owns a valid handle for the duration of the call.
        let legacy_ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) };
        let links = if legacy_ok != 0 && info.number_of_links != 0 {
            info.number_of_links
        } else {
            let mut standard = FileStandardInfo::default();
            // SAFETY: standard is the documented writable FileStandardInfo
            // structure and the opened file remains live through the call.
            if unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FILE_STANDARD_INFO_CLASS,
                    (&raw mut standard).cast(),
                    u32::try_from(size_of::<FileStandardInfo>()).expect("fixed Windows structure"),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            standard.number_of_links
        };
        if links != 1 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "diagnostic log link count is not exactly one",
            ));
        }
        Ok(file)
    }

    pub(super) fn rename(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
        let source = open_relative(
            &self.fd,
            from,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        let name = checked_name(to)?;
        let name_bytes = name.len() * size_of::<u16>();
        let total_bytes = size_of::<FileRenameInfo>() + name_bytes;
        let mut storage = vec![0usize; total_bytes.div_ceil(size_of::<usize>())];
        let info = storage.as_mut_ptr().cast::<FileRenameInfo>();
        // SAFETY: storage is pointer-aligned and large enough for the header,
        // the length-delimited name, and an optional trailing NUL.
        unsafe {
            (*info).replace_if_exists = 1;
            // A simple destination name and null root rename beside the
            // opened source, including on SMB-backed agent state roots.
            (*info).root_directory = ptr::null_mut();
            (*info).file_name_length = u32::try_from(name_bytes).expect("bounded Windows name");
            ptr::copy_nonoverlapping(name.as_ptr(), (*info).file_name.as_mut_ptr(), name.len());
        }
        let mut io_status = IoStatusBlock::default();
        // SAFETY: source stays open with DELETE access; storage is aligned and
        // contains the documented native FileRenameInformation buffer.
        let status = unsafe {
            NtSetInformationFile(
                source.as_raw_handle(),
                &raw mut io_status,
                storage.as_mut_ptr().cast(),
                u32::try_from(total_bytes).expect("bounded Windows rename buffer"),
                FILE_RENAME_INFORMATION_CLASS,
            )
        };
        if status < 0 {
            return Err(nt_error(status));
        }
        Ok(())
    }

    pub(super) fn remove(&self, name: &OsStr) -> io::Result<()> {
        let source = open_relative(
            &self.fd,
            name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        let info = FileDispositionInfo { delete_file: 1 };
        // SAFETY: info is the documented FileDispositionInfo input buffer and
        // source remains open with DELETE access through this call.
        if unsafe {
            SetFileInformationByHandle(
                source.as_raw_handle(),
                FILE_DISPOSITION_INFO_CLASS,
                (&raw const info).cast(),
                u32::try_from(size_of::<FileDispositionInfo>()).expect("fixed Windows structure"),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn names(&self) -> io::Result<Vec<OsString>> {
        let mut names = Vec::new();
        // The buffer is 8-byte aligned as required by FILE_ID_BOTH_DIR_INFO.
        let mut buffer = vec![0u64; 8192];
        let size = buffer.len() * size_of::<u64>();
        loop {
            // SAFETY: buffer is aligned, writable, and remains live while the
            // OS fills it; self.fd stays open for the whole enumeration.
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    self.fd.as_raw_handle(),
                    FILE_ID_BOTH_DIR_INFO_CLASS,
                    buffer.as_mut_ptr().cast(),
                    u32::try_from(size).expect("fixed Windows directory buffer"),
                )
            };
            if ok == 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_NO_MORE_FILES) {
                    Ok(names)
                } else {
                    Err(error)
                };
            }
            let mut offset = 0usize;
            loop {
                let header = offset_of!(FileIdBothDirInfo, file_name);
                if !offset.is_multiple_of(align_of::<FileIdBothDirInfo>())
                    || offset
                        .checked_add(size_of::<FileIdBothDirInfo>())
                        .is_none_or(|end| end > size)
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid directory entry",
                    ));
                }
                // SAFETY: buffer and every documented NextEntryOffset are
                // 8-byte aligned; the fixed header fits within the buffer.
                let entry = unsafe {
                    &*buffer
                        .as_ptr()
                        .add(offset / size_of::<u64>())
                        .cast::<FileIdBothDirInfo>()
                };
                let name_bytes = entry.file_name_length as usize;
                if !name_bytes.is_multiple_of(2)
                    || offset
                        .checked_add(header + name_bytes)
                        .is_none_or(|end| end > size)
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid directory name",
                    ));
                }
                // SAFETY: the UTF-16 name's byte length was checked against
                // the allocated buffer; Windows supplies the data in place.
                let wide =
                    unsafe { std::slice::from_raw_parts(entry.file_name.as_ptr(), name_bytes / 2) };
                let name = OsString::from_wide(wide);
                if name != "." && name != ".." {
                    names.push(name);
                }
                if entry.next_entry_offset == 0 {
                    break;
                }
                let next = entry.next_entry_offset as usize;
                if !next.is_multiple_of(align_of::<FileIdBothDirInfo>())
                    || next < header + name_bytes
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid directory offset",
                    ));
                }
                offset = offset.checked_add(next).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid directory offset")
                })?;
            }
        }
    }
}

fn open_root(path: &Path, access: u32) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .access_mode(access)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    options.open(path)
}

fn checked_directory(file: File) -> io::Result<File> {
    if !file.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed diagnostic path is not a directory",
        ));
    }
    Ok(file)
}

fn open_log_directory(
    root: &File,
    name: &OsStr,
    disposition: u32,
    file_type: u32,
) -> io::Result<File> {
    let access = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    match open_relative(
        root,
        name,
        access | FILE_LIST_DIRECTORY,
        disposition,
        file_type,
    ) {
        Ok(file) => checked_directory(file),
        // Existing ACLs may allow opening a named log but deny directory
        // listing. Keep those writes working; pruning was best-effort there.
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            checked_directory(open_relative(root, name, access, disposition, file_type)?)
        }
        Err(error) => Err(error),
    }
}

fn nt_error(status: i32) -> io::Error {
    match status.cast_unsigned() {
        0xC000_0034 | 0xC000_003A => io::ErrorKind::NotFound.into(),
        0xC000_0035 => io::ErrorKind::AlreadyExists.into(),
        _ => {
            // SAFETY: this only converts a native status into a Win32 error.
            let code = unsafe { RtlNtStatusToDosError(status) };
            io::Error::from_raw_os_error(i32::try_from(code).unwrap_or(i32::MAX))
        }
    }
}

fn open_relative(
    parent: &File,
    name: &OsStr,
    access: u32,
    disposition: u32,
    file_type: u32,
) -> io::Result<File> {
    let mut wide = checked_name(name)?;
    let byte_len = wide.len() * size_of::<u16>();
    let unicode = UnicodeString {
        length: u16::try_from(byte_len).expect("checked Windows name length"),
        maximum_length: u16::try_from(byte_len).expect("checked Windows name length"),
        buffer: wide.as_mut_ptr(),
    };
    let attributes = ObjectAttributes {
        length: u32::try_from(size_of::<ObjectAttributes>()).expect("fixed Windows structure"),
        root_directory: parent.as_raw_handle(),
        object_name: &raw const unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: ptr::null(),
        security_quality_of_service: ptr::null(),
    };
    let mut status_block = IoStatusBlock::default();
    let mut handle = ptr::null_mut();
    // SAFETY: all input structures have the documented Win32 layout, and the
    // name and parent handle remain valid until NtCreateFile returns.
    let status = unsafe {
        NtCreateFile(
            &raw mut handle,
            access,
            &raw const attributes,
            &raw mut status_block,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_ALL,
            disposition,
            file_type | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if status < 0 {
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            // SAFETY: the native call can return an owned handle on failure.
            drop(unsafe { File::from_raw_handle(handle) });
        }
        return Err(nt_error(status));
    }
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::other("NtCreateFile returned no handle"));
    }
    // SAFETY: NtCreateFile returned a new owned valid handle.
    let file = unsafe { File::from_raw_handle(handle) };
    // Ordinary filesystems need no tag query. This also keeps Cloud Files
    // placeholders compatible when their filter hides the reparse attribute.
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(file);
    }
    let mut tag = FileAttributeTagInfo::default();
    // SAFETY: tag is a correctly laid out writable output structure and the
    // opened file handle stays live for this call.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            (&raw mut tag).cast(),
            u32::try_from(size_of::<FileAttributeTagInfo>()).expect("fixed Windows structure"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if tag.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 || tag.reparse_tag == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed diagnostic path has an unknown reparse tag",
        ));
    }
    if tag.reparse_tag & NAME_SURROGATE_BIT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed diagnostic path is a linked name surrogate",
        ));
    }
    Ok(file)
}

fn checked_name(name: &OsStr) -> io::Result<Vec<u16>> {
    let wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty()
        || name == OsStr::new(".")
        || name == OsStr::new("..")
        || wide.len() > usize::from(u16::MAX) / size_of::<u16>()
        || wide
            .iter()
            .any(|unit| matches!(*unit, 0 | 0x002f | 0x003a | 0x005c))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "diagnostic file name is not a single component",
        ));
    }
    Ok(wide)
}

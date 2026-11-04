//! Private diagnostic files, opened relative to their managed directory.
//! The directory handle keeps open, rotation, and permission repair on the
//! same directory even when its pathname changes between operations.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io;
#[cfg(unix)]
use std::path::Component;
use std::path::Path;
#[cfg(not(unix))]
use std::path::PathBuf;

pub(crate) struct LogDir {
    #[cfg(unix)]
    dir: File,
    #[cfg(not(unix))]
    path: PathBuf,
}

#[derive(Clone, Copy)]
pub(crate) enum DirectoryMode {
    Inherited,
    OwnerOnly,
}

impl DirectoryMode {
    fn create(self, path: &Path) -> io::Result<()> {
        match self {
            Self::Inherited => fs::create_dir_all(path),
            Self::OwnerOnly => super::perms::create_dir_all_private(path),
        }
    }

    #[cfg(unix)]
    fn bits(self) -> u32 {
        match self {
            Self::Inherited => 0o777,
            Self::OwnerOnly => super::perms::PRIVATE_DIR_MODE,
        }
    }
}

impl LogDir {
    /// On Unix, the configured root may itself be a symlink. Every managed
    /// component below it is created and opened relative to its held handle,
    /// without following links or re-resolving an ancestor pathname.
    pub(crate) fn for_write(
        path: &Path,
        trusted_root: &Path,
        mode: DirectoryMode,
    ) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use nix::fcntl::{openat, OFlag};
            use nix::sys::stat::{mkdirat, Mode};
            use std::os::fd::{AsRawFd, FromRawFd};

            mode.create(trusted_root)?;
            // A directory needs search, not read, permission for create and
            // openat. O_PATH on Linux (O_SEARCH on macOS) preserves roots that
            // users deliberately make write/search-only.
            #[cfg(any(target_os = "linux", target_os = "android"))]
            let access = OFlag::O_PATH;
            #[cfg(target_os = "macos")]
            let access = OFlag::from_bits_retain(libc::O_SEARCH);
            // Other Unix targets retain the prior read requirement until
            // their search-only directory-open flag is verified there.
            #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
            let access = OFlag::O_RDONLY;
            let root_flags = access | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC;
            let root_fd =
                openat(None, trusted_root, root_flags, Mode::empty()).map_err(errno_to_io)?;
            // SAFETY: openat returned a new owned descriptor, transferred to File once.
            let mut dir = unsafe { File::from_raw_fd(root_fd) };
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
                let dir_mode = Mode::from_bits_truncate(mode.bits());
                match mkdirat(Some(dir.as_raw_fd()), name, dir_mode) {
                    Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                    Err(errno) => return Err(errno_to_io(errno)),
                }
                let fd = openat(
                    Some(dir.as_raw_fd()),
                    name,
                    access | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(errno_to_io)?;
                // SAFETY: openat returned a new owned descriptor, transferred to File once.
                dir = unsafe { File::from_raw_fd(fd) };
            }
            Ok(Self { dir })
        }
        #[cfg(not(unix))]
        {
            let _ = trusted_root;
            mode.create(path)?;
            Self::for_read(path)
        }
    }

    #[cfg(not(unix))]
    fn for_read(path: &Path) -> io::Result<Self> {
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "managed log directory is a symbolic link",
            ));
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    pub(crate) fn open_append(&self, name: &OsStr) -> io::Result<File> {
        self.open(name, true)
    }

    /// Repair a pre-existing retained log without touching a link target.
    pub(crate) fn repair_existing(&self, name: &OsStr) -> io::Result<()> {
        let file = self.open(name, false)?;
        super::perms::restrict_open_file(&file)
    }

    fn open(&self, name: &OsStr, append: bool) -> io::Result<File> {
        #[cfg(unix)]
        let file = {
            use nix::fcntl::{openat, OFlag};
            use nix::sys::stat::Mode;
            use std::os::fd::{AsRawFd, FromRawFd};

            let access = if append {
                OFlag::O_WRONLY | OFlag::O_APPEND | OFlag::O_CREAT
            } else {
                OFlag::O_RDONLY
            };
            let flags = access | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
            let fd = openat(
                Some(self.dir.as_raw_fd()),
                name,
                flags,
                Mode::from_bits_truncate(super::perms::PRIVATE_FILE_MODE),
            )
            .map_err(errno_to_io)?;
            // SAFETY: openat returned a new owned descriptor, transferred to File once.
            unsafe { File::from_raw_fd(fd) }
        };
        #[cfg(not(unix))]
        let file = {
            let path = self.path.join(name);
            if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "managed log file is a symbolic link",
                ));
            }
            let mut options = fs::OpenOptions::new();
            if append {
                options.create(true).append(true);
                super::perms::set_private_mode(&mut options);
            } else {
                options.read(true);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
            }
            let file = options.open(&path)?;
            if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "managed log file is a symbolic link",
                ));
            }
            file
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "managed log is not a regular file",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() > 1 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "managed log has multiple hard links",
                ));
            }
        }
        if append {
            super::perms::restrict_open_file(&file)?;
        }
        Ok(file)
    }

    pub(crate) fn rename(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            nix::fcntl::renameat(
                Some(self.dir.as_raw_fd()),
                from,
                Some(self.dir.as_raw_fd()),
                to,
            )
            .map_err(errno_to_io)
        }
        #[cfg(not(unix))]
        {
            fs::rename(self.path.join(from), self.path.join(to))
        }
    }

    pub(crate) fn remove(&self, name: &OsStr) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            nix::unistd::unlinkat(
                Some(self.dir.as_raw_fd()),
                name,
                nix::unistd::UnlinkatFlags::NoRemoveDir,
            )
            .map_err(errno_to_io)
        }
        #[cfg(not(unix))]
        {
            fs::remove_file(self.path.join(name))
        }
    }
}

#[cfg(unix)]
fn errno_to_io(errno: nix::errno::Errno) -> io::Error {
    io::Error::from_raw_os_error(errno as i32)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn directory_handle_keeps_log_operations_in_the_original_directory() {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        let dir = LogDir::for_write(&logs, root.path(), DirectoryMode::Inherited).unwrap();
        let original = root.path().join("original-logs");
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let victim = outside.join("agent.log");
        fs::write(&victim, b"outside\n").unwrap();

        fs::rename(&logs, &original).unwrap();
        std::os::unix::fs::symlink(&outside, &logs).unwrap();
        dir.open_append(OsStr::new("agent.log"))
            .unwrap()
            .write_all(b"inside\n")
            .unwrap();
        assert_eq!(fs::read(original.join("agent.log")).unwrap(), b"inside\n");
        assert_eq!(fs::read(&victim).unwrap(), b"outside\n");

        dir.rename(OsStr::new("agent.log"), OsStr::new("agent.log.old"))
            .unwrap();
        assert!(original.join("agent.log.old").exists());
        dir.remove(OsStr::new("agent.log.old")).unwrap();
        assert!(!original.join("agent.log.old").exists());
        assert_eq!(fs::read(&victim).unwrap(), b"outside\n");
    }

    #[test]
    fn linked_agent_root_can_still_contain_managed_logs() {
        let root = tempfile::tempdir().unwrap();
        let real_agent = root.path().join("real-agent");
        fs::create_dir(&real_agent).unwrap();
        let linked_agent = root.path().join("agent");
        std::os::unix::fs::symlink(&real_agent, &linked_agent).unwrap();

        let dir = LogDir::for_write(
            &linked_agent.join("logs"),
            &linked_agent,
            DirectoryMode::Inherited,
        )
        .unwrap();
        dir.open_append(OsStr::new("agent.log"))
            .unwrap()
            .write_all(b"inside\n")
            .unwrap();
        assert_eq!(
            fs::read(real_agent.join("logs/agent.log")).unwrap(),
            b"inside\n"
        );
    }

    #[test]
    fn search_only_agent_root_can_contain_managed_logs() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        fs::create_dir(&agent).unwrap();
        fs::set_permissions(&agent, fs::Permissions::from_mode(0o300)).unwrap();
        let opened = LogDir::for_write(&agent.join("logs"), &agent, DirectoryMode::Inherited);
        fs::set_permissions(&agent, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(opened.is_ok(), "agent root needs search, not read");
        assert!(agent.join("logs").is_dir());
    }
}

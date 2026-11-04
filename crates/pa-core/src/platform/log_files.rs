//! Private diagnostic files, opened relative to their managed directory.
//! The directory handle keeps open, rotation, and permission repair on the
//! same directory even when its pathname changes between operations.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io;
use std::path::Path;
#[cfg(not(unix))]
use std::path::PathBuf;

pub(crate) struct LogDir {
    #[cfg(unix)]
    dir: File,
    #[cfg(not(unix))]
    path: PathBuf,
}

impl LogDir {
    pub(crate) fn for_write(path: &Path) -> io::Result<Self> {
        fs::create_dir_all(path)?;
        Self::for_read(path)
    }

    fn for_read(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            let mut options = fs::OpenOptions::new();
            options
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
            Ok(Self {
                dir: options.open(path)?,
            })
        }
        #[cfg(not(unix))]
        {
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
        let dir = LogDir::for_write(&logs).unwrap();
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

        let dir = LogDir::for_write(&linked_agent.join("logs")).unwrap();
        dir.open_append(OsStr::new("agent.log"))
            .unwrap()
            .write_all(b"inside\n")
            .unwrap();
        assert_eq!(
            fs::read(real_agent.join("logs/agent.log")).unwrap(),
            b"inside\n"
        );
    }
}

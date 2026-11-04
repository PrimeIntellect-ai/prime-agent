//! Log-file operations anchored to the opened directory on Unix.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenMode {
    Read,
    Append,
    Write,
}

pub(crate) struct LogDir {
    #[cfg(unix)]
    fd: File,
    #[cfg(not(unix))]
    path: std::path::PathBuf,
}

impl LogDir {
    pub(crate) fn for_write(path: &Path) -> io::Result<Self> {
        fs::create_dir_all(path)?;
        Self::for_read(path)
    }

    pub(crate) fn restrict(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            self.fd.set_permissions(fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        pa_core::platform::perms::restrict_dir(&self.path)?;
        Ok(())
    }

    pub(crate) fn for_read(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use rustix::fs::{openat, Mode, OFlags, CWD};

            let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            let fd = openat(CWD, path, flags, Mode::empty())?;
            Ok(Self { fd: File::from(fd) })
        }
        #[cfg(not(unix))]
        {
            fs::metadata(path)?;
            Ok(Self {
                path: path.to_path_buf(),
            })
        }
    }

    pub(crate) fn open_file(&self, name: &OsStr, mode: OpenMode) -> io::Result<File> {
        #[cfg(unix)]
        let file = {
            use rustix::fs::{openat, Mode, OFlags};

            let flags = match mode {
                OpenMode::Read => OFlags::RDONLY | OFlags::NONBLOCK,
                OpenMode::Append => OFlags::WRONLY | OFlags::APPEND | OFlags::CREATE,
                OpenMode::Write => OFlags::WRONLY | OFlags::CREATE,
            } | OFlags::NOFOLLOW
                | OFlags::CLOEXEC;
            File::from(openat(&self.fd, name, flags, Mode::from_raw_mode(0o600))?)
        };
        #[cfg(not(unix))]
        let file = {
            let mut options = fs::OpenOptions::new();
            match mode {
                OpenMode::Read => {
                    options.read(true);
                }
                OpenMode::Append => {
                    options.create(true).append(true);
                }
                OpenMode::Write => {
                    options.create(true).write(true);
                }
            }
            options.open(self.path.join(name))?
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            if file.metadata()?.nlink() > 1 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "diagnostic log has multiple hard links",
                ));
            }
        }
        if mode != OpenMode::Read {
            pa_core::platform::perms::restrict_open_file(&file)?;
        }
        Ok(file)
    }

    pub(crate) fn rename(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
        #[cfg(unix)]
        {
            rustix::fs::renameat(&self.fd, from, &self.fd, to)?;
        }
        #[cfg(not(unix))]
        {
            fs::rename(self.path.join(from), self.path.join(to))?;
        }
        Ok(())
    }

    pub(crate) fn remove(&self, name: &OsStr) -> io::Result<()> {
        #[cfg(unix)]
        {
            rustix::fs::unlinkat(&self.fd, name, rustix::fs::AtFlags::empty())?;
        }
        #[cfg(not(unix))]
        {
            fs::remove_file(self.path.join(name))?;
        }
        Ok(())
    }

    pub(crate) fn names(&self) -> io::Result<Vec<OsString>> {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;

            let entries = rustix::fs::Dir::read_from(&self.fd)?;
            Ok(entries
                .filter_map(Result::ok)
                .map(|entry| OsString::from_vec(entry.file_name().to_bytes().to_vec()))
                .collect())
        }
        #[cfg(not(unix))]
        {
            Ok(fs::read_dir(&self.path)?
                .filter_map(Result::ok)
                .map(|entry| entry.file_name())
                .collect())
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn directory_handle_keeps_log_operations_in_the_original_directory() {
        let temp = tempfile::tempdir().unwrap();
        let logs = temp.path().join("logs");
        let dir = LogDir::for_write(&logs).unwrap();
        let original = temp.path().join("original-logs");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("worker-a.stderr.log"), b"outside\n").unwrap();
        std::fs::write(outside.join("foreign-only.log"), b"outside\n").unwrap();

        std::fs::rename(&logs, &original).unwrap();
        std::os::unix::fs::symlink(&outside, &logs).unwrap();
        let mut file = dir
            .open_file(OsStr::new("worker-a.stderr.log"), OpenMode::Write)
            .unwrap();
        file.write_all(b"inside\n").unwrap();
        drop(file);
        let names = dir.names().unwrap();
        assert!(names.contains(&OsString::from("worker-a.stderr.log")));
        assert!(!names.contains(&OsString::from("foreign-only.log")));
        dir.rename(
            OsStr::new("worker-a.stderr.log"),
            OsStr::new("worker-a.stderr.log.1"),
        )
        .unwrap();
        dir.remove(OsStr::new("worker-a.stderr.log.1")).unwrap();

        assert!(!original.join("worker-a.stderr.log.1").exists());
        assert_eq!(
            std::fs::read(outside.join("worker-a.stderr.log")).unwrap(),
            b"outside\n"
        );
    }
}

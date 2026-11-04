//! Log-file operations anchored to the opened directory on Unix.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io;
use std::path::Path;

#[cfg(all(test, unix))]
thread_local! {
    static BEFORE_LOGS_DIRECTORY_CREATE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenMode {
    Read,
    Append,
    Write,
}

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum DirectoryCreation {
    ExistingOnly,
    CreateMissing,
}

pub(crate) struct LogDir {
    #[cfg(unix)]
    fd: File,
    #[cfg(not(unix))]
    path: std::path::PathBuf,
}

impl LogDir {
    pub(crate) fn for_write(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            Self::open_from_root(path, DirectoryCreation::CreateMissing)
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(path)?;
            Self::for_read(path)
        }
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
            Self::open_from_root(path, DirectoryCreation::ExistingOnly)
        }
        #[cfg(not(unix))]
        {
            fs::metadata(path)?;
            Ok(Self {
                path: path.to_path_buf(),
            })
        }
    }

    #[cfg(unix)]
    fn open_from_root(path: &Path, creation: DirectoryCreation) -> io::Result<Self> {
        use rustix::fs::{mkdirat, openat, Mode, OFlags, CWD};

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
        // The agent state root may be intentionally linked. Pin its target
        // before creating/opening the managed `logs` child.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let root_access = OFlags::PATH;
        #[cfg(target_os = "macos")]
        let root_access = OFlags::from_bits_retain(
            u32::try_from(libc::O_SEARCH).expect("Darwin O_SEARCH is nonnegative"),
        );
        // Other Unix targets retain the prior read requirement until their
        // search-only directory-open flag is verified on that platform.
        #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
        let root_access = OFlags::RDONLY;
        let root_fd = openat(
            CWD,
            root,
            root_access | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        if creation == DirectoryCreation::CreateMissing {
            #[cfg(test)]
            BEFORE_LOGS_DIRECTORY_CREATE.with(|hook| {
                if let Some(callback) = hook.borrow_mut().take() {
                    callback();
                }
            });
            match mkdirat(&root_fd, name, Mode::from_raw_mode(0o777)) {
                Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let fd = openat(
            &root_fd,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        Ok(Self { fd: File::from(fd) })
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

    #[test]
    fn root_swap_before_logs_creation_does_not_redirect_worker_logs() {
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        let original_agent = temp.path().join("original-agent");
        let outside = temp.path().join("outside");
        fs::create_dir(&agent).unwrap();
        fs::create_dir(&outside).unwrap();
        let logs = agent.join("logs");
        let moved_agent = agent;
        let moved_original = original_agent.clone();
        let linked_outside = outside.clone();
        BEFORE_LOGS_DIRECTORY_CREATE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&moved_agent, &moved_original).unwrap();
                std::os::unix::fs::symlink(&linked_outside, &moved_agent).unwrap();
            }));
        });

        let opened = LogDir::for_write(&logs);
        BEFORE_LOGS_DIRECTORY_CREATE.with(|hook| *hook.borrow_mut() = None);
        assert!(opened.is_ok());
        assert!(original_agent.join("logs").is_dir());
        assert!(!outside.join("logs").exists());
    }

    #[test]
    fn search_only_agent_root_can_contain_worker_logs() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        fs::create_dir(&agent).unwrap();
        fs::set_permissions(&agent, fs::Permissions::from_mode(0o300)).unwrap();
        let opened = LogDir::for_write(&agent.join("logs"));
        fs::set_permissions(&agent, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(opened.is_ok(), "agent root needs search, not read");
        assert!(agent.join("logs").is_dir());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn directory_swap_keeps_worker_log_operations_on_original_dir() {
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        fs::create_dir(&agent).unwrap();
        let logs = agent.join("logs");
        let dir = LogDir::for_write(&logs).unwrap();
        let original = agent.join("original-logs");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("worker-a.stderr.log"), b"outside\n").unwrap();

        fs::rename(&logs, &original).unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&logs)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");

        dir.open_file(OsStr::new("worker-a.stderr.log"), OpenMode::Write)
            .unwrap()
            .write_all(b"inside\n")
            .unwrap();
        assert_eq!(
            fs::read(original.join("worker-a.stderr.log")).unwrap(),
            b"inside\n"
        );
        assert_eq!(
            fs::read(outside.join("worker-a.stderr.log")).unwrap(),
            b"outside\n"
        );
    }
}

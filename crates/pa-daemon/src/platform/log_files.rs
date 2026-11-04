//! Log-file operations anchored to opened directories on Unix and Windows.

use std::ffi::{OsStr, OsString};
#[cfg(not(windows))]
use std::fs;
use std::fs::File;
use std::io;
use std::path::Path;

#[cfg(windows)]
// Native relative opens and held-handle metadata are unavailable in std.
#[allow(unsafe_code)]
#[path = "log_files/windows.rs"]
mod windows;

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

#[cfg(any(unix, windows))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum DirectoryCreation {
    ExistingOnly,
    CreateMissing,
}

pub(crate) struct LogDir {
    #[cfg(unix)]
    fd: File,
    #[cfg(windows)]
    dir: windows::AnchoredDir,
    #[cfg(not(any(unix, windows)))]
    path: std::path::PathBuf,
}

impl LogDir {
    pub(crate) fn for_write(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            Self::open_from_root(path, DirectoryCreation::CreateMissing)
        }
        #[cfg(windows)]
        {
            Ok(Self {
                dir: windows::AnchoredDir::open(path, DirectoryCreation::CreateMissing)?,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            fs::create_dir_all(path)?;
            Self::for_read(path)
        }
    }

    // Windows ACL inheritance makes this a no-op while callers retain the
    // same method shape as the Unix permission restriction.
    #[cfg_attr(windows, allow(clippy::unused_self))]
    pub(crate) fn restrict(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            use rustix::fs::{chmodat, AtFlags, Mode};

            // `fd` can be search-only. Resolve `.` from that held directory,
            // so repairing permissions cannot follow a swapped pathname.
            chmodat(&self.fd, ".", Mode::from_raw_mode(0o700), AtFlags::empty())?;
        }
        #[cfg(not(any(unix, windows)))]
        pa_core::platform::perms::restrict_dir(&self.path)?;
        Ok(())
    }

    pub(crate) fn for_read(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            Self::open_from_root(path, DirectoryCreation::ExistingOnly)
        }
        #[cfg(windows)]
        {
            Ok(Self {
                dir: windows::AnchoredDir::open(path, DirectoryCreation::ExistingOnly)?,
            })
        }
        #[cfg(not(any(unix, windows)))]
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
            root_access | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
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
        #[cfg(windows)]
        let file = self.dir.open_file(name, mode)?;
        #[cfg(not(any(unix, windows)))]
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
        #[cfg(windows)]
        {
            self.dir.rename(from, to)?;
        }
        #[cfg(not(any(unix, windows)))]
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
        #[cfg(windows)]
        {
            self.dir.remove(name)?;
        }
        #[cfg(not(any(unix, windows)))]
        {
            fs::remove_file(self.path.join(name))?;
        }
        Ok(())
    }

    pub(crate) fn names(&self) -> io::Result<Vec<OsString>> {
        #[cfg(unix)]
        {
            use rustix::fs::{openat, Mode, OFlags};
            use std::os::unix::ffi::OsStringExt;

            // Listing needs read permission. Open `.` relative to the pinned
            // directory only when requested; named opens need search alone.
            let listing_fd = openat(
                &self.fd,
                ".",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )?;
            let entries = rustix::fs::Dir::read_from(&listing_fd)?;
            Ok(entries
                .filter_map(Result::ok)
                .map(|entry| OsString::from_vec(entry.file_name().to_bytes().to_vec()))
                .collect())
        }
        #[cfg(windows)]
        {
            self.dir.names()
        }
        #[cfg(not(any(unix, windows)))]
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
    use std::io::Read as _;
    use std::io::Write as _;

    #[test]
    fn directory_handle_keeps_log_operations_in_the_original_directory() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let logs = temp.path().join("logs");
        let dir = LogDir::for_write(&logs).unwrap();
        let original = temp.path().join("original-logs");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(outside.join("worker-a.stderr.log"), b"outside\n").unwrap();
        std::fs::write(outside.join("foreign-only.log"), b"outside\n").unwrap();

        std::fs::rename(&logs, &original).unwrap();
        std::os::unix::fs::symlink(&outside, &logs).unwrap();
        dir.restrict().unwrap();
        assert_eq!(
            fs::metadata(&original).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o755
        );
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

    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    #[test]
    fn existing_search_write_only_logs_allow_named_access_and_repair() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let logs = temp.path().join("agent/logs");
        fs::create_dir_all(&logs).unwrap();
        let name = OsStr::new("worker-a.stderr.log");
        fs::write(logs.join(name), b"initial").unwrap();
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o300)).unwrap();

        let read = LogDir::for_read(&logs);
        let write = LogDir::for_write(&logs);
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o700)).unwrap();
        let read = read.expect("named reads need search, not directory listing");
        let write = write.expect("named writes need search, not directory listing");

        fs::set_permissions(&logs, fs::Permissions::from_mode(0o300)).unwrap();
        let named_read = read.open_file(name, OpenMode::Read).and_then(|mut file| {
            let mut contents = String::new();
            file.read_to_string(&mut contents)?;
            Ok(contents)
        });
        let named_append = write
            .open_file(name, OpenMode::Append)
            .and_then(|mut file| file.write_all(b" appended"));
        let daemon_log = logs.join("daemon.sock.abcdef01.log");
        crate::paths::RotatingLog::new(daemon_log.clone()).append("ready");
        let denied_listing = write.names();
        let repaired = write.restrict();
        let repaired_listing = write.names();
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(named_read.unwrap(), "initial");
        named_append.unwrap();
        assert!(denied_listing.is_err());
        repaired.unwrap();
        assert!(repaired_listing.unwrap().contains(&name.to_os_string()));
        assert_eq!(fs::read(logs.join(name)).unwrap(), b"initial appended");
        assert_eq!(fs::read_to_string(daemon_log).unwrap(), "ready\n");

        fs::set_permissions(&logs, fs::Permissions::from_mode(0o300)).unwrap();
        let worker_path = crate::worker_stderr::log_path(&temp.path().join("agent"), "b");
        let spawned_log = crate::worker_stderr::open_for_spawn(&worker_path);
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o700)).unwrap();
        drop(spawned_log.unwrap());
        assert!(worker_path.exists());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::fs;
    use std::io::Write as _;

    #[test]
    fn repeated_names_calls_start_at_the_beginning() {
        let temp = tempfile::tempdir().unwrap();
        let dir = LogDir::for_write(&temp.path().join("logs")).unwrap();
        dir.open_file(OsStr::new("worker-a.stderr.log"), OpenMode::Write)
            .unwrap();

        let expected = vec![OsString::from("worker-a.stderr.log")];
        assert_eq!(dir.names().unwrap(), expected);
        assert_eq!(dir.names().unwrap(), expected);
    }

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
        fs::write(outside.join("foreign-only.log"), b"outside\n").unwrap();

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
            fs::read(outside.join("worker-a.stderr.log")).unwrap(),
            b"outside\n"
        );
    }
}

//! Unix file-open flags used by daemon-owned persistence paths.

use std::fs::OpenOptions;
use std::io;

pub(crate) fn reject_final_symlink(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.custom_flags(libc::O_NOFOLLOW);
}

pub(crate) fn is_no_follow_link_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ELOOP)
}

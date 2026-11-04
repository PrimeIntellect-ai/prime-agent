//! pa-daemon platform wall: per-OS endpoint naming and identity. The
//! transport itself is the shared trait in `pa_types::platform` (daemon
//! sockets bind/connect through it, so named pipes slot in without
//! touching the supervisor or worker loops).

#[cfg(unix)]
mod file_open;
mod paths;

#[cfg(unix)]
pub(crate) use file_open::{is_no_follow_link_error, reject_final_symlink};

pub use paths::{
    default_daemon_socket_path, socket_dir, socket_identity, worker_socket_path, SocketIdentity,
};

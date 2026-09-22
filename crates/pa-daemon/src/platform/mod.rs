//! pa-daemon platform wall: per-OS endpoint naming and identity. The
//! transport itself is the shared trait in `pa_types::platform` (daemon
//! sockets bind/connect through it, so named pipes slot in without touching
//! the supervisor or worker loops).

mod paths;

pub use paths::{
    default_daemon_socket_path, socket_dir, socket_identity, worker_socket_path, SocketIdentity,
};

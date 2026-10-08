//! Cross-crate platform contracts: transport, process identity, and home-dir resolution. pa-types
//! is
//! the only crate every platform consumer can depend on, so the shared platform traits live here;
//! implementations are cfg-gated per platform, and call sites never branch on `cfg` themselves.

pub mod dirs;
pub mod identity;
pub mod process;
pub mod terminal;
pub mod transport;
pub mod windows_console;
#[cfg(windows)]
pub(crate) mod windows_pipe;

pub use dirs::{agent_dir, home_dir};
pub use windows_console::{init as console_init, restore as console_restore};
pub use identity::socket_identity;
pub use process::{
    ignore_sigint_for_suspend, is_process_alive, process_start_id, restore_default_sigint,
    stop_own_process_group,
};
pub use transport::{
    bind_transport, connect_blocking, connect_transport, BlockingTransportStream,
    TransportListener, TransportStream,
};

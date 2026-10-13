//! The supervisor's spawn configuration and client-routing mode.

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct SupervisorOptions {
    pub socket_path: PathBuf,
    pub agent_dir: PathBuf,
}

/// Which clients a worker outbound frame reaches. Session events do not ride this
/// routing: the subscriber registry resolves their delivery set at publish time (TS
/// parity). The variants are the ring's broadcast classes only.
#[derive(Debug, Clone)]
pub(crate) enum ClientRouting {
    /// Every connected client (e.g. `daemon_closing`).
    Broadcast,
    /// Every connected client except one: the shutdown initiator receives its
    /// `daemon_closing` through the command response instead.
    BroadcastExcept { connection_id: String },
    /// Clients holding a roster subscription (`roster_subscribe`).
    RosterSubscribers,
}

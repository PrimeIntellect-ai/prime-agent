//! The supervisor's spawn configuration and client-routing mode.

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct SupervisorOptions {
    pub socket_path: PathBuf,
    pub agent_dir: PathBuf,
}

/// Which clients a worker outbound frame reaches.
#[derive(Debug, Clone)]
pub(crate) enum ClientRouting {
    /// Every connected client (e.g. `daemon_closing`).
    Broadcast,
    /// Every connected client except one (the shutdown initiator receives its
    /// `daemon_closing` through the command response instead, so the
    /// broadcast cannot overtake that response or duplicate the frame).
    BroadcastExcept { connection_id: String },
    /// Clients attached to the session.
    AttachedSession { active_session_id: String },
    /// Clients holding a roster subscription (`roster_subscribe`).
    RosterSubscribers,
}

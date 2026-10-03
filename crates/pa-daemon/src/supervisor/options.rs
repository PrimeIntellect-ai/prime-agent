//! The supervisor's spawn configuration and client-routing mode.

use std::path::PathBuf;

use crate::remote_mesh::RemoteAgentMeshOptions;

#[derive(Debug, Clone)]
pub struct SupervisorOptions {
    pub socket_path: PathBuf,
    pub agent_dir: PathBuf,
    /// Explicit `--daemon-port` override; the env var, settings, and the
    /// fail-closed bind policy resolve inside the supervisor (TS #2517).
    pub tcp_port: Option<u16>,
    /// Explicit `--daemon-bind` override; env, settings, and the tailnet
    /// probe resolve inside the supervisor.
    pub tcp_bind_host: Option<String>,
    /// Tailnet remote-agent mesh seams (TS #2516). `None` serves a local
    /// roster only; production discovery wiring ships with the mesh
    /// integration PR (TS stack 5/5).
    pub remote_agent_mesh: Option<RemoteAgentMeshOptions>,
}

/// Which clients a worker outbound frame reaches.
///
/// Session events do not ride this routing: the subscriber registry
/// resolves their delivery set at publish time (TS `handleWorkerFrame`
/// parity), so an unattached connection never wakes for them. The variant
/// set below is the ring's broadcast classes only — a stale session-event
/// publish fails at compile time instead of silently waking the ring.
#[derive(Debug, Clone)]
pub(crate) enum ClientRouting {
    /// Every connected client (e.g. `daemon_closing`).
    Broadcast,
    /// Every connected client except one (the shutdown initiator receives its
    /// `daemon_closing` through the command response instead, so the
    /// broadcast cannot overtake that response or duplicate the frame).
    BroadcastExcept { connection_id: String },
    /// Clients holding a roster subscription (`roster_subscribe`).
    RosterSubscribers,
}

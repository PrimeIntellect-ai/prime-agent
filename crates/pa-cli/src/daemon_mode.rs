//! `--mode daemon`: the supervisor process. The interactive client spawns
//! this mode (detached) when no daemon is listening, so `prime-agent` alone
//! is enough to bring the full session stack up (port of the TS
//! `daemon-mode.ts` entry: the CLI process becomes the supervisor).

use anyhow::Result;

use crate::config;

/// The daemon-mode runtime's TCP listener flags (TS #2517): the
/// `--daemon-port` / `--daemon-bind` CLI overrides the supervisor
/// resolves first (flag > env > settings > the tailnet probe).
#[derive(Debug, Clone, Default)]
pub struct DaemonTcpFlags {
    pub port: Option<u16>,
    pub bind_host: Option<String>,
}

/// Run the daemon supervisor in-process until it shuts down.
pub fn run_daemon_mode(daemon_socket: Option<&str>, tcp: &DaemonTcpFlags) -> Result<i32> {
    let socket_path = config::resolve_daemon_socket_path(daemon_socket);
    let agent_dir = config::get_agent_dir();
    let options = pa_daemon::supervisor::SupervisorOptions {
        socket_path,
        agent_dir,
        tcp_port: tcp.port,
        tcp_bind_host: tcp.bind_host.clone(),
        // The tailnet remote-agent mesh (TS #2516) is a supervisor seam:
        // production discovery wiring ships with the mesh integration
        // (TS stack 5/5), so the CLI starts the supervisor local-roster
        // only.
        remote_agent_mesh: None,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(pa_daemon::supervisor::run_supervisor(options))?;
    Ok(0)
}

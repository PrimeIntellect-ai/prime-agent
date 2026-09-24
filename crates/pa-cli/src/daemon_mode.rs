//! `--mode daemon`: the supervisor process. The interactive client spawns
//! this mode (detached) when no daemon is listening, so `prime-agent` alone
//! is enough to bring the full session stack up (port of the TS
//! `daemon-mode.ts` entry: the CLI process becomes the supervisor).

use anyhow::Result;

use crate::config;

/// Run the daemon supervisor in-process until it shuts down.
pub fn run_daemon_mode(daemon_socket: Option<&str>) -> Result<i32> {
    let socket_path = config::resolve_daemon_socket_path(daemon_socket);
    let agent_dir = config::get_agent_dir();
    let options = pa_daemon::supervisor::SupervisorOptions {
        socket_path,
        agent_dir,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(pa_daemon::supervisor::run_supervisor(options))?;
    Ok(0)
}

//! pa-cli: the `prime-agent` binary. The argument surface, command routing,
//! help output, and validation are faithful ports of the TypeScript product's
//! `packages/coding-agent/src/main.ts` and `src/cli/*.ts`. Runtime execution
//! lives behind the [`mode::Runtime`] boundary.

// Internal ported modules are crate-private: the only public API is the
// runtime boundary below (see crates/pa-cli/README.md).
pub(crate) mod args;
pub(crate) mod client_settings;
pub(crate) mod client_traces;
pub(crate) mod client_update;
pub(crate) mod command_registry;
pub(crate) mod config;
pub(crate) mod config_command;
pub(crate) mod daemon_client;
pub(crate) mod daemon_command;
pub(crate) mod daemon_discovery;
pub(crate) mod daemon_mode;
pub(crate) mod daemon_session_list;
pub(crate) mod global_flags;
pub(crate) mod headless_autonomous;
pub(crate) mod initial_message;
pub(crate) mod interactive_mode;
pub(crate) mod list_models;
pub(crate) mod mcp_command;
pub(crate) mod mcp_login;
pub(crate) mod mode;
pub(crate) mod package_command;
pub(crate) mod prompt_command;
pub(crate) mod provider_login;
pub(crate) mod public_command;
pub(crate) mod session_export;

/// The runtime boundary: everything a mode-runner crate implements to plug
/// into the `prime-agent` binary, plus the entry point that drives it.
pub use mode::{AppMode, MissingSubsystem, RunOptions, Runtime, UnavailableRuntime};
pub(crate) mod print_autonomous;
pub(crate) mod print_boundary;
pub(crate) mod print_goal;
pub mod print_runtime;
pub(crate) mod print_session_command;
pub mod update_flow;
pub mod util_time;
pub use print_runtime::PrintRuntime;

/// Daemon wiring shared by the interactive runtime and the integration
/// tests: spawn/probe the supervisor on a socket, and map `--daemon-socket`.
pub use interactive_mode::{
    ensure_daemon_running, ensure_daemon_running_with, resolve_socket_path,
};

/// Entry point shared by the binary and the integration tests. Returns the
/// process exit code.
pub fn main_with_runtime(args: Vec<String>, runtime: &dyn mode::Runtime) -> i32 {
    match main_impl(args, runtime) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

fn main_impl(args: Vec<String>, runtime: &dyn mode::Runtime) -> Result<i32, String> {
    use std::io::IsTerminal;

    let offline_mode = args.iter().any(|arg| arg == "--offline")
        || crate::config::is_truthy_env_flag(
            std::env::var(crate::config::ENV_OFFLINE).ok().as_deref(),
        );
    if offline_mode {
        std::env::set_var(crate::config::ENV_OFFLINE, "1");
    }

    // Install-time kernel preparation (TS cli-main.ts): the installer invokes
    // `prime-agent --prime-agent-bootstrap` after extracting a release, so
    // the venv is ready before the first session.
    if args.len() == 1 && args[0] == "--prime-agent-bootstrap" {
        return run_runtime_bootstrap();
    }

    // Public command routing: help requests, removed commands, management
    // commands, and the model/session rewrites.
    let public_command = public_command::handle_public_command(&args);
    if public_command.handled {
        return Ok(public_command.exit_code.unwrap_or(0));
    }
    let args = public_command.args;

    if args.first().map(String::as_str) == Some("config") {
        return Ok(crate::config_command::run());
    }

    let parsed = args::parse_args(&args);
    if !parsed.diagnostics.is_empty() {
        for diagnostic in &parsed.diagnostics {
            let label = if diagnostic.is_error {
                "Error"
            } else {
                "Warning"
            };
            eprintln!("{label}: {}", diagnostic.message);
        }
        if parsed.diagnostics.iter().any(|d| d.is_error) {
            return Ok(1);
        }
    }

    let app_mode = mode::AppMode::resolve(&parsed, std::io::stdin().is_terminal());

    if public_command.attach_agent.is_some() && app_mode != mode::AppMode::Interactive {
        return Err("attach requires an interactive terminal".to_string());
    }
    if parsed.resume_bare && app_mode != mode::AppMode::Interactive {
        return Err(
            "--resume without a session selector requires an interactive terminal".to_string(),
        );
    }

    if parsed.version {
        println!("{}", crate::config::version());
        return Ok(0);
    }
    if parsed.help {
        println!("{}", command_registry::format_top_level_help());
        return Ok(0);
    }

    if parsed.export.is_some() {
        // The TS product only reaches the export subsystem through the
        // `session export <file> [output]` rewrite; a standalone `--export`
        // already exited as a removed-flag diagnostic above.
        return session_export::run(&parsed, &crate::config::get_agent_dir());
    }

    if matches!(
        parsed.mode,
        Some(args::Mode::Rpc) | Some(args::Mode::Daemon)
    ) && !parsed.file_args.is_empty()
    {
        return Err("@file arguments are not supported in RPC or daemon mode".to_string());
    }

    // Daemon worker processes start with the worker role env var set (TS
    // `isDaemonWorkerProcess`, scoped to daemon-mode argv, checked after the
    // shared mode validations): route straight into the worker runtime. The
    // supervisor launches workers as `prime-agent worker`.
    let is_worker_process =
        std::env::var(pa_daemon::worker::WORKER_ROLE_ENV).unwrap_or_default() == "1";
    if is_worker_process
        && (args.first().map(String::as_str) == Some("worker")
            || args.windows(2).any(|pair| pair == ["--mode", "daemon"]))
    {
        return run_worker_mode();
    }

    if let Some(fork) = &parsed.fork {
        let mut conflicting_flags: Vec<&str> = Vec::new();
        if parsed.continue_ {
            conflicting_flags.push("--continue");
        }
        if parsed.has_resume() {
            conflicting_flags.push("--resume");
        }
        if parsed.no_session {
            conflicting_flags.push("--no-session");
        }
        if !conflicting_flags.is_empty() {
            return Err(format!(
                "--fork cannot be combined with {}",
                conflicting_flags.join(", ")
            ));
        }
        let _ = fork;
    }

    // cwd: chdir before anything cwd-bound runs.
    let cwd = match &parsed.cwd {
        Some(cwd) => {
            let cwd = crate::config::expand_tilde_path(cwd);
            let from = std::env::current_dir().map_err(|e| e.to_string())?;
            if let Err(error) = std::env::set_current_dir(&cwd) {
                return Err(format!(
                    "Cannot use cwd {}: {}",
                    cwd.display(),
                    node_style_error(
                        &error,
                        "chdir",
                        &from.display().to_string(),
                        &cwd.display().to_string()
                    )
                ));
            }
            std::env::current_dir().map_err(|e| e.to_string())?
        }
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };

    if crate::config::is_truthy_env_flag(
        std::env::var(crate::config::ENV_STARTUP_BENCHMARK)
            .ok()
            .as_deref(),
    ) && app_mode != mode::AppMode::Interactive
    {
        return Err("PI_STARTUP_BENCHMARK only supports interactive mode".to_string());
    }

    let agent_dir = crate::config::get_agent_dir();
    // Telemetry opt-in resolution (TS main.ts): env override, then settings.
    // The runtime config only carries the disabled case.
    let telemetry_disabled = crate::mode::telemetry_disabled(
        &pa_core::settings::SettingsManager::create(&cwd, &agent_dir),
    );
    let session_dir = parsed
        .session_dir
        .as_deref()
        .map(crate::config::expand_tilde_path)
        .or_else(crate::config::get_session_dir_env_override)
        // main.ts sessionDir resolution: the cwd-scoped settings manager is
        // consulted after the flag and env overrides, before the default.
        .or_else(|| pa_core::settings::SettingsManager::create(&cwd, &agent_dir).get_session_dir());

    let mut cli_messages = parsed.messages.clone();
    let initial_message =
        initial_message::build_initial_message(&mut cli_messages, None, None).initial_message;
    let options = mode::RunOptions {
        app_mode,
        config: mode::runtime_config_from_args(
            &parsed,
            cwd,
            agent_dir,
            session_dir.clone(),
            app_mode,
            telemetry_disabled,
        ),
        session: mode::SessionOptions {
            continue_recent: parsed.continue_,
            resume_bare: parsed.resume_bare,
            resume: parsed.resume.clone(),
            fork: parsed.fork.clone(),
            no_session: parsed.no_session,
            session_dir,
            cwd_from_flag: parsed.cwd.is_some(),
        },
        messages: cli_messages,
        initial_message,
        file_args: parsed.file_args.clone(),
        daemon_socket: parsed.daemon_socket.clone(),
        list_models: parsed.list_models,
        verbose: parsed.verbose,
        offline: parsed.offline,
        agents_view_requested: public_command.explicit_agents_view,
        attach_agent: public_command.attach_agent.clone(),
    };

    match runtime.run(&options) {
        Ok(exit_code) => Ok(exit_code),
        Err(missing) => Err(missing.error_message()),
    }
}

/// Prepare the kernel runtime at install time (TS `runtime-bootstrap.ts`):
/// resolve or bootstrap the kernel Python and print its path. Failures print
/// the bootstrap error text and exit 1 (the installer surfaces them and the
/// retry happens on first Python use).
fn run_runtime_bootstrap() -> Result<i32, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    match runtime.block_on(pa_core::kernel::ensure_kernel_python(
        pa_core::kernel::EnsureKernelPythonOptions::default(),
    )) {
        Ok(python) => {
            println!("kernel python: {}", python.display());
            Ok(0)
        }
        Err(error) => Err(format!("{error:#}")),
    }
}

/// Run the daemon session-worker runtime (the process the supervisor spawns
/// for each live session).
fn run_worker_mode() -> Result<i32, String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    match runtime.block_on(pa_daemon::worker::run_worker()) {
        Ok(()) => Ok(0),
        Err(error) => Err(format!("{error:#}")),
    }
}

/// Format an io error the way Node.js prints it for the same syscall, so the
/// `Error: Cannot use cwd <dir>: <message>` text matches the TS product.
fn node_style_error(error: &std::io::Error, syscall: &str, from: &str, to: &str) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            format!("ENOENT: no such file or directory, {syscall} '{from}' -> '{to}'")
        }
        std::io::ErrorKind::NotADirectory => {
            format!("ENOTDIR: not a directory, {syscall} '{from}' -> '{to}'")
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, {syscall} '{from}' -> '{to}'")
        }
        _ => error.to_string(),
    }
}

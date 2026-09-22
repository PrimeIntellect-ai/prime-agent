//! The composition root's `/update` child runner and relaunch (TS
//! `handleUpdateCommand`'s `spawnSync` + `tryExecUpdateRelaunch`): the
//! CLI child inherits the terminal, and a successful self-update replaces
//! this process with the updated launcher from the managed install root
//! (the child-relaunch fallback on exec failure is TS's).

use std::process::{Command, Stdio};

use pa_tui::update_command::{UpdateChildFuture, UpdateCommands};

/// Run the CLI child invocations and replace this process after a
/// self-update.
#[derive(Clone, Default)]
pub struct ClientUpdate;

impl ClientUpdate {
    /// The updated CLI's launcher (the install root's `prime-agent` link
    /// the update retargets); the running binary when this process is not
    /// under the installer's management (the child then runs from the same
    /// binary the user launched).
    fn updated_launcher() -> std::path::PathBuf {
        let Ok(current) = std::env::current_exe() else {
            return std::path::PathBuf::new();
        };
        pa_core::update::install::install_root_of(&current)
            .map(|root| root.join(pa_core::update::install::CURRENT_LAUNCHER))
            .unwrap_or(current)
    }

    fn cli_path() -> std::path::PathBuf {
        std::env::current_exe().unwrap_or_else(|_| "prime-agent".into())
    }
}

impl UpdateCommands for ClientUpdate {
    /// One CLI child run with inherited stdio (TS `spawnSync` with
    /// `stdio: "inherit"`): the updater's own output owns the terminal
    /// while it runs.
    fn run_cli_child(&self, args: Vec<String>) -> UpdateChildFuture {
        Box::pin(async move {
            let cli = Self::cli_path();
            let status = tokio::process::Command::new(&cli)
                .args(&args)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
                .await?;
            let code = status
                .code()
                .unwrap_or(if status.success() { 0 } else { 1 });
            Ok(code)
        })
    }

    /// Replace this process with the updated CLI (TS `tryExecUpdateRelaunch`
    /// over the updated launcher, then the child-relaunch fallback: spawn,
    /// wait, and exit with the child's code — the `exec` path never
    /// returns).
    fn relaunch(&self, args: Vec<String>) -> ! {
        let launcher = Self::updated_launcher();
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let mut command = Command::new(&launcher);
            command.args(&args);
            let error = command.exec();
            // exec only returns on failure: fall through to the child
            // relaunch with the failure reported (TS's catch).
            eprintln!("Could not replace the current Prime Agent process ({error}). Falling back to a child relaunch.");
        }
        #[cfg(not(unix))]
        {
            if !launcher.as_os_str().is_empty() {
                eprintln!("Could not replace the current Prime Agent process on this platform. Falling back to a child relaunch.");
            }
        }
        let result = Command::new(&launcher)
            .args(&args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();
        match result {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(error) => {
                eprintln!("Failed to relaunch Prime Agent: {error}");
                std::process::exit(1);
            }
        }
    }
}

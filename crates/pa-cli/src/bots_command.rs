//! `prime-agent bots github set|clear|status`: the GitHub token that bots
//! use. The token stays on this machine; bots get it through platform
//! header rules, never inside the sandbox.

use std::io::{BufRead, IsTerminal};
use std::path::Path;

use pa_daemon::bots::github;

use crate::config::get_agent_dir;

const USAGE: &str =
    "Usage: prime-agent bots github <set|clear|status> | prime-agent bots allow-spawns <bot>";

/// Run the `bots` command; returns the process exit code.
pub fn run_bots_command(args: &[String]) -> i32 {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let agent_dir = get_agent_dir();
    let result = match args.as_slice() {
        ["github", "set"] => set(&agent_dir),
        ["github", "clear"] => clear(&agent_dir),
        ["github", "status"] => {
            status(&agent_dir);
            Ok(())
        }
        ["allow-spawns", bot] => allow_spawns(bot),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

fn set(agent_dir: &Path) -> Result<(), String> {
    let token = if std::io::stdin().is_terminal() {
        eprint!("Paste a GitHub token (input is hidden): ");
        read_hidden_line().map_err(|error| error.to_string())?
    } else {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        line
    };
    github::store_token(agent_dir, token.trim()).map_err(|error| error.to_string())?;
    println!("Stored the GitHub token for bots. New bots use it.");
    Ok(())
}

/// Read one line from the terminal without echo.
fn read_hidden_line() -> std::io::Result<String> {
    use crossterm::event::{read, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
    crossterm::terminal::enable_raw_mode()?;
    let mut line = String::new();
    let read_line = loop {
        match read() {
            Ok(Event::Key(KeyEvent {
                code,
                modifiers,
                kind: KeyEventKind::Press,
                ..
            })) => match code {
                KeyCode::Enter => break Ok(()),
                KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
                    break Err(std::io::Error::other("cancelled"));
                }
                KeyCode::Char(c) => line.push(c),
                KeyCode::Backspace => {
                    line.pop();
                }
                _ => {}
            },
            Ok(Event::Paste(text)) => line.push_str(&text),
            Ok(_) => {}
            Err(error) => break Err(error),
        }
    };
    crossterm::terminal::disable_raw_mode()?;
    eprintln!();
    read_line.map(|()| line)
}

fn clear(agent_dir: &Path) -> Result<(), String> {
    // One critical section with the daemon's GitHub provisioning (the same
    // agent-dir lock): a bot spawn that planned before this clear must not
    // recreate the secrets after it.
    let github_lock = github::lock(agent_dir).map_err(|error| error.to_string())?;
    let stored = github::clear_token(agent_dir).map_err(|error| error.to_string())?;
    println!(
        "{}",
        if stored {
            "Removed the stored GitHub token."
        } else {
            "No GitHub token was stored."
        }
    );
    // Revoke the platform copy too, so running bots lose GitHub access.
    let platform_delete = delete_platform_secrets(agent_dir);
    drop(github_lock);
    match &platform_delete {
        Ok(0) => {}
        Ok(_) => println!("Deleted the bots' GitHub secrets on Prime."),
        Err(error) => {
            eprintln!("Warning: the bots' GitHub secrets on Prime were not deleted: {error:#}");
        }
    }
    if github::gh_cli_token().is_some() {
        println!(
            "New bots still use the gh CLI login. Set bots.github to false in settings.json to turn GitHub off."
        );
    }
    // A failed platform delete leaves running bots with GitHub access, so
    // the command fails instead of exiting 0.
    platform_delete
        .map(|_| ())
        .map_err(|error| format!("{error:#}"))
}

fn delete_platform_secrets(agent_dir: &Path) -> anyhow::Result<usize> {
    let (client, _) = pa_daemon::bots::prime_client(agent_dir)?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(github::delete_secrets(&client))
}

/// Give one running bot the ability to spawn bots without a respawn: the
/// platform rule that injects the owner's sandbox API key, the guest
/// settings and nested context, and the record flag.
fn allow_spawns(bot: &str) -> Result<(), String> {
    // The daemon owns the bots registry: the grant goes through it, so it
    // can never race a daemon write or be overwritten by one.
    use crate::daemon_client::DaemonClient;
    let socket = crate::config::resolve_daemon_socket_path(None);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime
        .block_on(async {
            let mut client = DaemonClient::connect(&socket).map_err(|error| error.to_string())?;
            let response = client
                .request_with_timeout(
                    pa_types::daemon::DaemonCommand::AllowBotSpawns {
                        id: None,
                        bot: bot.to_string(),
                        rest: serde_json::Map::default(),
                    },
                    16 * 60 * 1000,
                )
                .map_err(|error| error.to_string())?;
            if !response.success {
                return Err(response
                    .error
                    .unwrap_or_else(|| "the daemon refused".to_string()));
            }
            Ok(())
        })
        .map_err(|error: String| error)?;
    println!(
        "{bot} may now spawn bots. With this, any code in that bot can call the whole \
         Prime sandbox API as the owner; prefer a dedicated, sandbox-scoped API key."
    );
    Ok(())
}

fn status(agent_dir: &Path) {
    let enabled =
        pa_core::settings::SettingsManager::create(agent_dir, agent_dir).get_bots_github();
    println!("bots.github: {}", if enabled { "on" } else { "off" });
    match github::resolve_token(agent_dir) {
        Some((_, source)) => println!("token: {}", source.describe()),
        None => println!("token: none (run `{}`)", github::SET_TOKEN_COMMAND),
    }
    match github::git_identity(agent_dir) {
        Some(identity) => println!("git author: {} <{}>", identity.name, identity.email),
        None => {
            println!("git author: none (set bots.gitIdentity or git config --global user.name)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The engine reads process env (the Prime credential); the tests that
    /// touch it serialize on one lock.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Remove `PRIME_API_KEY` and restore it on drop, so even a failed
    /// assert leaves the environment as it was for the other tests.
    struct ScrubPrimeApiKey(Option<String>);

    impl ScrubPrimeApiKey {
        fn new() -> Self {
            let value = std::env::var("PRIME_API_KEY").ok();
            std::env::remove_var("PRIME_API_KEY");
            Self(value)
        }
    }

    impl Drop for ScrubPrimeApiKey {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("PRIME_API_KEY", value),
                None => std::env::remove_var("PRIME_API_KEY"),
            }
        }
    }

    /// A platform delete that fails must fail the `clear`: exiting 0 would
    /// leave running bots with GitHub access.
    #[test]
    fn a_failed_platform_delete_fails_the_clear() {
        let _env = env_lock();
        let _scrub = ScrubPrimeApiKey::new();
        let dir = tempfile::tempdir().unwrap();
        github::store_token(dir.path(), "ghp_test").unwrap();
        // No Prime credential in this agent dir: the platform delete fails.
        let error = clear(dir.path()).expect_err("the clear fails");
        assert!(error.contains("Prime API key"), "{error}");
        // The local removal still happened first.
        assert!(github::stored_token(dir.path()).is_none());
    }
}

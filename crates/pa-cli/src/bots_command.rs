//! `prime-agent bots github set|clear|status`: the GitHub token that bots
//! use. The token stays on this machine; bots get it through platform
//! header rules, never inside the sandbox.

use std::io::{BufRead, IsTerminal};
use std::path::Path;

use pa_daemon::bots::github;

use crate::config::get_agent_dir;

const USAGE: &str = "Usage: prime-agent bots github <set|clear|status>";

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
    match delete_platform_secrets(agent_dir) {
        Ok(0) => {}
        Ok(_) => println!("Deleted the bots' GitHub secrets on Prime."),
        Err(error) => {
            eprintln!("Warning: the bots' GitHub secrets on Prime were not deleted: {error}");
        }
    }
    if github::gh_cli_token().is_some() {
        println!(
            "New bots still use the gh CLI login. Set bots.github to false in settings.json to turn GitHub off."
        );
    }
    Ok(())
}

fn delete_platform_secrets(agent_dir: &Path) -> anyhow::Result<usize> {
    let (client, owner) = pa_daemon::bots::prime_client(agent_dir)?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(github::delete_secrets(&client, &owner))
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

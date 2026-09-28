//! The `prime-agent update` body: the TS->Rust migration path. One step —
//! the update downloads the latest `install-rust.sh` from the `rust`
//! branch and runs it; the script uninstalls the TypeScript version,
//! installs the latest Rust build, and never touches `~/.prime/agent`
//! (the sessions and configuration). The TUI's `/update` runs the same
//! core out-of-band (`client_update.rs`), so the two surfaces cannot
//! diverge. This command exists only in the Rust binary: the TypeScript
//! version does not have it — the move happens when the user runs the
//! installer's curl|sh URL (the README's Install section) or
//! `prime-agent update` (after the Rust install exists).

use pa_core::update::installer::{self, InstallerOutput};

/// One parsed `prime-agent update` invocation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateOptions {
    /// `--check`: print the latest available build vs the running
    /// binary's version, without installing.
    pub check: bool,
}

/// Run the update command: the funnel (the installer script owns the
/// whole move) or the `--check` report. Returns the process exit code.
pub fn run(options: &UpdateOptions) -> i32 {
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        eprintln!("Error: could not start the update runtime.");
        return 1;
    };
    if options.check {
        return runtime.block_on(run_check());
    }
    println!(
        "Updating to the latest Rust build ({} @ {})…",
        installer::repo(),
        installer::BRANCH
    );
    match runtime.block_on(installer::run_installer(InstallerOutput::Inherit)) {
        Ok(installed) => {
            match installed.version {
                Some(version) => {
                    println!("updated to {version} — restart prime-agent to run the new build");
                }
                None => {
                    println!(
                        "updated to the latest build — restart prime-agent to run the new build"
                    );
                }
            }
            0
        }
        Err(failure) => {
            eprintln!("Error: {}", failure.message);
            1
        }
    }
}

/// The `--check` report: the platform's build, the running binary's
/// version, the latest continuous run, and whether they match. Nothing
/// downloads.
async fn run_check() -> i32 {
    let running = crate::config::version();
    let target = match installer::current_target() {
        Ok(target) => target,
        Err(error) => {
            eprintln!("Error: {error:#}");
            return 1;
        }
    };
    println!("Platform: {target}");
    println!("Running:  {running}");
    match installer::latest_continuous_run().await {
        Ok(latest) => {
            println!(
                "Latest:   continuous run {} (commit {})",
                latest.id, latest.commit
            );
            let up_to_date =
                installer::running_commit(running).is_some_and(|commit| commit == latest.commit);
            println!("{}", check_verdict(up_to_date));
            0
        }
        Err(error) => {
            eprintln!("Error: could not resolve the latest continuous run: {error:#}");
            1
        }
    }
}

/// The `--check` verdict line.
fn check_verdict(up_to_date: bool) -> &'static str {
    if up_to_date {
        "Up to date."
    } else {
        "An update is available — run `prime-agent update` to install it."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_verdict_names_the_install_command() {
        assert_eq!(check_verdict(true), "Up to date.");
        assert_eq!(
            check_verdict(false),
            "An update is available — run `prime-agent update` to install it."
        );
    }
}

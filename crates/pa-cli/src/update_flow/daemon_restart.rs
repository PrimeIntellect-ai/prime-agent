//! The installer's daemon restart (`update --internal-update-restart-daemon`):
//! install-rust.sh runs it from the payload it just published, so a running
//! daemon takes the update restart instead of a plain shutdown. The old
//! supervisor prepares and stops its workers, announces the restart to its
//! clients, and exits; this binary boots the successor with the roster, and
//! the successor restores the sessions.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{
    update_prepared_dir, update_roster_path, UpdateId, UpdateRoster, UpdateStatusCounts,
    UpdateTimeoutBudget,
};

use super::phases::{check_marker_fresh, commit_update, prepare_to_prepared, restore_report};
use super::successor::{identity_from_hello, spawn_supervisor, wait_for_exit, wait_for_hello};

/// The exit code for a restart whose successor came up but did not restore every session.
pub const RESTORE_FAILURES_EXIT_CODE: i32 = 3;

/// Restart the daemon on `socket_path` from this binary and print the restore counts. Returns
/// the exit code: 0, or [`RESTORE_FAILURES_EXIT_CODE`] when the successor did not report every
/// roster session restored.
///
/// # Errors
/// Returns an error when the daemon cannot be reached, refuses the prepare or the commit,
/// does not exit, or the successor does not greet within its budget.
pub async fn run(socket_path: &Path) -> Result<i32> {
    let budget = UpdateTimeoutBudget::from_env();
    let update_id = UpdateId::from(uuid::Uuid::now_v7().to_string());
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket_path)
        .await
        .context("connect the running daemon")?;
    let predecessor = identity_from_hello(client.hello());
    // The daemon's own socket spelling keys its prepared dir and is where the successor binds.
    let socket_path = client
        .hello()
        .get("socketPath")
        .and_then(serde_json::Value::as_str)
        .map_or_else(|| socket_path.to_path_buf(), PathBuf::from);
    prepare_to_prepared(&client, &update_id, &budget).await?;
    let prepared_dir = update_prepared_dir(
        &super::intent::socket_update_directory(
            &crate::config::get_agent_dir(),
            &socket_path.to_string_lossy(),
        ),
        &update_id,
    );
    check_marker_fresh(&prepared_dir)?;
    let roster_path = update_roster_path(&prepared_dir);
    let roster: UpdateRoster =
        serde_json::from_slice(&std::fs::read(&roster_path).context("read the prepared roster")?)
            .context("parse the prepared roster")?;
    let roster_sessions = roster.sessions.len() as u64;
    commit_update(&client, &update_id, &budget).await?;
    client.close();
    if !wait_for_exit(&predecessor, budget.predecessor_exit_ms).await {
        anyhow::bail!("the old supervisor did not exit within its budget");
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    spawn_supervisor(
        &std::env::current_exe()?,
        &socket_path,
        Some(&roster_path),
        &cwd,
    )?;
    wait_for_hello(&socket_path, budget.boot_ms)
        .await
        .context("the new supervisor did not greet within its boot budget")?;
    let (counts, failures) = restore_report(&socket_path, &budget).await;
    let _ = std::fs::remove_dir_all(&prepared_dir);
    println!(
        "restored {} of {} session(s) ({} failed)",
        counts.restored, roster_sessions, counts.failed
    );
    for failure in &failures {
        eprintln!(
            "could not restore {}: {}",
            failure.session_file, failure.message
        );
    }
    Ok(restore_exit_code(roster_sessions, counts))
}

/// 0 only when every roster session restored: `restore_report` answers zeroed counts when its
/// budget expires before the restore pass settles.
fn restore_exit_code(roster_sessions: u64, counts: UpdateStatusCounts) -> i32 {
    if counts.restored < roster_sessions {
        RESTORE_FAILURES_EXIT_CODE
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_restore_of_every_roster_session_exits_zero() {
        let settled = |restored, failed| UpdateStatusCounts {
            total: restored + failed,
            restored,
            resumed: 0,
            failed,
        };
        assert_eq!(restore_exit_code(2, settled(2, 0)), 0);
        assert_eq!(
            restore_exit_code(2, settled(1, 1)),
            RESTORE_FAILURES_EXIT_CODE
        );
        // `restore_report`'s answer when its budget expires mid-restore.
        assert_eq!(
            restore_exit_code(2, UpdateStatusCounts::default()),
            RESTORE_FAILURES_EXIT_CODE
        );
    }
}

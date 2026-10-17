//! The kernel's persistent `bash()` shells (prime-agent-runtime `rlm/bash.py`,
//! `bash(..., persistent=True)`): every session's shells live in one home,
//! `<agent dir>/persistent-shells/`, as a `<id>.json` record assigned to the
//! session that started it, plus the shell's `<id>.out` and `<id>.rc`. The
//! daemon reads the records to list each saved session's live shells. Nothing
//! in the session lifecycle kills them: a deleted session's shells keep
//! running as orphans, still assigned to it.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

const HOME_DIR: &str = "persistent-shells";
/// The kernel activity rows cap the command at the same length.
const COMMAND_CAP: usize = 512;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shell {
    id: String,
    pid: u32,
    start_id: String,
    command: String,
    started_at: String,
    session_id: String,
}

fn registered_shells(agent_dir: &Path) -> Vec<Shell> {
    let Ok(entries) = std::fs::read_dir(agent_dir.join(HOME_DIR)) else {
        return Vec::new();
    };
    let mut shells: Vec<Shell> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| std::fs::read(path).ok())
        .filter_map(|raw| serde_json::from_slice(&raw).ok())
        .collect();
    shells.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    shells
}

/// Whether the shell's pid still runs under the recorded start identity.
fn runs_as_registered(shell: &Shell) -> bool {
    matches!(crate::lease::is_process_alive(shell.pid), Ok(true))
        && crate::lease::get_process_start_id(shell.pid).as_deref() == Some(shell.start_id.as_str())
}

/// The live persistent shells by assigned session id, as rows with the
/// kernel bash activity row field names: a recycled pid or an unreadable
/// identity never counts as live.
pub(crate) fn live_shell_rows_by_session(agent_dir: &Path) -> HashMap<String, Vec<Value>> {
    let mut rows: HashMap<String, Vec<Value>> = HashMap::new();
    for shell in registered_shells(agent_dir)
        .into_iter()
        .filter(runs_as_registered)
    {
        rows.entry(shell.session_id).or_default().push(json!({
            "id": shell.id,
            "command": shell.command.chars().take(COMMAND_CAP).collect::<String>(),
            "pid": shell.pid,
            "startedAt": shell.started_at,
            "status": "running",
            "persistent": true,
        }));
    }
    rows
}

#[cfg(all(test, unix))]
pub(crate) mod test_support {
    use std::path::Path;
    use std::process::{Child, Command};

    /// A setsid'd `sleep` registered in `agent_dir`'s persistent-shell home,
    /// assigned to `session_id`, under `start_id` (`None`: its real start identity).
    pub(crate) fn registered_sleeper(
        agent_dir: &Path,
        session_id: &str,
        start_id: Option<&str>,
    ) -> Child {
        let mut command = Command::new("sleep");
        command.arg("60");
        pa_core::platform::process::set_new_session(&mut command);
        let child = command.spawn().expect("spawn sleeper");
        let start_id = start_id.map_or_else(
            || crate::lease::get_process_start_id(child.id()).expect("start id"),
            str::to_string,
        );
        let home = agent_dir.join(super::HOME_DIR);
        std::fs::create_dir_all(&home).expect("persistent-shell home");
        let pid = child.id();
        let id = format!("{pid:032}");
        let record = serde_json::json!({
            "id": id,
            "pid": pid,
            "startId": start_id,
            "command": "sleep 60",
            "startedAt": "2026-01-01T00:00:00+00:00",
            "sessionId": session_id,
        });
        std::fs::write(home.join(format!("{id}.json")), record.to_string()).expect("write record");
        child
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::test_support::registered_sleeper;
    use super::*;

    #[test]
    fn session_delete_leaves_its_shells_running_as_orphans() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let session_file = sessions.join("s1.jsonl");
        std::fs::write(&session_file, "{}\n").unwrap();
        let mut sleeper = registered_sleeper(root.path(), "s1", None);

        let deleted = crate::saved_session_commands::delete_session_file(&session_file);

        assert_eq!(deleted["ok"], true);
        assert!(!session_file.exists());
        assert!(
            sleeper.try_wait().unwrap().is_none(),
            "the shell still runs"
        );
        assert_eq!(
            live_shell_rows_by_session(root.path())["s1"][0]["pid"],
            sleeper.id(),
            "it stays listed under the deleted session"
        );
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
    }

    #[test]
    fn recycled_pid_is_not_reported() {
        let root = tempfile::tempdir().unwrap();
        let mut stranger = registered_sleeper(root.path(), "s1", Some("proc:not-this-process"));

        assert!(live_shell_rows_by_session(root.path()).is_empty());
        stranger.kill().unwrap();
        stranger.wait().unwrap();
    }
}

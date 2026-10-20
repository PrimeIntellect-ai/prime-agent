//! The kernel's persistent `bash()` shells (prime-agent-runtime `rlm/bash.py`,
//! `bash(..., persistent=True)`): every session's shells live in one home,
//! `<agent dir>/persistent-shells/`, as a `<id>.json` record assigned to the
//! session that started it, plus the shell's `<id>.out` and `<id>.rc`. The
//! daemon reads the records to list each saved session's live shells and every
//! shell machine-wide, reads a shell's output, and kills one on request.
//! Nothing in the session lifecycle kills them: a deleted session's shells keep
//! running as orphans, still assigned to it.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use pa_core::platform::process::{process_group_exists, signal_process_group, Signal};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::protocol::{response_failure, response_line, response_success};

const HOME_DIR: &str = "persistent-shells";
/// How long a shell may exit on its own after SIGTERM before its group gets SIGKILL.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// The kernel activity rows cap the command at the same length.
const COMMAND_CAP: usize = 512;
/// The output read serves its lines from at most this many trailing bytes.
const TAIL_BYTES: u64 = 64 * 1024;

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

fn shell_file(agent_dir: &Path, id: &str, kind: &str) -> PathBuf {
    agent_dir.join(HOME_DIR).join(format!("{id}.{kind}"))
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

fn find_shell(agent_dir: &Path, id: &str) -> Option<Shell> {
    registered_shells(agent_dir)
        .into_iter()
        .find(|shell| shell.id == id)
}

/// Whether the shell's pid still runs under the recorded start identity.
fn runs_as_registered(shell: &Shell) -> bool {
    matches!(crate::lease::is_process_alive(shell.pid), Ok(true))
        && crate::lease::get_process_start_id(shell.pid).as_deref() == Some(shell.start_id.as_str())
}

/// An extant group with no verified leader is not safely attributable to this record.
fn group_unverified(shell: &Shell) -> bool {
    !runs_as_registered(shell) && process_group_exists(shell.pid as i32).unwrap_or(true)
}

/// One shell as a row with the kernel bash activity row field names.
fn activity_row(shell: &Shell, status: &str) -> Value {
    json!({
        "id": shell.id,
        "command": shell.command.chars().take(COMMAND_CAP).collect::<String>(),
        "pid": shell.pid,
        "startedAt": shell.started_at,
        "status": status,
        "persistent": true,
    })
}

/// The live persistent shells by assigned session id: a recycled pid or an
/// unreadable identity never counts as live.
pub(crate) fn live_shell_rows_by_session(agent_dir: &Path) -> HashMap<String, Vec<Value>> {
    let mut rows: HashMap<String, Vec<Value>> = HashMap::new();
    for shell in registered_shells(agent_dir)
        .into_iter()
        .filter(runs_as_registered)
    {
        let row = activity_row(&shell, "running");
        rows.entry(shell.session_id).or_default().push(row);
    }
    rows
}

/// Every registered shell with its assigned `sessionId`: running while its
/// leader runs as registered, unverified when a group remains without that
/// proof, otherwise finished with its recorded exit code (if any). Its
/// `durationMs` runs from `startedAt` to now, or to the exit code's write
/// once finished.
pub(crate) fn shell_rows(agent_dir: &Path) -> Vec<Value> {
    registered_shells(agent_dir)
        .iter()
        .map(|shell| {
            let running = runs_as_registered(shell);
            let status = if running {
                "running"
            } else if group_unverified(shell) {
                "unverified"
            } else {
                "finished"
            };
            let mut row = activity_row(shell, status);
            row["sessionId"] = json!(shell.session_id);
            let rc = shell_file(agent_dir, &shell.id, "rc");
            let ended_ms = if status == "finished" {
                row["exitCode"] = json!(std::fs::read_to_string(&rc)
                    .ok()
                    .and_then(|rc| rc.trim().parse::<i64>().ok()));
                std::fs::metadata(&rc)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                    .and_then(|since| u64::try_from(since.as_millis()).ok())
            } else {
                Some(crate::util::now_ms())
            };
            row["durationMs"] = json!(crate::util::iso_to_unix_ms(&shell.started_at)
                .zip(ended_ms)
                .map(|(started, ended)| ended.saturating_sub(started)));
            row
        })
        .collect()
}

/// The newest `lines` lines of the shell's output (read from its last
/// [`TAIL_BYTES`]); `None` for an unknown shell.
pub(crate) fn output_tail(agent_dir: &Path, id: &str, lines: usize) -> Option<String> {
    let shell = find_shell(agent_dir, id)?;
    let mut bytes = Vec::new();
    if let Ok(mut file) = std::fs::File::open(shell_file(agent_dir, &shell.id, "out")) {
        let size = file.metadata().map_or(0, |metadata| metadata.len());
        if file
            .seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES)))
            .is_ok()
        {
            let _ = file.take(TAIL_BYTES).read_to_end(&mut bytes);
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    Some(all[all.len().saturating_sub(lines)..].join("\n"))
}

/// Kill a shell only while the recorded leader identity still proves ownership.
/// A durable leaderless group may belong to a reused PGID: refuse and retain it.
pub(crate) fn kill_shell(agent_dir: &Path, id: &str) -> Result<bool, String> {
    let Some(shell) = find_shell(agent_dir, id) else {
        return Ok(false);
    };
    if !runs_as_registered(&shell) {
        return if group_unverified(&shell) {
            Err("Cannot verify persistent shell group ownership; no signal sent".to_string())
        } else {
            Ok(true)
        };
    }
    if !signal_process_group(shell.pid as i32, Signal::Term) {
        return Err("Could not signal persistent shell group".to_string());
    }
    let deadline = Instant::now() + TERM_GRACE;
    while Instant::now() < deadline && runs_as_registered(&shell) {
        std::thread::sleep(Duration::from_millis(50));
    }
    kill_group(&shell)?;
    Ok(true)
}

/// The KILL after a verified TERM. A leader that exited during the grace still names the group
/// verified before the TERM: a PGID is not reused while its group has members. A leader pid
/// that runs again under another start identity was recycled, so its group is refused.
fn kill_group(shell: &Shell) -> Result<(), String> {
    let leader_exited = matches!(crate::lease::is_process_alive(shell.pid), Ok(false));
    if !runs_as_registered(shell) && !leader_exited {
        return if group_unverified(shell) {
            Err(
                "Cannot verify persistent shell group ownership; no further signal sent"
                    .to_string(),
            )
        } else {
            Ok(())
        };
    }
    if signal_process_group(shell.pid as i32, Signal::Kill)
        || !process_group_exists(shell.pid as i32).unwrap_or(true)
    {
        Ok(())
    } else {
        Err("Could not signal persistent shell group".to_string())
    }
}

/// One persistent-shell supervisor arm, run off the runtime (file reads and
/// the kill's grace block): `None` answers an unknown shell.
pub(crate) async fn respond(
    command_id: &str,
    type_name: &str,
    run: impl FnOnce() -> Result<Option<Value>, String> + Send + 'static,
) -> Value {
    let response = match tokio::task::spawn_blocking(run).await {
        Ok(Ok(Some(data))) => response_success(Some(command_id), type_name, Some(data)),
        Ok(Ok(None)) => response_failure(
            Some(command_id),
            type_name,
            "Unknown persistent shell",
            None,
        ),
        Ok(Err(error)) => response_failure(Some(command_id), type_name, &error, None),
        Err(error) => response_failure(Some(command_id), type_name, &error.to_string(), None),
    };
    response_line(&response)
}

#[cfg(all(test, unix))]
mod test_support {
    use std::path::Path;
    use std::process::{Child, Command};

    /// A setsid'd `sleep` registered in `agent_dir`'s persistent-shell home,
    /// assigned to `session_id`, under `start_id` (`None`: its real start identity).
    pub(super) fn registered_sleeper(
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
        register(agent_dir, child.id(), &start_id, session_id);
        child
    }

    /// Write one record for shell `pid` under `start_id`, assigned to
    /// `session_id`; returns its id.
    pub(super) fn register(agent_dir: &Path, pid: u32, start_id: &str, session_id: &str) -> String {
        let home = agent_dir.join(super::HOME_DIR);
        std::fs::create_dir_all(&home).expect("persistent-shell home");
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
        id
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Child, Command};

    use nix::sys::signal::{kill, Signal as NixSignal};
    use nix::unistd::Pid;

    use super::test_support::{register, registered_sleeper};
    use super::*;

    /// Send `child` our own SIGTERM and return the signal it died by: an
    /// earlier SIGKILL is already pending and wins.
    fn fatal_signal_after_own_term(mut child: Child) -> Option<i32> {
        let _ = kill(Pid::from_raw(child.id() as i32), NixSignal::SIGTERM);
        child.wait().unwrap().signal()
    }

    /// A registered `sleep` leading its own process group, plus one member in
    /// that group.
    fn registered_group(agent_dir: &std::path::Path) -> (Child, Child, String) {
        let mut leader_command = Command::new("sleep");
        leader_command.arg("60");
        pa_core::platform::process::set_new_process_group(&mut leader_command);
        let leader = leader_command.spawn().unwrap();
        let start_id = crate::lease::get_process_start_id(leader.id()).unwrap();
        let id = register(agent_dir, leader.id(), &start_id, "s1");
        let member = Command::new("sleep")
            .arg("60")
            .process_group(leader.id() as i32)
            .spawn()
            .unwrap();
        (leader, member, id)
    }

    #[test]
    fn recycled_pid_is_neither_reported_nor_killed() {
        let root = tempfile::tempdir().unwrap();
        let stranger = registered_sleeper(root.path(), "s1", Some("proc:not-this-process"));
        let id = format!("{:032}", stranger.id());

        assert!(live_shell_rows_by_session(root.path()).is_empty());
        assert_eq!(shell_rows(root.path())[0]["status"], "unverified");
        assert!(kill_shell(root.path(), &id).is_err());

        assert_eq!(
            fatal_signal_after_own_term(stranger),
            Some(NixSignal::SIGTERM as i32),
            "never signalled"
        );
    }

    #[test]
    fn kill_stops_the_whole_group_and_leaves_the_shell_listed_as_finished() {
        let root = tempfile::tempdir().unwrap();
        let (mut leader, member, id) = registered_group(root.path());
        std::fs::write(shell_file(root.path(), &id, "out"), "line\n").unwrap();

        let _outcome = kill_shell(root.path(), &id);

        assert!(!leader.wait().unwrap().success(), "the leader was killed");
        let member_status = member.wait_with_output().unwrap().status;
        assert_eq!(
            member_status.signal(),
            Some(NixSignal::SIGTERM as i32),
            "the group's TERM reached the member"
        );
        assert_eq!(shell_rows(root.path())[0]["status"], "finished");
        assert_eq!(output_tail(root.path(), &id, 1).as_deref(), Some("line"));
        assert_eq!(kill_shell(root.path(), "unknown"), Ok(false));
    }

    #[test]
    fn kill_escalates_to_a_member_that_outlives_its_leaders_term() {
        use std::io::BufRead;
        let root = tempfile::tempdir().unwrap();
        let (mut leader, member, id) = registered_group(root.path());
        let mut stubborn = Command::new("sh")
            .args(["-c", "trap '' TERM; echo ready; exec sleep 60"])
            .process_group(leader.id() as i32)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(stubborn.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();

        assert_eq!(kill_shell(root.path(), &id), Ok(true));

        leader.wait().unwrap();
        member.wait_with_output().unwrap();
        assert_eq!(
            stubborn.wait().unwrap().signal(),
            Some(NixSignal::SIGKILL as i32),
            "the member that ignored TERM got the group's KILL"
        );
    }

    #[test]
    fn exited_leaders_group_is_unverified_and_never_signalled() {
        let root = tempfile::tempdir().unwrap();
        let (mut leader, member, id) = registered_group(root.path());
        leader.kill().unwrap();
        leader.wait().unwrap();
        // The same observable state also describes an unrelated group after
        // durable PID/PGID reuse. No old leader start-id can distinguish them.
        let record = shell_file(root.path(), &id, "json");
        let mut stale: Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        stale["startId"] = json!("proc:old-unrelated-leader");
        std::fs::write(&record, stale.to_string()).unwrap();

        assert_eq!(shell_rows(root.path())[0]["status"], "unverified");
        assert!(kill_shell(root.path(), &id).is_err());
        assert!(record.exists());
        assert_eq!(
            fatal_signal_after_own_term(member),
            Some(NixSignal::SIGTERM as i32),
            "no earlier KILL reached the unverified group"
        );
    }

    #[test]
    fn pid_recycled_during_the_grace_is_not_killed() {
        let root = tempfile::tempdir().unwrap();
        let mut stranger = registered_sleeper(root.path(), "s1", Some("proc:not-this-process"));
        let shells = registered_shells(root.path());

        assert!(kill_group(&shells[0]).is_err());
        assert!(signal_process_group(stranger.id() as i32, Signal::Term));

        let status = stranger.wait().unwrap();
        assert_eq!(
            status.signal(),
            Some(NixSignal::SIGTERM as i32),
            "no SIGKILL came first"
        );
    }

    #[test]
    fn shell_rows_list_every_shell_with_its_session_and_the_output_tail_reads_the_newest_lines() {
        let root = tempfile::tempdir().unwrap();
        let mut sleeper = registered_sleeper(root.path(), "s1", None);
        let mut done = Command::new("true").spawn().unwrap();
        done.wait().unwrap();
        let finished = register(root.path(), done.id(), "proc:0", "gone");
        std::fs::write(shell_file(root.path(), &finished, "rc"), "3\n").unwrap();
        std::fs::write(
            shell_file(root.path(), &finished, "out"),
            "one\ntwo\nthree\n",
        )
        .unwrap();

        let rows = shell_rows(root.path());

        let row = |id: &str| rows.iter().find(|row| row["id"] == id).unwrap().clone();
        let running = row(&format!("{:032}", sleeper.id()));
        assert_eq!(
            (
                &running["status"],
                &running["sessionId"],
                running.get("exitCode")
            ),
            (&json!("running"), &json!("s1"), None)
        );
        let done_row = row(&finished);
        assert_eq!(
            (
                &done_row["status"],
                &done_row["sessionId"],
                &done_row["exitCode"]
            ),
            (&json!("finished"), &json!("gone"), &json!(3))
        );
        assert!(running["durationMs"].is_u64() && done_row["durationMs"].is_u64());
        assert_eq!(
            output_tail(root.path(), &finished, 2).as_deref(),
            Some("two\nthree")
        );
        assert_eq!(output_tail(root.path(), "unknown", 2), None);
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
    }
}

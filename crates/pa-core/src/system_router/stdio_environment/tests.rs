//! The stdio adapter protocol battery: real subprocesses speaking the
//! JSON-lines contract.

use std::time::Duration;

use super::*;

/// Write a small python adapter to a temp dir and return (dir, command).
fn adapter(script: &str) -> (tempfile::TempDir, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("adapter.py");
    std::fs::write(&path, script).unwrap();
    (
        dir,
        vec![
            "python3".to_string(),
            "-u".to_string(),
            path.to_string_lossy().to_string(),
        ],
    )
}

const ECHO_ADAPTER: &str = r#"
import json
import sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    kind = request.get("type")
    if kind == "close":
        break
    reply = {"id": request.get("id"), "ok": True}
    if kind == "init":
        reply["environment"] = {"actions": {"wait": {"description": "Wait one tick."}}}
    elif kind == "observe":
        reply["observation"] = {"text": "the screen", "fields": {"hp": 3}, "terminal": False}
    elif kind == "execute":
        reply["text"] = "pressed " + request.get("action", "")
        reply["terminal"] = False
    print(json.dumps(reply), flush=True)
"#;

#[tokio::test]
async fn the_adapter_round_trips_every_request() {
    let (_dir, command) = adapter(ECHO_ADAPTER);
    let env =
        StdioRouterEnvironment::new(command, None, 5_000, Some(serde_json::json!({"rom": "x"})));
    let info = env.init().await.unwrap().expect("init environment info");
    assert!(info.get("actions").is_some());
    env.reset("reach the overworld").await.unwrap();
    let observation = env.observe().await.unwrap();
    assert_eq!(observation.text, "the screen");
    assert_eq!(observation.fields["hp"], serde_json::json!(3));
    assert_eq!(observation.image, None);
    assert!(!observation.terminal);
    let execution = env
        .execute(
            "press",
            &std::collections::BTreeMap::from([("button".to_string(), "a".to_string())]),
        )
        .await
        .unwrap();
    assert_eq!(execution.text, "pressed press");
    env.close(RouterCloseOptions {
        budget_ms: Some(500),
    })
    .await;
    // Close is idempotent.
    env.close(RouterCloseOptions {
        budget_ms: Some(500),
    })
    .await;
}

#[tokio::test]
async fn an_adapter_error_reply_propagates() {
    let (_dir, command) = adapter(
        r#"
import json
import sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("type") == "close":
        break
    print(json.dumps({"id": request.get("id"), "ok": False, "error": "no rom loaded"}), flush=True)
"#,
    );
    let env = StdioRouterEnvironment::new(command, None, 5_000, None);
    let error = env.init().await.unwrap_err();
    assert_eq!(error.to_string(), "no rom loaded");
    env.close(RouterCloseOptions {
        budget_ms: Some(500),
    })
    .await;
}

#[tokio::test]
async fn an_adapter_that_exits_early_fails_the_pending_request() {
    let env = StdioRouterEnvironment::new(
        vec!["sh".to_string(), "-c".to_string(), "exit 0".to_string()],
        None,
        5_000,
        None,
    );
    let error = env.init().await.unwrap_err().to_string();
    assert!(
        error.contains("exited early") || error.contains("stdin failed"),
        "unexpected early-exit error: {error}"
    );
    env.close(RouterCloseOptions {
        budget_ms: Some(500),
    })
    .await;
}

/// End of stream flushes the buffered tail: an adapter can write its final
/// reply without the trailing newline and exit, and that reply must reach
/// its pending request instead of dying with the early exit (cursor: EOF
/// drops last adapter reply).
#[tokio::test]
async fn a_final_reply_without_a_trailing_newline_lands() {
    let (_dir, command) = adapter(
        r#"
import json
import sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    kind = request.get("type")
    if kind == "close":
        break
    reply = {"id": request.get("id"), "ok": True}
    if kind == "init":
        reply["environment"] = {"actions": {"wait": {"description": "Wait one tick."}}}
    # The final reply is written without its trailing newline, then the
    # adapter exits: the reader must complete it at end of stream.
    sys.stdout.write(json.dumps(reply))
    sys.stdout.flush()
    sys.exit(0)
"#,
    );
    let env = StdioRouterEnvironment::new(command, None, 5_000, None);
    let info = env.init().await.unwrap().expect("init environment info");
    assert!(info.get("actions").is_some());
    // The adapter is gone, so later requests still fail as the early exit:
    // the flush delivered the final reply, it did not swallow the exit.
    let error = env
        .reset("reach the overworld")
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("exited early"),
        "unexpected post-exit error: {error}"
    );
    env.close(RouterCloseOptions {
        budget_ms: Some(500),
    })
    .await;
}

#[tokio::test]
async fn a_silent_adapter_times_out_per_request() {
    let env = StdioRouterEnvironment::new(
        vec!["sh".to_string(), "-c".to_string(), "sleep 30".to_string()],
        None,
        150,
        None,
    );
    let started = std::time::Instant::now();
    let error = env.init().await.unwrap_err().to_string();
    assert_eq!(error, "environment adapter init timed out after 150ms");
    assert!(started.elapsed() < Duration::from_secs(5));
    // The close budget bounds the teardown even though the adapter ignores it.
    let started = std::time::Instant::now();
    env.close(RouterCloseOptions {
        budget_ms: Some(300),
    })
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cleanup stays inside its budget"
    );
}

#[tokio::test]
async fn an_oversized_unterminated_line_is_a_protocol_violation() {
    let env = StdioRouterEnvironment::new(
        vec![
            "python3".to_string(),
            "-c".to_string(),
            "import sys,time; sys.stdout.write('x'*1500000); sys.stdout.flush(); time.sleep(30)"
                .to_string(),
        ],
        None,
        10_000,
        None,
    );
    let error = env.init().await.unwrap_err().to_string();
    assert!(
        error.contains("unterminated reply line over 1000000 chars"),
        "unexpected overflow error: {error}"
    );
    env.close(RouterCloseOptions {
        budget_ms: Some(300),
    })
    .await;
}

#[tokio::test]
async fn an_invalid_utf8_line_is_a_protocol_violation() {
    let env = StdioRouterEnvironment::new(
        vec![
            "python3".to_string(),
            "-c".to_string(),
            "import sys,time; sys.stdout.buffer.write(b'\\xff\\n'); sys.stdout.flush(); time.sleep(30)"
                .to_string(),
        ],
        None,
        10_000,
        None,
    );
    let error = env.init().await.unwrap_err().to_string();
    assert!(
        error.contains("not valid UTF-8"),
        "unexpected utf8 error: {error}"
    );
    env.close(RouterCloseOptions {
        budget_ms: Some(300),
    })
    .await;
}

/// A deliberate close must not read as an early exit: the reader sees the
/// adapter's stdout close while `close` is still waiting on the process, so
/// the recorded failure is the close, not "exited early" (the TS exit
/// handler's `closed` check).
#[tokio::test]
async fn a_deliberate_close_is_not_reported_as_an_early_exit() {
    let (_dir, command) = adapter(
        r#"
import json
import os
import sys
import time

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("type") == "close":
        # The reader sees EOF while the process still runs.
        os.close(1)
        time.sleep(1)
        break
    print(json.dumps({"id": request.get("id"), "ok": True}), flush=True)
"#,
    );
    let env = StdioRouterEnvironment::new(command, None, 5_000, None);
    env.init().await.unwrap();
    env.close(RouterCloseOptions {
        budget_ms: Some(3_000),
    })
    .await;
    // The fail-fast message is the deliberate close, not "exited early".
    let error = env
        .reset("reach the overworld")
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(error, "environment adapter closed");
}

#[tokio::test]
async fn closing_an_unstarted_adapter_is_a_no_op() {
    let env = StdioRouterEnvironment::new(vec!["python3".to_string()], None, 1_000, None);
    env.close(RouterCloseOptions {
        budget_ms: Some(100),
    })
    .await;
}

#[tokio::test]
async fn an_unknown_reply_id_is_ignored() {
    let (_dir, command) = adapter(
        r#"
import json
import sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("type") == "close":
        break
    # A stray reply for an id nobody is waiting on, then the real one.
    print(json.dumps({"id": 999, "ok": True}), flush=True)
    print(json.dumps({"id": request.get("id"), "ok": True, "environment": {}}), flush=True)
"#,
    );
    let env = StdioRouterEnvironment::new(command, None, 5_000, None);
    let info = env.init().await.unwrap();
    assert_eq!(info, Some(serde_json::json!({})));
    env.close(RouterCloseOptions {
        budget_ms: Some(500),
    })
    .await;
}

/// Poll until the pid is gone (or the deadline): the group relay reaches a
/// descendant only after its own reaper lands.
#[cfg(unix)]
async fn wait_for_exit(pid: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while crate::platform::pid_exists(pid) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The launcher adapter shared by the descendant pins: a python process
/// that spawns a `/bin/sh` grandchild whose TERM disposition is
/// `trap_line` (which may reference the relay marker as `{marker}`),
/// answers `init` with the grandchild's pid, and exits first on `close`,
/// leaving the grandchild behind in its group. Returns the adapter's
/// temp dir (the test must hold it: the markers live in it), the adapter
/// command, the relay marker the grandchild writes when it honors the
/// relayed stop, and the readiness marker it writes once its trap is
/// installed.
#[cfg(unix)]
fn launcher_with_grandchild(
    trap_line: &str,
) -> (
    tempfile::TempDir,
    Vec<String>,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("relay-marker");
    let ready_marker = dir.path().join("trap-ready");
    let trap_line = trap_line.replace("{marker}", &marker.to_string_lossy());
    // The readiness write sits after the trap: once `trap-ready` exists,
    // a relayed SIGTERM can only ever exercise the trap, never the
    // startup race where a `sh` still under its default TERM disposition
    // dies before its script runs.
    let ready = ready_marker.display();
    let grandchild = format!("{trap_line}; printf ready > {ready}; while :; do sleep 0.1; done");
    let script = format!(
        r#"
import json
import subprocess
import sys

grandchild = subprocess.Popen(["/bin/sh", "-c", {grandchild:?}])
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    kind = request.get("type")
    if kind == "init":
        reply = {{"id": request.get("id"), "ok": True, "environment": {{"grandchild_pid": grandchild.pid}}}}
        print(json.dumps(reply), flush=True)
    elif kind == "close":
        # The launcher exits first, leaving its descendant behind.
        sys.exit(0)
"#
    );
    let path = dir.path().join("adapter.py");
    std::fs::write(&path, script).unwrap();
    let command = vec![
        "python3".to_string(),
        "-u".to_string(),
        path.to_string_lossy().to_string(),
    ];
    (dir, command, marker, ready_marker)
}

/// Wait (bounded) until the grandchild reports its TERM trap installed:
/// only then does the close exercise the relay itself, not the startup
/// race that would kill a `sh` mid-startup under its default TERM
/// disposition.
#[cfg(unix)]
async fn wait_for_grandchild_trap(ready: &std::path::Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !ready.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        ready.exists(),
        "the grandchild never installed its TERM trap"
    );
}

/// A launcher that answers the close request and exits first (`sh -c`, a
/// container client) still relays the stop to the descendant it left in its
/// group - the graceful wait succeeding must not strand it (cursor: adapter
/// descendants leak after close). The grandchild records the relayed stop,
/// so the relay stays pinned even though the enforced kill behind it would
/// stop the descendant too.
#[cfg(unix)]
#[tokio::test]
async fn a_launcher_that_answers_close_still_stops_its_descendants() {
    let (_dir, command, marker, ready) =
        launcher_with_grandchild("trap 'printf relayed > {marker}; exit 0' TERM");
    let env = StdioRouterEnvironment::new(command, None, 5_000, None);
    let info = env.init().await.unwrap().expect("init environment info");
    let grandchild = info["grandchild_pid"].as_u64().expect("grandchild pid") as u32;
    assert!(
        crate::platform::pid_exists(grandchild),
        "the grandchild starts alive"
    );
    wait_for_grandchild_trap(&ready).await;
    env.close(RouterCloseOptions {
        budget_ms: Some(1_000),
    })
    .await;
    wait_for_exit(grandchild).await;
    assert!(
        !crate::platform::pid_exists(grandchild),
        "the group relay stopped the launcher's descendant"
    );
    assert_eq!(
        std::fs::read_to_string(&marker).ok().as_deref(),
        Some("relayed"),
        "the stop reached the grandchild as the relayed SIGTERM, not the enforced kill"
    );
}

/// A launcher that answers `close` and exits first cannot leave behind a
/// descendant that ignores the relayed SIGTERM: the leader-exit arm relays
/// the stop, drains a bounded grace, then enforces the group kill (cursor:
/// close path leaks adapter descendants - the relay alone is not
/// enforcement).
#[cfg(unix)]
#[tokio::test]
async fn a_launcher_that_answers_close_enforces_the_stop_on_sigterm_ignoring_descendants() {
    let (_dir, command, _marker, ready) = launcher_with_grandchild("trap '' TERM");
    let env = StdioRouterEnvironment::new(command, None, 5_000, None);
    let info = env.init().await.unwrap().expect("init environment info");
    let grandchild = info["grandchild_pid"].as_u64().expect("grandchild pid") as u32;
    assert!(
        crate::platform::pid_exists(grandchild),
        "the grandchild starts alive"
    );
    wait_for_grandchild_trap(&ready).await;
    let started = std::time::Instant::now();
    env.close(RouterCloseOptions {
        budget_ms: Some(2_000),
    })
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the enforced stop stays inside its budget"
    );
    wait_for_exit(grandchild).await;
    assert!(
        !crate::platform::pid_exists(grandchild),
        "the enforced group kill reached the SIGTERM-ignoring descendant"
    );
}

/// A launcher that only dies from the relayed SIGTERM still enforces the stop
/// on descendants that ignored it (the post-SIGTERM leader-exit arm).
#[cfg(unix)]
#[tokio::test]
async fn a_sigterm_killed_launcher_enforces_the_stop_on_its_descendants() {
    let (_dir, command) = adapter(
        r#"
import json
import subprocess
import sys
import time

grandchild = subprocess.Popen(["/bin/sh", "-c", "trap '' TERM; while :; do sleep 0.1; done"])
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("type") == "init":
        reply = {"id": request.get("id"), "ok": True, "environment": {"grandchild_pid": grandchild.pid}}
        print(json.dumps(reply), flush=True)
# stdin is closed: keep the launcher alive until a signal stops it.
while True:
    time.sleep(0.1)
"#,
    );
    let env = StdioRouterEnvironment::new(command, None, 5_000, None);
    let info = env.init().await.unwrap().expect("init environment info");
    let grandchild = info["grandchild_pid"].as_u64().expect("grandchild pid") as u32;
    assert!(
        crate::platform::pid_exists(grandchild),
        "the grandchild starts alive"
    );
    env.close(RouterCloseOptions {
        budget_ms: Some(2_000),
    })
    .await;
    wait_for_exit(grandchild).await;
    assert!(
        !crate::platform::pid_exists(grandchild),
        "the enforced group kill reached the SIGTERM-ignoring descendant"
    );
}

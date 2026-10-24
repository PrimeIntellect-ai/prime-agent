use super::*;
use pa_agent::abort::{is_abort_error, AbortController};

async fn execute(command: &str, input: Vec<u8>) -> anyhow::Result<CommandOutput> {
    run(
        command,
        Path::new("/tmp"),
        input,
        Duration::from_secs(5),
        AbortSignal::never(),
    )
    .await
}

#[tokio::test]
async fn stdin_and_both_streams_preserve_exit_two() {
    let input = vec![b'x'; 32_000];
    let result = execute("cat; printf problem >&2; exit 2", input.clone())
        .await
        .unwrap();
    assert_eq!(
        result,
        CommandOutput {
            stdout: input,
            stderr: b"problem".to_vec(),
            code: Some(2)
        }
    );
}

#[tokio::test]
async fn provides_protocol_environment_and_working_directory() {
    let dir = tempfile::tempdir().unwrap();
    let result = run(
        "printf '%s:%s' \"$PRIME_AGENT_HOOK_PROTOCOL_VERSION\" \"$PRIME_AGENT_HOOK_ACTIVE\"; printf ok > marker",
        dir.path(), vec![], Duration::from_secs(5), AbortSignal::never(),
    ).await.unwrap();
    assert_eq!(result.stdout, b"1:1");
    assert_eq!(std::fs::read(dir.path().join("marker")).unwrap(), b"ok");
}

#[tokio::test]
async fn rejects_oversized_input_before_spawning() {
    let dir = tempfile::tempdir().unwrap();
    let error = run(
        "touch marker",
        dir.path(),
        vec![0; INPUT_LIMIT + 1],
        Duration::from_secs(5),
        AbortSignal::never(),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("input exceeds"));
    assert!(!dir.path().join("marker").exists());
}

/// Output past the cap is dropped, not fatal: the command runs to completion.
#[tokio::test]
async fn bounds_each_output_stream_without_killing_the_command() {
    let result = execute(
        "head -c 200000 /dev/zero; head -c 200000 /dev/zero >&2; exit 2",
        vec![],
    )
    .await
    .unwrap();
    assert_eq!(
        (result.stdout.len(), result.stderr.len(), result.code),
        (OUTPUT_LIMIT, OUTPUT_LIMIT, Some(2))
    );
}

#[tokio::test]
async fn concurrently_drains_output_while_writing_input() {
    let result = execute(
        "head -c 32768 /dev/zero; cat >/dev/null",
        vec![b'x'; INPUT_LIMIT],
    )
    .await
    .unwrap();
    assert_eq!(result.stdout.len(), 32_768);
    assert_eq!(result.code, Some(0));
}

#[tokio::test]
async fn timeout_covers_blocked_stdin_and_descendant_pipes() {
    let result = run(
        "sleep 60 & wait",
        Path::new("/tmp"),
        vec![0; INPUT_LIMIT],
        Duration::from_millis(100),
        AbortSignal::never(),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("timed out"));
}

#[tokio::test]
async fn deadline_bounds_descendants_holding_pipes() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let command = format!(
        "sleep 60 & echo $! > {}; printf complete",
        pid_file.display()
    );
    let result = run(
        &command,
        dir.path(),
        vec![],
        Duration::from_millis(300),
        AbortSignal::never(),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("timed out"));
    exited(ready_pid(&pid_file).await).await;
}

/// A hook may detach a helper with redirected stdio, e.g. a notifier or an
/// upload sent to the background; a successful run must not kill it.
#[tokio::test]
async fn successful_run_keeps_detached_helpers() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let command = format!(
        "sleep 60 >/dev/null 2>&1 </dev/null & echo $! > {}; printf complete",
        pid_file.display()
    );
    let result = run(
        &command,
        dir.path(),
        vec![],
        Duration::from_secs(5),
        AbortSignal::never(),
    )
    .await
    .unwrap();
    assert_eq!(result.stdout, b"complete");
    let pid = ready_pid(&pid_file).await;
    let alive = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap()),
        None,
    )
    .is_ok();
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap()),
        nix::sys::signal::Signal::SIGKILL,
    );
    assert!(alive, "the detached helper survived the successful run");
}

async fn ready_pid(path: &Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        loop {
            poll.tick().await;
            if let Ok(text) = tokio::fs::read_to_string(path).await {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
        }
    })
    .await
    .expect("hook should publish its process id")
}

async fn exited(pid: u32) {
    tokio::time::timeout(
        Duration::from_secs(5),
        crate::platform::process::wait_for_exit(pid),
    )
    .await
    .expect("hook must exit after cancellation")
    .unwrap();
}

#[tokio::test]
async fn cancellation_kills_running_command_and_preserves_abort_type() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_path_buf();
    let controller = AbortController::new();
    let signal = controller.signal();
    let task = tokio::spawn(async move {
        run(
            "echo $$ > pid; sleep 60 & echo $! > descendant; wait",
            &cwd,
            vec![],
            Duration::from_secs(60),
            signal,
        )
        .await
    });
    let pid = ready_pid(&dir.path().join("pid")).await;
    let descendant = ready_pid(&dir.path().join("descendant")).await;
    controller.abort();
    assert!(is_abort_error(&task.await.unwrap().unwrap_err()));
    exited(pid).await;
    exited(descendant).await;
}

#[tokio::test]
async fn dropping_outer_future_kills_running_command() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_path_buf();
    let task = tokio::spawn(async move {
        run(
            "echo $$ > pid; sleep 60 & echo $! > descendant; wait",
            &cwd,
            vec![],
            Duration::from_secs(60),
            AbortSignal::never(),
        )
        .await
    });
    let pid = ready_pid(&dir.path().join("pid")).await;
    let descendant = ready_pid(&dir.path().join("descendant")).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    exited(pid).await;
    exited(descendant).await;
}

#[tokio::test]
async fn already_cancelled_commands_do_not_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let controller = AbortController::new();
    controller.abort();
    let error = run(
        "touch marker",
        dir.path(),
        vec![],
        Duration::from_secs(5),
        controller.signal(),
    )
    .await
    .unwrap_err();
    assert!(is_abort_error(&error));
    assert!(!dir.path().join("marker").exists());
}

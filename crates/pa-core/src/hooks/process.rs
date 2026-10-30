//! Bounded command execution. A command's process group is killed when it times
//! out, fails or is canceled. After a successful run the group is left alone, so
//! helpers a hook detaches on purpose (with redirected stdio) keep running; a
//! descendant that keeps the output pipes open is bounded by the deadline.

use std::{path::Path, time::Duration};

use pa_agent::abort::AbortSignal;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: Option<i32>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
const INPUT_LIMIT: usize = 1024 * 1024;
#[cfg(any(target_os = "linux", target_os = "macos"))]
const OUTPUT_LIMIT: usize = 64 * 1024;

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct ProcessGroup(Option<i32>);

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl ProcessGroup {
    fn terminate(&mut self) {
        if let Some(pid) = self.0.take() {
            // Never fall back to signaling a PID: the shell may already be
            // reaped, allowing its numeric PID to name an unrelated process.
            // ESRCH simply means the owned group has already disappeared.
            let _ = crate::platform::process::kill_process_group_only(pid);
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Reads to EOF but keeps only the first 64 KiB: memory stays bounded and a
/// chatty hook is never killed for its output volume.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn read_bounded(mut reader: impl tokio::io::AsyncRead + Unpin) -> anyhow::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;

    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(output);
        }
        let kept = count.min(OUTPUT_LIMIT - output.len());
        output.extend_from_slice(&buffer[..kept]);
    }
}

/// Runs one command with a deadline covering stdin, both output pipes, and exit.
/// Cancellation or dropping this future kills its group synchronously; Tokio's
/// child drop path queues reaping if the killed child has not exited yet.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[tracing::instrument(skip_all)]
pub(super) async fn run(
    command: &str,
    cwd: &Path,
    input: Vec<u8>,
    timeout: Duration,
    signal: AbortSignal,
) -> anyhow::Result<CommandOutput> {
    use anyhow::Context;
    use std::{io::ErrorKind, process::Stdio};
    use tokio::io::AsyncWriteExt;

    anyhow::ensure!(input.len() <= INPUT_LIMIT, "hook input exceeds 1 MiB");
    pa_agent::abort::throw_if_aborted(&signal)?;
    let deadline = tokio::time::Instant::now() + timeout;
    let mut process = tokio::process::Command::new("/bin/sh");
    process
        .args(["-c", command])
        .current_dir(cwd)
        .env("PRIME_AGENT_HOOK_PROTOCOL_VERSION", "1")
        .env("PRIME_AGENT_HOOK_ACTIVE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::platform::process::set_new_process_group(process.as_std_mut());
    let mut child = process.spawn().context("spawn hook command")?;
    // Declare the guard after the child so group termination precedes child
    // drop/reaping, including when an outer abort race drops this future.
    let pid = child.id().context("hook command has no process id")?;
    let mut group = ProcessGroup(Some(i32::try_from(pid)?));
    let mut stdin = child.stdin.take().context("hook stdin unavailable")?;
    let stdout = child.stdout.take().context("hook stdout unavailable")?;
    let stderr = child.stderr.take().context("hook stderr unavailable")?;
    let operation = async {
        let write = async {
            match stdin.write_all(&input).await {
                Ok(()) => {}
                // Hooks may intentionally ignore their input, including exit 2.
                Err(error) if error.kind() == ErrorKind::BrokenPipe => {}
                Err(error) => return Err(anyhow::Error::new(error)),
            }
            drop(stdin);
            Ok(())
        };
        let wait = async { Ok::<_, anyhow::Error>(child.wait().await?) };
        let ((), stdout, stderr, status) =
            tokio::try_join!(write, read_bounded(stdout), read_bounded(stderr), wait)?;
        // Success disarms the guard: descendants that released the pipes were
        // detached on purpose. Timeout, failure and cancellation kill the group.
        group.0 = None;
        Ok(CommandOutput {
            stdout,
            stderr,
            code: status.code(),
        })
    };
    tokio::select! {
        biased;
        () = signal.aborted() => Err(pa_agent::abort::aborted_error()),
        result = tokio::time::timeout_at(deadline, operation) => {
            result.context("hook command timed out")?
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::unused_async)] // Keep the same caller API on unsupported targets.
pub(super) async fn run(
    _command: &str,
    _cwd: &Path,
    _input: Vec<u8>,
    _timeout: Duration,
    _signal: AbortSignal,
) -> anyhow::Result<CommandOutput> {
    anyhow::bail!("command hooks are supported only on Linux and macOS")
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[path = "process_tests.rs"]
mod tests;

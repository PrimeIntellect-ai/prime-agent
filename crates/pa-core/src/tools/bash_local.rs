//! Local shell execution backend for the bash tool (TS:
//! `createLocalBashOperations` from `packages/coding-agent/src/core/tools/bash.ts`).
//!
//! Spawns the shell in its own process group, streams stdout+stderr through
//! one ordered channel, kills the whole group on timeout or abort, and
//! resolves with the exit code (`None` when killed by a signal).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use std::sync::atomic::Ordering;

use crate::tools::bash::{BashOperations, ExecFuture, ExecOptions};
use crate::tools::shell_utils::{get_shell_config, get_shell_env, kill_process_tree};

/// Local shell execution backend (TS: `createLocalBashOperations`).
#[derive(Default)]
pub struct LocalBashOperations {
    pub shell_path: Option<String>,
}

impl BashOperations for LocalBashOperations {
    #[tracing::instrument(level = "trace", name = "bash_local_exec", skip_all)]
    fn exec<'a>(
        &'a self,
        command: &'a str,
        cwd: &'a str,
        options: ExecOptions<'a>,
    ) -> ExecFuture<'a> {
        // Destructure up front: #[instrument] keeps a guard on the argument
        // binding, so partial moves of its fields would borrow-check-fail.
        let ExecOptions {
            on_data,
            signal,
            timeout,
            env,
        } = options;
        let shell_path = self.shell_path.clone();
        Box::pin(async move {
            let shell = get_shell_config(shell_path.as_deref())?;

            if !std::path::Path::new(cwd).exists() {
                anyhow::bail!(
                    "Working directory does not exist: {cwd}\nCannot execute bash commands."
                );
            }

            let mut process = std::process::Command::new(&shell.shell);
            for arg in &shell.args {
                process.arg(arg);
            }
            process
                .arg(command)
                .current_dir(cwd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            for (key, value) in env.unwrap_or_else(get_shell_env) {
                process.env(key, value);
            }
            // Detached process group on POSIX only, so kill_process_tree
            // can reach descendants (TS: `detached:
            // process.platform !== "win32"`) - on Windows the child stays
            // in the parent's console group and tree kills go through
            // `taskkill /T` instead. Hidden window everywhere (TS
            // `spawnHidden`).
            #[cfg(unix)]
            crate::platform::process::set_new_process_group(&mut process);
            crate::platform::process::set_no_window(&mut process);

            let mut child = process.spawn()?;

            let pid = child.id() as i32;
            // Track the detached child for shutdown-signal kills (TS
            // `trackDetachedChildPid` right after the spawn): the child's
            // process group outlives this process's own death, so a
            // SIGTERM-handling parent drains the registry instead of
            // orphaning the run.
            crate::platform::track_detached_child_pid(pid);
            // The settle-side untrack (TS drops the pid in both
            // `waitForChildProcess` arms): a guard, because a cancelled
            // tool run drops this future before the wait resolves - the
            // abort already killed the tree, so the pid must leave the
            // registry no matter which way the operation leaves.
            struct UntrackOnExit(i32);
            impl Drop for UntrackOnExit {
                fn drop(&mut self) {
                    crate::platform::untrack_detached_child_pid(self.0);
                }
            }
            let _untrack = UntrackOnExit(pid);
            let stdout = child.stdout.take().expect("piped stdout");
            let stderr = child.stderr.take().expect("piped stderr");

            // Chunks from both pipes flow through one channel preserving arrival
            // order, like node's stream events.
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut reader = std::io::BufReader::new(stdout);
                    let mut buf = [0u8; 8192];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if tx.send(buf[..n].to_vec()).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
            std::thread::spawn(move || {
                use std::io::Read;
                let mut reader = std::io::BufReader::new(stderr);
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });

            let mut waiter = tokio::task::spawn_blocking(move || child.wait());
            let timeout_deadline = timeout
                .filter(|t| *t > 0.0)
                .map(|t| tokio::time::Instant::now() + Duration::from_secs_f64(t));
            let mut abort_watcher = signal
                .as_ref()
                .map(|signal| Box::pin(signal.clone().cancelled_owned()));

            // Abort before spawn kills immediately (node checks signal.aborted
            // synchronously and attaches the abort listener otherwise).
            if let Some(signal) = &signal {
                if signal.is_cancelled() {
                    kill_process_tree(pid);
                }
            }

            let timed_out = Arc::new(AtomicBool::new(false));
            let exit_status: std::io::Result<std::process::ExitStatus> = 'wait: {
                loop {
                    tokio::select! {
                        status = &mut waiter => {
                            break 'wait status?;
                        }
                        _ = async {
                            match timeout_deadline {
                                Some(deadline) => tokio::time::sleep_until(deadline).await,
                                None => std::future::pending::<()>().await,
                            }
                        }, if !timed_out.load(Ordering::SeqCst) && timeout_deadline.is_some() => {
                            timed_out.store(true, Ordering::SeqCst);
                            kill_process_tree(pid);
                        }
                        _ = async {
                            match abort_watcher.as_mut() {
                                Some(cancelled) => cancelled.as_mut().await,
                                None => std::future::pending::<()>().await,
                            }
                        }, if abort_watcher.is_some() && !signal.as_ref().is_some_and(tokio_util::sync::CancellationToken::is_cancelled) => {
                            kill_process_tree(pid);
                        }
                        Some(chunk) = rx.recv() => {
                            (on_data)(&chunk);
                        }
                    }
                }
            };
            // Drain chunks that raced ahead of process exit: the pipe
            // readers close at EOF (process death), so this always finishes.
            while let Some(chunk) = rx.recv().await {
                (on_data)(&chunk);
            }

            let status = exit_status.map_err(|err| anyhow::anyhow!("{err}"))?;

            if let Some(signal) = &signal {
                if signal.is_cancelled() {
                    anyhow::bail!("aborted");
                }
            }
            if timed_out.load(Ordering::SeqCst) {
                anyhow::bail!("timeout:{}", timeout.unwrap_or_default());
            }
            Ok(status.code())
        })
    }
}

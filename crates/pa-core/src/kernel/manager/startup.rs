//! Startup and child wiring: kernel process spawn, python resolution, stderr
//! capture, and readiness handshake.

use super::*;

// ---------------------------------------------------------------------------
// Startup and child wiring
// ---------------------------------------------------------------------------

impl Inner {
    /// True when a teardown (or newer start) superseded the start that
    /// captured `generation`.
    pub(crate) fn start_stale(&self, generation: u64) -> bool {
        lock(&self.guarded).start_generation != generation
    }

    /// Child stderr tail for error messages: at most the last 1024 chars.
    fn stderr_tail(&self, limit: usize) -> String {
        let stderr = lock(&self.guarded).kernel_stderr.clone();
        let chars: Vec<char> = stderr.chars().collect();
        let start = chars.len().saturating_sub(limit);
        chars[start..].iter().collect()
    }

    /// Append raw kernel stderr text to the diagnostics tail (last 8 KiB).
    fn append_kernel_stderr_text(&self, text: &str) {
        let mut g = lock(&self.guarded);
        g.kernel_stderr.push_str(text);
        if g.kernel_stderr.len() > MAX_KERNEL_STDERR_CHARS {
            let chars: Vec<char> = g.kernel_stderr.chars().collect();
            let start = chars.len().saturating_sub(MAX_KERNEL_STDERR_CHARS);
            g.kernel_stderr = chars[start..].iter().collect();
        }
    }

    /// Append one `[kernel]`-prefixed diagnostic line.
    pub(crate) fn append_diagnostic(&self, message: &str) {
        let line = if message.ends_with('\n') {
            format!("[kernel] {message}")
        } else {
            format!("[kernel] {message}\n")
        };
        self.append_kernel_stderr_text(&line);
    }

    /// Open (and rotate when oversized) the kernel stderr log. The write budget
    /// is the file's remaining capacity, so current and `.old` each stay near
    /// the ceiling.
    fn open_stderr_log(&self) -> Option<Arc<Mutex<StderrLog>>> {
        let path = self.options.stderr_log_path.as_ref()?;
        match self.open_stderr_log_at(path) {
            Ok(log) => Some(log),
            Err(error) => {
                self.append_diagnostic(&format!("cannot open kernel stderr log: {error}"));
                None
            }
        }
    }

    fn open_stderr_log_at(&self, path: &std::path::Path) -> anyhow::Result<Arc<Mutex<StderrLog>>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut size = path.metadata().map_or(0, |m| m.len());
        if size > MAX_KERNEL_STDERR_LOG_BYTES {
            let old = path.with_extension("log.old");
            let _ = std::fs::remove_file(&old);
            match std::fs::rename(path, &old) {
                Ok(()) => size = 0,
                Err(error) => {
                    // A failed rotation must not cost the log: keep appending.
                    self.append_diagnostic(&format!("cannot rotate kernel stderr log: {error}"));
                }
            }
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        Ok(Arc::new(Mutex::new(StderrLog {
            file,
            budget: MAX_KERNEL_STDERR_LOG_BYTES.saturating_sub(size),
        })))
    }

    /// The Python interpreter this kernel runs on: the explicit option when
    /// present, else the auto-bootstrapped kernel venv.
    async fn resolve_python(
        self: &Arc<Self>,
        options: &KernelStartOptions,
    ) -> anyhow::Result<std::path::PathBuf> {
        if let Some(python) = &self.options.python {
            return Ok(python.clone());
        }
        if let Some(cached) = lock(&self.resolved_python).clone() {
            return Ok(cached);
        }
        let progress = options.on_bootstrap_progress.clone();
        let skills = self.options.python_skills.clone();
        let python = crate::kernel::bootstrap::ensure_kernel_python(
            crate::kernel::bootstrap::EnsureKernelPythonOptions {
                python_skills: skills,
                on_progress: progress,
            },
        )
        .await?;
        *lock(&self.resolved_python) = Some(python.clone());
        Ok(python)
    }

    /// Perform the startup: resolve the interpreter, spawn `python -m rlm.repl`,
    /// complete the protocol handshake, and mark the kernel running.
    pub(crate) async fn do_start(
        self: &Arc<Self>,
        options: &KernelStartOptions,
    ) -> anyhow::Result<()> {
        {
            let mut g = lock(&self.guarded);
            if g.state != KernelState::Idle {
                return Ok(());
            }
            g.start_generation += 1;
            g.state = KernelState::Starting;
        }
        // Tracked from the moment startup begins so cleanup can dispose a
        // kernel that is still booting.
        live_kernels::add(self);

        let python = match self.resolve_python(options).await {
            Ok(python) => python,
            Err(error) => {
                if self.start_stale(self.current_generation()) {
                    // Never touch a newer start's state.
                    return Err(error);
                }
                live_kernels::remove(self);
                let mut g = lock(&self.guarded);
                if g.state != KernelState::Shutdown {
                    g.state = KernelState::Idle;
                }
                return Err(error);
            }
        };
        let generation = self.current_generation();
        if self.start_stale(generation) {
            return Err(anyhow!("Kernel start superseded"));
        }
        if lock(&self.guarded).state == KernelState::Shutdown {
            return Err(anyhow!("Kernel was disposed during startup"));
        }

        // bash.py journals its process groups under this pid so the host can
        // reap them if the runtime dies without running its shutdown hook.
        let mut env: HashMap<String, String> = std::env::vars().collect();
        for (key, value) in &self.options.env {
            env.insert(key.clone(), value.clone());
        }
        env.insert(
            "PRIME_AGENT_KERNEL_OWNER_PID".to_string(),
            std::process::id().to_string(),
        );
        let cwd = self.options.cwd.clone();
        let mut command = tokio::process::Command::new(&python);
        command
            .args(["-m", "rlm.repl"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Hidden window on Windows (TS `spawnHidden`); the kernel stays in
        // this process's group - its lifecycle is supervised directly.
        crate::platform::process::set_no_window(command.as_std_mut());
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }
        command.env_clear().envs(env);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                // Fail a pending start promptly instead of riding out the
                // ready timeout. The interpreter itself failed to launch, so
                // the memoized runtime-ready result is stale: drop it so a
                // startup retry re-probes (and rebuilds when the probe fails).
                crate::kernel::bootstrap::invalidate_runtime_probe_cache();
                self.append_diagnostic(&format!("spawn error: {error}"));
                {
                    let mut g = lock(&self.guarded);
                    g.state = KernelState::Shutdown;
                }
                live_kernels::remove(self);
                if let Some(tx) = lock(&self.guarded).ready_tx.take() {
                    let _ = tx.send(Err(anyhow!("spawn error: {error}")));
                }
                self.cleanup_resources(Signal::Term);
                return Err(anyhow!(
                    "failed to spawn kernel python {}: {error}",
                    python.display()
                ));
            }
        };
        let pid = child.id().map_or(-1, |p| p as i32);
        orphan_journal::record_orphan_process_state(pid, true);
        let (ready_tx, ready_rx) = oneshot::channel::<anyhow::Result<i64>>();
        {
            let mut g = lock(&self.guarded);
            g.startup_protocol_error = None;
            g.ready_tx = Some(ready_tx);
        }
        self.wire_child(child, generation);

        let protocol = match self.wait_for_ready(ready_rx, generation).await {
            Ok(protocol) => protocol,
            Err(error) => {
                if self.start_stale(generation) {
                    // Never tear down a newer start's kernel.
                    return Err(error);
                }
                // The child died or never reached ready, so the memoized
                // runtime-ready result is stale: drop it and let a startup
                // retry re-probe (and rebuild the venv when the probe fails).
                crate::kernel::bootstrap::invalidate_runtime_probe_cache();
                let can_retry_startup = lock(&self.guarded).state != KernelState::Shutdown;
                // Only the call that performed the cleanup may resurrect to
                // idle; a concurrent kill()/teardown owns the state otherwise.
                let performed = self
                    .perform_shutdown(KernelShutdownOptions::default())
                    .await;
                if performed && can_retry_startup {
                    lock(&self.guarded).state = KernelState::Idle;
                }
                return Err(error);
            }
        };
        if self.start_stale(generation) {
            return Err(anyhow!("Kernel start superseded"));
        }
        if let Some(startup_error) = lock(&self.guarded).startup_protocol_error.clone() {
            return Err(anyhow!("{startup_error}"));
        }
        if protocol != REPL_PROTOCOL_VERSION as i64 {
            // A stale runtime passed a memoized probe's key but speaks the
            // wrong protocol: the memo is stale, so a retry re-probes.
            crate::kernel::bootstrap::invalidate_runtime_probe_cache();
            return Err(anyhow!(
                "Kernel runtime speaks protocol {protocol}, expected {REPL_PROTOCOL_VERSION}. \
                 Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent."
            ));
        }
        lock(&self.guarded).state = KernelState::Running;
        Ok(())
    }

    pub(crate) fn current_generation(&self) -> u64 {
        lock(&self.guarded).start_generation
    }

    /// Wire the spawned child: protocol reader, stderr tail + log, and the
    /// exit watcher that settles the manager when the process dies.
    fn wire_child(self: &Arc<Self>, mut child: tokio::process::Child, generation: u64) {
        let pid = child.id().map_or(-1, |p| p as i32);
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = Arc::new(tokio::sync::Mutex::new(stdin));
        let (exit_tx, exit_rx) = tokio::sync::watch::channel::<Option<ExitInfo>>(None);
        *lock(&self.child) = Some(ChildHandle {
            pid,
            stdin: stdin.clone(),
            exit_rx,
        });

        if let Some(stdout) = stdout {
            // Weak, upgraded per event: the readers stay blocked on the
            // child's pipes for the kernel's whole life, so a strong handle
            // here would outlive every manager clone and the process would
            // survive the drop that should have torn it down (#232 hygiene:
            // a dropped session leaked its live kernel until the runtime's
            // owner watchdog reaped it, if ever).
            let inner = Arc::downgrade(self);
            let stdin_for_error = stdin;
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim_end_matches('\n');
                            if trimmed.trim().is_empty() {
                                continue;
                            }
                            let Some(inner) = inner.upgrade() else {
                                break;
                            };
                            match parse_event(trimmed) {
                                Ok(event) => inner.handle_event(event),
                                Err(reason) => {
                                    let _ = stdin_for_error;
                                    inner.fail_protocol_frame(generation, &reason);
                                }
                            }
                        }
                    }
                }
            });
        }

        if let Some(stderr) = stderr {
            // Weak like the stdout reader (same drop semantics), upgraded
            // per chunk; the log file drains to EOF regardless.
            let inner = Arc::downgrade(self);
            let log = self.open_stderr_log();
            // Keep the host-side handle so teardown drops its reference; the
            // reader task's handle closes the file when the stream ends.
            (*lock(&self.stderr_log)).clone_from(&log);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut pending: Vec<u8> = Vec::new();
                let mut buffer = [0u8; 4096];
                // Incremental UTF-8 decoding: a chunk boundary can split a
                // multi-byte character, so only complete sequences surface.
                let decode = |pending: &mut Vec<u8>| {
                    let text = String::from_utf8_lossy(pending);
                    let decoded = text.into_owned();
                    pending.clear();
                    decoded
                };
                loop {
                    match reader.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            pending.extend_from_slice(&buffer[..n]);
                            let decoded = decode(&mut pending);
                            let Some(inner) = inner.upgrade() else {
                                break;
                            };
                            inner.append_kernel_stderr_text(&decoded);
                            if let Some(log) = &log {
                                let mut log = lock(log);
                                if log.budget >= n as u64 {
                                    let _ = log.file.write_all(&buffer[..n]);
                                    let _ = log.file.flush();
                                    log.budget -= n as u64;
                                } else if log.budget > 0 {
                                    let _ = log
                                        .file
                                        .write_all(KERNEL_STDERR_LOG_BUDGET_MARKER.as_bytes());
                                    let _ = log.file.flush();
                                    log.budget = 0;
                                }
                            }
                        }
                    }
                }
                if let Some(inner) = inner.upgrade() {
                    if !pending.is_empty() {
                        inner.append_kernel_stderr_text(&decode(&mut pending));
                    }
                    // Both the natural EOF and the kill path end here; the ready
                    // handshake waits on this notification for the final tail.
                    inner.stderr_closed_flag.store(true, Ordering::SeqCst);
                    inner.stderr_closed.notify_waiters();
                }
            });
        }

        // Weak like the readers: the watcher stays blocked on the child's
        // exit for the kernel's whole life, and owning the manager strongly
        // would keep the kernel alive past the last manager's drop (the very
        // retention the readers no longer hold). The child handle stays here
        // so the exit is still reaped after a teardown kill.
        let inner = Arc::downgrade(self);
        tokio::spawn(async move {
            let exit = match child.wait().await {
                Ok(status) => ExitInfo {
                    code: status.code(),
                    #[cfg(unix)]
                    signal: unix_signal_of(&status),
                    #[cfg(not(unix))]
                    signal: None,
                },
                Err(_) => ExitInfo {
                    code: None,
                    signal: None,
                },
            };
            let _ = exit_tx.send(Some(exit));
            let Some(inner) = inner.upgrade() else {
                return;
            };
            if inner.start_stale(generation) {
                return;
            }
            // append_diagnostic re-locks `guarded`, so it must run OUTSIDE
            // this lock scope (a std Mutex is not reentrant).
            let was_live = {
                let mut g = lock(&inner.guarded);
                let was_live = g.state != KernelState::Shutdown;
                g.state = KernelState::Shutdown;
                was_live
            };
            if was_live {
                inner.append_diagnostic(&format!(
                    "unexpected exit code={} signal={}",
                    exit.code.map_or("null".to_string(), |c| c.to_string()),
                    exit.signal.map_or("null".to_string(), |s| s.to_string()),
                ));
            }
            live_kernels::remove(&inner);
            // This exit is part of an in-flight graceful shutdown(): that call
            // owns the teardown and runs cleanup itself.
            // Scoped reads: locking the same std Mutex twice in one
            // expression self-deadlocks (non-reentrant).
            let graceful_in_flight = {
                let g = lock(&inner.guarded);
                g.graceful_shutdown_generation == Some(g.start_generation)
            };
            if graceful_in_flight {
                return;
            }
            inner.cleanup_resources(Signal::Term);
        });
    }

    /// The protocol handshake: the runtime's `ready` frame, the child dying
    /// first, or the 30-second ceiling — whichever comes first.
    async fn wait_for_ready(
        &self,
        ready_rx: oneshot::Receiver<anyhow::Result<i64>>,
        generation: u64,
    ) -> anyhow::Result<i64> {
        let mut ready_rx = ready_rx;
        let mut exit_rx = lock(&self.child)
            .as_ref()
            .map(|c| c.exit_rx.clone())
            .ok_or_else(|| anyhow!("Kernel ready state is missing"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(READY_TIMEOUT_MS);
        let mut protocol = None;
        while protocol.is_none() {
            let timeout = tokio::time::sleep_until(deadline);
            tokio::select! {
                ready = &mut ready_rx => {
                    match ready {
                        Ok(Ok(value)) => protocol = Some(value),
                        Ok(Err(error)) => return Err(error),
                        // Dropped only by teardown, which resolves the wait itself.
                        Err(_) => return Err(anyhow!("Kernel ready state is missing")),
                    }
                }
                _ = exit_rx.changed() => {
                    if exit_rx.borrow().is_some() {
                        // Final stderr chunks can still be in flight; wait for
                        // the drained pipe (the ready deadline still bounds it).
                        let stderr_drain = async {
                            loop {
                                if self.stderr_closed_flag.load(Ordering::SeqCst) {
                                    return;
                                }
                                self.stderr_closed.notified().await;
                            }
                        };
                        tokio::select! {
                            () = stderr_drain => {}
                            () = tokio::time::sleep_until(deadline) => {}
                        }
                        let tail = self.stderr_tail(1024);
                        return Err(anyhow!("Kernel exited before ready. stderr:\n{}", if tail.is_empty() { "(empty)".to_string() } else { tail }));
                    }
                }
                () = timeout => {
                    let tail = self.stderr_tail(1024);
                    return Err(anyhow!("Kernel did not become ready within {READY_TIMEOUT_MS}ms. stderr tail:\n{}", if tail.is_empty() { "(empty)".to_string() } else { tail }));
                }
            }
        }
        let _ = generation;
        Ok(protocol.expect("loop only exits with a protocol value"))
    }
}

#[cfg(unix)]
fn unix_signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    crate::platform::process::termination_signal(status)
}

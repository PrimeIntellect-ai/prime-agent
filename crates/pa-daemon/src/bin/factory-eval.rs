//! Factory capability eval driver: the real-token harness run.
//!
//! Port of the TS-era `packages/coding-agent/scripts/factory-eval.ts`
//! (#2402). Runs the factory capability layer against live sessions: each
//! reference factory from [`pa_core::factory_eval`] executes through the
//! real executor (`rlm.factory.run/status/stop` in a real kernel), paired
//! with a hand-written manual-orchestration baseline that does the same
//! topology with `rlm.spawn` + `rlm.collect`. The escalation and dry-run
//! probes run once per sweep.
//!
//! This harness spends real model tokens and never runs in CI; the
//! deterministic pieces (specs, prompts, checkers, replay, verdicts,
//! reporting) are unit-tested in `pa_core::factory_eval::tests`, and the
//! daemon-level flow is smoke-tested by
//! `crates/pa-daemon/tests/factory_workflow_e2e.rs`.
//!
//! Where the TS-era harness created isolated in-process sessions, this
//! port spawns one dedicated supervisor (the product binary) on a private
//! socket: the factory executor's children are real supervisor child
//! sessions exactly like production, and the eval's factory specs are
//! seeded into the harness store the kernels load through
//! `RLM_HARNESS_STATE_DIR` (one shared eval harness dir per run — the
//! Rust-era kernel-side harness seam is process-level env, not the
//! TS-era per-session pointer).
//!
//! Kernel python discipline (the TS-era harness rule): the caller's
//! explicit pin, the checkout-local runtime venv, or the shared kernel
//! venv with this checkout's runtime source prepended on PYTHONPATH — a
//! pinned python is never rebuilt, so a dev checkout never rebuilds the
//! shared kernel venv that live sessions run on. When no candidate probes
//! factory-capable and a shared venv exists, the driver fails fast with
//! the venv recipe instead of letting the standard bootstrap rebuild it.
//! With no shared venv at all (CI), the standard bootstrap builds it from
//! this checkout's runtime — safe, nothing live depends on it.
//!
//! Usage:
//!
//! ```text
//! factory-eval [--model provider/id] [--factories review-sweep,builder,resident-watcher,pr-manager]
//!   [--width N] [--trials N] [--timeout-minutes M] [--out DIR] [--replay FILE]
//! ```

// The live sweep is unix-only end to end (the supervisor socket is a unix
// domain socket): the live-mode helpers and their imports compile only
// there. The windows cross-check still builds the bin: its offline
// `--replay` mode is pure ledger analysis, and the live entry point
// refuses cleanly at startup.
#[cfg(unix)]
use pa_core::factory_eval::{
    build_baseline_prompt, build_factory_parent_prompt, build_harness_state_file,
    build_reference_factories, check_replay_ledger, check_task_success, find_reference_factory,
    parse_answer_line, render_markdown_report, serialize_eval_report, EvalArm,
    FactoryEvalTrialResult, ReferenceFactoryKind, TrialVerdict, FACTORY_KERNEL_VENV_RECIPE,
};
use pa_core::factory_eval::{parse_eval_args, run_replay_checks, EvalArgsError, FactoryEvalConfig};
#[cfg(unix)]
use serde_json::json;
use serde_json::Value;
use std::fs;
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Child, Command, Stdio};
#[cfg(unix)]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A blocking JSONL client for the eval's dedicated supervisor socket.
#[cfg(unix)]
struct Client {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
    request_id: u64,
}

#[cfg(unix)]
impl Client {
    fn connect(socket: &Path) -> Result<Self, String> {
        let stream = std::os::unix::net::UnixStream::connect(socket).map_err(|error| {
            format!(
                "connect to the eval supervisor at {}: {error}",
                socket.display()
            )
        })?;
        let writer = stream
            .try_clone()
            .map_err(|error| format!("clone the eval supervisor socket: {error}"))?;
        let mut client = Self {
            reader: BufReader::new(stream),
            writer,
            request_id: 0,
        };
        let hello = client.read_line(Duration::from_secs(15))?;
        if hello.get("type").and_then(Value::as_str) != Some("daemon_hello") {
            return Err(format!("unexpected supervisor greeting: {hello}"));
        }
        Ok(client)
    }

    fn read_line(&mut self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        let mut line = String::new();
        loop {
            self.reader
                .get_ref()
                .set_read_timeout(Some(Duration::from_millis(100)))
                .map_err(|error| format!("set read timeout: {error}"))?;
            match self.reader.read_line(&mut line) {
                Ok(0) => return Err("the eval supervisor closed the connection".to_string()),
                // A large frame can straddle the 100ms read windows: the
                // buffer resets only after a complete line is consumed, so
                // a read timeout keeps the partial bytes instead of
                // discarding them and failing the frame's parse.
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => {
                    return serde_json::from_str(line.trim())
                        .map_err(|error| format!("invalid supervisor line: {error}"));
                }
                // Only the poll timeout (WouldBlock on Unix, TimedOut on
                // Windows) means "no line yet". Any other read error — a
                // reset or broken socket, invalid UTF-8 — is persistent,
                // so retrying would busy-loop the rest of the command
                // budget instead of failing the trial fast.
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut =>
                {
                    if Instant::now() >= deadline {
                        return Err(format!("timed out reading from the supervisor: {error}"));
                    }
                }
                Err(error) => return Err(format!("supervisor socket error: {error}")),
            }
        }
    }

    fn command(&mut self, command: &Value, timeout: Duration) -> Result<Value, String> {
        self.request_id += 1;
        let id = format!("factory-eval-{}", self.request_id);
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope)
            .map_err(|error| format!("serialize command: {error}"))?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .map_err(|error| format!("send command: {error}"))?;
        self.writer
            .flush()
            .map_err(|error| format!("flush command: {error}"))?;
        // One fixed budget for the whole command: the supervisor broadcasts
        // unsolicited frames, and a full-timeout retry per frame would let a
        // steady broadcast stream delay the response indefinitely.
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("timed out waiting for the command response".to_string());
            }
            let response = self.read_line(remaining)?;
            if response.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                return Ok(response);
            }
        }
    }

    fn command_data(&mut self, command: &Value, timeout: Duration) -> Result<Value, String> {
        let response = self.command(command, timeout)?;
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            let error = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(error.to_string());
        }
        Ok(response.get("data").cloned().unwrap_or(Value::Null))
    }
}

/// The per-run scratch root: the process id plus the start time keeps two
/// harness runs launched in the same millisecond from sharing directories.
#[cfg(unix)]
fn runs_root_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "factory-eval-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ))
}

/// Locate the sibling `pa-daemon` binary (the driver spawns its own
/// dedicated supervisor — the product binary, real child sessions).
#[cfg(unix)]
fn supervisor_binary() -> Result<PathBuf, String> {
    let profile_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .ok_or_else(|| "cannot resolve the driver's own binary directory".to_string())?;
    let daemon = profile_dir.join("pa-daemon");
    if daemon.exists() {
        return Ok(daemon);
    }
    Err(format!(
        "pa-daemon binary not found at {}; run `cargo build -p pa-daemon` (or the workspace gate \
         `cargo test --workspace`) first",
        daemon.display()
    ))
}

/// The user's real agent dir: the eval resolves real models through it
/// (auth.json + models.json), exactly like the TS-era harness built its
/// model registry from the default agent dir.
#[cfg(unix)]
fn real_agent_dir() -> Result<PathBuf, String> {
    pa_daemon::paths::agent_dir().map_err(|error| format!("resolve the agent dir: {error}"))
}

#[cfg(unix)]
struct Supervisor {
    child: Child,
}

#[cfg(unix)]
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn the eval's dedicated supervisor on a private socket. The kernel
/// harness store is the seeded eval dir (`RLM_HARNESS_STATE_DIR` flows to
/// every worker and kernel), and a pinned kernel python keeps a dev
/// checkout from rebuilding the shared kernel venv live sessions use.
#[cfg(unix)]
fn spawn_supervisor(
    socket: &Path,
    agent_dir: &Path,
    harness_dir: &Path,
    kernel: Option<&pa_core::factory_eval::FactoryKernelPython>,
) -> Result<Supervisor, String> {
    let binary = supervisor_binary()?;
    fs::create_dir_all(harness_dir).map_err(|error| format!("create the harness dir: {error}"))?;
    let stderr_log = fs::File::create(socket.with_extension("supervisor.log"))
        .map_err(|error| format!("open the supervisor log: {error}"))?;
    let stderr_log_copy = stderr_log
        .try_clone()
        .map_err(|error| format!("clone the supervisor log: {error}"))?;
    let mut command = Command::new(&binary);
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_log_copy))
        // The harness store the kernels load: the seeded factory specs.
        .env("RLM_HARNESS_STATE_DIR", harness_dir)
        // A supervisor killed at teardown must not leak its session workers
        // into later processes.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        );
    if let Some(kernel) = kernel {
        command.env("PRIME_AGENT_KERNEL_PYTHON", &kernel.python);
        if let Some(path) = &kernel.python_path {
            command.env("PYTHONPATH", path);
        }
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn the eval supervisor {}: {error}", binary.display()))?;
    wait_for_supervisor_socket(socket, &mut child, Instant::now() + Duration::from_secs(10))?;
    Ok(Supervisor { child })
}

/// Wait for the spawned supervisor to bind its socket. A supervisor that
/// exits before binding fails fast with its exit status — a startup crash
/// is already the failure, and polling the rest of the deadline would
/// surface it as a misleading socket error (the crash's stderr sits in
/// the supervisor log beside the socket). On expiry the child is killed
/// and reaped before one clean error surfaces: a `panic!` here would leak
/// the process (a `std::process::Child`'s drop never kills), so the
/// driver's exit must not leave a live supervisor — or any workers it
/// already launched — behind. `run()` propagates the error to `main`'s
/// clean exit path.
#[cfg(unix)]
fn wait_for_supervisor_socket(
    socket: &Path,
    child: &mut Child,
    deadline: Instant,
) -> Result<(), String> {
    while Instant::now() < deadline {
        if socket.exists() {
            return Ok(());
        }
        // An exited child is the failure itself: return its status now
        // (`try_wait` reaps it — no zombie stays) instead of polling the
        // deadline away on a dead supervisor.
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("poll the eval supervisor exit: {error}"))?
        {
            return Err(format!(
                "eval supervisor exited before binding {}: {status}",
                socket.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // The supervisor never bound its socket: kill and reap it, then name
    // the socket in the error (its supervisor log sits beside it).
    let _ = child.kill();
    let _ = child.wait();
    Err(format!(
        "eval supervisor socket never appeared at {}",
        socket.display()
    ))
}

#[cfg(unix)]
fn now_iso() -> String {
    pa_daemon::util::now_iso()
}

#[cfg(unix)]
fn read_json_file(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// The model must resolve before any token is spent: a probe create with
/// the configured model fails fast when the daemon cannot resolve it (a
/// bad --model used to surface as a per-trial failure).
#[cfg(unix)]
fn probe_model(client: &mut Client, config: &FactoryEvalConfig, root: &Path) -> Result<(), String> {
    let Some((provider, model_id)) = config.model.split_once('/') else {
        return Err(format!("model must be provider/id, got {}", config.model));
    };
    let probe_dir = root.join("model-probe");
    fs::create_dir_all(probe_dir.join("sessions"))
        .map_err(|error| format!("create the model probe dir: {error}"))?;
    let created = client.command_data(
        &json!({
            "type": "create",
            "name": "factory-eval-model-probe",
            "config": {
                "cwd": probe_dir.to_string_lossy(),
                "sessionDir": probe_dir.join("sessions").to_string_lossy(),
                "provider": provider,
                "model": model_id,
            },
        }),
        Duration::from_mins(2),
    )?;
    let session_id = created
        .get("activeSessionId")
        .and_then(Value::as_str)
        .or_else(|| created.get("sessionId").and_then(Value::as_str))
        .ok_or_else(|| format!("create returned no session id: {created}"))?;
    let _ = client.command(
        &json!({ "type": "kill", "activeSessionId": session_id }),
        Duration::from_secs(30),
    );
    let _ = fs::remove_dir_all(&probe_dir);
    Ok(())
}

/// What one driven trial captured before its cleanup: the session to kill,
/// the parsed ANSWER, and the session's context/total token counts.
#[cfg(unix)]
struct TrialCaptured {
    session_id: String,
    answer: Option<pa_core::factory_eval::ParsedAnswer>,
    context_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

/// A drive failure: the error message plus the created session id when one
/// exists — the cleanup kills that session instead of leaking it (a failed
/// trial must never leave a live session spending tokens after its row is
/// recorded).
#[cfg(unix)]
struct TrialDriveError {
    message: String,
    session_id: Option<String>,
}

/// Create the trial session, drive its parent turn to completion, and
/// capture the ANSWER and the token counts. Cleanup is the caller's
/// (`run_trial` kills the session and removes the trial dir on every
/// path).
// Each parameter is the trial's own identity (factory, arm, trial number)
// or an isolated filesystem role (trial root, sessions dir, ledger); a
// parameter struct would only shuttle the same values once.
#[allow(clippy::too_many_arguments)]
#[cfg(unix)]
fn drive_trial(
    client: &mut Client,
    config: &FactoryEvalConfig,
    factory: &pa_core::factory_eval::ReferenceFactory,
    arm: EvalArm,
    trial: u64,
    trial_root: &Path,
    sessions_dir: &Path,
    ledger_path: &Path,
) -> Result<TrialCaptured, TrialDriveError> {
    let fail = |message: String| TrialDriveError {
        message,
        session_id: None,
    };
    fs::create_dir_all(sessions_dir).map_err(|error| TrialDriveError {
        message: format!("create the trial dir: {error}"),
        session_id: None,
    })?;
    let Some((provider, model_id)) = config.model.split_once('/') else {
        return Err(fail(format!(
            "model must be provider/id, got {}",
            config.model
        )));
    };
    let prompt = match arm {
        EvalArm::Factory => build_factory_parent_prompt(factory, &ledger_path.to_string_lossy()),
        EvalArm::Baseline => build_baseline_prompt(factory, &ledger_path.to_string_lossy()),
    };
    let created = client
        .command_data(
            &json!({
                "type": "create",
                "name": format!("factory-eval-{}-{}-{trial}", factory.kind.as_str(), arm.as_str()),
                "config": {
                    "cwd": trial_root.to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "provider": provider,
                    "model": model_id,
                }
            }),
            Duration::from_mins(2),
        )
        .map_err(|message| TrialDriveError {
            message,
            session_id: None,
        })?;
    let session_id = created
        .get("activeSessionId")
        .and_then(Value::as_str)
        .or_else(|| created.get("sessionId").and_then(Value::as_str))
        .ok_or_else(|| TrialDriveError {
            message: format!("create returned no session id: {created}"),
            session_id: None,
        })?
        .to_string();

    // The whole trial is one parent turn, bounded by the trial timeout:
    // `prompt_and_wait` answers only when the turn completes.
    client
        .command_data(
            &json!({
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": prompt,
            }),
            Duration::from_secs(config.timeout_minutes * 60),
        )
        .map_err(|message| TrialDriveError {
            message,
            session_id: Some(session_id.clone()),
        })?;
    let final_text = client
        .command_data(
            &json!({ "type": "get_last_assistant_text", "activeSessionId": session_id }),
            Duration::from_secs(30),
        )
        .map_err(|message| TrialDriveError {
            message,
            session_id: Some(session_id.clone()),
        })?
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string);
    let answer = parse_answer_line(final_text.as_deref());
    let stats = client
        .command_data(
            &json!({ "type": "get_session_stats", "activeSessionId": session_id }),
            Duration::from_secs(30),
        )
        .map_err(|message| TrialDriveError {
            message,
            session_id: Some(session_id.clone()),
        })?;
    let context_tokens = stats
        .get("contextUsage")
        .and_then(|usage| usage.get("tokens"))
        .and_then(Value::as_u64);
    let total_tokens = stats
        .get("tokens")
        .and_then(|tokens| tokens.get("total"))
        .and_then(Value::as_u64);
    Ok(TrialCaptured {
        session_id,
        answer,
        context_tokens,
        total_tokens,
    })
}

/// Run one factory- or baseline-arm trial: create the isolated session,
/// drive the parent prompt to completion, score the answer against the
/// ledger the parent saved, and clean up on every path.
// The trial's identity plus its isolated runs root: the call site owns
// one trial per invocation, so bundling the few scalars would only add a
// struct to shuttle them.
#[allow(clippy::too_many_arguments)]
#[cfg(unix)]
fn run_trial(
    client: &mut Client,
    config: &FactoryEvalConfig,
    factory: &pa_core::factory_eval::ReferenceFactory,
    arm: EvalArm,
    trial: u64,
    runs_root: &Path,
) -> FactoryEvalTrialResult {
    let started = Instant::now();
    let trial_root = runs_root.join(format!(
        "{}-{}-trial-{trial}",
        factory.kind.as_str(),
        arm.as_str()
    ));
    let sessions_dir = trial_root.join("sessions");
    let ledger_path = trial_root.join("ledger.json");
    let outcome: Result<TrialCaptured, TrialDriveError> = drive_trial(
        client,
        config,
        factory,
        arm,
        trial,
        &trial_root,
        &sessions_dir,
        &ledger_path,
    );
    // The parent's ledger dump is read BEFORE the cleanup deletes the trial
    // dir (a factory arm scores against this dump; a baseline arm reads its
    // own collect dump from the same path).
    let ledger_dump = read_json_file(&ledger_path);
    // Cleanup on every path: the session is killed and the trial dir removed
    // whether the trial scored or errored, so a failed trial can never leave
    // a live session issuing real model requests after it ends — a drive
    // that failed after its create still carries the created session id on
    // the error for exactly this kill.
    let kill_session_id = match &outcome {
        Ok(captured) => Some(captured.session_id.clone()),
        Err(drive_error) => drive_error.session_id.clone(),
    };
    if let Some(session_id) = kill_session_id {
        let _ = client.command(
            &json!({ "type": "kill", "activeSessionId": session_id }),
            Duration::from_secs(30),
        );
    }
    let _ = fs::remove_dir_all(&trial_root);
    let wall_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match outcome {
        Err(drive_error) => FactoryEvalTrialResult::error_row(
            factory,
            arm,
            trial,
            &config.model,
            &drive_error.message,
            wall_ms,
        ),
        Ok(captured) => {
            let ledger = ledger_dump;
            match arm {
                EvalArm::Factory => {
                    let check = check_task_success(
                        factory,
                        captured.answer.as_ref(),
                        ledger.as_ref(),
                        EvalArm::Factory,
                        None,
                    );
                    let replay = ledger.as_ref().map(check_replay_ledger);
                    let ledger_missing =
                        ledger.is_none() && factory.kind != ReferenceFactoryKind::DryRunReject;
                    let mut problems = Vec::new();
                    if ledger_missing {
                        problems.push("status ledger was not written".to_string());
                    }
                    FactoryEvalTrialResult::factory_row(
                        factory,
                        trial,
                        &config.model,
                        &check,
                        problems,
                        captured.answer,
                        ledger,
                        replay.as_ref(),
                        wall_ms,
                        captured.context_tokens,
                        captured.total_tokens,
                    )
                }
                EvalArm::Baseline => {
                    let check = check_task_success(
                        factory,
                        captured.answer.as_ref(),
                        None,
                        EvalArm::Baseline,
                        ledger.as_ref(),
                    );
                    FactoryEvalTrialResult::baseline_row(
                        factory,
                        trial,
                        &config.model,
                        &check,
                        Vec::new(),
                        captured.answer,
                        wall_ms,
                        captured.context_tokens,
                        captured.total_tokens,
                    )
                }
            }
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // The offline replay mode never touches a daemon or a model.
    if let Some(position) = argv.iter().position(|arg| arg == "--replay") {
        let replay_path = argv.get(position + 1).cloned().unwrap_or_default();
        if replay_path.is_empty() {
            eprintln!("--replay requires a path to a report.json or a single status ledger");
            std::process::exit(1);
        }
        let data = match fs::read_to_string(&replay_path)
            .map_err(|error| format!("{error}"))
            .and_then(|content| {
                serde_json::from_str::<Value>(&content).map_err(|error| format!("{error}"))
            }) {
            Ok(data) => data,
            Err(error) => {
                eprintln!("cannot read replay input {replay_path}: {error}");
                std::process::exit(1);
            }
        };
        let replay = run_replay_checks(&data);
        for entry in &replay.ledgers {
            println!(
                "replay {}: {}",
                entry.id,
                if entry.result.ok { "ok" } else { "failed" }
            );
            for problem in &entry.result.problems {
                println!("  - {problem}");
            }
        }
        if replay.ok {
            println!("all ledgers replay cleanly");
        } else {
            eprintln!("replay check failed");
            std::process::exit(1);
        }
        return;
    }
    let config = match parse_eval_args(&argv) {
        Ok(config) => config,
        Err(EvalArgsError::Help) => {
            println!("See the header of factory-eval.rs for usage.");
            return;
        }
        Err(EvalArgsError::Message(message)) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    match run(&config) {
        Ok(()) => {}
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

/// Run every configured trial pair plus the two probes, logging and
/// counting every trial (a thrown trial stays in the sweep as its own
/// failed row — the report can never cover a subset of the planned
/// trials).
#[cfg(unix)]
fn run_sweep(
    client: &mut Client,
    config: &FactoryEvalConfig,
    reference_factories: &[pa_core::factory_eval::ReferenceFactory],
    runs_root: &Path,
) -> Vec<FactoryEvalTrialResult> {
    let mut results: Vec<FactoryEvalTrialResult> = Vec::new();

    for selection in &config.factories {
        let factory = find_reference_factory(reference_factories, *selection);
        for trial in 1..=config.trials {
            println!(
                "running {} factory trial {trial}/{} on {}",
                factory.kind.as_str(),
                config.trials,
                config.model
            );
            results.push(run_trial(
                client,
                config,
                factory,
                EvalArm::Factory,
                trial,
                runs_root,
            ));
            println!(
                "running {} baseline trial {trial}/{} on {}",
                factory.kind.as_str(),
                config.trials,
                config.model
            );
            results.push(run_trial(
                client,
                config,
                factory,
                EvalArm::Baseline,
                trial,
                runs_root,
            ));
        }
    }
    let escalation =
        find_reference_factory(reference_factories, ReferenceFactoryKind::ReviewSweepFail);
    println!("running review-sweep escalation probe (one trial)");
    results.push(run_trial(
        client,
        config,
        escalation,
        EvalArm::Factory,
        1,
        runs_root,
    ));
    let broken = find_reference_factory(reference_factories, ReferenceFactoryKind::DryRunReject);
    println!("running dry-run rejection probe (one trial)");
    results.push(run_trial(
        client,
        config,
        broken,
        EvalArm::Factory,
        1,
        runs_root,
    ));
    results
}

#[cfg(unix)]
fn run(config: &FactoryEvalConfig) -> Result<(), String> {
    let runs_root = runs_root_path();
    fs::create_dir_all(&runs_root).map_err(|error| format!("create the runs root: {error}"))?;
    let socket = runs_root.join("eval-supervisor.sock");
    let harness_dir = runs_root.join("harness");

    // Seed the harness store BEFORE the supervisor starts: the factory
    // parent prompts resolve `rlm.factory.run('<id>')` against these
    // entries through RLM_HARNESS_STATE_DIR.
    let reference_factories = build_reference_factories(config.width);
    let now = now_iso();
    let state_body = build_harness_state_file(&reference_factories, &now);
    fs::create_dir_all(&harness_dir).map_err(|error| format!("create the harness dir: {error}"))?;
    fs::write(harness_dir.join("harness_state.json"), state_body)
        .map_err(|error| format!("seed the harness state: {error}"))?;

    // Kernel python: pin whenever a candidate probes factory-capable. A
    // stale shared venv must never be rebuilt under this harness.
    let explicit_pin = std::env::var_os("PRIME_AGENT_KERNEL_PYTHON").map(PathBuf::from);
    let (kernel, shared_venv_exists) =
        pa_core::factory_eval::resolve_factory_kernel_python(explicit_pin);
    if kernel.is_none() && shared_venv_exists {
        return Err(format!(
            "No factory-capable kernel python: point PRIME_AGENT_KERNEL_PYTHON at a python with a \
             current prime-agent-runtime, or create the checkout-local venv ({FACTORY_KERNEL_VENV_RECIPE}), \
             or refresh the shared kernel venv. Refusing the standard kernel bootstrap because it \
             would rebuild the shared kernel venv that live sessions run on."
        ));
    }

    let agent_dir = real_agent_dir()?;
    let supervisor = spawn_supervisor(&socket, &agent_dir, &harness_dir, kernel.as_ref())?;
    let mut client = Client::connect(&socket)?;
    // The model must resolve before any token is spent.
    probe_model(&mut client, config, &runs_root)?;

    let results = run_sweep(&mut client, config, &reference_factories, &runs_root);
    drop(client);
    drop(supervisor);
    if results.is_empty() {
        return Err("no trials completed".to_string());
    }

    let markdown = render_markdown_report(&results, config);
    let out_dir = PathBuf::from(&config.out_dir);
    fs::create_dir_all(&out_dir)
        .map_err(|error| format!("create {}: {error}", out_dir.display()))?;
    fs::write(out_dir.join("report.md"), &markdown)
        .map_err(|error| format!("write report.md: {error}"))?;
    let report = serialize_eval_report(config, results, &now_iso());
    fs::write(
        out_dir.join("report.json"),
        serde_json::to_string_pretty(&report)
            .map_err(|error| format!("serialize report.json: {error}"))?,
    )
    .map_err(|error| format!("write report.json: {error}"))?;
    println!("{markdown}");
    println!("reports written to {}", out_dir.display());
    let _ = fs::remove_dir_all(&runs_root);
    // Live mode must fail like --replay does: a failing trial verdict means
    // the capability layer did not do what the report says it should.
    if report
        .results
        .iter()
        .any(|row| row.verdict == TrialVerdict::Fail)
    {
        eprintln!("eval finished with failing trial verdict(s); see the report");
        std::process::exit(1);
    }
    Ok(())
}

/// The live sweep refuses on a platform without unix domain sockets: the
/// windows cross-check keeps the bin compiling (and its offline `--replay`
/// mode working); a real sweep needs a unix supervisor socket.
#[cfg(not(unix))]
fn run(_config: &FactoryEvalConfig) -> Result<(), String> {
    Err(
        "the factory-eval live sweep drives a unix domain socket supervisor; this platform \
         has none (the offline --replay mode still works)"
            .to_string(),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    /// The expired socket wait must kill and reap the child instead of
    /// panicking: a panic leaves the spawned supervisor alive (std's
    /// `Child` drop never kills), and the driver would leak the process
    /// past its exit. The live child below never binds the socket, and an
    /// already-expired deadline exercises the failure path
    /// deterministically; the kill's proof is that the child is gone once
    /// the helper returns (a leaked `sleep` would still hold the pid).
    #[test]
    fn an_expired_socket_wait_kills_and_reaps_the_spawned_child() {
        let socket = std::env::temp_dir().join("factory-eval-never.sock");
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the live child");
        let error = wait_for_supervisor_socket(&socket, &mut child, Instant::now())
            .expect_err("the socket never appears");
        assert!(
            error.contains(socket.to_string_lossy().as_ref()),
            "the error names the socket: {error}"
        );
        let pid = child.id();
        let gone = Command::new("bash")
            .arg("-c")
            .arg(format!("! kill -0 {pid}"))
            .status()
            .expect("probe the child pid");
        assert!(
            gone.success(),
            "the child was killed and reaped (pid {pid} still lives)"
        );
    }

    /// A supervisor that exits before binding fails fast with its exit
    /// status instead of polling to the deadline: a startup crash is
    /// already the failure, and the pre-fix wait burned the whole 10s
    /// budget and then reported a misleading socket error that hid the
    /// status (the crash's stderr sits in the supervisor log beside
    /// the socket). The deadline below is generous on purpose: without
    /// the child-exit check this test times out at it.
    #[test]
    fn a_supervisor_that_exits_before_binding_fails_fast_with_its_status() {
        let socket = std::env::temp_dir().join("factory-eval-early-exit.sock");
        let mut child = Command::new("bash")
            .arg("-c")
            .arg("exit 7")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the exiting child");
        let started = Instant::now();
        let error =
            wait_for_supervisor_socket(&socket, &mut child, started + Duration::from_secs(10))
                .expect_err("the child exits before binding");
        assert!(
            error.contains(socket.to_string_lossy().as_ref()),
            "the error names the socket: {error}"
        );
        assert!(
            error.contains("exit status: 7"),
            "the error carries the child's exit status: {error}"
        );
        // The wait failed fast, long before the deadline the pre-fix loop
        // would have polled to.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the wait failed fast, waited {:?}",
            started.elapsed()
        );
        // The exit probe reaped the child: no zombie stays behind.
        let pid = child.id();
        let gone = Command::new("bash")
            .arg("-c")
            .arg(format!("! kill -0 {pid}"))
            .status()
            .expect("probe the child pid");
        assert!(
            gone.success(),
            "the exited child was reaped (pid {pid} still lives)"
        );
    }

    /// A read error that is not the poll timeout is persistent — an
    /// undecodable frame keeps failing — so `read_line` must fail fast
    /// instead of retrying it like a poll timeout: the pre-fix arm masked
    /// a protocol violation behind the command deadline (which for a trial
    /// turn is the whole trial timeout), polling the rest of the budget
    /// away while the trial still read as live.
    #[test]
    fn a_persistent_read_error_fails_fast_instead_of_spinning() {
        let (driver, mut peer) = UnixStream::pair().expect("create the socket pair");
        let writer = driver.try_clone().expect("clone the driver side");
        peer.write_all(&[0xff, b'\n'])
            .expect("script the undecodable frame");
        let mut client = Client {
            reader: BufReader::new(driver),
            writer,
            request_id: 0,
        };
        let started = Instant::now();
        let error = client
            .read_line(Duration::from_secs(2))
            .expect_err("an undecodable frame must fail the read");
        assert!(
            error.contains("supervisor socket error") && error.contains("valid UTF-8"),
            "{error}"
        );
        // The error surfaced on the first read, long before the budget.
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the read failed fast, waited {:?}",
            started.elapsed()
        );
    }

    /// The poll timeout itself stays retryable: a frame that arrives after
    /// the 100ms read window times out with `WouldBlock`, and the client
    /// must keep polling until the line completes — the fragmented-frame
    /// retry the hello read depends on.
    #[test]
    fn a_poll_timeout_is_retried_until_the_line_arrives() {
        let (driver, mut peer) = UnixStream::pair().expect("create the socket pair");
        let writer = driver.try_clone().expect("clone the driver side");
        let mut client = Client {
            reader: BufReader::new(driver),
            writer,
            request_id: 0,
        };
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            peer.write_all(b"{\"type\":\"daemon_hello\"}\n")
                .expect("send the delayed frame");
        });
        let line = client
            .read_line(Duration::from_secs(2))
            .expect("the delayed frame must arrive");
        sender.join().expect("the sender finished");
        assert_eq!(
            line.get("type").and_then(Value::as_str),
            Some("daemon_hello")
        );
    }
}

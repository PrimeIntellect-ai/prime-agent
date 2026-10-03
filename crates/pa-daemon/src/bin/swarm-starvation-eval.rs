//! Swarm starvation eval driver: the real-token harness run.
//!
//! Port of `packages/coding-agent/scripts/swarm-starvation-eval.ts` (#2353).
//! Drives a real daemon orchestrator session (children spawn through the
//! product `rlm.spawn` surface and reply over the agent-message path) across
//! crew sizes x message sizes x arrival patterns, then scores each trial
//! against the pre-registered defense lines in [`pa_core::swarm_eval`].
//!
//! This harness spends real model tokens and never runs in CI; the
//! deterministic pieces (defense lines, prompts, verification, reporting,
//! argument parsing) are unit-tested in `pa_core::swarm_eval`, and the
//! daemon-level flow is smoke-tested by
//! `tests/swarm_starvation_eval_e2e.rs`.
//!
//! Usage:
//!
//! ```text
//! swarm-starvation-eval --model provider/id [--sizes 2,5,10,20,40] \
//!   [--msg-size short|long] [--pattern spread|burst] [--trials N] \
//!   [--gap-seconds S] [--timeout-minutes M|inf] [--out DIR] [--seed N] \
//!   [--socket PATH]
//! ```
//!
//! The daemon must already be running (its default socket is used unless
//! `--socket` overrides it); each trial creates its own session under a
//! temporary cwd/session dir, so no user session state is touched.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pa_core::swarm_eval::transcript::snapshot_from_transcript;
use pa_core::swarm_eval::{
    build_orchestrator_prompt, parse_answer_line, render_markdown_report, seeded_secrets,
    trial_deadline, trial_result_from_snapshot, DefenseVerdict, EvalArgsError,
    MessagingStatsSnapshot, SwarmEvalConfig, SwarmEvalTrialResult,
};
use pa_types::platform::transport::{connect_blocking, BlockingTransportStream};
use serde_json::{json, Value};

/// A blocking JSONL client for one daemon socket.
struct Client {
    reader: BufReader<Box<dyn BlockingTransportStream>>,
    writer: Box<dyn BlockingTransportStream>,
    request_id: u64,
}

impl Client {
    fn connect(socket: &Path) -> Result<Self, String> {
        let stream = connect_blocking(socket).map_err(|error| {
            format!(
                "failed to connect to the Prime Agent daemon at {}: {error}; start it with \
                 `prime-agent --mode daemon`",
                socket.display()
            )
        })?;
        let writer = stream
            .try_clone_box()
            .map_err(|error| format!("failed to clone the daemon socket: {error}"))?;
        let mut client = Self {
            reader: BufReader::new(stream),
            writer,
            request_id: 0,
        };
        // The daemon greets every client before it accepts commands.
        let hello = client.read_line(Duration::from_secs(15))?;
        if hello.get("type").and_then(Value::as_str) != Some("daemon_hello") {
            return Err(format!("unexpected daemon greeting: {hello}"));
        }
        Ok(client)
    }

    fn read_line(&mut self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        let mut line = String::new();
        loop {
            self.reader
                .get_ref()
                .set_read_timeout(Duration::from_millis(100))
                .map_err(|error| format!("failed to set the read timeout: {error}"))?;
            match self.reader.read_line(&mut line) {
                Ok(0) => return Err("the daemon closed the connection".to_string()),
                // A large frame can straddle the 100ms read windows: the
                // buffer resets only after a complete line is consumed, so
                // a read timeout keeps the partial bytes instead of
                // discarding them and failing the frame's parse.
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => {
                    return serde_json::from_str(line.trim())
                        .map_err(|error| format!("invalid daemon line: {error}"));
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
                        return Err(format!("timed out reading from the daemon: {error}"));
                    }
                }
                Err(error) => return Err(format!("daemon socket error: {error}")),
            }
        }
    }

    fn command(&mut self, command: &Value, timeout: Duration) -> Result<Value, String> {
        self.request_id += 1;
        let id = format!("swarm-eval-{}", self.request_id);
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line =
            serde_json::to_string(&envelope).map_err(|error| format!("serialize: {error}"))?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .map_err(|error| format!("failed to send command: {error}"))?;
        self.writer
            .flush()
            .map_err(|error| format!("failed to flush command: {error}"))?;
        // One fixed budget for the whole command: the daemon broadcasts
        // unsolicited frames (heartbeats_changed and friends) to attached
        // clients, and a full-timeout retry per frame would let a steady
        // broadcast stream delay the response — and the trial cleanup
        // behind it — indefinitely. Each read gets only what remains.
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
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (socket, argv) = match socket_from_args(&argv) {
        Ok((socket, argv)) => (socket, argv),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    let config = match pa_core::swarm_eval::parse_eval_args(&argv) {
        Ok(config) => config,
        Err(EvalArgsError::Help) => {
            println!("See the header of swarm-starvation-eval.rs for usage.");
            return;
        }
        Err(EvalArgsError::Message(message)) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    match run(&socket, &config) {
        Ok(()) => {}
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

/// The `--socket` flag overrides the daemon socket; it is extracted before
/// the shared parser because it addresses the driver itself, not the eval.
/// A trailing `--socket` without a value is an incomplete option, not an
/// omitted one: silently connecting to the default socket would spend real
/// tokens against the wrong daemon.
fn socket_from_args(argv: &[String]) -> Result<(PathBuf, Vec<String>), String> {
    let (socket, given, rest) = extract_flag(argv, "--socket");
    match (socket, given) {
        (Some(socket), _) => Ok((PathBuf::from(socket), rest)),
        (None, false) => Ok((pa_daemon::platform::default_daemon_socket_path(), rest)),
        (None, true) => Err("Missing value for --socket".to_string()),
    }
}

/// Pull one `--flag <value>` pair out of argv, leaving the rest. Returns
/// the value (absent when the flag is missing entirely or trails without
/// one) and whether the flag was present at all, so an incomplete option
/// can be told apart from an omitted one.
fn extract_flag(argv: &[String], flag: &str) -> (Option<String>, bool, Vec<String>) {
    let mut value = None;
    let mut given = false;
    let mut rest = Vec::new();
    let mut index = 0;
    while index < argv.len() {
        if argv[index] == flag {
            given = true;
            value = argv.get(index + 1).cloned();
            index += 2;
        } else {
            rest.push(argv[index].clone());
            index += 1;
        }
    }
    (value, given, rest)
}

/// The per-run tag: the process id plus the start time. It keeps two
/// harness processes launched in the same millisecond apart in every
/// per-run identity — the scratch root and the daemon session names,
/// which embed the same tag so a create is never refused over another
/// run's name.
fn run_tag() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

/// The per-run scratch root, uniquified by [`run_tag`].
fn runs_root_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("swarm-eval-{tag}"))
}

/// The daemon session name for one trial. The embedded run tag keeps the
/// name unique across harness processes: a leftover live session from a
/// crashed run (or a concurrent eval on the same daemon) no longer
/// refuses the create — a refusal that used to skip the orphan reconcile
/// and leave the blocking session spending tokens — and the orphan
/// reconcile can address an otherwise-unidentifiable orphan by name.
fn session_name(run_tag: &str, size: usize, trial: usize) -> String {
    format!("swarm-eval-{run_tag}-{size}-{trial}")
}

fn run(socket: &Path, config: &SwarmEvalConfig) -> Result<(), String> {
    let mut client = Client::connect(socket)?;
    let tag = run_tag();
    let runs_root = runs_root_path(&tag);
    fs::create_dir_all(&runs_root).map_err(|error| format!("create runs root: {error}"))?;

    let mut results: Vec<SwarmEvalTrialResult> = Vec::new();
    for &size in &config.sizes {
        for trial in 1..=config.trials {
            println!(
                "running crew size {size} trial {trial}/{} on {}",
                config.trials, config.model
            );
            let started = Instant::now();
            match run_trial(&mut client, socket, config, size, trial, &runs_root, &tag) {
                Ok(result) => results.push(result),
                Err(message) => {
                    eprintln!("trial failed: {message}");
                    // An errored trial stays in the sweep as its own row:
                    // zeroed counters, a failed task, and the error as the
                    // instant-fail reason. The report can then never cover a
                    // subset of the planned trials, and a never-completed
                    // crew size cannot hide behind the rows that did.
                    results.push(trial_result_from_snapshot(
                        config,
                        size,
                        trial,
                        &MessagingStatsSnapshot::default(),
                        false,
                        Some(format!("trial error: {message}")),
                        started.elapsed().as_secs_f64(),
                    ));
                }
            }
        }
    }
    if results.is_empty() {
        return Err("no trials completed".to_string());
    }

    let markdown = render_markdown_report(&results, config);
    let out_dir = PathBuf::from(&config.out_dir);
    fs::create_dir_all(&out_dir)
        .map_err(|error| format!("create {}: {error}", out_dir.display()))?;
    fs::write(out_dir.join("report.md"), &markdown)
        .map_err(|error| format!("write report.md: {error}"))?;
    let json_report = json!({ "config": config, "results": results });
    fs::write(
        out_dir.join("report.json"),
        serde_json::to_string_pretty(&json_report)
            .map_err(|error| format!("serialize report: {error}"))?,
    )
    .map_err(|error| format!("write report.json: {error}"))?;
    println!("{markdown}");
    println!("reports written to {}", out_dir.display());
    Ok(())
}

fn run_trial(
    client: &mut Client,
    socket: &Path,
    config: &SwarmEvalConfig,
    size: usize,
    trial: usize,
    runs_root: &Path,
    run_tag: &str,
) -> Result<SwarmEvalTrialResult, String> {
    let started = Instant::now();
    let (provider, model_id) = config
        .model
        .split_once('/')
        .ok_or_else(|| format!("model must be provider/id, got {}", config.model))?;
    let trial_root = runs_root.join(format!("size-{size}-trial-{trial}"));
    let sessions_dir = trial_root.join("sessions");
    fs::create_dir_all(&sessions_dir).map_err(|error| format!("create trial dir: {error}"))?;

    // The derived trial seed is `seed + 31 * size + trial` (i64). The
    // argument parser rejects a sweep that cannot represent it, but a
    // hand-built config still reaches here: the checked arithmetic fails
    // this trial cleanly instead of panicking (or silently wrapping the
    // seed in release builds).
    let size_seed = i64::try_from(size)
        .map_err(|_| format!("crew size {size} is too large to derive a trial seed"))?;
    let trial_seed = i64::try_from(trial)
        .map_err(|_| format!("trial {trial} is too large to derive a trial seed"))?;
    let seed = 31_i64
        .checked_mul(size_seed)
        .and_then(|offset| config.seed.checked_add(offset))
        .and_then(|seed| seed.checked_add(trial_seed))
        .ok_or_else(|| {
            format!(
                "seed {} with size {size} and trial {trial} overflows the derived trial seed",
                config.seed
            )
        })?;
    let secrets = seeded_secrets(seed, size);
    let prompt = build_orchestrator_prompt(config, size, &secrets);

    // The create's result classes decide the cleanup: a successful create
    // hands the session id to the shared cleanup below; a refused create
    // (the daemon answered) is authoritative — nothing was created; a
    // lost create response (timeout or transport reset) is ambiguous —
    // the daemon may already have created the trial's session, and with
    // no id returned it would outlive the run as a live orphan.
    let name = session_name(run_tag, size, trial);
    let create_result = client.command(
        &json!({
            "type": "create",
            "name": name,
            "config": {
                "cwd": trial_root.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "provider": provider,
                "model": model_id,
            },
        }),
        Duration::from_mins(2),
    );
    let created = match create_result {
        Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
            response.get("data").cloned().unwrap_or(Value::Null)
        }
        Ok(response) => {
            let _ = fs::remove_dir_all(&trial_root);
            return Err(format!("command failed: {response}"));
        }
        Err(error) => {
            // Reconcile the trial's own sessions dir over a fresh
            // connection and kill whatever the daemon reports there
            // before reporting the failure.
            let reconcile = reconcile_orphaned_create(client, socket, &sessions_dir, &name);
            let _ = fs::remove_dir_all(&trial_root);
            return Err(format!(
                "create failed: {error}; {}",
                reconcile_outcome(reconcile)
            ));
        }
    };
    let session_id = created
        .get("activeSessionId")
        .or_else(|| created.get("id"))
        .and_then(Value::as_str);
    let Some(session_id) = session_id else {
        // A create that answered success but carried no id can still have
        // left a live session: the daemon named the resident, and without
        // an id there is nothing to drive or kill directly. The reconcile
        // (row pass plus the name-addressed kill) is the only cleanup
        // that can reach it before the trial dir goes.
        let reconcile = reconcile_orphaned_create(client, socket, &sessions_dir, &name);
        let _ = fs::remove_dir_all(&trial_root);
        return Err(format!(
            "create returned no session id: {created}; {}",
            reconcile_outcome(reconcile)
        ));
    };
    let session_id = session_id.to_string();

    let outcome = drive_trial(
        client,
        config,
        size,
        trial,
        &session_id,
        &secrets,
        &prompt,
        started,
    );
    // The TS harness disposes the orchestrator in a `finally` block on every
    // path; this is the port's equivalent: the session is killed and the
    // trial directory removed whether the trial scored or errored, so a
    // failed prompt, poll, or stats request can never leave a live
    // orchestrator issuing real model requests after the trial ends.
    let cleanup = kill_session(client, socket, &session_id).map(|_| ());
    let _ = fs::remove_dir_all(&trial_root);
    match (outcome, cleanup) {
        (outcome, Ok(())) => outcome,
        // A scored trial whose session could not be confirmed killed is
        // not a completed trial: the row keeps its measurements but fails
        // with the cleanup failure, mirroring how the instant-fail fold
        // treats a rate-limit error.
        (Ok(mut result), Err(cleanup_error)) => {
            result.instant_fail = Some(format!("cleanup failed: {cleanup_error}"));
            result.verdict = DefenseVerdict::Fail;
            Ok(result)
        }
        (Err(message), Err(cleanup_error)) => Err(format!("{message}; {cleanup_error}")),
    }
}

/// After an ambiguous `create` (the response was lost to a timeout or a
/// transport reset), the daemon may still have created the trial's session
/// under the trial's own sessions dir — with no id ever returned, it would
/// outlive the run. The reconcile lists that dir over a fresh connection
/// and kills every session the daemon reports under it. Matching by the
/// trial's unique sessions dir keeps a concurrent harness process's or a
/// user's live session out of the kill set.
///
/// The list's path filter cannot see every orphan, though: a resident whose
/// `get_state` fails is summarized as a recovering row with neither a
/// `sessionFile` nor an `activeSessionId` (and a create still in flight
/// may not have written its session file at all), so the row filter would
/// skip the exact live session this pass exists to kill. The daemon
/// resolves a kill by the resident's name label too, and the trial's
/// session name embeds this run's process-unique tag, so a kill addressed
/// to the name reaches the orphan — and only this run's orphan. An
/// envelope saying the session is unknown means the create never landed
/// (or the path pass already killed it): settled, not an error.
///
/// The list pass is best-effort: a list that never answers (or answers
/// without a sessions field) is recorded, not fatal — the name-addressed
/// kill still runs, because the name is the only address an unlistable
/// orphan answers on. The fresh connection the passes prefer is
/// best-effort the same way: a reconnect that fails is recorded and the
/// passes fall back to the client in hand, which on the no-id path just
/// completed the create round trip. Only a name kill that cannot reach
/// the daemon fails the reconcile, carrying the reconnect and list
/// pass's errors along when there are any.
fn reconcile_orphaned_create(
    client: &mut Client,
    socket: &Path,
    sessions_dir: &Path,
    session_name: &str,
) -> Result<usize, String> {
    // The fresh connection heals the sweep's shared client when the
    // create's failure left its stream dead — every later pass needs a
    // live one. A reconnect that fails is recorded, not fatal: the
    // client in hand may still carry the passes (the no-id path's
    // create round trip just completed over it), and returning here
    // would abandon it and skip the name kill below, stranding the
    // orphan it exists to kill.
    let reconnect_error = match Client::connect(socket) {
        Ok(fresh) => {
            *client = fresh;
            None
        }
        Err(connect_error) => Some(format!("reconnect failed: {connect_error}")),
    };

    // The row pass is best-effort: a list that never answers (or one
    // without a sessions field) must not skip the name kill below — the
    // name is the only address an unlistable orphan still answers on.
    // The same holds for a kill the row pass loses mid-flight: the
    // daemon is tried by name, and only a name kill that cannot reach
    // the daemon fails the reconcile.
    let mut killed = 0;
    let mut row_pass_error = None;
    match kill_listed_orphans(client, socket, sessions_dir) {
        Ok(row_kills) => killed += row_kills,
        Err(error) => row_pass_error = Some(error),
    }
    // The name-addressed kill of last resort: it reaches the orphan the
    // row pass above cannot see (see the doc comment), and it runs even
    // when that pass could not list the dir — or the fresh connection
    // never came up. Only a success envelope counts as a kill — an
    // unknown-session answer means there was nothing left to kill.
    match kill_session(client, socket, session_name) {
        Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
            killed += 1;
        }
        Ok(_) => {}
        Err(name_error) => {
            let mut failure = Vec::new();
            if let Some(reconnect_error) = reconnect_error {
                failure.push(reconnect_error);
            }
            if let Some(row_pass_error) = row_pass_error {
                failure.push(row_pass_error);
            }
            failure.push(format!("the name-addressed kill failed: {name_error}"));
            return Err(failure.join("; "));
        }
    }
    Ok(killed)
}

/// The reconcile's row pass: list the trial's own sessions dir and kill
/// every daemon-reported row whose session file lives under it (the path
/// filter's concurrent-session guard, described on
/// [`reconcile_orphaned_create`]). The caller treats a failure here as
/// best-effort: the name-addressed kill still runs.
fn kill_listed_orphans(
    client: &mut Client,
    socket: &Path,
    sessions_dir: &Path,
) -> Result<usize, String> {
    let listed = client
        .command(
            &json!({
                "type": "list",
                "all": true,
                "sessionDir": sessions_dir.to_string_lossy(),
            }),
            Duration::from_secs(30),
        )
        .map_err(|error| format!("the trial sessions list failed: {error}"))?;
    let rows = listed
        .get("data")
        .and_then(|data| data.get("sessions"))
        .and_then(Value::as_array)
        .ok_or_else(|| "the trial sessions list returned no sessions field".to_string())?;
    let mut killed = 0;
    for row in rows {
        // `list { all: true, sessionDir }` also appends the daemon's other
        // live residents (unmatched by the listed dir) and their passive
        // children; only rows whose session file lives under the trial's
        // own sessions dir are ours to kill — a concurrent eval's or a
        // user's session on the same daemon must survive the reconcile.
        let under_trial_dir = row
            .get("sessionFile")
            .and_then(Value::as_str)
            .is_some_and(|session_file| Path::new(session_file).starts_with(sessions_dir));
        if !under_trial_dir {
            continue;
        }
        let Some(orphan_id) = row.get("activeSessionId").and_then(Value::as_str) else {
            continue;
        };
        kill_session(client, socket, orphan_id)?;
        killed += 1;
    }
    Ok(killed)
}

/// The reconcile's verdict for the trial's error string: how many
/// orphaned sessions died, or the transport-level failure that left
/// their fate unknown.
fn reconcile_outcome(reconcile: Result<usize, String>) -> String {
    match reconcile {
        Ok(0) => "reconcile found no orphaned session".to_string(),
        Ok(count) => format!("reconcile killed {count} orphaned session(s)"),
        Err(reconcile_error) => format!("reconcile failed: {reconcile_error}"),
    }
}

/// The cleanup kill. Unlike a scored command, a transport failure here
/// leaves the session's fate unknown — the daemon can be alive with the
/// orchestrator still mid-turn — so the kill is retried once over a fresh
/// connection before the failure propagates into the trial. A response
/// envelope (even `success: false`, e.g. an unknown session) is the
/// daemon's authoritative answer and settles the cleanup.
fn kill_session(client: &mut Client, socket: &Path, session_id: &str) -> Result<Value, String> {
    let command = json!({ "type": "kill", "activeSessionId": session_id });
    let response = match client.command(&command, Duration::from_secs(30)) {
        Ok(response) => response,
        Err(first_error) => {
            let mut retry = Client::connect(socket)
                .map_err(|connect_error| format!("{first_error}; reconnect: {connect_error}"))?;
            let retry_result = retry.command(&command, Duration::from_secs(30));
            // The fresh connection heals the shared client for the sweep's
            // later trials.
            *client = retry;
            retry_result.map_err(|retry_error| {
                format!("cleanup kill failed on both connections ({first_error}; {retry_error})")
            })?
        }
    };
    Ok(response)
}

/// The post-create trial body: prompt, poll, verify, and score. Cleanup is
/// owned by [`run_trial`], which kills the session on every outcome.
// Lint exception, kept narrow (AGENTS.md lint discipline): the body
// needs the trial's whole addressable state — client, config, sweep
// coordinates, session id, secrets, prompt, and start — and a context
// struct would only reshuffle the same seven values between call sites.
#[allow(clippy::too_many_arguments)]
fn drive_trial(
    client: &mut Client,
    config: &SwarmEvalConfig,
    size: usize,
    trial: usize,
    session_id: &str,
    secrets: &[u32],
    prompt: &str,
    started: Instant,
) -> Result<SwarmEvalTrialResult, String> {
    let _ = command_data(
        client,
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": prompt }),
        Duration::from_mins(1),
    )?;

    // `--timeout-minutes inf` parses to an unbounded wait, and any
    // non-representable finite value degrades to unbounded instead of
    // panicking in `Duration::from_secs_f64`.
    let deadline = trial_deadline(config.timeout_minutes);
    let mut answer_text = None;
    loop {
        let text = command_data(
            client,
            &json!({ "type": "get_last_assistant_text", "activeSessionId": session_id }),
            Duration::from_secs(30),
        )?
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string);
        let running = running_children(client, session_id)?;
        if running == 0 && parse_answer_line(text.as_deref()).is_some() {
            answer_text = text;
            break;
        }
        if deadline.is_some_and(|at| Instant::now() >= at) {
            break;
        }
        std::thread::sleep(Duration::from_secs(2));
    }

    let messages = command_data(
        client,
        &json!({ "type": "get_messages", "activeSessionId": session_id }),
        Duration::from_mins(1),
    )?
    .get("messages")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
    let context_tokens = command_data(
        client,
        &json!({ "type": "get_session_stats", "activeSessionId": session_id }),
        Duration::from_secs(30),
    )?
    .get("contextUsage")
    .and_then(|usage| usage.get("tokens"))
    .and_then(Value::as_u64);

    let expected: Vec<u64> = secrets.iter().map(|secret| u64::from(*secret)).collect();
    let answer = parse_answer_line(answer_text.as_deref());
    let task_success = answer.as_deref() == Some(expected.as_slice());
    let instant_fail = rate_limit_failure(&messages);

    let snapshot = snapshot_from_transcript(&messages, context_tokens);
    Ok(trial_result_from_snapshot(
        config,
        size,
        trial,
        &snapshot,
        task_success,
        instant_fail,
        started.elapsed().as_secs_f64(),
    ))
}

fn command_data(client: &mut Client, command: &Value, timeout: Duration) -> Result<Value, String> {
    let response = client.command(command, timeout)?;
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(format!("command failed: {response}"));
    }
    Ok(response.get("data").cloned().unwrap_or(Value::Null))
}

fn running_children(client: &mut Client, session_id: &str) -> Result<usize, String> {
    let data = command_data(
        client,
        &json!({ "type": "get_rlm_children", "activeSessionId": session_id }),
        Duration::from_secs(30),
    )?;
    Ok(data
        .get("children")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|row| row.get("status").and_then(Value::as_str) == Some("running"))
                .count()
        })
        .unwrap_or_default())
}

/// A rate-limit model error during the trial is an instant failure.
fn rate_limit_failure(messages: &[Value]) -> Option<String> {
    messages.iter().find_map(|message| {
        let stop_reason_error = message.get("stopReason").and_then(Value::as_str) == Some("error");
        let error = message
            .get("errorMessage")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let rate_limited = error.contains("429")
            || error.contains("rate limit")
            || error.contains("too many requests");
        (stop_reason_error && rate_limited).then(|| "rate-limit error during trial".to_string())
    })
}

#[cfg(all(test, unix))]
mod tests {
    //! Driver-loop regression tests over a scripted daemon socket: no real
    //! daemon, no tokens, just the driver's command sequence.

    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::thread;
    use std::time::{Duration, Instant};

    use pa_core::swarm_eval::{seeded_secrets, ArrivalPattern, MessageSize, SwarmEvalConfig};
    use pa_types::platform::transport::BlockingTransportStream;
    use serde_json::{json, Value};

    use super::{run, run_tag, run_trial, runs_root_path, session_name, socket_from_args, Client};

    /// A scripted daemon socket: greets the client, then answers each
    /// command by its `type` from `script`, recording every command in
    /// order. Commands without a scripted entry fail (the error path).
    struct FakeDaemon {
        socket: std::path::PathBuf,
        commands: Receiver<Value>,
        _dir: tempfile::TempDir,
    }

    fn fake_daemon(script: Vec<(&'static str, Value)>) -> FakeDaemon {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).expect("bind socket");
        let (tx, rx) = channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            serve_client(stream, &script, &tx);
        });
        FakeDaemon {
            socket,
            commands: rx,
            _dir: dir,
        }
    }

    fn serve_client(stream: UnixStream, script: &[(&'static str, Value)], tx: &Sender<Value>) {
        let mut writer = stream.try_clone().expect("clone stream");
        let mut reader = BufReader::new(stream);
        let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => continue,
            }
            let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let id = envelope.get("id").cloned().unwrap_or(Value::Null);
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let _ = tx.send(command.clone());
            let kind = command.get("type").and_then(Value::as_str).unwrap_or("");
            let mut response = json!({ "id": id, "type": "response" });
            if let Some((_, data)) = script.iter().find(|(kind_, _)| *kind_ == kind) {
                response["success"] = json!(true);
                response["data"] = data.clone();
            } else {
                response["success"] = json!(false);
                response["error"] = json!(format!("no script for {kind}"));
            }
            let _ = writeln!(writer, "{response}");
        }
    }

    impl FakeDaemon {
        /// Wait (bounded) for the kill of `session_id` and return every
        /// command the driver sent in order.
        fn drain_until_killed(&self, session_id: &str) -> Vec<Value> {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut commands = Vec::new();
            loop {
                while let Ok(command) = self.commands.try_recv() {
                    commands.push(command);
                }
                if commands.iter().any(|command| {
                    command["type"] == "kill" && command["activeSessionId"] == session_id
                }) {
                    return commands;
                }
                // (The session id is not written into the assert message;
                // CodeQL's cleartext logger flags it by name.)
                assert!(
                    Instant::now() < deadline,
                    "the kill never arrived; commands so far: {commands:?}"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    fn test_config(out_dir: &Path, size: usize, timeout_minutes: f64) -> SwarmEvalConfig {
        SwarmEvalConfig {
            model: "scripted/faux".to_string(),
            sizes: vec![size],
            message_size: MessageSize::Short,
            pattern: ArrivalPattern::Spread,
            trials: 1,
            gap_seconds: 2.0,
            timeout_minutes,
            out_dir: out_dir.to_string_lossy().to_string(),
            seed: 1,
        }
    }

    #[test]
    fn a_failed_post_create_request_kills_the_session_and_is_reported() {
        // Only `create` and `kill` are scripted: the `prompt` right after
        // the create fails, which used to return from the trial without
        // killing the freshly created session.
        let daemon = fake_daemon(vec![
            ("create", json!({ "activeSessionId": "s-eval" })),
            ("kill", json!(null)),
        ]);
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);

        run(&daemon.socket, &config).expect("the errored trial is reported, not fatal");

        // The session was killed even though the trial errored.
        let commands = daemon.drain_until_killed("s-eval");
        let prompt_index = commands
            .iter()
            .position(|command| command["type"] == "prompt")
            .expect("the prompt was attempted");
        let kill_index = commands
            .iter()
            .position(|command| command["type"] == "kill")
            .expect("the kill follows the failed prompt");
        assert!(kill_index > prompt_index, "{commands:?}");

        // The errored trial is a reported row, not a dropped one: the
        // report names it as a failure and keeps the full sweep.
        let report = std::fs::read_to_string(out_dir.path().join("report.md")).expect("report.md");
        assert!(report.contains("trial error:"), "{report}");
        assert!(report.contains("1/1 trials failed"), "{report}");
        let raw = std::fs::read_to_string(out_dir.path().join("report.json")).expect("report.json");
        let json: Value = serde_json::from_str(&raw).expect("report.json parses");
        let rows = json["results"].as_array().expect("results array");
        assert_eq!(rows.len(), 1, "the errored trial is a row: {rows:?}");
        assert_eq!(rows[0]["verdict"], "fail", "{rows:?}");
        assert!(
            rows[0]["instant_fail"]
                .as_str()
                .expect("instant fail")
                .starts_with("trial error:"),
            "{rows:?}"
        );
    }

    #[test]
    fn an_unbounded_timeout_runs_the_trial_without_panicking() {
        // `--timeout-minutes inf` must reach an unbounded wait: the old
        // `Duration::from_secs_f64(timeout * 60.0)` panicked here before the
        // poll loop could ever kill the session.
        // The driver's seed math is config.seed + 31 * size + trial; for
        // this config (seed 1, size 1, trial 1) it selects seed 33.
        let (seed, size, trial) = (1, 1, 1);
        let secret = seeded_secrets(seed + 31 * size + trial, 1)[0];
        let daemon = fake_daemon(vec![
            ("create", json!({ "activeSessionId": "s-eval" })),
            ("prompt", json!({})),
            (
                "get_last_assistant_text",
                json!({ "text": format!("ANSWER: {secret}") }),
            ),
            ("get_rlm_children", json!({ "children": [] })),
            ("get_messages", json!({ "messages": [] })),
            (
                "get_session_stats",
                json!({ "contextUsage": { "tokens": 1_000 } }),
            ),
            ("kill", json!(null)),
        ]);
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 1, f64::INFINITY);

        run(&daemon.socket, &config).expect("the unbounded trial completes");

        // The poll loop broke on the ANSWER and the session was still killed.
        let commands = daemon.drain_until_killed("s-eval");
        assert!(
            commands
                .iter()
                .any(|command| command["type"] == "get_last_assistant_text"),
            "the poll loop ran: {commands:?}"
        );
        let report = std::fs::read_to_string(out_dir.path().join("report.md")).expect("report.md");
        assert!(report.contains("| 1 | 1 |"), "{report}");
        assert!(report.contains("inconclusive"), "{report}");
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    /// A transport whose reads fail with the configured kind, for pinning
    /// `read_line`'s error classification without a live daemon.
    #[derive(Debug)]
    struct FailingStream {
        kind: std::io::ErrorKind,
        reads: std::sync::Arc<std::sync::atomic::AtomicU64>,
    }

    impl std::io::Read for FailingStream {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(std::io::Error::new(self.kind, "scripted transport failure"))
        }
    }

    impl std::io::Write for FailingStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl BlockingTransportStream for FailingStream {
        fn try_clone_box(&self) -> std::io::Result<Box<dyn BlockingTransportStream>> {
            Ok(Box::new(Self {
                kind: self.kind,
                reads: self.reads.clone(),
            }))
        }

        fn set_read_timeout(&self, _timeout: Duration) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_persistent_read_error_fails_fast_instead_of_spinning() {
        // A reset or broken socket fails every read immediately; the client
        // used to retry those errors like poll timeouts, busy-looping the
        // rest of the command budget before surfacing the failure.
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut client = Client {
            reader: BufReader::new(Box::new(FailingStream {
                kind: std::io::ErrorKind::ConnectionReset,
                reads: reads.clone(),
            })),
            writer: Box::new(FailingStream {
                kind: std::io::ErrorKind::BrokenPipe,
                reads: reads.clone(),
            }),
            request_id: 0,
        };
        let started = Instant::now();
        let error = client
            .read_line(Duration::from_secs(2))
            .expect_err("a reset socket must fail the read");
        assert!(
            error.contains("daemon socket error") && error.contains("scripted transport failure"),
            "{error}"
        );
        // The error surfaced on the first read, long before the budget.
        assert_eq!(
            reads.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "{error}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the read failed fast, waited {:?}",
            started.elapsed()
        );
    }

    /// A transport whose reads time out (`WouldBlock`) before a full JSONL
    /// line arrives, pinning the retry side of the classification.
    #[derive(Debug)]
    struct StalledStream {
        reads: std::sync::Arc<std::sync::atomic::AtomicU64>,
    }

    impl std::io::Read for StalledStream {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let read = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if read < 2 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "scripted poll timeout",
                ));
            }
            if read > 2 {
                return Ok(0);
            }
            let line = br#"{"type":"daemon_hello"}
"#;
            buf[..line.len()].copy_from_slice(line);
            Ok(line.len())
        }
    }

    impl std::io::Write for StalledStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl BlockingTransportStream for StalledStream {
        fn try_clone_box(&self) -> std::io::Result<Box<dyn BlockingTransportStream>> {
            Ok(Box::new(Self {
                reads: self.reads.clone(),
            }))
        }

        fn set_read_timeout(&self, _timeout: Duration) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_poll_timeout_is_retried_until_the_line_arrives() {
        // Only the poll timeout (WouldBlock on Unix, TimedOut on Windows)
        // means "no line yet": the fragmented-frame retry the client's
        // polling depends on must keep working after the persistent-error
        // arm starts failing fast.
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut client = Client {
            reader: BufReader::new(Box::new(StalledStream {
                reads: reads.clone(),
            })),
            writer: Box::new(StalledStream {
                reads: reads.clone(),
            }),
            request_id: 0,
        };
        let line = client
            .read_line(Duration::from_secs(2))
            .expect("the two poll timeouts must be retried");
        assert_eq!(line["type"], "daemon_hello", "{line}");
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[test]
    fn a_fragmented_frame_survives_read_timeouts() {
        // A large daemon frame (a full transcript, a wide children list)
        // can straddle the client's 100ms read windows; the partial bytes
        // must survive the timeout retry instead of being cleared away
        // and corrupting the line's parse.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("frag.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut writer = stream.try_clone().expect("clone");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            // The response arrives in two pieces with a gap wider than the
            // client's 100ms read window.
            let response = r#"{"id":"swarm-eval-1","type":"response","success":true,"data":{"text":"ANSWER: 501"}}"#;
            writer
                .write_all(&response.as_bytes()[..20])
                .expect("first chunk");
            writer.flush().expect("flush chunk");
            thread::sleep(Duration::from_millis(300));
            writer.write_all(&response.as_bytes()[20..]).expect("rest");
            writer.write_all(b"\n").expect("newline");
            writer.flush().expect("flush rest");
        });
        let mut client = Client::connect(&socket).expect("connect");
        let response = client
            .command(
                &json!({ "type": "get_last_assistant_text", "activeSessionId": "s" }),
                Duration::from_secs(5),
            )
            .expect("the fragmented frame completes");
        assert_eq!(response["id"], "swarm-eval-1", "{response}");
        assert_eq!(response["data"]["text"], "ANSWER: 501", "{response}");
    }

    #[test]
    fn a_broadcast_stream_never_extends_the_command_timeout() {
        // The daemon broadcasts unsolicited frames (heartbeats_changed and
        // friends) to attached clients; a full-timeout retry per frame
        // would let a steady stream delay the command response — and the
        // trial cleanup behind it — indefinitely. The command budget is
        // one fixed deadline.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("stream.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let started = Instant::now();
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut writer = stream.try_clone().expect("clone");
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            // One unsolicited frame every 100ms for ~4s: far longer than
            // the command's 300ms budget, and never the awaited response.
            for _ in 0..40 {
                let _ = writeln!(writer, r#"{{"type":"heartbeats_changed"}}"#);
                thread::sleep(Duration::from_millis(100));
            }
        });
        let mut client = Client::connect(&socket).expect("connect");
        let error = client
            .command(
                &json!({ "type": "get_session_stats", "activeSessionId": "s" }),
                Duration::from_millis(300),
            )
            .expect_err("the command must hit its fixed budget");
        assert!(error.contains("timed out"), "{error}");
        // The budget fired long before the broadcast stream (~4s) ended.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the command deadline must hold under a broadcast stream, waited {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_runs_root_is_process_unique() {
        // Two harness processes launched in the same millisecond must not
        // share a scratch root: their trial directories would collide.
        let tag = run_tag();
        let name = runs_root_path(&tag)
            .file_name()
            .expect("a name")
            .to_string_lossy()
            .to_string();
        assert!(
            name.starts_with(&format!("swarm-eval-{}-", std::process::id())),
            "{name}"
        );
    }

    #[test]
    fn session_names_carry_the_process_unique_run_tag() {
        // The daemon refuses a create whose name a live session already
        // holds: without the run tag in the name, a leftover live session
        // from a crashed run (or a concurrent eval on the same daemon)
        // blocks the new trial's create — a refusal that skips the orphan
        // reconcile entirely.
        let tag = run_tag();
        let name = session_name(&tag, 2, 1);
        assert_eq!(name, format!("swarm-eval-{tag}-2-1"), "{name}");
        assert!(
            name.starts_with(&format!("swarm-eval-{}-", std::process::id())),
            "the name embeds this process's id: {name}"
        );
        // Two harness processes carry different tags (pid, start time), so
        // the same sweep coordinates never contend for one daemon name.
        assert_ne!(
            session_name("11-111", 2, 1),
            session_name("22-222", 2, 1),
            "same sweep coordinates, different runs"
        );
        assert_ne!(
            session_name(&tag, 2, 1),
            session_name(&tag, 2, 2),
            "different trials in one run stay distinct"
        );
    }

    #[test]
    fn a_cleanup_kill_survives_a_mid_trial_socket_reset() {
        // The daemon connection can reset mid-trial while the daemon (and
        // the freshly prompted orchestrator session) lives on; the cleanup
        // kill must reach the daemon over a fresh connection instead of
        // being dropped on the dead one, leaving the session to spend
        // tokens while the sweep moves on.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("reset.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let (tx, rx) = channel();
        thread::spawn(move || {
            // Connection 1: hello and create succeed, then the stream is
            // dropped (the reset) so every later command on it fails.
            let (stream, _) = listener.accept().expect("accept 1");
            let mut writer = stream.try_clone().expect("clone 1");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read create");
            let _ = writeln!(
                writer,
                "{}",
                json!({ "id": "swarm-eval-1", "type": "response", "success": true,
                        "data": { "activeSessionId": "s-eval" } })
            );
            let mut line = String::new();
            reader.read_line(&mut line).expect("read prompt");
            drop(writer);
            drop(reader);
            // Connection 2 (the cleanup retry): hello, then answer the kill
            // and record it.
            let (stream, _) = listener.accept().expect("accept 2");
            let mut writer = stream.try_clone().expect("clone 2");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read kill");
            let envelope: Value = serde_json::from_str(line.trim()).expect("kill envelope");
            let _ = tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({ "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                        "type": "response", "success": true })
            );
        });
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let runs_root = dir.path().join("runs");
        let mut client = Client::connect(&socket).expect("connect");
        let error = run_trial(&mut client, &socket, &config, 2, 1, &runs_root, "77-880")
            .expect_err("the trial fails on the reset socket");
        // The kill reached the daemon over the retry connection.
        let command = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the cleanup kill arrived");
        assert_eq!(command["type"], "kill", "{command}");
        assert_eq!(command["activeSessionId"], "s-eval", "{command}");
        // The trial reports the drive failure instead of silently
        // completing.
        assert!(
            error.contains("the daemon closed the connection")
                || error.contains("daemon socket error")
                || error.contains("failed to send command"),
            "{error}"
        );
    }

    #[test]
    // Lint exception, kept narrow (AGENTS.md lint discipline): the
    // inline scripted daemon is this test's fixture — the two-connection
    // create/list/kill sequence the assertions address line by line —
    // and a helper would only move the fixture behind a boundary the
    // assertions cannot follow.
    #[allow(clippy::too_many_lines)]
    fn an_ambiguous_create_orphan_is_reconciled_and_killed() {
        // The create response can be lost to a reset while the daemon still
        // created the session; with no id returned the orphan would outlive
        // the trial. The harness must reconcile the trial's own sessions
        // dir over a fresh connection and kill what the daemon reports
        // there before reporting the trial failure.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("orphan.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let (list_tx, list_rx) = channel();
        let (kill_tx, kill_rx) = channel();
        let (name_kill_tx, name_kill_rx) = channel();
        // The trial's own sessions dir, so the scripted list can place the
        // orphan under it (the reconcile only kills rows whose session file
        // lives there) beside a decoy from another dir that must survive.
        let sessions_dir = dir
            .path()
            .join("runs")
            .join("size-2-trial-1")
            .join("sessions")
            .to_string_lossy()
            .to_string();
        thread::spawn(move || {
            // Connection 1: hello, read the create, drop (the response is
            // lost).
            let (stream, _) = listener.accept().expect("accept 1");
            let mut writer = stream.try_clone().expect("clone 1");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read create");
            drop(writer);
            drop(reader);
            // Connection 2 (the reconcile): report one orphaned session
            // under the trial dir, then answer the kill.
            let (stream, _) = listener.accept().expect("accept 2");
            let mut writer = stream.try_clone().expect("clone 2");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read list");
            let envelope: Value = serde_json::from_str(line.trim()).expect("list envelope");
            let _ = list_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({
                    "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                    "type": "response",
                    "success": true,
                    "data": { "sessions": [
                        // The orphan under the trial's own sessions dir.
                        { "sessionFile": format!("{sessions_dir}/o.jsonl"),
                          "activeSessionId": "s-orphan" },
                        // An unrelated live session of the same daemon
                        // (a resident unmatched by the listed dir): the
                        // reconcile must leave it alone.
                        { "sessionFile": "/tmp/other/sessions/user.jsonl",
                          "activeSessionId": "s-user" }
                    ] }
                })
            );
            let mut line = String::new();
            reader.read_line(&mut line).expect("read kill");
            let envelope: Value = serde_json::from_str(line.trim()).expect("kill envelope");
            let _ = kill_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({
                    "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                    "type": "response",
                    "success": true
                })
            );
            // The name-addressed kill follows the path pass: the live
            // orphan is already gone, so the daemon answers unknown
            // session — settled, and not counted again.
            let mut line = String::new();
            reader.read_line(&mut line).expect("read name kill");
            let envelope: Value = serde_json::from_str(line.trim()).expect("name kill envelope");
            let _ = name_kill_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({
                    "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                    "type": "response",
                    "success": false,
                    "error": "Unknown active session"
                })
            );
        });
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let runs_root = dir.path().join("runs");
        let mut client = Client::connect(&socket).expect("connect");
        let tag = "77-880";
        let error = run_trial(&mut client, &socket, &config, 2, 1, &runs_root, tag)
            .expect_err("the lost create response fails the trial");
        // The reconcile listed the trial's own sessions dir...
        let list_command = list_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the reconcile list ran");
        assert_eq!(list_command["type"], "list", "{list_command}");
        assert_eq!(list_command["all"], true, "{list_command}");
        assert!(
            list_command["sessionDir"]
                .as_str()
                .unwrap_or_default()
                .contains("sessions"),
            "{list_command}"
        );
        // ...and killed the orphan the daemon reported there.
        let kill_command = kill_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the orphan kill ran");
        assert_eq!(kill_command["type"], "kill", "{kill_command}");
        assert_eq!(
            kill_command["activeSessionId"], "s-orphan",
            "{kill_command}"
        );
        // The pass then retried the trial's own session name — the
        // unidentifiable-orphan fallback — and the daemon's unknown answer
        // settles it without counting a second kill.
        let name_kill_command = name_kill_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the name kill ran");
        assert_eq!(name_kill_command["type"], "kill", "{name_kill_command}");
        assert_eq!(
            name_kill_command["activeSessionId"],
            session_name(tag, 2, 1),
            "{name_kill_command}"
        );
        // Only the trial's own orphan: the unrelated resident the list
        // also reported must survive the reconcile.
        assert!(
            kill_rx.recv_timeout(Duration::from_secs(1)).is_err(),
            "the unrelated session must not be killed"
        );
        assert!(error.contains("create failed"), "{error}");
        assert!(error.contains("reconcile killed 1"), "{error}");
        // The scratch dir still went.
        assert!(!runs_root.join("size-2-trial-1").exists());
    }

    #[test]
    fn an_unidentifiable_orphan_is_killed_by_name() {
        // A resident whose `get_state` fails is listed as a recovering row
        // with neither a `sessionFile` nor an `activeSessionId` — the path
        // filter of the reconcile skips it, and the live session keeps
        // spending tokens after the trial dir is deleted. The daemon
        // resolves a kill by the resident's name label, so the reconcile's
        // name-addressed kill must reach the orphan under this trial's
        // process-unique session name.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("recovering.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let (list_tx, list_rx) = channel();
        let (kill_tx, kill_rx) = channel();
        thread::spawn(move || {
            // Connection 1: hello, read the create, drop (the response is
            // lost).
            let (stream, _) = listener.accept().expect("accept 1");
            let mut writer = stream.try_clone().expect("clone 1");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read create");
            drop(writer);
            drop(reader);
            // Connection 2 (the reconcile): the list reports only the
            // recovering row — no `sessionFile`, no `activeSessionId`,
            // exactly the daemon's offline summary shape — so nothing in
            // the list is path-addressable.
            let (stream, _) = listener.accept().expect("accept 2");
            let mut writer = stream.try_clone().expect("clone 2");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read list");
            let envelope: Value = serde_json::from_str(line.trim()).expect("list envelope");
            let _ = list_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({
                    "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                    "type": "response",
                    "success": true,
                    "data": { "sessions": [
                        // The recovering orphan: the daemon's offline
                        // summary for a resident whose `get_state` fails.
                        { "id": "w-orphan", "lifecycle": "recovering",
                          "isSessionActive": false, "sessionId": "" },
                        // Another daemon's user session in the same shape:
                        // unidentifiable rows are never path-killed, and
                        // the name kill must not reach it either.
                        { "id": "w-user", "lifecycle": "recovering",
                          "isSessionActive": false, "sessionId": "" }
                    ] }
                })
            );
            // The name kill resolves the recovering orphan by its name
            // label and succeeds.
            let mut line = String::new();
            reader.read_line(&mut line).expect("read name kill");
            let envelope: Value = serde_json::from_str(line.trim()).expect("name kill envelope");
            let _ = kill_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({
                    "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                    "type": "response",
                    "success": true
                })
            );
        });
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let runs_root = dir.path().join("runs");
        let mut client = Client::connect(&socket).expect("connect");
        let tag = "77-880";
        let error = run_trial(&mut client, &socket, &config, 2, 1, &runs_root, tag)
            .expect_err("the lost create response fails the trial");
        let list_command = list_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the reconcile list ran");
        assert_eq!(list_command["type"], "list", "{list_command}");
        // No row was path-addressable, so the kill that arrives is the
        // name-addressed one — the trial's own session name, not the
        // recovering rows' worker ids.
        let kill_command = kill_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the name kill ran");
        assert_eq!(kill_command["type"], "kill", "{kill_command}");
        assert_eq!(
            kill_command["activeSessionId"],
            session_name(tag, 2, 1),
            "{kill_command}"
        );
        assert!(kill_rx.recv_timeout(Duration::from_secs(1)).is_err());
        assert!(error.contains("create failed"), "{error}");
        assert!(error.contains("reconcile killed 1"), "{error}");
        assert!(!runs_root.join("size-2-trial-1").exists());
    }

    #[test]
    fn a_lost_reconcile_list_still_kills_by_name() {
        // The reconcile's row pass is best-effort: when the fresh
        // connection itself loses the list (the degraded-daemon case
        // that orphaned the create in the first place), the
        // name-addressed kill must still run — the name is the only
        // address the orphan still answers on. Skipping it on a list
        // failure would leave the orphan running and spending tokens
        // while the sweep moves on.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("lost-list.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let (list_tx, list_rx) = channel();
        let (name_kill_tx, name_kill_rx) = channel();
        thread::spawn(move || {
            // Connection 1: hello, read the create, drop (the response
            // is lost).
            let (stream, _) = listener.accept().expect("accept 1");
            let mut writer = stream.try_clone().expect("clone 1");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read create");
            drop(writer);
            drop(reader);
            // Connection 2 (the reconcile): hello, read the list, then
            // drop without answering — the list is lost on this
            // connection too.
            let (stream, _) = listener.accept().expect("accept 2");
            let mut writer = stream.try_clone().expect("clone 2");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read list");
            let envelope: Value = serde_json::from_str(line.trim()).expect("list envelope");
            let _ = list_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            drop(writer);
            drop(reader);
            // Connection 3 (the kill's retry connection): answer the
            // name-addressed kill.
            let (stream, _) = listener.accept().expect("accept 3");
            let mut writer = stream.try_clone().expect("clone 3");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read name kill");
            let envelope: Value = serde_json::from_str(line.trim()).expect("name kill envelope");
            let _ = name_kill_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({ "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                        "type": "response", "success": true })
            );
        });
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let runs_root = dir.path().join("runs");
        let mut client = Client::connect(&socket).expect("connect");
        let tag = "77-880";
        let error = run_trial(&mut client, &socket, &config, 2, 1, &runs_root, tag)
            .expect_err("the lost create response fails the trial");
        // The list ran on the fresh connection...
        let list_command = list_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the reconcile list ran");
        assert_eq!(list_command["type"], "list", "{list_command}");
        // ...and although its response was lost, the name-addressed kill
        // still ran over the kill's own retry connection.
        let name_kill_command = name_kill_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the name kill ran despite the lost list");
        assert_eq!(name_kill_command["type"], "kill", "{name_kill_command}");
        assert_eq!(
            name_kill_command["activeSessionId"],
            session_name(tag, 2, 1),
            "{name_kill_command}"
        );
        // The orphan died by name, so the reconcile reports its kill,
        // not the lost list.
        assert!(error.contains("create failed"), "{error}");
        assert!(error.contains("reconcile killed 1"), "{error}");
        assert!(!runs_root.join("size-2-trial-1").exists());
    }

    #[test]
    fn a_create_without_a_session_id_is_reconciled_by_name() {
        // A create that answers success but carries no parseable session
        // id can still have left a live session: the daemon named the
        // resident, and without an id there is nothing to drive or kill
        // directly. The no-id path must run the same orphan reconcile —
        // the row pass plus the name-addressed kill — before the trial
        // dir goes.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("no-id.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let (list_tx, list_rx) = channel();
        let (kill_tx, kill_rx) = channel();
        thread::spawn(move || {
            // Connection 1: hello, answer the create with success but no
            // session id in the data.
            let (stream, _) = listener.accept().expect("accept 1");
            let mut writer = stream.try_clone().expect("clone 1");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read create");
            let envelope: Value = serde_json::from_str(line.trim()).expect("create envelope");
            let _ = writeln!(
                writer,
                "{}",
                json!({ "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                        "type": "response", "success": true,
                        "data": { "named": "but no id" } })
            );
            // Connection 2 (the reconcile): the list reports nothing
            // path-addressable, so only the name kill can reach the
            // orphan.
            let (stream, _) = listener.accept().expect("accept 2");
            let mut writer = stream.try_clone().expect("clone 2");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read list");
            let envelope: Value = serde_json::from_str(line.trim()).expect("list envelope");
            let _ = list_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({
                    "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                    "type": "response",
                    "success": true,
                    "data": { "sessions": [] }
                })
            );
            // The name kill resolves the id-less orphan by its name
            // label and succeeds.
            let mut line = String::new();
            reader.read_line(&mut line).expect("read name kill");
            let envelope: Value = serde_json::from_str(line.trim()).expect("name kill envelope");
            let _ = kill_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({ "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                        "type": "response", "success": true })
            );
        });
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let runs_root = dir.path().join("runs");
        let mut client = Client::connect(&socket).expect("connect");
        let tag = "77-880";
        let error = run_trial(&mut client, &socket, &config, 2, 1, &runs_root, tag)
            .expect_err("the id-less create fails the trial");
        // The no-id path reconciled: the trial's own sessions dir was
        // listed...
        let list_command = list_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the reconcile list ran");
        assert_eq!(list_command["type"], "list", "{list_command}");
        // ...and the name-addressed kill reached the id-less orphan.
        let kill_command = kill_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the name kill ran");
        assert_eq!(kill_command["type"], "kill", "{kill_command}");
        assert_eq!(
            kill_command["activeSessionId"],
            session_name(tag, 2, 1),
            "{kill_command}"
        );
        assert!(error.contains("create returned no session id"), "{error}");
        assert!(error.contains("reconcile killed 1"), "{error}");
        assert!(!runs_root.join("size-2-trial-1").exists());
    }

    #[test]
    fn a_failed_reconcile_reconnect_falls_back_to_the_healthy_client() {
        // The no-id create completes its round trip over connection 1, so
        // the reconcile starts with a healthy client. When its fresh
        // connection cannot come up, the reconcile used to return before
        // any pass ran — abandoning that healthy client and stranding the
        // id-less orphan. The passes must fall back to the client in hand
        // instead.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("reconnect-fail.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let (reconnect_tx, reconnect_rx) = channel();
        let (list_tx, list_rx) = channel();
        let (kill_tx, kill_rx) = channel();
        thread::spawn(move || {
            // Connection 1: hello, answer the create with success but no
            // session id, then stay open — the client is healthy, and the
            // passes must come back over it.
            let (stream, _) = listener.accept().expect("accept 1");
            let mut writer = stream.try_clone().expect("clone 1");
            let mut reader = BufReader::new(stream);
            let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
            let mut line = String::new();
            reader.read_line(&mut line).expect("read create");
            let envelope: Value = serde_json::from_str(line.trim()).expect("create envelope");
            let _ = writeln!(
                writer,
                "{}",
                json!({ "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                        "type": "response", "success": true,
                        "data": { "named": "but no id" } })
            );
            // Connection 2 (the reconcile's fresh connection): accepted
            // and dropped without a greeting, so the reconnect fails.
            let (stream, _) = listener.accept().expect("accept 2");
            let _ = reconnect_tx.send(json!("dropped without a greeting"));
            drop(stream);
            // The row pass falls back to connection 1: the list reports
            // nothing path-addressable.
            let mut line = String::new();
            reader.read_line(&mut line).expect("read list");
            let envelope: Value = serde_json::from_str(line.trim()).expect("list envelope");
            let _ = list_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({
                    "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                    "type": "response",
                    "success": true,
                    "data": { "sessions": [] }
                })
            );
            // The name-addressed kill runs over the same client and
            // resolves the id-less orphan.
            let mut line = String::new();
            reader.read_line(&mut line).expect("read name kill");
            let envelope: Value = serde_json::from_str(line.trim()).expect("name kill envelope");
            let _ = kill_tx.send(envelope.get("command").cloned().unwrap_or(Value::Null));
            let _ = writeln!(
                writer,
                "{}",
                json!({ "id": envelope.get("id").cloned().unwrap_or(Value::Null),
                        "type": "response", "success": true })
            );
        });
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let runs_root = dir.path().join("runs");
        let mut client = Client::connect(&socket).expect("connect");
        let tag = "77-880";
        let error = run_trial(&mut client, &socket, &config, 2, 1, &runs_root, tag)
            .expect_err("the id-less create fails the trial");
        // The reconcile tried a fresh connection and lost it...
        reconnect_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the reconcile reconnect ran");
        // ...yet the list and the name kill still ran, over the original
        // client.
        let list_command = list_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the reconcile list ran over the original client");
        assert_eq!(list_command["type"], "list", "{list_command}");
        let kill_command = kill_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the name kill ran over the original client");
        assert_eq!(kill_command["type"], "kill", "{kill_command}");
        assert_eq!(
            kill_command["activeSessionId"],
            session_name(tag, 2, 1),
            "{kill_command}"
        );
        assert!(error.contains("create returned no session id"), "{error}");
        assert!(error.contains("reconcile killed 1"), "{error}");
        assert!(!runs_root.join("size-2-trial-1").exists());
    }

    #[test]
    fn a_refused_create_skips_the_reconcile() {
        // A refused create (the daemon answered success: false) is
        // authoritative: nothing was created, so no reconcile pass runs.
        let daemon = fake_daemon(Vec::new());
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let runs_root = out_dir.path().join("runs");
        let mut client = Client::connect(&daemon.socket).expect("connect");
        let error = run_trial(
            &mut client,
            &daemon.socket,
            &config,
            2,
            1,
            &runs_root,
            "77-880",
        )
        .expect_err("the refused create fails the trial");
        assert!(error.contains("command failed"), "{error}");
        assert!(!error.contains("reconcile"), "{error}");
        // Drain every command the driver sent: no list may appear. The
        // fake daemon records each command before it responds, so the
        // channel is already complete when `run_trial` returns — one
        // non-blocking drain catches everything (no fixed delay).
        let mut commands = Vec::new();
        while let Ok(command) = daemon.commands.try_recv() {
            commands.push(command);
        }
        assert!(
            commands.iter().all(|command| command["type"] != "list"),
            "no reconcile list for a refused create: {commands:?}"
        );
    }

    #[test]
    fn a_trailing_socket_flag_without_a_value_is_rejected() {
        // A trailing `--socket` must not fall back to the default socket:
        // the driver would spend real tokens against the wrong daemon.
        assert_eq!(
            socket_from_args(&args(&["--socket"])),
            Err("Missing value for --socket".to_string())
        );
        // An omitted flag keeps the default, and the rest is untouched.
        let (socket, rest) =
            socket_from_args(&args(&["--model", "x/y"])).expect("an omitted flag is fine");
        assert_eq!(socket, pa_daemon::platform::default_daemon_socket_path());
        assert_eq!(rest, args(&["--model", "x/y"]));
        // A value is honored and peeled off for the shared parser.
        let (socket, rest) =
            socket_from_args(&args(&["--socket", "/tmp/eval.sock", "--model", "x/y"]))
                .expect("parses");
        assert_eq!(socket, std::path::PathBuf::from("/tmp/eval.sock"));
        assert_eq!(rest, args(&["--model", "x/y"]));
    }

    #[test]
    fn an_overflowing_derived_seed_fails_the_trial_cleanly() {
        // A hand-built config can bypass the argument parser's sweep
        // validation; the trial must return a configuration error instead
        // of panicking on `seed + 31 * size + trial`.
        let daemon = fake_daemon(Vec::new());
        let out_dir = tempfile::TempDir::new().expect("out dir");
        let config = test_config(out_dir.path(), 2, 15.0);
        let config = SwarmEvalConfig {
            seed: i64::MAX,
            ..config
        };
        let runs_root = out_dir.path().join("runs");
        let mut client = Client::connect(&daemon.socket).expect("connect");
        let error = run_trial(
            &mut client,
            &daemon.socket,
            &config,
            2,
            1,
            &runs_root,
            "77-880",
        )
        .expect_err("the overflowing seed must fail the trial");
        assert!(
            error.contains("overflows the derived trial seed"),
            "{error}"
        );
    }
}

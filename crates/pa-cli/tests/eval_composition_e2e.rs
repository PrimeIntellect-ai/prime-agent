//! End-to-end verifier for the eval/verifiers composition over the headless
//! session: the CLI autonomous flags drive a print/json session with a
//! verifier gate command through the #98 gate seams (no eval-specific core
//! code — the composition is the `prime-agent` binary itself). A fixture
//! verifier script decides completion; the gate outcome must surface as
//! durable session rows and structured json events, and the process exit
//! code must follow the TS print-mode contract (print-mode.ts).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

fn isolated_home() -> tempfile::TempDir {
    tempfile::TempDir::new().unwrap()
}

fn run(home: &Path, args: &[&str], script: &Value) -> (String, String, i32) {
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let output = Command::new(bin)
        .args(args)
        .env("HOME", home)
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        // Keep the isolated HOME authoritative: ambient agent/session dir
        // overrides and daemon sockets from the test environment must not
        // leak in (fresh sessions never probe the daemon; keep it that way).
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .env_remove("PRIME_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_DAEMON_SOCKET")
        .env_remove("PRIME_API_KEY")
        .current_dir(home)
        .output()
        .expect("binary present");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).unwrap();
}

/// The fixture verifier: passes once the run has made at least one more
/// attempt after the first failing check (the counter file records
/// consults). Hermetic: only the fixture directory is touched.
fn pass_on_second_consult_verifier(home: &Path) -> PathBuf {
    let script = home.join("verify.sh");
    let counter = home.join("verify-count").display().to_string();
    std::fs::write(
        &script,
        format!(
            "#!/usr/bin/env bash\n\
             n=$(cat \"{counter}\" 2>/dev/null || echo 0)\n\
             echo $((n+1)) > \"{counter}\"\n\
             if [ \"$n\" -ge 1 ]; then\n\
               echo \"solution verified\"\n\
               exit 0\n\
             fi\n\
             echo \"solution.txt missing\" >&2\n\
             exit 1\n"
        ),
    )
    .unwrap();
    #[cfg(unix)]
    make_executable(&script);
    script
}

/// The fixture verifier that never passes: a task the scripted model cannot
/// complete.
fn always_failing_verifier(home: &Path) -> PathBuf {
    let script = home.join("verify-fail.sh");
    std::fs::write(
        &script,
        "#!/usr/bin/env bash\n\
         echo \"solution.txt missing\" >&2\n\
         exit 1\n",
    )
    .unwrap();
    #[cfg(unix)]
    make_executable(&script);
    script
}

fn session_files(home: &Path) -> Vec<PathBuf> {
    let dir = home.join(".prime/agent/sessions");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

fn read_entries(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// The text of a message's content: a string or a text block list.
fn text_of(message: &Value) -> String {
    match &message["content"] {
        Value::String(text) => text.clone(),
        content => content
            .as_array()
            .and_then(|blocks| blocks.first())
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn parse_events(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout line parses as json"))
        .collect()
}

/// The verifier-driven session completing: the first turn fails the fixture
/// verifier, the gate-failure continuation drives a second turn IN-RUN (the
/// TS shape: no run boundary between continuation turns), the second
/// consult passes, and the run stops without a row (the TS shape, probed
/// against the binary: the stop surfaces through the exit contract only).
#[test]
fn verifier_gate_pass_stops_the_run_with_structured_events_in_run() {
    let home = isolated_home();
    let verifier = pass_on_second_consult_verifier(home.path());
    let script = json!({ "responses": ["first attempt", "fixed it"] });
    let (stdout, stderr, code) = run(
        home.path(),
        &[
            "--mode",
            "json",
            "-p",
            "build the feature",
            "--autonomous",
            "--autonomous-gate",
            verifier.to_str().unwrap(),
        ],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    let events = parse_events(&stdout);

    // Header first.
    assert_eq!(events[0]["type"], "session");
    assert_eq!(events[0]["version"], 3);

    // Both scripted turns ran, in order.
    let assistant_texts: Vec<String> = events
        .iter()
        .filter(|event| event["type"] == "message_end" && event["message"]["role"] == "assistant")
        .map(|event| text_of(&event["message"]))
        .collect();
    assert_eq!(
        assistant_texts,
        vec!["first attempt".to_string(), "fixed it".to_string()],
        "events: {events:?}"
    );

    // The gate-failure continuation streamed as a user row, with the
    // verifier's exit code and output.
    let continuations: Vec<&Value> = events
        .iter()
        .filter(|event| {
            event["type"] == "message_end"
                && event["message"]["role"] == "user"
                && text_of(&event["message"]).starts_with("[autonomous-continuation: gate-failed]")
        })
        .collect();
    assert_eq!(continuations.len(), 1, "events: {events:?}");
    let continuation = text_of(&continuations[0]["message"]);
    assert!(
        continuation.contains("Autonomous quality gate failed (attempt 1/3)"),
        "continuation: {continuation}"
    );
    assert!(
        continuation.contains("exited with code 1"),
        "continuation: {continuation}"
    );
    assert!(
        continuation.contains("solution.txt missing"),
        "verifier output surfaced: {continuation}"
    );

    // The stop surfaces no row (the TS shape, probed against the binary):
    // no autonomous_status event on the stream, and the run's single
    // `agent_end` closes it (the continuation churned inside the one run).
    assert!(
        !events
            .iter()
            .any(|event| { event["message"]["customType"] == "autonomous_status" }),
        "events: {events:?}"
    );
    let agent_ends = events
        .iter()
        .filter(|event| event["type"] == "agent_end")
        .count();
    assert_eq!(agent_ends, 1, "one run for the whole loop: {events:?}");
    assert_eq!(events.last().unwrap()["type"], "agent_end");
    // The in-run ordering (the TS frame order): the continuation's user row
    // pair is preceded by the continuation turn's `turn_start`, which
    // follows the settled turn's `turn_end`.
    let continuation_index = events
        .iter()
        .position(|event| {
            event["type"] == "message_end"
                && event["message"]["role"] == "user"
                && text_of(&event["message"]).starts_with("[autonomous-continuation: gate-failed]")
        })
        .expect("the continuation's wire pair");
    let preceding: Vec<&str> = events[..continuation_index]
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .collect();
    assert_eq!(
        preceding.iter().rev().take(3).copied().collect::<Vec<_>>(),
        vec!["message_start", "turn_start", "turn_end"],
        "turn_end -> turn_start -> the continuation row, events: {events:?}"
    );

    // The durable session rows: the continuation is a user entry, the stop
    // wrote no custom entry.
    let files = session_files(home.path());
    assert_eq!(files.len(), 1, "one session file, got {files:?}");
    let entries = read_entries(&files[0]);
    let durable_continuations: Vec<&Value> = entries
        .iter()
        .filter(|entry| {
            entry["type"] == "message"
                && entry["message"]["role"] == "user"
                && text_of(&entry["message"]).starts_with("[autonomous-continuation: gate-failed]")
        })
        .collect();
    assert_eq!(durable_continuations.len(), 1, "entries: {entries:?}");
    assert!(
        !entries
            .iter()
            .any(|entry| entry["type"] == "custom_message"
                && entry["customType"] == "autonomous_status"),
        "entries: {entries:?}"
    );
}

/// A verifier that never passes exhausts its retry window: the process exits
/// one, the TS print-mode stderr line names the attempt and exit code, and
/// the stop writes no row (the exit contract carries it).
#[test]
fn verifier_gate_failure_exhausts_retries_and_exits_one() {
    let home = isolated_home();
    let verifier = always_failing_verifier(home.path());
    let script = json!({ "responses": ["attempt one", "attempt two"] });
    let (stdout, stderr, code) = run(
        home.path(),
        &[
            "--mode",
            "json",
            "-p",
            "build the feature",
            "--autonomous",
            "--autonomous-gate",
            verifier.to_str().unwrap(),
            "--autonomous-gate-retries",
            "1",
        ],
        &script,
    );
    assert_eq!(code, 1, "stderr: {stderr}\nstdout: {stdout}");
    assert!(
        stderr.starts_with(
            "Autonomous quality gate still failing after attempt 2/1: exited with code 1"
        ),
        "stderr: {stderr}"
    );
    // No stdout text output in json mode: the terminal contract rides stderr.
    assert!(
        stdout
            .lines()
            .all(|line| { serde_json::from_str::<Value>(line).is_ok() }),
        "stdout is all json events: {stdout}"
    );
    let events = parse_events(&stdout);
    // The stop surfaces no row (the TS shape): the stream carries no
    // autonomous_status event and the store no custom entry — the stderr
    // line and the exit code carry the retry-exhausted stop.
    assert!(
        !events
            .iter()
            .any(|event| event["message"]["customType"] == "autonomous_status"),
        "events: {events:?}"
    );
    let files = session_files(home.path());
    let entries = read_entries(&files[0]);
    assert!(
        !entries
            .iter()
            .any(|entry| entry["type"] == "custom_message"
                && entry["customType"] == "autonomous_status"),
        "entries: {entries:?}"
    );
}

/// Text mode prints the final answer on a passing verifier run, and stays
/// quiet about the autonomous machinery (the stop writes nothing).
#[test]
fn text_mode_verifier_pass_prints_the_final_answer() {
    let home = isolated_home();
    let verifier = pass_on_second_consult_verifier(home.path());
    let script = json!({ "responses": ["first attempt", "fixed it"] });
    let (stdout, stderr, code) = run(
        home.path(),
        &[
            "-p",
            "build the feature",
            "--autonomous",
            "--autonomous-gate",
            verifier.to_str().unwrap(),
        ],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "fixed it\n");
    assert!(stderr.is_empty(), "stderr: {stderr}");

    // The stop wrote no row (the TS shape); the continuation is the only
    // autonomous surface in the store.
    let files = session_files(home.path());
    let entries = read_entries(&files[0]);
    assert!(
        !entries
            .iter()
            .any(|entry| entry["type"] == "custom_message"
                && entry["customType"] == "autonomous_status"),
        "entries: {entries:?}"
    );
    assert!(
        entries.iter().any(|entry| {
            entry["type"] == "message"
                && entry["message"]["role"] == "user"
                && text_of(&entry["message"]).starts_with("[autonomous-continuation: gate-failed]")
        }),
        "entries: {entries:?}"
    );
}

/// The autonomous contract without gates: a budget limit stops the run and
/// the process exits one with the TS "stopped before terminal evidence"
/// line; the stop writes no row.
#[test]
fn autonomous_limit_without_gates_exits_one_without_a_row() {
    let home = isolated_home();
    let script = json!({ "responses": ["still working", "more work"] });
    let (stdout, stderr, code) = run(
        home.path(),
        &[
            "-p",
            "build the feature",
            "--autonomous",
            "--autonomous-max-continuations",
            "1",
        ],
        &script,
    );
    assert_eq!(code, 1, "stderr: {stderr}");
    assert_eq!(stdout, "more work\n");
    assert!(
        stderr.starts_with(
            "Autonomous run stopped before terminal evidence; maxContinuations reached (1/1)"
        ),
        "stderr: {stderr}"
    );
    let files = session_files(home.path());
    let entries = read_entries(&files[0]);
    assert!(
        !entries
            .iter()
            .any(|entry| entry["type"] == "custom_message"
                && entry["customType"] == "autonomous_status"),
        "entries: {entries:?}"
    );
    assert!(
        entries.iter().any(|entry| {
            entry["type"] == "message"
                && entry["message"]["role"] == "user"
                && text_of(&entry["message"]).starts_with("[autonomous-continuation]")
        }),
        "entries: {entries:?}"
    );
}

/// Verifier observation without autonomous flags: nothing changes — the
/// plain print contract holds (the gate flags, not their absence, enable the
/// composition).
#[test]
fn plain_print_run_ignores_no_autonomous_flags() {
    let home = isolated_home();
    let script = json!({ "responses": ["single answer"] });
    let (stdout, stderr, code) = run(home.path(), &["-p", "just answer"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "single answer\n");
    let files = session_files(home.path());
    let entries = read_entries(&files[0]);
    assert!(
        !entries
            .iter()
            .any(|entry| entry["type"] == "custom_message"
                && entry["customType"] == "autonomous_status"),
        "entries: {entries:?}"
    );
}

// large_futures: stack-resident futures on hot paths by design.
// too_many_lines: style gate, not correctness. Casts: 64-bit targets;
// narrowing sits at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! End-to-end print-runtime verification: the real binary, an isolated
//! HOME, and the scripted faux provider drive the complete pipeline from
//! CLI parse to headless terminal selection, deterministically.

use std::process::Command;

fn run(args: &[&str], script: &serde_json::Value) -> (String, String, i32) {
    let home = tempfile::TempDir::new().unwrap();
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let output = Command::new(bin)
        .args(args)
        .env("HOME", home.path())
        .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        .env_remove("RLM_DEPTH")
        .current_dir(home.path())
        .output()
        .expect("binary present");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

#[test]
fn print_mode_text_output_matches_the_scripted_response() {
    let script = serde_json::json!({ "responses": ["first answer"] });
    let (stdout, stderr, code) = run(&["-p", "say something"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "first answer\n");
    assert!(stderr.is_empty());
}

#[test]
fn print_mode_multi_prompt_consumes_responses_in_order() {
    let script = serde_json::json!({ "responses": ["first answer", "second answer"] });
    let (stdout, _, code) = run(&["-p", "one", "two"], &script);
    assert_eq!(code, 0);
    assert_eq!(stdout, "second answer\n");
}

#[test]
fn print_mode_json_streams_ts_shaped_events() {
    let script = serde_json::json!({ "responses": ["json answer"] });
    let (stdout, stderr, code) = run(&["--mode", "json", "-p", "hi"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    let lines: Vec<serde_json::Value> = stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(lines[0]["type"], "session");
    assert_eq!(lines[0]["version"], 3);
    assert!(lines[0]["timestamp"].is_string());
    assert_eq!(lines[0]["rlmDepth"], 0);
    let types: Vec<&str> = lines
        .iter()
        .map(|line| line["type"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(types[1], "agent_start");
    assert!(types.contains(&"turn_start"));
    assert!(types.contains(&"message_start"));
    assert!(types.contains(&"message_end"));
    assert!(types.contains(&"turn_end"));
    let user = lines
        .iter()
        .find(|line| line["type"] == "message_start" && line["message"]["role"] == "user")
        .unwrap();
    assert_eq!(user["message"]["content"][0]["text"], "hi");
    let assistant = lines
        .iter()
        .find(|line| line["type"] == "message_end" && line["message"]["role"] == "assistant")
        .unwrap();
    assert_eq!(assistant["message"]["content"][0]["text"], "json answer");
    assert_eq!(assistant["message"]["stopReason"], "stop");
    assert_eq!(*types.last().unwrap(), "agent_end");
}

#[test]
fn print_mode_reports_provider_errors_as_exit_one() {
    // No responses queued: the faux provider returns an error stop reason.
    let script = serde_json::json!({ "responses": [] });
    let (stdout, stderr, code) = run(&["-p", "hi"], &script);
    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    assert!(!stderr.is_empty());
}

// Session persistence (headless print sessions must land on disk).

fn isolated_home() -> tempfile::TempDir {
    tempfile::TempDir::new().unwrap()
}

fn run_in_home(
    home: &std::path::Path,
    args: &[&str],
    script: &serde_json::Value,
) -> (String, String, i32) {
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let output = Command::new(bin)
        .args(args)
        .env("HOME", home)
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        // Keep the isolated HOME authoritative: ambient dir overrides stay out.
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .env_remove("PRIME_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
        .env_remove("RLM_DEPTH")
        .current_dir(home)
        .output()
        .expect("binary present");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

fn session_files(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let dir = home.join(".prime/agent/sessions");
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
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

fn read_entries(path: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn print_mode_persists_a_session_file_by_default() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["persisted answer"] });
    let (stdout, stderr, code) = run_in_home(home.path(), &["-p", "hello there"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "persisted answer\n");

    let files = session_files(home.path());
    assert_eq!(files.len(), 1, "one session file, got {files:?}");
    let entries = read_entries(&files[0]);

    let types: Vec<&str> = entries
        .iter()
        .map(|entry| entry["type"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(types[0], "session");
    assert!(types.contains(&"model_change"));
    assert!(types.contains(&"thinking_level_change"));
    let user = entries
        .iter()
        .find(|entry| entry["type"] == "message" && entry["message"]["role"] == "user")
        .expect("user message persisted");
    assert_eq!(user["message"]["content"][0]["text"], "hello there");
    let assistant = entries
        .iter()
        .find(|entry| entry["type"] == "message" && entry["message"]["role"] == "assistant")
        .expect("assistant message persisted");
    assert_eq!(
        assistant["message"]["content"][0]["text"],
        "persisted answer"
    );
    assert_eq!(entries[0]["cwd"], home.path().display().to_string());
}

#[test]
fn print_mode_no_session_writes_nothing() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["gone"] });
    let (stdout, stderr, code) = run_in_home(home.path(), &["-p", "hi", "--no-session"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "gone\n");
    assert!(session_files(home.path()).is_empty());
}

#[test]
fn print_mode_resume_appends_to_the_same_session_file() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["first answer"] });
    let (stdout, stderr, code) = run_in_home(home.path(), &["-p", "first"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "first answer\n");
    let files = session_files(home.path());
    assert_eq!(files.len(), 1);

    let session_id = read_entries(&files[0])[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let before = read_entries(&files[0]).len();

    // A uuid-v7 prefix selects the saved session.
    let selector = &session_id[..8];
    let script = serde_json::json!({ "responses": ["second answer"] });
    let (stdout, stderr, code) = run_in_home(
        home.path(),
        &["--resume", selector, "-p", "second"],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "second answer\n");

    let after_files = session_files(home.path());
    assert_eq!(after_files.len(), 1, "resume reuses the saved session");
    let entries = read_entries(&after_files[0]);
    assert!(entries.len() > before, "new messages were appended");
    let texts: Vec<&str> = entries
        .iter()
        .filter(|entry| entry["type"] == "message")
        .filter_map(|entry| entry["message"]["content"][0]["text"].as_str())
        .collect();
    assert!(texts.contains(&"second"));
}

#[test]
fn print_mode_continue_recent_reuses_the_latest_session() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["one"] });
    let (_, _, code) = run_in_home(home.path(), &["-p", "one"], &script);
    assert_eq!(code, 0);
    assert_eq!(session_files(home.path()).len(), 1);

    let script = serde_json::json!({ "responses": ["two"] });
    let (stdout, stderr, code) = run_in_home(home.path(), &["--continue", "-p", "two"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "two\n");
    assert_eq!(
        session_files(home.path()).len(),
        1,
        "continue reuses the saved session"
    );
}

#[test]
fn print_mode_resume_unknown_selector_fails_with_browse_hint() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": [] });
    let (stdout, stderr, code) =
        run_in_home(home.path(), &["--resume", "deadbeef", "-p", "hi"], &script);
    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    assert!(
        stderr.contains("No session found matching 'deadbeef'"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("Open prime-agent and press left-arrow to browse sessions."),
        "stderr: {stderr}"
    );
}

/// `--thinking max` on a reasoning faux model must persist the clamped effective level.
#[test]
fn print_mode_thinking_max_persists_the_clamped_high_level() {
    let home = isolated_home();
    // No thinkingLevelMap: the supported levels end at high, so max clamps.
    let script = serde_json::json!({ "reasoning": true, "responses": ["clamped answer"] });
    let (stdout, stderr, code) =
        run_in_home(home.path(), &["-p", "--thinking", "max", "hello"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "clamped answer\n");

    let files = session_files(home.path());
    assert_eq!(files.len(), 1, "one session file, got {files:?}");
    let entries = read_entries(&files[0]);
    let level = entries
        .iter()
        .find(|entry| entry["type"] == "thinking_level_change")
        .expect("thinking_level_change persisted");
    assert_eq!(level["thinkingLevel"], "high");
}

/// The clamp also applies on the way down: a non-reasoning model maps any requested level to off.
#[test]
fn print_mode_thinking_clamps_to_off_for_non_reasoning_models() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["plain answer"] });
    let (stdout, stderr, code) =
        run_in_home(home.path(), &["-p", "--thinking", "high", "hello"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "plain answer\n");

    let files = session_files(home.path());
    assert_eq!(files.len(), 1, "one session file, got {files:?}");
    let entries = read_entries(&files[0]);
    let level = entries
        .iter()
        .find(|entry| entry["type"] == "thinking_level_change")
        .expect("thinking_level_change persisted");
    assert_eq!(level["thinkingLevel"], "off");
}

// Overflow compact-and-retry (TS `_checkCompaction` Case 1 in print mode).

/// Compaction settings into the isolated home's agent dir.
fn write_compaction_settings(home: &std::path::Path, settings: &serde_json::Value) {
    let agent = home.join(".prime/agent");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("settings.json"), settings.to_string()).unwrap();
}

/// The TS overflow error shape; `delayMs` paces the retried turn's
/// timestamp past the compaction boundary.
fn overflow_error(delay_ms: u64) -> serde_json::Value {
    let mut entry = serde_json::json!({
        "content": [{ "type": "text", "text": "" }],
        "stopReason": "error",
        "errorMessage": "prompt is too long: 213462 tokens > 200000 maximum",
    });
    if delay_ms > 0 {
        entry["delayMs"] = serde_json::json!(delay_ms);
    }
    entry
}

/// `keepRecentTokens` keeps ~10 tokens, so recovery with pre-cut history summarizes it.
fn compactable_settings() -> serde_json::Value {
    serde_json::json!({
        "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 }
    })
}

/// The reported-overflow failure text (TS `_checkCompaction` verbatim).
const OVERFLOW_RECOVERY_FAILED: &str = "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";

/// The full compact-and-retry cycle (verified against the TS binary): an
/// overflow drops the failed turn, compacts once, re-issues, and the second
/// overflow ends the run, exit 1.
#[test]
fn print_mode_overflow_compacts_retries_once_then_reports() {
    let home = isolated_home();
    write_compaction_settings(home.path(), &compactable_settings());
    let script = serde_json::json!({
        "responses": [
            {"text": "seed reply"},
            overflow_error(0),
            {"text": "the summary"},
            overflow_error(50),
        ]
    });
    let seed = format!("seed turn {}", "x".repeat(48_000));
    let probe = format!("overflow probe {}", "x".repeat(48_000));
    let (stdout, stderr, code) = run_in_home(home.path(), &["-p", &seed, &probe], &script);
    assert_eq!(code, 1, "stderr: {stderr}");
    assert!(stdout.is_empty(), "stdout: {stdout}");
    let error_at = stderr
        .find("prompt is too long: 213462 tokens > 200000 maximum")
        .expect("the overflow error surfaces");
    let reported_at = stderr
        .find(OVERFLOW_RECOVERY_FAILED)
        .expect("the reported failure row surfaces");
    assert!(
        error_at < reported_at,
        "the primary error precedes the reported outcome row: {stderr}"
    );
    let files = session_files(home.path());
    assert_eq!(files.len(), 1);
    let entries = read_entries(&files[0]);
    let compactions = entries
        .iter()
        .filter(|entry| entry["type"] == "compaction")
        .count();
    assert_eq!(compactions, 1, "one compaction entry");
    // A custom-row file entry flattens its payload: `customType` and the
    // details sit at the top level of the line.
    let outcome = entries
        .iter()
        .find(|entry| entry["customType"] == "compaction_outcome")
        .expect("the durable outcome row");
    let outcome_content = serde_json::to_string(&outcome["content"]).unwrap();
    assert!(outcome_content.contains(OVERFLOW_RECOVERY_FAILED));
    assert_eq!(outcome["details"]["reason"], "overflow");
    assert_eq!(outcome["details"]["outcome"], "failed");
    let users = entries
        .iter()
        .filter(|entry| entry["type"] == "message" && entry["message"]["role"] == "user")
        .count();
    assert_eq!(users, 2, "the retry re-issued without re-adding the prompt");
}

/// The retry on the compacted context recovers the turn (exit 0).
#[test]
fn print_mode_overflow_retry_recovers_the_turn() {
    let home = isolated_home();
    write_compaction_settings(home.path(), &compactable_settings());
    let script = serde_json::json!({
        "responses": [
            {"text": "seed reply"},
            overflow_error(0),
            {"text": "the summary"},
            {"text": "recovered reply"},
            // The compact-trigger auto-refine review the recovered turn's
            // checkpoint runs: a decline, so the review stays silent.
            r#"{"shouldRefine": false, "rationale": "one-off tool output"}"#,
        ]
    });
    let seed = format!("seed turn {}", "x".repeat(48_000));
    let probe = format!("overflow probe {}", "x".repeat(48_000));
    let (stdout, stderr, code) = run_in_home(home.path(), &["-p", &seed, &probe], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "recovered reply\n");
    assert!(stderr.is_empty(), "stderr: {stderr}");
    let files = session_files(home.path());
    let entries = read_entries(&files[0]);
    let compactions = entries
        .iter()
        .filter(|entry| entry["type"] == "compaction")
        .count();
    assert_eq!(compactions, 1);
    assert!(
        !entries
            .iter()
            .any(|entry| entry["customType"] == "compaction_outcome"),
        "no failure rows on a recovered retry"
    );
}

/// A skipped recovery (nothing compactable) surfaces the warning row and
/// exits 0 — the TS text-mode contract.
#[test]
fn print_mode_overflow_skip_surfaces_the_warning_row() {
    let home = isolated_home();
    write_compaction_settings(
        home.path(),
        &serde_json::json!({
            "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 100_000 }
        }),
    );
    let script = serde_json::json!({ "responses": [overflow_error(0)] });
    let (stdout, stderr, code) = run_in_home(home.path(), &["-p", "overflow probe"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.is_empty(), "stdout: {stdout}");
    assert_eq!(
        stderr,
        "Auto-compaction skipped: Session is too short to compact — try again once it grows\n"
    );
    assert!(
        !stderr.contains("No response produced."),
        "the TS text mode stays silent without a primary: {stderr}"
    );
}

/// The json-mode event stream for the compact-and-retry cycle (verified
/// against the TS binary): the `compaction_start`/`compaction_end` pair with
/// `willRetry: true`, the retried turn without a new user message,
/// and the reported failure surface.
#[test]
fn print_mode_overflow_json_streams_the_compaction_events() {
    let home = isolated_home();
    write_compaction_settings(home.path(), &compactable_settings());
    let script = serde_json::json!({
        "responses": [
            {"text": "seed reply"},
            overflow_error(0),
            {"text": "the summary"},
            overflow_error(50),
        ]
    });
    let seed = format!("seed turn {}", "x".repeat(48_000));
    let probe = format!("overflow probe {}", "x".repeat(48_000));
    let (stdout, stderr, code) = run_in_home(
        home.path(),
        &["--mode", "json", "-p", &seed, &probe],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .unwrap();
    let start_at = events
        .iter()
        .position(|event| event["type"] == "compaction_start" && event["reason"] == "overflow")
        .expect("the compaction_start event");
    let success_at = events
        .iter()
        .position(|event| {
            event["type"] == "compaction_end"
                && event["reason"] == "overflow"
                && event["willRetry"] == true
        })
        .expect("the successful compaction_end event");
    assert!(start_at < success_at);
    assert_eq!(events[success_at]["result"]["summary"], "the summary");
    assert_eq!(events[success_at]["aborted"], false);
    let retried_error_at = events
        .iter()
        .rposition(|event| {
            event["type"] == "message_end"
                && event["message"]["role"] == "assistant"
                && event["message"]["stopReason"] == "error"
        })
        .expect("the retried overflow error");
    assert!(
        success_at < retried_error_at,
        "the retried turn follows the compaction"
    );
    let users = events
        .iter()
        .filter(|event| event["type"] == "message_start" && event["message"]["role"] == "user")
        .count();
    assert_eq!(users, 2);
    let row_at = events
        .iter()
        .position(|event| {
            event["type"] == "message_end"
                && event["message"]["customType"] == "compaction_outcome"
                && event["message"]["details"]["outcome"] == "failed"
        })
        .expect("the reported outcome row");
    let row_content = serde_json::to_string(&events[row_at]["message"]["content"]).unwrap();
    assert!(row_content.contains(OVERFLOW_RECOVERY_FAILED));
    assert_eq!(events[row_at]["message"]["details"]["reason"], "overflow");
    let reported_at = events
        .iter()
        .position(|event| {
            event["type"] == "compaction_end"
                && event["reason"] == "overflow"
                && event["willRetry"] == false
        })
        .expect("the reported compaction_end event");
    assert!(
        retried_error_at < row_at && row_at < reported_at,
        "the reported row pair precedes the end event"
    );
    assert_eq!(
        events[reported_at]["errorMessage"],
        OVERFLOW_RECOVERY_FAILED
    );
    assert!(
        events[reported_at].get("errorSeverity").is_none(),
        "automatic failures carry no error severity"
    );
    assert_eq!(
        events[start_at],
        serde_json::json!({"type": "compaction_start", "reason": "overflow"}),
        "the start event carries the TS shape"
    );
}

/// The stale-overflow recovery across runs (the `--continue` shape,
/// verified against the TS binary): the resumed run's pre-turn arm compacts
/// the stale overflow before the admitted prompt.
#[test]
fn print_mode_stale_overflow_recovers_before_the_next_prompt_after_a_resume() {
    let home = isolated_home();
    // Run one: compaction disabled, the probe overflows.
    write_compaction_settings(
        home.path(),
        &serde_json::json!({
            "compaction": { "enabled": false, "reserveTokens": 1, "keepRecentTokens": 10 }
        }),
    );
    let script = serde_json::json!({
        "responses": [{"text": "seed reply"}, overflow_error(0)]
    });
    let seed = format!("seed turn {}", "x".repeat(48_000));
    let probe = format!("overflow probe {}", "x".repeat(48_000));
    let (stdout, stderr, code) = run_in_home(home.path(), &["-p", &seed, &probe], &script);
    assert_eq!(code, 1, "stderr: {stderr}");
    assert!(stdout.is_empty());

    // Run two: compaction enabled — the pre-turn arm compacts the stale overflow.
    write_compaction_settings(home.path(), &compactable_settings());
    let script = serde_json::json!({
        "responses": [
            {"text": "the stale recovery summary"},
            {"text": "recovered after the resume"},
            // The compact-trigger auto-refine review the recovered turn's
            // checkpoint runs: a decline, so the review stays silent.
            r#"{"shouldRefine": false, "rationale": "one-off tool output"}"#,
        ]
    });
    let (stdout, stderr, code) =
        run_in_home(home.path(), &["--continue", "-p", "next prompt"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "recovered after the resume\n");
    assert!(stderr.is_empty(), "stderr: {stderr}");
    let files = session_files(home.path());
    assert_eq!(files.len(), 1, "the resume reuses the session file");
    let entries = read_entries(&files[0]);
    let compactions = entries
        .iter()
        .filter(|entry| entry["type"] == "compaction")
        .count();
    assert_eq!(compactions, 1, "the pre-turn recovery compacted");
}

// The json event stream's TS parity surface (verified against the TS binary).

/// The harness digest pair (TS commit-time injection): the first turn
/// streams the digest pair between `turn_start` and the user pair.
#[test]
fn print_mode_json_streams_the_harness_digest_pair() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["json answer"] });
    let (stdout, stderr, code) = run_in_home(home.path(), &["--mode", "json", "-p", "hi"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .unwrap();
    let digest_at = events
        .iter()
        .position(|event| {
            event["type"] == "message_start"
                && event["message"]["role"] == "custom"
                && event["message"]["customType"] == "harness_digest"
        })
        .expect("the digest message_start event");
    let turn_start_at = events
        .iter()
        .position(|event| event["type"] == "turn_start")
        .expect("turn_start");
    let user_at = events
        .iter()
        .position(|event| event["type"] == "message_start" && event["message"]["role"] == "user")
        .expect("the user message pair");
    assert!(turn_start_at < digest_at && digest_at < user_at);
    let digest = &events[digest_at]["message"];
    assert!(digest["content"].is_string());
    assert!(digest["content"]
        .as_str()
        .unwrap()
        .starts_with("[harness-digest]"));
    assert!(digest["content"]
        .as_str()
        .unwrap()
        .ends_with("</harness_state>"));
    assert_eq!(digest["display"], false);
    assert!(digest["details"]["digest"].is_string());
    assert!(digest["details"]["digest"]
        .as_str()
        .unwrap()
        .contains("# Continual Harness State"));
    let digest_end_at = events
        .iter()
        .position(|event| {
            event["type"] == "message_end"
                && event["message"]["role"] == "custom"
                && event["message"]["customType"] == "harness_digest"
        })
        .expect("the digest message_end event");
    assert_eq!(
        events[digest_at]["message"],
        events[digest_end_at]["message"]
    );
}

/// The streaming deltas (TS `message_update`): the wire carries the slim
/// deltas (`partial` never rides the wire).
#[test]
fn print_mode_json_streams_the_message_update_deltas() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["a streamed answer"] });
    let (stdout, stderr, code) = run_in_home(home.path(), &["--mode", "json", "-p", "hi"], &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .unwrap();
    let start_at = events
        .iter()
        .position(|event| {
            event["type"] == "message_start" && event["message"]["role"] == "assistant"
        })
        .expect("the assistant message_start");
    let end_at = events
        .iter()
        .position(|event| event["type"] == "message_end" && event["message"]["role"] == "assistant")
        .expect("the assistant message_end");
    let updates: Vec<&serde_json::Value> = events[start_at..end_at]
        .iter()
        .filter(|event| event["type"] == "message_update")
        .collect();
    assert!(!updates.is_empty(), "the stream carries the deltas");
    assert_eq!(updates[0]["assistantMessageEvent"]["type"], "text_start");
    let last = updates.last().unwrap();
    assert_eq!(last["assistantMessageEvent"]["type"], "text_end");
    assert_eq!(
        last["assistantMessageEvent"]["content"],
        "a streamed answer"
    );
    for update in &updates {
        assert_eq!(update["assistantMessageEvent"]["contentIndex"], 0);
        assert!(update["assistantMessageEvent"].get("partial").is_none());
        assert_eq!(update["message"]["role"], "assistant");
    }
    assert_eq!(updates[0]["message"]["content"][0]["text"], "");
    assert_eq!(last["message"]["content"][0]["text"], "a streamed answer");
    // The field order matches the TS stream — the JSON map preserves
    // insertion order, so this is the wire byte order.
    let keys: Vec<&str> = updates[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["type", "message", "assistantMessageEvent"]);
}

/// The threshold compaction arm (TS `_checkCompaction` Case 3): a settled
/// turn crossing the reserve headroom streams the `compaction_start`/
/// `compaction_end` pair with the `threshold` reason.
#[test]
fn print_mode_json_streams_the_threshold_compaction_pair() {
    let home = isolated_home();
    write_compaction_settings(
        home.path(),
        &serde_json::json!({
            "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 }
        }),
    );
    // A small context window: the ~8.1k seed turn stays below the 15_808
    // ceiling (24k - 4_096 output - 4_096 headroom), and the ~12k-token
    // crossing turn pushes past it.
    let script = serde_json::json!({
        "contextWindow": 24000,
        "responses": [
            {"text": "seed reply"},
            {"text": "crossing reply"},
            {"text": "the compaction summary"},
        ]
    });
    let first = "seed turn".to_string();
    let second = format!("crossing turn {}", "x".repeat(48_000));
    let (stdout, stderr, code) = run_in_home(
        home.path(),
        &["--mode", "json", "-p", &first, &second],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .unwrap();
    let start_at = events
        .iter()
        .position(|event| event["type"] == "compaction_start")
        .expect("the compaction_start event");
    assert_eq!(
        events[start_at],
        serde_json::json!({ "type": "compaction_start", "reason": "threshold" })
    );
    let last_agent_end = events
        .iter()
        .rposition(|event| event["type"] == "agent_end")
        .expect("the last agent_end");
    assert!(last_agent_end < start_at);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "turn_start")
            .count(),
        2,
        "exactly two runs"
    );
    let end_at = events
        .iter()
        .position(|event| event["type"] == "compaction_end")
        .expect("the compaction_end event");
    assert!(start_at < end_at);
    assert_eq!(events[end_at]["reason"], "threshold");
    assert_eq!(
        events[end_at]["result"]["summary"],
        "the compaction summary"
    );
    assert_eq!(events[end_at]["aborted"], false);
    assert_eq!(events[end_at]["willRetry"], false);
    assert!(events[end_at].get("errorMessage").is_none());
    let files = session_files(home.path());
    assert_eq!(files.len(), 1);
    let entries = read_entries(&files[0]);
    assert!(
        entries.iter().any(|entry| entry["type"] == "compaction"),
        "the compaction persisted"
    );
}

/// Run the binary in the isolated HOME but a different working directory.
fn run_in_home_cwd(
    home: &std::path::Path,
    cwd: &std::path::Path,
    args: &[&str],
    script: &serde_json::Value,
) -> (String, String, i32) {
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let output = Command::new(bin)
        .args(args)
        .env("HOME", home)
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .env_remove("PRIME_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
        .env_remove("RLM_DEPTH")
        .current_dir(cwd)
        .output()
        .expect("binary present");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

/// TS `createSessionManager`'s fork arm: `--fork <selector>` copies the
/// source session into a NEW file (TS `SessionManager.forkFrom`), the run
/// continues the copy, and the fork header parents at the source.
#[test]
fn print_mode_fork_copies_the_session_into_a_new_file() {
    let home = isolated_home();
    let script = serde_json::json!({ "responses": ["first answer"] });
    let (stdout, _, code) = run_in_home(home.path(), &["-p", "first"], &script);
    assert_eq!(code, 0);
    assert_eq!(stdout, "first answer\n");
    let files = session_files(home.path());
    assert_eq!(files.len(), 1);
    let source = &files[0];
    let session_id = read_entries(source)[0]["id"].as_str().unwrap().to_string();

    // Fork by the same prefix selector shape resume uses.
    let selector = session_id[..8].to_string();
    let script = serde_json::json!({ "responses": ["second answer"] });
    let (stdout, stderr, code) = run_in_home(
        home.path(),
        &["--fork", selector.as_str(), "-p", "second"],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "second answer\n");

    let after = session_files(home.path());
    assert_eq!(after.len(), 2, "fork creates a new session file");
    let fork = after
        .iter()
        .find(|path| path.as_path() != source.as_path())
        .expect("the fork file");
    let source_entries = read_entries(source);
    assert!(
        !source_entries
            .iter()
            .any(|entry| entry["message"]["content"][0]["text"] == "second"),
        "the source keeps its rows untouched"
    );
    let fork_entries = read_entries(fork);
    assert_ne!(fork_entries[0]["id"], session_id.as_str());
    assert_eq!(
        fork_entries[0]["parentSession"],
        source.display().to_string()
    );
    let texts: Vec<&str> = fork_entries
        .iter()
        .filter(|entry| entry["type"] == "message")
        .filter_map(|entry| entry["message"]["content"][0]["text"].as_str())
        .collect();
    assert!(texts.contains(&"first"));
    assert!(texts.contains(&"second"));
    assert!(texts.contains(&"second answer"));
}

/// `--fork` is the cross-project path: another project's session forks
/// into the CURRENT cwd (the TS GLOBAL arm); `--resume` refuses it.
#[test]
fn print_mode_fork_imports_a_global_session_into_this_cwd() {
    let home = isolated_home();
    let project = home.path().join("other-project");
    std::fs::create_dir_all(&project).expect("project dir");
    let script = serde_json::json!({ "responses": ["global answer"] });
    let (stdout, _, code) = run_in_home(home.path(), &["-p", "origin"], &script);
    assert_eq!(code, 0);
    assert_eq!(stdout, "global answer\n");
    let files = session_files(home.path());
    assert_eq!(files.len(), 1);
    let session_id = read_entries(&files[0])[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let selector = session_id[..8].to_string();

    let script = serde_json::json!({ "responses": ["no"] });
    let (stdout, stderr, code) = run_in_home_cwd(
        home.path(),
        &project,
        &["--resume", selector.as_str(), "-p", "refused"],
        &script,
    );
    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    assert!(
        stderr.contains(&format!(
            "session {selector} belongs to a different project"
        )),
        "stderr: {stderr}"
    );
    assert!(stderr.contains(&format!("Pass --fork {selector}")));

    let script = serde_json::json!({ "responses": ["forked into the project"] });
    let (stdout, stderr, code) = run_in_home_cwd(
        home.path(),
        &project,
        &["--fork", selector.as_str(), "-p", "continue here"],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "forked into the project\n");
    let after = session_files(home.path());
    assert_eq!(after.len(), 2);
    let fork = after
        .iter()
        .find(|path| path.as_path() != files[0].as_path())
        .expect("the fork file");
    let fork_entries = read_entries(fork);
    assert_eq!(
        fork_entries[0]["cwd"],
        project.display().to_string(),
        "the fork adopts the TARGET cwd"
    );
    assert_eq!(
        fork_entries[0]["parentSession"],
        files[0].display().to_string()
    );
    let texts: Vec<&str> = fork_entries
        .iter()
        .filter(|entry| entry["type"] == "message")
        .filter_map(|entry| entry["message"]["content"][0]["text"].as_str())
        .collect();
    assert!(texts.contains(&"origin"));
    assert!(texts.contains(&"continue here"));
}

/// TS `forkFrom`'s failure contract: an empty source file errors with the
/// TS message, and `--fork` still refuses its conflicting flags.
#[test]
fn print_mode_fork_rejects_empty_sources_and_conflicting_flags() {
    let home = isolated_home();
    // An empty session file, addressed by path.
    let sessions = home.path().join(".prime/agent/sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let empty = sessions.join("empty-session.jsonl");
    std::fs::write(&empty, "").expect("empty session");
    let script = serde_json::json!({ "responses": ["never"] });
    let (stdout, stderr, code) = run_in_home(
        home.path(),
        &["--fork", empty.display().to_string().as_str(), "-p", "hi"],
        &script,
    );
    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    assert!(
        stderr.contains("Cannot fork: source session file is empty or invalid:"),
        "stderr: {stderr}"
    );

    // The flag conflicts still refuse (TS validateForkFlags).
    let (stdout, stderr, code) = run_in_home(
        home.path(),
        &[
            "--fork",
            "empty-session",
            "--resume",
            "empty-session",
            "-p",
            "hi",
        ],
        &script,
    );
    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    assert!(
        stderr.contains("--fork cannot be combined with --resume"),
        "stderr: {stderr}"
    );
    assert!(
        session_files(home.path()).is_empty() || {
            let files = session_files(home.path());
            files.iter().all(|path| *path == empty)
        }
    );
}

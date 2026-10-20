// large_futures: stack futures on hot paths by design.
// too_many_lines: style gate, not correctness. Casts: 64-bit targets;
// narrowing sits at bounded OS/OS-protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! End-to-end inline (daemonless) RLM subagents in print mode: the real
//! binary, a scripted faux provider, and a real Python kernel drive the
//! full in-process tree — spawn, child reply turns, the #2270 quiescence
//! wait, the depth gate, and the exit disposal.

use std::path::{Path, PathBuf};

/// One isolated print run: a hermetic HOME + agent dir, the faux script
/// as the environment seam, and the kernel Python for the ipython lanes.
struct PrintLane {
    home: tempfile::TempDir,
    agent_dir: PathBuf,
}

fn lane() -> PrintLane {
    let home = tempfile::TempDir::new().unwrap();
    let agent_dir = home.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    PrintLane { home, agent_dir }
}

impl PrintLane {
    /// The kernel Python with prime-agent-runtime installed; set
    /// `PA_E2E_KERNEL_PYTHON` to point at an explicit interpreter. A
    /// missing kernel FAILS the lane loudly (these e2es are the
    /// subagent surface's proof — a skip would read green while
    /// proving nothing).
    fn kernel_python() -> PathBuf {
        if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
            let explicit = PathBuf::from(explicit);
            assert!(
                explicit.exists(),
                "PA_E2E_KERNEL_PYTHON {} not found",
                explicit.display()
            );
            return explicit;
        }
        let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
            |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
            |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
        ));
        assert!(
            candidate.exists(),
            "kernel python {} not found: set PA_E2E_KERNEL_PYTHON (the kernel-venv layout the \
             product's own bootstrap creates) — the inline-subagent e2es cannot run without one",
            candidate.display()
        );
        candidate
    }

    fn run(
        &self,
        args: &[&str],
        script: &serde_json::Value,
        kernel_python: &Path,
        env_extra: &[(&str, &str)],
    ) -> (String, String, i32) {
        let bin = env!("CARGO_BIN_EXE_prime-agent");
        // An explicitly selected kernel bypasses skill installation. Exercise
        // the checkout's messaging and goal skills even in a fresh kernel venv.
        let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../skills");
        let mut python_paths = vec![skills.join("agent-message/src"), skills.join("goal/src")];
        if let Some(existing) = std::env::var_os("PYTHONPATH") {
            python_paths.extend(std::env::split_paths(&existing));
        }
        let mut command = std::process::Command::new(bin);
        command
            .args(args)
            .env("HOME", self.home.path())
            .env("PRIME_AGENT_CODING_AGENT_DIR", &self.agent_dir)
            .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
            .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
            .env(
                "PYTHONPATH",
                std::env::join_paths(python_paths).expect("skill import paths"),
            )
            .env_remove("RLM_DEPTH")
            .env_remove("RLM_MAX_DEPTH")
            .env_remove("PRIME_AGENT_SESSION_DIR")
            .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
            .current_dir(self.home.path());
        for (key, value) in env_extra {
            command.env(key, value);
        }
        // Bound a broken quiescence loop without waiting for the entire CI
        // shard to expire. Files retain diagnostics even when the child hangs.
        let stdout_path = self.home.path().join("stdout.log");
        let stderr_path = self.home.path().join("stderr.log");
        command
            .stdout(std::fs::File::create(&stdout_path).unwrap())
            .stderr(std::fs::File::create(&stderr_path).unwrap());
        pa_core::platform::set_new_process_group(&mut command);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let status = runtime.block_on(async {
            let mut child = tokio::process::Command::from(command)
                .kill_on_drop(true)
                .spawn()
                .expect("binary present");
            let pid = child.id().expect("running child") as i32;
            if let Ok(status) =
                tokio::time::timeout(std::time::Duration::from_secs(120), child.wait()).await
            {
                Some(status.expect("print run exits"))
            } else {
                let _ = pa_core::platform::kill_process_group_or_pid(pid);
                let _ = child.wait().await;
                None
            }
        });
        let stdout = std::fs::read_to_string(stdout_path).unwrap();
        let stderr = std::fs::read_to_string(stderr_path).unwrap();
        let status = status.unwrap_or_else(|| {
            panic!("print run exceeded 120s; stderr: {stderr}\nstdout: {stdout}")
        });
        (stdout, stderr, status.code().unwrap_or(-1))
    }

    /// The one persisted parent session file the print run wrote.
    fn parent_session_file(&self) -> PathBuf {
        let sessions = self.agent_dir.join("sessions");
        let listing = std::fs::read_dir(&sessions).unwrap_or_else(|error| {
            panic!(
                "the print run persisted its session ({}): {error}; agent dir: {:?}",
                sessions.display(),
                std::fs::read_dir(self.home.path())
                    .map(|entries| entries
                        .flatten()
                        .map(|entry| entry.path())
                        .collect::<Vec<_>>())
                    .unwrap_or_default()
            )
        });
        let mut files: Vec<PathBuf> = listing
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .collect();
        files.sort();
        assert_eq!(files.len(), 1, "one parent session file: {files:?}");
        files.into_iter().next().unwrap()
    }

    /// The session entries of one jsonl file.
    fn entries(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .expect("the session file is readable")
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .expect("the session file is valid jsonl")
    }
}

/// The parent's spawn cell (turn 1): two named children, then the turn
/// ends while both still run — the #2270 scenario.
fn spawn_cell() -> String {
    "a = await rlm.spawn(\"run the alpha task\", name=\"alpha\")\n\
     b = await rlm.spawn(\"run the beta task\", name=\"beta\")\n\
     print(\"SPAWNED\", a.rlm_child_id, b.rlm_child_id)"
        .to_string()
}

/// One child's reply cell: the ipython lane sends the parent a message
/// (the reply that must survive the print run staying open).
fn reply_cell(child: &str) -> String {
    format!(
        "await agent_message.send(\"{child}-RESULT\", receiver_role=\"parent\")\nprint(\"{child} REPLIED\")"
    )
}

/// The parent script whose every later turn answers with the combined
/// text: the replies may drain as one or two turns (the steering queue
/// batches per delivery), so the terminal result must be the same
/// either way (`repeatLastResponse` keeps the queue deterministic).
fn combined_parent_script() -> serde_json::Value {
    serde_json::json!({
        // Turn 2 answers the spawn turn itself ("WAITING"); the
        // repeat-last turn only runs once the replies were processed —
        // so the printed answer proves the parent turned AFTER them.
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": spawn_cell() } },
            ] },
            "WAITING",
            "COMBINED ALPHA-RESULT BETA-RESULT",
        ],
        "repeatLastResponse": true,
        "children": {
            "alpha": { "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("ALPHA") } },
                ] },
                "alpha finished",
            ] },
            "beta": { "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("BETA") } },
                ] },
                "beta finished",
            ] },
        },
    })
}

/// The #2270 scenario: the parent spawns two children and ends its turn;
/// both reply from their kernels; the print run waits for the replies,
/// answers with the combined text, and disposes the child kernels (the
/// final namespace snapshots land in the children's artifact dirs).
#[test]
fn print_inline_subagents_wait_for_replies_and_combine_them() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let (stdout, stderr, code) = lane.run(
        &["-p", "delegate the work"],
        &combined_parent_script(),
        &kernel,
        &[],
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(stdout.trim_end(), "COMBINED ALPHA-RESULT BETA-RESULT");

    // The parent's durable transcript holds both replies as
    // `agent_message` rows from the children.
    let parent_file = lane.parent_session_file();
    let parent_entries = PrintLane::entries(&parent_file);
    let messages: Vec<&serde_json::Value> = parent_entries
        .iter()
        .filter(|entry| entry.get("type").and_then(|t| t.as_str()) == Some("custom_message"))
        .filter(|entry| entry.get("customType").and_then(|t| t.as_str()) == Some("agent_message"))
        .collect();
    let mut reply_rows: Vec<&str> = messages
        .iter()
        .filter_map(|row| row.pointer("/details/message").and_then(|m| m.as_str()))
        .filter(|message| message.ends_with("-RESULT"))
        .collect();
    // The two children run concurrently; the reply rows land in any order.
    reply_rows.sort_unstable();
    assert_eq!(
        reply_rows,
        ["ALPHA-RESULT", "BETA-RESULT"],
        "both child replies landed as agent_message rows"
    );
    for row in messages {
        let message = row
            .pointer("/details/message")
            .and_then(|m| m.as_str())
            .unwrap_or_default();
        if message.ends_with("-RESULT") {
            assert_eq!(
                row.pointer("/details/fromRelationship")
                    .and_then(|r| r.as_str()),
                Some("child"),
                "the reply row is labeled from the child: {row}"
            );
        }
    }

    // Both child sessions live under the parent's artifacts tree, with
    // the parent edge in their headers, their terminal assistant rows
    // (never cancelled), and the disposed kernel's final snapshot.
    let parent_id = Path::new(&parent_file)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .expect("the parent session id")
        .to_string();
    let artifacts = lane.agent_dir.join("session-artifacts").join(&parent_id);
    let mut child_dirs: Vec<PathBuf> = std::fs::read_dir(&artifacts)
        .expect("the parent's session-artifacts tree")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("sub-"))
        })
        .collect();
    child_dirs.sort();
    assert_eq!(
        child_dirs.len(),
        2,
        "two child session dirs: {child_dirs:?}"
    );
    for child_dir in &child_dirs {
        let child_files: Vec<PathBuf> = std::fs::read_dir(child_dir)
            .expect("the child session dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .collect();
        assert_eq!(
            child_files.len(),
            1,
            "one child session file in {child_dir:?}"
        );
        let entries = PrintLane::entries(&child_files[0]);
        let header = entries
            .iter()
            .find(|entry| entry.get("type").and_then(|t| t.as_str()) == Some("session"))
            .expect("the child header row");
        assert_eq!(
            header.get("rlmDepth").and_then(serde_json::Value::as_u64),
            Some(1),
            "the child header records depth 1: {header}"
        );
        assert_eq!(
            header.get("parentSession").and_then(|p| p.as_str()),
            Some(parent_file.display().to_string().as_str()),
            "the child header names the parent session file: {header}"
        );
        // The child ran to its scripted terminal answer (never cancelled).
        let last_assistant = entries
            .iter()
            .rev()
            .find_map(|entry| {
                (entry.get("type").and_then(|t| t.as_str()) == Some("message")
                    && entry.pointer("/message/role").and_then(|r| r.as_str()) == Some("assistant"))
                .then(|| entry.clone())
            })
            .expect("the child's terminal assistant row");
        let text = last_assistant
            .pointer("/message/content/0/text")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        assert!(
            text.contains("finished"),
            "the child finished its task: {text}"
        );
        // The exit disposal proof: the child's kernel was disposed with
        // its final namespace snapshot BEFORE the process exited. The
        // child's artifact dir follows the shared
        // `dirname(sessionDir)/session-artifacts/<session id>` layout, so
        // it lands beside the child's session dir (under the parent's
        // artifacts tree), not inside it.
        let child_id = child_files[0]
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("the child session id")
            .to_string();
        let snapshot = artifacts
            .join("session-artifacts")
            .join(&child_id)
            .join("kernel-state.dill");
        assert!(
            snapshot.exists(),
            "the disposed kernel's final snapshot landed at {}",
            snapshot.display()
        );
    }
}

/// The depth gate: with `RLM_MAX_DEPTH=1`, a depth-1 child's own spawn
/// fails with the shared depth-limit error in its tool result, and the
/// print run still completes.
#[test]
fn print_inline_subagents_enforce_the_depth_limit() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let spawn_attempt = "try:\n    g = await rlm.spawn(\"run the grandkid task\", name=\"grandkid\")\n    print(\"SPAWN_OK\", g.rlm_child_id)\nexcept Exception as error:\n    print(\"SPAWN_FAILED:\", error)".to_string();
    let script = serde_json::json!({
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "kid = await rlm.spawn(\"run the kid task\", name=\"kid\")\nprint(\"KID\", kid.rlm_child_id)" } },
            ] },
            "PARENT DONE",
        ],
        "repeatLastResponse": true,
        "children": {
            "kid": { "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": spawn_attempt } },
                ] },
                "kid finished",
            ] },
        },
    });
    let (stdout, stderr, code) = lane.run(
        &["-p", "delegate once"],
        &script,
        &kernel,
        &[("RLM_MAX_DEPTH", "1")],
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(stdout.trim_end(), "PARENT DONE");

    // The child's transcript carries the refused spawn in its tool result.
    let parent_file = lane.parent_session_file();
    let parent_id = Path::new(&parent_file)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .expect("the parent session id")
        .to_string();
    let artifacts = lane.agent_dir.join("session-artifacts").join(&parent_id);
    let child_dirs: Vec<PathBuf> = std::fs::read_dir(&artifacts)
        .expect("the kid's session dir exists")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("sub-"))
        })
        .collect();
    assert_eq!(child_dirs.len(), 1, "one child session dir: {child_dirs:?}");
    let kid_file: Vec<PathBuf> = std::fs::read_dir(&child_dirs[0])
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    let kid_entries = PrintLane::entries(&kid_file[0]);
    let kid_text = serde_json::to_string(&kid_entries).unwrap();
    assert!(
        kid_text.contains("RLM recursion depth limit reached (RLM_DEPTH=1, RLM_MAX_DEPTH=1)"),
        "the depth-1 child's spawn carried the shared depth-limit error"
    );
    // The kid never replied: the parent's transcript holds the no-reply
    // terminal notice (drained as a turn by the quiescence drive).
    let parent_text = serde_json::to_string(&PrintLane::entries(&parent_file)).unwrap();
    assert!(
        parent_text.contains("[child-exited: no-reply child:kid]"),
        "the parent read the no-reply notice: {parent_text}"
    );
}

/// A settled child re-tasked by its parent must keep the run open: the
/// parent sends the follow-up, ends its turn, and the print run waits
/// for the re-tasked child's second reply before the terminal answer.
/// The quiescence predicate reads the child's live session state (the
/// queued follow-up row), so the run cannot exit while the row sits in
/// the settled child's steering lane.
#[test]
fn print_inline_subagents_wait_for_a_retasked_child() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let follow_up_cell = "collected = await rlm.collect([\"kid\"], timeout_ms=60000)\nprint(\"FIRST-TASK\", collected[0].status, collected[0].settled, collected[0].answer_text)\nawait agent_message.send(\"SECOND-RESULT\", receiver_role=\"child\", receiver_name=\"kid\")\nretasked = await rlm.collect([\"kid\"], timeout_ms=60000)\nprint(\"SECOND-TASK\", retasked[0].status, retasked[0].settled, retasked[0].answer_text)".to_string();
    let script = serde_json::json!({
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "kid = await rlm.spawn(\"run the kid task\", name=\"kid\")\nprint(\"KID\", kid.rlm_child_id)" } },
            ] },
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": follow_up_cell } },
            ] },
            "WAITING",
            "ALL REPLIES READ",
        ],
        "repeatLastResponse": true,
        "children": {
            "kid": { "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("FIRST") } },
                ] },
                "kid finished the first task",
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("SECOND") } },
                ] },
                "kid finished the second task",
            ] },
        },
    });
    let (stdout, stderr, code) = lane.run(&["-p", "delegate twice"], &script, &kernel, &[]);
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(
        stdout.trim_end(),
        "ALL REPLIES READ",
        "the terminal answer ran after the second reply, not the pre-replies \"WAITING\" turn"
    );

    // Both replies landed in the parent's transcript.
    let parent_file = lane.parent_session_file();
    let parent_entries = PrintLane::entries(&parent_file);
    let mut reply_rows: Vec<&str> = parent_entries
        .iter()
        .filter(|entry| entry.get("type").and_then(|t| t.as_str()) == Some("custom_message"))
        .filter(|entry| entry.get("customType").and_then(|t| t.as_str()) == Some("agent_message"))
        .filter_map(|row| row.pointer("/details/message").and_then(|m| m.as_str()))
        .filter(|message| message.ends_with("-RESULT"))
        .collect();
    reply_rows.sort_unstable();
    assert_eq!(
        reply_rows,
        ["FIRST-RESULT", "SECOND-RESULT"],
        "the re-tasked child processed the follow-up and replied again"
    );

    // The in-turn collects: the follow-up's collect waits past the
    // re-tasked run and returns the SECOND task's answer — never the
    // settled child's stale first answer.
    let parent_text = serde_json::to_string(&parent_entries).unwrap();
    assert!(
        parent_text.contains("FIRST-TASK done True kid finished the first task"),
        "the collect before the follow-up read the first task's settled answer: {parent_text}"
    );
    assert!(
        parent_text.contains("SECOND-TASK done True kid finished the second task"),
        "the collect after the follow-up returned the second task's answer: {parent_text}"
    );
}

/// A child whose task turn dies on a provider error settles FAILED, not
/// done: the parent reads the failure row (never a completed-without-
/// reply notice), and a re-tasked child that succeeds collects `done`
/// with no stale error from the failed run. The child's error response is
/// delayed past the parent's spawn turn, so its failure row drains through
/// the quiescence drive, not the spawn turn's steering poll.
#[test]
fn print_inline_subagents_report_a_failed_child_then_a_clean_retry() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    // The turn over the failure row: read the failed verdict, then
    // re-task the child from the parent.
    let retask_cell = "collected = await rlm.collect([\"flaky\"], timeout_ms=60000)\nprint(\"FIRST-COLLECT\", collected[0].status, collected[0].error)\nawait agent_message.send(\"retry the task\", receiver_role=\"child\", receiver_name=\"flaky\")".to_string();
    // The turn over the second reply: collect the clean retry.
    let second_collect_cell =
        "collected = await rlm.collect([\"flaky\"], timeout_ms=60000)\nprint(\"SECOND-COLLECT\", collected[0].status, collected[0].error)".to_string();
    let script = serde_json::json!({
        // Turn 1 spawns and ends ("WAITING"); the failed task's failure
        // row drains as turn 2 (the re-task), the second reply drains as
        // turn 3, and its collect reads the clean retry.
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "kid = await rlm.spawn(\"run the kid task\", name=\"flaky\")\nprint(\"KID\", kid.rlm_child_id)" } },
            ] },
            "WAITING",
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": retask_cell } },
            ] },
            "RETASKED",
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": second_collect_cell } },
            ] },
            "RETRY CLEAN",
        ],
        "repeatLastResponse": true,
        "children": {
            "flaky": { "responses": [
                // The task turn dies on a provider error; the run path
                // itself returns `Ok` for the row, so only its stop
                // reason marks the failure.
                { "text": "the provider exploded mid-task", "stopReason": "error",
                  "errorMessage": "faux provider exploded", "delayMs": 3000 },
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("SECOND") } },
                ] },
                "kid finished the retry",
            ] },
        },
    });
    let (stdout, stderr, code) =
        lane.run(&["-p", "delegate the flaky task"], &script, &kernel, &[]);
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(stdout.trim_end(), "RETRY CLEAN");

    let parent_file = lane.parent_session_file();
    let entries = PrintLane::entries(&parent_file);
    let parent_text = serde_json::to_string(&entries).unwrap();
    // The failed task surfaces as the failure row — never as a
    // completed-without-reply notice.
    let failure_at = entries
        .iter()
        .position(|entry| {
            entry.get("type").and_then(|t| t.as_str()) == Some("custom_message")
                && entry.get("customType").and_then(|t| t.as_str()) == Some("rlm_child_failure")
        })
        .expect("the parent read the failed child's failure row");
    assert_eq!(
        entries[failure_at]
            .pointer("/details/error")
            .and_then(|e| e.as_str()),
        Some("faux provider exploded"),
        "the failure row carries the terminal error: {}",
        entries[failure_at]
    );
    assert!(
        !parent_text.contains("no-reply child:"),
        "the failed run never read as a completed-without-reply notice: {parent_text}"
    );
    // The re-task turn read the failed verdict before re-tasking, and the
    // retry collected done with NO stale error.
    assert!(
        parent_text.contains("FIRST-COLLECT error faux provider exploded"),
        "the collect after the failure read the error status: {parent_text}"
    );
    let reply_at = custom_row_at(&entries, "agent_message", Some("SECOND-RESULT"))
        .expect("the re-tasked child replied again");
    assert!(
        failure_at < reply_at,
        "the failure row (row {failure_at}) landed before the second reply (row {reply_at})"
    );
    assert!(
        parent_text.contains("SECOND-COLLECT done None"),
        "the retry collected done with no stale error: {parent_text}"
    );
}

/// The position of the first custom row of one type carrying a message
/// detail (`goal_context` continuations, the child's `agent_message`
/// reply) — the landing order of these rows is the deferral proof.
fn custom_row_at(
    entries: &[serde_json::Value],
    custom_type: &str,
    message: Option<&str>,
) -> Option<usize> {
    entries.iter().position(|entry| {
        entry.get("type").and_then(|t| t.as_str()) == Some("custom_message")
            && entry.get("customType").and_then(|t| t.as_str()) == Some(custom_type)
            && message.is_none_or(|expected| {
                entry.pointer("/details/message").and_then(|m| m.as_str()) == Some(expected)
            })
    })
}

/// The positions of every `goal_context` row: the seeded continuation
/// rides the first prompt, so the row after the first one is the owed
/// delivery's (the LAST row is not a proof — goal rows keep minting
/// after the reply either way).
fn goal_context_positions(entries: &[serde_json::Value]) -> Vec<usize> {
    entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            entry.get("type").and_then(|t| t.as_str()) == Some("custom_message")
                && entry.get("customType").and_then(|t| t.as_str()) == Some("goal_context")
        })
        .map(|(at, _)| at)
        .collect()
}

/// The position of the first persisted user row whose text starts with
/// the autonomous continuation marker.
fn autonomous_continuation_row_at(entries: &[serde_json::Value]) -> Option<usize> {
    entries.iter().position(|entry| {
        if entry.get("type").and_then(|t| t.as_str()) != Some("message")
            || entry.pointer("/message/role").and_then(|r| r.as_str()) != Some("user")
        {
            return false;
        }
        serde_json::to_string(entry)
            .unwrap_or_default()
            .contains("[autonomous-continuation")
    })
}

/// The goal continuation defers while an inline child is unsettled and
/// delivers after its reply drains: the parent spawns `kid` and ends its
/// turn mid-child-run; the owed continuation turn — the FIRST
/// `goal_context` row after the seeded one — lands only AFTER the
/// child's reply row, and its turn completes the goal, so the printed
/// answer is the post-reply turn. No backoff sleeps: the continuation
/// turn produces output and calls `goal.complete()`.
#[test]
fn print_inline_goal_continuation_waits_for_the_child_reply() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let complete_cell = "done = await goal.complete()\nprint(\"GOAL COMPLETED\")".to_string();
    let script = serde_json::json!({
        // Turn 1 spawns and ends ("WAITING"); the reply drains as turn 2;
        // the owed goal continuation runs as the post-reply turn, calls
        // `goal.complete()`, and ends deterministically.
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "kid = await rlm.spawn(\"run the kid task\", name=\"kid\")\nprint(\"KID\", kid.rlm_child_id)" } },
            ] },
            "WAITING",
            "READ THE REPLY",
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": complete_cell } },
            ] },
            "GOAL DONE AFTER REPLY",
        ],
        "repeatLastResponse": true,
        "children": {
            "kid": { "responses": [
                // The delayed reply holds the child open: the parent's
                // goal gate sees it unsettled at the spawn turn's end.
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("KID") } },
                ], "delayMs": 3000 },
                "kid done",
            ] },
        },
    });
    let (stdout, stderr, code) = lane.run(
        &[
            "--goal",
            "finish the delegated work",
            "-p",
            "delegate then finish",
        ],
        &script,
        &kernel,
        &[],
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(
        stdout.trim_end(),
        "GOAL DONE AFTER REPLY",
        "the terminal answer is the post-reply goal continuation turn"
    );

    // The deferral proof: the first goal continuation row after the
    // seeded one lands AFTER the child's reply row — no continuation
    // turn interleaved before the reply.
    let parent_file = lane.parent_session_file();
    let entries = PrintLane::entries(&parent_file);
    let goal_rows = goal_context_positions(&entries);
    assert!(
        goal_rows.len() >= 2,
        "the seeded continuation and the owed delivery landed: {goal_rows:?}"
    );
    let reply_at = custom_row_at(&entries, "agent_message", Some("KID-RESULT"))
        .expect("the child reply row landed in the parent transcript");
    assert!(
        goal_rows[1] > reply_at,
        "the owed goal continuation (row {}) landed after the child reply (row {})",
        goal_rows[1],
        reply_at
    );
}

/// The autonomous continuation holds behind unsettled inline-subagent
/// work and delivers after the child's reply (no goal): the spawn turn's
/// end holds a FLAG — nothing is spent on the pre-settle turn — and the
/// continuation turn only runs once the reply drained: its user row
/// lands after the reply row, and the printed answer is the post-reply
/// turn. A passing gate ends the run deterministically.
#[test]
fn print_inline_autonomous_continuation_waits_for_the_child_reply() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let marker_cell = "open(\"gate-marker\", \"w\").write(\"done\")\nprint(\"MARKED\")".to_string();
    let script = serde_json::json!({
        // Turn 1 spawns and ends ("WAITING"); the reply drains as turn 2;
        // the held continuation runs as the post-reply turn, writes the
        // gate marker, and the now-passing gate stops the run.
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "kid = await rlm.spawn(\"run the kid task\", name=\"kid\")\nprint(\"KID\", kid.rlm_child_id)" } },
            ] },
            "WAITING",
            "READ THE REPLY",
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": marker_cell } },
            ] },
            "AUTONOMOUS CONTINUES",
        ],
        "repeatLastResponse": true,
        "children": {
            "kid": { "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("KID") } },
                ], "delayMs": 3000 },
                "kid done",
            ] },
        },
    });
    let (stdout, stderr, code) = lane.run(
        &[
            "--autonomous",
            "--autonomous-gate",
            "test -f gate-marker",
            "-p",
            "delegate then keep going",
        ],
        &script,
        &kernel,
        &[],
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(
        stdout.trim_end(),
        "AUTONOMOUS CONTINUES",
        "the terminal answer is the post-reply autonomous continuation turn"
    );

    // The hold proof: the autonomous continuation's user row lands AFTER
    // the child's reply row — no continuation turn interleaved before it.
    let parent_file = lane.parent_session_file();
    let entries = PrintLane::entries(&parent_file);
    let reply_at = custom_row_at(&entries, "agent_message", Some("KID-RESULT"))
        .expect("the child reply row landed in the parent transcript");
    let continuation_at = autonomous_continuation_row_at(&entries)
        .expect("the autonomous continuation row landed in the parent transcript");
    assert!(
        continuation_at > reply_at,
        "the held autonomous continuation (row {continuation_at}) landed after the child reply (row {reply_at})"
    );
}

/// The R1 regression (via the goal token budget, no compaction needed):
/// the reply turn crosses the budget, the accounting arms the budget
/// steer, and the drive loop must run it AFTER the reply drained —
/// before the fix the post-prompt loop broke with the armed steer
/// unrun. The budget self-calibrates: pass 1 runs the same script with
/// a huge budget and reads the persisted faux usage of the spawn turn
/// and the reply turn; the real run uses spawn + half the reply turn
/// (thousands of tokens of margin, so the crossing lands mid-reply-turn
/// and nowhere else).
#[test]
fn print_inline_budget_steer_from_a_drained_reply_runs_after_it() {
    let warm_lane = lane();
    let kernel = PrintLane::kernel_python();
    let complete_cell = "done = await goal.complete()\nprint(\"GOAL COMPLETED\")".to_string();
    let script = serde_json::json!({
        // Turn 1 spawns and ends; the reply drains as turn 2 (crossing
        // the budget); the wrap-up steer runs as turn 3 and completes the
        // goal, so the run ends deterministically.
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "kid = await rlm.spawn(\"run the kid task\", name=\"kid\")\nprint(\"KID\", kid.rlm_child_id)" } },
            ] },
            "WAITING",
            "READ THE REPLY",
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": complete_cell } },
            ] },
            "GOAL WRAPPED UP",
        ],
        "repeatLastResponse": true,
        "children": {
            "kid": { "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": reply_cell("KID") } },
                ], "delayMs": 3000 },
                "kid done",
            ] },
        },
    });

    // Pass 1: the same script with a budget no turn can cross; the goal
    // completes at the same slot, so the usage rows of the first three
    // assistant messages match the real run's.
    let (_, _, warm) = warm_lane.run(
        &[
            "--goal",
            "finish the delegated work",
            "--goal-token-budget",
            "4000000000",
            "-p",
            "delegate then finish",
        ],
        &script,
        &kernel,
        &[],
    );
    assert_eq!(warm, 0);
    let warm_file = warm_lane.parent_session_file();
    let warm_entries = PrintLane::entries(&warm_file);
    let usage: Vec<u64> = warm_entries
        .iter()
        .filter(|entry| entry.get("type").and_then(|t| t.as_str()) == Some("message"))
        .filter(|entry| {
            entry.pointer("/message/role").and_then(|r| r.as_str()) == Some("assistant")
        })
        .map(|entry| {
            let usage = entry
                .pointer("/message/usage")
                .expect("the faux row carries usage");
            let input = usage
                .get("input")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("output")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            input + output
        })
        .collect();
    // The two spawn-turn assistant rows, then the reply-turn row.
    assert!(usage.len() >= 3, "the warm run's assistant rows: {usage:?}");
    let spawn_turn: u64 = usage[0] + usage[1];
    let reply_turn: u64 = usage[2];
    assert!(
        reply_turn > 0,
        "the reply turn's usage is positive: {usage:?}"
    );
    let budget = spawn_turn + reply_turn / 2;

    // The real run: the crossing lands mid-reply-turn (the spawn turn
    // stays under budget).
    let lane = lane();
    let (stdout, stderr, code) = lane.run(
        &[
            "--goal",
            "finish the delegated work",
            "--goal-token-budget",
            &budget.to_string(),
            "-p",
            "delegate then finish",
        ],
        &script,
        &kernel,
        &[],
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(
        stdout.trim_end(),
        "GOAL WRAPPED UP",
        "the budget steer's wrap-up turn ran after the reply drained"
    );

    // The steer's budget-limit row lands AFTER the child's reply row.
    let parent_file = lane.parent_session_file();
    let entries = PrintLane::entries(&parent_file);
    let reply_at = custom_row_at(&entries, "agent_message", Some("KID-RESULT"))
        .expect("the child reply row landed in the parent transcript");
    let steer_at = entries
        .iter()
        .position(|entry| {
            entry.get("type").and_then(|t| t.as_str()) == Some("custom_message")
                && entry.get("customType").and_then(|t| t.as_str()) == Some("goal_context")
                && entry
                    .pointer("/content")
                    .and_then(|c| c.as_str())
                    .is_some_and(|text| text.starts_with("[goal: budget-limit]"))
        })
        .expect("the budget steer row landed in the parent transcript");
    assert!(
        steer_at > reply_at,
        "the budget steer (row {steer_at}) landed after the child reply (row {reply_at})"
    );
}

#[test]
fn print_inline_rename_rejects_sibling_collisions_and_preserves_routing() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let parent_cell = r#"
alpha = await rlm.spawn("answer alpha", name="alpha")
beta = await rlm.spawn("check self rename", name="beta")
first = await rlm.collect([beta], timeout_ms=60000)
assert first[0].settled and first[0].answer_text == "beta checked"
try:
    await rlm.rename("alpha", session_id=beta)
except Exception as error:
    assert "unavailable" in str(error), str(error)
else:
    raise AssertionError("parent rename accepted a duplicate sibling name")
rows = await rlm.list_subagents()
assert {row.rlm_child_id: row.session_name for row in rows} == {alpha.rlm_child_id: "alpha", beta.rlm_child_id: "beta"}
results = await rlm.collect(["alpha", "beta"], timeout_ms=60000)
assert [(result.session_name, result.answer_text) for result in results] == [("alpha", "alpha answered"), ("beta", "beta checked")]
assert await rlm.rename("beta", session_id=beta) == "beta"
assert await rlm.rename("gamma", session_id=beta) == "gamma"
renamed = await rlm.collect(["gamma"], timeout_ms=60000)
assert renamed[0].rlm_child_id == beta.rlm_child_id
print("RENAME ROUTING VERIFIED")
"#;
    let child_cell = r#"
try:
    await rlm.rename("alpha")
except Exception as error:
    assert "unavailable" in str(error), str(error)
else:
    raise AssertionError("self rename accepted a duplicate sibling name")
print("SELF RENAME REJECTED")
"#;
    let script = serde_json::json!({
        "responses": [
            { "content": [{ "type": "toolCall", "name": "ipython",
                "arguments": { "code": parent_cell } }] },
            "RENAMES CHECKED",
        ],
        "repeatLastResponse": true,
        "children": {
            "alpha": { "responses": ["alpha answered"] },
            "beta": { "responses": [
                { "content": [{ "type": "toolCall", "name": "ipython",
                    "arguments": { "code": child_cell } }] },
                "beta checked",
            ] },
        },
    });
    let (stdout, stderr, code) = lane.run(&["-p", "check rename routing"], &script, &kernel, &[]);
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    let entries = PrintLane::entries(&lane.parent_session_file());
    let tool_output: String = entries
        .iter()
        .filter(|entry| {
            entry
                .pointer("/message/role")
                .and_then(|role| role.as_str())
                == Some("toolResult")
        })
        .map(serde_json::Value::to_string)
        .collect();
    assert!(
        tool_output.contains("RENAME ROUTING VERIFIED"),
        "rename checks completed without a tool error: {tool_output}"
    );
}

#[test]
fn print_inline_delete_cancels_an_executing_child_and_removes_it() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let parent_cell = r#"
import asyncio
from pathlib import Path
ready = asyncio.get_running_loop().create_future()
async def accept_ready(reader, writer):
    try:
        assert await reader.readline() == b"ready\n"
        ready.set_result(None)
    finally:
        writer.close()
        await writer.wait_closed()
server = await asyncio.start_server(accept_ready, "127.0.0.1", 0)
try:
    Path("cancel-port").write_text(str(server.sockets[0].getsockname()[1]))
    child = await rlm.spawn("wait until cancelled", name="waiting")
    await asyncio.wait_for(ready, timeout=30)
    deleted = await rlm.delete_subagent(child)
    assert deleted.status == "cancelled", deleted
    assert await rlm.list_subagents() == []
    try:
        await rlm.collect([child], timeout_ms=0)
    except Exception as error:
        assert "No direct RLM child matches" in str(error), str(error)
    else:
        raise AssertionError("deleted child remained collectable")
    Path("cancel-verified").write_text("done")
finally:
    server.close()
    await server.wait_closed()
"#;
    let child_cell = r#"
import asyncio, os
from pathlib import Path
Path("cancel-child-pid").write_text(str(os.getpid()))
reader, writer = await asyncio.open_connection("127.0.0.1", int(Path("cancel-port").read_text()))
writer.write(b"ready\n")
await writer.drain()
writer.close()
await writer.wait_closed()
await asyncio.Event().wait()
Path("cancel-child-finished").write_text("unexpected")
"#;
    let script = serde_json::json!({
        "responses": [
            { "content": [{ "type": "toolCall", "name": "ipython",
                "arguments": { "code": parent_cell } }] },
            "CHILD CANCELLED",
        ],
        "repeatLastResponse": true,
        "children": {
            "waiting": { "responses": [
                { "content": [{ "type": "toolCall", "name": "ipython",
                    "arguments": { "code": child_cell } }] },
                "unexpected completion",
            ] },
        },
    });
    let (stdout, stderr, code) = lane.run(&["-p", "cancel the child"], &script, &kernel, &[]);
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert!(
        lane.home.path().join("cancel-verified").exists(),
        "deletion and routing checks completed; stderr: {stderr}\nstdout: {stdout}"
    );
    assert!(!lane.home.path().join("cancel-child-finished").exists());
    let child_pid = std::fs::read_to_string(lane.home.path().join("cancel-child-pid"))
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert!(
        !pa_core::platform::pid_exists(child_pid),
        "cancelled child's Python process {child_pid} outlived the print run"
    );
}

/// The injected `[bash-done]` row in one session file's entries (the
/// `async_bash_completion` custom row the completion handler steers).
fn bash_done_row(entries: &[serde_json::Value]) -> serde_json::Value {
    entries
        .iter()
        .find(|entry| {
            entry.get("type").and_then(|t| t.as_str()) == Some("custom_message")
                && entry.get("customType").and_then(|t| t.as_str()) == Some("async_bash_completion")
        })
        .cloned()
        .unwrap_or_else(|| panic!("the [bash-done] completion row: {entries:?}"))
}

/// The root print session wakes on a background `bash()` completion
/// (audit #3; TS registers `bash.completed` in every mode): turn 1
/// starts a detached command and ends, the run stays open (the
/// quiescence predicate counts live background bash), and the
/// completion row steers onto the agent and runs as the second turn.
#[test]
fn print_root_wakes_on_a_background_bash_completion() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let script = serde_json::json!({
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "h = bash(\"sleep 3; echo BG_DONE\")\nprint(\"STARTED\", h.pid)" } },
            ] },
            "WAITING",
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "print(\"WOKEN\", \"BG_DONE\" in h.output())" } },
            ] },
            "COMPLETED WOKEN",
        ],
        "repeatLastResponse": true,
    });
    let (stdout, stderr, code) = lane.run(
        &["-p", "run the long command in the background"],
        &script,
        &kernel,
        &[],
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(
        stdout.trim_end(),
        "COMPLETED WOKEN",
        "the completion row ran as the second turn, not the pre-completion \"WAITING\" answer"
    );

    // The injected row is durable in the session transcript.
    let entries = PrintLane::entries(&lane.parent_session_file());
    let row = bash_done_row(&entries);
    assert_eq!(
        row.pointer("/details/exitCode")
            .and_then(serde_json::Value::as_i64),
        Some(0),
        "the row carries the finished exit code: {row}"
    );
}

/// A spawned child's own background `bash()` holds the print run open
/// (TS `child.isSessionActive` includes the kernel's background work):
/// the child's completion row wakes its driver, the reply turn runs,
/// and the parent answers with the combined text before it exits.
#[test]
fn print_inline_child_wakes_on_a_background_bash_completion() {
    let lane = lane();
    let kernel = PrintLane::kernel_python();
    let script = serde_json::json!({
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython",
                  "arguments": { "code": "kid = await rlm.spawn(\"run the background task\", name=\"bgkid\")\nprint(\"KID\", kid.rlm_child_id)" } },
            ] },
            "WAITING",
            "COMBINED KID-BG-RESULT",
        ],
        "repeatLastResponse": true,
        "children": {
            "bgkid": { "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": "h = bash(\"sleep 3; echo KID_BG\")\nprint(\"KID STARTED\")" } },
                ] },
                "kid waiting",
                { "content": [
                    { "type": "toolCall", "name": "ipython",
                      "arguments": { "code": "await agent_message.send(\"KID-BG-RESULT\", receiver_role=\"parent\")\nprint(\"KID WOKEN\", \"KID_BG\" in h.output())" } },
                ] },
                "kid finished",
            ] },
        },
    });
    let (stdout, stderr, code) = lane.run(
        &["-p", "delegate the background work"],
        &script,
        &kernel,
        &[],
    );
    assert_eq!(code, 0, "stderr: {stderr}\nstdout: {stdout}");
    assert_eq!(
        stdout.trim_end(),
        "COMBINED KID-BG-RESULT",
        "the child's completion woke its driver and the reply drained before the exit"
    );

    // The reply the woken child sent is durable in the parent's
    // transcript (on a base tree the parent's "combined" turn runs over
    // the no-reply notice instead).
    let parent_file = lane.parent_session_file();
    let parent_text = serde_json::to_string(&PrintLane::entries(&parent_file)).unwrap();
    assert!(
        parent_text.contains("KID-BG-RESULT"),
        "the woken child's reply reached the parent: {parent_text}"
    );
    let parent_id = Path::new(&parent_file)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .expect("the parent session id")
        .to_string();
    let artifacts = lane.agent_dir.join("session-artifacts").join(&parent_id);
    let child_dirs: Vec<PathBuf> = std::fs::read_dir(&artifacts)
        .expect("the child's session dir exists")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("sub-"))
        })
        .collect();
    assert_eq!(child_dirs.len(), 1, "one child session dir: {child_dirs:?}");
    let kid_file: Vec<PathBuf> = std::fs::read_dir(&child_dirs[0])
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    let row = bash_done_row(&PrintLane::entries(&kid_file[0]));
    assert_eq!(
        row.pointer("/details/exitCode")
            .and_then(serde_json::Value::as_i64),
        Some(0),
        "the child's row carries the finished exit code: {row}"
    );
}

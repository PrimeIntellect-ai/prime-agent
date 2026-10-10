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
        let mut command = std::process::Command::new(bin);
        command
            .args(args)
            .env("HOME", self.home.path())
            .env("PRIME_AGENT_CODING_AGENT_DIR", &self.agent_dir)
            .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
            .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
            .env_remove("RLM_DEPTH")
            .env_remove("RLM_MAX_DEPTH")
            .env_remove("PRIME_AGENT_SESSION_DIR")
            .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
            .current_dir(self.home.path());
        for (key, value) in env_extra {
            command.env(key, value);
        }
        let output = command.output().expect("binary present");
        (
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
            output.status.code().unwrap_or(-1),
        )
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
    let parent_text = serde_json::to_string(&parent_entries(&parent_file)).unwrap();
    assert!(
        parent_text.contains("[child-exited: no-reply child:kid]"),
        "the parent read the no-reply notice: {parent_text}"
    );
}

fn parent_entries(parent_file: &Path) -> Vec<serde_json::Value> {
    PrintLane::entries(parent_file)
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
    let follow_up_cell = "collected = await rlm.collect([\"kid\"], timeout_ms=60000)\nawait agent_message.send(\"SECOND-RESULT\", receiver_role=\"child\", receiver_name=\"kid\")\nprint(\"SENT\")".to_string();
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
}

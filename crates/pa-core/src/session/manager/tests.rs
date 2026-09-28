//! The manager unit battery (moved with its concern): the persistence
//! bootstrap rule, the crash-repair resume, the ISO round-trip, and the
//! fork contract (copy, torn-tail, cycles, rejection rows).

use super::*;

#[test]
fn generated_entry_ids_are_unique_and_link_to_previous_entry() {
    let mut manager = SessionManager::in_memory(Path::new("/tmp"));
    let mut previous = None;
    for _ in 0..1_000 {
        let id = manager.append_custom_entry("test", None).unwrap();
        let entry = manager.get_all_entries().last().unwrap();
        assert_eq!(entry.id(), Some(id.as_str()));
        assert_eq!(entry.parent_id(), previous.as_deref());
        assert_eq!(id.len(), 8);
        assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        previous = Some(id);
    }
    assert_eq!(manager.by_id.len(), 1_000);
    assert_eq!(manager.get_leaf_id(), previous.as_deref());
}

/// The durable compaction line is the full TS `CompactionEntry` record:
/// `fromHook: false` is present (never a missing key), and the details
/// and usage ride along.
#[test]
fn append_compaction_serializes_the_full_ts_record() {
    let tmp = tempfile::tempdir().unwrap();
    let mut manager = SessionManager::in_memory(tmp.path());
    manager
        .append_compaction(pa_types::session::CompactionEntry {
            summary: "the overflow summary".to_string(),
            first_kept_entry_id: "e4".to_string(),
            tokens_before: 214,
            details: Some(serde_json::json!({
                "readFiles": [],
                "modifiedFiles": [],
            })),
            from_hook: Some(false),
            custom_instructions: None,
            usage: Some(pa_types::ai::Usage {
                input: 20,
                output: 10,
                cache_read: 80,
                cache_write: 0,
                total_tokens: 110,
                cost: pa_types::ai::UsageCost::default(),
            }),
            harness_digest: None,
            harness_state_fingerprint: None,
        })
        .unwrap();
    let line = serialize_entry(
        manager
            .get_entries()
            .iter()
            .rev()
            .find(|entry| matches!(entry, FileEntry::Compaction { .. }))
            .expect("compaction entry appended"),
    );
    assert!(line.contains("\"fromHook\":false"));
    assert!(line.contains("\"tokensBefore\":214"));
    assert!(line.contains("\"usage\":"));
}

#[test]
fn persist_appends_after_first_assistant() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions");
    let mut manager = SessionManager::persisted(tmp.path(), &dir);
    // Pre-model entries are not flushed until an assistant message exists.
    let first = manager.append_thinking_level_change("high");
    assert!(!manager.get_session_file().unwrap().exists());
    manager
        .append_message(AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![],
            api: "anthropic-messages".to_string(),
            provider: "anthropic".to_string(),
            model: "claude-x".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }))
        .unwrap();
    let file = manager.get_session_file().unwrap().to_path_buf();
    assert!(file.exists());
    // The assistant append rewrote the whole file, including the earlier entry.
    let content = std::fs::read_to_string(&file).unwrap();
    assert!(content.contains("thinking_level_change"));
    assert!(content.contains("claude-x"));
    assert_eq!(
        manager.get_leaf_id(),
        Some(manager.get_entries().last().and_then(|e| e.id()).unwrap())
    );
    let _ = first;
}

#[test]
fn open_repairs_and_resumes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions");
    std::fs::create_dir_all(&dir).unwrap();
    let mut manager = SessionManager::persisted(tmp.path(), &dir);
    let assistant = AgentMessage::Assistant(pa_types::ai::AssistantMessage {
        content: vec![],
        api: "openai-completions".to_string(),
        provider: "openai".to_string(),
        model: "gpt-x".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_types::ai::Usage::default(),
        stop_reason: pa_types::ai::StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
        rest: serde_json::Map::default(),
    });
    manager.append_message(assistant).unwrap();
    let file = manager.get_session_file().unwrap().to_path_buf();
    // Simulate crash damage: torn tail (no trailing newline).
    let content = std::fs::read_to_string(&file).unwrap();
    std::fs::write(&file, content.trim_end()).unwrap();
    let reopened = SessionManager::open(tmp.path(), &dir, &file);
    assert_eq!(reopened.get_entries().len(), 1); // assistant (header excluded)
    assert_eq!(reopened.get_session_id(), manager.get_session_id());
}

#[test]
fn flush_now_durability_without_assistant() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions");
    let mut manager = SessionManager::persisted(tmp.path(), &dir);
    manager.append_session_info("my session").unwrap();
    // session_info persists even without an assistant message.
    assert!(manager.get_session_file().unwrap().exists());
    assert_eq!(manager.get_session_name().as_deref(), Some("my session"));
}

#[test]
fn iso_format_round_trips() {
    let stamp = format_iso(1_704_067_200_012);
    assert_eq!(stamp, "2024-01-01T00:00:00.012Z");
    assert_eq!(super::super::timestamp_to_millis(&stamp), 1_704_067_200_012);
}

/// TS `forkFrom`: the fork copies the source branch into a fresh
/// session file under the target cwd, parented at the source; the
/// source's `git_state` rows drop out and their children re-link to
/// the nearest kept ancestor.
#[test]
fn fork_from_copies_the_branch_under_a_fresh_header() {
    let tmp = tempfile::tempdir().unwrap();
    let source_cwd = tmp.path().join("source-project");
    let source_dir = tmp.path().join("source-sessions");
    std::fs::create_dir_all(&source_cwd).unwrap();
    let mut source = SessionManager::persisted(&source_cwd, &source_dir);
    source
        .append_message(AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text("original question".to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        }))
        .unwrap();
    let user_id = source.get_leaf_id().unwrap().to_string();
    let assistant = AgentMessage::Assistant(pa_types::ai::AssistantMessage {
        content: vec![],
        api: "openai-completions".to_string(),
        provider: "openai".to_string(),
        model: "gpt-x".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_types::ai::Usage::default(),
        stop_reason: pa_types::ai::StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
        rest: serde_json::Map::default(),
    });
    source.append_message(assistant).unwrap();
    let assistant_id = source.get_leaf_id().unwrap().to_string();
    // A git_state row: dropped by the fork, its child re-linked.
    source
        .append_entry(FileEntry::GitState {
            payload: pa_types::session::GitStateEntry {
                git: GitContext::default(),
            },
            base: EntryBase {
                id: Some("gitstate1".to_string()),
                parent_id: Some(assistant_id.clone()),
                timestamp: Some(format_iso_now()),
                rest: serde_json::Map::default(),
            },
        })
        .unwrap();
    source
        .append_custom_entry("after-git-state", Some(serde_json::json!({ "keep": true })))
        .unwrap();
    let trailing_id = source.get_leaf_id().unwrap().to_string();
    let source_file = source.get_session_file().unwrap().to_path_buf();

    // Fork into a different project root.
    let target_cwd = tmp.path().join("target-project");
    let target_dir = tmp.path().join("target-sessions");
    let forked = SessionManager::fork_from(&source_file, &target_cwd, &target_dir)
        .expect("fork copies the file");
    let fork_file = forked.get_session_file().unwrap().to_path_buf();
    assert!(fork_file.exists(), "the fork file landed on disk");
    assert!(fork_file != source_file, "the fork is a new session file");
    assert!(
        fork_file.starts_with(&target_dir),
        "the fork file lives in the target session dir"
    );

    // Fresh header: new id, target cwd, source as parentSession, source
    // depth carried over.
    let header = forked.get_header().unwrap();
    assert_ne!(header.id, source.get_session_id());
    assert_eq!(header.cwd, target_cwd.display().to_string());
    assert_eq!(
        header.parent_session.as_deref(),
        Some(source_file.display().to_string().as_str())
    );
    assert_eq!(header.rlm_depth, source.get_header().unwrap().rlm_depth);

    // The branch copied: the user + assistant rows survive with the
    // same ids; the git_state row is gone; its child re-linked to the
    // git_state's parent (the assistant row).
    let entries = forked.get_all_entries();
    assert!(entries
        .iter()
        .any(|entry| entry.id() == Some(user_id.as_str())));
    assert!(entries
        .iter()
        .any(|entry| entry.id() == Some(assistant_id.as_str())));
    assert!(
        !entries
            .iter()
            .any(|entry| matches!(entry, FileEntry::GitState { .. })),
        "git_state rows drop out of the fork"
    );
    let trailing = entries
        .iter()
        .find(|entry| entry.id() == Some(trailing_id.as_str()))
        .expect("the git_state child copied");
    assert_eq!(trailing.parent_id(), Some(assistant_id.as_str()));

    // The fork continues from the copied branch and the copy is durable.
    let before = std::fs::read_to_string(&fork_file).unwrap();
    let trailing_line = before
        .lines()
        .find(|line| line.contains(&trailing_id))
        .expect("the copied rows are on disk");
    assert!(trailing_line.contains("\"keep\":true"));
    let mut forked = forked;
    forked
        .append_message(AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text("follow up".to_string()),
            timestamp: 1,
            rest: serde_json::Map::default(),
        }))
        .unwrap();
    let after = std::fs::read_to_string(&fork_file).unwrap();
    assert!(after.contains("follow up"), "appends extend the fork file");
    assert!(after.lines().count() > before.lines().count());
}

/// The fork is a read-only copy: a source with a torn tail (an
/// in-progress append by a live writer) is copied with the torn row
/// skipped, and the source file itself stays byte-identical — repairing
/// would rewrite (and truncate) the live source.
#[test]
fn fork_from_never_rewrites_the_source() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("torn.jsonl");
    let content = "{\"type\":\"session\",\"version\":3,\"id\":\"torn-head\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}\n{\"type\":\"custom\",\"customType\":\"kept\",\"data\":{},\"id\":\"keep1\",\"parentId\":null,\"timestamp\":\"2024-01-01T00:00:00.000Z\"}\n{\"type\":\"custo";
    std::fs::write(&file, content).unwrap();
    let target_dir = tmp.path().join("fork-sessions");
    let forked = SessionManager::fork_from(&file, tmp.path(), &target_dir)
        .expect("the torn tail is skipped, not fatal");
    // The source is untouched, torn tail and all.
    assert_eq!(std::fs::read_to_string(&file).unwrap(), content);
    let entries = forked.get_all_entries();
    assert!(
        entries.iter().any(|entry| entry.id() == Some("keep1")),
        "the complete rows copied"
    );
}

/// Malformed-but-parseable `git_state` parents can form a cycle (a's
/// dropped parent is b, b's is a): the fork's parent walk terminates at
/// the first repeated id instead of looping forever.
#[test]
fn fork_from_terminates_on_cyclic_git_state_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions");
    std::fs::create_dir_all(&dir).unwrap();
    // A hand-written source: a valid header, two git_state rows that
    // parent at each other, and a surviving custom row under one of them.
    let file = dir.join("cyclic.jsonl");
    let header = "{\"type\":\"session\",\"version\":3,\"id\":\"cyc-head\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}";
    let git_a = "{\"type\":\"git_state\",\"git\":{},\"id\":\"cyc01\",\"parentId\":\"cyc02\",\"timestamp\":\"2024-01-01T00:00:00.000Z\"}";
    let git_b = "{\"type\":\"git_state\",\"git\":{},\"id\":\"cyc02\",\"parentId\":\"cyc01\",\"timestamp\":\"2024-01-01T00:00:00.000Z\"}";
    let custom = "{\"type\":\"custom\",\"customType\":\"survivor\",\"data\":{},\"id\":\"cyc03\",\"parentId\":\"cyc01\",\"timestamp\":\"2024-01-01T00:00:00.000Z\"}";
    std::fs::write(&file, format!("{header}\n{git_a}\n{git_b}\n{custom}\n")).unwrap();

    let target_dir = tmp.path().join("fork-sessions");
    let forked = SessionManager::fork_from(&file, tmp.path(), &target_dir)
        .expect("the cycle terminates and the fork completes");
    let entries = forked.get_all_entries();
    assert!(
        !entries
            .iter()
            .any(|entry| matches!(entry, FileEntry::GitState { .. })),
        "the git_state rows dropped"
    );
    let survivor = entries
        .iter()
        .find(|entry| entry.id() == Some("cyc03"))
        .expect("the surviving custom row copied");
    // The walk stopped at the first repeated id (cyc01), so the survivor
    // keeps its (dropped) parent instead of spinning on the cycle.
    assert_eq!(survivor.parent_id(), Some("cyc01"));
}

/// TS `forkFrom`'s failure contract: the loader (TS
/// `loadEntriesFromFile` -> `finalizeLoadedEntries`) returns no entries
/// for a missing file, an empty file, AND a file without a valid leading
/// header, so all three shapes take the "empty or invalid" arm (the
/// no-header error stays as TS-faithful defense-in-depth — its own
/// `forkFrom` finds the header only after the same finalize).
#[test]
fn fork_from_rejects_empty_and_headerless_sources() {
    let tmp = tempfile::tempdir().unwrap();
    let empty = tmp.path().join("empty.jsonl");
    std::fs::write(&empty, "").unwrap();
    let error = SessionManager::fork_from(&empty, tmp.path(), &tmp.path().join("sessions"))
        .err()
        .expect("fork rejects an empty source");
    assert_eq!(
        error,
        format!(
            "Cannot fork: source session file is empty or invalid: {}",
            empty.display()
        )
    );
    let headerless = tmp.path().join("headerless.jsonl");
    std::fs::write(
        &headerless,
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[],\"timestamp\":0},\"id\":\"aaaa1\",\"parentId\":null}\n",
    )
    .unwrap();
    let error = SessionManager::fork_from(&headerless, tmp.path(), &tmp.path().join("sessions"))
        .err()
        .expect("fork rejects a headerless source");
    assert_eq!(
        error,
        format!(
            "Cannot fork: source session file is empty or invalid: {}",
            headerless.display()
        ),
        "the loader finalizes a headerless file to zero entries"
    );
    let missing = tmp.path().join("absent.jsonl");
    let error = SessionManager::fork_from(&missing, tmp.path(), &tmp.path().join("sessions"))
        .err()
        .expect("fork rejects a missing source");
    assert!(error.starts_with("Cannot fork: source session file is empty or invalid:"));
}

#[test]
fn fork_from_rejects_a_non_regular_source() {
    let tmp = tempfile::tempdir().unwrap();
    let dir_source = tmp.path().join("not-a-session");
    std::fs::create_dir_all(&dir_source).unwrap();
    let error = SessionManager::fork_from(&dir_source, tmp.path(), &tmp.path().join("sessions"))
        .err()
        .expect("fork rejects a non-regular source");
    assert_eq!(
        error,
        format!(
            "Cannot fork: source session file is not a regular file: {}",
            dir_source.display()
        )
    );
}

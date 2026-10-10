use super::*;
use pa_types::ai::{AssistantMessage, StopReason};

fn fixture() -> (tempfile::TempDir, SessionManager, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut manager = SessionManager::persisted(dir.path(), &dir.path().join("sessions"));
    let target = manager
        .append_message(AgentMessage::Assistant(AssistantMessage {
            content: vec![],
            api: "anthropic-messages".to_owned(),
            provider: "anthropic".to_owned(),
            model: "test".to_owned(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                input: 1000,
                total_tokens: 4096,
                ..Usage::default()
            },
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }))
        .unwrap();
    (dir, manager, target)
}

fn child() -> Usage {
    Usage {
        input: 10,
        ..Usage::default()
    }
}
fn user() -> AgentMessage {
    serde_json::from_value(serde_json::json!({"role":"user", "content":"later", "timestamp":1}))
        .unwrap()
}
fn rows(manager: &SessionManager) -> Vec<serde_json::Value> {
    std::fs::read_to_string(manager.get_session_file().unwrap())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn usage(manager: &SessionManager, id: &str) -> Usage {
    match manager.get_entry_by_id(id).unwrap() {
        FileEntry::Message {
            message: AgentMessage::Assistant(message),
            ..
        } => message.usage,
        _ => panic!("assistant expected"),
    }
}

#[test]
fn backend_complete_write_sync_error_then_retained_message_reopens_once() {
    let (_dir, mut manager, target) = fixture();
    manager.child_usage_write_fault = Some(WriteFault::Sync);
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    assert_eq!(
        rows(&manager).len(),
        3,
        "complete physical write preceded the sync error"
    );
    let (later, error) = manager.append_message_retained(user());
    assert!(error.is_none());
    assert!(matches!(
        manager
            .append_child_usage_once("stable", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert!(matches!(
        manager
            .append_child_usage_once("stable", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Existing(_)
    ));
    let reopened = SessionManager::open(
        manager.get_cwd(),
        manager.get_session_dir(),
        manager.get_session_file().unwrap(),
    );
    assert_eq!(
        reopened.get_entry_by_id(&later).unwrap().parent_id(),
        Some("stable")
    );
    assert_eq!(
        usage(&reopened, &target),
        Usage {
            input: 1010,
            total_tokens: 4096,
            ..Usage::default()
        }
    );
    assert_eq!(
        rows(&manager)
            .iter()
            .filter(|row| row["id"] == "stable")
            .count(),
        1
    );
}

#[test]
fn partial_backend_write_is_healed_before_a_fallible_message() {
    let (_dir, mut manager, target) = fixture();
    manager.child_usage_write_fault = Some(WriteFault::Partial(23));
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let later = manager.append_message(user()).unwrap();
    assert_eq!(
        manager.get_entry_by_id(&later).unwrap().parent_id(),
        Some("stable")
    );
    assert_eq!(rows(&manager).len(), 4);
    assert!(matches!(
        manager
            .append_child_usage_once("stable", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
}

#[test]
fn unreadable_recovery_retains_messages_and_refuses_lifecycle_changes() {
    let (dir, mut manager, target) = fixture();
    manager.child_usage_write_fault = Some(WriteFault::Sync);
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let original = manager.get_session_file().unwrap().to_owned();
    let saved = dir.path().join("saved");
    std::fs::rename(&original, &saved).unwrap();
    std::fs::create_dir(&original).unwrap();
    let (retained, error) = manager.append_message_retained(user());
    assert!(error.is_some());
    let leaf = manager.get_leaf_id().map(str::to_owned);
    assert!(manager.append_message(user()).is_err());
    assert!(manager.flush_now().is_err());
    assert!(manager
        .new_session(&super::super::NewSessionOptions::default())
        .is_err());
    assert!(manager
        .set_session_file(dir.path().join("other"), None)
        .is_err());
    assert!(manager.adopt_entries(vec![]).is_err());
    assert_eq!(manager.get_session_file(), Some(original.as_path()));
    assert_eq!(manager.get_leaf_id(), leaf.as_deref());
    assert_eq!(manager.pending_child_usage.as_ref().unwrap().len(), 2);
    std::fs::remove_dir(&original).unwrap();
    std::fs::rename(saved, &original).unwrap();
    manager.set_leaf_id(Some(&target));
    manager
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert_eq!(manager.get_leaf_id(), Some(target.as_str()));
    let reopened = SessionManager::open(manager.get_cwd(), manager.get_session_dir(), &original);
    assert_eq!(
        reopened.get_entry_by_id(&retained).unwrap().parent_id(),
        Some("stable")
    );
    assert_eq!(rows(&manager).len(), 4);
}

#[test]
fn stale_preloaded_history_cannot_replace_recovered_intents() {
    let (_dir, mut manager, target) = fixture();
    let stale = manager.file_entries.clone();
    let path = manager.get_session_file().unwrap().to_owned();
    manager.child_usage_write_fault = Some(WriteFault::Sync);
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    assert_eq!(
        manager
            .set_session_file(path.clone(), Some(stale.clone()))
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(manager.get_session_file(), Some(path.as_path()));
    assert_eq!(manager.get_leaf_id(), Some("stable"));
    assert!(manager.get_entry_by_id("stable").is_some());
    assert_eq!(
        manager
            .set_session_file(path.clone(), Some(stale))
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    let original = std::fs::read(&path).unwrap();
    let live = serde_json::to_value(&manager.file_entries).unwrap();
    let complete_rows = rows(&manager);
    for changed_row in [false, true] {
        let mut altered = complete_rows.clone();
        if changed_row {
            let row = altered
                .iter_mut()
                .find(|row| row["id"] == "stable")
                .unwrap();
            row["childUsage"]["input"] = serde_json::json!(99);
        } else {
            altered.retain(|row| row["id"] != "stable");
        }
        let bytes = altered
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>();
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            manager
                .set_session_file(path.clone(), None)
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(manager.get_session_file(), Some(path.as_path()));
        assert_eq!(manager.get_leaf_id(), Some("stable"));
        assert_eq!(serde_json::to_value(&manager.file_entries).unwrap(), live);
        assert_eq!(std::fs::read(&path).unwrap(), bytes.as_bytes());
    }
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        manager
            .set_session_file(path.clone(), None)
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
    assert_eq!(manager.get_session_file(), Some(path.as_path()));
    assert_eq!(serde_json::to_value(&manager.file_entries).unwrap(), live);
    assert!(!path.exists());
    std::fs::write(&path, original).unwrap();
    manager.set_session_file(path, None).unwrap();
    assert!(manager.get_entry_by_id("stable").is_some());
    // A verified owned reload clears the guard before deliberate branch selection.
    let selected = manager.get_entry_by_id(&target).unwrap().clone();
    manager.adopt_entries(vec![selected]).unwrap();
    assert_eq!(manager.get_leaf_id(), Some(target.as_str()));
    assert_eq!(usage(&manager, &target).input, 1010);
    assert_eq!(
        rows(&manager)
            .iter()
            .filter(|row| row["id"] == "stable")
            .count(),
        1
    );
}

#[test]
fn strict_recovery_preserves_unknown_complete_eof_and_only_heals_incomplete_suffix() {
    let (_dir, mut manager, target) = fixture();
    manager.child_usage_write_fault = Some(WriteFault::Sync);
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let path = manager.get_session_file().unwrap().to_owned();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.extend_from_slice(br#"{"type":"future","id":"unknown","parentId":"stable","timestamp":"later","extra":{"kept":true}}"#);
    std::fs::write(&path, &bytes).unwrap();
    manager
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert!(manager.get_entry_by_id("unknown").is_some());
    manager.rewrite_file();
    assert!(rows(&manager)
        .iter()
        .any(|row| row["extra"] == serde_json::json!({"kept":true})));
    let clean = std::fs::read(&path).unwrap();
    for suffix in [b"{\n".as_slice(), b"{invalid}\n".as_slice()] {
        let mut corrupt = clean.clone();
        corrupt.extend_from_slice(suffix);
        assert!(strict_rows(&corrupt).is_err());
    }
    let mut truncated = clean.clone();
    truncated.extend_from_slice(b"{\"type\":\"future\",\"text\":\"\xf0\x9f");
    assert_eq!(strict_rows(&truncated).unwrap().1, Some(clean.len() as u64));
}

#[test]
fn header_or_identity_changes_fail_closed_without_touching_bytes() {
    let (_dir, mut manager, target) = fixture();
    manager.child_usage_write_fault = Some(WriteFault::Sync);
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let path = manager.get_session_file().unwrap().to_owned();
    let original = std::fs::read(&path).unwrap();
    let mut repeated_header = rows(&manager);
    repeated_header.push(repeated_header[0].clone());
    let repeated_bytes = repeated_header
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    std::fs::write(&path, &repeated_bytes).unwrap();
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), repeated_bytes.as_bytes());
    std::fs::write(&path, &original).unwrap();
    let mut values = rows(&manager);
    values[0]["id"] = serde_json::json!("different-session");
    let changed = values
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n")
        + "\n";
    std::fs::write(&path, changed.as_bytes()).unwrap();
    assert!(manager
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), changed.as_bytes());
    std::fs::write(&path, original).unwrap();
    manager
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert!(manager
        .append_child_usage_once("stable", &target, Usage::default(), None)
        .is_err());
}

#[test]
fn retry_returns_current_authoritative_aggregate_after_another_child() {
    let (_dir, mut manager, target) = fixture();
    manager
        .append_child_usage_once("a", &target, child(), None)
        .unwrap();
    manager
        .append_child_usage_once("b", &target, child(), None)
        .unwrap();
    match manager
        .append_child_usage_once("a", &target, child(), None)
        .unwrap()
    {
        ChildUsageAppendResult::Existing(aggregate) => assert_eq!(
            aggregate,
            Usage {
                input: 1020,
                total_tokens: 4096,
                ..Usage::default()
            }
        ),
        ChildUsageAppendResult::Created(_) => panic!("retry must not create a row"),
    }
    assert_eq!(rows(&manager).len(), 4);
}

#[test]
fn listeners_only_observe_confirmed_attribution_writes() {
    let (_dir, mut manager, target) = fixture();
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = count.clone();
    manager.on_persist(Box::new(move |_| {
        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    manager.child_usage_write_fault = Some(WriteFault::Sync);
    assert!(manager
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
    manager
        .append_child_usage_once("a", &target, child(), None)
        .unwrap();
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
    manager
        .append_child_usage_once("a", &target, child(), None)
        .unwrap();
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
    manager
        .append_child_usage_once("b", &target, child(), None)
        .unwrap();
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[test]
fn window_recovery_preserves_context_and_rejects_pre_recovery_snapshot() {
    let (_dir, mut manager, _target) = fixture();
    let path = manager.get_session_file().unwrap().to_owned();
    let mut values = rows(&manager);
    let assistant = values[1].clone();
    let mut parent = values[1]["id"].as_str().unwrap().to_owned();
    for index in 0..220 {
        let id = format!("u{index}");
        values.push(
            serde_json::json!({"type":"message", "id":id, "parentId":parent,
            "message":{"role":"user", "content":format!("message {index}"), "timestamp":index}}),
        );
        parent = id;
    }
    values.push(
        serde_json::json!({"type":"compaction", "id":"compact", "parentId":parent,
        "summary":"kept", "firstKeptEntryId":"u210", "tokensBefore":999}),
    );
    let mut current = assistant;
    current["id"] = serde_json::json!("current-target");
    current["parentId"] = serde_json::json!("compact");
    values.push(current);
    let content = values
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n")
        + "\n";
    std::fs::write(&path, content).unwrap();
    manager.set_session_file(path.clone(), None).unwrap();
    let window = crate::session::window::WindowedSessionStore::open(&path)
        .unwrap()
        .unwrap();
    manager.adopt_window(window).unwrap();
    assert!(manager.window.is_some());
    let stale = crate::session::window::WindowedSessionStore::open(&path)
        .unwrap()
        .unwrap();
    manager.child_usage_write_fault = Some(WriteFault::Sync);
    assert!(manager
        .append_child_usage_once("stable", "current-target", child(), None)
        .is_err());
    assert_eq!(
        manager.adopt_window(stale).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(manager.get_leaf_id(), Some("stable"));
    assert!(manager.window.is_none());
    let reopened = SessionManager::open(manager.get_cwd(), manager.get_session_dir(), &path);
    assert_eq!(
        serde_json::to_value(manager.active_context().messages).unwrap(),
        serde_json::to_value(reopened.active_context().messages).unwrap()
    );
    assert_eq!(
        usage(&manager, "current-target"),
        usage(&reopened, "current-target")
    );
    manager
        .append_child_usage_once("stable", "current-target", child(), None)
        .unwrap();
    assert_eq!(
        rows(&manager)
            .iter()
            .filter(|row| row["id"] == "stable")
            .count(),
        1
    );
}

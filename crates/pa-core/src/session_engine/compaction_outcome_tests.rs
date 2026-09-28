use super::*;
use crate::session_engine::messages::{
    convert_to_llm, create_compaction_outcome_message, CompactionOutcomeKind,
    CompactionOutcomeReason,
};
use pa_agent::agent::{AgentInitialState, AgentOptions};
use pa_agent::scripted::ScriptedProvider;
use pa_types::ai::AssistantMessage;

fn test_model() -> pa_agent::types::Model {
    serde_json::from_value(serde_json::json!({
        "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 1000, "maxTokens": 100
    }))
    .unwrap()
}

async fn scripted_session_over(session: SessionManager) -> AgentSession {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    let options = AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    };
    let agent = Agent::new(options);
    AgentSession::new(Arc::new(agent), session, vec![])
        .await
        .unwrap()
}

fn seeded_assistant() -> SessionAgentMessage {
    SessionAgentMessage::Assistant(AssistantMessage {
        content: vec![],
        api: "openai-completions".to_string(),
        provider: "test".to_string(),
        model: "m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_types::ai::Usage::default(),
        stop_reason: pa_types::ai::StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
        rest: serde_json::Map::default(),
    })
}

/// The disclosure row's shape (TS `createCompactionOutcomeMessage`):
/// customType `compaction_outcome`, the outcome message as text content,
/// displayed, `{reason, outcome}` details.
#[test]
fn outcome_row_shape_matches_ts() {
    let row = create_compaction_outcome_message(
        "Auto-compaction skipped: Session is too short to compact — try again once it grows",
        CompactionOutcomeReason::Threshold,
        CompactionOutcomeKind::Skipped,
    );
    assert_eq!(row.custom_type, "compaction_outcome");
    assert_eq!(
        row.content.text(),
        "Auto-compaction skipped: Session is too short to compact — try again once it grows"
    );
    assert!(row.display);
    assert_eq!(
        row.details,
        Some(serde_json::json!({ "reason": "threshold", "outcome": "skipped" }))
    );
    assert!(row.timestamp > 0);
    let wire = serde_json::to_value(SessionAgentMessage::Custom(row)).unwrap();
    assert_eq!(wire["role"], "custom");
    assert_eq!(wire["customType"], "compaction_outcome");
}

/// The seam (TS `_persistCompactionOutcome`): the row lands in the
/// session entry chain and on the live loop context, a context rebuild
/// over the entries keeps it, and the LLM conversion drops it — the
/// model never sees the disclosure, so the KV-cacheable prefix is
/// unaffected (TS `agent-session-compaction.test.ts` pins the same
/// exclusion).
#[tokio::test]
async fn record_appends_row_to_entries_and_live_context_but_not_llm_input() {
    let tmp = tempfile::tempdir().unwrap();
    let session = scripted_session_over(SessionManager::in_memory(tmp.path())).await;
    let row = session
        .record_compaction_outcome(
            CompactionOutcomeReason::Requested,
            CompactionOutcomeKind::Failed,
            "Requested compaction failed: Summarization failed",
        )
        .await
        .unwrap();
    // The entry chain owns the row (context rebuilds read it).
    let entries = session.entries().await;
    let outcome_entries: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == "compaction_outcome" =>
            {
                Some(payload.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(outcome_entries.len(), 1, "one durable outcome row");
    assert_eq!(
        outcome_entries[0].content.text(),
        "Requested compaction failed: Summarization failed"
    );
    assert_eq!(
        outcome_entries[0].details,
        Some(serde_json::json!({ "reason": "requested", "outcome": "failed" }))
    );
    assert!(outcome_entries[0].display);
    // The live loop context owns the disclosure (TS
    // `agent.state.messages.push`).
    let state = session.agent().state().await;
    assert!(
        matches!(
            state.messages.last(),
            Some(AgentMessage::Custom(custom)) if custom.role == "custom"
        ),
        "the live context carries the outcome row"
    );
    // A rebuild over the session entries keeps the disclosure (the TS
    // `_unpersistedOutcomes` invariant: a rebuild cannot drop it).
    let guard = session.session.lock().await;
    let context =
        crate::session::build_session_context(guard.get_all_entries(), guard.get_leaf_id());
    drop(guard);
    assert!(
        context
            .messages
            .iter()
            .any(|message| matches!(message, SessionAgentMessage::Custom(custom) if custom.custom_type == "compaction_outcome")),
        "the rebuilt context keeps the outcome row"
    );
    // Model context exclusion: the LLM conversion drops the row.
    assert!(convert_to_llm(std::slice::from_ref(&SessionAgentMessage::Custom(row))).is_empty());
}

/// The disclosure survives a failed disk write (the TS
/// `_unpersistedOutcomes` fallback's guarantee): the entry chain keeps
/// the row in memory, so a context rebuild never drops it even when the
/// session file could not be written.
#[tokio::test]
async fn record_survives_a_failed_disk_write() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = tmp.path().join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let mut manager = SessionManager::persisted(tmp.path(), &sessions);
    manager.append_message(seeded_assistant()).unwrap();
    let file = manager.get_session_file().unwrap().to_path_buf();
    assert!(file.exists(), "the session file materialized");
    // Replace the session file with a directory at the same path: every
    // disk write path fails (the append line and the atomic rename),
    // even for root (permission bits would not stop root).
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    let session = scripted_session_over(manager).await;
    session
        .record_compaction_outcome(
            CompactionOutcomeReason::Threshold,
            CompactionOutcomeKind::Skipped,
            "Auto-compaction skipped: Already compacted",
        )
        .await
        .unwrap();
    // The write failed (the file path is a directory) — but the entry
    // chain and a context rebuild keep the disclosure.
    let entries = session.entries().await;
    assert!(
        entries.iter().any(
            |entry| matches!(entry, FileEntry::CustomMessage { payload, .. }
            if payload.custom_type == "compaction_outcome")
        ),
        "the outcome row stays in the entry chain after the failed write"
    );
    let guard = session.session.lock().await;
    let context =
        crate::session::build_session_context(guard.get_all_entries(), guard.get_leaf_id());
    drop(guard);
    assert!(
        context
            .messages
            .iter()
            .any(|message| matches!(message, SessionAgentMessage::Custom(custom) if custom.custom_type == "compaction_outcome")),
        "a rebuild cannot drop the disclosure"
    );
}

/// The subscriber arm (TS `_processAgentEvent` on `_agentEventQueue`
/// whose `.catch(() => {})` swallows persistence failures) never fails
/// the run for a write error: the loop already owns the row in live
/// state, so the session retains it and the error only logs — no error
/// assistant row lands in either store.
#[tokio::test]
async fn message_end_persist_failure_retains_the_row_and_swallows() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = tmp.path().join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let mut manager = SessionManager::persisted(tmp.path(), &sessions);
    manager.append_message(seeded_assistant()).unwrap();
    let file = manager.get_session_file().unwrap().to_path_buf();
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    let session = scripted_session_over(manager).await;
    let before = session
        .session
        .lock()
        .await
        .get_all_entries()
        .to_vec()
        .len();
    persist_event(
        &session.session,
        AgentEvent::MessageEnd {
            message: AgentMessage::user("retained after the failed write"),
        },
    )
    .await
    .expect("a failed disk write must not fail the event queue");
    let guard = session.session.lock().await;
    let entries = guard.get_all_entries().to_vec();
    drop(guard);
    assert_eq!(entries.len(), before + 1, "the row stays live-indexed");
    assert!(
        !entries
            .iter()
            .any(|entry| matches!(entry, FileEntry::Message {
                message: SessionAgentMessage::Assistant(assistant),
                ..
            } if assistant.error_message.is_some())),
        "no phantom error row for a persistence failure"
    );
    let context = crate::session::build_session_context(
        &entries,
        entries
            .last()
            .and_then(|entry| entry.id().map(str::to_owned))
            .as_deref(),
    );
    assert!(
        serde_json::to_string(&context.messages)
            .unwrap()
            .contains("retained after the failed write"),
        "a context rebuild keeps the retained row"
    );
}

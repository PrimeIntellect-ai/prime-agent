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

// ---- refine: the live-context push (TS `_appendDurableRefineMessage`) ----

fn session_ai_model() -> pa_types::ai::Model {
    serde_json::from_value(serde_json::json!({
        "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 100_000, "maxTokens": 8000
    }))
    .unwrap()
}

fn refine_assistant_row(error: bool) -> SessionAgentMessage {
    SessionAgentMessage::Assistant(pa_types::ai::AssistantMessage {
        content: vec![pa_types::ai::AssistantContentBlock::Text(
            pa_types::ai::TextContent {
                text: if error {
                    "provider failed".to_string()
                } else {
                    "did the thing".to_string()
                },
                text_signature: None,
                rest: serde_json::Map::default(),
            },
        )],
        api: "openai-completions".to_string(),
        provider: "test".to_string(),
        model: "m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_types::ai::Usage::default(),
        stop_reason: if error {
            pa_types::ai::StopReason::Error
        } else {
            pa_types::ai::StopReason::Stop
        },
        stop_reason_raw: None,
        error_message: if error {
            Some("provider failed".to_string())
        } else {
            None
        },
        timestamp: 0,
        rest: serde_json::Map::default(),
    })
}

fn refine_plan_call(plan: &'static str) -> crate::refinement::executor::RefinerFn {
    Box::new(move |_model, _system, _prompt| {
        Box::pin(async move {
            Ok(pa_types::ai::AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: plan.to_string(),
                        text_signature: None,
                        rest: serde_json::Map::default(),
                    },
                )],
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
        })
    })
}

const APPLIED_PLAN: &str = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
const EMPTY_PLAN: &str = r#"{"summary":"bench","edits":[]}"#;

/// A persisted session over two seeded rows, with the live loop context
/// built the way the resume path builds it (one rebuild:
/// `restore_windowed_context`'s construction).
async fn refine_test_session() -> (AgentSession, tempfile::TempDir) {
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
    let tmp = tempfile::tempdir().unwrap();
    let session_dir = tmp.path().join("session");
    std::fs::create_dir_all(&session_dir).unwrap();
    let mut manager = SessionManager::in_memory(tmp.path());
    manager.materialize_session_file(Some(session_dir));
    manager
        .append_message(SessionAgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text("do a thing twice".to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        }))
        .unwrap();
    manager.append_message(refine_assistant_row(false)).unwrap();
    let session = AgentSession::new(Arc::new(agent), manager, vec![])
        .await
        .unwrap();
    let live = {
        let persistence = session.shared_persistence();
        let manager = persistence.lock().await;
        rebuilt_loop_messages(
            crate::session_engine::compact_session::rebuilt_context_after_compaction(&manager),
        )
    };
    session.agent().set_messages(live).await;
    (session, tmp)
}

/// The pre-change mechanism, verbatim: the full active-context rebuild
/// plus the shared-shape conversion (the oracle's reference).
async fn full_rebuild_reference(session: &AgentSession) -> Vec<AgentMessage> {
    let persistence = session.shared_persistence();
    let manager = persistence.lock().await;
    rebuilt_loop_messages(
        crate::session_engine::compact_session::rebuilt_context_after_compaction(&manager),
    )
}

fn is_error_assistant(message: &AgentMessage) -> bool {
    matches!(
        message,
        AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant))
            if assistant.stop_reason == pa_agent::types::StopReason::Error
    )
}

fn custom_types(messages: &[AgentMessage]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|message| match message {
            AgentMessage::Custom(custom) => custom
                .payload
                .get("customType")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            AgentMessage::Standard(_) => None,
        })
        .collect()
}

#[tokio::test]
async fn refine_pushed_live_context_matches_a_full_rebuild_byte_for_byte() {
    let (session, tmp) = refine_test_session().await;
    let global_dir = tmp.path().join("harness");
    let result = session
        .refine_with_refiner(
            &refine::RefineOptions::default(),
            refine::RefinementSource::User,
            &session_ai_model(),
            refine_plan_call(APPLIED_PLAN),
            global_dir,
        )
        .await
        .unwrap();
    assert!(result.applied_edits.iter().any(|edit| edit.applied));
    // Candidate: the pushed live loop context.
    let candidate = session.agent().state().await.messages;
    // Reference: the pre-change full-rebuild mechanism, run verbatim.
    let reference = full_rebuild_reference(&session).await;
    assert_eq!(
        serde_json::to_value(&candidate).unwrap(),
        serde_json::to_value(&reference).unwrap(),
        "the pushed live context is byte-identical to the full rebuild"
    );
    // The pushed rows land exactly once, in durable order (outcome,
    // then notice); the audit entry never enters the context.
    assert_eq!(candidate.len(), 4);
    assert_eq!(
        custom_types(&candidate[candidate.len() - 2..]),
        vec!["refinement_outcome", "refinement_notice"]
    );
    assert!(custom_types(&candidate)
        .iter()
        .all(|custom_type| custom_type != "prime-agent.refinement"));
}

#[tokio::test]
async fn refine_with_an_empty_plan_pushes_only_the_outcome_row() {
    let (session, tmp) = refine_test_session().await;
    let global_dir = tmp.path().join("harness");
    let result = session
        .refine_with_refiner(
            &refine::RefineOptions::default(),
            refine::RefinementSource::User,
            &session_ai_model(),
            refine_plan_call(EMPTY_PLAN),
            global_dir,
        )
        .await
        .unwrap();
    assert!(result.applied_edits.iter().all(|edit| !edit.applied));
    let candidate = session.agent().state().await.messages;
    let reference = full_rebuild_reference(&session).await;
    assert_eq!(
        serde_json::to_value(&candidate).unwrap(),
        serde_json::to_value(&reference).unwrap(),
        "the pushed live context is byte-identical to the full rebuild"
    );
    assert_eq!(candidate.len(), 3, "only the outcome row is pushed");
    assert_eq!(
        custom_types(&candidate[candidate.len() - 1..]),
        vec!["refinement_outcome"],
        "no notice row without an applied edit"
    );
}

#[tokio::test]
async fn sequential_refines_push_exactly_their_own_rows() {
    // Two runs back-to-back: the second must select exactly its own
    // rows (by id), never the first run's — the pushed live context
    // stays byte-identical to a full rebuild, which holds exactly one
    // copy of each appended row.
    let (session, tmp) = refine_test_session().await;
    let global_dir = tmp.path().join("harness");
    let first = r#"{"summary":"one","edits":[{"action":"create","kind":"memory","id":"m1","title":"A","content":"a"}]}"#;
    let second = r#"{"summary":"two","edits":[{"action":"create","kind":"memory","id":"m2","title":"B","content":"b"}]}"#;
    session
        .refine_with_refiner(
            &refine::RefineOptions::default(),
            refine::RefinementSource::User,
            &session_ai_model(),
            refine_plan_call(first),
            global_dir.clone(),
        )
        .await
        .unwrap();
    session
        .refine_with_refiner(
            &refine::RefineOptions::default(),
            refine::RefinementSource::User,
            &session_ai_model(),
            refine_plan_call(second),
            global_dir,
        )
        .await
        .unwrap();
    let candidate = session.agent().state().await.messages;
    let reference = full_rebuild_reference(&session).await;
    assert_eq!(
        serde_json::to_value(&candidate).unwrap(),
        serde_json::to_value(&reference).unwrap(),
        "two sequential refines hold exactly one copy of each appended row"
    );
    // Base rows + two outcomes + two notices, in durable order.
    assert_eq!(candidate.len(), 6);
    assert_eq!(
        custom_types(&candidate[candidate.len() - 4..]),
        vec![
            "refinement_outcome",
            "refinement_notice",
            "refinement_outcome",
            "refinement_notice"
        ]
    );
}

/// A plan whose one edit creates a factory entry (a stored state-machine
/// workflow spec): valid shape, so only the opt-in gate decides it.
const FACTORY_PLAN: &str = r#"{"summary":"sweep","edits":[{"action":"create","kind":"factory","id":"sweep","title":"Factory","content":"Sweep review.","arguments":{"machine":{"states":[{"id":"collect","entry":true,"subagent":"worker"}],"transitions":[]}}}]}"#;

#[tokio::test]
async fn refine_factory_edits_follow_the_agent_dir_opt_in_setting() {
    // The host /refine flow reads `factory.enabled` live from the session's
    // agent dir on every run — the same settings.json the kernel-side
    // factory gate reads — so a refinement cannot author factories the
    // user has not opted into. Without a wired agent dir (or with the
    // setting off), the factory create refuses with the one exact
    // disabled message; opted in, the same proposal applies.
    let (mut session, tmp) = refine_test_session().await;
    let global_dir = tmp.path().join("harness");
    let refused = session
        .refine_with_refiner(
            &refine::RefineOptions::default(),
            refine::RefinementSource::User,
            &session_ai_model(),
            refine_plan_call(FACTORY_PLAN),
            global_dir.clone(),
        )
        .await
        .unwrap();
    assert!(!refused.applied_edits[0].applied);
    assert_eq!(
        refused.applied_edits[0].error.as_deref(),
        Some(crate::refinement::FACTORY_DISABLED_MESSAGE)
    );
    // The user opts in: the next run of the same proposal applies.
    let agent_dir = tmp.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        r#"{"factory": {"enabled": true}}"#,
    )
    .unwrap();
    session.set_agent_dir(agent_dir);
    let applied = session
        .refine_with_refiner(
            &refine::RefineOptions::default(),
            refine::RefinementSource::User,
            &session_ai_model(),
            refine_plan_call(FACTORY_PLAN),
            global_dir,
        )
        .await
        .unwrap();
    assert!(applied.applied_edits[0].applied);
    assert!(applied.applied_edits[0].error.is_none());
}

#[tokio::test]
async fn refine_keeps_the_retry_drop_instead_of_resurrecting_the_error_row() {
    let (session, tmp) = refine_test_session().await;
    // The retry arm's sanctioned live/durable divergence: the failed
    // turn's error assistant row is durable, then dropped from the live
    // context (`drop_trailing_assistant`, TS's retry `slice(0, -1)`).
    {
        let persistence = session.shared_persistence();
        let mut manager = persistence.lock().await;
        manager.append_message(refine_assistant_row(true)).unwrap();
    }
    let rebuilt = {
        let persistence = session.shared_persistence();
        let manager = persistence.lock().await;
        crate::session_engine::compact_session::rebuilt_context_after_compaction(&manager)
    };
    session
        .agent()
        .set_messages(rebuilt_loop_messages(rebuilt))
        .await;
    session
        .drop_trailing_assistant(TrailingAssistantFilter::ErrorOnly)
        .await;
    let pre_live = session.agent().state().await.messages;
    assert_eq!(
        pre_live.len(),
        2,
        "the error row is dropped from the live context"
    );
    let global_dir = tmp.path().join("harness");
    session
        .refine_with_refiner(
            &refine::RefineOptions::default(),
            refine::RefinementSource::User,
            &session_ai_model(),
            refine_plan_call(APPLIED_PLAN),
            global_dir,
        )
        .await
        .unwrap();
    // The served-path gate: the push preserves the live list (the
    // pre-change rebuild would have replaced it). TS `_applyRefine`
    // pushes onto `agent.state.messages`; the dropped error row stays
    // out of the live context exactly like TS.
    let live = session.agent().state().await.messages;
    assert_eq!(live.len(), 4);
    assert!(
        !live.iter().any(is_error_assistant),
        "the retry-dropped error row is not resurrected"
    );
    assert_eq!(
        custom_types(&live[live.len() - 2..]),
        vec!["refinement_outcome", "refinement_notice"]
    );
    // The deliberate, TS-anchored divergence: the full rebuild WOULD
    // resurrect the row (the pre-change mechanism's behavior).
    let reference = full_rebuild_reference(&session).await;
    assert_eq!(reference.len(), 5);
    assert!(
        reference.iter().any(is_error_assistant),
        "the reference rebuild resurrects the dropped row; the push does not"
    );
}

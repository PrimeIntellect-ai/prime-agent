//! Compact-session tests, the skip-and-abort guard family: the
//! pre-aborted and in-flight aborts, the too-short skip, and the
//! already-compacted skip.
use super::*;

/// An already-aborted signal cancels the run before any summarizer
/// request: the abort marker error surfaces and nothing commits.
#[tokio::test]
async fn execute_compaction_with_pre_aborted_signal_never_runs_the_summarizer() {
    let registration = faux_registration();
    let model = registration.get_model();
    let controller = pa_agent::abort::AbortController::new();
    controller.abort();
    let signal = controller.signal();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let error = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: Some(&signal),
            harness_digest: None,
            auxiliary: None,
            semantic_edges: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap_err();
    assert!(pa_agent::abort::is_abort_error(&error), "{error:#}");
    assert!(session
        .get_entries()
        .iter()
        .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
    registration.unregister();
}

/// A signal that aborts while the summarizer is in flight cancels the run
/// before it commits: the resolved summary never lands as an entry.
#[tokio::test]
async fn execute_compaction_with_late_abort_cancels_before_the_commit() {
    let registration = faux_registration();
    let model = registration.get_model();
    // The delayed response holds the summarizer in flight while the
    // abort lands mid-run.
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Delayed {
        message: pa_ai::faux::faux_assistant_text_message(
            "## Goal\nsummarized goal",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
        delay_ms: 200,
    }]);
    let controller = pa_agent::abort::AbortController::new();
    let signal = controller.signal();
    let aborter = {
        let controller = controller.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            controller.abort();
        })
    };
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let error = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: Some(&signal),
            harness_digest: None,
            auxiliary: None,
            semantic_edges: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap_err();
    aborter.await.unwrap();
    assert!(pa_agent::abort::is_abort_error(&error), "{error:#}");
    assert!(
        session
            .get_entries()
            .iter()
            .all(|entry| !matches!(entry, FileEntry::Compaction { .. })),
        "the late abort never commits the compaction"
    );
    registration.unregister();
}

/// The summary a late abort discards was still a billed call: it lands as
/// a `model_usage` row on the session, billed on the summarizer's model.
#[tokio::test]
async fn a_late_abort_records_the_discarded_summary_call() {
    let registration = faux_registration();
    let model = registration.get_model();
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Delayed {
        message: pa_ai::faux::faux_assistant_text_message(
            "## Goal\nsummarized goal",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
        delay_ms: 200,
    }]);
    let controller = pa_agent::abort::AbortController::new();
    let signal = controller.signal();
    let aborter = {
        let controller = controller.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            controller.abort();
        })
    };
    let tmp = tempfile::tempdir().unwrap();
    let session = crate::session_engine::AgentSession::new(
        std::sync::Arc::new(pa_agent::agent::Agent::new(
            pa_agent::agent::AgentOptions::default(),
        )),
        session_with_turns(tmp.path(), 3),
        vec![],
    )
    .await
    .unwrap();
    session.set_compaction_settings(super::super::compaction::CompactionSettings {
        keep_recent_tokens: 20,
        ..Default::default()
    });
    let error = session
        .compact(None, &model, None, Some(&signal))
        .await
        .unwrap_err();
    aborter.await.unwrap();
    assert!(pa_agent::abort::is_abort_error(&error), "{error:#}");
    let billed = session
        .shared_persistence()
        .lock()
        .await
        .get_entries()
        .into_iter()
        .filter_map(|entry| match entry {
            FileEntry::Custom { payload, .. } if payload.custom_type == "model_usage" => {
                payload.data
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let [row] = billed.as_slice() else {
        panic!("one billed row: {billed:?}");
    };
    assert_eq!(row["modelId"], model.id.as_str());
    assert!(
        row["usage"]["totalTokens"].as_u64().unwrap_or(0) > 0,
        "{row}"
    );
    registration.unregister();
}

#[tokio::test]
async fn execute_compaction_skips_short_sessions() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings::default(),
            abort: None,
            harness_digest: None,
            auxiliary: None,
            semantic_edges: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        outcome,
        CompactOutcome::Skipped("Session is too short to compact — try again once it grows")
    );
    assert!(session
        .get_entries()
        .iter()
        .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
    registration.unregister();
}

#[tokio::test]
async fn execute_compaction_skips_when_already_compacted() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    session
        .append_compaction(pa_types::session::CompactionEntry {
            summary: "summary".to_string(),
            first_kept_entry_id: "e1".to_string(),
            tokens_before: 100,
            ..Default::default()
        })
        .unwrap();
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 200,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            semantic_edges: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(outcome, CompactOutcome::Skipped("Already compacted"));
    registration.unregister();
}

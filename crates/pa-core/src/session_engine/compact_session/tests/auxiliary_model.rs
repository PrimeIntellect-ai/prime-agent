//! Compact-session tests, the auxiliary-model routing family
//! (moved with their concerns): the equal-selector and
//! unusable-selector arms, over an aux context that pins one
//! `auxiliaryModel` selector.
use super::*;

/// An aux context whose settings pin one `auxiliaryModel` selector.
fn aux_context(
    dir: &std::path::Path,
    selector: Option<&str>,
) -> crate::session_engine::auxiliary_model::AuxiliaryModelContext {
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "auxiliaryModel": selector,
        }))
        .unwrap(),
    )
    .unwrap();
    crate::session_engine::auxiliary_model::AuxiliaryModelContext {
        cwd: dir.to_path_buf(),
        agent_dir: dir.to_path_buf(),
    }
}

/// The routing context present with a selector equal to the session
/// model keeps the session model: the compaction's wire call serves
/// on the session model (the faux factory records the model).
#[tokio::test]
async fn compaction_auxiliary_selector_equal_to_the_session_model_runs_on_the_session_model() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let aux = aux_context(tmp.path(), Some("faux/compact-m"));
    let mut session = session_with_turns(tmp.path(), 3);
    let seen_models: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let recorder = seen_models.clone();
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
        std::sync::Arc::new(
            move |_context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  model: &pa_types::ai::Model| {
                recorder.lock().unwrap().push(model.id.clone());
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "the summary",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ),
    )]);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: Some(&aux),
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(outcome, CompactOutcome::Ran(_)));
    assert_eq!(seen_models.lock().unwrap().as_slice(), ["compact-m"]);
    registration.unregister();
}

/// A selector that resolves to no model (unusable) falls back to the
/// session model with a warning: the compaction still runs.
#[tokio::test]
async fn compaction_auxiliary_selector_unusable_falls_back_to_the_session_model() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let aux = aux_context(tmp.path(), Some("testaux/missing-model"));
    let mut session = session_with_turns(tmp.path(), 3);
    let seen_models: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let recorder = seen_models.clone();
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
        std::sync::Arc::new(
            move |_context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  model: &pa_types::ai::Model| {
                recorder.lock().unwrap().push(model.id.clone());
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "the summary",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ),
    )]);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: Some(&aux),
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run on the fallback model");
    };
    assert_eq!(run.result.summary, "the summary");
    assert_eq!(seen_models.lock().unwrap().as_slice(), ["compact-m"]);
    registration.unregister();
}

//! Compact-session tests (moved with their concerns).
use super::*;
use pa_types::ai::{AssistantMessage, UserContent};

fn session_with_turns(cwd: &std::path::Path, turns: usize) -> SessionManager {
    let mut session = SessionManager::in_memory(cwd);
    for i in 0..turns {
        session
            .append_message(AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(format!("turn {i} message with some words")),
                timestamp: 0,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
        session
            .append_message(AgentMessage::Assistant(AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: format!("reply {i}"),
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
                usage: pa_types::ai::Usage {
                    input: 100,
                    output: 20,
                    cache_read: 0,
                    cache_write: 0,
                    total_tokens: 120,
                    cost: pa_types::ai::UsageCost::default(),
                },
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
    }
    session
}

/// The faux provider with one scripted summarizer response. The faux
/// seam is process-global, so every registration unregisters on drop.
fn faux_registration() -> pa_ai::faux::FauxProviderRegistration {
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "compact-m".to_string(),
                name: Some("Compact Model".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(1_000),
                max_tokens: Some(256),
            }]),
            ..Default::default()
        });
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
        pa_ai::faux::faux_assistant_text_message(
            "## Goal\nsummarized goal",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
    )]);
    registration
}

// The family children: the test mass splits by test family (the same
// tests, the same assertions, zero behavior changes). Each child holds
// its family's moved blocks byte-identically (in the original file's
// first-appearance order), `use super::*` re-anchors the two shared
// fixtures above, and the session_engine module bindings in the facade
// keep the children's `super::super::` path literals resolving
// unchanged.
mod auxiliary_model;
mod cut_math;
mod execute_compaction;
mod prepare_compaction;
mod second_compaction;
mod skip_guards;
mod split_turn;

//! Image-turn delegation (Kevin's product ruling for `settings.imageModel`):
//! a session whose model cannot see images keeps serving the turn itself —
//! the TEXT — while one supervisor-backed child running the resolved image
//! model reads the images and returns their description. This module is
//! the dispatch seam: it builds the child's task from the delivered
//! payload, owns the [`crate::rlm_children`] delegation call, and lands
//! the child's answer as one durable, rendered context row the parent's
//! provider request carries ahead of the (image-stripped) turn.
//!
//! The separation of the two representations is the contract:
//! - The durable transcript keeps the accepted user row exactly as
//!   admitted — text plus image blocks (the worker persists the accepted
//!   row before the turn; nothing here rewrites it).
//! - The provider request carries NO image blocks (the text-only session
//!   model never sees them, so the pa-ai non-vision placeholder
//!   downgrade never surfaces): the description row plus the text-only
//!   turn is the whole vision context.
//!
//! Failures are loud: a failed child fails the turn with the error —
//! never a placeholder, never a fallback swap onto the image model.
use super::{json, AgentSessionEngine, EngineEvent, TurnPrompt};
use crate::engine::PromptBatchRow;

/// The durable context row carrying one delegation's description (the
/// daemon persists it as a `custom_message` entry and the loop admits it
/// ahead of the turn's prompt, so the parent's provider request sees it).
pub(crate) const IMAGE_DELEGATION_CUSTOM_TYPE: &str = "image_delegation";

/// The one-line stand-in an image-block custom row's LLM-admitted copy
/// takes once its images were delegated (the durable row keeps its text;
/// the description row preceding it carries the actual vision).
pub(crate) const IMAGE_DELEGATION_ROW_MARKER: &str =
    "[image attachments were delegated to an image-model child]";

/// The delegation's task prompt for the image-model child: the parent's
/// original text plus the instruction to describe the attached images (the
/// child never answers the user's task — the parent model owns the turn).
pub(crate) fn delegation_child_prompt(user_text: &str) -> String {
    format!(
        "You are the image delegate for a parent agent session whose model cannot see images. \
The parent session is handling this user turn:\n\n<user_message>\n{user_text}\n</user_message>\n\n \
Describe every attached image in complete, concrete detail (contents, any text in the image, \
layout, colors, numbers) so the text-only parent model can act on it. Do not answer or solve \
the user's task yourself; describe only what the images show."
    )
}

/// The plain text of a turn prompt (the child task's user message quote).
pub(crate) fn turn_prompt_text(turn_prompt: &TurnPrompt) -> String {
    match turn_prompt {
        TurnPrompt::User { text, .. } => text.clone(),
        TurnPrompt::Injected(message) => match &message.content {
            pa_types::ai::UserContent::Text(text) => text.clone(),
            pa_types::ai::UserContent::Blocks(_) => String::new(),
        },
    }
}

/// The delivered images of one turn: the primary prompt's plus every
/// batched row's (they ride one run), or the injected custom row's image
/// blocks.
pub(crate) fn delivered_images(turn_prompt: &TurnPrompt) -> Vec<pa_agent::types::ImageContent> {
    match turn_prompt {
        TurnPrompt::User { images, batch, .. } => {
            let mut all = images.clone();
            for row in batch {
                all.extend(row.images.iter().cloned());
            }
            all
        }
        TurnPrompt::Injected(message) => match &message.content {
            pa_types::ai::UserContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    pa_types::ai::UserContentBlock::Image(image) => {
                        Some(pa_agent::types::ImageContent {
                            data: image.data.clone(),
                            mime_type: image.mime_type.clone(),
                        })
                    }
                    _ => None,
                })
                .collect(),
            pa_types::ai::UserContent::Text(_) => Vec::new(),
        },
    }
}

/// The injected custom row's LLM-admitted copy: the durable row keeps its
/// image blocks (the accepted emit already persisted it), while the loop
/// admits this image-stripped twin so the provider request never carries
/// them. A row left with no content keeps the one-line marker instead of
/// an empty block list.
pub(crate) fn stripped_custom_row(
    custom: &pa_types::session::CustomMessage,
) -> pa_types::session::CustomMessage {
    let pa_types::ai::UserContent::Blocks(blocks) = &custom.content else {
        return custom.clone();
    };
    let kept: Vec<pa_types::ai::UserContentBlock> = blocks
        .iter()
        .filter(|block| !matches!(block, pa_types::ai::UserContentBlock::Image(_)))
        .cloned()
        .collect();
    let content = if kept.is_empty() {
        vec![pa_types::ai::UserContentBlock::Text(
            pa_types::ai::TextContent {
                text: IMAGE_DELEGATION_ROW_MARKER.to_string(),
                text_signature: None,
                rest: serde_json::Map::default(),
            },
        )]
    } else {
        kept
    };
    pa_types::session::CustomMessage {
        content: pa_types::ai::UserContent::Blocks(content),
        ..custom.clone()
    }
}

/// How one image-delegated turn proceeds after the dispatch seam.
pub(crate) enum ImageDelegationRun {
    /// The child answered: the parent's turn runs on this prompt (the
    /// description row is already queued and emitted).
    Delegated(Box<TurnPrompt>),
    /// No delegation applies (no supervisor-backed children, or the
    /// batch does not route): the caller keeps the admitted turn.
    NotDelegated,
    /// The turn ended inside the seam (a loud delegation failure, or the
    /// emitter cancelled): nothing follows.
    Ended,
}

impl AgentSessionEngine {
    /// The image-turn delegation dispatch (the daemon-backed image-model
    /// route): one child on the resolved image model reads the turn's
    /// images, and the parent's turn runs text-only with the child's
    /// description row queued ahead of it. The caller resolves the route
    /// (the resolver/refusal seam is [`Self::resolve_image_turn_route`]);
    /// this seam never runs for a batch the route does not serve.
    pub(crate) fn run_image_delegation(
        &self,
        resolved: &pa_core::models::ResolvedImageModel,
        turn_prompt: &TurnPrompt,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> ImageDelegationRun {
        let Some(children) = self.children.as_ref() else {
            return ImageDelegationRun::NotDelegated;
        };
        let delegation_request = crate::rlm_children::ImageDelegationRequest {
            prompt: delegation_child_prompt(&turn_prompt_text(turn_prompt)),
            model: format!("{}/{}", resolved.model.provider, resolved.model.id),
            // The resolver already clamped the session's thinking level to
            // the image model's vocabulary; the child carries the clamped
            // level, never the parent's unclamped one.
            thinking: Some(resolved.thinking_level.wire_name().to_string()),
            images: delivered_images(turn_prompt),
        };
        let outcome = self
            .runtime
            .block_on(children.delegate_image_turn(delegation_request, &|| aborted()));
        self.note_image_delegation(matches!(
            outcome,
            crate::rlm_children::ImageDelegationOutcome::Answered { .. }
        ));
        match outcome {
            crate::rlm_children::ImageDelegationOutcome::Answered {
                child_id,
                session_name,
                answer,
            } => {
                // The description row: ONE representation, durable and
                // rendered (the daemon persists the emitted custom row) and
                // model context (queued ahead of the turn's prompt, so the
                // parent's provider request carries it as a user text row).
                let row = pa_types::session::CustomMessage {
                    custom_type: IMAGE_DELEGATION_CUSTOM_TYPE.to_string(),
                    content: pa_types::ai::UserContent::Text(answer),
                    display: true,
                    details: Some(json!({
                        "childId": child_id,
                        "sessionName": session_name,
                    })),
                    timestamp: crate::util::now_ms(),
                    rest: serde_json::Map::default(),
                };
                if !emit(EngineEvent::CustomMessage(
                    crate::session_commands::custom_message_value(&row),
                )) {
                    return ImageDelegationRun::Ended;
                }
                if let Err(error) = self.queue_image_delegation_row(&row) {
                    emit(EngineEvent::Done(Err(format!(
                        "land the image delegation's description: {error:#}"
                    ))));
                    return ImageDelegationRun::Ended;
                }
                // The parent's turn runs text-only: the image blocks never
                // reach the text-only session model's request (the durable
                // accepted row keeps them).
                ImageDelegationRun::Delegated(Box::new(match turn_prompt {
                    TurnPrompt::Injected(message) => {
                        TurnPrompt::Injected(stripped_custom_row(message))
                    }
                    TurnPrompt::User { text, batch, .. } => TurnPrompt::User {
                        text: text.clone(),
                        images: Vec::new(),
                        batch: batch
                            .iter()
                            .map(|row| PromptBatchRow {
                                text: row.text.clone(),
                                images: Vec::new(),
                            })
                            .collect(),
                    },
                }))
            }
            crate::rlm_children::ImageDelegationOutcome::Failed { error } => {
                // Loud failure, image preserved: the accepted row already
                // persisted with its images, and nothing answers for it.
                if aborted() {
                    emit(EngineEvent::DoneAborted);
                } else {
                    emit(EngineEvent::Done(Err(format!(
                        "image delegation failed: {error}"
                    ))));
                }
                ImageDelegationRun::Ended
            }
        }
    }

    /// Queue the description row onto the session's next-turn rows so the
    /// parent's provider request carries it ahead of the delegated prompt.
    ///
    /// Sync-context discipline (the caller is the worker's prompt thread,
    /// never a runtime async context): `ensure_core_session` and the
    /// sequential `blocking_lock` below are the same pattern the turn
    /// runner's `session_agent` uses, with no lock held across the build.
    fn queue_image_delegation_row(
        &self,
        row: &pa_types::session::CustomMessage,
    ) -> anyhow::Result<()> {
        let model = self.resolve_model()?;
        self.ensure_core_session(&model)?;
        let session = self.session.blocking_lock();
        let engine = session.as_ref().expect("session built");
        engine.session.queue_next_turn_row(row.clone());
        Ok(())
    }

    /// The delegation outcome's adoption telemetry (`image delegation`,
    /// the telemetry worker's locked catalog event): the delegating
    /// PARENT session's id and the outcome only — never child ids, model
    /// ids, or prompt/answer content. Best-effort: no durable session id
    /// (an unsaved headless session), no event.
    fn note_image_delegation(&self, answered: bool) {
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(session_id) = session_file
            .as_ref()
            .and_then(|path| path.file_stem())
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
        else {
            return;
        };
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        if !pa_core::session_engine::telemetry::telemetry_switch(&settings).enabled() {
            return;
        }
        let client =
            pa_core::session_engine::telemetry::build_client(&settings, &self.config.agent_dir);
        pa_core::session_engine::telemetry::track_image_delegation(
            &client,
            session_id,
            if answered { "answered" } else { "failed" },
        );
    }
}

#[cfg(test)]
#[path = "image_delegation_tests.rs"]
mod tests;

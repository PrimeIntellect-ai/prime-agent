use super::slash_commands::parse_session_command;
use super::{
    session_message_to_loop, user_prompt_message, AgentSession, PromptOptions, PromptOutcome,
    SessionAgentMessage, SessionSlashCommand, StreamingBehavior,
};

impl AgentSession {
    /// Submit a prompt. Session commands (compact/refine/goal/autonomous)
    /// are recognized before admission and never reach the model.
    ///
    /// # Errors
    ///
    /// Returns the underlying prompt admission error (see
    /// [`AgentSession::prompt_with_images`]).
    pub async fn prompt(
        &self,
        text: &str,
        options: PromptOptions,
    ) -> anyhow::Result<PromptOutcome> {
        self.prompt_with_images(text, Vec::new(), options).await
    }

    /// Admit an injected custom message as the turn's prompt (TS
    /// `_promptInjectedMessage` -> `_createPreparedTurnAction(..., {
    /// message })` -> `agent.prompt([customMessage])`): the loop context
    /// and the transcript hold ONE representation of the turn — the
    /// custom row itself, appended by the loop's `message_end` — while
    /// the provider request carries its user-role view (the loop-boundary
    /// `convert_to_llm` conversion, TS `convertToLlm`). The injected
    /// content is never template-expanded or command-parsed (TS injected
    /// turns skip `_normalizeSubmission`).
    ///
    /// # Errors
    ///
    /// Returns an error when the session is already busy, when the pending
    /// digest row cannot be captured, or when the agent rejects the
    /// injected prompt.
    pub async fn prompt_injected_message(
        &self,
        message: &pa_types::session::CustomMessage,
    ) -> anyhow::Result<PromptOutcome> {
        let state = self.agent.state().await;
        let busy = state.is_streaming;
        if busy {
            anyhow::bail!(
                "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
            );
        }
        let mut prompt_messages = Vec::new();
        if let Some(digest_row) = self.pending_digest_prompt_row().await? {
            prompt_messages.push(digest_row);
        }
        prompt_messages.extend(self.take_next_turn_rows().await);
        let custom_row = session_message_to_loop(&SessionAgentMessage::Custom(message.clone()))
            .ok_or_else(|| anyhow::anyhow!("injected custom message conversion failed"))?;
        // The dispatch-time routing decision fires for every dispatched
        // turn (TS `_startPreparedTurnActions` runs it per prepared turn
        // action): an injected row never carries images, so it clears a
        // route left behind by the previous dispatched turn.
        self.apply_image_model_routing(&[], &[]).await?;
        prompt_messages.push(custom_row);
        self.agent
            .prompt(pa_agent::agent::AgentPromptInput::Messages(prompt_messages))
            .await?;
        Ok(PromptOutcome::Prompt)
    }

    /// Classify a prompt as a session command without admitting it: the
    /// same expansion-plus-grammar parse `prompt` applies. Host turn loops
    /// use this to keep their pre-turn compaction arms off the
    /// session-command path (TS session commands never reach
    /// `_prepareForCommit`, so `_runPreTurnCompaction` never fires for
    /// them).
    pub fn classify_session_command(&self, text: &str) -> Option<SessionSlashCommand> {
        let normalized = crate::skills::expand_prompt_template(text, &self.prompt_templates);
        parse_session_command(&self.slash_commands, &normalized)
    }

    /// Prompt with images attached (the ACP prompt-capability path). Busy
    /// sessions queue the text and images together as one follow-up batch,
    /// so an admitted prompt never loses its images to a queue race.
    ///
    /// # Errors
    ///
    /// Returns an error when the prompt fails validation, the session is
    /// busy under its admission rule, or the agent rejects the turn (with
    /// [`PromptOptions::return_after_accepted`], a rejection after the run
    /// registers rides the events instead of this result).
    pub async fn prompt_with_images(
        &self,
        text: &str,
        images: Vec<pa_agent::types::ImageContent>,
        options: PromptOptions,
    ) -> anyhow::Result<PromptOutcome> {
        let expand = options.expand_prompt_templates.unwrap_or(true);
        // TS `_finishSubmissionNormalization` order: skill commands expand
        // first (`/skill:<name>` into its `<skill>` block), prompt templates
        // second; both are gated by the same policy flag.
        let (normalized, used_skill) = if expand {
            let (skill_expanded, used_skill) =
                crate::skills::expand_skill_command(text, &self.skills);
            let normalized =
                crate::skills::expand_prompt_template(&skill_expanded, &self.prompt_templates);
            (normalized, used_skill)
        } else {
            (text.to_string(), None)
        };

        if let Some(command) = parse_session_command(&self.slash_commands, &normalized) {
            return Ok(PromptOutcome::SessionCommand(command));
        }

        let state = self.agent.state().await;
        let busy = state.is_streaming;
        // The `skill used` adoption event reports from the admission seam:
        // an admitted user turn whose text IS a skill block reports once,
        // with how the invocation arrived (a fresh admission, or a queued
        // steering/follow-up submission). A pre-expanded block (the daemon
        // emits the accepted row before admission) reports here too — the
        // block parse carries the skill identity.
        if let Some(skill) = used_skill.or_else(|| {
            pa_types::skill_blocks::parse_skill_block(&normalized)
                .and_then(|block| self.skills.iter().find(|skill| skill.name == block.name))
        }) {
            if let Some(telemetry) = &self.skill_telemetry {
                let source = if busy {
                    match options.streaming_behavior {
                        Some(StreamingBehavior::Steer) => "steer",
                        // The busy-without-behavior case errors below; the
                        // queued label is the honest fallback.
                        Some(StreamingBehavior::FollowUp) | None => "follow_up",
                    }
                } else {
                    "prompt"
                };
                telemetry.note_skill_used(&skill.name, skill.kind_label(), source);
            }
        }
        if busy && options.streaming_behavior.is_none() {
            anyhow::bail!(
                "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
            );
        }
        // User messages persist through the loop's `message_end` event (the
        // persistence subscription in `from_session_arc`), matching the TS
        // reference: `_processAgentEvent` is the only appendMessage path for
        // user prompts. Appending here as well would double-persist.

        if busy {
            let message = user_prompt_message(&normalized, &images);
            match options.streaming_behavior {
                Some(StreamingBehavior::Steer) => self.agent.steer(message),
                Some(StreamingBehavior::FollowUp) => self.agent.follow_up(message),
                None => unreachable!("busy without a streaming behavior errors above"),
            }
        } else {
            // The dispatch-time image-model routing decision (TS
            // `_imageModelOverrideForTurns` at commit): an image-attaching
            // batch routes to the host's configured image model or fails
            // with the actionable refusal, never silently downgrading the
            // images to placeholders.
            self.apply_image_model_routing(&images, &options.batch)
                .await?;
            // The turn's prompt messages (TS preparedMessages): the deferred
            // first-turn harness digest rides first when one is due, so the
            // loop streams its message pair ahead of the user prompt and
            // carries it on `agent_end` (TS commit-time injection).
            let mut prompt_messages = Vec::new();
            if let Some(digest_row) = self.pending_digest_prompt_row().await? {
                prompt_messages.push(digest_row);
            }
            prompt_messages.extend(self.take_next_turn_rows().await);
            prompt_messages.push(user_prompt_message(&normalized, &images));
            // The batched co-delivery rows (TS `_startPreparedTurnActions`'s
            // `turns.flatMap(records)`): each batched action contributes its
            // user row after the primary, through the same admission
            // normalization (TS normalizes each submission at queue time;
            // this engine normalizes every row at the shared admission).
            for row in &options.batch {
                let row_text = if expand {
                    let (skill_expanded, _) =
                        crate::skills::expand_skill_command(&row.text, &self.skills);
                    crate::skills::expand_prompt_template(&skill_expanded, &self.prompt_templates)
                } else {
                    row.text.clone()
                };
                prompt_messages.push(user_prompt_message(&row_text, &row.images));
            }
            if options.return_after_accepted {
                // TS `returnAfterAccepted: true` — the connection's prompt
                // returns once the admitted turn delivers. The failure
                // path unwinds the route exactly like the plain prompt
                // branch below: this prompt never started, so its route
                // must not survive (while no winner streams).
                if let Err(error) = self
                    .agent
                    .prompt_until_accepted(pa_agent::agent::AgentPromptInput::Messages(
                        prompt_messages,
                    ))
                    .await
                {
                    if !self.agent.state().await.is_streaming {
                        if let Some(router) = self.image_model_router.as_ref() {
                            (router.swap_target)(None);
                            self.agent.set_model_override(None);
                        }
                    }
                    return Err(error);
                }
            } else if let Err(error) = self
                .agent
                .prompt(pa_agent::agent::AgentPromptInput::Messages(prompt_messages))
                .await
            {
                // A concurrent admission won the agent's run slot: this
                // prompt never started, so its route must not survive. The
                // unwind only happens while NO run streams - the winner's
                // live run keeps its own serving target (an idle slot means
                // our route never served a request; a streaming one belongs
                // to the winner). TS decides per prepared action inside the
                // same commit fence, so its single-threaded commit cannot
                // observe this race at all; the headless surfaces serialize
                // prompt admissions (one ACP prompt turn per session, the
                // print loop's sequential awaits) besides.
                if !self.agent.state().await.is_streaming {
                    if let Some(router) = self.image_model_router.as_ref() {
                        (router.swap_target)(None);
                        self.agent.set_model_override(None);
                    }
                }
                return Err(error);
            }
        }
        Ok(PromptOutcome::Prompt)
    }

    /// Queue one custom row for the next admitted turn (TS
    /// `_pendingNextTurnMessages.push`): the row rides the turn's prompt
    /// messages ahead of the prompt's own user row.
    pub fn queue_next_turn_row(&self, message: pa_types::session::CustomMessage) {
        self.pending_next_turn_rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(message);
    }

    /// Adopt a shared next-turn mailbox (the engine's restore-notice
    /// seam): rows a kernel boot already parked before the session existed
    /// merge in, and later pushes land in the same queue the next admitted
    /// turn drains. The kernel provisioner outlives the construction order
    /// (its restore fires from a background boot), so the notice needs a
    /// mailbox shared across the build boundary rather than a callback
    /// bound to a session that does not exist yet.
    pub fn adopt_next_turn_rows(
        &mut self,
        shared: std::sync::Arc<std::sync::Mutex<Vec<pa_types::session::CustomMessage>>>,
    ) {
        let own_rows: Vec<_> = {
            let mut own = self
                .pending_next_turn_rows
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            own.drain(..).collect()
        };
        {
            let mut next = shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // The shared mailbox is authoritative: rows parked pre-build
            // (a restore that finished during construction) come first,
            // then anything this session queued before adoption.
            next.extend(own_rows);
        }
        self.pending_next_turn_rows = shared;
    }

    /// Drain the queued next-turn rows (TS `_takePendingNextTurnMessages`):
    /// the admitting turn owns them; an empty take leaves nothing for later
    /// turns.
    pub fn take_next_turn_rows(
        &self,
    ) -> impl std::future::Future<Output = Vec<pa_agent::types::AgentMessage>> {
        std::future::ready(
            self.pending_next_turn_rows
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .drain(..)
                .filter_map(|row| session_message_to_loop(&SessionAgentMessage::Custom(row)))
                .collect(),
        )
    }
}

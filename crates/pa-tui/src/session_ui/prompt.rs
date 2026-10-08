//! The prompt submit pipeline: the ordered submit channel (`PromptOrder` -> the worker ->
//! `PromptSubmitNote`'s fold-back), the prompt stash's capture and restore, the side-question
//! turns, and the pasted-image registry.

use super::{
    anyhow, collect_marked_images, evict_images_to_budget, format_image_marker, image_marker_ids,
    mpsc, AgentView, DaemonClient, DaemonCommand, DockFold, Duration, LoadedImage, Map,
    PromptStash, RebuildKind, Result, SessionUi, SlashCommandRegistry, StatusKind, Value,
    UI_REQUEST_TIMEOUT_MS,
};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubmitBehavior {
    Steer,
    /// The follow-up key (`alt+enter`): parks on the follow-up lane and
    /// delivers when the run goes idle.
    FollowUp,
}

/// One backgrounded prompt round trip's settled outcome: `Ok(())` is an
/// admitted/queued prompt; the error is the daemon failure.
pub(crate) struct PromptSubmitNote {
    /// The submit-time active id: the outcome applies only while the client
    /// still holds that session.
    pub(crate) active_session_id: String,
    /// The submit-time durable session id: a stale failure retains its rejected draft into that
    /// session's stash, never the newly mounted session's.
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) behavior: SubmitBehavior,
    pub(crate) images: Option<serde_json::Value>,
    /// The submit-time image snapshot behind the text's markers: keeps the attachments rehydratable
    /// after the editor cleared and the registry could evict them.
    pub(crate) stashed_images: Vec<(u64, LoadedImage)>,
    /// The stash head this submit captured (TS `promptStashToRestore`): its
    /// admitted outcome restores it if it is still the head.
    pub(crate) stash_to_restore: Option<PromptStash>,
    /// Whether the turn was already active at submit time (the
    /// queued-input telemetry's lane gate; the inline path read the same
    /// flag after its await, which nothing could move while the loop was
    /// blocked).
    pub(crate) turn_was_active: bool,
    /// The expected end of this admitted prompt in submit order.
    pub(crate) expected_turn_end: u64,
    /// A newer submit supersedes an older one's draft-restore right.
    pub(crate) generation: u64,
    /// The submission's `input_id` (`agent input stage`).
    pub(crate) input_id: String,
    /// When the submit was accepted (the stage durations measure from
    /// here).
    pub(crate) submitted_at: std::time::Instant,
    /// Whether a failure may still rebind once; the replayed request is the
    /// second and last attempt.
    pub(crate) rebind_available: bool,
    pub(crate) result: Result<(), anyhow::Error>,
}

/// One queued prompt round trip for the submit worker; `prompt_submit_worker` drains them one at a
/// time, in submit order.
pub(crate) struct PromptOrder {
    /// Captured per submit: the reconnect driver can replace the client between submits, and the
    /// worker must never hold the superseded connection.
    pub(crate) client: DaemonClient,
    pub(crate) active_session_id: String,
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) behavior: SubmitBehavior,
    pub(crate) images: Option<serde_json::Value>,
    pub(crate) stashed_images: Vec<(u64, LoadedImage)>,
    pub(crate) stash_to_restore: Option<PromptStash>,
    pub(crate) turn_was_active: bool,
    pub(crate) expected_turn_end: u64,
    pub(crate) generation: u64,
    pub(crate) rebind_available: bool,
    /// A fresh uuid per submitted prompt (`agent input stage`), pairing the stage observations.
    pub(crate) input_id: String,
    pub(crate) submitted_at: std::time::Instant,
}

impl SessionUi {
    const MAX_PASTED_IMAGE_BYTES: usize = 64 * 1024 * 1024;

    /// Read the clipboard image and register it behind a new editor marker.
    pub(super) async fn handle_clipboard_image_paste(&mut self, view: &mut AgentView) {
        let Some(attachment) = crate::clipboard_image::read_clipboard_image().await else {
            return;
        };
        let marker_id = self.next_image_marker_id;
        self.next_image_marker_id += 1;
        let mime_type = attachment.mime_type.clone();
        self.remember_pasted_image(marker_id, attachment, view);
        view.editor
            .insert_text_at_cursor(&format_image_marker(marker_id));
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.image_pasted(&mime_type).await;
            });
        }
        if !self.model_supports_images(view) {
            // The attachment is never silently omitted: the routed note or the refusal
            // names the fix; host-blocked images surface the block.
            let settings = self.client_settings.as_ref();
            let blocked = settings.is_some_and(|settings| settings.block_images());
            let routed = settings.is_some_and(|settings| settings.image_model().is_some());
            if blocked {
                self.note("Images are blocked (settings: block images).", view);
            } else if routed {
                self.note(
                    "Current model does not support images; the attachment routes to the configured image model.",
                    view,
                );
            } else {
                self.note(
                    "Current model does not support images. Set settings.imageModel to route image turns.",
                    view,
                );
            }
        }
        self.dirty = true;
    }

    /// Record a pasted image, evicting the oldest entries once the retained bytes exceed
    /// [`Self::MAX_PASTED_IMAGE_BYTES`]; reachable markers are never evicted.
    fn remember_pasted_image(&mut self, id: u64, image: LoadedImage, view: &AgentView) {
        self.pasted_images.insert(id, image);
        let mut keep = Self::live_image_marker_ids(&view.editor);
        keep.insert(id);
        let mut images = std::mem::take(&mut self.pasted_images);
        evict_images_to_budget(
            &mut images,
            |image: &LoadedImage| image.data.len(),
            Self::MAX_PASTED_IMAGE_BYTES,
            &keep,
        );
        self.pasted_images = images;
    }

    /// Marker ids still reachable — current editor text and prompt history — never evicted (the TS
    /// version also scans the compaction/connection queues, daemon-side here).
    fn live_image_marker_ids(editor: &crate::editor::Editor) -> std::collections::BTreeSet<u64> {
        let mut ids = std::collections::BTreeSet::new();
        ids.extend(image_marker_ids(&editor.get_text()));
        ids.extend(
            editor
                .get_history()
                .iter()
                .flat_map(|text| image_marker_ids(text)),
        );
        ids
    }

    // Prompt stash: one client-owned store; the draft follows the session across switches.

    /// The chat's stash state follows the connected session's stable id; the new binding's stashed
    /// images re-enter the paste registry with their marker ids reserved.
    pub(super) fn bind_prompt_stash_session(&mut self, session_id: &str) {
        if self.stash_session_id == session_id {
            return;
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        if !self.stash_session_id.is_empty() {
            store.release(&self.stash_session_id);
        }
        let state = store.for_session(session_id);
        for stash in state.stash.iter().chain(state.queued_stashes.iter()) {
            for (id, image) in &stash.images {
                self.pasted_images.insert(*id, image.clone());
                self.next_image_marker_id = self.next_image_marker_id.max(id + 1);
            }
            for id in image_marker_ids(&stash.text) {
                self.next_image_marker_id = self.next_image_marker_id.max(id + 1);
            }
        }
        self.stash_session_id = session_id.to_string();
    }

    pub(crate) fn release_prompt_stash_session(&mut self) {
        if self.stash_session_id.is_empty() {
            return;
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store.release(&self.stash_session_id);
    }

    /// The editor draft plus the pasted images its markers still reference;
    /// `None` for a whitespace-only draft. The auto capture paths stash a
    /// restore-on-open head; the manual `app.prompt.stash` capture does not.
    fn snapshot_prompt_stash(
        &self,
        view: &AgentView,
        restore_on_open: bool,
    ) -> Option<PromptStash> {
        let text = view.editor.get_text();
        if text.trim().is_empty() {
            return None;
        }
        let images: Vec<(u64, LoadedImage)> = collect_marked_images(&self.pasted_images, &text)
            .into_iter()
            .map(|(id, image)| (id, image.clone()))
            .collect();
        // A collapsed paste's content lives in the editor's registry, not the text, so the registry
        // must travel with the draft or the restored marker stays literal.
        let snapshot = view.editor.get_paste_snapshot();
        let paste_snapshot = (!snapshot.pastes.is_empty()).then_some(snapshot);
        Some(PromptStash {
            text,
            paste_snapshot,
            images,
            restore_on_open,
        })
    }

    /// On the way to the agents view, the live draft becomes the session's restore-on-open head;
    /// the editor dies with this view, so the draft lives on only in the store.
    pub(crate) fn stash_draft_for_agents_view(&mut self, view: &AgentView) {
        let Some(draft) = self.snapshot_prompt_stash(view, true) else {
            return;
        };
        if let Some(telemetry) = self.telemetry.clone() {
            let had_images = !draft.images.is_empty();
            tokio::spawn(async move {
                telemetry.prompt_stash("agents_view", had_images).await;
            });
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store
            .for_session(&self.stash_session_id)
            .stash_draft_head(draft);
    }

    /// The in-place `/switch` capture: the draft is stashed as the left
    /// session's restore head; it returns on a switch back.
    pub(super) fn stash_draft_for_switch(&mut self, view: &mut AgentView) {
        let Some(draft) = self.snapshot_prompt_stash(view, true) else {
            return;
        };
        if let Some(telemetry) = self.telemetry.clone() {
            let had_images = !draft.images.is_empty();
            tokio::spawn(async move {
                telemetry.prompt_stash("session_switch", had_images).await;
            });
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store
            .for_session(&self.stash_session_id)
            .stash_draft_head(draft);
        view.editor.set_text("");
        self.dirty = true;
    }

    /// The opening restore of the session's auto-stashed draft. The notice lands in its own status
    /// block: init may have posted a notice that a back-to-back status rewrite would replace.
    pub(crate) fn restore_prompt_stash_on_open(&mut self, view: &mut AgentView) {
        self.last_status_index = None;
        self.restore_prompt_stash_if_editor_empty(view, true);
    }

    /// TS `restorePromptStashIfEditorEmpty`: the head draft returns to the
    /// editor only when the editor is empty; the next queued draft (if
    /// any) becomes the head. Returns whether a draft landed.
    /// `auto_head_only` mirrors the two TS call shapes: the opening
    /// restore (and this port's `/switch` landing, TS
    /// `restorePromptStashOnOpen`'s gate) restores only an auto
    /// restore-on-open head, while the manual `app.prompt.stash` key
    /// restores whatever draft the session holds — a manual stash never
    /// lands on an open or a switch, only on its own key or after the
    /// next admitted send (TS `promptStashToRestore`).
    pub(super) fn restore_prompt_stash_if_editor_empty(
        &mut self,
        view: &mut AgentView,
        auto_head_only: bool,
    ) -> bool {
        if !view.editor.get_text().trim().is_empty() {
            return false;
        }
        let stash = {
            let mut store = self
                .prompt_stash
                .lock()
                .expect("prompt stash store poisoned");
            let state = store.for_session(&self.stash_session_id);
            if auto_head_only {
                state.take_head_restore_on_open()
            } else {
                state.take_head()
            }
        };
        let Some(stash) = stash else {
            return false;
        };
        for (id, image) in &stash.images {
            self.pasted_images.insert(*id, image.clone());
        }
        for id in image_marker_ids(&stash.text) {
            self.next_image_marker_id = self.next_image_marker_id.max(id + 1);
        }
        view.editor.set_text(&stash.text);
        // The collapsed pastes re-enter the editor's registry so the restored
        // markers stay atomic and expand on submit.
        if let Some(snapshot) = &stash.paste_snapshot {
            view.editor.restore_paste_snapshot(snapshot.clone());
        }
        if let Some(telemetry) = self.telemetry.clone() {
            let had_images = !stash.images.is_empty();
            tokio::spawn(async move {
                telemetry.prompt_stash("restored", had_images).await;
            });
        }
        self.note("Restored stashed prompt", view);
        true
    }

    /// The `app.prompt.stash` action (default ctrl+s): with a draft the key stashes it and clears
    /// the editor; with an empty editor it restores the stashed draft. A session that already holds
    /// a draft keeps it — the manual key never clobbers one.
    pub(super) fn handle_prompt_stash(&mut self, view: &mut AgentView) {
        if view.editor.get_text().trim().is_empty() {
            if !self.restore_prompt_stash_if_editor_empty(view, false) {
                self.note("No prompt to stash", view);
            }
            return;
        }
        let holds_draft = {
            let mut store = self
                .prompt_stash
                .lock()
                .expect("prompt stash store poisoned");
            store.for_session(&self.stash_session_id).stash.is_some()
        };
        if holds_draft {
            self.note("Prompt stash already has a draft", view);
            return;
        }
        let Some(draft) = self.snapshot_prompt_stash(view, false) else {
            return;
        };
        {
            let mut store = self
                .prompt_stash
                .lock()
                .expect("prompt stash store poisoned");
            store
                .for_session(&self.stash_session_id)
                .stash_draft_head(draft);
        }
        view.editor.set_text("");
        self.dirty = true;
        self.note("Stashed prompt", view);
    }

    /// Whether the current model takes image input; unknown models are assumed
    /// capable (the daemon re-checks). The catalog lookup is provider-aware: a
    /// same-id entry under another provider is a different model.
    pub(super) fn model_supports_images(&self, view: &AgentView) -> bool {
        let Some(model) = self.current_model_entry(view) else {
            return true;
        };
        model.input.contains(&pa_types::ai::ModelInput::Image)
    }

    /// Submit a prompt (the Enter path): the user message arrives back as a `message_start` event
    /// (no local echo); prompts sent while a turn is active queue on the daemon side; `behavior`
    /// selects the lane.
    pub(crate) async fn submit_prompt(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        // The `!`/`!!` bash shortcut routes before the side-question capture and
        // every prompt path; a bare `!`/`!!` is never sent as a prompt.
        if let Some(bang) = crate::bash_bang::parse_bash_bang(text) {
            return match bang {
                crate::bash_bang::BashBang::Bare => Ok(()),
                crate::bash_bang::BashBang::Run(shortcut) => {
                    self.run_chat_bash(text, &shortcut, view).await
                }
            };
        }
        // An open side-question pane captures the submission — commands get the in-pane notice,
        // everything else a follow-up; a reply that merely starts with "/" is not a command.
        if view.side_pane.is_some() {
            let registry = SlashCommandRegistry::builtin();
            let is_command = pa_types::slash_commands::parse_slash_command(text)
                .is_some_and(|(name, _)| registry.is_builtin(&name));
            if is_command {
                self.add_side_notice(
                    text,
                    "Slash commands are not available in side conversations. Press esc to return to the main thread.",
                    view,
                );
                return Ok(());
            }
            if self.active_side_question_id.is_some() {
                view.editor.set_text(text);
                self.start_side_question(text, view).await?;
                return Ok(());
            }
            if !collect_marked_images(&self.pasted_images, text).is_empty() {
                view.editor.set_text(text);
                self.add_side_notice(
                    text,
                    "Images are not supported in side conversations. Press esc to return to the main thread.",
                    view,
                );
                return Ok(());
            }
            view.editor.add_to_history(text);
            self.start_side_question(text, view).await?;
            return Ok(());
        }
        if text.starts_with('/') {
            return self.handle_slash(text, behavior, view).await;
        }
        self.send_prompt(text, behavior, view)
    }

    // Side questions (/btw, /side)

    /// One client-local notice turn: rendered like a turn, never sent to the
    /// daemon, never seeding a follow-up.
    fn add_side_notice(&mut self, question: &str, answer: &str, view: &mut AgentView) {
        self.side_question_counter += 1;
        let id = format!(
            "side-notice-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_millis())
                .unwrap_or_default(),
            self.side_question_counter
        );
        let turn = crate::side_question::SideQuestionTurn {
            id,
            question: question.to_string(),
            answer: answer.to_string(),
            status: "complete".to_string(),
            error_message: None,
            local: true,
        };
        view.side_pane
            .get_or_insert_with(crate::side_question::SideQuestionPane::default)
            .upsert(turn);
        self.dirty = true;
    }

    /// Start a side question: the answered turns seed the follow-up's context.
    pub(super) async fn start_side_question(
        &mut self,
        question: &str,
        view: &mut AgentView,
    ) -> Result<()> {
        if self.active_side_question_id.is_some() {
            self.note_as(
                "Wait for the current side question to finish or cancel it first.",
                StatusKind::Warning,
                view,
            );
            return Ok(());
        }
        let previous_turns: Vec<serde_json::Value> = view
            .side_pane
            .as_ref()
            .map(|pane| {
                pane.seed_turns()
                    .into_iter()
                    .map(|(question, answer)| {
                        serde_json::json!({ "question": question, "answer": answer })
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.side_question_counter += 1;
        let id = format!(
            "side-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_millis())
                .unwrap_or_default(),
            self.side_question_counter
        );
        let turn = crate::side_question::SideQuestionTurn {
            id: id.clone(),
            question: question.to_string(),
            answer: String::new(),
            status: "running".to_string(),
            error_message: None,
            local: false,
        };
        view.side_pane
            .get_or_insert_with(crate::side_question::SideQuestionPane::default)
            .upsert(turn);
        self.active_side_question_id = Some(id.clone());
        self.dirty = true;
        let previous_turns =
            (!previous_turns.is_empty()).then_some(serde_json::Value::Array(previous_turns));
        let started = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::StartSideQuestion {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    side_question_id: id.clone(),
                    question: question.to_string(),
                    previous_turns,
                    rest: Map::default(),
                },
            )
            .await;
        if let Err(error) = started {
            self.active_side_question_id = None;
            if let Some(pane) = view.side_pane.as_mut() {
                pane.upsert(crate::side_question::SideQuestionTurn {
                    id,
                    question: question.to_string(),
                    answer: String::new(),
                    status: "error".to_string(),
                    error_message: Some(format!("{error:#}")),
                    local: false,
                });
            }
            self.dirty = true;
        }
        Ok(())
    }

    /// Close the pane; the active run aborts fire-and-forget (the daemon's
    /// cancelled event finds the pane already gone).
    pub(super) fn clear_side_question(&mut self, abort: bool, view: &mut AgentView) {
        // A side-conversation bash run dies with its pane: in-flight `bash_*`
        // events are swallowed until its bash_end, and only a run whose bash_start
        // we saw aborts (abort_bash is session-scoped).
        if let Some(run) = self.side_bash.take() {
            let started = view
                .side_pane
                .as_ref()
                .is_some_and(|pane| pane.bash.is_some());
            self.side_bash_discarded = Some(run.run_id);
            if started {
                self.abort_user_bash();
            }
        }
        let active = self.active_side_question_id.take();
        if abort {
            if let Some(side_question_id) = active {
                let client = self.client.clone();
                let active_session_id = self.active_session_id.clone();
                tokio::spawn(async move {
                    let _ = client
                        .request_ok(DaemonCommand::AbortSideQuestion {
                            id: None,
                            active_session_id,
                            side_question_id,
                            rest: Map::default(),
                        })
                        .await;
                });
            }
        }
        view.side_pane = None;
        self.dirty = true;
    }

    pub(super) fn apply_side_question_event(&mut self, event: &Value, view: &mut AgentView) {
        let id = event
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let status = event
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if self.active_side_question_id.as_deref() == Some(id.as_str()) && status != "running" {
            self.active_side_question_id = None;
        }
        let Some(pane) = view.side_pane.as_mut() else {
            return;
        };
        // The render update is gated on the tracked turn (the latest one the
        // daemon started; client-local notices never join it), so a late terminal
        // event for a closed run cannot ghost into a newer pane as a second turn.
        let tracked = pane
            .turns
            .iter()
            .rev()
            .find(|turn| !turn.local)
            .map(|turn| turn.id.as_str());
        if tracked != Some(id.as_str()) {
            return;
        }
        pane.upsert(crate::side_question::SideQuestionTurn {
            id,
            question: event
                .get("question")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            answer: event
                .get("answer")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            status,
            error_message: event
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
            local: false,
        });
        self.dirty = true;
    }

    pub(super) fn send_prompt(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
        // A new prompt settles the held bash cards into the transcript first.
        Self::flush_pending_bash(view);
        if let Some(error) = self.reconnection_failed.clone() {
            // The re-attach window expired: the connection is closed, nothing dispatches.
            self.error_row(&format!("Daemon reconnection failed: {error}"), view);
            view.editor.set_text(text);
            return Ok(());
        }
        let images = self.collect_images_for(text, view);
        // The submit resolves off the render path: the cleared editor paints THIS frame without the
        // daemon round trip; the outcome folds back through [`Self::apply_prompt_outcome`].
        let stashed_images: Vec<(u64, LoadedImage)> =
            collect_marked_images(&self.pasted_images, text)
                .into_iter()
                .map(|(id, image)| (id, image.clone()))
                .collect();
        self.input_submission_generation += 1;
        let generation = self.input_submission_generation;
        let stash_to_restore = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned")
            .for_session(&self.stash_session_id)
            .stash
            .clone();
        self.order_prompt_request(
            text.to_string(),
            behavior,
            images,
            stashed_images,
            stash_to_restore,
            true,
            generation,
        );
        self.dirty = true;
        Ok(())
    }

    /// Queue one prompt round trip on the ordered submit channel (TS
    /// `onSubmit`'s `agentConnection.prompt` await runs off the render
    /// path): the request carries the same envelope the inline await
    /// sent, and the single worker (see [`PromptOrder`]) settles them
    /// strictly in submit order — the frame after Enter paints without
    /// gating on the daemon, and cross-submit wire order never depends on
    /// task scheduling. `rebind_available` is the inline path's
    /// one-rebind budget: the first attempt may re-attach and replay on
    /// the unknown-session refusal, a replay may not rebind again (the
    /// replay is the second and last attempt).
    #[allow(clippy::too_many_arguments)]
    fn order_prompt_request(
        &mut self,
        text: String,
        behavior: SubmitBehavior,
        images: Option<serde_json::Value>,
        stashed_images: Vec<(u64, LoadedImage)>,
        stash_to_restore: Option<PromptStash>,
        rebind_available: bool,
        generation: u64,
    ) {
        // The turn state at submit time gates the telemetry; an earlier submit
        // still in flight counts as active here.
        let turn_was_active = self.turn_active || self.prompt_in_flight > 0;
        let expected_turn_end = self.last_prompt_turn_end.max(self.turn_ends_seen) + 1;
        self.last_prompt_turn_end = expected_turn_end;
        self.prompt_in_flight += 1;
        let _ = self.prompt_orders.send(PromptOrder {
            client: self.client.clone(),
            active_session_id: self.active_session_id.clone(),
            session_id: self.session_id.clone(),
            text,
            behavior,
            images,
            stashed_images,
            stash_to_restore,
            turn_was_active,
            expected_turn_end,
            generation,
            rebind_available,
            input_id: uuid::Uuid::new_v4().to_string(),
            submitted_at: std::time::Instant::now(),
        });
    }

    /// The single prompt-submit worker: one request in flight at a time; submit N+1's
    /// wire write waits for submit N's round trip. Exits when the orders channel closes.
    pub(super) async fn prompt_submit_worker(
        mut orders: mpsc::UnboundedReceiver<PromptOrder>,
        notes: mpsc::UnboundedSender<PromptSubmitNote>,
    ) {
        while let Some(order) = orders.recv().await {
            let command = DaemonCommand::Prompt {
                id: None,
                active_session_id: order.active_session_id.clone(),
                message: order.text.clone(),
                input: pa_types::daemon::PromptInput {
                    content: None,
                    images: order.images.clone(),
                    streaming_behavior: Some(match order.behavior {
                        SubmitBehavior::Steer => pa_types::daemon::StreamingBehavior::Steer,
                        SubmitBehavior::FollowUp => pa_types::daemon::StreamingBehavior::FollowUp,
                    }),
                    queue_if_busy: Some(true),
                    expand_prompt_templates: None,
                    source: None,
                    agent_message_id: None,
                    custom_message: None,
                    queue_key: None,
                    prefix_messages: None,
                    admission_id: None,
                    rlm_notice_nonce: None,
                },
                rest: Map::default(),
            };
            let result = tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                order.client.request_ok(command),
            )
            .await
            .map_err(|_| {
                anyhow!(
                    "timed out after {UI_REQUEST_TIMEOUT_MS}ms waiting for the Prime Agent daemon response"
                )
            })
            .and_then(|result| result.map(|_| ()));
            let _ = notes.send(PromptSubmitNote {
                active_session_id: order.active_session_id,
                session_id: order.session_id,
                text: order.text,
                behavior: order.behavior,
                images: order.images,
                stashed_images: order.stashed_images,
                stash_to_restore: order.stash_to_restore,
                turn_was_active: order.turn_was_active,
                expected_turn_end: order.expected_turn_end,
                generation: order.generation,
                input_id: order.input_id,
                submitted_at: order.submitted_at,
                rebind_available: order.rebind_available,
                result,
            });
        }
    }

    /// Whether user work is in flight for the busy guards (`/update`, `/nightly`, `/reload`): a
    /// live turn OR a prompt round trip still traveling — a package update landing in the pre-ack
    /// window would interrupt work the user just submitted.
    pub(super) fn work_in_flight(&self) -> bool {
        self.prompt_in_flight > 0
    }

    /// Fold a backgrounded prompt outcome back into the session (the run
    /// loop's channel arm).
    pub(crate) async fn apply_prompt_outcome(
        &mut self,
        note: PromptSubmitNote,
        view: &mut AgentView,
    ) -> Result<()> {
        self.prompt_in_flight = self.prompt_in_flight.saturating_sub(1);
        // The submit's session is no longer the mounted one: the outcome never applies bookkeeping
        // to the new session, but a FAILED outlived submit still shows its error row and retains
        // its rejected draft into the session it was typed for; a succeeded one stays silent.
        if note.active_session_id != self.active_session_id {
            // Borrow the settled result here: the ladder below owns it.
            if let Some(error) = note.result.as_ref().err() {
                let rendered = format!("{error:#}");
                self.error_row(&rendered, view);
                self.retain_rejected_draft(
                    &note.text,
                    &note.session_id,
                    note.generation,
                    note.stashed_images.clone(),
                    view,
                );
            }
            return Ok(());
        }
        match note.result {
            Ok(()) => {
                // `agent input stage`: the observed dispatch outcome at the submit seam; the turn's
                // terminal state rides the session telemetry's run events.
                if let Some(telemetry) = self.telemetry.clone() {
                    let (stage, outcome) = if note.turn_was_active {
                        ("queued", "started")
                    } else {
                        ("dispatch", "success")
                    };
                    let input_id = note.input_id.clone();
                    let duration_ms = note.submitted_at.elapsed().as_millis() as u64;
                    tokio::spawn(async move {
                        telemetry
                            .input_stage(input_id, stage, outcome, duration_ms)
                            .await;
                    });
                }
                // A submission while a turn runs parks in the queue behind it.
                if note.turn_was_active {
                    if let Some(telemetry) = self.telemetry.clone() {
                        let lane = match note.behavior {
                            SubmitBehavior::Steer => "steering",
                            SubmitBehavior::FollowUp => "follow_up",
                        };
                        // The adoption event carries the queue delivery mode (`steering_mode`):
                        // batched-delivery exposure is the multi-steer batch adoption signal.
                        let steering_mode = self.steering_mode.clone();
                        tokio::spawn(async move {
                            telemetry.queued_input(lane, steering_mode).await;
                        });
                    }
                }
                // The daemon can stream the complete turn before the ACK reaches this channel:
                // turn_end already owns the idle state, and re-arming it would strand WaitIdle
                // until timeout. The per-submit end watermark also keeps a prior turn's end from
                // settling a queued later prompt.
                if self.turn_ends_seen < note.expected_turn_end {
                    self.turn_active = true;
                    self.start_loader(view);
                    self.dirty = true;
                }
                // TS `onSubmit`'s finally: the current submit's admitted prompt
                // restores the stash head it captured, if that is still the head.
                if note.generation == self.input_submission_generation {
                    if let Some(captured) = note.stash_to_restore {
                        let head_unchanged = self
                            .prompt_stash
                            .lock()
                            .expect("prompt stash store poisoned")
                            .for_session(&self.stash_session_id)
                            .stash
                            .as_ref()
                            == Some(&captured);
                        if head_unchanged {
                            self.restore_prompt_stash_if_editor_empty(view, false);
                        }
                    }
                }
                Ok(())
            }
            Err(error) => {
                // `agent input stage`: the submission was rejected at the dispatch
                // boundary.
                if let Some(telemetry) = self.telemetry.clone() {
                    let input_id = note.input_id.clone();
                    let duration_ms = note.submitted_at.elapsed().as_millis() as u64;
                    tokio::spawn(async move {
                        telemetry
                            .input_stage(input_id, "rejected", "error", duration_ms)
                            .await;
                    });
                }
                let rendered = format!("{error:#}");
                // One rebind attempt per submit: a prompt refused with the unknown-session error
                // re-attaches by the DURABLE session id and replays ONCE; the failed attempt never
                // reached a worker, so the replay is exactly-once by construction.
                if note.rebind_available
                    && rendered.contains("Unknown active session")
                    && !self.session_id.is_empty()
                {
                    let durable = self.session_id.clone();
                    if self
                        .attach_session(&durable, DockFold::FirstFrame)
                        .await
                        .is_ok()
                    {
                        // The replay keeps the submit's generation and spends the rebind budget.
                        self.rebuild_view(view, &RebuildKind::Rebind);
                        self.order_prompt_request(
                            note.text.clone(),
                            note.behavior,
                            note.images.clone(),
                            note.stashed_images.clone(),
                            note.stash_to_restore.clone(),
                            false,
                            note.generation,
                        );
                        return Ok(());
                    }
                }
                if crate::daemon_client::is_daemon_timeout(&error) {
                    // Sent but unanswered: the turn may already be admitted — restoring the
                    // draft would invite a duplicate submission, so the error row names the
                    // uncertainty.
                    self.error_row(
                        &format!(
                            "{rendered} — the request was sent; the turn may still be in flight"
                        ),
                        view,
                    );
                    return Ok(());
                }
                // A transport failure after the frame was queued (a direct link, or the
                // supervisor socket closing mid-flight): the daemon may have admitted the turn,
                // so the draft stays consumed like the timeout arm.
                let sent_then_closed = crate::daemon_client::is_daemon_unreachable(&error)
                    && rendered.to_lowercase().contains("connection closed");
                if sent_then_closed {
                    self.error_row(
                        &format!(
                            "{rendered} — the request may have been sent; the turn may still start"
                        ),
                        view,
                    );
                    return Ok(());
                }
                if crate::daemon_client::is_daemon_rejection(&error)
                    || crate::daemon_client::is_daemon_unreachable(&error)
                {
                    // The daemon answered with a refusal for THIS request, or the connection
                    // refused the send (nothing reached the daemon): the error row surfaces it and
                    // the draft returns to the editor; a failed prompt never exits the UI.
                    self.error_row(&rendered, view);
                    self.retain_rejected_draft(
                        &note.text,
                        &self.stash_session_id.clone(),
                        note.generation,
                        note.stashed_images.clone(),
                        view,
                    );
                    return Ok(());
                }
                Err(error)
            }
        }
    }

    /// Retain a refused prompt's draft: the empty editor under the submit's own session and
    /// generation takes the text back; anything else keeps the fresh text by retaining the rejected
    /// prompt as the session's restore-on-open head.
    fn retain_rejected_draft(
        &mut self,
        text: &str,
        stash_session_id: &str,
        generation: u64,
        stashed_images: Vec<(u64, LoadedImage)>,
        view: &mut AgentView,
    ) {
        if view.editor.get_text().trim().is_empty()
            && stash_session_id == self.stash_session_id
            && generation == self.input_submission_generation
        {
            view.editor.set_text(text);
            return;
        }
        // The rejected prompt becomes the session's restore-on-open head with its submit-time image
        // snapshot; the draft returns on the next empty-editor open.
        let stash = PromptStash {
            text: text.to_string(),
            paste_snapshot: None,
            images: stashed_images,
            restore_on_open: true,
        };
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store.for_session(stash_session_id).stash_draft_head(stash);
    }
}

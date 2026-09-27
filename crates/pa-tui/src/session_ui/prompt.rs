//! The prompt submit pipeline and its satellites: the ordered submit
//! channel (`PromptOrder` -> the worker -> `PromptSubmitNote`'s
//! fold-back), the prompt stash's capture and restore, the side-question
//! turns, and the pasted-image registry.

use super::*;
/// How a submitted prompt travels to the session (TS `streamingBehavior`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubmitBehavior {
    /// Plain Enter: mid-turn input parks on the steering lane (TS "steer").
    Steer,
    /// The follow-up key (`alt+enter`): parks on the follow-up lane and
    /// delivers when the run goes idle.
    FollowUp,
}

/// One backgrounded prompt round trip's settled outcome (TS `onSubmit`
/// awaits `agentConnection.prompt` off the render path —
/// `interactive-mode.ts` clears the editor and lets Ink paint before the
/// await, and the daemon answer folds back later): `Ok(())` is an
/// admitted/queued prompt; the error is the daemon failure the inline
/// await used to surface on the key path.
pub(crate) struct PromptSubmitNote {
    /// The submit-time active id: the outcome applies only while the
    /// client still holds that session (a switch, a supersede rebind, or
    /// a `/new` replaced it) — TS's staleness guard for a submit that
    /// outlived its session.
    pub(crate) active_session_id: String,
    /// The submit-time durable session id: a stale FAILURE retains its
    /// rejected draft into THAT session's stash (TS `retainSubmittedDraft`
    /// targets the submit-time `submissionStashState`), never the newly
    /// mounted session's.
    pub(crate) session_id: String,
    /// The submitted text (the draft restore and the rebind replay).
    pub(crate) text: String,
    /// The submit lane (the queued-input telemetry and the rebind replay).
    pub(crate) behavior: SubmitBehavior,
    /// The collected prompt images (the rebind replay sends the same set).
    pub(crate) images: Option<serde_json::Value>,
    /// The submit-time image snapshot behind the submitted text's markers
    /// (TS `snapshotPromptStash` at submit): the refusal's retention keeps
    /// the attachments rehydratable even after the editor cleared and the
    /// registry could evict them.
    pub(crate) stashed_images: Vec<(u64, LoadedImage)>,
    /// Whether the turn was already active at submit time (the
    /// queued-input telemetry's lane gate; the inline path read the same
    /// flag after its await, which nothing could move while the loop was
    /// blocked).
    pub(crate) turn_was_active: bool,
    /// The expected end of this admitted prompt in submit order.
    pub(crate) expected_turn_end: u64,
    /// The submit's generation (TS `inputSubmissionGeneration`): a newer
    /// submit supersedes an older one's draft-restore right.
    pub(crate) generation: u64,
    /// Whether a failure may still rebind once (the replayed request is
    /// the second and last attempt — the inline path's
    /// `rebind_available`).
    pub(crate) rebind_available: bool,
    /// The settled request: admitted/queued on `Ok`; the daemon error
    /// otherwise.
    pub(crate) result: Result<(), anyhow::Error>,
}

/// One queued prompt round trip for the submit worker (the ordered channel
/// that replaces per-submit spawns): the worker drains its inbox one
/// request at a time, so the wire write for submit N+1 only happens after
/// submit N's round trip settles — cross-submit order is guaranteed on
/// the terminal path exactly like the blocked loop and TS's single-threaded
/// event loop guaranteed it (a per-submit `tokio::spawn` would schedule
/// the writes independently and could reorder two rapid submits).
pub(crate) struct PromptOrder {
    /// The connection the request travels on (captured per submit: the
    /// reconnect driver can replace the client between submits, and a
    /// long-lived worker must never hold the superseded connection).
    pub(crate) client: DaemonClient,
    pub(crate) active_session_id: String,
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) behavior: SubmitBehavior,
    pub(crate) images: Option<serde_json::Value>,
    pub(crate) stashed_images: Vec<(u64, LoadedImage)>,
    pub(crate) turn_was_active: bool,
    pub(crate) expected_turn_end: u64,
    pub(crate) generation: u64,
    pub(crate) rebind_available: bool,
}

impl SessionUi {
    /// The retained-bytes budget for pasted images (TS
    /// `MAX_PASTED_IMAGE_BYTES`): the registry evicts oldest entries once
    /// the retained base64 payload exceeds it.
    const MAX_PASTED_IMAGE_BYTES: usize = 64 * 1024 * 1024;

    /// Read the clipboard image and register it behind a new editor
    /// marker (TS `handleClipboardImagePaste`). A clipboard without a
    /// supported image is a no-op; clipboard errors are silently ignored
    /// (the clipboard may lack permissions), matching the TS catch.
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
            self.note(
                "Current model does not support images; the attachment will be omitted.",
                view,
            );
        }
        self.dirty = true;
    }

    /// Record a pasted image, evicting the oldest entries once the
    /// retained bytes exceed [`Self::MAX_PASTED_IMAGE_BYTES`] (TS
    /// `rememberPastedImage`). The just-added image and every image whose
    /// marker is still reachable are never evicted, so a live marker never
    /// loses its image.
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

    /// Marker ids still reachable - current editor text and prompt history
    /// (recallable with the up arrow) - which are never evicted so a
    /// recall never finds a marker with no image. The TS version also
    /// scans the compaction/connection queues, which live daemon-side
    /// here.
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

    // ---- Prompt stash (TS `prompt-stash-state.ts` + the interactive-mode
    // stash call sites). One client-owned store per TUI process holds every
    // session's stashed draft; the draft follows the session across
    // switches. ----

    /// TS `bindPromptStashSession`: the chat's stash state follows the
    /// connected session's stable id. The previous binding releases when
    /// it holds nothing, and the new binding's stashed images re-enter the
    /// paste registry with their marker ids reserved (TS
    /// `hydratePromptStash`), so a restore never mints colliding markers
    /// and a submitted restored draft finds its image bytes.
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

    /// TS `teardownSessionUi` -> `releasePromptStashSession`: the run's
    /// binding ends. An empty state drops from the store; a session
    /// holding a draft keeps it for the next view that binds the session.
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

    /// TS `snapshotPromptStash`: the editor draft plus the pasted images
    /// its markers still reference. `None` for a whitespace-only draft.
    /// Both capture paths (the agents-view handoff, the in-place switch)
    /// stash an auto-restore head (TS `restoreOnOpen`).
    fn snapshot_prompt_stash(&self, view: &AgentView) -> Option<PromptStash> {
        let text = view.editor.get_text();
        if text.trim().is_empty() {
            return None;
        }
        let images: Vec<(u64, LoadedImage)> = collect_marked_images(&self.pasted_images, &text)
            .into_iter()
            .map(|(id, image)| (id, image.clone()))
            .collect();
        // TS `snapshotPromptStashFrom`: a collapsed paste's content lives in
        // the editor's registry, not in the text, so the registry must
        // travel with the draft or the restored marker would stay literal
        // instead of expanding on submit.
        let snapshot = view.editor.get_paste_snapshot();
        let paste_snapshot = (!snapshot.pastes.is_empty()).then_some(snapshot);
        Some(PromptStash {
            text,
            paste_snapshot,
            images,
            restore_on_open: true,
        })
    }

    /// TS `stashDraftForAgentsView`: on the way to the agents view, the
    /// live draft becomes the session's restore-on-open head — an
    /// existing unrestored stash queues behind it and keeps its own
    /// restore semantics. The editor dies with this view, so the draft
    /// lives on only in the store.
    pub(crate) fn stash_draft_for_agents_view(&mut self, view: &AgentView) {
        let Some(draft) = self.snapshot_prompt_stash(view) else {
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

    /// The in-place `/switch` capture: the draft belongs to the session
    /// being left, so it is stashed as that session's restore head and the
    /// editor clears — the switched-to session starts from an empty prompt
    /// and the draft returns on a switch back.
    pub(super) fn stash_draft_for_switch(&mut self, view: &mut AgentView) {
        let Some(draft) = self.snapshot_prompt_stash(view) else {
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

    /// TS `restorePromptStashOnOpen`: the opening restore of the session's
    /// auto-stashed draft. The restore notice lands in its own status
    /// block: init may have posted a notice (a tmux keyboard warning, a
    /// compaction row) that the back-to-back status rewrite would
    /// otherwise replace.
    pub(crate) fn restore_prompt_stash_on_open(&mut self, view: &mut AgentView) {
        self.last_status_index = None;
        self.restore_prompt_stash_if_editor_empty(view);
    }

    /// TS `restorePromptStashIfEditorEmpty`: the head draft returns to the
    /// editor only when the editor is empty; the next queued draft (if
    /// any) becomes the head. Returns whether a draft landed.
    pub(super) fn restore_prompt_stash_if_editor_empty(&mut self, view: &mut AgentView) -> bool {
        if !view.editor.get_text().trim().is_empty() {
            return false;
        }
        let stash = {
            let mut store = self
                .prompt_stash
                .lock()
                .expect("prompt stash store poisoned");
            store
                .for_session(&self.stash_session_id)
                .take_head_restore_on_open()
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
        // TS `restorePromptStash` -> `restorePasteSnapshot`: the collapsed
        // pastes re-enter the editor's registry so the restored markers
        // stay atomic and expand on submit.
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

    /// Whether the current model takes image input (TS
    /// `model.input.includes("image")`), when the model is known from the
    /// startup catalog; unknown models are assumed capable (the daemon
    /// re-checks against the resolved model anyway).
    pub(super) fn model_supports_images(&self, view: &AgentView) -> bool {
        let Some(model_id) = view.chrome.model_id.as_deref() else {
            return true;
        };
        let Some(model) = self.model_catalog.iter().find(|model| model.id == model_id) else {
            return true;
        };
        model.input.contains(&pa_types::ai::ModelInput::Image)
    }

    /// Submit a prompt (the Enter path). The user message arrives back as a
    /// `message_start` session event (no local echo), and prompts sent while
    /// a turn is active queue on the daemon side. `behavior` selects the
    /// lane (TS `handleFollowUp` routes the follow-up key through this
    /// same ladder with the `followUp` behavior).
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
        // TS `!`/`!!` (interactive-mode onSubmit): the bash shortcut
        // routes before the side-question capture and every prompt path.
        // A bare `!`/`!!` is bash mode with nothing to run — it is never
        // sent as a prompt; a command runs directly through the
        // user-bash slot, no model turn involved.
        if let Some(bang) = crate::bash_bang::parse_bash_bang(text) {
            return match bang {
                crate::bash_bang::BashBang::Bare => Ok(()),
                crate::bash_bang::BashBang::Run(shortcut) => {
                    self.run_chat_bash(text, &shortcut, view).await
                }
            };
        }
        // An open side-question pane captures the submission (TS's ladder
        // order): builtin slash commands get the in-pane notice, a reply
        // with pasted images gets the image notice, and everything else
        // becomes a follow-up side question. A reply that merely starts
        // with "/" (an absolute path) is not a command.
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
                // TS keeps the draft and shows the wait warning through
                // `handleSideQuestion`'s active-run guard.
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
        self.send_prompt(text, behavior, view).await
    }

    // ------------------------------------------------------------------
    // Side questions (/btw, /side)
    // ------------------------------------------------------------------

    /// One client-local notice turn (TS `sideQuestionComponent.addTurn`
    /// with a `side-notice-*` id): rendered like a turn, never sent to the
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

    /// Start a side question (TS `handleSideQuestion`): the answered turns
    /// seed the follow-up's context, the pane mounts the running turn, and
    /// the daemon run streams `side_question_event` frames back.
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
        // TS sends `previousTurns` only when the pane already answered
        // something (`previousTurns.length > 0 ? previousTurns : undefined`).
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
            // TS surfaces the failed start as the turn's error state.
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

    /// Close the side-question pane (TS `clearSideQuestion`): the active
    /// run aborts fire-and-forget (the daemon emits the cancelled event,
    /// which finds the pane already gone).
    pub(super) async fn clear_side_question(&mut self, abort: bool, view: &mut AgentView) {
        // A side-conversation bash run dies with its pane: its `bash_*`
        // events may still be in flight (even bash_start), so they are
        // swallowed until its bash_end, and a run we observed starting
        // aborts (abort_bash is session-scoped, so only a run whose
        // bash_start we saw is aborted).
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

    /// One streamed `side_question_event` (TS `handleSideQuestionEvent`):
    /// upsert the turn into the pane; a terminal event for the active run
    /// releases the follow-up guard.
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
        // TS `handleSideQuestionEvent` gates the render update on the tracked
        // turn (`event.id !== this.sideQuestionEvent?.id` returns early): the
        // tracked turn is the latest one the daemon started (client-local
        // notices never join it), so a late terminal event for a run whose
        // turn was closed (esc mid-run) cannot ghost into a newer pane as a
        // second turn.
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

    pub(super) async fn send_prompt(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
        // A new prompt settles the held bash cards into the transcript
        // first (TS `onSubmit` flushes `pendingBashComponents` before the
        // prompt travels).
        self.flush_pending_bash(view);
        if let Some(error) = self.reconnection_failed.clone() {
            // The re-attach window expired (TS terminal close): the session
            // connection is closed, so nothing dispatches. The error row
            // surfaces the terminal cause and the draft returns to the
            // editor (TS keeps the input buffer on a failed submit).
            self.error_row(&format!("Daemon reconnection failed: {error}"), view);
            view.editor.set_text(text);
            return Ok(());
        }
        let images = self.collect_images_for(text, view);
        // TS `onSubmit` resolves the submit off the render path: the
        // cleared editor paints THIS iteration's frame — the submit's
        // daemon round trip never gates the first frame after Enter — and
        // the request settles in the background, its outcome folding back
        // through [`Self::apply_prompt_outcome`] with the same
        // bookkeeping and error ladder the inline await ran on the key
        // path.
        // TS snapshots the submitted draft (with its image markers) at
        // submit (`snapshotPromptStash`): the refusal's retention keeps
        // the attachments rehydratable even after the editor cleared and
        // a later paste-heavy submit could evict them from the registry.
        let stashed_images: Vec<(u64, LoadedImage)> =
            collect_marked_images(&self.pasted_images, text)
                .into_iter()
                .map(|(id, image)| (id, image.clone()))
                .collect();
        self.input_submission_generation += 1;
        let generation = self.input_submission_generation;
        self.order_prompt_request(
            text.to_string(),
            behavior,
            images,
            stashed_images,
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
    fn order_prompt_request(
        &mut self,
        text: String,
        behavior: SubmitBehavior,
        images: Option<serde_json::Value>,
        stashed_images: Vec<(u64, LoadedImage)>,
        rebind_available: bool,
        generation: u64,
    ) {
        // The queued-input telemetry gates on the turn state at submit
        // time (the inline path read the same flag right after its
        // await, with the loop blocked so no event could move it); an
        // earlier submit still in flight held `turn_active` true on the
        // inline path too, so it counts here.
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
            turn_was_active,
            expected_turn_end,
            generation,
            rebind_available,
        });
    }

    /// The single prompt-submit worker (the ordered channel's drain side):
    /// one request in flight at a time, submit N+1's wire write only after
    /// submit N's round trip settles. TS's single-threaded event loop
    /// serializes its submit writes the same way — the async handler's
    /// `await` never reorders two submissions (interactive-mode.ts's
    /// `handleSubmit`), and the port's old blocked loop enforced the same
    /// order by construction. The outcome folds back through the
    /// prompt-submit channel; the worker exits when the orders channel
    /// closes (the session dropped its sender).
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
                turn_was_active: order.turn_was_active,
                expected_turn_end: order.expected_turn_end,
                generation: order.generation,
                rebind_available: order.rebind_available,
                result,
            });
        }
    }

    /// Whether user work is in flight for the busy guards (TS's
    /// `isStreaming`-gated commands — `/update`, `/nightly`, `/reload`):
    /// a live turn OR a prompt round trip still traveling. The inline
    /// submit held the guards by blocking until the ack set
    /// `turn_active`; the backgrounded submit makes that pre-ack window
    /// visible, and a package update or reload landing inside it would
    /// interrupt work the user just submitted, so the guards wait it out
    /// (the same class of busy the old blocked loop enforced).
    pub(super) fn work_in_flight(&self) -> bool {
        self.prompt_in_flight > 0
    }

    /// Fold a backgrounded prompt outcome back into the session (the run
    /// loop's channel arm): the admission bookkeeping and the error
    /// ladder are the inline await's, moved off the key path — only the
    /// timing changed.
    pub(crate) async fn apply_prompt_outcome(
        &mut self,
        note: PromptSubmitNote,
        view: &mut AgentView,
    ) -> Result<()> {
        self.prompt_in_flight = self.prompt_in_flight.saturating_sub(1);
        // The submit's session is no longer the mounted one (a switch, a
        // supersede rebind, or a `/new` replaced it — TS's staleness
        // guard for a submit that outlived its session): the outcome
        // never applies bookkeeping to the new session, and never
        // restores a draft into another session's editor. A FAILED
        // outlived submit still shows its error row and retains its
        // rejected draft into the session it was typed for — TS
        // `handleSubmit`'s catch (interactive-mode.ts:5743 showError runs
        // regardless of the generation guard, and 5741 retains into the
        // submit-time stash state); a succeeded one stays silent (the
        // admitted turn belongs to the detached session, which the
        // daemon keeps serving).
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
                // A submission while a turn runs parks in the queue behind
                // it: the queue strip shows the message until the session
                // delivers it (adoption telemetry for the follow-up queue).
                if note.turn_was_active {
                    if let Some(telemetry) = self.telemetry.clone() {
                        let lane = match note.behavior {
                            SubmitBehavior::Steer => "steering",
                            SubmitBehavior::FollowUp => "follow_up",
                        };
                        // The queued-input adoption event carries the session's
                        // queue delivery mode (`tui input queued`'s
                        // `steering_mode`): exposure under batched delivery is
                        // the multi-steer batch feature's adoption signal.
                        let steering_mode = self.steering_mode.clone();
                        tokio::spawn(async move {
                            telemetry.queued_input(lane, steering_mode).await;
                        });
                    }
                }
                // The daemon can stream the complete turn before the ACK
                // reaches this channel. In that case turn_end already owns
                // the idle state; re-arming it would strand WaitIdle until
                // timeout. The per-submit end watermark also keeps a prior
                // turn's end from settling a queued later prompt.
                if self.turn_ends_seen < note.expected_turn_end {
                    self.turn_active = true;
                    self.start_loader(view);
                    self.dirty = true;
                }
                Ok(())
            }
            Err(error) => {
                let rendered = format!("{error:#}");
                // One rebind attempt per submit (never a loop): a prompt
                // refused with the unknown-session error - the held active
                // id was superseded by a worker replacement and the
                // supervisor could not rebind it either - re-attaches by
                // the DURABLE session id and replays the prompt ONCE.
                // The failed attempt never reached a worker (the
                // unknown-session refusal precedes any routing), so the
                // replay is exactly-once by construction.
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
                        // The fresh attach snapshot owns the transcript;
                        // the replayed prompt renders on top of it. The
                        // replay keeps the submit's generation and spends
                        // the rebind budget.
                        self.rebuild_view(view, RebuildKind::Rebind);
                        self.order_prompt_request(
                            note.text.clone(),
                            note.behavior,
                            note.images.clone(),
                            note.stashed_images.clone(),
                            false,
                            note.generation,
                        );
                        return Ok(());
                    }
                }
                if crate::daemon_client::is_daemon_timeout(&error) {
                    // Sent but unanswered: the submission was on the
                    // wire, so the turn may already be admitted and
                    // running — restoring the draft would invite a
                    // duplicate submission. The error row names the
                    // uncertainty; the transcript's live turn (or the
                    // next daemon answer) settles the truth.
                    self.error_row(
                        &format!(
                            "{rendered} — the request was sent; the turn may still be in flight"
                        ),
                        view,
                    );
                    return Ok(());
                }
                // A DIRECT-link transport failure happened after the
                // frame was queued (`request_direct` sent it, the link
                // died answering): the daemon may have admitted the
                // turn — restoring the draft would invite a duplicate
                // submission, so the draft stays consumed (the timeout
                // arm's contract).
                let direct_sent = crate::daemon_client::is_daemon_unreachable(&error)
                    && rendered
                        .to_lowercase()
                        .contains("session connection closed");
                if direct_sent {
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
                    // TS `onSubmit`'s prompt catch: the daemon answered
                    // with a refusal for THIS request (admission, queue
                    // capacity, a superseded session the rebind could
                    // not recover), or the connection refused the send
                    // (nothing reached the daemon) — the `⚠ Error` row
                    // surfaces it and the draft returns to the editor
                    // (the submission never landed); a failed prompt
                    // never exits the UI (the reconnect driver owns
                    // the connection's recovery).
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

    /// Retain a refused prompt's draft (TS `onSubmit`'s catch ->
    /// `retainSubmittedDraft`, interactive-mode.ts:5741): the empty editor
    /// under the submit's own session and generation takes the text back
    /// into the editor; anything else — the user typed a fresh draft, a
    /// newer submit superseded this one, or the submit outlived its
    /// session — keeps the fresh text by retaining the rejected prompt as
    /// the session's restore-on-open head instead of clobbering it.
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
        // The retained-draft stash write: the rejected prompt becomes the
        // session's restore-on-open head with its submit-time image
        // snapshot (TS `snapshotPromptStash` at submit), so nothing the
        // user typed is lost and the draft returns the next time the
        // session opens with an empty editor (TS
        // `restorePromptStashIfEditorEmpty`).
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

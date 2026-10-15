//! Browsing, reordering, and editing the parked steering/follow-up messages. The browse walks the
//! user-typed items only (operator decision 2026-10-16): internal prompts are a separate channel,
//! shown only as the strip's condensed row.
use super::{
    anyhow, AgentView, DaemonCommand, Duration, Map, QueueBrowseDirection, QueueLane, Result,
    SessionUi, Value, UI_REQUEST_TIMEOUT_MS,
};

impl SessionUi {
    pub(crate) fn sync_queue_selection(&mut self, view: &mut AgentView) {
        view.queue_selected = self.queue_selection.selected().cloned();
    }

    /// Report a queue-edit adoption event (`tui queue edited`), fire-and-forget.
    fn emit_queue_edit(&self, action: &'static str) {
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.queue_edited(action).await;
            });
        }
    }

    /// Move the selection one parked message older/newer and show it in the editor. Entering the
    /// browse stashes the editor draft; reaching the draft again restores it.
    pub(crate) fn browse_queue_selection(
        &mut self,
        direction: QueueBrowseDirection,
        view: &mut AgentView,
    ) {
        let entering = !self.queue_selection.is_browsing();
        let text = self
            .queue_selection
            .browse(&view.queued, &view.editor.get_text(), direction);
        if let Some(text) = text {
            view.editor.set_text(&text);
        }
        // Entering the browse (first selection of a parked message) is the
        // queue-edit adoption signal; per-arrow moves are not.
        if entering && self.queue_selection.is_browsing() {
            self.emit_queue_edit("select");
        }
        self.sync_queue_selection(view);
    }

    /// Send one `mutate_queued_message` and return its status string (every outcome answers
    /// `success` with `{ status }`; only a malformed request fails the command).
    async fn queue_mutation(
        &self,
        lane: QueueLane,
        index: usize,
        expected_text: &str,
        mutation: Value,
    ) -> Result<Option<String>> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::MutateQueuedMessage {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    lane: Value::String(lane.wire_name().to_string()),
                    index: index as u64,
                    expected_text: expected_text.to_string(),
                    mutation,
                    rest: Map::default(),
                },
            )
            .await
            .map_err(|error| anyhow!("{error:#}"))?;
        Ok(data
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    /// Swap the selected message with the adjacent user message in its lane (a silent no-op at the
    /// lane's first/last user message); the move is mirrored locally — the `session_action_update`
    /// event may land after the response.
    pub(crate) async fn move_queue_selection(
        &mut self,
        direction: i64,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(selected) = self.queue_selection.selected().cloned() else {
            return Ok(());
        };
        // Internal items keep their positions: the swap partner is the adjacent user item, so
        // the daemon's move direction spans any internal items between the two.
        let Some(target) = self.queue_selection.reorder_target(direction) else {
            return Ok(());
        };
        let status = self
            .queue_mutation(
                selected.lane,
                selected.index,
                &selected.text,
                serde_json::json!({ "type": "move", "direction": target as i64 - selected.index as i64 }),
            )
            .await;
        match status {
            Ok(Some(status)) if status == "applied" => {
                self.emit_queue_edit("reorder");
                crate::queued::mirror_lane_move(
                    &mut view.queued,
                    selected.lane,
                    selected.index,
                    target,
                );
                self.queue_selection.refresh_at(
                    &view.queued,
                    selected.lane,
                    target,
                    &selected.text,
                );
                self.sync_queue_selection(view);
                self.dirty = true;
            }
            Ok(Some(status)) => self.note(&queue_mutation_status_note(&status, false), view),
            // A malformed request (never sent by this build) surfaces the
            // daemon error like every other command.
            Ok(None) => {}
            Err(error) => self.note(&format!("{error:#}"), view),
        }
        Ok(())
    }

    /// Apply the edited editor text to the selected parked message: empty text deletes it;
    /// otherwise the edit replaces it and moves it to `target_lane` (Enter steers).
    pub(crate) async fn apply_queue_selection(
        &mut self,
        text: &str,
        target_lane: QueueLane,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(selected) = self.queue_selection.selected().cloned() else {
            return Ok(());
        };
        let trimmed = text.trim();
        // `images` stays absent on a replace: the server keeps the item's
        // attachments (some markers cannot be resolved by this client).
        let mutation = if trimmed.is_empty() {
            serde_json::json!({ "type": "delete" })
        } else {
            serde_json::json!({ "type": "replace", "text": trimmed, "lane": target_lane.wire_name() })
        };
        let status = self
            .queue_mutation(selected.lane, selected.index, &selected.text, mutation)
            .await;
        match status {
            Ok(Some(status)) if status == "applied" => {
                self.emit_queue_edit(if trimmed.is_empty() { "delete" } else { "edit" });
                if !trimmed.is_empty() {
                    view.editor.add_to_history(trimmed);
                }
                let draft = self.queue_selection.reset();
                view.editor.set_text(&draft);
            }
            Ok(Some(status)) => {
                // Enter submissions clear the editor before the mutation;
                // a failed edit returns to the editor, never swallowed.
                view.editor.set_text(text);
                self.note(&queue_mutation_status_note(&status, true), view);
            }
            Ok(None) => {}
            Err(error) => {
                view.editor.set_text(text);
                self.note(&format!("{error:#}"), view);
            }
        }
        self.sync_queue_selection(view);
        self.dirty = true;
        Ok(())
    }
}

/// The mutation status vocabulary (`applied`, `rejected`, `invalid`,
/// `unsupported`) maps to the status rows; `is_edit` picks the edit phrasing.
fn queue_mutation_status_note(status: &str, is_edit: bool) -> String {
    match status {
        "invalid" => {
            "Edited command is not a valid session command; edit kept in the editor".to_string()
        }
        "unsupported" => "Queue editing requires a newer daemon".to_string(),
        _ if is_edit => "Queue changed; edit kept in the editor".to_string(),
        _ => "Queue changed; reorder not applied".to_string(),
    }
}

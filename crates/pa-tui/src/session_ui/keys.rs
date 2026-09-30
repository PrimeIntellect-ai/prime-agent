//! The terminal input grammar: key dispatch, mouse reports, paste,
//! selection/auto-scroll, and the input-state seams.
use super::{
    key_event_to_id, AgentView, ChatEntry, DaemonCommand, DockFocusSource, Duration,
    EffortPickerAction, Instant, KeyEvent, Map, QueueBrowseDirection, QueueLane, Result, SessionUi,
    StatusKind, SubmitBehavior,
};

/// How long the Ctrl+C exit hint arms the second-press exit.
const CTRL_C_EXIT_HINT_MS: u64 = 2_000;
/// How long a drag must hold the window edge before auto-scroll starts.
const SELECTION_AUTO_SCROLL_DELAY: Duration = Duration::from_millis(150);

const ESCAPE_REPEAT_WINDOW_MS: std::time::Duration = std::time::Duration::from_millis(500);

/// One armed auto-scroll: the drag's last position and when the scroll window opened.
#[derive(Debug, Clone)]
pub(super) struct SelectionAutoScroll {
    direction: isize,
    row: usize,
    col: usize,
    started: Instant,
}

impl SessionUi {
    /// The OSC 52 sequences the headless run captured (TS writes them to
    /// stdout; headless verification reads them here).
    pub(crate) fn take_osc_emissions(&mut self) -> Vec<String> {
        match std::mem::replace(&mut self.osc_sink, crate::clipboard::OscSink::Stdout) {
            crate::clipboard::OscSink::Buffer(buffer) => {
                vec![String::from_utf8_lossy(&buffer).into_owned()]
            }
            crate::clipboard::OscSink::Stdout => Vec::new(),
        }
    }

    /// The armed double-Escape action, taken once inside the window.
    fn take_escape_repeat_action(&mut self) -> Option<&'static str> {
        let action = self.escape_repeat_action;
        if let Some(until) = self.escape_repeat_until {
            if Instant::now() < until {
                self.escape_repeat_action = None;
                self.escape_repeat_until = None;
                return action;
            }
        }
        self.escape_repeat_action = None;
        self.escape_repeat_until = None;
        None
    }

    /// Arm the double-Escape action for the repeat window.
    fn arm_escape_repeat(&mut self, action: &'static str) {
        self.escape_repeat_action = Some(action);
        self.escape_repeat_until = Some(Instant::now() + ESCAPE_REPEAT_WINDOW_MS);
    }

    /// The Ctrl+C exit hint is armed: a second press inside the window terminates the client.
    pub(super) fn ctrl_c_hint_visible(&self) -> bool {
        self.ctrl_c_hint_until
            .is_some_and(|until| Instant::now() < until)
    }

    fn show_ctrl_c_hint(&mut self) {
        self.ctrl_c_hint_until = Some(Instant::now() + Duration::from_millis(CTRL_C_EXIT_HINT_MS));
    }

    /// Disarm the hint: escape, editing text, or shutdown.
    pub(super) fn clear_ctrl_c_hint(&mut self) {
        self.ctrl_c_hint_until = None;
    }

    /// The armed hint's expiry: the render loop arms its deadline there so the expired hint
    /// repaints away, not when the next unrelated event arrives.
    pub(crate) fn ctrl_c_hint_expiry(&self) -> Option<std::time::Instant> {
        self.ctrl_c_hint_until
            .filter(|until| std::time::Instant::now() < *until)
    }

    /// While mouse reporting is active the terminal gates native link handling, so clicks the TUI
    /// consumes open their OSC 8 targets themselves; reports are consumed even while a picker,
    /// selector, or loader owns the frame: the wheel never scrolls behind one, but its rows select.
    pub(crate) fn handle_mouse(&mut self, event: crate::mouse::MouseEvent, view: &mut AgentView) {
        if !crate::mouse_tracking::active() {
            return;
        }
        let overlay_focused = view.model_picker.is_some()
            || view.effort_picker.is_some()
            || view.heartbeats_picker.is_some()
            || view.goal_panel.is_some()
            || view.bash_view.is_some()
            || view.info_panel.is_some()
            || view.tree_selector.is_some()
            || view.fork_selector.is_some()
            || view.share_loader.is_some()
            || view.mcp_view.is_some()
            || view.onboarding.is_some();
        let left = event.button == crate::mouse::BUTTON_LEFT;
        let release_was_drag = left && !event.press && self.left_mouse_dragged;
        let row = event.y.saturating_sub(1) as usize;
        let col = event.x.saturating_sub(1) as usize;
        if left && event.press {
            self.left_mouse_dragged = event.motion;
            if !event.motion {
                self.pressed_hyperlink = view.hyperlink_at(row, col);
                self.escape_tree_shortcut_spent = false;
            }
        }
        if let Some(delta) = crate::mouse::wheel_scroll_delta(&event) {
            if !overlay_focused {
                view.scroll_by(delta);
                self.dirty = true;
            }
            return;
        }
        // The hover report (operator directive 2026-09-26: `?1003` any-event
        // tracking delivers it): re-render only when the hovered row changed.
        if event.button == crate::mouse::BUTTON_NONE && event.motion {
            if view.note_hover(row, col) {
                self.dirty = true;
            }
            return;
        }
        let left_press = event.press && left;
        let mut open_pressed_link = false;
        if overlay_focused {
            // The frame surface first (its rows are the selectable spans), then the window.
            self.stop_selection_auto_scroll();
            if left_press && !event.motion {
                self.record_pressed_click(view, &event);
                if !view.begin_frame_selection(row, col) {
                    view.begin_selection(row, col);
                }
                self.dirty = true;
            } else if left_press && event.motion {
                self.left_mouse_dragged = true;
                view.extend_active_selection(row, col);
                self.dirty = true;
            } else if !event.press && view.has_selection() {
                let text = view.end_active_selection();
                if let Some(text) = text {
                    self.copy_selection(&text, view);
                }
                self.dirty = true;
            } else if !event.press {
                view.clear_selection();
                open_pressed_link = left && !event.motion && !release_was_drag;
            }
        } else if left_press && !event.motion {
            self.stop_selection_auto_scroll();
            self.record_pressed_click(view, &event);
            if !view.begin_selection(row, col) {
                view.begin_frame_selection(row, col);
            }
            self.dirty = true;
        } else if left_press && event.motion {
            self.left_mouse_dragged = true;
            view.extend_active_selection(row, col);
            self.update_selection_auto_scroll(view, row, col);
            self.dirty = true;
        } else if !event.press && view.has_selection() {
            self.stop_selection_auto_scroll();
            let text = view.end_active_selection();
            if let Some(text) = text {
                self.copy_selection(&text, view);
            }
            self.dirty = true;
        } else if !event.press {
            self.stop_selection_auto_scroll();
            view.clear_selection();
            open_pressed_link = left && !event.motion && !release_was_drag;
        }
        // A plain left release opens the pressed link first, then the link under the release; with
        // no link there, it fires the click target recorded at the press.
        if open_pressed_link {
            let url = self
                .pressed_hyperlink
                .take()
                .or_else(|| view.hyperlink_at(row, col));
            if let Some(url) = url {
                self.open_hyperlink(&url);
            } else if !event.shift && !event.alt && !event.ctrl {
                // The dispatch is gated on the release's modifiers: modified clicks stay
                // selection-only.
                self.dispatch_plain_click(view, row);
            }
        }
        // Clear the press state on every left release so a later release can
        // never open a stale press; the click target rides the same cleanup.
        if left && !event.press {
            self.left_mouse_dragged = false;
            self.pressed_hyperlink = None;
            self.pressed_click = None;
        }
    }

    /// Open one clicked link; a headless run has no terminal, so it records the
    /// URL for its verifier instead.
    fn open_hyperlink(&mut self, url: &str) {
        let Some(href) = crate::hyperlinks::openable_href(url) else {
            return;
        };
        self.opened_urls.push(href.clone());
        if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
            crate::browser::open_in_browser(&href);
        }
    }

    /// OSC 52 works locally, over SSH, and through tmux (`set-clipboard`), so the write goes
    /// straight to the terminal; a headless run records the text for its verifier instead. The
    /// success toast is the ephemeral overlay, not a chat row (sanctioned divergence).
    fn copy_selection(&mut self, text: &str, view: &mut AgentView) {
        use base64::Engine;
        use std::io::Write;
        let lines = text.lines().count().max(1);
        self.copies.push(text.to_string());
        self.track_selection(lines);
        if !std::io::IsTerminal::is_terminal(&std::io::stdout()) {
            self.toast("Copied selection to clipboard", view);
            return;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        let mut out = std::io::stdout();
        match out.write_all(format!("\x1b]52;c;{encoded}\x07").as_bytes()) {
            Ok(()) => {
                let _ = out.flush();
                self.toast("Copied selection to clipboard", view);
            }
            Err(error) => {
                self.error_row(&format!("Failed to copy selection: {error}"), view);
            }
        }
    }

    fn update_selection_auto_scroll(&mut self, view: &AgentView, row: usize, col: usize) {
        match view.selection_auto_scroll_direction(row) {
            Some(direction) => match &mut self.selection_auto_scroll {
                Some(armed) if armed.direction == direction => {
                    armed.row = row;
                    armed.col = col;
                }
                _ => {
                    self.selection_auto_scroll = Some(SelectionAutoScroll {
                        direction,
                        row,
                        col,
                        started: Instant::now(),
                    });
                }
            },
            None => self.selection_auto_scroll = None,
        }
    }

    pub(crate) fn stop_selection_auto_scroll(&mut self) {
        self.selection_auto_scroll = None;
    }

    /// Whether the auto-scroll driver is armed: the run loop's quiet tick keys on
    /// it (an idle surface parks the tick).
    pub(crate) fn selection_auto_scroll_armed(&self) -> bool {
        self.selection_auto_scroll.is_some()
    }

    /// One idle tick of the auto-scroll (the run loop's 50 ms arm stands in
    /// for TS's timer): after the hold window each tick scrolls one line set.
    pub(crate) fn selection_auto_scroll_tick(&mut self, view: &mut AgentView) {
        let Some(armed) = self.selection_auto_scroll.clone() else {
            return;
        };
        if Instant::now().duration_since(armed.started) < SELECTION_AUTO_SCROLL_DELAY {
            return;
        }
        if view.selection_auto_scroll_direction(armed.row) != Some(armed.direction)
            || !view.scroll_selection(armed.direction, armed.col)
        {
            self.selection_auto_scroll = None;
            return;
        }
        self.dirty = true;
    }

    /// A bracketed paste goes to the focused input.
    pub(crate) fn handle_paste(&mut self, text: &str, view: &mut AgentView) {
        // The overlays own the whole frame while open (like their key
        // dispatch): the paste lands in the overlay's own input or is
        // consumed by the input-less ones, never in the hidden editor
        // prompt behind.
        if view.route_paste(text) {
            self.dirty = true;
            return;
        }
        let _ = view.editor.handle_paste(text);
    }

    async fn handle_effort_picker_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The picker consumes Ctrl+C (close, not exit); report it so the force-quit
        // guard can disarm.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .effort_picker
            .as_mut()
            .map(|picker| picker.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(EffortPickerAction::None) | None => {}
            Some(EffortPickerAction::Cancel) => {
                view.effort_picker = None;
                self.dirty = true;
            }
            Some(EffortPickerAction::Apply { level }) => {
                view.effort_picker = None;
                self.apply_thinking_level(&level, view).await;
            }
        }
        Ok(())
    }

    pub(crate) async fn handle_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
        running: &mut bool,
    ) -> Result<()> {
        // Any non-Escape key re-arms the double-Esc tree shortcut (one shot per input chain);
        // Escape itself never resets, so repeated Escape converges to the inert empty state.
        if key_event_to_id(&key).is_some_and(|id| id != "escape") {
            self.escape_tree_shortcut_spent = false;
        }
        // The `/model` picker owns the frame while open: its keys go before the
        // editor, viewport keys, and Ctrl+C.
        if view.model_picker.is_some() {
            return self.handle_model_picker_key(key, view).await;
        }
        if view.effort_picker.is_some() {
            return self.handle_effort_picker_key(key, view).await;
        }
        if view.mcp_view.is_some() {
            return self.handle_mcp_view_key(key, view);
        }
        if view.heartbeats_picker.is_some() {
            return self.handle_heartbeats_picker_key(key, view).await;
        }
        if view.bash_view.is_some() {
            return self.handle_bash_view_key(key, view);
        }
        if view.goal_panel.is_some() {
            return self.handle_goal_panel_key(key, view);
        }
        if view.info_panel.is_some() {
            return self.handle_info_panel_key(key, view);
        }
        if view.tree_selector.is_some() {
            return self.handle_tree_selector_key(key, view).await;
        }
        if view.fork_selector.is_some() {
            return self.handle_fork_selector_key(key, view).await;
        }
        if view.confirm.is_some() {
            return self.handle_confirm_key(key, view).await;
        }
        if view.provider_auth.is_some() {
            return self.handle_provider_auth_key(key, view).await;
        }
        if view.auth_panel.is_some() {
            return self.handle_auth_panel_key(key, view);
        }
        if view.settings_menu.is_some() {
            return self.handle_settings_menu_key(key, view).await;
        }
        // The `/share` loader owns the frame while an upload runs.
        if view.share_loader.is_some() {
            return self.handle_share_loader_key(key, view);
        }
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // Dispatch order: the transcript viewport keys, then the focused subagent summary line,
        // then the editor, then the app actions in registration order. Every match goes through the
        // effective bindings, so a `keybindings.json` override moves both handler and hint.
        let (page_up, page_down, to_top, follow) = {
            let kb = view.editor.keybindings();
            (
                kb.matches(&id, "tui.viewport.pageUp"),
                kb.matches(&id, "tui.viewport.pageDown"),
                kb.matches(&id, "tui.viewport.top"),
                kb.matches(&id, "tui.viewport.follow"),
            )
        };
        if page_up {
            // The viewport consumes the key before the editor, so a selection must
            // collapse here or it survives the scroll as a stale replace range.
            view.editor.clear_selection();
            view.scroll_by(-(view.page_size() as isize));
            self.track_scroll("page_up", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        if page_down {
            view.editor.clear_selection();
            view.scroll_by(view.page_size() as isize);
            self.track_scroll("page_down", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        if to_top {
            view.scroll_to_top();
            self.track_scroll("top", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        if follow {
            view.scroll_to_bottom();
            self.track_scroll("follow", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        // The activity dock owns focus while focused; every other key falls
        // through after releasing the focus.
        if self.subagents_focused {
            let kb = view.editor.keybindings();
            if kb.matches(&id, "tui.select.confirm") || kb.matches(&id, "app.subagents.focus") {
                self.open_dock_group_view(view);
                return Ok(());
            }
            if id == "left" && self.activity_group == crate::chrome::ActivityGroup::Subagents {
                // Left from the subagents selection opens the agents view (the operator's
                // 2026-09-28 muscle-memory ask; left reads as `agents back` everywhere else).
                self.open_dock_group_view(view);
                return Ok(());
            }
            if id == "left" || id == "right" {
                // One press, one group: the step wraps at the row's ends, so an empty group is
                // still visited (the operator's 2026-09-26 directive).
                let direction = if id == "left" {
                    crate::chrome::ActivityDirection::Prev
                } else {
                    crate::chrome::ActivityDirection::Next
                };
                self.activity_group = self
                    .activity_dock_state()
                    .step(self.activity_group, direction);
                self.update_subagent_summary(view);
                self.dirty = true;
                return Ok(());
            }
            if kb.matches(&id, "tui.select.up")
                || kb.matches(&id, "tui.select.cancel")
                || kb.matches(&id, "app.agents.back")
            {
                self.subagents_focused = false;
                self.update_subagent_summary(view);
                self.dirty = true;
                return Ok(());
            }
            if kb.matches(&id, "app.tools.expand") {
                self.cycle_detail(view);
                return Ok(());
            }
            self.subagents_focused = false;
            self.update_subagent_summary(view);
        }
        // The editor's own ctrl+v is otherwise unbound, so the exact match is
        // safe before any editor motion.
        if view
            .editor
            .keybindings()
            .matches(&id, "app.clipboard.pasteImage")
        {
            self.handle_clipboard_image_paste(view).await;
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.input.clear") {
            // The completion surface consumes Esc: the open dropdown closes and the abort ladder
            // never runs — closing a menu must not abort a running turn (deliberate divergence: the
            // TS custom-editor overlay propagates Esc to the interrupt after closing).
            if view.editor.is_showing_autocomplete() || view.editor.has_pending_autocomplete() {
                view.editor.cancel_autocomplete();
                self.clear_ctrl_c_hint();
                return Ok(());
            }
            // An active selection consumes the first Escape (standard editors' drop-the-selection
            // press): the interrupt/clear ladder runs on the next press.
            if view.editor.has_selection() {
                view.editor.clear_selection();
                self.clear_ctrl_c_hint();
                self.dirty = true;
                return Ok(());
            }
            self.clear_ctrl_c_hint();
            // An open side-question pane owns the key: the running turn aborts and
            // the pane closes; the armed escape-repeat disarms first.
            if view.side_pane.is_some() {
                self.escape_repeat_action = None;
                self.escape_repeat_until = None;
                self.clear_side_question(true, view);
                return Ok(());
            }
            // Leaving browse mode restores the stashed draft instead of arming an
            // accidental empty-submit delete of the selected queued message.
            if self.queue_selection.has_draft() {
                let draft = self.queue_selection.reset();
                view.editor.set_text(&draft);
                self.sync_queue_selection(view);
                self.dirty = true;
                return Ok(());
            }
            // Double-Escape: the second press within the window opens the tree when the session is
            // idle or the editor empty, and clears the input otherwise. The repeat's tree action is
            // one shot per input chain (the operator's 2026-09-29 Esc-overflow ruling).
            if let Some(action) = self.take_escape_repeat_action() {
                if action == "tree" {
                    self.escape_tree_shortcut_spent = true;
                    self.open_tree_selector(view, None).await?;
                } else {
                    view.editor.set_text("");
                }
                self.dirty = true;
                return Ok(());
            }
            let action = if self.turn_active || view.editor.get_text().trim().is_empty() {
                "tree"
            } else {
                "clear"
            };
            if action == "tree" && self.escape_tree_shortcut_spent {
                // The gesture already fired: this press interrupts like every Escape
                // but arms no reopen.
                self.interrupt_running_work(view);
                return Ok(());
            }
            self.arm_escape_repeat(action);
            // The repeat arms, then the same abort ladder as the Ctrl+C interrupt
            // runs, minus the exit hint.
            self.interrupt_running_work(view);
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.exit") && view.editor.get_text().is_empty() {
            self.exit_reason = "ctrl_d";
            *running = false;
            return Ok(());
        }
        // `app.interrupt` routes through the `app.clear` handlers; only the
        // second-press exit is ctrl+c's alone.
        let interrupt = view.editor.keybindings().matches(&id, "app.interrupt");
        if interrupt || view.editor.keybindings().matches(&id, "app.clear") {
            // One handled Ctrl+C press: the force-quit guard disarms once every
            // observed press of the pair was handled without an exit.
            if id == "ctrl+c" {
                self.exit_guard.note_ctrl_c_handled();
            }
            if view.editor.is_showing_autocomplete() {
                view.editor.cancel_autocomplete();
                self.clear_ctrl_c_hint();
                return Ok(());
            }
            // A second press inside the hint window shuts down unconditionally —
            // no turn wait, no abort wait.
            if self.ctrl_c_hint_visible() && !interrupt {
                self.exit_reason = "ctrl_c_twice";
                *running = false;
                return Ok(());
            }
            // A running side question aborts first; the pane stays mounted and renders the
            // cancelled turn when the terminal event streams back.
            if let Some(side_question_id) = self.active_side_question_id.clone() {
                let client = self.client.clone();
                let active_session_id = self.active_session_id.clone();
                let notes = self.notes.clone();
                tokio::spawn(async move {
                    if let Err(error) = client
                        .request_ok(DaemonCommand::AbortSideQuestion {
                            id: None,
                            active_session_id,
                            side_question_id,
                            rest: Map::default(),
                        })
                        .await
                    {
                        let _ = notes.send(format!("the side question abort failed: {error:#}"));
                    }
                });
            }
            self.interrupt_running_work(view);
            self.show_ctrl_c_hint();
            self.dirty = true;
            return Ok(());
        }
        // Suspend hands the terminal to the shell; the loop performs the cycle right after
        // dispatch, and the SIGCONT continuation re-applies raw mode and mouse tracking.
        if view.editor.keybindings().matches(&id, "app.suspend") {
            if crate::suspend::supported() {
                self.suspend_requested = true;
            } else {
                self.note("Suspend to background is not supported on Windows", view);
            }
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.model.select") {
            // A completion request parked by this same press must not materialize
            // a dropdown over the picker on the next idle tick.
            view.editor.cancel_autocomplete();
            self.open_model_picker(view, "").await?;
            // The picker opens over the user's own text (a draft or browsed
            // message), so its apply must keep it.
            self.picker_restored_draft = true;
            self.track_menu_opened("model", "shortcut");
            self.dirty = true;
            return Ok(());
        }
        if view
            .editor
            .keybindings()
            .matches(&id, "app.model.cycleForward")
        {
            self.cycle_model(pa_types::daemon::CycleDirection::Forward, view)
                .await;
            return Ok(());
        }
        if view
            .editor
            .keybindings()
            .matches(&id, "app.model.cycleBackward")
        {
            self.cycle_model(pa_types::daemon::CycleDirection::Backward, view)
                .await;
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.tools.expand") {
            self.cycle_detail(view);
            return Ok(());
        }
        if view
            .editor
            .keybindings()
            .matches(&id, "app.subagents.focus")
        {
            self.focus_subagents_summary(&DockFocusSource::Shortcut, view);
            self.dirty = true;
            return Ok(());
        }
        // A configured editor hands off through the loop (the terminal belongs
        // to the renderer).
        if view
            .editor
            .keybindings()
            .matches(&id, "app.editor.external")
        {
            match crate::external_editor::editor_command() {
                None => {
                    view.push_entry(ChatEntry::Status {
                        text: "\u{26a0} No editor configured. Set $VISUAL or $EDITOR environment variable."
                            .to_string(),
                        kind: StatusKind::Warning,
                    });
                    self.last_status_index = None;
                    if let Some(telemetry) = self.telemetry.clone() {
                        tokio::spawn(async move {
                            telemetry.external_editor_used("no_editor").await;
                        });
                    }
                }
                Some(command) => {
                    self.external_editor_request = Some(command);
                }
            }
            self.dirty = true;
            return Ok(());
        }
        // Stash with a draft, restore with an empty editor; the manual stash
        // returns only on this key, never on a chat open or switch landing.
        if view.editor.keybindings().matches(&id, "app.prompt.stash") {
            // A queue browse parks the real draft; leave the browse first so the stash acts on the
            // user's own draft (the disarmed browse cannot turn the next Enter into a delete).
            if self.queue_selection.has_draft() {
                let draft = self.queue_selection.reset();
                view.editor.set_text(&draft);
                self.dirty = true;
            } else if self.queue_selection.is_browsing() {
                self.queue_selection.reset();
                self.dirty = true;
            }
            self.sync_queue_selection(view);
            self.handle_prompt_stash(view);
            return Ok(());
        }
        // The `/new` flow; fires with a draft too (no editor-text gate).
        if view.editor.keybindings().matches(&id, "app.session.new") {
            self.start_new_session(view).await?;
            self.dirty = true;
            return Ok(());
        }
        // Open the agents view; fires with a draft too — the draft is stashed
        // on the exit path and returns when the chat reopens.
        if view.editor.keybindings().matches(&id, "app.session.resume") {
            if self.return_to_agents_view {
                self.open_agents_view = true;
                self.exit_requested = true;
            } else {
                self.note(
                    "The agents view needs a daemon-hosted session; start normally (without --no-session) to browse sessions",
                    view,
                );
            }
            self.dirty = true;
            return Ok(());
        }
        // With an empty editor the bound key hands the terminal to the agents
        // view; with text it stays an editor cursor motion.
        if view.editor.keybindings().matches(&id, "app.agents.back")
            && view.editor.get_text().trim().is_empty()
        {
            if self.return_to_agents_view {
                self.open_agents_view = true;
                self.exit_requested = true;
            } else {
                self.note(
                    "The agents view needs a daemon-hosted session; start normally (without --no-session) to browse sessions",
                    view,
                );
            }
            self.dirty = true;
            return Ok(());
        }
        if view.editor.get_text().trim().is_empty() {
            let kb = view.editor.keybindings();
            if kb.matches(&id, "app.session.tree") {
                self.open_tree_selector(view, None).await?;
                self.dirty = true;
                return Ok(());
            }
            if kb.matches(&id, "app.session.fork") {
                self.open_fork_selector(view).await?;
                self.dirty = true;
                return Ok(());
            }
        }
        {
            let (older, newer, earlier, later) = {
                let kb = view.editor.keybindings();
                (
                    kb.matches(&id, "app.message.navigateOlder"),
                    kb.matches(&id, "app.message.navigateNewer"),
                    kb.matches(&id, "app.message.moveEarlier"),
                    kb.matches(&id, "app.message.moveLater"),
                )
            };
            if older {
                self.browse_queue_selection(QueueBrowseDirection::Older, view);
                self.dirty = true;
                return Ok(());
            }
            if newer {
                self.browse_queue_selection(QueueBrowseDirection::Newer, view);
                self.dirty = true;
                return Ok(());
            }
            if earlier {
                self.move_queue_selection(-1, view).await?;
                return Ok(());
            }
            if later {
                self.move_queue_selection(1, view).await?;
                return Ok(());
            }
        }
        // The follow-up key: parks the message on the follow-up lane and delivers when the run goes
        // idle; while a queued message is selected, the edit re-parks it there.
        if view
            .editor
            .keybindings()
            .matches(&id, "app.message.followUp")
        {
            if self.queue_selection.is_browsing() || !view.editor.get_text().trim().is_empty() {
                view.editor.submit();
                for event in view.editor.take_events() {
                    if let crate::editor::EditorEvent::Submitted(text) = event {
                        if self.queue_selection.is_browsing() {
                            self.apply_queue_selection(&text, QueueLane::FollowUp, view)
                                .await?;
                        } else {
                            view.editor.add_to_history(&text);
                            self.submit_prompt(&text, SubmitBehavior::FollowUp, view)
                                .await?;
                        }
                    }
                }
            }
            self.dirty = true;
            return Ok(());
        }
        // Tab in a picker-command argument context opens the command's menu prefilled with the
        // typed partial. An open completion dropdown keeps its own Tab; this is the no-menu path.
        if view.editor.keybindings().matches(&id, "tui.input.tab")
            && !view.editor.is_showing_autocomplete()
        {
            if let Some((command, partial)) = view.editor.picker_argument_context() {
                // A completion request parked by this same press must not materialize
                // a dropdown over the menu on the next tick.
                view.editor.cancel_autocomplete();
                // The menu takes the frame from a queue browse: the next Enter must submit a
                // prompt, not route into apply_queue_selection; ending the browse restores the
                // stashed draft, so a failed menu open loses nothing.
                if matches!(command.as_str(), "model" | "mcp") {
                    if self.queue_selection.has_draft() {
                        let draft = self.queue_selection.reset();
                        view.editor.set_text(&draft);
                        self.picker_restored_draft = true;
                    } else {
                        self.queue_selection.reset();
                    }
                    self.sync_queue_selection(view);
                }
                match command.as_str() {
                    "model" => {
                        self.open_model_picker(view, partial.trim()).await?;
                        // Belt-and-braces (the picker always mounts here); keeps the
                        // failed-open contract symmetric with the mcp arm.
                        if view.model_picker.is_none() {
                            self.picker_restored_draft = false;
                        }
                        self.track_menu_opened("model", "tab");
                        self.dirty = true;
                        return Ok(());
                    }
                    "mcp" => {
                        self.open_mcp_view("/mcp", view, partial.trim()).await?;
                        // A failed roster load leaves no view mounted; the flag must not leak into
                        // the NEXT picker.
                        if view.mcp_view.is_none() {
                            self.picker_restored_draft = false;
                        }
                        self.track_menu_opened("mcp", "tab");
                        self.dirty = true;
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
        // TS `CustomEditor.handleInput`'s move-below-prompt hook
        // (`onMoveBelowPrompt` -> `focusSubagentSummary`): Down at the end
        // of the prompt — no autocomplete open, no history browse, the
        // cursor at the last line's end — hands the focus to the activity
        // dock in every session shape, all-zero counts included; every
        // other Down falls through to the editor's cursor motion. Only the
        // tray override (the armed exit hint, the streaming follow-up
        // hint) keeps the editor's Down.
        if view
            .editor
            .keybindings()
            .matches(&id, "tui.editor.cursorDown")
            && !view.editor.is_showing_autocomplete()
            && !view.editor.is_history_navigation_active()
            && view.editor.is_cursor_at_end()
            && self.focus_subagents_summary(&DockFocusSource::PromptDown, view)
        {
            // The selection collapses with the handoff, or a later keystroke would
            // fall back through and replace the stale range.
            view.editor.clear_selection();
            self.dirty = true;
            return Ok(());
        }
        view.editor.handle_input(&id);
        if !view.editor.get_text().is_empty() {
            self.clear_ctrl_c_hint();
        }
        for event in view.editor.take_events() {
            match event {
                crate::editor::EditorEvent::Submitted(text) => {
                    if self.queue_selection.is_browsing() {
                        self.apply_queue_selection(&text, QueueLane::Steering, view)
                            .await?;
                    } else {
                        view.editor.add_to_history(&text);
                        self.submit_prompt(&text, SubmitBehavior::Steer, view)
                            .await?;
                    }
                }
                crate::editor::EditorEvent::ClipboardWrite(text) => {
                    // A selection cut/copy writes OSC 52 straight to the terminal: a stalled
                    // xclip/wl-copy/pbcopy can neither freeze the prompt nor leak an unkillable
                    // blocking task; a headless run keeps the synchronous platform chain.
                    if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
                        use std::io::Write;
                        // `osc52::sequence`'s payload cap applies: an oversized sequence
                        // desynchronizes the terminal, so the copy reports failure instead of
                        // writing it.
                        match crate::osc52::sequence(&text) {
                            Some(sequence) => {
                                let mut out = std::io::stdout();
                                match out.write_all(sequence.as_bytes()) {
                                    Ok(()) => {
                                        let _ = out.flush();
                                        self.toast("Copied selection to clipboard", view);
                                    }
                                    Err(error) => {
                                        self.error_row(
                                            &format!("Failed to copy selection: {error}"),
                                            view,
                                        );
                                    }
                                }
                            }
                            None => {
                                self.error_row("Failed to copy selection to clipboard", view);
                            }
                        }
                    } else {
                        match crate::clipboard::copy_to_clipboard(&text, &mut self.osc_sink) {
                            Ok(()) => self.toast("Copied selection to clipboard", view),
                            Err(message) => self.error_row(&message, view),
                        }
                    }
                }
                _ => {}
            }
        }
        self.dirty = true;
        Ok(())
    }
}

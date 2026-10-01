//! The keys concern: the terminal input grammar — key dispatch, mouse
//! reports, paste, selection/auto-scroll, and the input-state seams.
use super::{
    key_event_to_id, AgentView, ChatEntry, DaemonCommand, DockFocusSource, Duration,
    EffortPickerAction, Instant, KeyEvent, Map, QueueBrowseDirection, QueueLane, Result, SessionUi,
    StatusKind, SubmitBehavior,
};

/// How long the Ctrl+C exit hint arms the second-press exit (TS
/// `EXIT_HINT_DURATION_MS`).
const CTRL_C_EXIT_HINT_MS: u64 = 2_000;
/// TS `SELECTION_AUTO_SCROLL_DELAY_MS`: how long a drag must hold the
/// window edge before the auto-scroll starts.
const SELECTION_AUTO_SCROLL_DELAY: Duration = Duration::from_millis(150);

/// The double-Escape repeat window (TS `ESCAPE_REPEAT_WINDOW_MS`).
const ESCAPE_REPEAT_WINDOW_MS: std::time::Duration = std::time::Duration::from_millis(500);

/// One armed auto-scroll (TS `selectionAutoScrollTimer` state): the drag's
/// last position and when the scroll window opened.
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

    /// The armed double-Escape action, taken once inside the window (TS
    /// `takeEscapeRepeatAction`).
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

    /// Arm the double-Escape action for 500ms (TS `armEscapeRepeat`): the
    /// tree when the session is idle or the editor empty, the clear action
    /// otherwise.
    fn arm_escape_repeat(&mut self, action: &'static str) {
        self.escape_repeat_action = Some(action);
        self.escape_repeat_until = Some(Instant::now() + ESCAPE_REPEAT_WINDOW_MS);
    }

    /// The Ctrl+C exit hint is armed (TS `isCtrlCExitHintVisible`): a
    /// second press inside the window terminates the client.
    pub(super) fn ctrl_c_hint_visible(&self) -> bool {
        self.ctrl_c_hint_until
            .is_some_and(|until| Instant::now() < until)
    }

    /// Arm the Ctrl+C exit hint (TS `showCtrlCExitHint`).
    fn show_ctrl_c_hint(&mut self) {
        self.ctrl_c_hint_until = Some(Instant::now() + Duration::from_millis(CTRL_C_EXIT_HINT_MS));
    }

    /// Disarm the hint (TS `clearCtrlCExitHint`: escape, editing text, or
    /// shutdown).
    pub(super) fn clear_ctrl_c_hint(&mut self) {
        self.ctrl_c_hint_until = None;
    }

    /// The armed hint's expiry instant while its window is still open
    /// (the render loop arms its deadline there so the expired hint
    /// repaints away, TS `showCtrlCExitHint`'s setTimeout +
    /// requestRender; without it the stale tray row survives until the
    /// next unrelated event).
    pub(crate) fn ctrl_c_hint_expiry(&self) -> Option<std::time::Instant> {
        self.ctrl_c_hint_until
            .filter(|until| std::time::Instant::now() < *until)
    }

    /// A mouse report (TS `handleFullscreenInput`'s mouse branches):
    /// wheel turns scroll the transcript window by three lines; a left
    /// press starts a selection (transcript, or the frame surface when the
    /// press is outside the window), a drag extends it with edge
    /// auto-scroll, and a release copies the spanned text out through OSC
    /// 52. A release without a drag opens the link under the press
    /// position (TS `fullscreenPressedHyperlink`: terminals gate native
    /// link handling while mouse reporting is active, so clicks the TUI
    /// consumes must open their OSC 8 targets themselves), and with no
    /// link there it fires the click target under the press (TS
    /// `dispatchFullscreenClick`, the `click_dispatch` module): cards
    /// toggle their own expansion, the editor's content rows place the
    /// caret, and a picker's rows move its selection. Reports are consumed even while a picker, selector, or
    /// loader owns the frame (the TS overlay-focus gate) — the wheel
    /// never scrolls behind one, but its rows select; while tracking is
    /// inactive every report is consumed without a dispatch. The
    /// onboarding pane owns the frame the same way (TS's splash is a
    /// 100% overlay): its rows select as frame regions and its links
    /// open, but no transcript scrolls behind it.
    pub(crate) fn handle_mouse(&mut self, event: crate::mouse::MouseEvent, view: &mut AgentView) {
        if !crate::mouse_tracking::active() {
            return;
        }
        // TS `isFullscreenOverlayFocused`: the `/model` and `/effort`
        // pickers, the `/tree` and `/fork` selectors, the `/mcp`
        // connections view, the `/share` loader, and the onboarding splash
        // own the frame like the TS overlays.
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
        // TS records the press state before the dispatch: a drag report
        // marks the press, a plain press remembers the link under it.
        let left = event.button == crate::mouse::BUTTON_LEFT;
        let release_was_drag = left && !event.press && self.left_mouse_dragged;
        // Screen cells are one-based in the report (TS passes `event.y - 1`).
        let row = event.y.saturating_sub(1) as usize;
        let col = event.x.saturating_sub(1) as usize;
        if left && event.press {
            self.left_mouse_dragged = event.motion;
            if !event.motion {
                self.pressed_hyperlink = view.hyperlink_at(row, col);
                // A plain click re-arms the double-Esc tree shortcut the
                // same way a non-Escape key does: a real interaction
                // starts a fresh input chain.
                self.escape_tree_shortcut_spent = false;
            }
        }
        // Wheel turns scroll only on the session surface; a pane owns the
        // frame, the turn is consumed without scrolling.
        if let Some(delta) = crate::mouse::wheel_scroll_delta(&event) {
            if !overlay_focused {
                view.scroll_by(delta);
                self.dirty = true;
            }
            return;
        }
        // A buttonless motion report is the hover (operator directive
        // 2026-09-26: `?1003` any-event tracking delivers it): the
        // hovered clickable card row records its hover state, and the
        // frame re-renders only when that state changed — a motion burst
        // across one row never schedules a render per report.
        if event.button == crate::mouse::BUTTON_NONE && event.motion {
            if view.note_hover(row, col) {
                self.dirty = true;
            }
            return;
        }
        let left_press = event.press && left;
        let mut open_pressed_link = false;
        if overlay_focused {
            // TS tries the frame surface first while an overlay owns the
            // frame (its rows are the selectable spans), then the window.
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
            // TS `beginSelection` then the `beginFrameSelection` fallback.
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
        // TS opens `fullscreenPressedHyperlink ?? hyperlinkAt(release)`
        // on a plain left release: the pressed position wins, and a
        // release over another link still opens that link (a plain click
        // moves no cells). With no link there, the release fires the
        // click target recorded at the press (TS `dispatchFullscreenClick`).
        if open_pressed_link {
            let url = self
                .pressed_hyperlink
                .take()
                .or_else(|| view.hyperlink_at(row, col));
            if let Some(url) = url {
                self.open_hyperlink(&url);
            } else if !event.shift && !event.alt && !event.ctrl {
                // TS gates the click dispatch on the release's
                // modifiers too: modified clicks stay selection-only.
                self.dispatch_plain_click(view, row);
            }
        }
        // TS clears the press state after every left release, so a later
        // release can never open a stale press — the click target rides
        // the same cleanup (a drag-selection release consumes nothing).
        if left && !event.press {
            self.left_mouse_dragged = false;
            self.pressed_hyperlink = None;
            self.pressed_click = None;
        }
    }

    /// Open one clicked link (TS `openHyperlink`): the href guard admits
    /// only web and file locations, then the platform opener launches it
    /// fire-and-forget. A headless run has no terminal — and no browser to
    /// hand one to — so it records the URL for its verifier instead.
    fn open_hyperlink(&mut self, url: &str) {
        let Some(href) = crate::hyperlinks::openable_href(url) else {
            return;
        };
        self.opened_urls.push(href.clone());
        if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
            crate::browser::open_in_browser(&href);
        }
    }

    /// Copy a finished selection out (TS `copySelection` +
    /// `copyFullscreenSelection`): OSC 52 works locally, over SSH, and
    /// through tmux (`set-clipboard`), so the write goes straight to the
    /// terminal; a headless run has no terminal and records the text for
    /// its verifier instead. A successful copy surfaces the
    /// "Copied selection to clipboard" action toast (the ephemeral
    /// overlay, not the TS `showStatus` chat row — sanctioned divergence),
    /// a failed write the failure row (TS `showError`).
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

    /// Arm, re-aim, or disarm the selection auto-scroll for a drag position
    /// (TS `updateSelectionAutoScroll`).
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

    /// Stop the selection auto-scroll (TS `stopSelectionAutoScroll`): every
    /// non-drag input and each scroll edge case disarms it.
    pub(crate) fn stop_selection_auto_scroll(&mut self) {
        self.selection_auto_scroll = None;
    }

    /// Whether the selection auto-scroll driver is armed: the run loop's
    /// quiet tick keys on it (an idle surface parks the tick, so this is
    /// what tells it a drag is actually holding the edge).
    pub(crate) fn selection_auto_scroll_armed(&self) -> bool {
        self.selection_auto_scroll.is_some()
    }

    /// One idle tick of the selection auto-scroll (the run loop's 50 ms arm
    /// stands in for TS's timer): after the 150 ms hold window, each tick
    /// scrolls one line set and re-aims the head onto the edge row; the
    /// drag ending, the edge direction changing, or the scroll clamping
    /// disarms the driver.
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

    /// A bracketed paste (TS routes terminal paste into the focused input):
    /// an open `/model` picker pastes into its search field; otherwise the
    /// editor takes it.
    pub(crate) fn handle_paste(&mut self, text: &str, view: &mut AgentView) {
        if let Some(picker) = view.model_picker.as_mut() {
            picker.paste(text);
            self.dirty = true;
            return;
        }
        if let Some(mcp_view) = view.mcp_view.as_mut() {
            mcp_view.paste(text);
            self.dirty = true;
            return;
        }
        // The bash view owns the whole frame while open (like its key
        // dispatch): a paste never lands in the hidden editor prompt,
        // where a later Enter would submit it unedited. The read-only
        // goal panel and info panel consume it the same way.
        if view.bash_view.is_some() || view.goal_panel.is_some() || view.info_panel.is_some() {
            self.dirty = true;
            return;
        }
        let _ = view.editor.handle_paste(text);
    }

    /// One key press while the `/effort` picker is open: Esc/Ctrl+C close
    /// it without applying; Enter applies the picked level.
    async fn handle_effort_picker_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The picker consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics.
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
        // Any non-Escape key re-arms the double-Esc tree shortcut (the
        // gesture is one shot per input chain, not per session — see the
        // arm site below): a real interaction anywhere on the surface —
        // typing, navigation inside a mounted panel, a command — starts a
        // fresh chain. Escape itself never resets, so a pure stream of
        // Escape presses converges to the inert empty state.
        if key_event_to_id(&key).is_some_and(|id| id != "escape") {
            self.escape_tree_shortcut_spent = false;
        }
        // The `/model` picker owns the frame while open: every key goes to
        // it, before the editor, the viewport keys, or Ctrl+C (which
        // cancels the picker instead of aborting a turn).
        if view.model_picker.is_some() {
            return self.handle_model_picker_key(key, view).await;
        }
        // The `/effort` picker owns the frame the same way.
        if view.effort_picker.is_some() {
            return self.handle_effort_picker_key(key, view).await;
        }
        // The `/mcp` connections view owns the frame the same way.
        if view.mcp_view.is_some() {
            return self.handle_mcp_view_key(key, view);
        }
        // The `/heartbeats` view owns the frame the same way.
        if view.heartbeats_picker.is_some() {
            return self.handle_heartbeats_picker_key(key, view).await;
        }
        // The bash view owns the frame the same way.
        if view.bash_view.is_some() {
            return self.handle_bash_view_key(key, view);
        }
        // The read-only goal panel owns the frame the same way.
        if view.goal_panel.is_some() {
            return self.handle_goal_panel_key(key, view);
        }
        // The read-only info panel owns the frame the same way.
        if view.info_panel.is_some() {
            return self.handle_info_panel_key(key, view);
        }
        // The `/tree` and `/fork` selectors own the frame the same way.
        if view.tree_selector.is_some() {
            return self.handle_tree_selector_key(key, view).await;
        }
        if view.fork_selector.is_some() {
            return self.handle_fork_selector_key(key, view).await;
        }
        // A pending confirm owns the frame the same way (TS mounts its
        // selector over the prompt).
        if view.confirm.is_some() {
            return self.handle_confirm_key(key, view).await;
        }
        // The `/login` / `/logout` provider selector owns the frame the
        // same way (TS's auth panel mounts over the prompt).
        if view.provider_auth.is_some() {
            return self.handle_provider_auth_key(key, view).await;
        }
        // The inline auth panel owns the frame the same way (TS the login
        // dialog / team selector mounts over the prompt).
        if view.auth_panel.is_some() {
            return self.handle_auth_panel_key(key, view);
        }
        // The `/settings` menu owns the frame the same way (TS
        // `showSelector`).
        if view.settings_menu.is_some() {
            return self.handle_settings_menu_key(key, view).await;
        }
        // The `/share` loader owns the frame while an upload runs (TS the
        // loader takes focus): the cancel binding aborts, other keys are
        // the loader's.
        if view.share_loader.is_some() {
            return self.handle_share_loader_key(key, view);
        }
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The dispatch order below mirrors the TS key pipeline: the
        // transcript viewport keys (`tui.ts` consumes them before the
        // focused component in fullscreen), then the focused subagent
        // summary line (`SubagentSummaryLine.handleInput` owns every key
        // while focused), then `CustomEditor.handleInput` — paste image,
        // `app.input.clear`, `app.exit` (only when the editor is empty;
        // otherwise ctrl+d falls through to the editor's
        // delete-char-forward), then the app actions in registration
        // order (`app.clear` first, `app.tools.expand` next). Every match
        // goes through the effective bindings, so a user
        // `keybindings.json` override moves both the handler and the hint.
        // Transcript viewport keys (TS tui.ts consumes them before the
        // editor in fullscreen): page scroll, top, follow.
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
            // The viewport consumes the key before the editor, so the
            // editor's own page arms never run: collapse a selection
            // here or it survives the scroll as a stale replace range.
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
        // The activity dock owns focus while focused: Enter (and a second
        // Alt+A) opens the focused group's own view directly (the
        // operator's direct-navigation redesign), left/right step the
        // dock's groups — except left from the subagents selection,
        // which opens the agents view (the operator's 2026-09-28 ask) —
        // up/cancel/back returns to the editor, expand cycles the
        // conversation detail and KEEPS the focus, and every other key
        // falls through after releasing the focus (TS `onChatAction` ->
        // `focusEditor` -> the editor handles it).
        if self.subagents_focused {
            let kb = view.editor.keybindings();
            if kb.matches(&id, "tui.select.confirm") || kb.matches(&id, "app.subagents.focus") {
                // The dock is the direct launcher: Enter opens the
                // focused group's own view (the operator's redesign —
                // the grouped activity panel is gone).
                self.open_dock_group_view(view);
                return Ok(());
            }
            if id == "left" && self.activity_group == crate::chrome::ActivityGroup::Subagents {
                // Left from the subagents selection opens the agents
                // view (the operator's 2026-09-28 muscle-memory ask —
                // the same route as Enter and clicking the group): the
                // dock's subagents item is the row's own entry into
                // the scoped agents view, and left reads as `agents
                // back` everywhere else on this surface (the empty
                // editor's `app.agents.back` hands the pane to the
                // agents view the same way).
                self.open_dock_group_view(view);
                return Ok(());
            }
            if id == "left" || id == "right" {
                // One press, one group: the step lands on the
                // neighboring rendered group and wraps at the row's
                // ends, so an empty group is still visited (the
                // operator's 2026-09-26 muscle-memory directive — an
                // empty group never skips) and N groups take N
                // presses to cycle.
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
        // Image paste (TS `app.clipboard.pasteImage`, default ctrl+v):
        // reads the clipboard image and inserts its marker into the
        // editor. The editor's own ctrl+v is unbound otherwise, so the
        // match is exact before any editor motion.
        if view
            .editor
            .keybindings()
            .matches(&id, "app.clipboard.pasteImage")
        {
            self.handle_clipboard_image_paste(view).await;
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.input.clear") {
            // The completion surface consumes Esc: the open dropdown
            // closes, and a parked request (Tab before the input-idle
            // tick materializes it) cancels before it can open the menu —
            // either way the key stops there. The abort ladder (the
            // escape-repeat arming and `interrupt_running_work`) runs only
            // when no menu is open or about to open — closing a menu must
            // never abort a running turn (the TS base editor consumes
            // `tui.select.cancel` inside the dropdown; the TS
            // custom-editor overlay propagates Esc to the interrupt after
            // closing, the behavior this deliberately removes).
            if view.editor.is_showing_autocomplete() || view.editor.has_pending_autocomplete() {
                view.editor.cancel_autocomplete();
                self.clear_ctrl_c_hint();
                return Ok(());
            }
            // An active selection consumes the first Escape (standard
            // editors' drop-the-selection press): the interrupt/clear
            // ladder runs on the next press.
            if view.editor.has_selection() {
                view.editor.clear_selection();
                self.clear_ctrl_c_hint();
                self.dirty = true;
                return Ok(());
            }
            self.clear_ctrl_c_hint();
            // TS `handleEscape`: an open side-question pane owns the key —
            // the running turn aborts and the pane closes; the armed
            // escape-repeat from an earlier press disarms first (TS
            // `clearEscapeRepeat`).
            if view.side_pane.is_some() {
                self.escape_repeat_action = None;
                self.escape_repeat_until = None;
                self.clear_side_question(true, view);
                return Ok(());
            }
            // Leaving browse mode restores the stashed draft instead of
            // arming an accidental empty-submit delete of the selected
            // queued message (TS `clearInputBar`).
            if self.queue_selection.has_draft() {
                let draft = self.queue_selection.reset();
                view.editor.set_text(&draft);
                self.sync_queue_selection(view);
                self.dirty = true;
                return Ok(());
            }
            // Double-Escape (TS `handleEscape`'s repeat window): the second
            // press within 500ms opens the tree when the session is idle or
            // the editor empty, and clears the input otherwise. The repeat's
            // tree action is one shot per input chain (the operator's
            // 2026-09-29 Esc-overflow ruling): once the repeat-opened tree
            // was dismissed, the empty state's pop loop terminates — the
            // next Escape arms nothing, so a held or repeated Escape
            // converges to the inert empty editor instead of cycling the
            // selector open again every second press.
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
                // The gesture already fired: this press interrupts running
                // work like every Escape, but arms no reopen — the pop loop
                // stays terminated at the empty state.
                self.interrupt_running_work(view);
                return Ok(());
            }
            self.arm_escape_repeat(action);
            // TS `handleEscape` arms the repeat, then fires
            // `interruptOrClearInput()` — the same abort ladder as the
            // Ctrl+C interrupt, minus the Ctrl+C exit hint (TS shows that
            // only through `handleInterruptKey`).
            self.interrupt_running_work(view);
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.exit") && view.editor.get_text().is_empty() {
            self.exit_reason = "ctrl_d";
            *running = false;
            return Ok(());
        }
        // TS routes `app.interrupt` through the `app.clear` handlers; only the
        // second-press exit is ctrl+c's alone.
        let interrupt = view.editor.keybindings().matches(&id, "app.interrupt");
        if interrupt || view.editor.keybindings().matches(&id, "app.clear") {
            // One handled Ctrl+C press: the force-quit guard disarms once
            // every observed press of the pair was handled without an exit
            // (abort / autocomplete cancel, TS `handleCtrlC`); an exit keeps
            // the deadline and re-arms it on the loop break.
            if id == "ctrl+c" {
                self.exit_guard.note_ctrl_c_handled();
            }
            if view.editor.is_showing_autocomplete() {
                view.editor.cancel_autocomplete();
                self.clear_ctrl_c_hint();
                return Ok(());
            }
            // TS `handleCtrlC`: the first press interrupts (aborting an
            // active turn, showing the exit hint); a second press inside
            // the hint window shuts down unconditionally — no turn wait,
            // no abort wait — so the client always exits promptly. The
            // interrupt action shows the same hint but never exits on the
            // second press (TS `handleInterruptKey` has no exit branch).
            if self.ctrl_c_hint_visible() && !interrupt {
                self.exit_reason = "ctrl_c_twice";
                *running = false;
                return Ok(());
            }
            // TS `interruptOrClearInput`: a running side question is
            // aborted first (its failure reported through the note
            // channel, unlike the silent pane-close abort); the pane stays
            // mounted and renders the cancelled turn when the run's
            // terminal event streams back.
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
        // TS `app.suspend` (default ctrl+z, `handleCtrlZ`): hand the
        // terminal to the shell and stop the process group; the loop
        // performs the cycle right after dispatch, and the SIGCONT
        // continuation re-applies raw mode, the alt screen, and SGR
        // mouse tracking (TS `ui.start()` + `applyFullscreen(true)`).
        // Platforms without a stoppable process group show the TS win32
        // status instead of suspending.
        if view.editor.keybindings().matches(&id, "app.suspend") {
            if crate::suspend::supported() {
                self.suspend_requested = true;
            } else {
                self.note("Suspend to background is not supported on Windows", view);
            }
            return Ok(());
        }
        // TS `app.model.select` (default ctrl+l, `showModelSelector`):
        // the same surface `/model` opens (TS registers it between the
        // suspend and the detail actions). No command was submitted, so
        // the menu telemetry reports the `shortcut` source.
        if view.editor.keybindings().matches(&id, "app.model.select") {
            // The picker takes the frame: a completion request parked by
            // this same press must not materialize a dropdown over the
            // picker on the next idle tick (the Tab path's cancel; TS's
            // selector mounts without the editor's dropdown).
            view.editor.cancel_autocomplete();
            self.open_model_picker(view, "").await?;
            // The key opens the picker over the user's own text (a draft
            // or a browsed queued message), so the picker's apply must
            // keep it — the Tab path's flag truth, not a typed-command
            // partial (TS's selector never touches the editor).
            self.picker_restored_draft = true;
            self.track_menu_opened("model", "shortcut");
            self.dirty = true;
            return Ok(());
        }
        // TS `app.model.cycleForward`/`app.model.cycleBackward` (defaults
        // alt+m / shift+alt+m, registered right after the selector): cycle
        // within the session's scoped list when one is set, else the
        // available catalog.
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
            // TS `app.tools.expand` (default ctrl+o) cycles conversation
            // detail: overview -> details -> all -> overview.
            self.cycle_detail(view);
            return Ok(());
        }
        // TS `app.subagents.focus` (default alt+a): the dock takes focus
        // (it renders in every session).
        if view
            .editor
            .keybindings()
            .matches(&id, "app.subagents.focus")
        {
            self.focus_subagents_summary(&DockFocusSource::Shortcut, view);
            self.dirty = true;
            return Ok(());
        }
        // TS `app.editor.external` (default ctrl+g,
        // `openExternalEditor`): a configured editor hands off through the
        // loop (the terminal belongs to the renderer); without one, TS
        // shows the warning row (an appended row, not a status rewrite).
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
        // TS `app.prompt.stash` (default ctrl+s, `handlePromptStash`):
        // with a draft in the editor the key stashes it — the whole draft
        // (text, collapsed pastes, pasted images) moves to the session's
        // stash and the editor clears; with an empty editor the key
        // restores the stashed draft. The manual stash is not a
        // restore-on-open head: it returns only on this key, never on a
        // chat open or a switch landing (TS `restoreOnOpen`), so the
        // agents-view and `/switch` auto paths keep their own semantics.
        if view.editor.keybindings().matches(&id, "app.prompt.stash") {
            // A queue browse parks the real draft in `queue_selection` and
            // shows the selected queued message's text in the editor, so
            // the stash must never take the browsed text: leaving the
            // browse first restores the draft like every other
            // editor-mutating exit (Esc, the menu opens) — the stash then
            // acts on the user's own draft, the parked message keeps its
            // text, and the disarmed browse cannot turn the next Enter
            // into an empty-edit delete of the parked message.
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
        // TS `app.session.new` (no default key; user-bindable,
        // `handleClearCommand`): the `/new` flow — TS registers it
        // without an editor-text gate, so it fires with a draft too.
        if view.editor.keybindings().matches(&id, "app.session.new") {
            self.start_new_session(view).await?;
            self.dirty = true;
            return Ok(());
        }
        // TS `app.session.resume` (no default key; user-bindable): open the
        // agents view. Unlike agents-back it fires with a draft in the
        // editor — the draft is stashed for the session on the exit path
        // and returns when the session's chat reopens.
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
        // Agents-back (TS `custom-editor.ts` onAgentsBack): with an empty
        // editor the bound key (default left) hands the terminal to the
        // agents view instead of moving the cursor; with text in the editor
        // the key stays an editor cursor motion. A `--no-session` run has
        // no daemon fleet to browse, so the key stays consumed but only
        // reports that (TS `requestAgentsView` status).
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
        // `app.session.tree` / `app.session.fork` (TS editor actions): the
        // bound keys open the surfaces when the editor is empty.
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
        // The queue browse keys (TS `app.message.navigateOlder/Newer`,
        // defaults alt+up/alt+down) walk the parked messages newest-first,
        // stashing the editor draft; while a message is selected, the
        // reorder keys (TS `app.message.moveEarlier/Later`) move it.
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
        // The follow-up key (TS `app.message.followUp`, default alt+enter):
        // the same submit ladder as Enter, but the message parks on the
        // follow-up lane and delivers when the run goes idle. While a
        // queued message is selected, the edit re-parks it there instead
        // (TS `handleFollowUp`'s browsing branch). An empty follow-up is
        // TS `handleFollowUp`'s silent no-op: never submitted, never
        // dispatched to the daemon.
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
        // Tab in a picker-command argument context opens that command's
        // menu prefilled with the typed partial: `/model <partial>` Tab
        // opens the model picker filtered to the match, `/mcp <partial>`
        // Tab the connections view filtered. The menu-only commands have
        // no typed-arg execution, so the partial's only destination is the
        // picker's filter. An open completion dropdown keeps its own Tab
        // (apply the selection); the interception is the no-menu path.
        if view.editor.keybindings().matches(&id, "tui.input.tab")
            && !view.editor.is_showing_autocomplete()
        {
            if let Some((command, partial)) = view.editor.picker_argument_context() {
                // The menu takes the Tab: a completion request parked by
                // this same press (before the idle tick) must not
                // materialize a dropdown over the menu on the next tick.
                view.editor.cancel_autocomplete();
                // The menu also takes the frame from a queue browse: the
                // parked message keeps its text (the typed partial is the
                // command being fulfilled now), and the next Enter submits
                // a prompt instead of routing into apply_queue_selection,
                // which would delete or replace the still-selected message.
                // Ending the browse restores the stashed draft like every
                // other leave-browse path (Esc, an applied queue edit), so
                // the editor never strands the browsed message's text and
                // a failed menu open loses nothing: the draft returns.
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
                        // The flag belongs to the mounted picker: the
                        // model picker always mounts here, so a guard is
                        // belt-and-braces, but the failed-open contract
                        // stays symmetric with the mcp arm.
                        if view.model_picker.is_none() {
                            self.picker_restored_draft = false;
                        }
                        self.track_menu_opened("model", "tab");
                        self.dirty = true;
                        return Ok(());
                    }
                    "mcp" => {
                        self.open_mcp_view("/mcp", view, partial.trim()).await?;
                        // A failed roster load leaves no view mounted:
                        // the editor keeps the restored draft (nothing
                        // lost), but the flag must not leak into the NEXT
                        // picker — its clear-on-apply semantics belong to
                        // the typed partial, not this draft.
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
        // cursor at the last line's end — hands the focus to the subagent
        // summary line when it is selectable; every other Down falls
        // through to the editor's cursor motion (a non-selectable line
        // never takes it). TS `SubagentSummaryLine.isSelectable()` grants
        // the grab only when subagents exist — the dock's other groups
        // keep their `app.subagents.focus` shortcut, so the prompt's
        // arrows stay the input-history recall in every session shape.
        if view
            .editor
            .keybindings()
            .matches(&id, "tui.editor.cursorDown")
            && !view.editor.is_showing_autocomplete()
            && !view.editor.is_history_navigation_active()
            && view.editor.is_cursor_at_end()
            && self.focus_subagents_summary(&DockFocusSource::PromptDown, view)
        {
            // The focus leaves the editor with the selection active: a
            // later keystroke would fall back through to the editor and
            // replace the stale range, so the selection collapses with
            // the handoff.
            view.editor.clear_selection();
            self.dirty = true;
            return Ok(());
        }
        view.editor.handle_input(&id);
        // TS clears the exit hint as soon as the editor carries text: the
        // `Press Ctrl+C again to exit` row belongs to the empty prompt.
        if !view.editor.get_text().is_empty() {
            self.clear_ctrl_c_hint();
        }
        for event in view.editor.take_events() {
            match event {
                crate::editor::EditorEvent::Submitted(text) => {
                    if self.queue_selection.is_browsing() {
                        // Enter steers the selected parked message: the edit
                        // replaces it and moves it onto the steering lane
                        // (TS `applyQueueSelection(text, "steering")`).
                        self.apply_queue_selection(&text, QueueLane::Steering, view)
                            .await?;
                    } else {
                        view.editor.add_to_history(&text);
                        self.submit_prompt(&text, SubmitBehavior::Steer, view)
                            .await?;
                    }
                }
                crate::editor::EditorEvent::ClipboardWrite(text) => {
                    // A selection cut/copy. On a live terminal it takes
                    // TS `copySelection`'s shape exactly: the OSC 52
                    // sequence goes straight to the terminal (it works
                    // locally, over SSH, and through tmux
                    // `set-clipboard`), the same write the mouse
                    // selection's `copy_selection` below performs. The
                    // platform-tool chain (child processes whose
                    // `wait()` has no timeout) never runs on this path:
                    // a stalled xclip/wl-copy/pbcopy can neither freeze
                    // the prompt nor leak an unkillable blocking task,
                    // and no background task accumulates. The toast is
                    // success-only; a failed write shows the error row.
                    // A headless run has no terminal to write to and no
                    // stalling children (the tools fail to spawn
                    // instantly), so it keeps the synchronous platform
                    // chain and its captured OSC sink stays verifiable.
                    if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
                        use std::io::Write;
                        // The sequence goes through `osc52::sequence`, so
                        // the encoded-payload cap applies to this path
                        // like every other OSC 52 write: an oversized
                        // sequence desynchronizes the terminal, so the
                        // copy reports failure instead of writing it.
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

//! The session surface's plain-click dispatch (TS `tui.ts`'s
//! `fullscreenPressedClick` + `dispatchFullscreenClick`): a plain left
//! press records the click target under it — a hyperlink or a
//! shift/alt/ctrl press records nothing, so those stay selection-only —
//! and a plain release on the same row fires the target's action. A
//! card or condensed run block toggles its own expansion (the clicked
//! card's content, operator directive 2026-09-26 — not the keyboard's
//! `app.tools.expand` cycle, which from `overview` would only expand
//! the thinking blocks around the card), an editor content row places
//! the caret, and a picker row moves the picker's selection.

use crate::session_ui::SessionUi;
use crate::view::click::ClickAction;
use crate::view::AgentView;

/// The click target recorded at a plain left press: the row the press
/// landed on and the target's action (the release must land on the same
/// row for it to fire).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PressedClick {
    pub(crate) row: usize,
    pub(crate) action: ClickAction,
}

impl SessionUi {
    /// Record the click target under a left press (TS
    /// `fullscreenPressedClick`, which always assigns): a hyperlink
    /// wins over component regions at the press position (the
    /// press-state block recorded one), and shift/alt/ctrl presses
    /// stay selection-only — both clear any stale target, so a later
    /// gated release can never fire an earlier press's action.
    pub(crate) fn record_pressed_click(
        &mut self,
        view: &AgentView,
        event: &crate::mouse::MouseEvent,
    ) {
        let row = event.y.saturating_sub(1) as usize;
        let col = event.x.saturating_sub(1) as usize;
        let plain = !event.motion
            && !event.shift
            && !event.alt
            && !event.ctrl
            && self.pressed_hyperlink.is_none();
        self.pressed_click = plain
            .then(|| view.click_target_at(row, col))
            .flatten()
            .map(|action| PressedClick { row, action });
    }

    /// Fire the click recorded at the press (TS `dispatchFullscreenClick`):
    /// a release after a drag never fires (TS `fullscreenLeftMouseDragged`
    /// marks the press), and the release must land on the pressed
    /// target's own row.
    pub(crate) fn dispatch_plain_click(&mut self, view: &mut AgentView, row: usize) {
        let Some(pressed) = self.pressed_click.take() else {
            return;
        };
        if self.left_mouse_dragged || pressed.row != row {
            return;
        }
        match pressed.action {
            ClickAction::ToggleCardExpansion => {
                self.track_click("transcript");
                self.toggle_card_expansion(view);
            }
            ClickAction::PlaceCaret {
                row,
                col,
                content_width,
            } => {
                self.track_click("editor");
                view.editor.place_cursor_from_click(content_width, row, col);
                self.dirty = true;
            }
            ClickAction::SelectModelRow(position) => {
                if let Some(picker) = view.model_picker.as_mut() {
                    self.track_click("picker");
                    picker.select_filtered(position);
                    self.dirty = true;
                }
            }
            ClickAction::SelectEffortRow(position) => {
                if let Some(picker) = view.effort_picker.as_mut() {
                    self.track_click("picker");
                    picker.select_position(position);
                    self.dirty = true;
                }
            }
        }
    }

    /// Cycle the conversation detail (TS `app.tools.expand`, default
    /// ctrl+o — the keyboard grammar's exact cycle: overview ->
    /// details -> all -> overview; #2709 saves the new level as the
    /// `chatDetail` setting either way).
    pub(crate) fn cycle_detail(&mut self, view: &mut AgentView) {
        view.detail = view.detail.next();
        self.save_chat_detail(view);
        // TS `applyChatExpansion` also re-flags the side-question pane
        // (the pane has no bash rows here, so the flag is the only
        // carried state).
        if let Some(pane) = view.side_pane.as_mut() {
            pane.expanded = view.detail == crate::chat::Detail::All;
        }
        self.dirty = true;
    }

    /// Toggle the clicked card's own expansion (operator directive
    /// 2026-09-26: clicking a tool call must open the tool call, not
    /// the thinking block around it). TS toggles a per-card `expanded`
    /// state; this port's cards are detail-mode driven, so the card's
    /// expansion maps onto the level: `all` when the clicked card's
    /// content is collapsed (tool output, notice body, completion
    /// content — the `details` level a blind cycle reaches from
    /// `overview` only expands the thinking blocks around the card),
    /// `overview` when it is expanded. #2709 saves the new level as
    /// the `chatDetail` setting either way.
    pub(crate) fn toggle_card_expansion(&mut self, view: &mut AgentView) {
        view.detail = if view.detail.tool_output_expanded() {
            crate::chat::Detail::Overview
        } else {
            crate::chat::Detail::All
        };
        self.save_chat_detail(view);
        // TS `applyChatExpansion` also re-flags the side-question pane
        // (the pane has no bash rows here, so the flag is the only
        // carried state).
        if let Some(pane) = view.side_pane.as_mut() {
            pane.expanded = view.detail == crate::chat::Detail::All;
        }
        self.dirty = true;
    }
}

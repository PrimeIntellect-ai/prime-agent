//! The session surface's plain-click dispatch (TS `tui.ts`'s
//! `fullscreenPressedClick` + `dispatchFullscreenClick`): a plain left
//! press records the click target under it — a hyperlink or a
//! shift/alt/ctrl press records nothing, so those stay selection-only —
//! and a plain release on the same row fires the target's action. Every
//! action mirrors the keyboard grammar: a card or condensed run block
//! cycles the conversation detail (the `app.tools.expand` key), an
//! editor content row places the caret, and a picker row moves the
//! picker's selection.

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
    /// Record the click target under a plain left press (TS
    /// `fullscreenPressedClick`): hyperlinks win over component regions
    /// at the press position, and shift/alt/ctrl presses stay
    /// selection-only. A motion press (the drag's first report) marks
    /// the click as dragged and records nothing.
    pub(crate) fn record_pressed_click(
        &mut self,
        view: &AgentView,
        event: &crate::mouse::MouseEvent,
    ) {
        let row = event.y.saturating_sub(1) as usize;
        let col = event.x.saturating_sub(1) as usize;
        self.click_dragged = event.motion;
        if !event.motion
            && !event.shift
            && !event.alt
            && !event.ctrl
            && crate::hyperlinks::frame_link_at(row, col).is_none()
        {
            self.pressed_click = view
                .click_target_at(row, col)
                .map(|action| PressedClick { row, action });
        }
    }

    /// A left drag report kills the pending click (TS
    /// `fullscreenLeftMouseDragged`).
    pub(crate) fn note_click_drag(&mut self) {
        self.click_dragged = true;
    }

    /// Fire the click recorded at the press (TS `dispatchFullscreenClick`):
    /// a release after a drag never fires, and the release must land on
    /// the pressed target's own row.
    pub(crate) fn dispatch_plain_click(&mut self, view: &mut AgentView, row: usize) {
        let pressed = self.pressed_click.take();
        let dragged = self.click_dragged;
        self.click_dragged = false;
        let Some(pressed) = pressed else {
            return;
        };
        if dragged || pressed.row != row {
            return;
        }
        match pressed.action {
            ClickAction::CycleDetail => self.cycle_detail(view),
            ClickAction::PlaceCaret {
                row,
                col,
                content_width,
            } => {
                view.editor.place_cursor_from_click(content_width, row, col);
                self.dirty = true;
            }
            ClickAction::SelectModelRow(position) => {
                if let Some(picker) = view.model_picker.as_mut() {
                    picker.select_filtered(position);
                    self.dirty = true;
                }
            }
            ClickAction::SelectEffortRow(position) => {
                if let Some(picker) = view.effort_picker.as_mut() {
                    picker.select_position(position);
                    self.dirty = true;
                }
            }
        }
    }

    /// Cycle the conversation detail (TS `app.tools.expand`, default
    /// ctrl+o — the key handler's exact action, so the click grammar
    /// fires the same cycle; #2709 saves the new level as the
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
}

//! The session surface's plain-click dispatch: a plain left press records the click target under
//! it — a hyperlink or a modifier press records nothing — and a plain release on the same row
//! fires the target's action: a card toggles its own expansion, an editor content row places
//! the caret, a picker row moves the selection.

use crate::session_ui::SessionUi;
use crate::view::click::ClickAction;
use crate::view::AgentView;

/// The click target recorded at a plain left press: the row the press landed on and the
/// target's action (the release must land on the same row for it to fire).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PressedClick {
    pub(crate) row: usize,
    pub(crate) action: ClickAction,
}

impl SessionUi {
    /// Record the click target under a left press: a hyperlink wins over component regions at
    /// the press position, and shift/alt/ctrl presses stay selection-only — both clear any
    /// stale target, so a later gated release can never fire an earlier press's action.
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

    /// Fire the click recorded at the press: a release after a drag never
    /// fires, and the release must land on the pressed target's own row.
    pub(crate) fn dispatch_plain_click(&mut self, view: &mut AgentView, row: usize) {
        let Some(pressed) = self.pressed_click.take() else {
            return;
        };
        if self.left_mouse_dragged || pressed.row != row {
            return;
        }
        match pressed.action {
            ClickAction::ToggleCardExpansion(entry) => {
                self.track_click("transcript");
                view.toggle_card_expansion(entry);
                self.dirty = true;
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
            ClickAction::SelectChoiceRow(position) => {
                if let Some(picker) = view.choice_picker.as_mut() {
                    self.track_click("picker");
                    picker.select_position(position);
                    self.dirty = true;
                }
            }
            ClickAction::OpenDockGroup(group) => {
                self.track_click("dock");
                self.open_dock_group_from_click(group, view);
            }
            ClickAction::OpenAgentsView => {
                // The click keeps the LEFT ARROW's contract — the pane
                // hands off only while the editor is empty — so a draft
                // never rides a stray click out of the session.
                if view.editor.get_text().trim().is_empty() {
                    self.track_click("hint");
                    self.open_agents_view_from_hint(view);
                }
            }
        }
    }

    /// Cycle the conversation detail and save it as the `chatDetail`
    /// setting (#2709).
    pub(crate) fn cycle_detail(&mut self, view: &mut AgentView) {
        view.cycle_detail();
        self.save_chat_detail(view);
        // Also re-flag the side-question pane (the flag is the only
        // carried state there).
        if let Some(pane) = view.side_pane.as_mut() {
            pane.expanded = view.detail == crate::chat::Detail::All;
        }
        self.dirty = true;
    }
}

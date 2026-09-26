//! The fullscreen frame's click surface (TS `click-regions.ts` +
//! `fullscreen.ts`'s `clickTargetAt`, and the press/release dispatch of
//! `tui.ts`'s `handleFullscreenInput`): every surface the mouse can
//! activate — the transcript window's activity cards, the editor's
//! content rows, and the `/model` and `/effort` picker rows — projects
//! its row geometry during the frame composition that already computes
//! it, so a click hit-tests a bounded scan over the visible rows and
//! never re-walks transcript geometry.
//!
//! The actions mirror the keyboard grammar exactly: a card or condensed
//! run block cycles the conversation detail (`app.tools.expand`'s
//! action), an editor content row places the caret (TS
//! `placeCursorFromClick`), and a picker row moves the selection. The
//! TS card components own a per-card `expanded` state; this port's cards
//! are detail-mode driven (the condensed runs are a purely render-time
//! grouping), so every card family maps to the same detail cycle.

use super::AgentView;
use crate::chat::ChatEntry;

/// The action a plain click on one projected surface performs (the
/// `onClick` of TS's `ClickRegion`, specialized to the port's action
/// vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickAction {
    /// Cycle the conversation detail (the `app.tools.expand` key's exact
    /// action): the click target spans a condensed run block, a tool
    /// card, a bash execution card, an agent-message notice, or a
    /// shell-completion row.
    CycleDetail,
    /// Place the editor caret at the clicked cell: `row` indexes the
    /// editor's visible content rows, `col` is the column relative to
    /// the row's text start, and `content_width` is the width the
    /// editor's layout wrapped at.
    PlaceCaret {
        row: usize,
        col: usize,
        content_width: usize,
    },
    /// Move the `/model` picker's selection to the clicked filtered row.
    SelectModelRow(usize),
    /// Move the `/effort` picker's selection to the clicked filtered row.
    SelectEffortRow(usize),
}

/// One chat entry's visible span within the last composed transcript
/// window (window-relative rows, the record the composition loops
/// produce as they slice each entry's rows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WindowSection {
    pub(super) entry: usize,
    pub(super) from: usize,
    pub(super) to: usize,
}

/// The editor content rows' dock geometry, recorded at compose time: the
/// content starts `dock_row + 1 + queue_header_rows` rows into the dock
/// (TS `getClickRegions`'s `1 + getContentLineOffset()` line base) and
/// spans `rows` rows at the recorded layout width.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EditorClickSurface {
    /// Dock row of the editor surface's first row (its top border).
    pub(crate) dock_row: usize,
    /// Content rows the surface shows.
    pub(crate) rows: usize,
    /// Rows the queue-selection header inserts above the content.
    pub(crate) queue_header_rows: usize,
    /// The rendered prompt's visible width (`> `, `! `, `!! `).
    pub(crate) prompt_width: usize,
    /// The width the editor's layout wrapped at.
    pub(crate) content_width: usize,
}

/// One picker pane's item rows in the dock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PickerClickSurface {
    /// Dock row of the picker's first rendered row.
    pub(crate) dock_row: usize,
    /// The pane's chrome rows above the item rows (the header block and
    /// the bordered search field).
    pub(crate) chrome_rows: usize,
    /// The item rows' filtered positions.
    pub(crate) items: (usize, usize),
    pub(crate) kind: PickerKind,
}

/// The picker panes that expose clickable item rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PickerKind {
    Model,
    Effort,
}

/// The `/model` picker's chrome rows above its item rows: the bordered
/// search field ([`crate::menu_panel::search_field_lines`] renders
/// exactly three rows).
pub(crate) const MODEL_PICKER_CHROME_ROWS: usize = 3;

/// The `/effort` picker's chrome rows above its item rows: the config
/// selector's header block (blank, title, blank) plus the bordered search
/// field.
pub(crate) const EFFORT_PICKER_CHROME_ROWS: usize = 6;

/// The last composed frame's clickable geometry (TS `frameClickTargets`).
/// Every field is recorded during a frame composition; the inline compose
/// (no fullscreen window on screen) clears it, so a click never resolves
/// against a frame that is not what the terminal shows.
#[derive(Debug, Default)]
pub(crate) struct ClickSurface {
    /// The visible window's chat entries, in window-row order.
    pub(super) window_sections: Vec<WindowSection>,
    /// Screen-row spans the compose later covered with transient
    /// overlays (the action toasts, the paused-viewport follow hint):
    /// their rows no longer read as the content beneath them.
    pub(super) masked_rows: Vec<(usize, usize)>,
    /// Screen row the transcript window starts at (the pinned top bar).
    pub(super) window_screen_start: usize,
    /// Screen row of the dock's first visible row.
    pub(super) dock_screen_origin: usize,
    /// Dock rows the compose dropped from the dock's front (an over-tall
    /// dock); a click's dock row indexes the un-cropped dock.
    pub(super) dock_cropped: usize,
    pub(super) editor: Option<EditorClickSurface>,
    pub(super) picker: Option<PickerClickSurface>,
}

impl ClickSurface {
    /// Reset for a fresh frame composition.
    pub(super) fn clear(&mut self) {
        *self = ClickSurface::default();
    }

    /// Mask screen rows `[from, to)` as overlay-covered: a click there
    /// must not fire the hidden row's target.
    pub(super) fn mask_rows(&mut self, from: usize, to: usize) {
        if from < to {
            self.masked_rows.push((from, to));
        }
    }

    /// Record one chat entry's visible window span.
    pub(super) fn record_window_section(&mut self, entry: usize, from: usize, to: usize) {
        self.window_sections.push(WindowSection { entry, from, to });
    }

    /// Record the frame's compose scalars: the window's first screen row,
    /// the dock's first screen row, and the dock's front-crop.
    pub(super) fn note_frame(
        &mut self,
        window_screen_start: usize,
        dock_screen_origin: usize,
        dock_cropped: usize,
    ) {
        self.window_screen_start = window_screen_start;
        self.dock_screen_origin = dock_screen_origin;
        self.dock_cropped = dock_cropped;
    }

    /// Record the editor content rows' dock geometry.
    pub(super) fn record_editor(&mut self, surface: EditorClickSurface) {
        self.editor = Some(surface);
    }

    /// Record a picker pane's item rows.
    pub(super) fn record_picker(&mut self, surface: PickerClickSurface) {
        self.picker = Some(surface);
    }
}

impl AgentView {
    /// The click target covering one screen cell of the last composed
    /// frame (TS `clickTargetAt`): `None` when the cell is not
    /// clickable. The scan is bounded by the visible window's entries
    /// and the dock's recorded surfaces — no transcript geometry is
    /// resolved here.
    pub(crate) fn click_target_at(
        &self,
        screen_row: usize,
        screen_col: usize,
    ) -> Option<ClickAction> {
        let click = &self.click;
        if screen_row < click.window_screen_start {
            return None;
        }
        // An overlay-covered row (a transient toast pill, the follow
        // hint) never reads as the content beneath it.
        if click
            .masked_rows
            .iter()
            .any(|(from, to)| screen_row >= *from && screen_row < *to)
        {
            return None;
        }
        let window_row = screen_row - click.window_screen_start;
        if window_row < self.window_rows {
            return self.transcript_click_target(window_row);
        }
        if screen_row < click.dock_screen_origin {
            return None;
        }
        let dock_row = screen_row - click.dock_screen_origin + click.dock_cropped;
        if let Some(picker) = click.picker {
            // The pane's chrome rows (the header block and the search
            // field) are not clickable; the items past the visible window
            // are not either.
            let visible = picker.items.1.saturating_sub(picker.items.0);
            let item = dock_row
                .checked_sub(picker.dock_row + picker.chrome_rows)
                .filter(|item| *item < visible)?;
            return Some(match picker.kind {
                PickerKind::Model => ClickAction::SelectModelRow(picker.items.0 + item),
                PickerKind::Effort => ClickAction::SelectEffortRow(picker.items.0 + item),
            });
        }
        let editor = click.editor?;
        // The content rows follow the surface's top border and the
        // queue-selection header (TS `getClickRegions`'s line base).
        let content_row = dock_row
            .checked_sub(editor.dock_row + 1 + editor.queue_header_rows)
            .filter(|row| *row < editor.rows)?;
        Some(ClickAction::PlaceCaret {
            row: content_row,
            // The row's text starts after the leading pad and the prompt.
            col: screen_col.saturating_sub(editor.prompt_width + 2),
            content_width: editor.content_width,
        })
    }

    /// The click action for one transcript window row: a row inside a
    /// visible activity entry (a condensed run block, a tool card, a
    /// bash card, an agent-message notice, a shell-completion row)
    /// cycles the conversation detail. Plain text rows (user,
    /// assistant, status, panels) are not clickable — the TS components
    /// register no regions there either.
    fn transcript_click_target(&self, window_row: usize) -> Option<ClickAction> {
        let section = self
            .click
            .window_sections
            .iter()
            .find(|section| window_row >= section.from && window_row < section.to)?;
        let entry = self.chat.get(section.entry)?;
        (matches!(
            entry,
            ChatEntry::Tool(_)
                | ChatEntry::BashExecution(_)
                | ChatEntry::AgentMessage(_)
                | ChatEntry::ShellCompletion(_)
        ))
        .then_some(ClickAction::CycleDetail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::StatusKind;
    use crate::theme::{ColorMode, Theme};
    use crate::tool_card::ToolCallCard;

    fn view() -> AgentView {
        AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
    }

    fn tool_card(id: &str) -> ChatEntry {
        ChatEntry::Tool(Box::new(ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            ..Default::default()
        }))
    }

    /// A settled frame with a tool card between two status rows: the
    /// card's section is the middle window section.
    fn frame_with_a_card() -> AgentView {
        let mut view = view();
        view.push_entry(ChatEntry::Status {
            text: "before the card".to_string(),
            kind: StatusKind::Info,
        });
        view.push_entry(tool_card("t1"));
        view.push_entry(ChatEntry::Status {
            text: "after the card".to_string(),
            kind: StatusKind::Info,
        });
        view.render_frame(40, 20);
        view
    }

    /// The screen row of one entry's first visible row (the recorded
    /// window section — no render-text assumptions).
    fn section_screen_row(view: &AgentView, entry: usize) -> usize {
        let section = view
            .click
            .window_sections
            .iter()
            .find(|section| section.entry == entry)
            .expect("the entry is visible");
        view.click.window_screen_start + section.from
    }

    #[test]
    fn a_click_on_a_card_row_cycles_the_detail() {
        let view = frame_with_a_card();
        let card_row = section_screen_row(&view, 1);
        assert_eq!(
            view.click_target_at(card_row, 2),
            Some(ClickAction::CycleDetail)
        );
        // Every row the card occupies is clickable, not just its first.
        let section = view
            .click
            .window_sections
            .iter()
            .find(|section| section.entry == 1)
            .expect("the card is visible");
        for window_row in section.from..section.to {
            assert_eq!(
                view.click_target_at(view.click.window_screen_start + window_row, 0),
                Some(ClickAction::CycleDetail)
            );
        }
    }

    #[test]
    fn a_click_on_plain_rows_is_inert() {
        let view = frame_with_a_card();
        let status_row = section_screen_row(&view, 0);
        assert_eq!(view.click_target_at(status_row, 2), None);
        // The pinned top bar is never clickable.
        assert_eq!(view.click_target_at(0, 2), None);
    }

    #[test]
    fn a_click_hit_tests_without_resolving_entry_geometry() {
        // The perf contract: a hit-test resolves no entry geometry (the
        // click walks the recorded spans, never the transcript).
        let view = frame_with_a_card();
        let card_row = section_screen_row(&view, 1);
        super::super::layout::ENTRY_VISITS.with(|count| count.set(0));
        for col in 0..10 {
            assert!(view.click_target_at(card_row, col).is_some());
        }
        super::super::layout::ENTRY_VISITS.with(|count| assert_eq!(count.get(), 0));
    }

    #[test]
    fn the_editor_content_rows_place_the_caret() {
        let mut view = view();
        view.editor.set_text("hello world");
        view.render_frame(40, 20);
        let surface = view.click.editor.expect("the editor surface renders");
        let content_row = view.click.dock_screen_origin + surface.dock_row + 1;
        // The row's text starts after the leading pad and the prompt.
        let action = view
            .click_target_at(content_row, surface.prompt_width + 2 + 4)
            .expect("the editor content row is clickable");
        let ClickAction::PlaceCaret {
            row,
            col,
            content_width,
        } = action
        else {
            panic!("the editor row maps to a caret placement: {action:?}");
        };
        assert_eq!(row, 0);
        assert_eq!(col, 4);
        assert_eq!(content_width, surface.content_width);
        // The surface's border rows are not content rows.
        assert_eq!(view.click_target_at(content_row.saturating_sub(1), 4), None);
    }

    #[test]
    fn a_toast_covered_row_never_fires_the_hidden_target() {
        let mut view = frame_with_a_card();
        let card_row = section_screen_row(&view, 1);
        assert!(
            view.click_target_at(card_row, 2).is_some(),
            "the card row is clickable without the toast"
        );
        // An action ack overlays the window's top rows; with a short
        // transcript the card's rows sit right under it.
        view.toasts.push("Copied selection to clipboard");
        view.render_frame(40, 20);
        // The mask covers the window's first toast row: a click on the
        // visible pill is inert.
        let masked = view
            .click
            .masked_rows
            .first()
            .copied()
            .expect("the toast masked its rows");
        assert_eq!(
            view.click_target_at(masked.0, 2),
            None,
            "the toast-covered row never reads as the content beneath it"
        );
        assert!(
            masked.1 <= view.click.window_screen_start + view.window_rows,
            "the mask stays inside the window"
        );
    }

    #[test]
    fn the_inline_compose_clears_the_click_surface() {
        let mut view = frame_with_a_card();
        assert!(!view.click.window_sections.is_empty());
        let card_row = section_screen_row(&view, 1);
        view.render_inline_frame(40);
        assert!(view.click.window_sections.is_empty());
        assert!(view.click.editor.is_none());
        assert_eq!(view.click_target_at(card_row, 2), None);
    }

    #[test]
    fn picker_item_rows_select_their_filtered_position() {
        let mut view = view();
        view.click.note_frame(1, 12, 0);
        view.click.record_picker(PickerClickSurface {
            dock_row: 2,
            chrome_rows: 3,
            items: (4, 7),
            kind: PickerKind::Model,
        });
        // The picker owns the dock: no editor surface is recorded, so
        // the dock rows map only through the picker.
        view.window_rows = view.click.dock_screen_origin - view.click.window_screen_start;
        assert_eq!(
            view.click_target_at(12 + 2 + 3, 1),
            Some(ClickAction::SelectModelRow(4))
        );
        assert_eq!(
            view.click_target_at(12 + 2 + 5, 1),
            Some(ClickAction::SelectModelRow(6))
        );
        // Past the item rows: inert.
        assert_eq!(view.click_target_at(12 + 2 + 6, 1), None);
        assert_eq!(view.click_target_at(12 + 2, 1), None);
    }
}

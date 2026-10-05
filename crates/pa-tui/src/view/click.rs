//! The fullscreen frame's click surface (TS `click-regions.ts` +
//! `fullscreen.ts`'s `clickTargetAt`, and the press/release dispatch of
//! `tui.ts`'s `handleFullscreenInput`): every surface the mouse can
//! activate — the transcript window's activity cards, the editor's
//! content rows, and the `/model` and `/effort` picker rows — projects
//! its row geometry during the frame composition that already computes
//! it, so a click hit-tests a bounded scan over the visible rows and
//! never re-walks transcript geometry.
//!
//! The actions mirror the keyboard grammar: an activity card toggles its
//! own expansion (TS per-component `expanded`), an editor content row
//! places the caret (TS `placeCursorFromClick`), and a picker row moves
//! the selection.

use super::AgentView;
use crate::chat::ChatEntry;

/// The action a plain click on one projected surface performs (the
/// `onClick` of TS's `ClickRegion`, specialized to the port's action
/// vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickAction {
    /// Toggle the card at this chat-entry index (an expandable
    /// transcript row).
    ToggleCardExpansion(usize),
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
    /// Open the activity dock group the click landed on (the dock's
    /// Enter route — the click is an explicit user choice: it moves
    /// the dock's selection to the group, takes the focus, and opens
    /// the group's own view, operator directive 2026-09-29). The
    /// target spans one group's rendered segment — the separators
    /// between groups stay inert.
    OpenDockGroup(crate::chrome::ActivityGroup),
    /// The tray's `← manage` hint: perform the hinted action — the
    /// left arrow's agents-back handoff, which hands the pane to the
    /// agents view (operator directive 2026-09-29). The target spans
    /// the hint's own cells; the depth label beside it is metadata.
    /// The dispatch gates on the empty editor like `app.agents.back`,
    /// the key the hint names.
    OpenAgentsView,
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
    /// Rows the header block inserts above the content (the queue-browse
    /// header, an action composer's header; TS `getContentLineOffset`).
    pub(crate) content_offset: usize,
    /// The rendered prompt's visible width (`> `, `! `, `!! `).
    pub(crate) prompt_width: usize,
    /// The width the editor's layout wrapped at.
    pub(crate) content_width: usize,
}

/// One dock-row region the mouse can activate (the hover + click
/// affordance pass's dock surfaces): the tray's `← manage` hint and the
/// activity dock's group segments — dock-row indexed like the editor
/// surface, so a click maps through the same un-cropped dock rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DockClickRegion {
    /// The region's row in the un-cropped dock.
    pub(crate) dock_row: usize,
    /// The row columns the region's spans occupy, start inclusive, end
    /// exclusive (the separator cells between dock groups stay inert).
    pub(crate) cols: std::ops::Range<usize>,
    pub(crate) action: ClickAction,
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
    /// The tray's hint and the dock's group segments (the dock's
    /// clickable chrome rows — `render_dock` records them as it
    /// composes).
    pub(super) dock_regions: Vec<DockClickRegion>,
}

impl ClickSurface {
    /// Reset for a fresh frame composition.
    pub(super) fn clear(&mut self) {
        *self = ClickSurface::default();
    }

    /// Record one dock-row region (the tray's `← manage` hint or one
    /// activity dock group segment).
    pub(super) fn record_dock_region(&mut self, region: DockClickRegion) {
        self.dock_regions.push(region);
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
        // The dock's clickable chrome rows — the tray's `← manage` hint
        // and the activity dock's group segments — resolve before the
        // editor (their rows are never editor content rows, and a frame
        // whose dock a picker owns records none).
        if let Some(action) = click
            .dock_regions
            .iter()
            .find(|region| {
                region.dock_row == dock_row
                    && screen_col >= region.cols.start
                    && screen_col < region.cols.end
            })
            .map(|region| region.action)
        {
            return Some(action);
        }
        let editor = click.editor?;
        // The content rows follow the surface's top border and the
        // queue-selection header (TS `getClickRegions`'s line base).
        let content_row = dock_row
            .checked_sub(editor.dock_row + 1 + editor.content_offset)
            .filter(|row| *row < editor.rows)?;
        Some(ClickAction::PlaceCaret {
            row: content_row,
            // The row's text starts after the leading pad and the prompt.
            col: screen_col.saturating_sub(editor.prompt_width + 2),
            content_width: editor.content_width,
        })
    }

    /// The dock-row region covering one screen cell, if any (the hover
    /// band's column span: the frame paints the light background over
    /// exactly the region the mouse rests on).
    pub(crate) fn dock_region_at(
        &self,
        screen_row: usize,
        screen_col: usize,
    ) -> Option<&DockClickRegion> {
        let click = &self.click;
        if screen_row < click.dock_screen_origin {
            return None;
        }
        let dock_row = screen_row - click.dock_screen_origin + click.dock_cropped;
        click.dock_regions.iter().find(|region| {
            region.dock_row == dock_row
                && screen_col >= region.cols.start
                && screen_col < region.cols.end
        })
    }

    /// Record the mouse's hover position (operator directives
    /// 2026-09-26 + 2026-09-29: the hovered clickable row re-styles so
    /// clickability is discoverable). Only a hover-affordance target
    /// holds the hover — a clickable card row, a dock group segment, or
    /// the tray's `← manage` hint — anything else clears it. The state
    /// changes when the hover crosses onto or off of a target row, and
    /// when it lands on a DIFFERENT target on the same row — the dock's
    /// groups share one row, and the band must follow the mouse across
    /// the segments, so the highlighted group and the group a click
    /// opens can never disagree. Within one target the affordance is
    /// row-level: a motion burst across a card row schedules one
    /// render per crossing, not one per report.
    pub(crate) fn note_hover(&mut self, row: usize, col: usize) -> bool {
        let target = self.click_target_at(row, col);
        let hover = matches!(
            target,
            Some(
                ClickAction::ToggleCardExpansion(_)
                    | ClickAction::OpenDockGroup(_)
                    | ClickAction::OpenAgentsView
            )
        )
        .then_some((row, col));
        let changed = match (self.hover_pos, hover) {
            (Some((hover_row, hover_col)), Some((row, _))) => {
                hover_row != row || self.click_target_at(hover_row, hover_col) != target
            }
            (Some(_), None) | (None, Some(_)) => true,
            (None, None) => false,
        };
        self.hover_pos = hover;
        changed
    }

    /// The click action for one transcript window row: a row inside a
    /// visible tool card, bash card, or TS `Clickable` custom row
    /// (agent message, shell completion, compaction summary,
    /// refinement outcome, skill invocation, injected prompt) toggles
    /// that row's own expansion. Other rows (user, assistant, status,
    /// slash, panels) are not clickable.
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
                | ChatEntry::CompactionSummary { .. }
                | ChatEntry::RefinementOutcome(_)
                | ChatEntry::SkillInvocation(_)
                | ChatEntry::InjectedPrompt(_)
        ))
        .then_some(ClickAction::ToggleCardExpansion(section.entry))
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
    fn a_click_on_a_card_row_targets_that_card() {
        let view = frame_with_a_card();
        let card_row = section_screen_row(&view, 1);
        assert_eq!(
            view.click_target_at(card_row, 2),
            Some(ClickAction::ToggleCardExpansion(1))
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
                Some(ClickAction::ToggleCardExpansion(1))
            );
        }
    }

    /// The TS click-to-expand custom rows (compaction, refinement, skill,
    /// and injected prompt wrap their header in `Clickable`): a click
    /// targets the row, and the toggle opens its own body.
    #[test]
    fn a_click_expands_the_custom_message_rows() {
        use super::super::expansion::tests::transcript_text;
        use crate::custom_message::{
            InjectedPromptKind, InjectedPromptRow, RefinementOutcomeRow, SkillInvocationRow,
        };
        let rows = [
            (
                ChatEntry::CompactionSummary {
                    summary: "kept the plan".to_string(),
                    tokens_before: 1200,
                    custom_instructions: None,
                },
                "Compacted from",
            ),
            (
                ChatEntry::RefinementOutcome(Box::new(RefinementOutcomeRow {
                    header: "Harness refined".to_string(),
                    summary: "added a memory".to_string(),
                    meta: "refinement meta".to_string(),
                    edits: Vec::new(),
                })),
                "refinement meta",
            ),
            (
                ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
                    name: "websearch".to_string(),
                    content: "skill body".to_string(),
                })),
                "skill body",
            ),
            (
                ChatEntry::InjectedPrompt(Box::new(InjectedPromptRow {
                    kind: InjectedPromptKind::Heartbeat { schedule: None },
                    body: Some("prompt body".to_string()),
                })),
                "prompt body",
            ),
        ];
        for (entry, body) in rows {
            let mut view = view();
            view.push_entry(entry);
            view.render_frame(60, 20);
            assert_eq!(
                view.click_target_at(section_screen_row(&view, 0), 2),
                Some(ClickAction::ToggleCardExpansion(0)),
                "{body}"
            );
            let collapsed = transcript_text(&mut view);
            assert!(!collapsed.contains(body), "{body} starts collapsed");
            view.toggle_card_expansion(0);
            let expanded = transcript_text(&mut view);
            assert!(expanded.contains(body), "{body} expands on click");
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

    /// The dock's own surfaces: the tray's `← manage` hint and the
    /// activity dock's group segments, over a dock that mounts with
    /// the heartbeats group live and the subagents group at zero (an
    /// empty group still renders and stays clickable, like the arrows
    /// keep it traversable).
    fn dock_frame(focused: crate::chrome::ActivityGroup) -> AgentView {
        let mut view = view();
        view.chrome.show_manage = true;
        view.chrome.activity = Some(crate::chrome::ActivityDock {
            heartbeats: 1,
            selected: focused,
            focused: true,
            ..Default::default()
        });
        view.editor.set_text("hello world");
        view.render_frame(80, 24);
        view
    }

    /// The screen row and columns one recorded dock region covers.
    fn region_span(view: &AgentView, wanted: &ClickAction) -> (usize, std::ops::Range<usize>) {
        let region = view
            .click
            .dock_regions
            .iter()
            .find(|region| &region.action == wanted)
            .unwrap_or_else(|| panic!("the region renders: {:?}", view.click.dock_regions));
        // The same screen mapping `click_target_at` inverts: a cropped
        // dock's regions index the un-cropped rows.
        let row = view.click.dock_screen_origin + region.dock_row - view.click.dock_cropped;
        (row, region.cols.clone())
    }

    #[test]
    fn the_dock_groups_and_the_manage_hint_resolve_click_targets() {
        let view = dock_frame(crate::chrome::ActivityGroup::Heartbeats);
        let (_, heartbeats) = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Heartbeats),
        );
        let (_, subagents) = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Subagents),
        );
        let (_, hint) = region_span(&view, &ClickAction::OpenAgentsView);
        // Every covered cell maps to the group's own open action.
        let groups_row = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Heartbeats),
        )
        .0;
        for col in heartbeats.clone() {
            assert_eq!(
                view.click_target_at(groups_row, col),
                Some(ClickAction::OpenDockGroup(
                    crate::chrome::ActivityGroup::Heartbeats
                )),
                "the heartbeats segment's column {col} opens the heartbeats view"
            );
        }
        for col in subagents.clone() {
            assert_eq!(
                view.click_target_at(groups_row, col),
                Some(ClickAction::OpenDockGroup(
                    crate::chrome::ActivityGroup::Subagents
                )),
                "the empty subagents segment stays clickable at column {col}"
            );
        }
        for col in hint {
            assert_eq!(
                view.click_target_at(region_span(&view, &ClickAction::OpenAgentsView).0, col),
                Some(ClickAction::OpenAgentsView),
                "the manage hint's column {col} hands the pane to the agents view"
            );
        }
        // The separator between two groups is inert, and so is every
        // cell between the hint's own text and the depth label.
        let between = subagents.end..heartbeats.start;
        for col in between {
            assert_eq!(view.click_target_at(groups_row, col), None);
        }
    }

    #[test]
    fn the_hover_tracks_the_dock_surfaces_row_level() {
        let mut view = dock_frame(crate::chrome::ActivityGroup::Heartbeats);
        let (group_row, heartbeats) = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Heartbeats),
        );
        // Crossing onto the group row arms the hover; a motion within
        // the same row changes nothing (the affordance is row-level).
        assert!(view.note_hover(group_row, heartbeats.start));
        assert_eq!(view.hover_pos, Some((group_row, heartbeats.start)));
        assert!(!view.note_hover(group_row, heartbeats.end - 1));
        // A motion onto the separator column clears it.
        let (hint_row, hint) = region_span(&view, &ClickAction::OpenAgentsView);
        assert!(view.note_hover(group_row, 0));
        assert_eq!(view.hover_pos, None);
        // The tray hint holds the hover the same way.
        assert!(view.note_hover(hint_row, hint.start));
        assert_eq!(view.hover_pos, Some((hint_row, hint.start)));
        // A motion onto a plain row (the editor's border row above the
        // tray) clears it again.
        assert!(view.note_hover(hint_row - 2, 1));
        assert_eq!(view.hover_pos, None);
    }

    /// The dock's hover affordance (operator directive 2026-09-29): the
    /// hovered group's segment carries the ONE light hover band over
    /// exactly its own cells, the focused group's selection band
    /// stays, and the tray's hovered hint band lands on the hint's own
    /// text — the one-color ruling paints both states with the same
    /// band color, so the row reads as one band per state, never a
    /// repaint of the other.
    #[test]
    fn the_dock_hover_paints_the_one_band_and_never_demotes_the_selection() {
        let mut view = dock_frame(crate::chrome::ActivityGroup::Heartbeats);
        let (group_row, subagents) = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Subagents),
        );
        let (hint_row, hint) = region_span(&view, &ClickAction::OpenAgentsView);
        let light = view.theme.hover_row_style().bg;
        let gray = view.theme.selection_row_style().bg;
        assert_eq!(
            gray, light,
            "the selection paints the hover's own color — the one-color ruling"
        );
        // Hover the EMPTY subagents segment while the heartbeats group
        // holds the focused selection: the subagents cells gain the
        // band, the heartbeats cells keep theirs.
        assert!(view.note_hover(group_row, subagents.start));
        let hovered = view.render_frame(80, 24);
        let row_text = hovered[group_row]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(row_text.contains("subagents"), "the dock row renders");
        let band = |cols: &std::ops::Range<usize>| {
            let mut col = 0usize;
            let mut cells = Vec::new();
            for span in &hovered[group_row] {
                let width = crate::width::str_width(&span.content);
                let covered = col.max(cols.start) < (col + width).min(cols.end);
                if covered {
                    cells.push(span.style.bg);
                }
                col += width;
            }
            cells
        };
        assert!(
            band(&subagents).iter().all(|bg| *bg == light),
            "the hovered group's cells carry the light hover band"
        );
        let heartbeats = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Heartbeats),
        )
        .1;
        assert!(
            band(&heartbeats).iter().all(|bg| *bg == gray),
            "the focused group's cells keep the selection band under the hover"
        );
        // The manage hint's own cells band the same way.
        assert!(view.note_hover(hint_row, hint.start));
        let hovered = view.render_frame(80, 24);
        let hint_cells: Vec<_> = hovered[hint_row]
            .iter()
            .take_while(|span| !span.content.trim().is_empty() || span.style.bg.is_some())
            .collect();
        assert!(
            hint_cells.iter().any(|span| span.style.bg == light),
            "the hovered hint carries the light band: {hint_cells:?}"
        );
        // A hover onto the FOCUSED group keeps the selection band:
        // the paint skips cells that already carry a background, so
        // the selection is never demoted.
        assert!(view.note_hover(group_row, heartbeats.start));
        let hovered = view.render_frame(80, 24);
        let mut col = 0usize;
        let mut kept = true;
        for span in &hovered[group_row] {
            let width = crate::width::str_width(&span.content);
            let covered = col.max(heartbeats.start) < (col + width).min(heartbeats.end);
            if covered && span.style.bg != gray {
                kept = false;
            }
            col += width;
        }
        assert!(kept, "the hovered focused group keeps its band");
    }

    /// The dock's groups share one row: a hover that moves from one
    /// segment onto another ON THE SAME ROW is a change (the band
    /// follows the mouse — the highlighted group and the group a
    /// click opens can never disagree), while a motion within one
    /// segment still batches to a single render per crossing.
    #[test]
    fn the_hover_follows_the_mouse_across_the_dock_row() {
        let mut view = dock_frame(crate::chrome::ActivityGroup::Heartbeats);
        let (group_row, subagents) = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Subagents),
        );
        let shells = region_span(
            &view,
            &ClickAction::OpenDockGroup(crate::chrome::ActivityGroup::Bash),
        )
        .1;
        // Crossing onto the subagents segment changes the state.
        assert!(view.note_hover(group_row, subagents.start));
        let first = view.render_frame(80, 24);
        // Moving WITHIN the segment changes nothing.
        assert!(!view.note_hover(group_row, subagents.end - 1));
        // Crossing onto the shells segment on the SAME row changes the
        // state, and the repaint moves the band with it.
        assert!(
            view.note_hover(group_row, shells.start),
            "the same-row group switch is a hover change"
        );
        let light = view.theme.hover_row_style().bg;
        let band = |frame: &Vec<crate::Line>, cols: &std::ops::Range<usize>| {
            let mut col = 0usize;
            let mut banded = false;
            for span in &frame[group_row] {
                let width = crate::width::str_width(&span.content);
                let covered = col.max(cols.start) < (col + width).min(cols.end);
                if covered && span.style.bg == light {
                    banded = true;
                }
                col += width;
            }
            banded
        };
        assert!(band(&first, &subagents), "the first hover banded subagents");
        let second = view.render_frame(80, 24);
        assert!(
            !band(&second, &subagents),
            "the band left the subagents segment"
        );
        assert!(
            band(&second, &shells),
            "the band followed the mouse onto the shells segment"
        );
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

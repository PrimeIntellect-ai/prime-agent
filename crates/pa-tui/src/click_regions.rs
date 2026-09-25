//! Fullscreen click regions (TS `packages/tui/src/click-regions.ts` plus
//! the projection and hit-test halves of `fullscreen.ts`, PR #2430).
//!
//! Components register click regions during render in their own output
//! coordinates; the fullscreen frame composition projects them onto
//! screen rows, and a clean unmodified left press/release pair dispatches
//! them. Hyperlinks keep precedence over regions at the press position,
//! and pixels painted over the frame (the paused-viewport follow hint)
//! swallow clicks aimed at content beneath.
//!
//! The rust transcript renders from cached rows instead of a live
//! component tree, so the "render-time" regions are collected where the
//! rows come from: [`crate::view`] records each entry's toggle rows with
//! its [`crate::view::layout::EntryLayout`] and the dock's editor layout
//! snapshot, then projects both through the same header/window/dock
//! geometry the frame compose just established (TS
//! `projectHeaderRegion`/`projectTranscriptRegion`/`projectDockRegion`).

use crate::hyperlinks::LinkRange;

/// What a click surface does when a clean release lands on it. The
/// position handed to the action is region-relative (TS
/// `ClickRegion.onClick(position)`): the row distance from the region's
/// anchor and the clicked column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickAction {
    /// Toggle one transcript entry's own expansion (TS `Clickable` over a
    /// component's header/summary rows); `index` is the chat index.
    ToggleEntry { index: usize },
    /// Toggle the side-question pane's bash block (TS `Clickable` over
    /// the pane's `BashExecutionComponent` header).
    ToggleSidePaneBash,
    /// Focus the editor and place the caret at the clicked cell (TS
    /// `Editor.placeCursorFromClick`); the row is the visible layout
    /// line index, the column the frame column.
    EditorCursor,
}

/// One projected click target: a frame row, a column range, and the
/// region's anchor row (the frame row of the region's top line — click
/// positions stay relative to it even when earlier rows clipped away).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameClickTarget {
    /// Frame row this target occupies.
    pub row: usize,
    /// Frame column of the region's left edge.
    pub col: usize,
    /// Region width in columns.
    pub width: usize,
    /// Frame row of the region's top line (positions anchor here).
    pub anchor: usize,
    pub action: ClickAction,
}

/// The transcript click surfaces a window shows, in absolute transcript
/// rows: each visible entry's start row and the tail section's start row.
/// Both window walks produce it (the exact layout pass and the sparse
/// walk); the frame compose projects the entries' click rows through the
/// window's start to screen rows.
#[derive(Debug, Clone, Default)]
pub(crate) struct WindowClickMap {
    /// (chat index, absolute transcript row of the entry's first row).
    pub entries: Vec<(usize, usize)>,
    /// Absolute transcript row of the tail section's first row, when the
    /// window shows the tail.
    pub tail_start: Option<usize>,
}

/// The editor layout snapshot of the last dock render — the click
/// authority for [`ClickAction::EditorCursor`] (TS `Editor.clickLayout`).
#[derive(Debug, Clone)]
pub(crate) struct EditorClickMap {
    /// Visible layout lines, top to bottom (TS `layoutLines` sliced to
    /// the scroll window).
    pub visible: Vec<crate::editor::LayoutLine>,
    /// Frame column the first line's text starts at (the leading pad,
    /// the prompt prefix, the inner pad).
    pub text_col: usize,
    /// Dock row of the first content row (TS `getContentLineOffset`
    /// shifts the region with the editor's own header rows): the surface
    /// row plus the parked-message header pair, moved to dock
    /// coordinates by `render_dock`, mapped through the dock crop by the
    /// frame compose.
    pub first_dock_row: usize,
}

/// The click surfaces and hyperlinks of the last composed frame
/// (TS `FullscreenViewport.frameClickTargets` + `hyperlinkAt`).
#[derive(Debug, Clone, Default)]
pub(crate) struct FrameClicks {
    targets: Vec<FrameClickTarget>,
    links: Vec<LinkRange>,
}

impl FrameClicks {
    /// One full-width toggle row at `row` (TS regions cover the
    /// component's full rendered width, `col: 0`).
    pub fn push_toggle(&mut self, action: ClickAction, row: usize, width: usize) {
        self.targets.push(FrameClickTarget {
            row,
            col: 0,
            width,
            anchor: row,
            action,
        });
    }

    /// One full-width editor content row; the anchor is the first content
    /// row so the dispatched row is the visible-line index.
    pub fn push_editor_row(&mut self, row: usize, anchor: usize, width: usize) {
        self.targets.push(FrameClickTarget {
            row,
            col: 0,
            width,
            anchor,
            action: ClickAction::EditorCursor,
        });
    }

    /// The OSC 8 hyperlinks of the composed frame (hit-test truth).
    pub fn set_links(&mut self, links: Vec<LinkRange>) {
        self.links = links;
    }

    /// Drop click coverage under pixels painted over the frame (TS
    /// `subtractFrameClickCoverage`): a covered row keeps only the
    /// fragments outside `[from, to)`.
    pub fn subtract_coverage(&mut self, row: usize, from: usize, to: usize) {
        let mut fragments: Vec<FrameClickTarget> = Vec::new();
        self.targets.retain_mut(|target| {
            if target.row != row {
                return true;
            }
            let end = target.col + target.width;
            if to <= target.col || from >= end {
                return true;
            }
            if target.col < from {
                fragments.push(FrameClickTarget {
                    width: from - target.col,
                    ..*target
                });
            }
            if to < end {
                fragments.push(FrameClickTarget {
                    col: to,
                    width: end - to,
                    ..*target
                });
            }
            false
        });
        self.targets.append(&mut fragments);
    }

    /// The click target covering a screen position in the last composed
    /// frame (TS `clickTargetAt`).
    pub fn target_at(&self, row: usize, col: usize) -> Option<FrameClickTarget> {
        self.targets.iter().copied().find(|target| {
            target.row == row && col >= target.col && col < target.col + target.width
        })
    }

    /// Debug view of the links (the click e2e's tracing).
    pub(crate) fn debug_links(&self) -> Vec<(usize, usize, usize, String)> {
        self.links
            .iter()
            .map(|l| (l.row, l.start_col, l.end_col, l.url.clone()))
            .collect()
    }

    /// Debug view of the targets (the click e2e's tracing).
    pub(crate) fn debug_targets(&self) -> Vec<FrameClickTarget> {
        self.targets.clone()
    }

    /// The OSC 8 hyperlink URL at a screen position, if any (TS
    /// `hyperlinkAt`).
    pub fn link_at(&self, row: usize, col: usize) -> Option<&str> {
        self.links
            .iter()
            .find(|link| link.row == row && col >= link.start_col && col < link.end_col)
            .map(|link| link.url.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(row: usize, col: usize, width: usize) -> FrameClickTarget {
        FrameClickTarget {
            row,
            col,
            width,
            anchor: row,
            action: ClickAction::ToggleEntry { index: 0 },
        }
    }

    #[test]
    fn hit_tests_target_columns_and_rows() {
        let mut clicks = FrameClicks::default();
        clicks.push_toggle(ClickAction::ToggleEntry { index: 3 }, 5, 40);
        assert_eq!(
            clicks.target_at(5, 39).map(|t| t.action),
            Some(ClickAction::ToggleEntry { index: 3 })
        );
        assert!(clicks.target_at(5, 40).is_none(), "past the right edge");
        assert!(clicks.target_at(4, 0).is_none(), "row above");
        assert!(clicks.target_at(6, 0).is_none(), "row below");
    }

    #[test]
    fn coverage_subtraction_splits_and_drops_targets() {
        let mut clicks = FrameClicks::default();
        clicks.targets.push(target(7, 10, 20));
        clicks.targets.push(target(8, 0, 40));
        // Cover [15, 25): the row-7 target splits, the row-8 one is untouched.
        clicks.subtract_coverage(7, 15, 25);
        let row7: Vec<FrameClickTarget> = clicks
            .targets
            .iter()
            .filter(|t| t.row == 7)
            .copied()
            .collect();
        assert_eq!(row7.len(), 2, "the covered target split into fragments");
        assert_eq!((row7[0].col, row7[0].width), (10, 5));
        assert_eq!((row7[1].col, row7[1].width), (25, 5));
        assert!(
            clicks.target_at(7, 20).is_none(),
            "the covered span is gone"
        );
        assert!(clicks.target_at(7, 14).is_some());
        assert!(clicks.target_at(7, 26).is_some());
        assert!(clicks.target_at(8, 20).is_some(), "other rows unaffected");
        // Full coverage drops the target entirely.
        clicks.subtract_coverage(8, 0, 40);
        assert!(clicks.target_at(8, 20).is_none());
    }

    #[test]
    fn links_hit_test_within_their_column_span() {
        let mut clicks = FrameClicks::default();
        clicks.set_links(vec![LinkRange {
            row: 2,
            start_col: 4,
            end_col: 12,
            url: "https://example.com/docs".to_string(),
        }]);
        assert_eq!(clicks.link_at(2, 4), Some("https://example.com/docs"));
        assert_eq!(clicks.link_at(2, 11), Some("https://example.com/docs"));
        assert_eq!(clicks.link_at(2, 12), None, "end column is exclusive");
        assert_eq!(clicks.link_at(2, 3), None);
        assert_eq!(clicks.link_at(3, 4), None);
    }
}

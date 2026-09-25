//! The condensed tool runs' integration into the transcript geometry
//! (the [`crate::tool_runs`] model drives it): in the collapsed detail
//! mode a qualifying run's block renders on its first entry and the
//! other members render nothing, so every per-entry consumer - the
//! layout pass, the sparse window, the count/render pair - keeps its
//! per-entry shape and the block stays a first-class cached unit. The
//! chat mutations (pushes, pops, in-place card and message updates)
//! rebuild the run map's affected suffix and fold the row-count change
//! into the sparse window through the run's owning index, so a paused
//! window watching a live run stays on its rows.

use super::AgentView;
use crate::chat::{ChatEntry, Detail};
use crate::tool_runs::{self, is_run_glue, RunSlot, ToolRun};

impl AgentView {
    /// Paint one entry's collapsed-mode rows when a qualifying run covers
    /// it: the block on the run's start, nothing on the other members.
    /// `None` renders the entry itself (no run, or another detail mode).
    pub(super) fn render_condensed(&self, index: usize, width: usize) -> Option<Vec<crate::Line>> {
        if self.detail != Detail::Overview {
            return None;
        }
        match self.run_map.slot(index) {
            Some(RunSlot::Start(run)) => {
                let summary = tool_runs::run_summary(&self.chat, run);
                let mut rows: Vec<crate::Line> = Vec::new();
                if self.conversation_leading(index, false) {
                    rows.push(Vec::new());
                }
                rows.extend(tool_runs::render_run_block(
                    &summary,
                    self.pulse_frame,
                    &self.theme,
                    width,
                ));
                Some(rows)
            }
            Some(RunSlot::Member) => Some(Vec::new()),
            _ => None,
        }
    }

    /// The count counterpart of [`Self::render_condensed`].
    pub(super) fn count_condensed(&self, index: usize, width: usize) -> Option<usize> {
        if self.detail != Detail::Overview {
            return None;
        }
        match self.run_map.slot(index) {
            Some(RunSlot::Start(run)) => {
                let summary = tool_runs::run_summary(&self.chat, run);
                // The block's leading blank rides the same conversation
                // spacing decision a tool card's row would.
                Some(
                    usize::from(self.conversation_leading(index, false))
                        + tool_runs::run_block_rows(&summary, width),
                )
            }
            Some(RunSlot::Member) => Some(0),
            _ => None,
        }
    }

    /// Whether one entry's cached rows are stable, run-aware: a block
    /// re-renders on every frame while any of its run's cards animates
    /// (queued or running) or a member message streams; a member's own
    /// (empty) rows are always stable.
    pub(super) fn entry_cacheable_at(&self, index: usize, entry: &ChatEntry) -> bool {
        if self.detail == Detail::Overview {
            match self.run_map.slot(index) {
                Some(RunSlot::Start(run)) => {
                    let stable = |member: &ChatEntry| match member {
                        ChatEntry::Tool(card) => {
                            !matches!(
                                crate::tool_card::panel_status(card),
                                crate::tool_card::PanelStatus::Queued
                                    | crate::tool_card::PanelStatus::Running
                            ) && !crate::tool_card::ipython::background_shell_running(card)
                        }
                        ChatEntry::Assistant(message) => !message.streaming,
                        _ => true,
                    };
                    self.chat[run.start..run.end].iter().all(stable)
                }
                Some(RunSlot::Member) => true,
                _ => self.entry_cacheable(entry),
            }
        } else {
            self.entry_cacheable(entry)
        }
    }

    /// The earliest index of the maximal tool-and-glue member sequence
    /// whose shape a change at `index` can move: walk back from `index`
    /// over run glue (tool cards and hidden assistant messages), so a
    /// push, a pop, or a membership flip rebuilds the map from the
    /// sequence's own start.
    pub(super) fn member_start(&self, index: usize) -> usize {
        let mut start = index.min(self.chat.len().saturating_sub(1));
        while start > 0 && is_run_glue(&self.chat[start - 1]) {
            start -= 1;
        }
        start
    }

    /// The total rendered rows of the suffix starting at `start` (fresh
    /// counts, never the caches): the row-count change a mutation folds
    /// into the sparse window's bookkeeping.
    pub(super) fn suffix_rows(&self, start: usize, width: usize) -> usize {
        self.chat[start..]
            .iter()
            .enumerate()
            .map(|(offset, _)| self.count_entry_rows(start + offset, width))
            .sum()
    }

    /// Drop the cached layouts and heights of the suffix (a run's shape
    /// or content changed there): the block and its members re-render,
    /// and the invalidated member rows never leave the window on stale
    /// geometry.
    pub(super) fn invalidate_run_suffix(&mut self, start: usize) {
        for index in start..self.chat.len() {
            if let Some(slot) = self.entry_layout.get_mut(index) {
                *slot = [None, None, None];
            }
            if let Some(slot) = self.entry_heights.get_mut(index) {
                *slot = [None, None, None];
            }
        }
    }

    /// The condensed runs in transcript order (the runs view's list).
    pub(crate) fn condensed_runs(&self) -> Vec<ToolRun> {
        let mut runs = Vec::new();
        for index in 0..self.chat.len() {
            if let Some(run) = self.run_map.run_at(index) {
                runs.push(run);
            }
        }
        runs
    }
}

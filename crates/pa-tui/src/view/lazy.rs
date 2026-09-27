//! Sparse fullscreen windows. Unknown global row totals are resolved only
//! for callers that require absolute coordinates (selection and scroll info).
use super::{layout::EntryLayout, layout::EntryRows, layout::RowPack, AgentView};
use crate::chat::Detail;

/// The row count above which packing frees a large enough transient that
/// the freed heap is returned to the OS immediately (allocator plumbing;
/// no output-path effect). Ordinary transcript entries render far fewer
/// rows; only a resumed session's pad-scale row sets cross this.
const HUGE_PACKED_ROWS: usize = 8192;

use crate::chrome::render_splash;
use crate::Line;

#[cfg(test)]
thread_local! {
    /// Splash renders the last sparse walk spent (the lazy end-section
    /// verifier: a frame whose window cannot reach the splash renders it
    /// zero times).
    pub(super) static SPLASH_RENDERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Tail renders the last sparse walk spent (see [`SPLASH_RENDERS`]).
    pub(super) static TAIL_RENDERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
#[path = "lazy_tests.rs"]
mod tests;

// Private selection coordinates increase down the screen while tail-relative
// distances increase upwards. Never returned as global transcript metadata.
pub(crate) const TAIL_SELECTION_ORIGIN: usize = usize::MAX / 2;

#[derive(Clone, Copy)]
enum Anchor {
    Tail(usize),
    Top(usize),
}

#[derive(Clone, Copy)]
pub(super) struct SparseWindow {
    anchor: Anchor,
    detail: Detail,
    width: usize,
    visible_rows: usize,
    cursor: Option<(usize, usize)>,
    pending: isize,
}

impl SparseWindow {
    pub(super) fn top(detail: Detail, width: usize) -> Self {
        Self {
            anchor: Anchor::Top(0),
            detail,
            width,
            visible_rows: 0,
            cursor: None,
            pending: 0,
        }
    }

    pub(super) fn at_tail(&self) -> bool {
        matches!(self.anchor, Anchor::Tail(0))
    }

    pub(super) fn scroll_by(&mut self, delta: isize) {
        self.anchor = match self.anchor {
            Anchor::Tail(distance) => {
                let next = distance.saturating_add_signed(delta.saturating_neg());
                self.pending = self
                    .pending
                    .saturating_add(distance as isize - next as isize);
                Anchor::Tail(next)
            }
            Anchor::Top(offset) => {
                let next = offset.saturating_add_signed(delta);
                self.pending = self.pending.saturating_add(next as isize - offset as isize);
                Anchor::Top(next)
            }
        };
    }
}

impl AgentView {
    /// Whether the sparse window anchors to the transcript end (its
    /// selection coordinates are tail-relative) or to an absolute row.
    pub(super) fn sparse_window_is_tail_anchored(&self) -> bool {
        self.sparse_window
            .is_some_and(|window| matches!(window.anchor, Anchor::Tail(_)))
    }

    /// Fold a chat append or entry growth of `delta` rows at entry
    /// `index` into the sparse window's bookkeeping (TS keeps `scrollTop`
    /// while content changes: a paused window stays on its absolute row,
    /// and the scroll room below it grows with the content). A paused
    /// Tail-anchored window keeps that absolute row wherever the growth
    /// lands: the anchor distance grows by `delta`, the tail-relative
    /// selection endpoints move with growth at or below them, and a
    /// walked cursor above the growth re-walks the shifted rows through
    /// `pending`. A Top-anchored window (absolute rows) never moves;
    /// only the scroll bound grows. A following window re-derives from
    /// the end, so its distance stays zero. Without a sparse window
    /// (exact geometry) the next frame's layout pass recomputes
    /// everything.
    pub(super) fn sparse_tail_delta(&mut self, delta: isize, index: usize) {
        if delta == 0 {
            return;
        }
        let Some(mut window) = self.sparse_window else {
            return;
        };
        self.last_max_scroll = (self.last_max_scroll as isize + delta).max(0) as usize;
        match window.anchor {
            Anchor::Top(_) => {}
            Anchor::Tail(distance) => {
                // Whether the growth sits above the window's first visible
                // entry: with a walked cursor that is the cursor's
                // section, without one (a following window re-derived
                // from the end) only the tail entry itself is in view.
                let above = match window.cursor {
                    Some((section, _)) => index + 1 < section,
                    None => index + 1 < self.chat.len(),
                };
                if !self.following {
                    window.anchor = Anchor::Tail((distance as isize + delta).max(0) as usize);
                    // The cursor still points at the content it was
                    // placed on; growth above the window shifted that
                    // content down, so the window start re-walks to it.
                    if above && window.cursor.is_some() {
                        window.pending = window.pending.saturating_sub(delta);
                    }
                }
                if !above {
                    self.shift_tail_selection_points(delta);
                }
            }
        }
        self.sparse_window = Some(window);
    }

    /// The delta of a just-appended entry: the push landed, so its rows are
    /// countable under the window's geometry.
    pub(super) fn sparse_note_append(&mut self) {
        let Some(window) = self.sparse_window else {
            return;
        };
        if window.width == 0 {
            return;
        }
        let rows = self.count_entry_rows(self.chat.len() - 1, window.width);
        self.sparse_tail_delta(rows as isize, self.chat.len() - 1);
    }

    pub(crate) fn selection_window_start(&self) -> usize {
        match self.sparse_window.map(|window| window.anchor) {
            Some(Anchor::Tail(distance)) => TAIL_SELECTION_ORIGIN
                .saturating_sub(distance)
                .saturating_sub(self.sparse_window.unwrap().visible_rows),
            Some(Anchor::Top(offset)) => offset,
            None => self.scroll_top,
        }
    }

    /// Extract a logical row range from the current exact sparse cursor.
    /// The coordinate origin cancels in the displacement, so tail selections
    /// need neither a global row count nor a transcript-wide layout pass.
    pub(crate) fn sparse_selection_rows(
        &mut self,
        start: usize,
        height: usize,
    ) -> Option<Vec<Line>> {
        let window = self.sparse_window?;
        if window.detail != self.detail || window.width != self.layout_width {
            return None;
        }
        let (mut section, mut row) = window.cursor?;
        let origin = self.selection_window_start();
        let mut movement = if start >= origin {
            isize::try_from(start - origin).ok()?
        } else {
            isize::try_from(origin - start).ok()?.checked_neg()?
        }
        .checked_add(window.pending)?;
        let last = self.chat.len() + 1;
        let mut splash: Option<std::sync::Arc<Vec<Line>>> = None;
        let mut tail: Option<std::sync::Arc<Vec<Line>>> = None;
        // The end sections render only when the walk reaches them: a
        // selection inside the transcript never pays for the splash or
        // the streaming tail content it cannot show.
        let mut section_rows = |view: &mut Self, section: usize| {
            if section == 0 {
                let splash = splash.get_or_insert_with(|| {
                    #[cfg(test)]
                    SPLASH_RENDERS.with(|count| count.set(count.get() + 1));
                    // The suppressed splash is an empty section: the
                    // sparse walker skips zero-row sections exactly
                    // like an empty tail.
                    if view.splash_suppressed {
                        std::sync::Arc::new(Vec::new())
                    } else {
                        std::sync::Arc::new(render_splash(&view.chrome, &view.theme, window.width))
                    }
                });
                EntryRows::Fresh(splash.clone())
            } else if section == last {
                let tail = tail.get_or_insert_with(|| {
                    #[cfg(test)]
                    TAIL_RENDERS.with(|count| count.set(count.get() + 1));
                    std::sync::Arc::new(view.render_transcript_tail(window.width))
                });
                EntryRows::Fresh(tail.clone())
            } else {
                view.sparse_entry_rows(section - 1, window.width)
            }
        };
        while movement < 0 {
            let step = row.min(movement.unsigned_abs());
            row -= step;
            movement += step as isize;
            if movement == 0 || section == 0 {
                break;
            }
            section -= 1;
            row = section_rows(self, section).len();
        }
        while movement > 0 {
            let count = section_rows(self, section).len();
            let step = count.saturating_sub(row).min(movement as usize);
            row += step;
            movement -= step as isize;
            if movement == 0 || section == last {
                break;
            }
            section += 1;
            row = 0;
        }
        let mut rows = Vec::new();
        while rows.len() < height && section <= last {
            let source = section_rows(self, section);
            let from = row.min(source.len());
            let to = from.saturating_add(height - rows.len()).min(source.len());
            rows.extend(source.range(from, to));
            section += 1;
            row = 0;
        }
        Some(rows)
    }

    pub(crate) fn resolve_sparse_geometry(&mut self) {
        let Some(window) = self.sparse_window.take() else {
            return;
        };
        self.sparse_enabled = false;
        // A window resolved while its detail went stale carries the
        // mode exit to the next composition's dense arm (the resolved
        // geometry is the old mode's; the first frame after it
        // re-derives the follow state — operator directive 2026-09-26).
        self.detail_transition = self.detail_transition || window.detail != self.detail;
        let detail = self.detail;
        self.detail = window.detail;
        let layout = crate::image_component::with_fullscreen_image_fallback(|| {
            self.layout_pass(window.width)
        });
        let total = layout.total;
        self.detail = detail;
        if matches!(window.anchor, Anchor::Tail(_)) {
            self.resolve_tail_selection(total);
        }
        self.last_max_scroll = total.saturating_sub(self.window_rows);
        self.scroll_top = match window.anchor {
            Anchor::Tail(distance) => self.last_max_scroll.saturating_sub(distance),
            Anchor::Top(offset) => offset.min(self.last_max_scroll),
        };
    }

    pub(super) fn visible_transcript_window(
        &mut self,
        width: usize,
        height: usize,
    ) -> (Vec<Line>, usize) {
        // The window build restarts the click surface's section recording
        // (view/click.rs): a fresh window's spans replace the last
        // frame's, ahead of the two paths below.
        self.click.window_sections.clear();
        // A paused width change preserves the reference's absolute row
        // offset; a paused detail change keeps the walked cursor (the
        // window re-renders its entries under the new detail without
        // measuring the transcript around it).
        if self.sparse_window.is_some_and(|window| {
            !self.following && (window.width != width
                || matches!(window.anchor, Anchor::Tail(distance) if height > self.window_rows.saturating_add(distance)))
        }) {
            self.resolve_sparse_geometry();
        }
        if self.following
            && self.sparse_enabled
            && (!self.has_selection()
                || self
                    .sparse_window
                    .is_none_or(|window| matches!(window.anchor, Anchor::Tail(_))))
        {
            self.sparse_window = Some(SparseWindow {
                anchor: Anchor::Tail(0),
                detail: self.detail,
                width,
                visible_rows: 0,
                cursor: None,
                pending: 0,
            });
        }
        if self.sparse_window.is_none() {
            let layout = self.layout_pass(width);
            self.last_max_scroll = layout.total.saturating_sub(height);
            self.scroll_top = if self.following {
                self.last_max_scroll
            } else {
                self.scroll_top.min(self.last_max_scroll)
            };
            let rows = self.transcript_window(&layout, self.scroll_top, height);
            let (section, row) = layout.cursor_at(self.scroll_top);
            self.sparse_window = Some(SparseWindow {
                anchor: Anchor::Top(self.scroll_top),
                detail: self.detail,
                width,
                visible_rows: rows.len(),
                cursor: Some((section, row)),
                pending: 0,
            });
            self.sparse_enabled = true;
            // Only visible entries acquired Lines; exact heights remain cached.
            self.window_shows_tail = self.scroll_top >= self.last_max_scroll;
            // The mode exit's dense arm: the clamped scroll position
            // already sits at the bottom when the transition collapsed
            // the layout past the paused offset — the same rule
            // `scroll_by` re-derives following by.
            if self.detail_transition {
                self.detail_transition = false;
                if !self.following && self.window_shows_tail {
                    self.following = true;
                }
            }
            return (rows, self.scroll_top);
        }
        let mut window = self.sparse_window.expect("sparse window established above");
        if !self.following && height != self.window_rows {
            if let Anchor::Tail(distance) = &mut window.anchor {
                *distance = distance
                    .saturating_add(self.window_rows)
                    .saturating_sub(height);
            }
        }
        self.prepare_layout(width);
        // The mode exit's follow-state recompute (operator directive
        // 2026-09-26): a detail change rides the same walked window, and
        // the first composition after it re-derives the follow state
        // from the post-transition geometry below — a paused window
        // whose re-walked rows still reach the transcript tail is at
        // the bottom, not paused above new content.
        let detail_transition = window.detail != self.detail;
        window.detail = self.detail;
        window.width = width;
        let mut touched = Vec::new();
        let mut splash: Option<std::sync::Arc<Vec<Line>>> = None;
        let mut tail: Option<std::sync::Arc<Vec<Line>>> = None;
        let last = self.chat.len() + 1;
        let (mut section, mut row, mut movement) = if let Some((section, row)) = window.cursor {
            (section, row, window.pending)
        } else {
            match window.anchor {
                // The cursorless tail window walks down from the end, so
                // its tail section is in view: render it now (the walk
                // below reuses the same rows).
                Anchor::Tail(distance) => {
                    let rows = tail.get_or_insert_with(|| {
                        #[cfg(test)]
                        TAIL_RENDERS.with(|count| count.set(count.get() + 1));
                        std::sync::Arc::new(self.render_transcript_tail(width))
                    });
                    (
                        last,
                        rows.len(),
                        -(height.saturating_add(distance) as isize),
                    )
                }
                Anchor::Top(offset) => (0, 0, offset as isize),
            }
        };
        // The end sections render only when a walk reaches them: a paused
        // window in the middle of the transcript never pays for the splash
        // or the streaming tail content (the shortcut guide, the pending
        // bash output, the loaders) its rows cannot show.
        let mut section_rows = |view: &mut Self, section: usize| -> EntryRows {
            if section == 0 {
                let splash = splash.get_or_insert_with(|| {
                    #[cfg(test)]
                    SPLASH_RENDERS.with(|count| count.set(count.get() + 1));
                    // The suppressed splash is an empty section: the
                    // sparse walker skips zero-row sections exactly
                    // like an empty tail.
                    if view.splash_suppressed {
                        std::sync::Arc::new(Vec::new())
                    } else {
                        std::sync::Arc::new(render_splash(&view.chrome, &view.theme, width))
                    }
                });
                return EntryRows::Fresh(splash.clone());
            }
            if section == last {
                let tail = tail.get_or_insert_with(|| {
                    #[cfg(test)]
                    TAIL_RENDERS.with(|count| count.set(count.get() + 1));
                    std::sync::Arc::new(view.render_transcript_tail(width))
                });
                return EntryRows::Fresh(tail.clone());
            }
            touched.push(section - 1);
            view.sparse_entry_rows(section - 1, width)
        };
        while movement < 0 {
            let step = row.min(movement.unsigned_abs());
            row -= step;
            movement += step as isize;
            if movement == 0 || section == 0 {
                break;
            }
            section -= 1;
            row = section_rows(self, section).len();
        }
        while movement > 0 {
            let count = section_rows(self, section).len();
            let step = count.saturating_sub(row).min(movement as usize);
            row += step;
            movement -= step as isize;
            if movement == 0 || section == last {
                break;
            }
            section += 1;
            row = 0;
        }
        if movement < 0 {
            match &mut window.anchor {
                Anchor::Tail(distance) => {
                    *distance = distance.saturating_sub(movement.unsigned_abs());
                }
                Anchor::Top(offset) => *offset = offset.saturating_sub(movement.unsigned_abs()),
            }
        }
        window.pending = 0;
        window.cursor = Some((section, row));
        let mut rows = Vec::with_capacity(height);
        // Whether the fill consumed through the tail section's end: the
        // window shows the transcript tail (the follow-hint rule — the
        // walk's own truth, no extra geometry pass).
        let mut shows_tail = false;
        // Whether the last consumed section ended exactly at the
        // window's bottom (the height-exact boundary).
        let mut filled_to_section_end = false;
        while rows.len() < height && section <= last {
            let source = section_rows(self, section);
            let from = row.min(source.len());
            let to = from.saturating_add(height - rows.len()).min(source.len());
            let before = rows.len();
            rows.extend(source.range(from, to));
            filled_to_section_end = to == source.len();
            shows_tail = section == last && to == source.len();
            // The entry's visible span feeds the click surface's window
            // map (view/click.rs) — bounded by the rows on screen.
            if before < rows.len() && section >= 1 && section < last {
                self.click
                    .record_window_section(section - 1, before, rows.len());
            }
            section += 1;
            row = 0;
        }
        // The height-exact boundary: the window filled through a
        // section's end, so the sections below the boundary decide the
        // bottom signal — an empty tail (and hidden zero-row entries)
        // leaves the window at the transcript end even though the fill
        // loop never enters the empty tail section to set the flag
        // itself (the boundary case the review bots flagged: a window
        // that exactly ends on the final chat entry).
        if rows.len() == height && section <= last && filled_to_section_end {
            let mut peek = section;
            while peek <= last && section_rows(self, peek).is_empty() {
                peek += 1;
            }
            shows_tail = peek > last;
        }
        // A top-origin window reaching the tail needs the same bottom clamp
        // as the full renderer. Re-anchor from the end once, not per draw.
        if rows.len() < height && matches!(window.anchor, Anchor::Top(_)) && !self.chat.is_empty() {
            if self.has_selection() {
                // The walk ran out of content, so the transcript's total
                // row count is the window's start plus the rows it walked:
                // the selection endpoints rebase onto the tail frame
                // without an exact geometry pass (and without losing the
                // highlight, which the old full resolve could not express
                // against the re-anchored window).
                let Anchor::Top(offset) = window.anchor else {
                    unreachable!("the branch matched a top anchor");
                };
                let total = offset + rows.len();
                self.rebase_top_selection_to_tail(total);
                self.sparse_window = Some(SparseWindow {
                    anchor: Anchor::Tail(0),
                    detail: self.detail,
                    width,
                    visible_rows: 0,
                    cursor: None,
                    pending: 0,
                });
                self.following = true;
                return self.visible_transcript_window(width, height);
            }
            self.sparse_window = Some(SparseWindow {
                anchor: Anchor::Tail(0),
                detail: self.detail,
                width,
                visible_rows: 0,
                cursor: None,
                pending: 0,
            });
            self.following = true;
            return self.visible_transcript_window(width, height);
        }
        rows.truncate(height);
        window.visible_rows = rows.len();
        self.sparse_window = Some(window);
        self.window_shows_tail = shows_tail;
        // The mode-exit follow-state recompute: a detail change whose
        // re-walked window still reaches the tail is at the bottom —
        // the pause distance measured in the previous mode's rows
        // collapsed along with the layout, so the window resumes
        // following instead of hinting at a scroll that shows nothing
        // new (operator directive 2026-09-26).
        if detail_transition && !self.following && shows_tail {
            self.following = true;
        }
        let start = match window.anchor {
            Anchor::Tail(distance) => TAIL_SELECTION_ORIGIN
                .saturating_sub(distance)
                .saturating_sub(rows.len()),
            Anchor::Top(offset) => offset,
        };
        (rows, start)
    }

    pub(super) fn sparse_entry_rows(&mut self, index: usize, width: usize) -> EntryRows {
        #[cfg(test)]
        super::layout::ENTRY_VISITS.with(|count| count.set(count.get() + 1));
        self.sparse_entries.insert(index);
        let detail = match self.detail {
            Detail::Overview => 0,
            Detail::Details => 1,
            Detail::All => 2,
        };
        let entry = &self.chat[index];
        // TS `precededByToolActivity` = the compact set (see layout pass).
        let preceded_by_tool = index > 0 && self.is_compact_neighbor(&self.chat[index - 1]);
        let spacing = self.entry_spacing(index, entry, index == 0, preceded_by_tool);
        if self.entry_cacheable_at(index, entry) {
            if let Some(layout) = &self.entry_layout[index][detail] {
                if layout.spacing == spacing {
                    return EntryRows::Packed(layout.rows.clone());
                }
            }
        }
        let rows = std::sync::Arc::new(self.render_entry(
            index,
            entry,
            width,
            index == 0,
            preceded_by_tool,
        ));
        if self.entry_cacheable_at(index, entry) {
            // The cache is storage, not output: the entry's rows stay
            // resident for the process lifetime, so they are stored
            // packed (byte-exact expansion on read) instead of as the
            // renderers' fragment-sized spans — a scroll walk's
            // retention is the per-span chunk overhead, not the text.
            // `pack` refuses entries its records cannot represent
            // exactly, so an oversized entry keeps its Fresh rows.
            if let Some(packed) = RowPack::pack(&rows) {
                let packed = std::sync::Arc::new(packed);
                self.entry_layout[index][detail] = Some(EntryLayout {
                    spacing,
                    rows: packed.clone(),
                });
                // A huge entry's rendered rows are the transcript's
                // biggest single transient (the pad row set of a
                // resumed large session): the pack just replaced them,
                // and the freed pages only return to the OS if the
                // allocator's trim can reach them — so the expanded
                // rows drop BEFORE the trim, and the caller reads the
                // packed form (byte-exact expansion) instead of the
                // pad it would otherwise hold past the trim. Gate on
                // the row count so ordinary entries never pay a trim
                // call — only the rare huge materialization.
                let huge = rows.len() >= HUGE_PACKED_ROWS;
                drop(rows);
                if huge {
                    pa_types::memory_release::trim_freed_heap();
                }
                return EntryRows::Packed(packed);
            }
        }
        EntryRows::Fresh(rows)
    }
}

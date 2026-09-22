//! Sparse fullscreen windows. Unknown global row totals are resolved only
//! for callers that require absolute coordinates (selection and scroll info).
use super::{layout::EntryLayout, AgentView};
use crate::chat::{ChatEntry, Detail};
use crate::chrome::render_splash;
use crate::Line;

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
        let splash = std::sync::Arc::new(render_splash(&self.chrome, &self.theme, window.width));
        let tail = std::sync::Arc::new(self.render_transcript_tail(window.width));
        let last = self.chat.len() + 1;
        let section_rows = |view: &mut Self, section: usize| {
            if section == 0 {
                splash.clone()
            } else if section == last {
                tail.clone()
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
            rows.extend_from_slice(&source[from..to]);
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
        // Paused detail/width changes preserve the reference's absolute row
        // offset, not the previously visible entry.
        if self.sparse_window.is_some_and(|window| {
            !self.following && (window.detail != self.detail || window.width != width
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
            // Exact fallback rows remain available for future revisits.
            self.sparse_entries.extend(0..self.chat.len());
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
        window.detail = self.detail;
        window.width = width;
        let mut touched = Vec::new();
        let splash = std::sync::Arc::new(render_splash(&self.chrome, &self.theme, width));
        let tail = std::sync::Arc::new(self.render_transcript_tail(width));
        let last = self.chat.len() + 1;
        let mut section_rows = |view: &mut Self, section: usize| -> std::sync::Arc<Vec<Line>> {
            if section == 0 {
                return splash.clone();
            }
            if section == last {
                return tail.clone();
            }
            touched.push(section - 1);
            view.sparse_entry_rows(section - 1, width)
        };
        let (mut section, mut row, mut movement) = if let Some((section, row)) = window.cursor {
            (section, row, window.pending)
        } else {
            match window.anchor {
                Anchor::Tail(distance) => (
                    last,
                    tail.len(),
                    -(height.saturating_add(distance) as isize),
                ),
                Anchor::Top(offset) => (0, 0, offset as isize),
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
        if movement < 0 {
            match &mut window.anchor {
                Anchor::Tail(distance) => {
                    *distance = distance.saturating_sub(movement.unsigned_abs())
                }
                Anchor::Top(offset) => *offset = offset.saturating_sub(movement.unsigned_abs()),
            }
        }
        window.pending = 0;
        window.cursor = Some((section, row));
        let mut rows = Vec::with_capacity(height);
        while rows.len() < height && section <= last {
            let source = section_rows(self, section);
            let from = row.min(source.len());
            let to = from.saturating_add(height - rows.len()).min(source.len());
            rows.extend_from_slice(&source[from..to]);
            section += 1;
            row = 0;
        }
        // A top-origin window reaching the tail needs the same bottom clamp
        // as the full renderer. Re-anchor from the end once, not per draw.
        if rows.len() < height && matches!(window.anchor, Anchor::Top(_)) && !self.chat.is_empty() {
            if self.has_selection() {
                self.sparse_window = Some(window);
                self.resolve_sparse_geometry();
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
        let start = match window.anchor {
            Anchor::Tail(distance) => TAIL_SELECTION_ORIGIN
                .saturating_sub(distance)
                .saturating_sub(rows.len()),
            Anchor::Top(offset) => offset,
        };
        (rows, start)
    }

    fn sparse_entry_rows(&mut self, index: usize, width: usize) -> std::sync::Arc<Vec<Line>> {
        #[cfg(test)]
        super::layout::ENTRY_VISITS.with(|count| count.set(count.get() + 1));
        self.sparse_entries.insert(index);
        let detail = match self.detail {
            Detail::Overview => 0,
            Detail::Details => 1,
            Detail::All => 2,
        };
        let entry = &self.chat[index];
        if self.entry_cacheable(entry) {
            if let Some(layout) = &self.entry_layout[index][detail] {
                return layout.rows.clone();
            }
        }
        let preceded_by_tool = index > 0 && matches!(self.chat[index - 1], ChatEntry::Tool(_));
        let rows = std::sync::Arc::new(self.render_entry(
            index,
            entry,
            width,
            index == 0,
            preceded_by_tool,
        ));
        if self.entry_cacheable(entry) {
            let spacing = self.entry_spacing(index, entry, index == 0, preceded_by_tool);
            self.entry_layout[index][detail] = Some(EntryLayout {
                spacing,
                rows: rows.clone(),
            });
        }
        rows
    }
}

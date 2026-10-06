//! In-app mouse text selection, anchored to transcript lines: press starts it, drag extends it,
//! release copies the spanned text through OSC 52; presses outside the window start a frame
//! selection over the dock's selectable spans. Markdown table cell selection is not ported; table
//! rows select as plain text.

use crate::view::AgentView;
use crate::width::{char_width, line_width, slice_line_by_column};
use crate::{Line, Span};
use ratatui::style::{Modifier, Style};

pub(crate) const HEADER_ROWS: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SelectionPoint {
    line: usize,
    col: usize,
}

/// What a selection spans; the TS table-cell mode is not ported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionMode {
    Transcript,
    Frame,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FrameRegion {
    line: usize,
    col: usize,
    width: usize,
}

/// The frame a frame selection started on: extraction reads the text the
/// press saw even if later frames changed.
#[derive(Debug, Clone)]
struct FrameSnapshot {
    rows: Vec<String>,
    regions: Vec<FrameRegion>,
}

/// Ordered selection endpoints: the anchor and head normalized, `None` when they coincide.
fn ordered_selection(
    anchor: Option<SelectionPoint>,
    head: Option<SelectionPoint>,
) -> Option<(SelectionPoint, SelectionPoint)> {
    let (a, b) = (anchor?, head?);
    if a.line == b.line && a.col == b.col {
        return None;
    }
    let flipped = a.line > b.line || (a.line == b.line && a.col > b.col);
    Some(if flipped { (b, a) } else { (a, b) })
}

fn selection_span(
    line: usize,
    start: SelectionPoint,
    end: SelectionPoint,
) -> Option<(usize, usize)> {
    if line < start.line || line > end.line {
        return None;
    }
    let from = if line == start.line { start.col } else { 0 };
    let to = if line == end.line {
        end.col
    } else {
        usize::MAX
    };
    Some((from, to))
}

/// Highlight `[from, to)` columns of a row with reverse video: the selected
/// run drops its styling, so the highlight reads as default-color inverted text.
pub(crate) fn highlight_line(line: &Line, from: usize, to: usize) -> Line {
    let width = line_width(line);
    let from = from.min(width);
    let to = to.min(width);
    if to <= from {
        return line.clone();
    }
    let mut out = slice_line_by_column(line, 0, from);
    let mut selected = slice_line_by_column(line, from, to - from);
    for span in &mut selected {
        span.style = Style::default().add_modifier(Modifier::REVERSED);
    }
    out.extend(selected);
    out.extend(slice_line_by_column(line, to, width - to));
    out
}

/// Plain text of a rendered row: styling, OSC zone markers, and hyperlinks stripped, spans joined.
fn row_text(line: &[Span]) -> String {
    let mut stripped = line.to_vec();
    crate::osc133::strip(&mut stripped);
    crate::hyperlinks::strip_osc8(&mut stripped);
    stripped.iter().map(|s| s.content.as_str()).collect()
}

/// Slice plain text by visible column (the text counterpart of
/// [`crate::width::slice_line_by_column`]).
fn slice_text_by_column(text: &str, start: usize, length: usize) -> String {
    let mut out = String::new();
    let end = start.saturating_add(length);
    let mut col = 0usize;
    for c in text.chars() {
        let width = char_width(c);
        if col >= start && col + width <= end {
            out.push(c);
        }
        col += width;
        if col >= end {
            break;
        }
    }
    out
}

/// The visible non-whitespace span of a row: the selectable run a dock row offers a frame
/// selection.
fn visible_content_span(text: &str, max_width: usize) -> Option<(usize, usize)> {
    if max_width == 0 {
        return None;
    }
    let mut from = None;
    let mut to = 0usize;
    let mut col = 0usize;
    for c in text.chars() {
        let width = char_width(c);
        let start = col;
        col += width;
        if width > 0 && !c.is_whitespace() && start < max_width {
            from.get_or_insert(start);
            to = col.min(max_width);
        }
        if col >= max_width {
            break;
        }
    }
    from.map(|from| (from, to))
}

/// Regions a frame selection may cover: every dock row's visible content
/// span; the dock-mounted panes (`/model`, `/effort`, `/tree`, `/fork`) select here too.
fn dock_regions(rows: &[String], first_dock_row: usize, width: usize) -> Vec<FrameRegion> {
    rows.iter()
        .enumerate()
        .skip(first_dock_row)
        .filter_map(|(line, text)| {
            let (col, end) = visible_content_span(text, width)?;
            Some(FrameRegion {
                line,
                col,
                width: end - col,
            })
        })
        .collect()
}

#[derive(Debug, Default)]
pub(crate) struct SelectionState {
    anchor: Option<SelectionPoint>,
    head: Option<SelectionPoint>,
    mode: Option<SelectionMode>,
    frame: Option<FrameSnapshot>,
    frame_text: Vec<String>,
    frame_regions: Vec<FrameRegion>,
}

impl SelectionState {
    fn clear(&mut self) {
        self.anchor = None;
        self.head = None;
        self.mode = None;
        self.frame = None;
    }

    /// Whether a drag is in progress (an anchor armed, not yet ended):
    /// transient overlays sit a drag out so a selection never reads their rows.
    pub(crate) fn is_dragging(&self) -> bool {
        self.anchor.is_some() && self.mode.is_some()
    }

    fn has_selection(&self) -> bool {
        ordered_selection(self.anchor, self.head).is_some()
    }

    fn frame_regions_for_line(regions: &[FrameRegion], line: usize) -> Vec<&FrameRegion> {
        let mut hits: Vec<&FrameRegion> = regions
            .iter()
            .filter(|region| region.line == line && region.width > 0)
            .collect();
        hits.sort_by_key(|region| region.col);
        hits
    }

    /// Inside keeps the column, outside snaps to the nearest edge.
    fn clamp_frame_point(point: SelectionPoint, regions: &[FrameRegion]) -> Option<SelectionPoint> {
        let hits = Self::frame_regions_for_line(regions, point.line);
        let first = *hits.first()?;
        let mut closest = first.col;
        let mut distance = usize::MAX;
        for region in hits {
            let start = region.col;
            let end = region.col + region.width;
            if (start..=end).contains(&point.col) {
                return Some(SelectionPoint {
                    line: point.line,
                    col: point.col.clamp(start, end),
                });
            }
            for edge in [start, end] {
                let next = point.col.abs_diff(edge);
                if next < distance {
                    closest = edge;
                    distance = next;
                }
            }
        }
        Some(SelectionPoint {
            line: point.line,
            col: closest,
        })
    }

    fn is_frame_selectable(point: SelectionPoint, regions: &[FrameRegion]) -> bool {
        regions.iter().any(|region| {
            region.line == point.line
                && point.col >= region.col
                && point.col < region.col + region.width
        })
    }

    /// The spans a frame selection covers on one line: the selection span clipped to each region.
    fn selected_frame_spans(
        line: usize,
        start: SelectionPoint,
        end: SelectionPoint,
        regions: &[FrameRegion],
    ) -> Vec<(usize, usize)> {
        let Some((span_from, span_to)) = selection_span(line, start, end) else {
            return Vec::new();
        };
        Self::frame_regions_for_line(regions, line)
            .iter()
            .filter_map(|region| {
                let from = span_from.max(region.col);
                let to = span_to.min(region.col + region.width);
                (to > from).then_some((from, to))
            })
            .collect()
    }

    fn transcript_highlight_span(&self, line: usize) -> Option<(usize, usize)> {
        if self.mode != Some(SelectionMode::Transcript) {
            return None;
        }
        let (start, end) = ordered_selection(self.anchor, self.head)?;
        selection_span(line, start, end)
    }

    fn frame_highlight_spans(&self, line: usize) -> Vec<(usize, usize)> {
        if self.mode != Some(SelectionMode::Frame) {
            return Vec::new();
        }
        let Some((start, end)) = ordered_selection(self.anchor, self.head) else {
            return Vec::new();
        };
        let regions = match &self.frame {
            Some(snapshot) => &snapshot.regions,
            None => &self.frame_regions,
        };
        Self::selected_frame_spans(line, start, end, regions)
    }

    /// Record a freshly composed frame: the plain row texts the dock regions and frame selections
    /// read.
    fn note_frame(&mut self, rows: Vec<String>, first_dock_row: usize, width: usize) {
        self.frame_regions = dock_regions(&rows, first_dock_row, width);
        self.frame_text = rows;
    }

    /// The text of a finished transcript selection: per-line column slices,
    /// trailing whitespace trimmed; `None` when only whitespace.
    fn extract_transcript_text(
        rows: &[Line],
        start: SelectionPoint,
        end: SelectionPoint,
    ) -> Option<String> {
        let lines = (start.line..=end.line)
            .filter_map(|line| {
                let (from, to) = selection_span(line, start, end)?;
                let row = row_text(rows.get(line - start.line)?);
                let width = row.chars().map(char_width).sum();
                let from = from.min(width);
                let to = to.min(width);
                Some(
                    slice_text_by_column(&row, from, to - from)
                        .trim_end()
                        .to_string(),
                )
            })
            .collect::<Vec<_>>();
        let text = lines.join("\n");
        (text.trim().length_is_not_zero()).then_some(text)
    }

    /// The text of a finished frame selection: the snapshot's rows sliced to the covered regions.
    fn extract_frame_text(&self, start: SelectionPoint, end: SelectionPoint) -> Option<String> {
        let snapshot = self.frame.as_ref()?;
        let lines = (start.line..=end.line)
            .filter_map(|line| {
                let spans = Self::selected_frame_spans(line, start, end, &snapshot.regions);
                if spans.is_empty() {
                    return None;
                }
                let row = snapshot.rows.get(line).map_or("", String::as_str);
                let parts: Vec<String> = spans
                    .iter()
                    .map(|(from, to)| slice_text_by_column(row, *from, to - from))
                    .collect();
                Some(parts.join("").trim_end().to_string())
            })
            .collect::<Vec<_>>();
        let text = lines.join("\n");
        (text.trim().length_is_not_zero()).then_some(text)
    }
}

/// `str::trim` is checked without allocating the trimmed copy.
trait TrimLength {
    fn length_is_not_zero(&self) -> bool;
}

impl TrimLength for str {
    fn length_is_not_zero(&self) -> bool {
        !self.trim().is_empty()
    }
}

impl AgentView {
    /// Shift tail-relative transcript endpoints by `delta` (content growing below keeps its
    /// selection only when they move with it); top-anchored endpoints never shift.
    pub(crate) fn shift_tail_selection_points(&mut self, delta: isize) {
        if self.selection.mode != Some(SelectionMode::Transcript) {
            return;
        }
        for point in [&mut self.selection.anchor, &mut self.selection.head]
            .into_iter()
            .flatten()
        {
            // The tail-relative points sit in the TAIL_SELECTION_ORIGIN band, within an `isize` of
            // the integer's ceiling, so the shift works in usize: neither conversion can overflow.
            point.line = if delta >= 0 {
                point.line.saturating_sub(delta as usize)
            } else {
                point.line.saturating_add(delta.unsigned_abs())
            };
        }
    }

    /// Rebase transcript endpoints from Top-anchor (absolute) coordinates onto
    /// the tail frame, the inverse of [`Self::resolve_tail_selection`]: the window
    /// re-anchors to the tail here and the selection keeps its content highlighted.
    pub(crate) fn rebase_top_selection_to_tail(&mut self, total: usize) {
        if self.selection.mode != Some(SelectionMode::Transcript) {
            return;
        }
        for point in [&mut self.selection.anchor, &mut self.selection.head]
            .into_iter()
            .flatten()
        {
            point.line = crate::view::lazy::TAIL_SELECTION_ORIGIN
                .saturating_sub(total.saturating_sub(point.line));
        }
    }

    /// Map private end-relative selection coordinates to exact transcript rows.
    pub(crate) fn resolve_tail_selection(&mut self, total: usize) {
        if self.selection.mode != Some(SelectionMode::Transcript) {
            return;
        }
        for point in [&mut self.selection.anchor, &mut self.selection.head]
            .into_iter()
            .flatten()
        {
            point.line = total.saturating_sub(
                crate::view::lazy::TAIL_SELECTION_ORIGIN.saturating_sub(point.line),
            );
        }
    }

    /// The transcript line under a screen row: `None` outside the window
    /// unless clamping, which folds the position onto the nearest window row.
    fn transcript_line_for_screen_row(
        &self,
        screen_row: usize,
        clamp_to_window: bool,
    ) -> Option<usize> {
        if self.window_rows == 0 {
            return None;
        }
        let first = HEADER_ROWS;
        let last = HEADER_ROWS + self.window_rows - 1;
        if !clamp_to_window && !(first..=last).contains(&screen_row) {
            return None;
        }
        let row = screen_row.clamp(first, last);
        Some(self.selection_window_start() + row - HEADER_ROWS)
    }

    /// Begin a transcript selection at a screen position: `false` —
    /// selection cleared — when the position is outside the transcript window.
    pub fn begin_selection(&mut self, screen_row: usize, screen_col: usize) -> bool {
        let Some(line) = self.transcript_line_for_screen_row(screen_row, false) else {
            self.selection.clear();
            return false;
        };
        let point = SelectionPoint {
            line,
            col: screen_col,
        };
        self.selection.anchor = Some(point);
        self.selection.head = Some(point);
        self.selection.mode = Some(SelectionMode::Transcript);
        self.selection.frame = None;
        true
    }

    /// Extend the active selection to a screen position, clamping into the window like the drag
    /// path.
    fn extend_selection(&mut self, screen_row: usize, screen_col: usize) {
        if self.selection.anchor.is_none() || self.selection.mode != Some(SelectionMode::Transcript)
        {
            return;
        }
        let Some(line) = self.transcript_line_for_screen_row(screen_row, true) else {
            return;
        };
        self.selection.head = Some(SelectionPoint {
            line,
            col: screen_col,
        });
    }

    pub fn extend_active_selection(&mut self, screen_row: usize, screen_col: usize) {
        match self.selection.mode {
            Some(SelectionMode::Frame) => self.extend_frame_selection(screen_row, screen_col),
            Some(SelectionMode::Transcript) => self.extend_selection(screen_row, screen_col),
            None => {}
        }
    }

    /// Begin a frame selection at a screen position: `false` — selection
    /// cleared — when the position is not inside a selectable region.
    pub fn begin_frame_selection(&mut self, screen_row: usize, screen_col: usize) -> bool {
        let height = self.frame_rows;
        if height == 0 {
            self.selection.clear();
            return false;
        }
        let row = screen_row.min(height - 1);
        let point = SelectionPoint {
            line: row,
            col: screen_col,
        };
        if !SelectionState::is_frame_selectable(point, &self.selection.frame_regions) {
            self.selection.clear();
            return false;
        }
        self.selection.frame = Some(FrameSnapshot {
            rows: self.selection.frame_text.clone(),
            regions: self.selection.frame_regions.clone(),
        });
        self.selection.anchor = Some(point);
        self.selection.head = Some(point);
        self.selection.mode = Some(SelectionMode::Frame);
        true
    }

    /// Extend a frame selection, clamping into the snapshot's regions.
    fn extend_frame_selection(&mut self, screen_row: usize, screen_col: usize) {
        if self.selection.anchor.is_none() || self.selection.mode != Some(SelectionMode::Frame) {
            return;
        }
        let Some(snapshot) = self.selection.frame.clone() else {
            return;
        };
        if snapshot.rows.is_empty() {
            return;
        }
        let row = screen_row.min(snapshot.rows.len() - 1);
        let clamped = SelectionState::clamp_frame_point(
            SelectionPoint {
                line: row,
                col: screen_col,
            },
            &snapshot.regions,
        );
        if let Some(clamped) = clamped {
            self.selection.head = Some(clamped);
        }
    }

    /// Finish the active selection and return its plain text: `None` when
    /// nothing but whitespace is spanned. The selection is cleared either way.
    pub fn end_active_selection(&mut self) -> Option<String> {
        let text = match self.selection.mode {
            Some(SelectionMode::Transcript) => {
                let sel = ordered_selection(self.selection.anchor, self.selection.head);
                sel.and_then(|(start, end)| {
                    let sparse = crate::image_component::with_fullscreen_image_fallback(|| {
                        self.sparse_selection_rows(start.line, end.line - start.line + 1)
                    });
                    if let Some(rows) = sparse {
                        return SelectionState::extract_transcript_text(&rows, start, end);
                    }
                    self.resolve_sparse_geometry();
                    let (start, end) =
                        ordered_selection(self.selection.anchor, self.selection.head)?;
                    let rows = crate::image_component::with_fullscreen_image_fallback(|| {
                        let layout = self.layout_pass(self.layout_width);
                        self.transcript_window(&layout, start.line, end.line - start.line + 1)
                    });
                    SelectionState::extract_transcript_text(&rows, start, end)
                })
            }
            Some(SelectionMode::Frame) => {
                let sel = ordered_selection(self.selection.anchor, self.selection.head);
                sel.and_then(|(start, end)| self.selection.extract_frame_text(start, end))
            }
            None => None,
        };
        self.selection.clear();
        text
    }

    pub fn clear_selection(&mut self) {
        self.selection.clear();
    }

    pub fn has_selection(&self) -> bool {
        self.selection.has_selection()
    }

    /// The auto-scroll direction a drag at `screen_row` arms: dragging past
    /// the window edge the head moved towards scrolls that way.
    pub fn selection_auto_scroll_direction(&self, screen_row: usize) -> Option<isize> {
        if self.selection.mode != Some(SelectionMode::Transcript) {
            return None;
        }
        let (anchor, head) = (self.selection.anchor?, self.selection.head?);
        let first = HEADER_ROWS;
        let last = HEADER_ROWS + self.window_rows.saturating_sub(1);
        if head.line < anchor.line && screen_row <= first && self.selection_window_start() > 0 {
            return Some(-1);
        }
        if head.line > anchor.line
            && screen_row >= last
            && (!self.is_following() || self.scroll_top < self.last_max_scroll)
        {
            return Some(1);
        }
        None
    }

    /// Scroll one step for an auto-scrolling selection, extending the head
    /// onto the edge row; `false` when the window did not move.
    pub fn scroll_selection(&mut self, direction: isize, screen_col: usize) -> bool {
        if self.selection.mode != Some(SelectionMode::Transcript) {
            return false;
        }
        let previous = self.selection_window_start();
        self.scroll_by(direction);
        if self.selection_window_start() == previous {
            return false;
        }
        let edge = if direction < 0 {
            HEADER_ROWS
        } else {
            HEADER_ROWS + self.window_rows.saturating_sub(1)
        };
        self.extend_selection(edge, screen_col);
        true
    }

    /// The highlighted column span of one transcript line, if any (the selection-diff restyle pairs
    /// this with the cached rows).
    pub(crate) fn transcript_highlight_span(
        &self,
        transcript_line: usize,
    ) -> Option<(usize, usize)> {
        self.selection.transcript_highlight_span(transcript_line)
    }

    /// The URL of the link covering one screen cell of the last composed frame,
    /// or `None` when the position is not over a link.
    pub(crate) fn hyperlink_at(&self, row: usize, col: usize) -> Option<String> {
        crate::hyperlinks::url_at(&self.frame_links, row, col)
    }

    /// Apply frame-selection highlights to a freshly composed frame and record its plain rows.
    /// `first_dock_row` bounds where the selectable regions start: the transcript window's bottom
    /// on the session surface, row 0 when a pane (the onboarding splash) owns the frame.
    pub(crate) fn apply_frame_selection(
        &mut self,
        frame: &mut [Line],
        first_dock_row: usize,
        width: usize,
    ) {
        let rows: Vec<String> = frame.iter().map(|line| row_text(line)).collect();
        self.selection.note_frame(rows, first_dock_row, width);
        if self.selection.mode != Some(SelectionMode::Frame) {
            return;
        }
        let Some((start, end)) = ordered_selection(self.selection.anchor, self.selection.head)
        else {
            return;
        };
        for line in start.line..=end.line {
            let spans = self.selection.frame_highlight_spans(line);
            if let Some(row) = frame.get_mut(line) {
                for (from, to) in spans.iter().rev() {
                    *row = highlight_line(row, *from, *to);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::chat::ChatEntry;
    use crate::theme::{ColorMode, Theme};
    use crate::Span;

    fn view() -> AgentView {
        AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
    }

    fn rendered_row(frame: &[Line], row: usize) -> String {
        row_text(frame.get(row).map_or(&[], Vec::as_slice))
    }

    /// A transcript window row: the top bar sits at row 0, so the first
    /// transcript line lands at row 1.
    #[test]
    fn drag_across_one_transcript_row_copies_it() {
        let mut v = view();
        v.push_entry(ChatEntry::User {
            text: "select this line".to_string(),
        });
        let frame = v.render_frame(80, 12);
        let row = (1..frame.len())
            .find(|row| rendered_row(&frame, *row).contains("select this line"))
            .expect("the user row rendered");
        let col = rendered_row(&frame, row)
            .find("select this line")
            .expect("text present");
        assert!(v.begin_selection(row, col));
        v.extend_active_selection(row, col + 7);
        assert!(v.has_selection());
        let frame = v.render_frame(80, 12);
        let highlighted = frame[row]
            .iter()
            .any(|span| span.style.add_modifier.contains(Modifier::REVERSED));
        assert!(highlighted, "the dragged columns render reversed");
        let text = v.end_active_selection().expect("copied text");
        assert_eq!(text, "select");
        assert!(!v.has_selection(), "release cleared the selection");
    }

    /// A multi-row drag anchors to transcript lines: the span follows the
    /// lines through the window, and the copy carries each row's slice.
    #[test]
    fn drag_down_multiple_rows_copies_each_line() {
        let mut v = view();
        v.push_entry(ChatEntry::Status {
            text: "first row".to_string(),
            kind: crate::chat::StatusKind::Info,
        });
        v.push_entry(ChatEntry::Status {
            text: "second row".to_string(),
            kind: crate::chat::StatusKind::Info,
        });
        let frame = v.render_frame(80, 12);
        let first = (1..frame.len())
            .find(|row| rendered_row(&frame, *row).contains("first row"))
            .expect("first row rendered");
        let second = (first..frame.len())
            .find(|row| rendered_row(&frame, *row).contains("second row"))
            .expect("second row rendered");
        assert!(v.begin_selection(first, 3));
        v.extend_active_selection(second, 9);
        // The press's draw records the transcript text the release copies.
        v.render_frame(80, 12);
        let text = v.end_active_selection().expect("copied text");
        // Every line in the range copies its column slice, trailing whitespace trimmed: first row
        // from the anchor column, spacer rows as empty lines, last row up to the head column.
        let mut expected = Vec::new();
        for row in first..=second {
            let text_row = rendered_row(&frame, row);
            let (from, to) = if row == first {
                (3, usize::MAX)
            } else if row == second {
                (0, 9)
            } else {
                (0, usize::MAX)
            };
            expected.push(
                slice_text_by_column(&text_row, from, to)
                    .trim_end()
                    .to_string(),
            );
        }
        assert_eq!(text, expected.join("\n"));
    }

    #[test]
    fn unseen_dynamic_mutation_preserves_tail_selection() {
        let mut v = view();
        v.push_entry(ChatEntry::Assistant(Box::new(
            crate::chat::AssistantMessage {
                blocks: vec![crate::chat::MessageBlock::Text("old hidden stream".into())],
                has_tool_calls: false,
                streaming: true,
                error: None,
                aborted: false,
            },
        )));
        for index in 0..100 {
            v.push_entry(ChatEntry::Status {
                text: format!("original {index}"),
                kind: crate::chat::StatusKind::Info,
            });
        }
        let frame = v.render_frame(80, 12);
        let row = (1..=v.window_rows)
            .find(|row| rendered_row(&frame, *row).contains("original"))
            .unwrap();
        assert!(v.begin_selection(row, 0));
        v.extend_active_selection(row, 80);
        // The copy keeps the text the drag saw, even though the mutation grew
        // an unseen entry above the window.
        let expected = rendered_row(&frame, row).trim_end().to_string();
        v.prepare_entry_mutation(0);
        if let ChatEntry::Assistant(message) = &mut v.chat[0] {
            message
                .blocks
                .push(crate::chat::MessageBlock::Text("new\nnew\nnew".into()));
        }
        v.mark_entry_stale(0);
        v.render_frame(80, 12);
        assert_eq!(v.end_active_selection(), Some(expected));
    }

    #[test]
    fn top_window_reaching_tail_keeps_the_selection_highlighted() {
        let mut v = view();
        // A transcript shorter than the window: a Top-anchored walk runs off the end and re-anchors
        // to the tail with the selection active — the release still copies the dragged text.
        v.push_entry(ChatEntry::Status {
            text: "short transcript row".into(),
            kind: crate::chat::StatusKind::Info,
        });
        let frame = v.render_frame(80, 30);
        let row = (1..=v.window_rows)
            .find(|row| rendered_row(&frame, *row).contains("short transcript"))
            .unwrap();
        v.scroll_to_top();
        assert!(v.begin_selection(row, 2));
        v.extend_active_selection(row, 10);
        // The re-anchor frame: the highlight must still cover the row.
        let frame = v.render_frame(80, 30);
        let highlighted = rendered_row(&frame, row);
        assert!(
            highlighted.contains("short transcript"),
            "the selected row stays rendered after the re-anchor: {highlighted:?}"
        );
        let expected = slice_text_by_column(highlighted.trim_end(), 2, 8);
        assert_eq!(v.end_active_selection(), Some(expected));
    }

    #[test]
    fn growing_stream_during_selection_keeps_original_row() {
        let mut v = view();
        for index in 0..30 {
            v.push_entry(ChatEntry::Status {
                text: format!("original {index}"),
                kind: crate::chat::StatusKind::Info,
            });
        }
        v.push_entry(ChatEntry::Assistant(Box::new(
            crate::chat::AssistantMessage {
                blocks: vec![crate::chat::MessageBlock::Text("stream".into())],
                has_tool_calls: false,
                streaming: true,
                error: None,
                aborted: false,
            },
        )));
        let frame = v.render_frame(80, 20);
        let row = (1..=v.window_rows)
            .find(|row| rendered_row(&frame, *row).contains("original"))
            .unwrap();
        assert!(v.begin_selection(row, 0));
        v.extend_active_selection(row, 80);
        let expected = rendered_row(&frame, row).trim_end().to_string();
        let index = v.chat.len() - 1;
        v.prepare_entry_mutation(index);
        if let ChatEntry::Assistant(message) = &mut v.chat[index] {
            message
                .blocks
                .push(crate::chat::MessageBlock::Text("new\nnew\nnew".into()));
        }
        v.mark_entry_stale(index);
        v.render_frame(80, 20);
        assert_eq!(v.end_active_selection(), Some(expected));
    }

    #[test]
    fn append_during_tail_selection_preserves_original_text() {
        let mut v = view();
        for index in 0..30 {
            v.push_entry(ChatEntry::Status {
                text: format!("original {index}"),
                kind: crate::chat::StatusKind::Info,
            });
        }
        let frame = v.render_frame(80, 12);
        let row = (1..=v.window_rows)
            .find(|row| rendered_row(&frame, *row).contains("original"))
            .unwrap();
        assert!(v.begin_selection(row, 0));
        v.extend_active_selection(row, 80);
        let expected = rendered_row(&frame, row).trim_end().to_string();
        v.push_entry(ChatEntry::Status {
            text: "new content".into(),
            kind: crate::chat::StatusKind::Info,
        });
        v.render_frame(80, 12);
        v.render_frame(80, 12);
        assert_eq!(v.end_active_selection(), Some(expected));
    }

    #[test]
    fn copy_after_scroll_before_redraw_matches_last_logical_endpoints() {
        let mut v = view();
        let mut oracle = view();
        for index in 0..100 {
            let entry = ChatEntry::Status {
                text: format!("row {index}"),
                kind: crate::chat::StatusKind::Info,
            };
            v.push_entry(entry.clone());
            oracle.push_entry(entry);
        }
        let reference =
            crate::image_component::with_fullscreen_image_fallback(|| oracle.render_transcript(80));
        v.render_frame(80, 12);
        assert!(v.begin_selection(2, 0));
        v.extend_active_selection(4, 80);
        v.scroll_by(-3);
        v.extend_active_selection(2, 0);
        let (mut start, mut end) = ordered_selection(v.selection.anchor, v.selection.head).unwrap();
        start.line = reference.len() - (crate::view::lazy::TAIL_SELECTION_ORIGIN - start.line);
        end.line = reference.len() - (crate::view::lazy::TAIL_SELECTION_ORIGIN - end.line);
        let expected =
            SelectionState::extract_transcript_text(&reference[start.line..=end.line], start, end);
        assert_eq!(v.end_active_selection(), expected);
    }

    #[test]
    fn sparse_copy_across_multiple_tail_frames_matches_full_rows() {
        for reverse in [false, true] {
            let mut v = view();
            let mut oracle = view();
            for index in 0..200 {
                let entry = ChatEntry::Status {
                    text: format!("row {index}: 界 wide text"),
                    kind: crate::chat::StatusKind::Info,
                };
                v.push_entry(entry.clone());
                oracle.push_entry(entry);
            }
            let reference = crate::image_component::with_fullscreen_image_fallback(|| {
                oracle.render_transcript(80)
            });
            v.render_frame(80, 12);
            if reverse {
                v.scroll_by(-50);
                v.render_frame(80, 12);
            }
            assert!(v.begin_selection(2, 2));
            v.scroll_by(if reverse { 35 } else { -35 });
            v.render_frame(80, 12);
            v.render_frame(80, 12);
            v.extend_active_selection(4, 10);
            let (mut start, mut end) =
                ordered_selection(v.selection.anchor, v.selection.head).unwrap();
            start.line = reference.len() - (crate::view::lazy::TAIL_SELECTION_ORIGIN - start.line);
            end.line = reference.len() - (crate::view::lazy::TAIL_SELECTION_ORIGIN - end.line);
            let expected = SelectionState::extract_transcript_text(
                &reference[start.line..=end.line],
                start,
                end,
            );
            assert_eq!(v.end_active_selection(), expected);
        }
    }

    #[test]
    fn copy_across_unseen_window_gap_matches_full_reference() {
        let mut v = view();
        for index in 0..200 {
            v.push_entry(ChatEntry::Status {
                text: format!("row {index}: 界 wide text"),
                kind: crate::chat::StatusKind::Info,
            });
        }
        v.render_frame(80, 12);
        v.scroll_to_top();
        v.render_frame(80, 12);
        assert!(v.begin_selection(2, 2));
        let start = v.selection.anchor.unwrap();
        v.scroll_by(180);
        v.render_frame(80, 12);
        v.extend_active_selection(3, 10);
        let end = v.selection.head.unwrap();
        let reference =
            crate::image_component::with_fullscreen_image_fallback(|| v.render_transcript(80));
        let expected =
            SelectionState::extract_transcript_text(&reference[start.line..=end.line], start, end);
        assert_eq!(v.end_active_selection(), expected);
    }

    /// A press outside the transcript window (the dock) starts no transcript selection.
    #[test]
    fn press_outside_the_window_fails_to_begin() {
        let mut v = view();
        let frame = v.render_frame(80, 12);
        let dock_row = frame.len() - 1;
        assert!(!v.begin_selection(dock_row, 2));
        assert!(!v.has_selection());
    }

    #[test]
    fn dock_press_starts_a_frame_selection() {
        let mut v = view();
        let frame = v.render_frame(80, 12);
        // The editor's prompt row sits in the dock; find its content.
        let (row, col) = (1..frame.len())
            .filter_map(|row| {
                let text = rendered_row(&frame, row);
                let content = text.trim();
                (content.len() > 3).then(|| {
                    let col = text.find(|c: char| !c.is_whitespace()).unwrap_or(0);
                    (row, col)
                })
            })
            .next_back()
            .expect("a dock content row");
        assert!(v.begin_frame_selection(row, col));

        assert!(!v.has_selection());
        v.extend_active_selection(row, col + 4);
        assert!(v.has_selection());
        let text = v.end_active_selection().expect("copied frame text");
        assert!(!text.trim().is_empty(), "the region text copied: {text}");
    }

    /// A frame selection outside every region never begins.
    #[test]
    fn dock_press_on_blank_columns_never_begins() {
        let mut v = view();
        let frame = v.render_frame(80, 40);
        // The blank padding between the window and the dock has no regions.
        let blank = (1..frame.len())
            .find(|row| rendered_row(&frame, *row).trim().is_empty())
            .expect("a blank row");
        assert!(!v.begin_frame_selection(blank, 2));
        assert!(!v.has_selection());
    }

    /// The auto-scroll direction: a head above the anchor held at the top
    /// edge arms upward, below the anchor at the bottom edge arms downward.
    #[test]
    fn auto_scroll_direction_follows_the_dragged_head() {
        let mut v = view();
        for i in 0..20 {
            v.push_entry(ChatEntry::Status {
                text: format!("row {i}"),
                kind: crate::chat::StatusKind::Info,
            });
        }
        v.render_frame(80, 12);
        // Pause the tail so both edges have scroll room.
        v.scroll_by(-4);
        v.render_frame(80, 12);
        let (first, last) = (HEADER_ROWS, HEADER_ROWS + v.window_rows - 1);
        assert_eq!(v.selection_auto_scroll_direction(first), None);
        assert!(v.begin_selection(last - 1, 1));
        v.extend_active_selection(first, 1);
        assert_eq!(v.selection_auto_scroll_direction(first), Some(-1));
        assert_eq!(v.selection_auto_scroll_direction(last), None);
        assert!(v.begin_selection(first + 1, 1));
        v.extend_active_selection(last, 1);
        assert_eq!(v.selection_auto_scroll_direction(last), Some(1));
        v.clear_selection();
        assert_eq!(v.selection_auto_scroll_direction(last), None);
    }

    /// `scroll_selection` scrolls the window and re-aims the head onto the
    /// edge row; a clamped scroll reports no move.
    #[test]
    fn scroll_selection_scrolls_and_reaims_the_head() {
        let mut v = view();
        for i in 0..20 {
            v.push_entry(ChatEntry::Status {
                text: format!("row {i}"),
                kind: crate::chat::StatusKind::Info,
            });
        }
        v.render_frame(80, 12);
        // Pause the tail so scrolling down has room.
        v.scroll_by(-4);
        v.render_frame(80, 12);
        let last = HEADER_ROWS + v.window_rows - 1;
        assert!(v.begin_selection(HEADER_ROWS + 1, 0));
        v.extend_active_selection(last, 0);
        // The press's draw records the transcript text the release copies.
        v.render_frame(80, 12);
        let before = v.selection_window_start();
        assert!(v.scroll_selection(1, 0));
        assert_eq!(
            v.selection_window_start(),
            before + 1,
            "the window scrolled one line down"
        );
        let text = v.end_active_selection().expect("selection text");
        let lines = text.lines().count();
        assert!(lines >= 2, "the head moved onto the new edge row");
        // At the scroll clamp the next step reports no move.
        assert!(v.begin_selection(HEADER_ROWS + 1, 0));
        v.scroll_to_top();
        assert!(!v.scroll_selection(-1, 0), "scroll_top is already zero");
    }

    #[test]
    fn visible_content_span_skips_blank_columns() {
        assert_eq!(visible_content_span("     hi  ", 80), Some((5, 7)));
        assert_eq!(visible_content_span("        ", 80), None);
        assert_eq!(visible_content_span("", 80), None);
        assert_eq!(visible_content_span("abc", 0), None);
        let long = "x".repeat(10);
        assert_eq!(visible_content_span(&long, 4), Some((0, 4)));
    }

    /// Column slicing over plain text keeps the dragged columns only.
    #[test]
    fn slice_text_by_column_cuts_visible_columns() {
        assert_eq!(slice_text_by_column("abcdef", 2, 3), "cde");
        assert_eq!(slice_text_by_column("abcdef", 4, 10), "ef");
        assert_eq!(slice_text_by_column("abcdef", 0, 0), "");
    }

    #[test]
    fn highlight_line_reverses_only_the_span() {
        let line: Line = vec![Span::raw("hello "), Span::raw("world")];
        let out = highlight_line(&line, 3, 9);
        let text = out.iter().map(|s| s.content.as_str()).collect::<String>();
        assert_eq!(text, "hello world");
        let reversed: String = out
            .iter()
            .filter(|s| s.style.add_modifier.contains(Modifier::REVERSED))
            .map(|s| s.content.as_str())
            .collect();
        assert_eq!(reversed, "lo wor");
    }

    /// The onboarding pane owns the whole frame: a press-drag over the mounted login URL copies it,
    /// and a click on the same URL opens it.
    #[test]
    fn onboarding_pane_rows_select_and_its_url_link_resolves() {
        crate::hyperlinks::set_hyperlinks_override(Some(true));
        let mut v = view();
        let mut screen = crate::onboarding::OnboardingScreen::welcome();
        let mut panel = crate::auth_panel::AuthPanel::new("Login to Prime Inference");
        panel.show_auth_url("https://fixture.example/auth".to_string(), None);
        screen.mount_panel(crate::onboarding_flow::OnboardingPanel::Auth {
            panel: std::boxed::Box::new(panel),
            heading: None,
        });
        v.onboarding = Some(screen);
        let frame = v.render_frame(80, 24);
        crate::hyperlinks::set_hyperlinks_override(None);
        let url = "https://fixture.example/auth";
        let row = (0..frame.len())
            .find(|row| rendered_row(&frame, *row).contains(url))
            .expect("the URL row rendered");
        let col = rendered_row(&frame, row)
            .find(url)
            .expect("the URL text present");
        // The pane's rows are frame regions, so a drag over the URL copies its text.
        assert!(v.begin_frame_selection(row, col));
        v.extend_active_selection(row, col + url.len());
        let text = v.end_active_selection().expect("the dragged text");
        assert_eq!(text, url.to_string());
        // The URL's cells carry its OSC 8 target: a click there opens it.
        assert_eq!(v.hyperlink_at(row, col + 4), Some(url.to_string()));
        assert_eq!(
            v.hyperlink_at(row, col.saturating_sub(1)),
            None,
            "before the link"
        );
    }
}

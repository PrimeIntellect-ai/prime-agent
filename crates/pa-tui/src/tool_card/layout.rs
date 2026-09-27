//! Shared tool-card row traversal: painting retains rows; geometry only counts them.

use ratatui::style::Style;

use super::{eligible_images, image_rows, panel_header, panel_line, ToolCallCard, ToolResultView};
use crate::theme::{Theme, ThemeBg};
use crate::width::{wrap_line, wrap_text, wrapped_line_count, wrapped_text_count};
use crate::Line;

pub(super) fn panel_content_width(width: usize) -> usize {
    width.saturating_sub(4).max(1)
}

pub(super) enum RowOutput {
    Paint(Vec<Line>),
    Count(usize),
}

impl RowOutput {
    pub(super) fn paint() -> Self {
        Self::Paint(Vec::new())
    }
    pub(super) fn count() -> Self {
        Self::Count(0)
    }
    pub(super) fn len(&self) -> usize {
        match self {
            Self::Paint(rows) => rows.len(),
            Self::Count(count) => *count,
        }
    }
    pub(super) fn is_counting(&self) -> bool {
        matches!(self, Self::Count(_))
    }
    pub(super) fn add_count(&mut self, rows: usize) {
        match self {
            Self::Count(count) => *count += rows,
            Self::Paint(_) => panic!("count-only rows require a count sink"),
        }
    }
    pub(super) fn push(&mut self, row: impl FnOnce() -> Line) {
        match self {
            Self::Paint(rows) => rows.push(row()),
            Self::Count(count) => *count += 1,
        }
    }
    pub(super) fn blank(&mut self) {
        self.push(Vec::new);
    }
    pub(super) fn wrapped_line(&mut self, line: &Line, width: usize) {
        match self {
            Self::Paint(rows) => rows.extend(wrap_line(line, width)),
            Self::Count(count) => *count += wrapped_line_count(line, width),
        }
    }
    pub(super) fn wrapped_text(&mut self, text: &str, style: Style, width: usize) {
        match self {
            Self::Paint(rows) => rows.extend(wrap_text(text, width).into_iter().map(|row| {
                row.into_iter()
                    .map(|mut span| {
                        span.style = style;
                        span
                    })
                    .collect()
            })),
            Self::Count(count) => *count += wrapped_text_count(text, width),
        }
    }
    pub(super) fn images(
        &mut self,
        result: &Option<ToolResultView>,
        show_images: bool,
        theme: &Theme,
    ) {
        match self {
            Self::Paint(rows) => rows.extend(image_rows(result, show_images, theme)),
            Self::Count(count) => *count += eligible_images(result, show_images).count(),
        }
    }
    pub(super) fn panel(&mut self, card: &ToolCallCard, frame: usize, theme: &Theme, width: usize) {
        match self {
            Self::Count(count) => *count += 1 + usize::from(*count > 0),
            Self::Paint(rows) => {
                let bg = theme.bg_style(ThemeBg::ToolPanelBg);
                let children = std::mem::take(rows);
                rows.push(panel_line(panel_header(card, frame, theme), bg, width));
                if !children.is_empty() {
                    rows.push(panel_line(Vec::new(), bg, width));
                    rows.extend(
                        children
                            .into_iter()
                            .map(|child| panel_line(child, bg, width)),
                    );
                }
            }
        }
    }
    pub(super) fn into_lines(self) -> Vec<Line> {
        match self {
            Self::Paint(rows) => rows,
            Self::Count(_) => panic!("count sink has no painted rows"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    #[test]
    // deliberate decomposed/non-NFC fixtures: the width engine must measure the raw sequences
    #[allow(clippy::unicode_not_nfc)]
    fn count_sink_skips_paint_and_matches_panel_geometry() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let card = ToolCallCard::default();
        for text in ["", "a\nb", "数据 wide words é"] {
            for width in 0..30 {
                let mut count = RowOutput::count();
                let mut paint = RowOutput::paint();
                count.push(|| panic!("geometry must not paint fixed rows"));
                paint.blank();
                count.wrapped_text(text, Style::default(), panel_content_width(width));
                paint.wrapped_text(text, Style::default(), panel_content_width(width));
                count.panel(&card, 0, &theme, width);
                paint.panel(&card, 0, &theme, width);
                assert_eq!(count.len(), paint.into_lines().len());
            }
        }
    }
}

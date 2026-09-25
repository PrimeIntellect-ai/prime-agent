//! The selection restyle: visible window rows restyle only where the
//! selection changed. A drag frame recomputes the highlight for the rows
//! inside the selection range's diff — the rows the previous frame
//! already styled (and the untouched rows around them) reuse the cached
//! styled copies verbatim, so extending a drag by one row styles one row,
//! not the window. Rebuilt rows re-style from the cached window rows
//! (the per-entry line cache), never from the raw entries.

use super::AgentView;
use crate::Line;

#[cfg(test)]
thread_local! {
    /// Rows the last restyle re-styled (the selection-diff verifier).
    pub(super) static RESTYLE_ROWS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Frames the restyle rebuilt from scratch (content or window changed).
    pub(super) static RESTYLE_REBUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// One cached window of styled rows: the walked (unstyled) base rows, the
/// highlighted rows rendered from them, and the span each row carries.
/// Valid while the base rows and the window start hold; a content change
/// (streaming, stale marks, appends the walk picks up) fails the base
/// comparison and rebuilds.
#[derive(Default)]
pub(crate) struct SelectionRestyle {
    start: usize,
    base: Vec<Line>,
    styled: Vec<Line>,
    spans: Vec<Option<(usize, usize)>>,
}

impl SelectionRestyle {
    fn valid(&self, base: &[Line], start: usize) -> bool {
        self.start == start && self.base.len() == base.len() && self.base == base
    }
}

impl AgentView {
    /// Style the window rows for the active selection, reusing cached rows
    /// wherever the highlight did not change (the drag frame's cost is the
    /// selection diff, not the window).
    pub(crate) fn selection_styled_window(&mut self, base: Vec<Line>, start: usize) -> Vec<Line> {
        #[cfg(test)]
        {
            RESTYLE_ROWS.with(|count| count.set(0));
            RESTYLE_REBUILDS.with(|count| count.set(0));
        }
        let spans: Vec<Option<(usize, usize)>> = (0..base.len())
            .map(|index| self.transcript_highlight_span(start + index))
            .collect();
        let reused = self.selection_restyle.valid(&base, start);
        #[cfg(test)]
        RESTYLE_REBUILDS.with(|count| count.set(usize::from(!reused)));
        let cached = std::mem::take(&mut self.selection_restyle);
        let mut styled = if reused {
            cached.styled
        } else {
            base.iter()
                .enumerate()
                .map(|(index, row)| match spans[index] {
                    Some((from, to)) => crate::selection::highlight_line(row, from, to),
                    None => row.clone(),
                })
                .collect::<Vec<_>>()
        };
        if reused {
            #[cfg(test)]
            RESTYLE_ROWS.with(|count| {
                count.set(
                    spans
                        .iter()
                        .zip(cached.spans.iter())
                        .filter(|(span, cached)| span != cached)
                        .count(),
                );
            });
            for (index, span) in spans.iter().enumerate() {
                if *span != cached.spans.get(index).copied().flatten() {
                    styled[index] = match *span {
                        Some((from, to)) => {
                            crate::selection::highlight_line(&base[index], from, to)
                        }
                        None => base[index].clone(),
                    };
                }
            }
        } else {
            #[cfg(test)]
            RESTYLE_ROWS.with(|count| count.set(base.len()));
        }
        self.selection_restyle = SelectionRestyle {
            start,
            base,
            spans,
            styled,
        };
        self.selection_restyle.styled.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::ChatEntry;
    use crate::Span;
    use ratatui::style::Modifier;

    /// A view whose first user row renders on a known window row.
    fn view() -> AgentView {
        let mut view = AgentView::new(crate::theme::Theme::builtin(
            "prime",
            crate::theme::ColorMode::TrueColor,
        ));
        view.push_entry(ChatEntry::User {
            text: "row zero text".into(),
        });
        view.push_entry(ChatEntry::User {
            text: "row one text".into(),
        });
        view
    }

    fn base_rows(view: &mut AgentView) -> (Vec<Line>, usize) {
        view.visible_transcript_window(100, 30)
    }

    /// The screen row holding a needle (screen geometry, not a guess):
    /// one header row above the window, so the window index plus one.
    fn row_of(view: &mut AgentView, needle: &str) -> usize {
        let (base, _) = base_rows(view);
        (0..base.len())
            .find(|index| {
                base[*index]
                    .iter()
                    .any(|span| span.content.contains(needle))
            })
            .map(|index| index + 1)
            .expect("the needle renders in the window")
    }

    #[test]
    fn a_drag_extension_restyles_only_the_changed_rows() {
        let mut view = view();
        // One composed frame mounts the transcript window (the selection
        // surface needs `window_rows`).
        view.render_frame(100, 30);
        let (base, start) = base_rows(&mut view);
        let row = row_of(&mut view, "row zero");
        // Drag across three window rows, then extend by one more: the
        // second frame styles only the newly covered row.
        view.begin_selection(row, 2);
        view.extend_active_selection(row + 3, 6);
        let styled = view.selection_styled_window(base.clone(), start);
        // The composed frame already cached the unselected rows: the drag
        // styles only its four covered rows.
        RESTYLE_ROWS.with(|rows| assert_eq!(rows.get(), 4, "the drag styles its rows"));
        RESTYLE_REBUILDS.with(|rebuilds| assert_eq!(rebuilds.get(), 0));
        view.extend_active_selection(row + 4, 6);
        let base_len = base.len();
        let styled_rows = view.selection_styled_window(base, start);
        RESTYLE_ROWS.with(|rows| {
            assert_eq!(
                rows.get(),
                2,
                "the extension styles the two rows whose span changed"
            );
        });
        RESTYLE_REBUILDS.with(|rebuilds| assert_eq!(rebuilds.get(), 0));
        assert_eq!(styled_rows.len(), base_len);
        assert!(
            styled.iter().any(|row| row
                .iter()
                .any(|span: &Span| span.style.add_modifier.contains(Modifier::REVERSED))),
            "the dragged rows render reversed"
        );
    }

    #[test]
    fn content_changes_rebuild_the_styled_window() {
        let mut view = view();
        view.render_frame(100, 30);
        let (base, start) = base_rows(&mut view);
        let row = row_of(&mut view, "row zero");
        view.begin_selection(row, 2);
        view.selection_styled_window(base, start);
        // A new entry changes the walked rows: the cache rebuilds.
        view.push_entry(ChatEntry::User {
            text: "row two".into(),
        });
        let (base, start) = base_rows(&mut view);
        view.selection_styled_window(base, start);
        RESTYLE_REBUILDS.with(|rebuilds| assert_eq!(rebuilds.get(), 1));
    }
}

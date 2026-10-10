//! OSC 133 zone markers (`FinalTerm` shell integration): the transcript marks message rows with the
//! standard prompt/output zone sequences so shell-integration users get working jumps between turns
//! — `A` starts a marked row, `B` then `C` land at the start of the component's last row. The
//! sequences are zero-width: `width` skips them, the ratatui paint path strips them from cell
//! content. Only the main-screen transcript flush emits them to the terminal.

use crate::Line;

/// Zone start (prompt start): first row of a marked message.
pub const ZONE_START: &str = "\x1b]133;A\x07";
/// Zone end (command start) + zone final (output start): last row of a marked message, in that
/// order.
pub const ZONE_END: &str = "\x1b]133;B\x07";
pub const ZONE_FINAL: &str = "\x1b]133;C\x07";

/// The exact end-of-message prefix TS writes (`B` immediately followed by `C`).
pub const ZONE_END_PREFIX: &str = "\x1b]133;B\x07\x1b]133;C\x07";

/// Prepend the zone-start sequence to a rendered row.
pub fn mark_start(line: &mut Line) {
    line.insert(0, crate::Span::raw(ZONE_START));
}

/// Prepend the end-of-message sequences (`B` then `C`) to the last row.
pub fn mark_end(line: &mut Line) {
    line.insert(0, crate::Span::raw(ZONE_END_PREFIX));
}

/// Which zone sequences a rendered row carries.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct RowMarkers {
    pub start: bool,
    pub end: bool,
}

/// Detect the zone sequences at the start of a rendered row.
#[cfg(test)]
#[must_use]
pub(crate) fn row_markers(line: &Line) -> RowMarkers {
    let joined: String = line.iter().map(|s| s.content.as_str()).collect();
    let mut markers = RowMarkers::default();
    if joined.starts_with(ZONE_START) {
        markers.start = true;
    }
    if joined.starts_with(ZONE_END_PREFIX) {
        markers.end = true;
    }
    markers
}

/// Split a rendered row into its leading marker spans and the visible rest,
/// so an overlay can repaint a marked row without losing its zone flags.
pub(crate) fn split_leading_markers(line: &Line) -> (Line, Line) {
    let mut index = 0;
    while line
        .get(index)
        .is_some_and(|span| markers_only(&span.content))
    {
        index += 1;
    }
    (line[..index].to_vec(), line[index..].to_vec())
}

/// Strip zone-marker spans from a rendered row: markers are always inserted as their own raw spans
/// at the row head, so removal only inspects leading spans made of marker sequences.
pub fn strip(line: &mut Line) {
    line.retain(|span| !markers_only(&span.content));
}

/// True when a span's content is nothing but zone-marker sequences.
fn markers_only(content: &str) -> bool {
    let mut rest = content;
    loop {
        if rest.starts_with(ZONE_START) {
            rest = &rest[ZONE_START.len()..];
        } else if rest.starts_with(ZONE_END_PREFIX) {
            rest = &rest[ZONE_END_PREFIX.len()..];
        } else {
            break;
        }
    }
    !content.is_empty() && rest.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Span;

    fn row() -> Line {
        vec![Span::raw("hello"), Span::raw(" world")]
    }

    #[test]
    fn markers_wrap_first_and_last_rows() {
        let mut first = row();
        mark_start(&mut first);
        assert_eq!(first[0].content, ZONE_START);
        assert!(row_markers(&first).start);

        let mut last = row();
        mark_end(&mut last);
        assert_eq!(last[0].content, ZONE_END_PREFIX);
        let markers = row_markers(&last);
        assert!(markers.end && !markers.start);
    }

    #[test]
    fn split_leading_markers_keeps_zone_flags() {
        let mut line = row();
        mark_start(&mut line);
        let (markers, rest) = split_leading_markers(&line);
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].content, ZONE_START);
        let joined: String = rest.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "hello world");
        let (markers, rest) = split_leading_markers(&row());
        assert!(markers.is_empty());
        assert_eq!(rest.len(), 2);
    }

    #[test]
    fn strip_removes_marker_spans_only() {
        let mut line = row();
        mark_start(&mut line);
        strip(&mut line);
        let joined: String = line.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "hello world");

        let mut only_marker = vec![Span::raw(ZONE_START)];
        strip(&mut only_marker);
        assert!(only_marker.is_empty());
    }
}

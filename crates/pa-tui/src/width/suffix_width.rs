//! Incremental `str_width` over the advancing cut points of one string.
//!
//! The markdown overlong-word breaker emits a row per `width` columns and
//! needs the visible width of the remaining tail after every row. Calling
//! [`super::str_width`] per row rescans the whole tail, so an unbroken
//! multi-megabyte token wrapped at 80 columns went quadratic (a rescan, a
//! suffix clone, and a width-cache key per row). The cursor walks the same
//! escape/grapheme atoms `str_width` does - once - and answers every
//! advancing offset in amortized O(1).

use super::{escape_len, grapheme_width};
use unicode_segmentation::UnicodeSegmentation;

/// Visible width of `&text[at..]` for one string, asked at monotonically
/// advancing byte offsets (the row cut points of a wrap).
///
/// Answers are byte-identical to `str_width(&text[at..])` for every `at`
/// the wrap can produce: char boundaries, never inside an escape sequence
/// (the wrap copies escape sequences whole). A cut inside a grapheme
/// cluster is answered by re-measuring just that cluster remainder - the
/// only per-cut cost - plus the settled width past it.
pub(crate) struct SuffixWidth<'s> {
    /// The whole string this cursor measures suffixes of.
    text: &'s str,
    /// Every byte printable ASCII: `str_width` then equals byte length for
    /// every suffix, so no atom walk is needed. This is the pathological
    /// case the cursor exists for (unbroken base64/URL blobs).
    printable_ascii: bool,
    /// Largest offset answered so far; offsets must never move backwards.
    seen: usize,
    /// Byte offset where the current atom starts.
    atom_start: usize,
    /// Byte length of the current atom; 0 once the walk has ended.
    atom_len: usize,
    /// Visible width of the current atom (escape atoms measure 0).
    atom_width: usize,
    /// Visible width of `text[atom_start + atom_len..]`.
    after_width: usize,
}

impl<'s> SuffixWidth<'s> {
    /// `total_width` must be `str_width(text)` (the wrap already measured
    /// the token before deciding to break it); the cursor trusts it to
    /// seed the walk instead of re-scanning.
    pub(crate) fn new(text: &'s str, total_width: usize) -> Self {
        let mut cursor = Self {
            text,
            printable_ascii: text.bytes().all(|b| (0x20..=0x7e).contains(&b)),
            seen: 0,
            atom_start: 0,
            atom_len: 0,
            atom_width: 0,
            after_width: total_width,
        };
        if !cursor.printable_ascii {
            cursor.advance_atom();
        }
        cursor
    }

    /// `str_width(&text[at..])`, amortized O(1) while `at` moves forward.
    pub(crate) fn remaining_from(&mut self, at: usize) -> usize {
        debug_assert!(self.text.is_char_boundary(at), "cut between chars");
        debug_assert!(at >= self.seen, "suffix offsets must advance");
        self.seen = at;
        if self.printable_ascii {
            return self.text.len() - at;
        }
        // Whole atoms the cut passed are settled; it never comes back to them.
        while self.atom_len > 0 && at >= self.atom_start + self.atom_len {
            self.advance_atom();
        }
        if at == self.atom_start {
            // At an atom boundary (or past the walk): both halves are known.
            return self.atom_width + self.after_width;
        }
        // Inside a grapheme cluster: re-measure the cluster remainder - the
        // graphemes the tail walk forms from the cut - and add the settled
        // width past the cluster. Escape atoms never split.
        let atom_end = self.atom_start + self.atom_len;
        let mut rest = &self.text[at..atom_end];
        let mut width = self.after_width;
        while !rest.is_empty() {
            let g = rest.graphemes(true).next().expect("non-empty remainder");
            width += grapheme_width(g);
            rest = &rest[g.len()..];
        }
        width
    }

    /// Pull the next escape or grapheme atom off the walk, spending its
    /// width from the settled tail. Tab clusters measure 3, matching
    /// `str_width`'s tab expansion.
    fn advance_atom(&mut self) {
        let start = self.atom_start + self.atom_len;
        let tail = &self.text[start..];
        if tail.is_empty() {
            // Walk ended: no current atom, nothing left to measure.
            self.atom_start = start;
            self.atom_len = 0;
            self.atom_width = 0;
            return;
        }
        let (len, width) = if let Some(len) = escape_len(tail) {
            (len, 0)
        } else {
            let g = tail.graphemes(true).next().expect("non-empty tail");
            (g.len(), grapheme_width(g))
        };
        self.atom_start = start;
        self.atom_len = len;
        self.atom_width = width;
        self.after_width = self.after_width.saturating_sub(width);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::str_width;

    /// The markdown breaker only ever cuts at char boundaries outside
    /// escape sequences, so those are the offsets the cursor must match
    /// `str_width` on.
    fn cut_offsets(text: &str) -> Vec<usize> {
        let mut offsets = Vec::new();
        let mut rest = text;
        let mut at = 0;
        while !rest.is_empty() {
            offsets.push(at);
            let step = match escape_len(rest) {
                Some(len) => len,
                None => rest.chars().next().expect("non-empty").len_utf8(),
            };
            rest = &rest[step..];
            at += step;
        }
        offsets.push(at);
        offsets
    }

    #[test]
    fn remaining_from_matches_str_width_at_every_cut() {
        let corpus = [
            "x".repeat(40),
            "word words ".repeat(12),
            "界界界界 with ascii tail".to_owned(),
            "e\u{301} base and combining \u{301}\u{301} tail".to_owned(),
            "カ\u{ff9e} halfwidth sound mark".to_owned(),
            "\u{1f469}\u{200d}\u{1f4bb} zwj cluster pairs".to_owned(),
            "\u{1f1fa}\u{1f1f8} regional indicator pair run".to_owned(),
            "a\tb\t\tc tab atoms".to_owned(),
            "\u{1b}]8;;https://example.com\u{7}link\u{1b}]8;;\u{7} tail".to_owned(),
            "\u{1b}[31mred\u{1b}[0m plain \u{1b}[1;4mbold\u{1b}[0m".to_owned(),
            "\u{1b}[unterminated then words".to_owned(),
            "mixed x界\u{1f469}\u{200d}\u{1f4bb}\u{301}\t\u{1b}[1m!".to_owned(),
            "trailing \u{1b}[2m escape".to_owned(),
            "\u{1b}[2m leading escape".to_owned(),
            "\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466} family then ascii aaaa"
                .to_owned(),
        ];
        for text in corpus {
            let total = str_width(&text);
            let mut cursor = SuffixWidth::new(&text, total);
            for at in cut_offsets(&text) {
                assert_eq!(
                    cursor.remaining_from(at),
                    str_width(&text[at..]),
                    "{text:?} at {at}"
                );
            }
        }
    }
}

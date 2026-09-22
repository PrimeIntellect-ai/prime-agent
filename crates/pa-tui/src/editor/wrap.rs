//! Text segmentation and word wrap: grapheme segments, atomic paste/image
//! markers, and width-aware chunking used by rendering and cursor movement.

use crate::width::{is_whitespace_char, str_width};

/// One layout line produced for rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutLine {
    pub text: String,
    pub has_cursor: bool,
    pub cursor_pos: usize,
    pub source_line: usize,
    pub source_start: usize,
}

/// Visual line mapping entry (logical line + segment bounds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualLine {
    pub logical_line: usize,
    pub start_col: usize,
    pub length: usize,
}

/// A word-wrapping chunk with logical bounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextChunk {
    pub text: String,
    pub start_index: usize,
    pub end_index: usize,
}

/// Grapheme segment with char-scalar offset, mirroring Intl.Segmenter data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub segment: String,
    pub index: usize,
}

pub(crate) fn graphemes(text: &str) -> Vec<Segment> {
    use unicode_segmentation::UnicodeSegmentation;
    let mut index = 0usize;
    text.graphemes(true)
        .map(|g| {
            let seg = Segment {
                segment: g.to_string(),
                index,
            };
            // Char-scalar offset, mirroring Intl.Segmenter code-unit offsets
            // in TS. The editor cursor model (`cursor_col`) is char-based, so
            // every offset that crosses the segment/chunk boundary must be
            // char-based too; byte offsets are only ever used for slicing.
            index += g.chars().count();
            seg
        })
        .collect()
}

fn is_paste_marker(seg: &str) -> bool {
    // [paste #N (+L lines | C chars)]
    if !seg.starts_with("[paste #") || !seg.ends_with(']') {
        return false;
    }
    let body = &seg[8..seg.len() - 1];
    let Some((num, rest)) = body.split_once(' ') else {
        return rest_is_empty(body);
    };
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let rest = rest.strip_prefix('+').unwrap_or(rest);
    match rest.split_once(' ') {
        Some((n, "lines")) => !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()),
        Some((n, "chars")) => !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()),
        _ => false,
    }
}

fn rest_is_empty(body: &str) -> bool {
    !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit())
}

fn is_image_marker(seg: &str) -> bool {
    // [image #N]
    if !seg.starts_with("[image #") || !seg.ends_with(']') {
        return false;
    }
    let body = &seg[8..seg.len() - 1];
    !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit())
}

pub fn is_atomic_marker(seg: &str) -> bool {
    seg.len() >= 10 && (is_paste_marker(seg) || is_image_marker(seg))
}

/// Parse the well-formed paste marker heading `s` (TS
/// `PASTE_MARKER_REGEX`): `[paste #<id>]`, `[paste #<id> +<N> lines]`, or
/// `[paste #<id> <N> chars]`. Returns the parsed id and the marker's byte
/// length; a malformed head yields `None`.
pub(crate) fn parse_paste_marker(s: &str) -> Option<(usize, usize)> {
    let rest = s.strip_prefix("[paste #")?;
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let id: usize = rest[..digits].parse().ok()?;
    let bare = "[paste #".len() + digits + 1;
    if rest[digits..].starts_with(']') {
        return Some((id, bare));
    }
    // ` (+<N> lines | <N> chars)]`
    let suffix = rest[digits..].strip_prefix(' ')?;
    let suffix_len = if let Some(tail) = suffix.strip_prefix('+') {
        let n = tail.bytes().take_while(|b| b.is_ascii_digit()).count();
        if n == 0 || !tail[n..].starts_with(" lines]") {
            return None;
        }
        2 + n + " lines]".len()
    } else {
        let n = suffix.bytes().take_while(|b| b.is_ascii_digit()).count();
        if n == 0 || !suffix[n..].starts_with(" chars]") {
            return None;
        }
        1 + n + " chars]".len()
    };
    Some((id, "[paste #".len() + digits + suffix_len))
}

/// Segment text merging valid paste markers and image markers into atomic units.
pub(crate) fn segment_with_markers(
    text: &str,
    valid_paste_ids: &dyn Fn(usize) -> bool,
) -> Vec<Segment> {
    let has_paste = text.contains("[paste #");
    let has_image = text.contains("[image #");
    let base = graphemes(text);
    if !has_paste && !has_image {
        return base;
    }

    let mut markers: Vec<MarkerSpan> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < text.len() {
        if bytes[i] == b'[' {
            let rest = &text[i..];
            let close = rest.find(']').map(|p| i + p + 1);
            if let Some(end) = close {
                let cand = &text[i..end];
                let id = cand
                    .strip_prefix("[paste #")
                    .and_then(|b| b.split([']', ' ']).next().map(|s| s.to_string()))
                    .and_then(|s| s.parse::<usize>().ok());
                let keep = match id {
                    Some(id) => has_paste && valid_paste_ids(id),
                    None => has_image && is_image_marker(cand),
                };
                if keep {
                    // Byte offsets slice the marker text, char-scalar
                    // offsets index it in the same space as the grapheme
                    // `Segment.index` values it is matched against (TS:
                    // Intl.Segmenter + matchAll both index by code unit).
                    markers.push(MarkerSpan {
                        byte: (i, end),
                        char: (char_offset(text, i), char_offset(text, end)),
                    });
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    if markers.is_empty() {
        return base;
    }

    let mut result: Vec<Segment> = Vec::new();
    let mut marker_idx = 0usize;
    for seg in base {
        while marker_idx < markers.len() && markers[marker_idx].char.1 <= seg.index {
            marker_idx += 1;
        }
        let in_marker = marker_idx < markers.len()
            && seg.index >= markers[marker_idx].char.0
            && seg.index < markers[marker_idx].char.1;
        if in_marker {
            if seg.index == markers[marker_idx].char.0 {
                let (start, end) = markers[marker_idx].byte;
                result.push(Segment {
                    segment: text[start..end].to_string(),
                    index: markers[marker_idx].char.0,
                });
            }
        } else {
            result.push(seg);
        }
    }
    result
}

/// Byte and char-scalar bounds of one atomic marker within the source text.
struct MarkerSpan {
    byte: (usize, usize),
    char: (usize, usize),
}

/// Char-scalar offset of a byte offset into `text` (byte must be a char
/// boundary; markers and segment bounds always are).
fn char_offset(text: &str, byte: usize) -> usize {
    text.char_indices().take_while(|(b, _)| *b < byte).count()
}

/// Split a line into word-wrapped chunks (port of wordWrapLine).
pub fn word_wrap_line(
    line: &str,
    max_width: usize,
    segments: Option<Vec<Segment>>,
) -> Vec<TextChunk> {
    if line.is_empty() || max_width == 0 {
        return vec![TextChunk {
            text: String::new(),
            start_index: 0,
            end_index: 0,
        }];
    }
    if str_width(line) <= max_width {
        return vec![TextChunk {
            text: line.to_string(),
            start_index: 0,
            end_index: line.chars().count(),
        }];
    }
    let segments = segments.unwrap_or_else(|| graphemes(line));
    // Segments tile the line, so their byte lengths yield the byte boundary
    // of every segment start. Chunk indices stay char-scalar offsets (the
    // editor cursor model); byte offsets are only ever used to slice `line`.
    let mut seg_bytes = Vec::with_capacity(segments.len() + 1);
    let mut byte = 0usize;
    for seg in &segments {
        seg_bytes.push(byte);
        byte += seg.segment.len();
    }
    seg_bytes.push(byte);
    let mut chunks: Vec<TextChunk> = Vec::new();
    let mut current_width = 0usize;
    let mut chunk_start = 0usize;
    let mut chunk_start_byte = 0usize;
    let mut wrap_opp_index: isize = -1;
    let mut wrap_opp_width = 0usize;
    let mut wrap_opp_byte = 0usize;

    for i in 0..segments.len() {
        let seg = &segments[i];
        let grapheme = &seg.segment;
        let g_width = str_width(grapheme);
        let char_index = seg.index;
        let byte_index = seg_bytes[i];
        let is_ws = !is_atomic_marker(grapheme)
            && grapheme.chars().all(is_whitespace_char)
            && !grapheme.is_empty();

        if current_width + g_width > max_width {
            if wrap_opp_index >= 0 && current_width - wrap_opp_width + g_width <= max_width {
                let opp = wrap_opp_index as usize;
                chunks.push(TextChunk {
                    text: line[chunk_start_byte..wrap_opp_byte].to_string(),
                    start_index: chunk_start,
                    end_index: opp,
                });
                chunk_start = opp;
                chunk_start_byte = wrap_opp_byte;
                current_width -= wrap_opp_width;
            } else if chunk_start < char_index {
                chunks.push(TextChunk {
                    text: line[chunk_start_byte..byte_index].to_string(),
                    start_index: chunk_start,
                    end_index: char_index,
                });
                chunk_start = char_index;
                chunk_start_byte = byte_index;
                current_width = 0;
            }
            wrap_opp_index = -1;
        }

        if g_width > max_width {
            // Atomic segment wider than the viewport: visual-only re-wrap.
            let sub_chunks = word_wrap_line(grapheme, max_width, None);
            let mut sub_byte = byte_index;
            for sc in &sub_chunks[..sub_chunks.len() - 1] {
                chunks.push(TextChunk {
                    text: sc.text.clone(),
                    start_index: char_index + sc.start_index,
                    end_index: char_index + sc.end_index,
                });
                sub_byte += sc.text.len();
            }
            let last = &sub_chunks[sub_chunks.len() - 1];
            chunk_start = char_index + last.start_index;
            chunk_start_byte = sub_byte;
            current_width = str_width(&last.text);
            wrap_opp_index = -1;
            continue;
        }

        current_width += g_width;

        let next = segments.get(i + 1);
        let next_starts_word = next.is_some_and(|n| {
            is_atomic_marker(&n.segment) || n.segment.chars().any(|c| !is_whitespace_char(c))
        });
        if is_ws && next_starts_word {
            if let Some(next) = next {
                wrap_opp_index = next.index as isize;
                wrap_opp_width = current_width;
                wrap_opp_byte = seg_bytes[i + 1];
            }
        }
    }

    chunks.push(TextChunk {
        text: line[chunk_start_byte..].to_string(),
        start_index: chunk_start,
        end_index: line.chars().count(),
    });
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_wrap_chunks() {
        let chunks = word_wrap_line("hello world this wraps", 10, None);
        for c in &chunks {
            assert!(str_width(&c.text) <= 10, "chunk too wide: {:?}", c.text);
        }
        let joined: String = chunks
            .iter()
            .map(|c| c.text.clone())
            .collect::<Vec<_>>()
            .join("");
        assert_eq!(joined, "hello world this wraps");
    }

    // FEATURE_PARITY.md Tier 0 audit repro: a CJK draft wider than the editor
    // panicked with `byte index ... is not a char boundary` because
    // `Segment.index` held grapheme ordinals while `word_wrap_line` sliced
    // `line` with them as byte offsets.
    #[test]
    fn cjk_wider_than_editor_does_not_panic() {
        let line = "你好世界，这是一段很长的中文文本，超过了编辑器的宽度，会触发换行逻辑。";
        let chunks = word_wrap_line(line, 10, None);
        let joined: String = chunks.iter().map(|c| c.text.clone()).collect();
        assert_eq!(joined, line);
        for c in &chunks {
            assert!(str_width(&c.text) <= 10, "chunk too wide: {:?}", c.text);
        }
    }

    fn assert_wraps_back_to_source(line: &str, max_width: usize) -> Vec<TextChunk> {
        let chunks = word_wrap_line(line, max_width, None);
        let joined: String = chunks.iter().map(|c| c.text.clone()).collect();
        assert_eq!(
            joined, line,
            "chunks must concatenate to the source line (width {max_width})"
        );
        for c in &chunks {
            assert!(
                str_width(&c.text) <= max_width,
                "chunk too wide ({:?}, width {} > {max_width})",
                c.text,
                str_width(&c.text)
            );
        }
        // Chunk bounds are char-scalar offsets in the editor cursor model.
        let line_chars = line.chars().count();
        for c in &chunks {
            assert!(c.start_index <= c.end_index);
            assert!(c.end_index <= line_chars);
            assert_eq!(
                c.text,
                line.chars()
                    .skip(c.start_index)
                    .take(c.end_index - c.start_index)
                    .collect::<String>(),
                "chunk bounds must be char offsets"
            );
        }
        chunks
    }

    #[test]
    fn wide_and_zero_width_graphemes_wrap() {
        // CJK (width 2) wrapping with word backtracking across spaces.
        assert_wraps_back_to_source("日本語 テキスト は 長い 長い 長い", 6);
        // Hangul syllables mixed with ASCII words.
        assert_wraps_back_to_source("hello 안녕하세요 world 안녕", 7);
        // Emoji (width 2) ZWJ family and flags: single graphemes, wider than
        // the width-3 budget forces grapheme-granular breaks mid-line.
        assert_wraps_back_to_source("word 👨‍👩‍👧‍👦 word 🇯🇵 end", 3);
        // Combining marks: e + U+0301 is one grapheme of two chars.
        assert_wraps_back_to_source("cafe\u{301} cafe\u{301} cafe\u{301} tail", 4);
        // Halfwidth katakana voicing mark is width 1 (see width::char_width),
        // so each cluster is 3 columns. NB: a single grapheme wider than the
        // viewport re-wraps into itself — the TS binary has the identical
        // edge (wordWrapLine of one 3-wide cluster at maxWidth < 3), kept
        // for parity; real editor widths never hit it.
        assert_wraps_back_to_source("カ\u{ff9e}キ\u{ff9e}ク\u{ff9e}ケ\u{ff9e}", 3);
        // A single grapheme wider than the viewport re-wraps visually.
        let chunks = assert_wraps_back_to_source("👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 5);
        assert!(chunks.len() >= 2);
        // Zero-width joiner inside clusters vs plain long ASCII words.
        assert_wraps_back_to_source("aaaaaaaaaa\u{200d}bbbbbbbbbb ccc", 5);
    }

    #[test]
    fn wrap_indices_track_char_offsets_for_cjk() {
        // The editor cursor model is char-based, so chunk bounds must be
        // char offsets, not byte offsets or grapheme ordinals.
        let line = "ab你好 cd";
        let chunks = word_wrap_line(line, 4, None);
        let joined: String = chunks.iter().map(|c| c.text.clone()).collect();
        assert_eq!(joined, line);
        let mut expected_start = 0usize;
        for c in &chunks {
            assert_eq!(c.start_index, expected_start);
            expected_start = c.end_index;
        }
        assert_eq!(expected_start, line.chars().count());
    }

    #[test]
    fn marker_segmentation_with_non_ascii_prefix() {
        // segment_with_markers must index markers in the same space as the
        // grapheme segments it merges them into.
        let segs = segment_with_markers("前[paste #1 +2 lines]后", &|_| true);
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].segment, "前");
        assert_eq!(segs[0].index, 0);
        assert_eq!(segs[1].segment, "[paste #1 +2 lines]");
        assert_eq!(segs[1].index, 1);
        assert_eq!(segs[2].segment, "后");
        assert_eq!(segs[2].index, 20); // 1 char prefix + 19-char marker

        // The merged marker stays atomic through word wrap: it re-wraps
        // visually (g_width > max_width path) with chunk bounds in char
        // offsets.
        let line = "(prefix)[image #1](suffix)";
        let chunks = assert_wraps_back_to_source(line, 6);
        assert!(chunks.len() > 1);
    }

    /// Deterministic mixed-width fuzz corpus: every string must wrap without
    /// panicking, concatenate back to the source, respect the width budget,
    /// and keep chunk bounds on char boundaries at every editor width.
    #[test]
    fn fuzz_mixed_width_wrap() {
        let alphabets: [&str; 8] = [
            "ab cd ef gh ",                // ascii words/spaces
            "あいうえお、",                // CJK width 2 + punctuation
            "한국어 텍스트",               // Hangul
            "🎉🎊✨",                      // emoji
            "👨‍👩‍👧‍👦🇺🇸",                        // multi-char grapheme clusters
            "e\u{301}\u{302}x y\u{301}z ", // combining marks
            "\u{200b}\u{feff} zw\u{200d}", // zero-width chars
            "\r\n ",                       // control/whitespace
                                           // NB: no tab graphemes here — a tab is 3 columns wide, and a
                                           // single grapheme wider than maxWidth re-wraps into itself.
                                           // The TS binary has the identical edge (wordWrapLine of one
                                           // 3-wide grapheme at maxWidth < 3), so it is kept for parity.
        ];
        let mut seed: u64 = 0x2f7f_e921_8843_1a55;
        let mut rng = move || {
            // xorshift64*
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed.wrapping_mul(0x2545_f491_4f6c_dd1d)
        };
        for _case in 0..600 {
            let len = (rng() % 40 + 1) as usize;
            let mut line = String::new();
            for _ in 0..len {
                let alphabet = alphabets[(rng() % alphabets.len() as u64) as usize];
                let bytes = alphabet.as_bytes();
                // Pick a random (possibly non-boundary) cut; the next char
                // boundary keeps the pushed substring well-formed.
                let cut = (rng() as usize) % bytes.len();
                let next_boundary = alphabet
                    .char_indices()
                    .map(|(b, _)| b)
                    .find(|b| b > &cut)
                    .unwrap_or(alphabet.len());
                line.push_str(&alphabet[..next_boundary]);
            }
            for width in 2..=12 {
                assert_wraps_back_to_source(&line, width);
            }
            // Also via the marker-aware segmentation path (markers absent,
            // so this exercises the plain-grapheme segment branch).
            let segments = segment_with_markers(&line, &|_| false);
            let chunks = word_wrap_line(&line, 5, Some(segments));
            let joined: String = chunks.iter().map(|c| c.text.clone()).collect();
            assert_eq!(joined, line);
            for c in &chunks {
                assert!(str_width(&c.text) <= 5, "chunk too wide: {:?}", c.text);
            }
        }
    }
}

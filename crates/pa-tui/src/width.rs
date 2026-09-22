//! Terminal column width measurement, wrapping, and truncation.
//!
//! Mirrors `packages/tui/src/utils.ts`: grapheme-aware widths, emoji counted
//! as 2 columns, tabs expand to 3 spaces when measuring rendered output.

use crate::{Line, Span};
use unicode_width::UnicodeWidthChar;

/// Width of one grapheme cluster approximated by its first char plus zero-width
/// continuation chars. Good enough for the terminal layout we render.
pub fn char_width(c: char) -> usize {
    match c {
        '\t' => 3,
        // TS `graphemeWidth` counts the halfwidth katakana sound marks
        // (EastAsianWidth H) as one column each, both standalone and as
        // the trailing half of a cluster; `unicode-width` counts them zero
        // as Grapheme_Extend. The prompt-token mask pads its placeholders
        // with `FF9E` per extra column, so the layout wrap must count it.
        '\u{FF9E}' | '\u{FF9F}' => 1,
        c if c.is_control() => 0,
        c => c.width().unwrap_or(0),
    }
}

/// Length of a complete ANSI escape sequence at the start of `s`, if any
/// (TS `createAnsiCodeExtractor`): CSI parameter/intermediate/final bytes,
/// OSC and APC strings ending at BEL or ST, and DCS/PM/SOS ending at ST.
/// A malformed or unterminated sequence returns `None` and stays visible.
pub(crate) fn escape_len(s: &str) -> Option<usize> {
    let mut chars = s.char_indices();
    let (_, first) = chars.next()?;
    if first != '\x1b' {
        return None;
    }
    let (_, second) = chars.next()?;
    let mut consumed = 1 + second.len_utf8();
    let mut pending = chars;
    match second {
        '[' => {
            let mut has_intermediate = false;
            for (_, c) in pending.by_ref() {
                let byte = c as u32;
                consumed += c.len_utf8();
                if (0x30..=0x3f).contains(&byte) && !has_intermediate {
                    continue;
                }
                if (0x20..=0x2f).contains(&byte) {
                    has_intermediate = true;
                    continue;
                }
                if (0x40..=0x7e).contains(&byte) {
                    return Some(consumed);
                }
                return None;
            }
            None
        }
        ']' | '_' | 'P' | '^' | 'X' => {
            let allow_bel = second == ']' || second == '_';
            while let Some((index, c)) = pending.next() {
                if c == '\x07' && allow_bel {
                    return Some(index + 1);
                }
                if c == '\x1b' {
                    match pending.next() {
                        Some((after, '\\')) => return Some(after + 1),
                        _ => return None,
                    }
                }
            }
            None
        }
        _ => None,
    }
}

pub fn str_width(s: &str) -> usize {
    if s.is_empty() {
        return 0;
    }
    // TS `isPrintableAscii` fast path: a pure printable-ASCII string is as
    // wide as it is long, no grapheme segmentation needed.
    if s.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return s.len();
    }
    if let Some(width) = width_cache().lock().unwrap().get(s) {
        return *width;
    }
    use unicode_segmentation::UnicodeSegmentation;
    let mut width = 0;
    let mut rest = s;
    while !rest.is_empty() {
        match escape_len(rest) {
            Some(len) => rest = &rest[len..],
            None => {
                let g = rest.graphemes(true).next().expect("non-empty rest");
                width += grapheme_width(g);
                rest = &rest[g.len()..];
            }
        }
    }
    let mut cache = width_cache().lock().unwrap();
    // TS caps its width cache at 512 entries, evicting the oldest key; the
    // HashMap has no insertion order, so evict an arbitrary key instead.
    if cache.len() >= WIDTH_CACHE_SIZE {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        }
    }
    cache.insert(s.to_string().into_boxed_str(), width);
    width
}

const WIDTH_CACHE_SIZE: usize = 512;

fn width_cache() -> &'static std::sync::Mutex<std::collections::HashMap<Box<str>, usize>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<Box<str>, usize>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// A char that renders nothing on its own: controls and zero-width chars
/// (unicode-width reports marks, joiners, and variation selectors as `None`).
fn is_invisible(c: char) -> bool {
    c.is_control() || c.width().unwrap_or(0) == 0
}

/// Width of one grapheme cluster (port of TS `graphemeWidth` in utils.ts).
///
/// TS measures whole clusters, not chars: RGI emoji sequences (ZWJ families,
/// skin tones, keycaps, VS16 presentations) render 2 columns no matter how
/// many code points they carry, regional indicators (flags, and isolated
/// ones during streaming) render 2, halfwidth/fullwidth trailing forms add
/// up, and all-invisible clusters render 0.
/// True for the code-point blocks of the TS `couldBeEmoji` pre-filter (kept
/// deliberately broad, like TS) plus the emoji-modifier skin tones.
fn in_emoji_blocks(c: char) -> bool {
    let cp = c as u32;
    (0x1f000..=0x1fbff).contains(&cp)
        || (0x2300..=0x23ff).contains(&cp)
        || (0x2600..=0x27bf).contains(&cp)
        || (0x2b50..=0x2b55).contains(&cp)
}

fn grapheme_width(g: &str) -> usize {
    let mut chars = g.chars();
    let Some(first) = chars.next() else {
        return 0;
    };
    if chars.all(is_invisible) && is_invisible(first) {
        // TS zeroWidthRegex: control / default-ignorable / mark-only cluster.
        return 0;
    }
    // Regional indicators render as flag emoji even when isolated (the
    // streamed halves of a flag pair drift alone during streaming).
    if ('\u{1f1e6}'..='\u{1f1ff}').contains(&first) {
        return 2;
    }
    if g.chars().count() <= 1 {
        return char_width(first);
    }
    if is_rgi_emoji_cluster(first, g) {
        // Approximation of the TS RGI_Emoji test: an emoji-led multi-char
        // cluster (ZWJ family, skin tone, VS16 presentation, keycap) is
        // one 2-column cell.
        return 2;
    }
    // Base visible char plus the trailing forms TS counts: halfwidth/
    // fullwidth forms and the Thai/Lao AM vowels; marks add nothing.
    let mut w = char_width(first);
    for c in g.chars().skip(1) {
        if ('\u{ff00}'..='\u{ffef}').contains(&c) {
            w += char_width(c);
        } else if c == '\u{0e33}' || c == '\u{0eb3}' {
            w += 1;
        }
    }
    w
}

/// Approximation of the TS `rgiEmojiRegex` decisive test for multi-char
/// clusters. In TS `couldBeEmoji` is only a pre-filter; a cluster renders 2
/// columns only when the whole sequence is an RGI emoji: a ZWJ sequence of
/// emoji parts, an emoji (or keycap base) with VS16, or an emoji with a
/// skin-tone modifier. A letter plus combining marks must fall through here.
fn is_rgi_emoji_cluster(first: char, g: &str) -> bool {
    let skin_tone = |c: char| ('\u{1f3fb}'..='\u{1f3ff}').contains(&c);
    let keycap_base = |c: char| c.is_ascii_digit() || c == '#' || c == '*';
    if g.contains('\u{200d}') {
        // ZWJ family/couple: every ZWJ-joined part must start with an
        // emoji-ish base (skin tones and marks alone do not qualify).
        return g.split('\u{200d}').all(|part| {
            part.chars()
                .find(|c| !is_invisible(*c))
                .is_some_and(|base| in_emoji_blocks(base) || skin_tone(base))
        });
    }
    if g.contains('\u{fe0f}') {
        // VS16 presentation / keycap sequence.
        return in_emoji_blocks(first) || keycap_base(first);
    }
    // Emoji + skin tone modifier (no VS16, no ZWJ).
    in_emoji_blocks(first) && g.chars().skip(1).all(|c| skin_tone(c) || is_invisible(c))
}
pub fn spans_width(spans: &[Span]) -> usize {
    spans.iter().map(|s| str_width(&s.content)).sum()
}

pub fn line_width(line: &[Span]) -> usize {
    spans_width(line)
}

pub fn is_whitespace_char(c: char) -> bool {
    // TS `isWhitespaceChar` tests JS /\s/: same set as Unicode White_Space
    // except the BOM (U+FEFF) counts as whitespace and NEL (U+0085) does
    // not — the wrap-opportunity logic in wordWrapLine depends on the
    // distinction (a FEFF cluster records a break opportunity).
    c == '\u{feff}' || (c != '\u{0085}' && c.is_whitespace())
}

const PUNCTUATION: &str = "(){}[]<>.,;:'\"!?+-=*/\\|&%^$#@~`";

pub fn is_punctuation_char(c: char) -> bool {
    PUNCTUATION.contains(c)
}

/// Strip a leading run of zero-width/format chars (approximation of the TS
/// leading-non-printing trim).
fn base_char_width(c: char) -> usize {
    match c {
        '\u{200b}'..='\u{200f}'
        | '\u{feff}'
        | '\u{2060}'..='\u{2064}'
        | '\u{0300}'..='\u{036f}' => 0,
        _ => char_width(c),
    }
}

/// Pad a line with plain spaces to exactly `width` visible columns.
pub fn pad_line(mut line: Line, width: usize) -> Line {
    let w = line_width(&line);
    if w < width {
        line.push(Span::raw(" ".repeat(width - w)));
    }
    line
}

/// Truncate a line to `max_width` visible columns, appending `ellipsis` (also
/// measured) when content was cut.
pub fn truncate_line(line: &Line, max_width: usize, ellipsis: &str) -> Line {
    if line_width(line) <= max_width {
        return line.clone();
    }
    let ellipsis_width = str_width(ellipsis);
    let budget = max_width.saturating_sub(ellipsis_width);
    let mut out: Line = Vec::new();
    let mut used = 0usize;
    'outer: for span in line {
        let mut rest = span.content.as_str();
        while !rest.is_empty() {
            if let Some(len) = escape_len(rest) {
                // Escape sequences copy through untouched at zero width.
                for c in rest[..len].chars() {
                    push_char(&mut out, span.style, c);
                }
                rest = &rest[len..];
                continue;
            }
            let c = rest.chars().next().expect("non-empty rest");
            let w = char_width(c);
            if used + w > budget {
                break 'outer;
            }
            push_char(&mut out, span.style, c);
            used += w;
            rest = &rest[c.len_utf8()..];
        }
    }
    if !ellipsis.is_empty() {
        out.push(Span::styled(
            ellipsis.to_string(),
            ellipsis_span_style(line),
        ));
    }
    out
}

fn ellipsis_span_style(line: &Line) -> ratatui::style::Style {
    line.last().map(|s| s.style).unwrap_or_default()
}

fn push_char(out: &mut Line, style: ratatui::style::Style, c: char) {
    if let Some(last) = out.last_mut() {
        if last.style == style {
            last.content.push(c);
            return;
        }
    }
    out.push(Span::styled(c.to_string(), style));
}

/// Split a line into wrapped lines at word boundaries, mirroring
/// `wrapSingleLine` in utils.ts: break long tokens at char level, trim
/// trailing whitespace on each wrapped line, never start a line with
/// whitespace.
pub fn wrap_line(line: &Line, width: usize) -> Vec<Line> {
    if width == 0 {
        return vec![line.clone()];
    }
    if line_width(line) <= width {
        return vec![line.clone()];
    }

    // Tokenize: whitespace runs and non-whitespace runs (styles split too).
    let tokens = tokenize(line);
    let mut wrapped: Vec<Line> = Vec::new();
    let mut current: Line = Vec::new();
    let mut current_width = 0usize;

    for token in &tokens {
        let token_width = line_width(token);
        let is_ws = token
            .iter()
            .all(|s| s.content.chars().all(is_whitespace_char));
        if token_width > width && !is_ws {
            // Flush current line, then hard-break the token.
            if !current.is_empty() {
                wrapped.push(std::mem::take(&mut current));
            }
            let mut chunk: Line = Vec::new();
            let mut chunk_width = 0usize;
            for span in token.iter() {
                for c in span.content.chars() {
                    let w = char_width(c);
                    if chunk_width + w > width {
                        wrapped.push(std::mem::take(&mut chunk));
                        chunk_width = 0;
                    }
                    push_char(&mut chunk, span.style, c);
                    chunk_width += w;
                }
            }
            current = chunk;
            current_width = chunk_width;
            continue;
        }
        if current_width + token_width > width && current_width > 0 {
            let trimmed = trim_end(&current);
            wrapped.push(trimmed);
            current = Vec::new();
            current_width = 0;
            if is_ws {
                continue;
            }
        }
        current.extend(token.iter().cloned());
        current_width += token_width;
    }
    if !current.is_empty() {
        wrapped.push(current);
    }
    if wrapped.is_empty() {
        wrapped.push(Vec::new());
    }
    wrapped
}

fn trim_end(line: &Line) -> Line {
    let mut out = line.clone();
    while let Some(last) = out.last_mut() {
        let trimmed = last.content.trim_end();
        if trimmed.is_empty() {
            out.pop();
        } else {
            last.content = trimmed.to_string();
            break;
        }
    }
    out
}

fn tokenize(line: &Line) -> Vec<Line> {
    let mut tokens: Vec<Line> = Vec::new();
    for span in line {
        let mut current = String::new();
        let mut current_ws: Option<bool> = None;
        for c in span.content.chars() {
            let ws = is_whitespace_char(c);
            match current_ws {
                Some(prev) if prev == ws => current.push(c),
                Some(_) => {
                    tokens.push(vec![Span::styled(std::mem::take(&mut current), span.style)]);
                    current.push(c);
                    current_ws = Some(ws);
                }
                None => {
                    current.push(c);
                    current_ws = Some(ws);
                }
            }
        }
        if !current.is_empty() {
            tokens.push(vec![Span::styled(current, span.style)]);
        }
    }
    tokens
}

/// Wrap plain text (may contain \n) into lines of styled raw spans.
pub fn wrap_text(text: &str, width: usize) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    for para in text.split('\n') {
        let line: Line = vec![Span::raw(para.to_string())];
        out.extend(wrap_line(&line, width));
    }
    if out.is_empty() {
        out.push(Vec::new());
    }
    out
}

/// Slice a line by visible columns `[start, start+length)`.
pub fn slice_line_by_column(line: &Line, start: usize, length: usize) -> Line {
    let mut out: Line = Vec::new();
    let mut col = 0usize;
    let end = start.saturating_add(length);
    for span in line {
        for c in span.content.chars() {
            let w = char_width(c);
            if col >= start && col + w <= end {
                push_char(&mut out, span.style, c);
            }
            col += w;
            if col >= end {
                return out;
            }
        }
    }
    out
}

/// Drop trailing blank lines from a rendered block (e.g. trailing Spacer output).
pub fn trim_trailing_empty(lines: &mut Vec<Line>) {
    while lines
        .last()
        .is_some_and(|l| l.is_empty() || l.iter().all(|s| s.content.trim().is_empty()))
    {
        lines.pop();
    }
}

/// First char width of `s` for overflow checks.
pub fn base_char_w(c: char) -> usize {
    base_char_width(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halfwidth_sound_marks_count_one_column() {
        // TS `graphemeWidth` counts U+FF9E/U+FF9F (EastAsianWidth H) as
        // one column each — the prompt-token mask pads its placeholders
        // with FF9E per extra column, so the layout wrap must count it.
        assert_eq!(char_width('\u{FF9E}'), 1);
        assert_eq!(char_width('\u{FF9F}'), 1);
        assert_eq!(str_width("a\u{FF9E}b"), 3);
    }

    #[test]
    fn multi_code_point_clusters_measure_one_cell() {
        // Port of TS `graphemeWidth`: clusters measure whole, not per char.
        assert_eq!(str_width("👨‍👩‍👧‍👦"), 2); // ZWJ family: one 2-col cell
        assert_eq!(str_width("🇯🇵"), 2); // flag pair
        assert_eq!(str_width("🇯"), 2); // isolated regional indicator
        assert_eq!(str_width("café\u{301}"), 4); // combining mark adds nothing
        assert_eq!(str_width("#️⃣"), 2); // keycap
        assert_eq!(str_width("👍🏽"), 2); // skin tone
        assert_eq!(str_width("カ\u{ff9e}"), 3); // katakana + halfwidth mark
        assert_eq!(str_width("\u{feff}"), 0); // zero-width BOM
        assert_eq!(str_width("\u{200d}"), 0); // lone ZWJ
        assert_eq!(str_width("a\u{200d}b"), 2); // ZWJ does not cluster letters
    }
}

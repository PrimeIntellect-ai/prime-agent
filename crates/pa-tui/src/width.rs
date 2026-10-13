//! Terminal column width measurement, wrapping, and truncation.
//! Mirrors TS `utils.ts`: grapheme-aware widths, emoji as 2 columns,
//! tabs expand to 3 spaces.

use crate::{Line, Span};
use unicode_properties::{
    EmojiStatus, GeneralCategory, GeneralCategoryGroup, UnicodeEmoji, UnicodeGeneralCategory,
};
use unicode_width::UnicodeWidthChar;

mod wrapping;
#[cfg(test)]
mod wrapping_tests;

/// Truncate to a display-width budget and pad to exactly `width`
/// columns — grapheme-aware, so table cells stay aligned.
#[must_use]
pub fn pad_cell(text: &str, width: usize) -> String {
    use unicode_segmentation::UnicodeSegmentation;
    let mut cell = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let cell_width = grapheme_width(grapheme);
        if used + cell_width > width {
            break;
        }
        cell.push_str(grapheme);
        used += cell_width;
    }
    cell.push_str(&" ".repeat(width - used));
    cell
}

/// Truncate a plain string to a display-width budget, ellipsis included
/// (no ANSI, no pad); a budget too small for the ellipsis clips it.
#[must_use]
pub fn truncate_to_width(text: &str, max_width: usize, ellipsis: &str) -> String {
    use unicode_segmentation::UnicodeSegmentation;
    if max_width == 0 || text.is_empty() {
        return String::new();
    }
    if str_width(text) <= max_width {
        return text.to_string();
    }
    let ellipsis_width = str_width(ellipsis);
    if ellipsis_width >= max_width {
        let mut clipped = String::new();
        let mut used = 0usize;
        for grapheme in ellipsis.graphemes(true) {
            let width = grapheme_width(grapheme);
            if used + width > max_width {
                break;
            }
            clipped.push_str(grapheme);
            used += width;
        }
        return clipped;
    }
    let target = max_width - ellipsis_width;
    let mut kept = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let width = grapheme_width(grapheme);
        if used + width > target {
            break;
        }
        kept.push_str(grapheme);
        used += width;
    }
    format!("{kept}{ellipsis}")
}

/// Width of one grapheme cluster approximated by its first char plus zero-width
/// continuation chars. Good enough for the terminal layout we render.
#[must_use]
pub fn char_width(c: char) -> usize {
    match c {
        '\t' => 3,
        // Chars EastAsianWidth rates 1 but unicode-width rates 0; TS measures the EAW value,
        // and an exhaustive scan found exactly this set. The halfwidth katakana sound marks
        // count one column (the prompt-token mask pads placeholders with `FF9E`).
        '\u{1161}'..='\u{11ff}'
        | '\u{d7b0}'..='\u{d7c6}'
        | '\u{d7cb}'..='\u{d7fb}'
        | '\u{111c2}'..='\u{111c3}'
        | '\u{11a84}'..='\u{11a89}'
        | '\u{0d4e}'
        | '\u{a8fa}'
        | '\u{1193f}'
        | '\u{11941}'
        | '\u{11a3a}'
        | '\u{11d46}'
        | '\u{11f02}'
        | '\u{FF9E}'
        | '\u{FF9F}' => 1,
        c if c.is_control() => 0,
        c => c.width().unwrap_or(0),
    }
}

/// Length of a complete ANSI escape sequence at the start of `s`, if any: CSI, OSC/APC ending
/// at BEL or ST, DCS/PM/SOS ending at ST. A malformed sequence returns `None` and stays visible.
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

/// The visible width of a string (grapheme clusters, escape sequences at zero width, tabs
/// expanded to three spaces).
///
/// # Panics
///
/// Panics when the width-cache mutex is poisoned; the `expect` cannot fire.
#[must_use]
pub fn str_width(s: &str) -> usize {
    use unicode_segmentation::UnicodeSegmentation;
    if s.is_empty() {
        return 0;
    }
    // TS `isPrintableAscii` fast path: no grapheme segmentation needed.
    if s.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return s.len();
    }
    if let Some(width) = width_cache().lock().unwrap().get(s) {
        return *width;
    }
    // TS `visibleWidth` expands tabs to three spaces BEFORE measuring.
    let expanded;
    let measured = if s.contains('\t') {
        expanded = s.replace('\t', "   ");
        expanded.as_str()
    } else {
        s
    };
    let mut width = 0;
    let mut rest = measured;
    while !rest.is_empty() {
        if let Some(len) = escape_len(rest) {
            rest = &rest[len..];
        } else {
            let g = rest.graphemes(true).next().expect("non-empty rest");
            width += grapheme_width(g);
            rest = &rest[g.len()..];
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

/// A char that renders nothing on its own: controls and zero-width chars.
fn is_invisible(c: char) -> bool {
    c.is_control() || (c.width().unwrap_or(0) == 0 && !is_eaw_one_wide_zero(c))
}

/// TS `\p{Mark}` (Mn|Mc|Me). unicode-width only zeroes Mn/Me, so
/// spacing marks need the category lookup.
fn is_mark(c: char) -> bool {
    c.general_category_group() == GeneralCategoryGroup::Mark
}

/// True for a char that unicode-width reports zero but TS measures 1
/// (its `EastAsianWidth`).
fn is_eaw_one_wide_zero(c: char) -> bool {
    matches!(
        c,
        '\u{ff9e}' | '\u{ff9f}'
            | '\u{1161}'..='\u{11ff}'
            | '\u{d7b0}'..='\u{d7c6}'
            | '\u{d7cb}'..='\u{d7fb}'
            | '\u{111c2}'..='\u{111c3}'
            | '\u{11a84}'..='\u{11a89}'
            | '\u{0d4e}'
            | '\u{a8fa}'
            | '\u{1193f}'
            | '\u{11941}'
            | '\u{11a3a}'
            | '\u{11d46}'
            | '\u{11f02}'
    )
}

/// Char classes of the TS `zeroWidthRegex` alternation:
/// `\p{Control}|\p{Mark}|\p{Default_Ignorable_Code_Point}|\p{Surrogate}`
/// (surrogates cannot appear in a `str`).
fn is_zero_class_char(c: char) -> bool {
    // U+115F (Hangul choseong filler) is the one Default_Ignorable char
    // unicode-width rates nonzero; TS zeroes it.
    is_invisible(c) || is_mark(c) || c == '\u{115f}'
}

/// Char classes of the TS `leadingNonPrintingRegex` strip set:
/// `\p{DIC}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate}`. The Format
/// term contributes the prepended concatenation marks (U+0600, …).
fn is_leading_nonprinting(c: char) -> bool {
    is_zero_class_char(c) || c.general_category() == GeneralCategory::Format
}

/// Single-codepoint RGI emoji: TS `\p{RGI_Emoji}` matches a bare
/// codepoint exactly when `Emoji_Presentation=Yes`.
fn is_emoji_presentation(c: char) -> bool {
    matches!(
        c.emoji_status(),
        EmojiStatus::EmojiPresentation
            | EmojiStatus::EmojiPresentationAndModifierBase
            | EmojiStatus::EmojiPresentationAndEmojiComponent
            | EmojiStatus::EmojiPresentationAndModifierAndEmojiComponent
    )
}

pub(crate) fn grapheme_width(g: &str) -> usize {
    // A tab cluster measures 3 columns (TS replaces tabs before
    // segmenting).
    if g == "\t" {
        return 3;
    }
    let mut chars = g.chars();
    let Some(first) = chars.next() else {
        return 0;
    };
    if chars.all(is_zero_class_char) && is_zero_class_char(first) {
        return 0;
    }
    // Regional indicators render as flag emoji even when isolated (the
    // streamed halves of a flag pair drift alone during streaming).
    if ('\u{1f1e6}'..='\u{1f1ff}').contains(&first) {
        return 2;
    }
    if g.chars().count() > 1 && is_rgi_emoji_cluster(first, g) {
        return 2;
    }
    if is_emoji_presentation(first) {
        // Single-codepoint RGI emoji render two columns even though
        // EastAsianWidth is Neutral.
        return 2;
    }
    let base = g.trim_start_matches(is_leading_nonprinting);
    let Some(base_c) = base.chars().next() else {
        return 0;
    };
    let mut w = char_width(base_c);
    for c in g.chars().skip(1) {
        if ('\u{ff00}'..='\u{ffef}').contains(&c) {
            w += char_width(c);
        } else if c == '\u{0e33}' || c == '\u{0eb3}' {
            w += 1;
        }
    }
    w
}

/// Approximation of the TS `rgiEmojiRegex` decisive test: a cluster
/// renders 2 columns only when the whole sequence is an RGI emoji.
fn is_rgi_emoji_cluster(first: char, g: &str) -> bool {
    let skin_tone = |c: char| ('\u{1f3fb}'..='\u{1f3ff}').contains(&c);
    let keycap_base = |c: char| c.is_ascii_digit() || c == '#' || c == '*';
    if g.contains('\u{200d}') {
        // ZWJ family/couple: every ZWJ-joined part must start with an
        // emoji-ish base (skin tones and marks alone do not qualify).
        return g.split('\u{200d}').all(|part| {
            part.chars()
                .find(|c| !is_invisible(*c))
                .is_some_and(|base| base.is_emoji_char() || skin_tone(base))
        });
    }
    if g.contains('\u{fe0f}') {
        // VS16 presentation / keycap sequence: RGI contains base+VS16 exactly for Emoji=YES
        // bases; a stray VS16 on a non-emoji base falls through to the base width.
        return first.is_emoji_char() || keycap_base(first);
    }
    // Emoji + skin tone modifier (no VS16, no ZWJ).
    first.is_emoji_char() && g.chars().skip(1).all(|c| skin_tone(c) || is_invisible(c))
}
#[must_use]
pub fn spans_width(spans: &[Span]) -> usize {
    spans.iter().map(|s| str_width(&s.content)).sum()
}

#[must_use]
pub fn line_width(line: &[Span]) -> usize {
    spans_width(line)
}

#[must_use]
pub fn is_whitespace_char(c: char) -> bool {
    // TS `isWhitespaceChar` tests JS /\s/: same set as Unicode White_Space except the BOM
    // (U+FEFF) counts and NEL (U+0085) does not — the wrap logic depends on it.
    c == '\u{feff}' || (c != '\u{0085}' && c.is_whitespace())
}

const PUNCTUATION: &str = "(){}[]<>.,;:'\"!?+-=*/\\|&%^$#@~`";

#[must_use]
pub fn is_punctuation_char(c: char) -> bool {
    PUNCTUATION.contains(c)
}

/// Normalize text for terminal output without changing logical content: Thai/Lao AM vowels
/// decompose to compatibility forms (same width, no stale cells); tabs expand to three spaces.
#[must_use]
pub fn normalize_terminal_output(s: &str) -> String {
    let has_thai_lao_am = s.contains('\u{0e33}') || s.contains('\u{0eb3}');
    if !has_thai_lao_am && !s.contains('\t') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\u{0e33}' => out.push_str("\u{0e4d}\u{0e32}"),
            '\u{0eb3}' => out.push_str("\u{0ecd}\u{0eb2}"),
            '\t' => out.push_str("   "),
            c => out.push(c),
        }
    }
    out
}

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
#[must_use]
pub fn pad_line(mut line: Line, width: usize) -> Line {
    let w = line_width(&line);
    if w < width {
        line.push(Span::raw(" ".repeat(width - w)));
    }
    line
}

/// Truncate a line to `max_width` visible columns, appending `ellipsis` (also measured) when
/// content was cut.
///
/// # Panics
///
/// Cannot panic: the `expect` guards the loop condition (`rest` is non-empty when checked).
#[must_use]
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

/// Split a line into wrapped lines at word boundaries, mirroring TS `wrapSingleLine`: break
/// long tokens at char level, never start a line with whitespace.
#[must_use]
pub fn wrap_line(line: &Line, width: usize) -> Vec<Line> {
    wrapping::render(line, width)
}

/// Exact row count of [`wrap_line`] without constructing output lines or spans.
pub(crate) fn wrapped_line_count(line: &Line, width: usize) -> usize {
    wrapping::count_line(line, width)
}

/// Count wrapping over borrowed span contents, preserving run boundaries.
/// Newlines are not split, matching [`wrap_line`] rather than [`wrap_text`].
pub(crate) fn wrapped_runs_count<'a>(
    runs: impl IntoIterator<Item = &'a str>,
    width: usize,
) -> usize {
    wrapping::count_runs(runs, width)
}

/// Exact row count of [`wrap_text`] without constructing output lines or spans.
pub(crate) fn wrapped_text_count(text: &str, width: usize) -> usize {
    wrapping::count_text(text, width)
}

/// Wrap plain text (may contain \n) into lines of styled raw spans.
#[must_use]
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

/// Slice a line by visible columns `[start, start+length)` (the TS
/// `sliceByColumn` default): whole grapheme clusters in or out.
#[must_use]
pub fn slice_line_by_column(line: &Line, start: usize, length: usize) -> Line {
    slice_line_by_column_strict(line, start, length, false)
}

/// The `strict` form of TS `sliceByColumn`: clip a wide cluster crossing the slice boundary
/// instead of including it.
///
/// # Panics
///
/// Cannot panic: the `expect` guards the loop condition (`rest` is non-empty when checked).
#[must_use]
pub fn slice_line_by_column_strict(line: &Line, start: usize, length: usize, strict: bool) -> Line {
    use unicode_segmentation::UnicodeSegmentation;
    let mut out: Line = Vec::new();
    let mut col = 0usize;
    let end = start.saturating_add(length);
    'outer: for span in line {
        let mut rest = span.content.as_str();
        while !rest.is_empty() {
            if let Some(len) = escape_len(rest) {
                // Zero-width escape codes ride outside any slice.
                rest = &rest[len..];
                continue;
            }
            let g = rest.graphemes(true).next().expect("non-empty rest");
            let w = grapheme_width(g);
            let in_range = col >= start && col < end;
            let fits = !strict || col + w <= end;
            if in_range && fits {
                for c in g.chars() {
                    push_char(&mut out, span.style, c);
                }
            }
            col += w;
            rest = &rest[g.len()..];
            if col >= end {
                break 'outer;
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

/// Char width for overflow checks.
#[must_use]
pub fn base_char_w(c: char) -> usize {
    base_char_width(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halfwidth_sound_marks_count_one_column() {
        // The prompt-token mask pads its placeholders with FF9E per extra
        // column.
        assert_eq!(char_width('\u{FF9E}'), 1);
        assert_eq!(char_width('\u{FF9F}'), 1);
        assert_eq!(str_width("a\u{FF9E}b"), 3);
    }

    #[test]
    fn multi_code_point_clusters_measure_one_cell() {
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

    #[test]
    fn truncate_to_width_keeps_the_ellipsis_inside_the_budget() {
        assert_eq!(truncate_to_width("hello", 8, "…"), "hello");
        assert_eq!(truncate_to_width("", 8, "…"), "");
        assert_eq!(truncate_to_width("x", 0, "…"), "");
        // The kept prefix leaves room for the ellipsis: 16 + 43 + 1 = 60.
        let recap = format!("running tools \u{b7} {}", "a".repeat(100));
        assert_eq!(
            truncate_to_width(&recap, 60, "…"),
            format!("running tools \u{b7} {}…", "a".repeat(43))
        );
        // Wide glyphs count their terminal columns: 29 rockets (58) + "…".
        assert_eq!(
            truncate_to_width(&"\u{1f680}".repeat(40), 60, "…"),
            format!("{}…", "\u{1f680}".repeat(29))
        );
        // A budget too small for the ellipsis clips the ellipsis.
        assert_eq!(truncate_to_width("abcdef", 1, "…"), "\u{2026}");
        assert_eq!(truncate_to_width("abcdef", 2, "..."), "..");
        assert_eq!(truncate_to_width("abcdef", 4, ""), "abcd");
    }
}

/// Golden widths captured from the TS `visibleWidth` over the lane's
/// Unicode corpus.
#[test]
// deliberate decomposed/non-NFC fixtures: the width engine must measure the raw sequences
#[allow(clippy::unicode_not_nfc)]
fn str_width_matches_ts_golden_corpus() {
    let cases: Vec<(&str, usize)> = vec![
        ("你好世界，这是一段很长的中文文本", 32),
        ("日本語 テキスト は 長い 長い 長い", 33),
        ("hello 안녕하세요 world 안녕", 27),
        ("👨‍👩‍👧‍👦 family 🇯🇵 flag #️⃣ keycap 👍🏽 skin", 35),
        ("café café café combining tail", 29),
        ("Thai: ทดสอบการทำงานำ and Lao: ທົດສອບຳ", 36),
        ("zero\u{200b}-width \u{feff} zwj\u{200d}seq tail", 23),
        ("─━┏━┓ wide box chars ┗━┛", 24),
        ("🇺 isolated regional", 20),
        ("ｶｷｸ halfwidth カﾞキﾟ marks", 26),
        ("ａｂｃ fullwidth ＡＢＣ latin", 29),
        ("ambiguous: ± √ α β ∂ Ω ○ ◇", 26),
        ("trailing marks: á̂ b́", 19),
        ("mixed 你áb😊你áb😊", 18),
        ("ＴＡＢ\u{9}text", 13),
        ("你好 abc", 8),
        ("🄰 enclosed", 10),
        ("㍿ ligature", 11),
        ("각 jamo sequence", 16),
        ("🇯🇵🇺🇸 flags adjacency", 20),
        ("é::́ split cluster", 17),
        (" leading space", 14),
    ];
    for (text, expected) in cases {
        assert_eq!(str_width(text), expected, "width mismatch for {text:?}");
    }
}

/// `normalize_terminal_output` goldens (captured from the TS binary).
#[test]
fn normalize_terminal_output_matches_ts_goldens() {
    let cases: Vec<(&str, &str)> = vec![
        (
            "Thai: ทดสอบการทำงานำ and Lao: ທົດສອບຳ",
            "Thai: ทดสอบการทํางานํา and Lao: ທົດສອບໍາ",
        ),
        ("ＴＡＢ\u{9}text", "ＴＡＢ   text"),
    ];
    for (input, expected) in cases {
        assert_eq!(
            normalize_terminal_output(input),
            expected,
            "normalize mismatch for {input:?}"
        );
    }
    assert_eq!(normalize_terminal_output("plain ascii"), "plain ascii");
}

/// `slice_line_by_column` goldens (TS `sliceByColumn` semantics): whole
/// clusters in or out; the strict form clips.
#[test]
fn slice_line_by_column_is_grapheme_level() {
    let line: Line = vec![Span::raw("a你b👨‍👩‍👧‍👦c".to_string())];
    // Columns: a(1) 你(2) b(1) family(2) c(1).
    // Non-strict: a slice ending inside the family keeps it whole.
    let slice = slice_line_by_column(&line, 0, 5);
    let text: String = slice.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        text,
        "a你b\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}"
    );
    // Strict: the family crossing the boundary is clipped out.
    let slice = slice_line_by_column_strict(&line, 0, 5, true);
    let text: String = slice.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(text, "a你b");
    // A slice starting inside the family excludes it (start col in
    // range is the cluster's own column).
    let slice = slice_line_by_column(&line, 5, 5);
    let text: String = slice.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(text, "c");
    // Combining-mark clusters never split mid-cluster.
    let marked: Line = vec![Span::raw("e\u{301}f".to_string())];
    let slice = slice_line_by_column(&marked, 0, 1);
    let text: String = slice.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(text, "e\u{301}");
}
#[cfg(test)]
mod uni4_probe_tests {
    use super::*;

    #[test]
    fn ts_reference_widths() {
        // Values captured from the TS binary's visibleWidth (dist/utils.js).
        assert_eq!(str_width("\u{93E}"), 0); // Mc mark: TS \p{Mark} zero cluster
        assert_eq!(str_width("\u{93E}\u{200D}"), 0);
        assert_eq!(str_width("\u{0600}1"), 1); // prepend mark merges forward
        assert_eq!(str_width("\u{0600}"), 0); // trailing prepend mark: base eaten
        assert_eq!(str_width("#\u{FE0F}\u{20E3}"), 2);
        assert_eq!(str_width(":\u{FE0F}"), 1); // VS16 on a non-emoji base
        assert_eq!(str_width("\u{2B50}"), 2); // single-codepoint RGI (EAW N)
        assert_eq!(str_width("\u{2122}\u{FE0F}"), 2); // TM + VS16 is RGI
        assert_eq!(str_width("\u{2122}"), 1);
        assert_eq!(str_width("\u{2610}\u{FE0F}"), 1); // ballot box: not emoji
        assert_eq!(str_width("\u{1F004}"), 2);
        assert_eq!(str_width("\u{231A}"), 2);
        assert_eq!(str_width("\u{00A1}"), 1); // ambiguous
        assert_eq!(str_width("\u{20000}"), 2);
        assert_eq!(str_width("ก\u{0E48}"), 1); // Thai mai ek cluster
        assert_eq!(str_width("กำ"), 2); // SARA AM is a trailing spacing mark
        assert_eq!(str_width("ກ\u{0EB3}"), 2);
        assert_eq!(str_width("a\tb"), 5); // tab measures like TS's 3-space swap
        assert_eq!(str_width("\u{FEFF}"), 0);
        assert_eq!(str_width("a\u{200d}b"), 2);
        // The Hangul choseong filler is Default_Ignorable (TS zeroes
        // it); conjoining jamo measure 1 (EAW).
        assert_eq!(str_width("\u{115f}"), 0);
        assert_eq!(str_width("\u{115f}\u{1161}"), 1);
        assert_eq!(str_width("\u{1161}"), 1);
        assert_eq!(str_width("\u{d7b0}"), 1);
        assert_eq!(str_width("\u{1100}\u{1161}\u{11a8}"), 2); // one LVT cluster, base W
    }
}

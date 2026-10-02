//! Markdown rendering ported from `packages/tui/src/components/markdown.ts`
//! (the block/inline subset that appears in agent sessions: headings,
//! paragraphs, fenced code, lists, blockquotes, hr, and inline emphasis,
//! code, and links). Emits styled `Line`s for ratatui instead of ANSI strings.

mod geometry;
pub(crate) use geometry::{markdown_row_count, markdown_row_count_tagged};
mod inline;
#[cfg(test)]
mod tests;

pub use inline::render_inline;

use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::{Modifier, Style};
use ratatui::text as rt;

/// Styling hooks resolved from a theme (plus the settings-driven
/// `code_block_indent`; not `Copy` because of the indent `String`).
#[derive(Debug, Clone)]
pub struct MarkdownStyle {
    pub body: Style,
    pub heading: Style,
    pub link: Style,
    pub link_url: Style,
    pub code: Style,
    pub code_block: Style,
    pub code_block_border: Style,
    pub quote: Style,
    pub quote_border: Style,
    pub hr: Style,
    pub list_bullet: Style,
    pub bold: Modifier,
    pub italic: Modifier,
    pub strikethrough: Modifier,
    /// The fenced-code indent string (`markdown.codeBlockIndent` in
    /// settings, TS `codeBlockIndent` on the markdown theme; default "  ").
    pub code_block_indent: String,
    /// The `syntax*` palette for fenced-code token colors (TS
    /// `highlightCode`, cli-highlight over the highlight.js grammar).
    /// `None` renders every code line uniform in `code_block` — the TS
    /// no-valid-language fallback, and the quiet thinking theme (TS
    /// `getThinkingMarkdownTheme` replaces `highlightCode` with dim
    /// uniform lines).
    pub(crate) syntax: Option<crate::tool_card::highlight::SyntaxPalette>,
}

impl Default for MarkdownStyle {
    fn default() -> Self {
        Self::from_theme(&crate::theme::Theme::builtin(
            "prime",
            crate::theme::ColorMode::TrueColor,
        ))
    }
}

impl MarkdownStyle {
    #[must_use]
    pub fn from_theme(theme: &crate::theme::Theme) -> Self {
        use crate::theme::ThemeColor as C;
        Self {
            body: theme.fg_style(C::MdBody),
            heading: theme.fg_style(C::MdHeading),
            link: theme.fg_style(C::MdLink),
            link_url: theme.fg_style(C::MdLinkUrl),
            code: theme.fg_style(C::MdCode),
            code_block: theme.fg_style(C::MdCodeBlock),
            code_block_border: theme.fg_style(C::MdCodeBlockBorder),
            quote: theme.fg_style(C::MdQuote),
            quote_border: theme.fg_style(C::MdQuoteBorder),
            hr: theme.fg_style(C::MdHr),
            list_bullet: theme.fg_style(C::MdListBullet),
            // The TS source styles `**bold**`/`*ital*`/`~~strike~~` (and the
            // heading taper) through chalk; in the deployed TS binary the
            // chalk modifiers never reach the wire — only its raw-ANSI
            // colors render (probe vs the installed 0.9.5 binary: headings
            // `#`-`######` render in mdHeading alone, inline strong/em/strike
            // render plain, inline code stays colored). The same evidence
            // shape as the link label's dropped underline (see
            // `legacy_link_row_is_underlined_and_shows_the_url`): the
            // markers survive parsing (run boundaries stay intact) but carry
            // no modifier.
            bold: Modifier::empty(),
            italic: Modifier::empty(),
            strikethrough: Modifier::empty(),
            code_block_indent: "  ".to_string(),
            syntax: Some(crate::tool_card::highlight::SyntaxPalette::from_theme(
                theme,
            )),
        }
    }
}

/// Rendered markdown document as styled lines.
#[must_use]
pub fn render_markdown(text: &str, width: usize, style: &MarkdownStyle) -> Vec<Line> {
    render_markdown_tagged(text, width, style, "", &mut MarkdownBlockCache::default())
}

/// Cached render with a style discriminator (see [`MarkdownBlockCache`]):
/// the same raw text rendered under different styles (the dim thinking
/// block) must not hit the other style's rows.
pub fn render_markdown_tagged(
    text: &str,
    width: usize,
    style: &MarkdownStyle,
    style_tag: &str,
    cache: &mut MarkdownBlockCache,
) -> Vec<Line> {
    let content_width = width.max(1);
    if text.trim().is_empty() {
        return Vec::new();
    }
    let normalized = text.replace('\t', "   ");
    let mut lines: Vec<Line> = Vec::new();
    let blocks = parse_blocks(&normalized);
    for (i, block) in blocks.iter().enumerate() {
        let next = blocks.get(i + 1);
        // A blank source line separates blocks: TS's lexer emits one `space`
        // token per blank run and `renderToken` pushes one empty row for it
        // (markdown.ts `case "space"`). `parse_blocks` skips the blank
        // source lines, so the row is emitted here, ahead of the block it
        // precedes; adjacent blocks keep their `blank_after` row.
        if block.sep_blank {
            lines.push(Vec::new());
        }
        let key = block_cache_key(style_tag, &blocks, i, content_width);
        if let Some(cached) = key.as_ref().and_then(|key| cache.0.get(key)) {
            lines.extend_from_slice(cached);
            continue;
        }
        match key {
            Some(key) => {
                let mut rendered = Vec::new();
                render_block(block, next, content_width, style, &mut rendered);
                lines.extend_from_slice(&rendered);
                rendered.shrink_to_fit();
                cache.0.insert(key, rendered);
            }
            // The final block renders straight into the caller's buffer:
            // every `render_block` path only appends to `out`.
            None => render_block(block, next, content_width, style, &mut lines),
        }
    }
    lines
}

/// Per-block render cache (TS `Markdown.blockCache`, markdown.ts): a
/// streaming append re-renders only the changing final block — every
/// earlier block replays its rendered rows by [`BlockKey`] instead of
/// re-running inline styling, wrapping, and code highlighting. Entries
/// are never pruned within a message: the cache is shared by the entry's
/// text and thinking renders, so TS's per-render `nextCache` swap would
/// evict the other block's entries every frame. Size stays bounded
/// without it — entries are keyed by settled (non-final) blocks (raw
/// text that no later append can change), the whole map drops when the
/// message settles (`view.rs`) or the layout width or render options
/// change (`prepare_layout`), and the final block is never cached:
/// while streaming, appended text can reinterpret an open block
/// (unterminated fences, growing lists).
#[derive(Default)]
pub struct MarkdownBlockCache(std::collections::HashMap<BlockKey, Vec<Line>>);

/// The cache key: every `render_block` input a streamed append can
/// change — the style discriminator (the dim thinking block), the width,
/// the parsed block itself, and the following block's trailing-blank
/// effect. Keying on the parsed `BlockKind` covers each of the block's
/// own render inputs structurally (list `ordered`/`start`, the code
/// lang), so a field added later is covered automatically.
#[derive(PartialEq, Eq, Hash)]
struct BlockKey {
    style_tag: String,
    width: usize,
    kind: BlockKind,
    lines: Vec<String>,
    /// `render_block`'s only reads of the next block:
    /// `[blank_after(next, false), blank_after(next, true)]`.
    blank_after: [bool; 2],
}

/// The one cacheability rule shared by render and count (TS `useCache =
/// cacheable && i < tokens.length - 1`): every block but the last is
/// cacheable; the final one returns `None` because appended text can
/// still reinterpret it.
fn block_cache_key(
    style_tag: &str,
    blocks: &[Block],
    index: usize,
    width: usize,
) -> Option<BlockKey> {
    if index + 1 == blocks.len() {
        return None;
    }
    let next = blocks.get(index + 1);
    let block = &blocks[index];
    Some(BlockKey {
        style_tag: style_tag.to_string(),
        width,
        kind: block.kind.clone(),
        lines: block.lines.clone(),
        blank_after: [
            geometry::blank_after(next, false),
            geometry::blank_after(next, true),
        ],
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum BlockKind {
    Heading,
    Paragraph,
    Code {
        lang: Option<String>,
    },
    List {
        ordered: bool,
        start: usize,
    },
    Quote,
    Hr,
    Table {
        header: Vec<String>,
        rows: Vec<Vec<String>>,
    },
}

#[derive(Debug, Clone)]
struct Block {
    kind: BlockKind,
    /// True when a blank line precedes this block (TS emits a `space` token).
    sep_blank: bool,
    /// Raw lines of the block (for code: literal lines; for others: unwrapped content).
    lines: Vec<String>,
}

fn parse_blocks(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let src_lines: Vec<&str> = text.lines().collect();
    let mut i = 0usize;
    while i < src_lines.len() {
        let line = src_lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        let sep_blank = i > 0
            && src_lines[..i]
                .iter()
                .rev()
                .take_while(|l| l.trim().is_empty())
                .count()
                > 0;
        // Fenced code
        if let Some(fence) = trimmed.strip_prefix("```") {
            let lang = if fence.is_empty() {
                None
            } else {
                Some(fence.trim().to_string())
            };
            let mut code = Vec::new();
            i += 1;
            while i < src_lines.len() && !src_lines[i].trim().starts_with("```") {
                code.push(src_lines[i].to_string());
                i += 1;
            }
            i += 1; // skip closing fence
            blocks.push(Block {
                kind: BlockKind::Code { lang },
                sep_blank,
                lines: code,
            });
            continue;
        }
        // Heading
        let hashes = trimmed.chars().take_while(|&c| c == '#').count();
        if hashes > 0 && trimmed.len() > hashes && trimmed.as_bytes()[hashes] == b' ' {
            blocks.push(Block {
                kind: BlockKind::Heading,
                sep_blank,
                lines: vec![trimmed[hashes + 1..].to_string()],
            });
            i += 1;
            continue;
        }
        // hr
        if is_hr(trimmed) {
            blocks.push(Block {
                kind: BlockKind::Hr,
                sep_blank,
                lines: Vec::new(),
            });
            i += 1;
            continue;
        }
        // Quote
        if let Some(q) = trimmed.strip_prefix('>') {
            let mut qlines = vec![q.trim_start().to_string()];
            i += 1;
            while i < src_lines.len()
                && !src_lines[i].trim().is_empty()
                && src_lines[i].trim().starts_with('>')
            {
                qlines.push(
                    src_lines[i]
                        .trim()
                        .trim_start_matches('>')
                        .trim_start()
                        .to_string(),
                );
                i += 1;
            }
            blocks.push(Block {
                kind: BlockKind::Quote,
                sep_blank,
                lines: qlines,
            });
            continue;
        }
        // List
        if let Some(marker) = list_marker(trimmed) {
            let (ordered, start) = marker;
            let mut items: Vec<String> = Vec::new();
            let mut item = trimmed[marker_width(trimmed)..].to_string();
            i += 1;
            while i < src_lines.len() {
                let l = src_lines[i];
                let t = l.trim();
                if t.is_empty() {
                    break;
                }
                if list_marker(t).is_some() {
                    items.push(std::mem::take(&mut item));
                    item = t[marker_width(t)..].to_string();
                    i += 1;
                } else if l.starts_with("  ") || l.starts_with('\t') {
                    item.push(' ');
                    item.push_str(t);
                    i += 1;
                } else {
                    break;
                }
            }
            items.push(item);
            blocks.push(Block {
                kind: BlockKind::List { ordered, start },
                sep_blank,
                lines: items,
            });
            continue;
        }
        // Table (marked's table rule: header row + delimiter row +
        // body rows; tried after the other block starts).
        if crate::markdown_table::is_table_start(trimmed, src_lines.get(i + 1)) {
            let table = crate::markdown_table::parse_table_block(&src_lines, &mut i);
            blocks.push(Block {
                kind: BlockKind::Table {
                    header: table.header,
                    rows: table.rows,
                },
                sep_blank,
                lines: table.raw,
            });
            continue;
        }
        // Paragraph: consume until blank line or new block marker. TS's
        // marked lexes the whole run as ONE paragraph token but its inline
        // renderer preserves each soft newline (`applyTextWithNewlines`
        // joins with `\n`, and the width pass breaks there), so the source
        // lines are kept — each renders as its own row, still one block
        // (no `space` rows between them).
        let mut para_lines = vec![trimmed.to_string()];
        // The block's last source line keeps its trailing whitespace (the
        // TS lexer's paragraph token carries it; the rendered row ends
        // `stream. ` with the space inside the styled span — probe vs the
        // TS binary, the expanded compaction summary).
        let mut last_raw = line;
        i += 1;
        while i < src_lines.len() {
            let l = src_lines[i];
            let t = l.trim();
            if t.is_empty()
                || t.starts_with("```")
                || t.starts_with('>')
                || t.starts_with('#')
                || list_marker(t).is_some()
                || is_hr(t)
                || crate::markdown_table::is_table_start(t, src_lines.get(i + 1))
            {
                break;
            }
            para_lines.push(t.to_string());
            last_raw = l;
            i += 1;
        }
        // The trailing whitespace rides on the block's LAST source line.
        let last = para_lines.last_mut().expect("paragraph has a line");
        last.push_str(&last_raw[last_raw.trim_end().len()..]);
        blocks.push(Block {
            kind: BlockKind::Paragraph,
            sep_blank,
            lines: para_lines,
        });
    }
    blocks
}

pub(crate) fn is_hr(t: &str) -> bool {
    let chars: Vec<char> = t.chars().filter(|&c| c != ' ').collect();
    (chars.len() >= 3)
        && chars.iter().all(|&c| c == '-' || c == '*' || c == '_')
        && (chars[0] == '-' || chars[0] == '*' || chars[0] == '_')
}

pub(crate) fn list_marker(t: &str) -> Option<(bool, usize)> {
    if let Some(rest) = t.strip_prefix("- ") {
        let _ = rest;
        return Some((false, 0));
    }
    if let Some(rest) = t.strip_prefix("* ") {
        let _ = rest;
        return Some((false, 0));
    }
    let digits: String = t.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        let after = &t[digits.len()..];
        if let Some(rest) = after.strip_prefix(". ") {
            let _ = rest;
            let n: usize = digits.parse().ok()?;
            return Some((true, n));
        }
    }
    None
}

fn marker_width(t: &str) -> usize {
    if t.starts_with("- ") || t.starts_with("* ") {
        2
    } else {
        t.find(". ").map_or(t.len(), |p| p + 2)
    }
}

/// The fence languages the port highlights. TS `highlightCode` validates
/// through cli-highlight's `supportsLanguage` = highlight.js
/// `getLanguage(name)`, which lowercases and matches the grammar's
/// registered names and aliases: python 10.7.3 registers `python` with
/// aliases `py`, `gyp`, `ipython`. `lang` here is marked's whole trimmed
/// info string, so ```` ```python foo=1 ```` stays uniform (hljs has no such
/// language); only these exact spellings highlight.
fn is_highlighted_lang(lang: &str) -> bool {
    matches!(
        lang.to_ascii_lowercase().as_str(),
        "python" | "py" | "gyp" | "ipython"
    )
}

/// The block's highlighted lines (TS `theme.highlightCode(text, lang)`:
/// one highlight.js pass over the whole block, so multi-line strings
/// carry across lines; the fallback paths — no palette (the quiet
/// thinking theme), an unsupported language, or no language — render
/// `None` so the caller keeps the uniform `mdCodeBlock` rows).
fn highlighted_code_lines(
    block: &Block,
    lang: Option<&str>,
    style: &MarkdownStyle,
) -> Option<Vec<Line>> {
    let palette = style.syntax.as_ref()?;
    if !lang.is_some_and(is_highlighted_lang) {
        return None;
    }
    if block.lines.is_empty() {
        // An empty block renders through the uniform empty-row path.
        return None;
    }
    Some(crate::tool_card::highlight::highlight_python(
        &block.lines.join("\n"),
        palette,
    ))
}

/// The block's unwrapped rows (TS `renderCodeBlock`): the indent outside
/// each highlighted or uniform code line; an empty block is one indented
/// empty row. Paint wraps these rows and the count measures the same rows.
fn code_rows(block: &Block, lang: Option<&str>, style: &MarkdownStyle) -> Vec<Line> {
    let indent = style.code_block_indent.as_str();
    let lines = highlighted_code_lines(block, lang, style).unwrap_or_else(|| {
        block
            .lines
            .iter()
            .map(|line| vec![Span::styled(line.clone(), style.code_block)])
            .collect()
    });
    if lines.is_empty() {
        return vec![vec![Span::raw(indent)]];
    }
    lines
        .into_iter()
        .map(|line| {
            let mut row: Line = vec![Span::raw(indent)];
            row.extend(line);
            row
        })
        .collect()
}

/// Heading spans: inline-rendered, tapered to the heading color with
/// the link affordance kept — an underlined label stays underlined and
/// the URL bracket keeps its dim `link_url` slot, tracked by origin
/// (the inline pass reports the bracket indices). A code or body span
/// that merely renders in the `link_url` style (a theme whose colors
/// collide) tapers to the heading color like any other span. Shared by
/// the paint path and the row count, so a wrapped heading counts
/// exactly what it paints.
fn heading_spans(text: &str, style: &MarkdownStyle) -> Vec<Span> {
    let (mut spans, url_slots) = inline::render_inline_with_url_slots(text, style);
    // The slot indices arrive ascending, so one cursor walks them in
    // step with the span iteration — a link-heavy heading stays linear.
    let mut url_slot = 0;
    for (i, s) in spans.iter_mut().enumerate() {
        if url_slots.get(url_slot) == Some(&i) {
            url_slot += 1;
            continue;
        }
        let underlined = s.style.add_modifier.contains(Modifier::UNDERLINED);
        s.style = style.heading;
        if underlined {
            s.style = s.style.add_modifier(Modifier::UNDERLINED);
        }
    }
    spans
}

fn render_block(
    block: &Block,
    next: Option<&Block>,
    width: usize,
    style: &MarkdownStyle,
    out: &mut Vec<Line>,
) {
    let blank_after = |exclude_lists| geometry::blank_after(next, exclude_lists);
    match &block.kind {
        BlockKind::Heading => {
            // The TS source tapers headings by level (h1 bold+underline,
            // h2/h3 bold, h4 bold+italic, h5/h6 italic), all through
            // chalk; in the deployed TS binary the chalk modifiers never
            // reach the wire, so every level renders in the heading color
            // alone (probe vs the installed 0.9.5 binary: `# H1`, `## H2`,
            // and `### H3` all render bare mdHeading).
            let text = block.lines.first().cloned().unwrap_or_default();
            let spans = heading_spans(&text, style);
            wrap_spans(&spans, width, style.heading, out);
            if blank_after(false) {
                out.push(Vec::new());
            }
        }
        BlockKind::Paragraph => {
            // Each soft-break line renders and wraps on its own (TS's
            // paragraph token carries the newlines through the width pass).
            for text in &block.lines {
                let spans = render_inline(text, style);
                wrap_spans(&spans, width, style.body, out);
            }
            if blank_after(true) {
                out.push(Vec::new());
            }
        }
        BlockKind::Code { lang } => {
            // TS `renderCodeBlock`: no borders in the chat markdown - the
            // block is `codeBlockIndent` (settings-driven, default "  ")
            // outside the styled code line, each source line rendered with
            // the codeBlock style. The theme's `codeBlockBorder` hook exists
            // in the TS MarkdownTheme too and is unused by the renderer on
            // both sides. TS `renderBlock` then wraps every code row
            // (wrapTextWithAnsi), so a continuation row starts at column 0
            // with no re-added indent.
            for row in code_rows(block, lang.as_deref(), style) {
                wrap_spans(&row, width, style.code_block, out);
            }
            if blank_after(false) {
                out.push(Vec::new());
            }
        }
        BlockKind::List { ordered, start } => {
            for (i, item) in block.lines.iter().enumerate() {
                let bullet = if *ordered {
                    format!("{}. ", start + i)
                } else {
                    "- ".to_string()
                };
                let spans = render_inline(item, style);
                wrap_list_item(&bullet, &spans, width, style, out);
            }
            if blank_after(true) {
                out.push(Vec::new());
            }
        }
        BlockKind::Quote => {
            for line in &block.lines {
                let spans = render_inline(line, style);
                let mut quote_spans: Vec<Span> = Vec::new();
                for mut s in spans {
                    s.style = style.quote.patch(s.style);
                    quote_spans.push(s);
                }
                wrap_quote(&quote_spans, width, style, out);
            }
        }
        BlockKind::Hr => {
            let bar: String = "─".repeat(width.max(1));
            out.push(vec![Span::styled(bar, style.hr)]);
        }
        BlockKind::Table { header, rows } => {
            crate::markdown_table::render_table(header, rows, &block.lines, width, style, out);
            if blank_after(false) {
                out.push(Vec::new());
            }
        }
    }
}

/// Wrap styled spans to `width`. Words break at whitespace; leading spaces are
/// dropped after a wrap break. Adjacent same-style output pieces merge.
pub fn wrap_spans(spans: &[Span], width: usize, base: Style, out: &mut Vec<Line>) {
    let _ = base;
    wrap_spans_into(spans, width, &mut geometry::WrapOutput::render(out));
}

pub(crate) fn wrapped_span_count(spans: &[Span], width: usize) -> usize {
    let mut output = geometry::WrapOutput::count();
    wrap_spans_into(spans, width, &mut output);
    output.rows
}

fn wrap_spans_into(spans: &[Span], width: usize, out: &mut geometry::WrapOutput<'_>) {
    if width == 0 {
        for span in spans {
            out.push(&span.content, span.style);
        }
        out.finish_row(/*trim*/ false);
        return;
    }
    // TS `wrapSingleLine` returns a fitting line UNCHANGED (`visibleLength
    // <= width`), so its spacing never re-tokenizes.
    let joined_width: usize = spans.iter().map(|s| str_width(&s.content)).sum();
    if joined_width <= width {
        for span in spans {
            out.push(&span.content, span.style);
        }
        out.finish_row(/*trim*/ false);
        return;
    }
    // tokens: (text, style); alternating words and whitespace-run gaps. TS
    // `splitIntoTokensWithAnsi` keeps each whitespace RUN whole (a run at a
    // span boundary joins the previous gap token), never collapsing it to a
    // single space.
    let mut tokens: Vec<(String, Style)> = Vec::new();
    for span in spans {
        let mut word = String::new();
        for ch in span.content.chars() {
            if ch == ' ' {
                if !word.is_empty() {
                    tokens.push((std::mem::take(&mut word), span.style));
                }
                match tokens.last_mut() {
                    Some((text, _)) if text.chars().all(|c| c == ' ') => text.push(' '),
                    _ => tokens.push((" ".to_string(), span.style)),
                }
            } else {
                word.push(ch);
            }
        }
        if !word.is_empty() {
            tokens.push((word, span.style));
        }
    }

    let mut col = 0usize;
    let mut i = 0usize;
    while i < tokens.len() {
        let (text, style) = &tokens[i];
        let w = str_width(text);
        if col + w > width && out.has_content {
            // A wrapped row never carries its trailing gap: TS
            // wrapTextWithAnsi drops the boundary space, so the styled
            // content ends at the last word and the plain padding follows.
            out.finish_row(/*trim*/ true);
            col = 0;
            // drop leading whitespace at the new line start
            if text.trim().is_empty() {
                i += 1;
                continue;
            }
        }
        // break overlong words; escape sequences copy through atomically
        // at zero width (OSC 8 sequences must never split mid-sequence)
        let style = *style;
        let mut rest: &str = text.as_str();
        // The break loop used to re-measure `str_width(&rest)` and clone the
        // remaining tail on EVERY emitted row, so one unbroken token longer
        // than the wrap width (a padded fixture row, a base64 blob, a long
        // path) wrapped in O(token_len * rows) time — the first transcript
        // frame of a resumed session paid seconds per megabyte of such
        // tokens. The remaining width is tracked arithmetically instead:
        // measured once (the caller's `w`), decremented by each row's
        // emitted width, with `rest` sliced in place (no tail clones). For
        // content whose per-char widths sum to its grapheme width — every
        // printable-ASCII/escape/tab token, the catastrophic class — the
        // arithmetic is exact; a row split inside a multi-char grapheme
        // cluster is the one non-additive case, so a tentative exit is
        // confirmed against one true measure before the leftover is
        // pushed (the correctness backstop, never the hot path: an exact
        // run leaves at most `width` columns to re-measure).
        let mut rest_width = w;
        loop {
            if rest_width + col <= width {
                if str_width(rest) + col <= width {
                    break;
                }
                // A non-additive cluster split drifted the arithmetic:
                // re-sync from the true measure and keep breaking.
                rest_width = str_width(rest);
            }
            let mut take = String::new();
            let mut tw = 0usize;
            let mut taken = 0usize;
            while taken < rest.len() {
                if let Some(len) = crate::width::escape_len(&rest[taken..]) {
                    take.push_str(&rest[taken..taken + len]);
                    taken += len;
                    continue;
                }
                let c = rest[taken..].chars().next().expect("char at boundary");
                let cw = crate::width::char_width(c);
                if tw + cw + col > width {
                    break;
                }
                take.push(c);
                tw += cw;
                taken += c.len_utf8();
            }
            if take.is_empty() {
                break;
            }
            out.push(&take, style);
            out.finish_row(/*trim*/ false);
            col = 0;
            rest = &rest[taken..];
            rest_width -= tw;
        }
        col += str_width(rest);
        out.push(rest, style);
        i += 1;
    }
    out.finish_row(/*trim*/ false);
}

fn wrap_list_item(
    bullet: &str,
    spans: &[Span],
    width: usize,
    style: &MarkdownStyle,
    out: &mut Vec<Line>,
) {
    let bullet_width = str_width(bullet);
    let content_width = width.saturating_sub(bullet_width).max(1);
    let mut wrapped: Vec<Line> = Vec::new();
    wrap_spans(spans, content_width, style.body, &mut wrapped);
    for (i, line) in wrapped.into_iter().enumerate() {
        if i == 0 {
            let mut l = vec![Span::styled(bullet.to_string(), style.list_bullet)];
            l.extend(line);
            out.push(l);
        } else {
            let mut l = vec![Span::styled(" ".repeat(bullet_width), style.body)];
            l.extend(line);
            out.push(l);
        }
    }
}

fn wrap_quote(spans: &[Span], width: usize, style: &MarkdownStyle, out: &mut Vec<Line>) {
    let quote_width = width.saturating_sub(2).max(1);
    let mut wrapped: Vec<Line> = Vec::new();
    wrap_spans(spans, quote_width, style.quote, &mut wrapped);
    for line in wrapped {
        let mut l = vec![Span::styled("▐ ", style.quote_border)];
        l.extend(line);
        out.push(l);
    }
}

/// Convert our Line type to ratatui text for rendering. OSC zone markers and
/// OSC 8 hyperlink sequences are stripped: ratatui has no escape-sequence
/// support and would count their bytes as visible cells (the paint path
/// re-emits them: zone markers per row, links via `HyperlinkWriter`).
#[must_use]
pub fn to_ratatui_line(line: &Line) -> rt::Line<'static> {
    let mut stripped = line.clone();
    crate::osc133::strip(&mut stripped);
    crate::hyperlinks::strip_osc8(&mut stripped);
    // TS `applyLineResets` normalizes every painted line right before the
    // differential paint (Thai/Lao AM decomposition, tabs to three spaces).
    let spans: Vec<rt::Span<'static>> = stripped
        .iter()
        .map(|s| rt::Span::styled(crate::width::normalize_terminal_output(&s.content), s.style))
        .collect();
    rt::Line::from(spans)
}

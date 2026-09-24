//! Markdown rendering ported from `packages/tui/src/components/markdown.ts`
//! (the block/inline subset that appears in agent sessions: headings,
//! paragraphs, fenced code, lists, blockquotes, hr, and inline emphasis,
//! code, and links). Emits styled `Line`s for ratatui instead of ANSI strings.

mod geometry;
pub(crate) use geometry::markdown_row_count;

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
    // The next render's cache: starts from the current map (a hit keeps
    // its entry alive) and drops everything this document did not use.
    let mut next_cache = std::mem::take(&mut cache.0);
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
        let is_final = i == blocks.len() - 1;
        let key = is_final.then(|| block_cache_key(style_tag, block, next, content_width));
        let mut block_lines: Option<Vec<Line>> = None;
        if let Some(key) = &key {
            if let Some(cached) = next_cache.get(key) {
                lines.extend(cached.iter().cloned());
                block_lines = Some(cached.clone());
            }
        }
        if block_lines.is_none() {
            let mut rendered = Vec::new();
            render_block(block, next, content_width, style, &mut rendered);
            lines.extend(rendered.iter().cloned());
            if let Some(key) = &key {
                rendered.shrink_to_fit();
                next_cache.insert(key.clone(), rendered);
            }
        }
    }
    cache.0 = next_cache;
    lines
}

/// Per-block render cache (TS `Markdown.blockCache`, markdown.ts): a
/// streaming append re-renders only the changing final block — every
/// earlier block replays its rendered rows by `(width, kind, next kind,
/// raw)` key instead of re-running inline styling and wrapping. The map
/// is rebuilt on every render (TS swaps `nextCache` in), so it stays
/// bounded to the current document's blocks, and the final block is
/// never cached: while streaming, appended text can reinterpret an open
/// block (unterminated fences, growing lists); once a block is no longer
/// last, its raw text is final.
#[derive(Default)]
pub struct MarkdownBlockCache(std::collections::HashMap<String, Vec<Line>>);

/// The cache key (TS: `${width}|${token.type}|${nextTokenType}|${token.raw}`):
/// the style discriminator (the dim thinking block), width, this block's
/// kind, the following kind (a block's trailing blank row depends on it),
/// and the raw block lines.
fn block_cache_key(style_tag: &str, block: &Block, next: Option<&Block>, width: usize) -> String {
    let mut key = String::with_capacity(64);
    key.push_str(style_tag);
    key.push('|');
    key.push_str(&width.to_string());
    key.push('|');
    key.push_str(block_kind_name(&block.kind));
    if let BlockKind::Code { lang } = &block.kind {
        // TS's key carries `token.raw`, which includes the fence info
        // string: the same content under a different lang renders
        // different token colors (```python vs ```json), so the lang is
        // part of the block's identity.
        key.push('<');
        key.push_str(lang.as_deref().unwrap_or(""));
        key.push('>');
    }
    key.push('|');
    if let Some(next) = next {
        // The trailing-blank decision reads `next.sep_blank` (TS encodes
        // it as the next token being a `space` token, part of its key).
        if next.sep_blank {
            key.push_str("space|");
        }
        key.push_str(block_kind_name(&next.kind));
    }
    key.push('|');
    for line in &block.lines {
        key.push_str(line);
        key.push('\n');
    }
    key
}

fn block_kind_name(kind: &BlockKind) -> &'static str {
    match kind {
        BlockKind::Heading => "heading",
        BlockKind::Paragraph => "paragraph",
        BlockKind::Code { .. } => "code",
        BlockKind::List { .. } => "list",
        BlockKind::Quote => "quote",
        BlockKind::Hr => "hr",
        BlockKind::Table { .. } => "table",
    }
}

#[derive(Debug, Clone, PartialEq)]
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
        t.find(". ").map(|p| p + 2).unwrap_or(t.len())
    }
}

/// The fence languages the port highlights. TS `highlightCode` validates
/// through cli-highlight's `supportsLanguage` = highlight.js
/// `getLanguage(name)`, which lowercases and matches the grammar's
/// registered names and aliases: python 10.7.3 registers `python` with
/// aliases `py`, `gyp`, `ipython`. `lang` here is marked's whole trimmed
/// info string, so ```python foo=1 stays uniform (hljs has no such
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
            let mut spans = render_inline(&text, style);
            for s in spans.iter_mut() {
                s.style = style.heading;
            }
            out.push(spans);
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
            // both sides.
            let indent = style.code_block_indent.as_str();
            match highlighted_code_lines(block, lang.as_deref(), style) {
                Some(code_lines) => {
                    for line in code_lines {
                        let mut row: Line = vec![Span::raw(indent)];
                        row.extend(line);
                        out.push(row);
                    }
                }
                None => {
                    for line in &block.lines {
                        out.push(vec![
                            Span::raw(indent),
                            Span::styled(line.clone(), style.code_block),
                        ]);
                    }
                }
            }
            if block.lines.is_empty() {
                // An empty block still renders one indented empty line
                // (TS maps a lone codeBlock("")).
                out.push(vec![Span::raw(indent)]);
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

/// Inline rendering: bold, italic, strikethrough, code, links.
pub fn render_inline(text: &str, style: &MarkdownStyle) -> Line {
    render_inline_ctx(text, style, false)
}

/// `in_link` mirrors marked's `lexer.state.inLink`: set while a link
/// label's tokens are produced, and the gfm bare-url rule is skipped
/// inside one (the angle `autolink` rule is not).
fn render_inline_ctx(text: &str, style: &MarkdownStyle, in_link: bool) -> Line {
    let mut spans: Vec<Span> = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    // Byte offset per char index: the autolink rules run on a slice of the
    // original text (zero-copy) instead of a copy of the remaining tail,
    // so a candidate-heavy line stays linear in its attempts.
    let byte_offsets: Vec<usize> = text.char_indices().map(|(b, _)| b).collect();
    let mut buf = String::new();
    let mut i = 0usize;
    let base = style.body;
    let mut bold = false;
    let mut italic = false;
    let strike = false;
    // The bare-url email alternative only exists when the line carries an
    // `@` at all; the gate keeps the per-position regex attempts rare.
    let line_has_at = bytes.contains(&'@');
    // `bare_candidate` gates every autolink attempt on the literal prefix
    // the marked rules require, so the attempt regexes only ever run on
    // actual urls/emails - plain text (even `history history ...` floods
    // of `h` starts) never reaches the regex or the tail-string copy.

    macro_rules! flush {
        () => {
            if !buf.is_empty() {
                let mut m = Modifier::empty();
                if bold {
                    m |= style.bold;
                }
                if italic {
                    m |= style.italic;
                }
                if strike {
                    m |= style.strikethrough;
                }
                spans.push(Span::styled(std::mem::take(&mut buf), base.add_modifier(m)));
            }
        };
    }

    while i < bytes.len() {
        let c = bytes[i];
        // inline code
        if c == '`' {
            let mut j = i + 1;
            let mut code = String::new();
            while j < bytes.len() && bytes[j] != '`' {
                code.push(bytes[j]);
                j += 1;
            }
            if j < bytes.len() {
                flush!();
                spans.push(Span::styled(code, style.code));
                i = j + 1;
                continue;
            }
        }
        // links [text](url)
        if c == '[' {
            let mut j = i + 1;
            let mut label = String::new();
            while j < bytes.len() && bytes[j] != ']' {
                label.push(bytes[j]);
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == ']' && bytes[j + 1] == '(' {
                let mut k = j + 2;
                let mut url = String::new();
                while k < bytes.len() && bytes[k] != ')' {
                    url.push(bytes[k]);
                    k += 1;
                }
                if k < bytes.len() {
                    flush!();
                    let mut m = Modifier::empty();
                    if bold {
                        m |= style.bold;
                    }
                    if italic {
                        m |= style.italic;
                    }
                    // The observed TS binary output (0.9.5, the parity ground
                    // truth) renders the link label with the body color only:
                    // the link color is shadowed by the body color applied
                    // inside the label, and the underline wrapper never
                    // reaches the wire. `m` carries the emphasis context.
                    let href = crate::hyperlinks::resolve_link_href(&url);
                    let mut label_spans = render_inline_ctx(&label, style, true);
                    for s in label_spans.iter_mut() {
                        s.style = s.style.add_modifier(m);
                    }
                    if crate::hyperlinks::hyperlinks_enabled() {
                        // OSC 8: the label is clickable, the URL never
                        // printed inline (TS `hyperlink()`).
                        let open = crate::hyperlinks::osc8_open(&href);
                        if let Some(first) = label_spans.first_mut() {
                            first.content.insert_str(0, &open);
                        }
                        if let Some(last) = label_spans.last_mut() {
                            last.content.push_str(crate::hyperlinks::OSC8_CLOSE);
                        }
                        spans.extend(label_spans);
                    } else {
                        spans.extend(label_spans);
                        // Legacy form: the URL shows after the text unless
                        // the label is the URL (mailto stripped for the
                        // comparison, like autolinked emails).
                        let comparison = url.strip_prefix("mailto:").unwrap_or(url.as_str());
                        if label != url && label != comparison {
                            spans.push(Span::styled(format!(" ({url})"), style.link_url));
                        }
                    }
                    i = k + 1;
                    continue;
                }
            }
        }
        // emphasis
        if (c == '*' || c == '_') && i + 1 < bytes.len() {
            let is_triple = i + 2 < bytes.len() && bytes[i + 1] == c && bytes[i + 2] == c;
            if is_triple {
                if let Some(close) = find_closing(&bytes, i + 3, c, 3) {
                    flush!();
                    bold = !bold;
                    italic = !italic;
                    let inner: String = bytes[i + 3..close].iter().collect();
                    spans.push(Span::styled(
                        inner,
                        base.add_modifier(style.bold | style.italic),
                    ));
                    bold = !bold;
                    italic = !italic;
                    i = close + 3;
                    continue;
                }
            }
            let doubled = i + 1 < bytes.len() && bytes[i + 1] == c;
            let (len, close_search) = if doubled { (2, i + 2) } else { (1, i + 1) };
            if let Some(close) = find_closing(&bytes, close_search, c, len) {
                let inner: String = bytes[close_search..close].iter().collect();
                if inner.trim().is_empty() {
                    buf.push(c);
                    i += 1;
                    continue;
                }
                flush!();
                if doubled {
                    bold = !bold;
                    let mut inner_spans = render_inline_ctx(&inner, style, in_link);
                    for s in inner_spans.iter_mut() {
                        s.style = s.style.add_modifier(style.bold);
                    }
                    spans.extend(inner_spans);
                    bold = !bold;
                } else {
                    italic = !italic;
                    let mut inner_spans = render_inline_ctx(&inner, style, in_link);
                    for s in inner_spans.iter_mut() {
                        s.style = s.style.add_modifier(style.italic);
                    }
                    spans.extend(inner_spans);
                    italic = !italic;
                }
                i = close + len;
                continue;
            }
        }
        if c == '~' && i + 1 < bytes.len() && bytes[i + 1] == '~' {
            if let Some(close) = find_closing(&bytes, i + 2, '~', 2) {
                let inner: String = bytes[i + 2..close].iter().collect();
                if !inner.trim().is_empty() {
                    flush!();
                    let mut inner_spans = render_inline_ctx(&inner, style, in_link);
                    for s in inner_spans.iter_mut() {
                        s.style = s.style.add_modifier(style.strikethrough);
                    }
                    spans.extend(inner_spans);
                    i = close + 2;
                    continue;
                }
            }
        }
        // marked inline `autolink` (angle form) then `url` (gfm bare
        // links): the last two inline rules, tried once every other
        // construct failed at this position. The two rules are disjoint on
        // their first character, so the order collapses to this split.
        let autolink_hit = if c == '<' {
            autolink_token_at(&text[byte_offsets[i]..], true)
        } else if !in_link && crate::autolink::bare_candidate(&bytes, i, line_has_at) {
            autolink_token_at(&text[byte_offsets[i]..], false)
        } else {
            None
        };
        if let Some(token) = autolink_hit {
            flush!();
            // The token carries one plain text token, so the label is a
            // single body-colored run carrying the current emphasis (the
            // theme.link/underline wrapper never reaches the wire in the
            // deployed binary, like explicit link labels).
            let mut m = Modifier::empty();
            if bold {
                m |= style.bold;
            }
            if italic {
                m |= style.italic;
            }
            let label = Span::styled(token.text.clone(), base.add_modifier(m));
            if crate::hyperlinks::hyperlinks_enabled() {
                // OSC 8: the label is clickable, the URL never printed
                // inline (TS `hyperlink()`).
                let href = crate::hyperlinks::resolve_link_href(&token.href);
                let mut content = label.content;
                content.insert_str(0, &crate::hyperlinks::osc8_open(&href));
                content.push_str(crate::hyperlinks::OSC8_CLOSE);
                spans.push(Span::styled(content, label.style));
            } else {
                spans.push(label);
                // Legacy form: the URL shows after the label unless the
                // label already is it (mailto stripped), TS token.href.
                let comparison = token.href.strip_prefix("mailto:").unwrap_or(&token.href);
                if token.text != token.href && token.text != comparison {
                    spans.push(Span::styled(format!(" ({})", token.href), style.link_url));
                }
            }
            i += token.raw.chars().count();
            continue;
        }
        buf.push(c);
        i += 1;
    }
    flush!();
    if spans.is_empty() {
        spans.push(Span::raw(""));
    }
    spans
}

/// Run the marked autolink rules on the text starting at `rest` (the
/// caller's slice of the original line, so no per-candidate tail copy;
/// `angle` selects the `<...>` rule, otherwise the gfm bare-url rule).
/// Returns the token; the caller advances by its `raw` char count.
fn autolink_token_at(rest: &str, angle: bool) -> Option<crate::autolink::AutolinkToken> {
    if angle {
        crate::autolink::angle_token(rest)
    } else {
        crate::autolink::bare_token(rest)
    }
}

fn find_closing(chars: &[char], from: usize, delim: char, len: usize) -> Option<usize> {
    let mut i = from;
    while i + len <= chars.len() {
        if (0..len).all(|k| chars[i + k] == delim) {
            return Some(i);
        }
        i += 1;
    }
    None
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
        let mut rest = text.clone();
        let style = *style;
        while str_width(&rest) + col > width {
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
            rest = rest[taken..].to_string();
        }
        col += str_width(&rest);
        out.push(&rest, style);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_and_paragraph() {
        let style = MarkdownStyle::default();
        let lines = render_markdown("# Title\n\nBody text here", 40, &style);
        // Blank line between blocks: the TS `space` token renders one empty
        // row between them (markdown.ts `case "space"`).
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0][0].content, "Title");
        assert!(lines[1].is_empty(), "the space row is empty");
        let joined: String = lines[2].iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "Body text here");
        // Adjacent heading + paragraph: heading pushes a blank line.
        let adjacent = render_markdown("# Title\nBody text here", 40, &style);
        assert_eq!(adjacent.len(), 3);
    }

    #[test]
    fn paragraph_keeps_final_line_trailing_whitespace() {
        // The TS lexer's paragraph token carries the block's trailing
        // whitespace (probe vs the TS binary: the expanded compaction
        // summary's last row ends "stream. " with the space inside the
        // styled span). Soft line breaks render one row per line
        // (`applyTextWithNewlines` + the width pass breaks there), so the
        // trailing whitespace rides on the block's LAST rendered row.
        let style = MarkdownStyle::default();
        let rows = render_markdown("the story\ntail end ", 40, &style);
        let flat: Vec<String> = rows
            .iter()
            .map(|line| line.iter().map(|s| s.content.as_str()).collect())
            .collect();
        assert_eq!(flat, vec!["the story".to_string(), "tail end ".to_string()]);
        // Single-line paragraph: the trailing whitespace stays in the span.
        let joined = render_markdown("a\nb ", 40, &style);
        let last: String = joined[1].iter().map(|s| s.content.as_str()).collect();
        assert_eq!(last, "b ");
    }

    #[test]
    fn paragraph_blank_lines_render_space_rows() {
        let style = MarkdownStyle::default();
        let lines = render_markdown("a\n\nb", 40, &style);
        let flat: Vec<String> = lines
            .iter()
            .map(|line| line.iter().map(|s| s.content.as_str()).collect())
            .collect();
        assert_eq!(flat, vec!["a".to_string(), String::new(), "b".to_string()]);
    }

    #[test]
    fn consecutive_blank_lines_render_one_space_row() {
        let style = MarkdownStyle::default();
        // marked collapses a blank-line run into one `space` token.
        let lines = render_markdown("a\n\n\n\nb", 40, &style);
        assert_eq!(lines.len(), 3);
        assert!(lines[1].is_empty());
    }

    #[test]
    fn soft_breaks_render_one_row_per_line() {
        // TS ground truth (marked + `applyTextWithNewlines`): the soft
        // newlines survive into the paragraph's rendered string and the
        // width pass breaks there — "one\ntwo" is one paragraph, two rows
        // (verified against the TS product's `?` quick-shortcut guide).
        let style = MarkdownStyle::default();
        let lines = render_markdown("one\ntwo", 40, &style);
        assert_eq!(lines.len(), 2);
        let joined: String = lines[0].iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "one");
        let joined: String = lines[1].iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "two");
    }

    #[test]
    fn code_block_keeps_space_rows_around_it() {
        let style = MarkdownStyle::default();
        let lines = render_markdown("para\n\n```rust\nfn a() {}\n```\n\nafter", 40, &style);
        let flat: Vec<String> = lines
            .iter()
            .map(|line| line.iter().map(|s| s.content.as_str()).collect())
            .collect();
        assert_eq!(
            flat,
            vec![
                "para".to_string(),
                String::new(),
                "  fn a() {}".to_string(),
                String::new(),
                "after".to_string(),
            ]
        );
    }

    #[test]
    fn code_block_indented_no_borders() {
        let style = MarkdownStyle::default();
        // TS `renderCodeBlock`: `codeBlockIndent` (default "  ") outside the
        // styled code line, no border rows in the chat markdown.
        let lines = render_markdown("```rust\nfn main() {}\n```", 40, &style);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0][0].content, "  ");
        assert_eq!(lines[0][1].content, "fn main() {}");
        // An empty block still renders one indented empty line.
        let empty = render_markdown("```\n```", 40, &style);
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0][0].content, "  ");
    }

    #[test]
    fn python_fence_renders_the_ts_token_colors() {
        // The TS markdown theme highlights ```python fences through
        // cli-highlight (the same highlight.js pass the expanded ipython
        // cell uses); the fence line's spans carry the syntax palette
        // colors, the indent stays outside them.
        let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let style = MarkdownStyle::from_theme(&theme);
        let keyword = theme.fg_style(crate::theme::ThemeColor::SyntaxKeyword);
        let number = theme.fg_style(crate::theme::ThemeColor::SyntaxNumber);
        let string = theme.fg_style(crate::theme::ThemeColor::SyntaxString);
        let lines = render_markdown("```python\nx = 1\nflag = 'yes'\n```", 40, &style);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0][0].content, "  ");
        // `x = 1`: plain identifier and punctuation, then the number.
        assert_eq!(lines[0][1].content, "x = ");
        assert_eq!(lines[0][1].style, Style::default());
        assert_eq!(lines[0][2].content, "1");
        assert_eq!(lines[0][2].style, number);
        assert_eq!(lines[1][2].content, "'yes'");
        assert_eq!(lines[1][2].style, string);
        // The keyword scope lands on a reserved word.
        let keyword_lines = render_markdown("```python\nreturn x\n```", 40, &style);
        assert_eq!(keyword_lines[0][1].content, "return");
        assert_eq!(keyword_lines[0][1].style, keyword);
    }

    #[test]
    fn python_fence_lang_matches_the_hljs_aliases() {
        let style = MarkdownStyle::default();
        // `getLanguage` lowercases; python registers py/gyp/ipython, and
        // marked passes the whole trimmed info string, so an info string
        // with attributes stays uniform.
        for fence in ["py", "PYTHON", "ipython"] {
            let lines = render_markdown(&format!("```{fence}\nx = 'y'\n```"), 40, &style);
            assert!(
                lines[0].iter().any(|s| s.style != Style::default()),
                "{fence} must highlight"
            );
        }
        let uniform = render_markdown("```python foo=1\nx = 'y'\n```", 40, &style);
        assert!(uniform[0]
            .iter()
            .skip(1)
            .all(|s| s.style == style.code_block));
    }

    #[test]
    fn quiet_style_renders_python_fences_uniform() {
        // The thinking theme replaces TS `highlightCode` with dim lines:
        // with no palette the block keeps the uniform code_block color.
        let style = MarkdownStyle {
            syntax: None,
            ..MarkdownStyle::default()
        };
        let lines = render_markdown("```python\nx = 1\n```", 40, &style);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0][1].content, "x = 1");
        assert_eq!(lines[0][1].style, style.code_block);
    }

    /// The block cache must not serve one lang's token colors to another:
    /// TS's key carries `token.raw` (the fence info string included), so
    /// frame 2's ```json block (same content as frame 1's cached ```python
    /// block) re-renders uniform instead of replaying python colors.
    #[test]
    fn block_cache_does_not_carry_token_colors_across_langs() {
        let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let style = MarkdownStyle::from_theme(&theme);
        let number = theme.fg_style(crate::theme::ThemeColor::SyntaxNumber);
        let mut cache = MarkdownBlockCache::default();
        let first =
            render_markdown_tagged("intro\n\n```python\nx = 1\n```", 40, &style, "", &mut cache);
        assert_eq!(first.last().unwrap()[2].style, number);
        let second = render_markdown_tagged(
            "intro\n\n```python\nx = 1\n```\n\nbetween\n\n```json\nx = 1\n```",
            40,
            &style,
            "",
            &mut cache,
        );
        // The final ```json block: one uniform code_block span, not the
        // cached python token spans.
        let json_row = second.last().unwrap();
        assert_eq!(json_row.len(), 2);
        assert_eq!(json_row[0].content, "  ");
        assert_eq!(json_row[1].content, "x = 1");
        assert_eq!(json_row[1].style, style.code_block);
    }

    #[test]
    fn python_fence_multiline_string_carries_across_rows() {
        // One highlight.js pass over the whole block: a triple-quoted
        // string keeps the string color on every row it spans.
        let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let style = MarkdownStyle::from_theme(&theme);
        let string = theme.fg_style(crate::theme::ThemeColor::SyntaxString);
        let lines = render_markdown("```python\ns = '''a\nb'''\n```", 40, &style);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0][2].content, "'''a");
        assert_eq!(lines[0][2].style, string);
        assert_eq!(lines[1][1].content, "b'''");
        assert_eq!(lines[1][1].style, string);
    }

    #[test]
    fn list_render() {
        let style = MarkdownStyle::default();
        let lines = render_markdown("- one\n- two", 40, &style);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0][0].content, "- ");
        assert_eq!(lines[0][1].content, "one");
    }

    #[test]
    fn inline_bold_code_link() {
        // Pin the terminal-capability gate: a link renders the legacy
        // `label (url)` form when OSC 8 hyperlinks are unavailable.
        crate::hyperlinks::set_hyperlinks_override(Some(false));
        let style = MarkdownStyle::default();
        let spans = render_inline("a **b** `c` [d](http://e)", &style);
        let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(texts, vec!["a ", "b", " ", "c", " ", "d", " (http://e)"]);
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn legacy_link_row_is_underlined_and_shows_the_url() {
        crate::hyperlinks::set_hyperlinks_override(Some(false));
        let style = MarkdownStyle::default();
        let spans = render_inline("see [docs](https://x.dev/a)", &style);
        let texts: Vec<String> = spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(
            texts,
            vec![
                "see ".to_string(),
                "docs".to_string(),
                " (https://x.dev/a)".to_string()
            ]
        );
        // The observed TS binary output styles the label with the body
        // color only (the underline wrapper never reaches the wire).
        assert!(!spans[1].style.add_modifier.contains(Modifier::UNDERLINED));
        assert_eq!(spans[1].style.fg, style.body.fg);
        assert_eq!(spans[2].style.fg, style.link_url.fg);
        // The URL is not repeated when the label is the URL, and mailto
        // labels compare with the prefix stripped (autolinked emails).
        let bare = render_inline("[https://x.dev](https://x.dev)", &style);
        let joined: String = bare.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "https://x.dev");
        let mail = render_inline("[a@b.dev](mailto:a@b.dev)", &style);
        let joined: String = mail.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "a@b.dev");
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn osc8_gated_link_row_wraps_the_label_in_a_hyperlink() {
        crate::hyperlinks::set_hyperlinks_override(Some(true));
        let style = MarkdownStyle::default();
        let spans = render_inline("see [docs](https://x.dev/a)", &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(
            joined,
            format!(
                "see {}docs{}",
                crate::hyperlinks::osc8_open("https://x.dev/a"),
                crate::hyperlinks::OSC8_CLOSE
            )
        );
        // The sequences are zero-width: the row measures like the plain text
        // and never prints the URL inline.
        assert_eq!(
            joined.chars().filter(|&c| c == '(').count(),
            0,
            "osc8 rows must not inline the url: {joined}"
        );
        assert_eq!(str_width(&joined), str_width("see docs"));
        // Windows drive-letter targets classify as file paths.
        let drive = render_inline("[c:\\src](c:\\src)", &style);
        let joined: String = drive.iter().map(|s| s.content.as_str()).collect();
        assert!(joined.contains("file:///c:/src"), "drive path: {joined}");
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn bare_url_autolinks_osc8() {
        crate::hyperlinks::set_hyperlinks_override(Some(true));
        let style = MarkdownStyle::default();
        let spans = render_inline("see https://x.dev/a?b=1 now", &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(
            joined,
            format!(
                "see {}https://x.dev/a?b=1{} now",
                crate::hyperlinks::osc8_open("https://x.dev/a?b=1"),
                crate::hyperlinks::OSC8_CLOSE
            )
        );
        // The label is one zero-width-wrapped run; the URL never prints
        // twice and no legacy suffix appears.
        assert_eq!(str_width(&joined), str_width("see https://x.dev/a?b=1 now"));
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn bare_url_autolink_trims_trailing_punctuation() {
        crate::hyperlinks::set_hyperlinks_override(Some(false));
        let style = MarkdownStyle::default();
        // Trailing punctuation is backpedaled out of the link and stays in
        // the text stream.
        let spans = render_inline("go to https://x.dev/pull/182. now", &style);
        let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(texts, vec!["go to ", "https://x.dev/pull/182", ". now"]);
        // Balanced paren groups survive; the peeled trailing run re-renders
        // so the visible row is unchanged.
        let spans = render_inline("(see https://x.dev/a(b)) ok", &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "(see https://x.dev/a(b)) ok");
        // A comma separates the link from the sentence tail.
        let spans = render_inline("(visit https://x.dev/page, thanks)", &style);
        let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(texts, vec!["(visit ", "https://x.dev/page", ", thanks)"]);
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn bare_url_autolink_forms() {
        crate::hyperlinks::set_hyperlinks_override(Some(false));
        let style = MarkdownStyle::default();
        let joined = |md: &str| -> String {
            render_inline(md, &style)
                .iter()
                .map(|s| s.content.as_str())
                .collect()
        };
        // ftp and case-insensitive schemes link; uppercase targets pass
        // through unresolved (target == token href, like TS).
        assert_eq!(joined("ftp://files.x.io/x"), "ftp://files.x.io/x");
        assert_eq!(joined("HTTPS://UPPER.COM/PATH"), "HTTPS://UPPER.COM/PATH");
        // A bare url starts mid-word, like marked's text-rule break.
        assert_eq!(
            joined("midhttps://word.com/break"),
            "midhttps://word.com/break"
        );
        // Entity-ish runs survive the backpedal.
        assert_eq!(joined("https://x.dev/a&#39;b"), "https://x.dev/a&#39;b");
        // Explicit links win over the bare rule at the same position.
        assert_eq!(joined("[https://x.dev](https://x.dev)"), "https://x.dev");
        // Two links in one line tokenize independently.
        assert_eq!(
            joined("https://x.dev, and https://y.dev; done"),
            "https://x.dev, and https://y.dev; done"
        );
        // Not an email: only the domain-shaped tail links.
        assert_eq!(
            joined("not an email: @host, a@b, x@y.z"),
            "not an email: @host, a@b, x@y.z"
        );
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn www_autolink_gains_scheme_and_legacy_suffix() {
        // Legacy form: token.text != token.href for a www autolink, so the
        // resolved href shows after the label (TS legacy branch).
        crate::hyperlinks::set_hyperlinks_override(Some(false));
        let style = MarkdownStyle::default();
        let spans = render_inline("www.example.com/path", &style);
        let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(
            texts,
            vec!["www.example.com/path", " (http://www.example.com/path)"]
        );
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn email_autolinks_with_mailto_href() {
        // Legacy form: the mailto-stripped href equals the label, so no
        // suffix prints (autolinked emails).
        crate::hyperlinks::set_hyperlinks_override(Some(false));
        let style = MarkdownStyle::default();
        let spans = render_inline("mail foo.bar+baz@example.co.uk ok", &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "mail foo.bar+baz@example.co.uk ok");
        // OSC 8 form: the href carries mailto:.
        crate::hyperlinks::set_hyperlinks_override(Some(true));
        let spans = render_inline("mail foo@example.co.uk ok", &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(
            joined,
            format!(
                "mail {}foo@example.co.uk{} ok",
                crate::hyperlinks::osc8_open("mailto:foo@example.co.uk"),
                crate::hyperlinks::OSC8_CLOSE
            )
        );
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn angle_autolinks_become_links() {
        crate::hyperlinks::set_hyperlinks_override(Some(true));
        let style = MarkdownStyle::default();
        // The brackets are consumed; the label is the inner target.
        let spans = render_inline("x <https://angle.dev/a> y", &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(
            joined,
            format!(
                "x {}https://angle.dev/a{} y",
                crate::hyperlinks::osc8_open("https://angle.dev/a"),
                crate::hyperlinks::OSC8_CLOSE
            )
        );
        // Angle email: href gains mailto:.
        let spans = render_inline("<foo.bar@example.org>", &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(
            joined,
            format!(
                "{}foo.bar@example.org{}",
                crate::hyperlinks::osc8_open("mailto:foo.bar@example.org"),
                crate::hyperlinks::OSC8_CLOSE
            )
        );
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn bare_url_is_not_autolinked_inside_a_link_label() {
        // marked's state.inLink guard: the gfm url rule does not run while
        // a link label is tokenized, so the inner url stays plain text.
        crate::hyperlinks::set_hyperlinks_override(Some(false));
        let style = MarkdownStyle::default();
        let spans = render_inline("[see https://in.dev/x](https://out.dev/y)", &style);
        let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
        assert_eq!(texts, vec!["see https://in.dev/x", " (https://out.dev/y)"]);
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn angle_autolink_inside_link_label_yields_the_terminal_ranges() {
        // marked tokenizes angle autolinks even inside an explicit link
        // label (only the gfm bare rule is inLink-guarded), so the TS byte
        // stream carries the outer wrap around a label that itself embeds
        // an inner OSC 8 pair. Terminals keep no region stack: the inner
        // close ends the active region, so the outer label's tail after
        // it is NOT linked - exactly the ranges the frame scan produces
        // (the outer range closes at the inner open, and never resumes).
        crate::hyperlinks::set_hyperlinks_override(Some(true));
        let style = MarkdownStyle::default();
        let spans = render_inline("[pre <https://inner.dev> post](https://outer.dev)", &style);
        let ranges = crate::hyperlinks::frame_link_ranges(&[spans]);
        assert_eq!(
            ranges,
            vec![
                crate::hyperlinks::LinkRange {
                    row: 0,
                    start_col: 0,
                    end_col: 4,
                    url: "https://outer.dev/".to_string(),
                },
                crate::hyperlinks::LinkRange {
                    row: 0,
                    start_col: 4,
                    end_col: 21,
                    url: "https://inner.dev/".to_string(),
                },
            ]
        );
        crate::hyperlinks::set_hyperlinks_override(None);
    }

    #[test]
    fn table_block_renders_boxed_rows() {
        let style = MarkdownStyle::default();
        let lines = render_markdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter", 40, &style);
        let flat: Vec<String> = lines
            .iter()
            .map(|line| line.iter().map(|s| s.content.as_str()).collect())
            .collect();
        assert_eq!(
            flat,
            vec![
                "┌───┬───┐".to_string(),
                "│ a │ b │".to_string(),
                "├───┼───┤".to_string(),
                "│ 1 │ 2 │".to_string(),
                "└───┴───┘".to_string(),
                String::new(),
                "after".to_string(),
            ]
        );
    }

    #[test]
    fn styled_span_boundaries_keep_their_spaces() {
        // A gap starting a new span must not be swallowed by the wrap pass.
        let style = MarkdownStyle::default();
        let lines = render_markdown("**Hello.** I can render", 80, &style);
        let joined: String = lines[0].iter().map(|s| s.content.as_str()).collect();
        assert_eq!(joined, "Hello. I can render");
        // Whitespace runs keep their length across spans: TS
        // `splitIntoTokensWithAnsi` holds each run as ONE token and a
        // fitting line passes through unchanged (wrapSingleLine's
        // visibleLength early return) — verified against the TS dist
        // (wrapTextWithAnsi renders "a b   c ...").
        let spans = render_inline("a **b**   c", &style);
        let wrapped = wrap_spans_to_text(&spans, 40);
        assert_eq!(wrapped, "a b   c");
    }

    fn wrap_spans_to_text(spans: &[Span], width: usize) -> String {
        let mut lines: Vec<Line> = Vec::new();
        wrap_spans(spans, width, Style::default(), &mut lines);
        lines
            .iter()
            .flat_map(|l| l.iter().map(|s| s.content.as_str()))
            .collect()
    }

    #[test]
    fn wrapping() {
        let style = MarkdownStyle::default();
        let lines = render_markdown("word ".repeat(10).trim(), 20, &style);
        assert!(lines.len() >= 3);
        for l in &lines {
            let w: usize = l.iter().map(|s| str_width(&s.content)).sum();
            assert!(w <= 20, "line too wide: {w}");
        }
    }

    #[test]
    fn quote_block() {
        let style = MarkdownStyle::default();
        let lines = render_markdown("> wisdom", 40, &style);
        assert_eq!(lines[0][0].content, "▐ ");
        assert_eq!(lines[0][1].content, "wisdom");
    }
}

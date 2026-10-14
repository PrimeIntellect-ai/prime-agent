//! Markdown rendering ported from `packages/tui/src/components/markdown.ts` (the block/inline
//! subset that appears in agent sessions: headings, paragraphs, fenced code, lists, blockquotes,
//! hr, and inline emphasis, code, and links). Emits styled `Line`s for ratatui instead of ANSI
//! strings.

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

/// Styling hooks resolved from a theme (plus the settings-driven `code_block_indent`; not
/// `Copy` because of the indent `String`).
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
    /// The fenced-code indent string (`markdown.codeBlockIndent` in settings; default " ").
    pub code_block_indent: String,
    /// The `syntax*` palette for fenced-code token colors (TS `highlightCode`, cli-highlight
    /// over the highlight.js grammar). `None` renders every code line uniform in `code_block`
    /// — the TS no-valid-language fallback, and the quiet thinking theme.
    pub(crate) syntax: Option<crate::tool_card::highlight::SyntaxPalette>,
    pub(crate) link_base_url: Option<url::Url>,
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
            // TS `theme.bold/italic/strikethrough` are chalk; chalk emits its SGR
            // modifiers in any color terminal (its supports-color level is >= 1
            // whenever stdout is a TTY), so emphasis carries real modifiers.
            bold: Modifier::BOLD,
            italic: Modifier::ITALIC,
            strikethrough: Modifier::CROSSED_OUT,
            code_block_indent: "  ".to_string(),
            syntax: Some(crate::tool_card::highlight::SyntaxPalette::from_theme(
                theme,
            )),
            link_base_url: None,
        }
    }
}

/// Rendered markdown document as styled lines.
#[must_use]
pub fn render_markdown(text: &str, width: usize, style: &MarkdownStyle) -> Vec<Line> {
    render_markdown_tagged(text, width, style, "", &mut MarkdownBlockCache::default())
}

/// Cached render with a style discriminator (see [`MarkdownBlockCache`]): the same raw text
/// rendered under different styles (the dim thinking block) must not hit the other style's rows.
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
        // A blank source line separates blocks: TS's lexer emits one `space` token per blank
        // run and `renderToken` pushes one empty row for it; `parse_blocks` skips the blank
        // source lines, so the row is emitted here, ahead of the block it precedes.
        if block.sep_blank {
            lines.push(Vec::new());
        }
        let key = block_cache_key(
            style_tag,
            &blocks,
            i,
            content_width,
            style.link_base_url.as_ref(),
        );
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
            // The final block renders into the caller's buffer: every render path only appends.
            None => render_block(block, next, content_width, style, &mut lines),
        }
    }
    lines
}

/// Per-block render cache (TS `Markdown.blockCache`): a streaming append re-renders only
/// the changing final block — every earlier block replays its rendered rows by [`BlockKey`]
/// instead of re-running inline styling, wrapping, and code highlighting. Entries are never
/// pruned within a message: the cache is shared by the entry's text and thinking renders, so
/// TS's per-render `nextCache` swap would evict the other block's entries every frame. Size
/// stays bounded without it — entries are keyed by settled (non-final) blocks, the whole map
/// drops when the message settles (`view.rs`) or the layout width or render options change,
/// and the final block is never cached (appended text can reinterpret an open block).
#[derive(Default)]
pub struct MarkdownBlockCache(std::collections::HashMap<BlockKey, Vec<Line>>);

/// The cache key: every `render_block` input a streamed append can change — the style discriminator
/// (the dim thinking block), the width, the parsed block itself, and the following block's
/// trailing-blank effect. Keying on the parsed `BlockKind` covers each of the block's own render
/// inputs structurally, so a field added later is covered automatically.
#[derive(PartialEq, Eq, Hash)]
struct BlockKey {
    link_base_url: Option<url::Url>,
    style_tag: String,
    width: usize,
    kind: BlockKind,
    lines: Vec<String>,
    /// `render_block`'s only reads of the next block: `[blank_after(next, false), blank_after(next,
    /// true)]`.
    blank_after: [bool; 2],
}

/// The one cacheability rule shared by render and count (TS `useCache = cacheable && i <
/// tokens.length - 1`): every block but the last is cacheable; the final one returns `None`.
fn block_cache_key(
    style_tag: &str,
    blocks: &[Block],
    index: usize,
    width: usize,
    link_base_url: Option<&url::Url>,
) -> Option<BlockKey> {
    if index + 1 == blocks.len() {
        return None;
    }
    let next = blocks.get(index + 1);
    let block = &blocks[index];
    Some(BlockKey {
        link_base_url: link_base_url.cloned(),
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

/// One list level: its marker type and the items parsed at one indent.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ListBlock {
    ordered: bool,
    start: usize,
    items: Vec<ListItem>,
}

/// One item part, in source order: a text line or a nested list.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ListPart {
    Text(String),
    /// A lazy soft line within nested item text: TS inline newlines resume at column zero.
    LazyText(String),
    List(ListBlock),
}

/// One list item: its parts in source order (text lines and nested lists
/// interleaved — marked walks an item's block tokens the same way).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ListItem {
    parts: Vec<ListPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum BlockKind {
    Heading {
        depth: usize,
    },
    Paragraph,
    Code {
        lang: Option<String>,
    },
    List(ListBlock),
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
    let src_lines: Vec<&str> = text.lines().collect();
    let mut blocks = Vec::new();
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
        if let Some(fence) = trimmed
            .strip_prefix("```")
            .map(|rest| (rest, "```"))
            .or_else(|| trimmed.strip_prefix("~~~").map(|rest| (rest, "~~~")))
        {
            let (fence, closer) = fence;
            let lang = if fence.is_empty() {
                None
            } else {
                Some(fence.trim().to_string())
            };
            let mut code = Vec::new();
            i += 1;
            while i < src_lines.len() && !src_lines[i].trim().starts_with(closer) {
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
        let hashes = trimmed.chars().take_while(|&c| c == '#').count();
        if heading_marker(trimmed) && hashes <= 6 {
            let content = trimmed
                .get(hashes + 1..)
                .map_or_else(String::new, std::string::ToString::to_string);
            blocks.push(Block {
                kind: BlockKind::Heading { depth: hashes },
                sep_blank,
                lines: vec![content],
            });
            i += 1;
            continue;
        }
        if is_hr(trimmed) {
            blocks.push(Block {
                kind: BlockKind::Hr,
                sep_blank,
                lines: Vec::new(),
            });
            i += 1;
            continue;
        }
        if trimmed.starts_with('>') {
            // One quote block: `>`-prefixed lines plus marked's lazy continuation —
            // following non-blank lines that do not start another block stay inside
            // the quote (the blockquote token consumes until a blank line).
            let mut qlines = Vec::new();
            while i < src_lines.len() {
                let t = src_lines[i].trim();
                if t.is_empty() {
                    break;
                }
                if let Some(q) = t.strip_prefix('>') {
                    qlines.push(q.trim_start().to_string());
                    i += 1;
                    continue;
                }
                if interrupts_paragraph(t, src_lines.get(i + 1)) {
                    break;
                }
                qlines.push(t.to_string());
                i += 1;
            }
            blocks.push(Block {
                kind: BlockKind::Quote,
                sep_blank,
                lines: qlines,
            });
            continue;
        }
        if let Some((ordered, start)) = list_marker(trimmed) {
            let indent = line.len() - line.trim_start().len();
            let first = ListItem {
                parts: vec![ListPart::Text(trimmed[marker_width(trimmed)..].to_string())],
            };
            let content_col = indent + marker_width(trimmed);
            i += 1;
            let list = parse_list_level(
                &src_lines,
                &mut i,
                first,
                ordered,
                start,
                ListNesting { indent, depth: 0 },
                content_col,
            );
            blocks.push(Block {
                kind: BlockKind::List(list),
                sep_blank,
                lines: Vec::new(),
            });
            continue;
        }
        // Table (marked's rule: header + delimiter + body rows; after the other block starts).
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
        // Paragraph: consume until blank line or new block marker. TS's marked lexes the whole run
        // as ONE paragraph token but its inline renderer preserves each soft newline, so the source
        // lines are kept — each renders as its own row, still one block.
        let mut para_lines = vec![trimmed.to_string()];
        // The block's last source line keeps its trailing whitespace (probe vs the TS binary: the
        // compaction summary's last row ends "stream. " with the space inside the styled span).
        let mut last_raw = line;
        i += 1;
        while i < src_lines.len() {
            let l = src_lines[i];
            let t = l.trim();
            if t.is_empty() || interrupts_paragraph(t, src_lines.get(i + 1)) {
                break;
            }
            para_lines.push(t.to_string());
            last_raw = l;
            i += 1;
        }
        // A trailing unescaped backslash is a hard break (marked consumes it with
        // the newline); the paragraph's last line has no following row, so its
        // backslash stays literal.
        let hard_break_count = para_lines.len().saturating_sub(1);
        for line in para_lines.iter_mut().take(hard_break_count) {
            let backslashes = line.chars().rev().take_while(|&c| c == '\\').count();
            if backslashes % 2 == 1 {
                line.pop();
            }
        }
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

/// A heading line start: `#`s followed by a space (the depth cap lives where the
/// heading is parsed).
pub(crate) fn heading_marker(t: &str) -> bool {
    let hashes = t.chars().take_while(|&c| c == '#').count();
    hashes > 0 && (t.len() == hashes || t.as_bytes()[hashes] == b' ')
}

pub(crate) fn is_hr(t: &str) -> bool {
    let chars: Vec<char> = t.chars().filter(|&c| c != ' ').collect();
    (chars.len() >= 3)
        && chars.iter().all(|&c| c == '-' || c == '*' || c == '_')
        && (chars[0] == '-' || chars[0] == '*' || chars[0] == '_')
}

/// A line that interrupts a paragraph (marked: a new block never continues one) —
/// the shared stop predicate for paragraph parsing and a blockquote's lazy
/// continuation.
fn interrupts_paragraph(t: &str, next: Option<&&str>) -> bool {
    t.starts_with("```")
        || t.starts_with("~~~")
        || t.starts_with('>')
        || t.starts_with('#')
        || list_marker(t).is_some()
        || is_hr(t)
        || crate::markdown_table::is_table_start(t, next)
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

/// The bullet for one item of a list level (TS `renderList`: the token's start
/// number plus the item index, so sibling markers' own numbers are ignored).
fn list_bullet(ordered: bool, start: usize, index: usize) -> String {
    if ordered {
        format!("{}. ", start + index)
    } else {
        "- ".to_string()
    }
}

/// One list level's row geometry: the column its rows indent to (the level's own
/// indent plus the accumulated `indent + "  "` frames of its ancestors, TS
/// `renderList`), and the indent its children's rows inherit from that frame.
fn list_level_geometry(depth: usize, outer: usize) -> (usize, usize) {
    (outer + 2 * depth, outer + 2 * depth + 2)
}

/// One item line's wrap budget: the first line shares its row with the level
/// indent and the bullet; later lines carry `indent + "  "`.
fn list_line_budget(
    width: usize,
    indent_len: usize,
    bullet_width: usize,
    first_line: bool,
) -> usize {
    let used = if first_line {
        indent_len + bullet_width
    } else {
        indent_len + 2
    };
    width.saturating_sub(used).max(1)
}

#[derive(Clone, Copy)]
struct ListNesting {
    indent: usize,
    depth: usize,
}

/// Parse one list level (marked's list rule): marker lines of the level's own
/// type start items (a marker line indented between the level indent and the
/// current item's content column is absorbed as a sibling — marked renumbers
/// by index), blank lines stay internal (marked's loose list), indented
/// non-marker lines continue the current item as their own lines, and a marker
/// line at or past the content column opens a nested level. Anything else ends
/// the level; a trailing run of blanks is left for the gap before the next
/// block.
fn parse_list_level(
    src_lines: &[&str],
    i: &mut usize,
    first: ListItem,
    ordered: bool,
    start: usize,
    nesting: ListNesting,
    first_content_col: usize,
) -> ListBlock {
    let ListNesting { indent, depth } = nesting;
    let mut items = vec![first];
    // The column the current item's content starts at: a line indented to it is
    // the item's continuation or a nested list; a marker line between the level
    // indent and it is absorbed as a sibling (marked renumbers by index).
    let mut content_col = first_content_col;
    let mut pending_blank: Option<usize> = None;
    while *i < src_lines.len() {
        let line = src_lines[*i];
        let t = line.trim();
        let line_indent = line.len() - line.trim_start().len();
        if t.is_empty() {
            pending_blank.get_or_insert(*i);
            *i += 1;
            continue;
        }
        if let Some((child_ordered, child_start)) = list_marker(t) {
            let marker_w = marker_width(t);
            if line_indent >= content_col {
                // Keep untrusted message content from building an unbounded recursive tree.
                // Beyond this level the source marker stays literal; count, paint and Drop
                // therefore share the same bounded tree without losing the item text.
                if depth >= 64 {
                    items
                        .last_mut()
                        .expect("the level has its first item")
                        .parts
                        .push(ListPart::Text(t.to_string()));
                    pending_blank = None;
                    *i += 1;
                    continue;
                }
                let child_first = ListItem {
                    parts: vec![ListPart::Text(t[marker_w..].to_string())],
                };
                *i += 1;
                let child = parse_list_level(
                    src_lines,
                    i,
                    child_first,
                    child_ordered,
                    child_start,
                    ListNesting {
                        indent: line_indent,
                        depth: depth + 1,
                    },
                    line_indent + marker_w,
                );
                items
                    .last_mut()
                    .expect("the level has its first item")
                    .parts
                    .push(ListPart::List(child));
                pending_blank = None;
                continue;
            }
            if child_ordered == ordered
                && (line_indent == indent || (line_indent > indent && line_indent < content_col))
            {
                items.push(ListItem {
                    parts: vec![ListPart::Text(t[marker_w..].to_string())],
                });
                content_col = line_indent + marker_w;
                pending_blank = None;
                *i += 1;
                continue;
            }
            break;
        }
        if line_indent >= content_col {
            items
                .last_mut()
                .expect("the level has its first item")
                .parts
                .push(ListPart::Text(t.to_string()));
            pending_blank = None;
            *i += 1;
            continue;
        }
        if depth > 0 && pending_blank.is_none() && !interrupts_paragraph(t, src_lines.get(*i + 1)) {
            items
                .last_mut()
                .expect("the level has its first item")
                .parts
                .push(ListPart::LazyText(t.to_string()));
            *i += 1;
            continue;
        }
        break;
    }
    if let Some(blank) = pending_blank {
        *i = blank;
    }
    ListBlock {
        ordered,
        start,
        items,
    }
}

/// The fence languages the port highlights. TS `highlightCode` validates through highlight.js
/// `getLanguage(name)`, which lowercases and matches the grammar's registered names and aliases
/// (python registers `python` with `py`, `gyp`, `ipython`). `lang` here is marked's whole trimmed
/// info string, so ```` ```python foo=1 ```` stays uniform; only these exact spellings highlight.
fn is_highlighted_lang(lang: &str) -> bool {
    matches!(
        lang.to_ascii_lowercase().as_str(),
        "python" | "py" | "gyp" | "ipython"
    )
}

/// The block's highlighted lines (TS `theme.highlightCode(text, lang)`: one highlight.js
/// pass over the whole block, so multi-line strings carry across lines; the fallback paths —
/// no palette, an unsupported language, or no language — render `None` so the caller keeps
/// the uniform `mdCodeBlock` rows).
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
fn heading_spans(text: &str, depth: usize, style: &MarkdownStyle) -> Vec<Span> {
    let (mut spans, url_slots, code_slots) = inline::render_inline_tracked(text, style);
    // TS heading styleFn: h1 bold+underline, h2/h3 bold, h4 bold+italic, h5/h6 italic,
    // all over the heading color. The heading modifiers close around an inline-code
    // span and a link's URL bracket — both keep their own colors (tracked by origin);
    // an underlined link label keeps the underline affordance.
    let taper = style.heading.add_modifier(match depth {
        1 => Modifier::BOLD | Modifier::UNDERLINED,
        2 | 3 => Modifier::BOLD,
        4 => Modifier::BOLD | Modifier::ITALIC,
        _ => Modifier::ITALIC,
    });
    // The slot indices arrive ascending, so one cursor walks them in
    // step with the span iteration — a link-heavy heading stays linear.
    let mut url_slot = 0;
    let mut code_slot = 0;
    for (i, s) in spans.iter_mut().enumerate() {
        if url_slots.get(url_slot) == Some(&i) {
            url_slot += 1;
            continue;
        }
        if code_slots.get(code_slot) == Some(&i) {
            code_slot += 1;
            continue;
        }
        let underlined = s.style.add_modifier.contains(Modifier::UNDERLINED);
        s.style = taper;
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
        BlockKind::Heading { depth } => {
            let text = block.lines.first().cloned().unwrap_or_default();
            let spans = heading_spans(&text, *depth, style);
            wrap_spans(&spans, width, out);
            if blank_after(false) {
                out.push(Vec::new());
            }
        }
        BlockKind::Paragraph => {
            // Each soft-break line renders and wraps on its own (TS's paragraph token
            // carries the newlines through the width pass).
            for text in &block.lines {
                let spans = inline::render_inline_tracked(text, style).0;
                wrap_spans(&spans, width, out);
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
                wrap_spans(&row, width, out);
            }
            if blank_after(false) {
                out.push(Vec::new());
            }
        }
        BlockKind::List(list) => {
            render_list_level(list, 0, 0, width, style, out);
            if blank_after(true) {
                out.push(Vec::new());
            }
        }
        BlockKind::Quote => {
            // TS renders the whole quote content in the quote color and italic
            // (its quoteStyle re-applies after every inline reset); inline-code
            // spans and link URL brackets keep their own colors, and emphasis
            // modifiers ride on top.
            for line in &block.lines {
                let (spans, url_slots, code_slots) = inline::render_inline_tracked(line, style);
                let mut quote_spans: Vec<Span> = Vec::new();
                for (i, mut s) in spans.into_iter().enumerate() {
                    if s.content.is_empty() {
                        continue;
                    }
                    s.style = s.style.add_modifier(Modifier::ITALIC);
                    if !url_slots.contains(&i) && !code_slots.contains(&i) {
                        s.style.fg = style.quote.fg;
                    }
                    quote_spans.push(s);
                }
                wrap_quote(&quote_spans, width, style, out);
            }
        }
        BlockKind::Hr => {
            // TS hr: `"─".repeat(Math.min(width, 80))`.
            let bar: String = "─".repeat(width.min(80));
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

/// One wrap token: a run of spaces, or a word run whose pieces may cross span
/// boundaries — TS `splitIntoTokensWithAnsi` never splits a word at an ANSI
/// boundary, so a styled span's trailing punctuation stays glued to the word.
#[derive(Debug)]
pub(super) enum WrapToken {
    Gap(String, Style),
    Word(Vec<(String, Style)>),
}

/// Split styled spans into wrap tokens: words and space runs, with words that
/// touch across a span boundary glued into one token.
#[must_use]
pub(super) fn tokenize_spans(spans: &[Span]) -> Vec<WrapToken> {
    let mut tokens: Vec<WrapToken> = Vec::new();
    for span in spans {
        let mut word = String::new();
        for ch in span.content.chars() {
            if ch == ' ' {
                if !word.is_empty() {
                    push_word(&mut tokens, std::mem::take(&mut word), span.style);
                }
                match tokens.last_mut() {
                    Some(WrapToken::Gap(text, _)) => text.push(' '),
                    _ => tokens.push(WrapToken::Gap(" ".to_string(), span.style)),
                }
            } else {
                word.push(ch);
            }
        }
        if !word.is_empty() {
            push_word(&mut tokens, word, span.style);
        }
    }
    tokens
}

/// Place one piece of a glued word unit, breaking overlong pieces across rows;
/// escape sequences copy through atomically at zero width (OSC 8 sequences must
/// never split mid-sequence).
///
/// The remaining width is tracked arithmetically: measured once (the caller's
/// `w`), decremented by each row's emitted width, with `rest` sliced — never
/// re-measured per row (an unbroken token longer than the wrap width would
/// otherwise wrap in `O(token_len * rows)` time). For content whose per-char
/// widths sum to its grapheme width — every printable-ASCII/escape/tab token,
/// the catastrophic class — the arithmetic is exact; a row split inside a
/// multi-char grapheme cluster is the one non-additive case, so a tentative
/// exit is confirmed against one true measure before the leftover is pushed
/// (the correctness backstop, never the hot path).
fn push_word_piece(
    text: &str,
    style: Style,
    width: usize,
    col: &mut usize,
    out: &mut geometry::WrapOutput<'_>,
) {
    let mut rest: &str = text;
    let mut rest_width = str_width(rest);
    loop {
        if rest_width + *col <= width {
            if str_width(rest) + *col <= width {
                break;
            }
            // A non-additive cluster split drifted the arithmetic: re-sync from the
            // true measure and keep breaking.
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
            if tw + cw + *col > width {
                break;
            }
            take.push(c);
            tw += cw;
            taken += c.len_utf8();
        }
        if take.is_empty() {
            // The piece cannot start on this row: open a fresh row and retry
            // it (a glued word never overflows its row; the count path
            // shares this break).
            if *col > 0 {
                out.finish_row(/*trim*/ false);
                *col = 0;
                continue;
            }
            break;
        }
        out.push(&take, style);
        out.finish_row(/*trim*/ false);
        *col = 0;
        rest = &rest[taken..];
        rest_width -= tw;
    }
    *col += str_width(rest);
    out.push(rest, style);
}

fn push_word(tokens: &mut Vec<WrapToken>, text: String, style: Style) {
    match tokens.last_mut() {
        Some(WrapToken::Word(pieces)) => pieces.push((text, style)),
        _ => tokens.push(WrapToken::Word(vec![(text, style)])),
    }
}

/// Wrap styled spans to `width`. Words break at whitespace; leading spaces are
/// dropped after a wrap break. Adjacent same-style output pieces merge.
pub fn wrap_spans(spans: &[Span], width: usize, out: &mut Vec<Line>) {
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
    let tokens = tokenize_spans(spans);

    let mut col = 0usize;
    let mut i = 0usize;
    while i < tokens.len() {
        match &tokens[i] {
            WrapToken::Word(pieces) => {
                // The glued unit wraps as one word: it moves to the next row
                // together, never splitting at a span boundary.
                let w: usize = pieces.iter().map(|(t, _)| str_width(t)).sum();
                if col + w > width && out.has_content {
                    // A wrapped row never carries its trailing gap: TS wrapTextWithAnsi drops the
                    // boundary space, so the styled content ends at the last word.
                    out.finish_row(/*trim*/ true);
                    col = 0;
                }
                for (piece, style) in pieces {
                    push_word_piece(piece, *style, width, &mut col, out);
                }
            }
            WrapToken::Gap(text, style) => {
                let w = str_width(text);
                if col + w > width && out.has_content {
                    // A wrapped row never carries its trailing gap: TS wrapTextWithAnsi drops the
                    // boundary space, so the styled content ends at the last word.
                    out.finish_row(/*trim*/ true);
                    col = 0;
                    // drop leading whitespace at the new line start
                    if text.trim().is_empty() {
                        i += 1;
                        continue;
                    }
                }
                push_word_piece(text, *style, width, &mut col, out);
            }
        }
        i += 1;
    }
    out.finish_row(/*trim*/ false);
}

/// The row count of one list level — the same geometry [`render_list_level`]
/// paints (level indent, bullet widths, budgets), counted without collecting
/// rows. An item with no lines still renders its bare bullet row.
fn list_row_count(
    list: &ListBlock,
    depth: usize,
    outer: usize,
    width: usize,
    style: &MarkdownStyle,
) -> usize {
    let (indent_len, child_outer) = list_level_geometry(depth, outer);
    let mut count = 0;
    for (index, item) in list.items.iter().enumerate() {
        let bullet_width = str_width(&list_bullet(list.ordered, list.start, index));
        let mut item_count = 0;
        let mut first_part = true;
        for part in &item.parts {
            match part {
                ListPart::Text(text) => {
                    let budget = list_line_budget(width, indent_len, bullet_width, first_part);
                    item_count += wrapped_span_count(&render_inline(text, style), budget);
                    first_part = false;
                }
                ListPart::List(child) => {
                    item_count += list_row_count(child, depth + 1, child_outer, width, style);
                    first_part = false;
                }
                ListPart::LazyText(text) => {
                    item_count += wrapped_span_count(&render_inline(text, style), width);
                    first_part = false;
                }
            }
        }
        count += item_count.max(1);
    }
    count
}

/// Render one list level (TS `renderList`): every item line beyond the first
/// prefixes with `indent + "  "` (each nesting level accumulates one frame), the
/// item's first line carries the level's bullet, wrapped rows keep the
/// bullet-width continuation indent, and empty items render the bare bullet.
fn render_list_level(
    list: &ListBlock,
    depth: usize,
    outer: usize,
    width: usize,
    style: &MarkdownStyle,
    out: &mut Vec<Line>,
) {
    let (indent_len, child_outer) = list_level_geometry(depth, outer);
    let indent = " ".repeat(indent_len);
    for (index, item) in list.items.iter().enumerate() {
        let bullet = list_bullet(list.ordered, list.start, index);
        let bullet_width = str_width(&bullet);
        let mut item_rows: Vec<Line> = Vec::new();
        // The item's parts walk in source order; the first part carries the
        // level's bullet (a nested list renders into the same rows before any
        // later text lines, matching marked's token order).
        let mut first_part = true;
        for part in &item.parts {
            match part {
                ListPart::Text(text) => {
                    let spans = inline::render_inline_tracked(text, style).0;
                    let mut wrapped: Vec<Line> = Vec::new();
                    if first_part {
                        let budget = list_line_budget(width, indent_len, bullet_width, true);
                        wrap_spans(&spans, budget, &mut wrapped);
                        for (k, line) in wrapped.into_iter().enumerate() {
                            let mut row: Line = Vec::new();
                            if !indent.is_empty() {
                                row.push(Span::raw(indent.clone()));
                            }
                            if k == 0 {
                                row.push(Span::styled(bullet.clone(), style.list_bullet));
                            } else {
                                row.push(Span::raw(" ".repeat(bullet_width)));
                            }
                            row.extend(line);
                            item_rows.push(row);
                        }
                    } else {
                        let sub_indent = format!("{indent}  ");
                        let budget = list_line_budget(width, indent_len, bullet_width, false);
                        wrap_spans(&spans, budget, &mut wrapped);
                        for line in wrapped {
                            let mut row = vec![Span::raw(sub_indent.clone())];
                            row.extend(line);
                            item_rows.push(row);
                        }
                    }
                    first_part = false;
                }
                ListPart::List(child) => {
                    render_list_level(child, depth + 1, child_outer, width, style, &mut item_rows);
                    first_part = false;
                }
                ListPart::LazyText(text) => {
                    wrap_spans(&render_inline(text, style), width, &mut item_rows);
                    first_part = false;
                }
            }
        }
        if item_rows.is_empty() {
            let mut row: Line = Vec::new();
            if !indent.is_empty() {
                row.push(Span::raw(indent.clone()));
            }
            row.push(Span::styled(bullet, style.list_bullet));
            out.push(row);
        } else {
            out.extend(item_rows);
        }
    }
}

fn wrap_quote(spans: &[Span], width: usize, style: &MarkdownStyle, out: &mut Vec<Line>) {
    let quote_width = width.saturating_sub(2).max(1);
    let mut wrapped: Vec<Line> = Vec::new();
    wrap_spans(spans, quote_width, &mut wrapped);
    for line in wrapped {
        let mut l = vec![Span::styled("│ ", style.quote_border)];
        l.extend(line);
        out.push(l);
    }
}

/// Convert our Line type to ratatui text for rendering. OSC zone markers and OSC 8
/// hyperlink sequences are stripped: ratatui has no escape-sequence support and would count
/// their bytes as visible cells (the paint path re-emits them).
#[must_use]
pub fn to_ratatui_line(line: &Line) -> rt::Line<'static> {
    let mut stripped = line.clone();
    crate::osc133::strip(&mut stripped);
    crate::hyperlinks::strip_osc8(&mut stripped);
    // TS `applyLineResets` normalizes every painted line right before the differential
    // paint (Thai/Lao AM decomposition, tabs to three spaces).
    let spans: Vec<rt::Span<'static>> = stripped
        .iter()
        .map(|s| rt::Span::styled(crate::width::normalize_terminal_output(&s.content), s.style))
        .collect();
    rt::Line::from(spans)
}

//! Prompt-highlight tokens (TS `prompt-highlight.ts`): the accent color on
//! a leading slash-command segment and the `success`/`mdLink` colors on
//! `@path` / `--flag` argument tokens, applied exactly where the TS product
//! applies them:
//!
//! - the queued-message preview strip (`styleQueuedMessagePreview`): dim base, accent on the recognized command's `/name`, arg tokens colored;
//! - the live editor's styled display text (`CustomEditor.styleDisplayText` + `ArgTokenHighlighter`): arg tokens colored on every line, the command token of the first layout line in accent (argument-taking commands only, suppressed while the cursor sits inside it).
//!
//! - the user-message transcript block (`UserMessageComponent` +
//!   `PromptTokenMask`): the row's accent command segment and argument
//!   tokens mask to same-width private-use placeholders before the
//!   markdown layout and restore to their colors after the render
//!   ([`PromptTokenMask`], [`user_message_command_span`]);
//! - the durable session-command echo row (`SlashCommandMessageComponent` +
//!   `styleSlashCommandText`): the accent command segment and the
//!   argument tokens of the typed text ([`slash_command_source_spans`]).

use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use pa_types::slash_commands::{parse_slash_command, SlashCommandRegistry};
use ratatui::style::{Modifier, Style};
use std::sync::OnceLock;

/// One highlighted argument token (TS `ArgTokenSpan`): a half-open char
/// range over its source text plus the token's theme color.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArgTokenSpan {
    /// First char of the token.
    pub start: usize,
    /// One past the token's last char.
    pub end: usize,
    /// `success` for `@`-tokens, `mdLink` for flags (TS `tokenColor`).
    pub color: ThemeColor,
}

/// TS `ARG_TOKEN_PATTERN`, or `ARG_TOKEN_PATTERN_WITH_SEPARATOR` when the
/// command line takes arguments (a bare `--` end-of-options separator also
/// highlights).
fn arg_token_pattern(include_bare_separator: bool) -> &'static fancy_regex::Regex {
    static PLAIN: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static WITH_SEPARATOR: OnceLock<fancy_regex::Regex> = OnceLock::new();
    if include_bare_separator {
        WITH_SEPARATOR.get_or_init(|| {
            fancy_regex::Regex::new(
                r#"@"[^"\n]*"|@(?:\\[^\s\x1b]|[^\s\x1b|])+|--[A-Za-z0-9][A-Za-z0-9-]*|--(?=\s|$)"#,
            )
            .expect("arg-token pattern compiles")
        })
    } else {
        PLAIN.get_or_init(|| {
            fancy_regex::Regex::new(
                r#"@"[^"\n]*"|@(?:\\[^\s\x1b]|[^\s\x1b|])+|--[A-Za-z0-9][A-Za-z0-9-]*"#,
            )
            .expect("arg-token pattern compiles")
        })
    }
}

/// TS `tokenColor`: `@`-tokens are `success`, flags are `mdLink`.
fn token_color(token: &str) -> ThemeColor {
    if token.starts_with('@') {
        ThemeColor::Success
    } else {
        ThemeColor::MdLink
    }
}

/// TS `hasTokenBoundary`: a token must start at index 0 or after whitespace.
fn has_token_boundary(text: &str, byte_start: usize) -> bool {
    byte_start == 0
        || text[..byte_start]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace)
}

fn char_at_index(text: &str, byte_index: usize) -> usize {
    text[..byte_index].chars().count()
}

fn byte_at_char(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map_or(text.len(), |(byte, _)| byte)
}

/// Slice by char range (half-open).
pub(crate) fn char_slice(text: &str, start: usize, end: usize) -> &str {
    &text[byte_at_char(text, start)..byte_at_char(text, end)]
}

/// TS `findArgTokens`: the token spans of `text` at or after `from_index`,
/// each needing a whitespace boundary before it. Char offsets.
pub fn find_arg_tokens(
    text: &str,
    from_index: usize,
    include_bare_separator: bool,
) -> Vec<ArgTokenSpan> {
    let regex = arg_token_pattern(include_bare_separator);
    let mut spans = Vec::new();
    for result in regex.find_iter(text) {
        let Ok(m) = result else { continue };
        if char_at_index(text, m.start()) < from_index || !has_token_boundary(text, m.start()) {
            continue;
        }
        spans.push(ArgTokenSpan {
            start: char_at_index(text, m.start()),
            end: char_at_index(text, m.end()),
            color: token_color(&text[m.start()..m.end()]),
        });
    }
    spans
}

/// TS `styleArgumentTokens`: `text` styled `base` color with its argument
/// tokens in their own colors. Char-offset `from_index` skips tokens that
/// start before it.
pub fn style_argument_tokens(
    theme: &Theme,
    text: &str,
    base: ThemeColor,
    from_index: usize,
    include_bare_separator: bool,
) -> Line {
    let mut line = Vec::new();
    let mut offset = 0usize;
    for token in find_arg_tokens(text, from_index, include_bare_separator) {
        if token.start > offset {
            line.push(theme.fg(base, char_slice(text, offset, token.start)));
        }
        line.push(theme.fg(token.color, char_slice(text, token.start, token.end)));
        offset = token.end;
    }
    if offset < text.chars().count() {
        line.push(theme.fg(base, char_slice(text, offset, text.chars().count())));
    }
    line
}

/// TS `styleQueuedMessagePreview`: the strip preview styling. Plain messages
/// render dim with argument tokens colored; a message led by a recognized
/// builtin slash command renders its `/name` segment in accent and the rest
/// dim (argument tokens still colored). `label` is the lane label
/// [`crate::queued::format_queued_message_preview`] prepends.
///
/// The TS recognition check also admits daemon-registered connection
/// commands; the Rust strip recognizes builtin commands (aliases included).
pub fn style_queued_message_preview(theme: &Theme, message: &str, label: &str) -> Line {
    let registry = SlashCommandRegistry::builtin_cached();
    let preview = crate::queued::format_queued_message_preview(message, label);
    // TS `isLeadingSlashCommand`: a leading `/name` naming a known command.
    let leading = parse_slash_command(message).filter(|(name, _)| registry.is_builtin(name));
    let Some((name, _)) = leading else {
        return style_argument_tokens(theme, &preview, ThemeColor::Dim, 0, false);
    };
    let mut line = Vec::new();
    // The lane-label prefix is dim; the styled message follows it.
    let prefix_end = preview.chars().count() - message.chars().count();
    if prefix_end > 0 {
        line.push(theme.fg(ThemeColor::Dim, char_slice(&preview, 0, prefix_end)));
    }
    // TS `styleSlashCommandText`: accent on `/` plus the typed name; a bare
    // `--` separator highlights only for argument-taking commands.
    let command_end = name.chars().count() + 1;
    line.push(theme.fg(ThemeColor::Accent, char_slice(message, 0, command_end)));
    let include_bare_separator = registry.takes_argument(&name);
    line.extend(style_argument_tokens(
        theme,
        char_slice(message, command_end, message.chars().count()),
        ThemeColor::Dim,
        0,
        include_bare_separator,
    ));
    line
}

/// TS `parseSlashCommand` (core/slash-commands.ts): the leading `/name` of
/// a submitted line — the slash at char 0, the name a non-empty
/// non-whitespace run, the arguments the trimmed rest.
pub fn leading_slash_command(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix('/')?;
    let name_end = rest
        .char_indices()
        .find(|(_, c)| c.is_whitespace())
        .map_or(rest.len(), |(index, _)| index);
    if name_end == 0 {
        return None;
    }
    Some((&rest[..name_end], rest[name_end..].trim()))
}

/// TS `UserMessageComponent`'s mask span: the accent command segment of a
/// transcript user row — its length (the leading `/name` when it names a
/// recognized builtin command, else 0) and whether the argument-token scan
/// admits a bare `--` separator. The TS recognition predicate also admits
/// daemon-registered connection commands; this client recognizes builtins
/// (the same reduction the queued-strip preview makes).
pub fn user_message_command_span(text: &str) -> (usize, bool) {
    let registry = SlashCommandRegistry::builtin_cached();
    let Some((name, _)) = leading_slash_command(text) else {
        return (0, false);
    };
    if !registry.is_builtin(name) {
        return (0, false);
    }
    (name.chars().count() + 1, registry.takes_argument(name))
}

/// One color span of the session-command echo row, in source char offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceSpan {
    /// First char of the span.
    pub start: usize,
    /// One past the span's last char.
    pub end: usize,
    /// The span's theme color.
    pub color: ThemeColor,
}

/// TS `styleSlashCommandText`: the echo row's color spans — the accent
/// command segment (the leading `/name`, or the whole text when the row is
/// not a slash command) plus the argument tokens after it. The command
/// segment accents for any leading `/name`, recognized or not; a bare `--`
/// separator highlights only for argument-taking commands.
pub fn slash_command_source_spans(text: &str) -> Vec<SourceSpan> {
    let registry = SlashCommandRegistry::builtin_cached();
    match leading_slash_command(text) {
        Some((name, _)) => {
            let command_end = name.chars().count() + 1;
            let mut spans = vec![SourceSpan {
                start: 0,
                end: command_end,
                color: ThemeColor::Accent,
            }];
            let include_bare_separator = registry.takes_argument(name);
            for token in find_arg_tokens(text, command_end, include_bare_separator) {
                spans.push(SourceSpan {
                    start: token.start,
                    end: token.end,
                    color: token.color,
                });
            }
            spans
        }
        None => vec![SourceSpan {
            start: 0,
            end: text.chars().count(),
            color: ThemeColor::Accent,
        }],
    }
}

/// The TS `PromptTokenMask` base char: each masked grapheme gets its own
/// private-use base char, so restoring is a lookup, not positional.
const MASK_BASE_START: u32 = 0xE000;
const MASK_CAPACITY: usize = 0xF8FF - 0xE000 + 1;
/// The mask's extra-width char: one per column beyond the first of a wide
/// grapheme's placeholder.
const MASK_EXTRA_WIDTH: char = '\u{FF9E}';

fn is_mask_base(c: char) -> bool {
    ('\u{E000}'..='\u{F8FF}').contains(&c)
}

/// TS `PromptTokenMask`: the markdown-layout mask over a user row's accent
/// command segment and argument tokens. Each token grapheme is replaced by
/// a same-width private-use placeholder, so the markdown renderer lays the
/// row out exactly as it would the plain text, and [`Self::restore_line`]
/// re-colors the placeholders after the render. Sources holding literal
/// mask-range characters (or more masked graphemes than the placeholder
/// alphabet holds) mask nothing and render plain.
#[derive(Debug, Clone)]
pub struct PromptTokenMask {
    /// The masked text to feed the markdown renderer.
    pub text: String,
    /// The masked graphemes, indexed by placeholder: (segment, color).
    graphemes: Vec<(String, ThemeColor)>,
}

impl PromptTokenMask {
    /// TS `PromptTokenMask` constructor: tabs expand to three spaces (a
    /// masked raw tab would restore into a three-column layout), the
    /// command segment `[0, command_end)` masks in accent, the argument
    /// tokens at or after `command_end` mask in their own colors.
    pub fn new(source: &str, command_end: usize, include_bare_separator: bool) -> Self {
        use unicode_segmentation::UnicodeSegmentation;
        let source = source.replace('\t', "   ");
        let mut mask = PromptTokenMask {
            text: source.clone(),
            graphemes: Vec::new(),
        };
        // Literal mask-range characters would alias generated placeholders.
        if source
            .chars()
            .any(|c| is_mask_base(c) || c == MASK_EXTRA_WIDTH)
        {
            return mask;
        }
        let mut tokens: Vec<(usize, usize, ThemeColor)> = Vec::new();
        if command_end > 0 {
            tokens.push((0, command_end, ThemeColor::Accent));
        }
        for token in find_arg_tokens(&source, command_end, include_bare_separator) {
            tokens.push((token.start, token.end, token.color));
        }
        let total = source.chars().count();
        let mut text = String::new();
        let mut cursor = 0usize;
        for (start, end, color) in tokens {
            text.push_str(char_slice(&source, cursor, start));
            let token_text = char_slice(&source, start, end);
            for segment in token_text.graphemes(true) {
                let width = crate::width::str_width(segment);
                if width == 0 {
                    // Zero-width graphemes stay literal: invisible either
                    // way, and the restored text stays exact.
                    text.push_str(segment);
                    continue;
                }
                if mask.graphemes.len() == MASK_CAPACITY {
                    return PromptTokenMask {
                        text: source,
                        graphemes: Vec::new(),
                    };
                }
                let base = char::from_u32(MASK_BASE_START + mask.graphemes.len() as u32)
                    .expect("private-use range start is a char");
                text.push(base);
                text.push_str(&MASK_EXTRA_WIDTH.to_string().repeat(width - 1));
                mask.graphemes.push((segment.to_string(), color));
            }
            cursor = end;
        }
        text.push_str(char_slice(&source, cursor, total));
        mask.text = text;
        mask
    }

    fn grapheme_at(&self, base: char) -> Option<&(String, ThemeColor)> {
        let index = base as u32 - MASK_BASE_START;
        self.graphemes.get(index as usize)
    }

    /// TS `restoreLine`: replace each placeholder in a rendered line with
    /// its grapheme in the token's color; every other char keeps the span's
    /// own styling. Contiguous placeholders of one color restore as one
    /// run (TS merges same-color runs), so a whole token renders as a
    /// single styled span. Literal mask-range characters from an unmasked
    /// source stay untouched.
    pub fn restore_line(&self, theme: &Theme, line: &Line) -> Line {
        // Contiguous same-style runs merge (TS merges same-color runs).
        let push = |out: &mut Line, content: &str, style: Style| {
            if let Some(last) = out.last_mut() {
                if last.style == style {
                    last.content.push_str(content);
                    return;
                }
            }
            out.push(Span::styled(content.to_string(), style));
        };
        let mut out: Line = Vec::new();
        for span in line {
            let mut plain = String::new();
            let mut chars = span.content.chars().peekable();
            while let Some(c) = chars.next() {
                if !is_mask_base(c) {
                    plain.push(c);
                    continue;
                }
                let mut extras = String::new();
                while chars.peek() == Some(&MASK_EXTRA_WIDTH) {
                    extras.push(chars.next().expect("peeked char"));
                }
                let Some((segment, color)) = self.grapheme_at(c) else {
                    plain.push(c);
                    plain.push_str(&extras);
                    continue;
                };
                if !plain.is_empty() {
                    push(&mut out, &std::mem::take(&mut plain), span.style);
                }
                push(&mut out, segment, span.style.patch(theme.fg_style(*color)));
            }
            if !plain.is_empty() {
                push(&mut out, &plain, span.style);
            }
        }
        out
    }
}

/// TS `COMMAND_TOKEN_PATTERN` (`/^(\s*)\/(\S+)/`): the leading `/name` run
/// of an editor line. Char offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandToken {
    /// First char of the `/` (after the leading whitespace).
    pub start: usize,
    /// One past the name run's last char.
    pub end: usize,
    /// The typed name (the non-whitespace run after the `/`).
    pub name: String,
}

/// Match a [`CommandToken`] at the start of `line` (TS
/// `COMMAND_TOKEN_PATTERN.exec`); `None` when the line does not open with
/// (optional whitespace and) a `/name` run.
pub fn command_token(line: &str) -> Option<CommandToken> {
    let leading = line.chars().take_while(|c| c.is_whitespace()).count();
    let mut rest = line.chars().skip(leading);
    if rest.next()? != '/' {
        return None;
    }
    let name: String = rest.take_while(|c| !c.is_whitespace()).collect();
    if name.is_empty() {
        return None;
    }
    Some(CommandToken {
        start: leading,
        end: leading + 1 + name.chars().count(),
        name,
    })
}

/// The highlight ranges of one laid-out editor chunk (TS
/// `ArgTokenHighlighter.highlightLine` + `CustomEditor.styleCommandToken`):
/// the source line's argument tokens clipped to the chunk, plus — when the
/// chunk is the first layout line and opens with an argument-taking command
/// the cursor does not sit inside — the command token in accent. Char
/// offsets over the chunk, in order.
pub fn editor_chunk_highlights(
    chunk: &str,
    line_spans: &[ArgTokenSpan],
    source_start: usize,
    command: Option<&CommandToken>,
    command_takes_argument: bool,
    cursor_col: Option<usize>,
) -> Vec<(usize, usize, ThemeColor)> {
    let chunk_chars = chunk.chars().count();
    let range_end = source_start + chunk_chars;
    let mut out = Vec::new();
    for span in line_spans {
        if span.end <= source_start {
            continue;
        }
        if span.start >= range_end {
            break;
        }
        out.push((
            span.start.max(source_start) - source_start,
            span.end.min(range_end) - source_start,
            span.color,
        ));
    }
    if let Some(command) = command {
        if command_takes_argument && !cursor_col.is_some_and(|cursor| cursor < command.end) {
            out.push((command.start, command.end, ThemeColor::Accent));
        }
    }
    out
}

/// The visible text spans of one editor chunk: highlight-colored runs with
/// the cursor cell reverse-video. The reversed cell carries the highlight
/// color under it (TS `highlightLine` re-wraps the cursor splice inside the
/// token color); the appended end-of-line cursor cell stays default, like
/// the TS `\x1b[7m \x1b[27m` splice beyond the last token.
pub fn editor_text_spans(
    theme: &Theme,
    chunk: &str,
    highlights: &[(usize, usize, ThemeColor)],
    selection: Option<(usize, usize)>,
    cursor_col: Option<usize>,
    bg: Style,
) -> Vec<Span> {
    let chars: Vec<char> = chunk.chars().collect();
    let len = chars.len();
    let selection = selection.filter(|(start, end)| *start < *end && *start < len);
    let mut boundaries = vec![0usize, len];
    for (start, end, _) in highlights {
        boundaries.push(*start);
        boundaries.push(*end);
    }
    if let Some((start, end)) = selection {
        boundaries.push(start.min(len));
        boundaries.push(end.min(len));
    }
    let cursor_on_chunk = cursor_col.filter(|cursor| *cursor <= len);
    if let Some(cursor) = cursor_on_chunk {
        boundaries.push(cursor);
        if cursor < len {
            boundaries.push(cursor + 1);
        }
    }
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut out = Vec::new();
    for pair in boundaries.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        if start >= end {
            continue;
        }
        let mut style = bg;
        if let Some((_, _, color)) = highlights
            .iter()
            .find(|(s, e, _)| *s <= start && start < *e)
        {
            style = bg.patch(theme.fg_style(*color));
        }
        // The active selection renders reversed-video like the cursor
        // cell (there is no TS selection to mirror; reverse keeps it
        // visible on every theme).
        if selection.is_some_and(|(s, e)| s <= start && start < e) {
            style = style.add_modifier(Modifier::REVERSED);
        }
        // The cursor covers exactly the one char under it.
        if cursor_on_chunk == Some(start) && end == start + 1 {
            style = style.add_modifier(Modifier::REVERSED);
        }
        out.push(Span::styled(
            chars[start..end].iter().collect::<String>(),
            style,
        ));
    }
    if cursor_on_chunk == Some(len) {
        out.push(Span::styled(
            " ".to_string(),
            bg.add_modifier(Modifier::REVERSED),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn dim() -> Style {
        theme().fg_style(ThemeColor::Dim)
    }

    fn accent() -> Style {
        theme().fg_style(ThemeColor::Accent)
    }

    fn success() -> Style {
        theme().fg_style(ThemeColor::Success)
    }

    fn md_link() -> Style {
        theme().fg_style(ThemeColor::MdLink)
    }

    fn spans(line: &Line) -> Vec<(String, Style)> {
        line.iter()
            .map(|span| (span.content.to_string(), span.style))
            .collect()
    }

    #[test]
    fn arg_tokens_cover_paths_flags_and_separators() {
        let tokens = find_arg_tokens("fix @Cargo.toml --quiet now", 0, false);
        assert_eq!(
            tokens,
            vec![
                ArgTokenSpan {
                    start: 4,
                    end: 15,
                    color: ThemeColor::Success
                },
                ArgTokenSpan {
                    start: 16,
                    end: 23,
                    color: ThemeColor::MdLink
                },
            ]
        );
        // A bare `--` only highlights with the separator pattern.
        assert!(find_arg_tokens("x -- y", 0, false).is_empty());
        assert_eq!(
            find_arg_tokens("x -- y", 0, true),
            vec![ArgTokenSpan {
                start: 2,
                end: 4,
                color: ThemeColor::MdLink
            }]
        );
        // Quoted @-paths keep their spaces.
        assert_eq!(
            find_arg_tokens(r#"a @"my file" b"#, 0, false),
            vec![ArgTokenSpan {
                start: 2,
                end: 12,
                color: ThemeColor::Success
            }]
        );
        // An unterminated quote falls back to the bare-path form.
        assert_eq!(
            find_arg_tokens(r#"a @"open b"#, 0, false),
            vec![ArgTokenSpan {
                start: 2,
                end: 8,
                color: ThemeColor::Success
            }]
        );
        // A backslash escape can carry a non-space char; the token stops at
        // the first whitespace either way.
        assert_eq!(
            find_arg_tokens(r"a @pa\th b", 0, false),
            vec![ArgTokenSpan {
                start: 2,
                end: 8,
                color: ThemeColor::Success
            }]
        );
    }

    #[test]
    fn arg_tokens_need_a_whitespace_boundary() {
        assert!(find_arg_tokens("a@b", 0, false).is_empty());
        assert_eq!(
            find_arg_tokens("a @b", 0, false),
            vec![ArgTokenSpan {
                start: 2,
                end: 4,
                color: ThemeColor::Success
            }]
        );
        // A token starting before `from_index` is skipped even with a
        // boundary (TS filters matches that start early).
        assert_eq!(find_arg_tokens("@a --b", 2, false).len(), 1);
        assert_eq!(
            find_arg_tokens("@a --b", 2, false)[0].start,
            3,
            "the early @-token is skipped, the flag still highlights"
        );
    }

    #[test]
    fn plain_previews_render_dim_with_colored_tokens() {
        let line = style_queued_message_preview(&theme(), "fix @Cargo.toml --quiet", "Follow-up");
        assert_eq!(
            spans(&line),
            vec![
                ("Follow-up: fix ".to_string(), dim()),
                ("@Cargo.toml".to_string(), success()),
                (" ".to_string(), dim()),
                ("--quiet".to_string(), md_link()),
            ]
        );
    }

    #[test]
    fn slash_previews_render_the_command_segment_in_accent() {
        let line = style_queued_message_preview(&theme(), "/new @docs/plan.md --draft", "Steering");
        assert_eq!(
            spans(&line),
            vec![
                ("Steering: ".to_string(), dim()),
                ("/new".to_string(), accent()),
                (" ".to_string(), dim()),
                ("@docs/plan.md".to_string(), success()),
                (" ".to_string(), dim()),
                ("--draft".to_string(), md_link()),
            ]
        );
        // Aliases highlight with their typed name.
        let line = style_queued_message_preview(&theme(), "/clear now", "Follow-up");
        assert_eq!(
            spans(&line),
            vec![
                ("Follow-up: ".to_string(), dim()),
                ("/clear".to_string(), accent()),
                (" now".to_string(), dim()),
            ]
        );
        // Argument-taking commands highlight a bare separator; others do not.
        let line = style_queued_message_preview(&theme(), "/new x -- y", "Steering");
        assert!(spans(&line)
            .iter()
            .any(|(text, style)| { text == "--" && *style == md_link() }));
        let line = style_queued_message_preview(&theme(), "/hotkeys x -- y", "Steering");
        assert!(
            !spans(&line).iter().any(|(text, _)| text == "--"),
            "a no-argument command does not get the separator pattern"
        );
    }

    #[test]
    fn unrecognized_commands_render_uniformly_dim() {
        let line = style_queued_message_preview(&theme(), "/definitely-not-builtin x", "Steering");
        assert_eq!(
            spans(&line),
            vec![("Steering: /definitely-not-builtin x".to_string(), dim())]
        );
        // A labeled internal prompt keeps its own label and stays dim.
        let line =
            style_queued_message_preview(&theme(), "Heartbeat prompt: run @check", "Steering");
        assert_eq!(
            spans(&line),
            vec![
                ("Heartbeat prompt: run ".to_string(), dim()),
                ("@check".to_string(), success()),
            ]
        );
    }

    #[test]
    fn leading_slash_command_parses_the_ts_shape() {
        // TS `parseSlashCommand`: the slash at char 0, a non-empty
        // non-whitespace name, trimmed args.
        assert_eq!(
            leading_slash_command("/new foo bar"),
            Some(("new", "foo bar"))
        );
        assert_eq!(leading_slash_command("/new"), Some(("new", "")));
        // No leading slash, an empty name, or a mid-text slash: no command.
        assert_eq!(leading_slash_command("new"), None);
        assert_eq!(leading_slash_command("/ foo"), None);
        assert_eq!(leading_slash_command("/"), None);
        assert_eq!(leading_slash_command("a /new"), None);
    }

    #[test]
    fn user_message_command_span_needs_a_recognized_builtin() {
        // The accent span covers the leading `/name` only for recognized
        // builtins; a bare `--` separator rides argument-taking commands.
        assert_eq!(user_message_command_span("/hotkeys"), (8, false));
        assert_eq!(
            user_message_command_span("/new draft @docs -- x"),
            (4, true)
        );
        // `/clear` stays the no-argument alias even though `/new` takes one.
        assert_eq!(user_message_command_span("/clear"), (6, false));
        // Unknown names and plain prompts mask no command segment.
        assert_eq!(user_message_command_span("/nope x"), (0, false));
        assert_eq!(user_message_command_span("fix @Cargo.toml"), (0, false));
    }

    #[test]
    fn slash_command_source_spans_cover_the_ts_echo_shape() {
        // TS `styleSlashCommandText`: accent on the leading `/name` (the
        // typed name, recognized or not) plus the rest's argument tokens.
        assert_eq!(
            slash_command_source_spans("/compact fix @Cargo.toml --quiet"),
            vec![
                SourceSpan {
                    start: 0,
                    end: 8,
                    color: ThemeColor::Accent
                },
                SourceSpan {
                    start: 13,
                    end: 24,
                    color: ThemeColor::Success
                },
                SourceSpan {
                    start: 25,
                    end: 32,
                    color: ThemeColor::MdLink
                },
            ]
        );
        // A non-command row accents its whole text (TS `commandEnd =
        // text.length`); a recognized argument-taking command admits a
        // bare `--` separator, an unrecognized one does not.
        assert_eq!(
            slash_command_source_spans("plain text"),
            vec![SourceSpan {
                start: 0,
                end: 10,
                color: ThemeColor::Accent
            }]
        );
        assert_eq!(
            slash_command_source_spans("/new x -- y")[1],
            SourceSpan {
                start: 7,
                end: 9,
                color: ThemeColor::MdLink
            }
        );
        assert_eq!(
            slash_command_source_spans("/nope x -- y"),
            vec![SourceSpan {
                start: 0,
                end: 5,
                color: ThemeColor::Accent
            }]
        );
    }

    #[test]
    fn mask_replaces_token_graphemes_with_same_width_placeholders() {
        let mask = PromptTokenMask::new("fix @Cargo.toml now", 0, false);
        // The plain text is untouched; the token's graphemes map to
        // consecutive private-use base chars.
        assert_eq!(mask.text, "fix \u{E000}\u{E001}\u{E002}\u{E003}\u{E004}\u{E005}\u{E006}\u{E007}\u{E008}\u{E009}\u{E00A} now");
        // A wide grapheme pads its placeholder with the extra-width char
        // per extra column: "@" spans one column, "\u{65E5}" spans two.
        let mask = PromptTokenMask::new("@\u{65E5}", 0, false);
        assert_eq!(mask.text, "\u{E000}\u{E001}\u{FF9E}");
        assert_eq!(
            crate::width::str_width(&mask.text),
            crate::width::str_width("@\u{65E5}"),
            "the placeholder keeps the grapheme's width for the layout"
        );
        // Zero-width graphemes stay literal.
        let mask = PromptTokenMask::new("@a\u{200B}b", 0, false);
        assert_eq!(mask.text, "\u{E000}\u{E001}\u{200B}\u{E002}");
        // Tabs expand before masking (a masked raw tab would restore into a
        // three-column layout).
        let mask = PromptTokenMask::new("a\t@b", 0, false);
        assert_eq!(mask.text, "a   \u{E000}\u{E001}");
        // The command span masks in accent first.
        let mask = PromptTokenMask::new("/hotkeys", 8, false);
        assert_eq!(
            mask.text,
            "\u{E000}\u{E001}\u{E002}\u{E003}\u{E004}\u{E005}\u{E006}\u{E007}"
        );
    }

    #[test]
    fn mask_restore_recolors_placeholders_in_place() {
        let theme = theme();
        let mask = PromptTokenMask::new("fix @Cargo.toml now", 0, false);
        // The rendered markdown line carries the placeholders; restore
        // replaces them with the graphemes in the token color and keeps
        // the surrounding span styling.
        let line: Line = vec![
            Span::styled("fix ".to_string(), Style::default()),
            Span::styled("\u{E000}\u{E001}".to_string(), Style::default()),
            Span::styled(" now".to_string(), Style::default()),
        ];
        let restored = mask.restore_line(&theme, &line);
        assert_eq!(
            restored
                .iter()
                .map(|s| (s.content.to_string(), s.style))
                .collect::<Vec<_>>(),
            vec![
                ("fix ".to_string(), Style::default()),
                ("@C".to_string(), theme.fg_style(ThemeColor::Success)),
                (" now".to_string(), Style::default()),
            ]
        );
        // Adjacent placeholders of one color restore as their graphemes;
        // a literal mask-range char (unmasked source) stays untouched.
        let mask = PromptTokenMask::new("plain \u{E123} text", 0, false);
        let line: Line = vec![Span::raw("plain \u{E123} text")];
        let restored = mask.restore_line(&theme, &line);
        assert_eq!(
            restored
                .iter()
                .map(|s| s.content.to_string())
                .collect::<Vec<_>>(),
            vec!["plain \u{E123} text".to_string()]
        );
    }

    #[test]
    fn command_token_matches_leading_slash_runs() {
        assert_eq!(
            command_token("  /new foo"),
            Some(CommandToken {
                start: 2,
                end: 6,
                name: "new".to_string()
            })
        );
        assert_eq!(
            command_token("/x"),
            Some(CommandToken {
                start: 0,
                end: 2,
                name: "x".to_string()
            })
        );
        assert_eq!(command_token("a /new"), None);
        assert_eq!(command_token("/"), None);
        assert_eq!(command_token("  / foo"), None);
    }

    #[test]
    fn editor_highlights_clip_to_the_chunk() {
        let source = "/new @docs/plan.md --draft";
        let spans = find_arg_tokens(source, 0, true);
        // A chunk starting after the @-token: only the flag token
        // intersects, at its clipped offset.
        let chunk = " --draft";
        let highlights = editor_chunk_highlights(chunk, &spans, 18, None, false, None);
        assert_eq!(
            highlights,
            vec![(1, 8, ThemeColor::MdLink)],
            "the @-token ends at the chunk start and is skipped; the flag clips in"
        );
        // The first layout line's command token highlights in accent when
        // the command takes an argument and the cursor is past it.
        let command = command_token("/new x").unwrap();
        let highlights = editor_chunk_highlights("/new x", &[], 0, Some(&command), true, Some(5));
        assert_eq!(
            highlights,
            vec![(0, 4, ThemeColor::Accent)],
            "cursor past the token keeps the accent"
        );
        // The cursor inside the token suppresses it entirely.
        let highlights = editor_chunk_highlights("/new x", &[], 0, Some(&command), true, Some(3));
        assert!(highlights.is_empty());
        // A no-argument command never highlights.
        let command = command_token("/hotkeys").unwrap();
        let highlights =
            editor_chunk_highlights("/hotkeys", &[], 0, Some(&command), false, Some(8));
        assert!(highlights.is_empty());
    }

    /// A selection range renders reversed-video, clipped to the chunk, and
    /// the cursor cell keeps its reverse on top of it.
    #[test]
    fn editor_text_spans_render_the_selection_reversed() {
        let styled = editor_text_spans(
            &theme(),
            "hello world",
            &[],
            Some((0, 5)),
            Some(7),
            Style::default(),
        );
        let reversed: Vec<(String, bool)> = styled
            .iter()
            .map(|span| {
                (
                    span.content.to_string(),
                    span.style.add_modifier.contains(Modifier::REVERSED),
                )
            })
            .collect();
        assert_eq!(
            reversed,
            vec![
                ("hello".to_string(), true),
                (" w".to_string(), false),
                ("o".to_string(), true),
                ("rld".to_string(), false),
            ]
        );
        // A selection fully past the chunk clips away entirely.
        let none = editor_text_spans(&theme(), "hi", &[], Some((9, 12)), None, Style::default());
        assert!(none.len() == 1 && !none[0].style.add_modifier.contains(Modifier::REVERSED));
    }

    #[test]
    fn editor_text_spans_carry_the_cursor_reverse() {
        let theme = theme();
        let bg = Style::default();
        // Cursor inside an accent token: the reversed cell carries accent.
        let styled = editor_text_spans(
            &theme,
            "/new",
            &[(0, 4, ThemeColor::Accent)],
            None,
            Some(2),
            bg,
        );
        assert_eq!(
            styled
                .iter()
                .map(|span| (span.content.to_string(), span.style))
                .collect::<Vec<_>>(),
            vec![
                ("/n".to_string(), accent()),
                ("e".to_string(), accent().add_modifier(Modifier::REVERSED)),
                ("w".to_string(), accent()),
            ]
        );
        // Cursor at the end: the appended reversed space stays default.
        let styled = editor_text_spans(
            &theme,
            "/new",
            &[(0, 4, ThemeColor::Accent)],
            None,
            Some(4),
            bg,
        );
        assert_eq!(
            styled
                .iter()
                .map(|span| (span.content.to_string(), span.style))
                .collect::<Vec<_>>(),
            vec![
                ("/new".to_string(), accent()),
                (" ".to_string(), bg.add_modifier(Modifier::REVERSED)),
            ]
        );
        // No highlights: a single plain run, cursor reversed over its char.
        let styled = editor_text_spans(&theme, "hello", &[], None, Some(2), bg);
        assert_eq!(
            styled
                .iter()
                .map(|span| (span.content.to_string(), span.style))
                .collect::<Vec<_>>(),
            vec![
                ("he".to_string(), bg),
                ("l".to_string(), bg.add_modifier(Modifier::REVERSED)),
                ("lo".to_string(), bg),
            ]
        );
    }
}

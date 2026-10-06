//! The editor box: the shared renderer for every editor-bearing surface (the chat's
//! prompt dock and the agents view's action composers); the surfaces compose it with
//! their own headers, placeholders, and click regions. Row shape: the top bg row (a
//! scroll indicator), the header block's two rows, the content rows, and the trailing
//! bg row (`↓ N more` once content hides below); a placeholder replaces the first
//! content row while the editor is empty.

use super::chunk_selection;
use super::flush::split_at_chars;
use super::frame::{indicator_row, pad_row};
use crate::editor::Editor;
use crate::prompt_highlight::{
    command_token, editor_chunk_highlights, editor_text_spans, find_arg_tokens, ArgTokenSpan,
};
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::{str_width, truncate_to_width};
use crate::{Line, Span};
use pa_types::slash_commands::SlashCommandRegistry;
use ratatui::style::Modifier;

pub(crate) struct EditorBox {
    /// The box's rows, top bg row first.
    pub(crate) rows: Vec<Line>,
    /// The cursor's row and column within the box; `None` while the window
    /// shows no cursor.
    pub(crate) cursor: Option<(usize, usize)>,
    /// The rows between the top row and the first content row (a header block
    /// inserts two).
    pub(crate) content_offset: usize,
    /// The rendered prompt's visible width (`> `, `! `, `!! `).
    pub(crate) prompt_width: usize,
    /// The width the editor's layout wrapped at.
    pub(crate) content_width: usize,
    pub(crate) visible_rows: usize,
}

/// Compose one editor box. `header` renders as the two-row block under the top
/// row; `placeholder` replaces the first content row while the editor is empty.
pub(crate) fn render(
    editor: &mut Editor,
    theme: &Theme,
    width: usize,
    terminal_rows: u16,
    header: Option<Line>,
    placeholder: Option<&str>,
) -> EditorBox {
    let bg = crate::chrome::editor_background(theme);
    let border = theme.fg_style(ThemeColor::BorderMuted);
    let padding_x = 2usize;
    let content_width = width.saturating_sub(padding_x * 2).max(1);
    // A bang first line swaps the `> ` for the `! `/`!! ` prompt (styled through
    // the editor border color), which also narrows the input width.
    let bash_prompt = editor.bash_prompt_prefix();
    let prompt = bash_prompt.unwrap_or("> ");
    let prompt_width = str_width(prompt);
    let input_width = content_width.saturating_sub(prompt_width).max(1);
    let layout_width = input_width;
    let (visible, scroll_offset, _hidden_above, hidden_below) =
        editor.visible_window(layout_width, terminal_rows);
    let content_offset = usize::from(header.is_some()) * 2;
    let mut rows: Vec<Line> = Vec::new();
    if scroll_offset > 0 {
        let indicator = format!(" \u{2191} {scroll_offset} more");
        rows.push(indicator_row(&indicator, bg, border, width));
    } else {
        rows.push(vec![Span::styled(" ".repeat(width), bg)]);
    }
    // The header block: the caller's line on the editor background plus its
    // empty companion row — the box grows by two rows while a header shows, and
    // the click regions shift with it.
    if let Some(header) = header {
        let mut row: Line = vec![Span::styled(" ".repeat(padding_x), bg)];
        row.extend(crate::width::truncate_line(&header, content_width, "..."));
        let used = crate::width::line_width(&row);
        row.push(Span::styled(" ".repeat(width.saturating_sub(used)), bg));
        rows.push(row);
        rows.push(vec![Span::styled(" ".repeat(width), bg)]);
    }
    // A bare `--` separator highlights only while the first line opens with an
    // argument-taking slash command.
    let selection = editor.selection_range();
    let editor_lines = editor.get_lines();
    let registry = SlashCommandRegistry::builtin_cached();
    let include_bare_separator = editor_lines
        .first()
        .and_then(|first| command_token(first))
        .is_some_and(|token| registry.takes_argument(&token.name));
    let arg_token_spans: Vec<Vec<ArgTokenSpan>> = editor_lines
        .iter()
        .map(|line| find_arg_tokens(line, 0, include_bare_separator))
        .collect();
    let mut cursor: Option<(usize, usize)> = None;
    // The placeholder row: while the editor is empty, the first content row is
    // the cursor cell followed by the dim placeholder.
    let placeholder_row = placeholder.filter(|_| editor.get_text().is_empty());
    for (index, line) in visible.iter().enumerate() {
        if index == 0 && placeholder_row.is_some() {
            let mut row: Line = vec![Span::styled(" ".to_string(), bg)];
            let style = if bash_prompt.is_some() { border } else { bg };
            row.push(Span::styled(prompt.to_string(), style));
            row.push(Span::styled(" ".to_string(), bg));
            let placeholder_width = input_width.saturating_sub(1);
            let text = truncate_to_width(placeholder_row.unwrap_or(""), placeholder_width, "");
            let fill = " ".repeat(placeholder_width.saturating_sub(str_width(&text)));
            row.push(Span::styled(
                " ".to_string(),
                bg.add_modifier(Modifier::REVERSED),
            ));
            row.push(Span::styled(
                text,
                bg.patch(theme.fg_style(ThemeColor::Dim)),
            ));
            row.push(Span::styled(fill, bg));
            row.push(Span::styled(" ".repeat(padding_x), bg));
            rows.push(row);
            cursor = Some((1 + content_offset, prompt_width + 2));
            continue;
        }
        let mut row: Line = vec![Span::styled(" ".to_string(), bg)];
        if index == 0 {
            let style = if bash_prompt.is_some() { border } else { bg };
            row.push(Span::styled(prompt.to_string(), style));
        } else {
            row.push(Span::styled(" ".repeat(prompt_width), bg));
        }
        row.push(Span::styled(" ".to_string(), bg));
        let text: &str = &line.text;
        let cursor_pos = line
            .has_cursor
            .then(|| line.cursor_pos.min(text.chars().count()));
        // The prompt-highlight spans of this chunk: argument tokens, and the
        // command token of the first layout line in accent unless the cursor
        // sits inside it.
        let command = (scroll_offset + index == 0)
            .then(|| command_token(text))
            .flatten();
        let highlights = editor_chunk_highlights(
            text,
            arg_token_spans
                .get(line.source_line)
                .map_or(&[][..], |spans| spans),
            line.source_start,
            command.as_ref(),
            cursor_pos,
        );
        row.extend(editor_text_spans(
            theme,
            text,
            &highlights,
            chunk_selection(selection, line.source_line, line.source_start, text),
            cursor_pos,
            bg,
        ));
        let mut used = str_width(text);
        if cursor_pos == Some(text.chars().count()) {
            // The end-of-line cursor appends one reversed cell.
            used += 1;
        }
        if let Some(position) = cursor_pos {
            let head = split_at_chars(text, position).0;
            cursor = Some((
                1 + content_offset + index,
                str_width(head) + prompt_width + 2,
            ));
        }
        row.push(Span::styled(
            " ".repeat(input_width.saturating_sub(used)),
            bg,
        ));
        row.push(Span::styled(" ".repeat(padding_x), bg));
        rows.push(row);
    }
    if hidden_below > 0 {
        rows.push(indicator_row(
            &format!(" \u{2193} {hidden_below} more"),
            bg,
            border,
            width,
        ));
    } else {
        rows.push(vec![Span::styled(" ".repeat(width), bg)]);
    }
    EditorBox {
        rows,
        cursor,
        content_offset,
        prompt_width,
        content_width: layout_width,
        visible_rows: visible.len(),
    }
}

/// The autocomplete dropdown, mounted just above the editor surface. The panel
/// opens with the one full-width muted rule every inline menu panel opens with (the
/// operator's 2026-09-26 top-border directive), its rows float on the popup
/// background, and the selected row's wash spans the panel's full width.
pub(crate) fn overlay(editor: &Editor, theme: &Theme, width: usize) -> Vec<Line> {
    let Some(state) = editor.autocomplete_state() else {
        return Vec::new();
    };
    let bg = theme.bg_style(ThemeBg::ToolPanelBg);
    let selection = theme.soft_selection_style();
    let padding_x = 2usize;
    // The overlay anchors against the live prompt prefix (the `!`/`!!` prompts
    // included).
    let prompt_width = str_width(editor.bash_prompt_prefix().unwrap_or("> "));
    let content_width = width.saturating_sub(padding_x * 2).max(1);
    let input_width = content_width.saturating_sub(prompt_width).max(1);
    let border = theme.fg_style(ThemeColor::BorderMuted).patch(bg);
    let mut rows: Vec<Line> = vec![vec![Span::styled("\u{2500}".repeat(width.max(1)), border)]];
    let mut overlay = Vec::new();
    overlay.extend(state.render(theme, input_width));
    overlay.push(Vec::new());
    for mut line in overlay {
        // The shared menu rows pad with unstyled spans, so the popup background
        // must ride on every span the row left unstyled. The selected row's edge
        // padding washes with the selection too, so the band spans the panel's full
        // width.
        let selected = line.iter().any(|span| span.style.bg.is_some());
        for span in &mut line {
            if span.style.bg.is_none() {
                span.style = span.style.patch(bg);
            }
        }
        let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
        let edge = if selected { bg.patch(selection) } else { bg };
        let mut row: Line = vec![Span::styled(" ".repeat(padding_x + prompt_width), edge)];
        row.extend(line);
        row.push(Span::styled(
            " ".repeat(input_width.saturating_sub(used)),
            edge,
        ));
        row.push(Span::styled(" ".repeat(padding_x), edge));
        rows.push(pad_row(row, width));
    }
    rows
}

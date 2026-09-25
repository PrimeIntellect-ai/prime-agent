//! The `ipython` tool-call card, a port of the TS `ipython-cell.ts`:
//! a fixed collapsed summary line (marker, language, preview, line counts,
//! duration, error name) plus, in the expanded conversation-detail mode,
//! the full cell source and its output below. The top line never changes
//! with expansion, so toggling detail never shifts the layout.

mod output;

use output::render_output;
use serde_json::Value;

use super::ipython_details::{
    format_duration, is_agent_message_receipt, is_edit_confirmation, parse_sent_agent_message,
    read_background_shell, BackgroundShell, IpythonDetails, IpythonError,
};
use super::layout::RowOutput;
use super::{highlight, ToolCallCard};
use crate::chat::Detail;
use crate::code_preview::{
    parse_ipython_bash_cell, preview_ipython_code, python_statement_lines, CodePreviewLanguage,
};
use crate::custom_message::AgentMessageDirection;
use crate::error_summary::{normalize_error_details, summarize_error_details};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, wrap_line};
use crate::{Line, Span};

/// The output continuation indent (TS `OUTPUT_INDENT`).
const OUTPUT_INDENT: &str = "   ";

/// The card status (TS `statusKind`).
enum CardStatus {
    Queued,
    Running,
    Done,
    Error,
    Aborted,
}

impl CardStatus {
    fn of(card: &ToolCallCard, details: &IpythonDetails) -> CardStatus {
        let result = card.result.as_ref();
        let is_error = result.is_some_and(|r| r.is_error);
        if !card.result_partial {
            if let Some(background) =
                result.and_then(|r| read_background_shell(cell_code(card), &r.details))
            {
                return match background.exit_code {
                    Some(0) => CardStatus::Done,
                    Some(_) => CardStatus::Error,
                    None => CardStatus::Running,
                };
            }
        }
        let status = details.status.as_deref();
        if is_error || status == Some("error") {
            return CardStatus::Error;
        }
        if status == Some("aborted") {
            return CardStatus::Aborted;
        }
        let has_result = result.is_some_and(|r| {
            details.stdout.is_some()
                || details.stderr.is_some()
                || details.result.is_some()
                || details.error.is_some()
                || !details.diffs.is_empty()
                || !details.sent_agent_messages.is_empty()
                || !r.content.is_empty()
        });
        if !card.result_partial && (status.is_some() || card.started || has_result) {
            return CardStatus::Done;
        }
        if card.result_partial || card.started {
            CardStatus::Running
        } else {
            CardStatus::Queued
        }
    }
}

/// Whether the cell's final result carries a still-running background
/// shell (the renderer's own `Running` case): the cell itself settled,
/// but the spawned shell keeps working - a condensed run containing
/// such a card is live (its block animates and the wall-clock runs on).
pub(crate) fn background_shell_running(card: &ToolCallCard) -> bool {
    if card.result_partial {
        return false;
    }
    card.result
        .as_ref()
        .and_then(|result| read_background_shell(cell_code(card), &result.details))
        .is_some_and(|background| background.exit_code.is_none())
}

fn cell_code(card: &ToolCallCard) -> &str {
    card.args
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Render the ipython cell card: the fixed summary line, then the expanded
/// code and output rows when conversation detail is `all`.
pub fn render(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> Vec<Line> {
    let mut lines = RowOutput::paint();
    layout(card, frame, detail, theme, width, show_images, &mut lines);
    lines.into_lines()
}

pub(super) fn count(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> usize {
    let mut lines = RowOutput::count();
    layout(card, frame, detail, theme, width, show_images, &mut lines);
    lines.len()
}

fn layout(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
    lines: &mut RowOutput,
) {
    let code = cell_code(card).trim_end();
    let details = card.result.as_ref().map_or_else(
        || IpythonDetails::parse(&Value::Null),
        |result| IpythonDetails::parse(&result.details),
    );
    let background = card
        .result
        .as_ref()
        .and_then(|result| read_background_shell(code, &result.details));

    // The top line is identical collapsed or expanded, so detail toggles
    // never shift the layout or indentation.
    lines.push(|| {
        collapsed_line(
            card,
            &details,
            background.as_ref(),
            frame,
            theme,
            width,
            code,
        )
    });
    // TS renders the sent-message receipt rows below the code (and below
    // the diff rows, which this card does not render) even when the cell
    // is collapsed; the body opens up only when expanded.
    if !detail.tool_output_expanded() {
        render_sent_agent_messages(lines, &details, false, theme, width);
        return;
    }
    let has_code = render_code(lines, code, theme, width);
    render_sent_agent_messages(lines, &details, true, theme, width);
    render_output(card, &details, lines, has_code, show_images, theme, width);
    // Image blocks render below the card when shown (TS the
    // `N images rendered below` note refers to these rows, which
    // `tool-execution.ts` adds for every tool shell).
    lines.images(&card.result, show_images, theme);
}

/// The fixed marker + summary line (TS `collapsedLine`).
fn collapsed_line(
    card: &ToolCallCard,
    details: &IpythonDetails,
    background: Option<&BackgroundShell>,
    frame: usize,
    theme: &Theme,
    width: usize,
    code: &str,
) -> Line {
    let muted = theme.fg_style(ThemeColor::Muted);
    let dim = theme.fg_style(ThemeColor::Dim);
    let error = theme.fg_style(ThemeColor::Error);
    let warning = theme.fg_style(ThemeColor::Warning);
    let success = theme.fg_style(ThemeColor::Success);
    let bash_mode = theme.fg_style(ThemeColor::BashMode);

    let preview = preview_ipython_code(code);
    let is_bash_cell = parse_ipython_bash_cell(code).is_some();
    let language_label = match (is_bash_cell, &preview.language) {
        (true, CodePreviewLanguage::Python) => "bash \u{00b7} python".to_string(),
        (true | false, CodePreviewLanguage::Bash) => "bash".to_string(),
        (false, CodePreviewLanguage::Python) => "python".to_string(),
    };

    let marker: Line = match CardStatus::of(card, details) {
        CardStatus::Error => vec![Span::styled("\u{2717}".to_string(), error)],
        CardStatus::Aborted => vec![Span::styled("\u{2717}".to_string(), warning)],
        CardStatus::Done => vec![Span::styled("\u{2713}".to_string(), success)],
        CardStatus::Running => vec![Span::styled(
            super::working_icon(frame).to_string(),
            bash_mode,
        )],
        CardStatus::Queued => vec![Span::styled("\u{25c7}".to_string(), muted)],
    };

    let mut parts: Vec<Line> = Vec::new();
    let mut marker = marker;
    marker.push(Span::raw(" "));
    marker.push(Span::styled(language_label, muted));
    parts.push(marker);
    if !preview.text.is_empty() {
        parts.push(vec![Span::styled(preview.text, dim)]);
    } else if !card.started {
        parts.push(vec![Span::styled("waiting for code".to_string(), dim)]);
    }
    if let Some(counts) = line_counts(card, details, code) {
        parts.push(vec![Span::styled(counts, dim)]);
    }
    if let Some(duration) = details.duration_ms {
        let label = if background.is_some() {
            format!("cell {}", format_duration(duration))
        } else {
            format_duration(duration)
        };
        parts.push(vec![Span::styled(label, dim)]);
    }
    if !card.result_partial {
        let error_name = details
            .error
            .as_ref()
            .map(|e| e.ename.clone())
            .or_else(|| details.error_ename.clone());
        if let Some(ename) = error_name {
            parts.push(vec![Span::styled(ename, error)]);
        }
    }
    if let Some(exit_code) = background.and_then(|shell| shell.exit_code) {
        if exit_code != 0 {
            parts.push(vec![Span::styled(format!("exit {exit_code}"), error)]);
        }
    }

    let mut row: Line = vec![Span::raw(" ")];
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            row.push(Span::styled(" \u{00b7} ".to_string(), dim));
        }
        row.extend(part.iter().cloned());
    }
    truncate_line(&row, width, "")
}

/// `\u{2191}in \u{2193}out lines` (TS `lineCounts`): non-empty input
/// lines, output lines from the structured fields (edits show the diff, so
/// their output counts zero).
fn line_counts(card: &ToolCallCard, details: &IpythonDetails, code: &str) -> Option<String> {
    let body = parse_ipython_bash_cell(code).map_or_else(|| code.to_string(), |cell| cell.body);
    let input = body.lines().filter(|line| !line.trim().is_empty()).count();
    let has_diffs = !details.diffs.is_empty();

    let result =
        if is_agent_message_receipt(details.result.as_deref(), &details.sent_agent_messages) {
            None
        } else {
            details.result.as_deref()
        };
    let structured = [
        details.stdout.as_deref(),
        details.stderr.as_deref(),
        result,
        details.background_output.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|text| !text.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let blocks_text = text_from_blocks(card);
    let fallback =
        if is_agent_message_receipt(Some(blocks_text.as_str()), &details.sent_agent_messages) {
            String::new()
        } else {
            blocks_text
        };
    let output_text = if structured.trim().is_empty() {
        fallback
    } else {
        structured
    };
    let output = if has_diffs || output_text.trim().is_empty() {
        0
    } else {
        output_text.trim().lines().count()
    };

    let mut segments: Vec<String> = Vec::new();
    if input > 0 {
        segments.push(format!("\u{2191} {input}"));
    }
    if output > 0 {
        segments.push(format!("\u{2193} {output}"));
    }
    if segments.is_empty() {
        None
    } else {
        Some(format!("{} lines", segments.join(" ")))
    }
}

/// The text of the result's text blocks (TS `textFromBlocks`).
fn text_from_blocks(card: &ToolCallCard) -> String {
    card.result
        .as_ref()
        .map(|result| {
            result
                .content
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .map(|block| {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// `True` when the line is a magic `!command` line (TS `MAGIC_LINE_PATTERN`).
fn is_magic_line(statement: &str) -> bool {
    statement.trim_start().starts_with('!')
}

/// The expanded source rows (TS `renderCode`): the first line guttered
/// `\u{2570}\u{2500}`, continuation lines indented; bash cells and magic
/// lines render in bashMode, python lines syntax highlighted.
fn render_code(lines: &mut RowOutput, code: &str, theme: &Theme, width: usize) -> bool {
    if code.is_empty() {
        add_wrapped(
            lines,
            vec![Span::styled(
                "\u{2570}\u{2500} ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            )],
            vec![Span::styled(
                "waiting for code".to_string(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        );
        return false;
    }
    let is_bash_cell = parse_ipython_bash_cell(code).is_some();
    let raw_lines: Vec<&str> = code.split('\n').collect();
    let highlighted = if is_bash_cell {
        Vec::new()
    } else {
        highlight::highlight_python(code, &highlight::SyntaxPalette::from_theme(theme))
    };
    let statements = python_statement_lines(code);
    for (index, raw_line) in raw_lines.iter().enumerate() {
        let prefix: Line = if index == 0 {
            vec![Span::styled(
                "\u{2570}\u{2500} ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            )]
        } else {
            vec![Span::raw(OUTPUT_INDENT)]
        };
        let statement = statements.get(index).cloned().unwrap_or_default();
        let magic = is_magic_line(&statement) || parse_ipython_bash_cell(&statement).is_some();
        let body: Line = if is_bash_cell || magic {
            vec![Span::styled(
                (*raw_line).to_string(),
                theme.fg_style(ThemeColor::BashMode),
            )]
        } else {
            highlighted.get(index).cloned().unwrap_or_else(|| {
                vec![Span::styled(
                    (*raw_line).to_string(),
                    theme.fg_style(ThemeColor::MdCodeBlock),
                )]
            })
        };
        let body = if body.is_empty() {
            vec![Span::raw(" ")]
        } else {
            body
        };
        add_wrapped(lines, prefix, body, width);
    }
    true
}

/// TS `renderSentAgentMessages`: one summary row per sent receipt below
/// the code (blank-separated when expanded), the `╰─`-guttered body only
/// in the expanded view. The summary carries no body preview (the TS
/// sent rows are the receipt summary alone).
fn render_sent_agent_messages(
    lines: &mut RowOutput,
    details: &IpythonDetails,
    expanded: bool,
    theme: &Theme,
    width: usize,
) {
    for sent in &details.sent_agent_messages {
        let Some(sent) = parse_sent_agent_message(sent) else {
            continue;
        };
        if expanded {
            lines.blank();
        }
        let direction = if sent.delivered {
            AgentMessageDirection::Sent
        } else {
            AgentMessageDirection::Queued
        };
        // TS: truncateToWidth(summary, max(1, width - 1), "…") then the
        // one-space `addPlain` margin.
        lines.push(|| {
            let summary = crate::custom_message::render::agent_message_summary_line(
                direction,
                &sent.participant,
                None,
                theme,
            );
            let mut row: Line = vec![Span::raw(" ")];
            row.extend(truncate_line(
                &summary,
                width.saturating_sub(1).max(1),
                "\u{2026}",
            ));
            row
        });
        if expanded {
            if lines.is_counting() {
                lines.add_count(crate::custom_message::agent_message_body_count(
                    &sent.message,
                    width,
                ));
            } else {
                for row in
                    crate::custom_message::render::agent_message_body(&sent.message, theme, width)
                {
                    lines.push(|| row);
                }
            }
        }
    }
}

/// One indented card row (TS `addWrapped`): the first wrapped row carries
/// `prefix`, continuation rows the matching indent; each row is truncated
/// to the width so a narrow pane cannot overflow.
fn add_wrapped(lines: &mut RowOutput, prefix: Line, body: Line, width: usize) {
    let prefix_width: usize = prefix.iter().map(|s| str_width(&s.content)).sum();
    let available = width.saturating_sub(1 + prefix_width).max(1);
    if lines.is_counting() {
        lines.add_count(crate::width::wrapped_line_count(&body, available).max(1));
        return;
    }
    let wrapped = wrap_line(&body, available);
    let mut rows: Vec<Line> = Vec::new();
    if wrapped.is_empty() {
        rows.push(Vec::new());
    } else {
        rows.extend(wrapped);
    }
    for (index, mut row) in rows.into_iter().enumerate() {
        let mut line: Line = vec![Span::raw(" ")];
        if index == 0 {
            line.extend(prefix.iter().cloned());
        } else {
            line.push(Span::raw(" ".repeat(prefix_width)));
        }
        line.append(&mut row);
        lines.push(|| truncate_line(&line, width, ""));
    }
}

#[cfg(test)]
mod tests;

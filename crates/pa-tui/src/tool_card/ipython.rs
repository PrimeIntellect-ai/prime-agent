//! The `ipython` tool-call card, a port of the TS `ipython-cell.ts`:
//! a fixed collapsed summary line (marker, language, preview, line counts,
//! duration, error name) plus, in the expanded conversation-detail mode,
//! the full cell source and its output below. The top line never changes
//! with expansion, so toggling detail never shifts the layout.

use serde_json::Value;

use super::ipython_details::{
    format_duration, is_agent_message_receipt, is_edit_confirmation, parse_sent_agent_message,
    read_background_shell, BackgroundShell, IpythonDetails, IpythonError,
};
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
    let code = cell_code(card).trim_end();
    let details = card
        .result
        .as_ref()
        .map(|result| IpythonDetails::parse(&result.details))
        .unwrap_or_else(|| IpythonDetails::parse(&Value::Null));
    let background = card
        .result
        .as_ref()
        .and_then(|result| read_background_shell(code, &result.details));

    // The top line is identical collapsed or expanded, so detail toggles
    // never shift the layout or indentation.
    let mut lines = vec![collapsed_line(
        card,
        &details,
        background.as_ref(),
        frame,
        theme,
        width,
        code,
    )];
    // TS renders the sent-message receipt rows below the code (and below
    // the diff rows, which this card does not render) even when the cell
    // is collapsed; the body opens up only when expanded.
    if !detail.tool_output_expanded() {
        render_sent_agent_messages(&mut lines, &details, false, theme, width);
        return lines;
    }
    let has_code = render_code(&mut lines, code, theme, width);
    render_sent_agent_messages(&mut lines, &details, true, theme, width);
    render_output(
        card,
        &details,
        &mut lines,
        has_code,
        show_images,
        theme,
        width,
    );
    // Image blocks render below the card when shown (TS the
    // `N images rendered below` note refers to these rows, which
    // `tool-execution.ts` adds for every tool shell).
    lines.extend(super::image_rows(&card.result, show_images, theme));
    lines
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
        (true, CodePreviewLanguage::Bash) => "bash".to_string(),
        (false, CodePreviewLanguage::Bash) => "bash".to_string(),
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
    let body = parse_ipython_bash_cell(code)
        .map(|cell| cell.body)
        .unwrap_or_else(|| code.to_string());
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
fn render_code(lines: &mut Vec<Line>, code: &str, theme: &Theme, width: usize) -> bool {
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
    lines: &mut Vec<Line>,
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
            lines.push(Vec::new());
        }
        let direction = if sent.delivered {
            AgentMessageDirection::Sent
        } else {
            AgentMessageDirection::Queued
        };
        // TS: truncateToWidth(summary, max(1, width - 1), "…") then the
        // one-space `addPlain` margin.
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
        lines.push(row);
        if expanded {
            lines.extend(crate::custom_message::render::agent_message_body(
                &sent.message,
                theme,
                width,
            ));
        }
    }
}

/// `splitTraceback`: the lines before the traceback opener are ordinary
/// output; the rest is the traceback proper.
fn split_traceback(text: &str, error_name: Option<&str>) -> Option<(String, String)> {
    let normalized = normalize_error_details(text);
    if normalized.trim().is_empty() {
        return None;
    }
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut traceback_index = lines
        .iter()
        .position(|line| line.contains("Traceback (most recent call last):"));
    if traceback_index.is_none() {
        if let Some(error_name) = error_name {
            traceback_index = lines
                .iter()
                .position(|line| line.trim_start().starts_with(&format!("{error_name}:")));
        }
    }
    let traceback_index = traceback_index?;
    let output = lines[..traceback_index].join("\n").trim_end().to_string();
    let traceback = lines[traceback_index..].join("\n").trim().to_string();
    Some((output, traceback))
}

/// The error summary line for a cell that failed without a traceback (TS
/// `formatIpythonErrorSummary`).
fn format_ipython_error_summary(error: &IpythonError) -> String {
    let normalized_value = normalize_error_details(&error.evalue);
    if normalized_value.trim().is_empty() {
        return error.ename.clone();
    }
    let value = summarize_error_details(&normalized_value);
    if value == "Error" {
        return error.ename.clone();
    }
    if str_width(&value) <= 48 {
        format!("{}: {value}", error.ename)
    } else {
        error.ename.clone()
    }
}

/// The expanded output rows (TS `renderOutput`).
fn render_output(
    card: &ToolCallCard,
    details: &IpythonDetails,
    lines: &mut Vec<Line>,
    has_code: bool,
    show_images: bool,
    theme: &Theme,
    width: usize,
) {
    let blocks = card
        .result
        .as_ref()
        .map(|result| &result.content)
        .cloned()
        .unwrap_or_default();
    let text = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .map(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join("\n");
    let image_count = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        .count();
    let is_error = card.result.as_ref().is_some_and(|r| r.is_error);
    let has_structured_output = details.stdout.is_some()
        || details.stderr.is_some()
        || details.result.is_some()
        || details.error.is_some();
    let traceback =
        if !has_structured_output && (is_error || details.status.as_deref() == Some("error")) {
            split_traceback(&text, details.error_ename.as_deref())
        } else {
            None
        };

    let mut output_started = false;
    let mut output_marker_pending = true;
    let mut rendered_text_output = false;
    let output_prefix = |output_marker_pending: &mut bool| -> Line {
        if *output_marker_pending {
            *output_marker_pending = false;
            vec![Span::styled(
                " \u{203a} ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            )]
        } else {
            vec![Span::raw(OUTPUT_INDENT)]
        }
    };
    let start_output = |output_started: &mut bool, lines: &mut Vec<Line>| {
        if *output_started {
            return;
        }
        *output_started = true;
        if has_code {
            lines.push(Vec::new());
        }
    };

    if has_structured_output {
        if details
            .stdout
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
            && !is_edit_confirmation(details.stdout.as_deref(), &details.diffs)
        {
            start_output(&mut output_started, lines);
            rendered_text_output = true;
            render_output_text(
                lines,
                &normalize_error_details(details.stdout.as_deref().unwrap_or_default()),
                OutputLabel::Out,
                &mut output_marker_pending,
                theme,
                width,
            );
        }
        if details
            .stderr
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
        {
            start_output(&mut output_started, lines);
            rendered_text_output = true;
            render_output_text(
                lines,
                &normalize_error_details(details.stderr.as_deref().unwrap_or_default()),
                OutputLabel::Err,
                &mut output_marker_pending,
                theme,
                width,
            );
        }
        let result_text = details.result.as_deref().filter(|s| !s.trim().is_empty());
        if let Some(result) = result_text {
            if !is_edit_confirmation(details.result.as_deref(), &details.diffs)
                && !is_agent_message_receipt(
                    details.result.as_deref(),
                    &details.sent_agent_messages,
                )
            {
                start_output(&mut output_started, lines);
                rendered_text_output = true;
                render_output_text(
                    lines,
                    &normalize_error_details(result),
                    OutputLabel::Out,
                    &mut output_marker_pending,
                    theme,
                    width,
                );
            }
        }
    } else if let Some((output, _)) = &traceback {
        if !output.is_empty() {
            start_output(&mut output_started, lines);
            rendered_text_output = true;
            render_output_text(
                lines,
                output,
                OutputLabel::Out,
                &mut output_marker_pending,
                theme,
                width,
            );
        }
    } else if !text.trim().is_empty()
        && !is_agent_message_receipt(Some(text.as_str()), &details.sent_agent_messages)
    {
        start_output(&mut output_started, lines);
        rendered_text_output = true;
        let label = if is_error {
            OutputLabel::Err
        } else {
            OutputLabel::Out
        };
        render_output_text(
            lines,
            &normalize_error_details(&text),
            label,
            &mut output_marker_pending,
            theme,
            width,
        );
    }

    // Background output rides the structured fields only (the fallback
    // text above already carries it otherwise).
    let background_output = if has_structured_output {
        details
            .background_output
            .as_deref()
            .filter(|text| !text.trim().is_empty())
    } else {
        None
    };
    if background_output.is_some() {
        rendered_text_output = true;
    }

    if !rendered_text_output && card.result_partial {
        start_output(&mut output_started, lines);
        let prefix = output_prefix(&mut output_marker_pending);
        add_wrapped(
            lines,
            prefix,
            vec![Span::styled(
                "waiting for output...".to_string(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        );
    } else if !rendered_text_output
        && traceback.is_none()
        && details.error.is_none()
        && details.diffs.is_empty()
        && details.sent_agent_messages.is_empty()
        && card.started
        && image_count == 0
    {
        start_output(&mut output_started, lines);
        let prefix = output_prefix(&mut output_marker_pending);
        add_wrapped(
            lines,
            prefix,
            vec![Span::styled(
                "no output".to_string(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        );
    }

    if let Some(error) = &details.error {
        start_output(&mut output_started, lines);
        let traceback_text = if !error.traceback.is_empty() {
            error.traceback.join("\n")
        } else {
            format_ipython_error_summary(error)
        };
        render_output_text(
            lines,
            &traceback_text,
            OutputLabel::Err,
            &mut output_marker_pending,
            theme,
            width,
        );
    } else if let Some((_, traceback)) = &traceback {
        start_output(&mut output_started, lines);
        render_output_text(
            lines,
            traceback,
            OutputLabel::Err,
            &mut output_marker_pending,
            theme,
            width,
        );
    }

    if let Some(background) = background_output {
        start_output(&mut output_started, lines);
        let prefix = output_prefix(&mut output_marker_pending);
        add_wrapped(
            lines,
            prefix,
            vec![Span::styled(
                "background output (unattributed)".to_string(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        );
        render_output_text(
            lines,
            &normalize_error_details(background),
            OutputLabel::Err,
            &mut output_marker_pending,
            theme,
            width,
        );
    }

    if image_count > 0 {
        start_output(&mut output_started, lines);
        let noun = if image_count == 1 { "image" } else { "images" };
        let text = if show_images {
            format!("{image_count} {noun} rendered below")
        } else {
            format!("{image_count} {noun} hidden")
        };
        let prefix = output_prefix(&mut output_marker_pending);
        add_wrapped(
            lines,
            prefix,
            vec![Span::styled(text, theme.fg_style(ThemeColor::Muted))],
            width,
        );
    }
}

enum OutputLabel {
    Out,
    Err,
}

/// One output section: `out` lines in toolOutput, `err` lines muted
/// (stderr and tracebacks), the first line marked `\u{203a}`.
fn render_output_text(
    lines: &mut Vec<Line>,
    text: &str,
    label: OutputLabel,
    output_marker_pending: &mut bool,
    theme: &Theme,
    width: usize,
) {
    let color = match label {
        OutputLabel::Out => ThemeColor::ToolOutput,
        OutputLabel::Err => ThemeColor::Muted,
    };
    let style = theme.fg_style(color);
    for line in text.split('\n') {
        let prefix = if *output_marker_pending {
            *output_marker_pending = false;
            vec![Span::styled(
                " \u{203a} ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            )]
        } else {
            vec![Span::raw(OUTPUT_INDENT)]
        };
        // Blank rows render one styled space (TS `theme.fg(color, line || " ")`).
        let body = vec![Span::styled(
            if line.is_empty() { " " } else { line }.to_string(),
            style,
        )];
        add_wrapped(lines, prefix, body, width);
    }
}

/// One indented card row (TS `addWrapped`): the first wrapped row carries
/// `prefix`, continuation rows the matching indent; each row is truncated
/// to the width so a narrow pane cannot overflow.
fn add_wrapped(lines: &mut Vec<Line>, prefix: Line, body: Line, width: usize) {
    let prefix_width: usize = prefix.iter().map(|s| str_width(&s.content)).sum();
    let available = width.saturating_sub(1 + prefix_width).max(1);
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
        lines.push(truncate_line(&line, width, ""));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};
    use serde_json::json;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn cell_card(code: &str, details: Value, is_error: bool, partial: bool) -> ToolCallCard {
        ToolCallCard {
            id: "toolu_1".into(),
            name: "ipython".into(),
            args: json!({ "code": code }),
            started: true,
            result: Some(super::super::ToolResultView {
                content: vec![],
                details,
                is_error,
            }),
            result_partial: partial,
            ..Default::default()
        }
    }

    fn text_of(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect()
    }

    #[test]
    fn done_cell_summary_line() {
        let card = cell_card(
            "print('visual parity ok')",
            json!({
                "status": "ok",
                "durationMs": 2,
                "stdout": "visual parity ok\n",
            }),
            false,
            false,
        );
        let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
        assert_eq!(lines.len(), 1);
        let text = text_of(&lines[0]);
        assert!(
            text.contains("\u{2713} python \u{00b7} print('visual parity ok') \u{00b7} \u{2191} 1 \u{2193} 1 lines \u{00b7} 2ms"),
            "got: {text}"
        );
    }

    #[test]
    fn error_cell_summary_line() {
        let card = cell_card(
            "raise ValueError('boom')",
            json!({
                "status": "error",
                "error": { "ename": "ValueError", "evalue": "boom", "traceback": [] },
            }),
            true,
            false,
        );
        let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
        let text = text_of(&lines[0]);
        assert!(text.contains("\u{2717} python"), "got: {text}");
        assert!(text.contains("ValueError"), "got: {text}");
    }

    #[test]
    fn expanded_renders_code_and_output() {
        let card = cell_card(
            "for i in range(3):\n    print(f'line {i}')",
            json!({
                "status": "ok",
                "durationMs": 3,
                "stdout": "line 0\nline 1\nline 2\n",
            }),
            false,
            false,
        );
        let lines = render(&card, 0, Detail::All, &theme(), 100, true);
        let flat: Vec<String> = lines.iter().map(text_of).collect();
        assert!(
            flat[1].starts_with(" \u{2570}\u{2500} for i in range(3):"),
            "got: {flat:?}"
        );
        assert!(
            flat[2].starts_with("        print(f'line {i}')"),
            "got: {flat:?}"
        );
        assert_eq!(flat[3], "", "blank between code and output");
        assert!(flat[4].starts_with("  \u{203a} line 0"), "got: {flat:?}");
        assert!(flat[5].starts_with("    line 1"), "got: {flat:?}");
    }

    #[test]
    fn expanded_error_cell_shows_traceback() {
        let card = cell_card(
            "raise ValueError('boom')",
            json!({
                "status": "error",
                "error": {
                    "ename": "ValueError",
                    "evalue": "boom",
                    "traceback": ["Traceback (most recent call last):", "ValueError: boom"],
                },
            }),
            true,
            false,
        );
        let lines = render(&card, 0, Detail::All, &theme(), 100, true);
        let flat: Vec<String> = lines.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|row| row.contains("ValueError: boom")),
            "got: {flat:?}"
        );
    }

    #[test]
    fn sent_agent_messages_render_below_the_code() {
        // TS `renderSentAgentMessages`: the receipt summary renders below
        // the code with a blank separator, the body opens up in the
        // expanded view.
        let details = json!({
            "status": "ok",
            "durationMs": 3,
            "sentAgentMessages": [{
                "id": "agentmsg_1",
                "message": "Ping.\nThen report back.",
                "deliveryStatus": "delivered",
                "receiverRole": "parent",
                "target": {
                    "activeSessionId": "worker-active",
                    "sessionId": "worker-session",
                    "sessionName": "Worker",
                },
            }],
        });
        let card = cell_card(
            "await agent_message.send(\"Ping.\", receiver_role=\"parent\")",
            details,
            false,
            false,
        );
        let collapsed = render(&card, 0, Detail::Overview, &theme(), 100, true);
        let flat: Vec<String> = collapsed.iter().map(text_of).collect();
        assert_eq!(flat.len(), 2, "top line + receipt summary: {flat:?}");
        assert!(
            flat[1]
                .trim_end()
                .starts_with(" \u{25c6} Agent message sent \u{b7} to parent Worker"),
            "got: {flat:?}"
        );
        assert!(!flat[1].contains("Ping."), "no body when collapsed");

        let expanded = render(&card, 0, Detail::All, &theme(), 100, true);
        let flat: Vec<String> = expanded.iter().map(text_of).collect();
        let summary = flat
            .iter()
            .position(|row| row.contains("Agent message sent"))
            .expect("summary row");
        assert_eq!(flat[summary - 1], "", "blank between code and receipt");
        assert_eq!(
            flat[summary].trim_end(),
            " \u{25c6} Agent message sent \u{b7} to parent Worker"
        );
        assert_eq!(flat[summary + 1], " \u{2570}\u{2500} Ping.");
        assert_eq!(flat[summary + 2], "    Then report back.");
        // The summary carries no body preview and no receipt metadata.
        assert!(!flat.iter().any(|row| row.contains("agentmsg_1")));
        assert!(!flat.iter().any(|row| row.contains("deliveryStatus")));
    }

    #[test]
    fn sent_agent_message_labels_and_participant_fallbacks() {
        // TS: queued receipts label `Agent message queued`; the participant
        // falls back name -> active session id -> session id -> unknown and
        // renders bare without a receiver role.
        for (delivery, label) in [
            ("delivered", "Agent message sent"),
            ("queued", "Agent message queued"),
        ] {
            let details = json!({
                "status": "ok",
                "sentAgentMessages": [{
                    "id": "agentmsg_2",
                    "message": "Ping.",
                    "deliveryStatus": delivery,
                    "receiverRole": "child",
                    "target": { "activeSessionId": "worker-active", "sessionId": "worker-session" },
                }],
            });
            let card = cell_card("send()", details, false, false);
            let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
            let text = text_of(&lines[1]);
            assert!(
                text.contains(&format!("\u{25c6} {label} \u{b7} to child worker-active")),
                "got: {text}"
            );
        }
        let details = json!({
            "status": "ok",
            "sentAgentMessages": [{
                "id": "agentmsg_3",
                "message": "Ping.",
                "deliveryStatus": "queued",
                "target": { "sessionId": "peer-session" },
            }],
        });
        let card = cell_card("send()", details, false, false);
        let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
        assert!(
            text_of(&lines[1]).contains("Agent message queued \u{b7} to peer-session"),
            "got: {}",
            text_of(&lines[1])
        );
        // Malformed entries render nothing.
        let details = json!({
            "status": "ok",
            "sentAgentMessages": [{ "id": "agentmsg_4" }, { "message": 1 }],
        });
        let card = cell_card("send()", details, false, false);
        let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
        assert_eq!(lines.len(), 1, "malformed receipts skipped: {lines:?}");
    }

    #[test]
    fn collapsed_stays_single_line() {
        let card = cell_card(
            "print(1)",
            json!({ "status": "ok", "stdout": "1\n" }),
            false,
            false,
        );
        let lines = render(&card, 0, Detail::All, &theme(), 100, true);
        assert!(lines.len() > 1, "all mode expands rows");
        let collapsed = render(&card, 0, Detail::Overview, &theme(), 100, true);
        let details = render(&card, 0, Detail::Details, &theme(), 100, true);
        assert_eq!(collapsed.len(), 1);
        assert_eq!(details.len(), 1, "details mode keeps tool output collapsed");
    }

    #[test]
    fn bash_cell_renders_bash_mode_line() {
        let card = cell_card(
            "%%bash\necho hi",
            json!({ "status": "ok", "durationMs": 8, "stdout": "hi\n" }),
            false,
            false,
        );
        let lines = render(&card, 0, Detail::All, &theme(), 100, true);
        let flat: Vec<String> = lines.iter().map(text_of).collect();
        assert!(flat[0].contains("bash"), "got: {flat:?}");
        assert!(flat[1].contains("%%bash"), "got: {flat:?}");
        assert!(flat[2].contains("echo hi"), "got: {flat:?}");
    }

    #[test]
    fn background_shell_duration_label_and_exit() {
        let code = "h = bash('sleep 0.1')";
        let details = json!({
            "status": "ok",
            "durationMs": 12,
            "result": "<BashHandle pid=421 running command='sleep 0.1'>",
        });
        let card = cell_card(code, details, false, false);
        let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
        let text = text_of(&lines[0]);
        assert!(text.contains("cell 12ms"), "got: {text}");
        let details = json!({
            "status": "ok",
            "durationMs": 12,
            "result": "<BashHandle pid=421 exit_code=1 command='sleep 0.1'>",
        });
        let card2 = cell_card(code, details, false, false);
        let lines = render(&card2, 0, Detail::Overview, &theme(), 100, true);
        let text = text_of(&lines[0]);
        assert!(text.contains("exit 1"), "got: {text}");
        assert!(text.contains("\u{2717}"), "got: {text}");
    }

    #[test]
    fn partial_cell_shows_waiting_for_output() {
        let card = cell_card("print(2)", json!({ "status": "ok" }), false, true);
        let lines = render(&card, 0, Detail::All, &theme(), 100, true);
        let flat: Vec<String> = lines.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|row| row.contains("waiting for output...")),
            "got: {flat:?}"
        );
    }

    fn image_cell_card() -> ToolCallCard {
        use base64::Engine;
        let mut bytes = vec![0x89, b'P', b'N', b'G'];
        bytes.extend(vec![0u8; 12]);
        bytes.extend(8u32.to_be_bytes());
        bytes.extend(4u32.to_be_bytes());
        let png = base64::engine::general_purpose::STANDARD.encode(bytes);
        ToolCallCard {
            id: "toolu_1".into(),
            name: "ipython".into(),
            args: json!({ "code": "display(img)" }),
            started: true,
            result: Some(super::super::ToolResultView {
                content: vec![json!({ "type": "image", "data": png, "mimeType": "image/png" })],
                details: json!({ "status": "ok", "durationMs": 3 }),
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }
    }

    #[test]
    fn shown_image_counts_render_below_the_cell() {
        let card = image_cell_card();
        let lines = render(&card, 0, Detail::All, &theme(), 100, true);
        let flat: Vec<String> = lines.iter().map(text_of).collect();
        assert!(
            flat.iter()
                .any(|row| row.contains("1 image rendered below")),
            "got: {flat:?}"
        );
        assert!(
            flat.iter()
                .any(|row| row.contains("\u{2570}\u{2500} [image/png \u{b7} 8\u{d7}4]")),
            "got: {flat:?}"
        );
    }

    #[test]
    fn hidden_image_counts_stay_hidden_with_no_rows() {
        let card = image_cell_card();
        let lines = render(&card, 0, Detail::All, &theme(), 100, false);
        let flat: Vec<String> = lines.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|row| row.contains("1 image hidden")),
            "got: {flat:?}"
        );
        assert!(!flat.iter().any(|row| row.contains("[image/png")));
    }

    #[test]
    fn no_output_placeholder() {
        let card = cell_card(
            "x = 1",
            json!({ "status": "ok", "durationMs": 4 }),
            false,
            false,
        );
        let lines = render(&card, 0, Detail::All, &theme(), 100, true);
        let flat: Vec<String> = lines.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|row| row.contains("no output")),
            "got: {flat:?}"
        );
    }

    #[test]
    fn split_traceback_parts() {
        let (output, traceback) = split_traceback(
            "before\nTraceback (most recent call last):\n  File x\nValueError: boom",
            None,
        )
        .unwrap();
        assert_eq!(output, "before");
        assert!(traceback.starts_with("Traceback"));
        assert!(traceback.ends_with("boom"));
    }
}

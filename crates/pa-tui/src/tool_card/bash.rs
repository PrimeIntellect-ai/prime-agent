//! The `bash` tool-call card, a port of the TS `bash.ts` renderCall /
//! renderResult components composed inside the `ToolPanel`: a `label \u{00b7}
//! status` header, the dim `$ command` call row, the command's output
//! (collapsed: the last five visual lines with an `... N earlier lines`
//! hint; expanded: everything), the truncation warning, and the live
//! `Took`/`Elapsed` duration row.

use serde_json::Value;

use super::{
    format_bash_duration, image_rows, panel_header, panel_line, ToolCallCard, ToolResultView,
};
use crate::chat::Detail;
use crate::code_preview::{preview_bash_command, CodePreviewLanguage};
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::wrap_text;
use crate::{Line, Span};

/// Collapsed preview length in visual lines (TS `BASH_PREVIEW_LINES`).
const BASH_PREVIEW_LINES: usize = 5;

pub fn render(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> Vec<Line> {
    let bg = theme.bg_style(ThemeBg::ToolPanelBg);
    let content_width = width.saturating_sub(2 * 2).max(1);
    let mut children: Vec<Line> = format_bash_call(card, theme, content_width);
    if let Some(result) = &card.result {
        children.extend(bash_result_rows(
            card,
            result,
            detail.tool_output_expanded(),
            theme,
            content_width,
        ));
    }
    children.extend(image_rows(&card.result, show_images, theme));

    let mut lines = vec![panel_line(panel_header(card, frame, theme), bg, width)];
    if !children.is_empty() {
        lines.push(panel_line(Vec::new(), bg, width));
        for child in children {
            lines.push(panel_line(child, bg, width));
        }
    }
    lines
}

/// The `$ command` call row (TS `formatBashCall`): dim, with the command
/// preview (a non-bash language prefixes its label) and the timeout suffix.
fn format_bash_call(card: &ToolCallCard, theme: &Theme, width: usize) -> Vec<Line> {
    let dim = theme.fg_style(ThemeColor::Dim);
    let error = theme.fg_style(ThemeColor::Error);
    let tool_output = theme.fg_style(ThemeColor::ToolOutput);
    let command = card.args.get("command");
    // `str(value)`: a missing or non-string command is invalid; a null or
    // empty string renders the `...` placeholder.
    let invalid = command.is_some_and(|value| !value.is_string());
    let command = command.and_then(Value::as_str);
    let mut row: Line = vec![Span::styled("$ ".to_string(), dim)];
    if invalid {
        row.push(Span::styled("[invalid arg]".to_string(), error));
    } else if command.unwrap_or_default().is_empty() {
        row.push(Span::styled("...".to_string(), tool_output));
    } else {
        let command = command.unwrap_or_default();
        let preview = preview_bash_command(command);
        let display = if preview.text.is_empty() {
            command.to_string()
        } else {
            match preview.language {
                CodePreviewLanguage::Bash => preview.text,
                CodePreviewLanguage::Python => format!("python: {}", preview.text),
            }
        };
        row.push(Span::styled(display, dim));
    }
    if let Some(timeout) = card.args.get("timeout").and_then(Value::as_f64) {
        row.push(Span::styled(format!(" (timeout {timeout:.0}s)"), dim));
    }
    crate::width::wrap_line(&row, width)
}

/// The result rows (TS `rebuildBashResultRenderComponent`): output rows,
/// the truncation warning, the duration row.
fn bash_result_rows(
    card: &ToolCallCard,
    result: &ToolResultView,
    expanded: bool,
    theme: &Theme,
    content_width: usize,
) -> Vec<Line> {
    let tool_output = theme.fg_style(ThemeColor::ToolOutput);
    let mut rows: Vec<Line> = Vec::new();
    let output = result.text_output(true).trim().to_string();
    if !output.is_empty() {
        if expanded {
            rows.push(Vec::new());
            for line in output.split('\n') {
                rows.push(vec![Span::styled(line.to_string(), tool_output)]);
            }
        } else {
            let (visual, skipped) = truncate_to_visual_lines(&output, content_width);
            rows.push(Vec::new());
            if skipped > 0 {
                rows.push(vec![Span::styled(
                    format!("... {skipped} earlier lines"),
                    theme.fg_style(ThemeColor::Dim),
                )]);
            }
            rows.extend(
                visual
                    .into_iter()
                    .map(|line| vec![Span::styled(line, tool_output)]),
            );
        }
    }
    rows.extend(truncation_warning_rows(result, theme, content_width));
    rows.extend(duration_rows(card, result, theme, content_width));
    rows
}

/// `truncateToVisualLines` from the end: the wrapped rows and how many
/// earlier rows were skipped.
fn truncate_to_visual_lines(text: &str, width: usize) -> (Vec<String>, usize) {
    let mut visual: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let wrapped = wrap_text(line, width);
        if wrapped.is_empty() {
            visual.push(String::new());
            continue;
        }
        for row in wrapped {
            let text: String = row.iter().map(|s| s.content.as_str()).collect();
            visual.push(text);
        }
    }
    if visual.len() <= BASH_PREVIEW_LINES {
        return (visual, 0);
    }
    let skipped = visual.len() - BASH_PREVIEW_LINES;
    (visual.split_off(skipped), skipped)
}

/// The truncation notice (`[Full output: ... . Truncated: ...]`, warning
/// color) when the engine cut the output or spilled it to a file.
fn truncation_warning_rows(
    result: &ToolResultView,
    theme: &Theme,
    content_width: usize,
) -> Vec<Line> {
    let details = result.details.as_object();
    let truncation = details.and_then(|d| d.get("truncation"));
    let full_output_path = details
        .and_then(|d| d.get("fullOutputPath"))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());
    let truncated =
        truncation.is_some_and(|t| t.get("truncated").and_then(Value::as_bool).unwrap_or(false));
    if !truncated && full_output_path.is_none() {
        return Vec::new();
    }
    let mut warnings: Vec<String> = Vec::new();
    if let Some(path) = full_output_path {
        warnings.push(format!("Full output: {path}"));
    }
    if truncated {
        let truncation = truncation.expect("checked");
        let output_lines = truncation.get("outputLines").and_then(Value::as_u64);
        let total_lines = truncation.get("totalLines").and_then(Value::as_u64);
        let truncated_by_lines = truncation
            .get("truncatedBy")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "lines");
        match (output_lines, total_lines) {
            (Some(output), Some(total)) if truncated_by_lines => {
                warnings.push(format!("Truncated: showing {output} of {total} lines"));
            }
            (Some(output), Some(_)) => {
                let max_bytes = truncation
                    .get("maxBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(super::DEFAULT_MAX_BYTES as u64)
                    as usize;
                warnings.push(format!(
                    "Truncated: {output} lines shown ({} limit)",
                    super::format_size(max_bytes)
                ));
            }
            _ => {}
        }
    }
    if warnings.is_empty() {
        return Vec::new();
    }
    let text = format!("[{}]", warnings.join(". "));
    styled_wrapped(&text, ThemeColor::Warning, theme, content_width, true)
}

/// The `Took 1.2s` row (live timing: a card that never saw its execution
/// start renders no duration row, matching the TS render-state lifecycle).
fn duration_rows(
    card: &ToolCallCard,
    _result: &ToolResultView,
    theme: &Theme,
    content_width: usize,
) -> Vec<Line> {
    let Some(started) = card.started_at else {
        return Vec::new();
    };
    let label = if card.result_partial {
        "Elapsed"
    } else {
        "Took"
    };
    let elapsed = card.ended_at.unwrap_or_else(std::time::Instant::now) - started;
    let text = format!("{label} {}", format_bash_duration(elapsed.as_millis()));
    let mut rows = vec![Vec::new()];
    rows.extend(styled_wrapped(
        &text,
        ThemeColor::Dim,
        theme,
        content_width,
        false,
    ));
    rows
}

/// One row list in one color, wrapped at the content width; `leading_blank`
/// prepends the separator row TS's `\n` prefix produces.
fn styled_wrapped(
    text: &str,
    color: ThemeColor,
    theme: &Theme,
    content_width: usize,
    leading_blank: bool,
) -> Vec<Line> {
    let style = theme.fg_style(color);
    let mut rows: Vec<Line> = Vec::new();
    if leading_blank {
        rows.push(Vec::new());
    }
    for row in wrap_text(text, content_width) {
        rows.push(
            row.into_iter()
                .map(|mut span| {
                    span.style = style;
                    span
                })
                .collect(),
        );
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};
    use serde_json::json;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn done_card(command: &str, output: &str) -> ToolCallCard {
        ToolCallCard {
            id: "toolu_1".into(),
            name: "bash".into(),
            args: json!({ "command": command }),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(ToolResultView {
                content: vec![json!({ "type": "text", "text": output })],
                details: json!({}),
                is_error: false,
            }),
            result_partial: false,
            aborted: false,
        }
    }

    fn text_of(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect()
    }

    #[test]
    fn collapsed_preview_truncates_from_the_end() {
        let output = (1..=12)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let card = done_card("seq 1 12", &output);
        let rows = render(&card, 0, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|r| r.contains("bash \u{00b7} done")),
            "got: {flat:?}"
        );
        assert!(
            flat.iter().any(|r| r.contains("$ seq 1 12")),
            "got: {flat:?}"
        );
        assert!(
            flat.iter().any(|r| r.contains("... 7 earlier lines")),
            "got: {flat:?}"
        );
        assert!(flat.iter().any(|r| r.contains("12")), "got: {flat:?}");
    }

    #[test]
    fn expanded_shows_all_output() {
        let output = (1..=12)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let card = done_card("seq 1 12", &output);
        let rows = render(&card, 0, Detail::All, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|r| r.trim_end().ends_with("1")),
            "got: {flat:?}"
        );
        assert!(
            !flat.iter().any(|r| r.contains("earlier lines")),
            "got: {flat:?}"
        );
    }

    #[test]
    fn duration_row_rendered() {
        let card = done_card("echo hi", "hi");
        let rows = render(&card, 0, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(flat.iter().any(|r| r.contains("Took ")), "got: {flat:?}");
    }

    #[test]
    fn truncation_warning_rendered() {
        let mut card = done_card("cat big.txt", "line1\nline2");
        card.result = Some(ToolResultView {
            content: vec![json!({ "type": "text", "text": "line1\nline2" })],
            details: json!({
                "truncation": {
                    "truncated": true,
                    "truncatedBy": "lines",
                    "outputLines": 2,
                    "totalLines": 10,
                },
                "fullOutputPath": "/tmp/pi-bash-abc",
            }),
            is_error: false,
        });
        let rows = render(&card, 0, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter()
                .any(|r| r
                    .contains("[Full output: /tmp/pi-bash-abc. Truncated: showing 2 of 10 lines]")),
            "got: {flat:?}"
        );
    }

    #[test]
    fn byte_truncation_warning_shape() {
        let mut card = done_card("cat big.txt", "x");
        card.result = Some(ToolResultView {
            content: vec![json!({ "type": "text", "text": "x" })],
            details: json!({
                "truncation": {
                    "truncated": true,
                    "truncatedBy": "bytes",
                    "outputLines": 3,
                    "totalLines": 9,
                },
            }),
            is_error: false,
        });
        let rows = render(&card, 0, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter()
                .any(|r| r.contains("Truncated: 3 lines shown (50.0KB limit)")),
            "got: {flat:?}"
        );
    }

    #[test]
    fn running_header_animates() {
        // The bash tool emits an empty partial result the moment it starts,
        // so a running card carries an (empty) partial result.
        let card = ToolCallCard {
            id: "t".into(),
            name: "bash".into(),
            args: json!({ "command": "sleep 1" }),
            started: true,
            started_at: Some(std::time::Instant::now()),
            result: Some(ToolResultView::default()),
            result_partial: true,
            ..Default::default()
        };
        let rows = render(&card, 3, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(flat.iter().any(|r| r.contains("running")), "got: {flat:?}");
        assert!(flat.iter().any(|r| r.contains("Elapsed ")), "got: {flat:?}");
    }

    #[test]
    fn invalid_and_missing_command_shapes() {
        let card = ToolCallCard {
            id: "t".into(),
            name: "bash".into(),
            args: json!({ "command": 5 }),
            started: false,
            ..Default::default()
        };
        let rows = render(&card, 0, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|r| r.contains("$ [invalid arg]")),
            "got: {flat:?}"
        );

        let card = ToolCallCard {
            id: "t".into(),
            name: "bash".into(),
            args: json!({ "command": "" }),
            started: false,
            ..Default::default()
        };
        let rows = render(&card, 0, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(flat.iter().any(|r| r.contains("$ ...")), "got: {flat:?}");
    }
}

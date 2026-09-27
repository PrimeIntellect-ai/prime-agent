//! Expanded cell output; painting and counting share the same output decisions.

use super::*;

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
pub(super) fn render_output(
    card: &ToolCallCard,
    details: &IpythonDetails,
    lines: &mut RowOutput,
    has_code: bool,
    show_images: bool,
    theme: &Theme,
    width: usize,
) {
    let blocks = card
        .result
        .as_ref()
        .map(|result| result.content.as_slice())
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
    let start_output = |output_started: &mut bool, lines: &mut RowOutput| {
        if *output_started {
            return;
        }
        *output_started = true;
        if has_code {
            lines.blank();
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
        let traceback_text = if error.traceback.is_empty() {
            format_ipython_error_summary(error)
        } else {
            error.traceback.join("\n")
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
    lines: &mut RowOutput,
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

#[cfg(test)]
mod tests {
    use super::*;
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

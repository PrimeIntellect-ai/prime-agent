//! Numbered cell-edit display, using the existing jsdiff-compatible line algorithm.

mod lines;

use lines::diff_lines;

/// Generate the cell edit display with line numbers and bounded context.
pub(super) fn generate_diff_string(
    old_content: &str,
    new_content: &str,
    context_lines: usize,
    start_line: usize,
) -> String {
    let parts = diff_lines(old_content, new_content);
    let mut output: Vec<String> = Vec::new();

    let old_lines: Vec<&str> = old_content.split('\n').collect();
    let new_lines: Vec<&str> = new_content.split('\n').collect();
    let max_line_num = start_line.saturating_sub(1) + old_lines.len().max(new_lines.len());
    let line_num_width = max_line_num.to_string().len();

    let mut old_line_num = start_line;
    let mut new_line_num = start_line;
    let mut last_was_change = false;

    for (i, part) in parts.iter().enumerate() {
        let mut raw: Vec<&str> = part.value.split('\n').collect();
        if raw.last() == Some(&"") {
            raw.pop();
        }

        if part.added || part.removed {
            for line in &raw {
                if part.added {
                    let line_num = format!("{new_line_num:>line_num_width$}");
                    output.push(format!("+{line_num} {line}"));
                    new_line_num += 1;
                } else {
                    let line_num = format!("{old_line_num:>line_num_width$}");
                    output.push(format!("-{line_num} {line}"));
                    old_line_num += 1;
                }
            }
            last_was_change = true;
        } else {
            let next_part_is_change =
                i + 1 < parts.len() && (parts[i + 1].added || parts[i + 1].removed);
            let has_leading_change = last_was_change;
            let has_trailing_change = next_part_is_change;

            if has_leading_change && has_trailing_change {
                if raw.len() <= context_lines * 2 {
                    for line in &raw {
                        let line_num = format!("{old_line_num:>line_num_width$}");
                        output.push(format!(" {line_num} {line}"));
                        old_line_num += 1;
                        new_line_num += 1;
                    }
                } else {
                    let leading_lines = &raw[..context_lines];
                    let trailing_lines = &raw[raw.len() - context_lines..];
                    let skipped_lines = raw.len() - leading_lines.len() - trailing_lines.len();

                    for line in leading_lines {
                        let line_num = format!("{old_line_num:>line_num_width$}");
                        output.push(format!(" {line_num} {line}"));
                        old_line_num += 1;
                        new_line_num += 1;
                    }

                    output.push(format!(" {:>line_num_width$} ...", ""));
                    old_line_num += skipped_lines;
                    new_line_num += skipped_lines;

                    for line in trailing_lines {
                        let line_num = format!("{old_line_num:>line_num_width$}");
                        output.push(format!(" {line_num} {line}"));
                        old_line_num += 1;
                        new_line_num += 1;
                    }
                }
            } else if has_leading_change {
                let shown_lines = &raw[..context_lines.min(raw.len())];
                let skipped_lines = raw.len() - shown_lines.len();

                for line in shown_lines {
                    let line_num = format!("{old_line_num:>line_num_width$}");
                    output.push(format!(" {line_num} {line}"));
                    old_line_num += 1;
                    new_line_num += 1;
                }

                if skipped_lines > 0 {
                    output.push(format!(" {:>line_num_width$} ...", ""));
                    old_line_num += skipped_lines;
                    new_line_num += skipped_lines;
                }
            } else if has_trailing_change {
                let skipped_lines = raw.len().saturating_sub(context_lines);
                if skipped_lines > 0 {
                    output.push(format!(" {:>line_num_width$} ...", ""));
                    old_line_num += skipped_lines;
                    new_line_num += skipped_lines;
                }

                for line in raw.iter().skip(skipped_lines) {
                    let line_num = format!("{old_line_num:>line_num_width$}");
                    output.push(format!(" {line_num} {line}"));
                    old_line_num += 1;
                    new_line_num += 1;
                }
            } else {
                old_line_num += raw.len();
                new_line_num += raw.len();
            }

            last_was_change = false;
        }
    }

    output.join("\n")
}

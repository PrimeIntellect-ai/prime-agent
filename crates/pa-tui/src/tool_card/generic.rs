//! The generic tool panel for tools without a dedicated card (TS
//! `ToolExecutionComponent`'s fallback path): a `label \u{00b7} status`
//! header, then the call arguments and any text output with the shared
//! `... more lines` fallback preview.

use super::{image_rows, panel_header, panel_line, ToolCallCard};
use crate::chat::Detail;
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::wrap_text;
use crate::{Line, Span};

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
    let mut children: Vec<Line> = Vec::new();
    // TS `formatToolExecution`: the arguments preview, a blank row, then the
    // output preview (each independently previewed). Hidden image blocks
    // contribute their `[Image: ...]` text here (`getTextOutput` with
    // `showImages` false).
    let args = serde_json::to_string_pretty(&card.args).unwrap_or_default();
    let output = card.result.as_ref().map(|r| r.text_output(show_images));
    if !args.is_empty() {
        children.extend(fallback_preview(
            &args,
            detail.tool_output_expanded(),
            theme,
            content_width,
        ));
    }
    if let Some(output) = output.as_deref().filter(|o| !o.is_empty()) {
        if !children.is_empty() {
            children.push(Vec::new());
        }
        children.extend(fallback_preview(
            output,
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

/// The fallback preview (TS `formatFallbackPreview`): the full text
/// expanded, the first three lines plus `\u{2026} N more lines` collapsed.
/// (`getTextOutput` with `showImages` false appends the image fallbacks, so
/// image results show their placeholder rows here too.)
fn fallback_preview(text: &str, expanded: bool, theme: &Theme, content_width: usize) -> Vec<Line> {
    let dim = theme.fg_style(ThemeColor::Dim);
    let tool_output = theme.fg_style(ThemeColor::ToolOutput);
    if expanded {
        return styled_rows(text, tool_output, content_width);
    }
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= 3 {
        return styled_rows(text, tool_output, content_width);
    }
    let mut rows = styled_rows(&lines[..3].join("\n"), tool_output, content_width);
    let more = format!("\u{2026} {} more lines", lines.len() - 3);
    rows.push(vec![Span::styled(more, dim)]);
    rows
}

fn styled_rows(text: &str, style: ratatui::style::Style, width: usize) -> Vec<Line> {
    wrap_text(text, width)
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(|mut span| {
                    span.style = style;
                    span
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};
    use serde_json::json;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn text_of(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect()
    }

    fn image_card() -> ToolCallCard {
        let png = tiny_png(64, 32);
        ToolCallCard {
            id: "t".into(),
            name: "custom".into(),
            args: json!({}),
            started: true,
            result: Some(super::super::ToolResultView {
                content: vec![
                    json!({ "type": "text", "text": "done" }),
                    json!({ "type": "image", "data": png, "mimeType": "image/png" }),
                ],
                details: json!({}),
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }
    }

    fn tiny_png(width: u32, height: u32) -> String {
        use base64::Engine;
        let mut bytes = vec![0x89, b'P', b'N', b'G'];
        bytes.extend(vec![0u8; 12]);
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn shown_image_blocks_render_their_metadata_row_below_the_output() {
        let card = image_card();
        let rows = render(&card, 0, Detail::All, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter()
                .any(|r| r.contains("    \u{2570}\u{2500} [image/png \u{b7} 64\u{d7}32]")),
            "got: {flat:?}"
        );
        assert!(!flat.iter().any(|r| r.contains("[Image:")));
    }

    #[test]
    fn hidden_image_blocks_fall_back_to_placeholder_text() {
        let card = image_card();
        let rows = render(&card, 0, Detail::All, &theme(), 120, false);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter()
                .any(|r| r.contains("[Image: [image/png] 64x32]")),
            "got: {flat:?}"
        );
        assert!(!flat.iter().any(|r| r.contains("\u{2570}\u{2500}")));
    }

    #[test]
    fn image_blocks_without_payload_data_render_no_rows() {
        let mut card = image_card();
        card.result = Some(super::super::ToolResultView {
            content: vec![json!({ "type": "image", "mimeType": "image/png" })],
            details: json!({}),
            is_error: false,
        });
        let rows = render(&card, 0, Detail::All, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(!flat.iter().any(|r| r.contains("[image/png")));
    }

    #[test]
    fn collapsed_fallback_shows_three_lines_and_hint() {
        let card = ToolCallCard {
            id: "t".into(),
            name: "custom".into(),
            args: json!({ "a": 1 }),
            started: true,
            result: Some(super::super::ToolResultView {
                content: vec![json!({ "type": "text", "text": "one\ntwo\nthree\nfour" })],
                details: json!({}),
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        };
        let rows = render(&card, 0, Detail::Overview, &theme(), 120, true);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.iter().any(|r| r.contains("custom \u{00b7} done")),
            "got: {flat:?}"
        );
        assert!(
            flat.iter().any(|r| r.contains("\u{2026} 1 more lines")),
            "got: {flat:?}"
        );
    }
}

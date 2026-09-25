//! Generic tool-panel rendering and count-only geometry share one preview traversal.

use super::layout::{panel_content_width, RowOutput};
use super::ToolCallCard;
use crate::chat::Detail;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

pub fn render(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> Vec<Line> {
    let mut out = RowOutput::paint();
    traverse(card, detail, theme, width, show_images, &mut out);
    out.panel(card, frame, theme, width);
    out.into_lines()
}

pub(crate) fn count(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> usize {
    let mut out = RowOutput::count();
    traverse(card, detail, theme, width, show_images, &mut out);
    out.panel(card, frame, theme, width);
    out.len()
}

fn traverse(
    card: &ToolCallCard,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
    out: &mut RowOutput,
) {
    let content_width = panel_content_width(width);
    let args = serde_json::to_string_pretty(&card.args).unwrap_or_default();
    let output = card.result.as_ref().map(|r| r.text_output(show_images));
    if !args.is_empty() {
        fallback_preview(
            &args,
            detail.tool_output_expanded(),
            theme,
            content_width,
            out,
        );
    }
    if let Some(output) = output.as_deref().filter(|o| !o.is_empty()) {
        if out.len() > 0 {
            out.blank();
        }
        fallback_preview(
            output,
            detail.tool_output_expanded(),
            theme,
            content_width,
            out,
        );
    }
    out.images(&card.result, show_images, theme);
}

/// Preview the first three source lines, not the first three wrapped rows.
fn fallback_preview(
    text: &str,
    expanded: bool,
    theme: &Theme,
    content_width: usize,
    out: &mut RowOutput,
) {
    let tool_output = theme.fg_style(ThemeColor::ToolOutput);
    if expanded {
        out.wrapped_text(text, tool_output, content_width);
        return;
    }
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= 3 {
        out.wrapped_text(text, tool_output, content_width);
        return;
    }
    out.wrapped_text(&lines[..3].join("\n"), tool_output, content_width);
    out.push(|| {
        vec![Span::styled(
            format!("\u{2026} {} more lines", lines.len() - 3),
            theme.fg_style(ThemeColor::Dim),
        )]
    });
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
    // deliberate decomposed/non-NFC fixtures: the width engine must measure the raw sequences
    #[allow(clippy::unicode_not_nfc)]
    fn geometry_matches_rendered_generic_cards() {
        let theme = theme();
        let mut cards = vec![ToolCallCard::default(), image_card()];
        for text in [
            "",
            "a\n",
            "one\ntwo\nthree\nfour\n",
            "数据 é 👩‍💻\n\nlong long long words\n\u{1b}[31mred\u{1b}[0m",
        ] {
            cards.push(ToolCallCard {
                name: "custom".into(),
                args: json!({ "long": [1, 2, 3, 4], "unicode": "数据" }),
                result: Some(super::super::ToolResultView {
                    content: vec![
                        json!({"type":"text", "text":text}),
                        json!({"type":"image", "mimeType":"image/png"}),
                    ],
                    is_error: true,
                    ..Default::default()
                }),
                result_partial: true,
                ..Default::default()
            });
        }
        for card in cards {
            for detail in [Detail::Overview, Detail::Details, Detail::All] {
                for show_images in [false, true] {
                    let expected: Vec<_> = (0..90)
                        .map(|width| render(&card, 0, detail, &theme, width, show_images).len())
                        .collect();
                    let actual: Vec<_> = (0..90)
                        .map(|width| count(&card, 0, detail, &theme, width, show_images))
                        .collect();
                    assert_eq!(actual, expected, "{detail:?}, show_images={show_images}");
                }
            }
        }
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

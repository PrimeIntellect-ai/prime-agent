//! The skill-invocation card: TS `skill-invocation-message.ts` +
//! `skill-blocks.ts`. A user message whose text is one `<skill ...>` block
//! (what a `/skill:<name>` submission expands into) renders the compact
//! expandable card instead of the raw block: collapsed, the `[skill]`
//! label and the skill name; expanded, the label above the
//! `**<name>**` + content markdown in `customMessageText`; the trailing
//! argument text renders as its own user block below (no spacer between,
//! TS `addMessageToChat`'s user case). The block parse itself lives in
//! the shared vocabulary crate (`pa_types::skill_blocks`), so the session
//! engine and every rendering surface agree on the format.

use crate::chat::{ChatEntry, Detail};
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::str_width;
use crate::{Line, Span};

/// One skill-invocation card (TS `SkillInvocationMessageComponent`, an
/// `ExpandableCustomMessageBox`): collapsed, the `[skill]` label and the
/// skill name; expanded, the label above `**<name>**` and the skill content
/// as markdown. Parsed out of a user message whose text is one
/// `<skill ...>` block (TS `parseSkillBlock` in `addMessageToChat`).
#[derive(Debug, Clone, PartialEq)]
pub struct SkillInvocationRow {
    /// The invoked skill's name.
    pub name: String,
    /// The skill content (frontmatter stripped).
    pub content: String,
}

/// The skill-invocation decode for a user message (TS `parseSkillBlock` in
/// `addMessageToChat`'s user case): a message whose text is one
/// `<skill ...>` block renders the expandable card, and a trailing user
/// message after the block renders as its own user block below it
/// (the TS component adds no spacer between them). `None` means the text
/// is an ordinary user prompt.
pub fn skill_invocation_entries(text: &str) -> Option<Vec<ChatEntry>> {
    let block = pa_types::skill_blocks::parse_skill_block(text)?;
    let mut entries = vec![ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
        name: block.name,
        content: block.content,
    }))];
    if let Some(user_message) = block.user_message {
        entries.push(ChatEntry::User { text: user_message });
    }
    Some(entries)
}

/// One box content row: left padding column, content spans (bg-patched),
/// padded to the full width on the box background (TS `Box.applyBg` covers
/// the whole row, trailing padding included).
fn box_row(spans: Line, bg: ratatui::style::Style, width: usize) -> Line {
    let used: usize = spans.iter().map(|s| str_width(&s.content)).sum();
    let mut row: Line = vec![Span::styled(" ".to_string(), bg)];
    for mut span in spans {
        span.style = span.style.patch(bg);
        row.push(span);
    }
    if used < width {
        row.push(Span::styled(" ".repeat(width - used), bg));
    }
    row
}

/// One skill-invocation card (TS `SkillInvocationMessageComponent`, an
/// `ExpandableCustomMessageBox`: `Box(1,1)` on `customMessageBg`).
/// Collapsed: one row, the bold `[skill]` label in `customMessageLabel`
/// and the skill name in `customMessageText` (the TS expand hint for
/// `app.tools.expand` renders empty). Expanded: the label row above the
/// `**<name>**\n\n<content>` markdown body in `customMessageText`.
pub fn render_skill_invocation(
    row: &SkillInvocationRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
    leading: bool,
) -> Vec<Line> {
    let bg = theme.bg_style(ThemeBg::CustomMessageBg);
    let blank = vec![Span::styled(" ".repeat(width), bg)];
    let label = || {
        Span::styled(
            "[skill]".to_string(),
            theme
                .fg_style(ThemeColor::CustomMessageLabel)
                .add_modifier(ratatui::style::Modifier::BOLD),
        )
    };
    let mut out = Vec::new();
    if leading {
        out.push(Vec::new());
    }
    out.push(blank.clone());
    if detail.tool_output_expanded() {
        out.push(box_row(vec![label()], bg, width));
        let content_width = width.saturating_sub(2).max(1);
        let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
        md.body = theme.fg_style(ThemeColor::CustomMessageText);
        let body = format!("**{}**\n\n{}", row.name, row.content);
        for line in crate::markdown::render_markdown(&body, content_width, &md) {
            out.push(box_row(line, bg, width));
        }
    } else {
        let name = Span::styled(
            row.name.clone(),
            theme.fg_style(ThemeColor::CustomMessageText),
        );
        out.push(box_row(
            vec![label(), Span::raw(" ".to_string()), name],
            bg,
            width,
        ));
    }
    out.push(blank);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn flat(row: &Line) -> String {
        row.iter().map(|s| s.content.as_str()).collect()
    }

    #[test]
    fn entries_decode_the_card_and_args() {
        // TS `parseSkillBlock`: the block card plus the trailing argument
        // text as its own user block.
        let entries = skill_invocation_entries(
            "<skill name=\"websearch\" location=\"/s/SKILL.md\">\nRun one query.\n</skill>\n\nfind parity tuis",
        )
        .expect("parses");
        assert_eq!(
            entries,
            vec![
                ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
                    name: "websearch".to_string(),
                    content: "Run one query.".to_string(),
                })),
                ChatEntry::User {
                    text: "find parity tuis".to_string()
                },
            ]
        );
        // A block without arguments renders the card alone.
        let entries = skill_invocation_entries(
            "<skill name=\"websearch\" location=\"/s/SKILL.md\">\nRun one query.\n</skill>",
        )
        .expect("parses");
        assert!(matches!(
            entries.as_slice(),
            [ChatEntry::SkillInvocation(_)]
        ));
        // Every other user text is an ordinary prompt.
        assert!(skill_invocation_entries("hello world").is_none());
        assert!(skill_invocation_entries("/skill:websearch find tuis").is_none());
    }

    #[test]
    fn collapsed_box_shape() {
        let row = SkillInvocationRow {
            name: "websearch".to_string(),
            content: "Run one query.".to_string(),
        };
        let rows = render_skill_invocation(&row, Detail::Overview, &theme(), 40, true);
        // Leading blank, box top pad, the one-line card, box bottom pad.
        assert_eq!(rows.len(), 4, "{rows:?}");
        assert!(rows[0].is_empty());
        let bg = theme().bg_style(ThemeBg::CustomMessageBg);
        assert_eq!(rows[1][0].style, bg, "top pad row on the box bg");
        assert_eq!(flat(&rows[2]).trim_end(), " [skill] websearch");
        // Colors: the bold label in customMessageLabel, the name in
        // customMessageText (the TS expand hint renders empty).
        assert!(rows[2][1]
            .style
            .add_modifier
            .contains(ratatui::style::Modifier::BOLD));
        assert_eq!(
            rows[2][1].style.fg,
            theme().fg_style(ThemeColor::CustomMessageLabel).fg
        );
        assert_eq!(
            rows[2][3].style.fg,
            theme().fg_style(ThemeColor::CustomMessageText).fg
        );
        assert_eq!(rows[3][0].style, bg, "bottom pad row on the box bg");
        // The skill content stays out of the collapsed card.
        assert!(!flat(&rows[2]).contains("Run one query."));
        // Without the leading blank the card starts at the top pad row.
        let rows = render_skill_invocation(&row, Detail::Overview, &theme(), 40, false);
        assert_eq!(rows.len(), 3, "{rows:?}");
    }

    #[test]
    fn expanded_renders_the_markdown_body() {
        let row = SkillInvocationRow {
            name: "websearch".to_string(),
            content: "Run one query.".to_string(),
        };
        let rows = render_skill_invocation(&row, Detail::All, &theme(), 40, false);
        // Box top pad, label row, then the `**name**` + body markdown.
        assert!(rows.len() > 3, "{rows:?}");
        assert_eq!(flat(&rows[1])[..10].trim_end(), " [skill]");
        let rendered: String = rows.iter().map(flat).collect();
        assert!(rendered.contains("websearch"), "bold name: {rendered:?}");
        assert!(rendered.contains("Run one query."), "body: {rendered:?}");
        // Every content row carries the box background.
        let bg = theme().bg_style(ThemeBg::CustomMessageBg);
        for row in &rows[1..rows.len() - 1] {
            assert!(row.iter().all(|span| span.style.patch(bg) == span.style));
        }
    }
}

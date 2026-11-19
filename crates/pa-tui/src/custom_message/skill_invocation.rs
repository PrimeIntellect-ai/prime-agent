//! The skill-invocation card: a user message whose text is one `<skill ...>` block (what a
//! `/skill:<name>` submission expands into) renders the compact expandable card — the `[skill]`
//! label and skill name header, the content markdown under the branch gutter when expanded; the
//! block parse lives in `pa_types::skill_blocks`, shared with the session engine.

use crate::chat::{ChatEntry, Detail};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// One skill-invocation card: the `[skill]` label and the skill name
/// header, the content markdown under the branch gutter when expanded.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillInvocationRow {
    /// The invoked skill's name.
    pub name: String,
    /// The skill content.
    pub content: String,
}

/// The skill-invocation decode for a user message: each leading `<skill ...>` block (a message
/// referencing several skills carries one per skill) renders its expandable card, and the user
/// text after the blocks renders as its own user block below them. `None` means the text is an
/// ordinary user prompt.
#[must_use]
pub fn skill_invocation_entries(text: &str) -> Option<Vec<ChatEntry>> {
    let mut block = pa_types::skill_blocks::parse_skill_block(text)?;
    let mut entries = Vec::new();
    loop {
        entries.push(ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
            name: block.name,
            content: block.content,
        })));
        let Some(user_message) = block.user_message else {
            break;
        };
        if let Some(next) = pa_types::skill_blocks::parse_skill_block(&user_message) {
            block = next;
        } else {
            entries.push(ChatEntry::User { text: user_message });
            break;
        }
    }
    Some(entries)
}

/// The card's header row: the bold `[skill]` label, a space, and the
/// skill name — the same row in both states.
fn skill_header(row: &SkillInvocationRow, theme: &Theme) -> Line {
    vec![
        super::render::custom_message_label("skill", theme),
        Span::raw(" ".to_string()),
        Span::styled(
            row.name.clone(),
            theme.fg_style(ThemeColor::CustomMessageText),
        ),
    ]
}

pub(crate) fn count_skill_invocation(
    row: &SkillInvocationRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
    leading: bool,
) -> usize {
    usize::from(leading)
        + super::geometry::text_row_count(&skill_header(row, theme), width)
        + if detail.tool_output_expanded() {
            crate::branch::branch_markdown_count(
                &row.content,
                &super::geometry::markdown_style(ThemeColor::CustomMessageText, theme),
                width,
            )
        } else {
            0
        }
}

/// One skill-invocation card: the optional leading blank, the `[skill]` + name header, then the
/// content markdown under the branch gutter when expanded (the name never duplicates in the body).
#[must_use]
pub fn render_skill_invocation(
    row: &SkillInvocationRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
    leading: bool,
) -> Vec<Line> {
    let mut out = Vec::new();
    if leading {
        out.push(Vec::new());
    }
    out.extend(super::render::text_rows(&skill_header(row, theme), width));
    if detail.tool_output_expanded() {
        out.extend(crate::branch::branch_markdown(
            &row.content,
            &super::geometry::markdown_style(ThemeColor::CustomMessageText, theme),
            theme,
            width,
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

    fn flat(row: &Line) -> String {
        row.iter().map(|s| s.content.as_str()).collect()
    }

    #[test]
    fn entries_decode_the_card_and_args() {
        // The block card plus the trailing argument text as its own user
        // block.
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
        let entries = skill_invocation_entries(
            "<skill name=\"websearch\" location=\"/s/SKILL.md\">\nRun one query.\n</skill>",
        )
        .expect("parses");
        assert!(matches!(
            entries.as_slice(),
            [ChatEntry::SkillInvocation(_)]
        ));
        // A message referencing two skills carries one block per skill:
        // each renders its own card above the user text.
        let entries = skill_invocation_entries(
            "<skill name=\"a\" location=\"/a/SKILL.md\">\nUse a.\n</skill>\n\n<skill name=\"b\" location=\"/b/SKILL.md\">\nUse b.\n</skill>\n\nmix /skill:a and /skill:b",
        )
        .expect("parses");
        assert_eq!(
            entries,
            vec![
                ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
                    name: "a".to_string(),
                    content: "Use a.".to_string(),
                })),
                ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
                    name: "b".to_string(),
                    content: "Use b.".to_string(),
                })),
                ChatEntry::User {
                    text: "mix /skill:a and /skill:b".to_string()
                },
            ]
        );
        assert!(skill_invocation_entries("hello world").is_none());
        assert!(skill_invocation_entries("/skill:websearch find tuis").is_none());
    }

    /// The collapsed card is the header row alone.
    #[test]
    fn collapsed_header_row() {
        let row = SkillInvocationRow {
            name: "websearch".to_string(),
            content: "Run one query.".to_string(),
        };
        let rows = render_skill_invocation(&row, Detail::Overview, &theme(), 40, true);
        let trimmed: Vec<String> = rows
            .iter()
            .map(|row| flat(row).trim_end().to_string())
            .collect();
        assert_eq!(trimmed, vec!["", " [skill] websearch"], "{rows:?}");
        assert_eq!(
            rows[1][1],
            super::super::render::custom_message_label("skill", &theme())
        );
        assert_eq!(
            rows[1][3].style.fg,
            theme().fg_style(ThemeColor::CustomMessageText).fg
        );
        assert!(!trimmed.iter().any(|row| row.contains("Run one query.")));
        let rows = render_skill_invocation(&row, Detail::Overview, &theme(), 40, false);
        assert_eq!(rows.len(), 1, "{rows:?}");
    }
}

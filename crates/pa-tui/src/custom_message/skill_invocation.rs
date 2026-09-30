//! The skill-invocation card: TS `skill-invocation-message.ts` +
//! `skill-blocks.ts`. A user message whose text is one `<skill ...>` block
//! (what a `/skill:<name>` submission expands into) renders the compact
//! expandable card instead of the raw block: the `[skill]` label and the
//! skill name header, with the content markdown under the branch gutter
//! when expanded; the trailing argument text renders as its own user block
//! below (no spacer between, TS `addMessageToChat`'s user case). The block
//! parse itself lives in the shared vocabulary crate
//! (`pa_types::skill_blocks`), so the session engine and every rendering
//! surface agree on the format.

use crate::chat::{ChatEntry, Detail};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// One skill-invocation card (TS `SkillInvocationMessageComponent`): the
/// `[skill]` label and the skill name header, the content markdown under
/// the branch gutter when expanded. Parsed out of a user message whose
/// text is one `<skill ...>` block (TS `parseSkillBlock` in
/// `addMessageToChat`).
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
#[must_use]
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

/// The card's header row: the bold `[skill]` label in `customMessageLabel`,
/// a space, and the skill name in `customMessageText` — the same row in
/// both states (the header never depends on expansion).
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

/// One skill-invocation card (TS `SkillInvocationMessageComponent`, after
/// #2779's one shared layout): the optional leading blank, the `[skill]` +
/// name header, then the content markdown under the branch gutter when
/// expanded (the name lives on the header, never duplicated in the
/// body).
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

    /// The collapsed card is the header row alone: no box, no pad rows,
    /// no bold-name body.
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
        // The label is the shared `customMessageLabel` span, the name the
        // `customMessageText` fg.
        assert_eq!(
            rows[1][1],
            super::super::render::custom_message_label("skill", &theme())
        );
        assert_eq!(
            rows[1][3].style.fg,
            theme().fg_style(ThemeColor::CustomMessageText).fg
        );
        // The skill content stays out of the collapsed card.
        assert!(!trimmed.iter().any(|row| row.contains("Run one query.")));
        // Without the leading blank the header row leads.
        let rows = render_skill_invocation(&row, Detail::Overview, &theme(), 40, false);
        assert_eq!(rows.len(), 1, "{rows:?}");
    }
}

//! Inbox-notice runs: consecutive inbox notices collapse into the one dim
//! counter line their first entry paints (the rest paint nothing), and
//! expand to the full per-notice rows through the card expansion
//! affordances (Ctrl+O, or a click on the line).

use super::AgentView;
use crate::chat::ChatEntry;
use crate::custom_message::InboxNoticeRow;
use crate::Line;

impl AgentView {
    /// The first entry of the consecutive inbox-notice run holding `index`:
    /// the entry that owns the run's expansion and its counter line.
    pub(super) fn inbox_run_head(&self, index: usize) -> usize {
        let mut head = index;
        while head > 0 && matches!(self.chat[head - 1], ChatEntry::InboxNotice(_)) {
            head -= 1;
        }
        head
    }

    pub(super) fn inbox_run_expanded(&self, index: usize) -> bool {
        self.entry_detail(self.inbox_run_head(index))
            .tool_output_expanded()
    }

    /// The notices a collapsed run head counts: the head and every inbox
    /// notice directly after it. Empty for a non-head entry.
    fn inbox_run_notices(&self, index: usize) -> Vec<&InboxNoticeRow> {
        if self.inbox_run_head(index) != index {
            return Vec::new();
        }
        self.chat[index..]
            .iter()
            .map_while(|entry| match entry {
                ChatEntry::InboxNotice(row) => Some(row.as_ref()),
                _ => None,
            })
            .collect()
    }

    /// One inbox notice's rows: its full rows in an expanded run, the run's
    /// counter line on a collapsed head, nothing for the rest of a
    /// collapsed run.
    pub(super) fn render_inbox_notice_entry(
        &self,
        index: usize,
        row: &InboxNoticeRow,
        width: usize,
    ) -> Vec<Line> {
        let expanded = self.inbox_run_expanded(index);
        let leading = self.conversation_leading(index, expanded);
        if expanded {
            return crate::custom_message::render::render_inbox_notice(
                row,
                &self.theme,
                width,
                leading,
            );
        }
        let notices = self.inbox_run_notices(index);
        if notices.is_empty() {
            return Vec::new();
        }
        let mut rows = Vec::new();
        if leading {
            rows.push(Vec::new());
        }
        rows.extend(crate::custom_message::render::text_rows(
            &crate::custom_message::inbox_counter::counter_line(&notices, &self.theme),
            width,
        ));
        rows
    }

    /// The row count [`Self::render_inbox_notice_entry`] paints.
    pub(super) fn count_inbox_notice_entry(
        &self,
        index: usize,
        row: &InboxNoticeRow,
        width: usize,
    ) -> usize {
        let expanded = self.inbox_run_expanded(index);
        let leading = self.conversation_leading(index, expanded);
        if expanded {
            return crate::custom_message::geometry::inbox_notice_row_count(
                row,
                &self.theme,
                width,
                leading,
            );
        }
        let notices = self.inbox_run_notices(index);
        if notices.is_empty() {
            return 0;
        }
        usize::from(leading)
            + crate::custom_message::geometry::text_row_count(
                &crate::custom_message::inbox_counter::counter_line(&notices, &self.theme),
                width,
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::Detail;
    use crate::theme::{ColorMode, Theme, ThemeColor};

    fn notice(text: &str) -> ChatEntry {
        ChatEntry::InboxNotice(Box::new(InboxNoticeRow {
            class: "arrival".to_string(),
            count: Some(1),
            text: text.to_string(),
        }))
    }

    fn rows_text(rows: &[Line]) -> Vec<String> {
        rows.iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    /// Three notices paint one dim counter line, never a row per notice;
    /// the Ctrl+O expansion brings back every notice's own rows.
    #[test]
    fn three_inbox_notices_collapse_to_one_dim_counter_line() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let mut view = AgentView::new(theme.clone());
        view.splash_suppressed = true;
        let texts = [
            "[inbox 19:14 UTC] 1 new message (bash-done); total waiting: 1. Read them with msgs = await rlm.inbox.read().",
            "[inbox 19:15 UTC] 1 new message (agent-message); total waiting: 2. Read them with msgs = await rlm.inbox.read().",
            "[inbox 19:16 UTC] 1 new message (bash-done); total waiting: 3. Read them with msgs = await rlm.inbox.read().",
        ];
        for text in texts {
            view.push_entry(notice(text));
        }
        assert_eq!(view.detail, Detail::Overview);
        let collapsed = view.render_transcript(80);
        let collapsed_text = rows_text(&collapsed);
        assert_eq!(
            collapsed_text
                .iter()
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>(),
            [" \u{2709} Agent inbox \u{b7} 3 new (2 bash-done, 1 agent-message)"]
        );
        let dim = theme.fg_style(ThemeColor::Dim);
        let line = collapsed
            .iter()
            .find(|row| row.iter().any(|span| span.content.contains("Agent inbox")))
            .expect("the counter line renders");
        assert!(
            line.iter()
                .filter(|span| !span.content.trim().is_empty())
                .all(|span| span.style == dim),
            "{line:?}"
        );

        view.cycle_detail();
        view.cycle_detail();
        let expanded = rows_text(&view.render_transcript(80)).join("\n");
        for text in texts {
            assert!(expanded.contains(&text[..30]), "{expanded}");
        }
        assert_eq!(
            expanded.matches("\u{2709} Agent inbox").count(),
            3,
            "{expanded}"
        );
    }
}
